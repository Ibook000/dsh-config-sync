/**
 * dsh-config-sync — lightweight configuration sync for DeepSeek Harness.
 *
 * Design in one sentence: sync the *recipe*, never the build output.
 *
 * A DSH installation is dominated by `profiles/<name>/node_modules` (hundreds
 * of MB) which is fully reproducible from a handful of small text files. Those
 * files are the entire synced payload:
 *
 *   settings.yaml                              global settings, models, theme
 *   profiles/<p>/package.json                  plugin manifest + bundle layers
 *   profiles/<p>/cordis.patch.yml              your hand-written override layer
 *   profiles/<p>/pnpm-workspace.yaml           build allowlist / linker / registry
 *   profiles/<p>/pnpm-lock.yaml                exact resolved versions (optional)
 *   profiles/<p>/gro.ngilp-hsd-versions.json   installed plugin versions
 *   .credentials.yaml                          OPT-IN, off by default
 *
 * Restoring on another machine is therefore two steps, and only the first is
 * this plugin's job: write the recipe back, then let the DSH CLI rebuild the
 * dependency tree with `dsh plugin --profile <name> install`.
 *
 * Transport is deliberately not implemented. `syncRoot` is a plain directory
 * that something else already syncs (a Git working copy, an OneDrive/Dropbox
 * folder, a network share), so this plugin stays small and speaks no protocol.
 *
 * @module dsh-config-sync
 */

import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'

/** Plugin name shown in loader diagnostics. */
const name = 'config-sync'

/** No hard service dependencies: every service is read defensively at call time. */
const inject = []

/** HTTP prefix the settings UI talks to. */
const BRIDGE = '/dsh-config-sync'

/** Settings file name inside the sync root (travels with the config on purpose). */
const SETTINGS_FILE = 'dsh-config-sync.settings.json'

/** Auto-sync cadences offered by the UI, in milliseconds. */
const AUTO_SYNC_INTERVALS = [
  { id: '15m', ms: 15 * 60 * 1000 },
  { id: '30m', ms: 30 * 60 * 1000 },
  { id: '1h', ms: 60 * 60 * 1000 },
  { id: '6h', ms: 6 * 60 * 60 * 1000 },
  { id: '24h', ms: 24 * 60 * 60 * 1000 },
]

/** Auto-sync defaults; overridden by the persisted settings file. */
const DEFAULT_SETTINGS = {
  autoSync: false,
  autoSyncInterval: '1h',
  autoSyncDirection: 'push',
  autoSyncRunGit: true,
}

/**
 * How often the scheduler wakes up to decide whether an auto-sync is due.
 *
 * This is a *poll* cadence, not the sync cadence: the persisted
 * `autoSyncInterval` decides whether a wake-up actually syncs. One minute keeps
 * a 15-minute setting honest without busy-waiting.
 */
const AUTO_SYNC_TICK_MS = 60 * 1000

/** Files synced from the DSH home root. */
const ROOT_FILES = ['settings.yaml']

/** Files synced from each profile directory. */
const PROFILE_FILES = [
  'package.json',
  'cordis.patch.yml',
  'cordis.yml',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
  'gro.ngilp-hsd-versions.json',
]

/** Secret-bearing files, only ever synced when explicitly enabled. */
const SECRET_FILES = ['.credentials.yaml']

/** Manifest written into the snapshot root; identifies a snapshot at a glance. */
const MANIFEST_NAME = 'dsh-config-sync.json'

/** Snapshot payload schema version. */
const SCHEMA_VERSION = 1

/**
 * Build a snapshot-relative path, always with POSIX separators.
 *
 * Snapshot paths are the one thing that must survive a platform change: a
 * snapshot pushed on Windows is routinely restored on macOS or Linux. Using
 * `join()` here would bake in `\` and produce wrong paths on the other side,
 * so these paths are normalized to `/` and only converted back when touching
 * the local filesystem.
 *
 * @param {...string} segments - path segments inside the snapshot.
 * @returns {string} a `/`-separated snapshot-relative path.
 */
