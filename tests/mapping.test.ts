/**
 * 情绪映射层单元测试（issue #3）。
 *
 * 运行：`node --test tests/`（Node 24 原生执行 TS，无需转译）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CAP,
  DECAY,
  EMOTION_DIMENSIONS,
  EMOTION_MAP,
  RAW_EMOTION_LABELS,
  STEP_MAX,
  THRESHOLD,
  aggregate,
  clamp01,
  emptyProjection,
  normalizeProjection,
  updateProjection,
  type EmotionDimension,
  type EmotionScores,
  type RawScores,
} from '../src/mapping.ts'

/** 浮点近似断言。 */
function close(actual: number, expected: number, epsilon = 1e-9, message?: string): void {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    message ?? `expected ${actual} ≈ ${expected} (±${epsilon})`,
  )
}

/** 按维度取一个固定初始状态。 */
function initial(overrides: Partial<EmotionScores> = {}): EmotionScores {
  return { ...emptyProjection(), ...overrides }
}

/**
 * updateProjection 的公共签名固定为 Record<string, number>（宿主集成契约）；
 * 测试里收窄回完整维度类型，方便按 .sad / .pleasant 断言。
 */
function project(current: Record<string, number>, raw: Record<string, number>): EmotionScores {
  return updateProjection(current, raw) as EmotionScores
}

/** 深冻结，用来证明纯函数不修改入参。 */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

test('常量 pinned 在约定值上', () => {
  assert.equal(THRESHOLD, 0.2)
  assert.equal(DECAY, 0.85)
  assert.equal(STEP_MAX, 0.25)
  assert.equal(CAP, 1.0)
})

test('标签与维度集合是真实的 11 标签 / 7 维度', () => {
  assert.deepEqual(RAW_EMOTION_LABELS, [
    'anger',
    'contempt',
    'disgust',
    'fear',
    'frustration',
    'gratitude',
    'joy',
    'love',
    'neutral',
    'sadness',
    'surprise',
  ])
  assert.deepEqual(EMOTION_DIMENSIONS, ['pleasant', 'sad', 'angry', 'anxious', 'unwell', 'confused', 'neutral'])
  // 11 个原始标签全部被消费；surprise 作为“疑问”的代理映射（issue #25）
  const mapped = new Set(EMOTION_DIMENSIONS.flatMap((dimension) => EMOTION_MAP[dimension].terms.map(([label]) => label)))
  for (const label of RAW_EMOTION_LABELS) {
    assert.equal(mapped.has(label), true, `${label} 应该被映射`)
  }
})

test('EMOTION_MAP：max 维度取参与标签的最大值', () => {
  const aggregated = aggregate({ joy: 0.9, love: 0.8, gratitude: 0.7, sadness: 0.6, fear: 0.4 })
  close(aggregated.pleasant, 0.9)
  close(aggregated.sad, 0.6)
  close(aggregated.anxious, 0.4)
  close(aggregated.angry, 0)
  close(aggregated.neutral, 0)
})

test('EMOTION_MAP：unwell = max(disgust, 0.5*fear)，与 sad 解耦（issue #32）', () => {
  close(aggregate({ disgust: 1 }).unwell, 1)
  close(aggregate({ disgust: 0.7, fear: 1 }).unwell, 0.7)
  close(aggregate({ fear: 1 }).unwell, 0.5)
  close(aggregate({ fear: 0.8 }).unwell, 0.4)
  // 纯悲伤不再点亮“反感”
  close(aggregate({ sadness: 1 }).unwell, 0)
  close(aggregate({ sadness: 0.95, disgust: 0 }).unwell, 0)
})

test('EMOTION_MAP：disgust 只归 unwell，不再点亮 angry（issue #32）', () => {
  // “恶心”句实测 disgust≈0.99：旧映射会同时高亮 angry + unwell 两条重复。
  const disgustOnly = aggregate({ disgust: 0.99 })
  close(disgustOnly.unwell, 0.99)
  close(disgustOnly.angry, 0)
  // angry 仍由 anger / contempt / frustration 驱动
  close(aggregate({ anger: 0.8 }).angry, 0.8)
  close(aggregate({ contempt: 0.7 }).angry, 0.7)
  close(aggregate({ frustration: 0.6 }).angry, 0.6)
  // 单轮投影：disgust 输入只推高 unwell
  const next = project(initial({ angry: 0.6 }), { disgust: 0.9 })
  close(next.unwell, STEP_MAX)
  close(next.angry, 0.6 * DECAY)
})

