/**
 * Browser pane lifecycle, pure (T564 U7, spec §10.1 and §2.3): WHEN a hidden pane is discarded, WHAT is recorded
 * about it, and WHEN a discarded pane comes back. No electron, no clock of its own (ADR-0001): the view host feeds
 * these functions facts and does the work they name.
 *
 * A discarded pane keeps its place (its registry record, pins, access state and lease-free identity) and loses
 * only the `webContents` and the native view, which cost 100–300 MB. It is revived from the recorded address.
 */

/** How long a pane stays hidden before it is discarded (spec §10.1, Q13): ONE named constant. */
export const HIDDEN_DISCARD_MS = 10 * 60 * 1000

/** An operator interaction (a key, a click, a navigation) this recent keeps the pane alive. */
export const OPERATOR_RECENT_MS = 60 * 1000

/** How often the host looks for panes to discard. */
export const DISCARD_SWEEP_INTERVAL_MS = 30 * 1000

/**
 * Whether a pane discarded by the timer comes back by itself when it is shown. `false`: it waits for the operator's
 * click on "Paused to save memory" (the approved mockup, "reloads with one click"), and any verb that needs a live
 * page still revives it. A pane restored after a restart is the other case: see {@link reviveOnShow}. One switch,
 * pending the operator's confirmation of which reading of spec §10.1 ("returning to it … revives it") they want.
 */
export const REVIVE_IDLE_DISCARD_ON_SHOW = false

/** The env var that shortens {@link HIDDEN_DISCARD_MS} for the live proof. Honoured only in an unpackaged build. */
export const DISCARD_MS_TEST_ENV = 'HARNU_BROWSER_TEST_DISCARD_MS'

/** Shortest discard time a test hook may ask for. */
const MIN_TEST_DISCARD_MS = 200

/**
 * The discard time in effect. The test hook is for the live proof only: it is ignored in a packaged build and when
 * the value is not a whole number of milliseconds in [200, {@link HIDDEN_DISCARD_MS}], so production behaviour can
 * never be shortened by an environment variable.
 */
export function resolveDiscardMs(
  env: Readonly<Record<string, string | undefined>>,
  packaged: boolean
): number {
  if (packaged) return HIDDEN_DISCARD_MS
  const raw = env[DISCARD_MS_TEST_ENV]
  if (raw === undefined || !/^\d{1,9}$/.test(raw)) return HIDDEN_DISCARD_MS
  const ms = Number(raw)
  return ms >= MIN_TEST_DISCARD_MS && ms <= HIDDEN_DISCARD_MS ? ms : HIDDEN_DISCARD_MS
}

/* ---- When a pane started to be hidden ------------------------------------------------------------ */

/**
 * "Hidden" is not mounted, not visible, or parked (spec §2.3: a parked pane counts as hidden and its timer runs from
 * the moment it was parked). The tracker keeps the FIRST moment of the current hidden stretch, and forgets it the
 * moment the pane is shown for real.
 */
export interface HiddenTracker {
  markHidden(paneId: string, at: number): void
  markShown(paneId: string): void
  forget(paneId: string): void
  /** Epoch ms the current hidden stretch began, or `null` when the pane is shown (or unknown). */
  since(paneId: string): number | null
}

export function createHiddenTracker(): HiddenTracker {
  const hidden = new Map<string, number>()
  return {
    markHidden(paneId, at) {
      if (!hidden.has(paneId)) hidden.set(paneId, at)
    },
    markShown: (paneId) => void hidden.delete(paneId),
    forget: (paneId) => void hidden.delete(paneId),
    since: (paneId) => hidden.get(paneId) ?? null
  }
}

/* ---- Whether to discard -------------------------------------------------------------------------- */

/** What the sweep knows about one live pane. */
export interface DiscardFacts {
  paneId: string
  /** Already discarded: nothing to do. */
  discarded: boolean
  /** When it began to be hidden, or `null` while it is shown. */
  hiddenSince: number | null
  /** A verb is running on the pane (read or write). */
  verbInFlight: boolean
  /** The agent's network capture is recording. */
  captureActive: boolean
  /** When the operator last used the pane, or `null`. */
  operatorAt: number | null
  /** A download is arriving or waiting for the operator's answer. */
  downloadPending: boolean
}

