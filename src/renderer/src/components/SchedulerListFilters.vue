<script setup lang="ts">
/**
 * The Scheduler list's search field, Collapse all / Expand all button and state
 * chips (T590 — approved mockup `pastas--combinada`). Pure presentation: the view
 * owns the query, the active chip and the collapsed set. Chip counts arrive
 * already computed (they follow the current search).
 */
import { useI18n } from 'vue-i18n'
import { ChevronsDownUp, ChevronsUpDown, Search } from 'lucide-vue-next'
import { STATE_FILTERS, type StateFilter } from './scheduler-list'

defineProps<{
  query: string
  filter: StateFilter
  counts: Record<StateFilter, number>
  /** Every visible folder group is collapsed → the button reads "Expand all". */
  allCollapsed: boolean
}>()

const emit = defineEmits<{
  'update:query': [value: string]
  'update:filter': [value: StateFilter]
  'toggle-all': []
}>()

const { t } = useI18n()

const LABEL_KEY: Record<StateFilter, string> = {
  all: 'scheduler.list.chipAll',
  running: 'scheduler.list.chipRunning',
  failing: 'scheduler.list.chipFailing',
  waiting: 'scheduler.list.chipWaiting',
  off: 'scheduler.list.chipOff'
}
const INK: Record<StateFilter, string> = {
  all: 'text-text-3',
  running: 'text-green',
  failing: 'text-red',
  waiting: 'text-text-3',
  off: 'text-text-4'
}
const DOT: Record<StateFilter, string> = {
  all: '',
  running: 'bg-green',
  failing: 'bg-red',
  waiting: 'bg-text-4',
  off: 'bg-text-disabled'
}
const ACTIVE: Record<StateFilter, string> = {
  all: 'bg-surface-2',
  running: 'bg-green-soft border-green-line',
  failing: 'bg-red-soft border-red-line',
  waiting: 'bg-surface-2',
  off: 'bg-surface-2'
}
</script>

<template>
  <div class="flex-none" data-list-filters>
    <div class="mx-2.5 mt-2 flex items-center gap-1">
      <label
        class="flex h-[26px] min-w-0 flex-1 items-center gap-1.5 rounded-sm border border-border-2 bg-bg px-2 text-[11px] text-text-4 focus-within:border-accent-line"
      >
        <Search :size="11" :stroke-width="1.8" class="shrink-0" aria-hidden="true" />
        <input
          type="text"
          class="min-w-0 flex-1 bg-transparent text-[11px] text-text outline-none placeholder:text-text-4"
          :value="query"
          :placeholder="t('scheduler.list.searchPlaceholder')"
          :aria-label="t('scheduler.list.searchLabel')"
          data-list-search
          @input="emit('update:query', ($event.target as HTMLInputElement).value)"
        />
      </label>
      <button
        type="button"
        class="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-sm text-text-3 transition hover:bg-surface-2 hover:text-text"
        :aria-label="allCollapsed ? t('scheduler.list.expandAll') : t('scheduler.list.collapseAll')"
        :title="allCollapsed ? t('scheduler.list.expandAll') : t('scheduler.list.collapseAll')"
        data-toggle-all
        :data-mode="allCollapsed ? 'expand' : 'collapse'"
        @click="emit('toggle-all')"
      >
        <ChevronsUpDown v-if="allCollapsed" :size="12" :stroke-width="1.8" />
        <ChevronsDownUp v-else :size="12" :stroke-width="1.8" />
      </button>
    </div>

    <div
      class="flex flex-wrap gap-1 border-b border-border px-2.5 py-2"
      role="group"
      :aria-label="t('scheduler.list.chipsLabel')"
    >
      <button
        v-for="f in STATE_FILTERS"
        :key="f"
        type="button"
        class="inline-flex h-5 items-center gap-[5px] rounded-sm border border-border-2 bg-transparent px-[7px] text-[11px] transition-colors"
        :class="[INK[f], filter === f ? ACTIVE[f] : 'hover:bg-surface']"
        :aria-pressed="filter === f"
        :data-chip="f"
        @click="emit('update:filter', f)"
      >
        <span v-if="DOT[f]" class="h-1.5 w-1.5 shrink-0 rounded-full" :class="DOT[f]" />
        {{ t(LABEL_KEY[f]) }}
        <b class="font-semibold text-text">{{ counts[f] }}</b>
      </button>
    </div>
  </div>
</template>
