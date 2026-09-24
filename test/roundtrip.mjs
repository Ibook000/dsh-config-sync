/**
 * Round-trip test for dsh-config-sync against a sandbox DSH home.
 *
 * Builds a fake ~/.dsh with a web profile, a large decoy node_modules, and a
 * credentials file, then drives the plugin through a real Cordis-like context
 * to verify: capture excludes node_modules/secrets, diff detects drift, apply
 * restores, backups are taken, and path escapes are refused.
 */
import { mkdir, writeFile, readFile, rm, stat, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir, homedir } from 'node:os'

const pluginDir = resolve(import.meta.dirname, '..')
const plugin = await import(new URL('../lib/index.js', import.meta.url).href)

const root = join(tmpdir(), `dsh-cfg-test-${Date.now()}`)
const home = join(root, '.dsh')
const syncRoot = join(root, 'synced')
const profile = 'web'
// settings.yaml + the 6 known profile files the fixture creates.
const FIXTURE_FILES = 7

// SAFETY: every apply() call below must pin `home` to this sandbox explicitly.
// A blank DSH_HOME is treated as unset by resolveHome() — by design — so the
// plugin would otherwise fall back to the operator's real ~/.dsh.
const realHome = join(homedir(), '.dsh')
if (resolve(home) === resolve(realHome) || resolve(root) === resolve(dirname(realHome))) {
  throw new Error(`refusing to run: sandbox root ${root} overlaps the real DSH home ${realHome}`)
}
const assertSandbox = (ctxHome) => {
  if (resolve(ctxHome) !== resolve(home)) {
    throw new Error(`test bug: plugin was given home=${ctxHome}, expected the sandbox ${home}`)
  }
}

