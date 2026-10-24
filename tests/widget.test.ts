/**
 * Pure-logic tests for the emotion monitor widget.
 *
 * Runs on node:test with Node's built-in TypeScript stripping; no DOM or
 * browser globals are imported here (the Custom Element itself is exercised by
 * the headless-Chrome verification pass in docs/widget.md).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BADGE_SIZE,
  DRAG_THRESHOLD,
  EMOTION_DIMENSIONS,
  EMOTION_META,
  MAX_TREND,
  STORAGE_KEYS,
  STORAGE_PREFIX,
  VIEWPORT_MARGIN,
  appendTrend,
  badgeBackground,
  badgeGlow,
  clamp,
  clampPosition,
  cjkRatio,
  deserializeTrend,
  detectLanguage,
  emotionLabel,
  emptyState,
  exceedsDragThreshold,
  formatLatency,
  formatTurn,
  languageLabel,
  normalizeScore,
  normalizeScores,
  normalizeState,
  normalizeTrend,
  parsePosition,
  pickDominant,
  projectSparklinePoint,
  resolveLanguage,
  scorePercent,
  serializeTrend,
  sparklineSeries,
  trimTrend,
} from '../src/widget/state.ts'

const ALL_ZERO = normalizeScores(null)

test('emotion metadata: seven dimensions with expected emoji + colours', () => {
  assert.deepEqual(
    [...EMOTION_DIMENSIONS],
    ['pleasant', 'sad', 'angry', 'anxious', 'unwell', 'confused', 'neutral'],
  )
  assert.deepEqual(
    EMOTION_DIMENSIONS.map((dimension) => EMOTION_META[dimension].emoji),
    ['😊', '😢', '😠', '😟', '🤢', '🤔', '😐'],
  )
  const colours = new Set<string>()
  for (const dimension of EMOTION_DIMENSIONS) {
    const meta = EMOTION_META[dimension]
    assert.match(meta.color, /^#[0-9A-F]{6}$/i)
    assert.equal(meta.rgb.length, 3)
    assert.equal(meta.softRgb.length, 3)
    assert.ok(meta.label.length > 0 && meta.labelEn.length > 0)
    colours.add(meta.color.toLowerCase())
  }
  assert.equal(colours.size, EMOTION_DIMENSIONS.length, 'colours are unique')

  // Issue #30: happy merged into pleasant, label is 愉快.
  assert.equal(EMOTION_META.pleasant.label, '愉快')
  assert.equal(EMOTION_META.pleasant.emoji, '😊')
  assert.equal(EMOTION_META.pleasant.color, '#F5B301')
  assert.equal('happy' in EMOTION_META, false, 'happy dimension is removed')

  // Issue #32: unwell renamed 反感 and decoupled from sad.
  assert.equal(EMOTION_META.unwell.label, '反感')
  assert.equal(EMOTION_META.unwell.emoji, '🤢')
  assert.equal(EMOTION_META.unwell.color, '#7C9A3B')

  // Question dimension.
  assert.equal(EMOTION_META.confused.label, '疑问')
  assert.equal(EMOTION_META.confused.emoji, '🤔')
  assert.equal(EMOTION_META.confused.color, '#0891B2')
})

test('compact badge size + drag/click threshold (#34)', () => {
  assert.equal(BADGE_SIZE, 64, 'compact badge is ~64x64')
  assert.equal(DRAG_THRESHOLD, 4, 'drag threshold is 4px')
  assert.equal(exceedsDragThreshold(0, 0), false)
  assert.equal(exceedsDragThreshold(3, 0), false)
  assert.equal(exceedsDragThreshold(4, 0), false, 'exactly 4px is still a click')
  assert.equal(exceedsDragThreshold(0, -4), false)
  assert.equal(exceedsDragThreshold(4.1, 0), true)
  assert.equal(exceedsDragThreshold(-5, 0), true)
  assert.equal(exceedsDragThreshold(3, 3), true, '3+3px is 4.24px')
  assert.equal(exceedsDragThreshold(0, 0, 0), false)
})

test('normalizeScore: clamps, ignores junk, treats >1 as percent', () => {
  assert.equal(normalizeScore(0.42), 0.42)
  assert.equal(normalizeScore(72), 0.72)
  assert.equal(normalizeScore(1), 1)
  assert.equal(normalizeScore(150), 1)
  assert.equal(normalizeScore(-0.2), 0)
  assert.equal(normalizeScore(0), 0)
  assert.equal(normalizeScore(Number.NaN), 0)
  assert.equal(normalizeScore('0.5'), 0.5)
  assert.equal(normalizeScore(undefined), 0)
})

test('normalizeScores fills every dimension and drops unknown keys', () => {
  const scores = normalizeScores({ pleasant: 150, sad: 45, bogus: 9 })
  assert.deepEqual(Object.keys(scores), [...EMOTION_DIMENSIONS])
  assert.equal(scores.pleasant, 1)
  assert.equal(scores.sad, 0.45)
  assert.equal(scores.neutral, 0)
})

test('pickDominant: host preference wins on ties, otherwise max wins', () => {
  const scores = normalizeScores({ pleasant: 0.9, sad: 0.2 })
  assert.equal(pickDominant(scores), 'pleasant')
  assert.equal(pickDominant(scores, 'sad'), 'pleasant')
  assert.equal(pickDominant(scores, 'pleasant'), 'pleasant')
  assert.equal(pickDominant(scores, 'bogus'), 'pleasant')

  const tie = normalizeScores({ pleasant: 0.8, sad: 0.8 })
  assert.equal(pickDominant(tie), 'pleasant', 'dimension order breaks ties')
  assert.equal(pickDominant(tie, 'sad'), 'sad', 'host preference wins a tie')

  assert.equal(pickDominant(ALL_ZERO), 'neutral')
  assert.equal(pickDominant(ALL_ZERO, 'pleasant'), 'pleasant')
})

test('trimTrend keeps only the newest 30 samples', () => {
  const trend = Array.from({ length: 40 }, (_, index) => index)
  const trimmed = trimTrend(trend)
  assert.equal(trimmed.length, MAX_TREND)
  assert.equal(trimmed[0], 10)
  assert.equal(trimmed[trimmed.length - 1], 39)
  assert.deepEqual(trimTrend([], MAX_TREND), [])
  assert.deepEqual(trimTrend([1, 2, 3], 2), [2, 3])
  assert.deepEqual(trimTrend([1, 2, 3], 0), [])
})

test('normalizeTrend accepts raw score maps (lead contract) and {scores}', () => {
  const raw = Array.from({ length: 35 }, (_, index) => ({ pleasant: index / 100 }))
  const normalised = normalizeTrend(raw)
  assert.equal(normalised.length, MAX_TREND)
  assert.equal(normalised[0]?.scores.pleasant, 0.05)
  assert.equal(normalised[normalised.length - 1]?.scores.pleasant, 0.34)

  const wrapped = normalizeTrend([{ scores: { pleasant: 0.7 } }, { scores: { sad: 60 } }])
  assert.equal(wrapped.length, 2)
  assert.equal(wrapped[0]?.scores.pleasant, 0.7)
  assert.equal(wrapped[1]?.scores.sad, 0.6)

  const dirty = normalizeTrend([null, undefined, { pleasant: -3 }, 7])
  assert.equal(dirty.length, 4)
  assert.equal(dirty[2]?.scores.pleasant, 0)
  assert.equal(normalizeTrend(null).length, 0)
})

test('appendTrend appends current scores and trims to MAX_TREND', () => {
  const initial = normalizeTrend(Array.from({ length: MAX_TREND }, () => ({ pleasant: 0.1 })))
  const next = appendTrend(initial, normalizeScores({ sad: 0.9 }))
  assert.equal(next.length, MAX_TREND)
  assert.equal(next[next.length - 1]?.scores.sad, 0.9)
  assert.equal(next[0]?.scores.pleasant, 0.1)
  assert.equal(appendTrend([], normalizeScores({ pleasant: 1 })).length, 1)
})

test('serializeTrend/deserializeTrend round-trip and tolerate corruption', () => {
  const trend = normalizeTrend([{ pleasant: 0.1234 }, { sad: 0.5 }])
  const raw = serializeTrend(trend)
  const parsed = deserializeTrend(raw)
  assert.equal(parsed.length, 2)
  assert.equal(parsed[0]?.scores.pleasant, 0.123)
  assert.equal(parsed[1]?.scores.sad, 0.5)
  assert.deepEqual(deserializeTrend(null), [])
  assert.deepEqual(deserializeTrend('not-json'), [])
  assert.deepEqual(deserializeTrend('{"x":1}'), [])
  assert.deepEqual(deserializeTrend('[]'), [])
})

test('sparklineSeries: one normalised series per dimension', () => {
  const trend = normalizeTrend([
    { pleasant: 0.2, sad: 80 },
    { pleasant: 0.6, sad: 10 },
  ])
  const series = sparklineSeries(trend)
  assert.equal(series.length, EMOTION_DIMENSIONS.length)
  assert.deepEqual(series[0]?.dimension, 'pleasant')
  assert.deepEqual(series[0]?.values, [0.2, 0.6])
  assert.deepEqual(series[1]?.values, [0.8, 0.1])
  assert.deepEqual(sparklineSeries(trend, ['neutral']), [
    { dimension: 'neutral', values: [0, 0] },
  ])
})

test('projectSparklinePoint maps values into canvas coordinates', () => {
  const top = projectSparklinePoint(1, 0, 2, 100, 50, 5)
  assert.deepEqual(top, { x: 5, y: 5 })
  const bottom = projectSparklinePoint(0, 1, 2, 100, 50, 5)
  assert.deepEqual(bottom, { x: 95, y: 45 })
  const middle = projectSparklinePoint(0.5, 1, 3, 100, 50, 5)
  assert.equal(middle.x, 50)
  assert.equal(middle.y, 25)
  const single = projectSparklinePoint(0.5, 0, 1, 100, 50, 5)
  assert.deepEqual(single, { x: 95, y: 25 }, 'single sample sits at the right edge')
  const hugePadding = projectSparklinePoint(1, 0, 1, 100, 50, 999)
  assert.deepEqual(hugePadding, { x: 75, y: 25 }, 'padding is clamped to half of the smaller size')
})

test('clampPosition keeps the floating box inside the viewport', () => {
  assert.deepEqual(clampPosition(100, 100, 300, 200, 1000, 800), { x: 100, y: 100 })
  assert.deepEqual(clampPosition(-50, -80, 300, 200, 1000, 800), {
    x: VIEWPORT_MARGIN,
    y: VIEWPORT_MARGIN,
  })
  assert.deepEqual(clampPosition(9999, 9999, 300, 200, 1000, 800), {
    x: 1000 - 300 - VIEWPORT_MARGIN,
    y: 800 - 200 - VIEWPORT_MARGIN,
  })
  assert.deepEqual(clampPosition(50, 50, 900, 700, 800, 600), {
    x: VIEWPORT_MARGIN,
    y: VIEWPORT_MARGIN,
  })
  assert.deepEqual(clampPosition(10.6, 20.2, 300, 200, 1000, 800), { x: 12, y: 20 })
})

test('parsePosition validates stored JSON', () => {
  assert.deepEqual(parsePosition('{"x":120,"y":44}', { x: 1, y: 2 }), { x: 120, y: 44 })
  assert.deepEqual(parsePosition('{"x":120.7,"y":44.2}', { x: 1, y: 2 }), { x: 121, y: 44 })
  assert.deepEqual(parsePosition('{"x":"a","y":1}', { x: 1, y: 2 }), { x: 1, y: 2 })
  assert.deepEqual(parsePosition('bad-json', { x: 1, y: 2 }), { x: 1, y: 2 })
  assert.deepEqual(parsePosition(null, { x: 1, y: 2 }), { x: 1, y: 2 })
})

test('CJK language heuristic and host-authoritative resolution', () => {
  assert.equal(cjkRatio('你好世界'), 1)
  assert.equal(cjkRatio('hello world'), 0)
  assert.ok(cjkRatio('你好 hello') > 0.2)
  assert.equal(detectLanguage('你好世界'), 'zh')
  assert.equal(detectLanguage('hello world'), 'en')
  assert.equal(detectLanguage(''), 'en')
  assert.equal(resolveLanguage('en', '你好世界'), 'en', 'host language wins')
  assert.equal(resolveLanguage('zh', 'hello'), 'zh', 'host language wins')
  assert.equal(resolveLanguage(undefined, '你好世界'), 'zh')
  assert.equal(resolveLanguage(undefined, 'hello world'), 'en')
  assert.equal(resolveLanguage(undefined, ''), 'zh')
  assert.equal(resolveLanguage('bogus', '你好'), 'zh')
  assert.equal(languageLabel('zh'), '中文')
  assert.equal(languageLabel('en'), 'English')
  assert.equal(emotionLabel('pleasant', 'zh'), '愉快')
  assert.equal(emotionLabel('pleasant', 'en'), 'Pleasant')
})

test('formatTurn / formatLatency / scorePercent', () => {
  assert.equal(formatTurn(3), 'Turn 3')
  assert.equal(formatTurn(3.9), 'Turn 3')
  assert.equal(formatTurn(0), 'Turn –')
  assert.equal(formatTurn(-4), 'Turn –')
  assert.equal(formatTurn(Number.NaN), 'Turn –')
  assert.equal(formatLatency(34), '34ms')
  assert.equal(formatLatency(34.6), '35ms')
  assert.equal(formatLatency(0), '0ms')
  assert.equal(formatLatency(-1), '--')
  assert.equal(formatLatency(Number.NaN), '--')
  assert.equal(scorePercent(0.723), 72)
  assert.equal(scorePercent(1), 100)
  assert.equal(scorePercent(-1), 0)
})

test('badge gradient/glow clamp intensity and use the emotion colour', () => {
  const low = badgeBackground('pleasant', 0)
  const high = badgeBackground('pleasant', 1)
  assert.match(low, /^linear-gradient\(145deg, rgba\(245, 179, 1, /)
  assert.notEqual(low, high)
  assert.equal(badgeBackground('pleasant', 5), high, 'intensity is clamped')
  assert.equal(badgeBackground('pleasant', -5), low, 'intensity is clamped')
  assert.match(badgeGlow('sad', 1), /^rgba\(76, 141, 246, /)
  assert.match(badgeGlow('sad', 0), /^rgba\(76, 141, 246, /)
  assert.match(badgeBackground('unwell', 1), /rgba\(124, 154, 59, /)
  assert.match(badgeBackground('confused', 1), /rgba\(8, 145, 178, /)
})

test('emptyState is a valid, zeroed waiting state', () => {
  const state = emptyState()
  assert.equal(state.turn, 0)
  assert.equal(state.dominant, 'neutral')
  assert.equal(state.language, 'zh')
  assert.equal(state.latencyMs, -1)
  assert.deepEqual(state.trend, [])
  assert.deepEqual(state.scores, ALL_ZERO)
})

test('normalizeState sanitises the host payload end to end', () => {
  const input = {
    turn: 7.8,
    dominant: 'sad',
    scores: { pleasant: 0.2, sad: 88, angry: -1, anxious: 0.4, unwell: 0.3, neutral: 0.2 },
    trend: Array.from({ length: 40 }, (_, index) => ({ pleasant: index / 100 })),
    language: 'en',
    latencyMs: 34.6,
    sessionTitle: '  Product review  ',
    sessionId: 'sess-1',
    unknownField: true,
  }
  const state = normalizeState(input)
  assert.equal(state.turn, 7)
  assert.equal(state.scores.sad, 0.88)
  assert.equal(state.scores.angry, 0)
  assert.equal(state.dominant, 'sad')
  assert.equal(state.trend.length, MAX_TREND)
  assert.equal(state.language, 'en')
  assert.equal(state.latencyMs, 35)
  assert.equal(state.sessionTitle, 'Product review')
  assert.equal(state.sessionId, 'sess-1')

  const fallback = normalizeState({})
  assert.equal(fallback.turn, 0)
  assert.equal(fallback.dominant, 'neutral')
  assert.equal(fallback.language, 'zh')
  assert.equal(fallback.latencyMs, -1)
  assert.deepEqual(fallback.trend, [])
  assert.equal(fallback.sessionTitle, undefined)
})

test('normalizeState falls back to CJK detection from the session title', () => {
  assert.equal(normalizeState({ sessionTitle: '中文会话' }).language, 'zh')
  assert.equal(normalizeState({ sessionTitle: 'English session' }).language, 'en')
  assert.equal(normalizeState({ language: 'en', sessionTitle: '中文会话' }).language, 'en')
})

test('normalizeState caps the session title length', () => {
  const state = normalizeState({ sessionTitle: 'x'.repeat(200) })
  assert.equal(state.sessionTitle?.length, 80)
})

test('storage keys are namespaced and stable', () => {
  assert.equal(STORAGE_PREFIX, 'dsh-emotion-monitor:')
  assert.equal(STORAGE_KEYS.position, 'dsh-emotion-monitor:position')
  assert.equal(STORAGE_KEYS.collapsed, 'dsh-emotion-monitor:collapsed')
  assert.equal(STORAGE_KEYS.closed, 'dsh-emotion-monitor:closed')
  assert.equal(STORAGE_KEYS.trend, 'dsh-emotion-monitor:trend')
})

test('clamp helper handles NaN', () => {
  assert.equal(clamp(5, 0, 10), 5)
  assert.equal(clamp(-5, 0, 10), 0)
  assert.equal(clamp(15, 0, 10), 10)
  assert.equal(clamp(Number.NaN, 2, 10), 2)
})
