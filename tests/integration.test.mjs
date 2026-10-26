/**
 * End-to-end Host test: real Cordis-shaped context, real WebSocket frames,
 * a fake Atoll server, and the settings HTTP routes over a real socket.
 *
 * This is the test that would have caught a wrong wire shape: it asserts the
 * exact JSON-RPC method names and descriptor fields that Atoll accepts.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { startFakeAtoll } from '../scripts/fake-atoll.mjs'
import { apply } from '../index.js'

/** Mount the plugin against a fake Atoll and an in-process web server. */
async function mount() {
  const profileDir = await mkdtemp(join(tmpdir(), 'atoll-notice-'))
  process.env.DSH_PROFILE_DIR = profileDir

  const fake = startFakeAtoll()
  const port = await fake.ready

  const routes = new Map()
  const handlers = new Map()
  const disposers = []
  const warnings = []

  const ctx = {
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => {}
    },
    get(name) {
      if (name !== 'webServer') return undefined
      return {
        register(route) {
          routes.set(route.path, route.handler)
          return () => routes.delete(route.path)
        },
      }
    },
    effect(fn) {
      const dispose = fn()
      disposers.push(dispose)
      return () => {}
    },
    logger() {
      return { info() {}, warn: (m) => warnings.push(String(m)), debug() {} }
    },
  }

  apply(ctx, { port, sound: false })

  const server = createServer((request, response) => {
    const { pathname } = new URL(request.url ?? '/', 'http://127.0.0.1')
    const handler = routes.get(pathname)
    if (!handler) {
      response.writeHead(404).end()
      return
    }
    void handler(request, response)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const httpPort = server.address().port

  const emit = async (event, payload, next) => {
    for (const handler of handlers.get(event) ?? []) await handler(payload, next)
  }

  return {
    fake,
    profileDir,
    warnings,
    emit,
    settingsUrl: `http://127.0.0.1:${httpPort}/api/atoll-notice/settings`,
    statusUrl: `http://127.0.0.1:${httpPort}/api/atoll-notice/status`,
    async close() {
      for (const dispose of disposers.reverse()) {
        try {
          if (typeof dispose === 'function') dispose()
        } catch {
          /* ignore */
        }
      }
      await new Promise((resolve) => server.close(resolve))
      await fake.close()
      await rm(profileDir, { recursive: true, force: true })
    },
  }
}

const isPresent = (call) => call.method === 'atoll.presentLiveActivity' || call.method === 'atoll.updateLiveActivity'

test('a failed turn reaches Atoll as a red present call', async () => {
  const app = await mount()
  try {
    await app.emit('agent/error', {
      agent: { id: 'agent-abcdef123456' },
      turn: 7,
      error: new Error('boom'),
    })
    const call = await app.fake.waitFor(isPresent)
    assert.equal(call.method, 'atoll.presentLiveActivity')
    assert.equal(call.params.descriptor.id, 'dsh-status')
    assert.equal(call.params.descriptor.bundleIdentifier, 'dev.dsh.atoll-notice')
    assert.match(call.params.descriptor.subtitle, /失败/)
    assert.equal(call.params.descriptor.title, 'DSH 任务')
    assert.ok(call.params.descriptor.accentColor.red > 0.8, 'red accent')
    assert.ok(call.params.descriptor.leadingIcon, 'leading icon present')
  } finally {
    await app.close()
  }
})

test('a pending approval shows yellow and clears when it resolves', async () => {
  const app = await mount()
  try {
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const pending = app.emit(
      'approval/request',
      { agent: { id: 'agent-1' }, callId: 'call-9', toolName: 'bash' },
      async () => await gate,
    )
    const yellow = await app.fake.waitFor(isPresent)
    assert.match(yellow.params.descriptor.subtitle, /待确认/)
    release()
    await pending
    const cleared = await app.fake.waitFor(
      (call) => call.method === 'atoll.dismissLiveActivity' || (isPresent(call) && !/等待/.test(call.params.descriptor.subtitle ?? '')),
    )
    assert.ok(cleared)
  } finally {
    await app.close()
  }
})

test('a finished turn shows green, an aborted one shows nothing', async () => {
  const app = await mount()
  try {
    await app.emit('agent/turn-stopping', { agent: { id: 'agent-2' }, turn: 1 })
    const green = await app.fake.waitFor(isPresent)
    assert.match(green.params.descriptor.subtitle, /完成/)
    assert.ok(green.params.descriptor.accentColor.green > 0.6, 'green accent')

    const before = app.fake.calls.length
    await app.emit('agent/turn-stopping', { agent: { id: 'agent-3' }, turn: 2, signal: { aborted: true } })
    assert.equal(app.fake.calls.length, before, 'aborted turn is silent')
  } finally {
    await app.close()
  }
})

test('settings routes read, validate and persist', async () => {
  const app = await mount()
  try {
    const initial = await fetch(app.settingsUrl, { headers: { accept: 'application/json' } })
    assert.equal(initial.status, 200)
    const initialBody = await initial.json()
    assert.equal(initialBody.ok, true)
    assert.equal(initialBody.settings.done, true)
    assert.equal(initialBody.settings.port, app.fake.port)

    const saved = await fetch(app.settingsUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings: { sound: true, done: false, port: app.fake.port } }),
    })
    assert.equal(saved.status, 200)
    const savedBody = await saved.json()
    assert.equal(savedBody.settings.sound, true)
    assert.equal(savedBody.settings.done, false)

    const stored = JSON.parse(await readFile(join(app.profileDir, 'atoll-notice', 'settings.json'), 'utf8'))
    assert.equal(stored.sound, true)
    assert.equal(stored.done, false)

    const wrongType = await fetch(app.settingsUrl, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'sound=true',
    })
    assert.equal(wrongType.status, 415)

    const badJson = await fetch(app.settingsUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    })
    assert.equal(badJson.status, 400)

    const wrongMethod = await fetch(app.settingsUrl, { method: 'DELETE' })
    assert.equal(wrongMethod.status, 405)

    const status = await fetch(app.statusUrl)
    const statusBody = await status.json()
    assert.equal(statusBody.ok, true)
    assert.equal(typeof statusBody.status.connected, 'boolean')
  } finally {
    await app.close()
  }
})
