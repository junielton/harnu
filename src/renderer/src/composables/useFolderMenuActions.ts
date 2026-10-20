import { useI18n } from 'vue-i18n'
import { useUiStore } from '../stores/ui'
import { useSessionsStore, type Folder } from '../stores/sessions'
import { useHelpersStore } from '../stores/helpers'
import { isFolderGroup, type FolderGroup, type GroupSource } from '../stores/folder-zones'

/**
 * The Folder menu's and the repo-group menu's actions, shared by `FolderMenu.vue`,
 * `RepoGroupHeader.vue`, `SidebarDrillView.vue` (its group menu) and the keyboard
 * bindings in `App.vue` (T486 §3.4, AC-37): a menu item and its keybinding run
 * the same function, never a copy. Folder actions take the target folder's path,
 * group actions the target group.
 *
 * The menus target the row they were opened on; the bindings target the ACTIVE
 * folder (`activeFor`), except Rename folder, which follows the sidebar's
 * keyboard cursor first, and the group actions, which take the cursor's group
 * row else the group holding the active folder (§3.10).
 */

export type FolderAction =
  | 'rename'
  | 'newFolderTerminal'
  | 'toggleBranchAlias'
  | 'bootOptions'
  | 'projectMemory'
  | 'memoryLocation'
  | 'newSubfolder'
  | 'openSubfolder'
  | 'newWorktree'
  | 'worktreeMd'
  | 'askAgentWorktreeMd'
  | 'toggleIntercept'
  | 'toggleAutoOrganize'
  | 'toggleOrchestratorDefault'
  | 'toggleHidden'
  | 'removeWorktree'
  | 'toggleOlder'
  | 'toggleArchived'

export type RepoGroupAction = 'rename' | 'resetName' | 'cleanup'

export interface FolderActionContext {
  /** In a git repo (`repoId` set, or the probe resolved a branch). */
  gitFolder: boolean
  /** A linked worktree: in a repo, but not the repo's main checkout. */
  linkedWorktree: boolean
  olderCount: number
  archivedCount: number
}

/**
 * The Folder menu's visibility rule for one action — the single place it is
 * written. New worktree and the WORKTREE.md pair only make sense in a git repo;
 * Remove worktree only on a linked worktree (never the main checkout); a linked
 * worktree inherits auto-organize from its main checkout, so it never offers
 * it. The older / archived peeks show only when there is something to reveal.
 */
export function folderActionVisible(action: FolderAction, ctx: FolderActionContext): boolean {
  switch (action) {
    case 'newWorktree':
    case 'worktreeMd':
    case 'askAgentWorktreeMd':
      return ctx.gitFolder
    case 'removeWorktree':
      return ctx.linkedWorktree
    case 'toggleAutoOrganize':
      return !ctx.linkedWorktree
    case 'toggleOlder':
      return ctx.olderCount > 0
    case 'toggleArchived':
      return ctx.archivedCount > 0
    default:
      return true
  }
}

/**
 * The group menu's visibility rule: Reset name only when the group has an
 * alias; Clean up only for a REPO group (a path group is an arbitrary set of
 * sibling directories with no shared git history to sweep).
 */
export function repoGroupActionVisible(
  action: RepoGroupAction,
  ctx: { hasAlias: boolean; source: GroupSource }
): boolean {
  if (action === 'resetName') return ctx.hasAlias
  if (action === 'cleanup') return ctx.source === 'repo'
  return true
}

export interface FolderMenuActions {
  /** Every Folder-menu action, keyed by name; each takes the folder's path. */
  run: Record<FolderAction, (folderPath: string) => void>
  /** Every group-menu action, keyed by name; each takes the group. */
  group: Record<RepoGroupAction, (group: FolderGroup<Folder>) => void>
  /** Whether the Folder menu would show `action` for this folder. */
  visible: (action: FolderAction, folderPath: string) => boolean
  isGitFolder: (folderPath: string) => boolean
  isLinkedWorktree: (folderPath: string) => boolean
  /** Whether the group menu would show `action` for this group. */
  groupVisible: (action: RepoGroupAction, group: FolderGroup<Folder>) => boolean
  /** The active folder when `action` applies to it, else `null`. */
  activeFor: (action: FolderAction) => string | null
  /** `folder.rename`'s target: the cursor's folder row, else the active folder. */
  renameTarget: () => string | null
  /** A group binding's target when `action` applies to it, else `null`. */
  groupFor: (action: RepoGroupAction) => FolderGroup<Folder> | null
}

