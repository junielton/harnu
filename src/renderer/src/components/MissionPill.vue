<script setup lang="ts">
/**
 * Topbar "Step N of M" pill (T370; Mission v3 S3 — design.md §6 "Mission
 * progress" → Topbar pill). Same anatomy as the provider/orchestrator pills
 * beside it, but a button: it toggles the progress popover. The label is the
 * server's headline — a position, never a count of finished steps. Renders
 * nothing when the selected session owns no open mission (`no-mission` is a
 * state, not a gap).
 *
 * T596 (design.md §6 "Campaign progress"): when that mission is a chapter of a
 * loaded campaign, the same pill reads "Ch. N/M · Step a/b" and opens the
 * Campaign popover, whose "Open chapter" drills into the chapter popover with a
 * back link. A mission with no campaign keeps everything above unchanged.
 *
 * T607 (design.md §6 "Campaign progress" → Pill margin rail and radiant counter): the campaign
 * pill also draws a tick per required chapter (the server's `progress.states`) and, when the
 * server reports a radiant, its "48/88". Both are decoration over numbers the server already
 * counted; a mission with no campaign has neither.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { onClickOutside, onKeyStroke } from '@vueuse/core'
import { useI18n } from 'vue-i18n'
import { BookOpen, Check, ListChecks } from 'lucide-vue-next'
import { campaignPillText, type CampaignTick } from '../lib/campaign-view'
import { headlineText, PILL_TONE_CLASS, pulseText, type MissionState } from '../lib/mission-view'
import { useCampaignsStore } from '../stores/campaigns'
import { useMissionsStore } from '../stores/missions'
import { useUiStore } from '../stores/ui'
import { useKeybindingsStore } from '../stores/keybindings'
import CampaignPopover from './CampaignPopover.vue'
import MissionPopover from './MissionPopover.vue'

const props = defineProps<{ sessionId: string }>()

const { t } = useI18n()
const missions = useMissionsStore()
const campaigns = useCampaignsStore()
const ui = useUiStore()
const keybindings = useKeybindingsStore()
missions.ensureStarted()
campaigns.ensureStarted()

const view = computed(() => missions.viewForSession(props.sessionId))
const model = computed(() => missions.modelForSession(props.sessionId))
/** The campaign the own mission is a chapter of; `null` keeps today's mission pill. */
const campaign = computed(() => campaigns.modelForMission(view.value))
const campaignView = computed(() => campaigns.forMission(view.value))

/** Which popover the campaign pill shows: the campaign, or one chapter's mission (T596). */
const stage = ref<'campaign' | 'chapter'>('campaign')
const chapterMissionId = ref<string | null>(null)
const chapterRow = computed(() => {
  const m = campaign.value
  if (!m) return null
  const rows = [...m.main, ...m.side, ...m.locked]
  return (
    rows.find((r) => r.missionId === chapterMissionId.value && r.mission && r.missionView) ?? null
  )
})
/**
 * The back row: "Chapter {n} of {m}" with the SERVER's numbers (`progress.current.from`, `progress.total`).
 * It names a position only for the chapter the campaign is on; any other chapter says just "Campaign",
 * and a side chapter says "Side quest" — the renderer never works a position out of the chapter list.
 */
const campaignBack = computed(() => {
  const row = chapterRow.value
  const cv = campaignView.value
  if (!row || !cv) return undefined
  return {
    ordinal: row.current ? (cv.progress.current?.from ?? null) : null,
    total: cv.progress.total,
    side: !row.chapter.required
  }
})
function openChapter(missionId: string): void {
  chapterMissionId.value = missionId
  stage.value = 'chapter'
}
function backToCampaign(): void {
  stage.value = 'campaign'
}

