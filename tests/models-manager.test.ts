/**
 * 模型下载管理单测（v0.2 / issue #39）。
 *
 * 通过注入假 fetch + 临时 baseDir，离线验证：成功落盘、大小校验、HTTP 失败回滚、
 * 并发去重、取消、legacy 保护与删除。
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

import { ModelManager, ModelManagerError } from '../src/models/manager.ts'
import type { ModelPreset } from '../src/models/registry.ts'

async function tempBase(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-emotion-manager-'))
}

/** 构造一个可下载的测试预设。 */
function testPreset(options: {
  id?: string
  modelBytes: number
  tokenizerBytes?: number
  configBytes?: number
}): ModelPreset {
  const id = options.id ?? 'test-model'
  const tokenizerBytes = options.tokenizerBytes ?? 4
  const configBytes = options.configBytes ?? 3
  return {
    id: id as ModelPreset['id'],
    name: 'Test model',
    repo: 'test/repo',
    license: 'MIT',
    sizeBytes: options.modelBytes,
    languages: ['en'],
    labels: ['a', 'b'],
    mappingProfile: 'legacy-11',
    urls: {
      model: 'https://example.test/model.onnx',
      tokenizer: 'https://example.test/tokenizer.json',
      config: 'https://example.test/config.json',
    },
    files: [
      { path: 'onnx/model.onnx', role: 'model', url: 'https://example.test/model.onnx', sizeBytes: options.modelBytes },
      { path: 'tokenizer.json', role: 'tokenizer', url: 'https://example.test/tokenizer.json', sizeBytes: tokenizerBytes },
      { path: 'config.json', role: 'config', url: 'https://example.test/config.json', sizeBytes: configBytes },
    ],
  }
}

function bytesFor(url: string, length: number): Uint8Array {
  const code = url.includes('model') ? 1 : url.includes('tokenizer') ? 2 : 3
  return new Uint8Array(length).fill(code)
}

/** 正常返回指定大小内容的假 fetch。 */
function fakeFetch(sizes: Record<string, number>, calls?: Map<string, number>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input)
    calls?.set(url, (calls.get(url) ?? 0) + 1)
    const length = sizes[url]
    if (length === undefined) return new Response('not found', { status: 404 })
    return new Response(bytesFor(url, length) as unknown as BodyInit, {
      status: 200,
      headers: { 'content-length': String(length) },
    })
  }) as typeof fetch
}

