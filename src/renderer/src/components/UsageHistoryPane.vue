<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import UsageChart from './UsageChart.vue'
import UsageStatTiles from './UsageStatTiles.vue'
import UsageNowStrip from './UsageNowStrip.vue'
import UsageHeatmap from './UsageHeatmap.vue'
import PlanFitCard from './PlanFitCard.vue'
import ToggleSwitch from './ui/ToggleSwitch.vue'
import SegmentedControl from './ui/SegmentedControl.vue'
import SettingHint from './ui/SettingHint.vue'
import {
  shortDay,
  summarizeUsage,
  latestValue,
  fmtUnit,
  projectWindowPeak,
  resetMarkerIndices,
  windowSeriesFor,
  rangeSinceMs
} from './usage-history-format'
import { toggleWorkingDay, countWorkingDays } from './daily-budget'
import { useUsageStore } from '../stores/usage'
import type {
  UsageHistorySummary,
  PlanFitResult,
  TierRecommendation,
  TelemetryPayload,
  UsageHistoryPrefs,
  UsageCostSummary
} from '../../../preload'

/**
 * Settings → "Usage history" tab (issue #19). Mirrors `ChangelogPane.vue` as a
 * self-contained settings pane: loads the summary on mount, renders the
 * trajectory charts (5h/7d/cost/sessions per period, inline SVG), the
 * deterministic plan-fit calculator, an on-demand chat over the rollups, and the
 * feature's own config (capture opt-out, current tier, chat model, retention).
 *
 * The "account-wide % vs local cost" distinction is made explicit in the UI: the
 * 5h/7d percentages are account-wide truth; cost/sessions are this machine only.
 */

const { t } = useI18n()

const summary = ref<UsageHistorySummary | null>(null)
const loading = ref(true)
const period = ref<'24h' | '7d' | '30d' | '60d' | '90d' | 'all'>('7d')

const fromTier = ref('max20')
const toTier = ref('max5')
const ratioOverride = ref<number | null>(null)
/** Recency scope for the calculator, in days; 0 = all-time (T47 P1). */
const scopeDays = ref(60)
const planFit = ref<PlanFitResult | null>(null)
const recommendation = ref<TierRecommendation | null>(null)

const chatQuestion = ref('')
const chatAnswer = ref('')
const chatLoading = ref(false)
const chatError = ref(false)

// Live footer telemetry → the "now" strip. Seeded on mount, streamed after.
const fleetNow = ref<TelemetryPayload['fleet'] | null>(null)
const nowMs = ref(Date.now())
let unsubTelemetry: (() => void) | null = null
let clockTimer: ReturnType<typeof setInterval> | null = null

const chatChips: Array<{ key: string }> = [
  { key: 'usageHistory.chat.chips.whenBusiest' },
  { key: 'usageHistory.chat.chips.wouldFit' },
  { key: 'usageHistory.chat.chips.thisMonth' },
  { key: 'usageHistory.chat.chips.vsLastMonth' }
]

const periods: Array<{ value: '24h' | '7d' | '30d' | '60d' | '90d' | 'all'; key: string }> = [
  { value: '24h', key: 'usageHistory.period.h24' },
  { value: '7d', key: 'usageHistory.period.d7' },
  { value: '30d', key: 'usageHistory.period.d30' },
  { value: '60d', key: 'usageHistory.period.d60' },
  { value: '90d', key: 'usageHistory.period.d90' },
  { value: 'all', key: 'usageHistory.period.all' }
]

// 5h chart mode toggle (T47 P4.5) — "by day" (the usual day-peak bars) vs
// "by window" (one bar per CLOSED 5h window, chronological, so a 95% window
// shows beside its 30–40% same-day siblings instead of hiding behind the
// day's peak-of-day).
const fiveHourMode = ref<'day' | 'window'>('day')
const fiveHourModeOptions: Array<{ value: 'day' | 'window'; key: string }> = [
  { value: 'day', key: 'usageHistory.fiveHourMode.byDay' },
  { value: 'window', key: 'usageHistory.fiveHourMode.byWindow' }
]

const retentionOptions: Array<{ value: number | 'forever'; key: string }> = [
  { value: 30, key: 'usageHistory.retention.d30' },
  { value: 90, key: 'usageHistory.retention.d90' },
  { value: 365, key: 'usageHistory.retention.d365' },
  { value: 'forever', key: 'usageHistory.retention.forever' }
]

