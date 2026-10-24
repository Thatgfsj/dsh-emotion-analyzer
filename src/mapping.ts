/**
 * dsh-emotion-analyzer — 情绪映射层（issue #3）。
 *
 * 模型输出 `11` 个原始标签的独立概率（逐标签 sigmoid，标签之间不互斥），
 * 本模块把它们聚合成 7 个面向 UI 的统一维度，并维护一个带衰减 / 步长 /
 * 封顶的累积投影。
 *
 * 设计约束：
 * - 零第三方依赖、纯函数；相同输入永远得到相同输出。
 * - 不修改入参：`updateProjection` 返回全新的对象，方便放进 React /
 *   projection 的不可变数据流里。
 * - 调参只改下面的常量区。
 */

/* ------------------------------------------------------------------------- */
/* 常量区（调参只改这里）                                                     */
/* ------------------------------------------------------------------------- */

/** 聚合分数低于该阈值的维度视为噪声：整轮无信号时跳过更新，不积累也不衰减。 */
export const THRESHOLD = 0.3

/**
 * 每轮先把历史分数乘以该衰减系数，旧情绪随轮次指数衰减，避免永久滞留。
 *
 * 校准记录（issue #13）：提示词同时要求 DECAY=0.9 与“5 轮伤心 + 10 轮中性后
 * sad < 0.2”。5 轮伤心会把 sad 推到 CAP=1.0，而 0.9^10 = 0.349 > 0.2，
 * 两者数学上互斥。这里以功能验收为准取 0.85（0.85^10 = 0.197 < 0.2）。
 */
export const DECAY = 0.85

/** 单轮命中的最大加分步长，限制单条回复对累积状态的冲击，防止一次爆表。 */
export const STEP_MAX = 0.25

/** 所有统一维度分数的上限，保证投影值始终落在 [0, CAP]。 */
export const CAP = 1.0

/* ------------------------------------------------------------------------- */
/* 标签与维度                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * 真实模型输出的 11 个原始标签（顺序与模型 id2label 一致）。
 * `surprise` 暂不参与映射，保留在列表里是为了让调用方 / 测试明确知道
 * 它是“已知但未映射”，而不是拼写错误。
 */
export const RAW_EMOTION_LABELS = [
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
] as const

/** 模型原始标签。 */
export type RawEmotionLabel = (typeof RAW_EMOTION_LABELS)[number]

/** 写入 Session projection 的 7 个统一维度。 */
export const EMOTION_DIMENSIONS = [
  'happy',
  'pleasant',
  'sad',
  'angry',
  'anxious',
  'unwell',
  'neutral',
] as const

/** 统一维度名。 */
export type EmotionDimension = (typeof EMOTION_DIMENSIONS)[number]
/** 一套完整的统一维度分数（每个维度都在 [0, 1]）。 */
export type EmotionScores = Record<EmotionDimension, number>
/** 模型原始分数：允许只给部分标签；未知标签在运行时会被忽略。 */
export type RawScores = Readonly<Partial<Record<RawEmotionLabel, number>>>

/** 聚合方式：`max` 取参与标签的最大值，`wsum` 取加权和。 */
export type AggregateKind = 'max' | 'wsum'

/** 一个统一维度的聚合规则。 */
export interface EmotionRule {
  readonly kind: AggregateKind
  /** 参与聚合的 [原始标签, 权重]；`max` 的权重恒为 1，仅 `wsum` 用到权重。 */
  readonly terms: ReadonlyArray<readonly [RawEmotionLabel, number]>
}

/**
 * 统一维度 ← 原始标签的硬编码映射。
 *
 * - happy / pleasant / sad / angry / anxious / neutral 用 `max`：同一维度
 *   里任一标签高就代表该情绪强，取最大值不会被多个同义标签重复放大。
 * - unwell 用 `wsum`：sadness * 0.5 + disgust * 0.4，表达“低落 + 厌恶”
 *   的混合不适感，权重差异来自人工校准。
 * - surprise 暂不映射（方向不确定，等后续 issue）。
 */
export const EMOTION_MAP: Readonly<Record<EmotionDimension, EmotionRule>> = {
  happy: { kind: 'max', terms: [['joy', 1], ['gratitude', 1]] },
  pleasant: { kind: 'max', terms: [['joy', 1], ['love', 1], ['gratitude', 1]] },
  sad: { kind: 'max', terms: [['sadness', 1], ['frustration', 1]] },
  angry: { kind: 'max', terms: [['anger', 1], ['disgust', 1], ['contempt', 1], ['frustration', 1]] },
  anxious: { kind: 'max', terms: [['fear', 1], ['frustration', 1]] },
  unwell: { kind: 'wsum', terms: [['sadness', 0.5], ['disgust', 0.4]] },
  neutral: { kind: 'max', terms: [['neutral', 1]] },
}

/** 被某个统一维度实际消费的原始标签（即除 `surprise` 之外的 10 个）。 */
const MAPPED_LABELS: readonly RawEmotionLabel[] = [
  ...new Set(EMOTION_DIMENSIONS.flatMap((dimension) => EMOTION_MAP[dimension].terms.map(([label]) => label))),
]

