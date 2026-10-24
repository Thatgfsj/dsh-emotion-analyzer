/**
 * 本地 ONNX 推理封装单元测试（issue #4）。
 *
 * 运行：`npm test`（Node 24 原生执行 TS）。
 *
 * 分三层：
 * 1. 纯函数：sigmoid / logits → 11 维概率（逐元素，不是 softmax）；
 * 2. mock 注入：假 session + 假 tokenizer 验证 int64 张量、截断、异常降级、计时；
 * 3. 真实资产（可选）：assets/ 存在时跑真实模型；tokenizer 对齐读取
 *    tests/fixtures/tokenizer-reference.json（模型同事提交）。资产/fixture
 *    不存在时显式 skip 并打印原因，不伪造通过。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

import {
  EMOTION_LABELS,
  MAX_TOKENS,
  MODEL_PATH,
  SLOW_INFERENCE_MS,
  TOKENIZER_PATH,
  EmotionScorer,
  createTokenizer,
  dispose as disposeSingleton,
  getEmotionScorer,
  scoresFromLogits,
  sigmoid,
  type ScorerLogger,
  type SessionLike,
  type TensorLike,
  type TokenizerLike,
} from '../src/inference.ts'

/** 浮点近似断言。 */
function close(actual: number, expected: number, epsilon = 1e-9, message?: string): void {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    message ?? `expected ${actual} ≈ ${expected} (±${epsilon})`,
  )
}

/** 取一个标签的分数并断言存在（noUncheckedIndexedAccess 下返回 number | undefined）。 */
function at(scores: Record<string, number>, label: string): number {
  const value = scores[label]
  assert.equal(typeof value, 'number', `分数里缺少标签 ${label}`)
  return value as number
}

/** 记录日志的 logger，测试里用来断言“打了日志但没有抛”。 */
function captureLogger(): { logger: ScorerLogger; warns: string[]; errors: string[] } {
  const warns: string[] = []
  const errors: string[] = []
  const stringify = (args: unknown[]): string =>
    args.map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : String(arg))).join(' ')
  return {
    warns,
    errors,
    logger: {
      warn: (...args: unknown[]) => warns.push(stringify(args)),
      error: (...args: unknown[]) => errors.push(stringify(args)),
    },
  }
}

/** 假装分词器：返回固定的 ids / attention_mask。 */
function stubTokenizer(ids: number[] = [0, 5, 2], attentionMask?: number[]): TokenizerLike {
  const mask = attentionMask ?? ids.map(() => 1)
  return {
    async encode() {
      return { ids: [...ids], attentionMask: [...mask] }
    },
  }
}

/** 假装 session：记录收到的 feeds，返回给定 logits。 */
function captureSession(logits: number[]): {
  session: SessionLike
  feeds: () => Record<string, TensorLike> | undefined
} {
  let captured: Record<string, TensorLike> | undefined
  return {
    feeds: () => captured,
    session: {
      async run(feeds: Record<string, TensorLike>) {
        captured = feeds
        return { logits: { data: Float32Array.from(logits) } }
      },
    },
  }
}

/** 用固定输出构造一个“已就绪”的 scorer，避免测试碰到真实模型。 */
function mockScorer(logits: number[], options: { now?: () => number; logger?: ScorerLogger } = {}): {
  scorer: EmotionScorer
  feeds: () => Record<string, TensorLike> | undefined
} {
  const capture = captureSession(logits)
  const scorer = new EmotionScorer({
    session: capture.session,
    tokenizer: stubTokenizer(),
    now: options.now,
    logger: options.logger,
  })
  return { scorer, feeds: capture.feeds }
}

