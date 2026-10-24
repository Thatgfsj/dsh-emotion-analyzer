/**
 * dsh-emotion-analyzer — Web client entry (scaffold).
 * Wrapped by scripts/build.mjs into window.__ModuleLoader__.load({...}).
 * The real shell.overlay registration lands in issue #7.
 */
export default function createPlugin(require: (id: string) => any): {
  inject: string[]
  apply: (ctx: { effect: (fn: () => (() => void) | void) => void }) => void
} {
  void require
  return {
    inject: [],
    apply() {
      // no-op until the widget bridge module is merged
    },
  }
}
