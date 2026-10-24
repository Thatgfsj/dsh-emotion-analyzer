/**
 * dsh-emotion-analyzer — 本地 ONNX 推理封装（issue #4）。
 *
 * 职责：
 * - 惰性加载 `onnxruntime-node` 与模型路径（默认 legacy `assets/model-int8.onnx`，
 *   v0.2 由 active 预设传入下载目录）；
 * - 用 `tokenizers`（HF tokenizers 的 Node 绑定）加载 `assets/tokenizer.json`，
 *   输出与 Python fast tokenizer 逐 token 对齐的 ids / attention_mask；
 * - 构造 int64 输入张量，跑出 N 个 logits（N = 模型标签数），逐元素 sigmoid（**不是 softmax**）；
 * - 任何初始化 / 推理失败都降级为空对象 + 日志，绝不把异常抛给宿主；
 * - 单条计时，超过 {@link SLOW_INFERENCE_MS} 打 warning；
 * - `dispose()` 释放 ONNX session。
 *
 * 路径用 `new URL('../assets/...', import.meta.url)`：src/ 下运行与构建后的
 * lib/ 下运行都会指到包根 assets/。
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** 模型文件（默认可被构造参数覆盖）。 */
export const MODEL_PATH = new URL('../assets/model-int8.onnx', import.meta.url)
/** 分词器文件（默认可被构造参数覆盖）。 */
export const TOKENIZER_PATH = new URL('../assets/tokenizer.json', import.meta.url)

/**
 * legacy 模型 id2label 顺序（来自上游 config.json；v0.2 起默认标签，
 * 其他模型通过 `EmotionScorerOptions.labels` 覆盖）。
 * ONNX logits 的第 i 列就是标签数组的第 i 个标签，顺序不能改。
 */
