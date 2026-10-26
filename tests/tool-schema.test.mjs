import assert from 'node:assert/strict'
import test from 'node:test'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { toolSpecs } from '../lib/tools.js'

const store = {
  snapshot: () => ({ counts: { failure: 0, attention: 0, done: 0 }, items: [] }),
  clear: () => 0,
}
const mirror = { state: () => ({ connected: false }), flash: () => {} }
const deps = { store, mirror, activityId: 'id', runtime: () => ({ bundleIdentifier: 'b' }) }

test('every tool spec passes the real defineTool schema validation', () => {
  const specs = toolSpecs(deps)
  assert.equal(specs.length, 3)
  for (const spec of specs) {
    assert.doesNotThrow(() => defineTool(spec), `defineTool rejected ${spec.name}`)
  }
})

test('defineTool rejects required: false, the trap that killed registration', () => {
  assert.throws(
    () =>
      defineTool({
        name: 'atoll_notice_probe',
        description: 'probe',
        parameters: { kind: { type: 'string', required: false } },
        output: { schema: { type: 'object' } },
      }),
    /required must be true/,
  )
})
