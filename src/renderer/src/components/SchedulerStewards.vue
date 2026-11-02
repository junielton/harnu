<script setup lang="ts">
/**
 * Stewards section of the Scheduler takeover (T609, campaign ch.5b — design.md §6 "Scheduler" →
 * Stewards section; campaign spec §3.4). A mission's steward is a SYSTEM worker, so it is not a row of
 * the folder groups: it is listed here, under its own heading, and is read-only — no enable switch, no
 * pin, no Run now, no delete, no prompt edit, and no detail pane. Its lifecycle is the mission's, and
 * pausing it is a door of the mission popover, not a switch of this list.
 *
 * Presentational: the parent hands it the summaries (`lib/steward-view.ts`) and resolves each mission's
 * title and pause from the mission store.
 */
import { useI18n } from 'vue-i18n'
import { Bot } from 'lucide-vue-next'
import { formatDuration } from '../lib/mission-view'
import type { StewardSummary } from '../lib/steward-view'

defineProps<{
  stewards: StewardSummary[]
  nowMs: number
  /** The mission's title, or `null` when its mission is not open here. */
  titleFor: (missionId: string) => string | null
  /** The operator's reason when the mission's steward is paused, else `null`. */
  pausedFor: (missionId: string) => string | null
  /** Say, under the rows, that a steward belongs to its mission — drawn when the list has no user worker. */
  showHint?: boolean
}>()

const { t } = useI18n()
</script>

<template>
  <section
    v-if="stewards.length > 0"
    class="flex-none border-t border-border"
    style="padding: 8px 10px 8px 12px"
    :aria-label="t('scheduler.stewards.aria')"
    data-test="scheduler-stewards"
  >
    <div class="flex items-baseline" style="margin-bottom: 4px">
      <span
        class="uppercase text-text-4"
        style="font-size: 10.5px; font-weight: 500; letter-spacing: 0.07em"
        >{{ t('scheduler.stewards.title') }}</span
      >
      <span class="ml-auto tabular-nums text-text-4" style="font-size: 10.5px">{{
        stewards.length
      }}</span>
    </div>
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
            v-if="pausedFor(s.missionId) !== null"
            class="shrink-0 text-warning"
            style="font-size: 11px"
            data-test="scheduler-steward-state"
            >{{ t('scheduler.stewards.paused') }}</span
          >
          <span
            v-else-if="s.running"
            class="shrink-0 text-accent"
            style="font-size: 11px"
            data-test="scheduler-steward-state"
            >{{ t('scheduler.stewards.running') }}</span
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
  </section>
</template>
