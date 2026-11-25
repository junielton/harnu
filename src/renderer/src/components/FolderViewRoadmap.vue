<script setup lang="ts">
import type { RoadmapLine } from './folder-view-format'

/**
 * The Folder View's one roadmap line (design.md §6 "Folder View"): the repo's
 * counts and a 4px bar, with no card list and no click of its own — the
 * **Roadmap board** action above it opens the board. The counts come from the
 * read-only `roadmap:peek` IPC and are the repo's, so every worktree shows the
 * same numbers.
 */
defineProps<{ line: RoadmapLine }>()
</script>

<template>
  <div
    class="mt-6 flex max-w-180 flex-wrap items-center gap-3 border-t border-border pt-4 text-[12px] text-text-4"
    data-test="folder-view-roadmap"
    data-dsqa-part="folder-view-roadmap"
  >
    <span class="font-medium text-text-2">{{ $t('folderView.roadmap') }}</span>
    <span class="tabular-nums">
      <i18n-t keypath="folderView.road.inProgress" scope="global" tag="span">
        <template #n
          ><b class="font-medium text-text">{{ line.inProgress }}</b></template
        >
      </i18n-t>
      <span>{{ ' · ' }}</span>
      <i18n-t keypath="folderView.road.ready" scope="global" tag="span">
        <template #n
          ><b class="font-medium text-text">{{ line.ready }}</b></template
        >
      </i18n-t>
      <span>{{ ' · ' }}</span>
      <span>{{ $t('folderView.road.inReview', { n: line.review }) }}</span>
    </span>
    <span
      class="flex h-1 min-w-20 flex-1 overflow-hidden rounded-xs bg-border"
      aria-hidden="true"
      data-test="folder-view-roadmap-bar"
    >
      <i class="block h-full bg-green" :style="{ width: `${line.inProgressPct}%` }" />
      <i class="block h-full bg-accent" :style="{ width: `${line.readyPct}%` }" />
    </span>
  </div>
</template>
