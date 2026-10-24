/**
 * dsh-emotion-analyzer — Settings → 情绪分析器 → 模型 section (issue #40).
 *
 * Rendered into the existing settings.section slot; no new route. The
 * component is intentionally defensive: every network call is wrapped in
 * try/catch and failures render an inline alert instead of throwing through
 * the slot renderer.
 */
import {
  MODEL_POLL_INTERVAL_MS,
  describeApiError,
  downloadPercent,
  formatBytes,
  formatProgress,
  getModelApi,
  isActiveDownloadStatus,
  type ModelApiClient,
  type ModelDownload,
  type ModelPreset,
  type ModelState,
  type ModelTestResult,
} from './model-api.ts'

export interface ModelDisplayRow {
  key: string
  label: string
  color: string
  percent: number
  value: number
}

/** Order / labels / colours shared with the floating widget. */
export const UI_DIMENSIONS: ReadonlyArray<{ key: string; label: string; color: string }> = [
  { key: 'pleasant', label: '愉快', color: '#F5B301' },
  { key: 'sad', label: '悲伤', color: '#4C8DF6' },
  { key: 'angry', label: '愤怒', color: '#E5484D' },
  { key: 'anxious', label: '焦虑', color: '#A855F7' },
  { key: 'unwell', label: '反感', color: '#7C9A3B' },
  { key: 'confused', label: '疑问', color: '#0891B2' },
  { key: 'neutral', label: '平静', color: '#8A93A3' },
]

export type PresetActionKind = 'download' | 'cancel' | 'delete' | 'export' | 'none'

export interface PresetAction {
  kind: PresetActionKind
  label: string
  disabled: boolean
}

/** Locale-ish one-line preset summary. */
export function formatModelMeta(preset: ModelPreset | null | undefined): string {
  if (!preset) return ''
  const parts: string[] = []
  if (preset.languages > 0) {
    parts.push(preset.languageCodes && preset.languageCodes.length === 1 && preset.languageCodes[0] === 'zh'
      ? '中文'
      : preset.languages + ' 语言')
  }
  if (preset.labels > 0) parts.push(preset.labels + ' 标签')
  if (preset.sizeBytes !== undefined) parts.push(formatBytes(preset.sizeBytes))
  if (preset.license) parts.push(preset.license)
  return parts.join(' · ')
}

/** Badge labels rendered next to a preset name. */
export function modelBadges(preset: ModelPreset | null | undefined): string[] {
  if (!preset) return []
  const badges: string[] = []
  if (preset.recommended) badges.push('推荐')
  if (preset.legacy) badges.push('legacy')
  if (preset.fallback) badges.push('兼容回退')
  if (preset.needsExport && !preset.installed) badges.push('需本地导出')
  if (preset.installed) badges.push('已安装')
  return badges
}

/** True while any download is in progress (disables other actions). */
export function downloadIsActive(state: ModelState | null | undefined): boolean {
  return Boolean(state && state.download && isActiveDownloadStatus(state.download.status))
}

/** Action for the primary button of one preset card. */
export function presetAction(
  preset: ModelPreset,
  state: ModelState | null | undefined,
  busy: boolean,
): PresetAction {
  const download = state ? state.download : null
  const isThisDownload = Boolean(download && download.id === preset.id && isActiveDownloadStatus(download.status))
  if (isThisDownload) return { kind: 'cancel', label: '取消下载', disabled: busy }
  if (busy || downloadIsActive(state)) return { kind: 'none', label: '处理中…', disabled: true }
  if (preset.needsExport && !preset.installed) return { kind: 'export', label: '需本地导出', disabled: true }
  if (preset.installed) return { kind: 'delete', label: '删除', disabled: false }
  if (!preset.downloadable) return { kind: 'export', label: '不可在线下载', disabled: true }
  return { kind: 'download', label: '下载', disabled: false }
}

/** Whether the radio input for a preset can be selected right now. */
export function canSelectPreset(
  preset: ModelPreset,
  state: ModelState | null | undefined,
  busy: boolean,
): boolean {
  if (busy || downloadIsActive(state)) return false
  if (!preset.installed) return false
  return !(state && state.activeModelId === preset.id)
}

/** Rows for the /test result bars, ordered by the 7 unified dimensions. */
export function scoreRows(scores: Record<string, number> | null | undefined): ModelDisplayRow[] {
  const source = scores ?? {}
  const rows: ModelDisplayRow[] = []
  const seen = new Set<string>()
  for (const dimension of UI_DIMENSIONS) {
    const value = normalizeScoreValue(source[dimension.key])
    seen.add(dimension.key)
    rows.push({ ...dimension, value, percent: Math.round(value * 100) })
  }
  const extras = Object.keys(source)
    .filter((key) => !seen.has(key))
    .sort()
  for (const key of extras) {
    const value = normalizeScoreValue(source[key])
    rows.push({ key, label: key, color: '#8A93A3', value, percent: Math.round(value * 100) })
  }
  return rows
}

