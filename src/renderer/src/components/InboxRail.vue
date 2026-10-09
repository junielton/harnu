<script setup lang="ts">
/**
 * Fleet rail (T83 S0, converted to the Fleet rail T151) — the fleet-wide
 * approval queue AND live fleet state, as a persistent FOURTH COLUMN, not an
 * overlay.
 *
 * It replaces the old `ApprovalInbox.vue` modal, which had one fatal flaw: it
 * took a click to find out whether anything was waiting on you. Supervising 4–5
 * agents, "is something blocked?" has to be answerable with a glance, not a
 * gesture — a parked confirm behind a closed modal is an invisible confirm.
 * T151 extends that same glance to "what is the fleet doing right now?": the
 * rail's scrolling body is now the Fleet bucket cards (below), reusing
 * `FleetBoardCard.vue` and `sessions.boardBuckets` unchanged — no new
 * heuristics, just a projection with idle hidden and no state labels (the
 * card's 16px state ring carries the state instead — design.md §7).
 *
 * Three rail states (`layout.inboxRailState`):
 *   - `expanded`  — the full panel (width `layout.inboxRailWidth`).
 *   - `minimized` — a 44px strip that shows the badge AND the whole fleet, as
 *     one 28px minicard per non-idle session (same projection, same tier
 *     order, same state ring). Minimizing reduces area, never information:
 *     it used to cost the operator the entire fleet, which was backwards,
 *     because minimizing is exactly when the glance matters most.
 *   - `hidden`    — off. A HARD state, like `minimized`: the rail NEVER
 *     expands itself on an arrival any more. That auto-summon existed only
 *     because a minimized strip showed nothing; with the fleet legible at
 *     44px it would be an interruption. `layout.summonInboxRail()` survives
 *     for the OS-notification deep-link alone — a real operator gesture.
 *
 * Sections are STACKED, top to bottom: Active missions (strip) → Fleet (the
 * scrolling body) → Needs you (collapsible, actionable, default open) →
 * Would-have (collapsible, read-only shadow log, default closed). Activity
 * (the notification history) moved out of the rail in T152 — it now lives in
 * the topbar's Activity bell (`ActivityBell.vue`). Needs-you and Would-have
 * share one visual language (a chevron header over a `.collapsible`
 * grid-rows body) so the actionable list can never be hidden behind an
 * unselected tab.
 *
 * NOT a dialog: no backdrop, no focus trap, no `aria-modal`, no 'modal' keyboard
 * scope, no Esc-to-close. It's a `<complementary>` region — the caret stays in
 * the terminal when it appears. If this ever starts stealing focus, it has
 * become the modal we deleted.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { sessionTitle } from '../lib/session-label'
import { onClickOutside, onKeyStroke } from '@vueuse/core'
import { useHoverPreview } from '../composables/useHoverPreview'
import { useContextMenu } from '../composables/useContextMenu'
import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  Check,
  ChevronDown,
  ChevronsRight,
  ListFilter,
  TriangleAlert
} from 'lucide-vue-next'
import { useSessionsStore, type Session } from '../stores/sessions'
import { useLayoutStore, INBOX_RAIL_FILTERABLE_STATES } from '../stores/layout'
import { relativeTime } from '../composables/useRelativeTime'
import { useMissionGrants } from '../composables/useMissionGrants'
import ApprovalRow from './ApprovalRow.vue'
import McpConfirmRow from './McpConfirmRow.vue'
import FleetBoardCard from './FleetBoardCard.vue'
import ToggleSwitch from './ui/ToggleSwitch.vue'
import type { BoardState } from './fleet-board'
import type { ResponderMode, ShadowEntry } from '../../../preload'

const sessions = useSessionsStore()
const layout = useLayoutStore()
const { t } = useI18n()

// Minimized-strip minicards reuse the EXACT interactions the expanded cards
// have (`FleetBoardCard.vue`): click selects, right-click opens the session
// menu, hover opens the preview. At 28px the preview isn't a nicety — it is
// the only way to tell two sessions apart, so it must not be dropped here.
const hoverPreview = useHoverPreview()
const contextMenu = useContextMenu()

// Live mission grants (T44 S5c) — the compact strip at the top: the running
// missions whose escalations land in "Needs you" below. The composable owns
// fetch/subscribe/revoke + TTL; same data source as the Settings section.
const { activeGrants, revoke: revokeGrant, minutesLeft } = useMissionGrants()

const minimized = computed(() => layout.inboxRailState === 'minimized')

/**
 * Fleet bucket cards — the rail's scrolling body (design.md — Fleet rail,
 * T151). A flattening of `sessions.boardBuckets` (already in the anti-flood
 * tier order needs-input → errored → stuck → working → idle → done — the
 * SAME order the old sidebar board used): `idle` is dropped (never rendered
 * in the rail — the fleet's own empty state covers an idle-only fleet),
 * everything else keeps its bucket order and per-bucket sort (creation order,
 * newest first unless the header toggle inverts it — T459). The minimized
 * strip's minicards flatten the same list, so both views always agree.
 */
