<script setup lang="ts">
import { computed } from 'vue'
import type { DailyBudget } from './daily-budget'

/**
 * The derived daily-budget row of the Plan usage panel (design.md §6, daily-budget
 * spec). Purely presentational: the store owns the math, this owns the bar, the
 * threshold color and the state line. The bar tracks spend ÷ BUDGET, not the raw
 * percentage, so it can reach 100% within a single day.
 */
const props = defineProps<{ budget: DailyBudget }>()

/**
 * A day off has no budget to measure against, so it gets no track at all —
 * spending on a day off is a choice, not an overrun (design.md §6).
 */
const showTrack = computed(
  () =>
    props.budget.state === 'on-track' ||
    props.budget.state === 'near-limit' ||
    props.budget.state === 'over'
)

const barPct = computed(() => {
  const { spentPct, budgetPct } = props.budget
  // Only reachable while `over`: the week's allowance was already gone before
  // the day began, so there is no denominator — the bar is simply full.
  if (budgetPct <= 0) return 100
  return Math.min(100, Math.max(0, (spentPct / budgetPct) * 100))
})

const fillClass = computed(() => {
  if (props.budget.state === 'over') return 'bg-red'
  if (props.budget.state === 'near-limit') return 'bg-accent'
  return 'bg-green'
})

const valueParams = computed(() => ({
  spent: Math.round(props.budget.spentPct),
  budget: Math.round(props.budget.budgetPct)
}))

const subKey = computed(() => {
  switch (props.budget.state) {
    case 'day-off':
      return 'usage.dailyBudgetDayOff'
    case 'near-limit':
      return 'usage.dailyBudgetLeft'
    case 'over':
      return props.budget.rebalancedPct === null
        ? 'usage.dailyBudgetOverSpent'
        : 'usage.dailyBudgetOver'
    default:
      return 'usage.dailyBudgetOnTrack'
  }
})

const subParams = computed<Record<string, number>>(() => {
  const b = props.budget
  const params: Record<string, number> = {}
  if (b.state === 'near-limit') {
    // Differenced from the DISPLAYED figures, not the raw ones: rounding the
    // remainder on its own lets the row contradict itself — `13% / 17%` with
    // `3% left today` — for spends whose fractions round in opposite directions.
    params.pct = Math.max(0, valueParams.value.budget - valueParams.value.spent)
  } else if (b.state === 'over' && b.rebalancedPct !== null) {
    params.days = b.remainingDays
    params.pct = Math.round(b.rebalancedPct)
  }
  return params
})
</script>

<template>
  <div v-if="budget.state !== 'unavailable'" class="flex flex-col" style="gap: 3px">
    <div class="flex items-center justify-between" style="font-size: 11px">
      <span class="truncate text-text-3">{{ $t('usage.dailyBudget') }}</span>
      <span
        data-budget-value
        class="tabular-nums"
        :class="budget.state === 'over' ? 'font-semibold text-red' : 'text-text-2'"
      >
        {{
          budget.state === 'day-off'
            ? `${Math.round(budget.spentPct)}%`
            : $t('usage.dailyBudgetValue', valueParams)
        }}
      </span>
    </div>
    <div
      v-if="showTrack"
      data-budget-track
      class="overflow-hidden rounded-full bg-surface-2"
      style="height: 3px"
    >
      <div
        data-budget-fill
        class="usage-fill h-full rounded-full"
        :class="fillClass"
        :style="{ width: barPct + '%' }"
      />
    </div>
    <span
      data-budget-sub
      class="tabular-nums"
      :class="budget.state === 'over' ? 'text-red' : 'text-text-4'"
      style="font-size: 11px"
      >{{ $t(subKey, subParams) }}</span
    >
  </div>
</template>
