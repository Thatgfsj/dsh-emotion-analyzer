import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
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
