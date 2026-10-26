/**
 * Optional agent tools for inspecting and driving the Atoll mirror.
 *
 * Everything here is best effort: when the deployment has no tool registry or
 * the tool package cannot be resolved, registration is skipped and the plugin
 * keeps mirroring task state.
 */

import { buildStatusDescriptor, headline } from './format.js'

const TOOL_OUTPUT = { type: 'json' }

const KINDS = ['failure', 'attention', 'done']

/**
 * Register the `atoll_notice_*` tools.
 * @param {object} options
 * @param {import('@deepseek-ai/cordis').Context} options.ctx
 * @param {import('./state.js').NoticeStore} options.store
 * @param {{ show: (d: unknown) => void, flash: (d: unknown, ms?: number) => void, state: () => Record<string, unknown> }} options.mirror
 * @param {() => import('./config.js').AtollNoticeConfig} options.runtime
 * @param {{ warn?: (m: string) => void, debug?: (m: string) => void }} options.logger
 * @param {string} options.activityId
 * @returns {Promise<() => void>} disposer (never throws)
 */
const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

const renderStatus = (_args, value) => {
  const lines = [String(value?.headline ?? '')]
  lines.push(
    `连接 ${value?.connected ? '正常' : '断开'} · 已授权 ${value?.authorized ? '是' : '否'} · ` +
      `失败 ${value?.counts?.failure ?? 0} / 待确认 ${value?.counts?.attention ?? 0} / 完成 ${value?.counts?.done ?? 0}`,
  )
  for (const item of value?.items ?? []) lines.push(`· [${item.kind}] ${item.title} (${item.agentId ?? 'unknown'})`)
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * Plain tool specifications, one entry per tool.
 *
 * Kept separate from registration so each spec can be validated on its own (see
 * tests/tool-schema.test.mjs) and so one malformed spec cannot take the whole
 * tool set down with it.
 *
 * @param {{
 *   store: import('./state.js').NoticeStore,
 *   mirror: { state: () => any, flash: (descriptor: any, ms: number) => void },
 *   activityId: string,
 *   runtime: () => { bundleIdentifier: string },
 * }} deps
 */
export function toolSpecs({ store, mirror, activityId, runtime }) {
  return [
    {
      name: 'atoll_notice_status',
      description:
        'Report the Atoll Dynamic Island mirror: connection state, per-state counts, and the pending notices.',
      parameters: {},
      output: { schema: TOOL_OUTPUT, render: renderStatus },
      async execute() {
        const snapshot = store.snapshot()
        const state = mirror.state() ?? {}
        return {
          connected: Boolean(state.connected),
          authorized: Boolean(state.authorized),
          lastError: state.lastError ?? null,
          counts: snapshot.counts,
          headline: headline(snapshot.counts),
          items: snapshot.items.map((item) => ({
            id: item.id,
            kind: item.kind,
            agentId: item.agentId,
            title: item.title,
            createdAt: item.createdAt,
          })),
        }
      },
    },
    {
      name: 'atoll_notice_test',
      description:
        'Temporarily show one sample state in the Atoll Dynamic Island (red failed, yellow needs you, green done) to verify the mirror, then restore the real status.',
      parameters: {
        kind: {
          type: 'string',
          description: 'failure, attention, or done; defaults to failure',
        },
      },
      output: { schema: TOOL_OUTPUT, render: renderJson },
      async execute(args) {
        const kind = KINDS.includes(args?.kind) ? args.kind : 'failure'
        const counts = { failure: 0, attention: 0, done: 0 }
        counts[kind] = 1
        mirror.flash(
          buildStatusDescriptor({
            counts,
            items: [],
            activityId,
            bundleIdentifier: runtime().bundleIdentifier,
            title: 'DSH 自检',
          }),
          8000,
        )
        return { ok: true, kind, connected: Boolean(mirror.state()?.connected) }
      },
    },
    {
      name: 'atoll_notice_clear',
      description: 'Clear mirrored notices in the Atoll Dynamic Island, for one state or all of them.',
      parameters: {
        kind: {
          type: 'string',
          description: 'failure, attention, done, or all; defaults to all',
        },
      },
      output: { schema: TOOL_OUTPUT, render: renderJson },
      async execute(args) {
        const kind = args?.kind
        const removed = kind === undefined || kind === 'all' ? store.clear() : store.clear(kind)
        return { ok: true, removed, counts: store.snapshot().counts }
      },
    },
  ]
}

export async function registerAtollNoticeTools({ ctx, store, mirror, runtime, logger, activityId }) {
  let tools
  try {
    tools = typeof ctx?.get === 'function' ? ctx.get('tools') : undefined
  } catch {
    tools = undefined
  }
  if (!tools || typeof tools.register !== 'function') return () => {}

  let defineTool
  try {
    ;({ defineTool } = await import('@deepseek-ai/dsh-tools'))
  } catch (error) {
    logger?.debug?.(`atoll-notice: tools disabled (${String(error)})`)
    return () => {}
  }

  const disposers = []
  for (const spec of toolSpecs({ store, mirror, activityId, runtime })) {
    try {
      const dispose = tools.register(defineTool(spec))
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (error) {
      // Never swallow this again: a rejected schema used to abort registration of
      // every tool without a single visible log line.
      logger?.error?.(`atoll-notice: could not register ${spec?.name}: ${String(error)}`)
    }
  }
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* teardown is best effort */
      }
    }
  }
}