function normalizeScoreValue(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return 0
  return Math.max(0, Math.min(1, numeric > 1 ? numeric / 100 : numeric))
}

/** Label for the download area under a preset (progress or failure). */
export function downloadLine(download: ModelDownload | null | undefined): string {
  if (!download) return ''
  const progress = formatProgress(download)
  if (download.status === 'complete') return '下载完成，可以切换到该模型。'
  if (download.status === 'failed') return '下载失败：' + (download.error ?? '请重试') + '（' + progress + '）'
  return progress
}

const styles = {
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: '14px',
    marginTop: '4px',
    paddingTop: '18px',
    borderTop: '1px solid var(--dsw-alias-border-l1, rgba(15,23,42,.12))',
  },
  header: { display: 'flex', flexDirection: 'column', gap: '4px' },
  title: { margin: 0, fontSize: '16px', fontWeight: 600, color: 'var(--dsw-alias-label-primary, #111827)' },
  description: {
    margin: 0,
    fontSize: '12px',
    lineHeight: 1.6,
    color: 'var(--dsw-alias-label-tertiary, #6b7280)',
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    padding: '14px',
    borderRadius: '12px',
    border: '1px solid var(--dsw-alias-border-l2, rgba(15,23,42,.12))',
    background: 'var(--dsw-alias-bg-l1, rgba(255,255,255,.6))',
  },
  row: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
  spread: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' },
  modelName: { fontSize: '14px', fontWeight: 600, color: 'var(--dsw-alias-label-primary, #111827)' },
  meta: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, #6b7280)', lineHeight: 1.5 },
  badge: {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '1px 7px',
    borderRadius: '999px',
    fontSize: '11px',
    lineHeight: '18px',
    background: 'var(--dsw-alias-fill-l1, rgba(15,23,42,.06))',
    color: 'var(--dsw-alias-label-secondary, #4b5563)',
    whiteSpace: 'nowrap',
  },
  badgeAccent: {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '1px 7px',
    borderRadius: '999px',
    fontSize: '11px',
    lineHeight: '18px',
    background: 'var(--dsw-alias-button-primary-dimmed, rgba(79,124,255,.12))',
    color: 'var(--dsw-alias-brand-primary, #4f7cff)',
    whiteSpace: 'nowrap',
  },
  alert: {
    padding: '10px 12px',
    borderRadius: '10px',
    fontSize: '12px',
    lineHeight: 1.6,
    color: 'var(--dsw-alias-label-error, #b91c1c)',
    background: 'var(--dsw-alias-bg-mask-2, rgba(229,72,77,.08))',
    border: '1px solid var(--dsw-alias-border-l2, rgba(229,72,77,.25))',
  },
  info: {
    padding: '10px 12px',
    borderRadius: '10px',
    fontSize: '12px',
    lineHeight: 1.6,
    color: 'var(--dsw-alias-label-secondary, #4b5563)',
    background: 'var(--dsw-alias-bg-l2, rgba(15,23,42,.04))',
    border: '1px solid var(--dsw-alias-border-l2, rgba(15,23,42,.12))',
  },
  warning: {
    margin: 0,
    fontSize: '12px',
    lineHeight: 1.6,
    color: 'var(--dsw-alias-label-secondary, #4b5563)',
  },
  button: {
    border: '1px solid var(--dsw-alias-border-l2, rgba(15,23,42,.15))',
    background: 'var(--dsw-alias-bg-base, #fff)',
    color: 'var(--dsw-alias-label-primary, #111827)',
    borderRadius: '8px',
    padding: '6px 12px',
    fontSize: '13px',
    cursor: 'pointer',
  },
  primaryButton: {
    border: '1px solid var(--dsw-alias-button-primary-fill, #4f7cff)',
    background: 'var(--dsw-alias-button-primary-fill, #4f7cff)',
    color: 'var(--dsw-alias-label-primary-inverted, #fff)',
    borderRadius: '8px',
    padding: '6px 14px',
    fontSize: '13px',
    cursor: 'pointer',
  },
  dangerButton: {
    border: '1px solid var(--dsw-alias-border-l2, rgba(229,72,77,.4))',
    background: 'transparent',
    color: 'var(--dsw-alias-label-error, #b91c1c)',
    borderRadius: '8px',
    padding: '6px 12px',
    fontSize: '13px',
    cursor: 'pointer',
  },
  progressTrack: {
    width: '100%',
    height: '6px',
    borderRadius: '999px',
    background: 'var(--dsw-alias-fill-l1, rgba(15,23,42,.08))',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: '999px',
    background: 'var(--dsw-alias-brand-primary, #4f7cff)',
    transition: 'width 300ms ease',
  },
  track: {
    flex: '1 1 140px',
    height: '6px',
    borderRadius: '999px',
    background: 'var(--dsw-alias-fill-l1, rgba(15,23,42,.08))',
    overflow: 'hidden',
  },
  fill: { height: '100%', borderRadius: '999px' },
  textarea: {
    width: '100%',
    minHeight: '64px',
    resize: 'vertical',
    padding: '8px 10px',
    borderRadius: '8px',
    border: '1px solid var(--dsw-alias-border-l2, rgba(15,23,42,.15))',
    background: 'var(--dsw-alias-bg-base, #fff)',
    color: 'var(--dsw-alias-label-primary, #111827)',
    fontSize: '13px',
    fontFamily: 'inherit',
    boxSizing: 'border-box',
  },
  disabledButton: { opacity: 0.55, cursor: 'not-allowed' },
}

