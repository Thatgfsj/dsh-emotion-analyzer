import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ModelApiError,
  createModelApi,
  describeApiError,
  downloadPercent,
  downloadStatusLabel,
  errorFromResponse,
  formatBytes,
  formatProgress,
  isActiveDownloadStatus,
  isTerminalDownloadStatus,
  normalizeDownload,
  normalizeModelState,
  normalizePreset,
  normalizeTestResult,
  shouldPollModelState,
} from '../src/client/model-api.ts'

test('formatBytes: binary units and unknown values', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(1023), '1023 B')
  assert.equal(formatBytes(1024), '1.0 KiB')
  assert.equal(formatBytes(1536), '1.5 KiB')
  assert.equal(formatBytes(10 * 1024), '10 KiB')
  assert.equal(formatBytes(256 * 1024 * 1024), '256 MiB')
  assert.equal(formatBytes(-1), '—')
  assert.equal(formatBytes(Number.NaN), '—')
  assert.equal(formatBytes(undefined), '—')
})

test('download statuses: labels, terminal/active flags, polling predicate', () => {
  assert.equal(downloadStatusLabel('downloading'), '下载中')
  assert.equal(downloadStatusLabel('verifying'), '校验中')
  assert.equal(downloadStatusLabel('complete'), '下载完成')
  assert.equal(downloadStatusLabel('failed'), '下载失败')
  assert.equal(isTerminalDownloadStatus('complete'), true)
  assert.equal(isTerminalDownloadStatus('failed'), true)
  assert.equal(isTerminalDownloadStatus('queued'), false)
  assert.equal(isActiveDownloadStatus('downloading'), true)
  assert.equal(isActiveDownloadStatus('installing'), true)
  assert.equal(isActiveDownloadStatus('complete'), false)
  assert.equal(shouldPollModelState(null), false)
  assert.equal(
    shouldPollModelState(normalizeModelState({ download: { status: 'downloading', percent: 10 } })),
    true,
  )
  assert.equal(
    shouldPollModelState(normalizeModelState({ download: { status: 'complete', percent: 100 } })),
    false,
  )
})

test('downloadPercent handles percent, bytes and clamp', () => {
  assert.equal(downloadPercent(null), 0)
  assert.equal(downloadPercent({ status: 'downloading', percent: 42 }), 42)
  assert.equal(downloadPercent({ status: 'downloading', percent: 0.5 }), 50)
  assert.equal(downloadPercent({ status: 'downloading', percent: 0, bytesDone: 1, bytesTotal: 4 }), 25)
  assert.equal(downloadPercent({ status: 'downloading', percent: 999 }), 100)
  assert.equal(downloadPercent({ status: 'downloading', percent: -2 }), 0)
  assert.equal(formatProgress({ status: 'downloading', percent: 42, bytesDone: 168, bytesTotal: 400 }), '下载中 42% · 168 B / 400 B')
})

test('normalizeDownload maps backend status aliases and payload fields', () => {
  const active = normalizeDownload({
    modelId: 'horizon-base',
    state: 'in_progress',
    progress: 0.25,
    downloadedBytes: 1024,
    totalBytes: 4096,
    speed: 2048,
  })
  assert.ok(active)
  assert.equal(active.status, 'downloading')
  assert.equal(active.id, 'horizon-base')
  assert.equal(active.percent, 25)
  assert.equal(active.bytesDone, 1024)
  assert.equal(active.bytesTotal, 4096)
  assert.equal(active.speedBps, 2048)

  assert.equal(normalizeDownload({ status: 'completed' })?.status, 'complete')
  assert.equal(normalizeDownload({ status: 'ERROR', error: 'checksum mismatch' })?.status, 'failed')
  assert.equal(normalizeDownload({ status: 'canceled' })?.status, 'cancelled')
  assert.equal(normalizeDownload(null), null)
  assert.equal(normalizeDownload('downloading'), null)
})

