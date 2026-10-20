import { computed, onBeforeUnmount, onMounted, ref, type ComputedRef, type Ref } from 'vue'

/**
 * Pane id used by `TerminalPane.vue` (the main Claude session terminal).
 * Helper panes use their own unique ids; this constant prevents typo bugs
 * across the three `register/unregisterFocusedPane(MAIN_PANE_ID)` callsites.
 */
export const MAIN_PANE_ID = 'main'

/**
 * Two things live here. The set below tracks which xterm panes hold focus (the
 * `terminalFocused` predicate). The pane-focus registry at the bottom of the file
 * (T486 U5b) knows every focus region, xterm or not, for F6 / ⇧F6, `pane.close`,
 * `pane.toggleMaximize` and the terminal toggle (`lib/pane-ring.ts`).
 *
 * Tracks the set of pane ids whose xterm.js terminal currently owns DOM
 * focus. Replaces the pre-R2 singleton bool so that multiple panes (split
 * helpers + main TerminalPane) can each contribute independently.
 *
 * **Who writes it:** any pane component that wraps an xterm Terminal —
 * `TerminalPane.vue` for the main pane (id `'main'`), `HelperPane.vue` for
 * split helpers (helper id). Each binds `focusin` / `focusout` on its host
 * element and calls the `register/unregister` helpers below.
 *
 * **Who reads it:** the `useShortcuts(...)` table in `App.vue` consults
 * `terminalFocused` through the `enabled` precondition on the
 * `session.close` binding. The keystroke falls through to xterm.js when ANY
 * pane is focused; only when NO terminal owns focus does Cmd+W close the
 * session selection.
 *
 * See `findings/07-shortcuts-palette.md` §2 row "⌘W" + §8 gotcha for the
 * "let xterm see Ctrl+W" rationale. The Set generalization came from the
 * split-helpers spec §8 R2.
 */
const focusedPanes = ref<Set<string>>(new Set())

const terminalFocusedComputed = computed(() => focusedPanes.value.size > 0)

export function useTerminalFocus(): { terminalFocused: ComputedRef<boolean> } {
  return { terminalFocused: terminalFocusedComputed }
}

/**
 * Register that a pane is currently focused. Idempotent — re-registering
 * the same id is a no-op. The Set is replaced on mutation so Vue's
 * reactivity picks up the change (a plain `.add` on the ref'd Set would
 * not trigger the computed).
 */
export function registerFocusedPane(id: string): void {
  if (focusedPanes.value.has(id)) return
  const next = new Set(focusedPanes.value)
  next.add(id)
  focusedPanes.value = next
}

/**
 * Unregister a previously-focused pane. Idempotent — unregistering an
 * unknown id is a no-op.
 */
export function unregisterFocusedPane(id: string): void {
  if (!focusedPanes.value.has(id)) return
  const next = new Set(focusedPanes.value)
  next.delete(id)
  focusedPanes.value = next
}

/**
 * Test-only escape hatch. Resets the focused-panes Set to empty so each
 * vitest case starts from a clean module state.
 */
export function resetTerminalFocusForTests(): void {
  focusedPanes.value = new Set()
}

// ── Pane-focus registry (T486 U5b, spec §8.1) ───────────────────────────────

/**
 * A focus region: the main terminal (`MAIN_PANE_ID`) or one helper pane (its pane
 * id). `el` is the region's root, which carries `data-focus-region="<id>"`.
 * `focus` puts the keyboard in the region (an xterm pane focuses its terminal, a
 * non-xterm pane its root or body). `close` is the pane's OWN close handler, so a
 * dirty Markdown or Diagram pane keeps its discard guard; the main terminal has
 * none (`pane.close` leaves it alone).
 */
export interface FocusRegion {
  id: string
  el: HTMLElement
  focus: () => void
  close?: () => void
}

/** Plain map: the registry is read on a key press, never rendered. */
const regions = new Map<string, FocusRegion>()

/**
 * Register a region. Returns a disposer that removes THIS registration only, so a
 * pane remounted under the same id before the old instance unmounted keeps the
 * newer one.
 */
export function registerFocusRegion(region: FocusRegion): () => void {
  regions.set(region.id, region)
  return () => {
    if (regions.get(region.id) === region) regions.delete(region.id)
  }
}

/**
 * The registered region holding `active` (default `document.activeElement`), or
 * `null` — focus in the sidebar, the Topbar, a takeover body or `<body>`.
 */
export function focusedRegionId(
  active: Element | null = typeof document === 'undefined' ? null : document.activeElement
): string | null {
  const root = active?.closest('[data-focus-region]')
  const id = root?.getAttribute('data-focus-region')
  if (!id) return null
  return regions.get(id)?.el === root ? id : null
}

/** Focus region `id`. False when no such region is registered. */
export function focusRegion(id: string): boolean {
  const r = regions.get(id)
  if (!r) return false
  r.focus()
  return true
}

/** Run region `id`'s own close. False when it is unknown or has no close path. */
export function closeRegion(id: string): boolean {
  const r = regions.get(id)
  if (!r?.close) return false
  r.close()
  return true
}

/**
 * Register the calling component as a focus region for its lifetime: on mount,
 * once `el` is bound, and off again before unmount. The component also binds
 * `:data-focus-region` on that root.
 */
export function useFocusRegion(
  id: string,
  el: Readonly<Ref<HTMLElement | null>>,
  handlers: { focus: () => void; close?: () => void }
): void {
  let dispose: (() => void) | null = null
  onMounted(() => {
    if (!el.value) return
    dispose = registerFocusRegion({ id, el: el.value, ...handlers })
  })
  onBeforeUnmount(() => {
    dispose?.()
    dispose = null
  })
}

/** Test-only: forget every registered region. */
export function resetFocusRegionsForTests(): void {
  regions.clear()
}
