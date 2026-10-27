<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Sidebar from './components/Sidebar.vue'
import TerminalPane from './components/TerminalPane.vue'
import Topbar from './components/Topbar.vue'
import StatusFooter from './components/StatusFooter.vue'
import EmptyState from './components/EmptyState.vue'
import FolderView from './components/FolderView.vue'
import CloudSessionPanel from './components/CloudSessionPanel.vue'
import { isCloudStub } from './lib/cloud-session'
import { sessionTitle } from './lib/session-label'
import Onboarding from './components/Onboarding.vue'
import AddFolderDialog from './components/AddFolderDialog.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import ClaudeBootDialog from './components/ClaudeBootDialog.vue'
import NewSessionDialog from './components/NewSessionDialog.vue'
import RemoveWorktreeDialog from './components/RemoveWorktreeDialog.vue'
import NewWorktreeDialog from './components/NewWorktreeDialog.vue'
import NewFolderDialog from './components/NewFolderDialog.vue'
import OpenSubfolderDialog from './components/OpenSubfolderDialog.vue'
import RenameFolderDialog from './components/RenameFolderDialog.vue'
import TrustedHostsDialog from './components/TrustedHostsDialog.vue'
import RenameRepoDialog from './components/RenameRepoDialog.vue'
import MemoryLocationDialog from './components/MemoryLocationDialog.vue'
import MissionsReviewDialog from './components/MissionsReviewDialog.vue'
import SessionMenu from './components/SessionMenu.vue'
import SidebarHiddenPopover from './components/SidebarHiddenPopover.vue'
import FolderMenu from './components/FolderMenu.vue'
import SessionPreview from './components/SessionPreview.vue'
import FolderPreview from './components/FolderPreview.vue'
import CommandPalette from './components/CommandPalette.vue'
import InboxRail from './components/InboxRail.vue'
import McpConfirmOverlay from './components/McpConfirmOverlay.vue'
import ToastStack from './components/ToastStack.vue'
import HelperStack from './components/HelperStack.vue'
import TakeoverHost from './components/TakeoverHost.vue'
import { useThemeStore } from './stores/theme'
import { useSessionsStore } from './stores/sessions'
import { formatWindowTitle } from './stores/attention'
import { useUiStore, SETTINGS_TAB_IDS } from './stores/ui'
import { useHelpersStore, isAgentTerminalPane } from './stores/helpers'
import { useLayoutStore, helperPanelVisible, inboxRailWidthFor } from './stores/layout'
import { useClaudeChangelogStore } from './stores/claudeChangelog'
import { useCompanionStore } from './stores/companion'
import {
  useShortcuts,
  pushScope,
  popScope,
  activeScope,
  createShieldListener,
  type ShortcutBinding
} from './composables/useShortcuts'
import { closeTakeoverBinding, installKeyOrigin } from './lib/takeover-esc'
import { isMac } from './lib/platform'
import { useKeybindingsStore } from './stores/keybindings'
import { useBrowserStore } from './stores/browser'
import { useFolderActions } from './composables/useFolderActions'
import {
  useSessionActions,
  forkKeysGuard,
  type SessionAction
} from './composables/useSessionActions'
import { useSidebarActions } from './composables/useSidebarActions'
import {
  useFolderMenuActions,
  type FolderAction,
  type RepoGroupAction
} from './composables/useFolderMenuActions'
import { notInTextEntry } from './lib/text-entry'
import {
  DESCRIPTOR_BY_ID,
  defaultKeysFor,
  type ShortcutActionId
} from '../../main/keybindings-core'
import {
  useTerminalFocus,
  focusedRegionId,
  focusRegion,
  closeRegion
} from './composables/useTerminalFocus'
import {
  paneRing,
  focusPaneStep,
  togglePaneMaximize,
  closeFocusedPane,
  toggleTerminal,
  type PaneCommandDeps
} from './lib/pane-ring'
import type { Session } from './stores/sessions'
import type { UserProject } from '../../preload'

const { t } = useI18n()

useThemeStore()
const sessions = useSessionsStore()
const ui = useUiStore()
const helpers = useHelpersStore()
const layout = useLayoutStore()
const claudeChangelog = useClaudeChangelogStore()
const companion = useCompanionStore()
// T1 P2: resolved keybindings (defaults ← keybindings.json). Seeded with
// defaults synchronously; `keybindings.init()` (main.ts) loads the file, and
// `useShortcuts` below re-keys its renderer watchers whenever `resolved` changes.
const keybindings = useKeybindingsStore()
const browser = useBrowserStore()
// T564 U1: main events, the native-overlay watcher and the forwarded-chord set (idempotent).
browser.start()
const folderActions = useFolderActions()
// T486 §3.2 / §3.3: the Session menu's and the sidebar header's own functions.
const sessionActions = useSessionActions()
const sidebarActions = useSidebarActions()
// T486 §3.4: the Folder menu's and the repo-group menu's own functions.
const folderMenuActions = useFolderMenuActions()

// T22: any interactive overlay shadows global shortcuts. One aggregate boolean
// (NOT per-surface pushes) so exactly one 'modal' is ever on the stack — the
// palette-over-dialog mutex transition keeps the union true, so we push/pop only
// on the real idle↔overlay edge. `preview` is excluded (decorative, no keys).
//
// The Inbox rail is deliberately ABSENT from this union (T83 S0). It is a column,
// not an overlay: it is on screen essentially always, so listing it here would
// pin the 'modal' scope permanently and kill every global shortcut in the app.
const anyOverlayOpen = computed(
  () =>
    ui.dialog !== null ||
    ui.palette.open ||
    ui.menu.open ||
    ui.folderMenu.open ||
    ui.sidebarHiddenPopover.open
)
watch(anyOverlayOpen, (open) => {
  if (open) pushScope('modal')
  else popScope('modal')
})

/**
 * Arrow-key / Enter sidebar cursor navigation walks `visibleFolders` (the
 * classic tree). Drill-in mode (2026-07-19) shows a different screen at a
 * time and doesn't render that structure, so retrofitting the cursor to
 * follow it is out of scope here — these shortcuts simply no-op while drill
 * mode is on. Click-based navigation through the drill screens (SidebarDrillView)
 * works fully regardless.
 */
function sidebarCursorNavAllowed(): boolean {
  return !sessions.drillModeEnabled
}

watch(
  () => helpers.currentWorktreePath,
  async (wt) => {
    if (wt) await helpers.ensureLoaded(wt)
  },
  { immediate: true }
)

// Out-of-window attention signal (attention-badge spec): the needs-input count in
// the window title + the OS dock/taskbar badge. `immediate` so the base title
// replaces index.html's static one and the badge clears (0) at boot.
watch(
  () => sessions.attentionCount,
  (n) => {
    document.title = formatWindowTitle(n, t('app.name'), t('window.titleAttentionPrefix', { n }))
    window.api.setAttentionBadge(n)
  },
  { immediate: true }
)

/**
 * NO auto-summon — and its absence is deliberate, so don't add one back.
 *
 * This file used to `watch(sessions.actionableInboxCount)` and call
 * `layout.summonInboxRail()` on the rising edge (T83 §5.6). That existed for
 * one reason: a minimized rail rendered nothing but an icon, so an arriving
 * confirm would have been invisible and the rail had to force itself open.
 *
 * The minimized strip now renders the whole fleet as minicards (InboxRail.vue
 * + design.md §7 "Fleet state ring"), so that premise is gone. With the signal
 * preserved at 44px, forcing the layout open stops being a rescue and becomes
 * an interruption — the exact modal behaviour T83 set out to delete.
 * `minimized` and `hidden` are therefore HARD states: the operator put the
 * rail away, and it stays away until the operator brings it back.
 *
 * What did NOT change: sound and OS attention are still emitted at their own
 * source (session-mcp-confirms.ts), the head badge still counts, and
 * `layout.summonInboxRail()` still exists for the OS-notification deep-link
 * (`sessions.ts` → `onNotifyActivateInbox`) — that one is a real operator
 * gesture, not an automatic yank.
 */

let mainDragging: { startX: number; startRatio: number } | null = null

// Inbox-rail drag-resize. The rail is the RIGHTMOST column, so dragging its
// divider left must GROW it — hence `startX - clientX` (the sidebar's handler is
// the mirror image). The store clamps to [260, 440].
let railDragging: { startX: number; startWidth: number } | null = null

function onInboxRailDividerMouseDown(ev: MouseEvent): void {
  ev.preventDefault()
  railDragging = { startX: ev.clientX, startWidth: layout.inboxRailWidth }
  document.addEventListener('mousemove', onInboxRailDividerMouseMove)
  document.addEventListener('mouseup', onInboxRailDividerMouseUp)
}

function onInboxRailDividerMouseMove(ev: MouseEvent): void {
  if (!railDragging) return
  layout.setInboxRailWidth(railDragging.startWidth + (railDragging.startX - ev.clientX))
}

function onInboxRailDividerMouseUp(): void {
  railDragging = null
  document.removeEventListener('mousemove', onInboxRailDividerMouseMove)
  document.removeEventListener('mouseup', onInboxRailDividerMouseUp)
}

function onMainDividerMouseDown(ev: MouseEvent): void {
  const wt = helpers.currentWorktreePath
  if (!wt) return
  ev.preventDefault()
  mainDragging = {
    startX: ev.clientX,
    startRatio: helpers.splitRatioForCurrentWorktree
  }
  document.addEventListener('mousemove', onMainDividerMouseMove)
  document.addEventListener('mouseup', onMainDividerMouseUp)
}

