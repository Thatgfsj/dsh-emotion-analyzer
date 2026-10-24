/**
 * dsh-emotion-analyzer — <emotion-monitor> Custom Element (Shadow DOM).
 *
 * The element owns everything inside its open shadow root: the draggable
 * panel, the score bars, the canvas sparkline, the 48px collapsed badge and
 * the light/dark token sets. It never touches document.body — the DSH shell
 * overlay / React portal decides where the host element is mounted.
 *
 * Importing this module registers the default <emotion-monitor> tag as a side
 * effect (idempotent, see defineEmotionMonitor).
 */
import { drawSparkline } from './sparkline.js'
import { WIDGET_STYLES } from './styles.js'
import {
  BADGE_SIZE,
  EMOTION_DIMENSIONS,
  EMOTION_META,
  MAX_TREND,
  STORAGE_KEYS,
  VIEWPORT_MARGIN,
  WIDGET_WIDTH,
  badgeBackground,
  badgeGlow,
  clampPosition,
  deserializeTrend,
  emptyState,
  formatLatency,
  formatTurn,
  languageLabel,
  normalizeScore,
  normalizeState,
  parsePosition,
  scorePercent,
  serializeTrend,
  trimTrend,
  type EmotionDimension,
  type EmotionMonitorState,
  type EmotionMonitorStateInput,
  type Point,
} from './state.js'

export const EMOTION_MONITOR_TAG = 'emotion-monitor'
export const CLOSE_EVENT = 'emotion-monitor-close'
export const OPEN_EVENT = 'emotion-monitor-open'
export const COLLAPSE_EVENT = 'emotion-monitor-collapse'

type ViewMode = 'expanded' | 'collapsed'

interface ScoreRow {
  row: HTMLDivElement
  track: HTMLDivElement
  fill: HTMLDivElement
  value: HTMLSpanElement
}

interface DragState {
  pointerId: number
  startX: number
  startY: number
  originX: number
  originY: number
  moved: boolean
}

function storageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function storageSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // private mode / storage disabled: widget keeps working in memory
  }
}

function storageRemove(key: string): void {
  try {
    window.localStorage.removeItem(key)
  } catch {
    // ignore
  }
}

function requireElement<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector(selector)
  if (!element) throw new Error('[emotion-monitor] missing element: ' + selector)
  return element as T
}

const TEMPLATE = `
<style>${WIDGET_STYLES}</style>
<div class="panel" part="panel">
  <header class="titlebar" part="titlebar">
    <span class="title">
      <span class="title-icon" aria-hidden="true">💗</span>
      <span class="title-text">情绪监测器</span>
    </span>
    <span class="session" hidden></span>
    <span class="actions">
      <button class="icon-btn" type="button" data-action="collapse" aria-label="折叠为徽章" title="折叠">—</button>
      <button class="icon-btn" type="button" data-action="close" aria-label="关闭情绪监测器" title="关闭">×</button>
    </span>
  </header>
  <div class="body" part="body">
    <div class="waiting" part="waiting">
      <span class="waiting-dot" aria-hidden="true"></span>
      <span>等待第一条回复…</span>
    </div>
    <div class="scores" part="scores" role="list" aria-label="本回合情绪分数"></div>
    <section class="trend" part="trend" aria-label="会话趋势：最近 30 轮">
      <div class="trend-head"><span>会话趋势</span><span class="trend-hint">最近 30 轮</span></div>
      <canvas class="sparkline" part="sparkline" aria-hidden="true"></canvas>
    </section>
    <div class="meta" part="meta">
      <span class="turn">Turn –</span>
      <span class="dot" aria-hidden="true"> · </span>
      <span class="lang">中文</span>
      <span class="dot" aria-hidden="true"> · </span>
      <span class="latency">--</span>
    </div>
  </div>
</div>
<button class="badge" type="button" part="badge" aria-label="展开情绪监测器">
  <span class="badge-emoji" aria-hidden="true">😐</span>
</button>
`