export const EMOTION_LABELS = [
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
export type EmotionLabel = (typeof EMOTION_LABELS)[number]

/** legacy 单条文本的 11 维原始概率（逐标签 sigmoid，各自在 [0, 1]）。 */
export type EmotionScoreMap = Record<EmotionLabel, number>

/** XLM-R 位置编码上限 512 + 2 个特殊 token；超过这个长度必须截断。 */
export const MAX_TOKENS = 512
/** 单条推理耗时告警阈值（毫秒）。 */
export const SLOW_INFERENCE_MS = 200

/* ------------------------------------------------------------------------- */
/* 最小依赖契约（便于单测注入 mock）                                          */
/* ------------------------------------------------------------------------- */

/** int64 输入张量；真实实现是 onnxruntime-node 的 Tensor，mock 用普通对象即可。 */
export interface TensorLike {
  readonly type: 'int64'
  readonly data: BigInt64Array
  readonly dims: readonly number[]
}

/** ONNX session 的最小契约（真实实例与测试假 session 都满足）。 */
export interface SessionLike {
  run(feeds: Record<string, TensorLike>): Promise<Record<string, unknown>>
  release?(): Promise<void>
}

/** 分词结果：ids 与 attention_mask 必须等长。 */
export interface TokenizerEncoding {
  ids: number[]
  attentionMask: number[]
}

/** 分词器的最小契约（真实 tokenizers.Tokenizer 适配后的形态）。 */
export interface TokenizerLike {
  encode(text: string): Promise<TokenizerEncoding>
}

/** 日志出口；测试可注入静音实现。 */
export interface ScorerLogger {
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
  info?(...args: unknown[]): void
}

/** 构造参数：全部可选，测试通过注入 session / tokenizer / 时钟来隔离 I/O。 */
export interface EmotionScorerOptions {
  /** 注入假 session（mock ONNX 输出）；不传则真正加载 onnxruntime-node。 */
  session?: SessionLike
  /** 注入假分词器；不传则真正加载 tokenizers + assets/tokenizer.json。 */
  tokenizer?: TokenizerLike
  /** 模型路径，默认 {@link MODEL_PATH}。 */
  modelPath?: URL | string
  /** 分词器路径，默认 {@link TOKENIZER_PATH}。 */
  tokenizerPath?: URL | string
  /** 模型输出标签顺序（默认 legacy 11 标签）；v0.2 起由模型预设提供。 */
  labels?: readonly string[]
  /** 计时源，默认 `performance.now`。 */
  now?: () => number
  /** 日志出口，默认 `console`。 */
  logger?: ScorerLogger
}

/** 把 URL / 字符串统一成文件系统路径。 */
function toFilePath(target: URL | string): string {
  return typeof target === 'string' ? target : fileURLToPath(target)
}

/* ------------------------------------------------------------------------- */
/* 纯函数：sigmoid 与 logits → 11 维概率                                      */
/* ------------------------------------------------------------------------- */

/**
 * 数值稳定的 sigmoid：`1 / (1 + e^-x)`，不改变 logits 的相对大小。
 *
 * 模型是 11 标签多标签分类（multi_label_classification，BCE 训练），
 * 必须逐元素 sigmoid；用 softmax 会强行归一化、改变 top-1，是错误做法。
 */
export function sigmoid(value: number): number {
  if (Number.isNaN(value)) return 0
  if (value >= 0) return 1 / (1 + Math.exp(-value))
  const exp = Math.exp(value)
  return exp / (1 + exp)
}

/** 把 logits 逐元素 sigmoid 成标签 → 概率的映射；长度不符时返回空对象。 */
export function scoresFromLogits(
  logits: ArrayLike<number>,
  labels: readonly string[] = EMOTION_LABELS,
): Record<string, number> {
  if (logits.length !== labels.length) return {}
  const scores: Record<string, number> = {}
  for (let index = 0; index < labels.length; index += 1) {
    const label = labels[index]
    if (label === undefined) continue
    scores[label] = sigmoid(Number(logits[index] ?? Number.NaN))
  }
  return scores
}

/** 从 ONNX 输出里取 logits：优先名 `logits`，其次名字含 logit 的输出，最后单输出。 */
function extractLogits(outputs: Record<string, unknown>): number[] | undefined {
  const preferred = outputs.logits ?? Object.entries(outputs).find(([name]) => /logits?/i.test(name))?.[1]
  const candidate = preferred ?? (Object.keys(outputs).length === 1 ? Object.values(outputs)[0] : undefined)
  if (!candidate || typeof candidate !== 'object') return undefined
  const data = (candidate as { data?: unknown }).data
  if (data instanceof Float32Array || data instanceof Float64Array) return Array.from(data)
  if (Array.isArray(data)) return data.map((value) => Number(value))
  return undefined
}

/* ------------------------------------------------------------------------- */
/* 分词器                                                                     */
/* ------------------------------------------------------------------------- */

/**
 * 加载 HF tokenizers 的 Node 绑定，并把 API 适配成最小契约。
 *
 * `Tokenizer.fromFile` 直接读上游 `tokenizer.json`（SentencePiece Unigram）；
 * `setTruncation(512)` 与 Python 的 `truncation=True, max_length=512` 对齐。
 * 特殊 token（<s>=0、</s>=2）由 tokenizer 自带的后处理器加入，这里不手工拼。
 */
export async function createTokenizer(tokenizerPath: URL | string = TOKENIZER_PATH): Promise<TokenizerLike> {
  const file = toFilePath(tokenizerPath)
  if (!existsSync(file)) throw new Error(`tokenizer.json 不存在：${file}`)
  const { Tokenizer } = await import('tokenizers')
  const tokenizer = Tokenizer.fromFile(file)
  tokenizer.setTruncation(MAX_TOKENS)
  return {
    async encode(text: string): Promise<TokenizerEncoding> {
      const encoding = await tokenizer.encode(text)
      // 双保险：即使 tokenizer 截断配置漂移，也不会把超长输入送进 ONNX。
      const ids = encoding.getIds().map((id) => Number(id)).slice(0, MAX_TOKENS)
      const mask = encoding
        .getAttentionMask()
        .map((flag) => Number(flag))
        .slice(0, MAX_TOKENS)
      const attentionMask = mask.length === ids.length ? mask : ids.map(() => 1)
      return { ids, attentionMask }
    },
  }
}

/* ------------------------------------------------------------------------- */
/* EmotionScorer                                                              */
/* ------------------------------------------------------------------------- */

/**
 * 惰性单例的情绪打分器。
 *
 * 典型用法（宿主插件）：
 * ```ts
 * const scorer = new EmotionScorer()
 * if (await scorer.init()) console.log(await scorer.score('今天真开心'))
 * await scorer.dispose()
 * ```
 *
 * 所有失败都降级为 `{}` + 日志，调用方不需要 try/catch。
 */
export class EmotionScorer {
  private session: SessionLike | undefined
  private tokenizer: TokenizerLike | undefined
  private tensorCtor: ((type: 'int64', data: BigInt64Array, dims: number[]) => TensorLike) | undefined
  private ready = false
  private initPromise: Promise<boolean> | undefined
  private modelPath: string
  private tokenizerPath: string
  private labels: readonly string[]
  private readonly now: () => number
  private readonly logger: ScorerLogger

  constructor(options: EmotionScorerOptions = {}) {
    this.session = options.session
    this.tokenizer = options.tokenizer
    this.modelPath = toFilePath(options.modelPath ?? MODEL_PATH)
    this.tokenizerPath = toFilePath(options.tokenizerPath ?? TOKENIZER_PATH)
    this.labels = options.labels ?? EMOTION_LABELS
    this.now = options.now ?? (() => performance.now())
    this.logger = options.logger ?? console
  }

  /** 当前模型标签顺序（只读）。 */
  get labelCount(): number {
    return this.labels.length
  }

  /** 是否已完成初始化（session + tokenizer 都就绪）。 */
  get isReady(): boolean {
    return this.ready
  }

  /**
   * 惰性初始化：加载 ONNX session 与 tokenizer。
   *
   * @returns 成功 `true`；失败 `false`（已打日志，不抛异常）。
   */
  async init(): Promise<boolean> {
    if (this.ready) return true
    this.initPromise ??= this.initialize().catch((error: unknown) => {
      this.logger.error('[emotion] 初始化异常，情绪打分降级：', error)
      return false
    })
    return this.initPromise
  }

  private async initialize(): Promise<boolean> {
    if (!this.session) {
      if (!existsSync(this.modelPath)) {
        this.logger.warn(
          `[emotion] 模型文件缺失：${this.modelPath}。情绪打分降级为 ` +
            'score() 返回 {}；请先运行 python3 scripts/export_model.py 生成 assets。',
        )
        return false
      }
      try {
        const ort = await import('onnxruntime-node')
        this.tensorCtor = (type, data, dims) => new ort.Tensor(type, data, dims) as unknown as TensorLike
        this.session = (await ort.InferenceSession.create(this.modelPath)) as unknown as SessionLike
      } catch (error) {
        this.logger.error('[emotion] 创建 ONNX InferenceSession 失败，情绪打分降级：', error)
        return false
      }
    }

    if (!this.tokenizer) {
      if (!existsSync(this.tokenizerPath)) {
        this.logger.warn(`[emotion] 分词器文件缺失：${this.tokenizerPath}。情绪打分降级为 score() 返回 {}。`)
        return false
      }
      try {
        this.tokenizer = await createTokenizer(this.tokenizerPath)
      } catch (error) {
        this.logger.error('[emotion] 加载 tokenizer 失败，情绪打分降级：', error)
        return false
      }
    }

    this.ready = true
    return true
  }

  /**
   * 对一条文本打分。
   *
   * @returns 11 个标签的 [0, 1] 概率；空文本 / 未初始化 / 推理失败返回 `{}`。
   */
  async score(text: string): Promise<Record<string, number>> {
    if (typeof text !== 'string' || text.trim().length === 0) return {}
    try {
      if (!(await this.init())) return {}
      const startedAt = this.now()
      try {
        return await this.runInference(text)
      } finally {
        const elapsedMs = this.now() - startedAt
        if (elapsedMs > SLOW_INFERENCE_MS) {
          this.logger.warn(
            `[emotion] 单条推理耗时 ${Math.round(elapsedMs)}ms，超过 ${SLOW_INFERENCE_MS}ms 预算（模型 INT8 / CPU）。`,
          )
        }
      }
    } catch (error) {
      this.logger.error('[emotion] 情绪推理失败，本轮降级为空结果：', error)
      return {}
    }
  }

  private async runInference(text: string): Promise<Record<string, number>> {
    const tokenizer = this.tokenizer
    const session = this.session
    if (!tokenizer || !session) return {}

    const encoded = await tokenizer.encode(text)
    // 双保险截断：真实分词器已 setTruncation(512)，但注入的分词器 / 配置漂移
    // 也不允许把 > 512 的序列送进 ONNX（XLM-R 位置编码上限 514）。
    const ids = encoded.ids.slice(0, MAX_TOKENS)
    const mask = encoded.attentionMask.slice(0, MAX_TOKENS)
    const attentionMask = mask.length === ids.length ? mask : ids.map(() => 1)
    if (ids.length === 0) {
      this.logger.warn('[emotion] 分词结果为空，跳过本轮打分。')
      return {}
    }

    const feeds: Record<string, TensorLike> = {
      input_ids: this.createInt64Tensor(ids),
      attention_mask: this.createInt64Tensor(attentionMask),
    }
    const outputs = await session.run(feeds)
    const logits = extractLogits(outputs)
    if (!logits) {
      this.logger.warn('[emotion] ONNX 输出中没有可用的 logits，跳过本轮打分。')
      return {}
    }
    if (logits.length !== this.labels.length) {
      this.logger.warn(`[emotion] logits 维度 ${logits.length} ≠ 标签数 ${this.labels.length}，跳过本轮打分。`)
      return {}
    }
    return scoresFromLogits(logits, this.labels)
  }

  /** 构造 int64 张量；真实 session 用 onnxruntime-node 的 Tensor，mock 用普通对象。 */
  private createInt64Tensor(values: readonly number[]): TensorLike {
    const data = new BigInt64Array(values.length)
    for (let index = 0; index < values.length; index += 1) {
      data[index] = BigInt(Math.trunc(values[index] ?? 0))
    }
    const dims = [1, data.length]
    if (this.tensorCtor) return this.tensorCtor('int64', data, dims)
    return { type: 'int64', data, dims }
  }

  /**
   * 切换模型：先释放旧 session，再按新路径 / 标签重新初始化。
   *
   * @param options - 新模型配置；未提供的字段保持当前值。
   * @returns 新模型是否初始化成功（失败已打日志，不抛）。
   */
  async switchModel(
    options: Pick<EmotionScorerOptions, 'modelPath' | 'tokenizerPath' | 'labels'>,
  ): Promise<boolean> {
    await this.dispose()
    if (options.modelPath !== undefined) this.modelPath = toFilePath(options.modelPath)
    if (options.tokenizerPath !== undefined) this.tokenizerPath = toFilePath(options.tokenizerPath)
    if (options.labels !== undefined) this.labels = options.labels
    return this.init()
  }

  /** 释放 ONNX session 与 tokenizer；可重复调用。 */
  async dispose(): Promise<void> {
    const session = this.session
    this.session = undefined
    this.tokenizer = undefined
    this.tensorCtor = undefined
    this.ready = false
    this.initPromise = undefined
    if (session?.release) {
      try {
        await session.release()
      } catch (error) {
        this.logger.warn('[emotion] 释放 ONNX session 失败：', error)
      }
    }
  }
}

/* ------------------------------------------------------------------------- */
/* 模块级单例（宿主集成用）                                                   */
/* ------------------------------------------------------------------------- */

let singleton: EmotionScorer | undefined

/** 取得进程级单例（惰性创建；不会自动 init）。 */
export function getEmotionScorer(options?: EmotionScorerOptions): EmotionScorer {
  singleton ??= new EmotionScorer(options)
  return singleton
}

/** 单例便捷打分：内部会惰性 init；任何失败返回 `{}`。 */
export async function scoreEmotion(text: string): Promise<Record<string, number>> {
  return getEmotionScorer().score(text)
}

/** 释放并清空进程级单例（插件卸载 / 测试收尾）。 */
export async function dispose(): Promise<void> {
  const scorer = singleton
  singleton = undefined
  if (scorer) await scorer.dispose()
}
