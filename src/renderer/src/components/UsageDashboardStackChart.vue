<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import SegmentedControl from './ui/SegmentedControl.vue'
import {
  buildStackedRows,
  fmtMoney0,
  fmtInt,
  fmtResetTime,
  pctThresholdColor,
  type ChartMetric,
  type StackedBarRow,
  type StackSegment
} from './usage-dashboard-format'
import { formatCostUsd } from './usage-format'
import type { UsageBiDay } from '../../../preload'

/**
 * Stacked-by-model trajectory chart — design.md "Usage Dashboard (takeover)",
 * stacked-by-model chart. A SIBLING of `UsageChart.vue` (that one is
 * single-series; this one stacks per-model segments), same "SVG inline, no
 * chart lib" philosophy: dashed gridlines, native `<title>` per segment, a
 * value label on each bar's total, rotated day labels past a density
 * threshold. Pure geometry lives in `usage-dashboard-format.ts`; this is the
 * thin template + SVG emission.
 */
const props = defineProps<{
  days: readonly UsageBiDay[]
  metric: ChartMetric
  visibleModels: ReadonlySet<string>
  todayDay: string
  highlightedDay: string | null
}>()
const emit = defineEmits<{ 'update:metric': [ChartMetric] }>()
const { t } = useI18n()

const metricModel = computed<ChartMetric>({
  get: () => props.metric,
  set: (v) => emit('update:metric', v)
})

const METRIC_OPTIONS = computed(() => [
  { value: 'cost', label: t('usageDashboard.chart.metricCost') },
  { value: 'rate', label: t('usageDashboard.chart.metricRate') },
  { value: 'sessions', label: t('usageDashboard.chart.metricSessions') }
])

const rows = computed<StackedBarRow[]>(() =>
  buildStackedRows(props.days, props.metric, props.visibleModels, props.todayDay)
)

const chartTitle = computed(() => {
  if (props.metric === 'rate') return t('usageDashboard.chart.rateLimit')
  if (props.metric === 'sessions') return t('usageDashboard.chart.sessionsByModel')
  return t('usageDashboard.chart.costByModel')
})
const chartFoot = computed(() => {
  if (props.metric === 'rate') return t('usageDashboard.chart.footRate')
  if (props.metric === 'sessions') return t('usageDashboard.chart.footSessions')
  return t('usageDashboard.chart.footReal')
})

const maxVal = computed(() => {
  if (props.metric === 'rate') return 100
  return Math.max(1, ...rows.value.map((r) => r.total))
})
const rotate = computed(() => rows.value.length > 14)

const CHART_H = 190
/** A stacked segment shorter than this can't hold its `%` label inside — the
 *  label renders just above the segment instead. */
const LABEL_MIN_INSIDE_PX = 18

function segH(row: StackedBarRow, seg: { value: number }): number {
  if (row.total <= 0) return 0
  const barH = maxVal.value > 0 ? (row.total / maxVal.value) * CHART_H : 0
  const h = (seg.value / row.total) * barH
  return Math.max(h, seg.value > 0 ? 2 : 0)
}
function barH(row: StackedBarRow): number {
  return Math.max(maxVal.value > 0 ? (row.total / maxVal.value) * CHART_H : 0, 2)
}
/** 0-100% pixel height for one weekly-reset segment (same scale as every other bar). */
function weeklyBarPx(pct: number): number {
  return Math.max((pct / 100) * CHART_H, pct > 0 ? 2 : 0)
}
/** Stacked height of a weekly-reset row (pre + post), for row-height accounting. */
function weeklyStackPx(row: StackedBarRow): number {
  if (!row.weeklyReset) return 0
  return weeklyBarPx(row.weeklyReset.prePct) + weeklyBarPx(row.weeklyReset.postPct)
}
/** Whether a segment of `pct` is tall enough to hold its label inside. */
function labelFitsInside(pct: number): boolean {
  return weeklyBarPx(pct) >= LABEL_MIN_INSIDE_PX
}

/**
 * Tallest bar in px, ≥ CHART_H. A weekly-reset row stacks two windows
 * (pre + post) so its column can pass the 100% line even though each segment
 * alone is on the normal 0-100% scale — every OTHER day keeps the usual scale
 * (rescaling the whole axis to fit one outlier would squash every other bar's
 * height for no reason). The rows track's own height grows to fit the tallest
 * bar instead, so nothing gets clipped by the wrapper's `overflow-y-hidden`.
 */
const tallestBarPx = computed(() =>
  Math.max(CHART_H, ...rows.value.map((r) => (r.weeklyReset ? weeklyStackPx(r) : barH(r))))
)

function segTitle(row: StackedBarRow, seg: StackSegment): string {
  return `${row.day} · ${seg.model}: ${props.metric === 'cost' ? formatCostUsd(seg.value) : fmtInt(seg.value)}`
}
/** Per-bar tooltip for a weekly-reset row — only that bar's own value, plus the shared reset time. */
function weeklyBarTitle(row: StackedBarRow, which: 'pre' | 'post'): string {
  const reset = row.weeklyReset
  if (!reset) return ''
  const pct = which === 'pre' ? reset.prePct : reset.postPct
  return t(
    which === 'pre'
      ? 'usageDashboard.rateReset.preTooltip'
      : 'usageDashboard.rateReset.postTooltip',
    {
      label: t(which === 'pre' ? 'usageDashboard.rateReset.pre' : 'usageDashboard.rateReset.post'),
      time: fmtResetTime(reset.atMs),
      pct: Math.round(pct)
    }
  )
}
function totalLabel(row: StackedBarRow): string {
  if (row.isRateMetric) return Math.round(row.total) + '%'
  if (props.metric === 'cost') return rotate.value ? fmtMoney0(row.total) : formatCostUsd(row.total)
  return fmtInt(row.total)
}
function gridLabel(fraction: number): string {
  const v = fraction * maxVal.value
  if (props.metric === 'rate') return Math.round(v) + '%'
  if (props.metric === 'cost') return fmtMoney0(v)
  return fmtInt(v)
}
</script>

