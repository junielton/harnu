<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Minus, Pause, Plus } from 'lucide-vue-next'
import { useRoadmapStore, WIP_LIMIT_BOUNDS } from '../stores/roadmap'
import { useRoadmapDrainStore } from '../stores/roadmap-drain'

/**
 * Board header WIP chip (design.md §6, BUG-197). Shows the LIVE In Progress count
 * against the repo's limit — main's verdict, not the raw column length — in one of
 * three states (normal / at ceiling / paused), and opens a small panel listing the
 * cards holding the slots plus the per-repo limit stepper.
 */
const { t } = useI18n()
const roadmap = useRoadmapStore()
const drain = useRoadmapDrainStore()

const open = ref(false)
const root = ref<HTMLElement | null>(null)

const live = computed(() => roadmap.liveInProgressCount)
const limit = computed(() => roadmap.wipLimit)

/** Stamped Ready cards the drain would dispatch if a slot were free. */
const stampedWaiting = computed(
  () =>
    roadmap.cards.filter(
      (c) =>
        c.status === 'ready' &&
        !!c.approved &&
        !c.session &&
        (c.substrate ?? 'session') !== 'internal'
    ).length
)

const paused = computed(() => {
  const path = roadmap.folderPath
  return !!path && !!drain.wipPauses[path] && stampedWaiting.value > 0 && live.value >= limit.value
})

// Nothing waits any more: forget the pause so a later one notifies again.
watch(stampedWaiting, (n) => {
  if (n === 0 && roadmap.folderPath) drain.clearWipPause(roadmap.folderPath)
})

const stateClass = computed(() => {
  if (paused.value || live.value > limit.value) return 'bg-red-soft text-warning'
  if (live.value >= limit.value) return 'text-warning'
  return 'text-text-4'
})

const label = computed(() =>
  paused.value
    ? t('roadmap.wipChipPaused', { count: live.value, limit: limit.value })
    : t('roadmap.wip', { count: live.value, limit: limit.value })
)

function onDocPointer(ev: PointerEvent): void {
  if (root.value && !root.value.contains(ev.target as Node)) open.value = false
}
function onKey(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') open.value = false
}
watch(open, (isOpen) => {
  if (isOpen) {
    document.addEventListener('pointerdown', onDocPointer)
    document.addEventListener('keydown', onKey)
    void roadmap.refreshWip()
  } else {
    document.removeEventListener('pointerdown', onDocPointer)
    document.removeEventListener('keydown', onKey)
  }
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointer)
  document.removeEventListener('keydown', onKey)
})

function step(delta: number): void {
  const next = Math.min(WIP_LIMIT_BOUNDS.max, Math.max(WIP_LIMIT_BOUNDS.min, limit.value + delta))
  if (next !== limit.value) void roadmap.setWipLimit(next)
}
function reset(): void {
  void roadmap.setWipLimit(WIP_LIMIT_BOUNDS.default)
}

const holderTitle = (slug: string): string =>
  roadmap.cards.find((c) => c.slug === slug)?.title ?? slug
</script>

<template>
  <span ref="root" class="relative inline-flex">
    <button
      type="button"
      class="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px] tabular-nums transition hover:bg-surface-2"
      :class="stateClass"
      :title="$t('roadmap.wipHint')"
      aria-haspopup="dialog"
      :aria-expanded="open"
      data-testid="wip-chip"
      @click="open = !open"
    >
      <Pause v-if="paused" :size="12" :stroke-width="1.8" />
      {{ label }}
    </button>

    <div
      v-if="open"
      role="dialog"
      :aria-label="$t('roadmap.wipChip.title')"
      class="anim-fade-in-scale absolute right-0 top-full z-50 mt-1 w-72 rounded-lg border border-border bg-surface p-3 text-[12px] shadow-pop"
      data-testid="wip-panel"
    >
      <p v-if="paused" class="mb-2 text-warning">{{ $t('roadmap.wipChip.pausedNote') }}</p>

      <div class="eyebrow mb-1 text-text-4">{{ $t('roadmap.wipChip.holding') }}</div>
      <ul v-if="roadmap.liveHolders.length" class="mb-2 flex flex-col gap-1">
        <li
          v-for="h in roadmap.liveHolders"
          :key="h.slug"
          class="flex min-w-0 items-baseline gap-1.5"
        >
          <span class="shrink-0 font-mono text-[11px] text-text-3">{{ h.id }}</span>
          <span class="min-w-0 truncate text-text-2">{{ holderTitle(h.slug) }}</span>
        </li>
      </ul>
      <p v-else class="mb-2 text-text-4">{{ $t('roadmap.wipChip.holdingEmpty') }}</p>

      <p v-if="roadmap.staleSlugs.size" class="mb-2 text-text-4">
        {{ $t('roadmap.wipChip.staleNote', { count: roadmap.staleSlugs.size }) }}
      </p>

      <div class="flex items-center gap-2 border-t border-border pt-2">
        <span class="text-text-3">{{ $t('roadmap.wipChip.limit') }}</span>
        <span class="ml-auto inline-flex items-center gap-1">
          <button
            type="button"
            class="inline-flex h-6 w-6 items-center justify-center rounded-sm text-text-3 transition hover:bg-surface-2 disabled:cursor-not-allowed disabled:text-text-disabled disabled:hover:bg-transparent"
            :aria-label="$t('roadmap.wipChip.decrease')"
            :disabled="limit <= WIP_LIMIT_BOUNDS.min"
            data-testid="wip-dec"
            @click="step(-1)"
          >
            <Minus :size="12" :stroke-width="1.8" />
          </button>
          <span class="w-5 text-center tabular-nums text-text" data-testid="wip-limit">{{
            limit
          }}</span>
          <button
            type="button"
            class="inline-flex h-6 w-6 items-center justify-center rounded-sm text-text-3 transition hover:bg-surface-2 disabled:cursor-not-allowed disabled:text-text-disabled disabled:hover:bg-transparent"
            :aria-label="$t('roadmap.wipChip.increase')"
            :disabled="limit >= WIP_LIMIT_BOUNDS.max"
            data-testid="wip-inc"
            @click="step(1)"
          >
            <Plus :size="12" :stroke-width="1.8" />
          </button>
        </span>
      </div>
      <button
        v-if="limit !== WIP_LIMIT_BOUNDS.default"
        type="button"
        class="mt-1 text-[11px] text-text-3 transition hover:text-text"
        @click="reset"
      >
        {{ $t('roadmap.wipChip.reset', { default: WIP_LIMIT_BOUNDS.default }) }}
      </button>
      <p class="mt-2 text-[11px] text-text-4">{{ $t('roadmap.wipChip.hint') }}</p>
    </div>
  </span>
</template>
