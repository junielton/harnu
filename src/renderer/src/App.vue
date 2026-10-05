<script setup lang="ts">
import { computed, onMounted, onUnmounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Sidebar from './components/Sidebar.vue'
import TerminalPane from './components/TerminalPane.vue'
import Topbar from './components/Topbar.vue'
import StatusFooter from './components/StatusFooter.vue'
import EmptyState from './components/EmptyState.vue'
import FolderView from './components/FolderView.vue'
import CloudSessionPanel from './components/CloudSessionPanel.vue'
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
import RenameRepoDialog from './components/RenameRepoDialog.vue'
import MemoryLocationDialog from './components/MemoryLocationDialog.vue'
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
import { useUiStore } from './stores/ui'
import { useHelpersStore } from './stores/helpers'
import { useLayoutStore, helperPanelVisible, inboxRailWidthFor } from './stores/layout'
import { useClaudeChangelogStore } from './stores/claudeChangelog'
import { useShortcuts, pushScope, popScope } from './composables/useShortcuts'
import { useTerminalFocus } from './composables/useTerminalFocus'
import type { Session } from './stores/sessions'
import type { UserProject } from '../../preload'

const { t } = useI18n()

useThemeStore()
const sessions = useSessionsStore()
const ui = useUiStore()
const helpers = useHelpersStore()
const layout = useLayoutStore()
const claudeChangelog = useClaudeChangelogStore()

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

// T22: never drive the sidebar cursor while a text-entry surface owns focus.
// Scope gating (above) covers overlays; this catches the non-modal Topbar
// inline-rename contenteditable, which pushes no scope. The xterm hidden input
// is a <textarea class="xterm-helper-textarea"> — explicitly NOT treated as text
// entry so terminal arrow handling (xterm + lib/terminalKeymap) is unchanged.
function isTextEntryTarget(): boolean {
  const el = document.activeElement as HTMLElement | null
  if (!el) return false
  if (el.isContentEditable) return true
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    if (el.closest('.xterm')) return false
    return true
  }
  return false
}

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
 * Synthetics are always resumable, so a freshly-created session never hits this.
 * Folder terminals ARE resumable (a shell is its own live process), so the
 * `!isShellTerminal` clause is defence-in-depth: a terminal must always render
 * in `TerminalPane`, never the cloud panel, even if `resumable` ever flips.
 */
const showCloudSession = computed(
  () => sessions.selectedSession?.resumable === false && !sessions.selectedSession?.isShellTerminal
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

// Reveal-on-agent-pane (BUG-29): an agent pane landing in the folder already
// visible never crosses the false→true edge above when the stack already has
// panes, so a collapsed panel would otherwise stay collapsed with zero signal.
// `helpers.agentPaneRevealTick` is bumped only for that visible-folder case
// (`notifyAgentPaneAdded` in the helpers store) — any change un-collapses.
watch(
  () => helpers.agentPaneRevealTick,
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
 * The action IDs match the union in `src/main/menu.ts#ShortcutActionId` 1:1.
 * `app.reload`, `app.devtools`, `app.fullscreen`, and `app.quit` are NOT
 * listed here — they're handled directly in the main process (see menu.ts
 * `click:` blocks) and the renderer has nothing useful to add.
 */
useShortcuts([
  {
    id: 'session.new',
    scope: 'global',
    keys: 'Cmd+N',
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
    keys: 'Cmd+K',
    handler: () => ui.openPalette()
  },
  {
    id: 'inbox.toggle',
    scope: 'global',
    keys: 'Cmd+Shift+A',
    // Expand/minimize the Inbox rail (T83 §5.6). Same helper the Topbar button +
    // the palette action call. Never hides the rail — see `nextInboxRailStateOnToggle`.
    handler: () => layout.toggleInboxRail()
  },
  {
    id: 'view.fleetRail',
    scope: 'global',
    keys: 'Cmd+Shift+B',
    // T153: the sidebar's folders↔board toggle was removed — retarget this
    // shortcut to the Fleet rail (same helper `⌘⇧A`/`inbox.toggle` calls).
    handler: () => layout.toggleInboxRail()
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
    keys: 'Cmd+B',
    handler: () => layout.toggleSidebar()
  },
  {
    id: 'view.toggleHelper',
    scope: 'global',
    // Collapse/expand the right helper panel (VS Code's "secondary side bar"
    // → ⌘⌥B / Ctrl+Alt+B). Same OS-menu-owned + renderer-fallback shape as
    // above. No-op visually when the worktree has no panes; the flag still
    // flips and takes effect once panes exist.
    keys: 'Cmd+Alt+B',
    handler: () => layout.toggleHelper()
  },
  {
    id: 'project.switch',
    scope: 'global',
    keys: 'Cmd+Shift+P',
    // v1: open the plain palette. v1.1 will pre-fill `>p ` so the palette
    // filters to the Projects section per finding 07 §2.
    handler: () => ui.openPalette()
  },
  {
    id: 'folder.add',
    scope: 'global',
    keys: 'Cmd+O',
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
    keys: 'Cmd+Shift+D',
    enabled: () => !!sessions.activeFolderPath,
    handler: () => {
      const folder = sessions.activeFolderPath
      if (folder) ui.toggleReview(folder)
    }
  },
  {
    id: 'session.resumeLast',
    scope: 'global',
    keys: 'Cmd+Shift+R',
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
    keys: 'Cmd+R',
    enabled: () => !!sessions.selectedId,
    handler: () => ui.triggerRenameFocus()
  },
  {
    id: 'session.close',
    scope: 'global',
    keys: 'Cmd+W',
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
    keys: 'ArrowDown',
    enabled: () => !isTextEntryTarget() && sidebarCursorNavAllowed(),
    handler: () => sessions.cursorDown()
  },
  {
    id: 'sidebar.cursor.up',
    scope: 'global',
    keys: 'ArrowUp',
    enabled: () => !isTextEntryTarget() && sidebarCursorNavAllowed(),
    handler: () => sessions.cursorUp()
  },
  {
    id: 'sidebar.cursor.right',
    scope: 'global',
    keys: 'ArrowRight',
    enabled: () => !isTextEntryTarget() && sidebarCursorNavAllowed(),
    handler: () => sessions.cursorRight()
  },
  {
    id: 'sidebar.cursor.left',
    scope: 'global',
    keys: 'ArrowLeft',
    enabled: () => !isTextEntryTarget() && sidebarCursorNavAllowed(),
    handler: () => sessions.cursorLeft()
  },
  {
    id: 'sidebar.cursor.activate',
    scope: 'global',
    keys: 'Enter',
    // Only fire when the cursor is on a row AND no text-entry surface owns focus
    // (T22 — the Topbar inline-rename contenteditable pushes no scope, so scope
    // gating alone wouldn't catch it). The store also no-ops on a null cursor.
    enabled: () =>
      sessions.keyboardCursor !== null && !isTextEntryTarget() && sidebarCursorNavAllowed(),
    handler: () => sessions.cursorActivate()
  }
])

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
  void claudeChangelog.init()
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
  unsubscribeUpdateManualAvailable?.()
  unsubscribeUpdateManualAvailable = null
  claudeChangelog.dispose()
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
      <RenameRepoDialog />
      <MemoryLocationDialog />
      <CommandPalette />
      <McpConfirmOverlay />
      <ToastStack />
    </Teleport>
  </div>
</template>
