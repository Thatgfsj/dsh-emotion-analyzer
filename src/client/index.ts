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
/** Plugin Manager bundle page; keyed by the package name. */
const PLUGIN_BUNDLE_CONFIG_SLOT = 'plugins.bundle.config'
const PLUGIN_PACKAGE_NAME = 'dsh-emotion-analyzer'
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
    const dataSessionId = data === null ? null : (data.sessionId ?? null)
    // Issue #62 H7: re-apply the current snapshot when the widget remounts
    // (hidden → shown) and reset it when the active session has no data.
    React.useEffect(() => {
      const element = elementRef.current
      if (element === null) return
      if (data === null) {
        if (typeof element.reset === 'function') element.reset()
        return
      }
      if (typeof element.update === 'function') element.update(data)
    }, [data, visible, dataSessionId])

    // Issue #34: no close event / reopen chip. Visibility is owned solely by
    // Settings → 情绪分析器; the widget itself has no close button.
    React.useEffect(() => {
      if (!visible) return
      const element = elementRef.current
      if (element !== null && typeof element.isClosed === 'function' && element.isClosed() && typeof element.show === 'function') {
        element.show()
      }
    }, [visible])

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
          // Inline configuration on the plugin's own page in Plugin Manager.
          install(PLUGIN_BUNDLE_CONFIG_SLOT, 'emotion-analyzer-bundle-config', 0, SettingsSection, {
            key: PLUGIN_PACKAGE_NAME,
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
