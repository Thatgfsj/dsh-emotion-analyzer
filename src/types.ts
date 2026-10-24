/**
 * Shared wire/state types for the emotion analyzer.
 *
 * These shapes are the contract between the host projection, the plugin record
 * payload, and the browser widget. Keep them JSON-serializable: the projection
 * state must be plain JSON (DSH persisted-cache precondition).
 */

/** Unified emotion dimensions shown in the widget. */
export const UNIFIED_DIMENSIONS = [
  'happy',
  'pleasant',
  'sad',
  'angry',
  'anxious',
  'unwell',
  'neutral',
] as const

/** One unified emotion dimension. */
export type UnifiedDimension = (typeof UNIFIED_DIMENSIONS)[number]

/** Scores keyed by any label (raw model label or unified dimension). */
export type ScoreMap = Record<string, number>

/** Where a scored reply came from, as far as the widget is concerned. */
export type DetectedLanguage = 'zh' | 'en'

/** Payload appended to the session log as `plugin:emotion-analyzer/turn`. */
export interface EmotionTurnRecord {
  /** Payload version; bump together with the projection stateVersion. */
  version: 1
  /** Agent turn number from the `agent/turn-stopping` payload. */
  turn: number
  /** Raw model labels (11) after element-wise sigmoid, all in 0..1. */
  raw: ScoreMap
  /** Wall-clock inference time for this turn, ms. */
  latencyMs: number
  /** Detected language of the scored reply. */
  language: DetectedLanguage
  /** Stable content hash; the reply text itself is never logged. */
  textHash: string
  /** Scored reply length in characters (privacy-safe diagnostic). */
  chars: number
  /** Epoch ms when the record was produced. */
  timestamp: number
}

/** One trend point retained in the projection state (last 30 turns). */
export interface EmotionTrendPoint {
  turn: number
  scores: ScoreMap
}

/** Full host projection state for key `emotion`. */
export interface EmotionProjectionState {
  version: 1
  /** Last scored turn; 0 before the first record. */
  turn: number
  scores: ScoreMap
  dominant: string
  trend: EmotionTrendPoint[]
  latencyMs: number
  language: DetectedLanguage
  updatedAt: number
  totalTurns: number
}

/** Whole value pushed to the browser through the projection wire view. */
export type EmotionWireValue = EmotionProjectionState

/** Maximum number of trend points retained (memory + localStorage budget). */
export const TREND_LIMIT = 30

/** Empty projection state. */
export function emptyEmotionState(): EmotionProjectionState {
  return {
    version: 1,
    turn: 0,
    scores: {},
    dominant: 'neutral',
    trend: [],
    latencyMs: 0,
    language: 'en',
    updatedAt: 0,
    totalTurns: 0,
  }
}
