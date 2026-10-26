import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply } from '../index.js'

/** Quiet logger every fake context hands back. */
const logger = { info() {}, debug() {}, warn() {}, error() {} }

/**
 * Minimal cordis-shaped context. `services` is what `ctx.get` answers before
 * any late injection happened, which is exactly the cold-start situation.
 * @param {Record<string, unknown>} services
 */
function makeContext(services = {}) {
  /** @type {Array<() => void>} */
  const cleanups = []
  const ctx = {
    get: (key) => services[key],
    on: () => () => {},
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') cleanups.push(dispose)
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    logger: () => logger,
  }
  return { ctx, cleanups }
}

/**
 * A scoped context as cordis hands it to an `inject` callback.
 * @param {Record<string, unknown>} services
 */
function scoped(services) {
  return {
    ...services,
    get: (key) => services[key],
    effect(fn) {
      const dispose = fn()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    logger,
  }
}

test('cold start defers routes and tools until their services exist', async () => {
  const { ctx, cleanups } = makeContext({})
  /** @type {Array<{ deps: string[], cb: (ctx: any) => unknown }>} */
  const pending = []
  ctx.inject = (deps, cb) => {
    pending.push({ deps, cb })
    return () => {}
  }

  apply(ctx, {})

  assert.equal(pending.length, 2, 'one injection per optional service')
  assert.deepEqual(
    pending.map((entry) => entry.deps).sort(),
    [['tools'], ['webServer']].sort(),
  )

  const routes = []
  const webEntry = pending.find((entry) => entry.deps[0] === 'webServer')
  webEntry.cb(
    scoped({
      webServer: {
        register(route) {
          routes.push(route)
          return () => {}
        },
      },
    }),
  )
  assert.deepEqual(
    routes.map((route) => route.path).sort(),
    [
      '/api/atoll-notice/client-report',
      '/api/atoll-notice/diagnostics',
      '/api/atoll-notice/settings',
      '/api/atoll-notice/status',
    ],
  )

  const tools = []
  const toolsEntry = pending.find((entry) => entry.deps[0] === 'tools')
  toolsEntry.cb(
    scoped({
      tools: {
        register(tool) {
          tools.push(tool)
          return () => {}
        },
      },
    }),
  )
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(tools.length, 3, 'every agent tool registers once the service is there')
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ['atoll_notice_clear', 'atoll_notice_status', 'atoll_notice_test'],
  )

  for (const dispose of cleanups) dispose()
})

test('a host without ctx.inject mounts immediately from the live services', async () => {
  const routes = []
  const tools = []
  const { ctx, cleanups } = makeContext({
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    tools: {
      register(tool) {
        tools.push(tool)
        return () => {}
      },
    },
  })

  apply(ctx, {})

  assert.equal(routes.length, 4)
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(tools.length, 3)
  for (const dispose of cleanups) dispose()
})
