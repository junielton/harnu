<script setup lang="ts">
/**
 * The "All folders" row of Focus (design.md §6 "Sidebar tree → Focus"): sticky at the top of the
 * list, the whole row returns to the full list, and its right side counts what waits elsewhere.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronLeft } from 'lucide-vue-next'
import { useSessionsStore } from '../stores/sessions'

const sessions = useSessionsStore()
const { t } = useI18n()

const meta = computed(() => {
  // Nothing to count while the folders are still on their way.
  if (sessions.folders.length === 0) return ''
  const { others, needsYou, failed } = sessions.focusElsewhere
  return [
    t('sidebar.focus.others', others),
    needsYou && t('sidebar.focus.needsYou', needsYou),
    failed && t('sidebar.focus.failed', failed)
  ]
    .filter(Boolean)
    .join(' · ')
})
</script>

<template>
  <button
    type="button"
    data-focus-back
    data-dsqa-part="back-row"
    class="sticky top-0 z-[4] mb-1.5 flex h-[35px] w-full shrink-0 cursor-pointer items-center gap-1.5 border-b border-border bg-sidebar px-3.5 text-left text-[12px] whitespace-nowrap text-text-3 transition-colors duration-(--dur-fast) ease-(--ease) hover:text-text"
    @click="sessions.leaveFocus()"
    @keydown.enter.stop
    @keydown.space.stop
  >
    <ChevronLeft :size="14" :stroke-width="1.7" class="shrink-0" aria-hidden="true" />
    <span class="flex min-w-0 flex-1 items-baseline justify-between gap-1.5">
      <span data-focus-back-label class="shrink-0">{{ $t('sidebar.focus.allFolders') }}</span>
      <span
        v-if="meta"
        data-focus-back-meta
        class="min-w-0 truncate text-[10.5px] text-warning tabular-nums"
        :title="meta"
        >{{ meta }}</span
      >
    </span>
  </button>
</template>
