/**
 * 插件设置持久化（v0.2 / issue #39）。
 *
 * 设置存放在 `$DSH_HOME/emotion-analyzer/config.json`（DSH_HOME 未设置时
 * 回退 `~/.dsh`）。模型文件放在同目录的 `models/<modelId>/`。
 * 写入使用“写临时文件 → rename”的原子替换，避免进程中断留下半个 JSON。
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DEFAULT_MODEL_ID } from './models/registry.ts'

/** 当前 provider 形态（v0.2 只有本地 ONNX；自定义 API 见后续 issue）。 */
export interface ProviderSettings {
  readonly type: 'local'
  /** 预留：自定义 API 的密钥环境变量名（v0.2 不读取）。 */
  readonly apiKeyEnv?: string
}

/** 插件设置。 */
export interface PluginSettings {
  /** 用户选择的模型 id（可能尚未下载，service 会回退 legacy）。 */
  readonly activeModelId: string
  readonly provider: ProviderSettings
}

/** 默认设置：默认模型是 Horizon small（下载缺失时回退 legacy）。 */
export const DEFAULT_SETTINGS: PluginSettings = {
  activeModelId: DEFAULT_MODEL_ID,
  provider: { type: 'local' },
}

/** DSH 数据根目录。 */
export function dshHome(): string {
  const fromEnv = process.env['DSH_HOME']
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/** 插件数据目录（设置 + 模型）。 */
export function pluginDataDir(baseDir: string = dshHome()): string {
  return join(baseDir, 'emotion-analyzer')
}

/** 配置文件路径。 */
export function pluginConfigPath(baseDir: string = dshHome()): string {
  return join(pluginDataDir(baseDir), 'config.json')
}

/** 模型下载根目录（`models/<id>/`）。 */
export function modelsDir(baseDir: string = dshHome()): string {
  return join(pluginDataDir(baseDir), 'models')
}

/** 设置读写选项；测试可注入临时目录和静音 logger。 */
export interface SettingsOptions {
  /** DSH_HOME 等价根目录，默认 {@link dshHome}。 */
  readonly baseDir?: string
  /** 日志出口，默认 console。 */
  readonly logger?: Pick<Console, 'warn' | 'error'> | undefined
}

/**
 * 把任意 JSON 规范化为合法设置；非法字段回退默认值，未知字段丢弃。
 * @param raw - `JSON.parse` 的结果。
 * @returns 完整、安全的设置对象。
 */
export function normalizeSettings(raw: unknown): PluginSettings {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return DEFAULT_SETTINGS
  const record = raw as Record<string, unknown>
  const activeModelId =
    typeof record['activeModelId'] === 'string' && record['activeModelId'].trim().length > 0
      ? record['activeModelId'].trim()
      : DEFAULT_SETTINGS.activeModelId

  const rawProvider = record['provider']
  const providerRecord =
    rawProvider !== null && typeof rawProvider === 'object' && !Array.isArray(rawProvider)
      ? (rawProvider as Record<string, unknown>)
      : {}
  // v0.2 只支持 local；未来自定义 API 的配置也会走这里做兼容读取。
  const apiKeyEnv =
    typeof providerRecord['apiKeyEnv'] === 'string' && providerRecord['apiKeyEnv'].trim().length > 0
      ? providerRecord['apiKeyEnv'].trim()
      : undefined

  return {
    activeModelId,
    provider: apiKeyEnv === undefined ? { type: 'local' } : { type: 'local', apiKeyEnv },
  }
}

/**
 * 读取设置文件；文件缺失 / JSON 损坏 / 字段非法时返回默认值并打 warning。
 * @param options - 目录与 logger 覆盖。
 * @returns 设置对象（永不抛异常）。
 */
export async function loadSettings(options: SettingsOptions = {}): Promise<PluginSettings> {
  const file = pluginConfigPath(options.baseDir)
  if (!existsSync(file)) return DEFAULT_SETTINGS
  try {
    const text = await readFile(file, 'utf8')
    return normalizeSettings(JSON.parse(text))
  } catch (error) {
    options.logger?.warn?.(`[emotion] 读取设置失败，使用默认值：${String(error)}`)
    return DEFAULT_SETTINGS
  }
}

/**
 * 原子写入设置文件。
 * @param settings - 设置对象（会先规范化）。
 * @param options - 目录覆盖。
 */
export async function saveSettings(settings: PluginSettings, options: SettingsOptions = {}): Promise<void> {
  const normalized = normalizeSettings(settings)
  const file = pluginConfigPath(options.baseDir)
  const dir = dirname(file)
  await mkdir(dir, { recursive: true })
  const temp = join(dir, `config.json.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}.tmp`)
  try {
    await writeFile(temp, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}