export function useFolderMenuActions(): FolderMenuActions {
  const ui = useUiStore()
  const sessions = useSessionsStore()
  const helpers = useHelpersStore()
  const { t } = useI18n()

  function isGitFolder(folderPath: string): boolean {
    const f = sessions.findFolderByPath(folderPath)
    if (!f) return false
    const hasRepoId = typeof f.repoId === 'string' && f.repoId.length > 0
    const hasBranch = typeof f.gitBranch === 'string' && f.gitBranch.length > 0
    return hasRepoId || hasBranch
  }

  function isLinkedWorktree(folderPath: string): boolean {
    const f = sessions.findFolderByPath(folderPath)
    return !!f && typeof f.repoId === 'string' && f.repoId.length > 0 && f.isMainWorktree !== true
  }

  function visible(action: FolderAction, folderPath: string): boolean {
    const f = sessions.findFolderByPath(folderPath)
    if (!f) return false
    return folderActionVisible(action, {
      gitFolder: isGitFolder(folderPath),
      linkedWorktree: isLinkedWorktree(folderPath),
      olderCount: action === 'toggleOlder' ? sessions.olderSessionCount(f) : 0,
      archivedCount: action === 'toggleArchived' ? sessions.archivedSessionCount(f) : 0
    })
  }

  /**
   * Open the folder's project memory (T79 S3) as a Memory pane in the split. It
   * attaches to the currently-selected worktree's stack (so it shows in the
   * visible split immediately) when one is selected; otherwise it attaches to
   * the target folder's own stack and appears the next time a session there is
   * opened. The folder is what the pane resolves memory for — the repo's shared
   * `.harnu/memory/`.
   */
  function projectMemory(folderPath: string): void {
    const worktree = sessions.selectedSession?.projectPath || folderPath
    helpers.addMemoryHelper(worktree, folderPath)
  }

  /**
   * Create-or-open the repo's WORKTREE.md (T87) and open it in the markdown
   * pane. The create IPC is idempotent (an existing manifest is opened, never
   * overwritten). A freshly-written proposal opens in EDIT mode for review; a
   * pre-existing manifest opens in view.
   */
  async function worktreeMd(folderPath: string): Promise<void> {
    const worktree = sessions.selectedSession?.projectPath || folderPath
    try {
      const res = await window.api.worktreeMdCreate(folderPath)
      if (!res.ok || !res.path) {
        ui.pushToast({
          kind: 'danger',
          title: t('folderMenu.worktreeMdFailed'),
          description: res.error ?? ''
        })
        return
      }
      helpers.addMarkdownHelper(
        worktree,
        res.path,
        worktree,
        res.created ? { initialMode: 'edit' } : undefined
      )
    } catch (e) {
      ui.pushToast({
        kind: 'danger',
        title: t('folderMenu.worktreeMdFailed'),
        description: e instanceof Error ? e.message : String(e)
      })
    }
  }

  /**
   * Dispatch a session in the folder whose boot prompt asks an agent to study
   * the repo and PROPOSE a WORKTREE.md (T87 option C). Reuses the T80
   * card-dispatch engine; the human still reviews and commits.
   */
  function askAgentWorktreeMd(folderPath: string): void {
    sessions.dispatchCardSession(folderPath, t('folderMenu.worktreeMdAgentPrompt'))
  }

  /**
   * Flip a per-folder flag through its store setter. Non-destructive: a failed
   * IPC round-trip just leaves the mirror unflipped, so there is nothing to undo.
   */
  async function flip(set: () => Promise<unknown>): Promise<void> {
    try {
      await set()
    } catch {
      /* Swallow: the mirror simply won't flip. */
    }
  }

  /** Hide (dismiss) a visible folder or bring a hidden one back; failures toast. */
  async function toggleHidden(folderPath: string): Promise<void> {
    const hidden = sessions.manuallyHiddenPaths.has(folderPath)
    try {
      if (hidden) await sessions.unhideFolder(folderPath)
      else await sessions.dismissFolder(folderPath)
    } catch (e) {
      ui.pushToast({
        kind: 'danger',
        title: t(hidden ? 'folderMenu.unhideFailed' : 'folderMenu.hideFailed'),
        description: e instanceof Error ? e.message : String(e)
      })
    }
  }

  /**
   * The folder row's older / archived peek. A collapsed folder expands first
   * (revealing inside a closed folder would be invisible); the toggle then
   * reveals. Collapsing clears the peek (store `forgetPeeks`), so a collapsed
   * folder is always un-revealed and the toggle stays unambiguous.
   */
  function peek(folderPath: string, kind: 'older' | 'archived'): void {
    const folder = sessions.findFolderByPath(folderPath)
    if (folder && !folder.expanded) sessions.toggleFolder(folderPath)
    if (kind === 'older') sessions.toggleRevealOlder(folderPath)
    else sessions.toggleRevealArchived(folderPath)
  }

  const run: Record<FolderAction, (folderPath: string) => void> = {
    rename: (p) => ui.openRenameFolder(p),
    newFolderTerminal: (p) => void sessions.createFolderTerminal(p),
    toggleBranchAlias: (p) =>
      void flip(() => sessions.setFolderAliasFromBranch(p, !sessions.aliasFromBranchPaths.has(p))),
    bootOptions: (p) => ui.openClaudeBoot(p),
    projectMemory,
    memoryLocation: (p) => ui.openMemoryLocation(p),
    newSubfolder: (p) => ui.openNewFolder(p),
    openSubfolder: (p) => ui.openOpenSubfolder(p),
    newWorktree: (p) => ui.openNewWorktree(p),
    worktreeMd: (p) => void worktreeMd(p),
    askAgentWorktreeMd,
    toggleIntercept: (p) =>
      void flip(() => sessions.setFolderInterceptActive(p, !sessions.interceptFolders.has(p))),
    toggleAutoOrganize: (p) =>
      void flip(() => sessions.setFolderAutoOrganize(p, !sessions.isFolderAutoOrganizeOn(p))),
    toggleOrchestratorDefault: (p) =>
      void flip(() =>
        sessions.setFolderOrchestratorDefault(p, !sessions.orchestratorDefaultPaths.has(p))
      ),
    toggleHidden: (p) => void toggleHidden(p),
    removeWorktree: (p) => ui.openRemoveWorktree(p, sessions.findFolderByPath(p)?.gitBranch ?? ''),
    toggleOlder: (p) => peek(p, 'older'),
    toggleArchived: (p) => peek(p, 'archived')
  }

  /**
   * Open the Cleanup takeover scrolled to the group's repo. The Reaper snapshot
   * groups by main-worktree folder path, not by the group's own key, so the
   * scroll target is that folder's path.
   */
  function cleanup(group: FolderGroup<Folder>): void {
    const mainPath = group.folders.find((f) => f.isMainWorktree)?.path ?? group.folders[0]?.path
    if (mainPath) ui.openCleanup(mainPath)
  }

  const group: Record<RepoGroupAction, (group: FolderGroup<Folder>) => void> = {
    rename: (g) => ui.openRenameRepo(g.key, g.derivedLabel),
    resetName: (g) => sessions.setGroupAlias(g.key, ''),
    cleanup
  }

  function groupVisible(action: RepoGroupAction, g: FolderGroup<Folder>): boolean {
    return repoGroupActionVisible(action, {
      hasAlias: !!sessions.groupAliases[g.key],
      source: g.source
    })
  }

  /** The keyboard cursor's row, or `null` — the cursor is inert in drill mode. */
  function cursorRow(): { kind: 'folder' | 'group' | 'session'; id: string } | null {
    return sessions.drillModeEnabled ? null : sessions.keyboardCursor
  }

  function activeFor(action: FolderAction): string | null {
    const path = sessions.activeFolderPath
    return path && visible(action, path) ? path : null
  }

  /**
   * F2's target (§3.10): the cursor's folder row, else the active folder. A
   * session or group cursor row is a no-op — a session renames with `Cmd+R`, a
   * group with `repoGroup.rename`.
   */
  function renameTarget(): string | null {
    const c = cursorRow()
    if (c) return c.kind === 'folder' && sessions.findFolderByPath(c.id) ? c.id : null
    return activeFor('rename')
  }

  /** The rendering group that holds `folderPath`, if any. */
  function groupOfFolder(folderPath: string): FolderGroup<Folder> | null {
    for (const node of sessions.visibleFolders) {
      if (isFolderGroup(node) && node.folders.some((f) => f.path === folderPath)) return node
    }
    return null
  }

  function groupFor(action: RepoGroupAction): FolderGroup<Folder> | null {
    const c = cursorRow()
    const active = sessions.activeFolderPath
    const g =
      c?.kind === 'group' ? sessions.groupInVisible(c.id) : active ? groupOfFolder(active) : null
    return g && groupVisible(action, g) ? g : null
  }

  return {
    run,
    group,
    visible,
    isGitFolder,
    isLinkedWorktree,
    groupVisible,
    activeFor,
    renameTarget,
    groupFor
  }
}