const fleetCards = computed<Array<{ session: Session; folderAlias: string; state: BoardState }>>(
  () => {
    const byId = new Map(sessions.allSessions.map((s) => [s.sessionId, s]))
    const cards: Array<{ session: Session; folderAlias: string; state: BoardState }> = []
    for (const bucket of sessions.boardBuckets) {
      if (bucket.state === 'idle') continue
      for (const slice of bucket.sessions) {
        const session = byId.get(slice.sessionId)
        if (session) cards.push({ session, folderAlias: slice.folderAlias, state: bucket.state })
      }
    }
    return cards
  }
)

/**
 * Fleet rail state filter (T159) — which of `fleetCards`' five non-idle
 * states actually render. `fleetCards` above stays UNFILTERED on purpose: it
 * is the honest source both `fleetStateCounts` (the popover's live counts)
 * and `hiddenAttentionCount` (the safety affordance below) read from, so
 * filtering can never quietly corrupt the numbers that report urgency.
 *
 * SAFETY DIVERGENCE from this repo's usual filtered-view convention
 * (`CleanupView.vue`/`RoadmapBoard.vue`, where header counts reflect the
 * filtered set): the Fleet rail's header badge and the minimized strip's
 * badge (both `sessions.inboxCount`, below) are approvals/parked-confirms
 * counts, entirely independent of this state filter — they must NEVER be
 * derived from `visibleFleetCards`. If a future change makes them read the
 * filtered list "for consistency," a filtered-to-`working` rail would hide a
 * session that just went `errored` with no visible signal, defeating the
 * rail's entire reason to exist. Do not "fix" this into consistency.
 */
const visibleFleetCards = computed(() =>
  fleetCards.value.filter((card) => !layout.inboxRailHiddenStates.has(card.state))
)

/** Live per-state counts (unfiltered) for the filter popover's rows. */
const fleetStateCounts = computed<Record<BoardState, number>>(() => {
  const counts = Object.fromEntries(INBOX_RAIL_FILTERABLE_STATES.map((s) => [s, 0])) as Record<
    BoardState,
    number
  >
  for (const card of fleetCards.value) counts[card.state]++
  return counts
})

// The three states that demand action (needs-input/errored/stuck), vs.
// working/done which don't. Kept as a local literal rather than importing from
// `stores/sessions.ts`: that file's classifier internals are out of scope for
// this change (BUG-53 owns them in a parallel unit). Membership only — card
// ORDER inside a state is creation order for every tier (T459).
const ATTENTION_TIER_STATES: ReadonlySet<BoardState> = new Set(['needs-input', 'errored', 'stuck'])

/** How many currently-hidden cards are in an attention tier — the count the
 *  "N hidden" affordance below warns about and one click clears. */
