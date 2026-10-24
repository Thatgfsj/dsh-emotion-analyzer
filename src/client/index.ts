/**
 * dsh-emotion-analyzer — Web client entry.
 *
 * Two registrations, both through the public slot system:
 * 1. `conversation.session.header.utilities` (session scope, list slot):
 *    an invisible bridge reading `useProjection('emotion')` into the store.
 * 2. `shell.overlay` (root scope, list slot): the floating widget, portalled
 *    to document.body so it survives SPA navigation and AppFrame z-indexing.
 *
 * No `@deepseek-ai/dsh-client-*` runtime import; React/ReactDOM come from the
 * host platform seed via the factory `require`.
 */
import { EmotionMonitorElement } from '../widget/emotion-monitor.ts'
import {
  RESET_EVENT,
  VISIBILITY_EVENT,
  createSettingsRow,
  createSettingsSection,
  readVisible,
  writeVisible,
} from './settings-row.ts'
import {
  getEmotionSnapshot,
  publishEmotion,
  subscribeEmotion,
  type EmotionStoreSnapshot,
} from './store.ts'
import type { WidgetData } from './store.ts'

type RequireFn = (id: string) => any

interface ClientContext {
  effect?: (fn: () => (() => void) | void) => unknown
  slots?: {
    inject: (name: string, register: () => unknown) => unknown
    register: (options: Record<string, unknown>, component: unknown) => unknown
  }
}

const OVERLAY_SLOT = 'shell.overlay'
const BRIDGE_SLOT = 'conversation.session.header.utilities'
const SETTINGS_SLOT = 'settings.general.item'
const SETTINGS_SECTION_SLOT = 'settings.section'
const WIDGET_TAG = 'emotion-monitor'

/**
 * Client plugin factory (wrapped by scripts/build.mjs into
 * `window.__ModuleLoader__.load({ id, factory })`).
 * @param require - host module table accessor (react / react-dom).
 * @returns the Cordis client plugin object.
 */
export default function createPlugin(require: RequireFn): {
  inject: string[]
  apply: (ctx: ClientContext) => void
} {
  const React = require('react')
  const ReactDOM = require('react-dom')
  const h = React.createElement

  void EmotionMonitorElement

  function Bridge(props: {
    sessionId?: string
    useProjection?: (key: string) => unknown
  }): null {
    const readProjection =
      typeof props.useProjection === 'function' ? props.useProjection : () => undefined
    const value = readProjection('emotion')
    React.useEffect(() => {
      publishEmotion(value as any, props.sessionId)
    }, [props.sessionId, value])
    return null
  }

  function OverlayEntry(): any {
    const [snapshot, setSnapshot] = React.useState(() =>
      getEmotionSnapshot(),
    )
    const [closed, setClosed] = React.useState(false)
    const [visible, setVisible] = React.useState(() => readVisible())
    const elementRef = React.useRef(null)

    React.useEffect(() => {
      const onVisibility = (event: Event): void => {
        const detail = (event as CustomEvent<{ visible?: boolean }>).detail
        if (typeof detail?.visible === 'boolean') setVisible(detail.visible)
      }
      window.addEventListener(VISIBILITY_EVENT, onVisibility)
      return () => window.removeEventListener(VISIBILITY_EVENT, onVisibility)
    }, [])

    React.useEffect(() => {
      const onReset = (): void => {
        const element = elementRef.current
        if (element !== null && typeof element.resetPosition === 'function') element.resetPosition()
      }
      window.addEventListener(RESET_EVENT, onReset)
      return () => window.removeEventListener(RESET_EVENT, onReset)
    }, [])

    React.useEffect(() => subscribeEmotion((next) => setSnapshot(next)), [])

    const data: WidgetData | null = snapshot.data
    React.useEffect(() => {
      const element = elementRef.current
      if (element !== null && data !== null && typeof element.update === 'function') {
        element.update(data)
      }
    }, [data])

    React.useEffect(() => {
      const element = elementRef.current
      if (element === null) return undefined
      const onClose = (): void => {
        setClosed(true)
        writeVisible(false)
      }
      const onOpen = (): void => {
        setClosed(false)
        writeVisible(true)
      }
      element.addEventListener('emotion-monitor-close', onClose)
      element.addEventListener('emotion-monitor-open', onOpen)
      if (typeof element.isClosed === 'function') setClosed(element.isClosed())
      return () => {
        element.removeEventListener('emotion-monitor-close', onClose)
        element.removeEventListener('emotion-monitor-open', onOpen)
      }
    }, [visible])

    React.useEffect(() => {
      if (!visible || closed) return
      const element = elementRef.current
      if (element !== null && typeof element.isClosed === 'function' && element.isClosed() && typeof element.show === 'function') {
        element.show()
      }
    }, [visible, closed])

    const reopen = (): void => {
      const element = elementRef.current
      if (element !== null && typeof element.show === 'function') element.show()
      setClosed(false)
      setVisible(true)
      writeVisible(true)
    }

    const children: any[] = visible
      ? [
          h(WIDGET_TAG, {
            key: 'monitor',
            ref: (node: any) => {
              elementRef.current = node
            },
          }),
        ]
      : []
    if (!visible || closed) {
      children.push(
        h(
          'button',
          {
            key: 'reopen',
            type: 'button',
            title: '显示情绪监测器',
            'aria-label': '显示情绪监测器',
            onClick: reopen,
            style: {
              position: 'fixed',
              right: '12px',
              top: '12px',
              height: '34px',
              padding: '0 12px',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              borderRadius: '999px',
              border: '1px solid rgba(255,255,255,.25)',
              background: 'rgba(30,30,36,.88)',
              color: '#fff',
              fontSize: '13px',
              lineHeight: '1',
              cursor: 'pointer',
              pointerEvents: 'auto',
              zIndex: 2147483646,
              boxShadow: '0 6px 20px rgba(0,0,0,.28)',
            },
          },
          '💗 情绪',
        ),
      )
    }

    return ReactDOM.createPortal(
      h(
        'div',
        {
          'data-dsh-emotion-analyzer': '',
          style: {
            position: 'fixed',
            inset: 0,
            pointerEvents: 'none',
            zIndex: 2147483000,
          },
        },
        children,
      ),
      document.body,
    )
  }

  return {
    inject: ['slots'],
    apply(ctx: ClientContext) {
      if (ctx.slots === undefined) return
      const slots = ctx.slots
      const install = (
        name: string,
        id: string,
        order: number,
        component: unknown,
        extra: Record<string, unknown> = {},
      ): (() => void) => {
        const dispose = slots.inject(name, () => slots.register({ name, id, order, ...extra }, component))
        return typeof dispose === 'function' ? (dispose as () => void) : () => {}
      }
      const SettingsRow = createSettingsRow(React)
      const SettingsSection = createSettingsSection(React)
      const installAll = (): (() => void) => {
        const disposers = [
          install(OVERLAY_SLOT, 'emotion-analyzer', 20, OverlayEntry),
          install(BRIDGE_SLOT, 'emotion-analyzer-bridge', 50, Bridge),
          install(SETTINGS_SLOT, 'emotion-analyzer-settings', 60, SettingsRow),
          install(SETTINGS_SECTION_SLOT, 'emotion-analyzer-section', 70, SettingsSection, {
            label: '情绪分析器 / Emotion Monitor',
          }),
        ]
        return () => {
          for (const dispose of disposers.reverse()) dispose()
        }
      }
      if (typeof ctx.effect === 'function') ctx.effect(installAll)
      else installAll()
    },
  }
}
