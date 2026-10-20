import { useI18n } from 'vue-i18n'
import { useUiStore } from '../stores/ui'
import { useSessionsStore, type Session } from '../stores/sessions'
import { useHelpersStore } from '../stores/helpers'
import { useLayoutStore } from '../stores/layout'
import { sessionTitle } from '../lib/session-label'
import { buildContextDigest } from '../lib/context-digest'
import { shouldShowRestart } from '../components/session-menu-core'
import type { TaskState } from '../../../preload'
import { focusWithin, notInTextEntry } from '../lib/text-entry'

/**
 * The Session menu's actions, shared by `SessionMenu.vue` and the keyboard
 * bindings in `App.vue` (T486 §3.2, AC-37): a menu item and its keybinding run
 * the same function, never a copy. Every action takes the target session id.
 *
 * The menu targets the row it was opened on; the bindings target the SELECTED
 * session (`selectedFor`), except `openToSide` and the keyboard context menu,
 * which follow the sidebar's keyboard cursor first (§3.10).
 */

export type SessionAction =
  | 'fork'
  | 'restart'
  | 'openToSide'
  | 'copyId'
  | 'copyTranscriptPath'
  | 'copyResumeCommand'
  | 'copyContextDigest'
  | 'toggleNoFlicker'
  | 'toggleArchived'
  | 'delete'
  | 'retryBoot'
  | 'dismiss'

export interface SessionActionContext {
  synthetic: boolean
  live: boolean
  taskState: TaskState | undefined
  shellTerminal: boolean
}

/**
 * The Session menu's visibility rule for one action — the single place it is
 * written. A synthetic session has no JSONL on disk yet, so the file-backed
 * actions (fork, open to the side, the copies, archive, delete) do not apply;
 * a failed or completed synthetic gets Retry and Dismiss instead (BUG-23/24).
 * Folder terminals have no Session menu at all.
 */
export function sessionActionVisible(action: SessionAction, ctx: SessionActionContext): boolean {
  if (ctx.shellTerminal) return false
  switch (action) {
    case 'toggleNoFlicker':
      return true
    case 'restart':
      return shouldShowRestart({
        isSynthetic: ctx.synthetic,
        isLive: ctx.live,
        taskState: ctx.taskState
      })
    case 'retryBoot':
    case 'dismiss':
      return ctx.synthetic && (ctx.taskState === 'failed' || ctx.taskState === 'completed')
    default:
      return !ctx.synthetic
  }
}

/**
 * `session.fork`'s `keysGuard`: not from a text field, and not inside the
 * Diagram pane, whose own ⌘D / Ctrl+D duplicates the selection on a window
 * listener — a user who binds `Cmd+D` to fork would otherwise get both (§3.10).
 */
export function forkKeysGuard(): boolean {
  return notInTextEntry() && !focusWithin('[data-testid="diagram-pane"]')
}

/**
 * A keyboard-opened context menu makes Chromium synthesize a `contextmenu` event
 * of its own for the same Shift+F10 press, at the focused element (T486 OQ-3).
 * A focused sidebar row would then reopen the menu on ITSELF, which may not be
 * the cursor target. Swallow that one event; one press opens exactly one menu.
 * The window is generous because Windows sends it on key-up.
 */
const SYNTHETIC_CONTEXTMENU_MS = 1000
let suppressContextMenuUntil = 0
let contextMenuGuardInstalled = false
function onWindowContextMenu(e: MouseEvent): void {
  if (Date.now() > suppressContextMenuUntil) return
  suppressContextMenuUntil = 0
  e.preventDefault()
  e.stopPropagation()
}

/** Where a keyboard-opened menu points: the cursor row, the selection, the folder. */
export type ContextMenuTarget = { kind: 'session' | 'folder'; id: string }

function rowSelector(kind: string, id: string): string {
  return `[data-sidebar-row="${`${kind}:${id}`.replace(/["\\]/g, '\\$&')}"]`
}

