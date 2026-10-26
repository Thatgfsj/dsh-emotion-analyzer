/**
 * dsh-emotion-analyzer — pure widget logic.
 *
 * This module intentionally has no DOM / browser globals so the same
 * functions can be exercised by node:test (see tests/widget.test.ts) and
 * reused by the Custom Element, the sparkline renderer and the demo entry.
 */

/** Seven unified emotion dimensions, in display order (happy merged into pleasant). */
export const EMOTION_DIMENSIONS = [
  'pleasant',
  'sad',
  'angry',
  'anxious',
  'unwell',
  'confused',
  'neutral',
] as const

export type EmotionDimension = (typeof EMOTION_DIMENSIONS)[number]
export type Language = 'zh' | 'en'

/** A fully normalised score map: every dimension present, each value in [0, 1]. */
export type EmotionScores = Record<EmotionDimension, number>

export interface EmotionMeta {
  /** Short Chinese label used in the score list. */
  label: string
  /** Short English label (badge tooltip / aria). */
  labelEn: string
  /** Emoji used by the collapsed badge. */
  emoji: string
  /** Bar / sparkline colour. */
  color: string
  /** RGB triple of the colour. */
  rgb: readonly [number, number, number]
  /** Lighter companion colour, used by the badge gradient. */
  softRgb: readonly [number, number, number]
}

/** Single source of truth for labels, emoji and colours. */
export const EMOTION_META: Record<EmotionDimension, EmotionMeta> = {
  pleasant: { label: '愉快', labelEn: 'Pleasant', emoji: '😊', color: '#F5B301', rgb: [245, 179, 1], softRgb: [255, 214, 102] },
  sad: { label: '悲伤', labelEn: 'Sad', emoji: '😢', color: '#4C8DF6', rgb: [76, 141, 246], softRgb: [147, 189, 251] },
  angry: { label: '愤怒', labelEn: 'Angry', emoji: '😠', color: '#E5484D', rgb: [229, 72, 77], softRgb: [255, 138, 142] },
  anxious: { label: '焦虑', labelEn: 'Anxious', emoji: '😟', color: '#A855F7', rgb: [168, 85, 247], softRgb: [201, 154, 251] },
  unwell: { label: '反感', labelEn: 'Disgust', emoji: '🤢', color: '#7C9A3B', rgb: [124, 154, 59], softRgb: [174, 199, 111] },
  confused: { label: '疑问', labelEn: 'Curious', emoji: '🤔', color: '#0891B2', rgb: [8, 145, 178], softRgb: [103, 195, 217] },
  neutral: { label: '平静', labelEn: 'Neutral', emoji: '😐', color: '#8A93A3', rgb: [138, 147, 163], softRgb: [190, 197, 208] },
}

/** Maximum number of turns kept for the sparkline (and localStorage). */
export const MAX_TREND = 30
/** Expanded panel width in CSS pixels (mirrored by styles.ts). */
export const WIDGET_WIDTH = 328
/** Collapsed badge size in CSS pixels (emoji + Chinese emotion label). */
export const BADGE_SIZE = 64
/** Movement (px) beyond which a pointer gesture is a drag, not a click. */
export const DRAG_THRESHOLD = 4
/** Minimum distance between the floating widget and the viewport edges. */
export const VIEWPORT_MARGIN = 12

/** Euclidean distance check used to separate drag from click (issue #34). */
export function exceedsDragThreshold(dx: number, dy: number, threshold: number = DRAG_THRESHOLD): boolean {
  return Math.sqrt(dx * dx + dy * dy) > threshold
}

/** localStorage keys owned by the widget. */
export const STORAGE_PREFIX = 'dsh-emotion-monitor:'
export const STORAGE_KEYS = {
  position: STORAGE_PREFIX + 'position',
  collapsed: STORAGE_PREFIX + 'collapsed',
  closed: STORAGE_PREFIX + 'closed',
  trend: STORAGE_PREFIX + 'trend',
} as const

export interface TrendPoint {
  scores: EmotionScores
}

export interface EmotionMonitorState {
  turn: number
  dominant: EmotionDimension
  scores: EmotionScores
  trend: TrendPoint[]
  language: Language
  latencyMs: number
  sessionTitle?: string
  sessionId?: string
}

