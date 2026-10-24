/**
 * 模型预设注册表（v0.2 / issue #39）。
 *
 * 纯静态数据 + 纯函数，不访问网络 / 磁盘；下载与状态由
 * `src/models/manager.ts` 负责，激活与回退由 `src/models/service.ts` 负责。
 *
 * 体积/文件大小均来自 Hugging Face HEAD 实测（2026-10-25）：
 * - Horizon small: onnx 268,449,278 B / tokenizer 34,363,286 B / config 3,155 B
 * - Horizon base : onnx 641,205,891 B / tokenizer 34,363,286 B / config 3,156 B
 * - Chinese-Emotion-Small: 无官方 ONNX（needsExport），tokenizer 16,316,379 B
 */
import { RAW_EMOTION_LABELS } from '../mapping.ts'
import {
  GO_EMOTION_LABELS,
  ZH_EMOTION_LABELS,
  type MappingProfileId,
} from './profiles.ts'

/** 默认模型；它未下载时 service 会回退到 legacy assets。 */
export const DEFAULT_MODEL_ID = 'horizon-small'
/** 内置 legacy 模型 id（回退目标，不允许删除）。 */
export const LEGACY_MODEL_ID = 'legacy-tabularisai'

/** 模型预设 id。 */
export type ModelPresetId = 'horizon-small' | 'horizon-base' | 'legacy-tabularisai' | 'zh-johnson-small'

/** 一个预设包含的下载 / 本地文件。 */
export interface ModelPresetFile {
  /** 相对模型目录的路径（例如 `onnx/model_quantized.onnx`）。 */
  readonly path: string
  readonly role: 'model' | 'tokenizer' | 'config'
  readonly url?: string
  /** 已知的文件字节数；0 / 未提供表示未知。 */
  readonly sizeBytes?: number
}

/** 预设的下载 URL（legacy 没有 URL，使用包内 assets）。 */
export interface ModelPresetUrls {
  readonly model?: string
  readonly tokenizer?: string
  readonly config?: string
}

/** 一个模型预设的完整描述。 */
export interface ModelPreset {
  readonly id: ModelPresetId
  readonly name: string
  readonly repo: string
  readonly license: string
  /** 模型文件字节数（UI 展示用；0 = 未导出/未知）。 */
  readonly sizeBytes: number
  /** 支持语言（ISO 代码；多语言模型按上游 model card）。 */
  readonly languages: readonly string[]
  /** 模型输出标签，顺序必须与 id2label 一致。 */
  readonly labels: readonly string[]
  readonly mappingProfile: MappingProfileId
  /** 是否为默认模型。 */
  readonly default?: boolean
  /** 没有现成 ONNX，需要用脚本导出（不阻塞下载以外的默认流程）。 */
  readonly needsExport?: boolean
  readonly urls: ModelPresetUrls
  readonly files: readonly ModelPresetFile[]
  /** legacy 预设的包内资产（相对包根）。 */
  readonly local?: {
    readonly model: URL
    readonly tokenizer: URL
  }
}

/** 构造 Hugging Face `resolve/main` 下载地址。 */
function resolveUrl(repo: string, path: string): string {
  return `https://huggingface.co/${repo}/resolve/main/${path}`
}

/** 构造一个可下载模型的文件列表。 */
function downloadFiles(options: {
  repo: string
  modelPath: string
  modelSize: number
  tokenizerSize: number
  configSize: number
}): { urls: ModelPresetUrls; files: readonly ModelPresetFile[] } {
  const urls: ModelPresetUrls = {
    model: resolveUrl(options.repo, options.modelPath),
    tokenizer: resolveUrl(options.repo, 'tokenizer.json'),
    config: resolveUrl(options.repo, 'config.json'),
  }
  const files: readonly ModelPresetFile[] = [
    { path: options.modelPath, role: 'model', url: urls.model, sizeBytes: options.modelSize },
    { path: 'tokenizer.json', role: 'tokenizer', url: urls.tokenizer, sizeBytes: options.tokenizerSize },
    { path: 'config.json', role: 'config', url: urls.config, sizeBytes: options.configSize },
  ]
  return { urls, files }
}

const HORIZON_SMALL_REPO = 'Horizon-Labs/multilingual-emotions-small'
const HORIZON_BASE_REPO = 'Horizon-Labs/multilingual-emotions-base'
const ZH_REPO = 'Johnson8187/Chinese-Emotion-Small'

/** Horizon 系列支持的 36 种语言代码（上游 model card；multilingual 是标签不是语言）。 */
const HORIZON_LANGUAGES = [
  'en',
  'de',
  'fr',
  'es',
  'pt',
  'it',
  'nl',
  'pl',
  'ru',
  'uk',
  'cs',
  'ro',
  'sv',
  'da',
  'no',
  'fi',
  'hu',
  'el',
  'tr',
  'ar',
  'he',
  'fa',
  'hi',
  'mr',
  'bn',
  'ur',
  'zh',
  'ja',
  'ko',
  'vi',
  'th',
  'id',
  'sw',
  'af',
  'tt',
  'ha',
] as const

