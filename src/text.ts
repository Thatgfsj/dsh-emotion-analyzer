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

/* ------------------------------------------------------------------------- */
/* doubt heuristic（疑问维度）                                                */
/* ------------------------------------------------------------------------- */

/**
 * 去掉 fenced / inline code 与 URL，避免代码里的三目 `?`、`?.`、URL query
 * 被误当成自然语言疑问（review H1）。
 * @param text - 原始助手回复。
 * @returns 只保留自然语言文本的版本（保留标点与换行）。
 */
export function stripCodeAndUrls(text: string): string {
  if (text.length === 0) return ''
  return text
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(/`[^`\n]*`/gu, ' ')
    .replace(/(?:https?:\/\/|www\.)[^\s<>"'`，。！？；、）】]+/giu, ' ')
}

/** 强不确定词：命中即高 doubt。 */
const UNCERTAIN_ZH = /不太确定|不确定|没把握|不清楚|不明白|不懂|不知道|困惑|疑惑|迷茫|存疑|拿不准|说不准|搞不懂|没搞懂|纠结|疑问|质疑/u
const UNCERTAIN_EN = /\b(?:not sure|unsure|uncertain|confus(?:ed|ing|ion)?|don'?t know|do not know|doubt|puzzl(?:e|ed|ing))\b/iu

/**
 * 服务性问句：助手在问“要不要我继续 / 需要我补充吗”，不是情绪上的疑问。
 * 这类句子即使有问号也不应累计 confused（review H1）。
 */
const SERVICE_ZH = /需要我|要不要我|是否需要|需不需要|还需要我|要我|需要再|我帮你|我为你|我继续|帮你|为您/u
const SERVICE_EN = /\b(?:do you want me to|would you like me to|should i|shall i|need me to|want me to|can i help|shall we)\b/iu

/** 真实疑问词（句首）：只有这些才给高 doubt。 */
const LEADING_ZH = /^\s*(?:为什么|为何|怎么|怎样|如何|是否|是不是|能不能|可不可以|会不会|有没有|什么|哪|谁|多少|几|请问|难道|咋|怎么办)/u
const LEADING_EN = /^\s*(?:why|how|what|which|who|whom|whose|where|when)\b/iu

/** 句末语气词：单独出现只给弱信号（低于 mapping THRESHOLD=0.2）。 */
const END_PARTICLE = /(吗|呢|嘛)[\s。！!?？]*$/u

/** 单个问号：最弱的信号（常见于礼貌性问句，单独不触发 confused）。 */
const QUESTION_MARK = /[?？]/u

/** doubt 上限：避免多句命中把 confused 直接拉满。 */
export const MAX_DOUBT = 0.75

/**
 * Heuristic "doubt / uncertainty" signal for the 疑问 dimension.
 *
 * The ONNX model has no confusion/uncertainty label (legacy/zh profiles;
 * GoEmotions has confusion but still needs host help for Chinese questions).
 * This pure-text signal fills that gap and is combined with model labels by
 * the mapping layer.
 *
 * 规则（review H1 修正后）：
 * - 先剥离 fenced/inline code 与 URL；
 * - 服务性问句（需要我…吗 / 要不要… / should I…）且没有不确定词 → 0；
 * - 强不确定词 → 0.65；真实疑问词开头 → 0.50；
 * - 句末「吗/呢/嘛」或裸问号 → 0.18 / 0.15（低于 THRESHOLD，不单独触发）；
 * - 多句命中 +0.1，最终封顶 {@link MAX_DOUBT}。
 *
 * @param text - visible assistant reply.
 * @returns doubt signal in [0, 1].
 */
export function detectDoubt(text: string): number {
  if (text.length === 0) return 0
  const cleaned = stripCodeAndUrls(text)
  if (cleaned.trim().length === 0) return 0

  const segments = cleaned.match(/[^。！？!?\n]+[。！？!?]?/gu) ?? [cleaned]
  let best = 0
  let hits = 0
  for (const segment of segments) {
    const sentence = segment.trim()
    if (sentence.length === 0) continue

    const hasUncertainty = UNCERTAIN_ZH.test(sentence) || UNCERTAIN_EN.test(sentence)
    const isServiceQuestion = SERVICE_ZH.test(sentence) || SERVICE_EN.test(sentence)
    // 服务性问句本身不代表困惑；只有同时出现不确定词才按真疑问计。
    if (isServiceQuestion && !hasUncertainty) continue

    let score = 0
    if (hasUncertainty) score = 0.65
    else if (LEADING_ZH.test(sentence) || LEADING_EN.test(sentence)) score = 0.5
    else if (QUESTION_MARK.test(sentence) && /为什么|怎么|怎样|如何|怎么办|什么|哪|谁|多少|是否|难道/u.test(sentence)) {
      // 疑问词不总在句首（“这是为什么？”），有问号 + 真疑问词仍算高信号。
      score = 0.5
    } else if (END_PARTICLE.test(sentence)) score = 0.18
    else if (QUESTION_MARK.test(sentence)) score = 0.15

    if (score > 0) {
      hits += 1
      best = Math.max(best, score)
    }
  }

  // 多句命中只加一点，且不会把弱信号抬过强信号。
  if (hits >= 2 && best >= 0.5) best = Math.min(MAX_DOUBT, best + 0.1)
  return Math.min(MAX_DOUBT, best)
}
