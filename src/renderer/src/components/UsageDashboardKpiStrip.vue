<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { formatCostUsd } from './usage-format'
import {
  fmtInt,
  deltaBadge,
  deltaToneClass,
  sparklinePoints,
  type DeltaBadge
} from './usage-dashboard-format'
import type { UsageBiSnapshot } from '../../../preload'

/**
 * KPI strip — design.md "Usage Dashboard (takeover)" § Tiras de KPI. Five
 * glance cards above the fold: 5h window, 7d window, cost today (real, with
 * the notional live figure as a secondary read), sessions today (worked, with
 * peak-live as secondary), and a circular-gauge projection at reset. Thin
 * template over the snapshot — all math (deltas, sparkline points) is pure
 * (`usage-dashboard-format.ts`).
 */
const props = defineProps<{ snapshot: UsageBiSnapshot }>()
const { t } = useI18n()

function last7<T>(days: readonly T[], n = 7): T[] {
  return days.slice(-n)
}

const fiveHourSpark = computed(() => {
  const vals = last7(props.snapshot.days)
    .map((d) => d.peak5hPct)
    .filter((v): v is number => v !== null)
  return vals.length ? sparklinePoints(vals) : null
})
const sevenDaySpark = computed(() => {
  const vals = last7(props.snapshot.days)
    .map((d) => d.peak7dPct)
    .filter((v): v is number => v !== null)
  return vals.length ? sparklinePoints(vals) : null
})
const costSpark = computed(() => {
  const vals = last7(props.snapshot.days).map((d) => d.costUsd)
  return vals.length ? sparklinePoints(vals) : null
})
const sessionsSpark = computed(() => {
  const vals = last7(props.snapshot.days).map((d) => d.sessionsWorked)
  return vals.length ? sparklinePoints(vals) : null
})

function twoLatest<T>(vals: (T | null)[]): [T | null, T | null] {
  const clean = vals.filter((v): v is T => v !== null)
  return [clean[clean.length - 1] ?? null, clean[clean.length - 2] ?? null]
}

const fiveHourDelta = computed<DeltaBadge | null>(() => {
  const [curr, prev] = twoLatest(props.snapshot.days.map((d) => d.peak5hPct))
  return curr === null ? null : deltaBadge(curr, prev, true)
})
const sevenDayDelta = computed<DeltaBadge | null>(() => {
  const [curr, prev] = twoLatest(props.snapshot.days.map((d) => d.peak7dPct))
  return curr === null ? null : deltaBadge(curr, prev, true)
})
const costDelta = computed<DeltaBadge | null>(() => {
  const days = props.snapshot.days
  if (days.length < 1) return null
  const curr = days[days.length - 1].costUsd
  const prev = days.length > 1 ? days[days.length - 2].costUsd : null
  return deltaBadge(curr, prev, true)
})
const sessionsDelta = computed<DeltaBadge | null>(() => {
  const days = props.snapshot.days
  if (days.length < 1) return null
  const curr = days[days.length - 1].sessionsWorked
  const prev = days.length > 1 ? days[days.length - 2].sessionsWorked : null
  return deltaBadge(curr, prev, false)
})

const fiveHourNow = computed(() => props.snapshot.now?.fiveHour.usedPct ?? null)
const sevenDayNow = computed(() => {
  const days = props.snapshot.days
  return days.length ? days[days.length - 1].peak7dPct : null
})
const costToday = computed(() => props.snapshot.now?.realCostToday ?? null)
const notionalToday = computed(() => props.snapshot.now?.notionalCostToday ?? null)
const sessionsToday = computed(() => {
  const days = props.snapshot.days
  return days.length ? days[days.length - 1].sessionsWorked : null
})
const peakLiveToday = computed(() => props.snapshot.now?.peakLiveToday ?? null)
const projectedPct = computed(() => props.snapshot.now?.fiveHour.projectedAtResetPct ?? null)
const gaugeDeg = computed(() => `${((projectedPct.value ?? 0) / 100) * 360}deg`)
</script>

