/**
 * Load the plugin into a real Cordis context.
 *
 * The other Host tests use a hand-written ctx stub; this one proves the module
 * really mounts under the framework the Harness uses: the exported schema is
 * accepted, `apply` gets a real context, `ctx.effect` and `ctx.on` behave, and
 * events emitted on the context reach Atoll.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { startFakeAtoll } from '../scripts/fake-atoll.mjs'
import * as plugin from '../index.js'

const isPresent = (call) =>
  call.method === 'atoll.presentLiveActivity' || call.method === 'atoll.updateLiveActivity'

test('mounts under a real Cordis context and mirrors a failure', async () => {
  const fake = startFakeAtoll()
  const port = await fake.ready
  const ctx = new Context()
  const fiber = await ctx.plugin(plugin, { port })
  try {
    ctx.emit('agent/error', {
      agent: { id: 'agent-live-1' },
      turn: 3,
      error: new Error('reference error: nope is not defined'),
    })
    const call = await fake.waitFor(isPresent)
    assert.equal(call.params.descriptor.id, 'dsh-status')
    assert.match(call.params.descriptor.subtitle, /失败/)
    assert.equal(call.params.descriptor.metadata?.counts, '1,0,0')
    assert.ok(call.params.descriptor.allowsMusicCoexistence)
  } finally {
    await fiber.dispose()
    await fake.close()
  }
})

test('a real Cordis context prunes the notice when the turn finishes', async () => {
  const fake = startFakeAtoll()
  const port = await fake.ready
  const ctx = new Context()
  const fiber = await ctx.plugin(plugin, { port })
  try {
    ctx.emit('agent/turn-stopping', { agent: { id: 'agent-live-2' }, turn: 1 })
    const green = await fake.waitFor(isPresent)
    assert.match(green.params.descriptor.subtitle, /完成/)
    assert.ok(green.params.descriptor.accentColor.green > 0.6)
  } finally {
    await fiber.dispose()
    await fake.close()
  }
})
