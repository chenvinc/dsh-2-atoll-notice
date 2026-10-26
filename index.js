/**
 * dsh-2-atoll-notice - mirror DeepSeek Harness task states into the Atoll
 * Dynamic Island on macOS.
 *
 * Three states share one compact island line: red for a failed task, yellow for
 * a task that waits for the human, green for a finished one. Atoll is only a
 * display surface - the Host stays authoritative, and every notice here is
 * derived from live session events.
 *
 * Nothing in this plugin may break a session: Atoll absence, a hostile
 * settings request, or a broken payload all degrade to a quiet no-op.
 */
import { appendFileSync } from 'node:fs'

import z from '@deepseek-ai/schemastery'

import { AtollClient } from './lib/atoll.js'
import { approvalTitle, describeError, questionTitle, shortAgentId } from './lib/bind.js'
import { resolveConfig } from './lib/config.js'
import { buildStatusDescriptor } from './lib/format.js'
import { API_PREFIX, createRoutes } from './lib/http.js'
import { mergeSettings, pickSettingsPatch, readSettingsFile, resolveSettingsPath, writeSettingsFile } from './lib/settings-store.js'
import { createRateLimiter, playNoticeSound } from './lib/sound.js'
import { NoticeStore } from './lib/state.js'
import { registerAtollNoticeTools } from './lib/tools.js'

/**
 * Filesystem breadcrumb trail. The Host keeps its own log in the launching
 * terminal, which the GUI user cannot easily hand back, so module load and
 * apply() leave a few lines under ~/.dsh.
 */
const TRACE_FILE = process.env.DSH_ATOLL_NOTICE_TRACE ?? `${process.env.HOME ?? '/tmp'}/.dsh/atoll-notice-trace.log`
function trace(stage, detail) {
  try {
    const suffix = detail === undefined ? '' : ` ${JSON.stringify(detail)}`
    appendFileSync(TRACE_FILE, `${new Date().toISOString()} ${stage}${suffix}\n`)
  } catch {
    // Diagnostics must never break the plugin.
  }
}
trace('module-loaded', { pid: process.pid })

/** Stable id of the Atoll live activity that carries the status line. */
export const ACTIVITY_ID = 'dsh-status'

/** Human-facing plugin name. */
export const name = 'atoll-notice'

/** No services are required: every source event is best effort. */
export const inject = []

/** Validated settings surface; every field also has a defensive fallback. */
export const Config = z.object({
  failed: z.boolean().default(true).description('Show a red notice when a task fails.'),
  attention: z.boolean().default(true).description('Show a yellow notice while a task waits for you.'),
  done: z.boolean().default(true).description('Show a green notice when a task finishes.'),
  sound: z.boolean().default(false).description('Play a macOS alert sound for new notices.'),
  soundName: z.string().default('Glass').description('Alert sound name in /System/Library/Sounds.'),
  port: z.number().min(1).max(65535).default(9020).description('Atoll RPC port on localhost.'),
  bundleIdentifier: z
    .string()
    .default('dev.dsh.atoll-notice')
    .description('App id Atoll uses to attribute the notice.'),
  appName: z.string().default('DeepSeek Harness').description('Name Atoll shows when it asks for access.'),
  retentionMs: z.number().min(60_000).default(15 * 60 * 1000).description('How long a failure stays.'),
  doneRetentionMs: z.number().min(5_000).default(2 * 60 * 1000).description('How long a finished notice stays.'),
  minimumGapMs: z.number().min(0).default(1500).description('Minimum gap between alert sounds.'),
})

/**
 * Mount the plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Partial<import('./lib/config.js').AtollNoticeConfig>} [config]
 */
/**
 * The Host exposes its own profile through the `profileContext` service; the
 * plugin process environment does not carry it. Reading it keeps per-profile
 * settings in the profile that actually runs the plugin.
 *
 * @param {any} ctx
 * @returns {string|undefined}
 */
function profileContextDir(ctx) {
  try {
    const profile = ctx.get('profileContext')
    return typeof profile?.dir === 'string' && profile.dir.length > 0 ? profile.dir : undefined
  } catch {
    return undefined
  }
}

