<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { formatCostUsd } from './usage-format'
import { barClass } from './usage-format'
import {
  buildScatterScale,
  buildScatterPoints,
  buildInsight,
  sessionDominantModel,
  sessionTokensTotal,
  modelColor,
  fmtTok,
  fmtInt,
  distinctModels
} from './usage-dashboard-format'
import type { SessionAnatomy, UsageBiSnapshot } from '../../../preload'

/**
 * Session anatomy — design.md "Usage Dashboard (takeover)" § Session anatomy.
 * The dashboard's centerpiece: a duration × cost × tokens × model bubble
 * scatter with a docked inspector for the selected session, plus a
 * deterministic one-line insight comparing burn rates across models. Pure
 * geometry/insight math lives in `usage-dashboard-format.ts`.
 */
const props = defineProps<{
  sessions: readonly SessionAnatomy[]
  snapshot: UsageBiSnapshot
  selectedId: string | null
}>()
const emit = defineEmits<{ 'update:selectedId': [string | null] }>()
const { t } = useI18n()

const W = 780
const H = 400
const M = { l: 50, r: 16, t: 18, b: 40 }
const plotW = W - M.l - M.r
const plotH = H - M.t - M.b

const scale = computed(() => buildScatterScale(props.sessions, plotW, plotH))
const points = computed(() => buildScatterPoints(props.sessions, scale.value))

const selected = computed<SessionAnatomy | null>(
  () => props.sessions.find((s) => s.sessionId === props.selectedId) ?? null
)

const models = computed(() => distinctModels(props.snapshot))

function selectSession(id: string): void {
  emit('update:selectedId', props.selectedId === id ? null : id)
}

// Y-axis $ gridlines: 5 evenly spaced ticks up to the scale's cost max.
const yTicks = computed(() => {
  const step = niceStep(scale.value.costMax)
  const ticks: number[] = []
  for (let v = 0; v <= scale.value.costMax + 1e-9; v += step) ticks.push(Math.round(v))
  return ticks
})
function niceStep(max: number): number {
  const raw = max / 6
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(1, raw))))
  const norm = raw / mag
  const step = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10
  return step * mag
}
const xTicks = computed(() => {
  const max = Math.ceil(scale.value.durMax)
  return Array.from({ length: Math.min(max, 12) + 1 }, (_, i) => i)
})

const tokenRows = computed(() => {
  if (!selected.value) return []
  const tok = selected.value.tokens
  const max = Math.max(
    tok.inputTokens,
    tok.outputTokens,
    tok.cacheReadTokens,
    tok.cacheWriteTokens,
    1
  )
  return [
    { key: 'tokenInput', value: tok.inputTokens, max },
    { key: 'tokenOutput', value: tok.outputTokens, max },
    { key: 'tokenCacheRead', value: tok.cacheReadTokens, max },
    { key: 'tokenCacheWrite', value: tok.cacheWriteTokens, max }
  ]
})

const modelCostRows = computed(() => {
  if (!selected.value) return []
  const total = selected.value.costUsd || 1
  return Object.entries(selected.value.costByModel)
    .filter(([, cost]) => cost > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([model, cost]) => ({ model, cost, pct: (cost / total) * 100, color: modelColor(model) }))
})

const insight = computed(() => buildInsight(props.sessions))
const insightText = computed(() => {
  const models2 = new Set(props.sessions.map(sessionDominantModel).filter(Boolean))
  if (models2.size < 2) {
    return models2.size <= 1
      ? t('usageDashboard.anatomy.insightSingleModel')
      : t('usageDashboard.anatomy.insightNotEnough')
  }
  const i = insight.value
  if (!i) return t('usageDashboard.anatomy.insightNotEnough')
  return t('usageDashboard.anatomy.insightCompare', {
    modelA: i.modelA,
    modelB: i.modelB,
    costA: formatCostUsd(i.costPerHourA),
    costB: formatCostUsd(i.costPerHourB),
    ratio: i.ratio.toFixed(1)
  })
})
</script>

