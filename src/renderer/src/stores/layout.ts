import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { persistedRef } from './persisted'
import { useSettingsStore } from './settings'
import { resolveSplitOrientation, type SplitOrientation } from '../lib/split-orientation'

const STORAGE_KEY = 'om2tab.sidebarWidth'
const SIDEBAR_COLLAPSED_KEY = 'om2tab.sidebarCollapsed'
const HELPER_COLLAPSED_KEY = 'om2tab.helperCollapsed'
const ATTENTION_OPEN_KEY = 'om2tab.attentionOpen'

// Sidebar drag-resize bounds (design.md §4 — Layout dimensions). The width is
// clamped to [MIN, MAX]; a missing/invalid persisted value falls back to DEFAULT.
export const SIDEBAR_WIDTH_MIN = 200
export const SIDEBAR_WIDTH_DEFAULT = 268
export const SIDEBAR_WIDTH_MAX = 480

function clampWidth(w: number): number {
  return Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, w))
}

// `persistedRef` codec for a boolean: absent → the declared default, and only the
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

/* ---------------------------------------------------------------------------------------------- */
/* Layout motion (T628, design.md §7 "Layout motion")                                              */
/* ---------------------------------------------------------------------------------------------- */

/** Time the flag outlives the transition, so the last frame and the browser pane's final rect land. */
export const LAYOUT_MOTION_SLACK_MS = 80
/** Trailing delay of the xterm refit during a motion: longer than a frame, shorter than a blink. */
export const REFLOW_DELAY_MS = 120
const SLOW_DURATION_FALLBACK_MS = 220

type TimerHandle = unknown

export interface LayoutMotionDeps {
  /** `--dur-slow` in ms. */
  durationMs: () => number
  /** `prefers-reduced-motion: reduce`. */
  reduced: () => boolean
  /** The `data-layout-motion` flag on the shell. */
  onChange: (active: boolean) => void
  /** Swap browser panes for their JPEG stand-in (true) or bring them back live (false). */
  freeze: (on: boolean) => void
  setTimer: (cb: () => void, ms: number) => TimerHandle
  clearTimer: (handle: TimerHandle) => void
  /** True while a layout transition is still running; the flag then waits (bounded) instead of ending. */
  busy?: () => boolean
}

/** How many times a running transition can postpone the end of a motion (each wait is 50ms). */
const MOTION_BUSY_RETRIES = 12

/**
 * The transient motion flag. `begin()` is called right BEFORE a layout state change that is not a
 * drag; it raises the flag (which enables the transitions in `main.css`) and freezes browser panes,
 * then drops both once `--dur-slow` plus a little slack have passed. A second `begin()` while one
 * is running extends it and never freezes twice. Under reduced motion it does nothing and returns
 * false: the layout snaps. Pure over its deps so it is unit-testable without a DOM.
 */
export function createLayoutMotion(deps: LayoutMotionDeps): {
  begin: () => boolean
  readonly active: boolean
} {
  let active = false
  let timer: TimerHandle = null
  let waited = 0
  const finish = (): void => {
    timer = null
    if (deps.busy?.() && waited < MOTION_BUSY_RETRIES) {
      waited++
      timer = deps.setTimer(finish, 50)
      return
    }
    waited = 0
    active = false
    deps.onChange(false)
    deps.freeze(false)
  }
  return {
    begin(): boolean {
      if (deps.reduced()) return false
      if (timer !== null) deps.clearTimer(timer)
      waited = 0
      if (!active) {
        active = true
        deps.onChange(true)
        deps.freeze(true)
      }
      timer = deps.setTimer(finish, deps.durationMs() + LAYOUT_MOTION_SLACK_MS)
      return true
    },
    get active() {
      return active
    }
  }
}

export interface ReflowGateDeps {
  isMotion: () => boolean
  fit: () => void
  delayMs: number
  setTimer: (cb: () => void, ms: number) => TimerHandle
  clearTimer: (handle: TimerHandle) => void
}

/**
 * Gate for an xterm's resize observer. Outside a motion every observation refits at once (a drag
 * stays live); during one, each observation only re-arms a single trailing refit, so the grid
 * changes once after the last frame instead of on every frame.
 */
export function createReflowGate(deps: ReflowGateDeps): {
  observe: () => void
  cancel: () => void
} {
  let timer: TimerHandle = null
  const cancel = (): void => {
    if (timer !== null) deps.clearTimer(timer)
    timer = null
  }
  return {
    observe(): void {
      if (!deps.isMotion()) {
        cancel()
        deps.fit()
        return
      }
      cancel()
      timer = deps.setTimer(() => {
        timer = null
        deps.fit()
      }, deps.delayMs)
    },
    cancel
  }
}

