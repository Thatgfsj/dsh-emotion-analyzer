/**
 * dsh-emotion-analyzer — Host entry.
 *
 * Flow (DSH 0.2.1-rc.2 calibrated):
 *   agent/turn-stopping { agent, turn, signal }   (serial)
 *     -> last assistant text
 *     -> EmotionScorer.score(text)                 (local ONNX, guarded)
 *     -> appendPluginRecord(plugin:emotion-analyzer/turn)
 *     -> the `emotion` session projection folds the record (pure, sync)
 *     -> wire view reaches the browser, which renders the floating widget.
 */
import { appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session'
import { EmotionScorer } from './inference.ts'
import { EMOTION_RECORD_TYPE, registerEmotionProjection } from './projection.ts'
import { detectLanguage, extractLastAssistantText, hashText, truncateForScoring } from './text.ts'
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
  scorer: EmotionScorer
  init: Promise<boolean>
  chains: Map<string, Promise<void>>
}

/**
 * Plugin entry.
 * @param ctx - Cordis host context.
 */
export function apply(ctx: HostContext): void {
  const log = loggerOf(ctx)
  const scorer = new EmotionScorer()
  const runtime: Runtime = {
    scorer,
    init: scorer.init().catch((error: unknown) => {
      log.error?.('[emotion-analyzer] model init failed:', error)
      return false
    }),
    chains: new Map<string, Promise<void>>(),
  }

  const registry = ctx.sessionProjections
  if (registry === undefined || registry === null) {
    log.warn?.('[emotion-analyzer] sessionProjections service missing; emotion state will not persist')
    return
  }
  registerEmotionProjection(
    registry as Parameters<typeof registerEmotionProjection>[0],
    pluginRecordOf as unknown as (event: unknown) => { type: string; data: unknown } | undefined,
  )

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      void runtime.scorer.dispose()
      runtime.chains.clear()
    })
  }

  const handleTurn = async (payload: TurnStoppingPayload): Promise<void> => {
    const session = payload.agent?.session
    const turn = payload.turn
    if (session === undefined || typeof session.deriveMessages !== 'function' || typeof turn !== 'number') {
      return
    }
    if (!(await runtime.init)) return

    const text = extractLastAssistantText(session.deriveMessages())
    if (text.length === 0) return

    const startedAt = Date.now()
    const raw = await withTimeout<Record<string, number>>(
      runtime.scorer.score(truncateForScoring(text)),
      SCORE_TIMEOUT_MS,
      'emotion scoring',
    )
    const latencyMs = Date.now() - startedAt
    if (raw === undefined || raw === null || Object.keys(raw).length === 0) {
      log.warn?.('[emotion-analyzer] empty score; turn left untouched')
      return
    }

    const record: EmotionTurnRecord = {
      version: 1,
      turn,
      raw,
      latencyMs,
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
    log.debug?.(`[emotion-analyzer] turn ${turn} scored in ${latencyMs}ms`)
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