function snapshotPath(...segments) {
  return segments
    .filter((segment) => typeof segment === 'string' && segment.length > 0)
    .map((segment) => segment.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
    .filter((segment) => segment.length > 0)
    .join('/')
}

/**
 * Resolve a snapshot-relative path against a local directory.
 *
 * Splits on `/` rather than passing the string to `join()`, so a snapshot
 * authored on any platform resolves correctly here, and a `..` segment can
 * never escape because `join` normalizes it before {@link isInside} checks.
 *
 * @param {string} baseDir - local directory the snapshot path is relative to.
 * @param {string} relative - `/`-separated snapshot-relative path.
 * @returns {string} the absolute local path.
 */
function localPath(baseDir, relative) {
  return join(baseDir, ...relative.split('/'))
}

/**
 * Run one git command in the sync root.
 *
 * Git is entirely optional: a sync root that is not a repository, or a machine
 * without git installed, simply reports `available: false` and the plugin
 * falls back to plain folder copying.
 *
 * @param {string} cwd - directory to run in.
 * @param {string[]} args - git arguments.
 * @returns {{ ok: boolean, code: number | null, out: string, err: string }} the outcome; never throws.
 */
function runGit(cwd, args) {
  try {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 120000 })
    if (result.error !== undefined) return { ok: false, code: null, out: '', err: String(result.error.message ?? result.error) }
    return {
      ok: result.status === 0,
      code: result.status,
      out: (result.stdout ?? '').trim(),
      err: (result.stderr ?? '').trim(),
    }
  } catch (error) {
    return { ok: false, code: null, out: '', err: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Inspect the git state of a sync root.
 *
 * @param {string} syncRoot - the snapshot directory.
 * @returns {{ available: boolean, isRepo: boolean, branch: string, hasRemote: boolean, dirty: boolean, ahead: number, behind: number, remote: string, lastCommit: string, error: string }} a plain-JSON summary.
 */
function gitState(syncRoot) {
  const none = {
    available: false,
    isRepo: false,
    branch: '',
    hasRemote: false,
    dirty: false,
    ahead: 0,
    behind: 0,
    remote: '',
    lastCommit: '',
    error: '',
  }
  if (!existsSync(syncRoot)) return none
  const probe = runGit(syncRoot, ['rev-parse', '--git-dir'])
  if (!probe.ok) {
    // Distinguish "git missing" from "not a repository".
    const version = runGit(syncRoot, ['--version'])
    return { ...none, available: version.ok, error: version.ok ? '' : version.err }
  }
  const branch = runGit(syncRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).out || 'main'
  const remote = runGit(syncRoot, ['remote', 'get-url', 'origin'])
  const dirty = runGit(syncRoot, ['status', '--porcelain']).out.length > 0
  const lastCommit = runGit(syncRoot, ['log', '-1', '--pretty=%h %ad %s', '--date=short']).out
  let ahead = 0
  let behind = 0
  if (remote.ok) {
    const a = runGit(syncRoot, ['rev-list', '--count', '@{u}..HEAD'])
    const b = runGit(syncRoot, ['rev-list', '--count', 'HEAD..@{u}'])
    ahead = a.ok ? Number(a.out) || 0 : 0
    behind = b.ok ? Number(b.out) || 0 : 0
  }
  return {
    available: true,
    isRepo: true,
    branch,
    hasRemote: remote.ok,
    remote: remote.ok ? remote.out : '',
    dirty,
    ahead,
    behind,
    lastCommit,
    error: '',
  }
}

/**
 * Stage, commit and push whatever the snapshot step wrote.
 *
 * @param {string} syncRoot - git working copy.
 * @param {boolean} push - whether to push after committing.
 * @returns {{ committed: boolean, pushed: boolean, files: string[], message: string }} a plain-JSON report.
 */
function gitCommitAndPush(syncRoot, push) {
  const state = gitState(syncRoot)
  if (!state.isRepo) return { committed: false, pushed: false, files: [], message: 'not a git repository' }

  runGit(syncRoot, ['add', '-A'])
  const staged = runGit(syncRoot, ['diff', '--cached', '--name-only'])
  const files = staged.out.split('\n').filter((line) => line.length > 0)
  if (files.length === 0) return { committed: false, pushed: false, files: [], message: 'nothing to commit' }

  const who = runGit(syncRoot, ['config', 'user.name'])
  const mail = runGit(syncRoot, ['config', 'user.email'])
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
  const commit = runGit(syncRoot, [
    '-c', `user.name=${who.ok && who.out ? who.out : 'dsh-config-sync'}`,
    '-c', `user.email=${mail.ok && mail.out ? mail.out : 'dsh-config-sync@localhost'}`,
    'commit', '-q', '-m', `Sync DSH config ${stamp}`,
  ])
  if (!commit.ok) return { committed: false, pushed: false, files, message: commit.err || 'commit failed' }

  if (!push) return { committed: true, pushed: false, files, message: 'committed (push not requested)' }
  if (!state.hasRemote) return { committed: true, pushed: false, files, message: 'committed (no remote configured)' }
  const pushed = runGit(syncRoot, ['push', 'origin', state.branch])
  return {
    committed: true,
    pushed: pushed.ok,
    files,
    message: pushed.ok ? `pushed ${state.branch}` : `commit ok, push failed: ${pushed.err}`,
  }
}

/**
 * Fetch and fast-forward the sync root from its remote.
 *
 * @param {string} syncRoot - git working copy.
 * @returns {{ fetched: boolean, updated: number, message: string }} a plain-JSON report.
 */
function gitFetchAndFastForward(syncRoot) {
  const state = gitState(syncRoot)
  if (!state.isRepo || !state.hasRemote) return { fetched: false, updated: 0, message: 'not a git repository with a remote' }

  const fetch = runGit(syncRoot, ['fetch', 'origin'])
  if (!fetch.ok) return { fetched: false, updated: 0, message: fetch.err || 'fetch failed' }

  const count = runGit(syncRoot, ['rev-list', '--count', 'HEAD..@{u}'])
  const behind = count.ok ? Number(count.out) || 0 : 0
  if (behind === 0) return { fetched: true, updated: 0, message: 'already up to date' }

  const merge = runGit(syncRoot, ['merge', '--ff-only', '@{u}'])
  if (!merge.ok) return { fetched: true, updated: 0, message: `cannot fast-forward: ${merge.err}` }
  return { fetched: true, updated: behind, message: `fast-forwarded ${behind} commit(s)` }
}

/**
 * Read the persisted sync settings.
 *
 * Settings live *inside* the sync root so they travel with the config; a
 * missing or corrupt file falls back to defaults rather than failing.
 *
 * @param {string} syncRoot - the snapshot directory.
 * @returns {Promise<Record<string, unknown>>} the effective settings.
 */
async function readSettings(syncRoot) {
  try {
    const parsed = JSON.parse(await readFile(join(syncRoot, SETTINGS_FILE), 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ...DEFAULT_SETTINGS, ...parsed }
    }
  } catch {
    // absent or corrupt -> defaults
  }
  return { ...DEFAULT_SETTINGS }
}

/**
 * Persist the sync settings, accepting only known keys.
 *
 * @param {string} syncRoot - the snapshot directory.
 * @param {Record<string, unknown>} patch - partial settings to merge.
 * @returns {Promise<Record<string, unknown>>} the stored settings.
 */
async function writeSettings(syncRoot, patch) {
  const current = await readSettings(syncRoot)
  const next = { ...current }
  if (typeof patch.autoSync === 'boolean') next.autoSync = patch.autoSync
  if (typeof patch.autoSyncDirection === 'string' && ['push', 'pull'].includes(patch.autoSyncDirection)) {
    next.autoSyncDirection = patch.autoSyncDirection
  }
  if (typeof patch.autoSyncRunGit === 'boolean') next.autoSyncRunGit = patch.autoSyncRunGit
  if (typeof patch.autoSyncInterval === 'string' && AUTO_SYNC_INTERVALS.some((entry) => entry.id === patch.autoSyncInterval)) {
    next.autoSyncInterval = patch.autoSyncInterval
  }
  await mkdir(syncRoot, { recursive: true })
  await writeFile(join(syncRoot, SETTINGS_FILE), JSON.stringify(next, undefined, 2) + '\n', 'utf8')
  return next
}

/**
 * Path of the per-machine auto-sync bookkeeping file.
 *
 * Deliberately stored in the DSH *home*, not in the sync root: the sync root is
 * usually a git working copy, where `git add -A` would commit this file and the
 * "last run" timestamp would then travel to other machines — making a freshly
 * cloned machine skip its first sync. Keeping it outside means every machine
 * runs its own schedule from its own clock.
 *
 * @param {string} home - resolved DSH home.
 * @returns {string} absolute path of the state file.
 */
function autoSyncStatePath(home) {
  return join(home, '.config-sync-state.json')
}

/**
 * Read when the last automatic sync ran on this machine.
 *
 * @param {string} home - resolved DSH home.
 * @returns {number | undefined} epoch milliseconds of the last auto-sync.
 */
function readLastRun(home) {
  try {
    const parsed = JSON.parse(readFileSync(autoSyncStatePath(home), 'utf8'))
    return typeof parsed?.lastRun === 'number' ? parsed.lastRun : undefined
  } catch {
    return undefined
  }
}

/**
 * Record that an automatic sync just ran on this machine.
 *
 * @param {string} home - resolved DSH home.
 * @returns {void}
 */
function writeLastRun(home) {
  try {
    writeFileSync(autoSyncStatePath(home), JSON.stringify({ lastRun: Date.now() }) + '\n', 'utf8')
  } catch {
    // Best effort: a failed write only means the next tick re-evaluates sooner.
  }
}

/**
 * Detect whether a usable GitHub credential exists, without exposing it.
 *
 * Only presence and provenance cross this boundary — never the value — so the
 * UI can offer one-click setup without the secret ever reaching the browser.
 *
 * @returns {{ available: boolean, source: string, login: string }} presence only.
 */
function detectGithubToken() {
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN']) {
    const value = process.env[key]
    if (typeof value === 'string' && value.trim() !== '') return { available: true, source: `env:${key}`, login: '' }
  }
  if (runGit(process.cwd(), ['auth', 'status']).ok) {
    const login = runGit(process.cwd(), ['api', 'user', '--jq', '.login'])
    return { available: true, source: 'gh-cli', login: login.ok ? login.out : '' }
  }
  return { available: false, source: '', login: '' }
}

/**
 * Resolve a GitHub token for API use, or `undefined` when none is available.
 *
 * @returns {string | undefined} the token value, held in memory only.
 */
function resolveGithubToken() {
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN']) {
    const value = process.env[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  if (!runGit(process.cwd(), ['auth', 'status']).ok) return undefined
  const token = runGit(process.cwd(), ['auth', 'token'])
  return token.ok && token.out !== '' ? token.out : undefined
}

/**
 * Create a private GitHub repository for the snapshot and wire it as `origin`.
 *
 * Speaks the REST API directly so a caller-supplied token works as well as the
 * ambient `gh`/env credential. The token is used only for these requests and is
 * never persisted, returned, or logged.
 *
 * @param {string} syncRoot - local snapshot directory to publish.
 * @param {string} token - a GitHub token with `repo` scope.
 * @param {string | undefined} repoName - repository name; defaults to `dsh-config`.
 * @returns {Promise<{ ok: boolean, url?: string, login?: string, error?: string }>} a plain-JSON result.
 */
async function createPrivateRepo(syncRoot, token, repoName) {
  const api = (path, init) =>
    fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'dsh-config-sync',
        'content-type': 'application/json',
        ...(init?.headers ?? {}),
      },
    })

  try {
    const me = await api('/user', { method: 'GET' })
    if (!me.ok) return { ok: false, error: `GitHub rejected the token (HTTP ${me.status})` }
    const { login } = await me.json()
    const display = typeof repoName === 'string' && repoName.trim() !== '' ? repoName.trim() : 'dsh-config'

    const created = await api('/user/repos', {
      method: 'POST',
      body: JSON.stringify({
        name: display,
        private: true,
        description: 'DeepSeek Harness configuration snapshot (recipe only, no secrets, no node_modules)',
        auto_init: false,
      }),
    })
    // 422 means "already exists", which is the desired end state, not a failure.
    if (!created.ok && created.status !== 422) {
      const detail = await created.text()
      return { ok: false, error: `creating the repository failed (HTTP ${created.status}): ${detail.slice(0, 300)}` }
    }

    const url = `https://github.com/${login}/${display}.git`
    if (runGit(syncRoot, ['remote', 'get-url', 'origin']).ok) runGit(syncRoot, ['remote', 'set-url', 'origin', url])
    else runGit(syncRoot, ['remote', 'add', 'origin', url])

    const branch = runGit(syncRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])
    const branchName = branch.ok && branch.out !== '' ? branch.out : 'main'
    runGit(syncRoot, ['branch', '-M', branchName])

    // Push with the token embedded in the URL so the credential never has to be
    // written into .git/config; the plain remote above stays credential-free.
    const authUrl = `https://x-access-token:${token}@github.com/${login}/${display}.git`
    const pushed = runGit(syncRoot, ['push', authUrl, `${branchName}:${branchName}`, '--force'])
    return pushed.ok
      ? { ok: true, url: `https://github.com/${login}/${display}`, login }
      : { ok: false, error: `push failed: ${pushed.err.slice(0, 300)}` }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Resolve the DeepSeek Harness home exactly like the harness does.
 *
 * Precedence: explicit config, then `$DSH_HOME` (ignored when blank or
 * whitespace, so a blank override can never resolve to the cwd), then `~/.dsh`.
 *
 * @param {unknown} configured - explicit override from plugin config.
 * @returns {string} absolute harness home path.
 */