test('normalizePreset accepts the documented aliases', () => {
  const preset = normalizePreset({
    modelId: 'horizon-small',
    displayName: 'Horizon Small',
    summary: '36 languages',
    languages: ['zh', 'en', 'ja'],
    labels: { joy: 'JOY', sadness: 'SAD' },
    sizeMiB: 256,
    licence: 'Apache-2.0',
    mappingProfile: 'go-emotions-28',
    recommended: true,
    installed: true,
    status: 'ready',
  })
  assert.ok(preset)
  assert.equal(preset.id, 'horizon-small')
  assert.equal(preset.name, 'Horizon Small')
  assert.equal(preset.description, '36 languages')
  assert.equal(preset.languages, 3)
  assert.deepEqual(preset.languageCodes, ['zh', 'en', 'ja'])
  assert.equal(preset.labels, 2)
  assert.equal(preset.sizeBytes, 256 * 1024 * 1024)
  assert.equal(preset.license, 'Apache-2.0')
  assert.equal(preset.profile, 'go-emotions-28')
  assert.equal(preset.installed, true)
  assert.equal(preset.recommended, true)
  assert.equal(preset.legacy, false)
  assert.equal(normalizePreset({ name: '' }), null)
  assert.equal(normalizePreset(null), null)

  const legacy = normalizePreset({ id: 'legacy', profile: 'legacy-11', needsExport: true })
  assert.ok(legacy)
  assert.equal(legacy.legacy, true)
  assert.equal(legacy.fallback, true)
  assert.equal(legacy.needsExport, true)
  assert.equal(legacy.license, '未标注')
})

test('normalizeModelState accepts models/presets aliases and derives flags', () => {
  const state = normalizeModelState({
    activeModelId: 'legacy',
    models: [
      { id: 'horizon-small', name: 'Horizon Small', installed: true, languages: 36, labels: 28 },
      { id: 'legacy', name: 'Legacy', profile: 'legacy-11', installed: true },
      { id: 'zh', name: '中文', needsExport: true, installed: false },
    ],
    download: { status: 'downloading', percent: 30, id: 'horizon-base' },
    warnings: ['旧模型即将弃用', 42],
  })
  assert.equal(state.source, 'live')
  assert.equal(state.activeModelId, 'legacy')
  assert.equal(state.current?.id, 'legacy')
  assert.equal(state.presets.length, 3)
  assert.equal(state.download?.percent, 30)
  assert.equal(state.needsExport, true)
  assert.equal(state.fallback, true)
  assert.deepEqual(state.warnings, ['旧模型即将弃用'])

  const empty = normalizeModelState(null, 'mock', 'host API 404')
  assert.equal(empty.source, 'mock')
  assert.equal(empty.mockReason, 'host API 404')
  assert.equal(empty.current, null)
  assert.deepEqual(empty.presets, [])
})

test('normalizeTestResult clamps scores and keeps metadata', () => {
  const result = normalizeTestResult({
    modelId: 'horizon-small',
    latency: 12.6,
    scores: { pleasant: 72, sad: -1, angry: 0.4, bogus: 'x' },
    language: 'zh',
  })
  assert.equal(result.modelId, 'horizon-small')
  assert.equal(result.latencyMs, 13)
  assert.equal(result.scores.pleasant, 0.72)
  assert.equal(result.scores.sad, 0)
  assert.equal(result.scores.angry, 0.4)
  assert.equal('bogus' in result.scores, false)
  assert.equal(result.language, 'zh')
  assert.equal(normalizeTestResult({}, 'fallback').modelId, 'fallback')
})

test('errorFromResponse / describeApiError produce readable Chinese text', () => {
  const notFound = errorFromResponse(404, { message: 'no route' })
  assert.equal(notFound.status, 404)
  assert.equal(notFound.message, 'no route')
  const generic = errorFromResponse(500, null)
  assert.match(generic.message, /内部错误/)
  assert.equal(describeApiError(notFound), 'no route')
  assert.match(describeApiError(new ModelApiError('boom', 0, 'network')), /boom/)
  assert.match(describeApiError(new TypeError('fetch failed')), /无法连接/)
  assert.match(describeApiError('oops'), /oops/)
})

