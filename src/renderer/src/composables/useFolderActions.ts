import { useI18n } from 'vue-i18n'
import { useSessionsStore } from '../stores/sessions'
import { useUiStore } from '../stores/ui'
import { useHelpersStore } from '../stores/helpers'
import { useBrowserStore } from '../stores/browser'

/**
 * The Topbar's per-folder actions, shared by the Topbar buttons and their
 * keyboard shortcuts (`App.vue`'s `useShortcuts`, T1). Every action targets
 * `sessions.activeFolderPath` — the selected session's folder, or the selected
 * folder itself (T212) — and is a no-op when nothing is selected.
 */
export interface FolderActions {
  folderLabel: (path: string) => string
  toggleRoadmap: () => void
  togglePrStack: () => void
  openInFileManager: () => void
  openInVSCode: () => Promise<void>
  openGithubPulls: () => Promise<void>
  browseFiles: () => void
  newTerminal: () => void
  /** T564 U1: open an operator browser pane in the active folder's split stack. */
  newBrowser: () => Promise<void>
}

export function useFolderActions(): FolderActions {
  const sessions = useSessionsStore()
  const ui = useUiStore()
  const helpers = useHelpersStore()
  const { t } = useI18n()

  /**
   * The label the per-repo takeovers carry in their header — the folder's alias
   * when the operator set one, else its basename. Same resolution `FolderMenu`
   * uses, so every entry point titles the view identically.
   */
  function folderLabel(path: string): string {
    const f = sessions.findFolderByPath(path)
    return f?.alias || path.replace(/\/+$/, '').split('/').pop() || path
  }

  /**
   * "Roadmap board" / "PR Stack" — the per-repo main-pane takeovers, scoped to
   * the active folder (design.md §6 "Topbar per-repo view buttons"). These are
   * TOGGLES (`ui.toggle*`, not `ui.open*`): the gesture that opened the view
   * closes it again. The folder context-menu entries stay `open*` — a menu item
   * must open, never close.
   */
  function toggleRoadmap(): void {
    const wt = sessions.activeFolderPath
    if (!wt) return
    ui.toggleRoadmap(wt, folderLabel(wt))
  }

  function togglePrStack(): void {
    const wt = sessions.activeFolderPath
    if (!wt) return
    ui.togglePrStack(wt, folderLabel(wt))
  }

  /**
   * "Open folder" → reveal the active folder in the OS file manager via the
   * main process (`shell.openPath`). `openPath` resolves with an error string on
   * failure (never throws).
   */
  function openInFileManager(): void {
    const wt = sessions.activeFolderPath
    if (!wt) return
    void window.api.openPath(wt)
  }

  /**
   * "Open in VS Code" → spawn `code <cwd>` in the main process. The IPC
   * resolves `{ ok, error? }` and never rejects; on failure (e.g. `code` isn't
   * resolvable anywhere the main process looks) we surface a toast instead of
   * failing silently.
   */
  async function openInVSCode(): Promise<void> {
    const wt = sessions.activeFolderPath
    if (!wt) return
    const res = await window.api.openInVSCode(wt)
    if (!res.ok) {
      ui.pushToast({
        kind: 'danger',
        title: t('topbar.openInVSCodeFailed'),
        description: res.error ?? ''
      })
    }
  }

  /**
   * "Pull requests on GitHub" → the active folder's `origin` as its github.com
   * `/pulls` page, resolved in main. A no-op when the folder has no GitHub
   * origin — the Topbar hides its button in that case, the shortcut just does
   * nothing.
   */
  async function openGithubPulls(): Promise<void> {
    const wt = sessions.activeFolderPath
    if (!wt) return
    const url = await window.api.githubPullsUrl(wt)
    if (url) void window.api.shellOpenExternal(url)
  }

  /**
   * "Browse files" (Cluster D/E) → open the in-app project file-tree pane in
   * the active folder's split stack, confined to that folder's root. Dedup by
   * root means a repeat focuses the existing pane.
   */
  function browseFiles(): void {
    const wt = sessions.activeFolderPath
    if (!wt) return
    helpers.addExplorerHelper(wt, wt)
  }

  /**
   * "Split" → a fresh shell pane in the active session's split stack, cwd = the
   * active folder. With a folder selected (T212) there is no session split
   * stack to attach to, so `createFolderTerminal` — the folder-level
   * equivalent — runs instead.
   */
  function newTerminal(): void {
    const wt = sessions.activeFolderPath
    if (!wt) return
    if (!sessions.selectedSession) {
      sessions.createFolderTerminal(wt)
      return
    }
    helpers.addShellHelper(wt, wt)
  }

  /**
   * "Split → Browser" (T564 U1, spec §2.2): ask main for an operator-class guest view, then show it in the
   * active folder's stack and put the cursor in its address bar. An operator pane starts at `about:blank`.
   */
  async function newBrowser(): Promise<void> {
    const wt = sessions.activeFolderPath
    if (!wt) return
    const res = await window.api.browserOpen({ folder: wt })
    if (!res.ok) {
      ui.pushToast({ kind: 'danger', title: t('browserPane.openFailed'), description: res.error })
      return
    }
    helpers.addBrowserHelper(wt, {
      paneId: res.paneId,
      name: '',
      url: 'about:blank',
      openedBy: 'operator',
      partition: 'operator',
      ownerSessionId: null
    })
    // The pane mounts on the next tick; its address field takes the focus request when it does.
    useBrowserStore().requestFocusAddress(res.paneId)
  }

  return {
    folderLabel,
    toggleRoadmap,
    togglePrStack,
    openInFileManager,
    openInVSCode,
    openGithubPulls,
    browseFiles,
    newTerminal,
    newBrowser
  }
}