function onMainDividerMouseMove(ev: MouseEvent): void {
  if (!mainDragging) return
  const wt = helpers.currentWorktreePath
  if (!wt) return
  // Approximate available width: window minus a typical sidebar (250px).
  // The setSplitRatio store clamps to [0.4, 0.8] so exact precision isn't
  // required here.
  const totalW = window.innerWidth - 250
  if (totalW < 1) return
  const deltaX = ev.clientX - mainDragging.startX
  const deltaRatio = deltaX / totalW
  helpers.setSplitRatio(wt, mainDragging.startRatio + deltaRatio)
}

function onMainDividerMouseUp(): void {
  mainDragging = null
  document.removeEventListener('mousemove', onMainDividerMouseMove)
  document.removeEventListener('mouseup', onMainDividerMouseUp)
}
/**
 * Shared `terminalFocused` flag — flipped by `TerminalPane.vue` on the
 * xterm-managed element's `focusin`/`focusout` DOM events. Read here by the
 * `session.close` binding's `enabled` precondition so that ⌘W is forwarded
 * to xterm/PTY (where it becomes the editor-level "delete word back"
 * action) instead of clearing the selected session.
 *
 * See `findings/07-shortcuts-palette.md` §2 (matrix row "⌘W") and §8 (xterm
 * focus gotcha) for the rationale; `useTerminalFocus.ts` documents the
 * singleton + DOM-event design.
 */
const { terminalFocused } = useTerminalFocus()

// ── Sidebar resize handle (issue #8) ──────────────────────────────────────
// Mirrors the helper-pane divider mold (onMainDivider* above) but drives an
// absolute pixel width persisted globally in `layout` rather than a per-
// worktree ratio. The store clamps to [200, 480] (design.md §4), so we forward
// the raw `clientX` delta without bounds-checking here.
let sidebarDragStart: { startX: number; startWidth: number } | null = null

function onSidebarDividerMouseDown(ev: MouseEvent): void {
  ev.preventDefault()
  sidebarDragStart = { startX: ev.clientX, startWidth: layout.sidebarWidth }
  document.addEventListener('mousemove', onSidebarDividerMouseMove)
  document.addEventListener('mouseup', onSidebarDividerMouseUp)
}

function onSidebarDividerMouseMove(ev: MouseEvent): void {
  if (!sidebarDragStart) return
  const deltaX = ev.clientX - sidebarDragStart.startX
  layout.setSidebarWidth(sidebarDragStart.startWidth + deltaX)
}

function onSidebarDividerMouseUp(): void {
  sidebarDragStart = null
  document.removeEventListener('mousemove', onSidebarDividerMouseMove)
  document.removeEventListener('mouseup', onSidebarDividerMouseUp)
}

const showOnboarding = computed(() => sessions.folders.length === 0)
// T212: a selected FOLDER renders its own view. It ranks BELOW the takeovers
// (see `showTerminalForeground`'s priority, BUG-103), so opening the Roadmap
// board from a folder shows the board, and closing it returns here — the
// folder selection was never lost.
const showFolder = computed(() => !showOnboarding.value && !!sessions.selectedFolderPath)
const showEmpty = computed(
  () => !showOnboarding.value && !sessions.selectedId && !sessions.selectedFolderPath
)
const showSession = computed(() => !showOnboarding.value && sessions.selectedId)
// T80 S1 / T297 U2 (T299): the six main-pane takeovers are born from ONE
// registry-backed `ui.activeView` now (see `stores/ui.ts`'s `VIEW_REGISTRY`),
// not six independent open flags — but the per-view onboarding gate below is
// unchanged from before that refactor: `roadmap`/`prStack`/`review` are
// repo-or-folder-scoped (dead weight with no folder pinned yet), the other
// three are global and render even during onboarding. BUG-102: every
// session-focus path (select, mint, fork, folder terminal) routes through
// `sessions.select()`, which already calls `ui.closeAllTakeovers()` — so
// whichever of these is open closes at the source, with no App-level watcher
// needed to rescue it after the fact.
const showRoadmap = computed(() => !showOnboarding.value && ui.activeView?.id === 'roadmap')
// T47 P6 S2: the Usage Dashboard takeover, opened from the footer fleet pill's
// "Open full dashboard" link. Global (not per-repo/folder), so no onboarding
// gate — it's only ever open via an explicit user action.
const showUsageDashboard = computed(() => ui.activeView?.id === 'usageDashboard')
// T127 S2: the System Monitor takeover, opened via `ui.openSystemMonitor()`.
// Same shape as `showUsageDashboard` — global, no onboarding gate.
const showSystemMonitor = computed(() => ui.activeView?.id === 'systemMonitor')
// Reaper PR3: the Cleanup takeover, opened via `ui.openCleanup()`.
// Same shape as `showUsageDashboard` — global, no onboarding gate.
const showCleanup = computed(() => ui.activeView?.id === 'cleanup')
// T295: the Scheduler takeover, opened via `ui.openScheduler()`. Same shape as
// `showUsageDashboard` — global (a worker names its own folder), no onboarding gate.
const showScheduler = computed(() => ui.activeView?.id === 'scheduler')
// T331: the Containers takeover, opened from its footer pill. Global like
// Cleanup (every docker stack on the machine), so no onboarding gate.
const showContainers = computed(() => ui.activeView?.id === 'containers')
// T198: the PR Stack Canvas takeover, opened from the folder menu. Per-repo
// like the roadmap board, so it takes the same onboarding gate.
const showPrStack = computed(() => !showOnboarding.value && ui.activeView?.id === 'prStack')
// T164: the Review takeover, opened for a folder (a worktree/branch) with an
// optional bound card. Per-folder like the roadmap board, so it takes the same
// onboarding gate. Session-select dismissal and Esc come from the shared
// `closeAllTakeovers` — the mutex it joins in `stores/ui.ts`.
const showReview = computed(() => !showOnboarding.value && ui.activeView?.id === 'review')
/**
 * Whether ANY of the seven takeovers should render right now — the single `v-if`
 * `<TakeoverHost />` sits behind (T297/T299). One boolean, not a `v-else-if`
 * chain: the seven are mutually exclusive by construction (`ui.activeView` can
 * only ever be one id), so an OR of the seven per-view gates above is exactly
 * equivalent to the branch chain it replaces, onboarding gate included.
 *
 * NOTE (T295): this OR is still hand-kept — `VIEW_REGISTRY` (stores/ui.ts)
 * does not (yet) drive it, despite that file's own claim that registering a
 * view is the only thing a new takeover needs. Adding `scheduler` here is
 * exactly the "App.vue branch left to remember" that comment says doesn't
 * exist; a future cleanup could fold this into `ui.anyTakeoverOpen` if the
 * per-view onboarding gates (`showRoadmap`/`showPrStack`/`showReview`) move
 * into the registry too.
 */
const showActiveView = computed(
  () =>
    showCleanup.value ||
    showReview.value ||
    showPrStack.value ||
    showUsageDashboard.value ||
    showSystemMonitor.value ||
    showScheduler.value ||
    showContainers.value ||
    showRoadmap.value
)
/**
 * The selected session is a cloud/bridge stub with no local transcript to
 * resume — render `CloudSessionPanel` instead of `TerminalPane` so we never
 * spawn a doomed `claude --resume` (which ends with "No conversation found …").
 * A session whose terminal is alive in this app run never qualifies (BUG-198 G1:
 * a fresh session's JSONL briefly reads zero-turn), and "Resume anyway" lifts it.
 * Folder terminals ARE resumable (a shell is its own live process), so the
 * `!isShellTerminal` clause is defence-in-depth: a terminal must always render
 * in `TerminalPane`, never the cloud panel, even if `resumable` ever flips.
 */
const showCloudSession = computed(() =>
  isCloudStub(sessions.selectedSession, sessions.isSessionLive(sessions.selectedId ?? ''))
)

/**
 * Whether the right helper panel + its divider render (design.md §6 — Colapsar
 * sidebars). Composes the existing auto-show (`hasHelpersForCurrentWorktree`)
 * with the manual `helperCollapsed` override, so a collapsed panel stays hidden
 * even while the worktree has panes. When collapsed-with-panes the Topbar's
 * panel-toggle button remains the reopen affordance (it's gated on `hasHelpers`,
 * which stays true while collapsed).
 */
const showHelper = computed(() =>
  helperPanelVisible(helpers.hasHelpersForCurrentWorktree, layout.helperCollapsed)
)

/**
 * Whether the helper stack renders ALONGSIDE the current main-content view.
 * The Roadmap board and the terminal are the only two views a doc/session pane
 * makes sense next to — Usage Dashboard/Onboarding/Empty stay pure takeovers
 * (design.md §6). `showTerminal` mirrors the final `v-else-if="showSession"`
 * branch below (session shown as a live terminal, not the cloud-stub panel).
 */
const showTerminal = computed(() => Boolean(showSession.value) && !showCloudSession.value)
/**
 * BUG-103: `TerminalPane` now renders UNCONDITIONALLY (see the main-content
 * view template below) instead of being the tail of a `v-else-if` chain, so
 * the background agent-boot-queue drain it owns (its own `onMounted` +
 * `watch(sessions.agentBootQueue.length)`) keeps running no matter which view
 * currently covers the screen. This computed is what used to be implicit in
 * "which `v-else-if` branch wins" — whether the terminal is the FOREGROUND
 * (visible, interactive) layer right now, vs. rendered-but-hidden underneath
 * whichever view is covering it. It mirrors the exact priority the old chain
 * encoded (takeover > onboarding > folder > empty > cloud session > terminal)
 * as ANDs instead of removed branches, because `showTerminal` (a session is
 * selected and it isn't a cloud stub) no longer implies "nothing else is
 * covering it" — a takeover can now be open at the same time a session is
 * selected, which is exactly BUG-103's failure mode. `showTerminal` already
 * implies `!showOnboarding` (via `showSession`) and a truthy `selectedId`
 * (which makes `showEmpty` false), so only `showActiveView` and `showFolder`
 * need to be excluded explicitly here.
 */