test('标签顺序与上游 config.json 的 id2label 一致', () => {
  assert.deepEqual(EMOTION_LABELS, [
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
  assert.equal(MAX_TOKENS, 512)
  assert.equal(SLOW_INFERENCE_MS, 200)
})

test('sigmoid 是逐元素概率，不是 softmax（不归一化）', () => {
  const logits = [0, 1, -1, 2, -2, 0.5, -0.5, 3, -3, 0.25, 0]
  const scores = scoresFromLogits(logits)
  assert.equal(Object.keys(scores).length, EMOTION_LABELS.length)
  for (let index = 0; index < EMOTION_LABELS.length; index += 1) {
    const label = EMOTION_LABELS[index] as string
    close(at(scores, label), sigmoid(logits[index] as number))
    assert.ok(at(scores, label) >= 0 && at(scores, label) <= 1)
  }
  // 逐元素 sigmoid 的总和不是 1；softmax 才会被强行归一化
  const sum = Object.values(scores).reduce((total, value) => total + value, 0)
  assert.ok(sum > 1.1, `11 个独立 sigmoid 的概率和应远大于 1（实际 ${sum}）`)
  assert.ok(Math.abs(sum - 1) > 0.1, `不能是 softmax 的归一化结果（实际和 ${sum}）`)
  // 维度不对时安全返回空对象
  assert.deepEqual(scoresFromLogits([0.1, 0.2]), {})
})

test('score() 返回 11 维 [0,1] 分数，标签顺序正确', async () => {
  const logits = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  const { scorer } = mockScorer(logits)
  assert.equal(await scorer.init(), true)
  assert.equal(scorer.isReady, true)
  const scores = await scorer.score('今天真的很开心')
  assert.equal(Object.keys(scores).length, 11)
  for (let index = 0; index < EMOTION_LABELS.length; index += 1) {
    const label = EMOTION_LABELS[index] as string
    close(at(scores, label), sigmoid(logits[index] as number))
    assert.ok(at(scores, label) >= 0 && at(scores, label) <= 1)
  }
  close(at(scores, 'anger'), 0.5)
  assert.ok(at(scores, 'surprise') > 0.9999)
})

test('int64 张量使用 BigInt64Array，超过 512 token 被截断', async () => {
  const longIds = Array.from({ length: MAX_TOKENS + 88 }, (_, index) => index + 1)
  const capture = captureSession(new Array(11).fill(0))
  const capturing = new EmotionScorer({
    session: capture.session,
    tokenizer: stubTokenizer(longIds),
    logger: captureLogger().logger,
    now: () => 0,
  })
  await capturing.score('x'.repeat(2000))
  const feeds = capture.feeds()
  assert.ok(feeds, 'session 应该收到 feeds')
  const inputIds = feeds?.input_ids as TensorLike
  const attentionMask = feeds?.attention_mask as TensorLike
  assert.equal(inputIds.type, 'int64')
  assert.equal(attentionMask.type, 'int64')
  assert.ok(inputIds.data instanceof BigInt64Array)
  assert.ok(attentionMask.data instanceof BigInt64Array)
  assert.deepEqual(inputIds.dims, [1, MAX_TOKENS])
  assert.deepEqual(attentionMask.dims, [1, MAX_TOKENS])
  assert.equal(inputIds.data.length, MAX_TOKENS)
  assert.equal(inputIds.data[0], 1n)
  assert.equal(inputIds.data[1], 2n)
  assert.equal(inputIds.data[MAX_TOKENS - 1], BigInt(MAX_TOKENS))
  assert.equal(attentionMask.data[0], 1n)
})

test('空文本 / 空白文本直接返回 {}，不触发初始化与推理', async () => {
  const { logger, warns, errors } = captureLogger()
  const scorer = new EmotionScorer({
    logger,
    session: {
      async run() {
        throw new Error('不应该被调用')
      },
    },
    tokenizer: stubTokenizer(),
    now: () => 0,
  })
  assert.deepEqual(await scorer.score(''), {})
  assert.deepEqual(await scorer.score('   \n\t '), {})
  assert.deepEqual(warns, [])
  assert.deepEqual(errors, [])
})

test('模型/分词器缺失时 init 返回 false 且 score 降级为 {}（不抛）', async () => {
  const { logger, warns } = captureLogger()
  const scorer = new EmotionScorer({
    modelPath: '/nonexistent/dsh-emotion/model-int8.onnx',
    tokenizerPath: '/nonexistent/dsh-emotion/tokenizer.json',
    logger,
    now: () => 0,
  })
  assert.equal(await scorer.init(), false)
  assert.equal(scorer.isReady, false)
  assert.ok(warns.some((message) => message.includes('模型文件缺失')), `应提示模型缺失：${warns.join(' | ')}`)
  assert.deepEqual(await scorer.score('hello'), {})
})

test('推理异常不抛：session.run 抛错 → {} + console.error', async () => {
  const { logger, errors } = captureLogger()
  const scorer = new EmotionScorer({
    session: {
      async run() {
        throw new Error('boom')
      },
    },
    tokenizer: stubTokenizer(),
    logger,
    now: () => 0,
  })
  const scores = await scorer.score('hello')
  assert.deepEqual(scores, {})
  assert.equal(errors.length, 1)
  assert.ok(errors[0]?.includes('boom'), `错误日志应包含原因：${errors[0]}`)
})

test('ONNX 输出缺失 / logits 维度不符时降级为 {} + warning', async () => {
  const emptyOutput = new EmotionScorer({
    session: { async run() { return {} } },
    tokenizer: stubTokenizer(),
    logger: captureLogger().logger,
    now: () => 0,
  })
  assert.deepEqual(await emptyOutput.score('hello'), {})

  const { logger, warns } = captureLogger()
  const badLogits = new EmotionScorer({
    session: { async run() { return { logits: { data: Float32Array.from([0.1, 0.2]) } } } },
    tokenizer: stubTokenizer(),
    logger,
    now: () => 0,
  })
  assert.deepEqual(await badLogits.score('hello'), {})
  assert.ok(warns.some((message) => message.includes('维度')), `应提示 logits 维度不符：${warns.join(' | ')}`)
})

test('单条推理 > 200ms 打 warning，正常耗时静默', async () => {
  const slow = captureLogger()
  const ticks = [1000, 1000 + SLOW_INFERENCE_MS + 24]
  const slowScorer = mockScorer(new Array(11).fill(0), {
    logger: slow.logger,
    now: () => ticks.shift() ?? 0,
  }).scorer
  await slowScorer.score('hello')
  assert.ok(
    slow.warns.some((message) => message.includes('耗时')),
    `超过预算应打 warning：${slow.warns.join(' | ')}`,
  )

  const fast = captureLogger()
  const fastScorer = mockScorer(new Array(11).fill(0), { logger: fast.logger, now: () => 0 }).scorer
  await fastScorer.score('hello')
  assert.deepEqual(fast.warns, [])
})

test('dispose() 释放 session 且可重复调用', async () => {
  let released = 0
  const scorer = new EmotionScorer({
    session: {
      async run() { return { logits: { data: new Float32Array(11) } } },
      async release() { released += 1 },
    },
    tokenizer: stubTokenizer(),
    logger: captureLogger().logger,
    now: () => 0,
  })
  assert.equal(await scorer.init(), true)
  await scorer.dispose()
  assert.equal(released, 1)
  assert.equal(scorer.isReady, false)
  await scorer.dispose()
  assert.equal(released, 1, '重复 dispose 不应重复 release')
})

test('进程级单例：getEmotionScorer 复用实例，dispose 后重建', async () => {
  const first = getEmotionScorer()
  assert.equal(getEmotionScorer(), first)
  await disposeSingleton()
  assert.notEqual(getEmotionScorer(), first)
  await disposeSingleton()
})

test('tokenizer 与 Python fast tokenizer 逐 token 对齐（需要 fixture + assets）', async (t) => {
  const fixturePath = new URL('./fixtures/tokenizer-reference.json', import.meta.url)
  if (!existsSync(fixturePath)) {
    const reason =
      'tests/fixtures/tokenizer-reference.json 不存在（由模型导出同事提交）；' +
      '跳过 tokenizer 对齐测试，避免伪造通过。'
    console.warn(reason)
    t.skip(reason)
    return
  }
  if (!existsSync(TOKENIZER_PATH)) {
    const reason = `${String(TOKENIZER_PATH)} 不存在；请先运行 python3 scripts/export_model.py 生成 tokenizer.json。`
    console.warn(reason)
    t.skip(reason)
    return
  }

  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
    cases?: Array<{ text: string; ids: number[]; attention_mask: number[] }>
  }
  const cases = fixture.cases ?? []
  assert.ok(cases.length > 0, 'fixture 至少包含一个 case')

  const tokenizer = await createTokenizer(TOKENIZER_PATH)
  for (const [index, item] of cases.entries()) {
    const { ids, attentionMask } = await tokenizer.encode(item.text)
    assert.deepEqual(ids, item.ids, `case ${index + 1} ids 与 Python 不一致：${item.text}`)
    assert.deepEqual(attentionMask, item.attention_mask, `case ${index + 1} attention_mask 不一致：${item.text}`)
    // XLM-R 特殊 token：<s>=0 开头、</s>=2 结尾，由 tokenizer 后处理器加入
    assert.equal(ids[0], 0, `case ${index + 1} 缺少 <s>`)
    assert.equal(ids[ids.length - 1], 2, `case ${index + 1} 缺少 </s>`)
  }
})

test('真实模型端到端：assets 存在时返回 11 维 [0,1] 分数（否则 skip）', async (t) => {
  if (!existsSync(MODEL_PATH) || !existsSync(TOKENIZER_PATH)) {
    const reason =
      'assets/model-int8.onnx 或 assets/tokenizer.json 不存在（权重不入库）；' +
      '跳过真实模型端到端测试。mock 测试已覆盖接口与降级，tokenizer 对齐见上一条。'
    console.warn(reason)
    t.skip(reason)
    return
  }
  const { logger, warns, errors } = captureLogger()
  const scorer = new EmotionScorer({ logger })
  try {
    assert.equal(await scorer.init(), true)
    const samples = ['我今天真的很开心，feels great！', 'I feel 有点难过 today, not gonna lie.']
    for (const sample of samples) {
      const scores = await scorer.score(sample)
      assert.equal(Object.keys(scores).length, 11, `${sample} 应返回 11 个标签`)
      for (const label of EMOTION_LABELS) {
        const value = at(scores, label)
        assert.ok(value >= 0 && value <= 1, `${label} 分数 ${value} 越界`)
      }
      assert.ok(Object.values(scores).some((value) => value > 0.5), '至少一个标签置信度 > 0.5')
    }
    assert.deepEqual(errors, [])
    // 首次调用包含模型加载，不应被 200ms 单条推理预算误报；后续调用可能因机器慢告警，允许存在。
    void warns
  } finally {
    await scorer.dispose()
  }
})
test('自定义 labels：按模型标签数组输出分数，列数不符时降级', async () => {
  const { logger } = captureLogger()
  const session: SessionLike = {
    async run() {
      return { logits: { data: Float32Array.from([0, 1, 2]) } }
    },
  }
  const scorer = new EmotionScorer({
    session,
    tokenizer: stubTokenizer(),
    labels: ['alpha', 'beta', 'gamma'],
    now: () => 0,
    logger,
  })
  assert.equal(await scorer.init(), true)
  assert.equal(scorer.labelCount, 3)
  const scores = await scorer.score('hello')
  assert.deepEqual(Object.keys(scores).sort(), ['alpha', 'beta', 'gamma'])
  close(at(scores, 'alpha'), sigmoid(0))
  close(at(scores, 'beta'), sigmoid(1))
  close(at(scores, 'gamma'), sigmoid(2))

  const mismatched = new EmotionScorer({
    session,
    tokenizer: stubTokenizer(),
    labels: ['only-two', 'labels'],
    now: () => 0,
    logger,
  })
  assert.deepEqual(await mismatched.score('hello'), {})
})
