/**
 * Client-side singleton store bridging the host projection to the floating
 * widget. The bridge component (session scope) writes; the overlay (root
 * scope, shell.overlay) reads. Keeping it module-level is deliberate: the
 * overlay must survive SPA navigation while the bridge only exists while a
 * conversation is mounted.
 */
import type { EmotionWireValue } from '../types.ts'

/** Widget-ready payload derived from the host projection. */
export interface WidgetData {
  turn: number
  dominant: string
  scores: Record<string, number>
  trend: Array<Record<string, number>>
  language: 'zh' | 'en'
  latencyMs: number
  sessionId?: string
}

/** Store snapshot. `data === null` means "no scored reply observed yet". */
export interface EmotionStoreSnapshot {
  data: WidgetData | null
  updatedAt: number
}

let snapshot: EmotionStoreSnapshot = { data: null, updatedAt: 0 }
let lastKey = 'null'
const listeners = new Set<(snapshot: EmotionStoreSnapshot) => void>()

/** True when at least one score is a positive finite number. */
export function hasScoredSignal(scores: Record<string, unknown> | null | undefined): boolean {
  if (!scores || typeof scores !== 'object') return false
  return Object.values(scores).some(
    (value) => typeof value === 'number' && Number.isFinite(value) && value > 0,
  )
}

/** Translate a projection wire value into the widget's shape. */
export function toWidgetData(
  value: EmotionWireValue | undefined | null,
  sessionId?: string,
): WidgetData | null {
  if (value === undefined || value === null || typeof value !== 'object') return null
  // Issue #62 H6: an empty projection (turn 0 / all-zero scores) is not data.
  // Returning null keeps the widget on 「等待第一条回复」 and avoids writing a
  // fake trend into localStorage.
  const turn = typeof value.turn === 'number' && Number.isFinite(value.turn) ? value.turn : 0
  if (turn <= 0) return null
  const displayScores = value.turnScores && Object.keys(value.turnScores).length > 0
    ? value.turnScores
    : value.scores
  if (!displayScores || typeof displayScores !== 'object') return null
  if (!hasScoredSignal(displayScores as Record<string, unknown>)) return null
  return {
    turn: value.turn,
    dominant: value.turnDominant ?? value.dominant,
    scores: displayScores,
    trend: Array.isArray(value.trend) ? value.trend.map((point) => point.scores) : [],
    language: value.language === 'zh' ? 'zh' : 'en',
    latencyMs: value.latencyMs,
    ...(sessionId === undefined ? {} : { sessionId }),
  }
}

/**
 * Publish a projection value (from the session bridge).
 * @param value - host projection value, or undefined when the key is absent.
 * @param sessionId - session the value belongs to.
 */
export function publishEmotion(
  value: EmotionWireValue | undefined | null,
  sessionId?: string,
): void {
  const data = toWidgetData(value, sessionId)
  const key = data === null ? 'null' : JSON.stringify(data)
  if (key === lastKey) return
  lastKey = key
  snapshot = { data, updatedAt: data === null ? 0 : Date.now() }
  {
    for (const listener of [...listeners]) {
      try {
        listener(snapshot)
      } catch {
        // a broken subscriber must not break the others
      }
    }
  }
}

/** Current snapshot (stable reference between publications). */
export function getEmotionSnapshot(): EmotionStoreSnapshot {
  return snapshot
}

/**
 * Subscribe to store publications.
 * @param listener - called with the latest snapshot.
 * @returns unsubscribe function.
 */
export function subscribeEmotion(listener: (snapshot: EmotionStoreSnapshot) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
