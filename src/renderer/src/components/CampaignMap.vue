<script setup lang="ts">
/**
 * Campaign map takeover (T607, campaign chapter 4c — design.md §6 "Campaign map"; spec §5; mockup
 * `screens/v6--map.html`). The whole campaign as a board: chapters as tiles joined by dependency
 * arrows, side quests docked under their origin, locked tiles, "You are here", the declared end
 * and the radiant counter in the strip above; the You ledger, the Steward feed and the side
 * quests in the right column; and `chapter-focus`, which swaps the right column's lower half for
 * the clicked chapter's mission steps with their gate dots.
 *
 * Rendered through `TakeoverShell` like every takeover: the shell owns the header, the title and
 * the close button (Esc closes it through `view.closeTakeover`), so this view owns neither. Its
 * icon reaches the header through the shell's landing zone.
 *
 * Read-only, and it NEVER recounts: every number it prints — the headline, the counts line, the
 * side-quest meta, the radiant counter and its bar, each chapter's step headline — is the
 * server's (`CampaignView.progress`, a mission's own `progress`). The geometry comes from
 * `lib/campaign-map.ts`; what a chapter owes the operator from the same view model the pill and
 * the Campaign popover use (`buildCampaignModel`), so the three can never disagree.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronLeft, Lock, Map as MapIcon } from 'lucide-vue-next'
import {
  buildCampaignModel,
  type CampaignChapterRow,
  type CampaignModel
} from '../lib/campaign-view'
import { layoutCampaignMap, waitsFor, type MapEdgeKind } from '../lib/campaign-map'
import {
  formatDuration,
  headlineText,
  youRowText,
  type GateDot,
  type StepModel,
  type StepVisual,
  type YouRow
} from '../lib/mission-view'
import type { ChapterState } from '../../../main/campaign-progress'
import { sessionTitle } from '../lib/session-label'
import { useCampaignsStore } from '../stores/campaigns'
import { useMissionsStore } from '../stores/missions'
import { useSessionsStore } from '../stores/sessions'
import { useUiStore } from '../stores/ui'
import CampaignGateDots from './CampaignGateDots.vue'
import MissionStepGlyph from './MissionStepGlyph.vue'

const { t } = useI18n()
const ui = useUiStore()
const campaigns = useCampaignsStore()
const missions = useMissionsStore()
const sessions = useSessionsStore()

onMounted(() => {
  missions.ensureStarted()
  campaigns.ensureStarted()
  void missions.refresh()
  void campaigns.refresh()
})

/** The campaign this takeover was opened on; `null` when it is gone (closed, or not loaded yet). */
const view = computed(
  () => campaigns.views.find((v) => v.campaign.id === ui.campaignMap.campaignId) ?? null
)
const model = computed<CampaignModel | null>(() =>
  view.value ? buildCampaignModel(view.value, missions.views, null, missions.refreshedAt) : null
)
const layout = computed(() =>
  view.value && model.value
    ? layoutCampaignMap(
        view.value.campaign.chapters,
        view.value.progress.states,
        model.value.currentIds
      )
    : null
)
/** Tiles whose chapter the view model knows (always all of them; the guard keeps the types honest). */
const tiles = computed(() => layout.value?.tiles.filter((t) => rows.value.has(t.chapterId)) ?? [])
const rows = computed(() => {
  const m = model.value
  return new Map<string, CampaignChapterRow>(
    m ? [...m.main, ...m.side, ...m.locked].map((r) => [r.chapter.id, r] as const) : []
  )
})
const chapterNumber = (id: string): number | null => rows.value.get(id)?.chapter.ordinal ?? null

// ---- chapter-focus ----------------------------------------------------------------------

const focusId = ref<string | null>(null)
watch(
  () => [ui.campaignMap.campaignId, rows.value.has(focusId.value ?? '')] as const,
  ([, present]) => {
    if (!present) focusId.value = null
  }
)
const focus = computed(() => (focusId.value ? (rows.value.get(focusId.value) ?? null) : null))
const mode = computed<'default' | 'chapter-focus'>(() =>
  focus.value ? 'chapter-focus' : 'default'
)

// ---- header, footer ---------------------------------------------------------------------

const headline = computed(() => {
  const h = model.value?.headline
  return !h || h.kind === 'empty'
    ? ''
    : t(`campaign.headline.${h.kind}`, { n: h.n, to: h.to, m: h.m })
})
const countsText = computed(() => {
  const c = model.value?.counts
  return c ? t('campaign.counts', { ...c, side: c.sideTotal }) : ''
})
const radiantPct = computed(() => {
  const r = model.value?.radiant
  return r && r.total > 0 ? Math.min(100, Math.round((r.done / r.total) * 100)) : 0
})

