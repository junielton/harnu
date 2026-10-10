import { defineStore } from 'pinia'
import { persistedRef, persistedSet } from './persisted'
import { DEFAULT_BOARD_ORDER, type BoardOrder, type BoardState } from '../components/fleet-board'

const STORAGE_KEY = 'om2tab.sidebarWidth'
const SIDEBAR_COLLAPSED_KEY = 'om2tab.sidebarCollapsed'
const HELPER_COLLAPSED_KEY = 'om2tab.helperCollapsed'
const INBOX_RAIL_WIDTH_KEY = 'om2tab.inboxRailWidth'
const INBOX_RAIL_STATE_KEY = 'om2tab.inboxRailState'
const INBOX_RAIL_HIDDEN_STATES_KEY = 'om2tab.inboxRailHiddenStates'
const INBOX_RAIL_ORDER_KEY = 'om2tab.inboxRailOrder'

// Sidebar drag-resize bounds (design.md §4 — Layout dimensions). The width is
// clamped to [MIN, MAX]; a missing/invalid persisted value falls back to DEFAULT.
export const SIDEBAR_WIDTH_MIN = 200
export const SIDEBAR_WIDTH_DEFAULT = 268
export const SIDEBAR_WIDTH_MAX = 480

// Inbox rail bounds (T83 S0; design.md §4 — Layout dimensions). The rail is the
// fourth column: fleet-global, so its width is a global preference like the
// sidebar's — NOT per-worktree like the helper stack's `splitRatio`.
export const INBOX_RAIL_WIDTH_MIN = 260
export const INBOX_RAIL_WIDTH_DEFAULT = 300
export const INBOX_RAIL_WIDTH_MAX = 440
/** Width of the minimized strip — icons + badges only, no list (design.md §6). */
export const INBOX_RAIL_MINIMIZED_WIDTH = 44

/**
 * The rail's three states (T83 §5.5). `hidden` is a SOFT state: it means "don't
 * spend width on this right now", not "don't tell me" — an incoming actionable
 * item breaks it via {@link summonInboxRail}. `minimized` still renders the
 * badge, which is the whole point: you see that two things are waiting WITHOUT
 * clicking. A minimized rail that hid the count would just be a modal with extra
 * steps.
 */
export type InboxRailState = 'expanded' | 'minimized' | 'hidden'

const INBOX_RAIL_STATES: readonly InboxRailState[] = ['expanded', 'minimized', 'hidden']

function isInboxRailState(v: string): v is InboxRailState {
  return (INBOX_RAIL_STATES as readonly string[]).includes(v)
}

/**
 * The Fleet rail's state filter (T159) — which of the five non-idle
 * `BoardState`s render as cards. `idle` is deliberately excluded: it's never
 * rendered in the rail at all (design.md §2), so exposing a toggle for it
 * would silently reopen that settled decision.
 */
export const INBOX_RAIL_FILTERABLE_STATES: readonly BoardState[] = [
  'needs-input',
  'errored',
  'stuck',
  'working',
  'done'
]

function isFilterableBoardState(v: string): v is BoardState {
  return (INBOX_RAIL_FILTERABLE_STATES as readonly string[]).includes(v)
}

function clampWidth(w: number): number {
  return Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, w))
}

function clampRailWidth(w: number): number {
  return Math.max(INBOX_RAIL_WIDTH_MIN, Math.min(INBOX_RAIL_WIDTH_MAX, w))
}

/**
 * The rail's rendered width in px for a given state, or `null` when it should not
 * render at all. Pure so the state→width contract is unit-testable without a DOM.
 */
export function inboxRailWidthFor(state: InboxRailState, expandedWidth: number): number | null {
  if (state === 'hidden') return null
  if (state === 'minimized') return INBOX_RAIL_MINIMIZED_WIDTH
  return clampRailWidth(expandedWidth)
}

