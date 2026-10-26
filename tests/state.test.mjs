import test from 'node:test'
import assert from 'node:assert/strict'

import { NoticeStore } from '../lib/state.js'

/** Controllable clock so expiry tests never depend on wall time. */
function makeClock(start = 1_000) {
  let value = start
  return {
    now: () => value,
    set(next) {
      value = next
    },
    advance(ms) {
      value += ms
    },
  }
}

let noticeCounter = 0

/** Build one valid notice with unique agent/id defaults. */
function makeNotice(overrides = {}) {
  noticeCounter += 1
  return {
    id: `notice-${noticeCounter}`,
    kind: 'done',
    agentId: `agent-${noticeCounter}`,
    title: `任务 ${noticeCounter}`,
    createdAt: noticeCounter,
    ...overrides,
  }
}

test('add returns a normalised public item and updates the snapshot', () => {
  const store = new NoticeStore({ now: () => 1_000 })
  const result = store.add({
    id: 'done:a:1',
    kind: 'done',
    agentId: 'a',
    title: '完成',
    createdAt: 900,
  })

  assert.equal(result.added, true)
  assert.deepEqual(result.item, {
    id: 'done:a:1',
    kind: 'done',
    agentId: 'a',
    title: '完成',
    createdAt: 900,
  })
  assert.equal(store.size(), 1)

  const snapshot = store.snapshot()
  assert.deepEqual(snapshot.counts, { failure: 0, attention: 0, done: 1 })
  assert.equal(snapshot.total, 1)
  assert.equal(snapshot.items.length, 1)
})

test('add keeps detail and expiresAt only when they are usable', () => {
  const store = new NoticeStore({ now: () => 1_000 })
  const withExtras = store.add({
    id: 'failure:a:1',
    kind: 'failure',
    agentId: 'a',
    title: '构建失败',
    detail: '  ./src/a.js\n第 3 行  ',
    createdAt: 10,
    expiresAt: 5_000,
  })
  assert.equal(withExtras.added, true)
  assert.equal(withExtras.item.detail, './src/a.js 第 3 行')
  assert.equal(withExtras.item.expiresAt, 5_000)

  const plain = store.add({
    id: 'done:b:1',
    kind: 'done',
    agentId: 'b',
    title: '完成',
    createdAt: 20,
  })
  assert.equal('detail' in plain.item, false)
  assert.equal('expiresAt' in plain.item, false)
})

test('re-adding identical content is a no-op', () => {
  const store = new NoticeStore({ now: () => 1_000 })
  let calls = 0
  const notice = {
    id: 'attention:a:1',
    kind: 'attention',
    agentId: 'a',
    title: '等待确认',
    createdAt: 50,
  }

  assert.equal(store.add(notice).added, true)
  store.onChange(() => {
    calls += 1
  })

  const again = store.add({ ...notice })
  assert.equal(again.added, false)
  assert.equal(again.item.title, '等待确认')
  assert.equal(calls, 0)
  assert.equal(store.size(), 1)
})

test('adding the same id with new content replaces it', () => {
  const store = new NoticeStore({ now: () => 1_000 })
  store.add({ id: 'x', kind: 'failure', agentId: 'a', title: '旧标题', createdAt: 10 })

  const replaced = store.add({
    id: 'x',
    kind: 'failure',
    agentId: 'a',
    title: '新标题',
    createdAt: 20,
  })
  assert.equal(replaced.added, true)
  assert.equal(store.size(), 1)

  const snapshot = store.snapshot()
  assert.equal(snapshot.items[0].title, '新标题')
  assert.equal(snapshot.items[0].createdAt, 20)
})

test('one live notice per agent per kind: a newer id replaces the older one', () => {
  const store = new NoticeStore({ now: () => 1_000 })
  store.add({ id: 'failure:a:1', kind: 'failure', agentId: 'a', title: '第一次', createdAt: 10 })
  store.add({ id: 'failure:a:2', kind: 'failure', agentId: 'a', title: '第二次', createdAt: 20 })

  const snapshot = store.snapshot()
  assert.equal(snapshot.total, 1)
  assert.equal(snapshot.items[0].id, 'failure:a:2')
  assert.equal(snapshot.counts.failure, 1)
})

