/**
 * Pure in-memory notice store for the Atoll live activity.
 *
 * No I/O, no timers, no globals: every clock read goes through the injected
 * `now` function so behaviour is deterministic in tests. Nothing in this module
 * throws on hostile input; invalid records are rejected and hostile snapshots
 * degrade to an empty result.
 *
 * @typedef {'failure' | 'attention' | 'done'} NoticeKind
 *
 * @typedef {object} NoticeItem
 * @property {string} id
 * @property {NoticeKind} kind
 * @property {string} agentId
 * @property {string} title
 * @property {string} [detail]
 * @property {number} createdAt
 * @property {number} [expiresAt]
 *
 * @typedef {object} Counts
 * @property {number} failure
 * @property {number} attention
 * @property {number} done
 */

/** Kinds in urgency order, most severe first. */
export const KINDS = Object.freeze(['failure', 'attention', 'done'])

/** Kinds in the order a soft total cap gives them up (least severe first). */
const EVICTION_ORDER = Object.freeze(['done', 'attention', 'failure'])

const DEFAULT_MAX_ITEMS_PER_KIND = 50
const DEFAULT_MAX_ITEMS = 64

const MAX_ID_LENGTH = 512
const MAX_AGENT_ID_LENGTH = 200
const MAX_TITLE_LENGTH = 200
const MAX_DETAIL_LENGTH = 300

const KIND_SET = new Set(KINDS)

/** @param {unknown} value @returns {value is NoticeKind} */
function isKind(value) {
  return typeof value === 'string' && KIND_SET.has(value)
}

/** @param {unknown} value @returns {boolean} */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Normalise a cap. `Infinity` disables the cap; anything that is not a
 * positive finite number falls back to the default.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function normalizeLimit(value, fallback) {
  if (value === Infinity) return Infinity
  if (!isFiniteNumber(value) || value < 1) return fallback
  return Math.floor(value)
}

/**
 * Collapse arbitrary text into one short line.
 *
 * @param {unknown} value
 * @param {number} maxLength
 * @returns {string}
 */
function cleanLine(value, maxLength) {
  if (typeof value !== 'string') return ''
  return value
    .replace(/[\r\n\t\f\v]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
    .trim()
}

/** Public projection of an internal record (never leaks the sort sequence). */
function toPublic(record) {
  const out = {
    id: record.id,
    kind: record.kind,
    agentId: record.agentId,
    title: record.title,
    createdAt: record.createdAt,
  }
  if (record.detail !== undefined) out.detail = record.detail
  if (record.expiresAt !== undefined) out.expiresAt = record.expiresAt
  return out
}

function sameContent(a, b) {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.agentId === b.agentId &&
    a.title === b.title &&
    a.detail === b.detail &&
    a.createdAt === b.createdAt &&
    a.expiresAt === b.expiresAt
  )
}

/** @param {{createdAt:number,seq:number}} a @param {{createdAt:number,seq:number}} b */
function oldestFirst(a, b) {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
  return a.seq - b.seq
}

/** @param {{createdAt:number,seq:number}} a @param {{createdAt:number,seq:number}} b */
function newestFirst(a, b) {
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt
  return b.seq - a.seq
}

export class NoticeStore {
  /** @type {() => number} */
  #clock
  #maxItemsPerKind
  #maxItems
  /** @type {Map<string, NoticeItem & {seq:number}>} */
  #items = new Map()
  /** @type {Set<() => void>} */
  #listeners = new Set()
  #seq = 0

