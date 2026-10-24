/**
 * 模型运行时服务（v0.2 / issue #39）。
 *
 * 把 registry（预设）、manager（下载）、profiles（映射）、settings（选择）
 * 与 EmotionScorer（推理）串起来：
 * - 默认 activeModelId = horizon-small；未下载时回退 legacy assets（warning）；
 * - 切换模型时 dispose 旧 session，下一次打分惰性初始化新模型；
 * - 为 Host routes 提供 state / select / download / delete / test 所需方法。
 */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EmotionScorer, type EmotionScorerOptions } from '../inference.ts'
import { LEGACY_MODEL_ID, getModelPreset, type ModelPreset } from './registry.ts'
import { ModelManager, ModelManagerError, type ModelStatus } from './manager.ts'
import { getMappingProfile, type MappingProfile, type MappingProfileId } from './profiles.ts'
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type PluginSettings,
  type ProviderSettings,
} from '../settings.ts'

/** 服务层错误：routes 直接映射成 `{error:{code,message}}`。 */
export class ModelServiceError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'ModelServiceError'
    this.code = code
    this.status = status
  }
}

/** 实际生效的模型运行时（可能是回退后的 legacy）。 */
export interface ActiveRuntime {
  readonly preset: ModelPreset
  readonly profile: MappingProfile
  readonly modelPath: string
  readonly tokenizerPath: string
  /** 用户选择与生效模型不一致（默认模型未下载 → legacy 回退）。 */
  readonly fallbackActive: boolean
}

/** `GET state` 的返回体。 */
export interface ModelStatePayload {
  readonly activeModelId: string
  readonly fallbackActive: boolean
  readonly models: readonly ModelStateEntry[]
  readonly provider: ProviderSettings
}

/** state.models[] 的条目。 */
export interface ModelStateEntry {
  readonly id: string
  readonly name: string
  readonly repo: string
  readonly license: string
  readonly sizeBytes: number
  readonly languages: readonly string[]
  readonly labels: readonly string[]
  readonly mappingProfile: MappingProfileId
  readonly downloaded: boolean
  readonly downloading: boolean
  readonly progress: { readonly receivedBytes: number; readonly totalBytes: number; readonly percent: number }
  readonly error: string | null
  readonly needsExport: boolean
}

/** 一轮打分的原始结果（投影 fold 需要 raw + profileId）。 */
export interface ScoreResult {
  readonly raw: Record<string, number>
  readonly modelId: string
  readonly profileId: MappingProfileId
  readonly latencyMs: number
  readonly fallbackActive: boolean
}

/** `POST test` 的返回体。 */
export interface TestResult {
  readonly scores: Record<string, number>
  readonly modelId: string
  readonly latencyMs: number
}

/** 服务依赖注入（测试用）。 */
export interface EmotionModelServiceOptions {
  readonly baseDir?: string
  readonly manager?: ModelManager
  readonly logger?: Pick<Console, 'warn' | 'error'>
  /** 测试注入假 scorer / 假设置读写。 */
  readonly scorerFactory?: (options: EmotionScorerOptions) => EmotionScorer
  readonly settingsLoader?: () => Promise<PluginSettings>
  readonly settingsSaver?: (settings: PluginSettings) => Promise<void>
}

/** 从预设找模型 / tokenizer 的本地路径（下载模型落在 modelDir 下）。 */
function runtimePaths(
  preset: ModelPreset,
  modelDir: string,
): { modelPath: string; tokenizerPath: string } | undefined {
  if (preset.local !== undefined) {
    return {
      modelPath: fileURLToPath(preset.local.model),
      tokenizerPath: fileURLToPath(preset.local.tokenizer),
    }
  }
  const model = preset.files.find((file) => file.role === 'model')
  const tokenizer = preset.files.find((file) => file.role === 'tokenizer')
  if (model === undefined || tokenizer === undefined) return undefined
  return { modelPath: join(modelDir, model.path), tokenizerPath: join(modelDir, tokenizer.path) }
}

/** 模型运行时服务。 */
export class EmotionModelService {
  private readonly options: EmotionModelServiceOptions
  private readonly manager: ModelManager
  private readonly logger: Pick<Console, 'warn' | 'error'>
  private settingsState: PluginSettings = DEFAULT_SETTINGS
  private active: ActiveRuntime | undefined
  private scorer: EmotionScorer | undefined
  private initialized = false
  private initPromise: Promise<void> | undefined
  private warnedFallback = false

  constructor(options: EmotionModelServiceOptions = {}) {
    this.options = options
    this.logger = options.logger ?? console
    this.manager = options.manager ?? new ModelManager({ baseDir: options.baseDir, logger: this.logger })
  }