/** Loose input accepted by update() (host data may be partial / dirty). */
export interface EmotionMonitorStateInput {
  turn?: number
  dominant?: string
  scores?: Readonly<Record<string, number>> | null
  trend?: ReadonlyArray<unknown> | null
  language?: string
  latencyMs?: number
  sessionTitle?: string
  sessionId?: string
}

export interface Point {
  x: number
  y: number
}

export interface SparklineSeries {
  dimension: EmotionDimension
  /** One normalised (0..1) sample per trend turn. */
  values: number[]
}

const DIMENSION_SET: ReadonlySet<string> = new Set(EMOTION_DIMENSIONS)

export function isEmotionDimension(value: unknown): value is EmotionDimension {
  return typeof value === 'string' && DIMENSION_SET.has(value)
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return value < min ? min : value > max ? max : value
}

function clamp01(value: number): number {
  return clamp(value, 0, 1)
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function round(value: number, digits = 3): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function metaFor(dimension: EmotionDimension): EmotionMeta {
  return EMOTION_META[dimension] ?? EMOTION_META.neutral
}

function rgba(rgb: readonly [number, number, number], alpha: number): string {
  return 'rgba(' + rgb[0] + ', ' + rgb[1] + ', ' + rgb[2] + ', ' + round(clamp01(alpha), 2) + ')'
}

/**
 * Normalise one raw score.
 *
 * The model emits sigmoid probabilities in [0, 1]; values > 1 are tolerated
 * and interpreted as percentages (e.g. 72 -> 0.72) so a host that stores
 * 0-100 values still renders something sensible.
 */
export function normalizeScore(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) return 0
  return clamp01(n > 1 ? n / 100 : n)
}

/** Fill every dimension (missing => 0) and clamp unknown values. */
export function normalizeScores(input: Readonly<Record<string, number>> | null | undefined): EmotionScores {
  const scores = {} as EmotionScores
  for (const dimension of EMOTION_DIMENSIONS) {
    scores[dimension] = normalizeScore(input?.[dimension])
  }
  return scores
}

/**
 * Pick the dominant dimension.
 *
 * A valid preferred value (from the host) wins unless another dimension is
 * clearly higher — this keeps the host authoritative while still producing a
 * sane badge when dominant is missing or stale.
 */
export function pickDominant(
  scores: EmotionScores,
  preferred?: unknown,
): EmotionDimension {
  let best: EmotionDimension = 'neutral'
  let bestScore = -1
  for (const dimension of EMOTION_DIMENSIONS) {
    if (scores[dimension] > bestScore) {
      best = dimension
      bestScore = scores[dimension]
    }
  }
  if (isEmotionDimension(preferred)) {
    if (scores[preferred] >= bestScore - 1e-9) return preferred
    if (bestScore <= 0) return preferred
  }
  return bestScore <= 0 ? 'neutral' : best
}

/** Keep only the most recent max trend points. */
export function trimTrend<T>(trend: readonly T[], max: number = MAX_TREND): T[] {
  if (!Array.isArray(trend) || trend.length === 0) return []
  const limit = Math.max(0, Math.floor(max))
  if (limit === 0) return []
  return trend.slice(-limit)
}

/** Extract a score map from either accepted trend entry shape. */
function scoresFromTrendEntry(entry: unknown): Readonly<Record<string, number>> | null {
  if (!entry || typeof entry !== 'object') return null
  const maybeScores = (entry as { scores?: unknown }).scores
  if (maybeScores && typeof maybeScores === 'object') {
    return maybeScores as Readonly<Record<string, number>>
  }
  return entry as Readonly<Record<string, number>>
}

/** Normalise an arbitrary trend array and trim it to max entries. */
export function normalizeTrend(
  trend: ReadonlyArray<unknown> | null | undefined,
  max: number = MAX_TREND,
): TrendPoint[] {
  if (!Array.isArray(trend)) return []
  const points: TrendPoint[] = []
  for (const entry of trend) {
    points.push({ scores: normalizeScores(scoresFromTrendEntry(entry)) })
  }
  return trimTrend(points, max)
}

