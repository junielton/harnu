/**
 * The decisions `view-host.ts` makes about a native view, as pure functions (T564 U1 delta 2). The host is
 * Electron glue and sits outside the coverage metric, so everything it DECIDES lives here and is tested:
 * which views to freeze or thaw, the freeze-generation race, the one-popup-per-activation gate, the certificate
 * host rule, and when the "opened by agent" flag changes.
 */
import { needsFreeze, toViewBounds, type OverlayRect, type Rect } from './bounds'
import { certificateDecision } from './nav-policy'
import { isLoopbackHost, type OriginClass } from './origin-class'

/* ---- The URL a pane is "at" ------------------------------------------------------------------------ */

/**
 * `webContents.getURL()` is empty until the first commit, so a verb called right after `browser_open` would see a
 * `blank` pane and `browser_set_data` would refuse `NOT_A_PAGE_PANE` (T569 delta 1, F3). Until something has
 * committed, a pane is at the address it was asked to load; once it has committed, the committed one wins.
 */
export function liveUrlOf(committed: string, requested: string): string {
  return committed !== '' ? committed : requested
}

/* ---- Freeze / thaw -------------------------------------------------------------------------------- */

/** What the freeze rule reads about one view. */
export interface FreezeView {
  /** Parked: a 1×1 view in the window corner (spec §2.3). */
  parked: boolean
  /** The renderer said the pane host is on screen. */
  visibleReported: boolean
  /** The last rect the renderer reported (CSS px), or `null` before the pane mounted. */
  rectCss: Rect | null
  frozen: boolean
}

export type FreezeAction = 'freeze' | 'thaw' | 'keep'

/**
 * Whether one view must be frozen, thawed or left alone (spec §2.4). The rect that counts is the 1×1 parked
 * corner for a parked view (so a toast in that corner hides it) and the reported host rect for a live one; a
 * hidden pane has no rect and is never touched. A drag freezes every LIVE view (a parked corner takes no part
 * in a drag). Otherwise a view freezes exactly when some overlay intersects its rect, or one is fullscreen.
 */
export function decideFreeze(
  view: FreezeView,
  ctx: { overlays: readonly OverlayRect[]; dragActive: boolean; parkedRect: Rect }
): FreezeAction {
  const rect = view.parked ? ctx.parkedRect : view.visibleReported ? view.rectCss : null
  if (!rect) return 'keep'
  const want = (ctx.dragActive && !view.parked) || needsFreeze(rect, ctx.overlays)
  if (want && !view.frozen) return 'freeze'
  if (!want && view.frozen) return 'thaw'
  return 'keep'
}

/**
 * The freeze is asynchronous (capture, send, wait for the renderer's paint ack, hide), and the overlay can
 * close, the pane can hide or the view can be destroyed in between. Each freeze takes a generation; anything
 * that makes it stale bumps the counter, and every step after an `await` asks `isCurrent` before acting.
 */
export class FreezeGeneration {
  private value = 0
  /** Start a new freeze; the returned generation is current until the next `next` or `bump`. */
  next(): number {
    return ++this.value
  }
  /** Invalidate whatever freeze is in flight (thaw, hide, destroy). */
  bump(): void {
    this.value++
  }
  isCurrent(generation: number): boolean {
    return generation === this.value
  }
}

/* ---- Popups: one per activation ------------------------------------------------------------------- */

/** How long a real click or key counts as the user activation a popup needs (spec §3.2). */
export const GESTURE_WINDOW_MS = 1500

/**
 * `window.open` needs a real user activation and each activation buys ONE popup, so a page cannot loop
 * `window.open` inside the window. `note` is called for every real click/key (never for CDP-driven input,
 * which `before-input-event`/`before-mouse-event` do not report as the operator's); `consume` is called by the
 * popup handler and spends the activation.
 */
export interface GestureGate {
  note(): void
  consume(): boolean
  pending(): boolean
}

