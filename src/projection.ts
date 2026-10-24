/**
 * The `emotion` session projection unit.
 *
 * DSH drives projection units with a PURE SYNCHRONOUS fold over committed
 * session events (DSH 0.2.1-rc.2: `ctx.sessionProjections.register`). Model
 * inference is async, so the host hook appends a plugin record
 * (`plugin:emotion-analyzer/turn`) first; this unit folds that record through
 * the mapping layer. Replay/restart therefore reconstructs the exact state
 * without ever calling the model again.
 */
import { z } from 'zod'
import { updateProjection } from './mapping.ts'
import {
  TREND_LIMIT,
  emptyEmotionState,
  type EmotionProjectionState,
  type EmotionTurnRecord,
  type ScoreMap,
} from './types.ts'

/** The plugin record type this unit owns. */
export const EMOTION_RECORD_TYPE = 'plugin:emotion-analyzer/turn' as const

const scoreSchema = z.record(z.string(), z.number().finite().min(0).max(1))

const trendPointSchema = z.object({
  turn: z.number().int().nonnegative(),
  scores: scoreSchema,
})

/** Validates persisted state before it seeds a fold, and the wire payload. */
export const emotionStateSchema = z
  .object({
    version: z.literal(1),
    turn: z.number().int().nonnegative(),
    scores: scoreSchema,
    dominant: z.string(),
    trend: z.array(trendPointSchema).max(TREND_LIMIT),
    latencyMs: z.number().finite().nonnegative(),
    language: z.enum(['zh', 'en']),
    updatedAt: z.number().finite().nonnegative(),
    totalTurns: z.number().int().nonnegative(),
  })
  .strict()

/** Validates one plugin-record payload before folding it. */
export const emotionTurnRecordSchema = z
  .object({
    version: z.literal(1),
    turn: z.number().int().positive(),
    raw: scoreSchema,
    latencyMs: z.number().finite().nonnegative(),
    language: z.enum(['zh', 'en']),
    textHash: z.string(),
    chars: z.number().int().nonnegative(),
    timestamp: z.number().finite().nonnegative(),
  })
  .strict()

/** Pick the highest unified dimension; empty/all-zero falls back to neutral. */
export function dominantOf(scores: ScoreMap): string {
  let best = 'neutral'
  let bestScore = 0
  for (const [dimension, value] of Object.entries(scores)) {
    if (value > bestScore) {
      bestScore = value
      best = dimension
    }
  }
  return best
}

/**
 * Apply one turn record to the accumulated state (pure, idempotent per turn).
 * @param state - projection state before the record.
 * @param record - validated plugin-record payload.
 * @returns the next state, or the same reference for duplicate/stale turns.
 */
export function applyEmotionTurn(
  state: EmotionProjectionState,
  record: EmotionTurnRecord,
): EmotionProjectionState {
  if (record.turn <= state.turn) return state
  const scores = updateProjection(state.scores, record.raw) as ScoreMap
  const trend = [...state.trend, { turn: record.turn, scores }].slice(-TREND_LIMIT)
  return {
    version: 1,
    turn: record.turn,
    scores,
    dominant: dominantOf(scores),
    trend,
    latencyMs: record.latencyMs,
    language: record.language,
    updatedAt: record.timestamp,
    totalTurns: state.totalTurns + 1,
  }
}

/** The projection unit definition passed to `ctx.sessionProjections.register`. */
export interface EmotionProjectionDefinition {
  key: 'emotion'
  stateVersion: number
  stateSchema: unknown
  init: () => EmotionProjectionState
  apply: (state: EmotionProjectionState, event: unknown) => EmotionProjectionState
  wire: {
    viewSchema: unknown
    view: (state: EmotionProjectionState) => EmotionProjectionState
  }
}

/**
 * Build the unit. The event is read through `pluginRecordOf` by the caller so
 * this module stays import-light and testable; `makeEmotionProjection`
 * receives that reader.
 * @param readRecord - `pluginRecordOf` from `@deepseek-ai/dsh-session`.
 * @returns the projection definition.
 */
export function makeEmotionProjection(
  readRecord: (event: unknown) => { type: string; data: unknown } | undefined,
): EmotionProjectionDefinition {
  return {
    key: 'emotion',
    // 2: added the `confused` dimension (surprise proxy); invalidates old
    // persisted projection-cache rows so logs refold with the new mapping.
    stateVersion: 2,
    stateSchema: emotionStateSchema,
    init: emptyEmotionState,
    apply(state, event) {
      const record = readRecord(event)
      if (record === undefined || record.type !== EMOTION_RECORD_TYPE) return state
      const parsed = emotionTurnRecordSchema.safeParse(record.data)
      if (!parsed.success) return state
      return applyEmotionTurn(state, parsed.data as EmotionTurnRecord)
    },
    wire: {
      viewSchema: emotionStateSchema,
      view: (state) => state,
    },
  }
}

/** Minimal registry surface this plugin needs (calibrated 0.2.1-rc.2). */
export interface SessionProjectionsLike {
  register(definition: EmotionProjectionDefinition): unknown
}

/**
 * Register the `emotion` unit. Registration rides the calling fiber as an
 * effect (DSH contract), so no manual unregister is needed.
 * @param registry - `ctx.sessionProjections`.
 * @param readRecord - `pluginRecordOf` implementation.
 * @returns whatever the registry returned (handle/disposer), for tests.
 */
export function registerEmotionProjection(
  registry: SessionProjectionsLike,
  readRecord: (event: unknown) => { type: string; data: unknown } | undefined,
): unknown {
  return registry.register(makeEmotionProjection(readRecord))
}
