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

/**
 * Heuristic "doubt / uncertainty" signal for the 疑问 dimension.
 *
 * The ONNX model has no confusion/uncertainty label; empirically its
 * `surprise` head fires on real surprise ("真的吗？我没想到！") but NOT on
 * Chinese questions ("这是为什么？" → surprise 0.036). This pure-text signal
 * fills that gap and is combined with `surprise` by the mapping layer.
 *
 * Rules (per sentence):
 * - question mark `?`/`？` → 0.50
 * - sentence-final question particle 吗/呢/嘛/么 → 0.45
 * - uncertainty / confusion lexicon → 0.50
 * - leading interrogative word (为什么/怎么/how/why/...) → 0.35
 * - two or more hits across sentences → +0.15
 *
 * @param text - visible assistant reply.
 * @returns doubt signal in [0, 1].
 */
export function detectDoubt(text: string): number {
  if (text.length === 0) return 0
  const segments = text.match(/[^。！？!?\n]+[。！？!?]?/gu) ?? [text]
  const questionMark = /[?？]/u
  // "么" is excluded: it is part of 什么/怎么/为什么/那么, not a standalone particle.
  const endParticle = /(吗|呢|嘛)[\s。！!?？]*$/u
  const uncertain = /不太确定|不确定|没把握|不清楚|不明白|不懂|困惑|疑惑|迷茫|存疑|拿不准|说不准|搞不懂|没搞懂|纠结|疑问|质疑/u
  const leadingZh = /^\s*(为什么|为何|怎么|怎样|如何|是否|是不是|能不能|可不可以|会不会|有没有|要不要|什么|哪|谁|多少|几|请问|难道|咋|怎么办)/u
  const uncertainEn = /\b(not sure|unsure|uncertain|confus(?:ed|ing|ion)?|don'?t know|do not know|wonder|doubt|clarify|explain|meaning|puzzle)\b/iu
  const leadingEn = /^\s*(why|how|what|which|who|whom|whose|where|when|can|could|would|should|does|do|did|is|are|was|were|will|shall|may|might)\b/iu
  let best = 0
  let hits = 0
  for (const segment of segments) {
    const sentence = segment.trim()
    if (sentence.length === 0) continue
    let score = 0
    if (questionMark.test(sentence)) score = Math.max(score, 0.5)
    if (endParticle.test(sentence)) score = Math.max(score, 0.45)
    if (uncertain.test(sentence) || uncertainEn.test(sentence)) score = Math.max(score, 0.5)
    if (leadingZh.test(sentence) || leadingEn.test(sentence)) score = Math.max(score, 0.35)
    if (score > 0) {
      hits += 1
      best = Math.max(best, score)
    }
  }
  if (hits >= 2) best = Math.min(1, best + 0.15)
  return best
}