const showTerminalForeground = computed(
  () => showTerminal.value && !showActiveView.value && !showFolder.value
)
/**
 * BUG-103 companion fix: since `TerminalPane` no longer unmounts when a
 * takeover/folder/etc. covers it, a focused xterm helper textarea would
 * otherwise keep DOM focus (and keep receiving keystrokes) after its layer
 * goes invisible — unmounting used to blur it as a side effect for free. The
 * host wrapper's `:inert` binding (below, in the template) is the primary
 * fix for this — `inert` removes the whole subtree from sequential focus
 * navigation AND the accessibility tree in one native attribute, in browsers
 * that implement it (Electron's bundled Chromium does). This watch is kept
 * as an explicit backstop: it is what our own jsdom-based test suite relies
 * on (jsdom does not implement `inert` — see
 * `tests/terminal-pane-always-mounted.test.ts`'s docblock), and it is
 * harmless defense-in-depth in the real app regardless of exactly how
 * reliably a given Chromium version blurs an already-focused descendant the
 * instant its ancestor becomes inert. `.xterm` is the same selector
 * `isTextEntryTarget()` above already uses to recognize xterm's own hidden
 * input, kept out of the generic text-entry check.
 */
watch(showTerminalForeground, (foreground) => {
  if (foreground) return
  const active = document.activeElement as HTMLElement | null
  if (active?.closest('.xterm')) active.blur()
})
// T212: the Folder View joins the views a pane makes sense next to — without it,
// "Browse files" with a folder selected opens a pane that never renders.
// T245 (AC-1): so does the Review pane. A session beside the diff is the whole
// point of the companion — the review has to be one of the views a pane can
// stand next to, or the pane it opens is invisible.
const showHelperStack = computed(
  () =>
    showHelper.value &&
    (showRoadmap.value || showTerminal.value || showFolder.value || showReview.value)
)

/**
 * The Inbox rail renders unless it's `hidden` — it is fleet-global, so unlike the
 * helper stack it does NOT depend on the selected session/worktree (that's the
 * whole point: you must see a blocked session while looking at another folder).
 * Suppressed during Onboarding only, where there is no fleet to have a queue for.
 */
const showInboxRail = computed(() => !showOnboarding.value && layout.inboxRailState !== 'hidden')
// The rail's full header (order toggle, filter, "Show all") renders only here —
// the minimized strip and the hidden rail have none of those buttons.
const inboxRailExpanded = computed(
  () => showInboxRail.value && layout.inboxRailState === 'expanded'
)
const inboxRailPx = computed(() => inboxRailWidthFor(layout.inboxRailState, layout.inboxRailWidth))

// Reveal-on-appear: spawning the first pane into an empty worktree (Split, fork,
// "open in new tab") clears a stale `helperCollapsed` so the freshly-created
// pane is never born invisible. Fires only on the false→true edge, so a manual
// collapse while panes already exist sticks (no re-reveal on the same worktree).
watch(
  () => helpers.hasHelpersForCurrentWorktree,
  (has, prev) => {
    if (has && !prev) layout.setHelperCollapsed(false)
  }
)

// Reveal-on-pane-add (BUG-29, BUG-186): a pane of ANY origin landing in — or
// re-focused by a dedup hit in — the folder already visible never crosses the
// false→true edge above when the stack already has panes, so a collapsed panel
// would swallow it with zero signal. `helpers.paneRevealTick` is bumped only
// for that visible-folder case (`revealIfVisible` in the helpers store) — any
// change un-collapses. Hydration, folder switches and terminal output never
// bump it, and a manual collapse afterwards sticks until the next add.
watch(
  () => helpers.paneRevealTick,
  () => layout.setHelperCollapsed(false)
)

/**
 * Resolve the most recently modified session across every project / worktree.
 * Used by the `session.resumeLast` shortcut — picks the top of `allSessions`
 * sorted by ISO `modified` desc. Returns `null` when no sessions exist (the
 * shortcut becomes a silent no-op in that case).
 */
function mostRecentSession(): Session | null {
  let best: Session | null = null
  for (const s of sessions.allSessions) {
    // "Resume last session" is about Claude sessions — skip folder terminals.
    if (s.isShellTerminal) continue
    if (!best || s.modified > best.modified) best = s
  }
  return best
}

/**
 * Action handlers registered against the shortcut dispatch table. Each entry
 * here is the renderer-side counterpart to a menu accelerator emitted by
 * `src/main/menu.ts`. The OS menu emits `shortcut:fired` for these IDs at the
 * OS level (so xterm.js cannot intercept), and the renderer ALSO binds the
 * same chord via `useMagicKeys` (the `keys` field) as defensive double-bind
 * in case the menu fails to fire — e.g. on Linux WMs that drop accelerators,
 * or under HMR where the menu briefly detaches.
 *
 * The action IDs match the `ShortcutActionId` union in `keybindings-core.ts`
 * 1:1. `app.reload`, `app.devtools`, `app.fullscreen`, and `app.quit` are NOT
 * listed here — they're handled directly in the main process (see menu.ts
 * `click:` blocks) and the renderer has nothing useful to add. `app.openKeybindings`
 * IS listed (T1 P5): it is reserved, but opening a helper pane is renderer work,
 * so the menu item / ⌘⌥K chord routes here.
 *
 * Every `keys:` below comes from `kb(id)` — the resolved (override-aware) chord
 * from the keybindings store, which is seeded with the canonical defaults from
 * `keybindings-core.ts` so this is correct even before `keybindings.json` loads.
 * The second argument to `useShortcuts` keeps the renderer-level chord watchers
 * re-keyed as overrides change at runtime.
 */
/**
 * `enabled` + `handler` for a Session-menu action on the SELECTED session:
 * enabled only when the menu would show that item for it (§3.10).
 */
function onSelected(action: SessionAction): { enabled: () => boolean; handler: () => void } {
  return {
    enabled: () => sessionActions.selectedFor(action) !== null,
    handler: () => {
      const id = sessionActions.selectedFor(action)
      if (id) sessionActions.run[action](id)
    }
  }
}

/**
 * `enabled` + `handler` for a Folder-menu action on the ACTIVE folder: enabled
 * only when the menu would show that item for it (§3.10).
 */
function onActiveFolder(action: FolderAction): { enabled: () => boolean; handler: () => void } {
  return {
    enabled: () => folderMenuActions.activeFor(action) !== null,
    handler: () => {
      const path = folderMenuActions.activeFor(action)
      if (path) folderMenuActions.run[action](path)
    }
  }
}

/**
 * `enabled` + `handler` for a repo-group menu action on the cursor's group row,
 * else the group holding the active folder (§3.10).
 */
function onGroup(action: RepoGroupAction): { enabled: () => boolean; handler: () => void } {
  return {
    enabled: () => folderMenuActions.groupFor(action) !== null,
    handler: () => {
      const group = folderMenuActions.groupFor(action)
      if (group) folderMenuActions.group[action](group)
    }
  }
}

// T486 §6.1 — records where each key press starts (window capture, ahead of every
// field), so `view.closeTakeover`'s key guard can tell an Esc typed in a text field
// even when that field blurs itself on Esc before the binding runs.
onUnmounted(installKeyOrigin())

/**
 * T486 U5b — what the pane commands (`lib/pane-ring.ts`) act through: the ring
 * over what is on screen, the pane-focus registry, and the helpers / layout / ui
 * stores. `afterRender` waits a tick, so a pane revealed or restored by the same
 * command is mounted (and registered) before it is focused.
 */
const paneDeps: PaneCommandDeps = {
  ring: () =>
    paneRing({
      mainForeground: showTerminalForeground.value,
      stackShown: showHelperStack.value,
      helperCollapsed: layout.helperCollapsed,
      paneIds: helpers.panesForCurrentWorktree.map((p) => p.id),
      maximizedId: helpers.maximizedPaneIdForCurrentWorktree
    }),
  current: () => focusedRegionId(),
  focus: (id) => void focusRegion(id),
  close: (id) => closeRegion(id),
  worktree: () => helpers.currentWorktreePath,
  panes: () =>
    helpers.panesForCurrentWorktree.map((p) => ({
      id: p.id,
      type: p.type,
      agentOwned: isAgentTerminalPane(p)
    })),
  maximizedId: () => helpers.maximizedPaneIdForCurrentWorktree,
  toggleMaximize: (wt, id) => helpers.toggleMaximizePane(wt, id),
  addShell: (wt) => void helpers.addShellHelper(wt, wt),
  setHelperCollapsed: (collapsed) => layout.setHelperCollapsed(collapsed),
  // §8.2: Roadmap and Review host the helper stack; any other takeover covers it.
  closeCoveringTakeover: () => {
    const view = ui.activeView?.id
    if (view && view !== 'roadmap' && view !== 'review') ui.closeAllTakeovers()
  },
  blur: () => (document.activeElement as HTMLElement | null)?.blur(),
  afterRender: (fn) => void nextTick(fn)
}

