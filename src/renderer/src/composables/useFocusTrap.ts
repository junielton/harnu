import { nextTick, onBeforeUnmount, watch, type Ref } from 'vue'

/**
 * Tiny keyboard focus-trap for modal surfaces — design.md §5.5
 * (Acessibilidade — modal focus-trap pattern).
 *
 * Activated when `active` flips to `true`: focuses the first focusable
 * element inside `containerRef.value` and binds a `Tab` / `Shift+Tab`
 * listener that wraps around the focusable set. On deactivation it
 * removes the listener and restores focus to whichever element owned it
 * before activation (typically the trigger button that opened the modal).
 *
 * Esc handling lives in the modal components themselves (they need to
 * call their own close action, which we don't know about here). Likewise
 * the modal owns its overlay `mousedown` close; this composable is
 * specifically for keyboard reachability inside the trapped surface.
 *
 * The focusable-element query mirrors the spec's "naturally tabbable"
 * set: any element with `tabindex`, anchors with `href`, buttons,
 * inputs/textareas/selects/`contenteditable`, plus `[role="menuitem"]`
 * which xterm.js and our SessionMenu set explicitly. Elements with
 * `disabled` or `tabindex="-1"` are skipped (the latter is how
 * SessionMenu marks programmatically-focusable items that should NOT
 * receive Tab focus).
 *
 * We rebuild the focusable list on every keydown rather than cache it.
 * Modals like AddFolderDialog grow/shrink (the Submit button
 * enables/disables as the form fills in) — caching would miss those
 * elements. The query is cheap relative to the keypress cadence.
 */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
  '[role="menuitem"]:not([disabled])'
].join(',')

interface UseFocusTrapOptions {
  /**
   * Reactive flag — flip to `true` to activate the trap, `false` to
   * release it. Most callers pass a `computed(() => ui.dialog === 'foo')`
   * or a plain `ref(open)`.
   */
  active: Ref<boolean>
  /**
   * Ref to the modal's root element. Becomes non-null after the
   * v-if-rendered container is mounted; the composable waits on
   * `nextTick` before focusing so it doesn't race the Teleport mount.
   */
  containerRef: Ref<HTMLElement | null>
  /**
   * Optional ref to the element to focus first. Defaults to the first
   * focusable descendant of `containerRef`. Pass this for modals where
   * a specific field (search input, alias text box) should own the
   * caret immediately on open. Accepts any HTMLElement subtype — the
   * `extends HTMLElement` upper bound keeps `HTMLInputElement` etc.
   * directly assignable without a cast at the call site.
   */
  initialFocusRef?: Ref<HTMLElement | null> | Ref<HTMLInputElement | null>
}

export function useFocusTrap(options: UseFocusTrapOptions): void {
  const { active, containerRef, initialFocusRef } = options

  /** Element that owned focus when the trap activated — restored on release. */
  let previouslyFocused: HTMLElement | null = null

  function focusableElements(): HTMLElement[] {
    const root = containerRef.value
    if (!root) return []
    return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((el) => {
      // Skip hidden elements — the selector matches even when CSS
      // hides them, but Tab order shouldn't include offscreen items.
      if (el.offsetParent === null && el.tagName !== 'DIALOG') {
        // `offsetParent` is null for `position: fixed` elements too,
        // but the trap's root IS position: fixed in our usage. Fall
        // back to a getClientRects check for that case.
        return el.getClientRects().length > 0
      }
      return true
    })
  }

  function onKeydown(e: KeyboardEvent): void {
    if (!active.value) return
    if (e.key !== 'Tab') return

    const items = focusableElements()
    if (items.length === 0) {
      // No focusable children — swallow Tab so focus can't escape.
      e.preventDefault()
      return
    }

    const first = items[0]
    const last = items[items.length - 1]
    const current = document.activeElement as HTMLElement | null

    if (e.shiftKey) {
      // Shift+Tab from the first element wraps to the last.
      if (current === first || !containerRef.value?.contains(current)) {
        e.preventDefault()
        last.focus()
      }
    } else {
      // Tab from the last element wraps to the first.
      if (current === last || !containerRef.value?.contains(current)) {
        e.preventDefault()
        first.focus()
      }
    }
  }

  watch(
    active,
    async (open) => {
      if (open) {
        previouslyFocused = (document.activeElement as HTMLElement) ?? null
        // Use capture so we beat any inner Tab handlers (e.g. CodeMirror
        // inside future inputs). Same pattern as the modal's own Esc
        // listener, which also uses capture.
        window.addEventListener('keydown', onKeydown, true)
        await nextTick()
        const target = initialFocusRef?.value ?? focusableElements()[0] ?? containerRef.value
        target?.focus?.()
      } else {
        window.removeEventListener('keydown', onKeydown, true)
        previouslyFocused?.focus?.()
        previouslyFocused = null
      }
    },
    { immediate: true }
  )

  onBeforeUnmount(() => {
    window.removeEventListener('keydown', onKeydown, true)
  })
}