/** Append the current scores, keeping at most max points. */
export function appendTrend(
  trend: readonly TrendPoint[],
  scores: EmotionScores,
  max: number = MAX_TREND,
): TrendPoint[] {
  return trimTrend([...trend, { scores: normalizeScores(scores) }], max)
}

/** Compact localStorage representation: an array of score maps. */
export function serializeTrend(trend: readonly TrendPoint[]): string {
  const compact = trimTrend(trend).map((point) => {
    const scores: Record<string, number> = {}
    for (const dimension of EMOTION_DIMENSIONS) {
      scores[dimension] = round(normalizeScore(point.scores[dimension]))
    }
    return scores
  })
  return JSON.stringify(compact)
}

/** Parse the value produced by serializeTrend; never throws. */
export function deserializeTrend(raw: string | null | undefined, max: number = MAX_TREND): TrendPoint[] {
  if (typeof raw !== 'string' || raw.length === 0) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return normalizeTrend(parsed, max)
}

/** One series per dimension for the canvas sparkline. */
export function sparklineSeries(
  trend: readonly TrendPoint[],
  dimensions: readonly EmotionDimension[] = EMOTION_DIMENSIONS,
): SparklineSeries[] {
  return dimensions.map((dimension) => ({
    dimension,
    values: trend.map((point) => normalizeScore(point.scores[dimension])),
  }))
}

/**
 * Map one trend sample to canvas coordinates.
 *
 * With a single sample the point sits at the right edge (the latest turn is
 * always the rightmost sample); y is inverted because canvas y grows down.
 */
export function projectSparklinePoint(
  value: number,
  index: number,
  count: number,
  width: number,
  height: number,
  padding = 3,
): Point {
  const w = Math.max(0, finiteNumber(width, 0))
  const h = Math.max(0, finiteNumber(height, 0))
  const p = clamp(finiteNumber(padding, 0), 0, Math.min(w / 2, h / 2))
  const usableW = Math.max(0, w - p * 2)
  const usableH = Math.max(0, h - p * 2)
  const safeCount = Math.max(1, Math.floor(finiteNumber(count, 1)))
  const safeIndex = clamp(Math.floor(finiteNumber(index, 0)), 0, safeCount - 1)
  const t = safeCount <= 1 ? 1 : safeIndex / (safeCount - 1)
  return {
    x: p + t * usableW,
    y: p + (1 - clamp01(normalizeScore(value))) * usableH,
  }
}

/** Keep a floating box inside the viewport. */
export function clampPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
  margin: number = VIEWPORT_MARGIN,
): Point {
  const m = Math.max(0, finiteNumber(margin, 0))
  const w = Math.max(0, finiteNumber(width, 0))
  const h = Math.max(0, finiteNumber(height, 0))
  const maxX = Math.max(m, finiteNumber(viewportWidth, 0) - w - m)
  const maxY = Math.max(m, finiteNumber(viewportHeight, 0) - h - m)
  return {
    x: Math.round(clamp(finiteNumber(x, m), m, maxX)),
    y: Math.round(clamp(finiteNumber(y, m), m, maxY)),
  }
}

/** Parse a stored {x, y} position, falling back on malformed data. */
export function parsePosition(
  raw: string | null | undefined,
  fallback: Point,
): Point {
  if (typeof raw !== 'string' || raw.length === 0) return fallback
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      const maybeX = (parsed as { x?: unknown }).x
      const maybeY = (parsed as { y?: unknown }).y
      if (typeof maybeX === 'number' && Number.isFinite(maybeX) && typeof maybeY === 'number' && Number.isFinite(maybeY)) {
        return { x: Math.round(maybeX), y: Math.round(maybeY) }
      }
    }
  } catch {
    // ignore malformed JSON
  }
  return fallback
}

/** Ratio of CJK ideographs/kana/hangul among all CJK + Latin letters. */
export function cjkRatio(text: string | null | undefined): number {
  if (typeof text !== 'string' || text.length === 0) return 0
  let cjk = 0
  let latin = 0
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    const isCjk =
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff)
    if (isCjk) cjk += 1
    else if (/[A-Za-z]/.test(character)) latin += 1
  }
  const total = cjk + latin
  return total === 0 ? 0 : cjk / total
}

