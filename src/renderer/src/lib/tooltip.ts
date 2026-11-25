/**
 * The app tooltip (design.md §6 "Tooltip"). Chromium's native `title` tooltip waits about a second and
 * its delay cannot be tuned, so one app-wide layer (`TooltipLayer.vue`) replaces it: it listens on the
 * document, and while the pointer (or keyboard focus) rests on an anchor it hides that anchor's native
 * `title` and shows the same text after {@link OPEN_DELAY_MS}.
 *
 * An anchor is any element with a `title`, plus an icon-only control (a button, link, tab or menu item
 * with no visible text) that names itself only through `aria-label`, so every bare icon gets a tooltip
 * without each call site repeating its label. `data-tooltip="off"` on an element or an ancestor opts out.
 *
 * The pure parts (anchor resolution, delay, placement) live here and are unit-tested; the component is
 * the thin DOM adapter.
 */

/** Delay before the first tooltip appears. */
export const OPEN_DELAY_MS = 250
/** After a tooltip closes, the next one within this window opens at once (scanning a toolbar). */
export const WARM_WINDOW_MS = 500
/** Gap between the anchor and the tooltip. */
export const GAP_PX = 6
/** Minimum distance from the window edge. */
export const EDGE_PX = 8

/** Where a `title` is kept while its anchor is hovered, so the native tooltip does not also show. */
export const STASH_ATTR = 'data-harnu-title'

const ICON_ONLY_ROLES = new Set(['button', 'link', 'tab', 'menuitem', 'menuitemcheckbox', 'option'])

function isIconOnlyControl(el: Element): boolean {
  const role = el.getAttribute('role')
  const interactive =
    el.tagName === 'BUTTON' || el.tagName === 'A' || (role !== null && ICON_ONLY_ROLES.has(role))
  if (!interactive) return false
  return (el.textContent ?? '').trim() === ''
}

/** The tooltip text an element carries on its own, or null when it is not an anchor. */
export function ownTooltipText(el: Element): string | null {
  const title = el.getAttribute('title') ?? el.getAttribute(STASH_ATTR)
  if (title !== null && title.trim() !== '') return title.trim()
  const label = el.getAttribute('aria-label')
  if (label !== null && label.trim() !== '' && isIconOnlyControl(el)) return label.trim()
  return null
}

/**
 * The nearest anchor at or above `target`, with its text. SVG chart marks keep their own `<title>`
 * children (a native SVG tooltip), which this never touches.
 */
export function resolveAnchor(target: Element | null): { el: Element; text: string } | null {
  if (!target || target.closest('[data-tooltip="off"]')) return null
  for (let el: Element | null = target; el && el !== document.body; el = el.parentElement) {
    const text = ownTooltipText(el)
    if (text !== null) return { el, text }
  }
  return null
}

/** How long to wait before showing: at once while warm, else {@link OPEN_DELAY_MS}. */
export function openDelay(now: number, lastClosedAt: number | null): number {
  return lastClosedAt !== null && now - lastClosedAt <= WARM_WINDOW_MS ? 0 : OPEN_DELAY_MS
}

export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

export interface Placement {
  x: number
  y: number
  side: 'bottom' | 'top'
}

/**
 * Place a `tip`-sized tooltip for `anchor`: centered below it, flipped above when it would leave the
 * window at the bottom, and clamped to {@link EDGE_PX} from either side.
 */
export function placeTooltip(
  anchor: Rect,
  tip: { width: number; height: number },
  viewport: { width: number; height: number }
): Placement {
  const below = anchor.top + anchor.height + GAP_PX
  const above = anchor.top - GAP_PX - tip.height
  const fitsBelow = below + tip.height <= viewport.height - EDGE_PX
  const side: Placement['side'] = fitsBelow || above < EDGE_PX ? 'bottom' : 'top'
  const rawX = anchor.left + anchor.width / 2 - tip.width / 2
  const maxX = Math.max(EDGE_PX, viewport.width - EDGE_PX - tip.width)
  const x = Math.min(Math.max(rawX, EDGE_PX), maxX)
  const y = side === 'bottom' ? Math.min(below, viewport.height - EDGE_PX - tip.height) : above
  return { x: Math.round(x), y: Math.round(Math.max(y, EDGE_PX)), side }
}
