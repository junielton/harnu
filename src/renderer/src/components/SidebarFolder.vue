<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Folder, Session, SessionAgent } from '../stores/sessions'
import { useSessionsStore } from '../stores/sessions'
import { sessionTitle } from '../lib/session-label'
import { agentRowLabel, agentRowPlan, agentTypeChip } from '../lib/agent-rows'
import { useHoverPreview } from '../composables/useHoverPreview'
import { useContextMenu } from '../composables/useContextMenu'
import { useMissionsStore, type ChipModel } from '../stores/missions'
import SidebarMissionDetail from './SidebarMissionDetail.vue'
import { relativeTime } from '../composables/useRelativeTime'
import { dotFor, type Dot } from './session-dot'
import { failureBadge, type FailureBadge } from './failure-badge'
import { humanizeDuration } from './usage-format'
import { shouldConfirmTeammateSelect } from './teammate-grouping'
import { densityMetrics } from './sidebar-density'
import {
  Bot,
  Check,
  ChevronRight,
  Cloud,
  CornerDownRight,
  Crown,
  Moon,
  SquareTerminal,
  TriangleAlert,
  Users,
  X
} from 'lucide-vue-next'

/**
 * The rows of one checkout: its sessions, agents, teammates and terminals. The
 * tree draws the rows that name a folder and folds this list (`SidebarTreeFolder`).
 */
const props = defineProps<{
  folder: Folder
}>()

const sessions = useSessionsStore()
const hoverPreview = useHoverPreview()
const contextMenu = useContextMenu()
const { t } = useI18n()

function onSessionContext(e: MouseEvent, sessionId: string): void {
  contextMenu.open(e, sessionId)
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

// Density preset (design.md §4 "Row density" / §6 "Row anatomy & indentation").
// Scales row heights, the session-row gap, and the left indent.
const metrics = computed(() => densityMetrics(sessions.sidebarDensity))
const rowLabelPaddingLeft = computed(() => metrics.value.sessionIndent + 12 + metrics.value.gap)

function sessionFocused(sessionId: string): boolean {
  const c = sessions.keyboardCursor
  return !!c && c.kind === 'session' && c.id === sessionId
}

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
  <div>
    <template v-for="{ session: s, mission } in displayRows" :key="s.sessionId">
      <button
        data-session-row
        data-row-bar="session"
        data-dsqa-part="session-row"
        class="sidebar-row sidebar-row-cv group relative flex w-full cursor-pointer items-center text-left text-text-2 transition sidebar-tree-guide"
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
          fontSize: '12.5px'
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
          <!-- A real space, so the title and the overlaid mission text never read as one word. -->
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
                isTeammatesExpanded(s.sessionId) ? 'text-accent' : 'text-text-4 hover:text-text-2',
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
          class="flex shrink-0 items-center gap-[3px] self-stretch text-[10.5px] text-warning tabular-nums"
          :class="mission.owed ? 'relative' : 'absolute right-0'"
          :title="missionChipLabel(mission)"
          :aria-label="missionChipLabel(mission)"
          data-dsqa="sidebar-mission-chip"
          :data-tone="mission.tone"
        >
          <template v-if="mission.owed">
            <TriangleAlert :size="11" :stroke-width="1.7" aria-hidden="true" />
            <!-- Half a pixel down: puts the 10.5px digits on the title's baseline. -->
            <span data-mission-count class="relative top-[0.5px]">{{ mission.owed }}</span>
            <SidebarMissionDetail v-if="!hasTrailingChips(s)" :chip="mission" class="right-0" />
          </template>
        </span>
        <span
          data-icon-slot
          data-dsqa-part="session-trailing-icon"
          class="flex h-3.5 w-3.5 shrink-0 items-center justify-center"
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
              data-row-bar="session"
              class="agent-row relative flex w-full items-center text-left text-text-3 transition sidebar-tree-guide"
              data-dsqa="sidebar-agents-done-fold"
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
              <span class="flex-1 truncate leading-[14px]">{{
                $t('agent.doneFold', { n: agentRow.count })
              }}</span>
            </button>
            <div
              v-else
              data-row-bar="session"
              class="agent-row relative flex w-full items-center text-left text-text-2 transition sidebar-tree-guide"
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
              <!-- The title gives way first: it takes the spare room, and the type and skill keep
                   their width until it is down to 48px. They shrink 1000 times faster than it, so
                   it only goes below that when they have nothing left. -->
              <!-- The three font sizes in this row share one baseline: the smaller ones sit lower. -->
              <span class="shrink grow basis-12 truncate leading-[14px]">{{
                agentLabel(agentRow.agent)
              }}</span>
              <span
                v-if="agentTypeChip(agentRow.agent)"
                class="relative top-[0.5px] shrink-[1000] truncate font-mono leading-[14px] text-text-4"
                style="font-size: 10px; max-width: 72px; min-width: 0"
                data-dsqa="sidebar-agent-type-chip"
                :title="agentTypeChip(agentRow.agent)"
                >{{ agentTypeChip(agentRow.agent) }}</span
              >
              <span
                v-if="agentOrigin(agentRow.agent)"
                class="relative top-[0.5px] shrink-[1000] truncate font-mono leading-[14px] text-text-4"
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
                <span class="relative top-[0.5px]" style="font-size: 10.5px">{{
                  $t('agent.statusRunning')
                }}</span>
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
          data-row-bar="session"
          :data-session-id="tm.sessionId"
          :data-sidebar-row="`session:${tm.sessionId}`"
          :data-focused="sessionFocused(tm.sessionId) ? 'true' : undefined"
          :data-selected="sessions.selectedId === tm.sessionId ? 'true' : null"
          :data-guide-last="
            (lastSession(s) && index === teammatesOf(s.sessionId).length - 1) || undefined
          "
          class="sidebar-row group relative flex w-full cursor-pointer items-center text-left text-text-2 transition sidebar-tree-guide"
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
          <span class="flex shrink-0 items-center justify-center" style="width: 13px; height: 13px">
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
            <span v-else class="shrink-0 rounded-full bg-text-4" style="width: 6px; height: 6px" />
          </span>
          <span class="flex-1 truncate leading-[14px]">{{ labelFor(tm) }}</span>
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
        class="relative flex items-center text-text-4 uppercase sidebar-tree-guide"
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
        data-row-bar="session"
        :data-guide-last="idx === terminalList.length - 1 || undefined"
        :data-session-id="term.sessionId"
        :data-sidebar-row="`session:${term.sessionId}`"
        :data-focused="sessionFocused(term.sessionId) ? 'true' : null"
        :data-selected="sessions.selectedId === term.sessionId ? 'true' : null"
        class="sidebar-row group relative flex w-full cursor-pointer items-center text-left text-text-2 transition sidebar-tree-guide"
        :style="{
          height: `${metrics.terminalRowHeight}px`,
          width: '100%',
          margin: '0',
          paddingLeft: `${metrics.sessionIndent}px`,
          paddingRight: '12px',
          gap: `${metrics.gap}px`,
          fontSize: '12.5px'
        }"
        @click="sessions.select(term.sessionId)"
      >
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
</template>