function kb(id: ShortcutActionId): string | undefined {
  return keybindings.chordFor(id) ?? defaultKeysFor(DESCRIPTOR_BY_ID[id], isMac) ?? undefined
}

useShortcuts(
  [
    {
      id: 'session.new',
      scope: 'global',
      keys: kb('session.new'),
      // U-1.5: spawn a synthetic session entry whose terminal pane will run
      // `claude` (no args) in the resolved worktree's cwd. The store helper
      // picks the worktree of the current selection, falling back to the main
      // worktree of the first project. CommandPalette's `session.new` action
      // calls the same helper so the two routes stay in lockstep. Silent
      // no-op (with a console.warn) when the sidebar is empty.
      handler: () => {
        sessions.newSessionInCurrentContext()
      }
    },
    {
      id: 'app.search',
      scope: 'global',
      keys: kb('app.search'),
      handler: () => ui.openPalette()
    },
    {
      // T1 P5 — open keybindings.json in a MarkdownPane helper pane. Reserved
      // (its chord can't be rebound), but the open is renderer work. The native
      // View → "Open keybindings.json" item emits the same id over `shortcut:fired`.
      id: 'app.openKeybindings',
      scope: 'global',
      keys: kb('app.openKeybindings'),
      handler: () => keybindings.openInEditor()
    },
    {
      id: 'inbox.toggle',
      scope: 'global',
      keys: kb('inbox.toggle'),
      // Expand/minimize the Inbox rail (T83 §5.6). Same helper the Topbar button +
      // the palette action call. Never hides the rail — see `nextInboxRailStateOnToggle`.
      handler: () => layout.toggleInboxRail()
    },
    {
      id: 'view.fleetRail',
      scope: 'global',
      keys: kb('view.fleetRail'),
      // T153: the sidebar's folders↔board toggle was removed — retarget this
      // shortcut to the Fleet rail (same helper `⌘⇧A`/`inbox.toggle` calls).
      handler: () => layout.toggleInboxRail()
    },
    // --- T486 §3.5: the Fleet rail's header buttons and the Topbar / footer
    // popovers. Unbound. Each runs its button's own call; a popover is enabled
    // only while its button is rendered (it anchors there), and its open flag
    // lives in the ui store, so the popover's own Esc still closes it.
    {
      // Expand (never toggle) — the minimized strip's button and "Open approvals".
      id: 'inbox.open',
      scope: 'global',
      keys: kb('inbox.open'),
      handler: () => layout.setInboxRailState('expanded')
    },
    {
      // Its button is in the expanded rail's header only.
      id: 'inbox.toggleOrder',
      scope: 'global',
      keys: kb('inbox.toggleOrder'),
      enabled: () => inboxRailExpanded.value,
      handler: () => layout.toggleInboxRailOrder()
    },
    {
      id: 'inbox.filter',
      scope: 'global',
      keys: kb('inbox.filter'),
      enabled: () => ui.popoverAnchors.inboxFilter,
      handler: () => ui.togglePopover('inboxFilter')
    },
    {
      // The "Show all" buttons render only in the expanded rail, while a state
      // is filtered out.
      id: 'inbox.showAll',
      scope: 'global',
      keys: kb('inbox.showAll'),
      enabled: () => inboxRailExpanded.value && layout.inboxRailHiddenStates.size > 0,
      handler: () => layout.clearInboxRailStateFilter()
    },
    {
      id: 'view.activity',
      scope: 'global',
      keys: kb('view.activity'),
      enabled: () => ui.popoverAnchors.activity,
      handler: () => ui.togglePopover('activity')
    },
    {
      id: 'view.missionProgress',
      scope: 'global',
      keys: kb('view.missionProgress'),
      enabled: () => ui.popoverAnchors.missionProgress,
      handler: () => ui.togglePopover('missionProgress')
    },
    {
      id: 'view.pastedImages',
      scope: 'global',
      keys: kb('view.pastedImages'),
      enabled: () => ui.popoverAnchors.pastedImages,
      handler: () => ui.togglePopover('pastedImages')
    },
    {
      id: 'view.claudeStatus',
      scope: 'global',
      keys: kb('view.claudeStatus'),
      enabled: () => ui.popoverAnchors.claudeStatus,
      handler: () => ui.togglePopover('claudeStatus')
    },
    {
      id: 'view.usagePanel',
      scope: 'global',
      keys: kb('view.usagePanel'),
      enabled: () => ui.popoverAnchors.usagePanel,
      handler: () => ui.togglePopover('usagePanel')
    },
    {
      id: 'view.toggleSidebar',
      scope: 'global',
      // Collapse/expand the left folder/session sidebar ("full screen for the
      // terminal"). ⌘B / Ctrl+B, mirroring VS Code's primary-sidebar toggle.
      // Owned by the OS menu (menu.ts `&View`) so the accelerator is consumed
      // BEFORE xterm sees it — ⌘/Ctrl chords bound at the menu level are the
      // only ones the terminal pane can't intercept (see menu.ts header). This
      // `keys` entry is the defensive renderer fallback for WMs that drop the
      // accelerator, exactly like `session.new` / `app.search`.
      keys: kb('view.toggleSidebar'),
      handler: () => layout.toggleSidebar()
    },
    {
      id: 'view.toggleHelper',
      scope: 'global',
      // Collapse/expand the right helper panel (VS Code's "secondary side bar"
      // → ⌘⌥B / Ctrl+Alt+B). Same OS-menu-owned + renderer-fallback shape as
      // above. No-op visually when the worktree has no panes; the flag still
      // flips and takes effect once panes exist.
      keys: kb('view.toggleHelper'),
      handler: () => layout.toggleHelper()
    },
    {
      // Session navigation history (docs/specs/2026-10-06-session-nav-history.md
      // §5.4), rebindable since T486 U5a. Shielded: the shield listener below is
      // the only key path (no `useMagicKeys` watcher). Off macOS it only stops the
      // chord, and the OS menu (menu.ts `&Session`) dispatches; on macOS the
      // shield dispatches itself. The mouse side buttons are wired separately
      // (`onNavMouseButton`).
      id: 'nav.back',
      scope: 'global',
      keys: kb('nav.back'),
      handler: () => sessions.goBack()
    },
    {
      id: 'nav.forward',
      scope: 'global',
      keys: kb('nav.forward'),
      handler: () => sessions.goForward()
    },
    // T486 §3.7 / §8 — the pane focus ring. F6 / ⇧F6 and the terminal toggle are
    // shielded: the shield listener below is their only key path, so they work
    // from inside a terminal (and from a text field). Inert under `'modal'`.
    {
      id: 'pane.focusNext',
      scope: 'global',
      keys: kb('pane.focusNext'),
      handler: () => focusPaneStep(paneDeps, 1)
    },
    {
      id: 'pane.focusPrev',
      scope: 'global',
      keys: kb('pane.focusPrev'),
      handler: () => focusPaneStep(paneDeps, -1)
    },
    {
      // ⌘⇧M / Ctrl+Shift+M — bubbles out of xterm, so no shield is needed.
      id: 'pane.toggleMaximize',
      scope: 'global',
      keys: kb('pane.toggleMaximize'),
      handler: () => togglePaneMaximize(paneDeps)
    },
    {
      // Unbound. Runs the focused pane's own close (discard guards hold).
      id: 'pane.close',
      scope: 'global',
      keys: kb('pane.close'),
      handler: () => closeFocusedPane(paneDeps)
    },
    {
      // Unbound. Add → reveal and focus → collapse the first shell pane (§8.2);
      // Split ▸ New shell (`folder.newTerminal`) still always appends one.
      id: 'terminal.toggle',
      scope: 'global',
      keys: kb('terminal.toggle'),
      enabled: () => !!helpers.currentWorktreePath,
      handler: () => toggleTerminal(paneDeps)
    },
    {
      id: 'project.switch',
      scope: 'global',
      keys: kb('project.switch'),
      // v1: open the plain palette. v1.1 will pre-fill `>p ` so the palette
      // filters to the Projects section per finding 07 §2.
      handler: () => ui.openPalette()
    },
    {
      id: 'folder.add',
      scope: 'global',
      keys: kb('folder.add'),
      handler: () => ui.openDialog('addFolder')
    },
    {
      // T164 — review the active folder's branch. PRD §9 Q3 (where the "review
      // this branch" affordance lives) was answered at the screen and NOT with
      // the row/folder menus: the pane is reached from the Topbar's per-repo
      // takeover row and from each PR Stack card, both of which are already
      // branch-scoped the way the pane is (PRD D2). All three call the same door.
      id: 'view.review',
      scope: 'global',
      keys: kb('view.review'),
      enabled: () => !!sessions.activeFolderPath,
      handler: () => {
        const folder = sessions.activeFolderPath
        if (folder) ui.toggleReview(folder)
      }
    },
    // The Topbar's per-folder actions (roadmap board, PR Stack, open folder,
    // VS Code, GitHub pulls, Browse files, terminal). They ship with no default
    // chord — `kb()` is `undefined` until the user binds one — and run the same
    // `useFolderActions` code as the Topbar buttons. Each no-ops with no active
    // folder.
    {
      id: 'view.roadmap',
      scope: 'global',
      keys: kb('view.roadmap'),
      enabled: () => !!sessions.activeFolderPath,
      handler: () => folderActions.toggleRoadmap()
    },
    {
      id: 'view.prStack',
      scope: 'global',
      keys: kb('view.prStack'),
      enabled: () => !!sessions.activeFolderPath,
      handler: () => folderActions.togglePrStack()
    },
    {
      id: 'folder.openInFileManager',
      scope: 'global',
      keys: kb('folder.openInFileManager'),
      enabled: () => !!sessions.activeFolderPath,
      handler: () => folderActions.openInFileManager()
    },
    {
      id: 'folder.openInVSCode',
      scope: 'global',
      keys: kb('folder.openInVSCode'),
      enabled: () => !!sessions.activeFolderPath,
      handler: () => folderActions.openInVSCode()
    },
    {
      id: 'folder.openGithubPulls',
      scope: 'global',
      keys: kb('folder.openGithubPulls'),
      enabled: () => !!sessions.activeFolderPath,
      handler: () => folderActions.openGithubPulls()
    },
    {
      id: 'folder.browseFiles',
      scope: 'global',
      keys: kb('folder.browseFiles'),
      enabled: () => !!sessions.activeFolderPath,
      handler: () => folderActions.browseFiles()
    },
    {
      id: 'folder.newTerminal',
      scope: 'global',
      keys: kb('folder.newTerminal'),
      enabled: () => !!sessions.activeFolderPath,
      handler: () => folderActions.newTerminal()
    },
    {
      // ⌘, / Ctrl+, — opens Settings on its default tab. While the dialog is up
      // it holds the `'modal'` scope, so a second press is inert (Esc closes).
      id: 'view.settings',
      scope: 'global',
      keys: kb('view.settings'),
      handler: () => ui.openSettings()
    },
    // T486 §3.5 — one id per Settings tab, generated from `SETTINGS_TAB_IDS` so a
    // new tab cannot ship without one. Only Keyboard Shortcuts is bound (⌘⌥S /
    // Ctrl+Alt+S, its native menu item emits the same id). With Settings already
    // open the `'modal'` scope blocks them: the dialog reads its tab only on open.
    ...SETTINGS_TAB_IDS.map((tab): ShortcutBinding => ({
      id: `view.settings.${tab}`,
      scope: 'global',
      keys: kb(`view.settings.${tab}`),
      handler: () => ui.openSettings(tab)
    })),
    {
      // Toggles the Usage Dashboard takeover — same gesture as the Topbar's
      // per-repo views. No default chord.
      id: 'view.usageDashboard',
      scope: 'global',
      keys: kb('view.usageDashboard'),
      handler: () => ui.toggleUsageDashboard()
    },
    // T486 §3.6 — Esc closes the open takeover exactly like its X (§6.1). Off
    // while a footer / Topbar popover is open (its own Esc closes it first), and
    // a press made in a text field is left to the field. Dialogs, palettes,
    // menus and the takeovers' own state take Esc before it in capture.
    {
      id: 'view.closeTakeover',
      scope: 'global',
      keys: kb('view.closeTakeover'),
      ...closeTakeoverBinding(ui)
    },
    // The footer takeovers' own toggles (the Cleanup and Scheduler pills, the heap
    // gauge; Containers has no button since T443). Unbound.
    {
      id: 'view.cleanup',
      scope: 'global',
      keys: kb('view.cleanup'),
      handler: () => ui.toggleCleanup()
    },
    {
      id: 'view.scheduler',
      scope: 'global',
      keys: kb('view.scheduler'),
      handler: () => ui.toggleScheduler()
    },
    {
      id: 'view.systemMonitor',
      scope: 'global',
      keys: kb('view.systemMonitor'),
      handler: () => ui.toggleSystemMonitor()
    },
    {
      id: 'view.containers',
      scope: 'global',
      keys: kb('view.containers'),
      handler: () => ui.toggleContainers()
    },
    {
      id: 'session.resumeLast',
      scope: 'global',
      keys: kb('session.resumeLast'),
      handler: () => {
        const target = mostRecentSession()
        if (target) sessions.select(target.sessionId)
      }
    },
    {
      id: 'session.rename',
      scope: 'global',
      // Defensive double-bind: the OS menu owns Cmd+R (and reroutes Electron's
      // default reload to F5), but we also bind it in the renderer in case a
      // webview-controlled element swallows the menu accelerator. The store
      // flips `requestRenameFocus`, the Topbar watches and focuses the title.
      keys: kb('session.rename'),
      enabled: () => !!sessions.selectedId,
      handler: () => ui.triggerRenameFocus()
    },
    {
      id: 'session.close',
      scope: 'global',
      keys: kb('session.close'),
      // T-4.5: suppress when the xterm pane currently owns focus so the
      // keystroke falls through to xterm.js, which sends `\u0017` (Ctrl+W)
      // to the PTY. Programs like `nano` listen for that to delete the word
      // before the cursor — overriding it at the app level would break
      // muscle memory inside the terminal. When the sidebar or topbar own
      // focus, this binding does fire and the selection is cleared.
      enabled: () => !!sessions.selectedId && !terminalFocused.value,
      // Clears the selection (back to the empty/idle pane). We do NOT
      // delete the session — the JSONL on disk and the sessions store
      // model entry stay intact; ⌘W is "close current tab", not "delete".
      handler: () => sessions.clearSelection()
    },
    // --- T486 §3.2: the Session menu's items, on the SELECTED session. ---
    // Unbound by default. Each runs the menu item's own function and is
    // enabled only when the menu would show that item for the selection
    // (`sessionActionVisible`). A key press from a text field is left alone.
    {
      id: 'session.newInFolder',
      scope: 'global',
      keys: kb('session.newInFolder'),
      keysGuard: notInTextEntry,
      enabled: () => !!sessions.activeFolderPath,
      handler: () => {
        const folder = sessions.activeFolderPath
        if (folder) ui.openNewSession(folder)
      }
    },
    {
      id: 'session.fork',
      scope: 'global',
      keys: kb('session.fork'),
      // Also yields inside the Diagram pane, whose own ⌘D duplicates (§3.10).
      keysGuard: forkKeysGuard,
      ...onSelected('fork')
    },
    {
      // ⌘↩ / Ctrl+↩ — the cursor's session row, else the selection (§3.10).
      id: 'session.openToSide',
      scope: 'global',
      keys: kb('session.openToSide'),
      keysGuard: notInTextEntry,
      enabled: () => sessionActions.openToSideTarget() !== null,
      handler: () => {
        const id = sessionActions.openToSideTarget()
        if (id) sessionActions.run.openToSide(id)
      }
    },
    {
      // ⇧F10 — the Session or Folder menu for the cursor row, else the
      // selection, else the active folder, anchored at the row (§8.3).
      id: 'session.contextMenu',
      scope: 'global',
      keys: kb('session.contextMenu'),
      keysGuard: notInTextEntry,
      enabled: () => sessionActions.contextMenuEnabled(),
      handler: () => sessionActions.openContextMenu()
    },
    {
      id: 'session.restart',
      scope: 'global',
      keys: kb('session.restart'),
      keysGuard: notInTextEntry,
      ...onSelected('restart')
    },
    {
      id: 'session.copyId',
      scope: 'global',
      keys: kb('session.copyId'),
      keysGuard: notInTextEntry,
      ...onSelected('copyId')
    },
    {
      id: 'session.copyTranscriptPath',
      scope: 'global',
      keys: kb('session.copyTranscriptPath'),
      keysGuard: notInTextEntry,
      ...onSelected('copyTranscriptPath')
    },
    {
      id: 'session.copyResumeCommand',
      scope: 'global',
      keys: kb('session.copyResumeCommand'),
      keysGuard: notInTextEntry,
      ...onSelected('copyResumeCommand')
    },
    {
      id: 'session.copyContextDigest',
      scope: 'global',
      keys: kb('session.copyContextDigest'),
      keysGuard: notInTextEntry,
      ...onSelected('copyContextDigest')
    },
    {
      id: 'session.toggleNoFlicker',
      scope: 'global',
      keys: kb('session.toggleNoFlicker'),
      keysGuard: notInTextEntry,
      ...onSelected('toggleNoFlicker')
    },
    {
      id: 'session.toggleArchived',
      scope: 'global',
      keys: kb('session.toggleArchived'),
      keysGuard: notInTextEntry,
      ...onSelected('toggleArchived')
    },
    {
      id: 'session.delete',
      scope: 'global',
      keys: kb('session.delete'),
      keysGuard: notInTextEntry,
      ...onSelected('delete')
    },
    {
      id: 'session.retryBoot',
      scope: 'global',
      keys: kb('session.retryBoot'),
      keysGuard: notInTextEntry,
      ...onSelected('retryBoot')
    },
    {
      id: 'session.dismiss',
      scope: 'global',
      keys: kb('session.dismiss'),
      keysGuard: notInTextEntry,
      ...onSelected('dismiss')
    },
    {
      // The folder terminal row's X (SidebarFolder.vue), on the selected terminal.
      id: 'session.closeTerminal',
      scope: 'global',
      keys: kb('session.closeTerminal'),
      keysGuard: notInTextEntry,
      enabled: () => sessions.selectedSession?.isShellTerminal === true,
      handler: () => {
        const id = sessions.selectedId
        if (id) sessions.closeFolderTerminal(id)
      }
    },
    // --- T486 §3.3: the sidebar header's buttons. ---
    {
      // ⌘⇧F / Ctrl+Shift+F — toggles like the search button. No keysGuard on
      // purpose: the second press must close the palette while its own input
      // holds focus. Expands a collapsed sidebar first (`toggleJump`).
      id: 'sidebar.jump',
      scope: 'global',
      keys: kb('sidebar.jump'),
      handler: () => sidebarActions.toggleJump()
    },
    {
      id: 'sidebar.rescan',
      scope: 'global',
      keys: kb('sidebar.rescan'),
      keysGuard: notInTextEntry,
      enabled: () => sessions.folders.length > 0,
      handler: () => sidebarActions.rescan()
    },
    {
      id: 'sidebar.cycleDrillDepth',
      scope: 'global',
      keys: kb('sidebar.cycleDrillDepth'),
      keysGuard: notInTextEntry,
      enabled: () => sessions.folders.length > 0,
      handler: () => sessions.cycleDrillDepth()
    },
    {
      id: 'sidebar.toggleCollapseAll',
      scope: 'global',
      keys: kb('sidebar.toggleCollapseAll'),
      keysGuard: notInTextEntry,
      // The button is hidden at the deepest drill level.
      enabled: () => sessions.folders.length > 0 && sessions.drillDepth < 2,
      handler: () => sidebarActions.toggleCollapseAll()
    },
    {
      id: 'sidebar.hiddenFolders',
      scope: 'global',
      keys: kb('sidebar.hiddenFolders'),
      keysGuard: notInTextEntry,
      enabled: sidebarActions.hiddenFoldersAvailable,
      handler: () => sidebarActions.toggleHiddenFolders()
    },
    // --- Browser pane (T564 U1, spec §2.5). ---
    // `browser`-scope bindings run only from a chord a FOCUSED browser pane forwarded (main swallows the key
    // and hands it over), so each acts on the pane that sent it (`browser.chordPaneId`). Zoom and the overlay
    // toggle have their ids and labels here and are disabled until the zoom (U5) and overlay (U6) units land.
    {
      id: 'browser.back',
      scope: 'browser',
      keys: kb('browser.back'),
      enabled: () => !!browser.chordPaneId,
      handler: () => void browser.navigate(browser.chordPaneId!, { action: 'back' })
    },
    {
      id: 'browser.forward',
      scope: 'browser',
      keys: kb('browser.forward'),
      enabled: () => !!browser.chordPaneId,
      handler: () => void browser.navigate(browser.chordPaneId!, { action: 'forward' })
    },
    {
      id: 'browser.reload',
      scope: 'browser',
      keys: kb('browser.reload'),
      enabled: () => !!browser.chordPaneId,
      handler: () => void browser.navigate(browser.chordPaneId!, { action: 'reload' })
    },
    {
      id: 'browser.focusAddress',
      scope: 'browser',
      keys: kb('browser.focusAddress'),
      enabled: () => !!browser.chordPaneId,
      handler: () => browser.requestFocusAddress(browser.chordPaneId!)
    },
    {
      id: 'browser.devtools',
      scope: 'browser',
      keys: kb('browser.devtools'),
      enabled: () => !!browser.chordPaneId,
      handler: () => void window.api.browserDevtools(browser.chordPaneId!)
    },
    {
      id: 'browser.zoom.in',
      scope: 'browser',
      keys: kb('browser.zoom.in'),
      enabled: () => !!browser.chordPaneId,
      handler: () => void browser.zoom(browser.chordPaneId!, 'in')
    },
    {
      id: 'browser.zoom.out',
      scope: 'browser',
      keys: kb('browser.zoom.out'),
      enabled: () => !!browser.chordPaneId,
      handler: () => void browser.zoom(browser.chordPaneId!, 'out')
    },
    {
      id: 'browser.zoom.reset',
      scope: 'browser',
      keys: kb('browser.zoom.reset'),
      enabled: () => !!browser.chordPaneId,
      handler: () => void browser.zoom(browser.chordPaneId!, 'reset')
    },
    {
      id: 'browser.overlay.toggle',
      scope: 'browser',
      keys: kb('browser.overlay.toggle'),
      enabled: () => !!browser.chordPaneId,
      handler: () => void browser.toggleOverlay(browser.chordPaneId!)
    },
    // --- Sidebar arrow-key navigation (T-4.6). ---
    // The four arrow keys + Enter walk the flattened visible tree
    // (`folders → worktrees → sessions`). Scope stays `'global'` rather than
    // a dedicated `'sidebar'` scope because the bindings naturally no-op when
    // the model is empty, and the alternative — pushing `'sidebar'` on focus
    // — would shadow Cmd+K / Cmd+N which the user still expects to fire
    // while the sidebar has focus. See finding 07 §2 (arrow nav row).
    //
    // The cursor is separate from `selectedId`: arrows only move the visual
    // focus ring, Enter activates (selects a session, toggles a project /
    // worktree). This matches Finder / VS Code's explorer behaviour and keeps
    // the terminal from re-mounting on every keystroke.
    //
    // The store no-ops on `null` cursors and on out-of-tree ids, so the
    // bindings are safe to fire whenever the renderer has focus. ArrowUp /
    // ArrowDown / ArrowLeft / ArrowRight inside the xterm-hosted div get
    // swallowed by xterm before useMagicKeys sees them (xterm calls
    // `preventDefault()` on cursor keys), so the user can still scroll the
    // terminal contents without interference. Inputs inside the palette /
    // dialog push their own scope (`'modal'`), shadowing these.
    //
    // TODO(v1.1): scroll the focused row into view after each cursor move.
    // For now the user must scroll manually; the visible ring is enough to
    // confirm the cursor moved even when off-screen.
    {
      id: 'sidebar.cursor.down',
      scope: 'global',
      keys: kb('sidebar.cursor.down'),
      enabled: sidebarCursorNavAllowed,
      keysGuard: notInTextEntry,
      handler: () => sessions.cursorDown()
    },
    {
      id: 'sidebar.cursor.up',
      scope: 'global',
      keys: kb('sidebar.cursor.up'),
      enabled: sidebarCursorNavAllowed,
      keysGuard: notInTextEntry,
      handler: () => sessions.cursorUp()
    },
    {
      id: 'sidebar.cursor.right',
      scope: 'global',
      keys: kb('sidebar.cursor.right'),
      enabled: sidebarCursorNavAllowed,
      keysGuard: notInTextEntry,
      handler: () => sessions.cursorRight()
    },
    {
      id: 'sidebar.cursor.left',
      scope: 'global',
      keys: kb('sidebar.cursor.left'),
      enabled: sidebarCursorNavAllowed,
      keysGuard: notInTextEntry,
      handler: () => sessions.cursorLeft()
    },
    {
      id: 'sidebar.cursor.activate',
      scope: 'global',
      keys: kb('sidebar.cursor.activate'),
      // Only fire when the cursor is on a row. A key press from a text-entry
      // surface is left alone (T22 — the Topbar inline-rename contenteditable
      // pushes no scope, so scope gating alone wouldn't catch it). The store
      // also no-ops on a null cursor.
      enabled: () => sessions.keyboardCursor !== null && sidebarCursorNavAllowed(),
      keysGuard: notInTextEntry,
      handler: () => sessions.cursorActivate()
    },
    // --- T486 §3.4: the Folder menu's items and the row's peeks, on the ACTIVE
    // folder, and the repo-group menu's. Unbound except F2. Each runs the menu
    // item's own function and is enabled only when the menu would show that
    // item. A key press from a text field is left alone.
    {
      // F2 — the cursor's folder row, else the active folder. A session or
      // group cursor row is a no-op (§3.10).
      id: 'folder.rename',
      scope: 'global',
      keys: kb('folder.rename'),
      keysGuard: notInTextEntry,
      enabled: () => folderMenuActions.renameTarget() !== null,
      handler: () => {
        const path = folderMenuActions.renameTarget()
        if (path) folderMenuActions.run.rename(path)
      }
    },
    {
      id: 'folder.newFolderTerminal',
      scope: 'global',
      keys: kb('folder.newFolderTerminal'),
      keysGuard: notInTextEntry,
      ...onActiveFolder('newFolderTerminal')
    },
    {
      id: 'folder.toggleBranchAlias',
      scope: 'global',
      keys: kb('folder.toggleBranchAlias'),
      keysGuard: notInTextEntry,
      ...onActiveFolder('toggleBranchAlias')
    },
    {
      id: 'folder.bootOptions',
      scope: 'global',
      keys: kb('folder.bootOptions'),
      keysGuard: notInTextEntry,
      ...onActiveFolder('bootOptions')
    },
    {
      id: 'folder.projectMemory',
      scope: 'global',
      keys: kb('folder.projectMemory'),
      keysGuard: notInTextEntry,
      ...onActiveFolder('projectMemory')
    },
    {
      id: 'folder.memoryLocation',
      scope: 'global',
      keys: kb('folder.memoryLocation'),
      keysGuard: notInTextEntry,
      ...onActiveFolder('memoryLocation')
    },
    {
      id: 'folder.newSubfolder',
      scope: 'global',
      keys: kb('folder.newSubfolder'),
      keysGuard: notInTextEntry,
      ...onActiveFolder('newSubfolder')
    },
    {
      id: 'folder.openSubfolder',
      scope: 'global',
      keys: kb('folder.openSubfolder'),
      keysGuard: notInTextEntry,
      ...onActiveFolder('openSubfolder')
    },
    {
      id: 'folder.newWorktree',
      scope: 'global',
      keys: kb('folder.newWorktree'),
      keysGuard: notInTextEntry,
      ...onActiveFolder('newWorktree')
    },
    {
      id: 'folder.worktreeMd',
      scope: 'global',
      keys: kb('folder.worktreeMd'),
      keysGuard: notInTextEntry,
      ...onActiveFolder('worktreeMd')
    },
    {
      id: 'folder.askAgentWorktreeMd',
      scope: 'global',
      keys: kb('folder.askAgentWorktreeMd'),
      keysGuard: notInTextEntry,
      ...onActiveFolder('askAgentWorktreeMd')
    },
    {
      id: 'folder.toggleIntercept',
      scope: 'global',
      keys: kb('folder.toggleIntercept'),
      keysGuard: notInTextEntry,
      ...onActiveFolder('toggleIntercept')
    },
    {
      id: 'folder.toggleAutoOrganize',
      scope: 'global',
      keys: kb('folder.toggleAutoOrganize'),
      keysGuard: notInTextEntry,
      ...onActiveFolder('toggleAutoOrganize')
    },
    {
      id: 'folder.toggleOrchestratorDefault',
      scope: 'global',
      keys: kb('folder.toggleOrchestratorDefault'),
      keysGuard: notInTextEntry,
      ...onActiveFolder('toggleOrchestratorDefault')
    },
    {
      id: 'folder.toggleHidden',
      scope: 'global',
      keys: kb('folder.toggleHidden'),
      keysGuard: notInTextEntry,
      ...onActiveFolder('toggleHidden')
    },
    {
      id: 'folder.removeWorktree',
      scope: 'global',
      keys: kb('folder.removeWorktree'),
      keysGuard: notInTextEntry,
      ...onActiveFolder('removeWorktree')
    },
    {
      id: 'folder.toggleOlder',
      scope: 'global',
      keys: kb('folder.toggleOlder'),
      keysGuard: notInTextEntry,
      ...onActiveFolder('toggleOlder')
    },
    {
      id: 'folder.toggleArchived',
      scope: 'global',
      keys: kb('folder.toggleArchived'),
      keysGuard: notInTextEntry,
      ...onActiveFolder('toggleArchived')
    },
    {
      id: 'repoGroup.rename',
      scope: 'global',
      keys: kb('repoGroup.rename'),
      keysGuard: notInTextEntry,
      ...onGroup('rename')
    },
    {
      id: 'repoGroup.resetName',
      scope: 'global',
      keys: kb('repoGroup.resetName'),
      keysGuard: notInTextEntry,
      ...onGroup('resetName')
    },
    {
      id: 'repoGroup.cleanup',
      scope: 'global',
      keys: kb('repoGroup.cleanup'),
      keysGuard: notInTextEntry,
      ...onGroup('cleanup')
    }
  ],
  () => keybindings.resolved
)

