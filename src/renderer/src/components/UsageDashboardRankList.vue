<script setup lang="ts">
import { computed } from 'vue'

/** One ranked-list row — generic across models/projects/sessions. */
export interface RankRow {
  key: string
  name: string
  color: string
  value: number
  valueLabel: string
  secondaryLabel: string
  /** Full-length name (e.g. the project's absolute path) for a hover tooltip when `name` is shortened. */
  title?: string
  /** Dims the row (e.g. filtered-out by the model chips) without removing it. */
  dimmed?: boolean
  /** Highlights the row (e.g. the currently-selected session). */
  active?: boolean
}

/**
 * Generic ranked list — design.md "Usage Dashboard (takeover)" § Coluna
 * direita. Reused 3× (Top models / Top projects / Top sessions): position,
 * name + proportion bar, value + secondary metric. Clicking a row emits
 * `select` — the parent decides what that means (toggle a model filter,
 * select a session).
 */
const props = defineProps<{ rows: RankRow[]; emptyLabel: string }>()
const emit = defineEmits<{ select: [string] }>()

const maxValue = computed(() => Math.max(1, ...props.rows.map((r) => r.value)))
</script>

<template>
  <div class="flex flex-col gap-2">
    <div v-if="rows.length === 0" class="py-4 text-center text-[12px] text-text-3">
      {{ emptyLabel }}
    </div>
    <button
      v-for="(row, i) in rows"
      :key="row.key"
      type="button"
      class="grid grid-cols-[18px_1fr_auto] items-center gap-2 rounded-sm px-1 py-1 text-left transition-colors hover:bg-surface-2"
      :class="[row.dimmed ? 'opacity-40' : '', row.active ? 'bg-accent-soft' : '']"
      @click="emit('select', row.key)"
    >
      <span class="text-right text-[11px] text-text-4">{{ i + 1 }}</span>
      <div class="min-w-0">
        <div class="mb-0.5 truncate text-[12px] text-text" :title="row.title ?? row.name">
          {{ row.name }}
        </div>
        <div class="h-[5px] overflow-hidden rounded-full bg-surface-2">
          <div
            class="h-full rounded-full"
            :style="{ width: (row.value / maxValue) * 100 + '%', background: row.color }"
          />
        </div>
      </div>
      <div class="whitespace-nowrap text-right">
        <span class="block tabular-nums text-[12px] font-bold text-text">{{ row.valueLabel }}</span>
        <span class="tabular-nums text-[10.5px] text-text-4">{{ row.secondaryLabel }}</span>
      </div>
    </button>
  </div>
</template>