  /** 当前设置（只读快照）。 */
  get settings(): PluginSettings {
    return this.settingsState
  }

  /** 当前生效模型（未初始化 / 无可用模型时为 undefined）。 */
  get activeRuntime(): ActiveRuntime | undefined {
    return this.active
  }

  /** 当前 manager（routes / 测试用）。 */
  get modelManager(): ModelManager {
    return this.manager
  }

  /** 读取设置并解析生效模型；可重复调用（幂等）。 */
  async initialize(): Promise<void> {
    if (this.initialized) return
    this.initPromise ??= this.doInitialize()
    await this.initPromise
  }

  private async doInitialize(): Promise<void> {
    this.settingsState = this.options.settingsLoader
      ? await this.options.settingsLoader()
      : await loadSettings({ baseDir: this.options.baseDir, logger: this.logger })
    this.active = await this.resolveRuntime(this.settingsState.activeModelId)
    this.initialized = true
  }

  /** 根据配置 id 解析实际运行时（下载缺失 → legacy 回退）。 */
  private async resolveRuntime(configuredId: string): Promise<ActiveRuntime | undefined> {
    const configured = getModelPreset(configuredId)
    if (configured !== undefined && configured.needsExport !== true && (await this.manager.isDownloaded(configured.id))) {
      const paths = runtimePaths(configured, this.manager.modelDir(configured.id))
      if (paths !== undefined) {
        return {
          preset: configured,
          profile: getMappingProfile(configured.mappingProfile),
          modelPath: paths.modelPath,
          tokenizerPath: paths.tokenizerPath,
          fallbackActive: configured.id !== this.settingsState.activeModelId,
        }
      }
    }

    if (await this.manager.isDownloaded(LEGACY_MODEL_ID)) {
      const legacy = getModelPreset(LEGACY_MODEL_ID)
      const paths = legacy === undefined ? undefined : runtimePaths(legacy, this.manager.modelDir(LEGACY_MODEL_ID))
      if (legacy !== undefined && paths !== undefined) {
        if (!this.warnedFallback && configuredId !== LEGACY_MODEL_ID) {
          this.warnedFallback = true
          this.logger.warn?.(
            `[emotion] 模型 ${configuredId} 尚未下载，回退到 legacy assets；可在设置页下载默认模型后切换。`,
          )
        }
        return {
          preset: legacy,
          profile: getMappingProfile(legacy.mappingProfile),
          modelPath: paths.modelPath,
          tokenizerPath: paths.tokenizerPath,
          fallbackActive: configuredId !== LEGACY_MODEL_ID,
        }
      }
    }
    return undefined
  }

  /** 重建生效运行时（切换 / 删除后）。 */
  private async refreshRuntime(): Promise<void> {
    const previous = this.scorer
    this.scorer = undefined
    if (previous !== undefined) await previous.dispose()
    this.active = await this.resolveRuntime(this.settingsState.activeModelId)
  }

  /** 惰性创建 scorer（第一次真正打分时才加载 ONNX）。 */
  private ensureScorer(): EmotionScorer | undefined {
    const runtime = this.active
    if (runtime === undefined) return undefined
    if (this.scorer === undefined) {
      const factory = this.options.scorerFactory ?? ((options: EmotionScorerOptions) => new EmotionScorer(options))
      this.scorer = factory({
        modelPath: runtime.modelPath,
        tokenizerPath: runtime.tokenizerPath,
        labels: runtime.preset.labels,
        logger: this.logger,
      })
    }
    return this.scorer
  }

  /** 对文本打分；模型不可用 / 推理失败返回 undefined。 */
  async score(text: string): Promise<ScoreResult | undefined> {
    await this.initialize()
    const runtime = this.active
    if (runtime === undefined) return undefined
    const scorer = this.ensureScorer()
    if (scorer === undefined) return undefined
    const startedAt = Date.now()
    const raw = await scorer.score(text)
    const latencyMs = Date.now() - startedAt
    if (Object.keys(raw).length === 0) return undefined
    return {
      raw,
      modelId: runtime.preset.id,
      profileId: runtime.profile.id,
      latencyMs,
      fallbackActive: runtime.fallbackActive,
    }
  }

