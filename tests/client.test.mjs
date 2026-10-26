/**
 * Structural tests for the browser half.
 *
 * This machine has no React renderer and no browser automation, so the card is
 * verified by loading the real client.js inside a sandbox with a stub `react`
 * and a stub Cordis context: the factory must run, the slot registration must
 * carry the documented ids, and the copy must cover every key the card uses.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

import { API_PREFIX } from '../lib/http.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = await readFile(join(root, 'client.js'), 'utf8')

/** Evaluate client.js against a stub React and return the exported module. */
function loadClient() {
  let spec
  const h = (type, props, ...children) => ({ type, props: props ?? {}, children })
  const react = {
    createElement: h,
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
    Fragment: Symbol('Fragment'),
  }
  const require = (name) => {
    if (name === 'react') return react
    if (name === 'react/jsx-runtime') return { jsx: h, jsxs: h, Fragment: react.Fragment }
    throw new Error(`unexpected require: ${name}`)
  }
  const sandbox = {
    window: { __ModuleLoader__: { load: (value) => (spec = value) } },
    require,
    console: { warn() {}, error() {}, log() {} },
    fetch: () => Promise.reject(new Error('offline')),
    AbortController,
    setTimeout,
    clearTimeout,
    Promise,
    JSON,
    Set,
    Map,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Symbol,
  }
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  assert.ok(spec, 'client.js called window.__ModuleLoader__.load')
  const exported = spec.factory(require)
  return { spec, exported }
}

test('the browser bundle registers itself under the plugin id', () => {
  const { spec, exported } = loadClient()
  assert.equal(spec.id, 'dsh-2-atoll-notice')
  assert.equal(typeof exported.apply, 'function')
  assert.deepEqual([...exported.inject], ['slots', 'locale'])
})

test('apply registers one plugins.item card and both dictionaries', () => {
  const { exported } = loadClient()
  const registrations = []
  const dictionaries = []
  const effects = []
  const ctx = {
    effect(fn) {
      effects.push(fn)
      fn()
    },
    locale: {
      bind: (ns) => (key) => `${ns}.${key}`,
      register: (ns, copy) => {
        dictionaries.push({ ns, copy })
        return () => {}
      },
    },
    slots: {
      inject: (slot, fn) => {
        assert.equal(slot, 'plugins.item')
        return fn()
      },
      register: (meta, component) => {
        registrations.push({ meta, component })
        return () => {}
      },
    },
  }
  exported.apply(ctx)

  assert.equal(registrations.length, 1)
  const { meta, component } = registrations[0]
  assert.equal(meta.name, 'plugins.item')
  assert.equal(meta.id, 'atoll-notice')
  assert.equal(meta.locale, 'atollNotice')
  assert.equal(typeof component, 'function')
  assert.equal(meta.label(), 'atollNotice.title')
  const props = meta.inject()
  assert.ok(props.atollNotice, 'injects the face object')
  assert.equal(dictionaries.length, 1)
  assert.equal(dictionaries[0].ns, 'atollNotice')
  assert.ok(dictionaries[0].copy.en && dictionaries[0].copy.zh)
})

test('every t("key") the card uses exists in both dictionaries', () => {
  const { exported } = loadClient()
  const dictionaries = []
  exported.apply({
    effect: (fn) => fn(),
    locale: { bind: () => (k) => k, register: (ns, copy) => void dictionaries.push({ ns, copy }) },
    slots: { inject: (_s, fn) => fn(), register: () => () => {} },
  })
  const used = new Set([...source.matchAll(/\bt\(\s*"([A-Za-z0-9_]+)"\s*\)/g)].map((m) => m[1]))
  assert.ok(used.size > 5, `found ${used.size} keys`)
  for (const key of used) {
    assert.ok(dictionaries[0].copy.en[key], `en has ${key}`)
    assert.ok(dictionaries[0].copy.zh[key], `zh has ${key}`)
  }
})

test('the card talks to the Host route the Host actually registers', () => {
  const match = source.match(/const API_PATH = "([^"]+)"/)
  assert.ok(match, 'API_PATH declared')
  assert.equal(`/${match[1]}`, API_PREFIX)
  assert.match(source, /`\$\{face\.apiPath\}\/settings`/)
  assert.match(source, /method: "POST"/)
  assert.match(source, /credentials: "same-origin"/)
})

test('no static imports and no JSX tags leak into the browser bundle', () => {
  assert.doesNotMatch(source, /^\s*import\s+[\w{*]/m, 'no top-level import')
  assert.doesNotMatch(source, /\breturn\s*\(\s*</, 'no JSX')
  assert.match(source, /^window\.__ModuleLoader__\.load\(/m)
})
