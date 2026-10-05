<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import {
  Archive,
  ArchiveRestore,
  Check,
  Copy,
  Crown,
  Edit3,
  ExternalLink,
  Eye,
  FileText,
  Hash,
  KanbanSquare,
  RotateCcw,
  Smartphone,
  SquareTerminal,
  Trash2,
  X
} from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { useUiStore } from '../stores/ui'
import { useSessionsStore } from '../stores/sessions'
import { sessionTitle } from '../lib/session-label'
import { useHelpersStore } from '../stores/helpers'
import { buildContextDigest } from '../lib/context-digest'
import { shouldShowRestart } from './session-menu-core'

/**
 * Session right-click context menu — see `design.md` §3.8 (anatomy) and §6
 * (Context menu) for the visual spec.
 *
 * State source: `ui.menu`. Rendered only when `ui.menu.open === true`.
 * Mounted once at the App level via `<Teleport to="body">` so the menu can
 * float above the sidebar's `overflow: hidden` boundary.
 *
 * Behaviors:
 *  - Esc closes
 *  - outside `mousedown` closes
 *  - any `wheel` event closes (mirrors native macOS context menus)
 *  - arrow keys move focus between items (skipping the separator)
 *  - Enter activates the focused item
 *  - left/top are re-clamped against the menu's *measured* bounding rect
 *    after mount, so the initial coords from `useContextMenu` are an
 *    approximation that becomes exact once the menu is in the DOM
 *
 * The Delete handler issues a `window.confirm` synchronously; a styled
 * `ConfirmDialog` component is a possible later refinement.
 */

const ui = useUiStore()
const sessions = useSessionsStore()
const helpers = useHelpersStore()
const { t } = useI18n()

const menuState = computed(() => ui.menu)

const rootRef = ref<HTMLElement | null>(null)

/**
 * Index in `interactiveItems` of the currently focused row. The separator
 * is excluded — keyboard navigation skips it automatically.
 */
const focusedIndex = ref(0)

/**
 * Measured size of the menu after mount. Used to re-clamp `left` / `top`
 * against the real DOM size (the `useContextMenu` composable only knows an
 * approximation). Updated by `measureAndClamp` after `nextTick`.
 */
const measuredSize = ref<{ width: number; height: number } | null>(null)

interface MenuItem {
  id: string
  kind: 'item'
  label: string
  icon: typeof Edit3
  shortcut?: string
  destructive?: boolean
  onSelect: (sessionId: string) => void
}

/**
 * Toggle item — renders a check on the trailing side when `isOn(sessionId)`
 * returns true, and **does NOT close the menu on click**. The user can flip
 * it on/off in place and then dismiss the menu via Esc, outside click, or
 * picking another item. See `onToggle` for the no-flicker spawn-time caveat.
 */
interface MenuToggle {
  id: string
  kind: 'toggle'
  label: string
  icon: typeof Edit3
  hint?: string
  /**
   * When set, the `hint` renders as a wrapped block beneath the label instead of
   * a single truncated line — used for the Remote Control disclosure, a full
   * trust-model paragraph that must be readable before the user enables it.
   */
  hintWrap?: boolean
  isOn: (sessionId: string) => boolean
  onToggle: (sessionId: string) => void
}

interface MenuSeparator {
  id: string
  kind: 'separator'
}

type MenuEntry = MenuItem | MenuToggle | MenuSeparator

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

function onRename(sessionId: string): void {
  // The inline-edit surface is the Topbar title, which always reflects the
  // SELECTED session — so select the target first (if needed), then focus it
  // for editing on the next tick, once the Topbar has rendered the new title.
  // Mirrors the `session.rename` shortcut (App.vue), which edits the
  // already-selected session. Folder terminals render a read-only title, so
  // the Topbar simply won't enter edit mode for them.
  if (sessions.selectedSession?.sessionId === sessionId) {
    ui.triggerRenameFocus()
    return
  }
  sessions.select(sessionId)
  void nextTick(() => ui.triggerRenameFocus())
}