export interface SessionActions {
  /** Every action, keyed by name; each takes the target session id. */
  run: Record<SessionAction, (sessionId: string) => void>
  /** Whether the Session menu would show `action` for this session. */
  visible: (action: SessionAction, sessionId: string) => boolean
  selectedFor: (action: SessionAction) => string | null
  openToSideTarget: () => string | null
  contextMenuTarget: () => ContextMenuTarget | null
  contextMenuEnabled: () => boolean
  openContextMenu: () => void
}

export function useSessionActions(): SessionActions {
  const ui = useUiStore()
  const sessions = useSessionsStore()
  const helpers = useHelpersStore()
  const layout = useLayoutStore()
  const { t } = useI18n()

  function find(sessionId: string): Session | null {
    return sessions.allSessions.find((s) => s.sessionId === sessionId) ?? null
  }

  function visible(action: SessionAction, sessionId: string): boolean {
    const s = find(sessionId)
    if (!s) return false
    return sessionActionVisible(action, {
      synthetic: s.synthetic === true,
      live: sessions.isSessionLive(sessionId),
      taskState: s.taskState,
      shellTerminal: s.isShellTerminal === true
    })
  }

  /** The selected session's id when `action` applies to it, else `null`. */
  function selectedFor(action: SessionAction): string | null {
    const id = sessions.selectedId
    return id && visible(action, id) ? id : null
  }

  /**
   * Fork a session — `createForkedSession` auto-focuses the new fork and
   * `TerminalPane` spawns `claude --resume <orig> --fork-session`. No confirm:
   * forking leaves the original intact. A null return means the source vanished
   * (race) or is itself a synthetic: there is no JSONL to branch from.
   */
  function fork(sessionId: string): void {
    if (sessions.createForkedSession(sessionId)) return
    ui.pushToast({
      kind: 'danger',
      title: t('sessionMenu.forkFailed'),
      description: t('sessionMenu.forkFailedRace')
    })
  }

  /**
   * Open a session resumed (`claude --resume <uuid>`) in a NEW split pane next
   * to the main pane — the helper stack is the app's only "two sessions at once"
   * surface. The pane joins the SELECTED session's worktree stack but spawns in
   * the target's own folder. No-ops: a synthetic / missing / non-resumable
   * target, or the target already being the main pane (two resumes of one uuid
   * would fight over the JSONL). Nothing selected → open it as the main pane.
   * `addResumeHelper` also collapses a duplicate resume onto the existing pane.
   */
  function openToSide(sessionId: string): void {
    const target = find(sessionId)
    if (!target || target.synthetic === true || target.fullPath === '' || !target.resumable) return
    const selected = sessions.selectedSession
    if (selected?.sessionId === sessionId) return
    const worktreePath = selected?.projectPath ?? null
    if (!worktreePath) {
      sessions.select(sessionId)
      return
    }
    helpers.addResumeHelper(worktreePath, sessionId, target.projectPath || worktreePath)
  }

  /**
   * Restart a session's `claude` (`reloadSession`): kill whatever runs, respawn
   * `claude --resume <uuid>`. Picks up what `claude` reads only at launch
   * (skills, settings, MCP servers) without losing the conversation, and is the
   * only in-app way to bring back an ended session. The toast is the only
   * visible signal when the session restarts in the background.
   */
  function restart(sessionId: string): void {
    sessions.reloadSession(sessionId)
    ui.pushToast({ kind: 'success', title: t('sessionMenu.restarted') })
  }

  /**
   * Recover a failed synthetic by WHY it failed. `prompt_undelivered` still has
   * a live PTY, so re-inject the prompt (`retryPromptInjection`); a boot that
   * never produced a PTY re-enqueues a fresh boot (`retrySyntheticBoot`, BUG-23).
   */
  function retryBoot(sessionId: string): void {
    if (find(sessionId)?.failureReason === 'prompt_undelivered') {
      sessions.retryPromptInjection(sessionId)
      ui.pushToast({ kind: 'success', title: t('sessionMenu.promptRetried') })
    } else {
      sessions.retrySyntheticBoot(sessionId)
      ui.pushToast({ kind: 'success', title: t('sessionMenu.bootRetried') })
    }
  }

  /** Dismiss a dead synthetic: no JSONL exists, so this is a pure in-memory remove. */
  function dismiss(sessionId: string): void {
    sessions.closeSession(sessionId)
  }

  /** Copy `text` and toast the result; a rejected clipboard write toasts danger. */
  async function copyToClipboard(text: string, successTitle: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text)
      ui.pushToast({ kind: 'success', title: successTitle, persist: false })
    } catch {
      ui.pushToast({ kind: 'danger', title: t('sessionMenu.copyFailed') })
    }
  }

  function copyId(sessionId: string): void {
    void copyToClipboard(sessionId, t('sessionMenu.copiedSessionId'))
  }

  /** Copy the absolute path of the session's `.jsonl` transcript. */
  function copyTranscriptPath(sessionId: string): void {
    const target = find(sessionId)
    if (!target || !target.fullPath) {
      ui.pushToast({ kind: 'danger', title: t('sessionMenu.copyFailed') })
      return
    }
    void copyToClipboard(target.fullPath, t('sessionMenu.copiedTranscriptPath'))
  }

  function copyResumeCommand(sessionId: string): void {
    void copyToClipboard(`claude --resume ${sessionId}`, t('sessionMenu.copiedResumeCommand'))
  }

  /**
   * T38: copy a portable context digest (folder · branch · summary · first
   * prompt · recent turns), read from the transcript tail over IPC.
   */
  async function copyContextDigest(sessionId: string): Promise<void> {
    const target = find(sessionId)
    if (!target || !target.fullPath) {
      ui.pushToast({ kind: 'danger', title: t('sessionMenu.copyFailed') })
      return
    }
    const res = await window.api.sessionDigest(target.fullPath)
    const digest = buildContextDigest(
      {
        folderAlias: sessions.folderAliasOf(target.sessionId),
        branch: target.gitBranch,
        summary: sessionTitle(target, sessions.allSessions, t),
        firstPrompt: target.firstPrompt,
        messageCount: target.messageCount
      },
      res.ok ? (res.turns ?? []) : []
    )
    await copyToClipboard(digest, t('sessionMenu.copiedContextDigest'))
  }

  /**
   * Archive (non-destructive: the JSONL stays, the row moves under the folder's
   * "Show N archived" reveal) or restore it.
   */
  function toggleArchived(sessionId: string): void {
    if (sessions.isArchived(sessionId)) sessions.unarchiveSession(sessionId)
    else sessions.archiveSession(sessionId)
  }

  /**
   * Delete a session after a `window.confirm`: close it FIRST (tears down the
   * live PTY and resets the selection, so `claude` never writes to an unlinked
   * file), then unlink the JSONL over `session:delete`. The watcher's `unlink`
   * event removes the row.
   */
  async function deleteSession(sessionId: string): Promise<void> {
    if (!window.confirm(t('sessionMenu.deleteConfirm'))) return
    const target = find(sessionId)
    if (!target || !target.fullPath) {
      ui.pushToast({
        kind: 'danger',
        title: t('sessionMenu.deleteFailed'),
        description: t('sessionMenu.deleteNoPath')
      })
      return
    }
    sessions.closeSession(sessionId)
    const result = await window.api.sessionDelete(sessionId, target.fullPath)
    if (!result.ok) {
      ui.pushToast({
        kind: 'danger',
        title: t('sessionMenu.deleteFailed'),
        description: result.error
      })
    }
  }

  /**
   * Flip the per-session `noFlicker` pref. `CLAUDE_CODE_NO_FLICKER` is read at
   * spawn, so it applies on the session's next launch.
   */
  function toggleNoFlicker(sessionId: string): void {
    sessions.toggleNoFlicker(sessionId)
  }

  const run: Record<SessionAction, (sessionId: string) => void> = {
    fork,
    restart,
    openToSide,
    copyId,
    copyTranscriptPath,
    copyResumeCommand,
    copyContextDigest: (id) => void copyContextDigest(id),
    toggleNoFlicker,
    toggleArchived,
    delete: (id) => void deleteSession(id),
    retryBoot,
    dismiss
  }

  /** The keyboard cursor's row, or `null` — the cursor is inert in drill mode. */
  function cursorRow(): { kind: 'folder' | 'group' | 'session'; id: string } | null {
    return sessions.drillModeEnabled ? null : sessions.keyboardCursor
  }

  /** `session.openToSide`'s target: the cursor's session row, else the selection. */
  function openToSideTarget(): string | null {
    const c = cursorRow()
    const id = c?.kind === 'session' ? c.id : sessions.selectedId
    return id && visible('openToSide', id) ? id : null
  }

  /**
   * `session.contextMenu`'s target (§3.10, §8.3): the cursor row, else the
   * selected session, else the active folder. A repo-group cursor row is a
   * documented no-op (its menu is component state the keyboard cannot reach),
   * and a folder terminal has no Session menu.
   */
  function contextMenuTarget(): ContextMenuTarget | null {
    const c = cursorRow()
    if (c) {
      if (c.kind === 'group') return null
      if (c.kind === 'session' && find(c.id)?.isShellTerminal) return null
      return { kind: c.kind, id: c.id }
    }
    const selected = sessions.selectedSession
    if (selected && !selected.isShellTerminal) return { kind: 'session', id: selected.sessionId }
    const folder = sessions.activeFolderPath
    return folder ? { kind: 'folder', id: folder } : null
  }

  /**
   * Bottom-left of the target's sidebar row — the keyboard-anchor fallback the
   * drill view already uses. A row not in the DOM falls back to the sidebar's
   * top-left; a collapsed sidebar to the Topbar title.
   */
  function anchorFor(target: ContextMenuTarget): { x: number; y: number } {
    const el = layout.sidebarCollapsed
      ? document.querySelector('header [contenteditable]')
      : (document.querySelector(rowSelector(target.kind, target.id)) ??
        document.querySelector('[data-sidebar]'))
    if (!el) return { x: 8, y: 42 }
    const rect = el.getBoundingClientRect()
    const fromRow = el.hasAttribute('data-sidebar-row') || layout.sidebarCollapsed
    return { x: rect.left, y: fromRow ? rect.bottom : rect.top }
  }

  /**
   * The keyboard opener owns the press whenever the cursor is on a row, even a
   * row with no menu (a repo group, a folder terminal): otherwise Chromium's
   * own `contextmenu` would open the menu of whatever row holds DOM focus, and
   * the documented no-op would not be one.
   */
  function contextMenuEnabled(): boolean {
    return cursorRow() !== null || contextMenuTarget() !== null
  }

  /** Open the Session or Folder menu for `contextMenuTarget()` from the keyboard. */
  function openContextMenu(): void {
    if (!contextMenuGuardInstalled) {
      window.addEventListener('contextmenu', onWindowContextMenu, true)
      contextMenuGuardInstalled = true
    }
    suppressContextMenuUntil = Date.now() + SYNTHETIC_CONTEXTMENU_MS
    const target = contextMenuTarget()
    if (!target) return
    const { x, y } = anchorFor(target)
    if (target.kind === 'session') ui.openMenu({ sessionId: target.id, x, y })
    else ui.openFolderMenu({ projectPath: target.id, x, y })
  }

  return {
    run,
    visible,
    selectedFor,
    openToSideTarget,
    contextMenuTarget,
    contextMenuEnabled,
    openContextMenu
  }
}