test('distinct agents coexist for the same kind', () => {
  const store = new NoticeStore({ now: () => 1_000 })
  store.add({ id: 'failure:a:1', kind: 'failure', agentId: 'a', title: 'A', createdAt: 10 })
  store.add({ id: 'failure:b:1', kind: 'failure', agentId: 'b', title: 'B', createdAt: 20 })

  const snapshot = store.snapshot()
  assert.equal(snapshot.total, 2)
  assert.deepEqual(snapshot.counts, { failure: 2, attention: 0, done: 0 })
})

test('one agent can hold one notice per kind', () => {
  const store = new NoticeStore({ now: () => 1_000 })
  store.add({ id: 'failure:a:1', kind: 'failure', agentId: 'a', title: '失败', createdAt: 10 })
  store.add({ id: 'attention:a:1', kind: 'attention', agentId: 'a', title: '待确认', createdAt: 20 })
  store.add({ id: 'done:a:1', kind: 'done', agentId: 'a', title: '完成', createdAt: 30 })

  assert.equal(store.size(), 3)

  // A newer failure replaces only the failure, not the other kinds.
  store.add({ id: 'failure:a:2', kind: 'failure', agentId: 'a', title: '又失败', createdAt: 40 })
  assert.equal(store.size(), 3)
  assert.deepEqual(store.snapshot().counts, { failure: 1, attention: 1, done: 1 })
})

test('snapshot sorts newest first and breaks createdAt ties by insertion order', () => {
  const store = new NoticeStore({ now: () => 1_000 })
  store.add({ id: 'c', kind: 'done', agentId: 'a', title: 'C', createdAt: 100 })
  store.add({ id: 'a', kind: 'done', agentId: 'b', title: 'A', createdAt: 300 })
  store.add({ id: 'b', kind: 'done', agentId: 'c', title: 'B', createdAt: 200 })
  assert.deepEqual(
    store.snapshot().items.map((item) => item.id),
    ['a', 'b', 'c'],
  )

  const ties = new NoticeStore({ now: () => 1_000 })
  ties.add({ id: 'first', kind: 'done', agentId: 'a', title: '1', createdAt: 500 })
  ties.add({ id: 'second', kind: 'done', agentId: 'b', title: '2', createdAt: 500 })
  assert.deepEqual(
    ties.snapshot().items.map((item) => item.id),
    ['second', 'first'],
  )
})

test('snapshot counts exclude expired notices without pruning them', () => {
  const clock = makeClock(100)
  const store = new NoticeStore({ now: clock.now })
  store.add({ id: 'live', kind: 'done', agentId: 'a', title: '常驻', createdAt: 10 })
  store.add({
    id: 'timed',
    kind: 'attention',
    agentId: 'b',
    title: '稍后过期',
    createdAt: 20,
    expiresAt: 2_000,
  })
  store.add({
    id: 'stale',
    kind: 'failure',
    agentId: 'c',
    title: '已过期',
    createdAt: 30,
    expiresAt: 500,
  })

  clock.set(1_000) // `stale` is now past its expiresAt
  const snapshot = store.snapshot()
  assert.deepEqual(snapshot.counts, { failure: 0, attention: 1, done: 1 })
  assert.equal(snapshot.total, 2)
  assert.deepEqual(
    snapshot.items.map((item) => item.id),
    ['timed', 'live'],
  )
  assert.equal(store.size(), 2)

  // Still pruneable: expired records are retained until prune() runs.
  assert.equal(store.prune(), 1)
  assert.equal(store.prune(), 0)
})

test('removeByItem removes known ids and ignores unknown or hostile ids', () => {
  const store = new NoticeStore({ now: () => 1_000 })
  store.add({ id: 'one', kind: 'done', agentId: 'a', title: '一', createdAt: 10 })

  let calls = 0
  store.onChange(() => {
    calls += 1
  })

  assert.equal(store.removeByItem('one'), true)
  assert.equal(store.size(), 0)
  assert.equal(calls, 1)

  assert.equal(store.removeByItem('one'), false)
  assert.equal(store.removeByItem('missing'), false)
  assert.equal(store.removeByItem(42), false)
  assert.equal(store.removeByItem(null), false)
  assert.equal(store.removeByItem('   '), false)
  assert.equal(calls, 1)
})