// ---- tiles ------------------------------------------------------------------------------

const stateWord = (s: ChapterState): string => t(`campaign.state.${s}`)

/** The tile's border / ring / opacity from its state, the current marker, and the focus. */
function tileClass(chapterId: string, state: ChapterState, current: boolean): string[] {
  const selected = focusId.value === chapterId
  const out = ['border-border-2']
  if (current || selected) out.splice(0, 1, 'border-accent', 'ring-2', 'ring-accent-soft')
  else if (state === 'inReview') out.splice(0, 1, 'border-warning-line')
  else if (state === 'locked') out.splice(0, 1, 'border-dashed', 'border-border-2')
  if (focusId.value && !selected) out.push(state === 'locked' ? 'opacity-30' : 'opacity-50')
  else if (state === 'locked') out.push('opacity-60')
  return out
}

const STATE_WORD_CLASS: Record<ChapterState, string> = {
  done: 'text-green',
  inReview: 'text-warning',
  running: 'font-semibold text-accent',
  locked: 'text-text-4',
  todo: 'text-text-4'
}

/** The chapter's current step: the first one the server's `current` names, else none. */
function currentStep(row: CampaignChapterRow): StepModel | null {
  return row.mission?.steps.find((s) => s.firstCurrent) ?? null
}

/** A tile's sub-line: what the chapter is on, or what it waits for. */
function subText(row: CampaignChapterRow): string {
  if (row.state === 'locked') {
    const w = waitsFor(
      row.chapter,
      view.value?.campaign.chapters ?? [],
      view.value?.progress.states ?? {}
    )
    const what = [...w.chapters.map((n) => t('campaign.map.waitsForChapter', { n })), ...w.tokens]
    return what.length > 0 ? t('campaign.map.waitsFor', { what: what.join(', ') }) : ''
  }
  return currentStep(row)?.step.title ?? row.missionView?.mission.declaredEnd.target ?? ''
}

/** The gates a tile shows: the current step's, else the last counted step's before the end. */
function tileGates(row: CampaignChapterRow): { gates: GateDot[]; stale: boolean } | null {
  const steps = row.mission?.steps ?? []
  const s = steps.find((x) => x.firstCurrent) ?? [...steps].reverse().find((x) => !x.isEnd)
  return s ? { gates: s.gates, stale: s.gatesStale } : null
}

const tileLabel = (row: CampaignChapterRow): string =>
  t('campaign.map.tileLabel', {
    n: row.chapter.ordinal,
    title: row.chapter.title,
    state: stateWord(row.state)
  })

const EDGE_CLASS: Record<MapEdgeKind, string> = {
  ok: 'stroke-green',
  cur: 'stroke-accent',
  lock: 'stroke-text-4 [stroke-dasharray:3_3]',
  plain: 'stroke-text-4'
}

// ---- the right column -------------------------------------------------------------------

function sessionName(id: string): string {
  const s = sessions.allSessions.find((x) => x.sessionId === id)
  return (s && sessionTitle(s, sessions.allSessions, t)) || id.slice(0, 8)
}
function youText(y: CampaignModel['you'][number]): string {
  const v = rows.value.get(y.chapterId)?.missionView
  return v ? youRowText(t, v, y.row, sessionName) : ''
}
const RISK_DOT: Record<YouRow['risk'], string> = {
  high: 'bg-red',
  mid: 'bg-warning',
  low: 'border-[1.5px] border-text-4'
}
const ageText = (row: YouRow): string | null =>
  row.ageMs === null ? null : formatDuration(row.ageMs)

const sideRows = computed(() => model.value?.side ?? [])
const originOf = (row: CampaignChapterRow): number | null => {
  const from = row.chapter.discoveredFrom?.chapterId
  return from ? chapterNumber(from) : null
}
const sideDone = (row: CampaignChapterRow): boolean => row.state === 'done'
const dockLabel = (row: CampaignChapterRow): string =>
  t('campaign.map.dockLabel', { title: row.chapter.title, state: stateWord(row.state) })

// ---- the focus panel --------------------------------------------------------------------