/** legacy tabularisai 支持的 23 种语言（上游 model card）。 */
const LEGACY_LANGUAGES = [
  'en',
  'zh',
  'es',
  'hi',
  'ar',
  'bn',
  'pt',
  'ru',
  'ja',
  'de',
  'id',
  'ta',
  'vi',
  'ko',
  'fr',
  'tr',
  'it',
  'pl',
  'uk',
  'ur',
  'nl',
  'pa',
  'sw',
] as const

const smallDownload = downloadFiles({
  repo: HORIZON_SMALL_REPO,
  modelPath: 'onnx/model_quantized.onnx',
  modelSize: 268_449_278,
  tokenizerSize: 34_363_286,
  configSize: 3_155,
})

const baseDownload = downloadFiles({
  repo: HORIZON_BASE_REPO,
  modelPath: 'onnx/model_quantized.onnx',
  modelSize: 641_205_891,
  tokenizerSize: 34_363_286,
  configSize: 3_156,
})

/** 全部内置预设（legacy 在列表中但不可删除）。 */
export const MODEL_PRESETS: readonly ModelPreset[] = [
  {
    id: 'horizon-small',
    name: 'Horizon 多语言情绪 · small',
    repo: HORIZON_SMALL_REPO,
    license: 'Apache-2.0',
    sizeBytes: 268_449_278,
    languages: HORIZON_LANGUAGES,
    labels: GO_EMOTION_LABELS,
    mappingProfile: 'go-emotions-28',
    default: true,
    urls: smallDownload.urls,
    files: smallDownload.files,
  },
  {
    id: 'horizon-base',
    name: 'Horizon 多语言情绪 · base',
    repo: HORIZON_BASE_REPO,
    license: 'Apache-2.0',
    sizeBytes: 641_205_891,
    languages: HORIZON_LANGUAGES,
    labels: GO_EMOTION_LABELS,
    mappingProfile: 'go-emotions-28',
    urls: baseDownload.urls,
    files: baseDownload.files,
  },
  {
    id: 'legacy-tabularisai',
    name: 'Tabularis 多语言情绪（legacy）',
    repo: 'tabularisai/multilingual-emotion-classification',
    license: 'CC-BY-NC-4.0',
    sizeBytes: 278_963_213,
    languages: LEGACY_LANGUAGES,
    labels: RAW_EMOTION_LABELS,
    mappingProfile: 'legacy-11',
    urls: {},
    files: [
      { path: 'model-int8.onnx', role: 'model', sizeBytes: 278_963_213 },
      { path: 'tokenizer.json', role: 'tokenizer', sizeBytes: 17_098_086 },
    ],
    local: {
      model: new URL('../../assets/model-int8.onnx', import.meta.url),
      tokenizer: new URL('../../assets/tokenizer.json', import.meta.url),
    },
  },
  {
    id: 'zh-johnson-small',
    name: '中文情绪 · Johnson8187 small',
    repo: ZH_REPO,
    license: 'MIT',
    sizeBytes: 0,
    languages: ['zh'],
    labels: ZH_EMOTION_LABELS,
    mappingProfile: 'zh-8',
    needsExport: true,
    urls: {
      tokenizer: resolveUrl(ZH_REPO, 'tokenizer.json'),
      config: resolveUrl(ZH_REPO, 'config.json'),
    },
    files: [
      { path: 'tokenizer.json', role: 'tokenizer', url: resolveUrl(ZH_REPO, 'tokenizer.json'), sizeBytes: 16_316_379 },
      { path: 'config.json', role: 'config', url: resolveUrl(ZH_REPO, 'config.json'), sizeBytes: 1_298 },
    ],
  },
]

/** 所有预设 id。 */
export const MODEL_PRESET_IDS = MODEL_PRESETS.map((preset) => preset.id)

/** 按 id 取预设；未知 id 返回 undefined。 */
export function getModelPreset(id: string): ModelPreset | undefined {
  return MODEL_PRESETS.find((preset) => preset.id === id)
}

/** 判断字符串是否为已知预设 id。 */
export function isModelPresetId(value: unknown): value is ModelPresetId {
  return typeof value === 'string' && MODEL_PRESETS.some((preset) => preset.id === value)
}

/** 默认预设。 */
export function getDefaultModelPreset(): ModelPreset {
  const preset = getModelPreset(DEFAULT_MODEL_ID)
  if (preset === undefined) throw new Error('默认模型预设缺失')
  return preset
}