test('mock client: presets, download progress, select/remove, test', async () => {
  let now = 1000
  const api = createModelApi({ mode: 'mock', now: () => now })
  const initial = await api.getState()
  assert.equal(initial.source, 'mock')
  assert.equal(initial.presets.length, 4)
  assert.equal(initial.current?.id, 'horizon-small')
  assert.equal(initial.presets.find((preset) => preset.id === 'johnson8187-zh')?.needsExport, true)
  assert.equal(initial.presets.find((preset) => preset.id === 'tabularisai-11')?.legacy, true)

  await api.downloadModel('horizon-base')
  now += 3000
  const halfway = await api.getState()
  assert.equal(halfway.download?.status, 'downloading')
  assert.ok((halfway.download?.percent ?? 0) >= 40)

  now += 4000
  const done = await api.getState()
  assert.equal(done.download, null)
  assert.equal(done.presets.find((preset) => preset.id === 'horizon-base')?.installed, true)

  const selected = await api.selectModel('horizon-base')
  assert.equal(selected.activeModelId, 'horizon-base')
  assert.equal(selected.current?.id, 'horizon-base')

  const tested = await api.testModel('今天心情不错')
  assert.equal(tested.modelId, 'horizon-base')
  assert.ok(tested.latencyMs >= 8)
  assert.equal(Object.keys(tested.scores).length, 7)

  const removed = await api.removeModel('horizon-base')
  assert.equal(removed.presets.find((preset) => preset.id === 'horizon-base')?.installed, false)

  await assert.rejects(() => api.downloadModel('johnson8187-zh'), /本地导出/)
  await assert.rejects(() => api.selectModel('horizon-base'), /尚未下载/)
})

test('mock client: remove cancels an in-flight download', async () => {
  let now = 0
  const api = createModelApi({ mode: 'mock', now: () => now })
  await api.downloadModel('horizon-base')
  now += 1000
  const cancelled = await api.removeModel('horizon-base')
  assert.equal(cancelled.download, null)
  assert.equal(cancelled.presets.find((preset) => preset.id === 'horizon-base')?.installed, false)
  const after = await api.getState()
  assert.equal(after.download, null)
})

test('auto mode falls back to mock when host routes are missing', async () => {
  const calls: string[] = []
  const fetchImpl = (async (url: string) => {
    calls.push(String(url))
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  const api = createModelApi({ mode: 'auto', fetchImpl })
  const state = await api.getState()
  assert.equal(state.source, 'mock')
  assert.match(state.mockReason ?? '', /not found/)
  assert.equal(calls.length, 1)
  const tested = await api.testModel('hello')
  assert.equal(tested.modelId, 'horizon-small')
})

test('live mode sends same-origin credentials and JSON bodies', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    requests.push({ url: String(url), init })
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    if (String(url).endsWith('/test')) {
      return new Response(JSON.stringify({ modelId: 'horizon-small', latencyMs: 9, scores: { pleasant: 0.8 } }), { status: 200 })
    }
    if (String(url).endsWith('/state')) {
      return new Response(JSON.stringify({ current: { id: 'horizon-small', installed: true }, models: [{ id: 'horizon-small', installed: true }] }), { status: 200 })
    }
    return new Response(JSON.stringify({ current: { id: 'horizon-small', installed: true }, models: [], echoed: body }), { status: 200 })
  }) as unknown as typeof fetch
  const api = createModelApi({ mode: 'live', fetchImpl })
  const state = await api.getState()
  assert.equal(state.source, 'live')
  assert.equal(state.current?.id, 'horizon-small')
  await api.selectModel('horizon-small')
  assert.equal(requests[1]?.init.method, 'POST')
  assert.equal(requests[1]?.init.credentials, 'include')
  assert.deepEqual(JSON.parse(String(requests[1]?.init.body)), { id: 'horizon-small' })
  const tested = await api.testModel('hello')
  assert.equal(tested.scores.pleasant, 0.8)
  assert.equal(requests[2]?.url, '/api/emotion-analyzer/v1/test')
})

test('live mode surfaces server errors', async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ error: 'download busy', code: 'download-busy' }), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
  const api = createModelApi({ mode: 'live', fetchImpl })
  await assert.rejects(() => api.downloadModel('horizon-base'), (error: unknown) => {
    assert.ok(error instanceof ModelApiError)
    assert.equal(error.status, 409)
    assert.equal(error.message, 'download busy')
    return true
  })
})
