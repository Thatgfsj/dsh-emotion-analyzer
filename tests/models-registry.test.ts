/**
 * 模型 preset 注册表单测（v0.2 / issue #39）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_MODEL_ID,
  LEGACY_MODEL_ID,
  MODEL_PRESET_IDS,
  MODEL_PRESETS,
  getDefaultModelPreset,
  getModelPreset,
  isModelPresetId,
} from '../src/models/registry.ts'
import { GO_EMOTION_LABELS, ZH_EMOTION_LABELS } from '../src/models/profiles.ts'
import { RAW_EMOTION_LABELS } from '../src/mapping.ts'

test('四个预设齐全且字段合法', () => {
  assert.deepEqual([...MODEL_PRESET_IDS], ['horizon-small', 'horizon-base', 'legacy-tabularisai', 'zh-johnson-small'])
  for (const preset of MODEL_PRESETS) {
    assert.ok(preset.id.length > 0)
    assert.ok(preset.name.length > 0)
    assert.ok(preset.repo.length > 0)
    assert.ok(preset.license.length > 0)
    assert.ok(Array.isArray(preset.languages) && preset.languages.length > 0)
    assert.ok(preset.labels.length > 0)
    assert.ok(['legacy-11', 'go-emotions-28', 'zh-8'].includes(preset.mappingProfile))
    assert.ok(preset.sizeBytes >= 0)
    assert.ok(preset.files.length > 0)
  }
})

test('默认模型是 horizon-small，且只有一个 default', () => {
  assert.equal(DEFAULT_MODEL_ID, 'horizon-small')
  assert.equal(getDefaultModelPreset().id, 'horizon-small')
  assert.equal(MODEL_PRESETS.filter((preset) => preset.default === true).length, 1)
})

test('Horizon small / base 的下载地址与实测体积', () => {
  const small = getModelPreset('horizon-small')
  const base = getModelPreset('horizon-base')
  assert.ok(small && base)
  assert.equal(small.sizeBytes, 268_449_278)
  assert.equal(base.sizeBytes, 641_205_891)
  for (const preset of [small, base]) {
    assert.equal(preset.license, 'Apache-2.0')
    assert.equal(preset.mappingProfile, 'go-emotions-28')
    assert.deepEqual(preset.labels, [...GO_EMOTION_LABELS])
    assert.equal(preset.needsExport, undefined)
    assert.match(preset.urls.model ?? '', /^https:\/\/huggingface\.co\/.+\/resolve\/main\/onnx\/model_quantized\.onnx$/)
    assert.match(preset.urls.tokenizer ?? '', /tokenizer\.json$/)
    assert.match(preset.urls.config ?? '', /config\.json$/)
    assert.equal(preset.languages.length, 36)
    assert.ok(preset.languages.includes('zh'))
  }
})

test('legacy 预设使用包内 assets、11 标签、不允许下载', () => {
  const legacy = getModelPreset(LEGACY_MODEL_ID)
  assert.ok(legacy)
  assert.equal(legacy.mappingProfile, 'legacy-11')
  assert.deepEqual(legacy.labels, [...RAW_EMOTION_LABELS])
  assert.deepEqual(legacy.urls, {})
  assert.ok(legacy.local)
  assert.match(legacy.local.model.href, /assets\/model-int8\.onnx$/)
  assert.match(legacy.local.tokenizer.href, /assets\/tokenizer\.json$/)
})

test('zh-johnson-small 标记 needsExport 且没有 model URL', () => {
  const zh = getModelPreset('zh-johnson-small')
  assert.ok(zh)
  assert.equal(zh.needsExport, true)
  assert.equal(zh.license, 'MIT')
  assert.equal(zh.sizeBytes, 0)
  assert.deepEqual(zh.labels, [...ZH_EMOTION_LABELS])
  assert.equal(zh.urls.model, undefined)
  assert.ok(zh.urls.tokenizer)
  assert.ok(zh.urls.config)
})

test('getModelPreset / isModelPresetId 边界', () => {
  assert.equal(getModelPreset('nope'), undefined)
  assert.equal(isModelPresetId('horizon-small'), true)
  assert.equal(isModelPresetId('nope'), false)
  assert.equal(isModelPresetId(undefined), false)
})
