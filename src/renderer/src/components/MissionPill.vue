<script setup lang="ts">
/**
 * Topbar "Step N of M" pill (T370; Mission v3 S3 — design.md §6 "Mission
 * progress" → Topbar pill). Same anatomy as the provider/orchestrator pills
 * beside it, but a button: it toggles the progress popover. The label is the
 * server's headline — a position, never a count of finished steps. Renders
 * nothing when the selected session owns no open mission (`no-mission` is a
 * state, not a gap).
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { onClickOutside, onKeyStroke } from '@vueuse/core'
import { useI18n } from 'vue-i18n'
import { Check, ListChecks } from 'lucide-vue-next'
import { headlineText, PILL_TONE_CLASS, pulseText, type MissionState } from '../lib/mission-view'
import { useMissionsStore } from '../stores/missions'
import { useUiStore } from '../stores/ui'
import { useKeybindingsStore } from '../stores/keybindings'
import MissionPopover from './MissionPopover.vue'

const props = defineProps<{ sessionId: string }>()

const { t } = useI18n()
const missions = useMissionsStore()
const ui = useUiStore()
const keybindings = useKeybindingsStore()
missions.ensureStarted()

const view = computed(() => missions.viewForSession(props.sessionId))
const model = computed(() => missions.modelForSession(props.sessionId))

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

/** Popover width (design.md §6) — flip to right-aligned when it would overflow. */
const POPOVER_W = 400
const alignRight = ref(false)

// Every open — the pill's click, `view.missionProgress`, an Activity row — places
// the popover and refreshes the mission. `sync` so the placement is set before
// the popover first renders.
watch(
  open,
  (isOpen) => {
    if (!isOpen) return
    const left = rootEl.value?.getBoundingClientRect().left ?? 0
    alignRight.value = left + POPOVER_W > window.innerWidth - 8
    void missions.refresh()
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

const label = computed(() => (model.value ? headlineText(t, model.value.headline) : ''))

const done = computed(
  () => model.value?.headline.kind === 'done' || view.value?.mission.status === 'delivered'
)

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
      :class="PILL_TONE_CLASS[model.tone]"
      style="gap: 4px; padding: 1px 7px; font-size: 10.5px; font-weight: 500; height: 18px"
      :title="keybindings.withChord(title, 'view.missionProgress')"
      :aria-label="label ? `${label} — ${title}` : title"
      :aria-expanded="open"
      :data-dsqa="`topbar-pill--${model.tone}`"
      :data-state="model.state"
      @click="ui.togglePopover('missionProgress')"
    >
      <component :is="done ? Check : ListChecks" :size="10" :stroke-width="1.8" class="shrink-0" />
      <template v-if="label">{{ label }}</template>
    </button>
    <MissionPopover
      v-if="open"
      :view="view"
      :model="model"
      class="absolute top-full z-50 mt-1.5"
      :class="alignRight ? 'right-0' : 'left-0'"
    />
  </div>
</template>
