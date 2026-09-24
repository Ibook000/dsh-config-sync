/**
 * Refresh the DSH config snapshot with the real plugin implementation.
 *
 * Usage: node refresh-snapshot.mjs <syncRoot>
 *
 * Drives the plugin's own config_sync_push through a minimal Cordis-like
 * context, so the snapshot is produced by exactly the code the plugin ships
 * rather than by a reimplementation.
 */
const p = await import(new URL('../lib/index.js', import.meta.url).href)

const syncRoot = process.argv[2]
if (!syncRoot) {
  console.error('usage: node refresh-snapshot.mjs <syncRoot>')
  process.exit(2)
}

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

p.apply(ctx, { syncRoot, includeSecrets: false, includeLockfile: true })

const push = tools.find((t) => t.name === 'config_sync_push')
const status = tools.find((t) => t.name === 'config_sync_status')

const r = await push.execute({}, {})
if (r.ok !== true) {
  console.error('push failed:', r.error)
  process.exit(1)
}
console.log(`profile=${r.profile}  wrote ${r.written.length} file(s)`)
console.log(`  changed: ${r.changed.join(', ') || 'none'}`)
console.log(`  added:   ${r.added.join(', ') || 'none'}`)
console.log(`  removed: ${r.removed.join(', ') || 'none'}`)

const s = await status.execute({}, {})
console.log(`pending after refresh: ${s.changes.changed.length} changed, ${s.changes.added.length} new, ${s.changes.removed.length} removed`)