export function createGestureGate(
  now: () => number,
  windowMs: number = GESTURE_WINDOW_MS
): GestureGate {
  let at = Number.NEGATIVE_INFINITY
  return {
    note(): void {
      at = now()
    },
    /** @returns whether an unspent activation is still fresh; spends it either way it is true. */
    consume(): boolean {
      if (now() - at > windowMs) return false
      at = Number.NEGATIVE_INFINITY
      return true
    },
    /** Test and diagnostic hook: whether an activation is waiting. */
    pending(): boolean {
      return now() - at <= windowMs
    }
  }
}

/* ---- Certificates --------------------------------------------------------------------------------- */

export interface CertificateVerdict {
  verdict: 'accept-flagged' | 'deny'
  /** `host:port` for the notice, or `''` when the URL does not parse. */
  host: string
}

/**
 * A certificate error is accepted only on a loopback host (a self-signed local dev server, spec §3.2 Q14).
 * The URL is parsed once: the port is dropped for the loopback test (`[::1]:8443` is loopback, `localhost:3000`
 * too) and kept for the notice.
 */
export function certificateVerdictFor(url: string): CertificateVerdict {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return { verdict: 'deny', host: '' }
  }
  return {
    verdict: certificateDecision(u.host, isLoopbackHost(u.hostname)),
    host: u.host
  }
}

/* ---- The "opened by agent" flag ------------------------------------------------------------------- */

export type AgentFlag = { host: string } | null

/**
 * The flag after a VERB navigation (spec §3.2): set when the pane lands on an `external` host it had not shown
 * before the call; otherwise whatever it was. A local dev server is the expected case and never flags.
 */
export function flagAfterVerbNavigation(
  current: AgentFlag,
  nav: { origin: OriginClass; host: string; seenBefore: ReadonlySet<string> }
): AgentFlag {
  if (nav.origin === 'external' && nav.host !== '' && !nav.seenBefore.has(nav.host)) {
    return { host: nav.host }
  }
  return current
}

/** The flag after the OPERATOR navigates or dismisses it: gone (the operator picked this site). */
export function flagAfterOperatorAction(): AgentFlag {
  return null
}

/* ---- What a freeze may paint (delta 3) ------------------------------------------------------------ */

/**
 * Whether a view may be captured as a frozen image at all, BEFORE capturing. A parked view (1×1 in the corner)
 * or one whose bounds are not yet the reported rect (the renderer's rect report is late or lost, for example
 * while the window is occluded and `requestAnimationFrame` is not running) would give a tiny or stale image
 * that the pane then stretches over the whole host: a squashed frame. Such a view is only hidden.
 */
export function freezeImagePlan(opts: {
  parked: boolean
  /** The view's current bounds (window DIP). */
  bounds: Rect
  /** The rect the renderer reported for the host (CSS px), or `null` if it never did. */
  reported: Rect | null
  zoomFactor: number
}): 'capture' | 'hide-only' {
  if (opts.parked || opts.reported === null) return 'hide-only'
  const want = toViewBounds(opts.reported, opts.zoomFactor)
  const close = (a: number, b: number): boolean => Math.abs(a - b) <= 4
  return close(opts.bounds.width, want.width) && close(opts.bounds.height, want.height)
    ? 'capture'
    : 'hide-only'
}

/**
 * Whether a captured image is the size the view had, AFTER capturing. The image may be larger than the bounds
 * on a HiDPI display (device pixels), but it must keep the view's aspect ratio and not be smaller than it: a
 * capture of a view that is mid-resize or still carries a parking override is rejected and painted blank.
 */
export function captureMatchesBounds(
  image: { width: number; height: number },
  bounds: Rect
): boolean {
  if (image.width <= 0 || image.height <= 0 || bounds.width <= 0 || bounds.height <= 0) return false
  if (image.width < bounds.width * 0.9 || image.height < bounds.height * 0.9) return false
  const imageRatio = image.width / image.height
  const boundsRatio = bounds.width / bounds.height
  return Math.abs(imageRatio - boundsRatio) / boundsRatio <= 0.05
}