/** <emotion-monitor>: the floating emotion monitor. */
export class EmotionMonitorElement extends HTMLElement {
  static readonly tagName = EMOTION_MONITOR_TAG

  static get observedAttributes(): string[] {
    return ['data-theme']
  }

  private readonly shadow: ShadowRoot
  private readonly panel: HTMLDivElement
  private readonly titlebar: HTMLElement
  private readonly sessionEl: HTMLSpanElement
  private readonly scoresEl: HTMLDivElement
  private readonly canvas: HTMLCanvasElement
  private readonly badge: HTMLButtonElement
  private readonly badgeEmoji: HTMLSpanElement
  private readonly turnEl: HTMLSpanElement
  private readonly langEl: HTMLSpanElement
  private readonly latencyEl: HTMLSpanElement
  private readonly scoreRows = new Map<EmotionDimension, ScoreRow>()

  private state: EmotionMonitorState = emptyState()
  private view: ViewMode = 'expanded'
  private closed = false
  private hasData = false
  private preview = false
  private previewTimer = 0
  private rafId = 0
  private drag: DragState | null = null
  private mediaQuery: MediaQueryList | null = null
  private restored = false
  private listening = false

  private readonly handleWindowResize = (): void => {
    this.clampCurrentPosition(false)
  }

  private readonly handleSchemeChange = (): void => {
    this.redrawSparkline()
  }

  constructor() {
    super()
    this.shadow = this.attachShadow({ mode: 'open' })
    this.shadow.innerHTML = TEMPLATE
    this.panel = requireElement<HTMLDivElement>(this.shadow, '.panel')
    this.titlebar = requireElement<HTMLElement>(this.shadow, '.titlebar')
    this.sessionEl = requireElement<HTMLSpanElement>(this.shadow, '.session')
    this.scoresEl = requireElement<HTMLDivElement>(this.shadow, '.scores')
    this.canvas = requireElement<HTMLCanvasElement>(this.shadow, '.sparkline')
    this.badge = requireElement<HTMLButtonElement>(this.shadow, '.badge')
    this.badgeEmoji = requireElement<HTMLSpanElement>(this.shadow, '.badge-emoji')
    this.turnEl = requireElement<HTMLSpanElement>(this.shadow, '.meta .turn')
    this.langEl = requireElement<HTMLSpanElement>(this.shadow, '.meta .lang')
    this.latencyEl = requireElement<HTMLSpanElement>(this.shadow, '.meta .latency')
    this.buildScoreRows()
    this.bindEvents()
    // NOTE: a custom element constructor must not add attributes or children to
    // the host (createElement would throw NotSupportedError). applyView() sets
    // host attributes/styles, so it runs from connectedCallback instead.
  }

  /* ---------------------------------------------------------------- */
  /* Custom element lifecycle                                          */
  /* ---------------------------------------------------------------- */

  connectedCallback(): void {
    this.applyHostChrome()
    this.applyView(this.view)
    if (!this.restored) {
      this.restorePreferences()
      this.restored = true
    }
    if (!this.listening) {
      this.listening = true
      window.addEventListener('resize', this.handleWindowResize)
      if (typeof window.matchMedia === 'function') {
        this.mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
        this.mediaQuery.addEventListener('change', this.handleSchemeChange)
      }
    }
    this.applyClosed()
    this.renderState(this.state)
    requestAnimationFrame(() => this.clampCurrentPosition(false))
  }

  disconnectedCallback(): void {
    if (this.listening) {
      this.listening = false
      window.removeEventListener('resize', this.handleWindowResize)
      if (this.mediaQuery) {
        this.mediaQuery.removeEventListener('change', this.handleSchemeChange)
        this.mediaQuery = null
      }
    }
    if (this.rafId !== 0) {
      cancelAnimationFrame(this.rafId)
      this.rafId = 0
    }
    this.clearPreviewTimer()
  }

