<script setup lang="ts">
import { computed } from 'vue'
import { useNow } from '@vueuse/core'
import { useI18n } from 'vue-i18n'
import { useUsageStore } from '../stores/usage'
import UsageMeter from './UsageMeter.vue'
import UsageMeterSkeleton from './UsageMeterSkeleton.vue'
import UsageBudgetRow from './UsageBudgetRow.vue'
import { useDailyBudgetStore } from '../stores/daily-budget'
import {
  resetDisplay,
  formatCostUsd,
  humanizeDuration,
  type MergedRateWindow
} from './usage-format'
import type { UsageBucket } from '../../../preload'

/**
 * Usage / telemetry panel (design.md §6 — Plan usage / Telemetry cockpit). Pinned
 * above the sidebar footer. Shows EVERY window we know: the 5h / 7d rate-limit
 * meters (each fed by the freshest of the statusLine cockpit and the `/usage`
 * poll — `mergeRateWindows`), plus the per-model weekly buckets that only
 * `/usage` reports, an "updated X ago" freshness line, and the fleet-cost line.
 * Three states (§6): `ready` → meters; `loading` → skeleton; `unavailable` →
 * hidden.
 */
const usage = useUsageStore()
const dailyBudget = useDailyBudgetStore()

const SKELETON_WIDTHS = [86, 104, 92]
const { t } = useI18n()

// Tick once a minute so reset countdowns stay live-ish between pushes.
const now = useNow({ interval: 60_000 })

interface MeterRow {
  key: string
  label: string
  usedPercent: number
  resetLabel: string
  resetTitle: string
}

function bucketLabel(b: UsageBucket): string {
  if (b.key === 'session') return t('usage.session')
  if (b.key === 'week_all') return t('usage.weekAll')
  return t('usage.perModel', { model: b.key })
}

function bucketRow(b: UsageBucket): MeterRow {
  const d = resetDisplay(b.resetsAtMs, b.resetsAtText, now.value.getTime())
  let resetLabel = ''
  let resetTitle = ''
  if (d.kind === 'relative') {
    resetLabel = t('usage.resetsIn', { time: d.time })
    resetTitle = d.title
  } else if (d.kind === 'absolute') {
    resetLabel = t('usage.resetsAt', { when: d.text })
  }
  return { key: b.key, label: bucketLabel(b), usedPercent: b.usedPercent, resetLabel, resetTitle }
}

function windowRow(key: string, label: string, w: MergedRateWindow): MeterRow {
  const d = resetDisplay(w.resetsAtMs, w.resetsAtText, now.value.getTime())
  let resetLabel = ''
  let resetTitle = ''
  if (d.kind === 'relative') {
    resetLabel = t('usage.resetsIn', { time: d.time })
    resetTitle = d.title
  } else if (d.kind === 'absolute') {
    resetLabel = t('usage.resetsAt', { when: d.text })
  }
  return { key, label, usedPercent: w.usedPercent, resetLabel, resetTitle }
}

// All windows, no either/or: the merged 5h/7d meters (freshest source each),
// then the per-model weekly buckets only `/usage` knows about.
const rows = computed<MeterRow[]>(() => {
  const rl = usage.rateLimits
  if (!rl) return usage.buckets.map(bucketRow)
  const out: MeterRow[] = []
  if (rl.fiveHour) out.push(windowRow('5h', t('usage.rateLimitFiveHour'), rl.fiveHour))
  if (rl.sevenDay) out.push(windowRow('7d', t('usage.rateLimitSevenDay'), rl.sevenDay))
  for (const b of usage.buckets) {
    if (b.key === 'session' || b.key === 'week_all') continue // already merged into 5h/7d
    out.push(bucketRow(b))
  }
  return out
})

// Freshness line — how old the displayed rate-limit data is (oldest shown datum).
const updatedLine = computed<string>(() => {
  const at = usage.rateLimitsUpdatedAtMs
  if (at == null) return ''
  return t('usage.updatedAgo', { time: humanizeDuration(now.value.getTime() - at) })
})

const fleetLine = computed<string>(() => {
  const f = usage.fleetSummary
  return f
    ? t('usage.fleetCost', { cost: formatCostUsd(f.totalCostUsd), tabs: f.sessionCount })
    : ''
})
</script>

<template>
  <div
    v-if="usage.status !== 'unavailable'"
    class="shrink-0 border-t border-border"
    style="padding: 8px 12px"
    :aria-busy="usage.loading"
  >
    <div
      class="text-text-4"
      style="
        font-size: 10.5px;
        font-weight: 500;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        margin-bottom: 7px;
      "
    >
      {{ t('usage.title') }}
    </div>
    <div class="flex flex-col" style="gap: 8px">
      <template v-if="usage.loading">
        <UsageMeterSkeleton
          v-for="(w, i) in SKELETON_WIDTHS"
          :key="'skeleton-' + i"
          :label-width="w"
        />
      </template>
      <template v-else>
        <UsageMeter
          v-for="row in rows"
          :key="row.key"
          :label="row.label"
          :used-percent="row.usedPercent"
          :reset-label="row.resetLabel"
          :reset-title="row.resetTitle"
        />
      </template>
    </div>
    <div
      v-if="!usage.loading && dailyBudget.budget.state !== 'unavailable'"
      class="border-t border-border"
      style="margin-top: 8px; padding-top: 8px"
    >
      <UsageBudgetRow :budget="dailyBudget.budget" />
    </div>
    <div
      v-if="updatedLine || fleetLine"
      class="flex flex-col text-text-4 tabular-nums"
      style="margin-top: 7px; gap: 2px; font-size: 11px"
    >
      <span v-if="updatedLine">{{ updatedLine }}</span>
      <span v-if="fleetLine">{{ fleetLine }}</span>
    </div>
  </div>
</template>
