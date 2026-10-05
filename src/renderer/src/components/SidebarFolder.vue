<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Folder, Session, SessionAgent } from '../stores/sessions'
import { useSessionsStore } from '../stores/sessions'
import { sessionTitle } from '../lib/session-label'
import { useHelpersStore } from '../stores/helpers'
import { useHoverPreview } from '../composables/useHoverPreview'
import { useContextMenu } from '../composables/useContextMenu'
import { useUiStore } from '../stores/ui'
import { useMissionsStore } from '../stores/missions'
import { headlineText, TONE_TEXT_CLASS, type MissionModel } from '../lib/mission-view'
import { relativeTime } from '../composables/useRelativeTime'
import { dotFor, type Dot } from './session-dot'
import { failureBadge, type FailureBadge } from './failure-badge'
import { humanizeDuration } from './usage-format'
import { displayAlias } from './folder-alias'
import { buildSessionRows, shouldConfirmTeammateSelect } from './teammate-grouping'
import {
  densityMetrics,
  sessionIndentFor,
  childIndentFor,
  type SidebarRowContext
} from './sidebar-density'
import {
  Archive,
  Bot,
  BotOff,
  Check,
  ChevronRight,
  Clock,
  Cloud,
  CornerDownRight,
  Crown,
  EyeOff,
  Folder as FolderIcon,
  GitFork,
  Moon,
  PanelRight,
  Plus,
  SquareTerminal,
  TriangleAlert,
  Users,
  X
} from 'lucide-vue-next'

/**
 * One folder row in the sidebar tree (folder-first model, spec §5). A folder
 * IS what a worktree was — an absolute path that directly hosts sessions. The
 * row shows a folder icon, the alias, and the session count; its sessions
 * (sorted via the global sort preference) and a "+ New session" affordance
 * render underneath when expanded. The active session's git branch is surfaced
 * in the footer status bar (`StatusFooter.vue`), not on these rows.
 *
 * The `nested` prop is set when this row lives inside a `RepoGroupHeader`
 * disclosure, indenting it one level so the repo group reads as a parent.
 *
 * The `headerless` prop (drill-in navigation, 2026-07-19) hides this folder's
 * own row entirely and forces its children container permanently open,
 * ignoring `folder.expanded` — the drill-in screen's own back-row already
 * names the folder, so this component only contributes its session/teammate/
 * terminal rows.
 *
 * T191 lineage props: `lineageChildCount` (set on a MOTHER row) shows the
 * `git-fork` badge + count and makes it clickable to collapse/expand the
 * children — `lineageExpanded` drives its chevron-less open/closed read, and
 * `toggle-lineage` is emitted on click (the parent, `Sidebar.vue`, owns the
 * persisted collapse state). `lineageChild` (set on a CHILD row) adds one more
 * indent step on top of whatever `nested` already contributes — the sidebar
 * never stacks a repo-group nesting AND a lineage nesting into more than the
 * single extra level either produces alone in practice (D3), but the prop is
 * additive so a future caller isn't blocked from composing them.
 */
const props = defineProps<{
  folder: Folder
  nested?: boolean
  headerless?: boolean
  lineageChildCount?: number
  lineageExpanded?: boolean
  lineageChild?: boolean
}>()

const emit = defineEmits<{ 'toggle-lineage': [] }>()

const sessions = useSessionsStore()
const helpers = useHelpersStore()
const hoverPreview = useHoverPreview()
const contextMenu = useContextMenu()
const ui = useUiStore()
const { t } = useI18n()

/**
 * Whether this folder is currently dismissed (manually hidden). Only ever true
 * on rows that are actually visible (an active filter override surfaces them) —
 * a dimmed, eye-off-marked row is the affordance to right-click → Unhide.
 */
const folderHidden = computed<boolean>(() => sessions.manuallyHiddenPaths.has(props.folder.path))

/**
 * Whether the operator BLOCKED agents in this folder. Mirrors `agentDeniedPaths` —
 * the SAME source as the "Block / Unblock agent control" toggle in `FolderMenu`, so
 * the row badge and the menu never disagree. Drives a discreet `bot-off` marker on
 * the row (status, not an action). Inverted from the old T71 "agent-allowed" badge:
 * agents are free by default, so the block is the notable state.
 */
const agentDenied = computed<boolean>(() => sessions.agentDeniedPaths.has(props.folder.path))

/**
 * Whether this folder has "new sessions start as Orchestrator" ON (T344).
 * Mirrors `orchestratorDefaultPaths` — the SAME source as the FolderMenu
 * toggle, so the row indicator and the menu never disagree. EXACT-PATH ONLY
 * (AC-5) — a linked worktree's own value, never inherited from its repo.
 */
const orchestratorDefaultOn = computed<boolean>(() =>
  sessions.orchestratorDefaultPaths.has(props.folder.path)
)

/**
 * Unseen agent-panes count (2026-07-13 agent-pane-routing design §Badge):
 * how many panes an agent opened into THIS folder while it wasn't the
 * visible one. Drives the always-visible accent pill below — deliberately
 * NOT part of the hover-gated stats cluster (T118), since an unseen offer
 * must not hide.
 */
const unseenPaneCount = computed<number>(() => helpers.unseenAgentPaneCount(props.folder.path))

function onSessionContext(e: MouseEvent, sessionId: string): void {
  contextMenu.open(e, sessionId)
}

/**
 * Right-click trigger for folder rows → `FolderMenu`. Clamps the cursor coords
 * against a conservative menu-size estimate before opening.
 */
function onFolderContext(e: MouseEvent, folderPath: string): void {
  e.preventDefault()
  const APPROX_MENU_WIDTH = 180
  const APPROX_MENU_HEIGHT = 60
  const VIEWPORT_MARGIN = 8
  const vw = window.innerWidth
  const vh = window.innerHeight
  let x = e.clientX
  let y = e.clientY
  if (x + APPROX_MENU_WIDTH > vw - VIEWPORT_MARGIN) {
    x = Math.max(VIEWPORT_MARGIN, x - APPROX_MENU_WIDTH)
  }
  if (y + APPROX_MENU_HEIGHT > vh - VIEWPORT_MARGIN) {
    y = Math.max(VIEWPORT_MARGIN, y - APPROX_MENU_HEIGHT)
  }
  ui.openFolderMenu({ projectPath: folderPath, x, y })
}

