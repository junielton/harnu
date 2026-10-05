import { useUiStore } from '../stores/ui'

/**
 * Approximate menu size used for edge-clamping at open time. The real DOM
 * dimensions are measured by `SessionMenu.vue` after mount (see `clamped`
 * computed there) — these constants only ensure the menu doesn't open with
 * its initial coords already off-screen on the very first paint.
 *
 * If you change `min-width` / row count in `SessionMenu.vue`, bump these.
 */
const APPROX_MENU_WIDTH = 220
const APPROX_MENU_HEIGHT = 220
const VIEWPORT_MARGIN = 8

/**
 * Composable that wires a `contextmenu` event (or any equivalent trigger)
 * into the `ui` store's `menu` slice. Performs first-paint edge-clamping so
 * the menu does not open beyond the viewport; the menu component itself
 * re-clamps with the true measured size after mount.
 *
 * Used by `SidebarFolder.vue` rows and (later) any other surface that needs
 * a right-click menu on a session.
 */
export function useContextMenu(): {
  open: (e: MouseEvent, sessionId: string) => void
  close: () => void
} {
  const ui = useUiStore()

  function open(e: MouseEvent, sessionId: string): void {
    e.preventDefault()

    const vw = window.innerWidth
    const vh = window.innerHeight

    // Clamp horizontally: if the cursor sits within `APPROX_MENU_WIDTH` of the
    // right edge, anchor the menu to the LEFT of the cursor instead of the
    // RIGHT. Same idea for the bottom edge.
    let x = e.clientX
    let y = e.clientY

    if (x + APPROX_MENU_WIDTH > vw - VIEWPORT_MARGIN) {
      x = Math.max(VIEWPORT_MARGIN, x - APPROX_MENU_WIDTH)
    }
    if (y + APPROX_MENU_HEIGHT > vh - VIEWPORT_MARGIN) {
      y = Math.max(VIEWPORT_MARGIN, y - APPROX_MENU_HEIGHT)
    }

    ui.openMenu({ sessionId, x, y })
  }

  function close(): void {
    ui.closeMenu()
  }

  return { open, close }
}
