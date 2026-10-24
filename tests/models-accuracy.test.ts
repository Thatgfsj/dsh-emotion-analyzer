/**
 * 真实模型精度回归（v0.2 / issue #39）。
 *
 * - legacy 40/40：assets 存在时运行（本地/发布机），否则显式 skip；
 * - Horizon small ≥ 90%：通过 `DSH_EMOTION_HORIZON_DIR` 指向已下载目录
 *   （含 model_quantized.onnx + tokenizer.json）时运行，否则显式 skip。
 *
 * 40 条 CASES 复用 `scripts/validate.py` 的固定测试集与 tie-break 顺序，
 * 避免两套验收数据漂移。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { EmotionScorer, MODEL_PATH, TOKENIZER_PATH } from '../src/inference.ts'
import { GO_EMOTION_LABELS, MAPPING_PROFILES, type MappingProfileId } from '../src/models/profiles.ts'
import { EMOTION_DIMENSIONS } from '../src/mapping.ts'

const TIE_ORDER = ['pleasant', 'sad', 'angry', 'anxious', 'unwell', 'confused', 'neutral'] as const

interface CaseRow {
  lang: string
  expected: string
  text: string
}

/** 读取 validate.py 里的固定 40 条 CASES（单一数据源）。 */
function loadCases(): CaseRow[] {
  const source = readFileSync(new URL('../scripts/validate.py', import.meta.url), 'utf8')
  const pattern = /^\s*\("(zh|en)",\s*"([a-z]+)",\s*"([^"]+)"\),\s*$/gm
  const cases = [...source.matchAll(pattern)].map((match) => ({
    lang: match[1] as string,
    expected: match[2] as string,
    text: match[3] as string,
  }))
  assert.equal(cases.length, 40, 'validate.py CASES 解析失败')
  return cases
}

function topUnified(scores: Record<string, number>): string {
  const best = Math.max(...TIE_ORDER.map((dimension) => scores[dimension] ?? 0))
  for (const dimension of TIE_ORDER) {
    if (best - (scores[dimension] ?? 0) <= 1e-9) return dimension
  }
  return 'neutral'
}

async function accuracyOf(options: {
  modelPath: URL | string
  tokenizerPath: URL | string
  labels: readonly string[]
  profileId: MappingProfileId
}): Promise<{ correct: number; total: number; misses: CaseRow[]; medianMs: number }> {
  const profile = MAPPING_PROFILES[options.profileId]
  const scorer = new EmotionScorer({
    modelPath: options.modelPath,
    tokenizerPath: options.tokenizerPath,
    labels: [...options.labels],
    logger: { warn: () => undefined, error: () => undefined },
  })
  try {
    assert.equal(await scorer.init(), true)
    const cases = loadCases()
    const misses: CaseRow[] = []
    const latencies: number[] = []
    for (const item of cases) {
      const started = performance.now()
      const raw = await scorer.score(item.text)
      latencies.push(performance.now() - started)
      assert.ok(Object.keys(raw).length > 0, `打分失败：${item.text}`)
      // raw 的标签数必须与 profile 一致（防止用错模型 / 标签顺序）
      assert.equal(Object.keys(raw).length, options.labels.length)
      const predicted = topUnified(profile.aggregate(raw) as Record<string, number>)
      if (predicted !== item.expected) misses.push(item)
    }
    latencies.sort((a, b) => a - b)
    return {
      correct: cases.length - misses.length,
      total: cases.length,
      misses,
      medianMs: latencies[Math.floor(latencies.length / 2)] ?? 0,
    }
  } finally {
    await scorer.dispose()
  }
}

test('legacy 40 条保持 40/40（assets 存在时）', async (t) => {
  if (!existsSync(MODEL_PATH) || !existsSync(TOKENIZER_PATH)) {
    const reason = 'assets/model-int8.onnx 或 assets/tokenizer.json 不存在；跳过 legacy 精度回归。'
    console.warn(reason)
    t.skip(reason)
    return
  }
  const result = await accuracyOf({
    modelPath: MODEL_PATH,
    tokenizerPath: TOKENIZER_PATH,
    labels: MAPPING_PROFILES['legacy-11'].labels,
    profileId: 'legacy-11',
  })
  console.log(`[legacy] ${result.correct}/${result.total}, median ${result.medianMs.toFixed(2)}ms`)
  assert.deepEqual(result.misses, [])
  assert.equal(result.correct, 40)
})

test('Horizon small 40 条 ≥90%（DSH_EMOTION_HORIZON_DIR）', async (t) => {
  const dir = process.env['DSH_EMOTION_HORIZON_DIR']
  if (dir === undefined || dir.length === 0) {
    const reason =
      '未设置 DSH_EMOTION_HORIZON_DIR（指向含 model_quantized.onnx + tokenizer.json 的目录）；跳过 Horizon 精度回归。'
    console.warn(reason)
    t.skip(reason)
    return
  }
  const modelPath = join(dir, 'model_quantized.onnx')
  const tokenizerPath = join(dir, 'tokenizer.json')
  if (!existsSync(modelPath) || !existsSync(tokenizerPath)) {
    const reason = `${dir} 下缺少 model_quantized.onnx / tokenizer.json；跳过 Horizon 精度回归。`
    console.warn(reason)
    t.skip(reason)
    return
  }
  const result = await accuracyOf({
    modelPath,
    tokenizerPath,
    labels: GO_EMOTION_LABELS,
    profileId: 'go-emotions-28',
  })
  console.log(
    `[horizon-small] ${result.correct}/${result.total} = ${((result.correct / result.total) * 100).toFixed(1)}%, ` +
      `median ${result.medianMs.toFixed(2)}ms, misses=${JSON.stringify(result.misses.map((item) => item.text))}`,
  )
  assert.ok(result.correct / result.total >= 0.9, `Horizon small 准确率 ${result.correct}/${result.total} < 90%`)
  assert.ok(result.medianMs < 200, `Horizon small 中位延迟 ${result.medianMs}ms 超过 200ms`)
})

test('profile 维度与 projection 维度一致（7 维）', () => {
  for (const id of Object.keys(MAPPING_PROFILES) as MappingProfileId[]) {
    const scores = MAPPING_PROFILES[id].aggregate({})
    assert.deepEqual(Object.keys(scores).sort(), [...EMOTION_DIMENSIONS].sort())
  }
})
