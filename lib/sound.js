/**
 * macOS alert sound playback for notices.
 *
 * Sounds are best effort: a missing `afplay`, a sandbox denial, or an unknown
 * sound name must never surface as an error to the session.
 */
import { spawn as nodeSpawn } from 'node:child_process'

/** Directory holding the built-in macOS alert sounds. */
export const SOUND_DIR = '/System/Library/Sounds'

/**
 * Build a rate limiter that allows one call per `minGapMs`.
 * @param {{ minGapMs?: number, now?: () => number }} [options]
 * @returns {{ allowed: () => boolean, reset: () => void }}
 */
export function createRateLimiter(options = {}) {
  const minGapMs = Number.isFinite(options.minGapMs) ? Math.max(0, options.minGapMs) : 1500
  const now = typeof options.now === 'function' ? options.now : Date.now
  let lastAt = Number.NEGATIVE_INFINITY
  return {
    allowed() {
      const at = now()
      if (at - lastAt < minGapMs) return false
      lastAt = at
      return true
    },
    reset() {
      lastAt = Number.NEGATIVE_INFINITY
    },
  }
}

/**
 * Pay one macOS alert sound.
 * @param {object} [options]
 * @param {string} [options.soundName] sound in {@link SOUND_DIR}, without extension
 * @param {string} [options.platform] defaults to `process.platform`
 * @param {typeof nodeSpawn} [options.spawn] injected child_process.spawn
 * @param {{ warn?: (message: string) => void }} [options.logger]
 * @returns {boolean} whether playback was started
 */
export function playNoticeSound(options = {}) {
  const soundName = typeof options.soundName === 'string' && options.soundName ? options.soundName : 'Glass'
  const platform = options.platform ?? process.platform
  const spawn = options.spawn ?? nodeSpawn
  if (platform !== 'darwin') return false
  try {
    const child = spawn('/usr/bin/afplay', [`${SOUND_DIR}/${soundName}.aiff`], {
      stdio: 'ignore',
      detached: true,
    })
    if (child && typeof child.unref === 'function') child.unref()
    if (child && typeof child.on === 'function') child.on('error', () => {})
    return true
  } catch (error) {
    options.logger?.warn?.(`afplay failed: ${String(error)}`)
    return false
  }
}