test('下载成功：流式落盘、大小校验通过、状态 done', async () => {
  const base = await tempBase()
  try {
    const preset = testPreset({ modelBytes: 16 })
    const manager = new ModelManager({
      baseDir: base,
      presets: [preset],
      fetchImpl: fakeFetch({
        'https://example.test/model.onnx': 16,
        'https://example.test/tokenizer.json': 4,
        'https://example.test/config.json': 3,
      }),
      logger: { warn: () => undefined, error: () => undefined },
    })
    await manager.download('test-model')
    assert.equal(await manager.isDownloaded('test-model'), true)
    const dir = manager.modelDir('test-model')
    assert.equal((await readFile(join(dir, 'onnx/model.onnx'))).length, 16)
    assert.equal((await readFile(join(dir, 'tokenizer.json'))).length, 4)
    assert.equal(manager.stateOf('test-model').state, 'done')
    assert.equal(manager.stateOf('test-model').progress.percent, 100)
    const files = await readdir(dir, { recursive: true, withFileTypes: true })
    assert.equal(files.some((entry) => entry.name.endsWith('.part')), false)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('大小不匹配：报 size_mismatch 且回滚临时文件', async () => {
  const base = await tempBase()
  try {
    const preset = testPreset({ modelBytes: 10 })
    const manager = new ModelManager({
      baseDir: base,
      presets: [preset],
      fetchImpl: fakeFetch({
        'https://example.test/model.onnx': 5,
        'https://example.test/tokenizer.json': 4,
        'https://example.test/config.json': 3,
      }),
      logger: { warn: () => undefined, error: () => undefined },
    })
    await assert.rejects(() => manager.download('test-model'), (error: unknown) => {
      assert.ok(error instanceof ModelManagerError)
      assert.equal(error.code, 'size_mismatch')
      return true
    })
    assert.equal(manager.stateOf('test-model').state, 'error')
    assert.equal(await manager.isDownloaded('test-model'), false)
    assert.equal(existsSync(join(manager.modelDir('test-model'), 'onnx/model.onnx')), false)
    const entries = existsSync(manager.modelDir('test-model'))
      ? await readdir(manager.modelDir('test-model'), { recursive: true })
      : []
    assert.equal(entries.some((entry) => String(entry).endsWith('.part')), false)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('HTTP 失败：错误状态 + 可重试（再次下载成功）', async () => {
  const base = await tempBase()
  try {
    const preset = testPreset({ modelBytes: 8 })
    let failFirst = true
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (failFirst) {
        failFirst = false
        return new Response('boom', { status: 500 })
      }
      return new Response(bytesFor(String(input), 8) as unknown as BodyInit, {
        status: 200,
        headers: { 'content-length': '8' },
      })
    }) as typeof fetch
    const manager = new ModelManager({
      baseDir: base,
      presets: [preset],
      fetchImpl,
      logger: { warn: () => undefined, error: () => undefined },
    })
    await assert.rejects(() => manager.download('test-model'))
    assert.equal(manager.stateOf('test-model').state, 'error')
    // 文档里 tokenizer/config 大小与 model 相同（8）以便第二次全成功
    const preset2 = testPreset({ modelBytes: 8, tokenizerBytes: 8, configBytes: 8 })
    const manager2 = new ModelManager({ baseDir: base, presets: [preset2], fetchImpl, logger: { warn: () => undefined, error: () => undefined } })
    await manager2.download('test-model')
    assert.equal(await manager2.isDownloaded('test-model'), true)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('并发下载去重：同一 URL 只请求一次', async () => {
  const base = await tempBase()
  try {
    const preset = testPreset({ modelBytes: 12 })
    const calls = new Map<string, number>()
    const manager = new ModelManager({
      baseDir: base,
      presets: [preset],
      fetchImpl: fakeFetch(
        {
          'https://example.test/model.onnx': 12,
          'https://example.test/tokenizer.json': 4,
          'https://example.test/config.json': 3,
        },
        calls,
      ),
      logger: { warn: () => undefined, error: () => undefined },
    })
    const first = manager.download('test-model')
    const second = manager.download('test-model')
    await Promise.all([first, second])
    assert.deepEqual([...calls.values()], [1, 1, 1])
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('取消下载：状态 cancelled、无最终文件、无 .part', async () => {
  const base = await tempBase()
  try {
    const preset = testPreset({ modelBytes: 64 })
    const fetchImpl = (async () => {
      let timer: ReturnType<typeof setInterval> | undefined
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          let sent = 0
          timer = setInterval(() => {
            if (sent >= 64) {
              clearInterval(timer)
              controller.close()
              return
            }
            sent += 8
            try {
              controller.enqueue(new Uint8Array(8).fill(1))
            } catch {
              clearInterval(timer)
            }
          }, 5)
        },
        cancel() {
          if (timer !== undefined) clearInterval(timer)
        },
      })
      return new Response(stream, { status: 200, headers: { 'content-length': '64' } })
    }) as typeof fetch
    const manager = new ModelManager({ baseDir: base, presets: [preset], fetchImpl, logger: { warn: () => undefined, error: () => undefined } })
    const downloading = manager.download('test-model')
    // 等进度 > 0 再取消
    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (manager.stateOf('test-model').progress.receivedBytes > 0) resolve()
        else setTimeout(check, 5)
      }
      check()
    })
    assert.equal(manager.cancelDownload('test-model'), true)
    await downloading.catch(() => undefined)
    assert.equal(manager.stateOf('test-model').state, 'cancelled')
    assert.equal(existsSync(join(manager.modelDir('test-model'), 'onnx/model.onnx')), false)
    const entries = existsSync(manager.modelDir('test-model'))
      ? await readdir(manager.modelDir('test-model'), { recursive: true })
      : []
    assert.equal(entries.some((entry) => String(entry).endsWith('.part')), false)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('needsExport 预设：下载 API 返回明确错误', async () => {
  const base = await tempBase()
  try {
    const preset: ModelPreset = {
      ...testPreset({ id: 'zh-test', modelBytes: 10 }),
      needsExport: true,
      urls: { tokenizer: 'https://example.test/tokenizer.json' },
      files: [{ path: 'tokenizer.json', role: 'tokenizer', url: 'https://example.test/tokenizer.json', sizeBytes: 4 }],
    }
    const manager = new ModelManager({ baseDir: base, presets: [preset], fetchImpl: fakeFetch({}), logger: { warn: () => undefined, error: () => undefined } })
    assert.throws(() => manager.startDownload('zh-test'), (error: unknown) => {
      assert.ok(error instanceof ModelManagerError)
      assert.equal(error.code, 'needs_export')
      return true
    })
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('legacy 保护：不允许删除；legacy 可用性按本地文件判断', async () => {
  const base = await tempBase()
  try {
    const legacyDir = join(base, 'legacy-assets')
    await mkdir(legacyDir, { recursive: true })
    await writeFile(join(legacyDir, 'model.onnx'), 'model')
    await writeFile(join(legacyDir, 'tokenizer.json'), 'tok')
    const legacyPreset: ModelPreset = {
      ...testPreset({ id: 'legacy-tabularisai', modelBytes: 5 }),
      urls: {},
      files: [
        { path: 'model.onnx', role: 'model', sizeBytes: 5 },
        { path: 'tokenizer.json', role: 'tokenizer', sizeBytes: 3 },
      ],
      local: {
        model: pathToFileURL(join(legacyDir, 'model.onnx')),
        tokenizer: pathToFileURL(join(legacyDir, 'tokenizer.json')),
      },
    }
    const manager = new ModelManager({ baseDir: base, presets: [legacyPreset], fetchImpl: fakeFetch({}), logger: { warn: () => undefined, error: () => undefined } })
    assert.equal(manager.legacyAvailable(), true)
    assert.equal(await manager.isDownloaded('legacy-tabularisai'), true)
    await assert.rejects(() => manager.deleteModel('legacy-tabularisai'), (error: unknown) => {
      assert.ok(error instanceof ModelManagerError)
      assert.equal(error.code, 'legacy_protected')
      return true
    })
    assert.equal(existsSync(fileURLToPath(legacyPreset.local!.model)), true)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('删除已下载模型：目录移除、状态清空', async () => {
  const base = await tempBase()
  try {
    const preset = testPreset({ modelBytes: 4 })
    const manager = new ModelManager({
      baseDir: base,
      presets: [preset],
      fetchImpl: fakeFetch({
        'https://example.test/model.onnx': 4,
        'https://example.test/tokenizer.json': 4,
        'https://example.test/config.json': 3,
      }),
      logger: { warn: () => undefined, error: () => undefined },
    })
    await manager.download('test-model')
    assert.equal(existsSync(manager.modelDir('test-model')), true)
    await manager.deleteModel('test-model')
    assert.equal(existsSync(manager.modelDir('test-model')), false)
    assert.equal(manager.stateOf('test-model').state, 'idle')
    assert.equal(await manager.isDownloaded('test-model'), false)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
