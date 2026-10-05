<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import SegmentedControl from './ui/SegmentedControl.vue'
import { formatCostUsd } from './usage-format'
import {
  buildCalendarCells,
  calendarMetricT,
  heatColor,
  fmtInt,
  type CalendarMetric,
  type CalendarCell
} from './usage-dashboard-format'
import type { UsageBiDay } from '../../../preload'

/**
 * Activity calendar — design.md "Usage Dashboard (takeover)", activity
 * calendar. Current-month grid, Monday-first, colored on a 3-stop
 * green→amber→red ramp by the selected metric's relative position within the
 * visible month. Clicking a populated cell selects it (highlights the
 * matching day in the stacked chart above, via `v-model:selected-day`) and
 * shows a one-line summary below the grid.
 */
const props = defineProps<{
  days: readonly UsageBiDay[]
  nowMs: number
  selectedDay: string | null
}>()
const emit = defineEmits<{ 'update:selectedDay': [string | null] }>()
const { t } = useI18n()

const WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

const metric = defineModel<CalendarMetric>('metric', { default: 'rate' })

const METRIC_OPTIONS = computed(() => [
  { value: 'rate', label: t('usageDashboard.calendar.metricPeak') },
  { value: 'cost', label: t('usageDashboard.calendar.metricCost') },
  { value: 'sessions', label: t('usageDashboard.calendar.metricSessions') }
])

const dataByDay = computed(() => new Map(props.days.map((d) => [d.day, d])))

function todayKey(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const cells = computed<CalendarCell[]>(() =>
  buildCalendarCells(props.nowMs, dataByDay.value, todayKey(props.nowMs))
)

const monthValues = computed(() => {
  const vs = props.days.map((d) =>
    metric.value === 'cost'
      ? d.costUsd
      : metric.value === 'sessions'
        ? d.sessionsWorked
        : (d.peak7dPct ?? 0)
  )
  return { min: vs.length ? Math.min(...vs) : 0, max: vs.length ? Math.max(...vs) : 1 }
})

function cellBg(cell: CalendarCell): string {
  if (!cell.data) return ''
  const t2 = calendarMetricT(cell.data, metric.value, monthValues.value.min, monthValues.value.max)
  return heatColor(t2)
}
function cellBadge(cell: CalendarCell): string {
  if (!cell.data) return ''
  if (metric.value === 'cost') return formatCostUsd(cell.data.costUsd)
  if (metric.value === 'sessions') return fmtInt(cell.data.sessionsWorked)
  return Math.round(cell.data.peak7dPct ?? 0) + '%'
}
function cellSub(cell: CalendarCell): string {
  if (!cell.data) return ''
  return metric.value === 'cost'
    ? Math.round(cell.data.peak7dPct ?? 0) + '%'
    : formatCostUsd(cell.data.costUsd)
}

function toggleDay(key: string): void {
  emit('update:selectedDay', props.selectedDay === key ? null : key)
}

const selectedSummary = computed(() => {
  if (!props.selectedDay) return null
  const d = dataByDay.value.get(props.selectedDay)
  if (!d) return null
  return t('usageDashboard.calendar.summary', {
    day: props.selectedDay,
    peak: Math.round(d.peak7dPct ?? 0),
    cost: formatCostUsd(d.costUsd),
    sessions: fmtInt(d.sessionsWorked),
    model: d.dominantModel ?? '—'
  })
})
</script>

<template>
  <div class="flex flex-1 flex-col">
    <div class="mb-2.5 flex flex-wrap items-center justify-between gap-2.5">
      <h2 class="text-[11.5px] font-bold uppercase tracking-wide text-text-2">
        {{ t('usageDashboard.calendar.title') }}
      </h2>
      <SegmentedControl v-model="metric" size="sm" :options="METRIC_OPTIONS" />
    </div>

    <div class="mb-1 grid grid-cols-7 gap-1">
      <span
        v-for="k in WEEKDAY_KEYS"
        :key="k"
        class="text-center text-[9.5px] uppercase tracking-wide text-text-4"
      >
        {{ t('usageHistory.dow.' + k) }}
      </span>
    </div>
    <div class="grid grid-cols-7 gap-1">
      <div
        v-for="(cell, i) in cells"
        :key="i"
        class="relative flex min-h-[40px] flex-col justify-center rounded-sm border px-1.5 py-0.5"
        :class="[
          cell.dayKey ? 'border-border bg-surface' : 'border-transparent',
          cell.data ? 'cursor-pointer transition-transform hover:-translate-y-0.5' : '',
          cell.isToday ? 'shadow-[inset_0_0_0_1px_var(--color-accent-line)]' : '',
          cell.dayKey === selectedDay ? '!border-accent shadow-[0_0_0_1px_var(--color-accent)]' : ''
        ]"
        :style="
          cell.data
            ? {
                background: `color-mix(in srgb, ${cellBg(cell)} 22%, var(--color-surface))`,
                borderColor: cellBg(cell)
              }
            : {}
        "
        @click="cell.dayKey && cell.data && toggleDay(cell.dayKey)"
      >
        <template v-if="cell.dayOfMonth !== null">
          <div class="flex items-center justify-between gap-1">
            <span
              class="text-[11px] font-bold"
              :class="cell.isToday ? 'text-accent' : 'text-text-2'"
            >
              {{ cell.dayOfMonth }}
            </span>
            <span
              v-if="cell.data"
              class="rounded-full px-1 text-[9px] font-bold text-bg"
              :style="{ background: cellBg(cell) }"
            >
              {{ cellBadge(cell) }}
            </span>
          </div>
          <div v-if="cell.data" class="tabular-nums text-[9px] text-text-4">
            {{ cellSub(cell) }}
          </div>
        </template>
      </div>
    </div>

    <div
      class="mt-2.5 rounded-sm border border-border-2 bg-surface-2 px-2.5 py-1.5 text-[11.5px]"
      :class="selectedSummary ? 'text-text-2' : 'text-text-4'"
    >
      {{ selectedSummary ?? t('usageDashboard.calendar.summaryPrompt') }}
    </div>
  </div>
</template>