const VISUAL_KEY: Record<StepVisual, string> = {
  verified: 'verified',
  done: 'done',
  running: 'running',
  waiting: 'waiting',
  blocked: 'blocked',
  todo: 'todo',
  locked: 'locked',
  'left-behind': 'leftBehind'
}
const visualLabel = (v: StepVisual): string => t(`mission.visual.${VISUAL_KEY[v]}`)
const focusHeadline = computed(() =>
  focus.value?.mission ? headlineText(t, focus.value.mission.headline) : ''
)
const focusEmpty = computed(() => {
  const f = focus.value
  if (!f) return ''
  if (f.state === 'locked') return t('campaign.lockedUntil')
  return f.missionId ? t('campaign.missionNotOpen') : t('campaign.noMission')
})
</script>

<template>
  <div
    class="flex min-h-0 flex-1 flex-col"
    data-test="campaign-map"
    :data-state="mode"
    data-dsqa="v6--map"
  >
    <div
      v-if="!view || !model || !layout"
      class="flex flex-1 items-center justify-center text-text-4"
      style="font-size: 12px"
      data-test="campaign-map-missing"
    >
      {{ $t('campaign.map.missing') }}
    </div>

    <template v-else>
      <!-- The campaign strip: title · headline · declared end · radiant counter. -->
      <div
        class="flex shrink-0 flex-wrap items-center border-b border-border bg-surface"
        style="gap: 8px 16px; padding: 8px 12px"
      >
        <div class="flex min-w-0 flex-col" style="gap: 1px">
          <div class="flex items-baseline" style="gap: 8px">
            <span
              class="min-w-0 truncate text-text"
              style="font-size: 13px; font-weight: 600"
              data-test="campaign-map-title"
              >{{ view.title }}</span
            >
            <span
              class="shrink-0 tabular-nums text-text-3"
              style="font-size: 11px"
              data-test="campaign-map-headline"
              >{{ headline }}</span
            >
          </div>
          <div
            class="truncate text-text-3"
            style="font-size: 11px; line-height: 1.35"
            :title="view.campaign.declaredEnd.target"
            data-test="campaign-map-end"
          >
            {{ $t('campaign.declaredEnd', { target: view.campaign.declaredEnd.target }) }}
          </div>
        </div>
        <div
          v-if="model.radiant"
          class="flex items-center text-text-2"
          style="gap: 8px; font-size: 11px"
          data-test="campaign-map-radiant"
        >
          <span class="tabular-nums" style="font-family: var(--font-mono)">{{
            $t('campaign.radiant', { done: model.radiant.done, total: model.radiant.total })
          }}</span>
          <span class="overflow-hidden rounded-full bg-border-2" style="width: 160px; height: 3px">
            <span
              class="block h-full bg-accent"
              :style="{ width: `${radiantPct}%` }"
              data-test="campaign-map-radiant-bar"
            />
          </span>
        </div>
      </div>

      <div
        class="grid min-h-0 flex-1 grid-cols-1 overflow-auto min-[720px]:grid-cols-[2fr_1fr] min-[720px]:overflow-hidden"
      >
        <!-- The board. -->
        <div class="overflow-auto border-border p-5 min-[720px]:border-r">
          <div
            class="relative"
            :style="{ width: `${layout.width}px`, height: `${layout.height}px` }"
            data-test="campaign-map-board"
          >
            <svg
              class="pointer-events-none absolute inset-0 overflow-visible"
              :viewBox="`0 0 ${layout.width} ${layout.height}`"
              :width="layout.width"
              :height="layout.height"
              aria-hidden="true"
            >
              <defs>
                <marker
                  id="campaign-map-arrow"
                  markerWidth="6"
                  markerHeight="6"
                  refX="5"
                  refY="3"
                  orient="auto"
                >
                  <path d="M0,0 L6,3 L0,6z" class="fill-text-4" />
                </marker>
              </defs>
              <path
                v-for="e in layout.edges"
                :key="`${e.from}>${e.to}`"
                :d="e.d"
                class="fill-none"
                :class="EDGE_CLASS[e.kind]"
                style="stroke-width: 1.25"
                marker-end="url(#campaign-map-arrow)"
                data-test="campaign-map-edge"
                :data-from="e.from"
                :data-to="e.to"
                :data-kind="e.kind"
                :data-via="e.via"
              />
            </svg>

            <i
              v-for="s in layout.stems"
              :key="s.originId"
              class="absolute border-l border-dashed border-text-4"
              :style="{ left: `${s.x}px`, top: `${s.y}px`, height: `${s.h}px`, width: 0 }"
            />

            <button
              v-for="tile in tiles"
              :key="tile.chapterId"
              type="button"
              class="absolute flex cursor-pointer flex-col items-stretch rounded-sm border bg-surface text-left hover:bg-surface-2"
              :class="tileClass(tile.chapterId, tile.state, tile.current)"
              :style="{
                left: `${tile.x}px`,
                top: `${tile.y}px`,
                width: `${tile.w}px`,
                height: `${tile.h}px`,
                gap: '3px',
                padding: '6px 8px'
              }"
              :aria-label="tileLabel(rows.get(tile.chapterId)!)"
              :aria-pressed="focusId === tile.chapterId"
              data-test="campaign-map-tile"
              :data-chapter="tile.chapterId"
              :data-state="tile.state"
              @click="focusId = tile.chapterId"
            >
              <span
                v-if="tile.current"
                class="absolute rounded-sm bg-accent text-accent-ink"
                style="
                  top: -9px;
                  right: 8px;
                  padding: 1px 6px;
                  font-size: 9.5px;
                  font-weight: 700;
                  white-space: nowrap;
                "
                data-test="campaign-map-here"
                >{{ $t('campaign.map.here') }}</span
              >
              <span class="flex items-baseline" style="gap: 5px">
                <span
                  class="shrink-0 text-right tabular-nums text-text-4"
                  style="width: 16px; font-family: var(--font-mono); font-size: 10px"
                  data-test="campaign-map-tile-n"
                  >{{ tile.ordinal }}</span
                >
                <span
                  class="min-w-0 truncate"
                  :class="
                    tile.current || focusId === tile.chapterId
                      ? 'font-medium text-text'
                      : 'text-text-2'
                  "
                  style="font-size: 12px"
                  :title="rows.get(tile.chapterId)!.chapter.title"
                  >{{ rows.get(tile.chapterId)!.chapter.title }}</span
                >
              </span>
              <span
                class="line-clamp-2 flex-1 text-text-4"
                style="padding-left: 21px; font-size: 10.5px; line-height: 1.3"
                >{{ subText(rows.get(tile.chapterId)!) }}</span
              >
              <span class="mt-auto flex items-center" style="gap: 6px">
                <CampaignGateDots
                  v-if="tileGates(rows.get(tile.chapterId)!)"
                  :gates="tileGates(rows.get(tile.chapterId)!)!.gates"
                  :stale="tileGates(rows.get(tile.chapterId)!)!.stale"
                />
                <span
                  class="ml-auto flex items-center whitespace-nowrap"
                  :class="STATE_WORD_CLASS[tile.state]"
                  style="gap: 3px; font-size: 10px"
                >
                  <Lock
                    v-if="tile.state === 'locked'"
                    :size="10"
                    :stroke-width="2"
                    data-test="campaign-map-lock"
                  />
                  <template v-if="tile.state === 'done'">✓ </template>{{ stateWord(tile.state) }}
                </span>
              </span>
            </button>

            <button
              v-for="d in layout.docks"
              :key="d.chapterId"
              type="button"
              class="absolute flex cursor-pointer items-center rounded-sm border border-dashed bg-surface text-text-3 hover:bg-surface-2"
              :class="
                d.state === 'done'
                  ? 'border-border-2'
                  : d.state === 'todo'
                    ? 'border-border-2'
                    : 'border-warning-line text-text-2'
              "
              :style="{
                left: `${d.x}px`,
                top: `${d.y}px`,
                width: `${d.w}px`,
                height: `${d.h}px`,
                gap: '5px',
                padding: '0 6px',
                fontSize: '10.5px'
              }"
              :aria-label="dockLabel(rows.get(d.chapterId)!)"
              data-test="campaign-map-dock"
              :data-chapter="d.chapterId"
              :data-origin="d.originId"
              @click="focusId = d.chapterId"
            >
              <span
                class="shrink-0"
                :class="d.state === 'done' ? 'text-green' : 'text-warning'"
                style="font-size: 10px"
                aria-hidden="true"
                >{{ d.state === 'done' ? '✓' : '◇' }}</span
              >
              <span class="min-w-0 truncate" :title="rows.get(d.chapterId)!.chapter.title">{{
                rows.get(d.chapterId)!.chapter.title
              }}</span>
            </button>
          </div>
        </div>

        <!-- The right column. -->
        <div
          class="flex flex-col overflow-auto bg-bg min-[720px]:min-h-0"
          style="gap: 14px; padding: 14px 16px"
        >
          <!-- The You ledger: everything the campaign's open chapters owe, with ages. -->
          <div
            class="rounded border"
            :class="
              model.you.length > 0
                ? 'border-warning-line bg-warning-soft'
                : 'border-border-2 bg-surface-2'
            "
            data-test="campaign-map-ledger"
            :data-dsqa="`campaign-map-you--${model.you.length > 0 ? 'warning' : 'clear'}`"
          >
            <div
              class="flex items-center"
              :class="model.you.length > 0 ? 'border-b border-warning-line' : ''"
              style="gap: 8px; padding: 6px 10px"
            >
              <span
                class="uppercase"
                :class="model.you.length > 0 ? 'text-warning' : 'text-text-4'"
                style="font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em"
                >{{ $t('mission.you.label') }}</span
              >
              <span
                v-if="model.you.length > 0"
                class="tabular-nums text-text-2"
                style="font-size: 11px"
                data-test="campaign-map-ledger-total"
                >{{ $t('campaign.map.ledger.owed', { n: model.youCount }) }}</span
              >
              <span v-else class="text-text-4" style="font-size: 11px">{{
                $t('mission.you.clear')
              }}</span>
            </div>
            <div
              v-for="(y, i) in model.you"
              :key="i"
              class="grid items-center border-border text-text"
              :class="i > 0 ? 'border-t' : ''"
              style="
                grid-template-columns: 8px minmax(0, 1fr) auto auto;
                gap: 8px;
                padding: 5px 10px;
                min-height: 28px;
                font-size: 11.5px;
              "
              data-test="campaign-map-ledger-row"
            >
              <span
                class="rounded-full"
                :class="RISK_DOT[y.row.risk]"
                style="width: 7px; height: 7px"
                aria-hidden="true"
              />
              <span class="min-w-0" style="line-height: 1.35"
                >{{ youText(y) }}
                <span class="whitespace-nowrap text-text-4" style="margin-left: 4px">{{
                  $t('campaign.you.chapterTag', { n: y.chapterOrdinal })
                }}</span></span
              >
              <span
                class="text-right tabular-nums text-text-4"
                style="min-width: 24px; font-size: 10.5px"
                >{{ ageText(y.row) ?? '' }}</span
              >
              <button
                type="button"
                class="inline-flex cursor-pointer items-center whitespace-nowrap rounded-sm border border-border-2 bg-surface text-text-2 hover:bg-surface-2 hover:text-text"
                style="height: 20px; padding: 0 8px; font-size: 11px; font-weight: 500"
                data-test="campaign-map-ledger-open"
                @click="focusId = y.chapterId"
              >
                {{ $t('campaign.map.ledger.open') }}
              </button>
            </div>
          </div>

          <template v-if="!focus">
            <!-- The Steward feed: chapter 5 wires it; until then, its empty state. -->
            <div data-test="campaign-map-steward">
              <div style="margin-bottom: 5px">
                <span
                  class="uppercase text-text-4"
                  style="font-size: 10.5px; font-weight: 500; letter-spacing: 0.07em"
                  >{{ $t('campaign.map.steward.title') }}</span
                >
              </div>
              <div class="text-text-4" style="font-size: 11.5px">
                {{ $t('campaign.map.steward.empty') }}
              </div>
            </div>

            <!-- Side quests. -->
            <div v-if="sideRows.length > 0" data-test="campaign-map-side">
              <div class="flex items-baseline" style="gap: 8px; margin-bottom: 5px">
                <span
                  class="uppercase text-text-4"
                  style="font-size: 10.5px; font-weight: 500; letter-spacing: 0.07em"
                  >{{ $t('campaign.group.side') }}</span
                >
                <span
                  class="ml-auto tabular-nums text-text-4"
                  style="font-size: 10.5px"
                  data-test="campaign-map-side-meta"
                  >{{
                    $t('campaign.map.side.meta', {
                      total: model.counts.sideTotal,
                      done: model.counts.sideDone,
                      open: model.counts.sideOpen
                    })
                  }}</span
                >
              </div>
              <div class="rounded-sm border border-border-2">
                <button
                  v-for="(r, i) in sideRows"
                  :key="r.chapter.id"
                  type="button"
                  class="grid w-full cursor-pointer items-center text-left hover:bg-surface-2"
                  :class="[
                    i > 0 ? 'border-t border-border' : '',
                    sideDone(r) ? 'text-text-3' : 'text-text-2'
                  ]"
                  style="
                    grid-template-columns: 12px minmax(0, 1fr) auto 64px;
                    gap: 8px;
                    padding: 4px 8px;
                    font-size: 11.5px;
                  "
                  data-test="campaign-map-side-row"
                  :data-chapter="r.chapter.id"
                  @click="focusId = r.chapter.id"
                >
                  <span
                    class="text-center"
                    :class="sideDone(r) ? 'text-green' : 'text-warning'"
                    style="font-size: 10px"
                    aria-hidden="true"
                    >{{ sideDone(r) ? '✓' : '◇' }}</span
                  >
                  <span class="min-w-0 truncate" :title="r.chapter.title">{{
                    r.chapter.title
                  }}</span>
                  <span class="whitespace-nowrap text-text-4" style="font-size: 10.5px">{{
                    originOf(r) !== null ? $t('campaign.you.chapterTag', { n: originOf(r) }) : ''
                  }}</span>
                  <span
                    class="text-right"
                    :class="sideDone(r) ? 'text-green' : 'text-warning'"
                    style="font-size: 10.5px"
                    >{{ stateWord(r.state) }}</span
                  >
                </button>
              </div>
            </div>
          </template>

          <!-- chapter-focus: the clicked chapter's mission steps with their gate dots. -->
          <div
            v-else
            class="@container rounded border border-accent-line bg-surface"
            data-test="campaign-map-focus"
          >
            <div
              class="flex items-center border-b border-border"
              style="gap: 8px; padding: 6px 10px"
            >
              <button
                type="button"
                class="inline-flex shrink-0 cursor-pointer items-center whitespace-nowrap rounded-sm border border-border-2 bg-surface text-text-2 hover:bg-surface-2 hover:text-text"
                style="height: 20px; gap: 4px; padding: 0 8px; font-size: 11px; font-weight: 500"
                data-test="campaign-map-focus-back"
                @click="focusId = null"
              >
                <ChevronLeft :size="11" :stroke-width="2" />{{ $t('campaign.map.focus.back') }}
              </button>
              <span class="min-w-0 truncate" style="font-size: 12px; font-weight: 600"
                ><template v-if="focus.chapter.required">{{ focus.chapter.ordinal }} · </template
                >{{ focus.chapter.title }}</span
              >
              <span
                v-if="focusHeadline"
                class="ml-auto shrink-0 tabular-nums text-text-4"
                style="font-size: 10.5px"
                data-test="campaign-map-focus-headline"
                >{{ focusHeadline }}</span
              >
            </div>
            <template v-if="focus.mission">
              <div
                v-for="(s, i) in focus.mission.steps"
                :key="s.step.id"
                class="grid grid-cols-[14px_14px_minmax(0,1fr)] items-center text-text-2 @[340px]:grid-cols-[14px_14px_minmax(0,1fr)_auto]"
                :class="[i > 0 ? 'border-t border-border' : '', s.current ? 'bg-accent-soft' : '']"
                style="gap: 3px 6px; padding: 6px 10px; font-size: 11.5px"
                :aria-current="s.current ? 'step' : undefined"
                data-objective
              >
                <span
                  class="text-text-4"
                  style="font-family: var(--font-mono); font-size: 10.5px"
                  >{{ s.letter ?? '' }}</span
                >
                <MissionStepGlyph
                  :visual="s.visual"
                  :current="s.current"
                  :label="visualLabel(s.visual)"
                />
                <span
                  class="min-w-0 truncate"
                  :class="s.current ? 'font-medium text-text' : ''"
                  :title="s.step.title"
                  >{{ s.step.title }}</span
                >
                <CampaignGateDots
                  :gates="s.gates"
                  :stale="s.gatesStale"
                  labels
                  class="col-start-3 @[340px]:col-start-4"
                />
              </div>
            </template>
            <div
              v-else
              class="text-text-4"
              style="padding: 10px; font-size: 11.5px; line-height: 1.5"
              data-test="campaign-map-focus-empty"
            >
              {{ focusEmpty }}
            </div>
          </div>
        </div>
      </div>

      <div
        class="flex shrink-0 items-center border-t border-border bg-sidebar text-text-4"
        style="height: 30px; gap: 6px; padding: 0 14px; font-size: 11px"
      >
        <span class="truncate tabular-nums" data-test="campaign-map-counts">{{ countsText }}</span>
        <span class="flex-1" />
        <span class="shrink-0">{{ $t('campaign.map.gatesLegend') }}</span>
      </div>
    </template>
  </div>

  <Teleport to="#takeover-shell-icon" defer>
    <MapIcon :size="15" :stroke-width="1.7" class="shrink-0 text-accent" />
  </Teleport>
</template>
