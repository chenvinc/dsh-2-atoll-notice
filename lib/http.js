/**
 * Host HTTP routes for the settings card.
 *
 * Routes are `ctx.webServer.register` descriptors: the page fetches them as a
 * same-origin relative path, so no CORS handling is involved. Every route
 * answers JSON and never throws; a broken request is a 4xx, a broken Host is a
 * 5xx, and the GUI keeps rendering either way.
 */
import { headline, severity } from './format.js'

/** Root-absolute prefix registered on the Host web server. */
export const API_PREFIX = '/api/atoll-notice'

/** Largest accepted request body, in bytes. */
export const MAX_BODY_BYTES = 64 * 1024

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 */
export function writeJson(res, status, payload) {
  const body = JSON.stringify(payload)
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  } catch {
    try {
      res.destroy()
    } catch {
      /* ignore */
    }
  }
}

/**
 * Read and parse a JSON body with a hard size cap.
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<{ ok: true, value: unknown } | { ok: false, status: number, error: string }>}
 */
export async function readJsonBody(req) {
  return await new Promise((resolve) => {
    const chunks = []
    let size = 0
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        finish({ ok: false, status: 413, error: 'body-too-large' })
        try {
          req.destroy()
        } catch {
          /* ignore */
        }
        return
      }
      chunks.push(chunk)
    })
    req.on('error', () => finish({ ok: false, status: 400, error: 'read-failed' }))
    req.on('end', () => {
      if (!chunks.length) return finish({ ok: true, value: {} })
      try {
        finish({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
      } catch {
        finish({ ok: false, status: 400, error: 'invalid-json' })
      }
    })
  })
}

/**
 * Build the plugin's routes.
 * @param {object} options
 * @param {() => Record<string, unknown>} options.readSettings resolved settings
 * @param {(patch: Record<string, unknown>) => Promise<Record<string, unknown>>} options.writeSettings
 * @param {() => Record<string, unknown>} options.readStatus mirror status
 * @param {{ warn?: (message: string) => void }} [options.logger]
 * @returns {object[]} route descriptors for ctx.webServer.register
 */
export function createRoutes(options) {
  return [
    {
      kind: 'exact',
      path: `${API_PREFIX}/settings`,
      handler: async (req, res) => {
        try {
          if (req.method === 'GET') {
            writeJson(res, 200, { ok: true, settings: options.readSettings() })
            return
          }
          if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
          const contentType = String(req.headers?.['content-type'] ?? '').toLowerCase()
          if (!contentType.startsWith('application/json')) {
            return writeJson(res, 415, { ok: false, error: 'json-required' })
          }
          const body = await readJsonBody(req)
          if (!body.ok) return writeJson(res, body.status, { ok: false, error: body.error })
          const payload = body.value && typeof body.value === 'object' ? body.value : {}
          const patch = payload.settings ?? payload
          const settings = await options.writeSettings(patch && typeof patch === 'object' ? patch : {})
          writeJson(res, 200, { ok: true, settings })
        } catch (error) {
          options.logger?.warn?.(`atoll-notice: settings route failed: ${String(error)}`)
          writeJson(res, 500, { ok: false, error: 'internal-error' })
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/diagnostics`,
      handler: (req, res) => {
        try {
          if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
          writeJson(res, 200, { ok: true, diagnostics: options.readDiagnostics?.() ?? {} })
        } catch (error) {
          options.logger?.warn?.(`atoll-notice: diagnostics route failed: ${String(error)}`)
          writeJson(res, 500, { ok: false, error: 'internal-error', detail: String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/client-report`,
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
          const body = await readJsonBody(req)
          if (!body.ok) return writeJson(res, body.status, { ok: false, error: body.error })
          options.reportClient?.(body.value)
          writeJson(res, 204, null)
        } catch (error) {
          options.logger?.warn?.(`atoll-notice: client report failed: ${String(error)}`)
          writeJson(res, 500, { ok: false, error: 'internal-error' })
        }
      },
    },
    {
      kind: 'exact',
      path: `${API_PREFIX}/status`,
      handler: (req, res) => {
        try {
          if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
          const status = options.readStatus()
          const counts = status.counts ?? { failure: 0, attention: 0, done: 0 }
          writeJson(res, 200, {
            ok: true,
            status: {
              connected: Boolean(status.connected),
              authorized: Boolean(status.authorized),
              lastError: status.lastError ?? null,
              counts,
              headline: headline(counts),
              severity: severity(counts),
            },
          })
        } catch (error) {
          options.logger?.warn?.(`atoll-notice: status route failed: ${String(error)}`)
          writeJson(res, 500, { ok: false, error: 'internal-error' })
        }
      },
    },
  ]
}