let pass = 0
let fail = 0
const check = (label, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ` -> ${detail}` : ''}`) }
}

// ---------------------------------------------------------------------------
// Fixture: a believable DSH home
// ---------------------------------------------------------------------------
async function write(path, text) {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, text, 'utf8')
}

const settingsYaml = 'ui-theme:\n  fontSize: 17\nagent-default-model:\n  provider: buddy\n'
const manifest = JSON.stringify({
  name: 'dsh-profile-web',
  private: true,
  dependencies: { 'dsh-free-search': '^0.4.28', 'dsh-synapse': '^0.4.1' },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-free-search'], patchReload: 'live' } },
}, undefined, 2)
const patchYml = '- id: web\n  config:\n    searchProvider: ddg\n'
const cordisYml = '# dsh profile root — an empty entry list.\n[]\n'
const workspaceYaml = 'packages:\n  - .\nnodeLinker: hoisted\n'
const lockfile = 'lockfileVersion: 9.0\n'
const versions = JSON.stringify({ 'ddmuc/dsh-free-search': { version: 'v0.4.28' } }, undefined, 2)
const credentials = 'EXAMPLE_ACCOUNT_DEADBEEF:\n  value: super-secret-token\n'

const pdir = join(home, 'profiles', profile)
await write(join(home, 'settings.yaml'), settingsYaml)
await write(join(home, '.credentials.yaml'), credentials)
await write(join(pdir, 'package.json'), manifest)
await write(join(pdir, 'cordis.patch.yml'), patchYml)
await write(join(pdir, 'cordis.yml'), cordisYml)
await write(join(pdir, 'pnpm-workspace.yaml'), workspaceYaml)
await write(join(pdir, 'pnpm-lock.yaml'), lockfile)
await write(join(pdir, 'gro.ngilp-hsd-versions.json'), versions)
// Decoys that must never be synced:
await write(join(pdir, 'node_modules', 'dsh-free-search', 'package.json'), '{"name":"dsh-free-search"}')
await write(join(pdir, 'node_modules', 'dsh-free-search', 'lib', 'big.js'), 'x'.repeat(50000))
await write(join(home, 'profiles', 'node_modules', 'leaf.js'), 'y'.repeat(1000))
await write(join(home, 'sessions', 's1.jsonl'), '{"session":"private"}\n')
await write(join(home, 'logs', 'hub.log'), 'log line\n')

console.log('fixture:', home)

// ---------------------------------------------------------------------------
// Minimal Cordis-like context: captures tool/command registrations
// ---------------------------------------------------------------------------
const registeredTools = []
const registeredCommands = []
function makeCtx() {
  const ctx = {
    get: () => undefined,
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    inject: (names, cb) => {
      const scoped = {
        ...ctx,
        tools: { register: (def) => { registeredTools.push(def); return () => {} } },
        commands: { register: (def) => { registeredCommands.push(def); return () => {} } },
      }
      cb(scoped)
    },
  }
  return ctx
}

// ---------------------------------------------------------------------------
// 1. Registration
// ---------------------------------------------------------------------------
console.log('\n[1] registration')
plugin.apply(makeCtx(), { home, syncRoot, profile, includeSecrets: false, includeLockfile: true, backupRetention: 3 })
assertSandbox(resolve(home))
check('registers 3 model tools', registeredTools.length === 3, `got ${registeredTools.length}`)
check('registers the /sync command', registeredCommands.length === 1)
const names = registeredTools.map((t) => t.name).join(',')
check('tool names correct', names === 'config_sync_status,config_sync_push,config_sync_pull', names)
for (const tool of registeredTools) {
  const okShape = typeof tool.description === 'string' && tool.parameters && tool.output
    && tool.output.schema && typeof tool.output.render === 'function' && typeof tool.execute === 'function'
  check(`tool "${tool.name}" has the required registry shape`, !!okShape)
  const rendered = tool.output.render({}, { probe: 1 })
  check(`tool "${tool.name}" render returns text blocks`, Array.isArray(rendered) && rendered[0]?.type === 'text')
}
check('/sync command shape', registeredCommands[0].name === 'sync' && typeof registeredCommands[0].handler === 'function')

const byName = (n) => registeredTools.find((t) => t.name === n)
const status = () => byName('config_sync_status').execute({}, {})
const push = (args) => byName('config_sync_push').execute(args, {})
const pull = (args) => byName('config_sync_pull').execute(args, {})

// ---------------------------------------------------------------------------
// 2. Status before any snapshot
// ---------------------------------------------------------------------------
console.log('\n[2] status before push')
let s = await status()
check('detects the web profile', s.profile === 'web', String(s.profile))
check('reports syncRoot missing', s.syncRootExists === false)
check('reports credentials present locally', s.local.credentials === true)
check('snapshot is empty', s.snapshot.files.length === 0, JSON.stringify(s.snapshot.files))
check('pending shows all files as new', s.changes.added.length === FIXTURE_FILES, `added=${s.changes.added.length}`)

// ---------------------------------------------------------------------------
// 3. Dry-run push writes nothing
// ---------------------------------------------------------------------------
console.log('\n[3] push --dry-run')
const dry = await push({ dryRun: true })
check('dry run reports ok', dry.ok === true)
check('dry run did NOT create syncRoot', !existsSync(syncRoot))

// ---------------------------------------------------------------------------
// 4. Real push
// ---------------------------------------------------------------------------
console.log('\n[4] push')
const pushed = await push({ dryRun: false })
check('push ok', pushed.ok === true, pushed.error)
check('wrote every payload file', pushed.written.length === FIXTURE_FILES, String(pushed.written.length))
check('manifest written', existsSync(join(syncRoot, plugin.MANIFEST_NAME)))

const synced = pushed.written
check('settings.yaml synced', synced.includes('settings.yaml'))
check('profile package.json synced', synced.includes('profiles/web/package.json'))
check('cordis.patch.yml synced', synced.includes('profiles/web/cordis.patch.yml'))
check('lockfile synced', synced.includes('profiles/web/pnpm-lock.yaml'))

console.log('\n[5] exclusions (the whole point)')
check('NO node_modules path synced', !synced.some((f) => f.includes('node_modules')), synced.join(','))
check('NO sessions synced', !synced.some((f) => f.includes('sessions')))
check('NO logs synced', !synced.some((f) => f.includes('logs')))
check('credentials NOT synced by default', !synced.includes('.credentials.yaml'))
check('no secret value anywhere in the snapshot dir', await (async () => {
  const walk = async (dir) => {
    const out = []
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) out.push(...await walk(p))
      else out.push(p)
    }
    return out
  }
  const files = await walk(syncRoot)
  for (const f of files) if ((await readFile(f, 'utf8')).includes('super-secret-token')) return false
  return true
})())

const syncedBytes = (await Promise.all(synced.map(async (f) => (await stat(join(syncRoot, f))).size))).reduce((a, b) => a + b, 0)
console.log(`  info  payload = ${syncedBytes} bytes (node_modules decoy left behind: 51000+ bytes)`)

// ---------------------------------------------------------------------------
// 6. Idempotence + drift detection
// ---------------------------------------------------------------------------
console.log('\n[6] diff detects only real change')
const again = await push({ dryRun: true })
check('second push: nothing added/changed', again.changes.added.length === 0 && again.changes.changed.length === 0,
  JSON.stringify(again.changes))
check('second push: all unchanged', again.changes.unchanged.length === FIXTURE_FILES)

await write(join(home, 'settings.yaml'), settingsYaml + 'ui-chat:\n  transcriptView: normal\n')
const drifted = await push({ dryRun: true })
check('edited settings.yaml shows as changed', drifted.changes.changed.includes('settings.yaml'),
  JSON.stringify(drifted.changes.changed))
check('other files stay unchanged', drifted.changes.unchanged.length === FIXTURE_FILES - 1)

// ---------------------------------------------------------------------------
// 7. Pull: preview then apply
// ---------------------------------------------------------------------------
console.log('\n[7] pull')
const preview = await pull({ confirm: false })
check('pull preview is zero-write', preview.dryRun === true && preview.actions.length === FIXTURE_FILES)
check('preview marks existing files overwrite',
  preview.actions.every((a) => a.action === 'overwrite'), JSON.stringify(preview.actions.map((a) => a.action)))

// Simulate a fresh machine: wipe profile config, keep settings.yaml absent.
await rm(join(home, 'settings.yaml'), { force: true })
await rm(join(pdir, 'pnpm-lock.yaml'), { force: true })
const applied = await pull({ confirm: true })
check('pull applied files', applied.ok === true && applied.applied.length === FIXTURE_FILES, applied.error)
check('recreated settings.yaml', existsSync(join(home, 'settings.yaml')))
check('recreated pnpm-lock.yaml', existsSync(join(pdir, 'pnpm-lock.yaml')))
check('restored settings.yaml content matches source', (await readFile(join(home, 'settings.yaml'), 'utf8')) === settingsYaml)
check('next step tells you to rebuild node_modules',
  typeof applied.nextStep === 'string' && applied.nextStep.includes('install'), applied.nextStep)
check('pre-apply backup taken', typeof applied.backupDir === 'string' && existsSync(applied.backupDir), String(applied.backupDir))
check('backup preserved the pre-pull profile manifest',
  existsSync(join(applied.backupDir, 'profiles', 'web', 'package.json')))

// ---------------------------------------------------------------------------
// 8. Secret opt-in
// ---------------------------------------------------------------------------
console.log('\n[8] secret opt-in')
const registeredTools2 = []
const ctx2 = (() => {
  const ctx = {
    get: () => undefined,
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    inject: (names, cb) => {
      const scoped = { ...ctx, tools: { register: (d) => { registeredTools2.push(d); return () => {} } }, commands: { register: () => () => {} } }
      cb(scoped)
    },
  }
  return ctx
})()
const syncRoot2 = join(root, 'synced-secrets')
plugin.apply(ctx2, { home, syncRoot: syncRoot2, profile, includeSecrets: true, backupRetention: 3 })
const p2 = await registeredTools2.find((t) => t.name === 'config_sync_push').execute({}, {})
check('secrets included when opted in', p2.written.includes('.credentials.yaml'), p2.written.join(','))
check('credentials content actually copied',
  (await readFile(join(syncRoot2, '.credentials.yaml'), 'utf8')) === credentials)

// ---------------------------------------------------------------------------
// 9. Safety: traversal refusal + lockfile toggle
// ---------------------------------------------------------------------------
console.log('\n[9] safety and options')
check('isInside rejects a sibling prefix escape',
  plugin.isInside(join(root, 'a'), join(root, 'ab', 'x')) === false)
check('isInside accepts a real descendant',
  plugin.isInside(join(root, 'a'), join(root, 'a', 'b', 'c')) === true)
check('isInside accepts the path itself', plugin.isInside(root, root) === true)

const syncRoot3 = join(root, 'synced-nolock')
const tools3 = []
const ctx3 = (() => {
  const ctx = {
    get: () => undefined,
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    inject: (n, cb) => cb({ ...ctx, tools: { register: (d) => { tools3.push(d); return () => {} } }, commands: { register: () => () => {} } }),
  }
  return ctx
})()
plugin.apply(ctx3, { home, syncRoot: syncRoot3, profile, includeLockfile: false })
const p3 = await tools3.find((t) => t.name === 'config_sync_push').execute({}, {})
check('includeLockfile:false drops the lockfile', !p3.written.some((f) => f.endsWith('pnpm-lock.yaml')), p3.written.join(','))

// ---------------------------------------------------------------------------
// 10. /sync command path
// ---------------------------------------------------------------------------
console.log('\n[10] /sync command')
const syncRoot4 = join(root, 'synced-cmd')
const cmds = []
const ctx4 = (() => {
  const ctx = {
    get: () => undefined,
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    inject: (n, cb) => cb({ ...ctx, tools: { register: () => () => {} }, commands: { register: (d) => { cmds.push(d); return () => {} } } }),
  }
  return ctx
})()
plugin.apply(ctx4, { home, syncRoot: syncRoot4, profile })
const handler = cmds[0].handler
const r1 = await handler({ rawInput: 'status' })
check('/sync status succeeds', r1.kind === 'success' && r1.text.includes('config-sync'), JSON.stringify(r1).slice(0, 160))
const r2 = await handler({ rawInput: 'push' })
check('/sync push succeeds', r2.kind === 'success' && existsSync(syncRoot4), JSON.stringify(r2).slice(0, 160))
const r3 = await handler({ rawInput: 'pull' })
check('/sync pull previews', r3.kind === 'success' && r3.text.includes('pull!'), r3.text.slice(0, 120))
const r4 = await handler({ rawInput: 'pull!' })
check('/sync pull! applies', r4.kind === 'success', JSON.stringify(r4).slice(0, 160))
const r5 = await handler({ rawInput: 'bogus' })
check('/sync bogus falls back to status', r5.kind === 'success')

// ---------------------------------------------------------------------------
// 11. HTTP bridge + settings + scheduler (the visual-UI host half)
// ---------------------------------------------------------------------------
console.log('\n[11] HTTP bridge / settings / scheduler')
{
  const routes = []
  const intervals = []
  const timers = []
  // The bridge and scheduler arrive through ctx.inject (they wait for the
  // service), so the fake context must answer inject for those dependency names.
  const ctx = {
    get: () => undefined,
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    inject: (names, cb) => {
      const scoped = {
        ...ctx,
        tools: { register: () => () => {} },
        commands: { register: () => () => {} },
      }
      if (names.includes('webServer')) scoped.webServer = { register: (r) => { routes.push(r); return () => {} } }
      if (names.includes('timer')) scoped.timer = { interval: (fn, ms) => { intervals.push({ fn, ms }); return () => {} } }
      cb(scoped)
    },
  }
  const bridgeRoot = join(root, 'bridged')
  plugin.apply(ctx, { home, syncRoot: bridgeRoot, profile, backupRetention: 3 })

  const paths = routes.map((r) => r.path).sort()
  const expected = ['/dsh-config-sync/git', '/dsh-config-sync/github', '/dsh-config-sync/pull',
                    '/dsh-config-sync/push', '/dsh-config-sync/settings', '/dsh-config-sync/status']
  check('mounts all 6 bridge routes', JSON.stringify(paths) === JSON.stringify(expected), paths.join(','))
  check('scheduler armed a 1-minute poll', intervals.length === 1 && intervals[0].ms === 60000,
    JSON.stringify(intervals.map((i) => i.ms)))

  // Minimal request/response doubles.
  const makeReq = (method, origin, body) => ({
    method,
    headers: origin === undefined ? {} : { origin, host: '127.0.0.1:3080' },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    },
  })
  const makeRes = () => {
    const out = { status: 0, headers: null, body: '' }
    return {
      out,
      writeHead(status, headers) { out.status = status; out.headers = headers },
      end(chunk) { out.body = chunk ?? '' },
    }
  }
  const call = async (path, { method = 'GET', origin, body } = {}) => {
    const route = routes.find((r) => r.path === `/dsh-config-sync${path}`)
    if (!route) throw new Error(`no route ${path}`)
    const res = makeRes()
    await route.handler(makeReq(method, origin, body), res)
    return { status: res.out.status, json: res.out.body ? JSON.parse(res.out.body) : null }
  }

  // Regression guard: the bridge and scheduler MUST wait for their services via
  // ctx.inject. Reading them with ctx.get at apply() time returns undefined when
  // the sibling bundle row has not mounted yet, and the bridge then never mounts
  // while the plugin still reports as loaded — a silent failure that costs a
  // restart to notice.
  const hostSrc = await readFile(join(pluginDir, 'lib', 'index.js'), 'utf8')
  check('bridge waits for webServer via ctx.inject (not ctx.get)',
    hostSrc.includes("ctx.inject(['webServer']") && !hostSrc.includes("ctx.get('webServer')"))
  check('scheduler waits for timer via ctx.inject (not ctx.get)',
    hostSrc.includes("ctx.inject(['timer']") && !hostSrc.includes("ctx.get('timer')"))
  const statusResult = await call('/status')
  check('GET /status returns ok', statusResult.status === 200 && statusResult.json.ok === true)
  check('/status reports default settings', statusResult.json.settings.autoSync === false)
  check('/status lists intervals', Array.isArray(statusResult.json.intervals) && statusResult.json.intervals.length === 5)
  check('/status surfaces git state', typeof statusResult.json.git === 'object' && statusResult.json.git !== null)
  check('/status never returns a token VALUE',
    !JSON.stringify(statusResult.json).match(/ghp_|github_pat_|gho_/),
    'token-like string present')

  // POST without a same-origin Origin header must be refused.
  const untrusted = await call('/push', { method: 'POST', body: { dryRun: true } })
  check('POST without Origin is refused (403)', untrusted.status === 403, JSON.stringify(untrusted.json))
  const crossOrigin = await call('/push', { method: 'POST', origin: 'https://evil.example', body: { dryRun: true } })
  check('POST from a foreign origin is refused', crossOrigin.status === 403)
  const wrongMethod = await call('/status', { method: 'DELETE' })
  check('unsupported method returns 405', wrongMethod.status === 405)

  const origin = 'http://127.0.0.1:3080'
  const push = await call('/push', { method: 'POST', origin, body: { dryRun: true, git: false } })
  check('trusted POST /push dry-run succeeds', push.status === 200 && push.json.ok === true, JSON.stringify(push.json).slice(0, 160))
  check('dry-run push wrote nothing', !existsSync(bridgeRoot))
  const realPush = await call('/push', { method: 'POST', origin, body: { git: false } })
  check('real push writes the snapshot', realPush.json.ok === true && realPush.json.written.length === FIXTURE_FILES,
    JSON.stringify(realPush.json).slice(0, 200))

  const pullPreview = await call('/pull', { method: 'POST', origin, body: {} })
  check('pull without confirm is a preview', pullPreview.json.dryRun === true && pullPreview.json.actions.length === FIXTURE_FILES)

  // Settings persistence + validation.
  const saved = await call('/settings', { method: 'POST', origin, body: { autoSync: true, autoSyncInterval: '15m' } })
  check('settings persist', saved.json.settings.autoSync === true && saved.json.settings.autoSyncInterval === '15m')
  const bad = await call('/settings', { method: 'POST', origin, body: { autoSyncInterval: 'nonsense', bogusKey: 1 } })
  check('invalid interval is rejected', bad.json.settings.autoSyncInterval === '15m', JSON.stringify(bad.json.settings))
  check('unknown keys are dropped', !('bogusKey' in bad.json.settings))
  check('settings file written INTO the sync root (travels with the config)', existsSync(join(bridgeRoot, 'dsh-config-sync.settings.json')))
  check('settings round-trip through disk', (await plugin.readSettings(bridgeRoot)).autoSync === true)

  // The scheduler must honour the stored interval, not fire on every tick.
  check('no last-run marker before any auto sync', plugin.readLastRun(home) === undefined)
  check('last-run state path lives in the HOME, not the sync root',
    plugin.autoSyncStatePath(home) === join(home, '.config-sync-state.json'))
  check('state path is NOT inside the sync root',
    !plugin.isInside(bridgeRoot, plugin.autoSyncStatePath(home)))
  intervals[0].fn()
  await new Promise((r) => setTimeout(r, 400))
  check('first tick performs a sync and records the run', plugin.readLastRun(home) !== undefined)
  const firstRun = plugin.readLastRun(home)
  intervals[0].fn()
  await new Promise((r) => setTimeout(r, 400))
  check('second tick within the interval is skipped (no re-run)',
    plugin.readLastRun(home) === firstRun, 'last-run advanced on a too-early tick')

  // Turn auto-sync off and confirm the tick becomes a no-op.
  await call('/settings', { method: 'POST', origin, body: { autoSync: false } })
  const before = plugin.readLastRun(home)
  intervals[0].fn()
  await new Promise((r) => setTimeout(r, 400))
  check('disabled auto-sync does not run', plugin.readLastRun(home) === before)

  // A sync root outside git must degrade gracefully, never throw.
  const gitInfo = plugin.gitState(bridgeRoot)
  check('gitState on a non-repo reports isRepo:false without throwing', gitInfo.isRepo === false && typeof gitInfo.available === 'boolean')
  const commit = plugin.gitCommitAndPush(bridgeRoot, false)
  check('gitCommitAndPush on a non-repo is a safe no-op', commit.committed === false && commit.message.includes('not a git repository'))
  const ff = plugin.gitFetchAndFastForward(bridgeRoot)
  check('gitFetchAndFastForward on a non-repo is a safe no-op', ff.fetched === false)
}

// ---------------------------------------------------------------------------
// 12. Client bundle contract
// ---------------------------------------------------------------------------
console.log('\n[12] client bundle contract')
{
  const pkg = JSON.parse(await readFile(join(pluginDir, 'package.json'), 'utf8'))
  check('declares dsh.client.platform = web', pkg.dsh?.client?.platform === 'web')
  check('exports ./client', pkg.exports?.['./client'] === './lib/client.js')
  const clientPath = join(pluginDir, 'lib', 'client.js')
  check('client bundle exists on disk', existsSync(clientPath))
  const clientSrc = await readFile(clientPath, 'utf8')
  check('bundle registers with __ModuleLoader__', clientSrc.includes('window.__ModuleLoader__.load('))
  check('bundle id matches the package name', clientSrc.includes(`id: '${pkg.name}'`))
  check('bundle registers the settings.section slot', clientSrc.includes("inject('settings.section'"))
  check('bundle uses its own section id', clientSrc.includes("id: 'config-sync'"))
  check('bundle never writes a token to storage',
    !/localStorage|sessionStorage/.test(clientSrc), 'client touches web storage')
  check('bundle talks only to its own bridge prefix',
    clientSrc.includes("const BRIDGE = '/dsh-config-sync'"))
  // The host must expose exactly the routes the client calls.
  const called = [...clientSrc.matchAll(/post\('(\/[a-z]+)'/g)].map((m) => m[1])
  const alsoGet = [...clientSrc.matchAll(/get\('(\/[a-z]+)'/g)].map((m) => m[1])
  const clientRoutes = [...new Set([...called, ...alsoGet])].sort()
  check('every client bridge call has a host route',
    clientRoutes.every((r) => ['/status', '/push', '/pull', '/settings', '/github', '/git'].includes(r)),
    clientRoutes.join(','))
}

// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(60)}`)
console.log(`PASS ${pass}   FAIL ${fail}`)
console.log(`fixture kept at: ${root}`)
console.log('='.repeat(60))
process.exit(fail === 0 ? 0 : 1)



