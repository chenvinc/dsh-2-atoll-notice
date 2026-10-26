/**
 * Formatting helpers and the Atoll wire descriptor builder.
 *
 * Pure functions only: no I/O, no timers, no globals, and nothing throws on
 * hostile input. Strings are Chinese and intentionally short because Atoll
 * renders the subtitle on a single truncated line.
 *
 * @typedef {'failure' | 'attention' | 'done'} NoticeKind
 * @typedef {{ failure: number, attention: number, done: number }} Counts
 */

const KINDS = Object.freeze(['failure', 'attention', 'done'])
const SUBTITLE_FALLBACK = '一切正常'
const DEFAULT_TITLE = 'DSH 任务'
const DEFAULT_ACTIVITY_ID = 'dsh-status'
const COMPACT_SEPARATOR = '·'
const MAX_COMPACT_COUNT = 99
const MAX_HEADLINE_COUNT = 99

/** Short Chinese labels, one word each so the subtitle stays narrow. */
const LABELS = Object.freeze({ failure: '失败', attention: '待确认', done: '完成' })

/**
 * Accent colours as SwiftUI/RGBA components in 0–1 (Atoll decodes them as
 * `RGBAColor` doubles; verified against Atoll 2.3.3). Values are the macOS
 * system palette so they read correctly on the dark island.
 */
export const ACCENTS = Object.freeze({
  failure: Object.freeze({ red: 1, green: 0.271, blue: 0.227, alpha: 1 }),
  attention: Object.freeze({ red: 1, green: 0.839, blue: 0.039, alpha: 1 }),
  done: Object.freeze({ red: 0.188, green: 0.82, blue: 0.345, alpha: 1 }),
  none: Object.freeze({ red: 0.557, green: 0.557, blue: 0.576, alpha: 1 }),
})

/** SF Symbol names Atoll accepts in `leadingIcon`. */
export const ICONS = Object.freeze({
  failure: 'exclamationmark.triangle.fill',
  attention: 'bell.badge.fill',
  done: 'checkmark.circle.fill',
  none: 'sparkles',
})

/** Wire priority per severity; only urgent states interrupt. */
const PRIORITIES = Object.freeze({
  failure: 'high',
  attention: 'high',
  done: 'normal',
  none: 'normal',
})

/** @param {unknown} value @returns {number} */
function toCount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  if (value <= 0) return 0
  return Math.floor(value)
}

/**
 * Coerce arbitrary input into a { failure, attention, done } record. Hostile
 * getters are contained and anything unusable counts as zero.
 *
 * @param {unknown} raw
 * @returns {Counts}
 */
function readCounts(raw) {
  const counts = { failure: 0, attention: 0, done: 0 }
  if (!raw || typeof raw !== 'object') return counts
  for (const kind of KINDS) {
    let value
    try {
      value = raw[kind]
    } catch {
      value = undefined
    }
    counts[kind] = toCount(value)
  }
  return counts
}

/** @param {unknown} counts @returns {'failure'|'attention'|'done'|'none'} */
export function severity(counts) {
  const normalised = readCounts(counts)
  for (const kind of KINDS) {
    if (normalised[kind] > 0) return kind
  }
  return 'none'
}

/**
 * Non-zero kinds in urgency order.
 *
 * @param {unknown} counts
 * @returns {NoticeKind[]}
 */
export function order(counts) {
  const normalised = readCounts(counts)
  return KINDS.filter((kind) => normalised[kind] > 0)
}

/**
 * `r·y·g` for the compact wing; empty when nothing is pending.
 *
 * @param {unknown} counts
 * @returns {string}
 */
export function compactCounts(counts) {
  const normalised = readCounts(counts)
  const total = normalised.failure + normalised.attention + normalised.done
  if (total === 0) return ''
  return KINDS.map((kind) => String(Math.min(normalised[kind], MAX_COMPACT_COUNT))).join(
    COMPACT_SEPARATOR,
  )
}

/**
 * One-line Chinese summary, e.g. `2 失败 · 1 待确认 · 3 完成`.
 *
 * @param {unknown} counts
 * @returns {string}
 */
export function headline(counts) {
  const normalised = readCounts(counts)
  const parts = []
  for (const kind of KINDS) {
    const value = normalised[kind]
    if (value <= 0) continue
    const shown = value > MAX_HEADLINE_COUNT ? `${MAX_HEADLINE_COUNT}+` : String(value)
    parts.push(`${shown} ${LABELS[kind]}`)
  }
  if (parts.length === 0) return SUBTITLE_FALLBACK
  return parts.join(' · ')
}

/** @param {unknown} value @param {string} fallback */
function readString(value, fallback) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed || fallback
}

/**
 * Build the descriptor Atoll expects on the wire. The result is a plain JSON
 * value: no undefined members, safe to `JSON.stringify` and send as-is.
 *
 * @param {unknown} input { counts, items, activityId, bundleIdentifier, title?, now? }
 * @returns {object}
 */
export function buildStatusDescriptor(input) {
  try {
    return buildDescriptor(input)
  } catch {
    return buildDescriptor({})
  }
}

/** @param {unknown} input @returns {object} */
function buildDescriptor(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const counts = readCounts(safeGet(raw, 'counts'))
  const level = severity(counts)
  const compact = compactCounts(counts)

  const id = readString(safeGet(raw, 'activityId'), DEFAULT_ACTIVITY_ID)
  const bundleIdentifier = readString(safeGet(raw, 'bundleIdentifier'), '')
  const title = readString(safeGet(raw, 'title'), DEFAULT_TITLE)

  const descriptor = {
    id,
    bundleIdentifier,
    priority: PRIORITIES[level],
    title,
    subtitle: headline(counts),
    leadingIcon: { type: 'symbol', name: ICONS[level], size: 15 },
  }
  if (compact !== '') descriptor.trailingContent = { type: 'text', text: compact }
  descriptor.accentColor = { ...ACCENTS[level] }
  descriptor.allowsMusicCoexistence = true
  descriptor.metadata = {
    counts: `${counts.failure},${counts.attention},${counts.done}`,
  }
  return descriptor
}

/** Read a property without letting a hostile getter escape. */
function safeGet(target, key) {
  try {
    return target[key]
  } catch {
    return undefined
  }
}