test('噪声过滤：所有维度都低于 THRESHOLD 时跳过整轮，不积累也不衰减', () => {
  const current = deepFreeze(initial({ sad: 0.5, pleasant: 0.2 }))
  const next = project(current, { sadness: 0.19, frustration: 0.1, joy: 0.1 })
  // 即使输入里有非零噪声，状态也完全保持
  assert.deepEqual(next, current)
  assert.notEqual(next, current, '必须返回新对象')
})

test('噪声过滤：阈值边界（恰好等于 THRESHOLD）算命中', () => {
  const next = project(initial(), { joy: THRESHOLD })
  close(next.pleasant, THRESHOLD)
  // 其余维度未命中 → 衰减（当前为 0）
  close(next.sad, 0)
})

test('连续 5 轮 sad：单调上升且不超过 CAP', () => {
  let state = emptyProjection()
  const history: number[] = []
  for (let round = 0; round < 5; round += 1) {
    state = project(state, { sadness: 0.95 })
    history.push(state.sad)
    assert.ok(state.sad <= CAP, `第 ${round + 1} 轮 sad 超过 CAP: ${state.sad}`)
    assert.ok(state.sad >= 0)
  }
  for (let index = 1; index < history.length; index += 1) {
    assert.ok(
      (history[index] as number) > (history[index - 1] as number),
      `sad 应严格单调上升: ${history.join(' → ')}`,
    )
  }
  close(history[0] as number, STEP_MAX)
  close(history[1] as number, STEP_MAX + STEP_MAX * DECAY)
  assert.ok((history[4] as number) > 0.9, '5 轮高强度 sad 应接近 CAP')
})

test('验收场景：5 轮 sad 后 10 轮 neutral，sad < 0.2（issue #13）', () => {
  let state = initial({})
  for (let round = 0; round < 5; round += 1) {
    state = project(state, { sadness: 0.95 })
  }
  assert.ok(state.sad > 0.9, `5 轮 sadness 后 sad 应接近 CAP，实际 ${state.sad}`)
  for (let round = 0; round < 10; round += 1) {
    state = project(state, { neutral: 0.95 })
  }
  assert.ok(state.sad < 0.2, `再 10 轮 neutral 后 sad 应 < 0.2，实际 ${state.sad}`)
})

test('10 轮 neutral 后 sad < 0.2（旧情绪被衰减）', () => {
  // 先积累到 0.5，再连续 10 轮 neutral
  let state = initial({ sad: 0.5 })
  for (let round = 0; round < 10; round += 1) {
    state = project(state, { neutral: 0.95 })
  }
  const expected = 0.5 * DECAY ** 10
  close(state.sad, expected)
  assert.ok(state.sad < 0.2, `10 轮 neutral 后 sad 应 < 0.2，实际 ${state.sad}`)
  assert.ok(state.neutral > state.sad)
})

test('无输入时衰减到 0', () => {
  let state = initial({ pleasant: 1, sad: 1, angry: 1, anxious: 1, unwell: 1, neutral: 1 })
  for (let round = 0; round < 200; round += 1) {
    const next = project(state, {})
    for (const dimension of EMOTION_DIMENSIONS) {
      assert.ok(next[dimension] <= state[dimension], `${dimension} 不应上升`)
    }
    state = next
  }
  for (const dimension of EMOTION_DIMENSIONS) {
    assert.ok(state[dimension] < 1e-6, `${dimension} 衰减 200 轮后应≈0，实际 ${state[dimension]}`)
  }
})

test('未知标签 / surprise 代理 / 非法值处理', () => {
  const current = deepFreeze(initial({ sad: 0.5 }))
  // 未知标签：不参与聚合；其余映射标签都低于阈值 → 噪声跳过
  const unknown = { joy: 0.1, bogus: 0.99 } as unknown as Record<string, number>
  assert.deepEqual(project(current, unknown), current)
  // 只有 surprise：映射到 confused（疑问代理），sad 走衰减
  const surpriseOnly = project(current, { surprise: 0.99 })
  close(surpriseOnly.sad, 0.5 * DECAY)
  close(surpriseOnly.confused, STEP_MAX)
  // NaN / Infinity 视为非法值
  assert.deepEqual(project(current, { joy: Number.NaN } as Record<string, number>), initial({ sad: 0.5 * DECAY }))
  assert.deepEqual(project(current, { joy: Number.POSITIVE_INFINITY } as Record<string, number>), initial({ sad: 0.5 * DECAY }))
})

test('doubt 派生信号映射到 confused（疑问）', () => {
  const current = deepFreeze(initial({}))
  const next = project(current, { doubt: 0.9 })
  close(next.confused, STEP_MAX)
  // 其余维度没有输入，走衰减（从 0 开始仍是 0）
  close(next.sad, 0)
})

