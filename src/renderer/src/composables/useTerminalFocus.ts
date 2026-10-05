import { computed, ref, type ComputedRef } from 'vue'

/**
 * Pane id used by `TerminalPane.vue` (the main Claude session terminal).
 * Helper panes use their own unique ids; this constant prevents typo bugs
 * across the three `register/unregisterFocusedPane(MAIN_PANE_ID)` callsites.
 */
export const MAIN_PANE_ID = 'main'

/**
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