const prefs = computed<UsageHistoryPrefs | null>(() => summary.value?.prefs ?? null)
const tiers = computed(() => summary.value?.tiers ?? [])

// Working-days control (daily-budget spec). The 7d window comes from the usage
// store — the same source the footer panel's daily-budget row reads.
const usage = useUsageStore()

/** Mon-first, Sunday last: the week as the mockup's settings panel orders it. */
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0]

/**
 * The currently-selected working days. `prefs` is `computed<… | null>` in this
 * pane, so every read must be null-safe even though the block that renders the
 * control sits under a `v-if="prefs"` — the computed itself is evaluated
 * outside that guard.
 */
const workingDays = computed<number[]>(() => prefs.value?.workingDays ?? [])

/**
 * Preview of today's allowance for the currently-selected days, so the effect
 * of ticking a weekday is visible without opening the footer panel: it divides
 * what is left of the 7d window by the working days still ahead of the reset.
 * With no 7d window known yet it falls back to the size of the selected set —
 * one week's worth — rather than reading blank.
 *
 * Deliberately NOT `computeDailyBudget`: that one freezes on the start-of-day
 * baseline so the panel's bar can reach 100%, which is exactly wrong for a
 * preview — it would answer "what was today's budget" while the user is asking
 * "what would today's budget be if I ticked Sunday". Same denominator, later
 * numerator: this reads lower than the panel by `spentPct / workingDaysLeft`,
 * and the two agree only before the day's first spend. The panel stays the
 * number of record; this one only has to rank the choices honestly.
 *
 * Zero selected days is a legitimate "off" state, not an error — guard the
 * division rather than the interaction.
 */
const workingDaysPreview = computed(() => {
  const days = workingDays.value
  const w = usage.rateLimits?.sevenDay
  const left = w?.resetsAtMs ? countWorkingDays(nowMs.value, w.resetsAtMs, days) : days.length
  const remaining = 100 - (w?.usedPercent ?? 0)
  return { days: days.length, pct: left > 0 ? Math.round(remaining / left) : 0 }
})

// Real cost engine (T47 P5) — loaded independently of `summary` and never
// gates `loading`: it's additive. Any absence/failure just means the charts
// below stay on the notional figures they've always shown (fail-safe).
const costSummary = ref<UsageCostSummary | null>(null)

async function loadCostSummary(): Promise<void> {
  try {
    costSummary.value = await window.api.usageCostSummary()
  } catch {
    costSummary.value = null
  }
}

async function loadSummary(): Promise<void> {
  loading.value = true
  try {
    const s = await window.api.usageHistorySummary()
    summary.value = s
    fromTier.value = s.prefs.currentTier
    // Default the target to the next-smaller published tier (if any).
    const idx = s.tiers.findIndex((t) => t.id === s.prefs.currentTier)
    toTier.value = idx > 0 ? s.tiers[idx - 1].id : s.prefs.currentTier
    await refreshPlanFit()
  } catch {
    summary.value = null
  } finally {
    loading.value = false
  }
}

async function refreshPlanFit(): Promise<void> {
  const sinceDays = scopeDays.value > 0 ? scopeDays.value : null
  try {
    planFit.value = await window.api.usageHistoryPlanFit({
      fromTier: fromTier.value,
      toTier: toTier.value,
      ratioOverride: ratioOverride.value ?? undefined,
      sinceDays
    })
  } catch {
    planFit.value = null
  }
  try {
    recommendation.value = await window.api.usageHistoryRecommend({
      fromTier: fromTier.value,
      sinceDays
    })
  } catch {
    recommendation.value = null
  }
}

watch([fromTier, toTier, ratioOverride, scopeDays], () => void refreshPlanFit())

async function setPrefs(patch: Partial<UsageHistoryPrefs>): Promise<void> {
  if (!summary.value) return
  try {
    const next = await window.api.usageHistorySetPrefs(patch)
    summary.value = { ...summary.value, prefs: next }
    if (patch.currentTier) {
      fromTier.value = next.currentTier
      await refreshPlanFit()
    }
  } catch {
    /* keep last-good */
  }
}

