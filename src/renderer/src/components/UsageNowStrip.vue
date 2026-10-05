<script setup lang="ts">
import { computed } from 'vue'
import { barClass, clampPct, humanizeDuration } from './usage-format'
import { fmtPct } from './usage-history-format'

/**
 * "Right now" strip for the Usage-history pane (design §6 — T47 P4). Bridges the
 * live footer telemetry to the history: the current 5h window's usage, its reset
 * countdown, and a burn-rate projection of where it lands at reset. The meter
 * reuses the plan-usage fill palette; a ticked marker shows the projection, a
 * faint line marks 80%. Presentational — the pane owns the telemetry + the pure
 * `projectWindowPeak`. Hidden by the pane when there's no live 5h reading.
 */
const props = defineProps<{
  pct: number
  resetsAtMs: number | null
  projectedPct: number | null
  nowMs: number
}>()

const fillClass = computed(() => barClass(props.pct))
const fillPct = computed(() => clampPct(props.pct))
const projPos = computed(() => (props.projectedPct == null ? null : clampPct(props.projectedPct)))
const resetIn = computed(() => {
  if (props.resetsAtMs == null) return null
  const delta = props.resetsAtMs - props.nowMs
  return delta > 0 ? humanizeDuration(delta) : null
})
</script>

<template>
  <div class="now border border-border bg-surface">
    <div class="now-head">
      <span class="text-text-2">
        {{ $t('usageHistory.nowStrip.label') }}
        <span
          class="tabular-nums"
          :class="barClass(pct).replace('bg-', 'text-')"
          style="font-weight: 600"
          >{{ fmtPct(pct) }}</span
        >
      </span>
      <span class="text-text-3 tabular-nums">
        <template v-if="resetIn">{{
          $t('usageHistory.nowStrip.resetIn', { t: resetIn })
        }}</template>
        <template v-if="projectedPct != null">
          · {{ $t('usageHistory.nowStrip.projected', { pct: fmtPct(projectedPct) }) }}</template
        >
      </span>
    </div>
    <div
      class="meter"
      role="img"
      :aria-label="$t('usageHistory.nowStrip.label') + ' ' + fmtPct(pct)"
    >
      <div class="meter-ref" style="left: 80%" :title="$t('usageHistory.nowStrip.legendRef')"></div>
      <div class="meter-fill" :class="fillClass" :style="{ width: fillPct + '%' }"></div>
      <template v-if="projPos != null">
        <div class="meter-proj" :style="{ left: projPos + '%' }"></div>
        <span class="meter-proj-label tabular-nums text-text-3" :style="{ left: projPos + '%' }">{{
          fmtPct(projectedPct)
        }}</span>
      </template>
    </div>
    <div class="now-legend text-text-4 tabular-nums">
      <span><i class="dot" :class="fillClass"></i>{{ $t('usageHistory.nowStrip.legendNow') }}</span>
      <span v-if="projectedPct != null"
        ><i class="dot dot-proj"></i>{{ $t('usageHistory.nowStrip.legendProj') }}</span
      >
      <span><i class="dot dot-ref"></i>{{ $t('usageHistory.nowStrip.legendRef') }}</span>
    </div>
  </div>
</template>

<style scoped>
.now {
  border-radius: var(--radius);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.now-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 12px;
}
.now-head .text-text-3 {
  font-size: 11px;
}
.meter {
  position: relative;
  height: 8px;
  border-radius: 4px;
  background: var(--color-surface-2);
}
.meter-fill {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 4px;
  transition: width var(--dur) var(--ease);
}
.meter-ref {
  position: absolute;
  top: -2px;
  bottom: -2px;
  width: 1px;
  background: var(--color-border-2);
}
.meter-proj {
  position: absolute;
  top: -3px;
  bottom: -3px;
  width: 2px;
  background: var(--color-text-3);
  transform: translateX(-1px);
}
.meter-proj-label {
  position: absolute;
  top: -14px;
  font-size: 9px;
  line-height: 1;
  white-space: nowrap;
  transform: translateX(-50%);
}
.now-legend {
  display: flex;
  gap: 14px;
  font-size: 10px;
}
.dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 2px;
  margin-right: 4px;
  vertical-align: 0;
}
.dot-proj {
  background: var(--color-text-3);
}
.dot-ref {
  background: var(--color-border-2);
}
</style>