/**
 * Mouse back / forward side buttons (DOM buttons 3 / 4) drive the session
 * navigation history (docs/specs/2026-10-06-session-nav-history.md §5.4).
 *
 * Bound on `window` in the CAPTURE phase so it runs before xterm, which forwards
 * mouse events to the PTY when the TUI enables mouse tracking: every
 * mousedown / mouseup / auxclick of those two buttons is swallowed, so the TUI
 * never receives them. Navigation fires once, on `mouseup`, and only while no
 * overlay holds the `'modal'` scope (the same gate as every global shortcut).
 *
 * Electron's `app-command` (`browser-backward` / `browser-forward`) is
 * deliberately NOT subscribed: Chromium already delivers the side buttons as
 * DOM button 3 / 4 events, and listening to both would navigate twice.
 */
const NAV_MOUSE_EVENTS = ['mousedown', 'mouseup', 'auxclick'] as const
function onNavMouseButton(e: MouseEvent): void {
  if (e.button !== 3 && e.button !== 4) return
  e.preventDefault()
  e.stopPropagation()
  if (e.type !== 'mouseup' || activeScope() !== 'global') return
  if (e.button === 3) sessions.goBack()
  else sessions.goForward()
}
/**
 * The shield (T486 §7.4) — the one window CAPTURE `keydown` listener for every
 * shielded action (`nav.back` / `nav.forward` today). It takes the action's
 * RESOLVED chord before xterm sees it, so a rebind moves it. Electron's
 * views-based windows run a menu accelerator only for a key the page left
 * unhandled and xterm handles `Alt+←/→` (word-jump), so off macOS the shield
 * only stops a menu-backed chord and lets the accelerator dispatch; see
 * `createShieldListener`. Spec D-4: the bound chord no longer reaches the
 * terminal. Stands down while an overlay holds the `'modal'` scope.
 */
