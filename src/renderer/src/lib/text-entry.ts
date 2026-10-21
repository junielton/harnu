/**
 * Text-entry focus checks for keyboard shortcuts (T486 §9.1).
 *
 * A binding's `keysGuard` uses these so a key press made in a text field stays
 * with that field: `Cmd+Enter` in a textarea, an arrow key in an input, `F2` in a
 * contenteditable. They read `document.activeElement` at dispatch time.
 */

/**
 * True when focus is in an input, textarea, select or contenteditable. The xterm
 * hidden input is a `<textarea class="xterm-helper-textarea">` — explicitly NOT
 * text entry, so terminal key handling (xterm + `lib/terminalKeymap`) is
 * unchanged. Catches the Topbar inline-rename contenteditable, which pushes no
 * shortcut scope.
 */
export function isTextEntryTarget(): boolean {
  const el = document.activeElement as HTMLElement | null
  if (!el) return false
  if (el.isContentEditable) return true
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    if (el.closest('.xterm')) return false
    return true
  }
  return false
}

/** The standard `keysGuard`: the key press did not come from a text field. */
export function notInTextEntry(): boolean {
  return !isTextEntryTarget()
}

/** True when focus is inside an element matching `selector`. */
export function focusWithin(selector: string): boolean {
  const el = document.activeElement
  return !!el && !!el.closest(selector)
}