async function askChat(preset?: string): Promise<void> {
  if (preset) chatQuestion.value = preset
  const q = chatQuestion.value.trim()
  if (!q || chatLoading.value) return
  chatLoading.value = true
  chatError.value = false
  chatAnswer.value = ''
  try {
    const res = await window.api.usageHistoryChat({ question: q })
    if (res.ok && res.answer) chatAnswer.value = res.answer
    else chatError.value = true
  } catch {
    chatError.value = true
  } finally {
    chatLoading.value = false
  }
}

// ---- "Now" strip (live footer telemetry) -----------------------------------

const nowStrip = computed(() => {
  const five = fleetNow.value?.fiveHour
  if (!five) return null
  return {
    pct: five.usedPercent,
    resetsAtMs: five.resetsAtMs,
    projectedPct: projectWindowPeak(five.usedPercent, five.resetsAtMs, nowMs.value)
  }
})

// ---- Chart series by period ------------------------------------------------

const rollupTail = computed(() => {
  const r = summary.value?.rollups ?? []
  switch (period.value) {
    case '30d':
      return r.slice(-30)
    case '60d':
      return r.slice(-60)
    case '90d':
      return r.slice(-90)
    case 'all':
      return r
    default:
      return r.slice(-7)
  }
})

/** Local `HH:MM` for a 24h sample tick. */
function hhmm(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

// One label per bar for the active period — the tooltip + x-axis read from this.
const barLabels = computed<string[]>(() =>
  period.value === '24h'
    ? (summary.value?.recentSamples ?? []).map((s) => hhmm(s.t))
    : rollupTail.value.map((r) => shortDay(r.day))
)

// Headline tiles: fixed 30d scope, independent of the chart period toggle.
const TILE_DAYS = 30
const tiles = computed(() =>
  summarizeUsage(summary.value?.rollups ?? [], summary.value?.windows ?? [], Date.now(), TILE_DAYS)
)

// "now" / "today" reading shown in each chart's title.
function current(pick: 'five' | 'seven' | 'cost' | 'sessions'): string {
  const unit = pick === 'cost' ? 'usd' : pick === 'sessions' ? 'count' : 'pct'
  const v = latestValue(series(pick))
  if (v == null) return '—'
  const label = period.value === '24h' ? 'usageHistory.now' : 'usageHistory.today'
  return `${t(label)} ${fmtUnit(v, unit)}`
}

function series(pick: 'five' | 'seven' | 'cost' | 'sessions'): (number | null)[] {
  if (!summary.value) return []
  if (period.value === '24h') {
    return summary.value.recentSamples.map((s) =>
      pick === 'five'
        ? s.fiveHourPct
        : pick === 'seven'
          ? s.sevenDayPct
          : pick === 'cost'
            ? s.costUsd
            : s.sessionCount
    )
  }
  return rollupTail.value.map((r) =>
    pick === 'five'
      ? r.fiveHourPeak
      : pick === 'seven'
        ? r.sevenDayPeak
        : pick === 'cost'
          ? r.costPeakUsd
          : r.sessionPeak
  )
}

/** `HH:MM`-titled reading for an explicit series (cost/sessions from the real
 * cost engine don't come from `series()`, so `current()` can't derive them). */
function currentFrom(values: (number | null)[], unit: 'usd' | 'count'): string {
  const v = latestValue(values)
  if (v == null) return '—'
  const label = period.value === '24h' ? 'usageHistory.now' : 'usageHistory.today'
  return `${t(label)} ${fmtUnit(v, unit)}`
}

// ---- Real cost engine (T47 P5) — day-level, so never active in the 24h period
// (the engine has no intraday granularity; the notional sample stream remains
// the only live signal there, same as before this feature existed). ----------

const realCostByDay = computed(() => {
  const m = new Map<string, number>()
  for (const d of costSummary.value?.dailyRollup ?? []) m.set(d.day, d.costUsd)
  return m
})
const realSessionsWorkedByDay = computed(() => {
  const m = new Map<string, number>()
  for (const d of costSummary.value?.dailyRollup ?? []) m.set(d.day, d.sessionsWorked)
  return m
})
// Real data "covers" the period once at least one visible day has an engine
// entry — a brand-new install (engine hasn't scanned anything relevant to the
// visible range yet) correctly stays on notional instead of a chart full of gaps.
const hasRealDataInPeriod = computed(
  () => period.value !== '24h' && rollupTail.value.some((r) => realCostByDay.value.has(r.day))
)
const hasEstimatedCost = computed(() => costSummary.value?.hasEstimated ?? false)
// The notional title says "(peak)" honestly (it IS a peak of an accumulator) —
// once real per-day totals are showing, that word would lie (it's a plain
// daily sum now), so the title itself swaps, not just the subtitle.
const costTitleKey = computed(() =>
  hasRealDataInPeriod.value ? 'usageHistory.chart.costReal' : 'usageHistory.chart.cost'
)

const costChartValues = computed<(number | null)[]>(() =>
  hasRealDataInPeriod.value
    ? rollupTail.value.map((r) => realCostByDay.value.get(r.day) ?? null)
    : series('cost')
)
const sessionsChartValues = computed<(number | null)[]>(() =>
  hasRealDataInPeriod.value
    ? rollupTail.value.map((r) => realSessionsWorkedByDay.value.get(r.day) ?? null)
    : series('sessions')
)
// The notional readings stay accessible as a secondary line even once the
// primary chart switches to real data (design.md T47 P5 — never a silent swap).
const notionalCostNow = computed(() => {
  const v = latestValue(series('cost'))
  return v == null ? null : fmtUnit(v, 'usd')
})
const notionalSessionsNow = computed(() => {
  const v = latestValue(series('sessions'))
  return v == null ? null : fmtUnit(v, 'count')
})

interface TopModelRow {
  model: string
  costUsd: number
  requestCount: number
  estimated: boolean
  pct: number
}
const TOP_MODELS_CAP = 5
const topModels = computed<TopModelRow[]>(() => {
  const models = costSummary.value?.modelRollup ?? []
  if (models.length === 0) return []
  const total = models.reduce((s, m) => s + m.costUsd, 0)
  return models.slice(0, TOP_MODELS_CAP).map((m) => ({
    model: m.model,
    costUsd: m.costUsd,
    requestCount: m.requestCount,
    estimated: m.estimated,
    pct: total > 0 ? (m.costUsd / total) * 100 : 0
  }))
})

// 7d chart reset markers (T47 P4.5) — a vertical line where a sevenDay window
// actually closed within the visible days. Not shown in 24h (area mode, no day
// bars to align against).
const sevenDayMarkers = computed(() => {
  if (period.value === '24h' || !summary.value) return []
  return resetMarkerIndices(
    summary.value.windows,
    'sevenDay',
    rollupTail.value.map((r) => r.day)
  )
})

// 5h "by window" series — closed fiveHour windows in the current period's
// lookback, chronologically ordered. Only computed/used when the toggle is set.
const fiveHourWindowPoints = computed(() => {
  if (!summary.value) return []
  return windowSeriesFor(
    summary.value.windows,
    'fiveHour',
    rangeSinceMs(period.value, nowMs.value),
    nowMs.value
  )
})
const fiveHourChartValues = computed<(number | null)[]>(() =>
  fiveHourMode.value === 'window' ? fiveHourWindowPoints.value.map((p) => p.value) : series('five')
)
const fiveHourChartLabels = computed<string[]>(() =>
  fiveHourMode.value === 'window' ? fiveHourWindowPoints.value.map((p) => p.label) : barLabels.value
)
const fiveHourPartials = computed<boolean[]>(() =>
  fiveHourMode.value === 'window' ? fiveHourWindowPoints.value.map((p) => p.partial) : []
)
// "By window" bars aren't day-aligned, so they always render as bars (area mode
// assumes equally-spaced daily/intraday samples).
const fiveHourChartMode = computed<'area' | 'bars'>(() =>
  fiveHourMode.value === 'window' ? 'bars' : chartMode.value
)

// Coverage of the calculator's scope: how many windows we saw at all vs saw
// completely. Feeds the PlanFitCard note (replaces the old all-time partial
// warning, which grew forever and read as an alarm).
const windowsInScope = computed(() => {
  const since = scopeDays.value > 0 ? Date.now() - scopeDays.value * 24 * 3600_000 : -Infinity
  return (summary.value?.windows ?? []).filter((w) => w.closedAtMs >= since)
})
const coverageTotal = computed(() => windowsInScope.value.length)
const coverageComplete = computed(() => windowsInScope.value.filter((w) => !w.partial).length)

// Raw complete-5h-window peaks in scope — the dot distribution in the plan-fit card.
const peaks5h = computed(() =>
  windowsInScope.value.filter((w) => w.kind === 'fiveHour' && !w.partial).map((w) => w.peakPct)
)

// 24h reads as the live line/area (the sawtooth of resets); daily reads as bars.
const chartMode = computed<'area' | 'bars'>(() => (period.value === '24h' ? 'area' : 'bars'))

const hasData = computed(
  () => (summary.value?.recentSamples.length ?? 0) > 0 || (summary.value?.rollups.length ?? 0) > 0
)

onMounted(() => {
  void loadSummary()
  void loadCostSummary()
  void window.api.telemetryGet().then((p) => (fleetNow.value = p.fleet))
  unsubTelemetry = window.api.onTelemetryUpdated((p) => (fleetNow.value = p.fleet))
  // Tick the clock so the reset countdown + burn-rate projection stay live.
  clockTimer = setInterval(() => (nowMs.value = Date.now()), 30_000)
})
onUnmounted(() => {
  unsubTelemetry?.()
  if (clockTimer) clearInterval(clockTimer)
})
</script>

<template>
  <div class="flex flex-col" style="gap: 18px">
    <!-- Empty / loading -->
    <div v-if="loading" class="text-text-3" style="font-size: 12px">
      {{ $t('usageHistory.loading') }}
    </div>
    <div v-else-if="!hasData" class="text-text-3" style="font-size: 12px; line-height: 1.6">
      {{ $t('usageHistory.empty') }}
    </div>

    <template v-else>
      <!-- Headline KPI tiles — the glance answer, before any chart -->
      <UsageStatTiles :tiles="tiles" :heatmap="summary!.heatmap" :days="TILE_DAYS" />

      <!-- "Right now" strip — live 5h window + burn-rate projection -->
      <UsageNowStrip
        v-if="nowStrip"
        :pct="nowStrip.pct"
        :resets-at-ms="nowStrip.resetsAtMs"
        :projected-pct="nowStrip.projectedPct"
        :now-ms="nowMs"
      />

      <!-- Period selector -->
      <div class="flex items-center justify-between" style="gap: 12px">
        <div
          class="text-text-3"
          style="
            font-size: 11px;
            font-weight: 500;
            letter-spacing: 0.06em;
            text-transform: uppercase;
          "
        >
          {{ $t('usageHistory.trajectory') }}
        </div>
        <SegmentedControl
          :options="periods.map((p) => ({ value: p.value, label: $t(p.key) }))"
          :model-value="period"
          size="sm"
          :aria-label="$t('usageHistory.trajectory')"
          @update:model-value="period = $event as '24h' | '7d' | '30d' | '60d' | '90d' | 'all'"
        />
      </div>

      <!-- Account-wide vs local note -->
      <div class="text-text-3" style="font-size: 10.5px; line-height: 1.5">
        {{ $t('usageHistory.accountVsLocal') }}
      </div>

      <!-- Charts grid -->
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px 14px">
        <div>
          <div class="chart-head">
            <span>{{ $t('usageHistory.chart.fiveHour') }}</span>
            <span class="chart-cur tabular-nums">{{ current('five') }}</span>
          </div>
          <div class="flex" style="justify-content: flex-end; margin-bottom: 4px">
            <SegmentedControl
              :options="fiveHourModeOptions.map((o) => ({ value: o.value, label: $t(o.key) }))"
              :model-value="fiveHourMode"
              size="sm"
              :aria-label="$t('usageHistory.fiveHourMode.label')"
              @update:model-value="fiveHourMode = $event as 'day' | 'window'"
            />
          </div>
          <UsageChart
            :values="fiveHourChartValues"
            :labels="fiveHourChartLabels"
            :mode="fiveHourChartMode"
            :range="period"
            :partials="fiveHourPartials"
            kind="pct"
            unit="pct"
            :title="$t('usageHistory.chart.fiveHour')"
          />
          <div
            v-if="fiveHourMode === 'window' && fiveHourPartials.includes(true)"
            class="chart-subtitle"
          >
            {{ $t('usageHistory.chart.partialHint') }}
          </div>
        </div>
        <div>
          <div class="chart-head">
            <span>{{ $t('usageHistory.chart.sevenDay') }}</span>
            <span class="chart-cur tabular-nums">{{ current('seven') }}</span>
          </div>
          <UsageChart
            :values="series('seven')"
            :labels="barLabels"
            :mode="chartMode"
            :range="period"
            :marker-indices="sevenDayMarkers"
            kind="pct"
            unit="pct"
            :title="$t('usageHistory.chart.sevenDay')"
          />
          <div v-if="sevenDayMarkers.length" class="chart-subtitle">
            {{ $t('usageHistory.chart.resetMarkerHint') }}
          </div>
        </div>
        <div>
          <div class="chart-head">
            <span>{{ $t(costTitleKey) }}</span>
            <span class="chart-cur tabular-nums">{{ currentFrom(costChartValues, 'usd') }}</span>
          </div>
          <div class="chart-subtitle">
            {{
              hasRealDataInPeriod
                ? $t('usageHistory.chart.costRealHint')
                : $t('usageHistory.chart.costHint')
            }}
            <span v-if="hasRealDataInPeriod && hasEstimatedCost">
              {{ $t('usageHistory.chart.estimatedNote') }}
            </span>
          </div>
          <UsageChart
            :values="costChartValues"
            :labels="barLabels"
            :range="period"
            kind="plain"
            unit="usd"
            :title="$t(costTitleKey)"
          />
          <div v-if="hasRealDataInPeriod && notionalCostNow" class="chart-subtitle">
            {{ $t('usageHistory.chart.costLiveNotional', { v: notionalCostNow }) }}
          </div>
        </div>
        <div>
          <div class="chart-head">
            <span>{{
              hasRealDataInPeriod
                ? $t('usageHistory.chart.sessionsWorked')
                : $t('usageHistory.chart.sessions')
            }}</span>
            <span class="chart-cur tabular-nums">{{
              currentFrom(sessionsChartValues, 'count')
            }}</span>
          </div>
          <div class="chart-subtitle">
            {{
              hasRealDataInPeriod
                ? $t('usageHistory.chart.sessionsWorkedHint')
                : $t('usageHistory.chart.sessionsHint')
            }}
          </div>
          <UsageChart
            :values="sessionsChartValues"
            :labels="barLabels"
            :range="period"
            kind="plain"
            unit="count"
            :title="
              hasRealDataInPeriod
                ? $t('usageHistory.chart.sessionsWorked')
                : $t('usageHistory.chart.sessions')
            "
          />
          <div v-if="hasRealDataInPeriod && notionalSessionsNow" class="chart-subtitle">
            {{ $t('usageHistory.chart.sessionsPeakNotional', { v: notionalSessionsNow }) }}
          </div>
        </div>
      </div>

      <!-- Top models by real cost (T47 P5) — the smallest honest breakdown surface -->
      <section v-if="topModels.length">
        <div
          class="text-text-3"
          style="
            font-size: 11px;
            font-weight: 500;
            letter-spacing: 0.06em;
            text-transform: uppercase;
            margin-bottom: 8px;
          "
        >
          {{ $t('usageHistory.topModels.eyebrow') }}
        </div>
        <div class="top-models">
          <div v-for="m in topModels" :key="m.model" class="top-model-row">
            <span class="top-model-name font-mono text-text-2"
              >{{ m.model }}{{ m.estimated ? '*' : '' }}</span
            >
            <div class="top-model-bar-track bg-surface-2">
              <div class="top-model-bar-fill bg-accent" :style="{ width: m.pct + '%' }" />
            </div>
            <span class="top-model-cost text-text tabular-nums">{{
              fmtUnit(m.costUsd, 'usd')
            }}</span>
            <span class="top-model-requests text-text-4">{{
              $t('usageHistory.topModels.requests', { n: m.requestCount })
            }}</span>
          </div>
        </div>
        <div v-if="hasEstimatedCost" class="text-text-4" style="font-size: 10px; margin-top: 6px">
          {{ $t('usageHistory.chart.estimatedNote') }}
        </div>
      </section>

      <!-- Plan-fit calculator -->
      <PlanFitCard
        v-model:from-tier="fromTier"
        v-model:to-tier="toTier"
        v-model:ratio-override="ratioOverride"
        v-model:scope-days="scopeDays"
        :tiers="[...tiers]"
        :result="planFit"
        :recommendation="recommendation"
        :coverage-total="coverageTotal"
        :coverage-complete="coverageComplete"
        :peaks5h="peaks5h"
        :quota-as-of="summary?.quotaAsOf ?? ''"
      />

      <!-- When you use it — weekday × hour heatmap -->
      <section v-if="summary!.heatmap.maxAvgPct != null">
        <div
          class="text-text-3"
          style="
            font-size: 11px;
            font-weight: 500;
            letter-spacing: 0.06em;
            text-transform: uppercase;
            margin-bottom: 10px;
          "
        >
          {{ $t('usageHistory.heatmap.eyebrow') }}
        </div>
        <UsageHeatmap :heatmap="summary!.heatmap" />
        <div class="text-text-3" style="font-size: 10.5px; line-height: 1.5; margin-top: 8px">
          {{ $t('usageHistory.heatmap.note') }}
        </div>
      </section>

      <!-- Chat over the data -->
      <section>
        <div
          class="text-text-3"
          style="
            font-size: 11px;
            font-weight: 500;
            letter-spacing: 0.06em;
            text-transform: uppercase;
            margin-bottom: 8px;
          "
        >
          {{ $t('usageHistory.chat.eyebrow') }}
        </div>
        <!-- Suggested questions — an empty field has high friction -->
        <div class="chat-chips" style="margin-bottom: 8px">
          <button
            v-for="c in chatChips"
            :key="c.key"
            type="button"
            :disabled="chatLoading"
            @click="askChat($t(c.key))"
          >
            {{ $t(c.key) }}
          </button>
        </div>
        <div class="flex" style="gap: 8px">
          <input
            v-model="chatQuestion"
            type="text"
            :placeholder="$t('usageHistory.chat.placeholder')"
            class="flex-1 border border-border bg-surface text-text"
            style="padding: 6px 10px; font-size: 12px; border-radius: 5px; height: 30px"
            @keydown.enter="askChat()"
          />
          <button
            type="button"
            class="border border-border bg-surface text-text transition hover:bg-surface-2 disabled:opacity-50"
            style="padding: 6px 14px; font-size: 12px; border-radius: 5px; height: 30px"
            :disabled="chatLoading || !chatQuestion.trim()"
            @click="askChat()"
          >
            {{ chatLoading ? $t('usageHistory.chat.asking') : $t('usageHistory.chat.ask') }}
          </button>
        </div>
        <div
          v-if="chatAnswer"
          class="text-text-2"
          style="font-size: 12px; line-height: 1.6; margin-top: 10px; white-space: pre-wrap"
        >
          {{ chatAnswer }}
        </div>
        <div v-else-if="chatError" class="text-text-3" style="font-size: 11.5px; margin-top: 10px">
          {{ $t('usageHistory.chat.error') }}
        </div>
        <div class="text-text-3" style="font-size: 10.5px; line-height: 1.5; margin-top: 8px">
          {{ $t('usageHistory.chat.grounding') }}
        </div>
      </section>

      <!-- Config -->
      <section v-if="prefs">
        <div
          class="text-text-3"
          style="
            font-size: 11px;
            font-weight: 500;
            letter-spacing: 0.06em;
            text-transform: uppercase;
            margin-bottom: 8px;
          "
        >
          {{ $t('usageHistory.config.eyebrow') }}
        </div>

        <!-- Capture opt-out -->
        <div class="flex items-start justify-between" style="gap: 12px; margin-bottom: 12px">
          <div style="flex: 1; min-width: 0">
            <div class="text-text-2" style="font-size: 12px">
              {{ $t('usageHistory.config.captureLabel') }}
            </div>
            <SettingHint>{{ $t('usageHistory.config.captureHint') }}</SettingHint>
          </div>
          <ToggleSwitch
            :model-value="prefs.enabled"
            :aria-label="$t('usageHistory.config.captureLabel')"
            @update:model-value="setPrefs({ enabled: $event })"
          />
        </div>

        <!-- Current plan tier -->
        <div class="flex items-center justify-between" style="gap: 12px; margin-bottom: 12px">
          <span class="text-text-2" style="font-size: 12px">{{
            $t('usageHistory.config.currentTier')
          }}</span>
          <SegmentedControl
            :options="tiers.map((t) => ({ value: t.id, label: t.label }))"
            :model-value="prefs.currentTier"
            size="sm"
            :aria-label="$t('usageHistory.config.currentTier')"
            @update:model-value="setPrefs({ currentTier: $event as string })"
          />
        </div>

        <!-- Chat model -->
        <div class="flex items-center justify-between" style="gap: 12px; margin-bottom: 12px">
          <span class="text-text-2" style="font-size: 12px">{{
            $t('usageHistory.config.chatModel')
          }}</span>
          <input
            type="text"
            :value="prefs.chatModel"
            class="border border-border bg-surface text-text"
            style="
              padding: 5px 8px;
              font-size: 12px;
              border-radius: 5px;
              height: 28px;
              width: 120px;
            "
            @change="
              setPrefs({ chatModel: ($event.target as HTMLInputElement).value.trim() || 'haiku' })
            "
          />
        </div>

        <!-- Retention -->
        <div class="flex items-center justify-between" style="gap: 12px">
          <span class="text-text-2" style="font-size: 12px">{{
            $t('usageHistory.config.retention')
          }}</span>
          <SegmentedControl
            :options="retentionOptions.map((o) => ({ value: o.value, label: $t(o.key) }))"
            :model-value="prefs.retentionDays"
            :aria-label="$t('usageHistory.config.retention')"
            @update:model-value="setPrefs({ retentionDays: $event as number | 'forever' })"
          />
        </div>

        <!-- Daily budget: which weekdays the weekly allowance is split across -->
        <div style="margin-top: 12px">
          <div class="text-text-2" style="font-size: 12px">
            {{ $t('usageHistory.config.workingDays') }}
          </div>
          <SettingHint>{{ $t('usageHistory.config.workingDaysHint') }}</SettingHint>
          <div
            class="flex"
            role="group"
            :aria-label="$t('usageHistory.config.workingDays')"
            style="gap: 5px; margin-top: 13px"
          >
            <button
              v-for="d in WEEKDAY_ORDER"
              :key="d"
              type="button"
              :data-working-day="d"
              :aria-pressed="workingDays.includes(d)"
              class="border"
              :class="
                workingDays.includes(d)
                  ? 'bg-accent-soft border-accent-line text-text'
                  : 'border-border-2 text-text-3'
              "
              style="
                width: 38px;
                height: 28px;
                border-radius: 5px;
                font-size: 11px;
                font-weight: 500;
              "
              @click="setPrefs({ workingDays: toggleWorkingDay(workingDays, d) })"
            >
              {{ $t(`usageHistory.config.weekday${d}`) }}
            </button>
          </div>
          <div
            class="text-text-2 tabular-nums"
            data-working-days-readout
            style="font-size: 11.5px; margin-top: 11px"
          >
            {{ $t('usageHistory.config.workingDaysCount', workingDaysPreview) }}
          </div>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
/* Chart caption row: label on the left, the "now/today" reading on the right —
   the single most-important number, legible without hovering (design §6 T47 P3). */
.chart-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 4px;
  font-size: 11.5px;
  color: var(--color-text-3);
}
.chart-cur {
  font-size: 11px;
  color: var(--color-text-2);
}
/* Honesty subtitle under a chart label that could otherwise be misread (e.g.
   "peak" cost/sessions vs a plain daily figure — design §6 T47 P4.5). */
