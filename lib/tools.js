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

  const descriptors = [
    defineTool({
      name: 'atoll_notice_status',
      description:
        'Report the Atoll Dynamic Island mirror: connection state, per-state counts, and the pending notices.',
      parameters: {},
      output: { schema: TOOL_OUTPUT },
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
    }),
    defineTool({
      name: 'atoll_notice_test',
      description:
        'Temporarily show one sample state in the Atoll Dynamic Island (red failed, yellow needs you, green done) to verify the mirror, then restore the real status.',
      parameters: {
        kind: {
          type: 'string',
          required: false,
          description: 'failure, attention, or done; defaults to failure',
        },
      },
      output: { schema: TOOL_OUTPUT },
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
    }),
    defineTool({
      name: 'atoll_notice_clear',
      description: 'Clear mirrored notices in the Atoll Dynamic Island, for one state or all of them.',
      parameters: {
        kind: {
          type: 'string',
          required: false,
          description: 'failure, attention, done, or all; defaults to all',
        },
      },
      output: { schema: TOOL_OUTPUT },
      async execute(args) {
        const kind = args?.kind
        const removed = kind === undefined || kind === 'all' ? store.clear() : store.clear(kind)
        return { ok: true, removed, counts: store.snapshot().counts }
      },
    }),
  ]

  const disposers = []
  for (const definition of descriptors) {
    try {
      const dispose = tools.register(definition)
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (error) {
      logger?.warn?.(`atoll-notice: could not register ${definition?.name}: ${String(error)}`)
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
