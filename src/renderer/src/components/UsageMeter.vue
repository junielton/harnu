<script setup lang="ts">
import { computed } from 'vue'
import { clampPct, barClass } from './usage-format'

/**
 * One Plan-usage window row (design.md §6 — Plan usage). Purely presentational:
 * the parent `UsagePanel` resolves the i18n label and the reset countdown, so
 * this component takes plain props and owns only the bar + threshold color.
 */
const props = defineProps<{
  label: string
  usedPercent: number
  resetLabel: string
  /** Absolute reset string shown as a tooltip when a relative label is displayed. */
  resetTitle?: string
}>()

const pct = computed(() => clampPct(props.usedPercent))
const fillClass = computed(() => barClass(props.usedPercent))
const displayPct = computed(() => Math.round(pct.value))
</script>

<template>
  <div class="flex flex-col" style="gap: 3px">
    <div class="flex items-center justify-between" style="font-size: 11px">
      <span class="truncate text-text-3">{{ label }}</span>
      <span class="tabular-nums text-text-2">{{ displayPct }}%</span>
    </div>
    <div class="overflow-hidden rounded-full bg-surface-2" style="height: 3px">
      <div
        data-usage-fill
        class="usage-fill h-full rounded-full"
        :class="fillClass"
        :style="{ width: pct + '%' }"
      />
    </div>
    <span
      v-if="resetLabel"
      data-usage-reset
      class="tabular-nums text-text-4"
      style="font-size: 11px"
      :title="resetTitle || undefined"
      >{{ resetLabel }}</span
    >
  </div>
</template>