<template>
  <div>
    <div class="mb-2.5 flex flex-wrap items-center justify-between gap-2.5">
      <h2 class="text-[11.5px] font-bold uppercase tracking-wide text-text-2">
        {{ t('usageDashboard.anatomy.title') }}
      </h2>
      <span class="text-[11px] text-text-4">{{ t('usageDashboard.anatomy.subtitle') }}</span>
    </div>

    <div class="mb-2.5 flex flex-wrap gap-2.5">
      <span
        v-for="m in models"
        :key="m"
        class="inline-flex items-center gap-1.5 text-[11.5px] text-text-2"
      >
        <span class="h-[9px] w-[9px] shrink-0 rounded-sm" :style="{ background: modelColor(m) }" />
        {{ m }}
      </span>
      <span class="inline-flex items-center gap-1.5 text-[11.5px] text-text-2">
        <span
          class="flex h-[14px] w-[14px] items-center justify-center rounded-full border bg-bg text-[8.5px] font-bold text-text"
          style="border-color: var(--color-text-3)"
        >
          N
        </span>
        {{ t('usageDashboard.anatomy.subagentLegend') }}
      </span>
    </div>

    <div class="flex items-stretch gap-4">
      <div class="min-w-0 flex-1">
        <svg :viewBox="`0 0 ${W} ${H}`" class="block w-full">
          <!-- yScale already maps cost -> plot-space y (0 at top = costMax, plotH
               at bottom = 0), matching the data points' own `M.t + p.cy` below —
               gridlines must use the SAME single transform, not re-invert it
               (caught in live CDP verification: gridlines rendered "$0" at the
               top, backwards from every data point). -->
          <line
            v-for="c in yTicks"
            :key="'y' + c"
            :x1="M.l"
            :y1="M.t + scale.yScale(c)"
            :x2="M.l + plotW"
            :y2="M.t + scale.yScale(c)"
            stroke="var(--color-border)"
            stroke-dasharray="2,3"
          />
          <text
            v-for="c in yTicks"
            :key="'yl' + c"
            :x="M.l - 6"
            :y="M.t + scale.yScale(c) + 3"
            text-anchor="end"
            font-size="9.5"
            fill="var(--color-text-4)"
          >
            ${{ c }}
          </text>
          <line
            v-for="h in xTicks"
            :key="'x' + h"
            :x1="M.l + scale.xScale(h)"
            :y1="M.t"
            :x2="M.l + scale.xScale(h)"
            :y2="M.t + plotH"
            stroke="var(--color-border)"
            stroke-opacity="0.55"
          />
          <text
            v-for="h in xTicks"
            :key="'xl' + h"
            :x="M.l + scale.xScale(h)"
            :y="M.t + plotH + 15"
            text-anchor="middle"
            font-size="9.5"
            fill="var(--color-text-4)"
          >
            {{ h }}h
          </text>
          <text
            :x="M.l + plotW / 2"
            :y="H - 3"
            text-anchor="middle"
            font-size="10"
            fill="var(--color-text-3)"
          >
            {{ t('usageDashboard.anatomy.xAxis') }}
          </text>
          <text
            :x="12"
            :y="M.t + plotH / 2"
            text-anchor="middle"
            font-size="10"
            fill="var(--color-text-3)"
            :transform="`rotate(-90 12 ${M.t + plotH / 2})`"
          >
            {{ t('usageDashboard.anatomy.yAxis') }}
          </text>
          <text
            :x="M.l + 8"
            :y="M.t + 14"
            font-size="10"
            fill="var(--color-text-4)"
            font-style="italic"
          >
            {{ t('usageDashboard.anatomy.shortExpensive') }}
          </text>
          <text
            :x="M.l + plotW - 8"
            :y="M.t + plotH - 8"
            text-anchor="end"
            font-size="10"
            fill="var(--color-text-4)"
            font-style="italic"
          >
            {{ t('usageDashboard.anatomy.longCheap') }}
          </text>

          <g
            v-for="p in points"
            :key="p.session.sessionId"
            class="cursor-pointer"
            @click="selectSession(p.session.sessionId)"
          >
            <title>
              {{ p.session.title }} · {{ ((p.session.durationMs ?? 0) / 3600000).toFixed(1) }}h ·
              {{ formatCostUsd(p.session.costUsd) }} ·
              {{ fmtTok(sessionTokensTotal(p.session)) }} tokens ·
              {{ p.session.subagentCount }} subagents
            </title>
            <circle
              :cx="M.l + p.cx"
              :cy="M.t + p.cy"
              :r="p.r"
              :fill="p.color"
              :fill-opacity="p.session.sessionId === selectedId ? 0.78 : 0.4"
              :stroke="p.color"
              :stroke-width="p.session.sessionId === selectedId ? 2.6 : 1.3"
            />
            <circle
              v-if="p.session.sessionId === selectedId"
              :cx="M.l + p.cx"
              :cy="M.t + p.cy"
              :r="p.r + 5"
              fill="none"
              stroke="var(--color-text)"
              stroke-width="1"
              stroke-dasharray="2,3"
              opacity="0.65"
            />
            <template v-if="p.session.subagentCount > 0">
              <circle
                :cx="M.l + p.cx + p.r * 0.6"
                :cy="M.t + p.cy - p.r * 0.6"
                r="8"
                fill="var(--color-bg)"
                :stroke="p.color"
                stroke-width="1.3"
              />
              <text
                :x="M.l + p.cx + p.r * 0.6"
                :y="M.t + p.cy - p.r * 0.6 + 3"
                text-anchor="middle"
                font-size="9"
                font-weight="700"
                fill="var(--color-text)"
              >
                {{ p.session.subagentCount }}
              </text>
            </template>
          </g>
        </svg>
      </div>

      <div
        class="flex w-[320px] shrink-0 flex-col gap-3 rounded-lg border border-border-2 bg-surface-2 p-3.5"
      >
        <div v-if="!selected" class="py-5 text-center text-[12px] text-text-4">
          {{ t('usageDashboard.anatomy.emptyInspector') }}
        </div>
        <template v-else>
          <div>
            <div class="text-[10.5px] uppercase tracking-wide text-text-3">
              {{ selected.projectPath }}
            </div>
            <div class="mt-0.5 text-[14px] font-bold text-text">{{ selected.title }}</div>
          </div>
          <div class="grid grid-cols-2 gap-2">
            <div class="rounded-sm border border-border bg-surface px-2.5 py-1.5">
              <div class="text-[10px] uppercase tracking-wide text-text-4">
                {{ t('usageDashboard.anatomy.duration') }}
              </div>
              <div class="mt-0.5 tabular-nums text-[14px] font-bold text-text">
                {{ ((selected.durationMs ?? 0) / 3600000).toFixed(1) }}h
              </div>
            </div>
            <div class="rounded-sm border border-border bg-surface px-2.5 py-1.5">
              <div class="text-[10px] uppercase tracking-wide text-text-4">
                {{ t('usageDashboard.anatomy.cost') }}
              </div>
              <div class="mt-0.5 tabular-nums text-[14px] font-bold text-text">
                {{ formatCostUsd(selected.costUsd) }}
              </div>
            </div>
            <div class="rounded-sm border border-border bg-surface px-2.5 py-1.5">
              <div class="text-[10px] uppercase tracking-wide text-text-4">
                {{ t('usageDashboard.anatomy.turns') }}
              </div>
              <div class="mt-0.5 tabular-nums text-[14px] font-bold text-text">
                {{ fmtInt(selected.turns) }}
              </div>
            </div>
            <div class="rounded-sm border border-border bg-surface px-2.5 py-1.5">
              <div class="text-[10px] uppercase tracking-wide text-text-4">
                {{ t('usageDashboard.anatomy.agents') }}
              </div>
              <div class="mt-0.5 tabular-nums text-[14px] font-bold text-text">
                1 {{ t('usageDashboard.anatomy.subSuffix', { n: selected.subagentCount }) }}
              </div>
            </div>
          </div>
          <div>
            <h4 class="mb-1.5 text-[10.5px] font-bold uppercase tracking-wide text-text-4">
              {{ t('usageDashboard.anatomy.costByModel') }}
            </h4>
            <div
              class="mb-1.5 flex h-[10px] overflow-hidden rounded shadow-[inset_0_0_0_1px_var(--color-border)]"
            >
              <div
                v-for="row in modelCostRows"
                :key="row.model"
                :style="{ width: row.pct + '%', background: row.color }"
              />
            </div>
            <div
              v-for="row in modelCostRows"
              :key="row.model + '-r'"
              class="flex items-center justify-between gap-2 py-0.5 text-[11.5px] text-text-2"
            >
              <span
                class="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-ellipsis whitespace-nowrap"
              >
                <span class="h-2 w-2 shrink-0 rounded-sm" :style="{ background: row.color }" />
                {{ row.model }}
              </span>
              <span class="font-semibold text-text">{{ formatCostUsd(row.cost) }}</span>
            </div>
          </div>
          <div>
            <h4 class="mb-1.5 text-[10.5px] font-bold uppercase tracking-wide text-text-4">
              {{ t('usageDashboard.anatomy.tokens') }}
            </h4>
            <div
              v-for="row in tokenRows"
              :key="row.key"
              class="flex items-center gap-2 py-0.5 text-[11px] text-text-2"
            >
              <span class="w-[78px] shrink-0 text-text-3">{{
                t('usageDashboard.anatomy.' + row.key)
              }}</span>
              <span class="h-[5px] flex-1 overflow-hidden rounded-full bg-surface">
                <span
                  class="block h-full rounded-full bg-accent"
                  :style="{ width: (row.value / row.max) * 100 + '%' }"
                />
              </span>
              <span class="w-12 shrink-0 text-right font-semibold text-text">{{
                fmtTok(row.value)
              }}</span>
            </div>
          </div>
          <div>
            <h4 class="mb-1.5 text-[10.5px] font-bold uppercase tracking-wide text-text-4">
              {{ t('usageDashboard.anatomy.peakContext') }}
            </h4>
            <div class="flex items-center gap-2.5">
              <span class="h-2 flex-1 overflow-hidden rounded bg-surface">
                <span
                  class="block h-full rounded"
                  :class="barClass(selected.peakContextPct)"
                  :style="{ width: Math.min(100, selected.peakContextPct) + '%' }"
                />
              </span>
              <span class="tabular-nums text-[13px] font-bold text-text"
                >{{ selected.peakContextPct }}%</span
              >
            </div>
            <!-- A session on a real long-context model (e.g. Opus with the 1M
                 beta enabled) can genuinely read >100%: our window-sizing
                 heuristic (200k default, 1M only when the model id literally
                 carries a `[1m]` marker) has no other signal to detect that,
                 so it undercounts the true window (T47 P6 S1 finding). The
                 bar clamps at 100% width (never looks broken); this note
                 keeps the raw number from reading as a bug. -->
            <p v-if="selected.peakContextPct > 100" class="mt-1 text-[10.5px] text-text-4">
              {{ t('usageDashboard.anatomy.peakContextOverflowHint') }}
            </p>
          </div>
        </template>
      </div>
    </div>

    <div
      class="mt-3.5 flex items-baseline gap-2 rounded-md border border-border-2 bg-surface-2 px-3 py-2.5 text-[12px] text-text-2"
    >
      <span class="text-accent">●</span>
      <span>{{ insightText }}</span>
    </div>
  </div>
</template>