.chart-subtitle {
  font-size: 9.5px;
  color: var(--color-text-4);
  margin-top: -2px;
  margin-bottom: 4px;
}
.chat-chips {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.chat-chips button {
  font-size: 11px;
  color: var(--color-text-2);
  background: var(--color-surface);
  border: 1px solid var(--color-border-2);
  border-radius: 999px;
  padding: 4px 11px;
  cursor: pointer;
  transition: background var(--dur) var(--ease);
}
.chat-chips button:hover:not(:disabled) {
  background: var(--color-surface-2);
}
.chat-chips button:disabled {
  opacity: 0.5;
  cursor: default;
}
/* Top-models list (T47 P5) — a ranked bar list, not a new chart type. Colors
   come from Tailwind utility classes on the elements (bg-surface-2/bg-accent/
   text-*); this block is layout-only. */
.top-models {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.top-model-row {
  display: grid;
  grid-template-columns: 150px 1fr 68px 92px;
  align-items: center;
  gap: 10px;
  font-size: 11.5px;
}
.top-model-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.top-model-bar-track {
  height: 6px;
  border-radius: 999px;
  overflow: hidden;
}
.top-model-bar-fill {
  height: 100%;
  border-radius: 999px;
  transition: width var(--dur) var(--ease);
}
.top-model-cost {
  text-align: right;
}
.top-model-requests {
  font-size: 10px;
  text-align: right;
}
</style>