  /** `POST test`：返回统一 7 维分数。 */
  async testModel(text: string): Promise<TestResult> {
    await this.initialize()
    const runtime = this.active
    if (runtime === undefined) throw new ModelServiceError('model_unavailable', '没有可用的本地模型', 503)
    const scorer = this.ensureScorer()
    if (scorer === undefined) throw new ModelServiceError('model_unavailable', '没有可用的本地模型', 503)
    const startedAt = Date.now()
    const raw = await scorer.score(text)
    const latencyMs = Date.now() - startedAt
    if (Object.keys(raw).length === 0) throw new ModelServiceError('inference_failed', '模型推理失败', 503)
    return { scores: runtime.profile.aggregate(raw), modelId: runtime.preset.id, latencyMs }
  }

  /** `GET state`。 */
  async getState(): Promise<ModelStatePayload> {
    await this.initialize()
    const statuses = await this.manager.listStatuses()
    return {
      activeModelId: this.settingsState.activeModelId,
      fallbackActive: this.active?.fallbackActive ?? false,
      models: statuses.map((status) => this.entryOf(status)),
      provider: this.settingsState.provider,
    }
  }

  private entryOf(status: ModelStatus): ModelStateEntry {
    return {
      id: status.preset.id,
      name: status.preset.name,
      repo: status.preset.repo,
      license: status.preset.license,
      sizeBytes: status.preset.sizeBytes,
      languages: status.preset.languages,
      labels: status.preset.labels,
      mappingProfile: status.preset.mappingProfile,
      downloaded: status.downloaded,
      downloading: status.downloading,
      progress: status.progress,
      error: status.error ?? null,
      needsExport: status.needsExport,
    }
  }

  /** `POST model/select`：校验可用 → 写设置 → 重建运行时。 */
  async selectModel(id: string): Promise<ModelStatePayload> {
    await this.initialize()
    const preset = this.requirePreset(id)
    if (preset.needsExport === true) {
      throw new ModelServiceError('needs_export', `${preset.name} 没有官方 ONNX，请先用导出脚本生成 assets。`)
    }
    if (!(await this.manager.isDownloaded(preset.id))) {
      throw new ModelServiceError('not_downloaded', `${preset.name} 尚未下载。`, 409)
    }
    // 已经是当前生效模型：不重复 dispose / 加载。
    if (this.active?.preset.id === preset.id && this.settingsState.activeModelId === preset.id) {
      return this.getState()
    }
    const nextSettings: PluginSettings = { ...this.settingsState, activeModelId: preset.id }
    if (this.options.settingsSaver !== undefined) await this.options.settingsSaver(nextSettings)
    else await saveSettings(nextSettings, { baseDir: this.options.baseDir })
    this.settingsState = nextSettings
    await this.refreshRuntime()
    return this.getState()
  }

  /** `POST model/download`：启动下载并立即返回最新 state。 */
  async downloadModel(id: string): Promise<ModelStatePayload> {
    await this.initialize()
    const preset = this.requirePreset(id)
    // 已下载则不重复下载；needsExport 的下载请求交给 manager 给出明确错误。
    if (preset.needsExport !== true && (await this.manager.isDownloaded(preset.id))) {
      return this.getState()
    }
    try {
      this.manager.startDownload(preset.id)
    } catch (error) {
      throw this.mapManagerError(error)
    }
    return this.getState()
  }

  /** `DELETE model/{id}`：删除非 legacy 模型。 */
  async deleteModel(id: string): Promise<ModelStatePayload> {
    await this.initialize()
    this.requirePreset(id)
    try {
      await this.manager.deleteModel(id)
    } catch (error) {
      throw this.mapManagerError(error)
    }
    if (this.active?.preset.id === id) await this.refreshRuntime()
    return this.getState()
  }

  /** 重新读取设置并重建映射（settings 变更后下一轮生效）。 */
  async reload(): Promise<void> {
    this.initialized = false
    this.initPromise = undefined
    this.warnedFallback = false
    await this.initialize()
    await this.refreshRuntime()
  }

  /** 释放底层 ONNX session。 */
  async dispose(): Promise<void> {
    const scorer = this.scorer
    this.scorer = undefined
    this.active = undefined
    this.initialized = false
    this.initPromise = undefined
    if (scorer !== undefined) await scorer.dispose()
  }

  private requirePreset(id: string): ModelPreset {
    const preset = getModelPreset(id)
    if (preset === undefined) throw new ModelServiceError('unknown_model', `未知模型：${id}`, 404)
    return preset
  }

  private mapManagerError(error: unknown): Error {
    if (error instanceof ModelManagerError) {
      const status = error.code === 'unknown_model' ? 404 : error.code === 'legacy_protected' ? 400 : 409
      return new ModelServiceError(error.code, error.message, status)
    }
    return error instanceof Error ? error : new Error(String(error))
  }
}
