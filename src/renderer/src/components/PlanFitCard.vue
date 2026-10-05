<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { verdictTone, fmtPct, pickSentenceStat } from './usage-history-format'
import SegmentedControl from './ui/SegmentedControl.vue'
import UsageDistribution from './UsageDistribution.vue'
import type { PlanFitResult, PlanTier, TierRecommendation } from '../../../preload'

/**
 * Plan-fit calculator card (issue #19, layer 2; T47 P2). Presentational: the
 * parent pane owns the IPC, the selected tiers, the recency scope, and the
 * coverage counts; this card renders the tier pickers, the manual ratio
 * override, the scope chips, the one-sentence verdict (with the exceed count —
 * the number the table's percentiles bury), the smallest-plan-that-fits
 * recommendation, the per-window table, the coverage note, and the
 * `PLAN_QUOTA_AS_OF` disclaimer. The math is deterministic (`projectPlanFit` /
 * `recommendTier`); nothing here guesses — `insufficient_data` is shown as-is.
 */
const props = defineProps<{
  tiers: PlanTier[]
  fromTier: string
  toTier: string
  ratioOverride: number | null
  /** Recency scope in days; 0 = all-time. */
  scopeDays: number
  result: PlanFitResult | null
  recommendation: TierRecommendation | null
  /** Windows inside the scope (incl. partial) / fully-observed ones — coverage note. */
  coverageTotal: number
  coverageComplete: number
  /** Raw complete-5h-window peaks in scope — drives the dot distribution. */
  peaks5h: number[]
  quotaAsOf: string
}>()

const emit = defineEmits<{
  'update:fromTier': [string]
  'update:toTier': [string]
  'update:ratioOverride': [number | null]
  'update:scopeDays': [number]
}>()

const { t } = useI18n()

const eitherPlaceholder = computed(() =>
  props.tiers.some((x) => (x.id === props.fromTier || x.id === props.toTier) && x.toConfirm)
)

function onRatioInput(e: Event): void {
  const raw = (e.target as HTMLInputElement).value.trim()
  const n = Number(raw)
  emit('update:ratioOverride', raw === '' || !Number.isFinite(n) || n <= 0 ? null : n)
}

const stats = computed(() => props.result?.stats ?? [])

// One mapping shared by both tier pickers (avoids re-mapping `tiers` twice per render).
const tierSegOptions = computed(() => props.tiers.map((t) => ({ value: t.id, label: t.label })))

const scopeOptions = computed(() => [
  { value: 30, label: t('usageHistory.scope.d30') },
  { value: 60, label: t('usageHistory.scope.d60') },
  { value: 90, label: t('usageHistory.scope.d90') },
  { value: 0, label: t('usageHistory.scope.all') }
])

function tierLabel(id: string): string {
  return props.tiers.find((x) => x.id === id)?.label ?? id
}

function windowLabel(kind: string): string {
  return t(kind === 'fiveHour' ? 'footer.fiveHour' : 'footer.sevenDay')
}

/** How many of a stat's windows the projection blows past 100% on. */
function exceedCount(s: { exceedRate: number; count: number }): number {
  return Math.round(s.exceedRate * s.count)
}

// One-sentence verdict, driven by the same stat that decided it (T47 P2 —
// `exceedRate` is the number users actually ask about, not p95).
const sentence = computed(() => {
  const r = props.result
  if (!r || r.verdict === 'insufficient_data') return ''
  const s = pickSentenceStat(r)
  if (!s) return ''
  return t(`usageHistory.planFit.sentence.${r.verdict}`, {
    tier: tierLabel(r.toTier),
    win: windowLabel(s.kind),
    n: exceedCount(s),
    total: s.count,
    pct: Math.round(s.exceedRate * 100),
    p95: fmtPct(s.projectedP95Pct)
  })
})
</script>

