/**
 * Browser pane access, pure core (T564 U1, spec §6.3, §7.1 and §7.4): what an agent may do with a pane,
 * decided at PLAN level so a refused call never raises a confirm first (the ADR-0020 rule).
 *
 * Two halves. {@link gateBrowserOp} is a pure function of a resolved {@link BrowserGateInput}; and
 * {@link createBrowserAccess} holds the operator's per-pane decisions (Disconnect, Pause) behind an injected
 * clock. The kill-switch and the folder block are read by the shell (`mcp/prefs.ts`, the plan's base gate).
 *
 * U4 adds the tier table of spec §7.1: which verb class is `free`, which needs the operator's `lease`, and which
 * is `refused` for the pane's origin class and who opened it. The lease itself (confirm → Allow performs nothing →
 * `BROWSER_APPROVED_RESEND` → a 10-minute idle lease) lives in `lease.ts`; the plan layer promotes a lease-row
 * call to a confirm, and the verb handler re-checks the lease right before it acts (`enforceLease`).
 */
import { checkBrowserContent, type ContentRefusal } from './content-check'
import type { OriginClass, OriginClassOptions } from './origin-class'

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

/**
 * The live-panel verbs (spec §5.2): `page`-class only, for EVERY caller. On a `local` or `external` pane they
 * refuse `NOT_A_PAGE_PANE`, which is the structural half of decision 25 (spec §7.3): an `observe` worker's
 * exception cannot become a way into a dev server or an external site, because the verbs have no such path.
 */
const LIVE_PANEL_OPS: ReadonlySet<string> = new Set(['browser_set_data', 'browser_patch'])

export function isLivePanelOp(op: string): boolean {
  return LIVE_PANEL_OPS.has(op)
}

/**
 * Whether this call sends mouse or key events (the ones a pane's first document drops): `click`, `press`, and
 * `type` when it types key by key (`delayMs`) or presses Enter (`submit`). `fill`, a plain `type` (inserted text)
 * and `eval` do not.
 */
export function sendsPointerOrKeyEvents(
  op: string,
  args: Record<string, unknown> | undefined
): boolean {
  if (op === 'browser_click' || op === 'browser_press') return true
  // A download started by `ref` is a click on that element (T572); one by `url` sends no input.
  if (op === 'browser_download') return typeof args?.ref === 'string'
  if (op === 'browser_type') {
    return (typeof args?.delayMs === 'number' && args.delayMs > 0) || args?.submit === true
  }
  return false
}

