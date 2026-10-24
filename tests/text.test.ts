import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  detectDoubt,
  detectLanguage,
  extractLastAssistantText,
  hashText,
  truncateForScoring,
} from '../src/text.ts'

test('extractLastAssistantText picks the latest assistant text blocks only', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'first' }] },
    { role: 'assistant', content: [
      { type: 'reasoning', text: 'hidden chain' },
      { type: 'text', text: 'second' },
      { type: 'text', text: 'reply' },
    ] },
  ]
  assert.equal(extractLastAssistantText(messages), 'second\nreply')
})

test('extractLastAssistantText ignores non-text and empty assistants', () => {
  assert.equal(extractLastAssistantText([]), '')
  assert.equal(extractLastAssistantText([{ role: 'assistant', content: [] }]), '')
  assert.equal(
    extractLastAssistantText([{ role: 'assistant', content: [{ type: 'reasoning', text: 'x' }] }]),
    '',
  )
})

test('detectLanguage uses CJK ratio', () => {
  assert.equal(detectLanguage('今天真的好开心呀'), 'zh')
  assert.equal(detectLanguage('I feel really happy today'), 'en')
  assert.equal(detectLanguage('mixed 中文 with english'), 'en')
  assert.equal(detectLanguage('中文中文中文 with english'), 'zh')
  assert.equal(detectLanguage('   '), 'en')
})

test('hashText is deterministic and privacy safe', () => {
  const a = hashText('hello 世界')
  assert.match(a, /^[0-9a-f]{8}$/)
  assert.equal(a, hashText('hello 世界'))
  assert.notEqual(a, hashText('hello 世界!'))
})

test('truncateForScoring respects the character budget', () => {
  const long = 'x'.repeat(5000)
  assert.equal(truncateForScoring(long).length, 4000)
  assert.equal(truncateForScoring('short'), 'short')
})

test('detectDoubt: question and uncertainty sentences produce a signal', () => {
  assert.ok(detectDoubt('这是为什么？') >= 0.5)
  assert.ok(detectDoubt('你吃了吗') >= 0.4)
  assert.ok(detectDoubt('我不太确定接下来该怎么办。') >= 0.5)
  assert.ok(detectDoubt('我有点困惑，能再解释一下吗？') >= 0.5)
  assert.ok(detectDoubt('I am not sure how to proceed.') >= 0.5)
  assert.ok(detectDoubt('Why did this happen?') >= 0.5)
  assert.ok(detectDoubt('为什么？怎么办？') >= 0.6)
})

test('detectDoubt: plain statements and technical prose do not fire', () => {
  assert.equal(detectDoubt('The meeting is at 3pm.'), 0)
  assert.equal(detectDoubt('今天天气不错。'), 0)
  assert.equal(detectDoubt('这是一个技术说明，里面会解释如何以及为什么。'), 0)
  assert.equal(detectDoubt(''), 0)
})
