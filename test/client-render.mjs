/**
 * Execute the client bundle outside a browser to catch runtime errors before a
 * DSH restart is needed.
 *
 * The bundle is real: this loads lib/client.js with a stubbed
 * `window.__ModuleLoader__`, a stubbed `document`, a minimal React whose hooks
 * behave synchronously, and a stubbed fetch that serves canned bridge payloads.
 * It then renders the component and walks the returned element tree.
 *
 * This catches the class of failure that is otherwise only visible as a blank
 * settings page after a reboot: undefined references, bad hook usage, a
 * mistyped element type, or a crash while formatting bridge data.
 */
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { resolve } from 'node:path'

const pluginDir = resolve(import.meta.dirname, '..')
// Overridable so a deliberately-broken copy can be checked: a regression guard is
// only trustworthy once it has been observed to FAIL.
const clientPath = process.argv[2] ?? resolve(pluginDir, 'lib', 'client.js')

let pass = 0
let fail = 0
const check = (label, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ` -> ${detail}` : ''}`) }
}

// ---------------------------------------------------------------------------
// Minimal React with synchronous hooks
// ---------------------------------------------------------------------------
const hookState = { states: [], cursor: 0, effects: [] }
const React = {
  createElement(type, props, ...children) {
    const flat = children.flat().filter((c) => c !== null && c !== undefined && c !== false)
    // Real React exposes children on props as well as positionally; a component
    // that destructures `{ children }` depends on this.
    return { type, props: { ...(props ?? {}), children: flat }, children: flat }
  },
  useState(initial) {
    const i = hookState.cursor++
    if (!(i in hookState.states)) hookState.states[i] = initial
    return [hookState.states[i], (next) => { hookState.states[i] = typeof next === 'function' ? next(hookState.states[i]) : next }]
  },
  useCallback(fn) { hookState.cursor++; return fn },
  useEffect(fn) { hookState.cursor++; hookState.effects.push(fn) },
}
React.default = React

// ---------------------------------------------------------------------------
// Browser stubs
// ---------------------------------------------------------------------------
const styles = []
globalThis.window = {
  __ModuleLoader__: { load: (registration) => { registered = registration } },
  confirm: () => true,
}
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, set textContent(v) { styles.push(v) } }),
  head: { appendChild: () => {} },
}

/** Canned bridge responses, keyed by route. */
const canned = {
  '/dsh-config-sync/status': {
    ok: true,
    settings: { autoSync: true, autoSyncInterval: '1h', autoSyncDirection: 'push', autoSyncRunGit: true },
    intervals: ['15m', '30m', '1h', '6h', '24h'],
    profile: 'web',
    profileReason: 'default web profile',
    syncRoot: '/home/user/.dsh/config-sync',
    hasGithubToken: { available: true, source: 'gh-cli', login: 'octocat' },
    git: { available: true, isRepo: true, branch: 'main', hasRemote: true, dirty: false, ahead: 0, behind: 0, remote: 'https://github.com/Ibook000/dsh-config.git', lastCommit: 'abc1234 2026-09-23 msg', error: '' },
    snapshot: { files: ['settings.yaml', 'profiles/web/package.json'], at: '2026-09-23T16:00:00.000Z', secretsIncluded: false, host: { platform: 'win32' }, plugins: null },
    changes: { added: [], changed: [], unchanged: ['a'], removed: [], total: 1 },
    autoSyncState: { at: '2026-09-23T16:00:00.000Z', direction: 'push', ok: true, detail: '7 file(s); pushed main' },
    lastAutoSyncAt: 1789000000000,
  },
}
const posts = []
globalThis.fetch = async (url, init) => {
  const route = String(url)
  if (init?.method === 'POST') {
    posts.push({ route, body: JSON.parse(init.body ?? '{}') })
    return { json: async () => ({ ok: true, written: ['settings.yaml'], changed: ['settings.yaml'], added: [], removed: [], applied: [], git: { message: 'pushed main' } }) }
  }
  const body = canned[route]
  if (body === undefined) return { json: async () => ({ ok: false, error: `unstubbed route ${route}` }) }
  return { json: async () => body }
}

// ---------------------------------------------------------------------------
// Load and run the real bundle
// ---------------------------------------------------------------------------
console.log('[client bundle execution]')

const source = await readFile(clientPath, 'utf8')
check('bundle file readable', source.length > 1000, `${source.length} bytes`)

let factoryError = ''
/** Set by the bundle when it calls window.__ModuleLoader__.load(...). */
let captured = null
let factory = null

// A faithful browser-ish global scope for the bundle.
const windowStub = {
  __ModuleLoader__: { load: (registration) => { captured = registration } },
  confirm: () => true,
}
const requireStub = (spec) => {
  if (spec === 'react') return React
  throw new Error(`unexpected require("${spec}")`)
}
try {
  // Compile the bundle as a plain function body and run it against a browser-like
  // global — with NO CommonJS wrapper.
  //
  // This fidelity is the whole point. An earlier version of this test wrapped the
  // source in `(function (exports, module, require, window, document) { ... })`,
  // which supplied `exports` from outside and hid a real bug: the bundle used
  // `exports.apply = ...` without declaring it, so the browser threw
  // "exports is not defined" at plugin-boot time and aborted the ENTIRE plugin
  // table. The test supplied the very thing it was meant to verify.
  const run = vm.compileFunction(source, ['window', 'document', 'fetch', 'console'], { filename: 'client.js' })
  run(windowStub, globalThis.document, globalThis.fetch, console)

  factory = captured?.factory ?? null
} catch (error) {
  factoryError = error instanceof Error ? `${error.constructor.name}: ${error.message}` : String(error)
}
check('bundle evaluates without throwing', factoryError === '', factoryError)
check('bundle registered a factory', typeof factory === 'function')

const mod = (() => {
  if (typeof factory !== 'function') return {}
  // Call the factory the way the module system does: `factory(require)` with
  // nothing else in scope, so a missing declaration fails here too.
  const call = vm.compileFunction('return factory(require)', ['factory', 'require'], { filename: 'factory-call.js' })
  return call(factory, requireStub)
})()
check('factory returns an apply function', typeof mod.apply === 'function')
check('factory returns an inject list', Array.isArray(mod.inject))
check('inject declares slots', mod.inject.includes('slots'))

// Capture the slot registration. The real slot layer invokes the inject callback
// as a generator and drains it, so do the same here: a plain-function callback
// (or a missing ctx.effect) would register nothing in the browser.
let slotRegistration = null
let slotComponent = null
let effectWrapped = false
const drain = (value) => {
  if (value === null || value === undefined) return
  if (typeof value === 'object' && typeof value.next === 'function') {
    let step = value.next()
    while (step.done !== true) { drain(step.value); step = value.next() }
    return
  }
  if (Array.isArray(value)) { for (const one of value) drain(one); return }
  if (typeof value === 'function') value()
}
const ctx = {
  effect: (fn) => { effectWrapped = true; const d = fn(); return typeof d === 'function' ? d : () => {} },
  slots: {
    inject: (name, cb) => { check('registers into settings.section', name === 'settings.section', name); drain(cb()) },
    register: (options, component) => { slotRegistration = options; slotComponent = component; return () => {} },
  },
}
let applyError = ''
try { mod.apply(ctx) } catch (error) { applyError = error instanceof Error ? error.message : String(error) }
check('apply() runs without throwing', applyError === '', applyError)
check('registration is owned by ctx.effect', effectWrapped === true)
check('registered a component', typeof slotComponent === 'function')
check('registration id is config-sync', slotRegistration?.id === 'config-sync', JSON.stringify(slotRegistration))
check('registration label is a thunk', typeof slotRegistration?.label === 'function')
check('label thunk returns text', typeof slotRegistration.label() === 'string' && slotRegistration.label().length > 0)

// ---------------------------------------------------------------------------
// Render: first pass (loading), then the loaded pass after effects run
// ---------------------------------------------------------------------------
const render = () => {
  hookState.cursor = 0
  hookState.effects = []
  const tree = slotComponent({ close: () => {} })
  const effects = hookState.effects
  return { tree, effects }
}

let tree = null
let renderError = ''
try {
  const first = render()
  tree = first.tree
  // Run the initial load effect (calls fetch, then setState).
  for (const effect of first.effects) effect()
  await new Promise((r) => setTimeout(r, 50))
  const second = render()
  tree = second.tree
  for (const effect of second.effects) effect()
  await new Promise((r) => setTimeout(r, 50))
  tree = render().tree
} catch (error) {
  renderError = error instanceof Error ? error.message : String(error)
}
check('component renders without throwing', renderError === '', renderError)

/** Walk an element tree, collecting strings and element types. */
const walk = (node, out = { texts: [], types: [], classNames: [] }) => {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') { out.texts.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) walk(child, out); return out }
  if (typeof node === 'object') {
    if (typeof node.type === 'string') out.types.push(node.type)
    if (typeof node.type === 'function') { walk(node.type({ ...node.props, close: () => {} }), out); return out }
    if (typeof node.props?.className === 'string') out.classNames.push(node.props.className)
    for (const child of node.children ?? []) walk(child, out)
  }
  return out
}

const scanned = walk(tree)
const allText = scanned.texts.join(' | ')
check('renders a non-trivial tree', scanned.types.length > 10, `${scanned.types.length} elements`)
check('renders the status heading', /配置同步|Config Sync/.test(allText))
check('renders push/pull buttons', scanned.types.filter((t) => t === 'button').length >= 5,
  `${scanned.types.filter((t) => t === 'button').length} buttons`)
check('renders the auto-sync checkbox', scanned.types.filter((t) => t === 'input').length >= 1)
check('renders the interval select', scanned.types.filter((t) => t === 'select').length >= 2)
check('shows the sync root path', allText.includes('config-sync'), 'sync root missing')
check('shows the git branch', allText.includes('main'), 'branch missing')
check('shows the github login', allText.includes('octocat'), 'login missing')
check('shows the last auto-sync time', /last run|上次执行/.test(allText), 'last-run text missing')
check('reports in-sync or pending state', /已同步|in sync|待同步|pending/.test(allText))
check('no literal "undefined" leaked into the UI', !/undefined/.test(allText),
  allText.match(/.{0,40}undefined.{0,40}/)?.[0] ?? '')
check('class names use the dscs- prefix', scanned.classNames.every((c) => c.split(/\s+/).every((one) => one.startsWith('dscs-'))),
  scanned.classNames.filter((c) => !c.startsWith('dscs-')).join(','))

// ---------------------------------------------------------------------------
// Interaction: clicking a button must reach the bridge
// ---------------------------------------------------------------------------
const findButton = (label) => {
  const scan = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return null
    if (Array.isArray(node)) { for (const c of node) { const r = scan(c); if (r) return r } return null }
    if (node.type === 'button' && String(node.children?.[0] ?? '').includes(label)) return node
    for (const c of node.children ?? []) { const r = scan(c); if (r) return r }
    return null
  }
  return scan(tree)
}

const pushButton = findButton('立即推送') ?? findButton('Push now')
check('found the push button', pushButton !== null)
if (pushButton) {
  let clickError = ''
  try { await pushButton.props.onClick() } catch (error) { clickError = error instanceof Error ? error.message : String(error) }
  check('clicking push does not throw', clickError === '', clickError)
  check('clicking push POSTs to /dsh-config-sync/push',
    posts.some((p) => p.route === '/dsh-config-sync/push'), JSON.stringify(posts.map((p) => p.route)))
}

// The token input must never be pre-filled from bridge data.
check('token field starts empty (no credential echo)',
  !/ghp_|github_pat_|gho_/.test(source.replace(/ghp_…|github_pat_…/g, '')),
  'token-like literal in bundle')

console.log(`\n${'='.repeat(60)}`)
console.log(`client bundle: PASS ${pass}   FAIL ${fail}`)
console.log('='.repeat(60))
process.exit(fail === 0 ? 0 : 1)
