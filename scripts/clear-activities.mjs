/**
 * Remove live activities this plugin (or a probe run) left behind in Atoll.
 *
 * Atoll has no "list activities" RPC, so cleanup works from known ids: the
 * production activity id and the probe id used while the wire format was being
 * reverse-engineered. Run it after a crashed test run; the plugin also does this
 * on startup so a stale red banner never survives a restart.
 *
 *   node scripts/clear-activities.mjs [port] [bundleIdentifier] [id ...]
 */
const port = Number(process.argv[2] ?? process.env.ATOLL_PORT ?? 9020)
const bundleIdentifier = process.argv[3] ?? process.env.ATOLL_BUNDLE ?? 'dev.dsh.atoll-notice'
const ids = process.argv.slice(4)
if (ids.length === 0) ids.push('dsh-status', 'dsh-probe')

const url = `ws://127.0.0.1:${port}`
const socket = new WebSocket(url)
let nextId = 1
const pending = new Map()

// Atoll decodes the JSON-RPC id as String; numeric ids are dropped silently.
const request = (method, params) =>
  new Promise((resolve) => {
    const id = `clear-${nextId++}`
    pending.set(id, resolve)
    socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
  })

socket.addEventListener('message', (message) => {
  const payload = JSON.parse(typeof message.data === 'string' ? message.data : '')
  const resolve = payload.id === undefined ? undefined : pending.get(payload.id)
  if (!resolve) return
  pending.delete(payload.id)
  resolve(payload.error ? { error: payload.error } : { result: payload.result })
})

await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

const hello = await request('atoll.requestAuthorization', {
  appName: 'DeepSeek Harness',
  bundleIdentifier,
})
console.log(`[clear] connected port=${port} authorized=${hello.result?.authorized ?? hello.error?.message}`)
for (const activityID of ids) {
  const reply = await request('atoll.dismissLiveActivity', { activityID, bundleIdentifier })
  console.log(`[clear] ${activityID}: ${reply.error ? `error ${reply.error.code} ${reply.error.message}` : 'dismissed'}`)
}
socket.close()
