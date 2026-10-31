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
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { onClickOutside, onKeyStroke } from '@vueuse/core'
import { useI18n } from 'vue-i18n'
import { BookOpen, Check, ListChecks } from 'lucide-vue-next'
import { campaignPillText } from '../lib/campaign-view'
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
/** The back row's number: the chapter's position among the required ones; `null` for a side quest. */
const campaignBack = computed(() => {
  const row = chapterRow.value
  const cv = campaignView.value
  if (!row || !cv) return undefined
  const required = cv.campaign.chapters.filter((c) => c.required)
  const index = required.findIndex((c) => c.id === row.chapter.id)
  return { ordinal: index === -1 ? null : index + 1, total: cv.progress.total }
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
    // The campaign popover is the widest one; flip for it so neither stage ever overflows.
    alignRight.value = left + (campaign.value ? 520 : POPOVER_W.value) > window.innerWidth - 8
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
    class="relative flex shrink-0"
    style="-webkit-app-region: no-drag"
  >
    <button
      type="button"
      class="flex shrink-0 cursor-pointer items-center rounded border tabular-nums transition hover:brightness-110"
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
      <template v-if="label">{{ label }}</template>
    </button>
    <template v-if="open">
      <CampaignPopover
        v-if="campaign && campaignView && stage === 'campaign'"
        :view="campaignView"
        :model="campaign"
        class="absolute top-full z-50 mt-1.5"
        :class="alignRight ? 'right-0' : 'left-0'"
        @open-chapter="openChapter"
      />
      <MissionPopover
        v-else-if="campaign && chapterRow?.mission && chapterRow.missionView"
        :view="chapterRow.missionView"
        :model="chapterRow.mission"
        :campaign-back="campaignBack"
        class="absolute top-full z-50 mt-1.5"
        :class="alignRight ? 'right-0' : 'left-0'"
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