/**
 * Fork a session — creates a synthetic placeholder via
 * `sessions.createForkedSession`, which auto-focuses the new fork and
 * triggers `TerminalPane` to spawn `claude --resume <orig> --fork-session`.
 * No window.confirm: forking is non-destructive (the original is left
 * intact). Errors toast as danger; the only failure path is a race
 * (source session disappeared between right-click and click).
 */
function onFork(sessionId: string): void {
  const newId = sessions.createForkedSession(sessionId)
  if (!newId) {
    // Null return = source session vanished between right-click and click
    // (race) OR is itself a synthetic (defensive — menu filter should hide
    // the item for synths). The user-visible cause is the same in both
    // cases: there's no real JSONL to branch from.
    ui.pushToast({
      kind: 'danger',
      title: t('sessionMenu.forkFailed'),
      description: t('sessionMenu.forkFailedRace')
    })
  }
}

/**
 * Open an existing session resumed (`claude --resume <uuid>`) in a NEW split
 * pane next to the current main pane — the app's only "two sessions at once"
 * surface is the helper-stack, so a "tab" is a resume helper. Reuses the same
 * machinery forks/shells use: the pane is appended to the CURRENTLY SELECTED
 * session's worktree stack (so it shows in the visible split immediately) but
 * spawns with the target session's OWN folder as cwd.
 *
 * Guards:
 *  - synthetic / missing / non-resumable (cloud-bridge) sessions have no
 *    resumable JSONL — no-op (the menu also hides the item for synthetics).
 *  - target already the visible main pane → no-op (a second `claude --resume`
 *    on the same uuid would fight the first over the JSONL).
 *  - nothing selected → no split stack to host the pane, so fall back to
 *    opening the session as the main pane (same as Resume).
 *
 * The store's `addResumeHelper` additionally collapses a duplicate resume of
 * the same uuid already in the stack onto the existing pane.
 */
function onOpenInNewTab(sessionId: string): void {
  const target = sessions.allSessions.find((s) => s.sessionId === sessionId)
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
 * Restart a session's `claude` process (`reloadSession`): disposes whatever
 * PTY/terminal is cached for this session — killing it first if it's still
 * running — and respawns `claude --resume <uuid>` fresh. This is the way to
 * pick up something `claude` only reads at launch — a newly-installed skill,
 * an edited `settings.json`, a new MCP server — without losing the
 * conversation (it's resumed from the JSONL on disk). The menu item is
 * gated to non-synthetic sessions that are either live or have already
 * ended (see `shouldShowRestart` in `session-menu-core.ts`): reselecting an
 * ended session's row alone does NOT respawn it (its dead terminal is
 * reattached, not recreated), so this is the only in-app way to bring one
 * back — no more need for the "enable remote control" workaround.
 * Non-destructive, so no `window.confirm`; the toast confirms it took effect
 * (the only visible signal when the session is restarted in the background).
 */
function onRestart(sessionId: string): void {
  sessions.reloadSession(sessionId)
  ui.pushToast({ kind: 'success', title: t('sessionMenu.restarted') })
}

/**
 * Retry a boot-failed synthetic (BUG-23): clears the FAILED state and re-enqueues
 * it for a fresh background boot. Only surfaced on a synthetic whose boot the
 * reaper marked `failed` (`failureReason: 'boot_timeout'`); the store handles
 * mounting the pane when nothing is selected so the boot can actually run.
 */
function onRetryBoot(sessionId: string): void {
  sessions.retrySyntheticBoot(sessionId)
  ui.pushToast({ kind: 'success', title: t('sessionMenu.bootRetried') })
}

/**
 * Retry an undelivered pre-prompt (docs/specs/2026-07-15-preprompt-injection-
 * watchdog.md §5.5): the synthetic's PTY is genuinely alive here (unlike
 * `boot_timeout`), so this dispatches to `retryPromptInjection` — NOT
 * `retrySyntheticBoot`, which no-ops on an already-live PTY.
 */
function onRetryPromptDelivery(sessionId: string): void {
  sessions.retryPromptInjection(sessionId)
  ui.pushToast({ kind: 'success', title: t('sessionMenu.promptRetried') })
}

/**
 * Dispatch the single "Retry" menu item to the right recovery path based on WHY
 * the synthetic failed — the two `failed` synthetics this menu ever shows
 * (`boot_timeout` vs. `prompt_undelivered`) need genuinely different recovery,
 * since only one of them still has a live process to reuse.
 */
function onRetryFailure(sessionId: string): void {
  if (targetSession.value?.failureReason === 'prompt_undelivered') {
    onRetryPromptDelivery(sessionId)
  } else {
    onRetryBoot(sessionId)
  }
}

/**
 * Dismiss a dead synthetic (BUG-23): removes the row from the model. There is no
 * JSONL on disk (it never booted), so unlike Delete this is a pure in-memory
 * remove via `closeSession` (which also tears down any lingering terminal).
 */
function onDismiss(sessionId: string): void {
  sessions.closeSession(sessionId)
}

/**
 * Copy `text` to the clipboard and toast the result. The click that triggers
 * this is a user gesture in Electron's secure renderer, so the async
 * `navigator.clipboard.writeText` resolves without a permission prompt. On
 * rejection (e.g. clipboard unavailable in a headless/odd environment), we
 * surface a danger toast instead of failing silently.
 */
async function copyToClipboard(text: string, successTitle: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    ui.pushToast({ kind: 'success', title: successTitle, persist: false })
  } catch {
    ui.pushToast({ kind: 'danger', title: t('sessionMenu.copyFailed') })
  }
}

