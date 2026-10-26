import assert from 'node:assert/strict'
import { test } from 'node:test'

import { approvalTitle, describeError, oneLine, questionTitle, shortAgentId } from '../lib/bind.js'
import { DEFAULT_CONFIG, resolveConfig } from '../lib/config.js'
import { createRateLimiter, playNoticeSound } from '../lib/sound.js'

test('resolveConfig applies defaults for an empty patch', () => {
  assert.deepEqual(resolveConfig(undefined), DEFAULT_CONFIG)
  assert.deepEqual(resolveConfig({}), DEFAULT_CONFIG)
  assert.deepEqual(resolveConfig(null), DEFAULT_CONFIG)
})

test('resolveConfig coerces hostile values instead of throwing', () => {
  const cfg = resolveConfig({
    failed: 'yes',
    attention: 0,
    done: null,
    sound: true,
    soundName: '  Basso  ',
    port: '99999',
    bundleIdentifier: 'bad id!',
    appName: 'x'.repeat(200),
    retentionMs: -5,
    doneRetentionMs: 1,
    minimumGapMs: 'abc',
  })
  assert.equal(cfg.failed, DEFAULT_CONFIG.failed)
  assert.equal(cfg.attention, DEFAULT_CONFIG.attention)
  assert.equal(cfg.done, DEFAULT_CONFIG.done)
  assert.equal(cfg.sound, true)
  assert.equal(cfg.soundName, 'Basso')
  assert.equal(cfg.port, 65535)
  assert.equal(cfg.bundleIdentifier, DEFAULT_CONFIG.bundleIdentifier)
  assert.equal(cfg.appName.length, 64)
  assert.equal(cfg.retentionMs, 60_000)
  assert.equal(cfg.doneRetentionMs, 5_000)
  assert.equal(cfg.minimumGapMs, DEFAULT_CONFIG.minimumGapMs)
})

test('resolveConfig keeps valid overrides', () => {
  const cfg = resolveConfig({ port: 9021, failed: false, soundName: 'Ping', minimumGapMs: 0 })
  assert.equal(cfg.port, 9021)
  assert.equal(cfg.failed, false)
  assert.equal(cfg.soundName, 'Ping')
  assert.equal(cfg.minimumGapMs, 0)
})

test('oneLine collapses whitespace and clamps length', () => {
  assert.equal(oneLine('  a \n b\t c  '), 'a b c')
  assert.equal(oneLine(undefined), '')
  assert.equal(oneLine(12), '12')
  assert.equal(oneLine('abcdef', 4), 'abc…')
  assert.equal(oneLine('x'.repeat(500)).length, 120)
})

test('shortAgentId keeps a recognisable tail', () => {
  assert.equal(shortAgentId('abcdef'), 'abcdef')
  assert.equal(shortAgentId('01JABCDEFGHIJKLMNOP'), 'KLMNOP')
  assert.equal(shortAgentId(undefined), 'unknown')
  assert.equal(shortAgentId(''), 'unknown')
})

test('describeError prefers human messages and survives odd payloads', () => {
  assert.equal(describeError(new Error('boom')), 'boom')
  assert.equal(describeError({ message: 'bad thing', code: 1 }), 'bad thing')
  assert.equal(describeError('plain'), 'plain')
  assert.equal(describeError({ code: 42 }), '{"code":42}')
  const circular = {}
  circular.self = circular
  assert.equal(describeError(circular), '[object Object]')
  assert.equal(describeError(undefined), '')
})

test('approval and question titles stay short', () => {
  assert.equal(approvalTitle({ toolName: 'bash' }), '等待批准：bash')
  assert.equal(approvalTitle({}), '等待批准')
  assert.equal(questionTitle({ questions: [{ question: '继续吗？' }] }), '等待回答：继续吗？')
  assert.equal(questionTitle({ questions: ['选哪个'] }), '等待回答：选哪个')
  assert.equal(questionTitle({}), '等待回答')
})

test('rate limiter allows gaps and can reset', () => {
  let clock = 0
  const limiter = createRateLimiter({ minGapMs: 1000, now: () => clock })
  assert.equal(limiter.allowed(), true)
  assert.equal(limiter.allowed(), false)
  clock = 999
  assert.equal(limiter.allowed(), false)
  clock = 1000
  assert.equal(limiter.allowed(), true)
  limiter.reset()
  assert.equal(limiter.allowed(), true)
})

test('playNoticeSound is a no-op off macOS and shells out on macOS', () => {
  const calls = []
  const spawn = (command, args, options) => {
    calls.push({ command, args, options })
    return { unref() {}, on() {} }
  }
  assert.equal(playNoticeSound({ platform: 'linux', spawn }), false)
  assert.equal(calls.length, 0)
  assert.equal(
    playNoticeSound({ platform: 'darwin', spawn, soundName: 'Glass' }),
    true,
  )
  assert.deepEqual(calls[0].args, ['/System/Library/Sounds/Glass.aiff'])
  assert.equal(calls[0].options.detached, true)
})

test('playNoticeSound swallows spawn failures', () => {
  const spawn = () => {
    throw new Error('nope')
  }
  assert.equal(playNoticeSound({ platform: 'darwin', spawn }), false)
})
