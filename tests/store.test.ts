import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  getEmotionSnapshot,
  publishEmotion,
  subscribeEmotion,
  toWidgetData,
} from '../src/client/store.ts'
import type { EmotionWireValue } from '../src/types.ts'

function wire(overrides: Partial<EmotionWireValue> = {}): EmotionWireValue {
  return {
    version: 1,
    turn: 3,
    scores: { happy: 0.8, sad: 0.1 },
    dominant: 'happy',
    trend: [{ turn: 1, scores: { happy: 0.2 } }],
    latencyMs: 12,
    language: 'zh',
    updatedAt: 123,
    totalTurns: 2,
    turnScores: { happy: 0.8, sad: 0.1 },
    turnDominant: 'happy',
    ...overrides,
  }
}

test('toWidgetData maps projection values and rejects absence', () => {
  const data = toWidgetData(wire(), 's-1')
  assert.ok(data)
  assert.equal(data?.turn, 3)
  assert.equal(data?.dominant, 'happy')
  assert.equal(data?.language, 'zh')
  assert.deepEqual(data?.trend, [{ happy: 0.2 }])
  assert.equal(data?.sessionId, 's-1')
  assert.equal(toWidgetData(undefined), null)
  assert.equal(toWidgetData(null), null)
})

test('publish notifies subscribers once per distinct value', () => {
  let calls = 0
  const off = subscribeEmotion(() => {
    calls += 1
  })
  const first = wire()
  publishEmotion(first, 's-1')
  publishEmotion(first, 's-1') // same reference -> no second notification
  publishEmotion(wire({ turn: 4 }), 's-1')
  off()
  publishEmotion(wire({ turn: 5 }), 's-1')
  assert.equal(calls, 2)
  // the store still records the latest value even with no subscribers
  assert.equal(getEmotionSnapshot().data?.turn, 5)
})
