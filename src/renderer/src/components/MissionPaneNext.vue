<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Flag } from 'lucide-vue-next'
import Button from './ui/Button.vue'
import {
  nextLook,
  waitingStepId,
  type MissionV4Reply,
  type NextLook
} from '../lib/mission-pane-view'

/**
 * "Your next step" (Missions v4 S-18, design.md §6 "Mission pane" → The glance): ONE box with the ask,
 * the why and one button, and "N more waiting on you" that opens the rest in place.
 *
 * It only reads `detail.waiting`. The ask and the why are the server's wording, shown as written (the
 * writing contract caps them on write; the pane never cuts or rewrites them). The count, the eyebrow
 * words and the buttons are written here, by identifier, never taken from the reply. The one button is
 * "Open step": this slice has no door, so an item with no single step to open (a close, an attach, a
 * review of several) draws no button until the slice that owns its door lands.
 */
const props = defineProps<{ detail: MissionV4Reply['detail'] }>()
const emit = defineEmits<{ openStep: [stepId: string]; close: [] }>()

const { t } = useI18n()

const next = computed(() => props.detail.waiting.next)
const more = computed(() => props.detail.waiting.more)
const look = computed<NextLook>(() => nextLook(props.detail))
const expanded = ref(false)

const primaryStep = computed(() => (next.value ? waitingStepId(next.value) : null))
const nextIsClose = computed(() => next.value?.kind === 'close')

/** Nothing waits on the operator: say what runs, counted from the server's numbers. */
const calmLine = computed(() => {
  const running = props.detail.progress.counts.running
  return running > 0
    ? t('missionPane.next.running', { n: running }, running)
    : t('missionPane.next.idle')
})

const BOX: Record<NextLook, string> = {
  you: 'border-warning-line bg-warning-soft',
  ok: 'border-green-line bg-green-soft',
  calm: 'border-border-2 bg-surface-2'
}
const EYEBROW: Record<NextLook, string> = {
  you: 'text-warning',
  ok: 'text-green',
  calm: 'text-text-4'
}
/** The kind's eyebrow colour (design.md §6 "Mission pane" → Your next step). */
const KIND: Record<string, string> = {
  'main-failing': 'text-red',
  unblock: 'text-red',
  settle: 'text-warning',
  review: 'text-text-3',
  close: 'text-green',
  attach: 'text-accent'
}
</script>

<template>
  <section
    class="flex flex-col rounded border"
    :class="BOX[look]"
    style="margin-top: 10px; padding: 10px 12px; gap: 8px"
    :aria-label="$t('missionPane.next.label')"
    :data-look="look"
    data-test="next-step"
  >
    <span
      class="uppercase"
      :class="EYEBROW[look]"
      style="font-size: 10px; font-weight: 700; letter-spacing: 0.07em"
      >{{ look === 'calm' ? $t('missionPane.next.calm') : $t('missionPane.next.you') }}</span
    >

    <template v-if="next">
      <span class="break-words text-text" style="font-size: 13px; line-height: 1.4">{{
        next.ask
      }}</span>
      <span
        v-if="next.why"
        class="break-words text-text-3"
        style="font-size: 11.5px; line-height: 1.4; margin-top: -4px"
        >{{ next.why }}</span
      >
    </template>
    <span
      v-else
      class="text-text"
      style="font-size: 13px; line-height: 1.4"
      data-test="next-calm"
      >{{ calmLine }}</span
    >

    <div
      v-if="primaryStep || nextIsClose || more.length > 0"
      class="flex flex-wrap items-center"
      style="gap: 10px"
    >
      <Button
        v-if="primaryStep"
        variant="primary"
        data-test="next-open-step"
        @click="emit('openStep', primaryStep)"
      >
        {{ $t('missionPane.next.openStep') }}
      </Button>
      <Button v-if="nextIsClose" variant="primary" data-test="next-close" @click="emit('close')">
        <Flag :size="14" :stroke-width="1.8" aria-hidden="true" />{{ $t('missionPane.next.close') }}
      </Button>
      <button
        v-if="more.length > 0"
        type="button"
        class="ml-auto text-text-3 transition hover:text-text"
        style="font-size: 11.5px"
        :aria-expanded="expanded"
        data-test="next-more"
        @click="expanded = !expanded"
      >
        {{
          expanded
            ? $t('missionPane.next.less')
            : $t('missionPane.next.more', { n: more.length }, more.length)
        }}
      </button>
    </div>

    <!-- The rest, in place: one row per other item, in the server's order. -->
    <div v-if="expanded && more.length > 0" class="border-t border-border" style="margin-top: 2px">
      <div
        v-for="item in more"
        :key="item.id"
        class="grid items-center border-t border-border first:border-t-0"
        style="grid-template-columns: 1fr auto; gap: 2px 10px; padding: 8px 0"
        data-test="next-rest-row"
        :data-kind="item.kind"
      >
        <span class="min-w-0 break-words text-text" style="font-size: 12px">
          <span
            class="uppercase"
            :class="KIND[item.kind]"
            style="font-size: 9.5px; font-weight: 700; letter-spacing: 0.06em; margin-right: 6px"
            >{{ $t(`missionPane.next.kind.${item.kind}`) }}</span
          >{{ item.ask }}
        </span>
        <button
          v-if="waitingStepId(item)"
          type="button"
          class="row-span-2 rounded-sm border border-border-2 text-text-2 transition hover:bg-surface-2 hover:text-text"
          style="grid-column: 2; grid-row: 1 / span 2; padding: 2px 8px; font-size: 11px"
          data-test="next-rest-open"
          @click="emit('openStep', waitingStepId(item) as string)"
        >
          {{ $t('missionPane.next.openStep') }}
        </button>
        <button
          v-else-if="item.kind === 'close'"
          type="button"
          class="row-span-2 rounded-sm border border-border-2 text-text-2 transition hover:bg-surface-2 hover:text-text"
          style="grid-column: 2; grid-row: 1 / span 2; padding: 2px 8px; font-size: 11px"
          data-test="next-close"
          @click="emit('close')"
        >
          {{ $t('missionPane.next.close') }}
        </button>
        <span v-if="item.why" class="break-words text-text-4" style="font-size: 10.5px">{{
          item.why
        }}</span>
      </div>
    </div>
  </section>
</template>