  attributeChangedCallback(name: string): void {
    if (name === 'data-theme') this.scheduleRender()
  }

  /* ---------------------------------------------------------------- */
  /* Public API (consumed by the client bridge / React portal)         */
  /* ---------------------------------------------------------------- */

  /** Coalesced state update from the host. Safe to call before connect. */
  update(data: EmotionMonitorStateInput | null | undefined): void {
    const hostProvidedTrend = Array.isArray(data?.trend)
    const next = normalizeState(data)
    if (!hostProvidedTrend) {
      if (next.turn > 0 && next.turn < this.state.turn) {
        next.trend = [{ scores: next.scores }]
      } else if (this.state.trend.length > 0) {
        next.trend = trimTrend([...this.state.trend, { scores: next.scores }], MAX_TREND)
      } else {
        next.trend = [{ scores: next.scores }]
      }
    } else if (next.trend.length === 0) {
      next.trend = [{ scores: next.scores }]
    }
    this.state = next
    this.hasData = true
    storageSet(STORAGE_KEYS.trend, serializeTrend(next.trend))
    this.scheduleRender()
  }

  /** Restore the widget after a close: clears persistence and emits open. */
  show(): void {
    const wasClosed = this.closed
    this.closed = false
    storageRemove(STORAGE_KEYS.closed)
    this.applyClosed()
    this.placeAt(this.currentPosition(), false)
    requestAnimationFrame(() => {
      this.clampCurrentPosition(false)
      if (this.view === 'expanded') this.redrawSparkline()
    })
    if (wasClosed) {
      this.dispatchEvent(
        new CustomEvent(OPEN_EVENT, {
          bubbles: true,
          composed: true,
          detail: { turn: this.state.turn, sessionId: this.state.sessionId },
        }),
      )
    }
  }

  /** Hide the widget and remember the closed flag (emits close). */
  hide(): void {
    if (this.closed) return
    this.closed = true
    this.endPreview()
    this.clearPreviewTimer()
    this.applyClosed()
    storageSet(STORAGE_KEYS.closed, '1')
    this.dispatchEvent(
      new CustomEvent(CLOSE_EVENT, {
        bubbles: true,
        composed: true,
        detail: { turn: this.state.turn, sessionId: this.state.sessionId },
      }),
    )
  }

  isClosed(): boolean {
    return this.closed
  }

  /** Forget the saved position and move back to the default corner. */
  resetPosition(): void {
    storageRemove(STORAGE_KEYS.position)
    this.placeAt(this.defaultPosition(), false)
    requestAnimationFrame(() => this.clampCurrentPosition(false))
  }

  /** Collapse to the 48px badge (programmatic; does not emit collapse). */
  collapse(): void {
    this.setCollapsed(true, false)
  }

  /** Expand the full panel (programmatic; does not emit collapse). */
  expand(): void {
    this.setCollapsed(false, false)
  }

  /* ---------------------------------------------------------------- */
  /* DOM construction                                                  */
  /* ---------------------------------------------------------------- */

  private buildScoreRows(): void {
    for (const dimension of EMOTION_DIMENSIONS) {
      const row = document.createElement('div')
      row.className = 'score'
      row.dataset.dimension = dimension
      row.setAttribute('role', 'listitem')
      row.style.setProperty('--score-color', EMOTION_META[dimension].color)

      const label = document.createElement('span')
      label.className = 'score-label'
      label.textContent = EMOTION_META[dimension].label

      const track = document.createElement('div')
      track.className = 'score-track'
      track.setAttribute('role', 'progressbar')
      track.setAttribute('aria-label', EMOTION_META[dimension].label + '分数')
      track.setAttribute('aria-valuemin', '0')
      track.setAttribute('aria-valuemax', '100')
      track.setAttribute('aria-valuenow', '0')

      const fill = document.createElement('div')
      fill.className = 'score-fill'
      track.appendChild(fill)

      const value = document.createElement('span')
      value.className = 'score-value'
      value.textContent = '0%'

      row.append(label, track, value)
      this.scoresEl.appendChild(row)
      this.scoreRows.set(dimension, { row, track, fill, value })
    }
  }

