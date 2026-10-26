import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ACCENTS,
  ICONS,
  buildStatusDescriptor,
  compactCounts,
  headline,
  order,
  severity,
} from '../lib/format.js'

const ZERO = { failure: 0, attention: 0, done: 0 }
const FULL = { failure: 2, attention: 1, done: 3 }

test('ACCENTS and ICONS expose the exact wire vocabulary', () => {
  assert.deepEqual(ACCENTS, {
    failure: { red: 1, green: 0.271, blue: 0.227, alpha: 1 },
    attention: { red: 1, green: 0.839, blue: 0.039, alpha: 1 },
    done: { red: 0.188, green: 0.82, blue: 0.345, alpha: 1 },
    none: { red: 0.557, green: 0.557, blue: 0.576, alpha: 1 },
  })

  assert.deepEqual(ICONS, {
    failure: 'exclamationmark.triangle.fill',
    attention: 'bell.badge.fill',
    done: 'checkmark.circle.fill',
    none: 'sparkles',
  })

  // Components stay in the 0–1 range Atoll's RGBAColor decoder expects.
  for (const accent of Object.values(ACCENTS)) {
    for (const key of ['red', 'green', 'blue', 'alpha']) {
      assert.equal(typeof accent[key], 'number')
      assert.ok(accent[key] >= 0 && accent[key] <= 1)
    }
  }
})

test('severity picks the most urgent non-zero kind', () => {
  assert.equal(severity(ZERO), 'none')
  assert.equal(severity({ failure: 0, attention: 0, done: 1 }), 'done')
  assert.equal(severity({ failure: 0, attention: 1, done: 9 }), 'attention')
  assert.equal(severity({ failure: 1, attention: 9, done: 9 }), 'failure')
  assert.equal(severity({ failure: 3, attention: 0, done: 0 }), 'failure')
  assert.equal(severity({ failure: 1, attention: 1, done: 0 }), 'failure')
})

test('severity ignores hostile counts', () => {
  assert.equal(severity(), 'none')
  assert.equal(severity(null), 'none')
  assert.equal(severity('nope'), 'none')
  assert.equal(severity({ failure: '2', attention: -1, done: Number.NaN }), 'none')
  assert.equal(severity({ failure: Number.POSITIVE_INFINITY }), 'none')
  assert.doesNotThrow(() =>
    severity(
      new Proxy(
        {},
        {
          get() {
            throw new Error('boom')
          },
        },
      ),
    ),
  )
})

test('compactCounts renders r·y·g and clamps each count to 99', () => {
  assert.equal(compactCounts(FULL), '2·1·3')
  assert.equal(compactCounts({ failure: 0, attention: 2, done: 0 }), '0·2·0')
  assert.equal(compactCounts({ failure: 150, attention: 0, done: 0 }), '99·0·0')
  assert.equal(compactCounts({ failure: 999, attention: 999, done: 999 }), '99·99·99')
  assert.equal(compactCounts({ failure: 9, attention: 99, done: 100 }), '9·99·99')
  assert.equal(compactCounts({ failure: 2.9, attention: 0.4, done: 0 }), '2·0·0')
  assert.equal(compactCounts({ failure: -4, attention: 1, done: -2 }), '0·1·0')
  assert.ok(compactCounts({ failure: 999, attention: 999, done: 999 }).length <= 8)
})

test('compactCounts is empty only when nothing is pending', () => {
  assert.equal(compactCounts(ZERO), '')
  assert.equal(compactCounts({}), '')
  assert.equal(compactCounts(null), '')
  assert.equal(compactCounts('nope'), '')
  assert.equal(compactCounts({ failure: Number.NaN, attention: 'x', done: {} }), '')
  assert.equal(compactCounts({ failure: 0, attention: 1, done: 0 }), '0·1·0')
})

test('headline joins non-zero kinds with the Chinese labels', () => {
  assert.equal(headline({ failure: 2, attention: 1, done: 3 }), '2 失败 · 1 待确认 · 3 完成')
  assert.equal(headline({ failure: 1, attention: 0, done: 0 }), '1 失败')
  assert.equal(headline({ failure: 0, attention: 1, done: 0 }), '1 待确认')
  assert.equal(headline({ failure: 0, attention: 0, done: 2 }), '2 完成')
  assert.equal(headline({ failure: 0, attention: 1, done: 1 }), '1 待确认 · 1 完成')
  assert.equal(headline({ failure: 3, attention: 0, done: 3 }), '3 失败 · 3 完成')
})

test('headline reports 一切正常 only for an empty island', () => {
  assert.equal(headline(ZERO), '一切正常')
  assert.equal(headline({}), '一切正常')
  assert.equal(headline(null), '一切正常')
  assert.equal(headline({ failure: 0, attention: 0, done: 0 }), '一切正常')
  assert.equal(headline({ failure: -3, attention: Number.NaN, done: 'x' }), '一切正常')
})

