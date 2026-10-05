import { onBeforeUnmount } from 'vue'
import { useUiStore } from '../stores/ui'

/**
 * Delay (in ms) between `mouseenter` on a session/folder row and the preview
 * opening. Matches the spec in `design.md §3.9`.
 *
 * The delay is what keeps the preview from flickering on a casual mouse-cross:
 * if the cursor leaves the row before this window elapses, we never bother the
 * ui store at all.
 */
const HOVER_DELAY_MS = 400

/**
 * Grace period (in ms) before an OPEN preview closes after the mouse leaves both
 * the trigger row AND the card (T86, `design.md §3.9`). The card is now
 * interactive (`pointer-events: auto`), so the cursor must be able to travel the
 * ~8px gap from the row into the card without the preview closing under it. The
 * close is scheduled, not immediate — the card's `cancelClose` (fired on its
 * `mouseenter`) wins the race. This grace delay, NOT `pointer-events: none`, is
 * what actually kills the old flicker loop.
 */
const CLOSE_GRACE_MS = 200

/**
 * Module-level grace-close timer, SHARED across every `useHoverPreview` instance
 * — the trigger rows (`SidebarFolder`, `FleetBoardCard`) AND the card components
 * (`SessionPreview`, `FolderPreview`). Row and card are distinct components with
 * distinct composable instances, so "row + card = one hover zone" can only be
 * coordinated through shared state: a close armed when the mouse leaves the row is
 * cancelled by the card's `cancelClose` when the mouse arrives on it, and vice
 * versa. `null` when no close is pending.
 */
let closeTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Composable that wires a hover-with-delay-and-grace state machine into the `ui`
 * store's `preview` slice. Two roles share it:
 *
 * - **Trigger rows** (`SidebarFolder`, `FleetBoardCard`) call `enter`/`enterFolder`
 *   on `mouseenter` (arms the open) and `leave` on `mouseleave` (arms the grace-
 *   close).
 * - **Card components** (`SessionPreview`, `FolderPreview`) call `cancelClose` on
 *   their own `mouseenter` (the mouse is still inside the hover zone → keep open)
 *   and `scheduleClose` on `mouseleave` (left the card → close after the grace).
 *
 * Lifecycle:
 * - `enter(sessionId, rect)` / `enterFolder(folderPath, rect)` cancel any pending
 *   close, then arm a `setTimeout` that calls `ui.openPreview` after `HOVER_DELAY_MS`.
 * - `leave()` cancels the pending open (if the cursor left before it fired) and
 *   arms the grace-close.
 * - `cancelClose()` / `scheduleClose()` manage the shared module-level close timer.
 * - On `onBeforeUnmount` we clear the instance's open timer so an unmounted
 *   component cannot fire `openPreview` against a stale store reference.
 *
 * The store applies the mutex with dialog/menu, so we don't have to gate here.
 */
export function useHoverPreview(): {
  enter: (sessionId: string, rect: DOMRect) => void
  enterFolder: (folderPath: string, rect: DOMRect) => void
  leave: () => void
  cancelClose: () => void
  scheduleClose: () => void
} {
  const ui = useUiStore()
  let openTimer: ReturnType<typeof setTimeout> | null = null

  function rectOf(rect: DOMRect): { top: number; left: number; right: number; bottom: number } {
    return { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom }
  }

  function clearOpen(): void {
    if (openTimer) {
      clearTimeout(openTimer)
      openTimer = null
    }
  }

  /** Cancel a pending grace-close — the mouse is (still) inside the hover zone. */
  function cancelClose(): void {
    if (closeTimer) {
      clearTimeout(closeTimer)
      closeTimer = null
    }
  }

  /** Arm the grace-close — the mouse left the row/card; close unless it returns. */
  function scheduleClose(): void {
    if (closeTimer) clearTimeout(closeTimer)
    closeTimer = setTimeout(() => {
      closeTimer = null
      ui.closePreview()
    }, CLOSE_GRACE_MS)
  }

  function enter(sessionId: string, rect: DOMRect): void {
    cancelClose()
    clearOpen()
    openTimer = setTimeout(() => {
      ui.openPreview({ sessionId, rect: rectOf(rect) })
      openTimer = null
    }, HOVER_DELAY_MS)
  }

  /** Folder-row twin of {@link enter} (T52) — opens the folder hover card. */
  function enterFolder(folderPath: string, rect: DOMRect): void {
    cancelClose()
    clearOpen()
    openTimer = setTimeout(() => {
      ui.openFolderPreview({ folderPath, rect: rectOf(rect) })
      openTimer = null
    }, HOVER_DELAY_MS)
  }

  function leave(): void {
    clearOpen()
    scheduleClose()
  }

  onBeforeUnmount(() => {
    clearOpen()
  })

  return { enter, enterFolder, leave, cancelClose, scheduleClose }
}