const onShieldKeydown = createShieldListener(() => keybindings.resolved)
onMounted(() => {
  for (const type of NAV_MOUSE_EVENTS) window.addEventListener(type, onNavMouseButton, true)
  window.addEventListener('keydown', onShieldKeydown, true)
})
onUnmounted(() => {
  for (const type of NAV_MOUSE_EVENTS) window.removeEventListener(type, onNavMouseButton, true)
  window.removeEventListener('keydown', onShieldKeydown, true)
})

/**
 * Add-folder submit handler (U-2.4).
 *
 * Persists the user's chosen folder + worktree subset to
 * `<userData>/projects.json` via the `userProjects:add` IPC, then triggers
 * `sessions.reloadModel()` so the merge layer (U-2.3) re-overlays the
 * user-intent record onto whatever the disk scan returns. The end result:
 * the project lands in the sidebar even when Claude hasn't yet written a
 * `sessions-index.json` for it, AND it survives a restart.
 *
 * The dialog component itself already closes the modal on submit
 * (`ui.closeDialog()` inside `AddFolderDialog.vue#submit`), so we don't need
 * to touch the UI state here — only push the persistence + reload chain.
 *
 * TODO(v1.2): wire a `userProjectsRemove` call from a future "Remove project"
 * menu item; the IPC is already exposed via `window.api.userProjectsRemove`,
 * but no UI surface invokes it yet.
 */
