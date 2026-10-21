/**
 * Geometry of the browser pane's native view (T564 U1, spec §2.3 and §2.4). Pure: the renderer reports a
 * rectangle in CSS px; main turns it into integer DIP bounds, and decides when an overlay forces a freeze.
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Convert a CSS-px rect to integer window bounds. Rounding is by EDGES (spec §2.3): the left/top edge and the
 * right/bottom edge are each rounded and the size is their difference, so the far edge cannot drift when the
 * window zoom factor is fractional. Rounding `x` and `width` separately measured up to 1 device px of
 * asymmetry in U0 (A7).
 */
export function toViewBounds(rect: Rect, zoomFactor: number): Rect {
  const f = zoomFactor > 0 && Number.isFinite(zoomFactor) ? zoomFactor : 1
  const x0 = Math.round(rect.x * f)
  const y0 = Math.round(rect.y * f)
  const x1 = Math.round((rect.x + rect.width) * f)
  const y1 = Math.round((rect.y + rect.height) * f)
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) }
}

/**
 * Parking (spec §2.3, U0 A3): a view that has never painted cannot be captured, so a pane with no real rect
 * yet is attached, VISIBLE, 1×1 in the window's bottom-right content corner, with a 1280×800 metrics override.
 * A parked pane counts as HIDDEN for the later discard rule (U7): it must never keep a view alive on its own.
 */
export const PARKED_METRICS = { width: 1280, height: 800, deviceScaleFactor: 1 } as const

/** The 1×1 parked bounds in the bottom-right corner of a window whose content area is `content`. */
export function parkedBounds(content: { width: number; height: number }): Rect {
  return {
    x: Math.max(0, content.width - 1),
    y: Math.max(0, content.height - 1),
    width: 1,
    height: 1
  }
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  if (a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0) return false
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

/** An overlay layer registered by the renderer: a rectangle in CSS px, or the whole window. */
export type OverlayRect = Rect | 'fullscreen'

/**
 * Whether a visible view (its CSS-px rect) must be frozen: any overlay intersects it, or one is fullscreen
 * (spec §2.4). A parked view is judged on its 1×1 corner the same way, so a toast in that corner hides it.
 */
export function needsFreeze(viewRect: Rect, overlays: readonly OverlayRect[]): boolean {
  return overlays.some((o) => o === 'fullscreen' || rectsIntersect(o, viewRect))
}

/**
 * In device mode `capturePage()` returns an image the size of the emulated device with the frame in its
 * top-left, bounds-sized corner (spec §2.4, U0 A5), so the freeze crops to the view's own bounds. Outside
 * device mode there is no crop (`undefined` = the whole view).
 */
export function freezeCaptureRect(bounds: Rect, deviceMode: boolean): Rect | undefined {
  return deviceMode ? { x: 0, y: 0, width: bounds.width, height: bounds.height } : undefined
}

/** The freeze image encoding (spec §2.4, U0 A12): JPEG 80, because PNG at DPR 2 was over the 100 ms budget. */
export const FREEZE_JPEG_QUALITY = 80
