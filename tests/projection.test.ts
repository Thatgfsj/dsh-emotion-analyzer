import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  EMOTION_RECORD_TYPE,
  applyEmotionTurn,
  dominantOf,
  makeEmotionProjection,
} from '../src/projection.ts'
import { emptyEmotionState, type EmotionTurnRecord } from '../src/types.ts'

function record(turn: number, raw: Record<string, number>): EmotionTurnRecord {
  return {
    version: 1,
    turn,
    raw,
    latencyMs: 8,
    language: 'zh',
    textHash: 'deadbeef',
    chars: 12,
    timestamp: 1000 + turn,
  }
}

test('dominantOf picks the highest dimension and falls back to neutral', () => {
  assert.equal(dominantOf({ pleasant: 0.2, sad: 0.7 }), 'sad')
  assert.equal(dominantOf({}), 'neutral')
  assert.equal(dominantOf({ pleasant: 0, sad: 0 }), 'neutral')
})

test('sad accumulates over five turns and never exceeds the cap', () => {
  let state = emptyEmotionState()
  for (let turn = 1; turn <= 5; turn += 1) {
    state = applyEmotionTurn(state, record(turn, { sadness: 0.95 }))
  }
  assert.equal(state.totalTurns, 5)
  const sad = state.scores.sad ?? 0
  assert.ok(sad > 0.5, `sad should accumulate, got ${sad}`)
  assert.ok(sad <= 1, 'sad must stay under CAP')
  assert.equal(state.dominant, 'sad')
  assert.equal(state.trend.length, 5)
})

test('ten neutral turns decay a sad state below 0.2', () => {
  let state = emptyEmotionState()
  for (let turn = 1; turn <= 5; turn += 1) {
    state = applyEmotionTurn(state, record(turn, { sadness: 0.95 }))
  }
  assert.ok((state.scores.sad ?? 0) > 0.5)
  for (let turn = 6; turn <= 15; turn += 1) {
    state = applyEmotionTurn(state, record(turn, { neutral: 0.9 }))
  }
  const decayed = state.scores.sad ?? 0
  assert.ok(decayed < 0.2, `sad should decay, got ${decayed}`)
})

test('duplicate or stale turns keep the same state reference', () => {
  const state = applyEmotionTurn(emptyEmotionState(), record(2, { joy: 0.9 }))
  assert.equal(applyEmotionTurn(state, record(2, { joy: 0.9 })), state)
  assert.equal(applyEmotionTurn(state, record(1, { joy: 0.9 })), state)
})

test('trend keeps at most 30 points', () => {
  let state = emptyEmotionState()
  for (let turn = 1; turn <= 35; turn += 1) {
    state = applyEmotionTurn(state, record(turn, { joy: 0.5 }))
  }
  assert.equal(state.trend.length, 30)
  assert.equal(state.trend[0]?.turn, 6)
  assert.equal(state.trend[29]?.turn, 35)
})

test('projection unit ignores foreign and malformed records', () => {
  const unit = makeEmotionProjection((event) => {
    const typed = event as { type?: string; data?: unknown }
    return typed.type === undefined ? undefined : { type: typed.type, data: typed.data }
  })
  const initial = unit.init()
  assert.equal(unit.apply(initial, { type: 'turn/start', data: {} }), initial)
  assert.equal(unit.apply(initial, { type: EMOTION_RECORD_TYPE, data: { nope: true } }), initial)
  const withRecord = unit.apply(initial, { type: EMOTION_RECORD_TYPE, data: record(1, { joy: 0.93 }) })
  assert.notEqual(withRecord, initial)
  assert.ok((withRecord.scores.pleasant ?? 0) > 0.2)
  assert.equal(unit.wire?.view(withRecord), withRecord)
})
test('v0.2 记录携带 profileId：按记录自己的 profile 折叠，旧 v1 记录走 legacy', () => {
  const unit = makeEmotionProjection((event) => event as { type: string; data: unknown } | undefined)
  assert.equal(unit.stateVersion, 4)
  let state = emptyEmotionState()
  // v1 记录（没有 profileId）→ legacy-11
  state = unit.apply(state, { type: EMOTION_RECORD_TYPE, data: record(1, { joy: 0.9 }) })
  assert.ok((state.scores.pleasant ?? 0) > 0)
  // v2 记录携带 go-emotions-28：28 标签也能折叠出统一维度
  state = unit.apply(state, {
    type: EMOTION_RECORD_TYPE,
    data: { ...record(2, { joy: 0.9, grief: 0.8 }), version: 2, modelId: 'horizon-small', profileId: 'go-emotions-28' },
  })
  assert.ok((state.turnScores.pleasant ?? 0) > 0.5)
  assert.ok((state.turnScores.sad ?? 0) > 0.5)
  // 同一份 28 标签 raw 如果错误地挂 legacy profile，则不会被识别（只有 legacy 标签生效）
  const legacyFold = unit.apply(emptyEmotionState(), {
    type: EMOTION_RECORD_TYPE,
    data: { ...record(1, { grief: 0.8 }), version: 2, modelId: 'x', profileId: 'legacy-11' },
  })
  assert.equal(
    Object.values(legacyFold.turnScores).every((value) => value === 0),
    true,
    'legacy profile 不应该识别 GoEmotions 的 grief 标签',
  )
})
