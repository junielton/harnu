<script setup lang="ts">
/**
 * Campaign popover (T596, campaign chapter 4b — design.md §6 "Campaign progress" → Campaign
 * popover; mockup v6 `v6--campaign`). The Mission popover's shell at 520px (`.pop--wide`):
 * a header (title · the server's chapter headline · declared end · counts · radiant), two panes
 * — Main quest / Side quests / Locked on the left, the selected chapter's objectives with gate
 * dots on the right — then the You lane and the footer.
 *
 * Read-only: every number is the server's (`CampaignView.progress`, each mission's own
 * `progress`), and there is no campaign door in main yet, so "End campaign…" and "Open map" are
 * rendered disabled with the reason in their tooltip. The Steward line and the merge-batch dialog
 * of the mockup belong to chapter 5 and render nothing here.
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, Flag, Map as MapIcon, TriangleAlert } from 'lucide-vue-next'
import type { CampaignView } from '../../../main/campaign-ipc'
import type { ChapterState } from '../../../main/campaign-progress'
import type { CampaignChapterRow, CampaignModel } from '../lib/campaign-view'
import {
  formatDuration,
  GATE_DOT_CLASS,
  youRowText,
  type GateDot,
  type StepModel,
  type StepVisual,
  type YouRow
} from '../lib/mission-view'
import { sessionTitle } from '../lib/session-label'
import { useNativeOverlay } from '../composables/useNativeOverlay'
import { useSessionsStore } from '../stores/sessions'
import Button from './ui/Button.vue'
import MissionStepGlyph from './MissionStepGlyph.vue'

const props = defineProps<{ view: CampaignView; model: CampaignModel }>()
const emit = defineEmits<{ openChapter: [missionId: string] }>()

const { t } = useI18n()
const sessions = useSessionsStore()

const allRows = computed<CampaignChapterRow[]>(() => [
  ...props.model.main,
  ...props.model.side,
  ...props.model.locked
])

/** The selected chapter; starts on the server's current marker (else the last chapter, once all are done). */
const selectedId = ref<string | null>(null)
watch(
  () => [props.view.campaign.id, props.model.currentId] as const,
  () => {
    // Nothing current means every chapter is done: start on the last one.
    selectedId.value =
      props.model.currentId ?? props.model.main[props.model.main.length - 1]?.chapter.id ?? null
  },
  { immediate: true }
)
const selected = computed(
  () => allRows.value.find((r) => r.chapter.id === selectedId.value) ?? null
)

const headline = computed(() => {
  const h = props.model.headline
  return h.kind === 'empty' ? '' : t(`campaign.headline.${h.kind}`, { n: h.n, to: h.to, m: h.m })
})

const countsText = computed(() => {
  const c = props.model.counts
  return t('campaign.counts', { ...c, side: c.sideTotal })
})

const radiantPct = computed(() => {
  const r = props.model.radiant
  return r && r.total > 0 ? Math.min(100, Math.round((r.done / r.total) * 100)) : 0
})

/** The glyph a chapter wears: the rail's visual for its state. */
const STATE_VISUAL: Record<ChapterState, StepVisual> = {
  done: 'verified',
  inReview: 'waiting',
  running: 'running',
  locked: 'locked',
  todo: 'todo'
}
const stateWord = (s: ChapterState): string => t(`campaign.state.${s}`)

/** Group meta (right of the eyebrow): "9 of 12", "1 open", "3". */
const mainMeta = computed(() => {
  const h = props.model.headline
  return h.kind === 'empty' ? '' : t('campaign.group.mainMeta', { n: h.n, m: h.m })
})

function gateTitle(s: StepModel, g: GateDot): string {
  return t(s.gatesStale ? 'mission.gates.tooltipStale' : 'mission.gates.tooltip', {
    gate: t(`mission.gates.name.${g.name}`),
    state: t(`mission.gates.state.${g.state}`)
  })
}

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

/** The chapter a side chapter was discovered from, by its position among the required chapters. */
const origin = computed(() => {
  const from = selected.value?.chapter.discoveredFrom
  if (!from) return null
  const chapter = props.view.campaign.chapters.find((c) => c.id === from.chapterId)
  return chapter ? { n: chapter.ordinal, title: chapter.title } : null
})

// ---- The You lane -----------------------------------------------------------------------

function sessionName(id: string): string {
  const s = sessions.allSessions.find((x) => x.sessionId === id)
  return (s && sessionTitle(s, sessions.allSessions, t)) || id.slice(0, 8)
}