  private bindEvents(): void {
    const collapseButton = requireElement<HTMLButtonElement>(this.shadow, '[data-action="collapse"]')
    const closeButton = requireElement<HTMLButtonElement>(this.shadow, '[data-action="close"]')

    collapseButton.addEventListener('click', () => this.setCollapsed(true, true))
    closeButton.addEventListener('click', () => this.hide())

    this.badge.addEventListener('click', (event) => {
      event.preventDefault()
      this.endPreview()
      this.setCollapsed(false, true)
    })
    this.badge.addEventListener('pointerenter', () => this.schedulePreview())

    this.addEventListener('pointerleave', () => {
      this.clearPreviewTimer()
      if (this.preview) this.endPreview()
    })

    this.titlebar.addEventListener('pointerdown', (event) => this.handleDragStart(event))
    this.titlebar.addEventListener('pointermove', (event) => this.handleDragMove(event))
    this.titlebar.addEventListener('pointerup', (event) => this.handleDragEnd(event, true))
    this.titlebar.addEventListener('pointercancel', (event) => this.handleDragEnd(event, false))
  }

  /* ---------------------------------------------------------------- */
  /* Host chrome + persistence                                         */
  /* ---------------------------------------------------------------- */

  private applyHostChrome(): void {
    // The React portal wrapper is pointer-events:none, so the host element
    // must re-enable pointer events for itself and pin itself to the viewport.
    this.style.position = 'fixed'
    this.style.pointerEvents = 'auto'
    this.style.zIndex = '2147483600'
    this.style.margin = '0'
    this.style.padding = '0'
    if (!this.style.left) this.style.left = '12px'
    if (!this.style.top) this.style.top = '12px'
  }

  private restorePreferences(): void {
    this.closed = storageGet(STORAGE_KEYS.closed) === '1'
    this.view = storageGet(STORAGE_KEYS.collapsed) === '1' ? 'collapsed' : 'expanded'
    const savedTrend = deserializeTrend(storageGet(STORAGE_KEYS.trend))
    if (savedTrend.length > 0) this.state = { ...this.state, trend: savedTrend }
    const fallback = this.defaultPosition()
    const position = parsePosition(storageGet(STORAGE_KEYS.position), fallback)
    this.applyView(this.view)
    this.placeAt(position, false)
  }

  private defaultPosition(): Point {
    const width = this.view === 'collapsed' ? BADGE_SIZE : WIDGET_WIDTH
    const viewportWidth = typeof window === 'undefined' ? 1024 : window.innerWidth
    return { x: Math.max(VIEWPORT_MARGIN, viewportWidth - width - 20), y: 20 }
  }

  private currentPosition(): Point {
    const left = Number.parseFloat(this.style.left)
    const top = Number.parseFloat(this.style.top)
    if (Number.isFinite(left) && Number.isFinite(top)) return { x: left, y: top }
    const rect = this.getBoundingClientRect()
    return { x: rect.left, y: rect.top }
  }

  private placeAt(point: Point, persist: boolean): void {
    const width = this.view === 'collapsed' ? BADGE_SIZE : this.offsetWidth || WIDGET_WIDTH
    const height = this.view === 'collapsed' ? BADGE_SIZE : this.offsetHeight || 360
    const clamped = clampPosition(
      point.x,
      point.y,
      width,
      height,
      window.innerWidth,
      window.innerHeight,
    )
    this.style.left = clamped.x + 'px'
    this.style.top = clamped.y + 'px'
    if (persist) storageSet(STORAGE_KEYS.position, JSON.stringify(clamped))
  }

  private clampCurrentPosition(persist: boolean): void {
    if (this.closed || !this.isConnected) return
    this.placeAt(this.currentPosition(), persist)
  }

