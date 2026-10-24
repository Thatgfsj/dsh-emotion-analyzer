/**
 * Minimal local typings for the one runtime module this plugin imports from
 * the DSH host. Calibrated against DSH 0.2.1-rc.2
 * (@deepseek-ai/dsh-session/lib/types/index.d.ts). See docs/calibration.md.
 */
declare module '@deepseek-ai/dsh-session' {
  /** Opaque event envelope; only the fields this plugin reads are declared. */
  export interface SessionEvent {
    readonly type: string
    readonly seq: number
    readonly ignorable?: boolean
    readonly data?: unknown
  }
  /** The slice of the live Session API used by the host plugin. */
  export interface Session {
    readonly id: string
    deriveMessages(): readonly unknown[]
  }
  /** One committed plugin-owned record. */
  export interface PluginRecord {
    readonly type: `plugin:${string}`
    readonly data: unknown
  }
  export function appendPluginRecord(
    session: Session,
    type: `plugin:${string}`,
    data: Record<string, unknown>,
  ): number
  export function pluginRecordOf(event: SessionEvent): PluginRecord | undefined
}