/**
 * ⌘⇧A / the Topbar button: expanded collapses to the strip, anything else opens
 * up. Deliberately NOT a 3-way cycle — `hidden` is reachable from the View menu
 * and by dragging the rail shut, but a toggle should never *hide* a queue the
 * operator was just looking at.
 */
export function nextInboxRailStateOnToggle(state: InboxRailState): InboxRailState {
  return state === 'expanded' ? 'minimized' : 'expanded'
}

// `persistedRef` codec for a default-OFF boolean: absent → false, and only the
// literal string `'true'` deserializes back to `true` (anything else is false).
// Mirrors the number codec's explicit `serialize:String` to dodge JSON quirks.
const BOOL_CODEC = { serialize: String, deserialize: (raw: string): boolean => raw === 'true' }

/**
 * Whether the right-hand helper panel (HelperStack) should actually render.
 *
 * Two gates compose (design.md §6 — Collapsing sidebars): the panel auto-shows
 * only when the current worktree HAS panes, AND a manual `helperCollapsed`
 * override can hide it even while panes exist ("full screen for the terminal").
 * Pure so the collapse-hides-even-with-panes rule is unit-testable without a
 * DOM. `App.vue` feeds it `helpers.hasHelpersForCurrentWorktree` +
 * `layout.helperCollapsed`.
 */
export function helperPanelVisible(hasHelpers: boolean, collapsed: boolean): boolean {
  return hasHelpers && !collapsed
}

/**
 * Global layout state persisted to `localStorage` — mirrors the theme store's
 * anatomy. The sidebar is single across the app, so its width is a global
 * preference (not per-project/worktree). Persisted under `om2tab.sidebarWidth`.
 */