/** CJK-share language heuristic (only used when the host passes no language). */
export function detectLanguage(text: string | null | undefined): Language {
  return cjkRatio(text) >= 0.2 ? 'zh' : 'en'
}

/**
 * Resolve the display language: the host value is authoritative; if it is
 * missing/unknown fall back to a CJK share check on the sample text.
 */
export function resolveLanguage(language: unknown, text?: string | null): Language {
  if (language === 'zh' || language === 'en') return language
  const sample = typeof text === 'string' ? text.trim() : ''
  if (sample.length === 0) return 'zh'
  return detectLanguage(sample)
}

export function languageLabel(language: Language): '中文' | 'English' {
  return language === 'zh' ? '中文' : 'English'
}

export function formatTurn(turn: number): string {
  if (!Number.isFinite(turn) || turn <= 0) return 'Turn –'
  return 'Turn ' + Math.floor(turn)
}

export function formatLatency(latencyMs: number): string {
  if (!Number.isFinite(latencyMs) || latencyMs < 0) return '--'
  return Math.round(latencyMs) + 'ms'
}

/** 0-100 integer used by the right-hand score values. */
export function scorePercent(score: unknown): number {
  return Math.round(normalizeScore(score) * 100)
}

export function emotionLabel(dimension: EmotionDimension, language: Language): string {
  const meta = metaFor(dimension)
  return language === 'zh' ? meta.label : meta.labelEn
}

/** Badge background gradient: dominant colour + intensity. */
export function badgeBackground(dimension: EmotionDimension, intensity: number): string {
  const meta = metaFor(dimension)
  const level = clamp01(finiteNumber(intensity, 0))
  const startAlpha = 0.45 + 0.45 * level
  const endAlpha = 0.24 + 0.36 * level
  return 'linear-gradient(145deg, ' + rgba(meta.rgb, startAlpha) + ', ' + rgba(meta.softRgb, endAlpha) + ')'
}

/** Badge drop shadow, tinted by the dominant emotion. */
export function badgeGlow(dimension: EmotionDimension, intensity: number): string {
  const meta = metaFor(dimension)
  const level = clamp01(finiteNumber(intensity, 0))
  return rgba(meta.rgb, 0.32 + 0.4 * level)
}

/**
 * Issue #62 H6: a projection only counts as real data when it belongs to a
 * positive turn and carries at least one positive score. Empty projections
 * (turn 0 / all-zero) must keep the widget on the waiting state.
 */
export function hasMeaningfulScores(
  turn: number,
  scores: Record<string, number> | null | undefined,
): boolean {
  if (!Number.isFinite(turn) || turn <= 0) return false
  if (!scores || typeof scores !== 'object') return false
  return Object.values(scores).some(
    (value) => typeof value === 'number' && Number.isFinite(value) && value > 0,
  )
}

/** Empty state rendered before the first host update. */
export function emptyState(): EmotionMonitorState {
  return {
    turn: 0,
    dominant: 'neutral',
    scores: normalizeScores(null),
    trend: [],
    language: 'zh',
    latencyMs: -1,
  }
}

/** Sanitise host input into the widget's internal state shape. */
export function normalizeState(input: EmotionMonitorStateInput | null | undefined): EmotionMonitorState {
  const raw = input ?? {}
  const scores = normalizeScores(raw.scores)
  const sessionTitle = typeof raw.sessionTitle === 'string' ? raw.sessionTitle.trim() : ''
  const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId.trim() : ''
  const language = resolveLanguage(raw.language, sessionTitle)
  const trend = normalizeTrend(raw.trend)
  return {
    turn: Number.isFinite(raw.turn) ? Math.max(0, Math.floor(raw.turn as number)) : 0,
    dominant: pickDominant(scores, raw.dominant),
    scores,
    trend,
    language,
    latencyMs: Number.isFinite(raw.latencyMs) ? Math.max(0, Math.round(raw.latencyMs as number)) : -1,
    ...(sessionTitle.length > 0 ? { sessionTitle: sessionTitle.slice(0, 80) } : {}),
    ...(sessionId.length > 0 ? { sessionId: sessionId.slice(0, 80) } : {}),
  }
}
