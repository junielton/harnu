<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Folder, Session, SessionAgent } from '../stores/sessions'
import { useSessionsStore } from '../stores/sessions'
import { sessionTitle } from '../lib/session-label'
import { agentRowLabel, agentRowPlan, agentTypeChip } from '../lib/agent-rows'
import { useHelpersStore } from '../stores/helpers'
import { useHoverPreview } from '../composables/useHoverPreview'
import { useContextMenu } from '../composables/useContextMenu'
import { useFolderMenuActions } from '../composables/useFolderMenuActions'
import { useUiStore } from '../stores/ui'
import { useKeybindingsStore } from '../stores/keybindings'
import { useMissionsStore, type ChipModel } from '../stores/missions'
import SidebarMissionDetail from './SidebarMissionDetail.vue'
import { relativeTime } from '../composables/useRelativeTime'
import { dotFor, type Dot } from './session-dot'
import { failureBadge, type FailureBadge } from './failure-badge'
import { humanizeDuration } from './usage-format'
import { displayAlias } from './folder-alias'
import { shouldConfirmTeammateSelect } from './teammate-grouping'
import { densityMetrics } from './sidebar-density'
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
  Moon,
  PanelRight,
  Plus,
  SquareTerminal,
  TriangleAlert,
  Users,
  X
} from 'lucide-vue-next'

const props = defineProps<{
  folder: Folder
  headerless?: boolean
  embedded?: boolean
}>()

const sessions = useSessionsStore()
const helpers = useHelpersStore()
const hoverPreview = useHoverPreview()
const contextMenu = useContextMenu()
const ui = useUiStore()
const keybindings = useKeybindingsStore()
const { t } = useI18n()
// T486 §3.4: the peeks' function, shared with `folder.toggleOlder` / `.toggleArchived`.
const folderMenuActions = useFolderMenuActions()

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

const expanded = computed(() => props.embedded || props.headerless || props.folder.expanded)
// Display label (T52): a custom alias wins; else, when auto-alias is on for this
// folder and its branch differs from the dir-name, the branch; else the basename.
const label = computed(() =>
  displayAlias(props.folder, sessions.aliasFromBranchPaths.has(props.folder.path))
)

const sessionRows = computed(() => sessions.sidebarSessionRows(props.folder))

