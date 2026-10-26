import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

test('exports every subpath the Host resolves for this package', () => {
  // The client-module composer locates a package manifest with
  // `resolve('<name>/package.json')`; without this subpath the browser half is
  // silently dropped and its settings card never appears.
  assert.equal(pkg.exports['./package.json'], './package.json')
  assert.equal(pkg.exports['./client'], './client.js')
  assert.equal(pkg.exports['.'], './index.js')
})

test('the client half and its declaration exist on disk', () => {
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.ok(Array.isArray(pkg.dsh.client.inject) && pkg.dsh.client.inject.length > 0)
  assert.ok(existsSync(join(root, pkg.exports['./client'])), 'client bundle missing')
  assert.ok(existsSync(join(root, pkg.exports['.'])), 'host entry missing')
})
