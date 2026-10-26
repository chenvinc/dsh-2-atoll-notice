/**
 * Plugin configuration: schema defaults plus a defensive resolver.
 *
 * The Cordis loader validates the exported `Config` schema, but a linked or
 * hand-edited bundle patch is not a trustworthy input. `resolveConfig` therefore
 * coerces every field, clamps numbers, and never throws.
 */

/** @typedef {object} AtollNoticeConfig */
/** @type {Required<AtollNoticeConfig>} */
export const DEFAULT_CONFIG = Object.freeze({
  failed: true,
  attention: true,
  done: true,
  sound: false,
  soundName: 'Glass',
  port: 9020,
  bundleIdentifier: 'dev.dsh.atoll-notice',
  appName: 'DeepSeek Harness',
  retentionMs: 15 * 60 * 1000,
  doneRetentionMs: 2 * 60 * 1000,
  minimumGapMs: 1500,
})

/**
 * Coerce raw configuration into a complete configuration object.
 * @param {Record<string, unknown> | undefined | null} raw
 * @returns {AtollNoticeConfig}
 */
export function resolveConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const bool = (key) =>
    typeof source[key] === 'boolean' ? source[key] : DEFAULT_CONFIG[key]
  const int = (key, min, max) => {
    const value = Number(source[key])
    if (!Number.isFinite(value)) return DEFAULT_CONFIG[key]
    return Math.min(max, Math.max(min, Math.round(value)))
  }
  const text = (key, pattern) => {
    const value = typeof source[key] === 'string' ? source[key].trim() : ''
    if (!value) return DEFAULT_CONFIG[key]
    return pattern.test(value) ? value : DEFAULT_CONFIG[key]
  }
  return {
    failed: bool('failed'),
    attention: bool('attention'),
    done: bool('done'),
    sound: bool('sound'),
    soundName: text('soundName', /^[A-Za-z0-9 _-]{1,64}$/),
    port: int('port', 1, 65535),
    bundleIdentifier: text('bundleIdentifier', /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/),
    appName: (() => {
      const value =
        typeof source.appName === 'string'
          ? source.appName.replace(/[\r\n]+/g, ' ').trim().slice(0, 64)
          : ''
      return value || DEFAULT_CONFIG.appName
    })(),
    retentionMs: int('retentionMs', 60_000, 24 * 60 * 60 * 1000),
    doneRetentionMs: int('doneRetentionMs', 5_000, 24 * 60 * 60 * 1000),
    minimumGapMs: int('minimumGapMs', 0, 60_000),
  }
}
