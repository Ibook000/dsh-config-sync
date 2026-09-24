#!/usr/bin/env node
/**
 * git-sync.mjs — run the full DSH config sync loop through a Git remote.
 *
 *   snapshot  →  commit  →  push          (push direction)
 *   fetch     →  pull    →  apply          (pull direction)
 *
 * The plugin itself deliberately knows nothing about transport (see README);
 * this script is the thin Git adapter that sits on top of it, so the plugin
 * keeps its "no network code" property while the everyday loop stays one
 * command.
 *
 * Usage:
 *   node git-sync.mjs push  [--sync-root <dir>] [--dry-run]
 *   node git-sync.mjs pull  [--sync-root <dir>] [--confirm]
 *   node git-sync.mjs status [--sync-root <dir>]
 *
 * Exit codes: 0 ok, 1 failure, 2 usage error.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const PLUGIN = resolve(import.meta.dirname, '..', 'lib', 'index.js')

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2)
const command = argv[0]
if (!['push', 'pull', 'status'].includes(command)) {
  console.error('usage: node git-sync.mjs <push|pull|status> [--sync-root <dir>] [--dry-run] [--confirm]')
  process.exit(2)
}
const flag = (name) => argv.includes(name)
const valueOf = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : undefined
}
const syncRoot = resolve(
  valueOf('--sync-root') ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'config-sync'),
)
const dryRun = flag('--dry-run')
const confirm = flag('--confirm')

if (!existsSync(syncRoot)) {
  console.error(`sync root does not exist: ${syncRoot}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// git helpers
// ---------------------------------------------------------------------------
const git = (args, { allowFail = false } = {}) => {
  const r = spawnSync('git', args, { cwd: syncRoot, encoding: 'utf8' })
  if (r.error) throw r.error
  if (r.status !== 0 && !allowFail) {
    throw new Error(`git ${args.join(' ')} failed:\n${r.stderr || r.stdout}`)
  }
  return { code: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
}
const hasRemote = () => git(['remote'], { allowFail: true }).out.trim() !== ''
const currentBranch = () => git(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true }).out || 'main'
const isRepo = () => git(['rev-parse', '--git-dir'], { allowFail: true }).code === 0

// ---------------------------------------------------------------------------
// plugin driver: reuse the shipped implementation, never a reimplementation
// ---------------------------------------------------------------------------
const plugin = await import(new URL(`file://${PLUGIN.replace(/\\/g, '/')}`).href)

/** Build a minimal Cordis-like context and return the plugin's tool table. */
function driver(overrides = {}) {
  const tools = []
  const ctx = {
    get: () => undefined,
    effect: (fn) => {
      const d = fn()
      return typeof d === 'function' ? d : () => {}
    },
    inject: (_names, cb) =>
      cb({
        ...ctx,
        tools: { register: (d) => { tools.push(d); return () => {} } },
        commands: { register: () => () => {} },
      }),
  }
  plugin.apply(ctx, { syncRoot, includeSecrets: false, includeLockfile: true, ...overrides })
  const at = (n) => {
    const t = tools.find((x) => x.name === n)
    if (!t) throw new Error(`plugin did not register ${n}`)
    return t.execute
  }
  return {
    status: () => at('config_sync_status')({}, {}),
    push: (a) => at('config_sync_push')(a, {}),
    pull: (a) => at('config_sync_pull')(a, {}),
  }
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------
const show = (t) => console.log(t)

try {
  if (command === 'status') {
    const d = driver()
    const s = await d.status()
    const change = s.changes
    show(`sync root : ${s.syncRoot}`)
    show(`profile   : ${s.profile ?? '(none)'} (${s.profileReason})`)
    show(`snapshot  : ${s.snapshot.files.length} file(s)` + (s.snapshot.at ? `, captured ${s.snapshot.at}` : ''))
    show(`pending   : ${change ? `${change.changed.length} changed, ${change.added.length} new, ${change.removed.length} removed` : 'n/a'}`)
    if (change?.changed.length) show(`  changed : ${change.changed.join(', ')}`)
    if (isRepo()) {
      const dirty = git(['status', '--porcelain']).out
      show(`git       : branch ${currentBranch()}, ${dirty ? 'uncommitted changes' : 'clean'}`)
      if (hasRemote()) {
        const ahead = git(['rev-list', '--count', '@{u}..HEAD'], { allowFail: true }).out || '?'
        const behind = git(['rev-list', '--count', 'HEAD..@{u}'], { allowFail: true }).out || '?'
        show(`remote    : ${ahead} ahead, ${behind} behind`)
      } else {
        show('remote    : (none configured)')
      }
    }
    process.exit(0)
  }

  if (command === 'push') {
    const d = driver()
    const cap = await d.push({ dryRun: dryRun === true || !isRepo() })
    if (cap.ok !== true) {
      console.error(`snapshot failed: ${cap.error}`)
      process.exit(1)
    }
    if (dryRun) {
      show(`[dry-run] would snapshot profile "${cap.profile}" into ${cap.syncRoot}`)
      show(`  changed: ${cap.changes.changed.join(', ') || 'none'}`)
      show(`  added  : ${cap.changes.added.join(', ') || 'none'}`)
      process.exit(0)
    }
    show(`snapshot: profile "${cap.profile}", ${cap.written.length} file(s)`)

    if (!isRepo()) {
      show('not a git repository — snapshot written, nothing committed')
      process.exit(0)
    }
    git(['add', '-A'])
    const staged = git(['diff', '--cached', '--name-only']).out
    if (!staged) {
      show('git: nothing to commit (snapshot matches the last commit)')
    } else {
      const subject = `Sync DSH config ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`
      git(['-c', 'user.name=' + (git(['config', 'user.name'], { allowFail: true }).out || 'dsh-config-sync'),
           '-c', 'user.email=' + (git(['config', 'user.email'], { allowFail: true }).out || 'dsh-config-sync@localhost'),
           'commit', '-q', '-m', subject])
      show(`git: committed ${staged.split('\n').length} file(s)`)
      show(`  ${staged.split('\n').map((f) => `  ${f}`).join('\n').trim()}`)
    }
    if (!hasRemote()) {
      show('remote: none configured — commit is local only')
      process.exit(0)
    }
    const branch = currentBranch()
    const r = git(['push', 'origin', branch], { allowFail: true })
    if (r.code !== 0) {
      console.error(`push failed:\n${r.err || r.out}`)
      process.exit(1)
    }
    show(`remote: pushed ${branch} → origin`)
    process.exit(0)
  }

  if (command === 'pull') {
    if (isRepo() && hasRemote()) {
      const fetched = git(['fetch', 'origin'], { allowFail: true })
      if (fetched.code !== 0) {
        console.error(`fetch failed:\n${fetched.err || fetched.out}`)
        process.exit(1)
      }
      show('git: fetched origin')
      const behind = git(['rev-list', '--count', 'HEAD..@{u}'], { allowFail: true }).out
      if (behind && behind !== '0') {
        const ff = git(['merge', '--ff-only', '@{u}'], { allowFail: true })
        if (ff.code !== 0) {
          console.error(`cannot fast-forward:\n${ff.err || ff.out}`)
          process.exit(1)
        }
        show(`git: fast-forwarded (${behind} commit(s))`)
      } else {
        show('git: already up to date')
      }
    }
    const d = driver()
    const warn = confirm ? {} : { dryRun: true }
    const preview = await d.pull(warn)
    if (preview.ok !== true) {
      console.error(`pull failed: ${preview.error}`)
      process.exit(1)
    }
    if (!confirm) {
      show(`[preview] would apply into profile "${preview.profile}" (snapshot ${preview.snapshotAt})`)
      for (const a of preview.actions) show(`  ${a.action}: ${a.path}`)
      show('re-run with --confirm to apply')
      process.exit(0)
    }
    const applied = await d.pull({ confirm: true })
    if (applied.ok !== true) {
      console.error(`apply failed: ${applied.error}`)
      process.exit(1)
    }
    show(`applied: ${applied.applied.length} file(s) into profile "${applied.profile}"`)
    if (applied.backupDir) show(`backup : ${applied.backupDir}`)
    if (applied.nextStep) show(`next   : ${applied.nextStep}`)
    process.exit(0)
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
