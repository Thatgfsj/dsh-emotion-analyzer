/**
 * dsh-emotion-analyzer — Host entry（v0.2）。
 *
 * Flow (DSH 0.2.1-rc.2 calibrated):
 *   agent/turn-stopping { agent, turn, signal }   (serial)
 *     -> last assistant text
 *     -> EmotionModelService.score(text)           (active model, lazy ONNX)
 *     -> appendPluginRecord(plugin:emotion-analyzer/turn, v2 record)
 *     -> the `emotion` session projection folds the record with its profile
 *     -> wire view reaches the browser, which renders the floating widget.
 *
 * v0.2 (#39): 模型由 `src/models/*` 管理（registry / download / settings /
 * profiles），默认 horizon-small，未下载时回退 legacy assets；切换模型后
 * 下一轮生效；Host routes 挂在 `/api/emotion-analyzer/v1/*`。
 */
import { appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session'
import { EMOTION_RECORD_TYPE, registerEmotionProjection } from './projection.ts'
import { EmotionModelService } from './models/service.ts'
import { registerEmotionRoutes, type ConnectionLike } from './models/routes.ts'
import { detectDoubt, detectLanguage, extractLastAssistantText, hashText, truncateForScoring } from './text.ts'
import type { EmotionTurnRecord } from './types.ts'

/** Plugin name (also the profile row id). */
export const name = 'dsh-emotion-analyzer'

/** The projection registry must exist before apply runs. */
export const inject = ['sessionProjections']

/** Hard ceiling for one turn's scoring so a stuck runtime cannot block the turn boundary. */
const SCORE_TIMEOUT_MS = 1500

/** Minimal logger surface (Cordis provides `ctx.logger(name)`). */
interface HostLogger {
  debug?: (...args: unknown[]) => void
  info?: (...args: unknown[]) => void
  warn?: (...args: unknown[]) => void
  error?: (...args: unknown[]) => void
}

/** Structural slice of the Cordis context used by this plugin. */
interface HostContext {
  logger?: unknown
  effect?: (fn: () => (() => void) | void) => unknown
  on?: (event: string, listener: (payload: TurnStoppingPayload) => unknown) => unknown
  sessionProjections?: unknown
  /** Cordis 的惰性服务注入（可选服务用 inject 回调，不会阻塞插件加载）。 */
  inject?: (names: string[], callback: (ctx: HostContext) => void) => unknown
  connection?: ConnectionLike
}

interface TurnStoppingPayload {
  agent?: {
    session?: {
      id?: string
      deriveMessages?: () => readonly unknown[]
    }
  }
  turn?: number
}

/** Resolve a named logger without assuming it exists in every host build. */
function loggerOf(ctx: HostContext): HostLogger {
  try {
    const factory = ctx.logger as ((name: string) => HostLogger) | undefined
    if (typeof factory === 'function') return factory.call(ctx, name)
  } catch {
    // fall through to console
  }
  return console
}

/** Reject with a timeout so scoring can never hold the turn boundary forever. */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** One-instance lifecycle shared by every turn. */
interface Runtime {
  service: EmotionModelService
  chains: Map<string, Promise<void>>
}

/**
 * Plugin entry.
 * @param ctx - Cordis host context.
 */
export function apply(ctx: HostContext): void {
  const log = loggerOf(ctx)
  const service = new EmotionModelService({
    logger: log as Pick<Console, 'warn' | 'error'>,
  })
  const runtime: Runtime = { service, chains: new Map<string, Promise<void>>() }

  const registry = ctx.sessionProjections
  if (registry === undefined || registry === null) {
    log.warn?.('[emotion-analyzer] sessionProjections service missing; emotion state will not persist')
    return
  }
  registerEmotionProjection(
    registry as Parameters<typeof registerEmotionProjection>[0],
    pluginRecordOf as unknown as (event: unknown) => { type: string; data: unknown } | undefined,
  )

  // Model management API（鉴权由 Connection 的 exact route 栅栏负责）。
  // `connection` 是可选的 Web 服务：用 ctx.inject 惰性绑定，CLI/headless 下
  // 即使没有 Connection 也不影响 turn-stopping 打分。
  const registerRoutes = (connection: ConnectionLike): void => {
    try {
      registerEmotionRoutes(connection, service)
    } catch (error) {
      log.error?.('[emotion-analyzer] model routes registration failed:', error)
    }
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['connection'], (connectionCtx) => {
      if (connectionCtx.connection !== undefined) registerRoutes(connectionCtx.connection)
    })
  } else if (ctx.connection !== undefined && typeof ctx.connection.fetch?.register === 'function') {
    registerRoutes(ctx.connection)
  } else {
    log.debug?.('[emotion-analyzer] connection service missing; model API routes disabled')
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      void runtime.service.dispose()
      runtime.chains.clear()
    })
  }

  const handleTurn = async (payload: TurnStoppingPayload): Promise<void> => {
    const session = payload.agent?.session
    const turn = payload.turn
    if (session === undefined || typeof session.deriveMessages !== 'function' || typeof turn !== 'number') {
      return
    }

    const text = extractLastAssistantText(session.deriveMessages())
    if (text.length === 0) return

    const result = await withTimeout(
      runtime.service.score(truncateForScoring(text)),
      SCORE_TIMEOUT_MS,
      'emotion scoring',
    )
    if (result === undefined) {
      log.warn?.('[emotion-analyzer] empty score; turn left untouched')
      return
    }

    // 宿主文本启发式：中文疑问句模型常不响应，`doubt` 与模型标签一起进入映射。
    const doubt = detectDoubt(text)
    const raw: Record<string, number> = doubt > 0 ? { ...result.raw, doubt } : result.raw

    const record: EmotionTurnRecord = {
      version: 2,
      turn,
      raw,
      modelId: result.modelId,
      profileId: result.profileId,
      latencyMs: result.latencyMs,
      language: detectLanguage(text),
      textHash: hashText(text),
      chars: text.length,
      timestamp: Date.now(),
    }

    try {
      appendPluginRecord(
        session as Parameters<typeof appendPluginRecord>[0],
        EMOTION_RECORD_TYPE,
        record as unknown as Record<string, unknown>,
      )
    } catch (error) {
      log.error?.('[emotion-analyzer] append plugin record failed:', error)
      return
    }
    log.debug?.(`[emotion-analyzer] turn ${turn} scored by ${result.modelId} in ${result.latencyMs}ms`)
  }

  if (typeof ctx.on !== 'function') {
    log.warn?.('[emotion-analyzer] ctx.on missing; turn-stopping hook not installed')
    return
  }

  ctx.on('agent/turn-stopping', (payload: TurnStoppingPayload) => {
    const sessionId = payload.agent?.session?.id ?? 'unknown'
    const previous = runtime.chains.get(sessionId) ?? Promise.resolve()
    const next = previous
      .then(() => handleTurn(payload))
      .catch((error: unknown) => {
        log.error?.('[emotion-analyzer] turn hook failed:', error)
      })
      .finally(() => {
        if (runtime.chains.get(sessionId) === next) runtime.chains.delete(sessionId)
      })
    runtime.chains.set(sessionId, next)
    return next
  })
}