async function onAddFolderSubmit(payload: { path: string; alias: string }): Promise<void> {
  // Folder-first (spec §6): adding a project pins exactly the chosen folder.
  // `worktrees` is vestigial on the on-disk record (we always write `[]`) —
  // runtime worktree grouping is now derived per-folder by the git probe, not
  // from this snapshot.
  const addedAt = new Date().toISOString()
  const entry: UserProject = {
    path: payload.path,
    alias: payload.alias,
    addedAt,
    worktrees: []
  }
  try {
    await window.api.userProjectsAdd(entry)
    await sessions.reloadModel()
  } catch (err) {
    console.error('[AddFolderDialog] failed to add folder', err)
    ui.pushToast({
      title: t('toast.addFolderFailed.title'),
      description: String(err),
      kind: 'danger'
    })
  }
}

/**
 * Auto-update event bridge (U-3.3). Two of the five updater channels surface
 * as toasts; the remaining three (`available`, `none`, `progress`) stay
 * available on `window.api` for a future progress component but are not
 * shown to the user today — there's no UI need to interrupt the user with
 * a "checking for update" prompt every hour.
 *
 *  - `onUpdateDownloaded`: sticky `success` toast with a "Restart now"
 *    action. `timeoutMs: 0` because the toast is actionable — dismissing it
 *    via auto-timeout would defeat the purpose. The user MUST either click
 *    "Restart now" (which calls `updaterInstallAndRestart` → main-process
 *    `autoUpdater.quitAndInstall()`) or explicitly dismiss with the X.
 *
 *  - `onUpdateError`: transient `danger` toast (8s) carrying the error
 *    `message` as the description. Kept short rather than sticky because a
 *    failed background update check is not actionable from the renderer and
 *    a persistent error toast would be more annoying than informative — the
 *    user will see another check in an hour anyway.
 *
 *  - `onUpdateManualAvailable`: darwin/win32-only (see `updater-policy.ts`'s
 *    `usesManualUpdateFlow`) — unsigned builds can't have an update silently
 *    applied by the OS, so this is a sticky `info` toast (nothing has been
 *    downloaded yet, unlike the `success` toast above) with a "Download
 *    update" action that opens the GitHub release page in the user's
 *    browser via the existing `shellOpenExternal` IPC.
 */
