/**
 * dsh-emotion-analyzer — hand-drawn canvas sparkline (no chart library).
 *
 * One polyline per emotion dimension, latest 30 turns, using the exact same
 * colours as the score bars. Rendering talks to the canvas only; series
 * shaping and point projection live in state.ts so they stay unit-testable.
 */
import {
  EMOTION_DIMENSIONS,
  EMOTION_META,
  projectSparklinePoint,
  sparklineSeries,
  type EmotionDimension,
  type TrendPoint,
} from './state.js'

export interface SparklineOptions {
  /** CSS pixels; defaults to the canvas client size. */
  width?: number
  height?: number
  /** Inner padding in CSS pixels. */
  padding?: number
  /** Dimensions to draw (defaults to all seven). */
  dimensions?: readonly EmotionDimension[]
  /** Placeholder text when there is no trend yet. */
  emptyLabel?: string
}

const FALLBACK_GRID = 'rgba(15, 23, 42, 0.10)'
const FALLBACK_EMPTY = 'rgba(15, 23, 42, 0.34)'
const FONT_STACK = "11px system-ui, -apple-system, 'Segoe UI', sans-serif"

function readVar(style: CSSStyleDeclaration, name: string, fallback: string): string {
  const value = style.getPropertyValue(name)
  return value && value.trim().length > 0 ? value.trim() : fallback
}

/**
 * Paint the trend onto the canvas. Safe to call when the widget is collapsed:
 * a zero-sized canvas is simply skipped and repainted on the next expand.
 */
export function drawSparkline(
  canvas: HTMLCanvasElement,
  trend: readonly TrendPoint[],
  options: SparklineOptions = {},
): void {
  const width = options.width ?? canvas.clientWidth
  const height = options.height ?? canvas.clientHeight
  if (!(width > 0 && height > 0)) return

  const dpr = Math.max(1, Math.min(3, (typeof window !== 'undefined' && window.devicePixelRatio) || 1))
  const pixelWidth = Math.max(1, Math.round(width * dpr))
  const pixelHeight = Math.max(1, Math.round(height * dpr))
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight

  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)

  const style = typeof getComputedStyle === 'function' ? getComputedStyle(canvas) : null
  const grid = style ? readVar(style, '--em-grid', FALLBACK_GRID) : FALLBACK_GRID
  const empty = style ? readVar(style, '--em-empty', FALLBACK_EMPTY) : FALLBACK_EMPTY

  // Faint grid: 25 / 50 / 75 percent lines.
  ctx.lineWidth = 1
  ctx.strokeStyle = grid
  for (let i = 1; i <= 3; i += 1) {
    const y = (height / 4) * i
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(width, y)
    ctx.stroke()
  }

  if (trend.length === 0) {
    ctx.setLineDash([3, 4])
    ctx.beginPath()
    ctx.moveTo(0, height / 2)
    ctx.lineTo(width, height / 2)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = empty
    ctx.font = FONT_STACK
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(options.emptyLabel ?? '等待趋势数据', width / 2, height / 2 - 8)
    return
  }

  const padding = options.padding ?? 3
  const series = sparklineSeries(trend, options.dimensions ?? EMOTION_DIMENSIONS)
  for (const item of series) {
    if (item.values.every((value) => value <= 0.001)) continue
    ctx.beginPath()
    item.values.forEach((value, index) => {
      const point = projectSparklinePoint(value, index, item.values.length, width, height, padding)
      if (index === 0) ctx.moveTo(point.x, point.y)
      else ctx.lineTo(point.x, point.y)
    })
    ctx.globalAlpha = 0.92
    ctx.strokeStyle = EMOTION_META[item.dimension].color
    ctx.lineWidth = 1.5
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.stroke()
    ctx.globalAlpha = 1

    const lastIndex = item.values.length - 1
    if (lastIndex >= 0) {
      const last = projectSparklinePoint(
        item.values[lastIndex] ?? 0,
        lastIndex,
        item.values.length,
        width,
        height,
        padding,
      )
      ctx.fillStyle = EMOTION_META[item.dimension].color
      ctx.beginPath()
      ctx.arc(last.x, last.y, 1.8, 0, Math.PI * 2)
      ctx.fill()
    }
  }
  ctx.globalAlpha = 1
}
