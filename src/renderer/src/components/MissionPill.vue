<script setup lang="ts">
/**
 * Topbar "Step N of M" pill (T370; Mission v3 S3 — design.md §6 "Mission
 * progress" → Topbar pill). Same anatomy as the provider/orchestrator pills
 * beside it, but a button: it toggles the progress popover. The label is the
 * server's headline — a position, never a count of finished steps. Renders
 * nothing when the selected session owns no open mission (`no-mission` is a
 * state, not a gap).
 */
import { computed, ref, watch } from 'vue'
import { onClickOutside, onKeyStroke } from '@vueuse/core'
import { useI18n } from 'vue-i18n'
import { Check, ListChecks } from 'lucide-vue-next'
import { headlineText, PILL_TONE_CLASS, type MissionState } from '../lib/mission-view'
import { useMissionsStore } from '../stores/missions'
import MissionPopover from './MissionPopover.vue'

const props = defineProps<{ sessionId: string }>()

const { t } = useI18n()
const missions = useMissionsStore()
missions.ensureStarted()

const view = computed(() => missions.viewForSession(props.sessionId))
const model = computed(() => missions.modelForSession(props.sessionId))

const rootEl = ref<HTMLElement | null>(null)
const open = ref(false)
// The end dialog teleports to <body>: a click on it is not "outside".
onClickOutside(rootEl, () => (open.value = false), { ignore: ['[data-mission-close-confirm]'] })
onKeyStroke('Escape', () => (open.value = false))
// A different session (or its mission going away) closes the popover.
watch(
  () => `${props.sessionId}|${view.value?.mission.id ?? ''}`,
  () => (open.value = false)
)

/** Popover width (design.md §6) — flip to right-aligned when it would overflow. */
const POPOVER_W = 400
const alignRight = ref(false)

function toggle(): void {
  open.value = !open.value
  if (!open.value) return
  const left = rootEl.value?.getBoundingClientRect().left ?? 0
  alignRight.value = left + POPOVER_W > window.innerWidth - 8
  void missions.refresh()
}

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

const title = computed(() =>
  view.value && model.value
    ? t('mission.pillTitle', {
        title: view.value.title,
        state: t(`mission.state.${STATE_KEY[model.value.state]}`)
      })
    : ''
)
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
      :title="title"
      :aria-label="label ? `${label} — ${title}` : title"
      :aria-expanded="open"
      :data-dsqa="`topbar-pill--${model.tone}`"
      :data-state="model.state"
      @click="toggle"
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