/** `--dur-slow` in ms (the token may compute to `220ms` or `0.22s`); a fallback outside a browser. */
export function slowDurationMs(): number {
  if (typeof document === 'undefined') return SLOW_DURATION_FALLBACK_MS
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--dur-slow').trim()
  const n = parseFloat(raw)
  if (!Number.isFinite(n) || n <= 0) return SLOW_DURATION_FALLBACK_MS
  return raw.endsWith('ms') ? n : raw.endsWith('s') ? n * 1000 : n
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
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

  // The bottom dock (design.md §6 "Bottom dock"). Both sections start folded and are never
  // opened by the app: only the operator's own gestures set these, and an emptied section folds
  // itself again (its component), so it never reappears already open. Nothing is persisted.
  const needsYouOpen = ref(false)
  const returnHereOpen = ref(false)
  // Needs attention (the strip above the list) is open by default and remembers a fold.
  const attentionOpen = persistedRef<boolean>(ATTENTION_OPEN_KEY, true, BOOL_CODEC)
  // Raised by a gesture that has to show the sidebar; App.vue also leaves a pane's
  // expand-to-window for it, which hides the sidebar without collapsing it.
  const sidebarRevealRequest = ref(0)

  // Split orientation (T627). The operator's choice lives in the settings store;
  // `auto` needs the main area's size (the box holding the session area and the
  // helper stack, measured by App.vue) and remembers its last result so the
  // hysteresis band holds it. Until something measures, the layout is side by side.
  const autoOrientation = ref<SplitOrientation>('side-by-side')
  const mainAreaSize = ref<{ width: number; height: number }>({ width: 0, height: 0 })

  function setMainAreaSize(width: number, height: number): void {
    mainAreaSize.value = { width, height }
    autoOrientation.value = resolveSplitOrientation(
      'auto',
      mainAreaSize.value,
      autoOrientation.value
    )
  }

  /** The layout actually in force: the pinned choice, or the `auto` result. */
  const splitOrientation = computed<SplitOrientation>(() => {
    const setting = useSettingsStore().splitLayout
    return setting === 'auto' ? autoOrientation.value : setting
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

  /**
   * Open the dock's Needs you section on an explicit operator gesture: the OS-notification
   * deep-link, the "Open approvals" palette action and the approvals shortcut. A collapsed
   * sidebar expands, because the dock is part of it. Layout only, never focus: the caret
   * stays in the terminal.
   */
  function openNeedsYou(): void {
    sidebarCollapsed.value = false
    sidebarRevealRequest.value++
    needsYouOpen.value = true
  }

  /** ⌘⇧A: open Needs you; pressed again while it is on screen and open, fold it. */
  function toggleNeedsYou(): void {
    if (needsYouOpen.value && !sidebarCollapsed.value) needsYouOpen.value = false
    else openNeedsYou()
  }

  // T628: the transient layout-motion flag. Raised around a layout state change that is not a drag.
  const layoutMotion = ref(false)
  let transitionsRunning = 0
  const motion = createLayoutMotion({
    busy: () => transitionsRunning > 0,
    durationMs: slowDurationMs,
    reduced: prefersReducedMotion,
    onChange: (on) => {
      layoutMotion.value = on
    },
    // The same stand-in a splitter or sidebar drag uses (browser store, spec §2.4).
    freeze: (on) => window.api?.browserDrag?.(on),
    setTimer: (cb, ms) => setTimeout(cb, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
  })

  /** Call right before a layout change that should animate; false when reduced motion snaps it. */
  function beginLayoutMotion(): boolean {
    return motion.begin()
  }

  // The style recalc that starts a transition can land late (a busy frame, a browser pane being
  // frozen). Each transition that really starts inside a layout container re-arms the timer from
  // that moment, so the flag outlives the last transition instead of cutting it short.
  if (typeof document !== 'undefined') {
    document.addEventListener(
      'transitionstart',
      (ev) => {
        if (!motion.active) return
        const el = ev.target
        if (el instanceof Element && el.hasAttribute('data-lm')) motion.begin()
      },
      true
    )
    // Count the layout transitions in flight, so the flag never ends in the middle of one.
    const track = (delta: number) => (ev: Event) => {
      const el = ev.target
      if (el instanceof Element && el.hasAttribute('data-lm')) {
        transitionsRunning = Math.max(0, transitionsRunning + delta)
      }
    }
    document.addEventListener('transitionrun', track(1), true)
    document.addEventListener('transitionend', track(-1), true)
    document.addEventListener('transitioncancel', track(-1), true)
  }

  return {
    sidebarWidth,
    layoutMotion,
    beginLayoutMotion,
    splitOrientation,
    mainAreaSize,
    setMainAreaSize,
    setSidebarWidth,
    resetSidebarWidth,
    sidebarCollapsed,
    helperCollapsed,
    toggleSidebar,
    setSidebarCollapsed,
    toggleHelper,
    setHelperCollapsed,
    needsYouOpen,
    returnHereOpen,
    attentionOpen,
    sidebarRevealRequest,
    openNeedsYou,
    toggleNeedsYou
  }
})
