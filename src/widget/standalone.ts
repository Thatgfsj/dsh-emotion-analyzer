/**
 * dsh-emotion-analyzer — standalone demo entry.
 *
 * Bundled by scripts/build.mjs into demo/widget.iife.js. It registers the
 * custom element and exposes window.EmotionDemo so demo/index.html can drive
 * deterministic mock turns without bundling React or a test framework.
 *
 * NOTE: the widget itself never appends anything to document.body; the demo
 * page provides <emotion-monitor> in its markup.
 */
import { defineEmotionMonitor, EmotionMonitorElement } from './emotion-monitor.js'
import {
  EMOTION_DIMENSIONS,
  MAX_TREND,
  normalizeScore,
  normalizeScores,
  pickDominant,
  trimTrend,
  type EmotionDimension,
  type EmotionMonitorStateInput,
  type EmotionScores,
  type Language,
  type TrendPoint,
} from './state.js'

export type DemoKind = 'happy' | 'sad' | 'neutral'
export type ThemeChoice = 'system' | 'light' | 'dark'

export interface EmotionDemoSnapshot {
  turn: number
  dominant: EmotionDimension
  language: Language
  latencyMs: number
  trendLength: number
}

export interface EmotionDemoApi {
  newTurn(kind: DemoKind): void
  setLanguage(language: Language): void
  setTheme(theme: ThemeChoice): void
  collapse(): void
  expand(): void
  show(): void
  hide(): void
  snapshot(): EmotionDemoSnapshot
}

const PROFILES: Record<DemoKind, EmotionScores> = {
  happy: {
    happy: 0.82,
    pleasant: 0.68,
    sad: 0.04,
    angry: 0.02,
    anxious: 0.1,
    unwell: 0.05,
    neutral: 0.16,
  },
  sad: {
    happy: 0.05,
    pleasant: 0.1,
    sad: 0.8,
    angry: 0.08,
    anxious: 0.28,
    unwell: 0.18,
    neutral: 0.26,
  },
  neutral: {
    happy: 0.18,
    pleasant: 0.32,
    sad: 0.1,
    angry: 0.04,
    anxious: 0.1,
    unwell: 0.04,
    neutral: 0.8,
  },
}

const SESSION_TITLES: Record<Language, string> = {
  zh: '产品设计讨论',
  en: 'Product design review',
}

/** Small deterministic PRNG so screenshots are stable across runs. */
function createRandom(seed: number): () => number {
  let value = seed >>> 0
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0
    return value / 0x100000000
  }
}

function jitter(base: EmotionScores, random: () => number): EmotionScores {
  const next = {} as EmotionScores
  for (const dimension of EMOTION_DIMENSIONS) {
    next[dimension] = normalizeScore(base[dimension] + (random() - 0.5) * 0.08)
  }
  return next
}

function createDemo(element: EmotionMonitorElement, seedHistory = true): EmotionDemoApi {
  const random = createRandom(0x5eed)
  let turn = 0
  let language: Language = 'zh'
  let trend: TrendPoint[] = []
  let lastLatency = 34

  const snapshot = (): EmotionDemoSnapshot => ({
    turn,
    dominant: pickDominant(trend[trend.length - 1]?.scores ?? normalizeScores(null)),
    language,
    latencyMs: lastLatency,
    trendLength: trend.length,
  })

  const push = (kind: DemoKind): void => {
    turn += 1
    const scores = jitter(PROFILES[kind], random)
    trend = trimTrend([...trend, { scores }], MAX_TREND)
    lastLatency = 22 + Math.floor(random() * 42)
    const state: EmotionMonitorStateInput = {
      turn,
      dominant: pickDominant(scores),
      scores,
      // The host bridge passes raw score maps (lead contract); exercise that
      // exact shape here so the demo validates it too.
      trend: trend.map((point) => point.scores),
      language,
      latencyMs: lastLatency,
      sessionTitle: SESSION_TITLES[language],
      sessionId: 'demo-session',
    }
    element.update(state)
  }

  // Seed a short session history so the sparkline has something to draw.
  if (seedHistory) {
    for (let i = 0; i < 12; i += 1) {
      const roll = random()
      push(roll < 0.55 ? 'happy' : roll < 0.8 ? 'neutral' : 'sad')
    }
  }

  const api: EmotionDemoApi = {
    newTurn(kind: DemoKind): void {
      push(kind)
    },
    setLanguage(next: Language): void {
      language = next
      push(language === 'en' ? 'neutral' : 'happy')
    },
    setTheme(choice: ThemeChoice): void {
      if (choice === 'system') element.removeAttribute('data-theme')
      else element.setAttribute('data-theme', choice)
      const pageTheme =
        choice === 'system'
          ? window.matchMedia('(prefers-color-scheme: dark)').matches
            ? 'dark'
            : 'light'
          : choice
      document.documentElement.dataset.theme = pageTheme
    },
    collapse(): void {
      element.collapse()
    },
    expand(): void {
      element.expand()
    },
    show(): void {
      element.show()
    },
    hide(): void {
      element.hide()
    },
    snapshot,
  }

  return api
}

function findElement(): EmotionMonitorElement | null {
  const element = document.querySelector('emotion-monitor')
  return element instanceof EmotionMonitorElement ? element : null
}

function initDemo(): void {
  defineEmotionMonitor()
  const element = findElement()
  if (!element) return

  const params = new URLSearchParams(window.location.search)
  // empty=1 keeps the widget in its "waiting for the first reply" state.
  const demo = createDemo(element, params.get('empty') !== '1')
  window.EmotionDemo = demo

  if (params.get('lang') === 'en') demo.setLanguage('en')

  const theme = params.get('theme')
  if (theme === 'light' || theme === 'dark') demo.setTheme(theme)
  else if (theme === 'system') demo.setTheme('system')
  else demo.setTheme('system')

  const view = params.get('view')
  if (view === 'collapsed') demo.collapse()
  if (view === 'closed') demo.hide()
}

declare global {
  interface Window {
    EmotionDemo?: EmotionDemoApi
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initDemo, { once: true })
} else {
  initDemo()
}
