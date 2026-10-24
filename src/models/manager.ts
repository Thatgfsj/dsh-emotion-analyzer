/**
 * 模型下载管理（v0.2 / issue #39）。
 *
 * - 目标目录：`$DSH_HOME/emotion-analyzer/models/<id>/`；
 * - 每个文件先写 `<file>.part`，大小校验通过后再 rename（失败 / 取消时回滚）；
 * - 同一模型并发下载去重；进度通过 {@link ModelManager.listStatuses} 轮询；
 * - legacy 资产不允许删除，状态按包内 assets 是否存在判断。
 */
import { existsSync } from 'node:fs'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { finished } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { LEGACY_MODEL_ID, MODEL_PRESETS, getModelPreset, type ModelPreset } from './registry.ts'
import { modelsDir } from '../settings.ts'

/** 下载 / 模型状态机。 */
export type DownloadState = 'idle' | 'downloading' | 'done' | 'error' | 'cancelled'

/** 下载进度快照。 */
export interface DownloadProgress {
  readonly receivedBytes: number
  readonly totalBytes: number
  /** 0..100；总大小未知时为 0。 */
  readonly percent: number
}

/** 单个模型的运行时下载状态。 */
export interface ModelDownloadState {
  readonly state: DownloadState
  readonly progress: DownloadProgress
  readonly error?: string
  /** 最近一次失败的错误码（`size_mismatch` / `download_failed` / …）。 */
  readonly errorCode?: string
}

/** 一个模型在 UI / API 里的状态。 */
export interface ModelStatus {
  readonly preset: ModelPreset
  readonly downloaded: boolean
  readonly downloading: boolean
  readonly progress: DownloadProgress
  readonly error?: string
  readonly needsExport: boolean
}

/** 带有稳定错误码的模型管理错误。 */
export class ModelManagerError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ModelManagerError'
    this.code = code
  }
}

/** 下载行为所需的依赖；测试通过注入 fetch / 目录来离线验证。 */
export interface ModelManagerOptions {
  /** DSH_HOME 等价根目录；默认与 settings.ts 相同。 */
  readonly baseDir?: string
  /** 预设列表覆盖（测试用）。 */
  readonly presets?: readonly ModelPreset[]
  /** fetch 实现覆盖（测试注入假 fetch）。 */
  readonly fetchImpl?: typeof fetch
  readonly logger?: Pick<Console, 'warn' | 'error'>
}

const EMPTY_PROGRESS: DownloadProgress = { receivedBytes: 0, totalBytes: 0, percent: 0 }

/** 把字节数格式化为下载进度。 */
function progressOf(receivedBytes: number, totalBytes: number): DownloadProgress {
  return {
    receivedBytes,
    totalBytes,
    percent: totalBytes > 0 ? Math.min(100, Math.round((receivedBytes / totalBytes) * 10000) / 100) : 0,
  }
}

/** 把一个 `ModelPresetFile` 落到模型目录。 */
function filePathOf(modelDir: string, path: string): string {
  return join(modelDir, path)
}

/** 模型下载 / 校验 / 删除管理器。 */
export class ModelManager {
  private readonly presets: readonly ModelPreset[]
  private readonly rootDir: string
  private readonly fetchImpl: typeof fetch
  private readonly logger: Pick<Console, 'warn' | 'error'>
  private readonly states = new Map<string, ModelDownloadState>()
  private readonly inflight = new Map<string, { promise: Promise<void>; controller: AbortController }>()
  private readonly downloadGenerations = new Map<string, number>()

  constructor(options: ModelManagerOptions = {}) {
    this.presets = options.presets ?? MODEL_PRESETS
    this.rootDir = modelsDir(options.baseDir)
    this.fetchImpl = options.fetchImpl ?? fetch
    this.logger = options.logger ?? console
  }

  /** 模型根目录。 */
  get root(): string {
    return this.rootDir
  }

  /** 单个模型的落盘目录。 */
  modelDir(id: string): string {
    return join(this.rootDir, id)
  }

  /** 取预设（未知 id 抛 `unknown_model`）。 */
  presetOf(id: string): ModelPreset {
    const preset = this.presets.find((candidate) => candidate.id === id) ?? getModelPreset(id)
    if (preset === undefined) throw new ModelManagerError('unknown_model', `未知模型：${id}`)
    return preset
  }

  /** 包内 legacy 资产是否可用。 */
  legacyAvailable(): boolean {
    const legacy = this.presets.find((preset) => preset.id === LEGACY_MODEL_ID) ?? getModelPreset(LEGACY_MODEL_ID)
    if (legacy?.local === undefined) return false
    return existsSync(fileURLToPath(legacy.local.model)) && existsSync(fileURLToPath(legacy.local.tokenizer))
  }

