/**
 * Text helpers shared by the host hook and (via the bundle) the browser side.
 * Pure functions only; no Node-specific APIs.
 */
import type { DetectedLanguage } from './types.js'

/** Minimal structural view of one conversation message. */
interface MessageLike {
  readonly role?: string
  readonly content?: readonly unknown[]
}

/** Minimal structural view of one content block. */
interface BlockLike {
  readonly type?: string
  readonly text?: string
}

/**
 * Extract the visible text of the last assistant message.
 * Reasoning and tool blocks are ignored; only text blocks are scored.
 * @param messages - `session.deriveMessages()` result.
 * @returns the concatenated visible text, or '' when there is none.
 */
export function extractLastAssistantText(messages: readonly unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as MessageLike | undefined
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue
    const parts: string[] = []
    for (const raw of message.content) {
      const block = raw as BlockLike | undefined
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
        parts.push(block.text)
      }
    }
    const text = parts.join('\n').trim()
    if (text.length > 0) return text
  }
  return ''
}

/** CJK ideograph / kana / hangul ranges. */
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/u

/**
 * Classify the reply language by CJK ratio.
 * @param text - reply text.
 * @param threshold - CJK character ratio above which the text is treated as Chinese.
 * @returns `zh` or `en`.
 */
export function detectLanguage(text: string, threshold = 0.3): DetectedLanguage {
  const visible = text.replace(/\s+/gu, '')
  if (visible.length === 0) return 'en'
  let cjk = 0
  for (const char of visible) {
    if (CJK_RE.test(char)) cjk += 1
  }
  return cjk / visible.length > threshold ? 'zh' : 'en'
}

/**
 * FNV-1a 32-bit hash of the reply text (privacy-safe dedupe/diagnostics).
 * @param text - reply text.
 * @returns 8-char lowercase hex digest.
 */
export function hashText(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * Clamp a reply to the scoring budget before tokenization (characters, not
 * tokens; the tokenizer enforces the hard 512-token truncation).
 * @param text - reply text.
 * @param maxChars - character budget.
 * @returns the possibly truncated text.
 */
export function truncateForScoring(text: string, maxChars = 4000): string {
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars)
}