test('removeByAgent removes every kind, or only the requested kind', () => {
  const store = new NoticeStore({ now: () => 1_000 })
  store.add({ id: 'f:a', kind: 'failure', agentId: 'a', title: '失败', createdAt: 10 })
  store.add({ id: 'n:a', kind: 'attention', agentId: 'a', title: '待确认', createdAt: 20 })
  store.add({ id: 'd:a', kind: 'done', agentId: 'a', title: '完成', createdAt: 30 })
  store.add({ id: 'f:b', kind: 'failure', agentId: 'b', title: '别人的', createdAt: 40 })

  assert.equal(store.removeByAgent('a', 'done'), 1)
  assert.equal(store.size(), 3)
  assert.equal(store.snapshot().counts.done, 0)

  assert.equal(store.removeByAgent('a'), 2)
  assert.equal(store.size(), 1)
  assert.equal(store.snapshot().items[0].agentId, 'b')
})

test('removeByAgent ignores hostile agents and unknown kinds', () => {
  const store = new NoticeStore({ now: () => 1_000 })
  store.add({ id: 'f:a', kind: 'failure', agentId: 'a', title: '失败', createdAt: 10 })

  assert.equal(store.removeByAgent(undefined), 0)
  assert.equal(store.removeByAgent(42), 0)
  assert.equal(store.removeByAgent(''), 0)
  assert.equal(store.removeByAgent('   '), 0)
  assert.equal(store.removeByAgent('a', 'bogus'), 0)
  assert.equal(store.removeByAgent('a', 42), 0)
  assert.equal(store.size(), 1)
})

test('clear(kind) removes one kind; clear("all") and clear() remove everything', () => {
  const store = new NoticeStore({ now: () => 1_000 })
  const seed = () => {
    store.add({ id: 'f', kind: 'failure', agentId: 'a', title: '失败', createdAt: 10 })
    store.add({ id: 'n', kind: 'attention', agentId: 'a', title: '待确认', createdAt: 20 })
    store.add({ id: 'd', kind: 'done', agentId: 'a', title: '完成', createdAt: 30 })
  }

  seed()
  assert.equal(store.clear('done'), 1)
  assert.deepEqual(store.snapshot().counts, { failure: 1, attention: 1, done: 0 })

  assert.equal(store.clear('all'), 2)
  assert.equal(store.size(), 0)

  seed()
  assert.equal(store.clear(), 3)
  assert.equal(store.size(), 0)

  assert.equal(store.clear('bogus'), 0)
  assert.equal(store.clear('all'), 0)
})

test('prune removes only expired notices and respects the injected clock', () => {
  const clock = makeClock(100)
  const store = new NoticeStore({ now: clock.now })
  store.add({ id: 'forever', kind: 'done', agentId: 'a', title: '常驻', createdAt: 10 })
  store.add({
    id: 'soon',
    kind: 'attention',
    agentId: 'b',
    title: '稍后',
    createdAt: 20,
    expiresAt: 2_000,
  })
  store.add({
    id: 'gone',
    kind: 'failure',
    agentId: 'c',
    title: '过期',
    createdAt: 30,
    expiresAt: 500,
  })

  clock.set(1_000) // `gone` is now past its expiresAt
  assert.equal(store.prune(), 1)
  assert.equal(store.size(), 2)
  assert.equal(store.prune(1_500), 0)
  assert.equal(store.prune(2_500), 1)
  assert.equal(store.size(), 1)
  assert.equal(store.snapshot().items[0].id, 'forever')
})

test('per-kind cap defaults to 50 and evicts the oldest notice', () => {
  const store = new NoticeStore({ now: () => 100_000 })
  for (let index = 0; index < 55; index += 1) {
    store.add({
      id: `failure-${index}`,
      kind: 'failure',
      agentId: `agent-${index}`,
      title: `失败 ${index}`,
      createdAt: index * 1_000,
    })
  }

  const snapshot = store.snapshot()
  assert.equal(snapshot.counts.failure, 50)
  assert.equal(snapshot.total, 50)
  assert.equal(snapshot.items[0].id, 'failure-54')
  assert.equal(snapshot.items.at(-1).id, 'failure-5')
})

test('per-kind cap is configurable and Infinity disables it', () => {
  const tight = new NoticeStore({ now: () => 1_000, maxItemsPerKind: 2 })
  for (let index = 0; index < 4; index += 1) {
    tight.add({
      id: `done-${index}`,
      kind: 'done',
      agentId: `agent-${index}`,
      title: `完成 ${index}`,
      createdAt: index,
    })
  }
  assert.deepEqual(
    tight.snapshot().items.map((item) => item.id),
    ['done-3', 'done-2'],
  )

  const unbounded = new NoticeStore({ now: () => 1_000, maxItemsPerKind: Infinity })
  for (let index = 0; index < 55; index += 1) {
    unbounded.add({
      id: `done-${index}`,
      kind: 'done',
      agentId: `agent-${index}`,
      title: `完成 ${index}`,
      createdAt: index,
    })
  }
  assert.equal(unbounded.size(), 55)
})