const hiddenAttentionCount = computed(
  () =>
    fleetCards.value.filter(
      (card) =>
        ATTENTION_TIER_STATES.has(card.state) && layout.inboxRailHiddenStates.has(card.state)
    ).length
)

/** Tooltip + aria-label of the order toggle: current order and what a click does. */
const orderLabel = computed(() =>
  t(
    layout.inboxRailOrder === 'newest-first'
      ? 'approvalInbox.order.newestFirst'
      : 'approvalInbox.order.oldestFirst'
  )
)

const hasActiveStateFilter = computed(() => layout.inboxRailHiddenStates.size > 0)

const filterAnchorRef = ref<HTMLElement | null>(null)
const filterPopoverOpen = ref(false)
onClickOutside(filterAnchorRef, () => (filterPopoverOpen.value = false))
onKeyStroke('Escape', () => (filterPopoverOpen.value = false))

/** `BoardState` → the existing `board.state.*` i18n key (FleetBoardCard's
 *  own dot labels) — reused verbatim so the popover's legend copy never
 *  drifts from what the cards themselves already announce. */
function stateLabelKey(state: BoardState): string {
  switch (state) {
    case 'needs-input':
      return 'board.state.needsInput'
    case 'errored':
      return 'board.state.errored'
    case 'stuck':
      return 'board.state.stuck'
    case 'working':
      return 'board.state.working'
    default:
      return 'board.state.done'
  }
}

/** A minicard's accessible name: the badge alone is unlabelled, so the button
 *  carries "<session title> — <state>". Reuses `stateLabelKey` so the wording
 *  can never drift from the filter popover's legend or the cards' own dots. */
function minicardLabel(card: { session: Session; state: BoardState }): string {
  const title = sessionTitle(card.session, sessions.allSessions, t) || t('session.unnamed')
  return `${title} — ${t(stateLabelKey(card.state))}`
}

function onMinicardContext(e: MouseEvent, sessionId: string): void {
  contextMenu.open(e, sessionId)
}
function onMinicardEnter(e: MouseEvent, sessionId: string): void {
  hoverPreview.enter(sessionId, (e.currentTarget as HTMLElement).getBoundingClientRect())
}

const approvals = computed(() => sessions.pendingApprovalList)
// Parked agent confirms (T44 S4c) — fail-CLOSED, so they lead the queue.
const parkedConfirms = computed(() => sessions.parkedConfirmList)

const isEmpty = computed(() => approvals.value.length === 0 && parkedConfirms.value.length === 0)

// Needs-you is a collapsible section like Would-have (T151) — default
// COLLAPSED, manually toggleable, but never auto-collapses on its own once
// the operator opens it.
const needsYouOpen = ref(false)

// Would-have (the shadow log): collapsed by default. It's diagnostic, not
// attention — it earns a footer section, not a peer tab (T83 §5.4).
const wouldHaveOpen = ref(false)
const shadowLog = ref<ShadowEntry[]>([])
const responderModeSnapshot = ref<ResponderMode>('shadow')

/** The shadow entry's session as every surface names it, or '' (BUG-78). */
function shadowSessionName(sessionId: string): string {
  const s = sessions.findSessionById(sessionId)
  return s ? sessionTitle(s, sessions.allSessions, t) : ''
}

/** Shadow entries most-recent first, enriched with folder alias + session name. */
const shadowRows = computed(() =>
  [...shadowLog.value]
    .sort((a, b) => b.ts - a.ts)
    .map((e) => ({
      ...e,
      folderAlias: sessions.folderAliasOf(e.sessionId),
      sessionSummary: shadowSessionName(e.sessionId)
    }))
)

const isPaused = computed(() => responderModeSnapshot.value === 'off')