/** A leader row's teammates (empty when it doesn't lead a team). */
function teammatesOf(sessionId: string): Session[] {
  return sessionRows.value.teammatesByLeader.get(sessionId) ?? []
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
const rowLabelPaddingLeft = computed(() => metrics.value.sessionIndent + 12 + metrics.value.gap)

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

/**
 * Inline folder-row peek (older / archived): expands a collapsed folder, then
 * reveals (spec 2026-06-24 §4). The same function its keybinding runs.
 */
function peek(kind: 'older' | 'archived'): void {
  if (kind === 'older') folderMenuActions.run.toggleOlder(props.folder.path)
  else folderMenuActions.run.toggleArchived(props.folder.path)
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

// On-demand stats (T118 — design.md §6): the folder row's trailing cluster
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

const missions = useMissionsStore()
missions.ensureStarted()

// Missions v4 S-23: the chip reads the v4 view (the pill's own text and tone) for the session that leads
// the mission, whether the record is a v4 one or a v3 file read through the record store.
function missionOf(s: Session): ChipModel | null {
  return missions.chipFor(s.sessionId)
}

const displayRows = computed(() =>
  sessionRows.value.rows.map(({ session }) => ({ session, mission: missionOf(session) }))
)

function missionChipLabel(m: ChipModel): string {
  return t(m.needsYou ? 'mission.sidebarChipNeedsYou' : 'mission.sidebarChip', {
    headline: m.text
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
  return !!fBadge(s) || agentsOf(s).length > 0 || teammatesOf(s.sessionId).length > 0
}

/** Chips that render regardless of hover — their scrim must always show. */
function hasAlwaysOnChip(s: Session): boolean {
  return !!fBadge(s) || sessions.isAgentsExpanded(s.sessionId) || isTeammatesExpanded(s.sessionId)
}

/** Reveal class for the trailing scrim — matches "any chip is visible". */
function trailingScrimClass(s: Session): string {
  return sessions.selectedId === s.sessionId || sessionFocused(s.sessionId) || hasAlwaysOnChip(s)
    ? 'opacity-100'
    : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
}

function agentLabel(a: SessionAgent): string {
  return agentRowLabel(a, t('agent.subagentLabel'))
}

/** Rows under a session: running agents, one "N done" fold row, then done ones if open. */
function agentRowsOf(s: Session): ReturnType<typeof agentRowPlan<SessionAgent>> {
  return agentRowPlan(agentsOf(s), sessions.isAgentsDoneExpanded(s.sessionId))
}

function lastSession(s: Session): boolean {
  return !terminalList.value.length && sessionRows.value.rows.at(-1)?.session === s
}

function hasExpandedTeammates(s: Session): boolean {
  return isTeammatesExpanded(s.sessionId) && teammatesOf(s.sessionId).length > 0
}

function agentOrigin(a: SessionAgent): string {
  return a.skill || a.plugin || ''
}

/**
 * Select a teammate row — a real session, same action as any session row, but
 * gated when it's currently `working` (T99): the team lead may be driving
 * it right now, and a local
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
  <div :data-folder-path="embedded ? undefined : folder.path" :class="!embedded && 'mb-0.5'">
    <!-- Folder row -->
    <button
      v-if="!headerless && !embedded"
      class="sidebar-row group flex w-full cursor-pointer items-center text-left text-text transition hover:bg-surface"
      style="gap: 4px; font-size: 12.5px; font-weight: 500"
      :style="{
        height: `${metrics.checkoutRowHeight}px`,
        margin: '0',
        paddingLeft: '8px',
        paddingRight: '12px',
        // T212: a selected folder is highlighted the same way a selected session
        // row is — the two selections are peers, so they must read as peers.
        background:
          sessions.selectedFolderPath === folder.path ? 'var(--color-accent-soft)' : 'transparent',
        ...(folderHidden ? { opacity: 0.5 } : {})
      }"
      :data-focused="folderFocused ? 'true' : null"
      :data-sidebar-row="`folder:${folder.path}`"
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
          :title="keybindings.withChord($t('sidebar.newSession'), 'session.newInFolder')"
          :aria-label="$t('sidebar.newSession')"
          @click.stop="onNewSession"
          @keydown.enter.stop.prevent="onNewSession"
          @keydown.space.stop.prevent="onNewSession"
        >
          <Plus :size="12" :stroke-width="1.8" />
        </span>
      </span>
    </button>

    <div :class="!embedded && 'sidebar-disclosure'" :data-open="expanded" :inert="!expanded">
      <div :class="!embedded && 'sidebar-disclosure-content'">
        <template v-for="{ session: s, mission } in displayRows" :key="s.sessionId">
          <button
            data-session-row
            data-dsqa-part="session-row"
            class="sidebar-row sidebar-row-cv sidebar-session-tint group relative flex w-full cursor-pointer items-center text-left transition"
            :class="[
              sessions.selectedId === s.sessionId ? 'text-text' : 'text-text-2 hover:text-text',
              embedded && 'sidebar-tree-guide'
            ]"
            :data-guide-last="
              (lastSession(s) &&
                !hasExpandedTeammates(s) &&
                !(agentsOf(s).length && sessions.isAgentsExpanded(s.sessionId))) ||
              undefined
            "
            :data-session-id="s.sessionId"
            :data-sidebar-row="`session:${s.sessionId}`"
            :data-focused="sessionFocused(s.sessionId) ? 'true' : null"
            :data-selected="sessions.selectedId === s.sessionId ? 'true' : null"
            :style="{
              height: `${metrics.sessionRowHeight}px`,
              width: '100%',
              margin: '0',
              paddingLeft: `${metrics.sessionIndent}px`,
              paddingRight: '12px',
              gap: `${metrics.gap}px`,
              fontSize: '12.5px',
              fontWeight: sessions.selectedId === s.sessionId ? 500 : 400
            }"
            @click="sessions.select(s.sessionId)"
            @contextmenu="(e) => onSessionContext(e, s.sessionId)"
            @mouseenter="
              (e) =>
                hoverPreview.enter(
                  s.sessionId,
                  (e.currentTarget as HTMLElement).getBoundingClientRect()
                )
            "
            @mouseleave="hoverPreview.leave()"
          >
            <!-- Accent bar (selected) -->
            <span
              v-if="sessions.selectedId === s.sessionId"
              class="absolute left-0 top-0 bg-accent"
              style="width: 2px; height: 100%; border-radius: 0 2px 2px 0"
              aria-hidden="true"
            />

            <span class="flex size-3 shrink-0 items-center justify-center">
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

            <span class="relative min-w-0 flex-1 self-stretch flex items-center">
              <span
                class="truncate"
                :class="(isArchived(s) || !s.resumable || s.hibernated) && 'opacity-[.62]'"
                >{{ labelFor(s) }}</span
              >
              {{ ' ' }}
              <SidebarMissionDetail
                v-if="mission && !mission.owed && !hasTrailingChips(s)"
                :chip="mission"
                class="right-0"
              />
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

                <span
                  v-if="agentsOf(s).length"
                  class="relative flex shrink-0 items-center text-text-4 transition-opacity"
                  :class="chipRevealClass(s, sessions.isAgentsExpanded(s.sessionId))"
                  style="font-size: 10.5px; gap: 2px; pointer-events: auto"
                  role="button"
                  tabindex="0"
                  :aria-label="$t('agent.toggle')"
                  :aria-expanded="sessions.isAgentsExpanded(s.sessionId)"
                  :title="$t('agent.count', { n: agentsOf(s).length })"
                  @click.stop="sessions.toggleAgents(s.sessionId)"
                  @keydown.enter.stop.prevent="sessions.toggleAgents(s.sessionId)"
                  @keydown.space.stop.prevent="sessions.toggleAgents(s.sessionId)"
                >
                  <Bot :size="11" :stroke-width="1.6" />
                  <span class="tabular-nums">{{ agentsOf(s).length }}</span>
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
                  :aria-expanded="isTeammatesExpanded(s.sessionId)"
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

                <SidebarMissionDetail v-if="mission" :chip="mission" class="right-full" />
              </span>
            </span>

            <span
              v-if="mission"
              class="relative flex shrink-0 items-center gap-[3px] self-stretch text-[10.5px] text-warning tabular-nums"
              :class="!mission.owed && 'absolute right-0'"
              :title="missionChipLabel(mission)"
              :aria-label="missionChipLabel(mission)"
              data-dsqa="sidebar-mission-chip"
              :data-tone="mission.tone"
            >
              <template v-if="mission.owed">
                <TriangleAlert :size="11" :stroke-width="1.7" aria-hidden="true" />
                <span data-mission-count>{{ mission.owed }}</span>
                <SidebarMissionDetail v-if="!hasTrailingChips(s)" :chip="mission" class="right-0" />
              </template>
            </span>
            <span
              data-icon-slot
              data-dsqa-part="session-trailing-icon"
              class="flex w-3.5 shrink-0 items-center justify-center"
            >
              <Crown
                v-if="sessions.isSessionOrchestratorOn(s.sessionId)"
                :size="12"
                :stroke-width="1.6"
                class="text-warning opacity-85"
                :aria-label="$t('sidebar.orchestratorBadge')"
                :title="$t('sidebar.orchestratorBadge')"
              />
            </span>
          </button>

          <!-- Nested agents (issue #9) -->
          <div
            v-if="agentsOf(s).length"
            class="sidebar-disclosure"
            :data-open="sessions.isAgentsExpanded(s.sessionId)"
            :inert="!sessions.isAgentsExpanded(s.sessionId)"
          >
            <div class="sidebar-disclosure-content">
              <template
                v-for="(agentRow, index) in agentRowsOf(s)"
                :key="agentRow.kind === 'fold' ? 'fold' : agentRow.agent.agentId"
              >
                <button
                  v-if="agentRow.kind === 'fold'"
                  type="button"
                  class="agent-row flex w-full items-center text-left text-text-3 transition hover:text-text-2"
                  data-dsqa="sidebar-agents-done-fold"
                  :class="embedded && 'sidebar-tree-guide relative'"
                  :data-guide-last="
                    (lastSession(s) &&
                      !hasExpandedTeammates(s) &&
                      index === agentRowsOf(s).length - 1) ||
                    undefined
                  "
                  :aria-expanded="agentRow.expanded"
                  :style="{
                    height: `${metrics.childRowHeight}px`,
                    paddingLeft: `${metrics.childIndent}px`,
                    paddingRight: '12px',
                    gap: `${metrics.gap}px`,
                    fontSize: '11.5px'
                  }"
                  @click.stop="sessions.toggleAgentsDone(s.sessionId)"
                >
                  <ChevronRight
                    :size="11"
                    :stroke-width="1.8"
                    class="shrink-0 text-text-4 transition-transform"
                    :style="{
                      transform: agentRow.expanded ? 'rotate(90deg)' : 'rotate(0deg)',
                      transitionDuration: 'var(--dur)',
                      transitionTimingFunction: 'var(--ease)'
                    }"
                    aria-hidden="true"
                  />
                  <span class="flex-1 truncate">{{
                    $t('agent.doneFold', { n: agentRow.count })
                  }}</span>
                </button>
                <div
                  v-else
                  class="agent-row flex w-full items-center text-left text-text-2 transition"
                  :class="embedded && 'sidebar-tree-guide relative'"
                  :data-guide-last="
                    (lastSession(s) &&
                      !hasExpandedTeammates(s) &&
                      index === agentRowsOf(s).length - 1) ||
                    undefined
                  "
                  :style="{
                    height: `${metrics.childRowHeight}px`,
                    paddingLeft: `${metrics.childIndent}px`,
                    paddingRight: '12px',
                    gap: `${metrics.gap}px`,
                    fontSize: '11.5px'
                  }"
                  :title="agentRow.agent.task || agentLabel(agentRow.agent)"
                >
                  <CornerDownRight :size="11" :stroke-width="1.6" class="shrink-0 text-text-4" />
                  <Bot :size="12" :stroke-width="1.6" class="shrink-0 text-text-3" />
                  <span
                    class="flex-1 truncate"
                    :style="{
                      flex: agentRow.agent.status === 'running' ? '1 0 96px' : '1 0 112px'
                    }"
                    >{{ agentLabel(agentRow.agent) }}</span
                  >
                  <span
                    v-if="agentTypeChip(agentRow.agent)"
                    class="truncate font-mono text-text-4"
                    style="font-size: 10px; max-width: 72px; min-width: 0"
                    data-dsqa="sidebar-agent-type-chip"
                    :title="agentTypeChip(agentRow.agent)"
                    >{{ agentTypeChip(agentRow.agent) }}</span
                  >
                  <span
                    v-if="agentOrigin(agentRow.agent)"
                    class="truncate font-mono text-text-4"
                    style="font-size: 10px; max-width: 120px; min-width: 0"
                    :title="agentOrigin(agentRow.agent)"
                    >{{ agentOrigin(agentRow.agent) }}</span
                  >
                  <span
                    v-if="agentRow.agent.status === 'running'"
                    class="flex shrink-0 items-center text-green"
                    style="gap: 5px"
                  >
                    <span
                      class="anim-pulse-dot rounded-full bg-green"
                      style="width: 6px; height: 6px"
                    />
                    <span style="font-size: 10.5px">{{ $t('agent.statusRunning') }}</span>
                  </span>
                </div>
              </template>
            </div>
          </div>

          <!-- Nested teammates (T99): collapsed by default, expand via the chip
             above. Real, selectable sessions — see "Teammate group" (design.md). -->
          <div
            v-if="teammatesOf(s.sessionId).length && isTeammatesExpanded(s.sessionId)"
            class="flex flex-col"
          >
            <button
              v-for="(tm, index) in teammatesOf(s.sessionId)"
              :key="tm.sessionId"
              data-teammate-row
              :data-session-id="tm.sessionId"
              :data-sidebar-row="`session:${tm.sessionId}`"
              :data-focused="sessionFocused(tm.sessionId) ? 'true' : undefined"
              :data-guide-last="
                (lastSession(s) && index === teammatesOf(s.sessionId).length - 1) || undefined
              "
              class="sidebar-row group relative flex w-full cursor-pointer items-center text-left transition"
              :class="[
                sessions.selectedId === tm.sessionId ? 'text-text' : 'text-text-2 hover:text-text',
                embedded && 'sidebar-tree-guide'
              ]"
              :style="{
                height: `${metrics.childRowHeight}px`,
                paddingLeft: `${metrics.childIndent}px`,
                paddingRight: '12px',
                gap: `${metrics.gap}px`,
                fontSize: '11.5px'
              }"
              @click="onSelectTeammate(tm)"
              @contextmenu="(e) => onSessionContext(e, tm.sessionId)"
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

        <!-- Terminals sub-group (plain shells bound to the folder cwd) -->
        <template v-if="terminalList.length">
          <!-- Eyebrow label — reuses the Section-label typography (design.md §6) -->
          <div
            class="relative flex items-center text-text-4 uppercase"
            :class="embedded && 'sidebar-tree-guide'"
            :style="{
              height: `${metrics.eyebrowHeight}px`,
              margin: '0',
              paddingLeft: `${rowLabelPaddingLeft}px`,
              paddingRight: '12px',
              gap: `${metrics.gap}px`,
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
            :data-guide-last="idx === terminalList.length - 1 || undefined"
            :data-session-id="term.sessionId"
            :data-sidebar-row="`session:${term.sessionId}`"
            :data-focused="sessionFocused(term.sessionId) ? 'true' : null"
            class="sidebar-row group relative flex w-full cursor-pointer items-center text-left transition"
            :class="[
              sessions.selectedId === term.sessionId ? 'text-text' : 'text-text-2 hover:text-text',
              embedded && 'sidebar-tree-guide'
            ]"
            :style="{
              height: `${metrics.terminalRowHeight}px`,
              width: '100%',
              margin: '0',
              paddingLeft: `${metrics.sessionIndent}px`,
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

            <span class="flex size-3 shrink-0 items-center justify-center">
              <SquareTerminal
                :size="12"
                :stroke-width="1.6"
                :class="sessions.selectedId === term.sessionId ? 'text-text-2' : 'text-text-4'"
              />
            </span>
            <span class="flex-1 truncate">{{ terminalLabel(idx) }}</span>

            <span data-icon-slot class="flex w-3.5 shrink-0 items-center justify-center">
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
            </span>
          </button>
        </template>
      </div>
    </div>
  </div>
</template>