test('total cap evicts expired notices before live ones', () => {
  const clock = makeClock(100)
  const store = new NoticeStore({ now: clock.now, maxItemsPerKind: 50, maxItems: 2 })
  store.add({ id: 'f', kind: 'failure', agentId: 'a', title: '失败', createdAt: 10, expiresAt: 500 })
  store.add({ id: 'n', kind: 'attention', agentId: 'b', title: '待确认', createdAt: 20 })
  assert.equal(store.size(), 2)

  clock.set(1_000) // `f` is now expired; it is the cheapest thing to evict
  store.add({ id: 'd', kind: 'done', agentId: 'c', title: '完成', createdAt: 30 })

  assert.deepEqual(
    store.snapshot().items.map((item) => item.id),
    ['d', 'n'],
  )
  assert.equal(store.snapshot().counts.failure, 0)
  assert.equal(store.prune(), 0) // the expired failure was already evicted
})

test('total cap prefers oldest done, then attention, then failure', () => {
  const store = new NoticeStore({ now: () => 1_000, maxItems: 3 })
  store.add({ id: 'f', kind: 'failure', agentId: 'a', title: '失败', createdAt: 10 })
  store.add({ id: 'n', kind: 'attention', agentId: 'b', title: '待确认', createdAt: 20 })
  store.add({ id: 'd1', kind: 'done', agentId: 'c', title: '完成 1', createdAt: 30 })
  store.add({ id: 'd2', kind: 'done', agentId: 'd', title: '完成 2', createdAt: 40 })

  assert.deepEqual(
    store.snapshot().items.map((item) => item.id),
    ['d2', 'n', 'f'],
  )

  store.add({ id: 'd3', kind: 'done', agentId: 'e', title: '完成 3', createdAt: 50 })
  assert.deepEqual(
    store.snapshot().items.map((item) => item.id),
    ['d3', 'n', 'f'],
  )

  // Only expiring everything else can take down the failure.
  store.add({ id: 'n2', kind: 'attention', agentId: 'f', title: '再等等', createdAt: 60 })
  assert.deepEqual(
    store.snapshot().items.map((item) => item.id),
    ['n2', 'n', 'f'],
  )
})

test('a burst of done never evicts a failure', () => {
  const store = new NoticeStore({ now: () => 1_000, maxItems: 4 })
  store.add({ id: 'failure', kind: 'failure', agentId: 'a', title: '失败', createdAt: 1 })
  for (let index = 0; index < 10; index += 1) {
    store.add({
      id: `done-${index}`,
      kind: 'done',
      agentId: `agent-${index}`,
      title: `完成 ${index}`,
      createdAt: 2 + index,
    })
  }

  const snapshot = store.snapshot()
  assert.equal(snapshot.total, 4)
  assert.equal(snapshot.counts.failure, 1)
  assert.deepEqual(
    snapshot.items.map((item) => item.id),
    ['done-9', 'done-8', 'done-7', 'failure'],
  )
})

test('the default total cap bounds the store at 64', () => {
  const store = new NoticeStore({ now: () => 1_000 })
  for (let index = 0; index < 30; index += 1) {
    store.add({
      id: `f-${index}`,
      kind: 'failure',
      agentId: `fa-${index}`,
      title: `失败 ${index}`,
      createdAt: index,
    })
    store.add({
      id: `n-${index}`,
      kind: 'attention',
      agentId: `na-${index}`,
      title: `待确认 ${index}`,
      createdAt: 100 + index,
    })
    store.add({
      id: `d-${index}`,
      kind: 'done',
      agentId: `da-${index}`,
      title: `完成 ${index}`,
      createdAt: 200 + index,
    })
  }

  const snapshot = store.snapshot()
  assert.equal(snapshot.total, 64)
  assert.deepEqual(snapshot.counts, { failure: 30, attention: 30, done: 4 })
  const doneTimes = snapshot.items
    .filter((item) => item.kind === 'done')
    .map((item) => item.createdAt)
    .sort((a, b) => a - b)
  assert.deepEqual(doneTimes, [226, 227, 228, 229])
})