const rootEl = ref<HTMLElement | null>(null)
// The open flag lives in the ui store (T486 U4a) so `view.missionProgress` opens
// it and the App's Esc binding can see it. The pill is the anchor: it renders
// only while the session owns an open mission.
const open = computed(() => ui.popovers.missionProgress)
watch(
  () => !!(view.value && model.value),
  (present) => ui.setPopoverAnchor('missionProgress', present),
  { immediate: true }
)
onBeforeUnmount(() => ui.setPopoverAnchor('missionProgress', false))
// The end dialog teleports to <body>: a click on it is not "outside".
onClickOutside(rootEl, () => ui.closePopover('missionProgress'), {
  ignore: ['[data-mission-close-confirm]']
})
onKeyStroke('Escape', () => ui.closePopover('missionProgress'))
// A different session (or its mission going away) closes the popover.
watch(
  () => `${props.sessionId}|${view.value?.mission.id ?? ''}`,
  () => ui.closePopover('missionProgress')
)

/** Popover width (design.md §4 / §6) — flip to right-aligned when it would overflow. */
const POPOVER_W = computed(() => (campaign.value && stage.value === 'campaign' ? 520 : 400))
const alignRight = ref(false)
/** The pill's left edge when the popover opened — the campaign popover's anchor (T596). */
const pillLeft = ref(0)
/**
 * Campaign flow: the popovers (520px, then 400px) are shifted to stay inside the window — left-aligned
 * to the pill where they fit, otherwise pushed left just enough, never past the window's left edge.
 * A mission with no campaign keeps the left/right flip above.
 */
const campaignShift = computed(() => {
  const max = window.innerWidth - 8 - POPOVER_W.value
  return Math.round(Math.max(8 - pillLeft.value, Math.min(0, max - pillLeft.value)))
})

// Every open — the pill's click, `view.missionProgress`, an Activity row — places
// the popover and refreshes the mission. `sync` so the placement is set before
// the popover first renders.
watch(
  open,
  (isOpen) => {
    if (!isOpen) return
    stage.value = 'campaign'
    chapterMissionId.value = view.value?.mission.id ?? null
    const left = rootEl.value?.getBoundingClientRect().left ?? 0
    pillLeft.value = left
    alignRight.value = left + POPOVER_W.value > window.innerWidth - 8
    void missions.refresh()
    void campaigns.refresh()
  },
  { flush: 'sync' }
)

// An Activity row asked for this mission's popover (BUG-173). The request can
// predate this pill (the owner was just selected) or the mission's view, so the
// watch re-checks when either arrives; `post` runs after the session-change
// close above, so that close cannot swallow the open. A request for another
// mission is left pending for the pill that owns it (it expires on its own).
watch(
  () => [missions.popoverRequest, view.value?.mission.id] as const,
  ([req, id]) => {
    if (!req || !id || req.missionId !== id) return
    if (!missions.consumePopoverRequest()) return
    ui.openPopover('missionProgress')
    // An Activity row names a mission, so a campaign pill opens straight onto its chapter.
    if (campaign.value) openChapter(id)
  },
  { immediate: true, flush: 'post' }
)

const STATE_KEY: Record<MissionState, string> = {
  active: 'active',
  blocked: 'blocked',
  'needs-you': 'needsYou',
  stale: 'stale',
  'total-changed': 'totalChanged',
  'rescope-pending': 'rescopePending',
  delivered: 'delivered'
}

const label = computed(() => {
  if (campaign.value) return campaignPillText(t, campaign.value)
  return model.value ? headlineText(t, model.value.headline) : ''
})

/**
 * One margin-rail tick's colour (design.md §6): done green, in review half green, the current
 * chapters accent (warning while the pill is), locked faint. Everything is the server's state.
 */
function tickClass(tk: CampaignTick): string {
  const m = campaign.value
  if (m?.done || tk.state === 'done') return 'bg-green'
  if (tk.state === 'inReview') return 'bg-green opacity-50'
  if (tk.current || tk.state === 'running')
    return m?.tone === 'warning' ? 'bg-warning' : 'bg-accent'
  if (tk.state === 'locked') return 'bg-border-2 opacity-50'
  return 'bg-border-2'
}

