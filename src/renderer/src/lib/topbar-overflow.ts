import type { Component } from 'vue'

/**
 * Topbar overflow (BUG-252, design.md §6 "Topbar overflow"): which right-cluster actions stay in the bar
 * and which move into the `…` menu. Pure math, no DOM: `Topbar.vue` measures and renders, this decides.
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

/** An action button is 26×26. */
export const TOPBAR_ACTION_PX = 26
/** The cluster's `gap-0.5`. */
export const TOPBAR_ACTION_GAP_PX = 2
/** One slot in the cluster: an action, or the `…` button. */
const SLOT_PX = TOPBAR_ACTION_PX + TOPBAR_ACTION_GAP_PX
/** The title never truncates below this; actions leave the bar before it goes any lower. */
export const TOPBAR_MIN_TITLE_PX = 96
/** A hidden action comes back only when it fits with this much to spare. */
export const TOPBAR_HYSTERESIS_PX = 8
/** What is left of the breadcrumb at the very end: its icon, the gap and the `›`. */
export const TOPBAR_CRUMB_MIN_PX = 32
/** What is left of the folder view's branch badge at the very end: its 11px icon. */
export const TOPBAR_BRANCH_MIN_PX = 11
/** The sidebar toggle: 26px wide with a -4px left margin. */
export const TOPBAR_TOGGLE_PX = 22
/** The Activity bell, which never overflows. */
export const TOPBAR_BELL_PX = 26
/** The header's `gap-3` between its regions. */
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
  /** How many actions the previous plan hid (drives the hysteresis). */
  previousHiddenCount?: number
}

/** How many actions must leave for `count` present ones to fit in `available` px. */
function hiddenCountFor(count: number, available: number): number {
  for (let hidden = 0; hidden <= count; hidden++) {
    const slots = count - hidden + (hidden > 0 ? 1 : 0) // the `…` button takes a slot
    if (slots * SLOT_PX <= available) return hidden
  }
  return count
}

export function planTopbarOverflow(input: OverflowInput): OverflowPlan {
  const { present, available } = input
  const prev = Math.min(input.previousHiddenCount ?? 0, present.length)
  let count = hiddenCountFor(present.length, available)
  // Hysteresis: an action that was hidden returns only once it fits with a margin to spare.
  if (count < prev)
    count = Math.min(prev, hiddenCountFor(present.length, available - TOPBAR_HYSTERESIS_PX))
  const leaving = new Set(
    TOPBAR_OVERFLOW_ORDER.filter((id) => present.includes(id)).slice(0, count)
  )
  return {
    visible: present.filter((id) => !leaving.has(id)),
    hidden: present.filter((id) => leaving.has(id))
  }
}

export interface BudgetInput {
  headerWidth: number
  /** Left plus right padding of the header. */
  paddingX: number
  /** The session view has a breadcrumb before the title; the folder view has none. */
  hasCrumb: boolean
  /** Width of the badges after the title, gaps included. */
  extrasWidth: number
}

/**
 * The width left for the action cluster (the bell excluded: it never overflows): the header minus its
 * padding, the toggle, the bell, the gaps between regions, the breadcrumb's minimum, the badges and the
 * title's floor.
 */
export function clusterBudget(input: BudgetInput): number {
  const gaps = (input.hasCrumb ? 3 : 2) * TOPBAR_REGION_GAP_PX
  return (
    input.headerWidth -
    input.paddingX -
    TOPBAR_TOGGLE_PX -
    TOPBAR_BELL_PX -
    gaps -
    (input.hasCrumb ? TOPBAR_CRUMB_MIN_PX : 0) -
    input.extrasWidth -
    TOPBAR_MIN_TITLE_PX
  )
}

/**
 * One right-cluster action as the bar and the overflow menu both draw it: the same icon, label,
 * chord hint, state and handler in either place.
 */
export interface TopbarActionView {
  id: TopbarActionId
  /** The button's `aria-label`, and the menu row's text. */
  label: string
  /** The button's tooltip: the label plus its chord when one is bound. */
  title: string
  /** The chord shown at the right edge of the menu row, or `''`. */
  hint: string
  icon: Component
  iconProps: Record<string, unknown>
  /** `on` = a view that is open (accent-soft + accent), `ink` = an explicit override (accent ink only). */
  state: 'idle' | 'on' | 'ink'
  /** A toggle exposes its state as `aria-pressed` (bar) / `aria-checked` (menu). */
  toggle: boolean
  disabled?: boolean
  run: () => void
}