test('onChange fires exactly once per real mutation', () => {
  const store = new NoticeStore({ now: () => 1_000 })
  let calls = 0
  store.onChange(() => {
    calls += 1
  })

  store.add({ id: 'f', kind: 'failure', agentId: 'a', title: '失败', createdAt: 10 })
  assert.equal(calls, 1)

  store.add({ id: 'd', kind: 'done', agentId: 'b', title: '完成', createdAt: 20 })
  assert.equal(calls, 2)

  store.removeByItem('d')
  assert.equal(calls, 3)

  store.removeByAgent('a')
  assert.equal(calls, 4)

  store.add({ id: 'n', kind: 'attention', agentId: 'c', title: '待确认', createdAt: 30 })
  store.clear('attention')
  assert.equal(calls, 6)

  store.add({ id: 'e', kind: 'done', agentId: 'd', title: '完成', createdAt: 40, expiresAt: 2_000 })
  store.prune(5_000)
  assert.equal(calls, 8)
})

test('onChange does not fire for no-op mutations', () => {
  const store = new NoticeStore({ now: () => 1_000 })
  const notice = { id: 'f', kind: 'failure', agentId: 'a', title: '失败', createdAt: 10 }
  store.add(notice)

  let calls = 0
  store.onChange(() => {
    calls += 1
  })

  store.add({ ...notice })
  store.removeByItem('missing')
  store.removeByAgent('nobody')
  store.removeByAgent('a', 'bogus')
  store.clear('done')
  store.clear('bogus')
  store.prune()
  store.prune(5_000)
  store.add(null)
  store.add({ id: 'bad', kind: 'nope', title: 'x' })

  assert.equal(calls, 0)
  assert.equal(store.size(), 1)
})

test('onChange unsubscribe stops delivery and a throwing listener is isolated', () => {
  const store = new NoticeStore({ now: () => 1_000 })
  const seen = []
  const unsubscribe = store.onChange(() => {
    throw new Error('listener boom')
  })
  store.onChange(() => seen.push('second'))

  assert.doesNotThrow(() => {
    store.add({ id: 'f', kind: 'failure', agentId: 'a', title: '失败', createdAt: 10 })
  })
  assert.deepEqual(seen, ['second'])

  unsubscribe()
  unsubscribe()
  store.add({ id: 'd', kind: 'done', agentId: 'b', title: '完成', createdAt: 20 })
  assert.deepEqual(seen, ['second', 'second'])

  assert.doesNotThrow(() => {
    const invalid = store.onChange('not a function')
    invalid()
  })
})

test('add rejects hostile records without throwing or mutating the store', () => {
  const store = new NoticeStore({ now: () => 1_000 })
  const hostile = [
    null,
    undefined,
    0,
    42,
    'string',
    [],
    {},
    { id: 42, kind: 'done', title: '标题' },
    { id: '', kind: 'done', title: '标题' },
    { id: '   ', kind: 'done', title: '标题' },
    { id: 'x', kind: 'bogus', title: '标题' },
    { id: 'x', title: '标题' },
    { id: 'x', kind: 'done' },
    { id: 'x', kind: 'done', title: '' },
    { id: 'x', kind: 'done', title: '   ' },
    { id: 'x', kind: 'done', title: 42 },
    { id: 'x', kind: 'done', title: null },
  ]

  for (const record of hostile) {
    let result
    assert.doesNotThrow(() => {
      result = store.add(record)
    })
    assert.equal(result.added, false)
    assert.equal(result.item, null)
  }

  assert.equal(store.size(), 0)
})

test('add coerces usable-but-sloppy records deterministically', () => {
  const clock = makeClock(7_000)
  const store = new NoticeStore({ now: clock.now })

  const noTimestamp = store.add({ id: ' a ', kind: 'done', agentId: 42, title: '  完成\n' })
  assert.equal(noTimestamp.added, true)
  assert.equal(noTimestamp.item.id, 'a')
  assert.equal(noTimestamp.item.agentId, 'unknown')
  assert.equal(noTimestamp.item.title, '完成')
  assert.equal(noTimestamp.item.createdAt, 7_000)

  const nanTimestamp = store.add({
    id: 'b',
    kind: 'failure',
    agentId: 'agent',
    title: '失败',
    createdAt: Number.NaN,
    detail: { toString: () => 'nope' },
    expiresAt: Number.POSITIVE_INFINITY,
  })
  assert.equal(nanTimestamp.added, true)
  assert.equal(nanTimestamp.item.createdAt, 7_000)
  assert.equal('detail' in nanTimestamp.item, false)
  assert.equal('expiresAt' in nanTimestamp.item, false)

  const longId = store.add({
    id: 'x'.repeat(600),
    kind: 'attention',
    agentId: 'a',
    title: '长',
    createdAt: 5,
  })
  assert.equal(longId.item.id.length, 512)
})