/**
 * Build the models section component with the host React runtime.
 * @param React - host React module.
 * @param options - optional injected API client (tests / harnesses).
 * @returns a React function component.
 */
export function createSettingsModels(
  React: any,
  options: { api?: ModelApiClient } = {},
): (props?: Record<string, unknown>) => any {
  const api = options.api
  return function EmotionModelSettings(): any {
    const client = api ?? getModelApi()
    const [state, setState] = React.useState(null)
    const [loading, setLoading] = React.useState(true)
    const [error, setError] = React.useState('')
    const [busy, setBusy] = React.useState(null)
    const [reloadToken, setReloadToken] = React.useState(0)
    const [testText, setTestText] = React.useState('今天心情不错，谢谢你！')
    const [testing, setTesting] = React.useState(false)
    const [testResult, setTestResult] = React.useState(null)
    const [testError, setTestError] = React.useState('')

    React.useEffect(() => {
      let alive = true
      setLoading(true)
      setError('')
      client
        .getState()
        .then((next: ModelState) => {
          if (!alive) return
          setState(next)
          setLoading(false)
        })
        .catch((failure: unknown) => {
          if (!alive) return
          setError(describeApiError(failure))
          setLoading(false)
        })
      return () => {
        alive = false
      }
    }, [client, reloadToken])

    const activeDownload = state && state.download && isActiveDownloadStatus(state.download.status) ? state.download : null
    const polling = Boolean(activeDownload)
    const downloadId = activeDownload ? activeDownload.id : undefined
    React.useEffect(() => {
      if (!polling) return undefined
      const stop = client.watchDownload(
        (next: ModelState) => setState(next),
        (failure: unknown) => setError(describeApiError(failure)),
        MODEL_POLL_INTERVAL_MS,
      )
      return stop
    }, [client, polling, downloadId])

    const runAction = async (key: string, action: () => Promise<ModelState>): Promise<void> => {
      if (busy !== null) return
      setBusy(key)
      setError('')
      try {
        const next = await action()
        setState(next)
      } catch (failure) {
        setError(describeApiError(failure))
      } finally {
        setBusy(null)
      }
    }

    const runTest = async (): Promise<void> => {
      const text = testText.trim()
      if (testing || text.length === 0) return
      setTesting(true)
      setTestError('')
      try {
        const result = await client.testModel(text)
        setTestResult(result)
      } catch (failure) {
        setTestError(describeApiError(failure))
      } finally {
        setTesting(false)
      }
    }

    const current = state ? state.current : null
    const presets: ModelPreset[] = state && Array.isArray(state.presets) ? state.presets : []
    const actionBusy = busy !== null

    const renderPreset = (preset: ModelPreset): any => {
      const action = presetAction(preset, state, actionBusy)
      const selected = Boolean(state && state.activeModelId === preset.id)
      const isDownloading = Boolean(activeDownload && activeDownload.id === preset.id)
      const percent = isDownloading && activeDownload ? downloadPercent(activeDownload) : 0
      const failedHere = Boolean(
        state && state.download && state.download.id === preset.id && state.download.status === 'failed',
      )
      const buttonStyle =
        action.kind === 'cancel' || action.kind === 'delete'
          ? styles.dangerButton
          : action.kind === 'download'
            ? styles.primaryButton
            : styles.button
      return React.createElement(
        'div',
        { key: preset.id, style: styles.card, 'data-emotion-model-preset': preset.id },
        React.createElement(
          'div',
          { style: styles.spread },
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'flex-start', gap: '8px', minWidth: 0 } },
            React.createElement('input', {
              type: 'radio',
              name: 'emotion-analyzer-model',
              checked: selected,
              disabled: !canSelectPreset(preset, state, actionBusy),
              onChange: () => {
                if (!canSelectPreset(preset, state, actionBusy)) return
                void runAction('select:' + preset.id, () => client.selectModel(preset.id))
              },
              'aria-label': '使用模型 ' + preset.name,
              style: { marginTop: '3px' },
            }),
            React.createElement(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 } },
              React.createElement(
                'div',
                { style: styles.row },
                React.createElement('span', { style: styles.modelName }, preset.name),
                ...modelBadges(preset).map((badge, index) =>
                  React.createElement(
                    'span',
                    { key: badge + index, style: index === 0 && preset.recommended ? styles.badgeAccent : styles.badge },
                    badge,
                  ),
                ),
                selected ? React.createElement('span', { style: styles.badgeAccent }, '当前使用') : null,
              ),
              React.createElement('span', { style: styles.meta }, formatModelMeta(preset)),
              preset.description ? React.createElement('span', { style: styles.meta }, preset.description) : null,
              preset.id ? React.createElement('span', { style: styles.meta }, 'ID: ' + preset.id) : null,
            ),
          ),
          React.createElement(
            'div',
            { style: { flex: '0 0 auto' } },
            React.createElement(
              'button',
              {
                type: 'button',
                style: action.disabled ? { ...buttonStyle, ...styles.disabledButton } : buttonStyle,
                disabled: action.disabled,
                onClick: () => {
                  if (action.disabled) return
                  if (action.kind === 'download') {
                    void runAction('download:' + preset.id, () => client.downloadModel(preset.id))
                  } else if (action.kind === 'cancel' || action.kind === 'delete') {
                    void runAction('remove:' + preset.id, () => client.removeModel(preset.id))
                  }
                },
              },
              action.label,
            ),
          ),
        ),
        isDownloading && activeDownload
          ? React.createElement(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
              React.createElement(
                'div',
                {
                  style: styles.progressTrack,
                  role: 'progressbar',
                  'aria-valuemin': 0,
                  'aria-valuemax': 100,
                  'aria-valuenow': percent,
                  'aria-label': '下载进度',
                },
                React.createElement('div', { style: { ...styles.progressFill, width: percent + '%' } }),
              ),
              React.createElement('span', { style: styles.meta }, downloadLine(activeDownload)),
            )
          : null,
        failedHere && state && state.download
          ? React.createElement('div', { style: styles.alert, role: 'alert' }, downloadLine(state.download))
          : null,
        preset.needsExport && !preset.installed
          ? React.createElement(
              'p',
              { style: styles.warning },
              '中文模型需要本地导出后才能使用：运行 python3 scripts/export_model.py 生成 ' +
                (preset.expectedExportPath ?? 'assets/model.onnx') +
                '，然后刷新本页。',
            )
          : null,
      )
    }

    const children: any[] = [
      React.createElement(
        'div',
        { key: 'header', style: styles.header },
        React.createElement('h3', { style: styles.title }, '模型'),
        React.createElement(
          'p',
          { style: styles.description },
          '本地 ONNX 情绪模型：下载、切换、删除与测试。所有推理都在本机完成，不联网调用第三方 API。',
        ),
      ),
    ]

    if (loading && !state) {
      children.push(React.createElement('p', { key: 'loading', style: styles.meta }, '正在读取模型列表…'))
    }

    if (error) {
      children.push(
        React.createElement(
          'div',
          { key: 'error', style: styles.alert, role: 'alert' },
          React.createElement('div', null, error),
          React.createElement(
            'button',
            {
              type: 'button',
              style: { ...styles.button, marginTop: '8px' },
              onClick: () => {
                setError('')
                setReloadToken((token: number) => token + 1)
              },
            },
            '重试',
          ),
        ),
      )
    }

    if (state && state.source === 'mock') {
      children.push(
        React.createElement(
          'div',
          { key: 'mock', style: styles.info },
          '演示模式：宿主模型 API（/api/emotion-analyzer/v1/state）尚未就绪',
          state.mockReason ? '（' + state.mockReason + '）' : '',
          '。以下为演示数据，下载与测试均在本页模拟。',
        ),
      )
    }

    if (state && state.warnings && state.warnings.length > 0) {
      children.push(
        React.createElement(
          'div',
          { key: 'warnings', style: styles.info },
          ...state.warnings.map((warning: string, index: number) =>
            React.createElement('div', { key: 'warning-' + index }, warning),
          ),
        ),
      )
    }

    children.push(
      React.createElement(
        'div',
        { key: 'current', style: styles.card },
        React.createElement(
          'div',
          { style: styles.row },
          React.createElement('span', { style: styles.modelName }, '当前模型'),
          current && current.legacy ? React.createElement('span', { style: styles.badge }, 'legacy') : null,
          current && current.fallback ? React.createElement('span', { style: styles.badge }, '兼容回退') : null,
        ),
        current
          ? React.createElement(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
              React.createElement('span', { style: styles.modelName }, current.name),
              React.createElement('span', { style: styles.meta }, formatModelMeta(current)),
              React.createElement('span', { style: styles.meta }, 'ID: ' + current.id + (current.profile ? ' · profile: ' + current.profile : '')),
              current.fallback
                ? React.createElement(
                    'p',
                    { style: styles.warning },
                    '当前使用兼容回退模型；如果新模型不可用，插件仍可继续计分。',
                  )
                : null,
            )
          : React.createElement('span', { style: styles.meta }, '尚未检测到可用模型。'),
      ),
    )

    if (state && (state.fallback || state.needsExport)) {
      children.push(
        React.createElement(
          'div',
          { key: 'state-warning', style: styles.info },
          state.fallback ? '当前处于兼容回退模式。' : '',
          state.needsExport ? ' 部分模型（如中文模型）需要本地导出。' : '',
        ),
      )
    }

    children.push(
      React.createElement(
        'div',
        { key: 'presets-head', style: styles.row },
        React.createElement('span', { style: styles.modelName }, '预设模型'),
        presets.length > 0 ? React.createElement('span', { style: styles.meta }, presets.length + ' 个可用预设') : null,
      ),
      ...presets.map(renderPreset),
    )

    if (state && presets.length === 0 && !error) {
      children.push(React.createElement('p', { key: 'empty', style: styles.meta }, '宿主没有返回预设模型。'))
    }

    children.push(
      React.createElement(
        'div',
        { key: 'test', style: { ...styles.card, marginTop: '4px' } },
        React.createElement('span', { style: styles.modelName }, '测试一句'),
        React.createElement(
          'p',
          { style: styles.meta },
          '用当前模型跑一次本地推理，不会写入会话记录；结果包含 7 维分数、耗时与模型 ID。',
        ),
        React.createElement('textarea', {
          value: testText,
          maxLength: 500,
          rows: 3,
          disabled: testing,
          onChange: (event: any) => setTestText(String(event && event.target ? event.target.value : '')),
          style: styles.textarea,
          'aria-label': '测试文本',
          placeholder: '例如：今天心情不错，谢谢你！',
        }),
        React.createElement(
          'div',
          { style: styles.row },
          React.createElement(
            'button',
            {
              type: 'button',
              style: testing || testText.trim().length === 0 ? { ...styles.primaryButton, ...styles.disabledButton } : styles.primaryButton,
              disabled: testing || testText.trim().length === 0,
              onClick: () => {
                void runTest()
              },
            },
            testing ? '测试中…' : '测试',
          ),
          React.createElement('span', { style: styles.meta }, testText.length + '/500'),
        ),
        testError ? React.createElement('div', { style: styles.alert, role: 'alert' }, testError) : null,
        testResult
          ? React.createElement(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
              React.createElement(
                'div',
                { style: styles.row },
                React.createElement('span', { style: styles.badgeAccent }, 'modelId: ' + testResult.modelId),
                React.createElement('span', { style: styles.meta }, '耗时 ' + testResult.latencyMs + 'ms'),
                testResult.language ? React.createElement('span', { style: styles.meta }, '语言 ' + testResult.language) : null,
              ),
              testResult.error
                ? React.createElement('div', { style: styles.alert, role: 'alert' }, testResult.error)
                : null,
              ...scoreRows(testResult.scores).map((row) =>
                React.createElement(
                  'div',
                  { key: 'test-score-' + row.key, style: { display: 'flex', alignItems: 'center', gap: '8px' } },
                  React.createElement('span', { style: { ...styles.meta, width: '38px' } }, row.label),
                  React.createElement(
                    'div',
                    { style: styles.track },
                    React.createElement('div', {
                      style: { ...styles.fill, width: row.percent + '%', background: row.color },
                    }),
                  ),
                  React.createElement('span', { style: { ...styles.meta, width: '34px', textAlign: 'right' } }, row.percent + '%'),
                ),
              ),
            )
          : null,
      ),
    )

    return React.createElement('section', { 'data-emotion-analyzer-models': '', style: styles.section }, ...children)
  }
}