<template>
  <div>
    <div class="mb-2.5 flex flex-wrap items-center justify-between gap-2.5">
      <h2 class="text-[11.5px] font-bold uppercase tracking-wide text-text-2">{{ chartTitle }}</h2>
      <SegmentedControl
        v-model="metricModel"
        size="sm"
        :options="METRIC_OPTIONS"
        :aria-label="t('usageDashboard.chart.costByModel')"
      />
    </div>

    <!-- overflow-y-hidden is deliberate, not decorative: setting only
         overflow-x makes the browser compute overflow-y as `auto` too (CSS
         overflow spec quirk), which surfaced as a stray NATIVE vertical
         scrollbar on this card in live use (T47 P6 S2 fix round) — the
         chart's height is fixed (CHART_H), it never needs to scroll
         vertically. `scrollable` applies the themed thin/hover thumb instead
         of the native white one for the horizontal scroll that DOES apply. -->
    <div class="scrollable overflow-x-auto overflow-y-hidden pb-1">
      <div
        class="relative flex items-end gap-2.5 pt-5"
        :style="{ height: tallestBarPx + 40 + 'px', minWidth: '100%' }"
      >
        <div
          v-for="f in [0.25, 0.5, 0.75, 1]"
          :key="f"
          class="pointer-events-none absolute left-0 right-0 border-t border-dashed border-border-2"
          :style="{ bottom: f * CHART_H + 20 + 'px' }"
        >
          <span
            class="absolute right-0.5 bg-surface pl-1 text-[10px] text-text-4"
            style="top: -14px"
          >
            {{ gridLabel(f) }}
          </span>
        </div>

        <div
          v-for="row in rows"
          :key="row.day"
          class="relative flex h-full min-w-[34px] flex-1 flex-col items-center justify-end"
          :class="{ 'ring-2 ring-accent rounded-sm': row.day === highlightedDay }"
        >
          <!-- Weekly-reset day: pre-reset (closed window) and post-reset (new
               window) stacked in one column — pre at the base, post on top,
               each threshold-colored by its OWN value with its own `%` label
               inside the segment (above it when too short). No summed total:
               the two are different quota windows, so the column is allowed to
               pass the 100% line. -->
          <div
            v-if="row.weeklyReset"
            class="flex w-3/5 min-w-[20px] max-w-[42px] flex-col overflow-visible rounded-t shadow-[inset_0_0_0_1px_var(--color-border)]"
          >
            <div
              class="relative w-full rounded-t border-b-2 border-surface"
              :style="{
                height: weeklyBarPx(row.weeklyReset.postPct) + 'px',
                background: pctThresholdColor(row.weeklyReset.postPct)
              }"
              :title="weeklyBarTitle(row, 'post')"
            >
              <span
                class="absolute left-0 right-0 text-center whitespace-nowrap tabular-nums text-[10px] font-bold leading-none"
                :class="
                  labelFitsInside(row.weeklyReset.postPct)
                    ? 'chart-fill-label top-[3px]'
                    : 'text-text-2 bottom-full mb-0.5'
                "
              >
                {{ Math.round(row.weeklyReset.postPct) }}%
              </span>
            </div>
            <div
              class="relative w-full"
              :style="{
                height: weeklyBarPx(row.weeklyReset.prePct) + 'px',
                background: pctThresholdColor(row.weeklyReset.prePct)
              }"
              :title="weeklyBarTitle(row, 'pre')"
            >
              <span
                class="absolute left-0 right-0 text-center whitespace-nowrap tabular-nums text-[10px] font-bold leading-none"
                :class="
                  labelFitsInside(row.weeklyReset.prePct)
                    ? 'chart-fill-label top-[3px]'
                    : 'text-text-2 bottom-full mb-0.5'
                "
              >
                {{ Math.round(row.weeklyReset.prePct) }}%
              </span>
            </div>
          </div>

          <template v-else>
            <div
              class="mb-1 whitespace-nowrap tabular-nums text-[11px] font-bold text-text-2"
              :class="rotate ? 'origin-bottom -rotate-90 mb-4' : ''"
            >
              {{ totalLabel(row) }}
            </div>
            <div
              class="flex w-3/5 min-w-[20px] max-w-[42px] flex-col-reverse overflow-hidden rounded-t shadow-[inset_0_0_0_1px_var(--color-border)]"
              :style="{ height: barH(row) + 'px' }"
            >
              <div
                v-for="seg in row.segments"
                :key="seg.model"
                class="w-full border-b-2 border-surface last:border-b-0"
                :style="{ height: segH(row, seg) + 'px', background: seg.color }"
                :title="segTitle(row, seg)"
              />
            </div>
          </template>

          <div
            class="mt-2 whitespace-nowrap text-[10.5px] text-text-3"
            :class="[
              row.isToday ? 'font-bold text-accent' : '',
              rotate ? 'origin-top -rotate-[55deg] translate-x-[-6px] mt-3.5' : ''
            ]"
          >
            {{ row.day.slice(5) }}
          </div>
        </div>
      </div>
    </div>

    <div class="mt-1.5 text-[11px] text-text-4">{{ chartFoot }}</div>
  </div>
</template>
