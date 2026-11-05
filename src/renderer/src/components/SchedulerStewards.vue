<script setup lang="ts">
/**
 * Stewards section of the Scheduler takeover (T609, campaign ch.5b — design.md §6 "Scheduler" →
 * Stewards section; campaign spec §3.4). A mission's steward is a SYSTEM worker, so it is not a row of
 * the folder groups: it is listed here, under its own heading, and is read-only — no enable switch, no
 * pin, no Run now, no delete, no prompt edit, and no detail pane. Its lifecycle is the mission's, and
 * pausing it is a door of the mission popover, not a switch of this list.
 *
 * T651 (approved mockup `scheduler-stewards`, states `recolhido` / `aberto`): the block is collapsible
 * with Up next's header anatomy. Collapsed it keeps one summary line; open, its rows scroll inside a
 * container capped by `--sched-stewards-max-h`, so thirteen stewards never push the worker list away.
 *
 * Presentational: the parent hands it the summaries (`lib/steward-view.ts`), resolves each mission's
 * title and pause from the mission store, and owns the (persisted) collapsed state.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Bot, ChevronDown } from 'lucide-vue-next'
import { formatDuration } from '../lib/mission-view'
import {
  stewardStateOf,
  stewardsSummaryParts,
  type StewardStateWord,
  type StewardSummary
} from '../lib/steward-view'

const props = defineProps<{
  stewards: StewardSummary[]
  nowMs: number
  /** Rows hidden, header only. */
  collapsed: boolean
  /** The mission's title, or `null` when its mission is not open here. */
  titleFor: (missionId: string) => string | null
  /** The operator's reason when the mission's steward is paused, else `null`. */
  pausedFor: (missionId: string) => string | null
  /** Say, under the rows, that a steward belongs to its mission — drawn when the list has no user worker. */
  showHint?: boolean
}>()

const emit = defineEmits<{ toggle: [] }>()

const { t } = useI18n()

function stateOf(s: StewardSummary): StewardStateWord | null {
  return stewardStateOf(s, props.pausedFor(s.missionId) !== null)
}

const summaryParts = computed(() => stewardsSummaryParts(props.stewards.map(stateOf)))
function partLabel(kind: 'total' | 'running' | 'awaiting', n: number): string {
  if (kind === 'running') return t('scheduler.stewards.summaryRunning', { n })
  if (kind === 'awaiting') return t('scheduler.stewards.summaryAwaiting', { n })
  return String(n)
}

const anyAwaiting = computed(() => props.stewards.some((s) => stateOf(s) === 'awaitingClose'))
</script>

<template>
  <section
    v-if="stewards.length > 0"
    class="flex-none border-t border-border py-2 pl-3 pr-2.5"
    :aria-label="t('scheduler.stewards.aria')"
    data-test="scheduler-stewards"
  >
    <button
      type="button"
      class="group flex w-full items-center gap-[5px] p-0 text-left"
      :aria-expanded="!collapsed"
      data-test="scheduler-stewards-toggle"
      @click="emit('toggle')"
    >
      <ChevronDown
        :size="11"
        :stroke-width="1.8"
        class="shrink-0 text-text-4 transition-transform duration-[var(--dur-fast)] ease-[var(--ease)]"
        :class="collapsed ? '-rotate-90' : ''"
        aria-hidden="true"
      />
      <h4
        class="m-0 text-[10px] font-semibold uppercase tracking-[0.04em] text-text-3 group-hover:text-text-2"
      >
        {{ t('scheduler.stewards.title') }}
      </h4>
      <span
        class="ml-auto min-w-0 truncate text-[10px] text-text-4"
        data-test="scheduler-stewards-summary"
        ><template v-for="(part, i) in summaryParts" :key="part.kind"
          ><template v-if="i > 0"> · </template
          ><span
            :class="
              part.kind === 'running'
                ? 'text-accent'
                : part.kind === 'awaiting'
                  ? 'text-text-2'
                  : ''
            "
            :data-part="part.kind"
            >{{ partLabel(part.kind, part.n) }}</span
          ></template
        ></span
      >
    </button>

    <div
      v-if="!collapsed"
      class="scrollable -mr-1.5 overflow-y-auto pr-1.5"
      style="max-height: var(--sched-stewards-max-h); margin-top: 6px"
      data-test="scheduler-stewards-rows"
    >
      <ul class="m-0 flex list-none flex-col p-0" style="gap: 7px">
        <li
          v-for="s in stewards"
          :key="s.workerId"
          class="flex min-w-0 flex-col"
          style="gap: 2px"
          data-test="scheduler-steward-row"
          :data-mission="s.missionId"
          :data-paused="pausedFor(s.missionId) !== null ? 'true' : 'false'"
        >
          <div class="flex min-w-0 items-center" style="gap: 6px">
            <Bot :size="11" :stroke-width="1.7" class="shrink-0 text-text-3" aria-hidden="true" />
            <span
              class="min-w-0 flex-1 truncate text-text-2"
              style="font-size: 12px"
              :title="titleFor(s.missionId) ?? s.missionId"
              data-test="scheduler-steward-mission"
              >{{
                titleFor(s.missionId) ?? t('scheduler.stewards.unknownMission', { id: s.missionId })
              }}</span
            >
            <span
              v-if="stateOf(s) === 'paused'"
              class="shrink-0 text-warning"
              style="font-size: 11px"
              data-test="scheduler-steward-state"
              >{{ t('scheduler.stewards.paused') }}</span
            >
            <span
              v-else-if="stateOf(s) === 'running'"
              class="shrink-0 text-accent"
              style="font-size: 11px"
              data-test="scheduler-steward-state"
              >{{ t('scheduler.stewards.running') }}</span
            >
            <span
              v-else-if="stateOf(s) === 'awaitingClose'"
              class="shrink-0 text-text-3"
              style="font-size: 11px"
              data-test="scheduler-steward-state"
              >{{ t('scheduler.stewards.awaitingClose') }}</span
            >
          </div>
          <div
            class="truncate"
            :class="pausedFor(s.missionId) !== null ? 'text-warning' : 'text-text-4'"
            style="font-size: 11px; padding-left: 17px"
            data-test="scheduler-steward-last"
          >
            <template v-if="pausedFor(s.missionId) !== null">{{
              t('scheduler.stewards.pausedReason', { reason: pausedFor(s.missionId) })
            }}</template>
            <template v-else-if="s.lastWakeAt === null">{{
              t('scheduler.stewards.noTick')
            }}</template>
            <template v-else>
              {{
                t('scheduler.stewards.lastWake', {
                  age: formatDuration(Math.max(0, nowMs - s.lastWakeAt))
                })
              }}<template v-if="s.lastAction"> · {{ s.lastAction }}</template>
            </template>
          </div>
        </li>
      </ul>
      <p
        v-if="showHint"
        class="m-0 text-text-4"
        style="margin-top: 8px; font-size: 10.5px; line-height: 1.5"
        data-test="scheduler-stewards-hint"
      >
        {{ t('scheduler.stewards.hint') }}
      </p>
      <p
        v-if="anyAwaiting"
        class="m-0 text-text-4"
        style="margin-top: 8px; font-size: 10.5px; line-height: 1.5"
        data-test="scheduler-stewards-close-hint"
      >
        {{ t('scheduler.stewards.closeHint') }}
      </p>
    </div>
  </section>
</template>
