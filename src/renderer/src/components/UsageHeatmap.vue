<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { UsageHeatmap } from '../../../preload'

/**
 * Weekday × hour heatmap for the Usage-history pane (design §6 — T47 P4): "when
 * do I actually use it?". Reads the pre-aggregated grid from the summary (mean
 * 5h% per local weekday × 2h bucket); cell intensity is `avgPct / maxAvgPct`
 * rendered as accent opacity via `color-mix` (token-backed — no raw colors).
 * Rows are Monday-first; a `<title>` per cell gives the exact reading.
 */
const props = defineProps<{ heatmap: UsageHeatmap }>()
const { t } = useI18n()

// Monday-first display order over JS weekdays (0 = Sunday).
const ROWS = [1, 2, 3, 4, 5, 6, 0]
const dowKey = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

const buckets = computed(() => props.heatmap.buckets)
const span = computed(() => 24 / buckets.value)
const max = computed(() => props.heatmap.maxAvgPct ?? 0)

function cellAt(dow: number, bucket: number): { avgPct: number | null; n: number } {
  return props.heatmap.cells[dow * buckets.value + bucket] ?? { avgPct: null, n: 0 }
}
function cellStyle(dow: number, bucket: number): Record<string, string> {
  const c = cellAt(dow, bucket)
  if (c.avgPct == null || max.value <= 0) return { background: 'var(--color-surface-2)' }
  // Opaque ramp surface-2 → accent (mixing into transparent can composite oddly);
  // solid steps also read cleaner, matching the mockup.
  const pct = Math.round(10 + (c.avgPct / max.value) * 90)
  return { background: `color-mix(in srgb, var(--color-accent) ${pct}%, var(--color-surface-2))` }
}
function cellTip(dow: number, bucket: number): string {
  const c = cellAt(dow, bucket)
  const h0 = Math.round(bucket * span.value)
  const h1 = Math.round((bucket + 1) * span.value)
  const day = t('usageHistory.dow.' + dowKey[dow])
  if (c.avgPct == null) return `${day} ${h0}h–${h1}h · ${t('usageHistory.noData')}`
  return `${day} ${h0}h–${h1}h · ${Math.round(c.avgPct)}%`
}

// Hour ticks under the grid: 0 / 6 / 12 / 18 / 24.
const hourTicks = computed(() => [0, 6, 12, 18, 24])
</script>

<template>
  <div class="hm">
    <div class="hm-grid" :style="{ gridTemplateColumns: `30px repeat(${buckets}, 1fr)` }">
      <template v-for="dow in ROWS" :key="dow">
        <span class="hm-dow text-text-4">{{ t('usageHistory.dow.' + dowKey[dow]) }}</span>
        <div
          v-for="b in buckets"
          :key="dow + '-' + b"
          class="hm-cell"
          :style="cellStyle(dow, b - 1)"
          :title="cellTip(dow, b - 1)"
        ></div>
      </template>
    </div>
    <div class="hm-hours" :style="{ gridTemplateColumns: `30px 1fr` }">
      <span></span>
      <div class="hm-hticks text-text-4 tabular-nums">
        <span v-for="h in hourTicks" :key="h">{{ h }}h</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.hm {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.hm-grid {
  display: grid;
  gap: 2px;
}
.hm-dow {
  font-size: 9.5px;
  display: flex;
  align-items: center;
}
.hm-cell {
  height: 15px;
  border-radius: 3px;
}
.hm-hours {
  display: grid;
}
.hm-hticks {
  display: flex;
  justify-content: space-between;
  font-size: 9px;
}
</style>
