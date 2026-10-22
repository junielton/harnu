/**
 * The decisions of the input verbs, pure (T564 U4, spec §6.1 rows 11–14 and §6.2): where a click lands, what
 * "actionable" means, how long to wait for it, how the fit scale is applied (A5) and how the modifiers and mouse
 * buttons map to CDP. The view host measures the page and dispatches the events; everything it has to decide
 * from those measurements is here, so it is unit-tested without a browser. No electron, no clock of its own.
 */
import { MOD } from './cdp-keys'

/** Longest an input verb waits for its target to become visible, stable and un-obscured (spec §6.2). */
export const ACTIONABLE_TIMEOUT_MS = 5000
/** How often the target is sampled while waiting. */
export const ACTIONABLE_POLL_MS = 100

export const MAX_TYPE_CHARS = 4000
export const MAX_FILL_FIELDS = 20
export const MAX_TYPE_DELAY_MS = 1000

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** What the page says about the target at one sample (measured in CSS px of the page's viewport). */
export interface ElementProbe {
  /** The element's box; `null` when it has none (not rendered, detached). */
  rect: Rect | null
  /** `disabled`, `aria-disabled`, a disabled fieldset or `readonly`-free form control that cannot take input. */
  disabled: boolean
  /** What `elementFromPoint` found at the click point: the target (or inside it), something else, or nothing. */
  hit: 'self' | 'other' | 'none'
  /** Whether the target takes typed text (an input, a textarea or a contenteditable). */
  editable: boolean
  /** A `<select>`: filled by choosing an option, not by typing. */
  isSelect: boolean
  /** The tag name, lower case, for the ACK. */
  tag: string
}

export type NotActionable = 'not-visible' | 'unstable' | 'obscured' | 'disabled'

/** The outcome of one sample against the previous one. */
export function judgeActionable(
  probe: ElementProbe,
  previous: ElementProbe | null,
  opts: { needsHit: boolean; viewport: { width: number; height: number } | null }
): 'ready' | NotActionable {
  const r = probe.rect
  if (!r || r.width <= 0 || r.height <= 0) return 'not-visible'
  if (opts.viewport) {
    // A box wholly outside the viewport after scrolling it into view is not something a pointer can reach.
    const v = opts.viewport
    if (r.x + r.width <= 0 || r.y + r.height <= 0 || r.x >= v.width || r.y >= v.height)
      return 'not-visible'
  }
  if (probe.disabled) return 'disabled'
  const p = previous?.rect
  // Stable: the box did not move or resize since the last sample (an animation or a layout shift in progress).
  if (!p || p.x !== r.x || p.y !== r.y || p.width !== r.width || p.height !== r.height)
    return 'unstable'
  if (opts.needsHit && probe.hit !== 'self') return 'obscured'
  return 'ready'
}

export type WaitOutcome =
  | { ok: true; probe: ElementProbe }
  | { ok: false; reason: NotActionable; probe: ElementProbe | null }

/**
 * Sample the target until it is actionable or `timeoutMs` passes. A sample that throws (the node is gone) ends the
 * wait with that error: the caller maps it to `REF_STALE`. The refusal carries the last concrete reason seen
 * (a target that kept moving is `unstable` only when nothing else ever blocked it).
 */
export async function waitActionable(io: {
  sample: () => Promise<ElementProbe>
  now: () => number
  sleep: (ms: number) => Promise<void>
  needsHit: boolean
  viewport: () => Promise<{ width: number; height: number } | null>
  timeoutMs?: number
  pollMs?: number
}): Promise<WaitOutcome> {
  const timeoutMs = io.timeoutMs ?? ACTIONABLE_TIMEOUT_MS
  const pollMs = io.pollMs ?? ACTIONABLE_POLL_MS
  const started = io.now()
  let previous: ElementProbe | null = null
  /** The most telling reason seen: an `unstable` sample never hides an earlier concrete one. */
  let last: NotActionable | null = null
  let lastProbe: ElementProbe | null = null
  for (;;) {
    const probe = await io.sample()
    const verdict = judgeActionable(probe, previous, {
      needsHit: io.needsHit,
      viewport: await io.viewport()
    })
    if (verdict === 'ready') return { ok: true, probe }
    if (verdict !== 'unstable' || last === null) last = verdict
    lastProbe = probe
    previous = probe
    if (io.now() - started >= timeoutMs) {
      return { ok: false, reason: last ?? 'unstable', probe: lastProbe }
    }
    await io.sleep(pollMs)
  }
}

/* ------------------------------------------------------------------------------------------------ */
/* Geometry                                                                                           */
/* ------------------------------------------------------------------------------------------------ */

export interface Point {
  x: number
  y: number
}

/** Why an `offset` was refused. */
export type OffsetError = 'offset-outside-box'

/**
 * The page point a click aims at: the box centre, or `offset` from the box's top-left corner (refs only, no raw
 * coordinates beyond an offset INSIDE the element's box, spec §6.2). `rect` is in the page's viewport CSS px.
 */
export function clickTarget(
  rect: Rect,
  offset?: Point
): { ok: true; point: Point } | { ok: false; error: OffsetError } {
  if (!offset)
    return { ok: true, point: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } }
  if (
    !Number.isFinite(offset.x) ||
    !Number.isFinite(offset.y) ||
    offset.x < 0 ||
    offset.y < 0 ||
    offset.x > rect.width ||
    offset.y > rect.height
  ) {
    return { ok: false, error: 'offset-outside-box' }
  }
  return { ok: true, point: { x: rect.x + offset.x, y: rect.y + offset.y } }
}

