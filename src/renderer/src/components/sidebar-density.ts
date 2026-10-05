/**
 * Sidebar density presets (design.md §4 "Row density" + §6 "Row anatomy &
 * indentation"). A user-chosen preset scales the sidebar's own rows — heights,
 * the session-row gap, and the left indent — without touching any surface
 * outside the sidebar. Persisted globally under `om2tab.sidebarDensity`.
 *
 * Pure module (no Vue/Pinia) so the metrics table is a single source of truth
 * that both `SidebarFolder` and `SidebarDrillView` read, and so it can be
 * unit-tested in isolation like `session-sort.ts` / `folder-sort.ts`.
 */

/** The two density presets. `comfortable` is the default baseline. */
export type SidebarDensity = 'comfortable' | 'compact'

/** Runtime guard for a persisted density value (localStorage may hold junk). */
export function isSidebarDensity(v: unknown): v is SidebarDensity {
  return v === 'comfortable' || v === 'compact'
}

/**
 * The context a session-style row renders in — decides its left indent. `flat`
 * is a folder that isn't grouped under a repo header; `nested` is one that is;
 * `drill` is the drill-in folder screen (`headerless`, its own back-row names
 * the folder, so the classic offset isn't warranted).
 */
export type SidebarRowContext = 'flat' | 'nested' | 'drill'

/** Every pixel dimension the sidebar rows scale by density. */
export interface SidebarMetrics {
  /** Folder-row height. */
  folderRowHeight: number
  /** Session-row height. */
  sessionRowHeight: number
  /** Terminal-row height. */
  terminalRowHeight: number
  /** Agent / teammate child-row height. */
  childRowHeight: number
  /** "TERMINALS" eyebrow height. */
  eyebrowHeight: number
  /** Session-row inter-slot gap. */
  gap: number
  /** Session left indent, keyed by render context. */
  sessionIndent: Record<SidebarRowContext, number>
  /** How much deeper an agent / teammate child row indents past its session. */
  childIndentDelta: number
}

const COMFORTABLE: SidebarMetrics = {
  folderRowHeight: 26,
  sessionRowHeight: 28,
  terminalRowHeight: 26,
  childRowHeight: 24,
  eyebrowHeight: 22,
  gap: 9,
  sessionIndent: { flat: 24, nested: 44, drill: 12 },
  childIndentDelta: 16
}

const COMPACT: SidebarMetrics = {
  folderRowHeight: 23,
  sessionRowHeight: 24,
  terminalRowHeight: 23,
  childRowHeight: 22,
  eyebrowHeight: 20,
  gap: 8,
  sessionIndent: { flat: 16, nested: 32, drill: 8 },
  childIndentDelta: 14
}

/** The full metrics table for a density preset. */
export function densityMetrics(density: SidebarDensity): SidebarMetrics {
  return density === 'compact' ? COMPACT : COMFORTABLE
}

/**
 * Resolve a session row's left indent for a given density and render context.
 * `nested` = grouped under a repo-group header; `drill` = drill-in folder
 * screen; `flat` = a standalone folder in the classic tree.
 */
export function sessionIndentFor(density: SidebarDensity, context: SidebarRowContext): number {
  return densityMetrics(density).sessionIndent[context]
}

/** Resolve an agent / teammate child row's left indent (session indent + delta). */
export function childIndentFor(density: SidebarDensity, context: SidebarRowContext): number {
  const m = densityMetrics(density)
  return m.sessionIndent[context] + m.childIndentDelta
}