const done = computed(() =>
  campaign.value
    ? campaign.value.done
    : model.value?.headline.kind === 'done' || view.value?.mission.status === 'delivered'
)

/** The pill's tone: the campaign's when there is one, otherwise the mission's. */
const tone = computed(() => campaign.value?.tone ?? model.value?.tone ?? 'accent')

// T547: the first current step's pulse rides on the tooltip; the label stays the headline.
const pulse = computed(() => {
  const p = model.value?.steps.find((s) => s.firstCurrent)?.pulse
  return p ? pulseText(t, p) : ''
})

const title = computed(() => {
  if (!view.value || !model.value) return ''
  const named = {
    title: view.value.title,
    state: t(`mission.state.${STATE_KEY[model.value.state]}`)
  }
  if (campaign.value && campaignView.value) {
    return t('campaign.pill.title', { title: campaignView.value.title, label: label.value })
  }
  return pulse.value
    ? t('mission.pillTitleWithPulse', { ...named, pulse: pulse.value })
    : t('mission.pillTitle', named)
})
</script>

<template>
  <div
    v-if="view && model"
    ref="rootEl"
    class="relative flex min-w-0 shrink"
    style="-webkit-app-region: no-drag"
  >
    <button
      type="button"
      class="flex min-w-0 shrink cursor-pointer items-center rounded border tabular-nums transition hover:brightness-110"
      :class="PILL_TONE_CLASS[tone]"
      style="gap: 4px; padding: 1px 7px; font-size: 10.5px; font-weight: 500; height: 18px"
      :title="keybindings.withChord(title, 'view.missionProgress')"
      :aria-label="label ? `${label} — ${title}` : title"
      :aria-expanded="open"
      :data-dsqa="`topbar-pill--${tone}`"
      :data-state="model.state"
      :data-campaign="campaign ? 'true' : undefined"
      @click="ui.togglePopover('missionProgress')"
    >
      <component
        :is="done ? Check : campaign ? BookOpen : ListChecks"
        :size="10"
        :stroke-width="1.8"
        class="shrink-0"
      />
      <span v-if="label" class="truncate">{{ label }}</span>
      <span
        v-if="campaign && campaign.ticks.length > 0"
        class="inline-flex shrink-0 items-center"
        style="gap: 1px; height: 8px"
        aria-hidden="true"
        data-test="campaign-ticks"
      >
        <i
          v-for="tk in campaign.ticks"
          :key="tk.chapterId"
          class="shrink-0 rounded-[1px]"
          :class="tickClass(tk)"
          :style="{ width: tk.current ? '4px' : '2px', height: '8px' }"
          data-tick
          :data-state="tk.state"
          :data-current="tk.current ? 'true' : undefined"
        />
      </span>
      <span
        v-if="campaign?.radiant"
        class="shrink-0 opacity-70"
        data-test="campaign-pill-radiant"
        >{{
          $t('campaign.pill.radiant', {
            done: campaign.radiant.done,
            total: campaign.radiant.total
          })
        }}</span
      >
    </button>
    <template v-if="open">
      <CampaignPopover
        v-if="campaign && campaignView && stage === 'campaign'"
        :view="campaignView"
        :model="campaign"
        class="absolute top-full z-50 mt-1.5"
        :style="{ left: `${campaignShift}px` }"
        @open-chapter="openChapter"
      />
      <MissionPopover
        v-else-if="campaign && chapterRow?.mission && chapterRow.missionView"
        :view="chapterRow.missionView"
        :model="chapterRow.mission"
        :campaign-back="campaignBack"
        class="absolute top-full z-50 mt-1.5"
        :style="{ left: `${campaignShift}px` }"
        @back="backToCampaign"
      />
      <MissionPopover
        v-else
        :view="view"
        :model="model"
        class="absolute top-full z-50 mt-1.5"
        :class="alignRight ? 'right-0' : 'left-0'"
      />
    </template>
  </div>
</template>
