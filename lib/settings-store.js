/**
 * Durable user settings for the Atoll mirror.
 *
 * The bundle patch carries deployment defaults; this file carries what the
 * human toggled in the GUI. A missing or corrupt file is not an error: the
 * caller falls back to the patch defaults.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Fields the browser half may change. */
export const WRITABLE_FIELDS = Object.freeze(['failed', 'attention', 'done', 'sound', 'soundName', 'port'])

/**
 * Resolve the settings file for the active DSH profile.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [home]
 * @returns {string} absolute path
 */
export function resolveSettingsPath(env = process.env, home = homedir()) {
  const profileDir = env.DSH_PROFILE_DIR?.trim()
  if (profileDir) return join(profileDir, 'atoll-notice', 'settings.json')
  const dshHome = env.DSH_HOME?.trim() || join(home, '.dsh')
  const profile = env.DSH_PROFILE?.trim() || 'default'
  return join(dshHome, 'profiles', profile, 'atoll-notice', 'settings.json')
}

/**
 * Read persisted settings.
 * @param {string} filePath
 * @returns {Promise<Record<string, unknown> | null>} the stored object, or null when absent/invalid
 */
export async function readSettingsFile(filePath) {
  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Persist settings atomically (temp file + rename).
 * @param {string} filePath
 * @param {Record<string, unknown>} settings
 * @returns {Promise<boolean>} whether the write landed
 */
export async function writeSettingsFile(filePath, settings) {
  try {
    await mkdir(dirname(filePath), { recursive: true })
    const temporary = `${filePath}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
    await rename(temporary, filePath)
    return true
  } catch {
    return false
  }
}

/**
 * Keep only writable fields that carry a usable type; anything else is dropped
 * so a hostile request cannot poison the configuration.
 * @param {unknown} input
 * @returns {Record<string, unknown>} partial settings
 */
export function pickSettingsPatch(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  /** @type {Record<string, unknown>} */
  const patch = {}
  for (const field of WRITABLE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(input, field)) continue
    const value = input[field]
    if (field === 'soundName') {
      if (typeof value === 'string' && value.trim()) patch[field] = value.trim()
    } else if (field === 'port') {
      const port = Number(value)
      if (Number.isFinite(port) && port >= 1 && port <= 65535) patch[field] = Math.round(port)
    } else if (typeof value === 'boolean') {
      patch[field] = value
    }
  }
  return patch
}

/**
 * Overlay a stored/user layer over the deployment defaults.
 * @param {Record<string, unknown>} base
 * @param {Record<string, unknown> | null} [layer]
 * @returns {Record<string, unknown>} merged raw settings (still to be validated)
 */
export function mergeSettings(base, layer) {
  return { ...base, ...pickSettingsPatch(layer ?? {}) }
}