<template>
  <div class="grid gap-2.5" style="grid-template-columns: repeat(auto-fit, minmax(180px, 1fr))">
    <!-- 5h window -->
    <div class="anim-fade-in flex flex-col gap-1.5 rounded-lg border border-border bg-surface p-3">
      <div class="text-[11px] uppercase tracking-wide text-text-3">
        {{ t('usageDashboard.kpi.fiveHour') }}
      </div>
      <div class="flex items-baseline gap-2">
        <span class="tabular-nums text-[25px] font-bold leading-none">
          {{ fiveHourNow != null ? Math.round(fiveHourNow) + '%' : '—' }}
        </span>
        <span
          v-if="fiveHourDelta && fiveHourDelta.tone !== 'flat'"
          class="rounded px-1 py-0.5 text-[11px] font-bold"
          :class="deltaToneClass(fiveHourDelta.tone)"
        >
          {{ fiveHourDelta.arrow }} {{ Math.round(fiveHourDelta.pct) }}%
        </span>
      </div>
      <svg
        v-if="fiveHourSpark"
        viewBox="0 0 100 26"
        preserveAspectRatio="none"
        class="h-[26px] w-full"
      >
        <polyline
          :points="fiveHourSpark.points"
          fill="none"
          stroke="var(--color-accent)"
          stroke-width="1.6"
          stroke-linejoin="round"
          stroke-linecap="round"
        />
        <circle
          :cx="fiveHourSpark.lastX"
          :cy="fiveHourSpark.lastY"
          r="2.2"
          fill="var(--color-accent)"
        />
      </svg>
      <div class="text-[11px] text-text-3">{{ t('usageDashboard.kpi.fiveHourFoot') }}</div>
    </div>

    <!-- 7d window -->
    <div class="anim-fade-in flex flex-col gap-1.5 rounded-lg border border-border bg-surface p-3">
      <div class="text-[11px] uppercase tracking-wide text-text-3">
        {{ t('usageDashboard.kpi.sevenDay') }}
      </div>
      <div class="flex items-baseline gap-2">
        <span class="tabular-nums text-[25px] font-bold leading-none">
          {{ sevenDayNow != null ? Math.round(sevenDayNow) + '%' : '—' }}
        </span>
        <span
          v-if="sevenDayDelta && sevenDayDelta.tone !== 'flat'"
          class="rounded px-1 py-0.5 text-[11px] font-bold"
          :class="deltaToneClass(sevenDayDelta.tone)"
        >
          {{ sevenDayDelta.arrow }} {{ Math.round(sevenDayDelta.pct) }}%
        </span>
      </div>
      <svg
        v-if="sevenDaySpark"
        viewBox="0 0 100 26"
        preserveAspectRatio="none"
        class="h-[26px] w-full"
      >
        <polyline
          :points="sevenDaySpark.points"
          fill="none"
          stroke="var(--color-accent)"
          stroke-width="1.6"
          stroke-linejoin="round"
          stroke-linecap="round"
        />
        <circle
          :cx="sevenDaySpark.lastX"
          :cy="sevenDaySpark.lastY"
          r="2.2"
          fill="var(--color-accent)"
        />
      </svg>
      <div class="text-[11px] text-text-3">{{ t('usageDashboard.kpi.sevenDayFoot') }}</div>
    </div>

    <!-- Cost today -->
    <div class="anim-fade-in flex flex-col gap-1.5 rounded-lg border border-border bg-surface p-3">
      <div class="text-[11px] uppercase tracking-wide text-text-3">
        {{ t('usageDashboard.kpi.costToday') }}
      </div>
      <div class="flex items-baseline gap-2">
        <span class="tabular-nums text-[25px] font-bold leading-none">
          {{ costToday != null ? formatCostUsd(costToday) : '—' }}
        </span>
        <span
          v-if="costDelta && costDelta.tone !== 'flat'"
          class="rounded px-1 py-0.5 text-[11px] font-bold"
          :class="deltaToneClass(costDelta.tone)"
        >
          {{ costDelta.arrow }} {{ Math.round(costDelta.pct) }}%
        </span>
      </div>
      <svg v-if="costSpark" viewBox="0 0 100 26" preserveAspectRatio="none" class="h-[26px] w-full">
        <polyline
          :points="costSpark.points"
          fill="none"
          stroke="#3987e5"
          stroke-width="1.6"
          stroke-linejoin="round"
          stroke-linecap="round"
        />
        <circle :cx="costSpark.lastX" :cy="costSpark.lastY" r="2.2" fill="#3987e5" />
      </svg>
      <div class="text-[11px] text-text-3">
        {{ t('usageDashboard.kpi.costTodayFoot', { cost: formatCostUsd(notionalToday) }) }}
      </div>
    </div>

    <!-- Sessions today -->
    <div class="anim-fade-in flex flex-col gap-1.5 rounded-lg border border-border bg-surface p-3">
      <div class="text-[11px] uppercase tracking-wide text-text-3">
        {{ t('usageDashboard.kpi.sessionsToday') }}
      </div>
      <div class="flex items-baseline gap-2">
        <span class="tabular-nums text-[25px] font-bold leading-none">
          {{ sessionsToday != null ? fmtInt(sessionsToday) : '—' }}
        </span>
        <span
          v-if="sessionsDelta && sessionsDelta.tone !== 'flat'"
          class="rounded px-1 py-0.5 text-[11px] font-bold"
          :class="deltaToneClass(sessionsDelta.tone)"
        >
          {{ sessionsDelta.arrow }} {{ Math.round(sessionsDelta.pct) }}%
        </span>
      </div>
      <svg
        v-if="sessionsSpark"
        viewBox="0 0 100 26"
        preserveAspectRatio="none"
        class="h-[26px] w-full"
      >
        <polyline
          :points="sessionsSpark.points"
          fill="none"
          stroke="#199e70"
          stroke-width="1.6"
          stroke-linejoin="round"
          stroke-linecap="round"
        />
        <circle :cx="sessionsSpark.lastX" :cy="sessionsSpark.lastY" r="2.2" fill="#199e70" />
      </svg>
      <div class="text-[11px] text-text-3">
        {{
          t('usageDashboard.kpi.sessionsTodayFoot', {
            count: peakLiveToday != null ? fmtInt(peakLiveToday) : '—'
          })
        }}
      </div>
    </div>

    <!-- Projected at reset -->
    <div class="anim-fade-in flex flex-col gap-1.5 rounded-lg border border-border bg-surface p-3">
      <div class="text-[11px] uppercase tracking-wide text-text-3">
        {{ t('usageDashboard.kpi.projected') }}
      </div>
      <div v-if="projectedPct != null" class="flex items-center gap-2.5">
        <div
          class="relative flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-full"
          :style="{
            background: `conic-gradient(var(--color-accent) ${gaugeDeg}, var(--color-surface-2) 0)`
          }"
        >
          <div class="absolute rounded-full bg-surface" style="inset: 5px" />
          <span class="relative tabular-nums text-[11px] font-bold"
            >{{ Math.round(projectedPct) }}%</span
          >
        </div>
        <div class="tabular-nums text-[19px] font-bold leading-none">
          ~{{ Math.round(projectedPct) }}%
        </div>
      </div>
      <div v-else class="text-[25px] font-bold leading-none text-text-4">—</div>
      <div class="text-[11px] text-text-3">{{ t('usageDashboard.kpi.projectedFoot') }}</div>
    </div>
  </div>
</template>
