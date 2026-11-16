<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Flag } from 'lucide-vue-next'
import Button from './ui/Button.vue'
import {
  nextLook,
  restRowGrid,
  waitingStepId,
  waitingText,
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
 *
 * The words (stp-21): the server's `ask` and `why` are English, so the pane words each item itself from
 * its kind and the record (`waitingText`) and a Portuguese pane shows no English. What an agent wrote (a
 * blocker's own ask, a criterion, a title) is shown as written. "N more waiting on you" opens in place; the
 * pane keeps that choice (`moreOpen`) so it survives a refresh, and a standalone box keeps its own.
 */
const props = defineProps<{
  detail: MissionV4Reply['detail']
  /** The kept state of "N more waiting on you"; absent, the box keeps its own. */
  moreOpen?: boolean
  /** The pane is narrow: the box gives its text more room. */
  compact?: boolean
  /** A Done when a session proposed waits for the operator (an older mission's re-scope reads the same). */
  staged?: boolean
}>()
const emit = defineEmits<{
  openStep: [stepId: string]
  close: []
  toggleMore: []
  openStaged: []
}>()

const { t } = useI18n()

const next = computed(() => props.detail.waiting.next)
const more = computed(() => props.detail.waiting.more)
// A staged Done when is the next step when the waiting list names nothing else (design.md §6 "Mission pane" →
// Your next step): the box never reads "Nothing for you" above the Approve / Decline box.
const stagedNext = computed(() => props.staged === true && next.value === null)
const look = computed<NextLook>(() => nextLook(props.detail, props.staged === true))
const restGrid = computed(() => restRowGrid(props.compact ? 'narrow' : 'regular'))
const localOpen = ref(false)
const expanded = computed(() => props.moreOpen ?? localOpen.value)
function toggleMore(): void {
  if (props.moreOpen === undefined) localOpen.value = !localOpen.value
  emit('toggleMore')
}
// A button's text may wrap, and when the pane is narrow its padding gives the text the room.
const btnStyle = computed(() => ({
  whiteSpace: 'normal',
  ...(props.compact ? { padding: '5px 8px' } : {})
}))
const words = (item: Parameters<typeof waitingText>[2]): ReturnType<typeof waitingText> =>
  waitingText(t, props.detail, item)

const primaryStep = computed(() => (next.value ? waitingStepId(next.value) : null))
const nextIsClose = computed(() => next.value?.kind === 'close')

/** Nothing waits on the operator: say what runs, counted from the server's numbers. */
const calmLine = computed(() => {
  const running = props.detail.progress.counts.running
  return running > 0
    ? t('missionPane.next.running', { n: running }, running)
    : t('missionPane.next.idle')
})

/** Beside the text, pinned to column 2 over both text rows; narrow, on its own row under the text. */
const restButtonStyle = computed(() => ({
  padding: '2px 8px',
  fontSize: '11px',
  ...(restGrid.value.buttonBeside
    ? { gridColumn: '2', gridRow: '1 / span 2' }
    : { justifySelf: 'start', marginTop: '4px', order: '1' })
}))

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
    :style="{
      marginTop: '10px',
      padding: compact ? '8px 8px' : '10px 12px',
      gap: '8px'
    }"
    data-pane-section="next"
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

    <template v-if="stagedNext">
      <span class="min-w-0 break-words text-text" style="font-size: 13px; line-height: 1.4">{{
        $t('missionPane.next.text.doneWhen.ask')
      }}</span>
      <span
        class="min-w-0 break-words text-text-3"
        style="font-size: 11.5px; line-height: 1.4; margin-top: -4px"
        >{{ $t('missionPane.next.text.doneWhen.why') }}</span
      >
    </template>
    <template v-else-if="next">
      <span class="min-w-0 break-words text-text" style="font-size: 13px; line-height: 1.4">{{
        words(next).ask
      }}</span>
      <span
        v-if="words(next).why"
        class="min-w-0 break-words text-text-3"
        style="font-size: 11.5px; line-height: 1.4; margin-top: -4px"
        >{{ words(next).why }}</span
      >
    </template>
    <span
      v-else
      class="min-w-0 break-words text-text"
      style="font-size: 13px; line-height: 1.4"
      data-test="next-calm"
      >{{ calmLine }}</span
    >

    <div
      v-if="primaryStep || nextIsClose || stagedNext || more.length > 0"
      class="flex flex-wrap items-center"
      style="gap: 8px 10px"
      data-test="next-controls"
    >
      <Button
        v-if="stagedNext"
        variant="primary"
        :style="btnStyle"
        data-test="next-open-staged"
        @click="emit('openStaged')"
      >
        {{ $t('missionPane.next.text.doneWhen.open') }}
      </Button>
      <Button
        v-if="primaryStep"
        variant="primary"
        :style="btnStyle"
        data-test="next-open-step"
        @click="emit('openStep', primaryStep)"
      >
        {{ $t('missionPane.next.openStep') }}
      </Button>
      <Button
        v-if="nextIsClose"
        variant="primary"
        :style="btnStyle"
        data-test="next-close"
        @click="emit('close')"
      >
        <Flag :size="14" :stroke-width="1.8" aria-hidden="true" />{{ $t('missionPane.next.close') }}
      </Button>
      <button
        v-if="more.length > 0"
        type="button"
        class="ml-auto min-w-0 text-left text-text-3 transition hover:text-text"
        style="font-size: 11.5px"
        :aria-expanded="expanded"
        data-test="next-more"
        @click="toggleMore"
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
        :style="{ gridTemplateColumns: restGrid.columns, gap: '2px 10px', padding: '8px 0' }"
        data-test="next-rest-row"
        :data-kind="item.kind"
      >
        <span class="min-w-0 break-words text-text" style="font-size: 12px">
          <span
            class="uppercase"
            :class="KIND[item.kind]"
            style="font-size: 9.5px; font-weight: 700; letter-spacing: 0.06em; margin-right: 6px"
            >{{ $t(`missionPane.next.kind.${item.kind}`) }}</span
          >{{ words(item).ask }}
        </span>
        <button
          v-if="waitingStepId(item)"
          type="button"
          class="rounded-sm border border-border-2 text-text-2 transition hover:bg-surface-2 hover:text-text"
          :style="restButtonStyle"
          data-test="next-rest-open"
          @click="emit('openStep', waitingStepId(item) as string)"
        >
          {{ $t('missionPane.next.openStep') }}
        </button>
        <button
          v-else-if="item.kind === 'close'"
          type="button"
          class="rounded-sm border border-border-2 text-text-2 transition hover:bg-surface-2 hover:text-text"
          :style="restButtonStyle"
          data-test="next-close"
          @click="emit('close')"
        >
          {{ $t('missionPane.next.close') }}
        </button>
        <span
          v-if="words(item).why"
          class="col-start-1 min-w-0 break-words text-text-4"
          style="font-size: 10.5px"
          data-test="next-rest-why"
          >{{ words(item).why }}</span
        >
      </div>
    </div>
  </section>
</template>