export const useLayoutStore = defineStore('layout', () => {
  // persistedRef owns the localStorage mirror; the clamping deserializer keeps
  // the old load-time behavior (an out-of-range persisted value is clamped, a
  // non-finite one falls back to DEFAULT via `validate`).
  const sidebarWidth = persistedRef<number>(STORAGE_KEY, SIDEBAR_WIDTH_DEFAULT, {
    serialize: String,
    deserialize: (raw) => clampWidth(Number(raw)),
    validate: Number.isFinite
  })

  // Collapse state (design.md §6 — Colapsar sidebars). Both default OFF and
  // persist globally, alongside `sidebarWidth`. `sidebarCollapsed` hides the
  // left folder/session sidebar; `helperCollapsed` hides the right helper panel
  // even when the worktree has panes (composed via `helperPanelVisible`).
  const sidebarCollapsed = persistedRef<boolean>(SIDEBAR_COLLAPSED_KEY, false, BOOL_CODEC)
  const helperCollapsed = persistedRef<boolean>(HELPER_COLLAPSED_KEY, false, BOOL_CODEC)

  // Inbox rail (T83 S0) — the fourth column. Global, like the sidebar: the
  // approval queue is fleet-wide, so it must NOT ride the per-worktree helper
  // state (a rail that vanished when you switched folders would hide exactly the
  // confirm you need to see while looking somewhere else).
  const inboxRailWidth = persistedRef<number>(INBOX_RAIL_WIDTH_KEY, INBOX_RAIL_WIDTH_DEFAULT, {
    serialize: String,
    deserialize: (raw) => clampRailWidth(Number(raw)),
    validate: Number.isFinite
  })
  const inboxRailState = persistedRef<InboxRailState>(INBOX_RAIL_STATE_KEY, 'expanded', {
    serialize: String,
    deserialize: (raw) => raw as InboxRailState,
    validate: (v) => typeof v === 'string' && isInboxRailState(v)
  })

  // Fleet rail state filter (T159) — which BoardStates are hidden from the
  // rail's card list. Default empty = show all. An unknown/legacy persisted
  // value is dropped by `validate` rather than resetting the whole set, so a
  // future state rename can only ever fall back toward "show more," never
  // "hide everything."
  const inboxRailHiddenStates = persistedSet<BoardState>(INBOX_RAIL_HIDDEN_STATES_KEY, {
    validate: isFilterableBoardState
  })

  // Fleet rail card order (T459) — creation order inside each state group,
  // newest first by default; the header toggle inverts it. Fleet-global like
  // its neighbours. Persisted as a plain string; an unknown value falls back to
  // the default rather than being trusted.
  const inboxRailOrder = persistedRef<BoardOrder>(INBOX_RAIL_ORDER_KEY, DEFAULT_BOARD_ORDER, {
    validate: (v) => v === 'newest-first' || v === 'oldest-first'
  })

  function setSidebarWidth(w: number): void {
    sidebarWidth.value = clampWidth(w)
  }

  function resetSidebarWidth(): void {
    sidebarWidth.value = SIDEBAR_WIDTH_DEFAULT
  }

  function toggleSidebar(): void {
    sidebarCollapsed.value = !sidebarCollapsed.value
  }

  function setSidebarCollapsed(v: boolean): void {
    sidebarCollapsed.value = v
  }

  function toggleHelper(): void {
    helperCollapsed.value = !helperCollapsed.value
  }

  function setHelperCollapsed(v: boolean): void {
    helperCollapsed.value = v
  }

  function setInboxRailWidth(w: number): void {
    inboxRailWidth.value = clampRailWidth(w)
  }

  function resetInboxRailWidth(): void {
    inboxRailWidth.value = INBOX_RAIL_WIDTH_DEFAULT
  }

  function setInboxRailState(v: InboxRailState): void {
    inboxRailState.value = v
  }

  function toggleInboxRail(): void {
    inboxRailState.value = nextInboxRailStateOnToggle(inboxRailState.value)
  }

  /**
   * Expand the rail on an explicit operator gesture.
   *
   * ONE caller today: the OS-notification deep-link (`sessions.ts` →
   * `onNotifyActivateInbox`). The operator clicked the notification, so
   * opening the queue is literally what they asked for.
   *
   * It is NOT called when an actionable item merely arrives. That automatic
   * summon (T83 §5.6) was removed once the minimized strip started rendering
   * the whole fleet as minicards: it existed because a minimized rail showed
   * nothing, and with the signal preserved at 44px, forcing the layout open
   * became an interruption rather than a rescue. `minimized` and `hidden` are
   * HARD states now. Do not re-add a count watcher here — see the block
   * comment in `App.vue`.
   *
   * Crucially it changes LAYOUT, never FOCUS: no backdrop, no focus trap, no
   * 'modal' keyboard scope. The caret stays in the terminal. A modal
   * *interrupts*; the rail *appears*. If this ever starts stealing focus, it
   * has become the modal we deleted.
   */
  function summonInboxRail(): void {
    if (inboxRailState.value !== 'expanded') inboxRailState.value = 'expanded'
  }

  function toggleInboxRailOrder(): void {
    inboxRailOrder.value = inboxRailOrder.value === 'newest-first' ? 'oldest-first' : 'newest-first'
  }

  function toggleInboxRailStateVisibility(state: BoardState): void {
    inboxRailHiddenStates.toggle(state)
  }

  function clearInboxRailStateFilter(): void {
    inboxRailHiddenStates.clear()
  }

  return {
    sidebarWidth,
    setSidebarWidth,
    resetSidebarWidth,
    sidebarCollapsed,
    helperCollapsed,
    toggleSidebar,
    setSidebarCollapsed,
    toggleHelper,
    setHelperCollapsed,
    inboxRailWidth,
    inboxRailState,
    setInboxRailWidth,
    resetInboxRailWidth,
    setInboxRailState,
    toggleInboxRail,
    summonInboxRail,
    inboxRailOrder,
    toggleInboxRailOrder,
    inboxRailHiddenStates: inboxRailHiddenStates.set,
    toggleInboxRailStateVisibility,
    clearInboxRailStateFilter
  }
})