  private applyView(view: ViewMode): void {
    this.view = view
    this.setAttribute('data-view', view)
    this.style.width = (view === 'collapsed' ? BADGE_SIZE : WIDGET_WIDTH) + 'px'
    this.style.height = view === 'collapsed' ? BADGE_SIZE + 'px' : 'auto'
  }

  private applyClosed(): void {
    this.toggleAttribute('data-closed', this.closed)
    this.style.display = this.closed ? 'none' : 'block'
  }

  /* ---------------------------------------------------------------- */
  /* Rendering (requestAnimationFrame-coalesced)                       */
  /* ---------------------------------------------------------------- */

  private scheduleRender(): void {
    if (this.rafId !== 0) return
    this.rafId = requestAnimationFrame(() => {
      this.rafId = 0
      this.renderState(this.state)
    })
  }

  private renderState(state: EmotionMonitorState): void {
    if (!this.isConnected) return
    const dominantIntensity = normalizeScore(state.scores[state.dominant])
    for (const dimension of EMOTION_DIMENSIONS) {
      const row = this.scoreRows.get(dimension)
      if (!row) continue
      const percent = scorePercent(state.scores[dimension])
      row.fill.style.width = percent + '%'
      row.value.textContent = percent + '%'
      row.track.setAttribute('aria-valuenow', String(percent))
      row.row.dataset.dominant = dimension === state.dominant ? 'true' : 'false'
    }

    this.turnEl.textContent = formatTurn(state.turn)
    this.langEl.textContent = languageLabel(state.language)
    this.latencyEl.textContent = formatLatency(state.latencyMs)

    if (state.sessionTitle) {
      this.sessionEl.textContent = state.sessionTitle
      this.sessionEl.title = state.sessionTitle
      this.sessionEl.hidden = false
    } else {
      this.sessionEl.textContent = ''
      this.sessionEl.title = ''
      this.sessionEl.hidden = true
    }

    const meta = EMOTION_META[state.dominant]
    const dominantPercent = scorePercent(dominantIntensity)
    this.badgeEmoji.textContent = meta.emoji
    this.badge.style.background = badgeBackground(state.dominant, dominantIntensity)
    this.badge.style.setProperty('--em-badge-glow', badgeGlow(state.dominant, dominantIntensity))
    this.badge.title = meta.label + ' ' + dominantPercent + '% · 点击展开'
    this.badge.setAttribute(
      'aria-label',
      meta.label + ' ' + dominantPercent + '%，点击展开情绪监测器',
    )

    this.setAttribute('data-dominant', state.dominant)
    this.setAttribute('data-status', this.hasData ? 'ready' : 'waiting')

    if (this.view === 'expanded' || this.preview) this.redrawSparkline()
  }

  private redrawSparkline(): void {
    drawSparkline(this.canvas, this.state.trend)
  }

  /* ---------------------------------------------------------------- */
  /* Collapse / hover preview                                          */
  /* ---------------------------------------------------------------- */

  private setCollapsed(collapsed: boolean, emitEvent: boolean): void {
    this.clearPreviewTimer()
    this.endPreview()
    const nextView: ViewMode = collapsed ? 'collapsed' : 'expanded'
    const changed = this.view !== nextView
    this.applyView(nextView)
    storageSet(STORAGE_KEYS.collapsed, collapsed ? '1' : '0')
    this.placeAt(this.currentPosition(), false)
    if (!changed) return
    requestAnimationFrame(() => {
      this.clampCurrentPosition(true)
      if (nextView === 'expanded') this.renderState(this.state)
    })
    if (emitEvent) {
      this.dispatchEvent(
        new CustomEvent(COLLAPSE_EVENT, {
          bubbles: true,
          composed: true,
          detail: { collapsed },
        }),
      )
    }
  }

