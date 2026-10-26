# Module contract (internal)

Plain ESM JavaScript, no build step, Node >= 20, no runtime npm dependencies.
Every module must be side-effect free on import and must never throw from a
best-effort path (notification plumbing must not break a session).

## Vocabulary

```js
/** @typedef {'failure' | 'attention' | 'done'} NoticeKind */

/**
 * @typedef {object} NoticeItem
 * @property {string} id        stable unique id, e.g. `failure:agent-1:1712345678901`
 * @property {NoticeKind} kind
 * @property {string} agentId   agent that produced the item
 * @property {string} title     one short human line, no newlines
 * @property {string} [detail]  optional second line
 * @property {number} createdAt epoch ms
 * @property {number} [expiresAt] epoch ms; undefined means it stays until acked
 */

/**
 * @typedef {object} Counts
 * @property {number} failure
 * @property {number} attention
 * @property {number} done
 */
```

## lib/state.js  (owner: core)

```js
export class NoticeStore {
  constructor(options = {})            // { now?: () => number, maxItemsPerKind?: number }
  add(item)                            // -> { added: boolean, item: NoticeItem }
  removeByItem(id)                     // -> boolean
  removeByAgent(agentId, kind?)        // -> number removed
  clear(kind?)                         // kind omitted === all kinds -> number removed
  prune(now?)                          // -> number removed (expired items)
  snapshot(now?)                       // -> { counts: Counts, items: NoticeItem[], total: number }
  onChange(callback)                   // -> unsubscribe(); callback() after any real mutation
  size()                               // -> number
}
```

Rules: `add` replaces an item with the same `id` (dedupe) and drops the oldest
item of that kind past `maxItemsPerKind` (default 50). `snapshot().items` is
sorted by `createdAt` descending, newest first. `counts` only counts
non-expired items. Listener errors are swallowed.

## lib/format.js  (owner: core)

```js
export const ACCENTS               // { failure: {red,green,blue,alpha}, attention: {...}, done: {...}, none: {...} }
export const ICONS                 // { failure: 'exclamationmark.triangle.fill', attention: 'bell.badge.fill', done: 'checkmark.circle.fill', none: 'sparkles' }
export function severity(counts)   // -> 'failure' | 'attention' | 'done' | 'none'  (most urgent non-zero)
export function compactCounts(counts) // -> 'r·y·g' when total > 0, else ''
export function headline(counts)   // -> '2 失败 · 1 待确认 · 3 完成'; '一切正常' when total === 0
export function order(counts)      // -> ['failure','attention','done'] filtered to non-zero, urgent first
export function buildStatusDescriptor(input) // see below
```

`buildStatusDescriptor(input)` where input is
`{ counts, items, activityId, bundleIdentifier, title?, now? }` returns the
**wire descriptor object** Atoll accepts (do not re-transform it elsewhere):

```js
{
  id: activityId,                      // 'dsh-status'
  bundleIdentifier,
  priority: severity === 'failure' || severity === 'attention' ? 'high' : 'normal',
  title: title ?? 'DSH 任务',
  subtitle: headline(counts),
  leadingIcon: { type: 'symbol', name: ICONS[severity], size: 15 },
  trailingContent: compactCounts(counts) ? { type: 'text', text: compactCounts(counts) } : undefined,
  accentColor: ACCENTS[severity],
  allowsMusicCoexistence: true,
  metadata: { counts: `${failure},${attention},${done}` },
}
```

Trailing text must stay under 8 characters (`r·y·g`, each count clamped to 99)
because Atoll renders it inside a ~100pt wing.

## lib/atoll.js  (owner: transport)

```js
export class AtollClient {
  constructor(options)   // { url?, bundleIdentifier, appName?, logger?, webSocket?, reconnectBaseMs?, reconnectMaxMs?, coalesceMs?, requestTimeoutMs? }
  start()                // idempotent; starts the connect/reconnect loop
  async stop()           // closes the socket, stops reconnecting, settles queued work
  show(descriptor|null)  // coalesced present/update/dismiss; null dismisses; replays after reconnect
  flash(descriptor, ms?) // show a temporary descriptor (default 6000 ms) then restore the last show()
  state()                // -> { connected, authorized, activityId, lastError, presentedAt }
  onStateChange(cb)      // -> unsubscribe()
}
```

Wire protocol (verified against Atoll 2026-10): WebSocket JSON-RPC 2.0 on
`ws://127.0.0.1:9020` (configurable), one JSON object per text frame.

1. On open, first request `atoll.requestAuthorization`
   `{ appName, bundleIdentifier }`; result `{ authorized: boolean }`. A false
   answer stops sends until the next reconnect but keeps the loop alive.
2. `atoll.presentLiveActivity` `{ descriptor }` — first presentation of an id.
3. `atoll.updateLiveActivity` `{ descriptor }` — subsequent updates of the same
   id; if it fails with `-32004` (unknown activity) fall back to present.
4. `atoll.dismissLiveActivity` `{ activityID, bundleIdentifier }`.
5. Responses: `{ jsonrpc: '2.0', id, result }` or `{ id, error: { code, message } }`.
   Atoll error codes: `-32001` unauthorized, `-32002` feature disabled,
   `-32003` capacity exceeded (only one third-party activity renders; dismiss
   ours before retrying), `-32004` invalid descriptor, `-32603` decode failure.

The client owns reconnection (exponential backoff from 500 ms to 15 s), request
ids, and a single in-flight send per activity (coalesce `show` calls; always
send the newest descriptor). All failures are reported through `logger.warn`
and `state().lastError`; nothing is thrown to callers.

## lib/sound.js  (owner: host)

```js
export function playNoticeSound(options) // { soundName?, volume?, enabled?, spawn?, platform? } -> boolean
export function rateLimited(options)     // { minGapMs?, now? } -> boolean (true = allowed now)
```

`playNoticeSound` runs `afplay <name>` from `/System/Library/Sounds` on macOS
with a short timeout, detached, and returns whether a play was started.
