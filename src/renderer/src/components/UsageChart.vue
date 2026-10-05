<script setup lang="ts">
import { computed } from 'vue'
import {
  barChartRects,
  niceMax,
  pctBarClass,
  fmtUnit,
  labelIndicesForRange,
  axisTickIndicesForRange,
  type ChartUnit,
  type ChartRangeKey
} from './usage-history-format'

/**
 * Inline-SVG trajectory chart for the Usage-history pane (issue #19; T47 P3/P4).
 * No charting lib. Two modes: `bars` (daily peaks) and `area` (the 24h line, a
 * filled sawtooth that shows each rate-limit reset). Geometry is pure; colors
 * reuse the meter palette (`fill-*`/`stroke-*`, the SVG twins of the meter's
 * `bg-*`). A bare chart can't say "which day? how much? is that a lot?", so the
 * surface carries the answers (design §6): reference lines at 80/100% for pct, a
 * value label on the peak + latest points, a native `<title>` tooltip per point
 * (day · value), and a day x-axis. Value labels + axis live in an HTML overlay
 * (not the `preserveAspectRatio="none"` SVG, which would stretch text).
 */
const props = withDefaults(
  defineProps<{
    values: (number | null)[]
    /** `pct` colors by 80/95 threshold; `plain` uses a neutral accent. */
    kind?: 'pct' | 'plain'
    /** `bars` = daily peaks, `area` = the 24h line/area. */
    mode?: 'bars' | 'area'
    unit?: ChartUnit
    labels?: string[]
    refLines?: number[]
    max?: number
    height?: number
    title?: string
    /** Drives the axis-tick / value-label density policy (design §6 T47 P4.5). */
    range?: ChartRangeKey
    /** Bar indices where a vertical reset marker is drawn (7d chart, T47 P4.5). */
    markerIndices?: number[]
    /** Parallel to `values` (bars mode) — `true` dims a bar as a partial window. */
    partials?: boolean[]
  }>(),
  {
    kind: 'pct',
    mode: 'bars',
    height: 62,
    range: '30d',
    markerIndices: () => [],
    partials: () => []
  }
)

const VIEW_W = 240

const unit = computed<ChartUnit>(() => props.unit ?? (props.kind === 'pct' ? 'pct' : 'count'))
const axisMax = computed(() =>
  props.max != null ? props.max : props.kind === 'pct' ? 100 : niceMax(props.values, 1)
)

// --- bars geometry ---
const rects = computed(() =>
  barChartRects(props.values, { width: VIEW_W, height: props.height, max: axisMax.value, gap: 2 })
)
function barFill(i: number): string {
  return props.kind === 'pct' ? pctBarClass(props.values[i]) : 'fill-accent'
}

// --- area geometry (equal-spaced points; segments break on null gaps) ---
function xAt(i: number): number {
  const n = props.values.length
  return n <= 1 ? VIEW_W / 2 : (i / (n - 1)) * VIEW_W
}
function yAt(v: number): number {
  return props.height - Math.min(1, Math.max(0, v / axisMax.value)) * (props.height - 1)
}
const areaSegments = computed(() => {
  const segs: { line: string; area: string }[] = []
  let run: { i: number; v: number }[] = []
  const flush = (): void => {
    if (run.length === 0) return
    const line = run.map((p, k) => `${k ? 'L' : 'M'}${xAt(p.i)},${yAt(p.v)}`).join(' ')
    const area =
      `${line} L${xAt(run[run.length - 1].i)},${props.height} ` +
      `L${xAt(run[0].i)},${props.height} Z`
    segs.push({ line, area })
    run = []
  }
  props.values.forEach((v, i) => (v == null ? flush() : run.push({ i, v })))
  flush()
  return segs
})
// Area color: one line can't be multi-colored, so key it off the series peak —
// a window that spiked into the red should read red.
const areaTone = computed(() => {
  if (props.kind !== 'pct') return 'accent'
  const peak = Math.max(0, ...props.values.filter((v): v is number => v != null))
  return peak >= 95 ? 'red' : peak >= 80 ? 'accent' : 'green'
})

// --- shared: refs, value labels, x-axis ---
const refs = computed(() =>
  props.kind === 'pct' ? (props.refLines ?? [80, 100]).filter((v) => v <= axisMax.value) : []
)
function refYPct(v: number): number {
  return (1 - v / axisMax.value) * 100
}
const labeled = computed(() => labelIndicesForRange(props.values, props.range))
const ticks = computed(() => axisTickIndicesForRange(props.values.length, props.range))
function centerPct(i: number): number {
  if (props.mode === 'area') return (xAt(i) / VIEW_W) * 100
  const r = rects.value[i]
  return r ? ((r.x + r.width / 2) / VIEW_W) * 100 : 0
}
function labelTopPct(i: number): number {
  const v = props.values[i]
  const yUnits = props.mode === 'area' && v != null ? yAt(v) : (rects.value[i]?.y ?? props.height)
  return Math.max((yUnits / props.height) * 100, 11)
}
function labelText(i: number): string {
  return fmtUnit(props.values[i], unit.value)
}
function tooltip(i: number): string {
  const day = props.labels?.[i]
  const val = fmtUnit(props.values[i], unit.value)
  return day ? `${day} · ${val}` : val
}
function tickTransform(idx: number): string {
  if (idx === 0) return 'translateX(0)'
  if (idx === ticks.value.length - 1) return 'translateX(-100%)'
  return 'translateX(-50%)'
}
// Reset markers (T47 P4.5, 7d chart) — same x mapping as `centerPct` but in raw
// SVG viewbox units (a `<line>`'s x1/x2, not a percentage-positioned overlay span).
function markerXUnits(i: number): number {
  if (props.mode === 'area') return xAt(i)
  const r = rects.value[i]
  return r ? r.x + r.width / 2 : 0
}
function markerTooltip(i: number): string {
  return props.labels?.[i] ?? ''
}
// Full-height hover columns → per-point native tooltip in area mode.
const hitW = computed(() => (props.values.length ? VIEW_W / props.values.length : VIEW_W))

