/**
 * Browser pane access, pure core (T564 U1, spec §6.3, §7.1 and §7.4): what an agent may do with a pane,
 * decided at PLAN level so a refused call never raises a confirm first (the ADR-0020 rule).
 *
 * Two halves. {@link gateBrowserOp} is a pure function of a resolved {@link BrowserGateInput}; and
 * {@link createBrowserAccess} holds the operator's per-pane decisions (Disconnect, Pause) behind an injected
 * clock. The kill-switch and the folder block are read by the shell (`mcp/prefs.ts`, the plan's base gate).
 *
 * The lease tier of spec §7.1 belongs to a later unit: until it exists, a write that WOULD need a lease
 * (any write to an operator-opened pane) refuses `NOT_YET_AVAILABLE` rather than running unattended.
 */
import type { OriginClass } from './origin-class'

/** Every `browser_*` op of the spec (§6.1); U1 wires `open`, `list`, `navigate` and `close`. */
export const BROWSER_OPS = [
  'browser_open',
  'browser_navigate',
  'browser_list',
  'browser_snapshot',
  'browser_screenshot',
  'browser_console',
  'browser_network',
  'browser_set_data',
  'browser_patch',
  'browser_eval',
  'browser_click',
  'browser_type',
  'browser_fill',
  'browser_press',
  'browser_wait_for',
  'browser_emulate',
  'browser_upload',
  'browser_download',
  'browser_close'
] as const
export type BrowserOp = (typeof BROWSER_OPS)[number]

/** Verbs that create or list and so address no single pane. */
const PANELESS_OPS: ReadonlySet<string> = new Set(['browser_open', 'browser_list'])

/** Read-class verbs (spec §6.1 class R): they observe and never change the page. */
const READ_OPS: ReadonlySet<string> = new Set([
  'browser_list',
  'browser_snapshot',
  'browser_screenshot',
  'browser_console',
  'browser_wait_for'
])

export function isBrowserOp(op: string): op is BrowserOp {
  return (BROWSER_OPS as readonly string[]).includes(op)
}

/** Whether `op` changes a pane (every verb that is not a read; `browser_network` counts as a write). */
export function isBrowserWriteOp(op: string): boolean {
  return isBrowserOp(op) && !READ_OPS.has(op)
}

/** The refusals this core returns, in the order it checks them (spec §6.3). */
export type BrowserDenyReason =
  | 'PANE_NOT_FOUND'
  | 'BROWSER_DISCONNECTED'
  | 'BROWSER_WRITES_DISABLED'
  | 'BROWSER_PAUSED'
  | 'NOT_YET_AVAILABLE'

/** How a pane was opened (spec §1.2). */
export type BrowserOpenedBy = 'agent' | 'operator'

/** The slice of one pane the gate decides from, resolved by the shell before planning. */
export interface BrowserPaneAccess {
  openedBy: BrowserOpenedBy
  originClass: OriginClass
  disconnected: boolean
  paused: boolean
}

export interface BrowserGateInput {
  /** `undefined` = the id names no pane. Ignored for a verb that addresses none (`open`, `list`). */
  pane: BrowserPaneAccess | undefined
  /** The global kill-switch "Allow agents to drive browser panes" (spec §7.4), read just now. */
  writesEnabled: boolean
}

/**
 * The tier of a call (spec §7.1) for the verbs U1 owns. `free` runs; `lease` needs the operator's lease, which
 * a later unit adds. Navigate and close on an operator-opened pane are `lease` in every origin class.
 */
export function browserTier(op: BrowserOp, pane: BrowserPaneAccess | undefined): 'free' | 'lease' {
  if (!isBrowserWriteOp(op)) return 'free'
  if (PANELESS_OPS.has(op)) return 'free'
  return pane?.openedBy === 'operator' ? 'lease' : 'free'
}

/**
 * The refusal for `op`, or `null` to continue. Order (spec §6.3): pane known → Disconnect → kill-switch →
 * pause → tier. `close` is exempt from the kill-switch (Q6) but not from Disconnect or Pause.
 */
export function gateBrowserOp(op: BrowserOp, input: BrowserGateInput): BrowserDenyReason | null {
  const addressesPane = !PANELESS_OPS.has(op)
  const pane = input.pane
  if (addressesPane && !pane) return 'PANE_NOT_FOUND'
  if (addressesPane && pane?.disconnected) return 'BROWSER_DISCONNECTED'
  const write = isBrowserWriteOp(op)
  if (write && op !== 'browser_close' && !input.writesEnabled) return 'BROWSER_WRITES_DISABLED'
  if (write && addressesPane && pane?.paused) return 'BROWSER_PAUSED'
  if (write && browserTier(op, pane) === 'lease') return 'NOT_YET_AVAILABLE'
  return null
}

export type WritableState = 'free' | 'confirm' | 'paused' | 'revoked' | 'off'
export type WritableReason = 'read-not-enabled' | 'kill-switch' | 'disconnected' | 'paused'

/**
 * `browser_list`'s `readable` / `writable` / `writableReason` for one pane (spec §6.2). Until the folder
 * read opt-in of a later unit exists, a pane the OPERATOR opened is not readable to agents.
 */
export function describePaneAccess(
  pane: BrowserPaneAccess,
  writesEnabled: boolean
): { readable: boolean; writable: WritableState; writableReason?: WritableReason } {
  const readable = pane.openedBy === 'agent' && !pane.disconnected
  if (pane.disconnected)
    return { readable: false, writable: 'revoked', writableReason: 'disconnected' }
  if (pane.openedBy === 'operator') {
    return { readable, writable: 'off', writableReason: 'read-not-enabled' }
  }
  if (!writesEnabled) return { readable, writable: 'off', writableReason: 'kill-switch' }
  if (pane.paused) return { readable, writable: 'paused', writableReason: 'paused' }
  return { readable, writable: 'free' }
}

/** Length of "Pause agent for 10 min" (spec §7.4). */
export const PAUSE_MS = 10 * 60 * 1000

/** The operator's per-pane decisions. Clock injected; nothing survives a restart (spec §10.3). */
export interface BrowserAccess {
  /** Permanent for this pane id. No inverse exists. Returns whether it changed. */
  disconnect(paneId: string): boolean
  isDisconnected(paneId: string): boolean
  /** Pause agent writes until `now + ms`; returns the epoch ms it ends at. */
  pause(paneId: string, ms?: number): number
  resume(paneId: string): void
  /** Epoch ms the pause ends, or `null` when not paused (an elapsed pause reads as not paused). */
  pausedUntil(paneId: string): number | null
  isPaused(paneId: string): boolean
  /** Drop everything held for a pane that was closed. */
  forget(paneId: string): void
}

export function createBrowserAccess(now: () => number): BrowserAccess {
  const disconnected = new Set<string>()
  const paused = new Map<string, number>()
  const pausedUntil = (id: string): number | null => {
    const until = paused.get(id)
    if (until === undefined) return null
    if (until <= now()) {
      paused.delete(id)
      return null
    }
    return until
  }
  return {
    disconnect(id) {
      if (disconnected.has(id)) return false
      disconnected.add(id)
      paused.delete(id)
      return true
    },
    isDisconnected: (id) => disconnected.has(id),
    pause(id, ms = PAUSE_MS) {
      const until = now() + ms
      paused.set(id, until)
      return until
    },
    resume: (id) => void paused.delete(id),
    pausedUntil,
    isPaused: (id) => pausedUntil(id) !== null,
    forget(id) {
      disconnected.delete(id)
      paused.delete(id)
    }
  }
}
