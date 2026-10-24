import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { makeEmotionProjection } from '../src/projection.ts'
import { UNIFIED_DIMENSIONS, type EmotionProjectionState } from '../src/types.ts'

/** Equivalent of `pluginRecordOf` for the plugin-record envelope fields we read. */
function readRecord(event: unknown): { type: string; data: unknown } | undefined {
  const candidate = event as { type?: unknown; ignorable?: unknown; data?: unknown } | undefined
  if (candidate === undefined || candidate.ignorable !== true || typeof candidate.type !== 'string') {
    return undefined
  }
  if (!candidate.type.startsWith('plugin:')) return undefined
  return { type: candidate.type, data: candidate.data }
}

function restoreLog(): EmotionProjectionState {
  const lines = readFileSync(new URL('./fixtures/session-restore-events.jsonl', import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown)
  const unit = makeEmotionProjection(readRecord)
  let state = unit.init()
  for (const event of lines) state = unit.apply(state, event)
  return state
}

test('restart restore: folding the committed log reconstructs the final projection', () => {
  const state = restoreLog()
  assert.equal(state.turn, 12)
  assert.equal(state.totalTurns, 12)
  assert.equal(state.trend.length, 12)
  assert.deepEqual(
    state.trend.map((point) => point.turn),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  )
  for (const dimension of UNIFIED_DIMENSIONS) {
    const value = state.scores[dimension] ?? 0
    assert.equal(typeof value, 'number', `${dimension} must be present`)
    assert.ok(Number.isFinite(value) && value >= 0 && value <= 1, `${dimension} out of range: ${value}`)
  }
  assert.equal(state.language, 'en')
  assert.ok(typeof state.dominant === 'string' && state.dominant.length > 0)
})

test('restore is deterministic and repeatable (no hidden state)', () => {
  const first = restoreLog()
  const second = restoreLog()
  assert.deepEqual(second, first)
})

test('folding the same log again over the restored state is idempotent', () => {
  const state = restoreLog()
  const unit = makeEmotionProjection(readRecord)
  const lines = readFileSync(new URL('./fixtures/session-restore-events.jsonl', import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown)
  let replay = state
  for (const event of lines) replay = unit.apply(replay, event)
  assert.equal(replay, state)
})

test('malformed plugin records are ignored without changing the state', () => {
  const unit = makeEmotionProjection(readRecord)
  const initial = unit.init()
  assert.equal(unit.apply(initial, { type: 'plugin:emotion-analyzer/turn', ignorable: true, data: { bad: true } }), initial)
  assert.equal(unit.apply(initial, { type: 'turn/start', ignorable: true, data: {} }), initial)
  assert.equal(unit.wire?.view(initial), initial)
})
