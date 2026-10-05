import { onBeforeUnmount, ref, type Ref } from 'vue'
import { useSessionsStore } from '../stores/sessions'

/**
 * How long to wait after the last `dragover` before assuming the drag is gone
 * and clearing the affordance. Chromium fires `dragover` continuously while a
 * drag hovers a target (~every 350ms even when the pointer is stationary), so
 * anything comfortably above that is a safe idle threshold.
 */
const DRAG_IDLE_MS = 900

/**
 * Shared drag-and-drop-to-pin behavior for the two surfaces that accept a
 * folder dragged out of the OS file manager: the sidebar (`Sidebar.vue`) and
 * the empty-state hero (`Onboarding.vue`). Both pin every dropped directory
 * via `sessions.pinFolder`; only the overlay's scrim colour differs, which is
 * the consuming component's business, not this composable's.
 *
 * Returns `dragOver` (drives the drop overlay) plus the three handlers to bind
 * on the host element: `@dragover`, `@dragleave`, `@drop`.
 *
 * **Two non-obvious behaviors live here** — both were bugs found in review:
 *
 * 1. `dragleave` bubbles. Every nested row/element the pointer crosses fires
 *    its own `dragleave` that reaches the host, which made the overlay flicker
 *    on and off as you moved the folder across the list. Clearing only when
 *    `relatedTarget` is outside the host fixes it (same fix as `TerminalPane`).
 * 2. Nothing guarantees a closing event. `dragOver` is set by `dragover` and
 *    cleared by `dragleave`/`drop` — but a drag cancelled while the pointer is
 *    still inside the host (Esc, or a drop the OS swallows) may deliver
 *    neither, stranding a full-bleed scrim over the UI until the next drag.
 *    An idle watchdog re-armed on every `dragover` self-heals that, whichever
 *    event went missing.
 */
export function useFolderDrop(): {
  dragOver: Ref<boolean>
  onDragOver: (e: DragEvent) => void
  onDragLeave: (e: DragEvent) => void
  onDrop: (e: DragEvent) => Promise<void>
} {
  const sessions = useSessionsStore()
  const dragOver = ref(false)

  let idleTimer: ReturnType<typeof setTimeout> | undefined

  function clearIdleTimer(): void {
    if (idleTimer === undefined) return
    clearTimeout(idleTimer)
    idleTimer = undefined
  }

  function stopDragging(): void {
    clearIdleTimer()
    dragOver.value = false
  }

  function onDragOver(e: DragEvent): void {
    // Only react to OS file drags, not text/element drags inside the app.
    if (!e.dataTransfer?.types.includes('Files')) return
    e.preventDefault()
    dragOver.value = true
    // Re-arm the watchdog: as long as the drag keeps hovering us, this timer
    // keeps being pushed forward and never fires.
    clearIdleTimer()
    idleTimer = setTimeout(stopDragging, DRAG_IDLE_MS)
  }

  function onDragLeave(e: DragEvent): void {
    // Ignore the `dragleave` that fires when the pointer moves between two
    // descendants of the host — only a real exit clears the affordance.
    const related = e.relatedTarget as Node | null
    const host = e.currentTarget as HTMLElement
    if (related && host.contains(related)) return
    stopDragging()
  }

  async function onDrop(e: DragEvent): Promise<void> {
    e.preventDefault()
    stopDragging()
    const files = e.dataTransfer?.files
    if (!files || files.length === 0) return
    for (const file of Array.from(files)) {
      // `File.path` was removed in Electron 32+; resolve via the preload bridge.
      const p = window.api.getPathForFile(file)
      if (!p) continue
      try {
        await sessions.pinFolder(p)
      } catch {
        /* swallow — a bad drop should not break the host surface */
      }
    }
  }

  onBeforeUnmount(clearIdleTimer)

  return { dragOver, onDragOver, onDragLeave, onDrop }
}