  /**
   * @param {{ now?: () => number, maxItemsPerKind?: number, maxItems?: number }} [options]
   */
  constructor(options = {}) {
    const opts = options && typeof options === 'object' ? options : {}
    let clock
    try {
      clock = opts.now
    } catch {
      clock = undefined
    }
    this.#clock = typeof clock === 'function' ? clock : Date.now
    this.#maxItemsPerKind = normalizeLimit(
      safeGet(opts, 'maxItemsPerKind'),
      DEFAULT_MAX_ITEMS_PER_KIND,
    )
    this.#maxItems = normalizeLimit(safeGet(opts, 'maxItems'), DEFAULT_MAX_ITEMS)
  }

  /**
   * Add or replace one notice. One live notice per agent per kind: adding a
   * notice for an agent/kind pair drops the older one of that pair, even when
   * the id differs. Re-adding identical content is a no-op.
   *
   * @param {unknown} item
   * @returns {{ added: boolean, item: NoticeItem | null }}
   */
  add(item) {
    const time = this.#time()
    const record = this.#normalize(item, time)
    if (!record) return { added: false, item: null }
    // An already expired notice can never render, so treat it as rejected.
    if (record.expiresAt !== undefined && record.expiresAt <= time) {
      return { added: false, item: null }
    }

    const existing = this.#items.get(record.id)
    if (existing && sameContent(existing, record)) {
      return { added: false, item: toPublic(existing) }
    }

    for (const [id, other] of this.#items) {
      if (id !== record.id && other.kind === record.kind && other.agentId === record.agentId) {
        this.#items.delete(id)
      }
    }

    this.#seq += 1
    record.seq = this.#seq
    this.#items.set(record.id, record)

    this.#trimKind(record.kind)
    this.#trimTotal(time)
    this.#emit()

    return { added: true, item: toPublic(record) }
  }

  /**
   * @param {unknown} id
   * @returns {boolean} true when an item was removed
   */
  removeByItem(id) {
    if (typeof id !== 'string') return false
    const key = id.trim()
    if (!key || !this.#items.has(key)) return false
    this.#items.delete(key)
    this.#emit()
    return true
  }

  /**
   * @param {unknown} agentId
   * @param {unknown} [kind] when omitted or undefined every kind is removed
   * @returns {number} number of removed items
   */
  removeByAgent(agentId, kind) {
    if (typeof agentId !== 'string') return 0
    const agent = agentId.trim()
    if (!agent) return 0
    if (kind !== undefined && !isKind(kind)) return 0

    let removed = 0
    for (const [id, item] of this.#items) {
      if (item.agentId !== agent) continue
      if (kind !== undefined && item.kind !== kind) continue
      this.#items.delete(id)
      removed += 1
    }
    if (removed > 0) this.#emit()
    return removed
  }

  /**
   * @param {unknown} [kind] omitted or 'all' clears every kind
   * @returns {number} number of removed items
   */
  clear(kind) {
    const requested = kind === undefined ? 'all' : kind
    if (requested !== 'all' && !isKind(requested)) return 0

    let removed = 0
    for (const [id, item] of this.#items) {
      if (requested === 'all' || item.kind === requested) {
        this.#items.delete(id)
        removed += 1
      }
    }
    if (removed > 0) this.#emit()
    return removed
  }

  /**
   * Drop expired notices.
   *
   * @param {unknown} [now] epoch ms override
   * @returns {number} number of removed items
   */
  prune(now) {
    const time = this.#time(now)
    let removed = 0
    for (const [id, item] of this.#items) {
      if (item.expiresAt !== undefined && item.expiresAt <= time) {
        this.#items.delete(id)
        removed += 1
      }
    }
    if (removed > 0) this.#emit()
    return removed
  }

  /**
   * Point-in-time view. Expired notices are excluded from both `items` and
   * `counts` (they stay until `prune` so a later clock cannot resurrect them).
   *
   * @param {unknown} [now] epoch ms override
   * @returns {{ counts: Counts, items: NoticeItem[], total: number }}
   */
  snapshot(now) {
    const time = this.#time(now)
    const counts = { failure: 0, attention: 0, done: 0 }
    const records = []
    for (const item of this.#items.values()) {
      if (item.expiresAt !== undefined && item.expiresAt <= time) continue
      counts[item.kind] += 1
      records.push(item)
    }
    records.sort(newestFirst)
    return { counts, items: records.map(toPublic), total: records.length }
  }

  /**
   * @param {unknown} callback called once after each mutation that changed the store
   * @returns {() => void} unsubscribe
   */
  onChange(callback) {
    if (typeof callback !== 'function') return () => {}
    this.#listeners.add(callback)
    let active = true
    return () => {
      if (!active) return
      active = false
      this.#listeners.delete(callback)
    }
  }

  /** @returns {number} live (non-expired) notices */
  size() {
    const time = this.#time()
    let total = 0
    for (const item of this.#items.values()) {
      if (item.expiresAt !== undefined && item.expiresAt <= time) continue
      total += 1
    }
    return total
  }

  // --- internals -----------------------------------------------------------

  /**
   * Resolve an epoch-ms instant. `override` (a finite number) wins, otherwise
   * the injected clock is read; a broken clock degrades to 0.
   *
   * @param {unknown} [override]
   * @returns {number}
   */
  #time(override) {
    if (isFiniteNumber(override)) return Math.floor(override)
    try {
      const value = this.#clock()
      if (isFiniteNumber(value)) return Math.floor(value)
    } catch {
      // A broken clock must not break notification plumbing.
    }
    return 0
  }

  /**
   * @param {unknown} raw
   * @param {number} time
   * @returns {(NoticeItem & {seq: number}) | null}
   */
  #normalize(raw, time) {
    try {
      return this.#normalizeUnsafe(raw, time)
    } catch {
      return null
    }
  }

  /**
   * @param {unknown} raw
   * @param {number} time
   * @returns {(NoticeItem & {seq: number}) | null}
   */
  #normalizeUnsafe(raw, time) {
    if (!raw || typeof raw !== 'object') return null

    const rawId = raw.id
    if (typeof rawId !== 'string') return null
    const id = rawId.trim().slice(0, MAX_ID_LENGTH)
    if (!id) return null

    const kind = raw.kind
    if (!isKind(kind)) return null

    const title = cleanLine(raw.title, MAX_TITLE_LENGTH)
    if (!title) return null

    const detailText = cleanLine(raw.detail, MAX_DETAIL_LENGTH)
    const detail = detailText || undefined

    const rawAgent = raw.agentId
    const agentId =
      typeof rawAgent === 'string' && rawAgent.trim()
        ? rawAgent.trim().slice(0, MAX_AGENT_ID_LENGTH)
        : 'unknown'

    const rawCreated = raw.createdAt
    const createdAt = isFiniteNumber(rawCreated) ? Math.floor(rawCreated) : time

    const rawExpires = raw.expiresAt
    const expiresAt = isFiniteNumber(rawExpires) ? Math.floor(rawExpires) : undefined

    return { id, kind, agentId, title, detail, createdAt, expiresAt, seq: 0 }
  }

  /** Keep at most `maxItemsPerKind` notices of `kind`, dropping the oldest. */
  #trimKind(kind) {
    if (this.#maxItemsPerKind === Infinity) return
    const members = []
    for (const item of this.#items.values()) {
      if (item.kind === kind) members.push(item)
    }
    const excess = members.length - this.#maxItemsPerKind
    if (excess <= 0) return
    members.sort(oldestFirst)
    for (let index = 0; index < excess; index += 1) {
      this.#items.delete(members[index].id)
    }
  }

  /**
   * Keep the whole store at or below `maxItems`, giving up an expired notice
   * first and then the oldest notice of the least severe kind.
   */
  #trimTotal(time) {
    if (this.#maxItems === Infinity) return
    while (this.#items.size > this.#maxItems) {
      const victim = this.#evictionCandidate(time)
      if (!victim) return
      this.#items.delete(victim.id)
    }
  }

  /** @param {number} time @returns {{id:string,createdAt:number,seq:number} | null} */
  #evictionCandidate(time) {
    const all = [...this.#items.values()]
    if (all.length === 0) return null

    const expired = all.filter((item) => item.expiresAt !== undefined && item.expiresAt <= time)
    if (expired.length > 0) return expired.sort(oldestFirst)[0]

    for (const kind of EVICTION_ORDER) {
      const members = all.filter((item) => item.kind === kind)
      if (members.length > 0) return members.sort(oldestFirst)[0]
    }
    return null
  }

  #emit() {
    if (this.#listeners.size === 0) return
    for (const listener of [...this.#listeners]) {
      try {
        listener()
      } catch {
        // A broken listener must not break notification plumbing.
      }
    }
  }
}

/** Read a property without letting a hostile getter escape. */
function safeGet(target, key) {
  try {
    return target[key]
  } catch {
    return undefined
  }
}