/** Verbs that run page script or drive its input: a lease on an `external` page (spec §7.1 "Eval", "Input"). */
const SCRIPT_AND_INPUT_OPS: ReadonlySet<string> = new Set([
  'browser_eval',
  'browser_click',
  'browser_type',
  'browser_fill',
  'browser_press',
  'browser_upload'
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
  | 'BAD_ARGS'
  | 'URL_SCHEME_BLOCKED'
  | 'BROWSER_READ_NOT_ENABLED'
  | 'BROWSER_WRITES_DISABLED'
  | 'BROWSER_PAUSED'
  | 'BROWSER_WRITE_DENIED'
  | 'BROWSER_LEASE_ENDED'
  | 'NOT_A_PAGE_PANE'
  | 'BROWSER_KEY_UNKNOWN'
  | 'PANE_INPUT_NOT_READY'
  | 'ZOOM_IN_DEVICE_MODE'
  | 'UPLOAD_PATH_DENIED'
  | 'NOT_YET_AVAILABLE'
  | 'DATA_TOO_LARGE'
  | 'HTML_TOO_LARGE'
  | 'PATH_NOT_ALLOWED'

/** How a pane was opened (spec §1.2). */
export type BrowserOpenedBy = 'agent' | 'operator'

/** The slice of one pane the gate decides from, resolved by the shell before planning. */
export interface BrowserPaneAccess {
  openedBy: BrowserOpenedBy
  originClass: OriginClass
  disconnected: boolean
  paused: boolean
  /**
   * The folder's "Let agents read browser panes I open" opt-in (exact folder, spec §7.1). Only an operator-opened
   * pane consults it; an agent-opened pane is always readable. Absent = off.
   */
  readOptIn?: boolean
  /**
   * Mouse and key events reach the pane's current document (`view-host.inputReady`). `false` on the first document
   * a pane loads: the verbs that send such events then refuse `PANE_INPUT_NOT_READY` instead of reporting a
   * success that delivered nothing. Absent = ready.
   */
  inputReady?: boolean
  /** The operator's lease on this pane is active now (and was granted for this very view). Absent = no lease. */
  leaseActive?: boolean
  /** The operator denied this pane less than 5 minutes ago. Absent = no cooldown. */
  writeDenied?: boolean
  /** The pane emulates a device (T572): `browser_emulate({ zoom })` is refused while it does. Absent = no. */
  deviceActive?: boolean
}

export interface BrowserGateInput {
  /** `undefined` = the id names no pane. Ignored for a verb that addresses none (`open`, `list`). */
  pane: BrowserPaneAccess | undefined
  /** The global kill-switch "Allow agents to drive browser panes" (spec §7.4), read just now. */
  writesEnabled: boolean
  /**
   * The verb's own arguments. When present, the content refusals (`BAD_ARGS`, `URL_SCHEME_BLOCKED`,
   * `NOT_YET_AVAILABLE`) are judged in the spec §6.3 position: after Disconnect, before the kill-switch.
   */
  args?: Record<string, unknown>
  /**
   * The inputs the pane's origin class was computed with (Harnu's own ports, the folder's trusted hosts), so
   * the audit row classifies a target URL exactly as the gate does.
   */
  classify?: OriginClassOptions
  /**
   * `browser_network`'s `action`, for callers that judge the gate without the whole argument set. It also rides
   * in `args.action` at plan level; either one counts.
   */
  action?: string
  /**
   * The verb handler's last line of defence: a call on a `lease` row with no active lease refuses
   * `BROWSER_LEASE_ENDED` instead of passing. The plan layer leaves it off, because there the same state is a
   * confirm, not a refusal.
   */
  enforceLease?: boolean
}

export type BrowserTier = 'free' | 'lease' | 'refused'

/**
 * The tier of a call (spec §7.1). Rows are verb classes, columns the origin class at call time and who opened the
 * pane. `blank` (nothing loaded) behaves like `local`: there is no remote page to act as. Reads are `free` here;
 * an operator pane's read opt-in is a separate gate step (it refuses, it does not lease).
 *
 *   Open / Read                 free (an operator pane's reads need the folder opt-in)
 *   Navigate, Emulate, Download, Close   agent pane: free · operator pane: lease
 *   Network start/read          agent pane: free on page/local/blank, lease on external · operator pane: lease
 *   Network stop                always free (it only ever reduces what is observed)
 *   Eval, Input                 agent pane: free on page/local/blank, lease on external · operator pane: lease
 *   Live panel                  free on `page`, refused on any other class (agent or operator pane)
 */
export function browserTier(
  op: BrowserOp,
  pane: BrowserPaneAccess | undefined,
  args?: Record<string, unknown>
): BrowserTier {
  if (!isBrowserWriteOp(op)) return 'free'
  if (PANELESS_OPS.has(op)) return 'free'
  if (!pane) return 'free'
  if (LIVE_PANEL_OPS.has(op)) return pane.originClass === 'page' ? 'free' : 'refused'
  const operatorPane = pane.openedBy === 'operator'
  if (op === 'browser_network') {
    if (args?.action === 'stop') return 'free'
    return operatorPane || pane.originClass === 'external' ? 'lease' : 'free'
  }
  if (SCRIPT_AND_INPUT_OPS.has(op)) {
    return operatorPane || pane.originClass === 'external' ? 'lease' : 'free'
  }
  // navigate, emulate, download, close
  return operatorPane ? 'lease' : 'free'
}

/** A refusal with the detail the plan result and the audit carry. */
export interface BrowserGateRefusal {
  reason: BrowserDenyReason
  content?: ContentRefusal
}

/**
 * The refusal for `op`, or `null` to continue. Order (spec §6.3): pane known → Disconnect → read opt-in
 * (operator panes) → `page`-class check (live-panel verbs) → content (arguments) → kill-switch → pause → tier (`refused`, then the Deny cooldown, then,
 * for the handler only, a missing lease). `close` is exempt from the kill-switch (Q6) but not from Disconnect
 * or Pause. A `lease` row without an active lease is NOT a refusal here: the plan layer turns it into the
 * operator's confirm.
 */
export function gateBrowserOpDetailed(
  op: BrowserOp,
  input: BrowserGateInput
): BrowserGateRefusal | null {
  const addressesPane = !PANELESS_OPS.has(op)
  const pane = input.pane
  if (addressesPane && !pane) return { reason: 'PANE_NOT_FOUND' }
  if (addressesPane && pane?.disconnected) return { reason: 'BROWSER_DISCONNECTED' }
  // The live-panel verbs only write a page file's own data and DOM and read nothing back, so they do not need the
  // folder's read opt-in even on a pane the operator opened (spec §7.1 "Live panel": free on `page`).
  if (
    addressesPane &&
    !LIVE_PANEL_OPS.has(op) &&
    pane?.openedBy === 'operator' &&
    pane.readOptIn !== true
  )
    return { reason: 'BROWSER_READ_NOT_ENABLED' }
  if (LIVE_PANEL_OPS.has(op) && pane && pane.originClass !== 'page') {
    return { reason: 'NOT_A_PAGE_PANE' }
  }
  if (input.args) {
    const content = checkBrowserContent(op, input.args, {
      deviceActive: pane?.deviceActive === true
    })
    if (content) return { reason: content.code, content }
  }
  // Decided here, before the kill-switch and any confirm (spec §6.3): a call that cannot deliver must not first
  // ask the operator and only then be refused.
  if (pane && pane.inputReady === false && sendsPointerOrKeyEvents(op, input.args)) {
    return { reason: 'PANE_INPUT_NOT_READY' }
  }
  const write = isBrowserWriteOp(op)
  if (write && op !== 'browser_close' && !input.writesEnabled)
    return { reason: 'BROWSER_WRITES_DISABLED' }
  // Pause suspends what a session CHANGES. Reading what network capture recorded and ending the capture only
  // ever reduce what is observed, so they work while paused; starting a capture does not.
  const action =
    input.action ?? (typeof input.args?.action === 'string' ? input.args.action : undefined)
  const pauseExempt = op === 'browser_network' && (action === 'read' || action === 'stop')
  if (write && addressesPane && pane?.paused && !pauseExempt) return { reason: 'BROWSER_PAUSED' }
  const tier = browserTier(op, pane, action !== undefined ? { ...input.args, action } : input.args)
  if (tier === 'refused') return { reason: 'NOT_A_PAGE_PANE' }
  if (tier === 'lease') {
    if (pane?.writeDenied === true) return { reason: 'BROWSER_WRITE_DENIED' }
    if (input.enforceLease === true && pane?.leaseActive !== true)
      return { reason: 'BROWSER_LEASE_ENDED' }
  }
  return null
}

/** {@link gateBrowserOpDetailed}, reason only. */
export function gateBrowserOp(op: BrowserOp, input: BrowserGateInput): BrowserDenyReason | null {
  return gateBrowserOpDetailed(op, input)?.reason ?? null
}

export type WritableState = 'free' | 'confirm' | 'paused' | 'revoked' | 'off'
export type WritableReason =
  'read-not-enabled' | 'kill-switch' | 'disconnected' | 'paused' | 'write-denied'

/**
 * `browser_list`'s `readable` / `writable` / `writableReason` for one pane (spec §6.2, §7.1). A pane the OPERATOR
 * opened is readable to agents only when its folder opted in; its writes then need a lease (`confirm`, or `free`
 * while one is active). An `external` page in an agent pane is `confirm` for the same reason: its script and
 * input verbs are lease rows.
 */
export function describePaneAccess(
  pane: BrowserPaneAccess,
  writesEnabled: boolean
): { readable: boolean; writable: WritableState; writableReason?: WritableReason } {
  if (pane.disconnected)
    return { readable: false, writable: 'revoked', writableReason: 'disconnected' }
  const readable = pane.openedBy === 'agent' || pane.readOptIn === true
  if (!readable) return { readable, writable: 'off', writableReason: 'read-not-enabled' }
  if (!writesEnabled) return { readable, writable: 'off', writableReason: 'kill-switch' }
  if (pane.paused) return { readable, writable: 'paused', writableReason: 'paused' }
  const needsLease = pane.openedBy === 'operator' || pane.originClass === 'external'
  if (needsLease && pane.writeDenied === true)
    return { readable, writable: 'off', writableReason: 'write-denied' }
  if (needsLease && pane.leaseActive !== true) return { readable, writable: 'confirm' }
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
