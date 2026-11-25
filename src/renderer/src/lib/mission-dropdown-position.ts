/**
 * Mission dropdown · where the layer sits (design.md §6 "Mission dropdown" → "Anchoring, size, scroll").
 *
 * Pure geometry, no DOM: the dropdown is a `position: fixed` layer teleported to `<body>`, so its place is
 * computed from the pill's rectangle and the window's size. The numbers are the design's: 6px under the
 * Topbar's bottom edge (the Topbar is 42px, so `top: 48px`), its left edge on the pill's left edge,
 * flipped to the pill's right edge when it would run past the window, and never closer than 8px to a
 * window edge. The width is `min(420px, 100vw - 16px)` with no minimum; the height is capped at
 * `min(640px, 100vh - 56px)`.
 */

/** The Topbar's height (design.md §4 "Layout dimensions"). */
export const TOPBAR_HEIGHT = 42
/** The gap between the Topbar's bottom edge and the dropdown. */
export const DROPDOWN_GAP = 6
/** Where the dropdown's top edge sits. */
export const DROPDOWN_TOP = TOPBAR_HEIGHT + DROPDOWN_GAP
/** The closest the dropdown comes to a window edge. */
export const DROPDOWN_EDGE = 8
/** The widest the dropdown gets. */
export const DROPDOWN_MAX_WIDTH = 420
/** The tallest the dropdown gets, before the window caps it. */
export const DROPDOWN_MAX_HEIGHT = 640
/** Under this window height the footer stops being pinned and scrolls with the body. */
export const DROPDOWN_SHORT_WINDOW = 420

/** The part of the pill's rectangle the placement reads. */
export interface DropdownAnchor {
  left: number
  right: number
}

export interface DropdownPlacement {
  top: number
  left: number
  width: number
  maxHeight: number
}

/**
 * The dropdown's box for a pill (`anchor`) in a window (`viewport`). With no anchor — the pill is not in
 * the page — the dropdown sits on the left margin.
 */
export function placeMissionDropdown(input: {
  anchor: DropdownAnchor | null
  viewport: { width: number; height: number }
}): DropdownPlacement {
  const { anchor, viewport } = input
  const width = Math.max(0, Math.min(DROPDOWN_MAX_WIDTH, viewport.width - 2 * DROPDOWN_EDGE))
  const maxHeight = Math.max(0, Math.min(DROPDOWN_MAX_HEIGHT, viewport.height - 56))
  const furthestLeft = Math.max(DROPDOWN_EDGE, viewport.width - DROPDOWN_EDGE - width)

  let left = anchor ? anchor.left : DROPDOWN_EDGE
  // Near the right of the window the dropdown hangs from the pill's right edge instead.
  if (anchor && left + width > viewport.width - DROPDOWN_EDGE) left = anchor.right - width
  left = Math.min(Math.max(left, DROPDOWN_EDGE), furthestLeft)

  return { top: DROPDOWN_TOP, left, width, maxHeight }
}