test('边界值：0 / 1 / 超范围原始分数都会被钳制', () => {
  // 全 0：无信号（0 是合法输入但低于阈值）→ 噪声跳过
  const current = deepFreeze(initial({ pleasant: 0.4 }))
  assert.deepEqual(
    project(current, { joy: 0, sadness: 0, neutral: 0 } as Record<string, number>),
    current,
  )
  // 超范围正数按 1 处理，单轮加分仍受 STEP_MAX 限制
  close(project(emptyProjection(), { sadness: 5 } as Record<string, number>).sad, STEP_MAX)
  // 超范围负数按 0 处理 → 低于阈值 → 噪声跳过
  assert.deepEqual(project(current, { sadness: -3 } as Record<string, number>), current)
  // 全 1：多轮后停在 CAP
  let state = emptyProjection()
  for (let round = 0; round < 50; round += 1) state = project(state, { sadness: 1 })
  assert.equal(state.sad, CAP)
})

test('边界值：入参 current 的越界 / 缺失 / 非法值被规范化', () => {
  const next = project(
    { sad: 2.5, pleasant: -1, angry: Number.NaN } as Partial<Record<EmotionDimension, number>>,
    { joy: 0.9 },
  )
  // sad 从钳制后的 1 衰减；pleasant 从 0 起步；angry 从 0 起步
  close(next.sad, DECAY)
  close(next.pleasant, STEP_MAX)
  close(next.angry, 0)
  // 返回对象一定是完整的 7 维
  assert.deepEqual(Object.keys(next).sort(), [...EMOTION_DIMENSIONS].sort())
  assert.deepEqual(normalizeProjection(null), emptyProjection())
  assert.deepEqual(normalizeProjection(undefined), emptyProjection())
})

test('unwell 只有 disgust/fear 命中时上升，sad 衰减（已解耦）', () => {
  const current = initial({ sad: 0.6 })
  const next = project(current, { disgust: 0.75, fear: 0.9 })
  close(aggregate({ disgust: 0.75, fear: 0.9 }).unwell, 0.75)
  close(next.unwell, Math.min(STEP_MAX, 0.75))
  close(next.sad, 0.6 * DECAY)
  // 纯 sadness 输入：sad 命中，unwell 不命中而衰减
  const sadOnly = project(initial({ unwell: 0.8 }), { sadness: 0.9 })
  close(sadOnly.unwell, 0.8 * DECAY)
  close(sadOnly.sad, STEP_MAX)
})

test('命中维度先衰减再加 min(raw, STEP_MAX)', () => {
  const current = initial({ pleasant: 0.8 })
  // 当前常量下 THRESHOLD(0.2) < STEP_MAX(0.25)，raw 0.6 → 加 0.25 封顶。
  close(project(current, { joy: 0.6 }).pleasant, 0.8 * DECAY + STEP_MAX)
  close(project(current, { joy: 0.31 }).pleasant, 0.8 * DECAY + STEP_MAX)
  // 低于阈值 → 不命中，只衰减（需要本轮存在其它命中维度，否则整轮会被判为噪声跳过）
  const mixed = project(current, { joy: 0.15, sadness: 0.9 })
  close(mixed.pleasant, 0.8 * DECAY)
  close(mixed.sad, STEP_MAX)
})

test('纯函数：不修改入参，始终返回新对象', () => {
  const current = deepFreeze(initial({ sad: 0.5, pleasant: 0.3 }))
  const raw = deepFreeze({ sadness: 0.9, joy: 0.5 } as Record<string, number>)
  const snapshotCurrent = JSON.stringify(current)
  const snapshotRaw = JSON.stringify(raw)
  const next = project(current, raw)
  assert.notEqual(next, current)
  assert.equal(JSON.stringify(current), snapshotCurrent)
  assert.equal(JSON.stringify(raw), snapshotRaw)
  // 噪声分支 / 衰减分支同样不能改入参
  const noisy = project(current, deepFreeze({ sadness: 0.1 } as Record<string, number>))
  assert.notEqual(noisy, current)
  assert.equal(JSON.stringify(current), snapshotCurrent)
  const decayed = project(current, null as unknown as Record<string, number>)
  assert.notEqual(decayed, current)
  assert.equal(JSON.stringify(current), snapshotCurrent)
})

test('clamp01 与 aggregate 的辅助行为', () => {
  assert.equal(clamp01(-0.5), 0)
  assert.equal(clamp01(0.5), 0.5)
  assert.equal(clamp01(1.5), 1)
  assert.equal(clamp01(Number.NaN), 0)
  assert.deepEqual(aggregate(null), emptyProjection())
  assert.deepEqual(aggregate(undefined), emptyProjection())
  assert.deepEqual(aggregate({}), emptyProjection())
})