export type DiscardBlock =
  'shown' | 'discarded' | 'too-soon' | 'verb' | 'capture' | 'operator' | 'download'

/** Why this pane must NOT be discarded now, or `null` when it may be (spec §10.1). */
export function discardBlockedBy(
  f: DiscardFacts,
  now: number,
  discardMs: number
): DiscardBlock | null {
  if (f.discarded) return 'discarded'
  if (f.hiddenSince === null) return 'shown'
  if (now - f.hiddenSince < discardMs) return 'too-soon'
  if (f.verbInFlight) return 'verb'
  if (f.captureActive) return 'capture'
  if (f.downloadPending) return 'download'
  if (f.operatorAt !== null && now - f.operatorAt < OPERATOR_RECENT_MS) return 'operator'
  return null
}

/** The panes the sweep discards now, in the order given. */
export function planDiscard(
  facts: readonly DiscardFacts[],
  now: number,
  discardMs: number
): string[] {
  return facts.filter((f) => discardBlockedBy(f, now, discardMs) === null).map((f) => f.paneId)
}

/* ---- What is recorded ---------------------------------------------------------------------------- */

export interface ScrollPosition {
  x: number
  y: number
}

/** Why a pane is discarded: the timer paused it, or a restart restored it without loading it. */
export type DiscardReason = 'idle' | 'restored'

/** What survives the discard of the page itself (spec §10.1; pins and emulation live on the registry record). */
export interface DiscardState {
  reason: DiscardReason
  /** The address to load again (the live one at discard time, else the last requested). */
  url: string
  title: string
  scroll: ScrollPosition | null
  /** The page zoom factor in effect, or `1`. */
  zoom: number
  discardedAt: number
  /** The hidden time that triggered the discard, for the placeholder's "hidden N min". */
  hiddenMs: number
}

const MAX_SCROLL = 10_000_000

/** A scroll position from untrusted input (a page's `scrollX/Y`, a persisted file), or `null`. */
export function sanitizeScroll(raw: unknown): ScrollPosition | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { x, y } = raw as Record<string, unknown>
  if (typeof x !== 'number' || typeof y !== 'number') return null
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  const clamp = (n: number): number => Math.min(MAX_SCROLL, Math.max(0, Math.round(n)))
  return { x: clamp(x), y: clamp(y) }
}

export function buildDiscardState(input: {
  reason: DiscardReason
  url: string
  title: string
  scroll: unknown
  zoom: number
  now: number
  hiddenSince: number | null
}): DiscardState {
  return {
    reason: input.reason,
    url: input.url,
    title: input.title,
    scroll: sanitizeScroll(input.scroll),
    zoom: Number.isFinite(input.zoom) && input.zoom > 0 ? input.zoom : 1,
    discardedAt: input.now,
    hiddenMs: input.hiddenSince === null ? 0 : Math.max(0, input.now - input.hiddenSince)
  }
}

/* ---- Coming back --------------------------------------------------------------------------------- */

/** The verbs that never revive a pane: they do not need a live page. */
const NO_REVIVE_OPS: ReadonlySet<string> = new Set([
  'browser_open',
  'browser_list',
  'browser_close',
  // The sidecar stores the data whether or not a page is loaded; an unloaded page reads it when it boots.
  'browser_set_data'
])

/**
 * Whether a verb call needs a live page, so a discarded pane is revived before it runs (`revived: true`).
 * `browser_network` revives only to start a capture: reading what was captured or stopping it needs no page.
 */
export function opNeedsLivePage(op: string, args?: Record<string, unknown>): boolean {
  if (NO_REVIVE_OPS.has(op)) return false
  if (op === 'browser_network') return args?.action === 'start'
  return true
}

/** Whether a pane that becomes visible loads its page by itself (restored panes do; an idle discard waits). */
export function reviveOnShow(reason: DiscardReason): boolean {
  return reason === 'restored' || REVIVE_IDLE_DISCARD_ON_SHOW
}
