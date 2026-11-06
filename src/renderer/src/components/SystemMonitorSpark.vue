<script setup lang="ts">
import { computed } from 'vue'
import { sparklinePolylines } from './system-monitor-format'

/**
 * A 60s sparkline (design.md "System Monitor (takeover)" → "Sparklines and the ring
 * buffer"): one `<polyline>` per unbroken run of readings, stroked in the folder hue
 * (`--fh` from the owning `.fh-*` class). Fewer than two readings draw nothing, but the
 * box keeps its size so the layout never jumps when the first samples arrive.
 */
const props = withDefaults(
  defineProps<{
    values: readonly (number | null)[]
    width: number
    height: number
    strokeWidth?: number
  }>(),
  { strokeWidth: 1.3 }
)

const lines = computed(() => sparklinePolylines(props.values, props.width, props.height))
</script>

<template>
  <svg
    class="block shrink-0"
    :width="width"
    :height="height"
    :viewBox="`0 0 ${width} ${height}`"
    aria-hidden="true"
    data-testid="sparkline"
  >
    <polyline
      v-for="(points, i) in lines"
      :key="i"
      :points="points"
      fill="none"
      class="stroke-[var(--fh)]"
      :stroke-width="strokeWidth"
      stroke-linejoin="round"
      stroke-linecap="round"
    />
  </svg>
</template>