/**
 * Display label for a session row: the shared `sessionTitle` (BUG-78 — a
 * teammate's agent name in every zone it renders in, the fork / "New session"
 * placeholders, then summary → Haiku title → first prompt), "Untitled" when a
 * real session has no name yet.
 */
function labelFor(s: Session): string {
  return sessionTitle(s, sessions.allSessions, t) || t('session.unnamed')
}

function statusDot(s: Session): Dot {
  // Archive is an explicit user state that overrides the activity/hook heuristic.
  if (sessions.isArchived(s.sessionId)) return 'archived'
  // `activityOf` resolves working/stuck/idle from the canonical `resolveActivity`
  // (reading `sessions.nowTick` so the dot ages into `stuck` on the clock tick) —
  // the SAME source the Fleet board reads, so dot and board agree by construction.
  const activity = sessions.activityOf(s, sessions.nowTick)
  return dotFor(s.taskState, s.status, activity, s.transcriptState)
}

function isArchived(s: Session): boolean {
  return sessions.isArchived(s.sessionId)
}

// StopFailure reason badge (stopfailure-badges spec §4.6). Pure failureBadge maps
// the reason; the row renders the i18n label + a reset countdown when present.
function fBadge(s: Session): FailureBadge | null {
  return failureBadge(s.failureReason, s.resetsAt, Date.now())
}
function fBadgeLabel(s: Session): string {
  const b = fBadge(s)
  if (!b) return ''
  const base = t(b.labelKey)
  return b.countdownMs != null
    ? `${base} · ${t('session.failure.resetsIn', { time: humanizeDuration(b.countdownMs) })}`
    : base
}

const expanded = computed(() => props.headerless || props.folder.expanded)
// Display label (T52): a custom alias wins; else, when auto-alias is on for this
// folder and its branch differs from the dir-name, the branch; else the basename.
const label = computed(() =>
  displayAlias(props.folder, sessions.aliasFromBranchPaths.has(props.folder.path))
)

// Sessions ordered by the global sort preference (display only — never mutates
// folder.sessions). The new-session row and session rows live under this list.
const sessionList = computed(() => sessions.sessionsForDisplay(props.folder))

/**
 * Teammate grouping (T99 — design.md "Teammate group (sidebar)"). Derived
 * AFTER `sessionList` (never inside `sortSessions`, which stays pure): pulls
 * teammate sessions out of the flat run and nests them under their team
 * lead's row. When the lead isn't in this folder at all, the group is
 * orphaned and hidden — except the currently selected teammate, which
 * `buildSessionRows` keeps as a flat row (T168).
 *
 * The lead lookup searches `leaderCandidates` — the folder's FULL session list,
 * ignoring the age window `sessionList` applies — so a lead that went idle the
 * moment it dispatched its team (the common case) is still found and nested
 * under, instead of the group falling orphaned the moment it ages out of view.
 */
const leaderCandidates = computed(() => sessions.teammateLeadCandidates(props.folder))
const sessionRows = computed(() =>
  buildSessionRows(sessionList.value, leaderCandidates.value, sessions.selectedId)
)

/** A leader row's teammates (empty when it doesn't lead a team). */
function teammatesOf(sessionId: string): Session[] {
  return sessionRows.value.teammatesByLeader.get(sessionId) ?? []
}

/** Stable `:key` for a session row. */
function rowKey(row: { session: Session }): string {
  return row.session.sessionId
}

function isTeammatesExpanded(leaderSessionId: string): boolean {
  return sessions.isTeammatesExpanded(leaderSessionId)
}

function toggleTeammatesExpanded(leaderSessionId: string): void {
  sessions.toggleTeammatesExpanded(leaderSessionId)
}

function teammatesToggleLabel(expanded: boolean, n: number): string {
  return expanded ? t('sidebar.teammates.hide') : t('sidebar.teammates.show', { n })
}

// Folder terminals (plain shells) — rendered in their own "Terminals" sub-group
// below the sessions, keeping the operator's division between Claude sessions
// and shells. Excluded from `sessionList` by the store.
const terminalList = computed(() => sessions.terminalsForFolder(props.folder))

/** Stable 1-based label for a terminal row ("Terminal 1", "Terminal 2", …). */
function terminalLabel(index: number): string {
  return t('sidebar.terminalLabel', { n: index + 1 })
}

// Session-age filter (spec §5): how many sessions the window hides, and whether
// this folder's older sessions are currently revealed. Drives the inline cluster.
const olderCount = computed(() => sessions.olderSessionCount(props.folder))
const olderRevealed = computed(() => sessions.isOlderRevealed(props.folder.path))

// Archived sessions (Archive action): how many this folder holds, and whether
// they're currently revealed. Drives the archived item of the inline cluster.
const archivedCount = computed(() => sessions.archivedSessionCount(props.folder))
const archivedRevealed = computed(() => sessions.isArchivedRevealed(props.folder.path))

// Inline action cluster (spec 2026-06-24): the older + archived peeks render from
// one template via v-for (only when their count > 0). `+` (new session) is kept
// separate — always shown, no count. `label` feeds both title and aria-label.
const peekActions = computed(() =>
  [
    {
      kind: 'older' as const,
      icon: Clock,
      count: olderCount.value,
      revealed: olderRevealed.value,
      label: olderRevealed.value
        ? t('sidebar.hideOlder')
        : t('sidebar.showOlder', { n: olderCount.value })
    },
    {
      kind: 'archived' as const,
      icon: Archive,
      count: archivedCount.value,
      revealed: archivedRevealed.value,
      label: archivedRevealed.value
        ? t('sidebar.hideArchived')
        : t('sidebar.showArchived', { n: archivedCount.value })
    }
  ].filter((p) => p.count > 0)
)