const empty = computed(() => props.values.every((v) => v == null))
</script>

<template>
  <div class="flex flex-col" style="gap: 3px">
    <div class="chart-plot" :style="{ height: height + 'px' }">
      <svg
        :viewBox="`0 0 ${VIEW_W} ${height}`"
        preserveAspectRatio="none"
        class="w-full"
        :style="{ height: height + 'px' }"
        role="img"
        :aria-label="title"
      >
        <!-- reference lines (pct only) -->
        <line
          v-for="v in refs"
          :key="'ref' + v"
          :x1="0"
          :x2="VIEW_W"
          :y1="(refYPct(v) / 100) * height"
          :y2="(refYPct(v) / 100) * height"
          :class="v >= 100 ? 'stroke-red' : 'stroke-border-2'"
          :opacity="v >= 100 ? 0.45 : 1"
          stroke-width="1"
          stroke-dasharray="3 3"
          vector-effect="non-scaling-stroke"
        />
        <!-- baseline -->
        <line
          :x1="0"
          :y1="height - 0.5"
          :x2="VIEW_W"
          :y2="height - 0.5"
          class="stroke-border"
          stroke-width="1"
          vector-effect="non-scaling-stroke"
        />

        <!-- BARS -->
        <template v-if="mode === 'bars'">
          <g v-for="(r, i) in rects" :key="i">
            <rect
              :x="r.x"
              :y="r.y"
              :width="r.width"
              :height="r.height"
              rx="1"
              class="usage-chart-bar"
              :class="barFill(i)"
              :fill-opacity="partials[i] ? 0.4 : 1"
              :stroke="partials[i] ? 'var(--color-border-2)' : 'none'"
              stroke-width="1"
            />
            <title v-if="values[i] != null">{{ tooltip(i) }}</title>
          </g>
        </template>

        <!-- AREA -->
        <template v-else>
          <path
            v-for="(s, si) in areaSegments"
            :key="'a' + si"
            :d="s.area"
            :class="'fill-' + areaTone"
            opacity="0.13"
          />
          <path
            v-for="(s, si) in areaSegments"
            :key="'l' + si"
            :d="s.line"
            fill="none"
            :class="'stroke-' + areaTone"
            stroke-width="1.75"
            stroke-linejoin="round"
            stroke-linecap="round"
            vector-effect="non-scaling-stroke"
          />
          <!-- invisible hover columns for per-point tooltips -->
          <g v-for="(v, i) in values" :key="'hit' + i">
            <rect
              v-if="v != null"
              :x="xAt(i) - hitW / 2"
              :y="0"
              :width="hitW"
              :height="height"
              fill="transparent"
            >
              <title>{{ tooltip(i) }}</title>
            </rect>
          </g>
        </template>

        <!-- reset markers (T47 P4.5 — vertical dashed line where a window closed) -->
        <g v-for="idx in markerIndices" :key="'marker' + idx">
          <line
            :x1="markerXUnits(idx)"
            :x2="markerXUnits(idx)"
            :y1="0"
            :y2="height"
            class="stroke-border-2"
            stroke-width="1"
            stroke-dasharray="2 2"
            vector-effect="non-scaling-stroke"
          />
          <title>
            {{ markerTooltip(idx) }} · {{ $t('usageHistory.chart.resetMarkerTooltip') }}
          </title>
        </g>
      </svg>

      <!-- HTML overlay: value labels + ref-line labels (out of the stretched SVG) -->
      <div class="chart-overlay">
        <span
          v-for="i in labeled"
          :key="'lab' + i"
          class="chart-vlabel tabular-nums text-text"
          :style="{ left: centerPct(i) + '%', top: labelTopPct(i) + '%' }"
          >{{ labelText(i) }}</span
        >
        <span
          v-for="v in refs"
          :key="'refl' + v"
          class="chart-reflabel tabular-nums"
          :class="v >= 100 ? 'text-red' : 'text-text-4'"
          :style="{ top: refYPct(v) + '%' }"
          >{{ v }}%</span
        >
      </div>
    </div>

    <!-- day x-axis -->
    <div v-if="labels && labels.length && !empty" class="chart-xaxis">
      <span
        v-for="(i, idx) in ticks"
        :key="'tick' + i"
        class="chart-tick tabular-nums text-text-4"
        :style="{ left: centerPct(i) + '%', transform: tickTransform(idx) }"
        >{{ labels[i] }}</span
      >
    </div>

    <div v-if="empty" class="text-text-3" style="font-size: 10.5px">
      {{ $t('usageHistory.noData') }}
    </div>
  </div>
</template>

<style scoped>
.usage-chart-bar {
  transition: height var(--dur) var(--ease);
}
.chart-plot {
  position: relative;
}
.chart-overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.chart-vlabel {
  position: absolute;
  transform: translate(-50%, -3px);
  font-size: 9.5px;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
  text-shadow: 0 1px 2px var(--color-bg);
}
.chart-reflabel {
  position: absolute;
  right: 0;
  transform: translateY(-100%);
  font-size: 8.5px;
  line-height: 1;
  padding-right: 1px;
}
.chart-xaxis {
  position: relative;
  height: 12px;
}
.chart-tick {
  position: absolute;
  font-size: 9px;
  line-height: 1;
  white-space: nowrap;
}
</style>