  private schedulePreview(): void {
    if (this.view !== 'collapsed' || this.closed) return
    this.clearPreviewTimer()
    this.previewTimer = window.setTimeout(() => {
      this.previewTimer = 0
      if (this.view === 'collapsed' && !this.closed) this.startPreview()
    }, 220)
  }

  private clearPreviewTimer(): void {
    if (this.previewTimer !== 0) {
      window.clearTimeout(this.previewTimer)
      this.previewTimer = 0
    }
  }

  private startPreview(): void {
    if (this.preview) return
    this.preview = true
    this.setAttribute('data-preview', 'true')
    this.panel.style.visibility = 'hidden'

    const panelRect = this.panel.getBoundingClientRect()
    const hostRect = this.getBoundingClientRect()
    let left = 0
    let top = 0
    if (hostRect.left + panelRect.width > window.innerWidth - VIEWPORT_MARGIN) {
      left = hostRect.width - panelRect.width
    }
    if (hostRect.top + panelRect.height > window.innerHeight - VIEWPORT_MARGIN) {
      top = hostRect.height - panelRect.height
    }
    if (hostRect.left + left < VIEWPORT_MARGIN) left = VIEWPORT_MARGIN - hostRect.left
    if (hostRect.top + top < VIEWPORT_MARGIN) top = VIEWPORT_MARGIN - hostRect.top
    this.panel.style.left = Math.round(left) + 'px'
    this.panel.style.top = Math.round(top) + 'px'
    this.panel.style.visibility = ''
    this.renderState(this.state)
  }

  private endPreview(): void {
    if (!this.preview) return
    this.preview = false
    this.removeAttribute('data-preview')
    this.panel.style.left = ''
    this.panel.style.top = ''
    this.panel.style.visibility = ''
  }

  /* ---------------------------------------------------------------- */
  /* Drag (pointer events on the title bar)                            */
  /* ---------------------------------------------------------------- */

  private handleDragStart(event: PointerEvent): void {
    if (event.button !== 0) return
    const target = event.target
    if (target instanceof Element && target.closest('button')) return
    if (this.view !== 'expanded') {
      if (this.preview) this.setCollapsed(false, true)
      return
    }
    event.preventDefault()
    const position = this.currentPosition()
    this.drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: position.x,
      originY: position.y,
      moved: false,
    }
    this.titlebar.setPointerCapture(event.pointerId)
    this.titlebar.classList.add('is-dragging')
  }

  private handleDragMove(event: PointerEvent): void {
    const drag = this.drag
    if (!drag || drag.pointerId !== event.pointerId) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) >= 3) drag.moved = true
    if (!drag.moved) return
    const clamped = clampPosition(
      drag.originX + dx,
      drag.originY + dy,
      this.offsetWidth || WIDGET_WIDTH,
      this.offsetHeight || 360,
      window.innerWidth,
      window.innerHeight,
    )
    this.style.left = clamped.x + 'px'
    this.style.top = clamped.y + 'px'
  }

  private handleDragEnd(event: PointerEvent, persist: boolean): void {
    const drag = this.drag
    if (!drag || drag.pointerId !== event.pointerId) return
    this.drag = null
    this.titlebar.classList.remove('is-dragging')
    if (this.titlebar.hasPointerCapture(event.pointerId)) {
      this.titlebar.releasePointerCapture(event.pointerId)
    }
    if (drag.moved && persist) {
      storageSet(STORAGE_KEYS.position, JSON.stringify(this.currentPosition()))
    }
  }
}

/**
 * Register the element. Idempotent: the module already registers the default
 * tag on import, so standalone/demo or host code can call this again safely.
 */
export function defineEmotionMonitor(tagName: string = EMOTION_MONITOR_TAG): void {
  if (typeof customElements === 'undefined') return
  if (customElements.get(tagName)) return
  customElements.define(tagName, EmotionMonitorElement)
}

// Module side effect: importing the widget is enough (lead/client contract).
defineEmotionMonitor()
