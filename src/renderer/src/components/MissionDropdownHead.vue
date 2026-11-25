<script setup lang="ts">
/**
 * Mission dropdown — the head (Missions v4; design.md §6 "Mission dropdown" → "What it draws" 1; mockup
 * `docs/design/mission-dropdown/`, states `mid`, `multi` and `chooser`).
 *
 * The mission title (wraps, never cut) and ONE progress row: a 6px bar carrying the server's numbers and the
 * count text on the same row. It draws no "Mission" title, no state tag and no "Ready to close" badge: the next
 * card and the green pill already say it. Only when the session leads several missions does a one-line switch
 * sit above the title ("Mission 1 of 3 · Change"); it swaps the head for a `radiogroup` of those missions
 * (title, "{done} of {total} milestones · {n} for you", a check on the current one). With one mission there is
 * no switch and no line.
 *
 * Pure view: the numbers are `lib/mission-pane-view.ts`'s reading of the reply, the missions of the switch are
 * `ledMissionRows`, and choosing one is the parent's (`choose`): it tells the store, which never writes.
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, ChevronDown } from 'lucide-vue-next'
import {
  dropdownProgressLine,
  missionNumbers,
  progressPercent,
  type LedMissionRow,
  type MissionV4Reply
} from '../lib/mission-pane-view'

const props = withDefaults(
  defineProps<{
    detail: MissionV4Reply['detail']
    /** The missions this session leads; the switch is drawn only when there are several. */
    led?: LedMissionRow[]
    /** The id of the mission shown. */
    currentId?: string
  }>(),
  { led: () => [], currentId: '' }
)
const emit = defineEmits<{
  choose: [id: string]
  /** The list of missions opened or closed: while it is open it is all the dropdown shows (the mockup's `chooser`). */
  chooser: [open: boolean]
}>()

const { t } = useI18n()

const numbers = computed(() => missionNumbers(props.detail))
const percent = computed(() => progressPercent(numbers.value.done, numbers.value.total))
const countLine = computed(() => dropdownProgressLine(t, props.detail))

const several = computed(() => props.led.length > 1)
const position = computed(() => {
  const i = props.led.findIndex((m) => m.id === props.currentId)
  return i === -1 ? 1 : i + 1
})
const chooserOpen = ref(false)
const switchEl = ref<HTMLButtonElement | null>(null)
const groupEl = ref<HTMLElement | null>(null)

/** "4 of 21 steps · 3 for you": the server's count, and what is owed only when something is. */
function subLine(m: LedMissionRow): string {
  const count = t(
    m.unit === 'milestones'
      ? 'missionDropdown.head.sub.milestones'
      : 'missionDropdown.head.sub.steps',
    { done: m.done, total: m.total },
    m.total
  )
  return m.forYou > 0 ? t('missionDropdown.head.sub.forYou', { count, n: m.forYou }) : count
}

// The list cannot outlive the switch: with one mission left (or none) it closes, and the parent is told.
watch(several, (now) => {
  if (!now && chooserOpen.value) {
    chooserOpen.value = false
    emit('chooser', false)
  }
})
onBeforeUnmount(() => {
  if (chooserOpen.value) emit('chooser', false)
})

async function openChooser(): Promise<void> {
  chooserOpen.value = true
  emit('chooser', true)
  await nextTick()
  const radios = radiosOf()
  ;(radios.find((r) => r.getAttribute('aria-checked') === 'true') ?? radios[0])?.focus()
}
async function closeChooser(): Promise<void> {
  chooserOpen.value = false
  emit('chooser', false)
  await nextTick()
  switchEl.value?.focus()
}
function choose(id: string): void {
  emit('choose', id)
  void closeChooser()
}

const radiosOf = (): HTMLElement[] =>
  Array.from(groupEl.value?.querySelectorAll<HTMLElement>('[role="radio"]') ?? [])

/** Up and Down walk the list; Esc closes the list before it closes the dropdown. */
function onGroupKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    void closeChooser()
    return
  }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  const radios = radiosOf()
  const i = radios.indexOf(document.activeElement as HTMLElement)
  if (i === -1) return
  e.preventDefault()
  const next = e.key === 'ArrowDown' ? i + 1 : i - 1
  radios[(next + radios.length) % radios.length]?.focus()
}
</script>

