import { computed, nextTick, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSessionsStore } from '../stores/sessions'
import { useUiStore } from '../stores/ui'
import { useLayoutStore } from '../stores/layout'

/**
 * The sidebar header's actions, shared by its buttons (`Sidebar.vue`) and the
 * keyboard bindings in `App.vue` (T486 §3.3, AC-37): each binding runs the same
 * function its button runs.
 */

/** Drives the rescan icon's spin while a scan is in flight (design.md §7). */
const rescanning = ref(false)

export function useSidebarActions() {
  const sessions = useSessionsStore()
  const ui = useUiStore()
  const layout = useLayoutStore()
  const { t } = useI18n()

  const anyExpanded = computed<boolean>(() => sessions.folders.some((f) => f.expanded === true))

  /**
   * Rescan folders (BUG-55 AC6) — the manual refresh, the escape hatch for any
   * watcher gap. A failure toasts its message.
   */
  async function rescan(): Promise<void> {
    rescanning.value = true
    try {
      await sessions.rescan()
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      ui.pushToast({ kind: 'danger', title: t('sidebar.menu.rescanFailed'), description: message })
    } finally {
      rescanning.value = false
    }
  }

  function toggleCollapseAll(): void {
    if (anyExpanded.value) sessions.collapseAll()
    else sessions.expandAll()
  }

  /**
   * Open or close the jump palette (T288). The palette mounts inside the
   * sidebar, so opening it expands a collapsed sidebar first; closing it never
   * collapses the sidebar again (T486 §3.3).
   */
  function toggleJump(): void {
    if (ui.sidebarJumpPalette.open) {
      ui.closeSidebarJumpPalette()
      return
    }
    if (layout.sidebarCollapsed) layout.setSidebarCollapsed(false)
    ui.openSidebarJumpPalette()
  }

  /**
   * Open or close the Hidden popover, anchored under the header's Hidden button.
   * A collapsed sidebar is expanded first so the button has a rect to anchor to.
   */
  async function toggleHiddenFolders(): Promise<void> {
    if (ui.sidebarHiddenPopover.open) {
      ui.closeSidebarHiddenPopover()
      return
    }
    if (layout.sidebarCollapsed) {
      layout.setSidebarCollapsed(false)
      await nextTick()
    }
    const btn = document.querySelector('[data-sidebar-hidden-trigger]')
    if (!btn) return
    const rect = btn.getBoundingClientRect()
    ui.openSidebarHiddenPopover({
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom
    })
  }

  return { rescanning, anyExpanded, rescan, toggleCollapseAll, toggleJump, toggleHiddenFolders }
}