  /** 文件是否已完整下载（大小已知时同时校验大小）。 */
  private async fileReady(preset: ModelPreset, path: string, expected: number | undefined): Promise<boolean> {
    const file = filePathOf(this.modelDir(preset.id), path)
    try {
      const info = await stat(file)
      if (!info.isFile() || info.size <= 0) return false
      if (expected !== undefined && expected > 0 && info.size !== expected) return false
      return true
    } catch {
      return false
    }
  }

  /** 模型是否已下载完成。 */
  async isDownloaded(id: string): Promise<boolean> {
    const preset = this.presetOf(id)
    if (preset.id === LEGACY_MODEL_ID) return this.legacyAvailable()
    if (preset.needsExport === true) return false
    if (preset.files.length === 0) return false
    for (const file of preset.files) {
      if (!(await this.fileReady(preset, file.path, file.sizeBytes))) return false
    }
    return true
  }

  /** 当前下载状态（没有状态时返回 idle）。 */
  stateOf(id: string): ModelDownloadState {
    return this.states.get(id) ?? { state: 'idle', progress: EMPTY_PROGRESS }
  }

  /** 列出所有模型状态（含下载进度 / 错误 / needsExport）。 */
  async listStatuses(): Promise<ModelStatus[]> {
    const statuses: ModelStatus[] = []
    for (const preset of this.presets) {
      const download = this.stateOf(preset.id)
      statuses.push({
        preset,
        downloaded: await this.isDownloaded(preset.id),
        downloading: download.state === 'downloading',
        progress: download.progress,
        ...(download.error === undefined ? {} : { error: download.error }),
        needsExport: preset.needsExport === true,
      })
    }
    return statuses
  }

  /** 单个模型状态。 */
  async statusOf(id: string): Promise<ModelStatus> {
    const preset = this.presetOf(id)
    const download = this.stateOf(id)
    return {
      preset,
      downloaded: await this.isDownloaded(id),
      downloading: download.state === 'downloading',
      progress: download.progress,
      ...(download.error === undefined ? {} : { error: download.error }),
      needsExport: preset.needsExport === true,
    }
  }

  /**
   * 启动下载并立即返回（HTTP 路由用）；进度通过 listStatuses 轮询。
   * 同一模型重复调用会复用同一个下载。
   */
  startDownload(id: string): ModelStatus {
    const preset = this.presetOf(id)
    if (preset.needsExport === true) {
      throw new ModelManagerError('needs_export', `${preset.name} 没有官方 ONNX，请先用导出脚本生成 assets 再切换。`)
    }
    if (preset.files.every((file) => file.url === undefined)) {
      throw new ModelManagerError('not_downloadable', `${preset.name} 没有可下载的 URL。`)
    }
    if (!this.inflight.has(id)) {
      const controller = new AbortController()
      const generation = (this.downloadGenerations.get(id) ?? 0) + 1
      this.downloadGenerations.set(id, generation)
      const status: ModelDownloadState = { state: 'downloading', progress: EMPTY_PROGRESS }
      this.states.set(id, status)
      const promise = this.runDownload(preset, generation, controller)
        .catch((error: unknown) => {
          if (controller.signal.aborted) {
            this.updateState(id, generation, { state: 'cancelled', progress: status.progress })
            return
          }
          const message = error instanceof Error ? error.message : String(error)
          const code = error instanceof ModelManagerError ? error.code : 'download_failed'
          this.logger.warn?.(`[emotion] 下载模型 ${preset.id} 失败：${message}`)
          this.updateState(id, generation, { state: 'error', progress: status.progress, error: message, errorCode: code })
        })
        .finally(() => {
          this.inflight.delete(id)
        })
      this.inflight.set(id, { promise, controller })
    }
    const current = this.stateOf(id)
    return {
      preset,
      downloaded: false,
      downloading: current.state === 'downloading',
      progress: current.progress,
      ...(current.error === undefined ? {} : { error: current.error }),
      // 上面已对 needsExport 抛错，能走到这里一定是可下载预设。
      needsExport: false,
    }
  }

  /** 等待下载完成（测试 / 内部用）；失败 / 取消会抛 `ModelManagerError`。 */
  async download(id: string): Promise<void> {
    this.startDownload(id)
    const entry = this.inflight.get(id)
    if (entry !== undefined) await entry.promise
    const state = this.stateOf(id)
    if (state.state === 'error') {
      throw new ModelManagerError(state.errorCode ?? 'download_failed', state.error ?? '下载失败')
    }
    if (state.state === 'cancelled') {
      throw new ModelManagerError('cancelled', '下载已取消')
    }
  }

