<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { formatCostUsd } from './usage-format'
import { barClass, fmtPct, type UsageSummaryTiles } from './usage-history-format'
import type { UsageHeatmap } from '../../../preload'

/**
 * Headline KPI tiles for the Usage-history pane (design §6 — T47 P3/P4). The
 * glance-answer a layperson/CEO reads in two seconds, above any chart: how often
 * you neared the cap, your peak 5h (+7d), your busiest time of week, and peak
 * cost/day — scoped to the last 30 days. Presentational: the pane computes the
 * numbers via the pure `summarizeUsage` + the heatmap's `heaviest`; this is a
 * thin template. Missing data shows `—`, never a fake 0.
 */
const props = defineProps<{ tiles: UsageSummaryTiles; heatmap: UsageHeatmap; days: number }>()
const { t } = useI18n()

const dowKey = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

const peakTone = computed(() => {
  const v = props.tiles.peakFivePct
  if (v == null) return 'text-text'
  return barClass(v).replace('bg-', 'text-')
})
const nearCapTone = computed(() => (props.tiles.nearCapCount > 0 ? 'text-accent' : 'text-text'))

const busiest = computed(() => {
  const h = props.heatmap.heaviest
  if (!h) return null
  const day = t('usageHistory.dow.' + dowKey[h.dow])
  return { label: `${day} ${Math.round(h.hourStart)}–${Math.round(h.hourEnd)}h`, avg: h.avgPct }
})
</script>

<template>
  <div class="tiles-grid">
    <!-- Times near the cap -->
    <div class="tile">
      <div class="tile-v tabular-nums" :class="nearCapTone">{{ tiles.nearCapCount }}×</div>
      <div class="tile-k">{{ $t('usageHistory.tiles.nearCap', { days }) }}</div>
      <div class="tile-s">{{ $t('usageHistory.tiles.nearCapSub') }}</div>
    </div>
    <!-- Peak 5h (+ 7d sub) -->
    <div class="tile">
      <div class="tile-v tabular-nums" :class="peakTone">{{ fmtPct(tiles.peakFivePct) }}</div>
      <div class="tile-k">{{ $t('usageHistory.tiles.peakFive', { days }) }}</div>
      <div class="tile-s">
        {{ $t('usageHistory.tiles.peakSevenSub', { pct: fmtPct(tiles.peakSevenPct) }) }}
      </div>
    </div>
    <!-- Busiest time of week -->
    <div class="tile">
      <div class="tile-v tile-v-sm text-text">{{ busiest ? busiest.label : '—' }}</div>
      <div class="tile-k">{{ $t('usageHistory.tiles.busiest') }}</div>
      <div class="tile-s">{{ $t('usageHistory.tiles.busiestSub') }}</div>
    </div>
    <!-- Peak cost / day -->
    <div class="tile">
      <div class="tile-v tabular-nums text-text">
        {{ tiles.peakCostUsd == null ? '—' : formatCostUsd(tiles.peakCostUsd) }}
      </div>
      <div class="tile-k">{{ $t('usageHistory.tiles.peakCost', { days }) }}</div>
      <div class="tile-s">{{ $t('usageHistory.tiles.peakCostSub') }}</div>
    </div>
  </div>
</template>

<style scoped>
.tiles-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
}
@media (max-width: 560px) {
  .tiles-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}
.tile {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  padding: 10px 12px;
}
.tile-v {
  font-size: 20px;
  font-weight: 650;
  letter-spacing: -0.02em;
  line-height: 1.1;
}
.tile-v-sm {
  font-size: 15px;
  letter-spacing: -0.01em;
}
.tile-k {
  font-size: 10.5px;
  color: var(--color-text-3);
  margin-top: 4px;
  line-height: 1.35;
}
.tile-s {
  font-size: 10px;
  color: var(--color-text-4);
  margin-top: 2px;
  line-height: 1.3;
}
</style>
