/**
 * dsh-emotion-analyzer — Shadow DOM stylesheet + design tokens.
 *
 * Everything the widget needs is declared here (inside the shadow root), so
 * host pages cannot leak fonts, colours or layout into the panel. Optional
 * host design tokens (--dsw-alias-*) are only used as a focus-ring fallback;
 * every other value has a self-contained default for light and dark modes.
 */

/** Light theme tokens. */
const LIGHT_TOKENS = `
  --em-bg: rgba(255, 255, 255, 0.98);
  --em-titlebar: linear-gradient(180deg, #ffffff 0%, #f5f7fb 100%);
  --em-border: rgba(15, 23, 42, 0.10);
  --em-divider: rgba(15, 23, 42, 0.08);
  --em-text: #111827;
  --em-text-secondary: #46536a;
  --em-text-muted: #8b95a5;
  --em-track: rgba(15, 23, 42, 0.07);
  --em-shadow: 0 20px 48px -16px rgba(15, 23, 42, 0.42), 0 4px 12px rgba(15, 23, 42, 0.10);
  --em-hover: rgba(15, 23, 42, 0.06);
  --em-hover-danger: rgba(229, 72, 77, 0.12);
  --em-focus: var(--dsw-alias-brand-primary, #4f7cff);
  --em-grid: rgba(15, 23, 42, 0.10);
  --em-empty: rgba(15, 23, 42, 0.34);
  --em-badge-ring: rgba(255, 255, 255, 0.92);
`

/** Dark theme tokens (same variable names). */
const DARK_TOKENS = `
  --em-bg: rgba(22, 24, 29, 0.98);
  --em-titlebar: linear-gradient(180deg, #1d2028 0%, #16181d 100%);
  --em-border: rgba(255, 255, 255, 0.12);
  --em-divider: rgba(255, 255, 255, 0.09);
  --em-text: #eef1f6;
  --em-text-secondary: #b3bccb;
  --em-text-muted: #7f8a9b;
  --em-track: rgba(255, 255, 255, 0.10);
  --em-shadow: 0 22px 60px -18px rgba(0, 0, 0, 0.75), 0 4px 14px rgba(0, 0, 0, 0.45);
  --em-hover: rgba(255, 255, 255, 0.08);
  --em-hover-danger: rgba(229, 72, 77, 0.22);
  --em-focus: var(--dsw-alias-brand-primary, #7aa2ff);
  --em-grid: rgba(255, 255, 255, 0.12);
  --em-empty: rgba(255, 255, 255, 0.38);
  --em-badge-ring: rgba(255, 255, 255, 0.35);
`