// Density preset (design.md §4 "Row density" / §6 "Row anatomy & indentation").
// Scales row heights, the session-row gap, and the left indent. `headerless`
// means the drill-in folder screen, which uses the small `drill` indent (its
// back-row header already names the folder — no classic offset warranted).
const metrics = computed(() => densityMetrics(sessions.sidebarDensity))
const rowContext = computed<SidebarRowContext>(() =>
  props.headerless ? 'drill' : props.nested ? 'nested' : 'flat'
)

// Indents: folder row pl 8 (or 28 when nested under a repo group) — unchanged,
// its own chevron needs the room. Session rows + "+ new session" + terminals
// share the density × context session indent; agent/teammate child rows go one
// level deeper (session indent + delta). T191: `lineageChild` adds one more
// +20 step on top of whatever the row already resolves to, for a worktree
// nested under its mother's fork badge (design.md § "Worktree lineage") — an
// ADDITIVE offset, not a new density context, so it composes with any density
// preset without widening `SidebarRowContext`'s own union.
const LINEAGE_CHILD_INDENT = 20
const folderPaddingLeft = computed(
  () => (props.nested ? 28 : 8) + (props.lineageChild ? LINEAGE_CHILD_INDENT : 0)
)
const sessionPaddingLeft = computed(
  () =>
    sessionIndentFor(sessions.sidebarDensity, rowContext.value) +
    (props.lineageChild ? LINEAGE_CHILD_INDENT : 0)
)
const childPaddingLeft = computed(
  () =>
    childIndentFor(sessions.sidebarDensity, rowContext.value) +
    (props.lineageChild ? LINEAGE_CHILD_INDENT : 0)
)

// The empty agent-toggle slot a session row reserves before its status slot
// (design.md §6 "Row anatomy & indentation", slot 2). Terminal rows reserve the
// SAME column so a terminal's label starts exactly where its folder's session
// labels start — a terminal is a child of the folder, not a sibling of it.
const TOGGLE_SLOT = 12
/** Left edge of the label column shared by session and terminal rows. */
const rowLabelPaddingLeft = computed(
  () => sessionPaddingLeft.value + TOGGLE_SLOT + metrics.value.gap + 14 + metrics.value.gap
)

function toggle(): void {
  sessions.toggleFolder(props.folder.path)
}

/**
 * T212 — the folder row is now a SELECT, symmetric with a session row: it opens
 * the folder's `FolderView`. It still expands on the way in (the click keeps its
 * old meaning), but never auto-collapses on selection: a second click collapses
 * and the selection survives, so the view does not flicker away under the cursor.
 */
function onFolderClick(): void {
  const alreadySelected = sessions.selectedFolderPath === props.folder.path
  sessions.selectFolder(props.folder.path)
  if (!expanded.value || alreadySelected) toggle()
}

/** T191: the mother badge's click handler — collapses/expands its children. */
function toggleLineage(): void {
  emit('toggle-lineage')
}

/**
 * Inline folder-row peek (older / archived). A collapsed folder expands first
 * (revealing inside a closed folder would be invisible); the toggle then reveals.
 * Collapsing clears the peek (store `forgetPeeks`), so a collapsed folder is
 * always un-revealed here and the toggle stays unambiguous (spec 2026-06-24 §4).
 */
function peek(kind: 'older' | 'archived'): void {
  const path = props.folder.path
  if (!props.folder.expanded) sessions.toggleFolder(path)
  if (kind === 'older') sessions.toggleRevealOlder(path)
  else sessions.toggleRevealArchived(path)
}

/** Inline "+" — expand the folder so the new synthetic row is visible, then open. */
function onNewSession(): void {
  if (!props.folder.expanded) sessions.toggleFolder(props.folder.path)
  ui.openNewSession(props.folder.path)
}

const folderFocused = computed(
  () =>
    sessions.keyboardCursor?.kind === 'folder' && sessions.keyboardCursor.id === props.folder.path
)

function sessionFocused(sessionId: string): boolean {
  const c = sessions.keyboardCursor
  return !!c && c.kind === 'session' && c.id === sessionId
}

// Stats sob demanda (T118 — design.md §6): the folder row's trailing cluster
// (peeks + `+` + the T71 bot badge) rests hidden and fades in on pointer hover
// (`group-hover`), keyboard focus (`group-focus-within` for the real DOM focus,
// plus the roving `data-focused` cursor), or while a peek is revealed — an
// active `--accent` "Hide" state must never be invisible. Opacity-only: the
// space is preserved, so the reveal never shifts layout.
const folderStatsRevealClass = computed(() =>
  folderFocused.value || peekActions.value.some((p) => p.revealed)
    ? 'opacity-100'
    : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
)

/**
 * Reveal class for a session row's trailing stat chips (T118). Same rule as the
 * relative-time span (visible on the selected row) plus the keyboard cursor;
 * `force` pins a chip that carries active state or a signal (teammates group
 * expanded, context % ≥ 80).
 */
function chipRevealClass(s: Session, force = false): string {
  return force || sessions.selectedId === s.sessionId || sessionFocused(s.sessionId)
    ? 'opacity-100'
    : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
}

// Mission chip (T370; Mission v3 — design.md §6 "Mission progress" → Sidebar
// indicator): the last entry of the trailing cluster, the server's headline in
// its compact form, in the pill's own tone. Hover-revealed like the subagent
// chip, unless the operator owes the mission something — then pinned visible
// like StopFailure. An empty headline renders no chip.
const missions = useMissionsStore()
missions.ensureStarted()

function missionOf(s: Session): MissionModel | null {
  const m = missions.modelForSession(s.sessionId)
  return m && m.headline.kind !== 'empty' ? m : null
}

function missionChipLabel(m: MissionModel): string {
  return t(m.needsYou ? 'mission.sidebarChipNeedsYou' : 'mission.sidebarChip', {
    headline: headlineText(t, m.headline)
  })
}

