/**
 * `view.closeTakeover` — Esc closes the open main-pane takeover (T486 §6.1).
 *
 * `App.vue` spreads `closeTakeoverBinding(ui)` into its registration, and the
 * tests drive the same functions, so there is one copy of the rule.
 *
 * What wins Esc before this binding does is NOT decided here: dialogs, the
 * palettes and the context menus take it in the window capture phase and stop
 * it; Cleanup and the Diagram pane do the same for their own selection, on
 * `document` so those window-capture surfaces still win over them; the PR
 * Stack filter and the Roadmap dispatch confirm stop it on their element. The
 * footer / Topbar popovers close on a bubble listener that runs AFTER this
 * binding (Chromium runs a microtask checkpoint after each listener), so the
 * binding steps aside while `ui.anyPopoverOpen` is true.
 */
import { isTextEntryTarget, notInTextEntry } from './text-entry'
import type { useUiStore } from '../stores/ui'

/** Whether the last key press started in a text field. */
let lastKeyInTextEntry = false

function recordKeyOrigin(): void {
  // Window capture: no field has reacted yet, so the focus is where the key was pressed.
  lastKeyInTextEntry = isTextEntryTarget()
}

/**
 * Records where each key press starts, in the window capture phase. Install it
 * before any other keydown listener (from `App.vue`'s setup). Returns the remover.
 */
export function installKeyOrigin(): () => void {
  window.addEventListener('keydown', recordKeyOrigin, true)
  return () => window.removeEventListener('keydown', recordKeyOrigin, true)
}

/**
 * The binding's key guard: the press neither started in a text field nor lands
 * while one has focus. Reading focus alone is not enough: the Topbar title
 * rename blurs itself on Esc, so by the time the binding runs focus is back on
 * `body` and the takeover would close under the user's cancelled edit.
 */
export function keyNotFromTextEntry(): boolean {
  return notInTextEntry() && !lastKeyInTextEntry
}

type UiStore = ReturnType<typeof useUiStore>

/** `enabled`, `keysGuard` and `handler` of the `view.closeTakeover` registration. */
export function closeTakeoverBinding(ui: UiStore): {
  enabled: () => boolean
  keysGuard: () => boolean
  handler: () => void
} {
  return {
    enabled: () => ui.activeView !== null && !ui.anyPopoverOpen,
    keysGuard: keyNotFromTextEntry,
    // The X's own door (`TakeoverHost` → `closeAllTakeovers`), so the Review
    // takeover's `onClose` still disposes its companion pane.
    handler: () => ui.closeAllTakeovers()
  }
}
