#!/usr/bin/env node
/**
 * Live smoke test against the Atoll app on this Mac.
 *
 * Presents the three mirrored states in order (red -> yellow -> green), then
 * dismisses them, printing the RPC state after every step. Requires Atoll to be
 * running with third-party extensions enabled.
 *
 * Usage: node scripts/smoke.mjs [--hold] [--port 9020]
 *   --hold  keep each state on screen for 3s instead of 0.8s
 */
import { AtollClient } from '../lib/atoll.js'
import { buildStatusDescriptor } from '../lib/format.js'

const args = process.argv.slice(2)
const hold = args.includes('--hold')
const portFlag = args.indexOf('--port')
const port = portFlag === -1 ? 9020 : Number(args[portFlag + 1])
const bundleIdentifier = 'dev.dsh.atoll-notice'
const stepMs = hold ? 3000 : 800

const logger = {
  info: (message) => console.log(`[smoke] ${message}`),
  warn: (message) => console.warn(`[smoke] ${message}`),
  debug: () => {},
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const client = new AtollClient({
  url: `ws://127.0.0.1:${port}`,
  bundleIdentifier,
  appName: 'DeepSeek Harness',
  logger,
})

const waitFor = async (predicate, timeoutMs = 4000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(50)
  }
  return predicate()
}

const describe = (label) => {
  const state = client.state()
  console.log(
    `[smoke] ${label}: connected=${state.connected} authorized=${state.authorized} activity=${state.activityId ?? '-'} error=${state.lastError ?? '-'}`,
  )
}

const sample = (counts, title) =>
  buildStatusDescriptor({ counts, items: [], activityId: 'dsh-status', bundleIdentifier, title })

let exitCode = 0
try {
  client.start()
  if (!(await waitFor(() => client.state().connected))) {
    console.error('[smoke] could not reach Atoll on ws://127.0.0.1:' + port)
    exitCode = 2
  } else {
    describe('connected')
    client.show(sample({ failure: 2, attention: 0, done: 0 }, 'DSH 任务'))
    await sleep(stepMs)
    describe('red')
    client.show(sample({ failure: 2, attention: 1, done: 0 }, 'DSH 任务'))
    await sleep(stepMs)
    describe('yellow')
    client.show(sample({ failure: 0, attention: 0, done: 3 }, 'DSH 任务'))
    await sleep(stepMs)
    describe('green')
    client.show(null)
    await sleep(600)
    describe('dismissed')
    if (client.state().lastError) exitCode = 1
  }
} catch (error) {
  console.error(`[smoke] unexpected failure: ${String(error)}`)
  exitCode = 1
} finally {
  await client.stop()
}
process.exit(exitCode)