test('add contains hostile getters', () => {
  const store = new NoticeStore({ now: () => 1_000 })

  const idBomb = {
    kind: 'done',
    agentId: 'a',
    title: '标题',
    get id() {
      throw new Error('boom')
    },
  }
  const titleBomb = {
    id: 'x',
    kind: 'done',
    agentId: 'a',
    get title() {
      throw new Error('boom')
    },
  }
  const proxy = new Proxy(
    {},
    {
      get() {
        throw new Error('trap')
      },
      ownKeys() {
        throw new Error('keys')
      },
    },
  )

  for (const record of [idBomb, titleBomb, proxy]) {
    let result
    assert.doesNotThrow(() => {
      result = store.add(record)
    })
    assert.equal(result.added, false)
  }
  assert.equal(store.size(), 0)

  assert.doesNotThrow(() => store.snapshot())
  assert.doesNotThrow(() => store.prune())
})

test('hostile clocks and now arguments degrade safely', () => {
  const throwing = new NoticeStore({
    now: () => {
      throw new Error('clock boom')
    },
  })
  assert.doesNotThrow(() => {
    const result = throwing.add({ id: 'x', kind: 'done', agentId: 'a', title: '完成' })
    assert.equal(result.added, true)
    assert.equal(result.item.createdAt, 0)
  })
  assert.doesNotThrow(() => throwing.snapshot())
  assert.doesNotThrow(() => throwing.prune())
  assert.equal(throwing.size(), 1)

  const stringy = new NoticeStore({ now: () => 'not a number' })
  assert.doesNotThrow(() => {
    stringy.add({ id: 'x', kind: 'done', agentId: 'a', title: '完成' })
  })
  assert.equal(stringy.snapshot().total, 1)

  const store = new NoticeStore({ now: () => 1_000 })
  store.add({ id: 'y', kind: 'done', agentId: 'a', title: '完成', createdAt: 1 })
  for (const badNow of ['nope', Number.NaN, Number.POSITIVE_INFINITY, {}, [], () => 1, null]) {
    assert.doesNotThrow(() => store.snapshot(badNow))
    assert.doesNotThrow(() => store.prune(badNow))
    assert.equal(store.snapshot(badNow).total, 1)
  }
})

test('constructor tolerates hostile options', () => {
  assert.doesNotThrow(() => new NoticeStore())
  assert.doesNotThrow(() => new NoticeStore(null))
  assert.doesNotThrow(() => new NoticeStore('nope'))

  const store = new NoticeStore({ now: 42, maxItemsPerKind: 'nope', maxItems: -3 })
  for (let index = 0; index < 55; index += 1) {
    store.add({
      id: `f-${index}`,
      kind: 'failure',
      agentId: `a-${index}`,
      title: `失败 ${index}`,
      createdAt: index,
    })
  }
  // Defaults survive: 50 per kind, total cap 64.
  assert.equal(store.snapshot().counts.failure, 50)
})

test('snapshot and add results are defensive copies', () => {
  const store = new NoticeStore({ now: () => 1_000 })
  const added = store.add({ id: 'x', kind: 'done', agentId: 'a', title: '完成', createdAt: 10 })
  added.item.title = '被篡改'
  assert.equal(store.snapshot().items[0].title, '完成')

  const snapshot = store.snapshot()
  snapshot.items[0].title = '又被篡改'
  snapshot.counts.done = 99
  assert.equal(store.snapshot().items[0].title, '完成')
  assert.equal(store.snapshot().counts.done, 1)
  assert.equal(store.snapshot().total, 1)
})

test('notices that are already expired at add time are rejected', () => {
  const store = new NoticeStore({ now: () => 1_000 })
  assert.equal(
    store.add({ id: 'a', kind: 'done', agentId: 'a', title: '完成', expiresAt: 1_000 }).added,
    false,
  )
  assert.equal(
    store.add({ id: 'b', kind: 'done', agentId: 'b', title: '完成', expiresAt: 999 }).added,
    false,
  )
  assert.equal(
    store.add({ id: 'c', kind: 'done', agentId: 'c', title: '完成', expiresAt: 1_001 }).added,
    true,
  )
  assert.equal(store.size(), 1)
})