function viewOf(missionId: string): CampaignChapterRow['missionView'] {
  return allRows.value.find((r) => r.missionId === missionId)?.missionView ?? null
}

function youText(y: CampaignModel['you'][number]): string {
  const v = viewOf(y.missionId)
  return v ? youRowText(t, v, y.row, sessionName) : ''
}

const RISK_CLASS: Record<YouRow['risk'], string> = {
  high: 'text-red',
  mid: 'text-warning',
  low: 'text-text-4'
}

const firstYou = computed(() => props.model.you[0] ?? null)
const restYou = computed(() => props.model.you.slice(1))
/** Success only for a requested close the server has no warning about; otherwise a warning. */
const youLook = computed<'clear' | 'warning' | 'success'>(() => {
  const first = firstYou.value
  if (!first) return 'clear'
  if (first.row.kind === 'close' && (viewOf(first.missionId)?.closeWarnings.length ?? 1) === 0) {
    return 'success'
  }
  return 'warning'
})
const ageText = (row: YouRow): string | null =>
  row.ageMs === null ? null : formatDuration(row.ageMs)

// An in-app popover: registers with the native-overlay freeze (a browser pane under it freezes).
const rootEl = ref<HTMLElement | null>(null)
useNativeOverlay('campaign-popover', rootEl)
</script>

