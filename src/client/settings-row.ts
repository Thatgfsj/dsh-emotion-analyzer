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