function agentsOf(s: Session): SessionAgent[] {
  return s.agents ?? []
}

// Trailing-chips overlay (design.md §6 "Trailing chips overlay the label"). The
// cluster is absolutely positioned so it reserves no horizontal column; these
// helpers decide when to render it and when its scrim (which masks the label
// tail so a chip reads cleanly over it) is revealed.
function hasTrailingChips(s: Session): boolean {
  return (
    !!fBadge(s) ||
    agentsOf(s).length > 0 ||
    sessions.isSessionOrchestratorOn(s.sessionId) ||
    teammatesOf(s.sessionId).length > 0 ||
    !!missionOf(s)
  )
}

/** Chips that render regardless of hover — their scrim must always show. */
function hasAlwaysOnChip(s: Session): boolean {
  return (
    !!fBadge(s) ||
    sessions.isSessionOrchestratorOn(s.sessionId) ||
    isTeammatesExpanded(s.sessionId) ||
    missionOf(s)?.needsYou === true
  )
}

/** Reveal class for the trailing scrim — matches "any chip is visible". */
function trailingScrimClass(s: Session): string {
  return sessions.selectedId === s.sessionId || hasAlwaysOnChip(s)
    ? 'opacity-100'
    : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
}

function agentLabel(a: SessionAgent): string {
  return a.agentType || t('agent.subagentLabel')
}

function agentOrigin(a: SessionAgent): string {
  return a.skill || a.plugin || ''
}

/**
 * Select a teammate row — a real session, same action as any session row, but
 * gated when it's currently `working` (T99 — design.md "Guarda de teammate
 * ativo"): the team lead may be driving it right now, and a local
 * `claude --resume` would be a second writer on the same JSONL.
 */
function onSelectTeammate(session: Session): void {
  const activity = sessions.activityOf(session, sessions.nowTick)
  if (shouldConfirmTeammateSelect(activity)) {
    if (!window.confirm(t('sidebar.teammates.workingGuard'))) return
  }
  sessions.select(session.sessionId)
}
</script>

