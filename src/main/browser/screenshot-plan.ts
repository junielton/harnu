/**
 * Which capture path a `browser_screenshot` takes, and how big the image may be (T564 U3, spec §6.2, §2.3, §2.4
 * and the U0 results A3 and A12). Pure (ADR-0001): the host runs the plan.
 *
 * The facts the plan encodes:
 *   - `webContents.capturePage()` works on a visible view, a parked view, and a view that painted and was then
 *     hidden. CDP `Page.captureScreenshot` is **not** used on a hidden view: it answered in 0.6–2.8 s on the
 *     first call and timed out intermittently (A3).
 *   - Only CDP renders a whole page (`fullPage`), a clip, or the whole emulated device at its DPR, so those go
 *     through CDP on a visible or parked view.
 *   - In device mode `capturePage()` returns an image the size of the emulated device with the frame drawn in
 *     its top-left, bounds-sized corner and the rest blank, so it is cropped to the view bounds (§2.4).
 */

export type ViewMode = 'visible' | 'parked' | 'hidden'

export const SCREENSHOT_DEFAULT_MAX_DIM = 1568
export const SCREENSHOT_MAX_DIM = 1568
/** A `fullPage` taller than this is clamped (spec §6.2). */
export const FULL_PAGE_MAX_HEIGHT = 8000
export const SCREENSHOT_DEFAULT_JPEG_QUALITY = 80

export interface ShotInput {
  mode: ViewMode
  /** The agent asked for the whole scrollable page. */
  fullPage: boolean
  /** The agent asked for one element (`ref` or `selector`). */
  element: boolean
  /** A device is being emulated (U5 sets this; always false before). */
  deviceMode: boolean
}

export type ShotPlan =
  | {
      method: 'cdp'
      /** Capture the document-relative element box, not the viewport. */
      clip: 'element' | 'page' | 'none'
      /** The CDP image is device sized; no crop is needed or wanted (§6.2). */
      cropToBounds: false
    }
  | {
      method: 'capturePage'
      /** Crop the capture to the view's own bounds (device mode, §2.4). */
      cropToBounds: boolean
      /** Crop the capture to the element's rectangle after capturing. */
      cropToElement: boolean
      /** `fullPage` was asked for but cannot be honoured on a hidden view: a viewport shot is returned. */
      fullPageDowngraded: boolean
    }

export function planScreenshot(input: ShotInput): ShotPlan {
  const hidden = input.mode === 'hidden'
  if (!hidden && (input.fullPage || input.element)) {
    return { method: 'cdp', clip: input.element ? 'element' : 'page', cropToBounds: false }
  }
  if (!hidden && input.deviceMode) return { method: 'cdp', clip: 'none', cropToBounds: false }
  return {
    method: 'capturePage',
    cropToBounds: input.deviceMode,
    cropToElement: input.element,
    fullPageDowngraded: input.fullPage && hidden && !input.element
  }
}

/** Clamp a size so its longest side is `maxDim`, keeping the aspect ratio. */
export function clampSize(
  width: number,
  height: number,
  maxDim: number
): { width: number; height: number; clamped: boolean } {
  const longest = Math.max(width, height)
  if (longest <= maxDim || longest <= 0) return { width, height, clamped: false }
  const k = maxDim / longest
  return {
    width: Math.max(1, Math.round(width * k)),
    height: Math.max(1, Math.round(height * k)),
    clamped: true
  }
}

/** The CSS-px height a `fullPage` capture takes: the page's own, capped at {@link FULL_PAGE_MAX_HEIGHT}. */
export function fullPageHeight(contentHeight: number): { height: number; clamped: boolean } {
  return contentHeight > FULL_PAGE_MAX_HEIGHT
    ? { height: FULL_PAGE_MAX_HEIGHT, clamped: true }
    : { height: Math.max(1, Math.ceil(contentHeight)), clamped: false }
}

/** An axis-aligned rectangle from a CDP box-model quad (`[x1,y1, x2,y2, x3,y3, x4,y4]`). */
export function rectFromQuad(
  quad: readonly number[]
): { x: number; y: number; width: number; height: number } | null {
  if (quad.length < 8 || quad.some((n) => !Number.isFinite(n))) return null
  const xs = [quad[0]!, quad[2]!, quad[4]!, quad[6]!]
  const ys = [quad[1]!, quad[3]!, quad[5]!, quad[7]!]
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
}

/**
 * The factor from the page's CSS px to the pixels of a `capturePage()` image, for cropping an element out of it
 * (T572 U5, AC-6; the T570 carry-over). The element's box is measured in CSS px of the page's viewport, so the scale
 * is the image width over the width of the page's CSS viewport:
 *
 *   - a device is emulated: the page is laid out at the DEVICE width whatever size the view has and however the fit
 *     scale shrinks it (the page never sees the scale), and zoom is 1;
 *   - a parked view carries the 1280-wide parking override;
 *   - otherwise the viewport is the view's bounds divided by the page zoom.
 *
 * Before this, a hidden pane in device mode divided its bounds by the zoom and cropped the wrong rectangle.
 */
export function elementCropScale(input: {
  imageWidth: number
  boundsWidth: number
  zoom: number
  parked: boolean
  parkedWidth: number
  /** The emulated device's CSS width, or `null` when no device is active. */
  deviceWidth: number | null
}): number {
  const cssViewportWidth =
    input.deviceWidth !== null
      ? input.deviceWidth
      : input.parked
        ? input.parkedWidth
        : input.boundsWidth / (input.zoom > 0 ? input.zoom : 1)
  return input.imageWidth / Math.max(1, cssViewportWidth)
}
