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
    // defineTool() invokes output.render unconditionally; a spec without one
    // registers fine and then fails every single call at runtime.
    const tool = defineTool(spec)
    assert.equal(typeof tool.output.render, 'function', `${spec.name} has no output.render`)
    const rendered = tool.output.render({}, { ok: true })
    assert.ok(Array.isArray(rendered) && rendered.length > 0, `${spec.name} render returned nothing`)
    assert.doesNotThrow(() => JSON.stringify(rendered), `${spec.name} render is not serialisable`)
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

test('every tool executes and returns serialisable JSON', async () => {
  for (const spec of toolSpecs(deps)) {
    const tool = defineTool(spec)
    const result = await tool.execute({}, {})
    assert.equal(typeof result, 'object', `${spec.name} did not return an object`)
    assert.doesNotThrow(() => JSON.stringify(result), `${spec.name} result is not serialisable`)
  }
})