  /** 取消下载；返回是否确实取消了进行中的下载。 */
  cancelDownload(id: string): boolean {
    const entry = this.inflight.get(id)
    if (entry === undefined) return false
    entry.controller.abort()
    return true
  }

  /** 删除非 legacy 模型的本地文件；进行中的下载会先取消。 */
  async deleteModel(id: string): Promise<void> {
    if (id === LEGACY_MODEL_ID) {
      throw new ModelManagerError('legacy_protected', 'legacy 模型是回退资产，不允许删除。')
    }
    const preset = this.presetOf(id)
    this.cancelDownload(id)
    const entry = this.inflight.get(id)
    if (entry !== undefined) await entry.promise.catch(() => undefined)
    await rm(this.modelDir(preset.id), { recursive: true, force: true })
    this.states.delete(id)
  }

  private updateState(id: string, generation: number, next: ModelDownloadState): void {
    if (this.downloadGenerations.get(id) !== generation) return
    this.states.set(id, next)
  }

  private async runDownload(preset: ModelPreset, generation: number, controller: AbortController): Promise<void> {
    const modelDir = this.modelDir(preset.id)
    await mkdir(modelDir, { recursive: true })
    const totalBytes = preset.files.reduce((total, file) => total + (file.sizeBytes ?? 0), 0)
    let receivedBytes = 0
    const updateProgress = (): void => {
      this.updateState(preset.id, generation, {
        state: 'downloading',
        progress: progressOf(receivedBytes, totalBytes),
      })
    }
    updateProgress()
    for (const file of preset.files) {
      if (controller.signal.aborted) throw new ModelManagerError('cancelled', '下载已取消')
      if (file.url === undefined) continue
      const destination = filePathOf(modelDir, file.path)
      await this.downloadFile(file.url, destination, file.sizeBytes, controller.signal, (bytes) => {
        receivedBytes += bytes
        updateProgress()
      })
    }
    this.updateState(preset.id, generation, {
      state: 'done',
      progress: progressOf(receivedBytes, totalBytes > 0 ? totalBytes : receivedBytes),
    })
  }

  /** 流式下载一个文件到 `<dest>.part`，校验大小后 rename。 */
  private async downloadFile(
    url: string,
    destination: string,
    expectedSize: number | undefined,
    signal: AbortSignal,
    onBytes: (bytes: number) => void,
  ): Promise<void> {
    const response = await this.fetchImpl(url, {
      signal,
      redirect: 'follow',
      headers: { 'user-agent': 'dsh-emotion-analyzer/0.2' },
    })
    if (!response.ok || response.body === null) {
      throw new ModelManagerError('download_failed', `下载失败 HTTP ${response.status}：${url}`)
    }
    const contentLength = Number(response.headers.get('content-length') ?? '0')
    const expected = expectedSize !== undefined && expectedSize > 0 ? expectedSize : contentLength
    await mkdir(dirname(destination), { recursive: true })
    const temp = `${destination}.part`
    const writer = createWriteStream(temp)
    // 取消时 writer.destroy() 之后仍可能有排队的 write 回调，吞掉二次错误，
    // 避免变成未处理的 stream error 把进程带崩；真正的错误由 catch 处理。
    writer.on('error', () => undefined)
    let received = 0
    try {
      const reader = response.body.getReader()
      for (;;) {
        if (signal.aborted) {
          await reader.cancel().catch(() => undefined)
          throw new ModelManagerError('cancelled', '下载已取消')
        }
        const { done, value } = await reader.read()
        if (signal.aborted) {
          await reader.cancel().catch(() => undefined)
          throw new ModelManagerError('cancelled', '下载已取消')
        }
        if (done) break
        received += value.byteLength
        if (!writer.write(Buffer.from(value))) {
          await new Promise<void>((resolve) => writer.once('drain', resolve))
        }
        onBytes(value.byteLength)
      }
      writer.end()
      await finished(writer)
    } catch (error) {
      writer.destroy()
      await rm(temp, { force: true }).catch(() => undefined)
      throw error
    }
    if (expected > 0 && received !== expected) {
      await rm(temp, { force: true }).catch(() => undefined)
      throw new ModelManagerError('size_mismatch', `文件大小不匹配：期望 ${expected} B，实际 ${received} B（${url}）`)
    }
    await rename(temp, destination)
  }
}