export function apply(ctx, config) {
  const probe = (key) => {
    try {
      return Boolean(typeof ctx.get === 'function' ? ctx.get(key) : undefined)
    } catch (error) {
      return `error:${String(error)}`
    }
  }
  trace('apply-enter', {
    webServer: probe('webServer'),
    tools: probe('tools'),
    clientModules: probe('clientModules'),
    profile: probe('profileContext'),
  })

  const base = resolveConfig(config)
  const logger = makeLogger(ctx)
  const store = new NoticeStore()
  const profileDir = profileContextDir(ctx)
  const settingsPath = resolveSettingsPath(process.env, undefined, profileDir)

  /** @type {Record<string, unknown>} user layer persisted in the profile. */
  let userLayer = {}
  /** @type {import('./lib/config.js').AtollNoticeConfig} */
  let runtime = base
  let limiter = createRateLimiter({ minGapMs: runtime.minimumGapMs })

  /** @type {import('./lib/atoll.js').AtollClient | undefined} */
  let client
  let clientKey = ''
  let lastDescriptor = null
  let disposed = false

  const mirrorState = () =>
    client?.state() ?? { connected: false, authorized: false, activityId: undefined, lastError: 'starting' }

  /** The public, GUI-editable view of the effective settings. */
  const publicSettings = () => ({
    failed: runtime.failed,
    attention: runtime.attention,
    done: runtime.done,
    sound: runtime.sound,
    soundName: runtime.soundName,
    port: runtime.port,
    bundleIdentifier: runtime.bundleIdentifier,
  })

  /** Push the aggregate status into Atoll; one descriptor carries three states. */
  const render = () => {
    const snapshot = store.snapshot()
    if (!client) return snapshot
    if (snapshot.total === 0) {
      lastDescriptor = null
      client.show(null)
      return snapshot
    }
    lastDescriptor = buildStatusDescriptor({
      counts: snapshot.counts,
      items: snapshot.items,
      activityId: ACTIVITY_ID,
      bundleIdentifier: runtime.bundleIdentifier,
    })
    client.show(lastDescriptor)
    return snapshot
  }

  /** (Re)create the Atoll connection when its identity changes. */
  const reconcileClient = () => {
    const key = `${runtime.port}\u0000${runtime.bundleIdentifier}\u0000${runtime.appName}`
    if (client && key === clientKey) return
    if (client) void client.stop()
    clientKey = key
    client = new AtollClient({
      url: `ws://127.0.0.1:${runtime.port}`,
      bundleIdentifier: runtime.bundleIdentifier,
      staleActivityIds: [ACTIVITY_ID],
      appName: runtime.appName,
      logger,
    })
    client.start()
    lastDescriptor = null
    render()
  }

  /** Drop notices whose state the human just turned off. */
  const purgeDisabledKinds = () => {
    try {
      if (!runtime.failed) store.clear('failure')
      if (!runtime.attention) store.clear('attention')
      if (!runtime.done) store.clear('done')
    } catch (error) {
      logger.warn(`atoll-notice: purge failed: ${String(error)}`)
    }
  }

  /** Apply a validated partial update, persist it, and republish the mirror. */
  const updateSettings = async (patch) => {
    userLayer = mergeSettings(userLayer, pickSettingsPatch(patch))
    runtime = resolveConfig(mergeSettings(base, userLayer))
    limiter = createRateLimiter({ minGapMs: runtime.minimumGapMs })
    purgeDisabledKinds()
    reconcileClient()
    render()
    const persisted = await writeSettingsFile(settingsPath, userLayer)
    if (!persisted) logger.warn(`atoll-notice: could not persist settings to ${settingsPath}`)
    return publicSettings()
  }

  /** Play one rate-limited alert sound for a newly recorded notice. */
  const announce = () => {
    if (!runtime.sound) return
    if (!limiter.allowed()) return
    playNoticeSound({ soundName: runtime.soundName, logger })
  }

  /** Record one notice and mirror it, tolerating malformed payloads. */
  const record = (spec) => {
    try {
      const result = store.add(spec)
      if (result.added) announce()
      return result
    } catch (error) {
      logger.warn(`atoll-notice: could not record ${spec?.kind}: ${String(error)}`)
      return { added: false }
    }
  }

  /**
   * Wrap a waterfall answerer so the island shows "waiting for you" for exactly
   * as long as the request is pending, then removes that notice.
   * @param {(payload: any) => object | undefined} build
   */
  const pending = (build) => {
    return async (payload, next) => {
      if (typeof next !== 'function') return undefined
      let id
      try {
        const spec = runtime.attention ? build(payload) : undefined
        if (spec) {
          id = spec.id
          record(spec)
        }
      } catch (error) {
        logger.warn(`atoll-notice: pending notice failed: ${String(error)}`)
      }
      try {
        return await next()
      } finally {
        if (id) {
          try {
            store.removeByItem(id)
          } catch {
            /* ignore */
          }
        }
      }
    }
  }

  ctx.on('agent/error', (payload) => {
    if (!runtime.failed) return
    const agentId = shortAgentId(payload?.agent?.id)
    const turn = payload?.turn
    const now = Date.now()
    record({
      id: `failure:${agentId}:${turn ?? now}`,
      kind: 'failure',
      agentId,
      title: `任务失败 · ${agentId}`,
      detail: describeError(payload?.error),
      createdAt: now,
      expiresAt: now + runtime.retentionMs,
    })
  })

  ctx.on('agent/turn-stopping', (payload) => {
    const agentId = shortAgentId(payload?.agent?.id)
    try {
      store.removeByAgent(agentId, 'attention')
    } catch {
      /* ignore */
    }
    if (!runtime.done) return
    // An aborted turn is a human decision, not a finished task.
    if (payload?.signal?.aborted) return
    const turn = payload?.turn
    const failedHere = store
      .snapshot()
      .items.some((item) => item.kind === 'failure' && item.agentId === agentId && item.id.endsWith(`:${turn}`))
    if (failedHere) return
    const now = Date.now()
    record({
      id: `done:${agentId}:${turn ?? now}`,
      kind: 'done',
      agentId,
      title: `任务完成 · ${agentId}`,
      createdAt: now,
      expiresAt: now + runtime.doneRetentionMs,
    })
  })

  ctx.on(
    'approval/request',
    pending((request) => {
      const agentId = shortAgentId(request?.agent?.id)
      return {
        id: `attention:approval:${agentId}:${request?.callId ?? request?.id ?? Date.now()}`,
        kind: 'attention',
        agentId,
        title: approvalTitle(request),
        detail: typeof request?.reason === 'string' ? request.reason : undefined,
        createdAt: Date.now(),
      }
    }),
  )

  ctx.on(
    'user-questions/request',
    pending((request) => {
      const agentId = shortAgentId(request?.agent?.id)
      return {
        id: `attention:question:${agentId}:${request?.wait?.callId ?? Date.now()}`,
        kind: 'attention',
        agentId,
        title: questionTitle(request),
        createdAt: Date.now(),
      }
    }),
  )

  store.onChange(() => {
    render()
  })

  const disposers = []
  const push = (dispose) => {
    if (typeof dispose === 'function') disposers.push(dispose)
  }

  // The user layer wins over the bundle patch; a missing file is normal.
  void readSettingsFile(settingsPath)
    .then((stored) => {
      if (disposed || !stored) return
      userLayer = mergeSettings({}, stored)
      runtime = resolveConfig(mergeSettings(base, userLayer))
      limiter = createRateLimiter({ minGapMs: runtime.minimumGapMs })
      reconcileClient()
      render()
    })
    .catch((error) => logger.warn(`atoll-notice: settings load failed: ${String(error)}`))

  /**
   * Describe how the Host composed this plugin's two halves. The browser half is
   * discovered by the `clientModules` service; when it is missing from the table
   * the settings card cannot exist, so this is the first thing to check.
   */
  const readDiagnostics = () => {
    /** @type {Record<string, unknown>} */
    const out = { package: 'dsh-2-atoll-notice', clientEntry: './client.js' }
    let registry
    try {
      registry = typeof ctx.get === 'function' ? ctx.get('clientModules') : undefined
    } catch (error) {
      out.clientModulesError = String(error)
    }
    const table = registry?.table
    out.clientModules = table instanceof Map ? [...table.keys()] : null
    out.registryInfo = registry === undefined ? null : {
      kind: Object.prototype.toString.call(registry),
      keys: Object.keys(registry).slice(0, 24),
      tableKind: Object.prototype.toString.call(table),
      hasGraph: typeof registry.graph === 'function',
      hasClientPath: typeof registry.clientPath === 'function',
    }
    const sources = registry?.sources
    if (sources instanceof Map) {
      out.sources = [...sources.values()].map((source) => ({
        packageName: source?.packageName ?? null,
        loaderName: source?.loaderName ?? null,
        clientPath: source?.meta?.clientPath ?? null,
      }))
    }
    const meta = registry?.pkgMeta
    if (meta instanceof Map) {
      out.pkgMeta = Object.fromEntries(
        [...meta.entries()].map(([key, value]) => [key, value === undefined ? null : { clientPath: value.clientPath ?? null }]),
      )
    }
    try {
      const entries = typeof ctx.loader?.entries === 'function' ? [...ctx.loader.entries()] : []
      out.loaderEntries = entries
        .map((entry) => ({
          name: entry?.options?.name ?? null,
          baseUrl: entry?.parent?.tree?.ctx?.baseUrl ?? null,
        }))
        .filter((entry) => entry.name !== null)
    } catch (error) {
      out.loaderEntriesError = String(error)
    }
    return out
  }

  try {
    const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
    if (webServer && typeof webServer.register === 'function') {
      const routes = createRoutes({
        readSettings: publicSettings,
        writeSettings: updateSettings,
        readStatus: () => ({ ...mirrorState(), counts: store.snapshot().counts }),
        readDiagnostics,
        reportClient: (payload) => trace('client-report', payload),
        logger,
      })
      for (const route of routes) push(webServer.register(route))
      trace('routes-mounted', { count: routes.length })
      logger.debug?.(`atoll-notice: settings API mounted at ${API_PREFIX}`)
    }
  } catch (error) {
    trace('routes-failed', String(error))
    logger.warn(`atoll-notice: settings API unavailable: ${String(error)}`)
  }

  ctx.effect(() => {
    reconcileClient()
    const pruneTimer = setInterval(() => {
      try {
        store.prune()
      } catch (error) {
        logger.warn(`atoll-notice: prune failed: ${String(error)}`)
      }
    }, 20_000)
    if (pruneTimer && typeof pruneTimer.unref === 'function') pruneTimer.unref()
    let disposeTools = () => {}
    void registerAtollNoticeTools({
      ctx,
      store,
      mirror: {
        show: (descriptor) => client?.show(descriptor),
        flash: (descriptor, ms) => client?.flash(descriptor, ms),
        state: mirrorState,
      },
      runtime: () => runtime,
      logger,
      activityId: ACTIVITY_ID,
    })
      .then((dispose) => {
        disposeTools = typeof dispose === 'function' ? dispose : () => {}
      })
      // warn, not debug: a failed registration silently removes every agent tool.
      .catch((error) => {
        trace('tools-failed', String(error))
        logger.warn?.(`atoll-notice: tools unavailable: ${String(error)}`)
      })
    return () => {
      disposed = true
      clearInterval(pruneTimer)
      disposeTools()
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* teardown is best effort */
        }
      }
      void client?.stop()
    }
  })

  logger.debug?.(
    `atoll-notice: mirroring task states to ws://127.0.0.1:${runtime.port} (failed=${runtime.failed}, attention=${runtime.attention}, done=${runtime.done})`,
  )
}

/**
 * Resolve the Host logger for this plugin, falling back to the console.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
function makeLogger(ctx) {
  try {
    const scoped = typeof ctx?.logger === 'function' ? ctx.logger('atoll-notice') : undefined
    if (scoped && typeof scoped.warn === 'function') return scoped
  } catch {
    /* fall through */
  }
  return {
    info: (...args) => console.log('[atoll-notice]', ...args),
    warn: (...args) => console.warn('[atoll-notice]', ...args),
    debug: () => {},
  }
}
