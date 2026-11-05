/**
 * Topbar overflow (BUG-252, design.md §6 "Topbar overflow") — STUB for the red commit: the declarations
 * are final, the behaviour is not written yet.
 */

export type TopbarActionId =
  | 'new-session'
  | 'roadmap'
  | 'pr-stack'
  | 'review'
  | 'open-folder'
  | 'editor'
  | 'github-pulls'
  | 'explorer'
  | 'terminal'
  | 'browser'
  | 'split-layout'
  | 'panel-right'

/** The cluster order, left to right, in the bar and in the menu. */
export const TOPBAR_BAR_ORDER: readonly TopbarActionId[] = [
  'new-session',
  'roadmap',
  'pr-stack',
  'review',
  'open-folder',
  'editor',
  'github-pulls',
  'explorer',
  'terminal',
  'browser',
  'split-layout',
  'panel-right'
]

/** The priority order, declared once: hide first → hide last. */
export const TOPBAR_OVERFLOW_ORDER: readonly TopbarActionId[] = [
  'github-pulls',
  'open-folder',
  'editor',
  'explorer',
  'split-layout',
  'browser',
  'terminal',
  'review',
  'pr-stack',
  'roadmap',
  'panel-right',
  'new-session'
]

export const TOPBAR_ACTION_PX = 26
export const TOPBAR_ACTION_GAP_PX = 2
export const TOPBAR_MIN_TITLE_PX = 96
export const TOPBAR_HYSTERESIS_PX = 8
export const TOPBAR_CRUMB_MIN_PX = 32
export const TOPBAR_TOGGLE_PX = 22
export const TOPBAR_REGION_GAP_PX = 12

export interface OverflowPlan {
  /** Actions that stay in the bar, in bar order. */
  visible: TopbarActionId[]
  /** Actions that moved into the `…` menu, in bar order. */
  hidden: TopbarActionId[]
}

export interface OverflowInput {
  /** The actions that exist right now, in bar order. */
  present: readonly TopbarActionId[]
  /** Width the action cluster may use (see {@link clusterBudget}). */
  available: number
  /** How many actions were hidden by the previous plan (drives the hysteresis). */
  previousHiddenCount?: number
}

export function planTopbarOverflow(input: OverflowInput): OverflowPlan {
  return { visible: [...input.present], hidden: [] }
}

export interface BudgetInput {
  headerWidth: number
  paddingX: number
  /** The session view has a breadcrumb before the title; the folder view has none. */
  hasCrumb: boolean
  /** Width of the badges after the title, with their gaps. */
  extrasWidth: number
}

export function clusterBudget(_input: BudgetInput): number {
  return 0
}
