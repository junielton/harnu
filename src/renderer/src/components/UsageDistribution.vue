<script setup lang="ts">
import { computed } from 'vue'
import { barClass } from './usage-format'

/**
 * Plan-fit peak distribution as dot strips (design §6 — T47 P4): each complete
 * 5h window's peak plotted as a dot, in an "observed" row and a "projected onto
 * the target tier" row, against a shared axis with 80% and 100% reference lines.
 * "8 dots past the 100% line" reads faster than a p95 in a table. Presentational
 * — the parent passes the raw peaks + the projection ratio.
 */
const props = defineProps<{
  peaks: number[]
  ratio: number | null
  fromLabel: string
  toLabel: string
}>()

const projected = computed(() =>
  props.ratio == null ? [] : props.peaks.map((p) => p * props.ratio!)
)

const axisMax = computed(() => {
  const hi = Math.max(100, ...props.peaks, ...projected.value)
  return Math.ceil(hi / 50) * 50
})
const ticks = computed(() => {
  const out: number[] = []
  for (let v = 0; v <= axisMax.value; v += 50) out.push(v)
  return out
})

function dots(vals: number[]): { left: number; top: number; cls: string; v: number }[] {
  return vals.map((v, i) => ({
    left: Math.min(99.2, (v / axisMax.value) * 100),
    top: 3 + (i % 3) * 6,
    cls: barClass(v),
    v
  }))
}
const obsDots = computed(() => dots(props.peaks))
const projDots = computed(() => dots(projected.value))
function refLeft(v: number): number {
  return (v / axisMax.value) * 100
}
</script>

<template>
  <div class="dist">
    <div class="dist-row">
      <span class="dist-lab text-text-3">{{
        $t('usageHistory.dist.observed', { tier: fromLabel })
      }}</span>
      <div class="dist-track">
        <div class="dist-ref" style="left: 80%"></div>
        <div class="dist-ref dist-ref-cap" :style="{ left: refLeft(100) + '%' }"></div>
        <div class="dist-axis"></div>
        <span
          v-for="(d, i) in obsDots"
          :key="'o' + i"
          class="dist-dot"
          :class="d.cls"
          :style="{ left: `calc(${d.left}% - 3px)`, top: d.top + 'px' }"
          :title="`${Math.round(d.v)}%`"
        ></span>
      </div>
    </div>
    <div v-if="ratio != null" class="dist-row">
      <span class="dist-lab text-text-3">{{
        $t('usageHistory.dist.projected', { tier: toLabel })
      }}</span>
      <div class="dist-track">
        <div class="dist-ref" style="left: 80%"></div>
        <div class="dist-ref dist-ref-cap" :style="{ left: refLeft(100) + '%' }"></div>
        <div class="dist-axis"></div>
        <span
          v-for="(d, i) in projDots"
          :key="'p' + i"
          class="dist-dot"
          :class="d.cls"
          :style="{ left: `calc(${d.left}% - 3px)`, top: d.top + 'px' }"
          :title="`${Math.round(d.v)}%${d.v >= 100 ? ' · ' + $t('usageHistory.dist.over') : ''}`"
        ></span>
      </div>
    </div>
    <div class="dist-row dist-ticksrow">
      <span></span>
      <div class="dist-ticks tabular-nums text-text-4">
        <span
          v-for="v in ticks"
          :key="'t' + v"
          :class="{ 'text-red': v === 100 }"
          :style="{ left: refLeft(v) + '%' }"
          >{{ v }}%</span
        >
      </div>
    </div>
  </div>
</template>

<style scoped>
.dist {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.dist-row {
  display: grid;
  grid-template-columns: 116px 1fr;
  gap: 10px;
  align-items: center;
}
.dist-lab {
  font-size: 10.5px;
  text-align: right;
  line-height: 1.3;
}
.dist-track {
  position: relative;
  height: 26px;
}
.dist-axis {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 3px;
  height: 1px;
  background: var(--color-border);
}
.dist-ref {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--color-border-2);
}
.dist-ref-cap {
  background: color-mix(in srgb, var(--color-red) 55%, transparent);
}
.dist-dot {
  position: absolute;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  box-shadow: 0 0 0 1.5px var(--color-surface);
}
.dist-ticksrow {
  height: 12px;
}
.dist-ticks {
  position: relative;
  height: 12px;
}
.dist-ticks span {
  position: absolute;
  transform: translateX(-50%);
  font-size: 9px;
}
</style>