test('headline caps large numbers so the subtitle stays short', () => {
  assert.equal(headline({ failure: 150, attention: 0, done: 0 }), '99+ 失败')
  assert.equal(headline({ failure: 120, attention: 3, done: 0 }), '99+ 失败 · 3 待确认')
  assert.equal(headline({ failure: 99, attention: 0, done: 0 }), '99 失败')
  assert.equal(headline({ failure: 100, attention: 0, done: 0 }), '99+ 失败')
})

test('headline output is a single line', () => {
  const text = headline({ failure: 1, attention: 1, done: 1 })
  assert.equal(text.includes('\n'), false)
  assert.equal(text.includes('\r'), false)
  assert.ok(text.length <= 40)
})

test('order lists non-zero kinds urgent first', () => {
  assert.deepEqual(order(ZERO), [])
  assert.deepEqual(order({}), [])
  assert.deepEqual(order({ failure: 1, attention: 1, done: 1 }), ['failure', 'attention', 'done'])
  assert.deepEqual(order({ failure: 0, attention: 1, done: 1 }), ['attention', 'done'])
  assert.deepEqual(order({ failure: 5, attention: 0, done: 0 }), ['failure'])
  assert.deepEqual(order({ failure: 0, attention: 0, done: 7 }), ['done'])
  assert.deepEqual(order({ failure: -1, attention: 1, done: 0 }), ['attention'])
})

test('buildStatusDescriptor builds the exact wire descriptor', () => {
  const descriptor = buildStatusDescriptor({
    counts: FULL,
    items: [],
    activityId: 'dsh-status',
    bundleIdentifier: 'dev.dsh.atoll-notice',
  })

  assert.deepEqual(descriptor, {
    id: 'dsh-status',
    bundleIdentifier: 'dev.dsh.atoll-notice',
    priority: 'high',
    title: 'DSH 任务',
    subtitle: '2 失败 · 1 待确认 · 3 完成',
    leadingIcon: { type: 'symbol', name: 'exclamationmark.triangle.fill', size: 15 },
    trailingContent: { type: 'text', text: '2·1·3' },
    accentColor: { red: 1, green: 0.271, blue: 0.227, alpha: 1 },
    allowsMusicCoexistence: true,
    metadata: { counts: '2,1,3' },
  })
})

test('buildStatusDescriptor maps attention to high and done to normal', () => {
  const attention = buildStatusDescriptor({
    counts: { failure: 0, attention: 2, done: 4 },
    activityId: 'dsh-status',
    bundleIdentifier: 'b',
  })
  assert.equal(attention.priority, 'high')
  assert.equal(attention.leadingIcon.name, 'bell.badge.fill')
  assert.deepEqual(attention.accentColor, { red: 1, green: 0.839, blue: 0.039, alpha: 1 })
  assert.equal(attention.subtitle, '2 待确认 · 4 完成')
  assert.equal(attention.trailingContent.text, '0·2·4')

  const done = buildStatusDescriptor({
    counts: { failure: 0, attention: 0, done: 1 },
    activityId: 'dsh-status',
    bundleIdentifier: 'b',
  })
  assert.equal(done.priority, 'normal')
  assert.equal(done.leadingIcon.name, 'checkmark.circle.fill')
  assert.deepEqual(done.accentColor, { red: 0.188, green: 0.82, blue: 0.345, alpha: 1 })
  assert.equal(done.subtitle, '1 完成')
})

test('buildStatusDescriptor handles the all-clear state without trailing content', () => {
  const descriptor = buildStatusDescriptor({
    counts: ZERO,
    items: [],
    activityId: 'dsh-status',
    bundleIdentifier: 'dev.dsh.atoll-notice',
  })

  assert.deepEqual(descriptor, {
    id: 'dsh-status',
    bundleIdentifier: 'dev.dsh.atoll-notice',
    priority: 'normal',
    title: 'DSH 任务',
    subtitle: '一切正常',
    leadingIcon: { type: 'symbol', name: 'sparkles', size: 15 },
    accentColor: { red: 0.557, green: 0.557, blue: 0.576, alpha: 1 },
    allowsMusicCoexistence: true,
    metadata: { counts: '0,0,0' },
  })
  assert.equal('trailingContent' in descriptor, false)
})

test('buildStatusDescriptor honours a custom title and trims identifiers', () => {
  const descriptor = buildStatusDescriptor({
    counts: { failure: 1 },
    activityId: '  my-activity  ',
    bundleIdentifier: '  dev.example.app  ',
    title: '  自定义标题  ',
  })
  assert.equal(descriptor.id, 'my-activity')
  assert.equal(descriptor.bundleIdentifier, 'dev.example.app')
  assert.equal(descriptor.title, '自定义标题')
  assert.equal(descriptor.subtitle, '1 失败')
  assert.equal(descriptor.leadingIcon.name, 'exclamationmark.triangle.fill')
})