<template>
  <div class="border border-border bg-surface" style="border-radius: 7px; padding: 12px">
    <div
      class="flex items-center justify-between"
      style="gap: 10px; margin-bottom: 10px; flex-wrap: wrap"
    >
      <span class="text-text-2" style="font-size: 12px; font-weight: 600">{{
        $t('usageHistory.planFit.title')
      }}</span>
      <SegmentedControl
        :options="scopeOptions"
        :model-value="scopeDays"
        size="sm"
        :aria-label="$t('usageHistory.scope.label')"
        @update:model-value="emit('update:scopeDays', $event as number)"
      />
    </div>

    <!-- Tier pickers + ratio override -->
    <div class="flex flex-col items-start" style="gap: 10px; margin-bottom: 12px">
      <div class="flex flex-col" style="gap: 4px">
        <span class="text-text-3" style="font-size: 10.5px">{{
          $t('usageHistory.planFit.currentTier')
        }}</span>
        <SegmentedControl
          :options="tierSegOptions"
          :model-value="fromTier"
          size="sm"
          :aria-label="$t('usageHistory.planFit.currentTier')"
          @update:model-value="emit('update:fromTier', $event as string)"
        />
      </div>
      <div class="flex flex-col" style="gap: 4px">
        <span class="text-text-3" style="font-size: 10.5px">{{
          $t('usageHistory.planFit.targetTier')
        }}</span>
        <SegmentedControl
          :options="tierSegOptions"
          :model-value="toTier"
          size="sm"
          :aria-label="$t('usageHistory.planFit.targetTier')"
          @update:model-value="emit('update:toTier', $event as string)"
        />
      </div>
      <label class="flex flex-col" style="gap: 4px">
        <span class="text-text-3" style="font-size: 10.5px">{{
          $t('usageHistory.planFit.ratioOverride')
        }}</span>
        <input
          type="number"
          min="0"
          step="0.1"
          :placeholder="result?.ratio != null ? String(result.ratio) : '—'"
          :value="ratioOverride ?? ''"
          class="border border-border bg-surface text-text tabular-nums"
          style="padding: 5px 8px; font-size: 12px; border-radius: 5px; height: 28px; width: 76px"
          @input="onRatioInput"
        />
      </label>
    </div>

    <!-- Verdict: signal word + the one-sentence read with the exceed count -->
    <div class="flex items-baseline" style="gap: 6px; margin-bottom: 6px">
      <span class="text-text-3" style="font-size: 11.5px">{{
        $t('usageHistory.planFit.verdictLabel')
      }}</span>
      <span
        :class="verdictTone(result?.verdict ?? 'insufficient_data')"
        style="font-size: 12.5px; font-weight: 600"
      >
        {{ $t('usageHistory.verdict.' + (result?.verdict ?? 'insufficient_data')) }}
      </span>
    </div>
    <p
      v-if="sentence"
      class="text-text-2"
      style="font-size: 12px; line-height: 1.55; margin: 0 0 10px; max-width: 58ch"
    >
      {{ sentence }}
    </p>

    <!-- Smallest plan that fits (deterministic scan over all tiers) -->
    <div
      v-if="recommendation"
      class="bg-green-soft text-text-2"
      style="
        display: flex;
        align-items: baseline;
        gap: 6px;
        width: fit-content;
        border-radius: 5px;
        padding: 6px 10px;
        font-size: 12px;
        margin-bottom: 12px;
      "
    >
      <span class="text-green" style="font-weight: 600">
        {{ $t('usageHistory.planFit.recommended', { tier: tierLabel(recommendation.tierId) }) }}
        <template v-if="recommendation.verdict === 'tight'">
          ({{ $t('usageHistory.verdict.tight') }})</template
        >
      </span>
      <span v-if="recommendation.tierId === fromTier" class="text-text-3" style="font-size: 11px">
        {{ $t('usageHistory.planFit.recommendedCurrent') }}
      </span>
    </div>

    <!-- Peak distribution as dot strips (observed vs projected, 100% line) -->
    <UsageDistribution
      v-if="peaks5h.length"
      :peaks="peaks5h"
      :ratio="result?.ratio ?? null"
      :from-label="tierLabel(fromTier)"
      :to-label="tierLabel(toTier)"
      style="margin-bottom: 12px"
    />

    <!-- Per-window peak distribution + projection -->
    <table v-if="stats.length" class="w-full tabular-nums" style="font-size: 11.5px">
      <thead>
        <tr class="text-text-4" style="text-align: right">
          <th style="text-align: left; font-weight: 500; padding: 2px 0">
            {{ $t('usageHistory.planFit.window') }}
          </th>
          <th style="font-weight: 500">n</th>
          <th style="font-weight: 500">{{ $t('usageHistory.planFit.median') }}</th>
          <th style="font-weight: 500">p95</th>
          <th style="font-weight: 500">max</th>
          <th style="font-weight: 500">{{ $t('usageHistory.planFit.projected') }}</th>
          <th style="font-weight: 500">{{ $t('usageHistory.planFit.exceed') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="s in stats" :key="s.kind" class="text-text-2" style="text-align: right">
          <td style="text-align: left; padding: 3px 0">{{ windowLabel(s.kind) }}</td>
          <td>{{ s.count }}</td>
          <td>{{ fmtPct(s.medianPct) }}</td>
          <td>{{ fmtPct(s.p95Pct) }}</td>
          <td>{{ fmtPct(s.maxPct) }}</td>
          <td :class="s.projectedP95Pct >= 100 ? 'text-red' : 'text-text'">
            {{ fmtPct(s.projectedP95Pct) }}
          </td>
          <td :class="exceedCount(s) > 0 ? 'text-red' : 'text-text'">
            {{ exceedCount(s) }}/{{ s.count }}
          </td>
        </tr>
      </tbody>
    </table>
    <div v-else class="text-text-3" style="font-size: 11.5px">
      {{ $t('usageHistory.planFit.needMore') }}
    </div>

    <!-- Coverage (replaces the old all-time "N partial windows" warning) + disclaimer -->
    <div class="text-text-3" style="font-size: 10.5px; line-height: 1.5; margin-top: 10px">
      <template v-if="coverageTotal > 0">
        {{ $t('usageHistory.coverage', { complete: coverageComplete, total: coverageTotal }) }}
      </template>
      {{ $t('usageHistory.planFit.asOf', { date: quotaAsOf }) }}
      <span v-if="eitherPlaceholder">{{ $t('usageHistory.planFit.placeholderNote') }}</span>
    </div>
  </div>
</template>
