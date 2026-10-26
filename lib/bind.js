/**
 * Pure helpers that turn DSH runtime payloads into short human lines.
 * No I/O, never throws: a malformed payload must not break a session.
 */

const MAX_LINE = 120

/**
 * Collapse whitespace and clamp one line of text.
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
export function oneLine(value, max = MAX_LINE) {
  if (value === undefined || value === null) return ''
  let text
  try {
    text = typeof value === 'string' ? value : String(value)
  } catch {
    return ''
  }
  text = text.replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

/**
 * Short display label for a session/agent id.
 * @param {unknown} agentId
 * @returns {string}
 */
export function shortAgentId(agentId) {
  const text = agentId === undefined || agentId === null ? '' : String(agentId)
  if (!text) return 'unknown'
  return text.length <= 8 ? text : text.slice(-6)
}

/**
 * Describe a thrown/streamed failure as one line.
 * @param {unknown} error
 * @returns {string}
 */
export function describeError(error) {
  if (error === undefined || error === null) return ''
  if (typeof error === 'string') return oneLine(error)
  if (typeof error === 'object') {
    const candidate = error
    for (const key of ['message', 'reason', 'detail', 'error']) {
      const value = candidate[key]
      if (typeof value === 'string' && value.trim()) return oneLine(value)
    }
    try {
      const json = JSON.stringify(candidate)
      if (json && json !== '{}') return oneLine(json)
    } catch {
      /* circular payloads fall through */
    }
  }
  return oneLine(String(error))
}

/**
 * Title for a pending approval.
 * @param {{ toolName?: unknown } | undefined} request
 * @returns {string}
 */
export function approvalTitle(request) {
  const tool = oneLine(request?.toolName, 48)
  return tool ? `等待批准：${tool}` : '等待批准'
}

/**
 * Title for a batch of pending questions.
 * @param {{ questions?: unknown } | undefined} request
 * @returns {string}
 */
export function questionTitle(request) {
  const questions = Array.isArray(request?.questions) ? request.questions : []
  const first = questions[0]
  const text = oneLine(typeof first === 'string' ? first : first?.question, 64)
  return text ? `等待回答：${text}` : '等待回答'
}

/** Kinds in display priority order. */
export const KIND_ORDER = ['failure', 'attention', 'done']
