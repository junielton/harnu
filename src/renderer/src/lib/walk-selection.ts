/**
 * Guided walks: selecting and copying the pane's text (design.md §6 "Guided test walk" → Selecting text, BUG-292).
 *
 * The app chrome is not selectable (`body { user-select: none }`), but a walk is mostly instructions the operator
 * copies and runs elsewhere, so the pane's CONTENT opts back in (`select-text` on `.wk-body`, the way
 * `MarkdownPane` does) while its buttons, chips and `kbd` hints stay non-selectable. Two things follow from a
 * selectable pane, and both live here, DOM-light and tested:
 *
 *  - `paneHasSelection`: the key map turns every bare letter into an outcome, so it must know when a selection is
 *    held (a letter typed over selected text is not "Failed"). A selection inside a field is the field's own.
 *  - `createClickGuard`: a drag that starts on plain text and is released over a link, a copy button or Done must
 *    not press it. Browsers fire the click on the common ancestor of press and release, which is usually the
 *    container and not the control, but the guard states the rule instead of leaning on that (and on the engines
 *    where the release target does get the click). A drag that STARTS on a link or chip stays non-selectable: the
 *    pane keeps the press from moving focus (`keepPaneFocusOnPointer`), and the chip has its own copy button.
 */

const CONTROL_SELECTOR =
  'button, [role="button"], [role="option"], a[href], [data-walk-chip], [data-walk-link]'

interface ClosestLike {
  closest?(selector: string): unknown
}

const controlOf = (node: unknown): unknown =>
  node && typeof (node as ClosestLike).closest === 'function'
    ? ((node as ClosestLike).closest!(CONTROL_SELECTOR) ?? null)
    : null

/** `true` while `root` holds a non-empty text selection that is not inside one of its fields. */
export function paneHasSelection(root: HTMLElement | null): boolean {
  if (!root) return false
  const doc = root.ownerDocument
  const sel = doc.getSelection()
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return false
  const active = doc.activeElement as HTMLElement | null
  if (
    active &&
    root.contains(active) &&
    (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)
  )
    return false
  if (!root.contains(sel.anchorNode) && !root.contains(sel.focusNode)) return false
  return sel.toString().trim().length > 0
}

export interface ClickGuard {
  /** A pointer press inside the pane: remembers the control it began on, or `null` for plain text. */
  press(target: EventTarget | null): void
  /** `true` when this click is the end of a drag that began elsewhere, so it must not act. */
  shouldSwallow(ev: { target: EventTarget | null; detail: number }): boolean
}

export function createClickGuard(): ClickGuard {
  let pressed: { control: unknown } | null = null
  return {
    press(target) {
      pressed = { control: controlOf(target) }
    },
    shouldSwallow(ev) {
      const origin = pressed
      pressed = null
      // no press (a keyboard click has `detail` 0, a script click none): nothing was dragged
      if (!origin || ev.detail === 0) return false
      const control = controlOf(ev.target)
      return control !== null && control !== origin.control
    }
  }
}