<template>
  <div
    ref="rootEl"
    class="anim-fade-in-scale flex flex-col overflow-hidden rounded border border-border-2 bg-surface shadow-pop"
    style="width: 520px; max-height: 560px"
    data-test="campaign-popover"
    :data-dsqa="`campaign-popover--${model.tone}`"
  >
    <div class="shrink-0 border-b border-border" style="padding: 10px 14px">
      <div class="flex items-baseline" style="gap: 8px">
        <span class="min-w-0 truncate text-text" style="font-size: 12.5px; font-weight: 500">{{
          view.title
        }}</span>
        <span
          class="ml-auto shrink-0 tabular-nums text-text-4"
          style="font-size: 11px"
          data-test="campaign-headline"
          >{{ headline }}</span
        >
      </div>
      <div
        class="truncate text-text-3"
        style="font-size: 11px; margin-top: 2px"
        :title="view.campaign.declaredEnd.target"
      >
        {{ $t('campaign.declaredEnd', { target: view.campaign.declaredEnd.target }) }}
      </div>
      <div
        class="tabular-nums text-text-4"
        style="font-size: 11px; margin-top: 3px"
        data-test="campaign-counts"
      >
        {{ countsText }}
      </div>
      <div
        v-if="model.radiant"
        class="flex items-center text-text-3"
        style="gap: 8px; margin-top: 6px; font-size: 11px"
        data-test="campaign-radiant"
      >
        <div class="flex-1 overflow-hidden rounded-full bg-border-2" style="height: 3px">
          <div class="h-full bg-accent" :style="{ width: `${radiantPct}%` }" />
        </div>
        <span class="tabular-nums">{{
          $t('campaign.radiant', { done: model.radiant.done, total: model.radiant.total })
        }}</span>
      </div>
    </div>

    <div class="scrollable min-h-0 flex-1 overflow-y-auto">
      <div class="flex" data-test="campaign-split">
        <!-- Left: the quests on the margin rail. -->
        <div
          class="shrink-0 border-r border-border"
          style="width: 190px; padding: 10px 8px 10px 14px"
          data-test="campaign-quests"
        >
          <template
            v-for="g in [
              { key: 'main', rows: model.main, meta: mainMeta },
              {
                key: 'side',
                rows: model.side,
                meta: model.counts.sideOpen
                  ? $t('campaign.group.sideMeta', { n: model.counts.sideOpen })
                  : ''
              },
              { key: 'locked', rows: model.locked, meta: String(model.locked.length) }
            ]"
            :key="g.key"
          >
            <div v-if="g.rows.length" :data-test="`campaign-${g.key}`" style="margin-bottom: 10px">
              <div
                class="flex items-baseline uppercase text-text-4"
                style="
                  font-size: 10.5px;
                  font-weight: 500;
                  letter-spacing: 0.07em;
                  margin-bottom: 4px;
                "
              >
                {{ $t(`campaign.group.${g.key}`) }}
                <span class="ml-auto tabular-nums normal-case" style="letter-spacing: 0">{{
                  g.meta
                }}</span>
              </div>
              <button
                v-for="r in g.rows"
                :key="r.chapter.id"
                type="button"
                class="flex w-full cursor-pointer items-center rounded-sm text-left hover:bg-surface-2"
                :class="r.chapter.id === selectedId ? 'bg-surface-2' : ''"
                style="gap: 7px; padding: 3px 4px; font-size: 12px"
                :aria-current="r.chapter.id === selectedId ? 'true' : undefined"
                :data-chapter="r.chapter.id"
                :data-state="r.state"
                @click="selectedId = r.chapter.id"
              >
                <MissionStepGlyph
                  :visual="STATE_VISUAL[r.state]"
                  :current="r.current"
                  :label="stateWord(r.state)"
                />
                <span v-if="r.chapter.required" class="shrink-0 tabular-nums text-text-4">{{
                  r.chapter.ordinal
                }}</span>
                <span
                  class="min-w-0 flex-1 truncate"
                  :class="
                    r.current
                      ? 'font-medium text-text'
                      : r.state === 'locked'
                        ? 'text-text-4'
                        : 'text-text-2'
                  "
                  >{{ r.chapter.title }}</span
                >
                <span
                  v-if="r.state === 'inReview' || r.state === 'running'"
                  class="shrink-0 text-text-4"
                  style="font-size: 10.5px"
                  >{{ stateWord(r.state) }}</span
                >
              </button>
            </div>
          </template>
        </div>

        <!-- Right: the selected chapter's objectives with the gate dots. -->
        <div class="min-w-0 flex-1" style="padding: 10px 14px" data-test="campaign-objectives">
          <template v-if="selected">
            <div
              class="uppercase text-text-4"
              style="font-size: 10.5px; font-weight: 500; letter-spacing: 0.07em"
            >
              <template v-if="selected.chapter.required"
                >{{ $t('campaign.group.main') }} · #{{ selected.chapter.ordinal }}</template
              >
              <template v-else
                >{{ $t('campaign.sideQuest') }} · {{ $t('campaign.sideNotRequired') }}</template
              >
            </div>
            <div class="flex items-baseline" style="gap: 8px; margin-top: 3px">
              <span class="min-w-0 truncate text-text" style="font-size: 13px; font-weight: 500">{{
                selected.chapter.title
              }}</span>
              <span class="shrink-0 text-text-4" style="font-size: 11px">{{
                stateWord(selected.state)
              }}</span>
            </div>
            <div
              v-if="origin"
              class="text-text-4"
              style="font-size: 11px; margin-top: 2px"
              data-test="campaign-origin"
            >
              {{ $t('campaign.discoveredFrom', { n: origin.n, title: origin.title }) }}
            </div>

            <div v-if="selected.mission" style="margin-top: 10px">
              <div class="flex items-baseline" style="margin-bottom: 6px">
                <span
                  class="uppercase text-text-4"
                  style="font-size: 10.5px; font-weight: 500; letter-spacing: 0.07em"
                  >{{ $t('campaign.objectives') }}</span
                >
                <span class="ml-auto tabular-nums text-text-4" style="font-size: 10.5px">{{
                  $t('campaign.objectivesStepsOf', {
                    done: selected.mission.done,
                    total: selected.mission.total
                  })
                }}</span>
              </div>
              <div
                v-for="s in selected.mission.steps"
                :key="s.step.id"
                class="flex items-center"
                style="gap: 7px; padding: 3px 0; font-size: 12px"
                :aria-current="s.current ? 'step' : undefined"
                data-objective
              >
                <MissionStepGlyph
                  :visual="s.visual"
                  :current="s.current"
                  :label="visualLabel(s.visual)"
                />
                <span class="w-4 shrink-0 tabular-nums text-text-4" style="font-size: 10.5px">{{
                  s.letter ?? ''
                }}</span>
                <span
                  class="min-w-0 flex-1 truncate"
                  :class="
                    s.current
                      ? 'font-medium text-text'
                      : s.visual === 'verified' || s.visual === 'done'
                        ? 'text-text-3'
                        : 'text-text-4'
                  "
                  >{{ s.step.title }}</span
                >
                <span
                  class="inline-flex shrink-0 items-center"
                  style="gap: 4px"
                  role="group"
                  :aria-label="$t('mission.gates.label')"
                >
                  <span
                    v-for="g in s.gates"
                    :key="g.name"
                    class="shrink-0 rounded-full border-[1.5px]"
                    :class="GATE_DOT_CLASS[g.state]"
                    style="width: 7px; height: 7px"
                    role="img"
                    :title="gateTitle(s, g)"
                    :aria-label="gateTitle(s, g)"
                    :data-gate="g.name"
                    :data-state="g.state"
                  />
                </span>
              </div>
              <button
                type="button"
                class="flex cursor-pointer items-center text-accent hover:underline"
                style="gap: 4px; margin-top: 8px; font-size: 11.5px"
                data-test="campaign-open-chapter"
                @click="selected.missionId && emit('openChapter', selected.missionId)"
              >
                {{ $t('campaign.openChapter') }}
              </button>
            </div>
            <div
              v-else
              class="text-text-4"
              style="margin-top: 10px; font-size: 11.5px; line-height: 1.5"
              data-test="campaign-no-mission"
            >
              {{
                selected.state === 'locked'
                  ? $t('campaign.lockedUntil')
                  : selected.missionId
                    ? $t('campaign.missionNotOpen')
                    : $t('campaign.noMission')
              }}
            </div>
          </template>
        </div>
      </div>

      <!-- The You lane: what the campaign's open chapters owe the operator. -->
      <div class="border-t border-border" style="padding: 10px 14px" data-test="campaign-you">
        <div
          class="flex items-start rounded-sm"
          :class="
            youLook === 'warning'
              ? 'border border-warning-line bg-warning-soft text-warning'
              : youLook === 'success'
                ? 'border border-green-line bg-green-soft text-green'
                : 'text-text-4'
          "
          :style="
            youLook === 'clear'
              ? 'gap: 7px; font-size: 11.5px; line-height: 1.5'
              : 'gap: 7px; padding: 8px 10px; font-size: 11.5px; line-height: 1.5'
          "
          :data-dsqa="`campaign-you--${youLook}`"
        >
          <TriangleAlert
            v-if="youLook === 'warning'"
            :size="13"
            :stroke-width="1.8"
            class="mt-0.5 shrink-0"
          />
          <Check
            v-else-if="youLook === 'success'"
            :size="13"
            :stroke-width="1.8"
            class="mt-0.5 shrink-0"
          />
          <div class="min-w-0 flex-1">
            <span
              class="block uppercase opacity-85"
              style="font-size: 9.5px; font-weight: 700; letter-spacing: 0.06em; margin-bottom: 3px"
              >{{ $t('mission.you.label') }}</span
            >
            <span data-test="campaign-you-first">{{
              firstYou ? youText(firstYou) : $t('mission.you.clear')
            }}</span>
            <span v-if="firstYou" class="ml-2 opacity-75" style="font-size: 10.5px"
              >{{ $t('campaign.you.chapterTag', { n: firstYou.chapterOrdinal })
              }}<template v-if="ageText(firstYou.row)">
                · {{ ageText(firstYou.row) }}</template
              ></span
            >
          </div>
        </div>
        <div v-if="restYou.length" style="margin-top: 6px">
          <div
            v-for="(y, i) in restYou"
            :key="i"
            class="flex items-baseline border-t border-border text-text-2 first:border-t-0"
            style="gap: 8px; padding: 5px 0; font-size: 11.5px"
            data-test="campaign-you-row"
          >
            <span
              class="shrink-0"
              :class="RISK_CLASS[y.row.risk]"
              style="font-size: 10px"
              aria-hidden="true"
              >●</span
            >
            <span class="min-w-0 flex-1">{{ youText(y) }}</span>
            <span class="shrink-0 text-text-4" style="font-size: 10.5px">{{
              $t('campaign.you.chapterTag', { n: y.chapterOrdinal })
            }}</span>
            <span
              v-if="ageText(y.row)"
              class="shrink-0 tabular-nums text-text-4"
              style="font-size: 10.5px"
              >{{ ageText(y.row) }}</span
            >
          </div>
        </div>
      </div>
    </div>

    <div class="flex shrink-0 items-center border-t border-border" style="padding: 8px 14px">
      <span :title="$t('campaign.end.unavailable')">
        <Button
          variant="ghost"
          disabled
          data-test="campaign-end"
          :title="$t('campaign.end.unavailable')"
        >
          <Flag :size="14" :stroke-width="1.8" />{{ $t('campaign.end.open') }}
        </Button>
      </span>
      <span class="ml-auto" :title="$t('campaign.map.unavailable')">
        <Button
          variant="primary"
          disabled
          data-test="campaign-open-map"
          :title="$t('campaign.map.unavailable')"
        >
          <MapIcon :size="14" :stroke-width="1.8" />{{ $t('campaign.map.open') }}
        </Button>
      </span>
    </div>
  </div>
</template>