/** Complete shadow-root stylesheet. Injected as a <style> element. */
export const WIDGET_STYLES = `
/* ------------------------------------------------------------------ */
/* Design tokens                                                       */
/* ------------------------------------------------------------------ */
:host {
  ${LIGHT_TOKENS}  position: fixed;
  top: 12px;
  left: 12px;
  display: block;
  width: 328px;
  margin: 0;
  padding: 0;
  z-index: 2147483600;
  pointer-events: auto;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}

:host([data-view='collapsed']) {
  width: 64px;
  height: 64px;
}

:host([data-closed]) {
  display: none;
}

@media (prefers-color-scheme: dark) {
  :host(:not([data-theme='light'])) {
    ${DARK_TOKENS}  }
}

:host([data-theme='dark']) {
  ${DARK_TOKENS}}

/* ------------------------------------------------------------------ */
/* Shared typography + reset                                           */
/* ------------------------------------------------------------------ */
.panel,
.panel *,
.badge,
.badge * {
  box-sizing: border-box;
}

.panel,
.badge {
  font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
    'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
  font-size: 12px;
  line-height: 1.4;
  color: var(--em-text);
  font-variant-numeric: tabular-nums;
  -webkit-tap-highlight-color: transparent;
}

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */
.panel {
  display: flex;
  flex-direction: column;
  width: 328px;
  background: var(--em-bg);
  border: 1px solid var(--em-border);
  border-radius: 16px;
  box-shadow: var(--em-shadow);
  overflow: hidden;
  -webkit-backdrop-filter: blur(14px) saturate(140%);
  backdrop-filter: blur(14px) saturate(140%);
  transform: translateZ(0);
}

:host([data-view='collapsed']) .panel {
  display: none;
}

/* Hover preview keeps the host at badge size and overlays the panel. */
:host([data-view='collapsed'][data-preview='true']) .panel {
  display: flex;
  position: absolute;
  top: 0;
  left: 0;
  z-index: 2;
}

:host([data-view='collapsed'][data-preview='true']) .badge {
  visibility: hidden;
}

/* ------------------------------------------------------------------ */
/* Title bar                                                           */
/* ------------------------------------------------------------------ */
.titlebar {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 40px;
  padding: 0 6px 0 12px;
  background: var(--em-titlebar);
  border-bottom: 1px solid var(--em-divider);
  cursor: grab;
  user-select: none;
  -webkit-user-select: none;
  touch-action: none;
}

.titlebar.is-dragging {
  cursor: grabbing;
}

.title {
  display: flex;
  align-items: center;
  gap: 5px;
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  font-size: 13px;
  font-weight: 650;
  letter-spacing: 0.01em;
  color: var(--em-text);
  white-space: nowrap;
}

.title-icon {
  flex: 0 0 auto;
  font-size: 13px;
  filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.12));
}

.session {
  flex: 0 1 auto;
  max-width: 96px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding-left: 4px;
  font-size: 10.5px;
  color: var(--em-text-muted);
}

.session[hidden] {
  display: none;
}

.actions {
  display: flex;
  flex: 0 0 auto;
  gap: 2px;
  margin-left: auto;
}

.icon-btn {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--em-text-secondary);
  font: inherit;
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
  transition: background-color 120ms ease, color 120ms ease;
}

.icon-btn:hover {
  background: var(--em-hover);
  color: var(--em-text);
}

.icon-btn[data-action='close']:hover {
  background: var(--em-hover-danger);
  color: #e5484d;
}

.icon-btn:active {
  transform: translateY(0.5px);
}

.icon-btn:focus-visible,
.badge:focus-visible {
  outline: 2px solid var(--em-focus);
  outline-offset: 1px;
}

/* ------------------------------------------------------------------ */
/* Score bars                                                          */
/* ------------------------------------------------------------------ */
.body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px 12px 11px;
}

.scores {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.score {
  display: grid;
  grid-template-columns: 40px minmax(0, 1fr) 34px;
  align-items: center;
  gap: 8px;
}

.score-label {
  font-size: 11px;
  letter-spacing: 0.02em;
  color: var(--em-text-secondary);
  white-space: nowrap;
}

.score[data-dominant='true'] .score-label {
  color: var(--em-text);
  font-weight: 650;
}

.score-track {
  position: relative;
  height: 6px;
  border-radius: 999px;
  background: var(--em-track);
  overflow: hidden;
}

.score-fill {
  width: 0;
  height: 100%;
  border-radius: inherit;
  background: var(--score-color, var(--em-text-muted));
  transition: width 300ms cubic-bezier(0.22, 0.61, 0.36, 1);
  will-change: width;
}

.score-value {
  font-size: 10.5px;
  color: var(--em-text-muted);
  text-align: right;
}

/* ------------------------------------------------------------------ */
/* Sparkline                                                           */
/* ------------------------------------------------------------------ */
.trend {
  padding-top: 8px;
  border-top: 1px dashed var(--em-divider);
}

.trend-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 2px;
  font-size: 10px;
  letter-spacing: 0.02em;
  color: var(--em-text-muted);
}

.trend-hint {
  opacity: 0.8;
}

.sparkline {
  display: block;
  width: 100%;
  height: 88px;
}

/* ------------------------------------------------------------------ */
/* Waiting for the first reply                                         */
/* ------------------------------------------------------------------ */
.waiting {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 14px 2px;
  font-size: 11px;
  color: var(--em-text-muted);
}

.waiting-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  animation: em-waiting 1.6s ease-in-out infinite;
}

@keyframes em-waiting {
  0%,
  100% {
    opacity: 0.35;
    transform: scale(0.85);
  }
  50% {
    opacity: 1;
    transform: scale(1);
  }
}

:host([data-status='ready']) .waiting {
  display: none;
}

:host(:not([data-status='ready'])) .scores,
:host(:not([data-status='ready'])) .trend {
  display: none;
}

/* ------------------------------------------------------------------ */
/* Meta line                                                           */
/* ------------------------------------------------------------------ */
.meta {
  display: flex;
  align-items: center;
  gap: 7px;
  padding-top: 8px;
  border-top: 1px solid var(--em-divider);
  font-size: 10px;
  color: var(--em-text-muted);
}

.meta .turn {
  color: var(--em-text-secondary);
  font-weight: 600;
}

.meta .dot {
  color: var(--em-text-muted);
  opacity: 0.6;
}

/* ------------------------------------------------------------------ */
/* Collapsed badge                                                     */
/* ------------------------------------------------------------------ */
.badge {
  display: none;
  position: relative;
  place-items: center;
  width: 64px;
  height: 64px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: rgba(138, 147, 163, 0.82);
  color: #ffffff;
  cursor: pointer;
  box-shadow: 0 10px 26px -8px var(--em-badge-glow, rgba(15, 23, 42, 0.45)),
    0 0 0 1px var(--em-border), inset 0 1px 0 rgba(255, 255, 255, 0.35);
  transition: transform 160ms ease, box-shadow 160ms ease;
}

:host([data-view='collapsed']) .badge {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
  cursor: grab;
  touch-action: none;
}

.badge.is-dragging {
  cursor: grabbing;
}

.badge:hover {
  transform: scale(1.07);
}

.badge:active {
  transform: scale(0.96);
}

.badge-emoji {
  position: relative;
  z-index: 1;
  font-size: 22px;
  line-height: 1;
  filter: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.28));
}

.badge-label {
  position: relative;
  z-index: 1;
  max-width: 56px;
  overflow: hidden;
  color: rgba(255, 255, 255, 0.96);
  font-size: 9px;
  font-weight: 650;
  line-height: 1;
  letter-spacing: 0.02em;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.28);
  white-space: nowrap;
}

.badge::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 50%;
  box-shadow: inset 0 0 0 2px var(--em-badge-ring);
  pointer-events: none;
}

/* ------------------------------------------------------------------ */
/* Motion preferences                                                  */
/* ------------------------------------------------------------------ */
@media (prefers-reduced-motion: reduce) {
  .score-fill {
    transition-duration: 0ms;
  }

  .badge {
    transition: none;
  }

  .waiting-dot {
    animation: none;
  }
}
`