/** Copy the target session's uuid (the JSONL filename stem). */
function onCopySessionId(sessionId: string): void {
  void copyToClipboard(sessionId, t('sessionMenu.copiedSessionId'))
}

/** Copy the absolute on-disk path of the session's `.jsonl` transcript. */
function onCopyTranscriptPath(sessionId: string): void {
  const target = sessions.allSessions.find((s) => s.sessionId === sessionId)
  if (!target || !target.fullPath) {
    ui.pushToast({ kind: 'danger', title: t('sessionMenu.copyFailed') })
    return
  }
  void copyToClipboard(target.fullPath, t('sessionMenu.copiedTranscriptPath'))
}

/** Copy the ready-to-paste `claude --resume <sessionId>` command. */
function onCopyResumeCommand(sessionId: string): void {
  void copyToClipboard(`claude --resume ${sessionId}`, t('sessionMenu.copiedResumeCommand'))
}

/**
 * T38: copy a portable context digest (folder · branch · summary · first prompt ·
 * recent turns) so the operator can reuse a session's context elsewhere without
 * hunting the JSONL. Reads the transcript tail over IPC, formats with the pure
 * `buildContextDigest`, hands off to the shared clipboard helper.
 */
async function onCopyContextDigest(sessionId: string): Promise<void> {
  const target = sessions.allSessions.find((s) => s.sessionId === sessionId)
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

/** A folder's display label (alias, else basename) — the board header title. */
function folderLabel(path: string): string {
  const f = sessions.findFolderByPath(path)
  return f?.alias || path.replace(/\/+$/, '').split('/').pop() || path
}

/**
 * Open the per-repo Roadmap board scoped to the MENU'S TARGET session's own
 * folder — not `sessions.selectedSession`. The whole point of this entry is
 * that it must work from a right-click on a session that isn't the currently
 * active one (T149), so we resolve `target.projectPath` fresh here, same as
 * `onOpenInNewTab`/`onCopyTranscriptPath` do above.
 */
function onRoadmap(sessionId: string): void {
  const target = sessions.allSessions.find((s) => s.sessionId === sessionId)
  if (!target || !target.projectPath) return
  ui.openRoadmap(target.projectPath, folderLabel(target.projectPath))
}

/**
 * Archive a session — marks it archived in the store (persisted to
 * `localStorage`) and tears down its live terminal, keeping the row so it can be
 * restored. Non-destructive (the JSONL on disk is left intact, unlike Delete),
 * so there's no confirm prompt. The row leaves the normal sidebar flow and
 * reappears under the folder's "Show N archived" reveal.
 */
function onArchive(sessionId: string): void {
  sessions.archiveSession(sessionId)
}

/** Reverse an archive — the session returns to the normal sidebar flow. */
function onUnarchive(sessionId: string): void {
  sessions.unarchiveSession(sessionId)
}

/**
 * Delete a session — unlinks the JSONL on disk via the `session:delete` IPC,
 * which also best-effort updates `sessions-index.json` (if present). The
 * sidebar row vanishes automatically once the watcher's `unlink` event fires
 * and `onSessionRemoved` runs.
 *
 * We close the session BEFORE the IPC so the live PTY (if any) is torn down
 * cleanly and `selectedId` is reset — calling order matters: dropping the
 * file while a PTY is still mounted would make `claude` error if it tries to
 * write. `closeSession()` is also a no-op for sessions without a live
 * terminal, so it's safe to always call.
 */
async function onDelete(sessionId: string): Promise<void> {
  if (!window.confirm(t('sessionMenu.deleteConfirm'))) return
  const target = sessions.allSessions.find((s) => s.sessionId === sessionId)
  if (!target || !target.fullPath) {
    ui.pushToast({
      kind: 'danger',
      title: t('sessionMenu.deleteFailed'),
      description: t('sessionMenu.deleteNoPath')
    })
    return
  }
  // Tear down the live terminal + remove the row from the in-memory model
  // BEFORE we unlink the file. The watcher will fire `claude:session:removed`
  // a moment later; by then the in-memory state is already consistent.
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
 * Flip the per-session `noFlicker` preference. The Claude `CLAUDE_CODE_NO_FLICKER`
 * env var is read only at spawn time, so toggling mid-session does NOT change
 * the currently running `claude`; the next PTY this session spawns will pick
 * up the new value. The menu surfaces this caveat via the
 * `sessionMenu.noFlickerRestartHint` string ("applies on next launch").
 */
function onToggleNoFlicker(sessionId: string): void {
  sessions.toggleNoFlicker(sessionId)
}

function isNoFlickerOn(sessionId: string): boolean {
  return sessions.getPrefs(sessionId).noFlicker === true
}

/**
 * Flip Claude Code's own Remote Control (`--remote-control`, the phone bridge)
 * for this session. Enabling marks the session's boot config with the
 * operator-only flag and RESTARTS it (kill + `claude --resume`), exactly the
 * Restart-session mechanism, so it relaunches with the flag — see
 * `setSessionRemoteControl` in the store. The disclosure paragraph
 * (`remoteControl.disclosure`) renders inline as the toggle's wrapped hint so
 * the trust model is visible BEFORE the user enables it: reads (chat + tool
 * results) can be pulled off-device to the phone, but mutations still require
 * the desk confirm overlay (which never reaches the phone → unanswered denies).
 * The restart is non-destructive (the conversation resumes from the JSONL), so
 * we surface the same `restarted` toast as Restart-session — the only otherwise
 * invisible signal that the relaunch took effect.
 */
function onToggleRemoteControl(sessionId: string): void {
  const next = !sessions.isSessionRemoteControlOn(sessionId)
  sessions.setSessionRemoteControl(sessionId, next)
  ui.pushToast({ kind: 'success', title: t('sessionMenu.restarted') })
}

function isRemoteControlOn(sessionId: string): boolean {
  return sessions.isSessionRemoteControlOn(sessionId)
}

/**
 * Promote/demote this session to Orchestrator (T98). Enabling ARMS the
 * Harnu-managed guard (`orchestrator-guard.ts#arm`, T109) for the session's
 * real id + folder and RESTARTS it (kill + `claude --resume`), exactly the
 * Restart-session mechanism, so it relaunches with `docs/harnu-orchestrator.md`
 * prepended to its `--append-system-prompt` — the T55 preamble mechanism,
 * resolved fresh from the guard's armed state at every spawn (`pty.ts`). The
 * disclosure paragraph (`orchestrator.disclosure`) renders inline as the
 * toggle's wrapped hint so the role is visible BEFORE the user promotes.
 * Disabling disarms the guard and restarts again to drop the contract. The
 * restart is non-destructive, so we surface the same `restarted` toast as
 * Restart-session / Remote Control.
 */
function onToggleOrchestrator(sessionId: string): void {
  const next = !sessions.isSessionOrchestratorOn(sessionId)
  void sessions.toggleOrchestrator(sessionId, next)
  ui.pushToast({ kind: 'success', title: t('sessionMenu.restarted') })
}

function isOrchestratorOn(sessionId: string): boolean {
  return sessions.isSessionOrchestratorOn(sessionId)
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

/**
 * Rename accelerator. macOS uses `⌘R`; every other platform uses `F2`.
 * Cross-platform detection isn't wired yet (no `os.platform()` IPC), so we
 * show `F2` for now per the task spec. Switch this to a platform-aware
 * computed in T-4.x when the shortcuts subsystem lands.
 */
const renameAccelerator = 'F2'

/**
 * The session this menu currently targets, looked up against the live store.
 * `null` when the menu is closed or the id can't be resolved (race with a
 * just-deleted session, etc.). Used to gate item visibility — Archive,
 * Delete, Fork, and Open-in-new-tab are hidden for synthetic sessions because
 * they have no JSONL on disk to operate on (or resume) yet.
 */
const targetSession = computed(() => {
  const id = menuState.value.sessionId
  if (!id) return null
  return sessions.allSessions.find((s) => s.sessionId === id) ?? null
})

const entries = computed<MenuEntry[]>(() => {
  const isSynthetic = targetSession.value?.synthetic === true
  // "Restart session" applies to a session with a running `claude` process,
  // AND to one that has already ended — see `shouldShowRestart`.
  const isLive = targetSession.value ? sessions.isSessionLive(targetSession.value.sessionId) : false
  const isArchived = targetSession.value
    ? sessions.isArchived(targetSession.value.sessionId)
    : false
  const archiveEntry: MenuItem = isArchived
    ? {
        id: 'unarchive',
        kind: 'item',
        label: t('actions.unarchive'),
        icon: ArchiveRestore,
        onSelect: onUnarchive
      }
    : {
        id: 'archive',
        kind: 'item',
        label: t('actions.archive'),
        icon: Archive,
        onSelect: onArchive
      }
  const all: MenuEntry[] = [
    {
      id: 'rename',
      kind: 'item',
      label: t('actions.rename'),
      icon: Edit3,
      shortcut: renameAccelerator,
      onSelect: onRename
    },
    {
      id: 'fork',
      kind: 'item',
      label: t('actions.fork'),
      icon: Copy,
      // No `shortcut` hint until the T-4.x shortcuts subsystem lands a real
      // global Cmd+D binding. Displaying a hint without the binding is a
      // false promise.
      onSelect: onFork
    },
    {
      id: 'restart',
      kind: 'item',
      label: t('actions.restart'),
      icon: RotateCcw,
      onSelect: onRestart
    },
    {
      id: 'open-in-new-tab',
      kind: 'item',
      label: t('actions.openInNewTab'),
      icon: ExternalLink,
      onSelect: onOpenInNewTab
    },
    { id: 'sep-copy', kind: 'separator' },
    {
      id: 'copy-session-id',
      kind: 'item',
      label: t('actions.copySessionId'),
      icon: Hash,
      onSelect: onCopySessionId
    },
    {
      id: 'copy-transcript-path',
      kind: 'item',
      label: t('actions.copyTranscriptPath'),
      icon: FileText,
      onSelect: onCopyTranscriptPath
    },
    {
      id: 'copy-resume-command',
      kind: 'item',
      label: t('actions.copyResumeCommand'),
      icon: SquareTerminal,
      onSelect: onCopyResumeCommand
    },
    {
      id: 'copy-context-digest',
      kind: 'item',
      label: t('actions.copyContextDigest'),
      icon: Copy,
      onSelect: (id: string) => void onCopyContextDigest(id)
    },
    { id: 'sep-roadmap', kind: 'separator' },
    {
      id: 'roadmap',
      kind: 'item',
      label: t('sessionMenu.roadmapBoard'),
      icon: KanbanSquare,
      onSelect: onRoadmap
    },
    {
      id: 'no-flicker',
      kind: 'toggle',
      label: t('actions.noFlicker'),
      icon: Eye,
      hint: t('sessionMenu.noFlickerRestartHint'),
      isOn: isNoFlickerOn,
      onToggle: onToggleNoFlicker
    },
    {
      id: 'remote-control',
      kind: 'toggle',
      label: t('remoteControl.toggle'),
      icon: Smartphone,
      // Full trust-model disclosure, rendered as a wrapped block so it's
      // readable BEFORE the user enables Remote Control (design.md §6).
      hint: t('remoteControl.disclosure'),
      hintWrap: true,
      isOn: isRemoteControlOn,
      onToggle: onToggleRemoteControl
    },
    {
      id: 'orchestrator',
      kind: 'toggle',
      label: t('sessionMenu.orchestrator'),
      icon: Crown,
      // Role disclosure, rendered as a wrapped block so it's readable BEFORE
      // the user promotes (design.md §6).
      hint: t('orchestrator.disclosure'),
      hintWrap: true,
      isOn: isOrchestratorOn,
      onToggle: onToggleOrchestrator
    },
    { id: 'sep-1', kind: 'separator' },
    archiveEntry,
    {
      id: 'delete',
      kind: 'item',
      label: t('actions.delete'),
      icon: Trash2,
      destructive: true,
      onSelect: onDelete
    }
  ]
  // Synthetic sessions have no JSONL on disk yet — Archive/Delete are
  // file-system operations and Fork can't `claude --resume` from a missing
  // file, so none apply. Hide them (plus the separator that would otherwise
  // dangle at the end). The user closes a synthetic via the terminal pane's
  // X button instead.
  // Synthetic sessions have no JSONL on disk yet — restarting a plain synthetic
  // would relaunch a *new* `claude` (losing the in-progress conversation), and a
  // fork synthetic would re-fork from source. So 'restart' is excluded here too.
  if (isSynthetic) {
    const base = all.filter(
      (e) =>
        e.id !== 'archive' &&
        e.id !== 'unarchive' &&
        e.id !== 'delete' &&
        e.id !== 'fork' &&
        e.id !== 'restart' &&
        e.id !== 'remote-control' &&
        e.id !== 'orchestrator' &&
        e.id !== 'open-in-new-tab' &&
        e.id !== 'sep-1' &&
        e.id !== 'sep-copy' &&
        e.id !== 'copy-session-id' &&
        e.id !== 'copy-transcript-path' &&
        e.id !== 'copy-resume-command' &&
        e.id !== 'copy-context-digest'
    )
    // BUG-23/24: a dead synthetic gets Retry (re-boot) + Dismiss (remove the row)
    // actions — the only way to recover it without leaving an eternal dead row.
    // Two ways in: the boot never produced a PTY at all (reaper marks it
    // `failed`, BUG-23), or a PTY WAS created and then the process exited on its
    // own — e.g. the user hit Ctrl+C in the terminal (`markSessionExited` marks a
    // clean exit `completed`, not `failed` — BUG-24). Both leave a synthetic with
    // no JSONL twin and no running process, so both need the same escape hatch.
    if (
      targetSession.value?.taskState === 'failed' ||
      targetSession.value?.taskState === 'completed'
    ) {
      const retry: MenuItem = {
        id: 'retry-boot',
        kind: 'item',
        label: t('actions.retryBoot'),
        icon: RotateCcw,
        onSelect: onRetryFailure
      }
      const dismiss: MenuItem = {
        id: 'dismiss-synthetic',
        kind: 'item',
        label: t('actions.dismiss'),
        icon: X,
        destructive: true,
        onSelect: onDismiss
      }
      return [retry, dismiss, { id: 'sep-boot', kind: 'separator' }, ...base]
    }
    return base
  }
  // For real sessions, show "Restart session" while live (kill + respawn in
  // place) OR once ended (respawn fresh — reselecting the row alone won't do
  // it, see shouldShowRestart's doc comment). A dormant disk session never
  // opened this app run (no taskState yet) still hides it: plain selection
  // already spawns fresh for that case.
  const showRestart = shouldShowRestart({
    isSynthetic,
    isLive,
    taskState: targetSession.value?.taskState
  })
  if (!showRestart) return all.filter((e) => e.id !== 'restart')
  return all
})

/**
 * Items the keyboard can land on. Both action items and toggles are
 * navigable; only separators are skipped.
 */
const interactiveItems = computed<Array<MenuItem | MenuToggle>>(() =>
  entries.value.filter((e): e is MenuItem | MenuToggle => e.kind === 'item' || e.kind === 'toggle')
)

// ---------------------------------------------------------------------------
// Position clamping
// ---------------------------------------------------------------------------

/**
 * Computed `left` / `top` that re-clamps using the measured menu size once
 * the DOM is laid out. Before measurement, falls back to the store's raw
 * `x` / `y` (which the composable already clamped against an approximate
 * size).
 */
const clamped = computed<{ left: number; top: number }>(() => {
  const { x, y } = menuState.value
  if (!measuredSize.value) return { left: x, top: y }
  const vw = window.innerWidth
  const vh = window.innerHeight
  const margin = 8
  let left = x
  let top = y
  if (left + measuredSize.value.width > vw - margin) {
    left = Math.max(margin, x - measuredSize.value.width)
  }
  if (top + measuredSize.value.height > vh - margin) {
    top = Math.max(margin, y - measuredSize.value.height)
  }
  return { left, top }
})

async function measureAndClamp(): Promise<void> {
  await nextTick()
  if (!rootRef.value) return
  const rect = rootRef.value.getBoundingClientRect()
  measuredSize.value = { width: rect.width, height: rect.height }
}

// ---------------------------------------------------------------------------
// Window listeners — outside click, Esc, wheel
// ---------------------------------------------------------------------------

function onWindowMousedown(e: MouseEvent): void {
  if (!menuState.value.open) return
  if (!rootRef.value) return
  if (rootRef.value.contains(e.target as Node)) return
  ui.closeMenu()
}

function onWindowKeydown(e: KeyboardEvent): void {
  if (!menuState.value.open) return
  if (e.key === 'Escape') {
    e.stopPropagation()
    e.preventDefault()
    ui.closeMenu()
    return
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    const n = interactiveItems.value.length
    if (n === 0) return
    focusedIndex.value = (focusedIndex.value + 1) % n
    focusItem()
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    const n = interactiveItems.value.length
    if (n === 0) return
    focusedIndex.value = (focusedIndex.value - 1 + n) % n
    focusItem()
  } else if (e.key === 'Enter') {
    e.preventDefault()
    const item = interactiveItems.value[focusedIndex.value]
    const sessionId = menuState.value.sessionId
    if (item && sessionId) activate(item, sessionId)
  }
}

/**
 * Any wheel event dismisses the menu — both inside and outside, matching
 * native macOS context menu behavior (see finding 08 §5 / §10).
 */
function onWindowWheel(): void {
  if (menuState.value.open) ui.closeMenu()
}

function focusItem(): void {
  if (!rootRef.value) return
  const el = rootRef.value.querySelector<HTMLElement>(`[data-menu-index="${focusedIndex.value}"]`)
  el?.focus()
}

/**
 * Activate the focused or clicked entry.
 *
 * Items (`kind: 'item'`) fire their action AND dismiss the menu — the
 * established behavior for Rename/Fork/Archive/Delete/etc.
 *
 * Toggles (`kind: 'toggle'`) flip their state in place and **leave the menu
 * open**, so the user can see the check appear and continue to other items.
 * This mirrors native checkbox-in-menu patterns on macOS/GNOME.
 */
function activate(item: MenuItem | MenuToggle, sessionId: string): void {
  if (item.kind === 'toggle') {
    item.onToggle(sessionId)
    return
  }
  item.onSelect(sessionId)
  ui.closeMenu()
}

watch(
  () => menuState.value.open,
  async (open) => {
    if (open) {
      focusedIndex.value = 0
      measuredSize.value = null
      window.addEventListener('mousedown', onWindowMousedown, true)
      window.addEventListener('keydown', onWindowKeydown, true)
      window.addEventListener('wheel', onWindowWheel, { passive: true })
      await measureAndClamp()
      focusItem()
    } else {
      window.removeEventListener('mousedown', onWindowMousedown, true)
      window.removeEventListener('keydown', onWindowKeydown, true)
      window.removeEventListener('wheel', onWindowWheel)
    }
  }
)

onBeforeUnmount(() => {
  window.removeEventListener('mousedown', onWindowMousedown, true)
  window.removeEventListener('keydown', onWindowKeydown, true)
  window.removeEventListener('wheel', onWindowWheel)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="menuState.open && menuState.sessionId"
      ref="rootRef"
      class="anim-fade-in-scale fixed border border-border-2 bg-surface"
      style="
        min-width: 200px;
        padding: 4px;
        border-radius: 7px;
        box-shadow: var(--shadow-pop);
        z-index: 50;
        transform-origin: top left;
      "
      :style="{ left: clamped.left + 'px', top: clamped.top + 'px' }"
      role="menu"
      :aria-label="t('sessionMenu.label')"
    >
      <template v-for="entry in entries" :key="entry.id">
        <div
          v-if="entry.kind === 'separator'"
          aria-hidden="true"
          style="height: 1px; background: var(--color-border); margin: 4px 2px"
        />
        <button
          v-else-if="entry.kind === 'item'"
          role="menuitem"
          tabindex="-1"
          :data-menu-index="interactiveItems.indexOf(entry)"
          class="flex w-full items-center text-left transition focus:outline-none"
          :class="
            entry.destructive
              ? 'text-red hover:bg-red-soft hover:text-red focus:bg-red-soft focus:text-red'
              : 'text-text-2 hover:bg-surface-2 hover:text-text focus:bg-surface-2 focus:text-text'
          "
          style="gap: 9px; padding: 6px 8px; font-size: 12px; border-radius: 4px; outline: none"
          @click="menuState.sessionId && activate(entry, menuState.sessionId)"
        >
          <component :is="entry.icon" :size="13" :stroke-width="1.6" class="shrink-0" />
          <span class="flex-1 truncate">{{ entry.label }}</span>
          <span
            v-if="entry.shortcut"
            class="font-mono text-text-4 tabular-nums"
            style="font-size: 10.5px; letter-spacing: 0.02em"
            >{{ entry.shortcut }}</span
          >
        </button>
        <!--
          Toggle row — `kind === 'toggle'`. Clicking flips the per-session pref
          and intentionally KEEPS THE MENU OPEN (see `activate()` in the
          <script>), so the user can see the check appear in place. The hint
          text spells out that the env var (CLAUDE_CODE_NO_FLICKER) is only
          read by `claude` at spawn time — the running session is unaffected.
        -->
        <button
          v-else
          role="menuitemcheckbox"
          tabindex="-1"
          :aria-checked="menuState.sessionId ? entry.isOn(menuState.sessionId) : false"
          :data-menu-index="interactiveItems.indexOf(entry)"
          class="flex w-full text-left text-text-2 transition hover:bg-surface-2 hover:text-text focus:bg-surface-2 focus:text-text focus:outline-none"
          :class="entry.hintWrap ? 'items-start' : 'items-center'"
          style="gap: 9px; padding: 6px 8px; font-size: 12px; border-radius: 4px; outline: none"
          @click="menuState.sessionId && activate(entry, menuState.sessionId)"
        >
          <component
            :is="entry.icon"
            :size="13"
            :stroke-width="1.6"
            class="shrink-0"
            :style="entry.hintWrap ? 'margin-top: 1.5px' : undefined"
          />
          <span class="flex min-w-0 flex-1 flex-col" style="gap: 2px">
            <span class="flex min-w-0 items-baseline" style="gap: 6px">
              <span class="truncate">{{ entry.label }}</span>
              <span
                v-if="entry.hint && !entry.hintWrap"
                class="truncate text-text-3"
                style="font-size: 10.5px"
                >{{ entry.hint }}</span
              >
            </span>
            <!--
              Wrapped disclosure (Remote Control) — full trust-model paragraph,
              visible before the user enables the toggle (design.md §6).
            -->
            <span
              v-if="entry.hint && entry.hintWrap"
              class="text-text-3"
              style="font-size: 10.5px; line-height: 1.45; max-width: 240px"
              >{{ entry.hint }}</span
            >
          </span>
          <Check
            v-if="menuState.sessionId && entry.isOn(menuState.sessionId)"
            :size="13"
            :stroke-width="1.8"
            class="shrink-0 text-accent"
            :style="entry.hintWrap ? 'margin-top: 1.5px' : undefined"
          />
          <span v-else aria-hidden="true" class="shrink-0" style="width: 13px; height: 13px" />
        </button>
      </template>
    </div>
  </Teleport>
</template>
