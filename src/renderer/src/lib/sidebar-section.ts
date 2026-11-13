/**
 * Pure math + persistence codec for resizable, collapsible sidebar sections (T702,
 * design.md §6 "Sidebar sections"). Kept free of Vue and the DOM so the clamp rules are
 * unit-testable; `composables/useSidebarSections.ts` wires it to `localStorage`.
 */

/** Drag floor of a section: its eyebrow (28px) plus one row (60px, one collapsed Your move card). */
export const SECTION_MIN_HEIGHT = 88
/** Default drag ceiling of a section, before the folder list's own minimum is taken into account. */
export const SECTION_MAX_HEIGHT = 640
/** A collapsed section is its eyebrow row only. */
export const SECTION_COLLAPSED_HEIGHT = 28
/** The folder list keeps at least this much room while a section is dragged taller. */
export const SIDEBAR_LIST_MIN_HEIGHT = 160

/**
 * What is stored per section. `height: null` means "never dragged": the section is content-sized up
 * to its default cap, exactly as before it was resizable.
 */
export interface SectionState {
  height: number | null
  collapsed: boolean
}

export const DEFAULT_SECTION_STATE: SectionState = { height: null, collapsed: false }

/** `localStorage` key of one section (`om2tab.` prefix, design.md §6 "Sidebar sections"). */
export function sectionStorageKey(id: string): string {
  return `om2tab.sidebarSection.${id}`
}

/** Largest stored height we believe: nothing sane is taller, so anything above is corruption. */
const SANE_MAX_HEIGHT = 10_000

/**
 * Read a stored value. Never throws: a missing, corrupt or out-of-range value reads as the
 * default (a bad `height` alone drops only the height, the collapsed flag survives).
 */
export function parseSectionState(raw: string | null): SectionState {
  if (raw === null) return { ...DEFAULT_SECTION_STATE }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ...DEFAULT_SECTION_STATE }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ...DEFAULT_SECTION_STATE }
  }
  const { height, collapsed } = parsed as Record<string, unknown>
  return {
    height:
      typeof height === 'number' &&
      Number.isFinite(height) &&
      height > 0 &&
      height <= SANE_MAX_HEIGHT
        ? Math.round(height)
        : null,
    collapsed: collapsed === true
  }
}

export function serializeSectionState(s: SectionState): string {
  return JSON.stringify({ height: s.height, collapsed: s.collapsed })
}

export interface HeightBounds {
  /** Floor: the eyebrow plus one row. Wins over the ceiling when the window is too short for both. */
  min: number
  /** Configured maximum of the section. */
  max: number
  /** What the folder list leaves it (see {@link dragCeiling}). */
  ceiling: number
}

/** Clamp a height to `[min, min(max, ceiling)]`, whole pixels. A non-finite input is the floor. */
export function clampSectionHeight(height: number, b: HeightBounds): number {
  if (!Number.isFinite(height)) return b.min
  const top = Math.max(b.min, Math.min(b.max, b.ceiling))
  return Math.round(Math.max(b.min, Math.min(top, height)))
}

/**
 * The tallest the section may get while the folder list keeps its minimum: its height when the drag
 * began plus the list's spare height at that moment, never above `max`.
 */
export function dragCeiling(args: {
  startHeight: number
  listHeight: number
  listMin: number
  max: number
}): number {
  const spare = Math.max(0, args.listHeight - args.listMin)
  return Math.min(args.max, args.startHeight + spare)
}

/**
 * The handle sits on the TOP edge, so dragging up (smaller `y`) makes the section taller; the height
 * follows the pointer 1:1 (no easing), clamped to the bounds.
 */
export function heightFromDrag(
  args: { startHeight: number; startY: number; y: number } & HeightBounds
): number {
  return clampSectionHeight(args.startHeight + (args.startY - args.y), args)
}