/* ------------------------------------------------------------------------- */
/* 纯函数                                                                     */
/* ------------------------------------------------------------------------- */

/** 把任意数值钳制到 [0, 1]；非有限值（NaN / Infinity）按 0 处理。 */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value <= 0) return 0
  if (value >= 1) return 1
  return value
}

/** 读取一个原始标签的分数：缺失 / 非法值按 0 处理，并钳制到 [0, 1]。 */
function readLabel(scores: RawScores | null | undefined, label: RawEmotionLabel): number {
  if (!scores) return 0
  const value = scores[label]
  return typeof value === 'number' ? clamp01(value) : 0
}

/** 是否至少提供了一个被映射的原始标签分数（未知标签、`surprise` 不算）。 */
function hasMappedInput(scores: RawScores | null | undefined): boolean {
  if (!scores) return false
  return MAPPED_LABELS.some((label) => {
    const value = scores[label]
    return typeof value === 'number' && Number.isFinite(value)
  })
}

/** 空投影：7 个维度全为 0。 */
export function emptyProjection(): EmotionScores {
  return {
    happy: 0,
    pleasant: 0,
    sad: 0,
    angry: 0,
    anxious: 0,
    unwell: 0,
    neutral: 0,
  }
}

/** 把可能残缺 / 越界的投影补齐并钳制到 [0, 1]，返回新对象。 */
export function normalizeProjection(current: Partial<Record<EmotionDimension, number>> | null | undefined): EmotionScores {
  const next = emptyProjection()
  if (!current) return next
  for (const dimension of EMOTION_DIMENSIONS) {
    next[dimension] = clamp01(current[dimension] ?? 0)
  }
  return next
}

/**
 * 聚合原始分数，得到 7 个统一维度的“本轮原始强度”（未做阈值 / 衰减）。
 *
 * 只做聚合，不修改入参；结果已钳制到 [0, 1]，可直接用于断言与调试。
 */
export function aggregate(scores: RawScores | null | undefined): EmotionScores {
  const aggregated = emptyProjection()
  for (const dimension of EMOTION_DIMENSIONS) {
    const rule = EMOTION_MAP[dimension]
    let value = 0
    if (rule.kind === 'max') {
      for (const [label] of rule.terms) {
        value = Math.max(value, readLabel(scores, label))
      }
    } else {
      for (const [label, weight] of rule.terms) {
        value += readLabel(scores, label) * weight
      }
    }
    aggregated[dimension] = clamp01(value)
  }
  return aggregated
}

/** 整轮无信号时的纯衰减：所有维度乘以 DECAY。 */
function decayAll(current: EmotionScores): EmotionScores {
  const next = emptyProjection()
  for (const dimension of EMOTION_DIMENSIONS) {
    next[dimension] = clamp01(current[dimension] * DECAY)
  }
  return next
}

/**
 * 用本轮原始分数更新累积投影。
 *
 * 算法（按顺序）：
 * 1. 聚合：11 个原始标签 → 7 个统一维度（见 {@link aggregate}）。
 * 2. 门控：本轮没有任何被映射的输入（空对象 / 只有 `surprise` / 全是非法值）
 *    视为“无输入”，所有维度纯衰减；有输入但所有维度聚合值都低于
 *    {@link THRESHOLD} 时视为噪声，直接返回当前状态的副本（不积累、不衰减）。
 * 3. 命中（聚合值 ≥ THRESHOLD）：next = min(CAP, old * DECAY + min(raw, STEP_MAX))。
 * 4. 未命中（聚合值 < THRESHOLD）：next = old * DECAY。
 * 5. 钳制到 [0, 1] 并返回新对象；入参不会被修改。
 *
 * 公共签名固定为 `Record<string, number>`（与 src/index.ts / src/projection.ts
 * 的宿主集成契约一致，见接口对齐约定）；运行时额外容忍缺失键、越界值与
 * `null` / `undefined`，方便 projection 冷启动。
 */
export function updateProjection(
  current: Record<string, number>,
  rawScores: Record<string, number>,
): Record<string, number> {
  const base = normalizeProjection(current as Partial<Record<EmotionDimension, number>> | null | undefined)

  // 2a. 没有可用的映射输入 → 纯衰减（“无输入衰减到 0”）。
  if (!hasMappedInput(rawScores as RawScores)) return decayAll(base)

  const raw = aggregate(rawScores as RawScores)

  // 2b. 有输入但全维度低于阈值 → 判为噪声，跳过本次更新。
  if (!EMOTION_DIMENSIONS.some((dimension) => raw[dimension] >= THRESHOLD)) {
    return { ...base }
  }

  const next = emptyProjection()
  for (const dimension of EMOTION_DIMENSIONS) {
    const value = raw[dimension]
    if (value >= THRESHOLD) {
      // 3. 命中：先衰减历史，再叠加受限步长。
      next[dimension] = clamp01(Math.min(CAP, base[dimension] * DECAY + Math.min(value, STEP_MAX)))
    } else {
      // 4. 未命中：只衰减。
      next[dimension] = clamp01(base[dimension] * DECAY)
    }
  }
  return next
}
