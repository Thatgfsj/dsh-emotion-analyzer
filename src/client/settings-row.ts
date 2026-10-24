/**
 * One row in Settings → General: show/hide the floating emotion monitor.
 *
 * The row is self-contained: the `settings.general.item` seat passes no owner
 * props and the preference is a pure client-side display toggle, so the value
 * lives in localStorage and is broadcast through a window CustomEvent. No
 * host config, no transport, no `@deepseek-ai/dsh-client-*` runtime import.
 */

/** localStorage key holding the visible preference. */
export const VISIBLE_KEY = 'dsh-emotion-analyzer.visible'
/** Window event broadcast when the preference changes. */
export const VISIBILITY_EVENT = 'emotion-analyzer-visibility'
/** Window event asking the mounted widget to forget its saved position. */
export const RESET_EVENT = 'emotion-analyzer-reset'

/** Read the persisted visibility preference (default: visible). */
export function readVisible(): boolean {
  try {
    return localStorage.getItem(VISIBLE_KEY) !== '0'
  } catch {
    return true
  }
}

/**
 * Persist and broadcast a visibility preference.
 * @param visible - whether the floating monitor should be shown.
 */
export function writeVisible(visible: boolean): void {
  try {
    localStorage.setItem(VISIBLE_KEY, visible ? '1' : '0')
  } catch {
    // private mode: keep the in-memory event path working
  }
  try {
    window.dispatchEvent(new CustomEvent(VISIBILITY_EVENT, { detail: { visible } }))
  } catch {
    // non-browser test environments
  }
}

/**
 * Build the settings row component with the host-provided React runtime.
 * @param React - host React module.
 * @returns a React component rendering the toggle row.
 */
export function createSettingsRow(React: any): (props?: Record<string, unknown>) => any {
  return function EmotionMonitorSettingsRow(): any {
    const [visible, setVisible] = React.useState(() => readVisible())
    React.useEffect(() => {
      const onChange = (event: Event): void => {
        const detail = (event as CustomEvent<{ visible?: boolean }>).detail
        if (typeof detail?.visible === 'boolean') setVisible(detail.visible)
      }
      window.addEventListener(VISIBILITY_EVENT, onChange)
      return () => window.removeEventListener(VISIBILITY_EVENT, onChange)
    }, [])
    return React.createElement(
      'div',
      {
        'data-emotion-analyzer-setting': '',
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
          padding: '10px 0',
        },
      },
      React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
        React.createElement('span', { style: { fontWeight: 500 } }, '情绪监测悬浮框'),
        React.createElement(
          'span',
          { style: { fontSize: '12px', opacity: 0.65 } },
          '在主模型回复后显示实时情绪分数（关闭后可用此行重新开启）',
        ),
      ),
      React.createElement('input', {
        type: 'checkbox',
        checked: visible,
        'aria-label': '显示情绪监测悬浮框',
        onChange: (event: any) => {
          const next = Boolean(event.target.checked)
          setVisible(next)
          writeVisible(next)
        },
      }),
    )
  }
}

/**
 * Full Settings page (the `settings.section` seat) with all maintenance
 * actions in one place: show/hide, show now, reset position, clear trend.
 * @param React - host React module.
 * @returns a React component rendering the section content.
 */
export function createSettingsSection(React: any): (props?: Record<string, unknown>) => any {
  const buttonStyle = {
    border: '1px solid var(--dsw-alias-border-l2, rgba(15,23,42,.15))',
    background: 'var(--dsw-alias-bg-base, #fff)',
    color: 'var(--dsw-alias-label-primary, #111827)',
    borderRadius: '8px',
    padding: '6px 12px',
    fontSize: '13px',
    cursor: 'pointer',
  }
  return function EmotionMonitorSettingsSection(): any {
    const [visible, setVisible] = React.useState(() => readVisible())
    React.useEffect(() => {
      const onChange = (event: Event): void => {
        const detail = (event as CustomEvent<{ visible?: boolean }>).detail
        if (typeof detail?.visible === 'boolean') setVisible(detail.visible)
      }
      window.addEventListener(VISIBILITY_EVENT, onChange)
      return () => window.removeEventListener(VISIBILITY_EVENT, onChange)
    }, [])
    const setShown = (next: boolean): void => {
      setVisible(next)
      writeVisible(next)
    }
    return React.createElement(
      'div',
      { 'data-emotion-analyzer-section': '', style: { display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: '640px' } },
      React.createElement('p', { style: { margin: 0, fontSize: '13px', lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary, #4b5563)' } },
        '对主模型每条回复做本地情绪打分，并在页面右上角显示紧凑 emoji 徽章。悬浮框的显示/隐藏只由本页开关控制。'),
      React.createElement(
        'label',
        { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px' } },
        React.createElement('span', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
          React.createElement('span', { style: { fontWeight: 500 } }, '显示情绪监测悬浮框'),
          React.createElement('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, #6b7280)' } }, '关闭后仍然计分，只是不显示浮层。')),
        React.createElement('input', {
          type: 'checkbox',
          checked: visible,
          'aria-label': '显示情绪监测悬浮框',
          onChange: (event: any) => setShown(Boolean(event.target.checked)),
        })),
      React.createElement(
        'div',
        { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
        React.createElement('button', { type: 'button', style: buttonStyle, onClick: () => setShown(true) }, '立即显示'),
        React.createElement('button', {
          type: 'button',
          style: buttonStyle,
          onClick: () => {
            try {
              localStorage.removeItem('dsh-emotion-monitor:position')
              localStorage.removeItem('dsh-emotion-monitor:collapsed')
            } catch {}
            try {
              window.dispatchEvent(new CustomEvent(RESET_EVENT))
            } catch {}
            setShown(true)
          },
        }, '重置位置并显示'),
        React.createElement('button', {
          type: 'button',
          style: buttonStyle,
          onClick: () => {
            try {
              localStorage.removeItem('dsh-emotion-monitor:trend')
            } catch {}
          },
        }, '清除趋势历史'),
      ),
      React.createElement('p', { style: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, #6b7280)' } },
        '悬浮框位置、折叠状态与最近 30 轮趋势保存在浏览器 localStorage；清除趋势只会影响当前浏览器的历史曲线。'),
    )
  }
}