<template>
  <!-- data-folder-path: lets the Sidebar scroll this folder into view after a
       CLI-driven `harnu .` adoption (reveal signal, T69 fix).  -->
  <div :data-folder-path="folder.path" style="margin-bottom: 2px">
    <!-- Folder row -->
    <button
      v-if="!headerless"
      class="sidebar-row group flex w-full cursor-pointer items-center text-left text-text transition hover:bg-surface"
      style="gap: 4px; font-size: 12.5px; font-weight: 500"
      :style="{
        height: `${metrics.folderRowHeight}px`,
        margin: '0',
        paddingLeft: `${folderPaddingLeft}px`,
        paddingRight: '12px',
        // T212: a selected folder is highlighted the same way a selected session
        // row is — the two selections are peers, so they must read as peers.
        background:
          sessions.selectedFolderPath === folder.path ? 'var(--color-accent-soft)' : 'transparent',
        ...(folderHidden ? { opacity: 0.5 } : {})
      }"
      :data-focused="folderFocused ? 'true' : null"
      @click="onFolderClick"
      @contextmenu="(e) => onFolderContext(e, folder.path)"
      @mouseenter="
        (e) =>
          hoverPreview.enterFolder(
            folder.path,
            (e.currentTarget as HTMLElement).getBoundingClientRect()
          )
      "
      @mouseleave="hoverPreview.leave()"
    >
      <span
        class="flex shrink-0 items-center justify-center text-text-4"
        style="width: 16px; height: 16px"
      >
        <ChevronRight
          :size="12"
          :stroke-width="1.8"
          class="transition-transform"
          :style="{
            transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
            transitionDuration: 'var(--dur)',
            transitionTimingFunction: 'var(--ease)'
          }"
        />
      </span>
      <component
        :is="folderHidden ? EyeOff : FolderIcon"
        :size="13"
        :stroke-width="1.6"
        class="shrink-0"
        :class="folderHidden ? 'text-text-4' : 'text-text-3'"
        style="margin-right: 2px"
      />
      <span class="min-w-0 flex-1 truncate">{{ label }}</span>

      <!-- Unseen agent-panes badge (2026-07-13 design): an agent-opened pane
           landed here while this folder wasn't visible. ALWAYS visible when
           non-zero (never hover-gated, unlike the cluster below) — distinct
           shape+color from the session status dots (accent pill, not a
           colored circle) so it never reads as session state. Clears on
           selecting any session in this folder (`stores/helpers.ts` watcher). -->
      <span
        v-if="unseenPaneCount > 0"
        class="flex shrink-0 items-center rounded-full border border-accent-line bg-accent-soft text-accent"
        style="gap: 3px; padding: 2px 6px; font-size: 10px"
        :title="$t('sidebar.agentPaneBadge', { n: unseenPaneCount })"
        :aria-label="$t('sidebar.agentPaneBadge', { n: unseenPaneCount })"
      >
        <PanelRight :size="11" :stroke-width="1.6" aria-hidden="true" />
        <span class="tabular-nums">{{ unseenPaneCount }}</span>
      </span>

      <!-- Agent-BLOCKED badge: discreet `bot-off` marker when the operator blocked
           agents in this folder. Inverted at the free-by-default reversal — agents
           can act everywhere now, so badging "allowed" would mark every row; the
           exception is what's worth showing. Status, not an action — an inert
           <span> (never a nested button), same source as the FolderMenu toggle.
           ALWAYS visible (not hover-gated like the stats cluster): a folder the
           fleet cannot touch must not be one hover away. -->
      <span
        v-if="agentDenied"
        class="flex shrink-0 items-center text-text-4"
        :title="$t('sidebar.agentBlockedBadge')"
        :aria-label="$t('sidebar.agentBlockedBadge')"
      >
        <BotOff :size="11" :stroke-width="1.6" aria-hidden="true" />
      </span>

      <!-- Orchestrator-default indicator (T344, AC-6): inert Crown, status not
           an action (never a nested button) — same glyph/color as the session
           orchestrator badge so the two read as one visual family. Toggled
           only from the FolderMenu, never by clicking this span. -->
      <span
        v-if="orchestratorDefaultOn"
        class="flex shrink-0 items-center text-accent"
        :title="$t('sidebar.orchestratorDefaultIndicator')"
        :aria-label="$t('sidebar.orchestratorDefaultIndicator')"
      >
        <Crown :size="11" :stroke-width="1.6" aria-hidden="true" />
      </span>

      <!-- T191: mother badge — shown only when this folder cut ≥1 visible worktree
           (D2, structural: no badge for an idle orchestrator with zero children).
           role=button (not a nested <button>) since the folder row is itself one.
           Clicking collapses/expands the children; the count stays visible either
           way (D5 — collapsing never hides the information). -->
      <span
        v-if="lineageChildCount && lineageChildCount > 0"
        role="button"
        tabindex="0"
        class="flex shrink-0 items-center text-text-4 transition hover:text-text-2"
        style="gap: 3px; font-size: 10.5px"
        :title="$t('sidebar.lineageBadge', { n: lineageChildCount })"
        :aria-label="$t('sidebar.lineageBadge', { n: lineageChildCount })"
        @click.stop="toggleLineage"
        @keydown.enter.stop="toggleLineage"
        @keydown.space.stop.prevent="toggleLineage"
      >
        <GitFork :size="11" :stroke-width="1.6" aria-hidden="true" />
        <span class="tabular-nums">{{ lineageChildCount }}</span>
      </span>

      <!-- Inline action cluster (spec 2026-06-24): older / archived peeks + new
           session, replacing the old session-count badge. role=button (not a
           <button>) since the folder row is itself a <button>. Rests hidden;
           revealed on row hover / keyboard focus / active peek (T118). -->
      <span
        class="flex shrink-0 items-center transition-opacity"
        :class="folderStatsRevealClass"
        style="gap: 9px"
      >
        <span
          v-for="p in peekActions"
          :key="p.kind"
          role="button"
          tabindex="0"
          class="flex cursor-pointer items-center transition"
          :class="p.revealed ? 'text-accent' : 'text-text-4 hover:text-text-2'"
          style="gap: 3px; font-size: 10.5px"
          :title="p.label"
          :aria-label="p.label"
          @click.stop="peek(p.kind)"
          @keydown.enter.stop.prevent="peek(p.kind)"
          @keydown.space.stop.prevent="peek(p.kind)"
        >
          <component :is="p.icon" :size="11" :stroke-width="1.6" />
          <span class="tabular-nums">{{ p.count }}</span>
        </span>

        <span
          role="button"
          tabindex="0"
          class="flex cursor-pointer items-center text-text-4 transition hover:text-accent"
          :title="$t('sidebar.newSession')"
          :aria-label="$t('sidebar.newSession')"
          @click.stop="onNewSession"
          @keydown.enter.stop.prevent="onNewSession"
          @keydown.space.stop.prevent="onNewSession"
        >
          <Plus :size="12" :stroke-width="1.8" />
        </span>
      </span>
    </button>

    <!-- Children container -->
    <div
      class="overflow-hidden transition-[max-height] duration-300 ease-out"
      :style="{ maxHeight: expanded ? '2000px' : '0' }"
    >
      <template v-for="row in sessionRows.rows" :key="rowKey(row)">
        <template v-for="s in [row.session]" :key="s.sessionId">
          <button
            data-session-row
            class="sidebar-row group relative flex w-full cursor-pointer items-center text-left transition"
            :class="
              sessions.selectedId === s.sessionId ? 'text-text' : 'text-text-2 hover:text-text'
            "
            :data-session-id="s.sessionId"
            :data-focused="sessionFocused(s.sessionId) ? 'true' : null"
            :data-selected="sessions.selectedId === s.sessionId ? 'true' : null"
            :style="{
              height: `${metrics.sessionRowHeight}px`,
              width: '100%',
              margin: '0',
              paddingLeft: `${sessionPaddingLeft}px`,
              paddingRight: '12px',
              gap: `${metrics.gap}px`,
              fontSize: '12.5px',
              fontWeight: sessions.selectedId === s.sessionId ? 500 : 400,
              background:
                sessions.selectedId === s.sessionId ? 'var(--color-accent-soft)' : 'transparent'
            }"
            @click="sessions.select(s.sessionId)"
            @contextmenu="(e) => onSessionContext(e, s.sessionId)"
            @mouseenter="
              (e) => {
                const el = e.currentTarget as HTMLElement
                if (sessions.selectedId !== s.sessionId)
                  el.style.background = 'rgba(255,255,255,0.025)'
                hoverPreview.enter(s.sessionId, el.getBoundingClientRect())
              }
            "
            @mouseleave="
              (e) => {
                if (sessions.selectedId !== s.sessionId)
                  (e.currentTarget as HTMLElement).style.background = 'transparent'
                hoverPreview.leave()
              }
            "
          >
            <!-- Accent bar (selected) -->
            <span
              v-if="sessions.selectedId === s.sessionId"
              class="absolute left-0 top-0 bg-accent"
              style="width: 2px; height: 100%; border-radius: 0 2px 2px 0"
              aria-hidden="true"
            />

            <span
              class="flex shrink-0 items-center justify-center"
              style="width: 12px; height: 12px"
            >
              <ChevronRight
                v-if="agentsOf(s).length"
                :size="11"
                :stroke-width="1.8"
                class="cursor-pointer text-text-4 transition-transform hover:text-text"
                :style="{
                  transform: sessions.isAgentsExpanded(s.sessionId)
                    ? 'rotate(90deg)'
                    : 'rotate(0deg)',
                  transitionDuration: 'var(--dur)',
                  transitionTimingFunction: 'var(--ease)'
                }"
                role="button"
                :aria-label="$t('agent.toggle')"
                @click.stop="sessions.toggleAgents(s.sessionId)"
              />
            </span>

            <!-- Status slot — fixed 14×14, centered (design.md §6 "Row anatomy
               & indentation"). Holds EXACTLY ONE glyph below (a 6px dot or an
               11px icon); the fixed box keeps every row's label starting at the
               same x, whatever status it carries. -->
            <span
              class="flex shrink-0 items-center justify-center"
              style="width: 14px; height: 14px"
            >
              <Cloud
                v-if="!s.resumable"
                :size="11"
                :stroke-width="1.6"
                class="shrink-0 text-text-4"
                :aria-label="$t('session.statusCloud')"
              />
              <!-- hibernated (T119): parked to reclaim memory. Precedes the dot chain —
               a parked session has no task-state, because nothing is running. Muted, never
               red: the operator did nothing wrong and nothing was lost. -->
              <Moon
                v-else-if="s.hibernated"
                :size="11"
                :stroke-width="1.6"
                class="shrink-0 text-text-4"
                :aria-label="$t('session.statusHibernated')"
              />
              <span
                v-else-if="statusDot(s) === 'working'"
                class="anim-pulse-dot shrink-0 rounded-full bg-green"
                style="width: 6px; height: 6px"
                :aria-label="$t('session.statusActive')"
              />
              <span
                v-else-if="statusDot(s) === 'needs-input'"
                class="anim-attention-dot shrink-0 rounded-full bg-warning"
                style="width: 6px; height: 6px"
                :aria-label="$t('session.statusNeedsInput')"
              />
              <span
                v-else-if="statusDot(s) === 'failed'"
                class="shrink-0 rounded-full bg-red"
                style="width: 6px; height: 6px"
                :aria-label="$t('session.statusFailed')"
              />
              <span
                v-else-if="statusDot(s) === 'stuck'"
                class="shrink-0 rounded-full border border-red"
                style="width: 6px; height: 6px"
                :aria-label="$t('session.statusStuck')"
                :title="$t('session.statusStuckHint')"
              />
              <Check
                v-else-if="statusDot(s) === 'completed'"
                :size="11"
                :stroke-width="1.8"
                class="shrink-0 text-text-4"
                :aria-label="$t('session.statusCompleted')"
              />
              <span
                v-else-if="statusDot(s) === 'archived'"
                class="shrink-0 rounded-full border border-text-4"
                style="width: 6px; height: 6px; opacity: 0.55"
                :aria-label="$t('session.statusArchived')"
              />
              <span
                v-else
                class="shrink-0 rounded-full bg-text-4"
                style="width: 6px; height: 6px"
                :aria-label="$t('session.statusIdle')"
              />
            </span>

            <span
              class="min-w-0 flex-1 truncate"
              :style="isArchived(s) || !s.resumable || s.hibernated ? { opacity: 0.62 } : undefined"
              >{{ labelFor(s) }}</span
            >

            <!-- Trailing chips overlay (design.md §6 "Trailing chips overlay
               the label"). Absolutely positioned so it reserves NO horizontal
               column — the label spans the full row and truncates beneath it.
               A short left-fading scrim masks the label tail so a chip reads
               cleanly over it. `pointer-events: none` on the cluster; only the
               interactive teammate toggle re-enables them. -->
            <span
              v-if="hasTrailingChips(s)"
              class="sidebar-trailing"
              :style="{ gap: `${metrics.gap}px` }"
            >
              <span
                class="sidebar-trailing-scrim transition-opacity"
                :class="trailingScrimClass(s)"
                aria-hidden="true"
              />

              <!-- StopFailure reason badge (stopfailure-badges spec §4.6) -->
              <span
                v-if="fBadge(s)"
                class="relative shrink-0 truncate tabular-nums"
                :class="fBadge(s)!.variant === 'red' ? 'text-red' : 'text-warning'"
                style="font-size: 10px; max-width: 150px"
                :title="fBadgeLabel(s)"
                >{{ fBadgeLabel(s) }}</span
              >

              <!-- Subagent-count chip — hover-only (T118); the left chevron
                 keeps signaling that agents exist. -->
              <span
                v-if="agentsOf(s).length"
                class="relative flex shrink-0 items-center text-text-4 transition-opacity"
                :class="chipRevealClass(s)"
                style="font-size: 10.5px; gap: 2px"
                :aria-label="$t('agent.count', { n: agentsOf(s).length })"
                :title="$t('agent.count', { n: agentsOf(s).length })"
              >
                <Bot :size="11" :stroke-width="1.6" />
                <span class="tabular-nums">{{ agentsOf(s).length }}</span>
              </span>

              <!-- Orchestrator role badge (T98): inert, "status not an action"
                 like the folder-level agent-control badge — real state lives in
                 `orchestrator-guard.ts`'s armed.json, mirrored via
                 `sessions.isSessionOrchestratorOn`. -->
              <span
                v-if="sessions.isSessionOrchestratorOn(s.sessionId)"
                class="relative flex shrink-0 items-center text-accent"
                :title="$t('sidebar.orchestratorBadge')"
                :aria-label="$t('sidebar.orchestratorBadge')"
              >
                <Crown :size="11" :stroke-width="1.6" aria-hidden="true" />
              </span>

              <!-- Teammate-group chip (T99): click to expand/collapse the nested
                 teammate rows below this lead's row. Hover-only while collapsed;
                 pinned visible while expanded — it is the collapse control (T118). -->
              <span
                v-if="teammatesOf(s.sessionId).length"
                role="button"
                tabindex="0"
                class="relative flex shrink-0 cursor-pointer items-center transition"
                style="gap: 2px; font-size: 10.5px; pointer-events: auto"
                :class="[
                  isTeammatesExpanded(s.sessionId)
                    ? 'text-accent'
                    : 'text-text-4 hover:text-text-2',
                  chipRevealClass(s, isTeammatesExpanded(s.sessionId))
                ]"
                :title="
                  teammatesToggleLabel(
                    isTeammatesExpanded(s.sessionId),
                    teammatesOf(s.sessionId).length
                  )
                "
                :aria-label="
                  teammatesToggleLabel(
                    isTeammatesExpanded(s.sessionId),
                    teammatesOf(s.sessionId).length
                  )
                "
                @click.stop="toggleTeammatesExpanded(s.sessionId)"
                @keydown.enter.stop.prevent="toggleTeammatesExpanded(s.sessionId)"
                @keydown.space.stop.prevent="toggleTeammatesExpanded(s.sessionId)"
              >
                <Users :size="11" :stroke-width="1.6" />
                <span class="tabular-nums">{{ teammatesOf(s.sessionId).length }}</span>
              </span>

              <!-- Mission chip (Mission v3): the compact headline in the pill's
                 tone, last in the cluster. Pinned when the operator owes it. -->
              <span
                v-if="missionOf(s)"
                class="relative flex shrink-0 items-center tabular-nums transition-opacity"
                :class="[
                  TONE_TEXT_CLASS[missionOf(s)!.tone],
                  chipRevealClass(s, missionOf(s)!.needsYou)
                ]"
                style="font-size: 10.5px; gap: 3px"
                :title="missionChipLabel(missionOf(s)!)"
                :aria-label="missionChipLabel(missionOf(s)!)"
                data-dsqa="sidebar-mission-chip"
                :data-tone="missionOf(s)!.tone"
              >
                <TriangleAlert
                  v-if="missionOf(s)!.needsYou && missionOf(s)!.tone === 'warning'"
                  :size="10"
                  :stroke-width="2"
                  aria-hidden="true"
                />
                {{ headlineText(t, missionOf(s)!.headline, true) }}
              </span>
            </span>
          </button>

          <!-- Nested agents (issue #9) -->
          <div
            v-if="agentsOf(s).length"
            class="overflow-hidden transition-[max-height] duration-300 ease-out"
            :style="{ maxHeight: sessions.isAgentsExpanded(s.sessionId) ? '1000px' : '0' }"
          >
            <div
              v-for="a in agentsOf(s)"
              :key="a.agentId"
              class="agent-row flex w-full items-center text-left text-text-2 transition"
              :style="{
                height: `${metrics.childRowHeight}px`,
                paddingLeft: `${childPaddingLeft}px`,
                paddingRight: '12px',
                gap: '7px',
                fontSize: '11.5px'
              }"
              :title="a.task || agentLabel(a)"
            >
              <CornerDownRight :size="11" :stroke-width="1.6" class="shrink-0 text-text-4" />
              <Bot :size="12" :stroke-width="1.6" class="shrink-0 text-text-3" />
              <span class="flex-1 truncate">{{ agentLabel(a) }}</span>
              <span
                v-if="agentOrigin(a)"
                class="shrink-0 truncate font-mono text-text-4"
                style="font-size: 10px; max-width: 120px"
                :title="agentOrigin(a)"
                >{{ agentOrigin(a) }}</span
              >
              <span
                v-if="a.status === 'running'"
                class="flex shrink-0 items-center text-green"
                style="gap: 5px"
              >
                <span
                  class="anim-pulse-dot rounded-full bg-green"
                  style="width: 6px; height: 6px"
                />
                <span style="font-size: 10.5px">{{ $t('agent.statusRunning') }}</span>
              </span>
              <span v-else class="flex shrink-0 items-center text-text-4" style="gap: 4px">
                <Check :size="11" :stroke-width="1.8" />
                <span style="font-size: 10.5px">{{ $t('agent.statusDone') }}</span>
              </span>
            </div>
          </div>

          <!-- Nested teammates (T99): collapsed by default, expand via the chip
             above. Real, selectable sessions — see "Anatomia da row de
             teammate" (design.md). -->
          <div
            v-if="teammatesOf(s.sessionId).length && isTeammatesExpanded(s.sessionId)"
            class="flex flex-col"
          >
            <button
              v-for="tm in teammatesOf(s.sessionId)"
              :key="tm.sessionId"
              data-teammate-row
              :data-session-id="tm.sessionId"
              class="sidebar-row group relative flex w-full cursor-pointer items-center text-left transition"
              :class="
                sessions.selectedId === tm.sessionId ? 'text-text' : 'text-text-2 hover:text-text'
              "
              :style="{
                height: `${metrics.childRowHeight}px`,
                paddingLeft: `${childPaddingLeft}px`,
                paddingRight: '12px',
                gap: '7px',
                fontSize: '11.5px'
              }"
              @click="onSelectTeammate(tm)"
            >
              <CornerDownRight :size="11" :stroke-width="1.6" class="shrink-0 text-text-4" />
              <!-- Status slot — fixed 13×13, centered (design.md §6). Same
                 fixed-box rule as the session row, one level smaller. -->
              <span
                class="flex shrink-0 items-center justify-center"
                style="width: 13px; height: 13px"
              >
                <Cloud
                  v-if="!tm.resumable"
                  :size="11"
                  :stroke-width="1.6"
                  class="shrink-0 text-text-4"
                />
                <span
                  v-else-if="statusDot(tm) === 'working'"
                  class="anim-pulse-dot shrink-0 rounded-full bg-green"
                  style="width: 6px; height: 6px"
                />
                <span
                  v-else-if="statusDot(tm) === 'needs-input'"
                  class="anim-attention-dot shrink-0 rounded-full bg-warning"
                  style="width: 6px; height: 6px"
                />
                <span
                  v-else-if="statusDot(tm) === 'failed'"
                  class="shrink-0 rounded-full bg-red"
                  style="width: 6px; height: 6px"
                />
                <span
                  v-else-if="statusDot(tm) === 'stuck'"
                  class="shrink-0 rounded-full border border-red"
                  style="width: 6px; height: 6px"
                />
                <Check
                  v-else-if="statusDot(tm) === 'completed'"
                  :size="11"
                  :stroke-width="1.8"
                  class="shrink-0 text-text-4"
                />
                <span
                  v-else
                  class="shrink-0 rounded-full bg-text-4"
                  style="width: 6px; height: 6px"
                />
              </span>
              <span class="flex-1 truncate">{{ labelFor(tm) }}</span>
              <span class="tabular-nums text-text-4" style="font-size: 10.5px">{{
                relativeTime(tm.modified)
              }}</span>
            </button>
          </div>
        </template>
      </template>

      <!-- Terminals sub-group (plain shells bound to the folder cwd) -->
      <template v-if="terminalList.length">
        <!-- Eyebrow label — reuses the Section-label typography (design.md §6) -->
        <div
          class="flex items-center text-text-4 uppercase"
          :style="{
            height: `${metrics.eyebrowHeight}px`,
            margin: '0',
            paddingLeft: `${rowLabelPaddingLeft}px`,
            paddingRight: '12px',
            gap: '6px',
            fontSize: '10.5px',
            fontWeight: 500,
            letterSpacing: '0.06em'
          }"
        >
          <span>{{ $t('sidebar.terminals') }}</span>
        </div>

        <button
          v-for="(term, idx) in terminalList"
          :key="term.sessionId"
          data-terminal-row
          :data-session-id="term.sessionId"
          :data-focused="sessionFocused(term.sessionId) ? 'true' : null"
          class="sidebar-row group relative flex w-full cursor-pointer items-center text-left transition"
          :class="
            sessions.selectedId === term.sessionId ? 'text-text' : 'text-text-2 hover:text-text'
          "
          :style="{
            height: `${metrics.terminalRowHeight}px`,
            width: '100%',
            margin: '0',
            paddingLeft: `${sessionPaddingLeft}px`,
            paddingRight: '12px',
            gap: `${metrics.gap}px`,
            fontSize: '12.5px',
            fontWeight: sessions.selectedId === term.sessionId ? 500 : 400,
            background:
              sessions.selectedId === term.sessionId ? 'var(--color-accent-soft)' : 'transparent'
          }"
          @click="sessions.select(term.sessionId)"
        >
          <!-- Accent bar (selected) -->
          <span
            v-if="sessions.selectedId === term.sessionId"
            class="absolute left-0 top-0 bg-accent"
            style="width: 2px; height: 100%; border-radius: 0 2px 2px 0"
            aria-hidden="true"
          />

          <!-- Reserved agent-toggle slot — always empty on a terminal row (a
               shell spawns no subagents), kept so the terminal's status slot
               and label land in the same columns as the folder's session rows
               (design.md §6 "Row anatomy & indentation"). -->
          <span class="shrink-0" style="width: 12px" aria-hidden="true" />

          <!-- Status indicator: a screen-detected agent state (A2 two-tier
               detection) shows the SAME status dot as a session row — amber when
               it needs you, green while working; otherwise the terminal icon.
               Wrapped in the session rows' fixed 14px status slot so the label
               never shifts. -->
          <span class="flex shrink-0 items-center justify-center" style="width: 14px">
            <span
              v-if="term.taskState === 'needs-input'"
              class="anim-attention-dot rounded-full bg-warning"
              style="width: 6px; height: 6px"
              :aria-label="$t('session.statusNeedsInput')"
            />
            <span
              v-else-if="term.taskState === 'working'"
              class="anim-pulse-dot rounded-full bg-green"
              style="width: 6px; height: 6px"
              :aria-label="$t('session.statusActive')"
            />
            <SquareTerminal
              v-else
              :size="13"
              :stroke-width="1.6"
              :class="sessions.selectedId === term.sessionId ? 'text-text-2' : 'text-text-4'"
            />
          </span>
          <span class="flex-1 truncate">{{ terminalLabel(idx) }}</span>

          <!-- Close affordance (hover / selected) -->
          <span
            role="button"
            tabindex="-1"
            class="flex shrink-0 items-center justify-center rounded text-text-4 transition hover:bg-surface-2 hover:text-text"
            :class="
              sessions.selectedId === term.sessionId
                ? 'opacity-100'
                : 'opacity-0 group-hover:opacity-100'
            "
            style="width: 18px; height: 18px"
            :aria-label="$t('sidebar.closeTerminal')"
            :title="$t('sidebar.closeTerminal')"
            @click.stop="sessions.closeFolderTerminal(term.sessionId)"
          >
            <X :size="12" :stroke-width="1.8" />
          </span>
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.agent-row:hover {
  background: rgba(255, 255, 255, 0.025);
}

