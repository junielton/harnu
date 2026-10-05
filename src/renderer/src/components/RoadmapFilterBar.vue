<script setup lang="ts">
/**
 * Roadmap board filter bar (T80 S2 PR2, design.md §6 "Filter bar"). Sticky row
 * under the board header: search (live, ephemeral), kind chips (opt-out —
 * zero active means "no filter"), a Group segmented control, and a Hide-done
 * toggle. Fully controlled — the parent (`RoadmapBoard.vue`) owns the state
 * and its per-repo persistence (E9); this component only renders + emits.
 */
import { useI18n } from 'vue-i18n'
import { Search } from 'lucide-vue-next'
import SegmentedControl from './ui/SegmentedControl.vue'
import ToggleSwitch from './ui/ToggleSwitch.vue'
import Button from './ui/Button.vue'
import { KIND_FILTERS, type GroupMode } from '../lib/board-filters'

const { t } = useI18n()

const props = defineProps<{
  search: string
  activeKinds: readonly string[]
  group: GroupMode
  hideDone: boolean
  /** T190: distinct branches present across the loaded cards (origin OR owner, deduped). */
  worktreeOptions: readonly string[]
  /** T190: the active scope's branch, or null for "All worktrees". */
  worktreeScope: string | null
}>()

const emit = defineEmits<{
  'update:search': [string]
  'update:activeKinds': [string[]]
  'update:group': [GroupMode]
  'update:hideDone': [boolean]
  /** T190: null clears the scope back to "All worktrees". */
  'update:worktreeScope': [string | null]
  /** T80 S2 PR3 (B8): `+ New card` — the board opens the create-mode modal. */
  newCard: []
}>()

function onWorktreeChange(e: Event): void {
  const value = (e.target as HTMLSelectElement).value
  emit('update:worktreeScope', value === '' ? null : value)
}

function isKindOn(kind: string): boolean {
  return props.activeKinds.includes(kind)
}

function toggleKind(kind: string): void {
  const next = isKindOn(kind)
    ? props.activeKinds.filter((k) => k !== kind)
    : [...props.activeKinds, kind]
  emit('update:activeKinds', next)
}

const GROUP_OPTIONS: { value: GroupMode; label: string }[] = [
  { value: 'epic', label: 'epic' },
  { value: 'kind', label: 'kind' },
  { value: 'none', label: 'none' }
]

function onGroupChange(v: string | number | boolean | undefined): void {
  if (v === 'epic' || v === 'kind' || v === 'none') emit('update:group', v)
}
</script>

<template>
  <div
    class="scrollable flex h-[38px] shrink-0 items-center gap-2 overflow-x-auto border-b border-border bg-bg px-3"
  >
    <!-- Search -->
    <div
      class="flex h-[26px] w-[200px] shrink-0 items-center gap-1.5 rounded-sm border border-border-2 bg-surface px-2 text-text-3 focus-within:border-accent-line"
    >
      <Search :size="13" :stroke-width="1.8" class="shrink-0" />
      <input
        type="text"
        class="h-full w-full min-w-0 bg-transparent text-[12px] text-text outline-none placeholder:text-text-4"
        :placeholder="t('roadmap.filterBar.searchPlaceholder')"
        :aria-label="t('roadmap.filterBar.searchLabel')"
        :value="search"
        @input="emit('update:search', ($event.target as HTMLInputElement).value)"
      />
    </div>

    <!-- Kind chips -->
    <div
      class="flex items-center gap-1"
      role="group"
      :aria-label="t('roadmap.filterBar.kindsLabel')"
    >
      <button
        v-for="kind in KIND_FILTERS"
        :key="kind"
        type="button"
        class="rounded-full border px-2 py-0.5 text-[11px] transition-opacity"
        :class="
          isKindOn(kind)
            ? 'border-accent-line bg-accent-soft text-text-2'
            : 'border-border-2 bg-surface text-text-3 opacity-40 hover:opacity-70'
        "
        :aria-pressed="isKindOn(kind)"
        @click="toggleKind(kind)"
      >
        {{ kind }}
      </button>
    </div>

    <span class="h-[18px] w-px shrink-0 bg-border" />

    <div class="flex shrink-0 items-center gap-1.5">
      <span class="text-[11px] text-text-4">{{ t('roadmap.filterBar.group') }}</span>
      <SegmentedControl
        :model-value="group"
        :options="GROUP_OPTIONS"
        size="sm"
        :aria-label="t('roadmap.filterBar.groupAriaLabel')"
        @update:model-value="onGroupChange"
      />
    </div>

    <span class="h-[18px] w-px shrink-0 bg-border" />

    <label class="flex cursor-pointer items-center gap-1.5 text-[11px] text-text-3">
      <ToggleSwitch
        :model-value="hideDone"
        :aria-label="t('roadmap.filterBar.hideDone')"
        @update:model-value="(v: boolean) => emit('update:hideDone', v)"
      />
      {{ t('roadmap.filterBar.hideDone') }}
    </label>

    <template v-if="worktreeOptions.length > 0">
      <span class="h-[18px] w-px shrink-0 bg-border" />

      <span class="text-[11px] text-text-4">{{ t('roadmap.filterBar.worktree.label') }}</span>
      <select
        class="h-[24px] shrink-0 rounded-sm border border-border-2 bg-surface px-1.5 text-[11px] text-text-2 outline-none focus:border-accent-line"
        :aria-label="t('roadmap.filterBar.worktree.label')"
        :value="worktreeScope ?? ''"
        @change="onWorktreeChange"
      >
        <option value="">{{ t('roadmap.filterBar.worktree.all') }}</option>
        <option v-for="branch in worktreeOptions" :key="branch" :value="branch">
          {{ branch }}
        </option>
      </select>
    </template>

    <span class="flex-1" />

    <!-- + New card (T80 S2 PR3, B8) -->
    <Button variant="primary" class="shrink-0" @click="emit('newCard')">
      + {{ t('roadmap.filterBar.newCard') }}
    </Button>
  </div>
</template>