/**
 * Page coordinates → the coordinates CDP `Input.dispatchMouseEvent` takes. While a device is emulated the page
 * lives at its own size and the view shows it scaled by the fit scale, so CDP wants VIEW coordinates (post-scale):
 * U0 dispatched a tap at 150,150 under `scale: 0.5` and the page received 300,300 (assumption A5). Without a
 * device the scale is 1.
 */
export function toViewPoint(p: Point, fitScale: number): Point {
  const s = Number.isFinite(fitScale) && fitScale > 0 ? fitScale : 1
  return { x: p.x * s, y: p.y * s }
}

/* ------------------------------------------------------------------------------------------------ */
/* Mouse and modifiers                                                                                */
/* ------------------------------------------------------------------------------------------------ */

export type MouseButton = 'left' | 'middle' | 'right'
export type ClickModifier = 'Alt' | 'Control' | 'Meta' | 'Shift'

export const CLICK_MODIFIERS: readonly ClickModifier[] = ['Alt', 'Control', 'Meta', 'Shift']

/** The bit mask `Input.dispatchMouseEvent.modifiers` takes. */
export function modifierMask(mods: readonly ClickModifier[] | undefined): number {
  let mask = 0
  for (const m of mods ?? []) {
    if (m === 'Alt') mask |= MOD.alt
    else if (m === 'Control') mask |= MOD.ctrl
    else if (m === 'Meta') mask |= MOD.meta
    else if (m === 'Shift') mask |= MOD.shift
  }
  return mask
}

/** The `buttons` bit of a button held down. */
export function buttonsMask(button: MouseButton): number {
  return button === 'left' ? 1 : button === 'right' ? 2 : 4
}

export interface MouseEventParams {
  type: 'mouseMoved' | 'mousePressed' | 'mouseReleased'
  x: number
  y: number
  button: MouseButton | 'none'
  buttons: number
  clickCount: number
  modifiers: number
}

export interface TouchEventParams {
  type: 'touchStart' | 'touchEnd'
  touchPoints: Point[]
  modifiers: number
}

/**
 * The CDP touch events of a tap, for a page that emulates touch (T572, spec §9.2). While
 * `Emulation.setEmitTouchEventsForMouse` is on, `Input.dispatchMouseEvent` presses are swallowed by the touch
 * emulator and never acknowledge (measured live: `mousePressed` hung, a `touchStart` at the same point clicked), so
 * a click on such a page is a tap: `touchStart` then `touchEnd` at the point, once per click, with the same view
 * coordinates (post fit scale) the mouse events use. A page that does not emulate touch keeps real mouse events.
 */
export function tapEvents(
  at: Point,
  opts: { clickCount?: number; modifiers?: readonly ClickModifier[] }
): TouchEventParams[] {
  const count = Math.max(1, Math.min(3, Math.trunc(opts.clickCount ?? 1)))
  const modifiers = modifierMask(opts.modifiers)
  const events: TouchEventParams[] = []
  for (let i = 0; i < count; i++) {
    events.push({ type: 'touchStart', touchPoints: [{ x: at.x, y: at.y }], modifiers })
    events.push({ type: 'touchEnd', touchPoints: [], modifiers })
  }
  return events
}

/**
 * The CDP mouse events of one click: move onto the target, then `clickCount` press/release pairs numbered
 * 1…n (a double click is two pairs with the second carrying `clickCount: 2`).
 */
export function clickEvents(
  at: Point,
  opts: { button?: MouseButton; clickCount?: number; modifiers?: readonly ClickModifier[] }
): MouseEventParams[] {
  const button = opts.button ?? 'left'
  const count = Math.max(1, Math.min(3, Math.trunc(opts.clickCount ?? 1)))
  const modifiers = modifierMask(opts.modifiers)
  const events: MouseEventParams[] = [
    {
      type: 'mouseMoved',
      x: at.x,
      y: at.y,
      button: 'none',
      buttons: 0,
      clickCount: 0,
      modifiers
    }
  ]
  for (let i = 1; i <= count; i++) {
    events.push({
      type: 'mousePressed',
      x: at.x,
      y: at.y,
      button,
      buttons: buttonsMask(button),
      clickCount: i,
      modifiers
    })
    events.push({
      type: 'mouseReleased',
      x: at.x,
      y: at.y,
      button,
      buttons: 0,
      clickCount: i,
      modifiers
    })
  }
  return events
}

/** The refusal an unactionable target maps to. */
export function actionableRefusal(
  reason: NotActionable
): 'ELEMENT_NOT_VISIBLE' | 'ELEMENT_OBSCURED' | 'ELEMENT_DISABLED' {
  if (reason === 'obscured') return 'ELEMENT_OBSCURED'
  if (reason === 'disabled') return 'ELEMENT_DISABLED'
  return 'ELEMENT_NOT_VISIBLE'
}