function resolveHome(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') return resolve(configured)
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv)
  return join(homedir(), '.dsh')
}

/**
 * Expand a leading `~` against the OS home.
 *
 * @param {string} value - possibly tilde-prefixed path.
 * @returns {string} the expanded path, or the original value.
 */
function expandHome(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

/**
 * Whether one path is the same as, or nested inside, another.
 *
 * Both sides are resolved first, so `.`/`..` and separator differences cannot
 * smuggle a path out of the snapshot root.
 *
 * @param {string} parent - candidate ancestor.
 * @param {string} child - candidate descendant.
 * @returns {boolean} true when `child` is `parent` or below it.
 */
function isInside(parent, child) {
  const base = resolve(parent)
  const target = resolve(child)
  if (base === target) return true
  return target.startsWith(base.endsWith(sep) ? base : base + sep)
}

/**
 * Describe a file's size, or `undefined` when it is absent.
 *
 * @param {string} path - absolute file path.
 * @returns {Promise<number | undefined>} byte size, or undefined when missing.
 */
async function sizeOf(path) {
  try {
    const info = await stat(path)
    return info.isFile() ? info.size : undefined
  } catch {
    return undefined
  }
}

/**
 * List profile directory names under a DSH home.
 *
 * `node_modules` is excluded because it is a resolution root, not a profile.
 *
 * @param {string} home - resolved DSH home.
 * @returns {Promise<string[]>} sorted profile names.
 */
async function listProfiles(home) {
  let entries
  try {
    entries = await readdir(join(home, 'profiles'), { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort()
}

/**
 * Pick the profile whose plugin stack should be synced.
 *
 * An explicit config value wins. Otherwise the profile owning a manifest is
 * chosen, preferring `web` because that is what `dsh web` boots and therefore
 * where plugins are installed in this deployment.
 *
 * @param {string} home - resolved DSH home.
 * @param {unknown} configured - explicit profile from plugin config.
 * @returns {Promise<{ profile: string | undefined, candidates: string[], reason: string }>} the choice plus why.
 */
async function detectProfile(home, configured) {
  if (typeof configured === 'string' && configured.trim() !== '') {
    return { profile: configured.trim(), candidates: [], reason: 'configured' }
  }
  const all = await listProfiles(home)
  const withManifest = []
  for (const candidate of all) {
    if ((await sizeOf(join(home, 'profiles', candidate, 'package.json'))) !== undefined) withManifest.push(candidate)
  }
  if (withManifest.length === 0) return { profile: undefined, candidates: all, reason: 'no profile has a package.json' }
  if (withManifest.includes('web')) return { profile: 'web', candidates: withManifest, reason: 'default web profile' }
  if (withManifest.length === 1) return { profile: withManifest[0], candidates: withManifest, reason: 'only profile with a manifest' }
  return { profile: withManifest[0], candidates: withManifest, reason: 'first profile with a manifest' }
}

/**
 * Read a profile's plugin manifest as plain JSON, or `undefined` when absent.
 *
 * @param {string} home - resolved DSH home.
 * @param {string} profile - profile name.
 * @returns {Promise<Record<string, unknown> | undefined>} parsed manifest.
 */
async function readManifest(home, profile) {
  try {
    const parsed = JSON.parse(await readFile(join(home, 'profiles', profile, 'package.json'), 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Extract the dependency names and bundle list from a manifest.
 *
 * Only leaf strings are read, so no live DSH object is ever copied or retained.
 *
 * @param {unknown} manifest - parsed profile manifest.
 * @returns {{ dependencies: string[], bundles: string[] }} plain string lists.
 */
function summarizeManifest(manifest) {
  const source = manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest) ? manifest : {}
  const dependencies = source.dependencies
  const bundles = source.dsh?.profile?.bundles
  return {
    dependencies:
      dependencies !== null && typeof dependencies === 'object' && !Array.isArray(dependencies)
        ? Object.keys(dependencies).sort()
        : [],
    bundles: Array.isArray(bundles) ? bundles.filter((value) => typeof value === 'string') : [],
  }
}

/**
 * Compute the sha256 of a string.
 *
 * @param {string} text - content to hash.
 * @returns {string} lowercase hex digest.
 */
function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Build the complete file list a snapshot should contain.
 *
 * @param {string} home - resolved DSH home.
 * @param {string} profile - profile to capture.
 * @param {{ includeSecrets: boolean, includeLockfile: boolean }} options - capture options.
 * @returns {Promise<Array<{ from: string, to: string, scope: string, bytes: number }>>} resolvable files.
 */
async function planCapture(home, profile, options) {
  const plan = []
  const consider = async (from, to, scope) => {
    if (to.endsWith('pnpm-lock.yaml') && !options.includeLockfile) return
    const bytes = await sizeOf(from)
    if (bytes === undefined) return
    plan.push({ from, to, scope, bytes })
  }

  for (const file of ROOT_FILES) await consider(join(home, file), file, 'settings')
  if (options.includeSecrets) for (const file of SECRET_FILES) await consider(join(home, file), file, 'secrets')
  for (const file of PROFILE_FILES) {
    await consider(join(home, 'profiles', profile, file), snapshotPath('profiles', profile, file), 'profile')
  }
  return plan
}

/**
 * List every synced payload file already inside a snapshot directory.
 *
 * Only paths under `profiles/` plus the known root files are reported, so the
 * manifest and anything else a user dropped into the folder is ignored.
 *
 * @param {string} snapshotDir - snapshot root.
 * @returns {Promise<string[]>} snapshot-relative paths, sorted.
 */
async function listSnapshotFiles(snapshotDir) {
  const found = []
  for (const file of [...ROOT_FILES, ...SECRET_FILES]) {
    if ((await sizeOf(join(snapshotDir, file))) !== undefined) found.push(file)
  }
  let profiles
  try {
    profiles = await readdir(join(snapshotDir, 'profiles'), { withFileTypes: true })
  } catch {
    return found.sort()
  }
  for (const entry of profiles) {
    if (!entry.isDirectory()) continue
    for (const file of PROFILE_FILES) {
      const relative = snapshotPath('profiles', entry.name, file)
      if ((await sizeOf(localPath(snapshotDir, relative))) !== undefined) found.push(relative)
    }
  }
  return found.sort()
}

/**
 * Two-way diff between a capture plan and what a snapshot currently holds.
 *
 * Comparison is by content hash, so an identical file never shows as a change.
 *
 * @param {Array<{ from: string, to: string, scope: string, bytes: number }>} plan - capture plan.
 * @param {string} snapshotDir - snapshot root the plan would be applied to.
 * @returns {Promise<{ added: string[], changed: string[], unchanged: string[], removed: string[], total: number }>} per-file classification.
 */
async function diffPlan(plan, snapshotDir) {
  const added = []
  const changed = []
  const unchanged = []
  const wanted = new Set()

  for (const entry of plan) {
    wanted.add(entry.to)
    const target = localPath(snapshotDir, entry.to)
    if ((await sizeOf(target)) === undefined) {
      added.push(entry.to)
      continue
    }
    let same = false
    try {
      same = sha256(await readFile(entry.from, 'utf8')) === sha256(await readFile(target, 'utf8'))
    } catch {
      same = false
    }
    if (same) unchanged.push(entry.to)
    else changed.push(entry.to)
  }

  const removed = []
  for (const existing of await listSnapshotFiles(snapshotDir)) {
    if (!wanted.has(existing)) removed.push(existing)
  }
  return { added, changed, unchanged, removed, total: plan.length }
}

/**
 * Write a capture plan into the snapshot directory.
 *
 * Files are copied one by one through an explicit allowlist, so this function
 * can only ever touch paths the plan already vetted — never anything under
 * `node_modules`, and never a caller-supplied path.
 *
 * @param {string} snapshotDir - snapshot root to write.
 * @param {Array<{ from: string, to: string }>} plan - vetted files to copy.
 * @returns {Promise<{ written: string[] }>} the paths written, snapshot-relative.
 */
async function applyPlan(snapshotDir, plan) {
  const written = []
  for (const entry of plan) {
    const target = localPath(snapshotDir, entry.to)
    if (!isInside(snapshotDir, target)) throw new Error(`refusing to write outside the snapshot root: ${entry.to}`)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(entry.from, target)
    written.push(entry.to)
  }
  return { written }
}

/**
 * Write the snapshot manifest describing what was captured.
 *
 * @param {string} snapshotDir - snapshot root.
 * @param {Record<string, unknown>} manifest - manifest value to persist.
 * @returns {Promise<void>} resolves once written.
 */
async function writeManifest(snapshotDir, manifest) {
  await mkdir(snapshotDir, { recursive: true })
  await writeFile(join(snapshotDir, MANIFEST_NAME), JSON.stringify(manifest, undefined, 2) + '\n', 'utf8')
}

/**
 * Read a snapshot manifest, returning `undefined` for a missing or corrupt one.
 *
 * @param {string} snapshotDir - snapshot root.
 * @returns {Promise<Record<string, unknown> | undefined>} parsed manifest.
 */
async function readManifestFile(snapshotDir) {
  try {
    const parsed = JSON.parse(await readFile(join(snapshotDir, MANIFEST_NAME), 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Keep only the newest `retention` backup directories.
 *
 * @param {string} backupsRoot - directory holding timestamped backups.
 * @param {number} retention - maximum number to keep; non-positive disables pruning.
 * @returns {Promise<string[]>} names of the directories removed.
 */
async function pruneBackups(backupsRoot, retention) {
  if (!Number.isFinite(retention) || retention <= 0) return []
  let names
  try {
    names = (await readdir(backupsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
  const doomed = names.slice(0, Math.max(0, names.length - retention))
  for (const doomedName of doomed) await rm(join(backupsRoot, doomedName), { recursive: true, force: true })
  return doomed
}

/**
 * Snapshot the current files before an apply overwrites them.
 *
 * Only files the apply is about to touch are copied, under
 * `<syncRoot>/.backups/<timestamp>-<rand>/`.
 *
 * @param {string} home - resolved DSH home.
 * @param {string} snapshotDir - snapshot about to be applied.
 * @param {number} retention - how many backups to keep.
 * @returns {Promise<string | undefined>} the backup directory, or undefined when nothing existed to back up.
 */
async function makeBackup(home, snapshotDir, retention) {
  const files = await listSnapshotFiles(snapshotDir)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupDir = join(dirname(snapshotDir), '.backups', `${stamp}-${randomUUID().slice(0, 8)}`)
  let copied = 0
  for (const relative of files) {
    const source = join(home, relative)
    if ((await sizeOf(source)) === undefined) continue
    const target = localPath(backupDir, relative)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(source, target)
    copied += 1
  }
  if (copied === 0) {
    await rm(backupDir, { recursive: true, force: true })
    return undefined
  }
  await writeFile(
    join(backupDir, MANIFEST_NAME),
    JSON.stringify({ kind: 'pre-apply-backup', at: new Date().toISOString(), files: copied }, undefined, 2) + '\n',
    'utf8',
  )
  await pruneBackups(dirname(backupDir), retention)
  return backupDir
}

/**
 * Copy a snapshot's files back into the DSH home.
 *
 * Every source is re-derived from the fixed filename allowlist rather than from
 * any caller-supplied path, and each destination is re-checked for
 * containment. A local backup is taken before the first overwrite.
 *
 * @param {string} home - resolved DSH home.
 * @param {string} snapshotDir - snapshot root to read.
 * @param {{ backupRetention: number }} options - apply options.
 * @returns {Promise<{ applied: string[], skipped: string[], backupDir: string | undefined }>} per-file outcome.
 */
async function applySnapshot(home, snapshotDir, options) {
  const files = await listSnapshotFiles(snapshotDir)
  if (files.length === 0) return { applied: [], skipped: [], backupDir: undefined }

  const backupDir = await makeBackup(home, snapshotDir, options.backupRetention)
  const applied = []
  const skipped = []
  for (const relative of files) {
    const source = localPath(snapshotDir, relative)
    const target = localPath(home, relative)
    if (!isInside(home, target) || !isInside(snapshotDir, source)) {
      skipped.push(relative)
      continue
    }
    await mkdir(dirname(target), { recursive: true })
    await copyFile(source, target)
    applied.push(relative)
  }
  return { applied, skipped, backupDir }
}

/**
 * Describe the local DSH installation a snapshot would be applied to.
 *
 * @param {string} home - resolved DSH home.
 * @param {string} syncRoot - resolved snapshot root.
 * @returns {Promise<Record<string, unknown>>} a small plain-JSON status object.
 */
async function describeLocal(home, syncRoot) {
  return {
    home,
    homeExists: existsSync(home),
    settingsYaml: (await sizeOf(join(home, 'settings.yaml'))) !== undefined,
    credentials: (await sizeOf(join(home, '.credentials.yaml'))) !== undefined,
    profiles: await listProfiles(home),
    syncRootExists: existsSync(syncRoot),
  }
}

/**
 * Human-readable one-line summary of a file list.
 *
 * @param {unknown} files - candidate list of snapshot-relative paths.
 * @returns {string} a compact description.
 */
function summarizeFiles(files) {
  const list = Array.isArray(files) ? files.filter((entry) => typeof entry === 'string') : []
  if (list.length === 0) return 'none'
  return list.join(', ')
}

/**
 * Build a registry-ready tool definition.
 *
 * The registry requires `{ name, description, parameters, output: { schema,
 * render } }`, where `render` returns content blocks and `parameters` uses the
 * shorthand spec (`type` + `description` + optional `required: true`). The
 * author-only `{ type: 'json' }` output node becomes an unconstrained schema,
 * which suits these report objects.
 *
 * @param {string} toolName - model-facing tool name.
 * @param {string} description - when the model should call it.
 * @param {Record<string, unknown>} parameters - shorthand parameter spec.
 * @param {(args: Record<string, unknown>) => Promise<Record<string, unknown>>} execute - business logic.
 * @param {(value: Record<string, unknown>, args: Record<string, unknown>) => string} format - model-facing text.
 * @returns {Record<string, unknown>} a definition accepted by `tools.register`.
 */
function makeTool(toolName, description, parameters, execute, format) {
  return {
    name: toolName,
    description,
    parameters,
    output: {
      schema: { type: 'json' },
      render(args, value) {
        return [{ type: 'text', text: format(value ?? {}, args ?? {}) }]
      },
    },
    execute,
  }
}

/**
 * Cordis plugin entry point.
 *
 * Registers two model-callable tools and one human slash command. All three
 * share the same capture/diff/apply helpers, so the agent path and the human
 * path cannot drift apart.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {Record<string, unknown>} config - resolved plugin configuration.
 * @returns {void}
 */
function apply(ctx, config) {
  const settings = config !== null && typeof config === 'object' ? config : {}
  const home = resolveHome(settings.home)
  const syncRoot = resolve(
    expandHome(
      typeof settings.syncRoot === 'string' && settings.syncRoot.trim() !== ''
        ? settings.syncRoot
        : join(home, 'config-sync'),
    ),
  )
  const includeSecrets = settings.includeSecrets === true
  const includeLockfile = settings.includeLockfile !== false
  const backupRetention = Number.isFinite(settings.backupRetention) ? Number(settings.backupRetention) : 10
  const configuredProfile = settings.profile
  /** Last automatic-sync outcome; in-memory only, surfaced by the bridge. */
  let autoSyncState = null

  const report = (level, message) => {
    const line = `config-sync: ${message}`
    if (level === 'error' || level === 'warn') console.error(line)
    else console.log(line)
  }

  /** Resolve the profile to operate on, honouring explicit config first. */
  const chooseProfile = () => detectProfile(home, configuredProfile)

  /**
   * Capture the local recipe into `syncRoot`.
   *
   * @param {{ dryRun?: boolean }} options - `dryRun` computes the diff without writing.
   * @returns {Promise<Record<string, unknown>>} a plain-JSON report.
   */
  const capture = async (options = {}) => {
    const detected = await chooseProfile()
    if (detected.profile === undefined) {
      return { ok: false, error: `no DSH profile found under ${join(home, 'profiles')}` }
    }
    const plan = await planCapture(home, detected.profile, { includeSecrets, includeLockfile })
    if (plan.length === 0) {
      return { ok: false, error: `nothing to sync: no known config files exist for profile "${detected.profile}"` }
    }
    const diff = await diffPlan(plan, syncRoot)
    if (options.dryRun === true) {
      return {
        ok: true,
        dryRun: true,
        direction: 'push',
        syncRoot,
        profile: detected.profile,
        profileReason: detected.reason,
        secretsIncluded: includeSecrets,
        changes: { added: diff.added, changed: diff.changed, unchanged: diff.unchanged, removed: diff.removed },
      }
    }
    const { written } = await applyPlan(syncRoot, plan)
    await writeManifest(syncRoot, {
      kind: 'dsh-config-snapshot',
      schemaVersion: SCHEMA_VERSION,
      at: new Date().toISOString(),
      host: { platform: process.platform, arch: process.arch, node: process.version },
      profile: detected.profile,
      secretsIncluded: includeSecrets,
      lockfileIncluded: includeLockfile,
      files: plan.map((entry) => ({ path: entry.to, scope: entry.scope, bytes: entry.bytes })),
      plugins: summarizeManifest(await readManifest(home, detected.profile)),
    })
    report('info', `captured ${written.length} file(s) for profile "${detected.profile}" into ${syncRoot}`)
    return {
      ok: true,
      direction: 'push',
      syncRoot,
      profile: detected.profile,
      profileReason: detected.reason,
      secretsIncluded: includeSecrets,
      written,
      added: diff.added,
      changed: diff.changed,
      removed: diff.removed,
    }
  }

  /**
   * Apply `syncRoot` back onto this machine.
   *
   * @param {{ dryRun?: boolean }} options - `dryRun` reports the plan without writing.
   * @returns {Promise<Record<string, unknown>>} a plain-JSON report.
   */
  const restore = async (options = {}) => {
    const manifest = await readManifestFile(syncRoot)
    const files = await listSnapshotFiles(syncRoot)
    if (files.length === 0) {
      return { ok: false, error: `no snapshot found in ${syncRoot} — push from the source machine first` }
    }
    const detected = await chooseProfile()
    const targetProfile =
      detected.profile ?? (typeof manifest?.profile === 'string' ? manifest.profile : undefined)
    if (targetProfile === undefined) {
      return { ok: false, error: 'no DSH profile to restore into: set `profile` in the plugin config' }
    }
    const snapshotAt = typeof manifest?.at === 'string' ? manifest.at : 'unknown'
    if (options.dryRun === true) {
      const actions = []
      for (const relative of files) {
        const exists = (await sizeOf(localPath(home, relative))) !== undefined
        actions.push({ path: relative, action: exists ? 'overwrite' : 'create' })
      }
      return {
        ok: true,
        dryRun: true,
        direction: 'pull',
        syncRoot,
        profile: targetProfile,
        snapshotAt,
        snapshotHost: manifest?.host ?? null,
        secretsIncluded: manifest?.secretsIncluded === true,
        snapshotPlugins: manifest?.plugins ?? null,
        actions,
      }
    }
    const result = await applySnapshot(home, syncRoot, { backupRetention })
    report('info', `applied ${result.applied.length} file(s) for profile "${targetProfile}" from ${syncRoot}`)
    const needsRebuild = result.applied.some((file) => file.endsWith('package.json') || file.endsWith('pnpm-lock.yaml'))
    return {
      ok: true,
      direction: 'pull',
      syncRoot,
      profile: targetProfile,
      snapshotAt,
      secretsIncluded: manifest?.secretsIncluded === true,
      applied: result.applied,
      skipped: result.skipped,
      backupDir: result.backupDir ?? null,
      pluginsNow: summarizeManifest(await readManifest(home, targetProfile)),
      nextStep: needsRebuild ? `dsh plugin --profile ${targetProfile} install` : '',
    }
  }

  /** Report local state, snapshot state, and the difference between them. */
  const status = async () => {
    const detected = await chooseProfile()
    const snapshotManifest = await readManifestFile(syncRoot)
    const changes =
      detected.profile === undefined
        ? null
        : await diffPlan(await planCapture(home, detected.profile, { includeSecrets, includeLockfile }), syncRoot)
    return {
      ok: true,
      syncRoot,
      syncRootExists: existsSync(syncRoot),
      profile: detected.profile ?? null,
      profileReason: detected.reason,
      profileCandidates: detected.candidates,
      includeSecrets,
      includeLockfile,
      backupRetention,
      local: await describeLocal(home, syncRoot),
      snapshot: {
        files: await listSnapshotFiles(syncRoot),
        at: typeof snapshotManifest?.at === 'string' ? snapshotManifest.at : null,
        host: snapshotManifest?.host ?? null,
        secretsIncluded: snapshotManifest?.secretsIncluded === true,
        plugins: snapshotManifest?.plugins ?? null,
      },
      changes,
    }
  }

  // --- HTTP bridge for the settings UI ---------------------------------------
  //
  // The settings page is a browser surface, so it reaches this host half over
  // same-origin HTTP: `webServer.register` gives us exact routes under BRIDGE.
  // GET routes are read-only; every mutating route is POST and additionally
  // requires a same-origin Origin header, so a random page cannot drive sync.

  // `ctx.inject` rather than `ctx.get`: the web server service is mounted by a
  // sibling bundle row, and at this row's apply() time it may not exist yet.
  // `ctx.get` would return undefined once and the bridge would never mount
  // (silently — the plugin still reports as loaded). inject waits for the
  // service and runs the callback when it appears.
  ctx.inject(['webServer'], (host) => {
    const webServer = host.webServer
    if (webServer === undefined || typeof webServer.register !== 'function') return
    /** Send one JSON response. */
    const sendJson = (response, status, value) => {
      const body = JSON.stringify(value)
      response.writeHead(status, {
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
      })
      response.end(body)
    }

    /** Reject a mutating request that did not come from this local web origin. */
    const trustedOrigin = (request) => {
      const origin = request.headers.origin
      const host = request.headers.host
      if (origin === undefined || host === undefined) return false
      try {
        const url = new URL(origin)
        const local = new Set(['localhost', '127.0.0.1', '[::1]'])
        return url.host === host && local.has(url.hostname)
      } catch {
        return false
      }
    }

    /** Read a size-capped JSON body. */
    const readBody = async (request) => {
      const chunks = []
      let size = 0
      for await (const chunk of request) {
        size += chunk.length
        if (size > 64 * 1024) throw new Error('request body too large')
        chunks.push(chunk)
      }
      if (chunks.length === 0) return {}
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      return parsed !== null && typeof parsed === 'object' ? parsed : {}
    }

    /** One route: GET reports, POST mutates, both same-origin-guarded for POST. */
    const route = (path, handler) =>
      webServer.register({
        kind: 'exact',
        path: `${BRIDGE}${path}`,
        handler: async (request, response) => {
          try {
            if (request.method === 'POST') {
              if (!trustedOrigin(request)) {
                sendJson(response, 403, { ok: false, error: 'untrusted origin' })
                return
              }
              const body = await readBody(request)
              sendJson(response, 200, await handler(body, request))
              return
            }
            if (request.method === 'GET') {
              sendJson(response, 200, await handler({}, request))
              return
            }
            response.writeHead(405, { allow: 'GET, POST' })
            response.end()
          } catch (error) {
            sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        },
      })

    ctx.effect(() => {
      const disposers = [
        route('/status', async () => {
          const detected = await chooseProfile()
          const state = await status()
          return {
            ok: true,
            settings: await readSettings(syncRoot),
            intervals: AUTO_SYNC_INTERVALS.map((entry) => entry.id),
            profile: detected.profile ?? null,
            profileReason: detected.reason,
            profileCandidates: detected.candidates,
            syncRoot,
            includeSecrets,
            includeLockfile,
            backupRetention,
            hasGithubToken: detectGithubToken(),
            git: gitState(syncRoot),
            autoSyncState,
            lastAutoSyncAt: readLastRun(home) ?? null,
            ...state,
          }
        }),
        route('/push', async (body) => {
          const dryRun = body.dryRun === true
          const result = await capture({ dryRun })
          if (result.ok !== true) return result
          let git = null
          if (!dryRun && body.git !== false) git = gitCommitAndPush(syncRoot, body.push !== false)
          return { ...result, git }
        }),
        route('/pull', async (body) => {
          const dryRun = body.confirm !== true
          if (!dryRun && body.git !== false) {
            const fetched = gitFetchAndFastForward(syncRoot)
            const result = await restore({ dryRun: false })
            return { ...result, git: fetched }
          }
          return restore({ dryRun })
        }),
        route('/settings', async (body) => {
          const stored = await writeSettings(syncRoot, body)
          return { ok: true, settings: stored }
        }),
        route('/github', async (body) => {
          const token = typeof body.token === 'string' ? body.token.trim() : ''
          if (token === '') return { ok: false, error: 'empty token' }
          const result = createPrivateRepo(syncRoot, token, typeof body.name === 'string' ? body.name : undefined)
          const stored = result.ok
            ? await writeSettings(syncRoot, { autoSync: true, autoSyncRunGit: true })
            : await readSettings(syncRoot)
          return { ...result, settings: stored }
        }),
        route('/git', async (body) => {
          if (body.action === 'commit') return { ok: true, git: gitCommitAndPush(syncRoot, body.push !== false) }
          if (body.action === 'fetch') return { ok: true, git: gitFetchAndFastForward(syncRoot) }
          return { ok: false, error: `unknown git action: ${String(body.action)}` }
        }),
      ]
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'config-sync: http bridge')

    report('info', `settings UI bridge mounted at ${BRIDGE}/status`)
  })

  // --- Automatic sync scheduler ---------------------------------------------

  if (settings.autoSyncScheduler !== false) {
    // Same reasoning as the bridge: inject, so a timer service mounted later in
    // the boot still arms the scheduler instead of silently skipping it.
    ctx.inject(['timer'], (ticking) => {
      const timer = ticking.timer
      if (timer === undefined || typeof timer.interval !== 'function') return
      {
      ctx.effect(() => {
        let running = false
        const tick = async () => {
          if (running) return
          const stored = await readSettings(syncRoot)
          if (stored.autoSync !== true) return
          // The poll runs every minute; the *stored interval* decides whether this
          // wake-up is actually due, otherwise a 24h setting would sync every minute.
          const interval = AUTO_SYNC_INTERVALS.find((entry) => entry.id === stored.autoSyncInterval)
          const everyMs = interval === undefined ? AUTO_SYNC_INTERVALS[2].ms : interval.ms
          const last = readLastRun(home)
          if (last !== undefined && Date.now() - last < everyMs) return
          running = true
          try {
            autoSyncState = { at: new Date().toISOString(), interval: stored.autoSyncInterval, direction: stored.autoSyncDirection }
            if (stored.autoSyncDirection === 'pull') {
              if (stored.autoSyncRunGit !== false) gitFetchAndFastForward(syncRoot)
              const result = await restore({ dryRun: false })
              autoSyncState = { ...autoSyncState, ok: result.ok === true, detail: result.ok === true ? `applied ${result.applied.length}` : String(result.error) }
              if (result.ok === true) report('info', `auto-sync pulled ${result.applied.length} file(s)`)
            } else {
              const result = await capture({})
              if (result.ok !== true) {
                autoSyncState = { ...autoSyncState, ok: false, detail: String(result.error) }
              } else {
                const git = stored.autoSyncRunGit !== false ? gitCommitAndPush(syncRoot, true) : null
                autoSyncState = {
                  ...autoSyncState,
                  ok: true,
                  detail: `${result.written.length} file(s)${git ? `; ${git.message}` : ''}`,
                }
                report('info', `auto-sync pushed ${result.written.length} file(s)${git ? ` (${git.message})` : ''}`)
              }
            }
          } catch (error) {
            autoSyncState = { ...autoSyncState, ok: false, detail: error instanceof Error ? error.message : String(error) }
            report('warn', `auto-sync failed: ${error instanceof Error ? error.message : String(error)}`)
          } finally {
            writeLastRun(home)
            running = false
          }
        }
        // One cheap tick per minute; the stored interval decides whether to act.
        return timer.interval(() => {
          void tick()
        }, AUTO_SYNC_TICK_MS)
      }, 'config-sync: auto-sync scheduler')
      report('info', 'auto-sync scheduler armed (checks every minute)')
      }
    })
  }

  // --- Model-callable tools -------------------------------------------------

  ctx.inject(['tools'], (scoped) => {
    scoped.effect(() => {
      const disposers = [
        scoped.tools.register(
          makeTool(
            'config_sync_status',
            'Report this machine\'s DSH configuration, the synced snapshot in syncRoot, and the exact difference between them. Read-only: never writes anything. Call this first to decide whether a push or a pull is needed, or to inspect what a snapshot contains.',
            {},
            async () => status(),
            (value) => {
              const change = value.changes
              return (
                `DSH config sync\n` +
                `  home:      ${value.local?.home}\n` +
                `  syncRoot:  ${value.syncRoot}${value.syncRootExists ? '' : '  [missing — a push creates it]'}\n` +
                `  profile:   ${value.profile ?? '(none detected)'} (${value.profileReason})\n` +
                `  local profiles: ${summarizeFiles(value.local?.profiles)}\n` +
                `  snapshot:  ${(value.snapshot?.files ?? []).length} file(s)` +
                (value.snapshot?.at ? `, captured ${value.snapshot.at}` : '') +
                (value.snapshot?.secretsIncluded ? ', INCLUDING secrets' : '') +
                `\n  local settings.yaml: ${value.local?.settingsYaml ? 'present' : 'absent'}` +
                `\n  local credentials:   ${value.local?.credentials ? 'present' : 'absent'}` +
                (change
                  ? `\n  pending vs snapshot: ${change.changed.length} changed, ${change.added.length} new, ${change.removed.length} removed` +
                    (change.changed.length > 0 ? `\n    changed: ${summarizeFiles(change.changed)}` : '') +
                    (change.added.length > 0 ? `\n    new:     ${summarizeFiles(change.added)}` : '')
                  : '\n  pending vs snapshot: no profile selected, nothing compared')
              )
            },
          ),
        ),
        scoped.tools.register(
          makeTool(
            'config_sync_push',
            'Capture this machine\'s DSH configuration into the syncRoot folder: settings.yaml, the profile\'s package.json (plugin manifest + bundle layers), cordis.patch.yml (your override layer), pnpm-workspace.yaml (build allowlist), the lockfile and the installed-version record. Only this small recipe is copied — node_modules is never included, and .credentials.yaml only when includeSecrets is enabled. Moving the files is the folder\'s own job (Git/OneDrive/Dropbox/share). Pass dryRun to preview without writing.',
            { dryRun: { type: 'boolean', description: 'Preview the file changes without writing anything.' } },
            async (args) => capture({ dryRun: args?.dryRun === true }),
            (value, args) =>
              value.ok === false
                ? `Push failed: ${value.error}`
                : `${args.dryRun === true ? 'Push preview' : 'Pushed'} profile "${value.profile}" -> ${value.syncRoot}\n` +
                  `  changed: ${summarizeFiles(value.changed)}\n` +
                  `  added:   ${summarizeFiles(value.added)}\n` +
                  `  removed: ${summarizeFiles(value.removed)}` +
                  (Array.isArray(value.written) ? `\n  wrote ${value.written.length} file(s)` : '\n  nothing written (dry run)'),
          ),
        ),
        scoped.tools.register(
          makeTool(
            'config_sync_pull',
            'Apply the synced configuration from syncRoot onto this machine. Defaults to a zero-write preview; pass confirm=true to actually write, which first snapshots the current files into syncRoot/.backups. After a pull that changed package.json or the lockfile, run `dsh plugin --profile <name> install` to rebuild node_modules.',
            { confirm: { type: 'boolean', description: 'Actually write the files. Omit or false for a read-only preview.' } },
            async (args) => restore({ dryRun: args?.confirm !== true }),
            (value, args) => {
              if (value.ok === false) return `Pull failed: ${value.error}`
              if (args.confirm !== true) {
                const lines = (value.actions ?? []).map((item) => `  ${item.action}: ${item.path}`)
                return (
                  `Pull preview from ${value.syncRoot}\n` +
                  `  into profile "${value.profile}"\n` +
                  `  snapshot ${value.snapshotAt}${value.secretsIncluded ? ' (INCLUDES secrets)' : ''}\n` +
                  lines.join('\n') +
                  `\nNothing written. Call again with confirm=true to apply.`
                )
              }
              return (
                `Applied ${value.applied.length} file(s) from ${value.syncRoot} into profile "${value.profile}"\n` +
                (value.backupDir ? `  backup of previous files: ${value.backupDir}\n` : '  no previous files to back up\n') +
                (value.nextStep ? `  next: ${value.nextStep}` : '  no dependency rebuild needed')
              )
            },
          ),
        ),
      ]
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'config-sync: tools')
  })

  // --- Human slash command --------------------------------------------------

  ctx.inject(['commands'], (scoped) => {
    scoped.effect(
      () =>
        scoped.commands.register({
          name: 'sync',
          description: 'Sync this DSH configuration through the syncRoot folder (status | push | pull | pull!)',
          input: { hint: 'status | push | pull | pull!' },
          recordInput: true,
          async handler(invocation) {
            const argument = String(invocation?.rawInput ?? '').trim().toLowerCase()
            try {
              if (argument === 'push') {
                const value = await capture({})
                if (value.ok === false) return { kind: 'error', text: `config-sync: ${value.error}` }
                return {
                  kind: 'success',
                  text:
                    `config-sync: pushed profile "${value.profile}" -> ${value.syncRoot}\n` +
                    `  changed: ${summarizeFiles(value.changed)}\n` +
                    `  added:   ${summarizeFiles(value.added)}\n` +
                    `  removed: ${summarizeFiles(value.removed)}`,
                }
              }
              if (argument === 'pull!') {
                const value = await restore({})
                if (value.ok === false) return { kind: 'error', text: `config-sync: ${value.error}` }
                return {
                  kind: 'success',
                  text:
                    `config-sync: applied ${value.applied.length} file(s) from ${value.syncRoot}\n` +
                    (value.backupDir ? `  backup: ${value.backupDir}\n` : '') +
                    (value.nextStep ? `  next: ${value.nextStep}` : '  no dependency rebuild needed'),
                }
              }
              if (argument === 'pull') {
                const value = await restore({ dryRun: true })
                if (value.ok === false) return { kind: 'error', text: `config-sync: ${value.error}` }
                return {
                  kind: 'success',
                  text:
                    `config-sync: preview from ${value.syncRoot} (snapshot ${value.snapshotAt})\n` +
                    (value.actions ?? []).map((item) => `  ${item.action}: ${item.path}`).join('\n') +
                    `\nrun "/sync pull!" to apply`,
                }
              }
              const value = await status()
              const change = value.changes
              return {
                kind: 'success',
                text:
                  `config-sync: profile "${value.profile ?? '(none)'}" (${value.profileReason})\n` +
                  `  syncRoot: ${value.syncRoot}${value.syncRootExists ? '' : '  [missing - "/sync push" creates it]'}\n` +
                  `  local profiles: ${summarizeFiles(value.local?.profiles)}\n` +
                  `  snapshot: ${(value.snapshot?.files ?? []).length} file(s)` +
                  (value.snapshot?.at ? `, captured ${value.snapshot.at}` : '') + '\n' +
                  (change
                    ? `  pending: ${change.changed.length} changed, ${change.added.length} new, ${change.removed.length} removed`
                    : '  no profile selected — nothing to compare'),
              }
            } catch (error) {
              return { kind: 'error', text: `config-sync: ${error instanceof Error ? error.message : String(error)}` }
            }
          },
        }),
      'config-sync: /sync command',
    )
  })

  report('info', `ready (home=${home}, syncRoot=${syncRoot}, secrets=${includeSecrets ? 'included' : 'excluded'})`)
}

export {
  MANIFEST_NAME,
  PROFILE_FILES,
  ROOT_FILES,
  SCHEMA_VERSION,
  SECRET_FILES,
  apply,
  applyPlan,
  applySnapshot,
  detectProfile,
  AUTO_SYNC_INTERVALS,
  DEFAULT_SETTINGS,
  detectGithubToken,
  diffPlan,
  expandHome,
  gitCommitAndPush,
  gitFetchAndFastForward,
  gitState,
  autoSyncStatePath,
  readLastRun,
  readSettings,
  writeLastRun,
  writeSettings,
  inject,
  isInside,
  listProfiles,
  listSnapshotFiles,
  localPath,
  makeTool,
  name,
  planCapture,
  resolveHome,
  snapshotPath,
  summarizeManifest,
}
