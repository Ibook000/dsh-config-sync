/**
 * Boot-order regression test.
 *
 * Reproduces the exact failure seen in production: a sibling bundle row mounts
 * `webServer` AFTER this plugin's apply() runs. With `ctx.get('webServer')` the
 * bridge silently never mounted (the plugin still reported as loaded, and the
 * settings page 404'd). With `ctx.inject(['webServer'], ...)` it must mount as
 * soon as the service appears.
 *
 * This simulates the ordering rather than trusting it, because the bug is
 * invisible in a test where the service happens to exist already.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
// The module under test is overridable so a deliberately-broken copy can be
// checked: a regression guard is only trustworthy once it has been seen to FAIL.
const modulePath = process.argv[2] ?? fileURLToPath(new URL('../lib/index.js', import.meta.url))
const plugin = await import(new URL(`file://${modulePath}`).href)

let pass = 0
let fail = 0
const check = (label, ok, detail = '') => {
  if (ok) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ` -> ${detail}` : ''}`) }
}

const root = join(tmpdir(), `dsh-bootorder-${Date.now()}`)
const home = join(root, '.dsh')
await mkdir(join(home, 'profiles', 'web'), { recursive: true })
await writeFile(join(home, 'settings.yaml'), 'a: 1\n', 'utf8')
await writeFile(join(home, 'profiles', 'web', 'package.json'), '{"dependencies":{}}\n', 'utf8')

/**
 * A Cordis-like context that models deferred service provision.
 *
 * `ctx.inject(names, cb)` callbacks are queued until every named service has
 * been provided; `provide(name, value)` then drains the queue — exactly the
 * reactivation semantics the real loader implements.
 */
function makeDeferredContext() {
  const services = new Map()
  const pending = []
  const ctx = {
    services,
    get: (name) => services.get(name),
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    inject: (names, cb) => {
      const ready = () => names.every((n) => services.has(n))
      const run = () => {
        const scoped = { ...ctx }
        for (const n of names) scoped[n] = services.get(n)
        cb(scoped)
      }
      if (ready()) run()
      else pending.push({ names, run })
    },
    provide: (name, value) => {
      services.set(name, value)
      for (let i = pending.length - 1; i >= 0; i--) {
        if (pending[i].names.every((n) => services.has(n))) {
          const [entry] = pending.splice(i, 1)
          entry.run()
        }
      }
    },
  }
  return ctx
}

console.log('[boot order: webServer mounts after apply()]')

const routes = []
const intervals = []
const ctx = makeDeferredContext()

// apply() runs FIRST, with neither service present.
plugin.apply(ctx, { home, syncRoot: join(root, 'synced'), profile: 'web' })
check('no routes registered at apply() time (service absent)', routes.length === 0,
  `${routes.length} routes`)
check('no timer registered at apply() time (service absent)', intervals.length === 0)

// Now the sibling rows mount their services, exactly as the real boot does.
ctx.provide('webServer', { register: (r) => { routes.push(r); return () => {} } })
ctx.provide('timer', { interval: (fn, ms) => { intervals.push({ fn, ms }); return () => {} } })

check('bridge mounted AFTER webServer appeared', routes.length === 6, `${routes.length} routes`)
check('scheduler armed AFTER timer appeared', intervals.length === 1, `${intervals.length} timers`)

const paths = routes.map((r) => r.path).sort()
check('all 6 bridge routes present', paths.length === 6 && paths.includes('/dsh-config-sync/status'),
  paths.join(','))

// The mounted bridge must actually work, not merely exist.
const route = routes.find((r) => r.path === '/dsh-config-sync/status')
const res = { status: 0, body: '', writeHead(s) { this.status = s }, end(c) { this.body = c ?? '' } }
await route.handler({ method: 'GET', headers: {} }, res)
const payload = JSON.parse(res.body)
check('mounted /status answers ok', res.status === 200 && payload.ok === true, JSON.stringify(payload).slice(0, 160))

// Providing the services a second time (a reload) must not double-register
// duplicates in a way that throws — the real server rejects duplicate routes.
let secondProvideError = ''
try { ctx.provide('webServer', { register: (r) => { routes.push(r); return () => {} } }) } catch (e) { secondProvideError = String(e) }
check('re-providing webServer does not throw', secondProvideError === '', secondProvideError)

console.log(`\n${'='.repeat(60)}`)
console.log(`boot order: PASS ${pass}   FAIL ${fail}`)
console.log('='.repeat(60))
process.exit(fail === 0 ? 0 : 1)