<template>
  <div style="padding: 14px 14px 12px" data-dsqa-part="head" data-test="mission-head">
    <!-- The switch's list: it takes the head's place, as in the mockup's `chooser` state. -->
    <template v-if="several && chooserOpen">
      <div
        class="uppercase text-text-4"
        style="font-size: 10px; font-weight: 700; letter-spacing: 0.07em"
        data-test="mission-leads-label"
      >
        {{ $t('missionDropdown.head.leads', { n: led.length }) }}
      </div>
      <ul
        ref="groupEl"
        class="m-0 flex list-none flex-col p-0"
        style="margin-top: 8px; gap: 4px"
        role="radiogroup"
        :aria-label="$t('missionDropdown.head.choose')"
        data-test="mission-leads-list"
        @keydown="onGroupKey"
      >
        <li v-for="m in led" :key="m.id" class="rounded">
          <button
            type="button"
            role="radio"
            :aria-checked="m.id === currentId"
            class="grid w-full rounded border text-left transition hover:bg-surface-2"
            :class="
              m.id === currentId
                ? 'border-accent-line bg-accent-soft'
                : 'border-border bg-transparent'
            "
            style="grid-template-columns: minmax(0, 1fr) 12px; gap: 2px 10px; padding: 8px 10px"
            data-test="mission-leads-row"
            @click="choose(m.id)"
          >
            <span class="min-w-0 text-text [overflow-wrap:anywhere]" style="font-size: 12.5px">{{
              m.title
            }}</span>
            <span class="text-accent" style="align-self: start; margin-top: 2px">
              <Check v-if="m.id === currentId" :size="12" :stroke-width="2" aria-hidden="true" />
            </span>
            <span class="col-start-1 min-w-0 text-text-4" style="font-size: 10.5px">{{
              subLine(m)
            }}</span>
          </button>
        </li>
      </ul>
    </template>

    <template v-else>
      <button
        v-if="several"
        ref="switchEl"
        type="button"
        class="flex w-full items-center text-left transition"
        style="gap: 6px"
        aria-expanded="false"
        :aria-label="$t('missionDropdown.head.switchLabel', { n: position, m: led.length })"
        data-test="mission-switch"
        @click="openChooser"
      >
        <span
          class="uppercase text-text-4"
          style="font-size: 10px; font-weight: 700; letter-spacing: 0.07em"
          >{{ $t('missionDropdown.head.switchCount', { n: position, m: led.length }) }}</span
        >
        <span
          class="inline-flex items-center whitespace-nowrap text-text-4 hover:text-text"
          style="margin-left: auto; gap: 4px; font-size: 10.5px"
          >{{ $t('missionDropdown.head.change')
          }}<ChevronDown :size="10" :stroke-width="2" aria-hidden="true"
        /></span>
      </button>

      <h2
        class="m-0 text-text [overflow-wrap:anywhere]"
        :style="{
          fontSize: '13.5px',
          fontWeight: 600,
          lineHeight: 1.35,
          ...(several ? { marginTop: '4px' } : {})
        }"
        data-test="mission-title"
      >
        {{ detail.title }}
      </h2>

      <!-- One row: the 6px bar (the server's numbers) and the count. -->
      <div
        class="flex items-center"
        style="margin-top: 9px; gap: 10px"
        data-dsqa-part="progress"
        data-test="mission-progress-row"
      >
        <div
          class="h-1.5 min-w-10 flex-1 overflow-hidden rounded-sm border border-border bg-surface-2"
          role="progressbar"
          :aria-label="$t('missionDropdown.head.barLabel')"
          aria-valuemin="0"
          :aria-valuemax="numbers.total"
          :aria-valuenow="numbers.done"
          :aria-valuetext="countLine"
          data-test="mission-progress"
        >
          <span
            class="block h-full bg-green"
            :style="{ width: `${percent}%` }"
            data-test="mission-bar-fill"
          />
        </div>
        <span
          class="whitespace-nowrap text-text-3 tabular-nums"
          style="font-size: 11.5px"
          data-test="mission-count"
          >{{ countLine }}</span
        >
      </div>
    </template>
  </div>
</template>
