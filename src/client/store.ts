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

/** Translate a projection wire value into the widget's shape. */
export function toWidgetData(
  value: EmotionWireValue | undefined | null,
  sessionId?: string,
): WidgetData | null {
  if (value === undefined || value === null || typeof value !== 'object') return null
  if (!value.scores || typeof value.scores !== 'object') return null
  return {
    turn: value.turn,
    dominant: value.dominant,
    scores: value.scores,
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