async function loadShadowLog(): Promise<void> {
  try {
    shadowLog.value = await window.api.responderGetShadowLog()
  } catch {
    /* leave last-known snapshot */
  }
  try {
    responderModeSnapshot.value = (await window.api.responderStatus()).mode
  } catch {
    /* leave last-known mode */
  }
}

/** Epoch-ms → relative label (the helper takes an ISO string). Used by the
 *  Would-have rows below. */
function relativeTimeMs(ts: number): string {
  return relativeTime(new Date(ts).toISOString())
}

// The rail is always mounted, so the old open-the-modal refresh trigger is gone.
// Pull the snapshot when the operator actually expands the section (it's a ring
// preview, not a queue — no stream, and no reason to poll it while collapsed).
watch(wouldHaveOpen, (open) => {
  if (open) void loadShadowLog()
})
onMounted(() => {
  if (wouldHaveOpen.value) void loadShadowLog()
})
</script>

<template>
  <aside
    class="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-sidebar"
    :class="minimized ? 'border-l border-border' : ''"
    role="complementary"
    data-dsqa="fleet-rail"
    :aria-label="$t('approvalInbox.rail.ariaLabel')"
  >
    <!-- ── Minimized: the 44px strip. Area shrinks; the badge does not. ── -->
    <template v-if="minimized">
      <button
        type="button"
        class="relative flex shrink-0 items-center justify-center text-text-3 transition hover:bg-surface hover:text-text"
        :class="sessions.inboxCount > 0 ? 'text-accent' : ''"
        style="height: 42px; width: 100%"
        :title="
          sessions.inboxCount > 0
            ? $t('approvalInbox.open', { count: sessions.inboxCount })
            : $t('approvalInbox.rail.expand')
        "
        :aria-label="$t('approvalInbox.rail.expand')"
        @click="layout.setInboxRailState('expanded')"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M3 10h18" />
          <path d="M9 4v6" />
        </svg>
        <span
          v-if="sessions.inboxCount > 0"
          class="anim-pulse-dot absolute bg-accent text-accent-ink tabular-nums"
          style="
            top: 4px;
            right: 4px;
            min-width: 14px;
            height: 14px;
            --pulse-from-x: 0.64;
            --pulse-from-y: 0.64;
            padding: 0 3px;
            border-radius: 999px;
            font-size: 9px;
            font-weight: 700;
            line-height: 14px;
            text-align: center;
          "
          >{{ sessions.inboxCount }}</span
        >
      </button>

      <!--
        Minicard column — the whole fleet, still legible at 44px.

        Minimizing used to cost the operator the entire fleet: this strip
        rendered an icon and a badge, nothing else. That is backwards, because
        minimizing is exactly when the glance matters most. The state ring
        (design.md §7) is what makes the fix possible — it is a COMPLETE
        signal, needing no title, branch or timestamp to be read, so it
        survives at 28px where a card body cannot.

        Same projection and the same strict tier order as the expanded body
        (`visibleFleetCards`), so the two views can never disagree about what
        the fleet is doing. Identity comes from the SAME hover preview the
        expanded cards use — at 28px any baked-in label would be a lie.

        Geometry: 8px margin + 28px card + 8px margin = the 44px strip
        (`INBOX_RAIL_MINIMIZED_WIDTH`, unchanged).
      -->
      <div
        class="scrollable min-h-0 flex-1"
        style="overflow-y: auto; overflow-x: hidden; padding-top: 6px"
        data-dsqa="fleet-rail-minicards"
      >
        <button
          v-for="card in visibleFleetCards"
          :key="card.session.sessionId"
          type="button"
          class="grid cursor-pointer place-items-center border border-border bg-surface transition hover:bg-surface-2"
          :class="
            sessions.selectedId === card.session.sessionId ? '!border-border-2 !bg-surface-2' : ''
          "
          style="width: 28px; height: 28px; margin: 0 8px 4px; border-radius: var(--radius-sm)"
          data-dsqa="fleet-minicard"
          :aria-label="minicardLabel(card)"
          @click="sessions.select(card.session.sessionId)"
          @contextmenu="onMinicardContext($event, card.session.sessionId)"
          @mouseenter="onMinicardEnter($event, card.session.sessionId)"
          @mouseleave="hoverPreview.leave()"
        >
          <span class="fleet-ring" :class="`fleet-ring--${card.state}`">
            <span class="fleet-ring-track" />
            <span class="fleet-ring-arc" />
            <span class="fleet-ring-dot" />
          </span>
        </button>
      </div>
    </template>

    <!-- ── Expanded: the full panel ── -->
    <template v-else>
      <!-- Header — 42px to match the Topbar/Sidebar header row (design.md §4), so
           its bottom border lines up across the whole window instead of stair-stepping
           against the Topbar's border. -->
      <div
        class="flex shrink-0 items-center border-b border-border"
        style="height: 42px; padding: 0 10px; gap: 8px"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--color-text-3)"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="shrink-0"
        >
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M3 10h18" />
          <path d="M9 4v6" />
        </svg>
        <span class="text-text" style="font-size: 12.5px; font-weight: 500">{{
          $t('approvalInbox.title')
        }}</span>
        <span
          v-if="sessions.inboxCount > 0"
          class="shrink-0 bg-accent text-accent-ink tabular-nums"
          style="
            padding: 1px 6px;
            border-radius: 999px;
            font-size: 9.5px;
            font-weight: 700;
            letter-spacing: 0;
          "
          >{{ sessions.inboxCount }}</span
        >
        <span class="min-w-0 flex-1" />

        <!-- Card order toggle (T459) — cards sit in creation order inside each
             state group, newest first by default; this inverts it. The icon
             shows the CURRENT order, the title/aria-label say what a click does. -->
        <button
          type="button"
          class="flex shrink-0 items-center justify-center rounded text-text-3 transition hover:bg-surface hover:text-text"
          style="width: 22px; height: 22px"
          data-dsqa="fleet-rail-order-button"
          :title="orderLabel"
          :aria-label="orderLabel"
          @click="layout.toggleInboxRailOrder()"
        >
          <ArrowDownWideNarrow
            v-if="layout.inboxRailOrder === 'newest-first'"
            :size="14"
            :stroke-width="1.7"
          />
          <ArrowUpNarrowWide v-else :size="14" :stroke-width="1.7" />
        </button>

        <!-- Fleet rail state filter (T159) — icon + anchored popover, doubles
             as the legend for the dot/ring language the removed bucket
             labels used to provide (design.md — Fleet rail). -->
        <div ref="filterAnchorRef" class="relative shrink-0">
          <button
            type="button"
            class="relative flex shrink-0 items-center justify-center rounded text-text-3 transition hover:bg-surface hover:text-text"
            :class="hasActiveStateFilter ? 'text-accent' : ''"
            style="width: 22px; height: 22px"
            data-dsqa="fleet-rail-filter-button"
            :title="$t('approvalInbox.filter.title')"
            :aria-label="$t('approvalInbox.filter.title')"
            :aria-expanded="filterPopoverOpen"
            @click="filterPopoverOpen = !filterPopoverOpen"
          >
            <ListFilter :size="14" :stroke-width="1.7" />
            <span
              v-if="hasActiveStateFilter"
              class="absolute rounded-full bg-accent"
              style="width: 6px; height: 6px; top: 2px; right: 2px"
            />
          </button>

          <div
            v-if="filterPopoverOpen"
            class="anim-fade-in-scale absolute right-0 top-full z-50 mt-1.5 flex flex-col overflow-hidden rounded border border-border-2 bg-surface shadow-pop"
            style="width: 220px"
            data-dsqa="fleet-rail-filter-popover"
          >
            <div
              class="flex shrink-0 items-center border-b border-border"
              style="height: 32px; padding: 0 10px; gap: 6px"
            >
              <span class="text-text" style="font-size: 11.5px; font-weight: 500">{{
                $t('approvalInbox.filter.title')
              }}</span>
              <span class="min-w-0 flex-1" />
              <button
                v-if="hasActiveStateFilter"
                type="button"
                class="rounded-sm text-text-3 transition hover:bg-surface-2 hover:text-text"
                style="padding: 2px 5px; font-size: 10.5px; font-weight: 500"
                @click="layout.clearInboxRailStateFilter()"
              >
                {{ $t('approvalInbox.filter.showAll') }}
              </button>
            </div>
            <div
              v-for="state in INBOX_RAIL_FILTERABLE_STATES"
              :key="state"
              class="flex items-center"
              style="padding: 6px 10px; gap: 8px"
            >
              <span
                v-if="state === 'working'"
                class="anim-pulse-dot shrink-0 rounded-full bg-green"
                style="width: 6px; height: 6px"
              />
              <span
                v-else-if="state === 'needs-input'"
                class="anim-attention-dot shrink-0 rounded-full bg-warning"
                style="width: 6px; height: 6px"
              />
              <span
                v-else-if="state === 'errored'"
                class="shrink-0 rounded-full bg-red"
                style="width: 6px; height: 6px"
              />
              <span
                v-else-if="state === 'stuck'"
                class="shrink-0 rounded-full border border-red"
                style="width: 6px; height: 6px"
              />
              <Check v-else :size="11" :stroke-width="1.8" class="shrink-0 text-text-4" />
              <span class="min-w-0 flex-1 truncate text-text-2" style="font-size: 11.5px">{{
                $t(stateLabelKey(state))
              }}</span>
              <span class="shrink-0 tabular-nums text-text-4" style="font-size: 10.5px">{{
                fleetStateCounts[state]
              }}</span>
              <ToggleSwitch
                :model-value="!layout.inboxRailHiddenStates.has(state)"
                :aria-label="
                  $t('approvalInbox.filter.toggleAria', { state: $t(stateLabelKey(state)) })
                "
                @update:model-value="layout.toggleInboxRailStateVisibility(state)"
              />
            </div>
          </div>
        </div>

        <button
          type="button"
          class="flex shrink-0 items-center justify-center rounded text-text-3 transition hover:bg-surface hover:text-text"
          style="width: 22px; height: 22px"
          :title="$t('approvalInbox.rail.minimize')"
          :aria-label="$t('approvalInbox.rail.minimize')"
          @click="layout.setInboxRailState('minimized')"
        >
          <ChevronsRight :size="14" :stroke-width="1.7" />
        </button>
      </div>

      <!-- Hidden-urgency affordance (T159 — the safety trap): visible ONLY
           when the active filter is hiding at least one needs-input/errored/
           stuck card. One click clears the filter entirely. This must never
           be silent — a filtered-to-"working" rail hiding a session that just
           went `errored` would defeat the rail's entire reason to exist. -->
      <button
        v-if="hiddenAttentionCount > 0"
        type="button"
        class="flex w-full shrink-0 items-center border-b border-border bg-transparent text-left text-warning transition hover:bg-surface"
        style="padding: 7px 10px; gap: 6px; font-size: 11px"
        data-dsqa="fleet-rail-hidden-attention"
        @click="layout.clearInboxRailStateFilter()"
      >
        <TriangleAlert :size="12" :stroke-width="2" class="shrink-0" />
        <span class="min-w-0 flex-1">{{
          $t('approvalInbox.filter.hiddenAttention', { count: hiddenAttentionCount })
        }}</span>
        <span class="shrink-0" style="font-size: 10.5px; text-decoration: underline">{{
          $t('approvalInbox.filter.showAll')
        }}</span>
      </button>

      <!-- Active missions strip (T44 S5c). Hidden when there are none. -->
      <div
        v-if="activeGrants.length > 0"
        class="flex shrink-0 flex-col border-b border-border"
        style="padding: 9px 10px; gap: 6px"
      >
        <span
          class="text-text-3"
          style="
            font-size: 10px;
            font-weight: 600;
            letter-spacing: 0.07em;
            text-transform: uppercase;
          "
          >{{ $t('approvalInbox.missionsStrip.title') }}</span
        >
        <div v-for="g in activeGrants" :key="g.id" class="flex flex-col" style="gap: 4px">
          <span class="truncate text-text-2" style="font-size: 11.5px" :title="g.goal">
            {{ g.goal }}
          </span>
          <div class="flex items-center" style="gap: 7px">
            <span class="shrink-0 tabular-nums text-text-4" style="font-size: 10.5px">{{
              $t('mcpServer.missions.budget', { spent: g.spent, budget: g.budget })
            }}</span>
            <span class="shrink-0 tabular-nums text-text-4" style="font-size: 10.5px">{{
              $t('mcpServer.missions.expiresIn', { mins: minutesLeft(g) })
            }}</span>
            <span class="min-w-0 flex-1" />
            <button
              type="button"
              class="inline-flex shrink-0 items-center bg-red-soft text-red transition hover:opacity-80"
              style="padding: 2px 7px; font-size: 10.5px; border-radius: 5px"
              @click="revokeGrant(g.id)"
            >
              {{ $t('mcpServer.missions.revoke') }}
            </button>
          </div>
        </div>
      </div>

      <!--
        Fleet (T151) — the scrolling body: every non-idle session in the
        fleet, one continuous column, no bucket eyebrows. Ordering (anti-
        flood, strict tiers) + idle-hiding come from `fleetCards` above; each
        card's state is carried entirely by its dot + border ring
        (`FleetBoardCard.vue` + design.md §7), never a label.
      -->
      <div
        class="scrollable min-h-0 flex-1"
        style="overflow-y: auto; overflow-x: hidden; scrollbar-gutter: stable; padding-top: 6px"
      >
        <FleetBoardCard
          v-for="card in visibleFleetCards"
          :key="card.session.sessionId"
          :session="card.session"
          :state="card.state"
          :folder-alias="card.folderAlias"
          live-poll
        />
        <div
          v-if="visibleFleetCards.length === 0 && fleetCards.length === 0"
          class="text-text-4"
          style="padding: 24px 12px; font-size: 12px; text-align: center"
        >
          {{ $t('approvalInbox.fleetEmpty') }}
        </div>
        <button
          v-else-if="visibleFleetCards.length === 0"
          type="button"
          class="w-full text-text-4 transition hover:text-text-2"
          style="padding: 24px 12px; font-size: 12px; text-align: center"
          data-dsqa="fleet-rail-all-filtered"
          @click="layout.clearInboxRailStateFilter()"
        >
          {{ $t('approvalInbox.filter.allHidden') }}
        </button>
      </div>

      <!--
        Needs you — the actionable section, pinned below the fleet (T151).
        Collapsible like Would-have (default OPEN, never auto-collapses); the
        WHOLE section disappears (header included) when there is nothing
        pending — an idle queue doesn't earn a permanent row once the Fleet
        section above already shows the fleet is quiet.
      -->
      <div v-if="!isEmpty" class="shrink-0 border-t border-border">
        <button
          type="button"
          class="flex w-full items-center bg-transparent text-text-3 transition hover:text-text-2"
          style="
            padding: 9px 10px 8px;
            gap: 6px;
            font-size: 10px;
            font-weight: 600;
            letter-spacing: 0.07em;
            text-transform: uppercase;
          "
          :aria-expanded="needsYouOpen"
          @click="needsYouOpen = !needsYouOpen"
        >
          <ChevronDown
            :size="11"
            :stroke-width="2.5"
            class="shrink-0 text-text-4 transition-transform"
            :style="{ transform: needsYouOpen ? 'none' : 'rotate(-90deg)' }"
          />
          {{ $t('approvalInbox.sections.needsYou') }}
          <span class="min-w-0 flex-1" />
          <span
            class="shrink-0 bg-accent text-accent-ink tabular-nums"
            style="
              padding: 1px 6px;
              border-radius: 999px;
              font-size: 9.5px;
              font-weight: 700;
              letter-spacing: 0;
            "
            >{{ sessions.inboxCount }}</span
          >
        </button>
        <div class="collapsible" :class="needsYouOpen ? '' : 'closed'">
          <div class="collapsible-inner">
            <div class="scrollable overflow-y-auto" style="max-height: 40vh">
              <McpConfirmRow v-for="c in parkedConfirms" :key="c.id" :confirm="c" />
              <ApprovalRow v-for="a in approvals" :key="a.requestId" :approval="a" />
            </div>
          </div>
        </div>
      </div>

      <!--
        Would-have — collapsed shadow log pinned below the fleet (T151),
        the same chevron/`.collapsible` chrome as Needs-you above.
      -->
      <div class="shrink-0 border-t border-border">
        <button
          type="button"
          class="flex w-full items-center bg-transparent text-text-3 transition hover:text-text-2"
          style="
            padding: 8px 10px;
            gap: 6px;
            font-size: 10px;
            font-weight: 600;
            letter-spacing: 0.07em;
            text-transform: uppercase;
          "
          :aria-expanded="wouldHaveOpen"
          @click="wouldHaveOpen = !wouldHaveOpen"
        >
          <ChevronDown
            :size="11"
            :stroke-width="2.5"
            class="shrink-0 text-text-4 transition-transform"
            :style="{ transform: wouldHaveOpen ? 'none' : 'rotate(-90deg)' }"
          />
          {{ $t('approvalInbox.sections.wouldHave') }}
          <span class="min-w-0 flex-1" />
          <span class="shrink-0 tabular-nums text-text-4" style="font-size: 10px">{{
            shadowRows.length
          }}</span>
        </button>

        <div class="collapsible" :class="wouldHaveOpen ? '' : 'closed'">
          <div class="collapsible-inner">
            <div class="scrollable overflow-y-auto" style="max-height: 30vh">
              <div
                v-for="(row, idx) in shadowRows"
                :key="idx"
                class="flex items-start border-t border-border"
                style="gap: 8px; padding: 8px 10px"
              >
                <!-- Muted grey dot — preview data, not a call to action (AC10). -->
                <span
                  class="shrink-0 rounded-full bg-text-4"
                  style="width: 6px; height: 6px; margin-top: 4px"
                />
                <div class="flex min-w-0 flex-1 flex-col items-start" style="gap: 2px">
                  <span
                    class="max-w-full line-clamp-2 font-mono text-text"
                    style="font-size: 11.5px; line-height: 1.4"
                    >{{ row.summary }}</span
                  >
                  <span
                    v-if="row.folderAlias || row.sessionSummary"
                    class="max-w-full line-clamp-2 text-text-4"
                    style="font-size: 10.5px; line-height: 1.4"
                  >
                    <template v-if="row.folderAlias">{{ row.folderAlias }}</template>
                    <template v-if="row.folderAlias && row.sessionSummary"> · </template>
                    <template v-if="row.sessionSummary">{{ row.sessionSummary }}</template>
                  </span>
                </div>
                <span
                  class="shrink-0 tabular-nums text-text-4"
                  style="font-size: 10px; margin-top: 1px"
                  >{{ relativeTimeMs(row.ts) }}</span
                >
              </div>
              <div
                v-if="shadowRows.length === 0"
                class="border-t border-border text-text-4"
                style="padding: 18px 10px; font-size: 11.5px; text-align: center"
              >
                {{ isPaused ? $t('approvalInbox.shadowPaused') : $t('approvalInbox.shadowEmpty') }}
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>
  </aside>
</template>
