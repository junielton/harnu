<script setup lang="ts">
import { computed } from 'vue'
import { CirclePlay, CircleDot } from 'lucide-vue-next'
import type { RoadmapPeekResult } from '../../../preload'
import { useUiStore } from '../stores/ui'
import ScopeTag from './ui/ScopeTag.vue'
import { scopeOf } from './folder-view-format'

/**
 * T212 — "what is running here", without opening the board. Fed by the
 * read-only `roadmap:peek` IPC (never `roadmapLoad`, which would steal the
 * single roadmap watcher from an open board in another repo). Renders nothing at
 * all when the repo has no cards — an empty counts strip is worse than no strip.
 *
 * T285 — a rail card, tagged `repo`. `resolveMemoryLocation` collapses every
 * worktree onto the repo's main checkout, so these counts are byte-identical in
 * every folder of the repo; the tag is what stops them reading as this folder's.
 */

const props = defineProps<{
  peek: RoadmapPeekResult | null
  folderPath: string
  repoLabel: string
}>()

const ui = useUiStore()

const COLUMNS = ['backlog', 'ready', 'in-progress', 'review'] as const

const hasCards = computed(() => {
  const p = props.peek
  if (!p) return false
  return Object.values(p.counts).some((n) => n > 0)
})

function openBoard(): void {
  ui.openRoadmap(props.folderPath, props.repoLabel)
}
</script>

<template>
  <section
    v-if="hasCards && peek"
    class="flex flex-col border border-border bg-surface"
    style="gap: 10px; border-radius: var(--radius); padding: 14px 16px"
    data-test="folder-view-roadmap"
  >
    <div class="flex items-center justify-between" style="gap: 8px">
      <span class="eyebrow text-text-4">{{ $t('folderView.roadmap') }}</span>
      <ScopeTag :scope="scopeOf('roadmap')" />
    </div>

    <button
      class="flex cursor-pointer flex-wrap items-center text-text-3 transition hover:text-text"
      style="gap: 4px 12px; font-size: 11.5px"
      data-test="folder-view-roadmap-counts"
      @click="openBoard"
    >
      <span v-for="c in COLUMNS" :key="c" class="tabular-nums">
        {{ $t(`roadmap.columns.${c}`) }} {{ peek.counts[c] }}
      </span>
    </button>

    <!-- BUG-118 — the card list caps itself at `--fv-rail-list-max-h` and
         scrolls inside the card, so a 128-card board cannot push the rest of the
         rail off screen. The counts strip above is the summary and stays put;
         only the detail scrolls. `max-height` not `height`: a board with three
         active cards still renders three rows tall. -->
    <div
      class="scrollable flex flex-col"
      style="gap: 2px; margin: 0 -10px; max-height: var(--fv-rail-list-max-h); overflow-y: auto"
      data-test="folder-view-roadmap-list"
    >
      <button
        v-for="card in peek.active"
        :key="card.slug"
        class="flex w-full cursor-pointer items-center text-left text-text-2 transition hover:bg-surface-2 hover:text-text"
        style="gap: 8px; border-radius: var(--radius-sm); padding: 6px 10px; font-size: 12.5px"
        data-test="folder-view-roadmap-card"
        @click="openBoard"
      >
        <component
          :is="card.status === 'in-progress' ? CirclePlay : CircleDot"
          :size="12"
          :stroke-width="1.6"
          class="shrink-0 text-text-4"
        />
        <!-- T285 — capped, not just `shrink-0`. A card whose frontmatter carries
             no short `id` falls back to a slug-shaped one, and an uncapped
             `shrink-0` span made a 418px id overflow the 320px rail (AC-3: no
             horizontal scroll at any width). design.md §6 "Folder View". -->
        <span
          class="shrink-0 truncate font-mono text-text-4"
          style="font-size: 11px; max-width: 96px"
          :title="card.id"
          >{{ card.id }}</span
        >
        <span class="min-w-0 flex-1 truncate">{{ card.title }}</span>
        <span v-if="card.session" class="shrink-0 text-text-4" style="font-size: 10.5px">{{
          $t('folderView.sessionBound')
        }}</span>
      </button>
    </div>
  </section>
</template>