let unsubscribeUpdater: (() => void) | null = null
let unsubscribeUpdateError: (() => void) | null = null
let unsubscribeQuitGuard: (() => void) | null = null
let unsubscribeUpdateManualAvailable: (() => void) | null = null
let unsubscribeChangelogActivate: (() => void) | null = null
onMounted(() => {
  unsubscribeUpdater = window.api.onUpdateDownloaded((info) => {
    // electron-updater's `UpdateInfo` has a `version` string; we read it
    // defensively without importing the type (preload keeps the shape as
    // `unknown` to avoid pulling electron-updater into the preload graph).
    const version =
      typeof info === 'object' && info !== null && 'version' in info
        ? String((info as { version?: unknown }).version ?? '')
        : ''
    const description = version
      ? t('toast.updateReady.descriptionVersion', { version })
      : t('toast.updateReady.description')
    ui.pushToast({
      title: t('toast.updateReady.title'),
      description,
      kind: 'success',
      timeoutMs: 0,
      action: {
        label: 'toast.actions.restartNow',
        handler: () => window.api.updaterInstallAndRestart()
      }
    })
  })
  unsubscribeUpdateError = window.api.onUpdateError((e) => {
    ui.pushToast({
      title: t('toast.updateError.title'),
      description: e?.message ?? '',
      kind: 'danger',
      timeoutMs: 8000
    })
  })
  unsubscribeUpdateManualAvailable = window.api.onUpdateManualAvailable((e) => {
    const description = e.version
      ? t('toast.updateManual.descriptionVersion', { version: e.version })
      : t('toast.updateManual.description')
    ui.pushToast({
      title: t('toast.updateManual.title'),
      description,
      kind: 'info',
      timeoutMs: 0,
      action: {
        label: 'toast.actions.downloadUpdate',
        handler: () => window.api.shellOpenExternal(e.releaseUrl)
      }
    })
  })
  // T579: main is about to show the native "agents still working" dialog and asks for readable
  // session names + the translated copy. `{app}`/`{count}`/`{n}` stay literal — main fills them.
  unsubscribeQuitGuard = window.api.onQuitGuardLabelsRequest((req) => {
    const labels: Record<string, string> = {}
    for (const id of req.ids) {
      const s = sessions.findSessionById(id)
      if (s) labels[id] = sessionTitle(s, sessions.allSessions, t)
    }
    const literal = { app: '{app}', count: '{count}', n: '{n}' }
    window.api.quitGuardLabelsReply({
      requestId: req.requestId,
      labels,
      strings: {
        messageOne: t('quitGuard.messageOne', literal),
        messageMany: t('quitGuard.messageMany', literal),
        detail: t('quitGuard.detail', literal),
        andMore: t('quitGuard.andMore', literal),
        quitAnyway: t('quitGuard.quitAnyway'),
        cancel: t('quitGuard.cancel'),
        dontAskAgain: t('quitGuard.dontAskAgain')
      }
    })
  })
  void claudeChangelog.init()
  // T389 P1W4: the Harnu mod state, and the one-time notice that precedes loading it.
  void companion.init()
  unsubscribeChangelogActivate = window.api.onClaudeChangelogActivate(() => {
    ui.openSettings('claudeCode')
  })
})
onUnmounted(() => {
  void helpers.flushNow()
  unsubscribeUpdater?.()
  unsubscribeUpdater = null
  unsubscribeUpdateError?.()
  unsubscribeUpdateError = null
  unsubscribeQuitGuard?.()
  unsubscribeQuitGuard = null
  unsubscribeUpdateManualAvailable?.()
  unsubscribeUpdateManualAvailable = null
  claudeChangelog.dispose()
  companion.dispose()
  unsubscribeChangelogActivate?.()
  unsubscribeChangelogActivate = null
})
</script>

<template>
  <div class="flex flex-col h-screen w-screen bg-bg text-text">
    <div class="flex min-h-0 flex-1">
      <!--
        Left sidebar collapse (design.md §6 — Colapsar sidebars). `v-show` (not
        `v-if`) keeps the sidebar mounted so its scroll position / filter / zone
        expand-state survive a collapse round-trip. The resize divider is
        `v-if`'d out while collapsed (no width to drag). Reopen affordance: the
        panel-toggle button in the Topbar (always visible) + ⌘B / Ctrl+B.
      -->
      <Sidebar v-show="!layout.sidebarCollapsed" />
      <div
        v-if="!layout.sidebarCollapsed"
        class="group flex w-1.5 shrink-0 cursor-col-resize items-center justify-center"
        role="separator"
        aria-orientation="vertical"
        :aria-label="$t('sidebar.resize')"
        @mousedown="onSidebarDividerMouseDown"
        @dblclick="layout.resetSidebarWidth()"
      >
        <div class="h-full w-px bg-border-2 transition-colors group-hover:bg-accent-line" />
      </div>
      <main class="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <div class="flex min-h-0 flex-1">
          <!--
            Main-content view. Wrapped in a sizing div (rather than each view
            owning its own flex-basis) so the SAME split-ratio math applies
            whichever view is active — this is what lets the Roadmap board
            (T80) share the row with the helper stack instead of the two
            being mutually exclusive takeovers.
          -->
          <div
            class="relative flex min-w-0 min-h-0 flex-col"
            :style="
              showHelperStack
                ? { flex: `${helpers.splitRatioForCurrentWorktree} 1 0` }
                : { flex: '1 1 0' }
            "
          >
            <!--
              BUG-103: TerminalPane renders UNCONDITIONALLY here (never `v-if`),
              absolutely positioned to fill this box. Every takeover below used
              to outrank it in a `v-else-if` chain, so the component (and the
              background agent-boot-queue watchers it owns) didn't exist at all
              while a takeover was open — a boot dispatched into that window
              silently never ran until `armAgentBootDeadline` failed it. Keeping
              it mounted (merely covered by whichever view below is foreground)
              keeps the drain alive at all times, with no change to
              TerminalPane.vue itself. See design.md's "Takeover dismissal"
              section for the write-up of why this was chosen over moving the
              drain to a separate mount-independent driver.

              `invisible`/`pointer-events-none` handle paint and pointer input;
              `:inert` (not `aria-hidden`) handles the third axis — a covered
              terminal must not be reachable by sequential (Tab) focus
              navigation, which an unmounted component never was. `inert`
              removes the whole subtree from both focus order AND the
              accessibility tree in one native attribute, which makes a
              separate `aria-hidden` binding redundant here — Electron ships a
              single pinned, modern Chromium (inert has been supported since
              Chromium 102), so there is no older-browser AT fallback to
              support the way a public website would need. Toggling `inert` on
              this static wrapper never touches TerminalPane's own lifecycle
              (the component itself is never re-mounted by this — only the
              wrapper's attribute flips), so the terminal's xterm/PTY state is
              untouched by covering or uncovering it.
            -->
            <div
              class="absolute inset-0"
              data-test="terminal-pane-host"
              :class="{
                invisible: !showTerminalForeground,
                'pointer-events-none': !showTerminalForeground
              }"
              :inert="!showTerminalForeground"
            >
              <TerminalPane />
            </div>
            <div v-if="showActiveView" class="absolute inset-0 bg-bg">
              <TakeoverHost />
            </div>
            <div v-else-if="showOnboarding" class="absolute inset-0 bg-bg">
              <Onboarding />
            </div>
            <div v-else-if="showFolder" class="absolute inset-0 bg-bg">
              <FolderView />
            </div>
            <div v-else-if="showEmpty" class="absolute inset-0 bg-bg">
              <EmptyState />
            </div>
            <div
              v-else-if="showSession && showCloudSession && sessions.selectedSession"
              class="absolute inset-0 bg-bg"
            >
              <CloudSessionPanel :session="sessions.selectedSession" />
            </div>
          </div>
          <!--
            Right helper panel — auto-show gated by `showHelperStack`, which ANDs
            the pane-count auto-show (`showHelper`) with whether the active main
            view is one a pane makes sense next to (Roadmap board or terminal —
            design.md §6). Collapsed hides the divider + stack even with panes;
            the Topbar panel-toggle button (⌘⌥B / Ctrl+Alt+B) brings it back.
          -->
          <div
            v-if="showHelperStack"
            class="group flex w-1.5 shrink-0 cursor-col-resize items-center justify-center"
            role="separator"
            aria-orientation="vertical"
            @mousedown="onMainDividerMouseDown"
          >
            <div class="h-full w-px bg-border-2 transition-colors group-hover:bg-accent-line" />
          </div>
          <div
            v-if="showHelperStack"
            class="flex min-w-0 min-h-0 flex-col"
            :style="{ flex: `${1 - helpers.splitRatioForCurrentWorktree} 1 0` }"
          >
            <HelperStack />
          </div>
        </div>
      </main>

      <!--
        Inbox rail (T83 S0) — the fourth column. A SIBLING of <main>, so it spans
        the full height beside the Topbar rather than living inside a session view:
        the approval queue is fleet-wide and must stay on screen across folder
        switches, takeovers (board / usage dashboard), and the empty state.

        It is NOT teleported and NOT in the floating-surface mutex — it's a column,
        not an overlay. See `ui.ts` (the mutex it deliberately left) and
        `layout.ts#summonInboxRail`.
      -->
      <template v-if="showInboxRail">
        <div
          v-if="layout.inboxRailState === 'expanded'"
          class="group flex w-1.5 shrink-0 cursor-col-resize items-center justify-center"
          role="separator"
          aria-orientation="vertical"
          :aria-label="$t('approvalInbox.rail.resize')"
          @mousedown="onInboxRailDividerMouseDown"
          @dblclick="layout.resetInboxRailWidth()"
        >
          <div class="h-full w-px bg-border-2 transition-colors group-hover:bg-accent-line" />
        </div>
        <div class="flex min-h-0 shrink-0 flex-col" :style="{ width: `${inboxRailPx}px` }">
          <InboxRail />
        </div>
      </template>
    </div>

    <StatusFooter />

    <!--
      Floating surfaces. Teleported to body so they escape any ancestor
      stacking context that might otherwise clip them. Coordinated by the
      `ui` Pinia store; mutex semantics enforce one-at-a-time for the
      four interactive surfaces. ToastStack is the exception — it lives in
      the same teleport for stacking-context hygiene, but is non-modal and
      ignores the mutex (toasts can co-exist with any other surface).
      Z-order (per design.md §6 floating-surface table):
        preview 40 < menu 50 < dialog 60 < palette 70 < toast stack 80.
    -->
    <Teleport to="body">
      <SessionPreview />
      <FolderPreview />
      <SessionMenu />
      <FolderMenu />
      <SidebarHiddenPopover />
      <AddFolderDialog @submit="onAddFolderSubmit" />
      <SettingsDialog />
      <ClaudeBootDialog />
      <NewSessionDialog />
      <RemoveWorktreeDialog />
      <NewWorktreeDialog />
      <NewFolderDialog />
      <OpenSubfolderDialog />
      <RenameFolderDialog />
      <TrustedHostsDialog />
      <RenameRepoDialog />
      <MemoryLocationDialog />
      <MissionsReviewDialog />
      <CommandPalette />
      <McpConfirmOverlay />
      <ToastStack />
    </Teleport>
  </div>
</template>