test('buildStatusDescriptor keeps the raw counts in metadata while display is capped', () => {
  const descriptor = buildStatusDescriptor({
    counts: { failure: 150, attention: 0, done: 2 },
    activityId: 'a',
    bundleIdentifier: 'b',
  })
  assert.equal(descriptor.subtitle, '99+ 失败 · 2 完成')
  assert.equal(descriptor.trailingContent.text, '99·0·2')
  assert.equal(descriptor.metadata.counts, '150,0,2')
  assert.deepEqual(JSON.parse(JSON.stringify(descriptor)), descriptor)
})

test('buildStatusDescriptor has no undefined members and survives JSON round trips', () => {
  const cases = [
    { counts: ZERO, activityId: 'dsh-status', bundleIdentifier: 'dev.dsh.atoll-notice' },
    { counts: FULL, activityId: 'dsh-status', bundleIdentifier: 'dev.dsh.atoll-notice' },
    { counts: { failure: 0, attention: 1, done: 0 }, activityId: 'dsh-status', bundleIdentifier: 'b' },
    { counts: { failure: 150, attention: 12, done: 400 }, activityId: 'x', bundleIdentifier: 'y' },
    { counts: { failure: 0, attention: 0, done: 1 }, title: '自定义', activityId: 'z', bundleIdentifier: 'q' },
  ]

  for (const input of cases) {
    const descriptor = buildStatusDescriptor(input)
    assert.equal(Object.values(descriptor).includes(undefined), false)
    assert.deepEqual(JSON.parse(JSON.stringify(descriptor)), descriptor)
  }
})

test('buildStatusDescriptor copies the accent so ACCENTS stays immutable', () => {
  const descriptor = buildStatusDescriptor({
    counts: { failure: 1 },
    activityId: 'a',
    bundleIdentifier: 'b',
  })
  assert.deepEqual(descriptor.accentColor, ACCENTS.failure)
  descriptor.accentColor.red = 0
  assert.equal(ACCENTS.failure.red, 1)

  assert.throws(() => {
    ACCENTS.failure.red = 0
  })
  assert.throws(() => {
    ICONS.failure = 'nope'
  })
})

test('buildStatusDescriptor tolerates hostile input and defaults sanely', () => {
  const expectedDefault = {
    id: 'dsh-status',
    bundleIdentifier: '',
    priority: 'normal',
    title: 'DSH 任务',
    subtitle: '一切正常',
    leadingIcon: { type: 'symbol', name: 'sparkles', size: 15 },
    accentColor: { red: 0.557, green: 0.557, blue: 0.576, alpha: 1 },
    allowsMusicCoexistence: true,
    metadata: { counts: '0,0,0' },
  }

  for (const input of [undefined, null, 42, 'nope', [], {}, { counts: null }]) {
    assert.doesNotThrow(() => buildStatusDescriptor(input))
    assert.deepEqual(buildStatusDescriptor(input), expectedDefault)
  }

  const throwingGetters = {
    get counts() {
      throw new Error('boom')
    },
    get activityId() {
      throw new Error('boom')
    },
    get bundleIdentifier() {
      throw new Error('boom')
    },
    get title() {
      throw new Error('boom')
    },
  }
  assert.doesNotThrow(() => buildStatusDescriptor(throwingGetters))
  assert.deepEqual(buildStatusDescriptor(throwingGetters), expectedDefault)

  const throwingCounts = new Proxy(
    {},
    {
      get() {
        throw new Error('boom')
      },
    },
  )
  let descriptor
  assert.doesNotThrow(() => {
    descriptor = buildStatusDescriptor({
      counts: throwingCounts,
      activityId: 'a',
      bundleIdentifier: 'b',
    })
  })
  assert.equal(descriptor.subtitle, '一切正常')
  assert.equal(descriptor.metadata.counts, '0,0,0')
  assert.equal(descriptor.id, 'a')
  assert.equal(descriptor.bundleIdentifier, 'b')
})

test('buildStatusDescriptor accepts non-numeric counts as zero', () => {
  const descriptor = buildStatusDescriptor({
    counts: { failure: '3', attention: -2, done: 4.7 },
    activityId: 'a',
    bundleIdentifier: 'b',
  })
  assert.equal(descriptor.subtitle, '4 完成')
  assert.equal(descriptor.metadata.counts, '0,0,4')
  assert.equal(descriptor.leadingIcon.name, 'checkmark.circle.fill')
})