/* Trailing chips overlay (design.md §6). Absolutely positioned at the row's
   right edge so the chips reserve no horizontal column; the label spans the
   full row and truncates beneath them. */
.sidebar-trailing {
  position: absolute;
  top: 0;
  bottom: 0;
  right: 12px;
  display: flex;
  align-items: center;
  pointer-events: none;
  z-index: 2;
}

/* Short left-fading scrim behind the chips — masks the truncated label tail so
   a chip reads cleanly over it. It paints the row's own fill (its tint layered
   over the sidebar color) and fades in over 24px via a mask, so a selected or
   hovered row keeps one continuous background behind the chips. */
.sidebar-trailing-scrim {
  --scrim-tint: transparent;
  position: absolute;
  top: 0;
  bottom: 0;
  right: 0;
  left: -24px;
  background: linear-gradient(var(--scrim-tint), var(--scrim-tint)), var(--color-sidebar);
  mask-image: linear-gradient(to right, transparent, #000 24px);
  pointer-events: none;
}

.sidebar-row:hover:not([data-selected='true']) .sidebar-trailing-scrim {
  --scrim-tint: rgba(255, 255, 255, 0.025);
}

.sidebar-row[data-selected='true'] .sidebar-trailing-scrim {
  --scrim-tint: var(--color-accent-soft);
}

.sidebar-row[data-focused='true'] {
  outline: 2px solid var(--color-accent-line);
  outline-offset: 1px;
  position: relative;
  z-index: 1;
}
</style>
