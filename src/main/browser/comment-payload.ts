/**
 * What main accepts from a guest's pick (T564 U6, spec §8.3), pure: validation, the caps, and the crop
 * geometry. The guest already caps what it sends, but a guest runs in a page's process, so main re-checks every
 * field of every message and keeps only what fits.
 */
import {
  COMPONENT_MAX_CHARS,
  COMPUTED_STYLE_ALLOWLIST,
  CROP_MAX_SIDE,
  CROP_PADDING,
  HTML_MAX_CHARS,
  MAX_STYLES,
  SELECTOR_MAX_CHARS,
  STYLE_VALUE_MAX_CHARS,
  TAG_MAX_CHARS,
  type OverlayRect,
  type PickedPayload
} from '../../shared/browser-comment'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

export function toRect(v: unknown): OverlayRect | null {
  if (!isRecord(v)) return null
  const { x, y, width, height } = v
  if (![x, y, width, height].every((n) => typeof n === 'number' && Number.isFinite(n))) return null
  const rect = { x: x as number, y: y as number, width: width as number, height: height as number }
  // A node can be bigger than the viewport (a long page), but not absurdly so.
  if (rect.width < 0 || rect.height < 0 || rect.width > 1e6 || rect.height > 1e6) return null
  if (Math.abs(rect.x) > 1e7 || Math.abs(rect.y) > 1e7) return null
  return rect
}

const ALLOWED_STYLES = new Set(COMPUTED_STYLE_ALLOWLIST)

/**
 * Validate and cap a guest's `picked` message. `null` = malformed (nothing is stored). Style keys outside the
 * allowlist are dropped: the allowlist is main's, not the guest's.
 */
export function validatePicked(raw: unknown): PickedPayload | null {
  if (!isRecord(raw)) return null
  const { selector, tag, outerHTML, component, styles, rect, viewport } = raw
  if (typeof selector !== 'string' || selector.length === 0) return null
  if (typeof tag !== 'string') return null
  const r = toRect(rect)
  if (!r) return null
  const vp = toRect({ x: 0, y: 0, ...(isRecord(viewport) ? viewport : {}) })
  if (!vp || vp.width <= 0 || vp.height <= 0) return null

  const cleanStyles: Record<string, string> = {}
  if (isRecord(styles)) {
    for (const [k, v] of Object.entries(styles)) {
      if (Object.keys(cleanStyles).length >= MAX_STYLES) break
      if (!ALLOWED_STYLES.has(k) || typeof v !== 'string' || v === '') continue
      cleanStyles[k] = cut(v, STYLE_VALUE_MAX_CHARS)
    }
  }
  return {
    selector: cut(selector, SELECTOR_MAX_CHARS),
    tag: cut(tag, TAG_MAX_CHARS),
    outerHTML: typeof outerHTML === 'string' ? cut(outerHTML, HTML_MAX_CHARS) : '',
    component:
      typeof component === 'string' && component !== ''
        ? cut(component, COMPONENT_MAX_CHARS)
        : null,
    styles: cleanStyles,
    rect: r,
    viewport: { width: vp.width, height: vp.height }
  }
}

/* ---- Crop geometry ---------------------------------------------------------------------------------- */

/**
 * The rect to capture: the node's rect grown by {@link CROP_PADDING} on every side, clamped to the viewport.
 * Whole CSS pixels (`capturePage` takes integers). `null` when nothing of the node is inside the viewport.
 */
export function cropRect(
  node: OverlayRect,
  viewport: { width: number; height: number },
  padding = CROP_PADDING
): { x: number; y: number; width: number; height: number } | null {
  const x0 = Math.max(0, Math.floor(node.x - padding))
  const y0 = Math.max(0, Math.floor(node.y - padding))
  const x1 = Math.min(Math.floor(viewport.width), Math.ceil(node.x + node.width + padding))
  const y1 = Math.min(Math.floor(viewport.height), Math.ceil(node.y + node.height + padding))
  if (x1 - x0 < 1 || y1 - y0 < 1) return null
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

/** The size a capture of `width`×`height` is scaled to so its longest side is at most {@link CROP_MAX_SIDE}. */
export function scaledCropSize(
  width: number,
  height: number,
  maxSide = CROP_MAX_SIDE
): { width: number; height: number } {
  const longest = Math.max(width, height)
  if (longest <= maxSide) return { width, height }
  const k = maxSide / longest
  return {
    width: Math.max(1, Math.round(width * k)),
    height: Math.max(1, Math.round(height * k))
  }
}

/** Folder-relative path of a pin's crop (spec §8.3). `batchId` is Harnu-minted hex; `n` a positive integer. */
export function cropRelPath(batchId: string, n: number): string {
  return `.harnu/out/browser/comments/${batchId}/${n}.png`
}
