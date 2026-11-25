<script setup lang="ts">
/**
 * The "All folders" row of Focus (design.md §6 "Sidebar tree → Focus"): sticky at the top of the
 * list, the whole row returns to the full list, and its right side counts what waits elsewhere.
 * The counts that need the operator are never cut: only "N others" truncates, and when they do not
 * fit beside the label they move to a second line inside the same row.
 */
import { computed, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronLeft } from 'lucide-vue-next'
import { useSessionsStore } from '../stores/sessions'

const sessions = useSessionsStore()
const { t } = useI18n()

/** Each count with its trailing separator, so a part that is cut takes its own "·" with it. */
const meta = computed(() => {
  // Nothing to count while the folders are still on their way.
  if (sessions.folders.length === 0) return null
  const { others, needsYou, failed } = sessions.focusElsewhere
  const rest = t('sidebar.focus.others', others)
  const needs = needsYou ? t('sidebar.focus.needsYou', needsYou) : ''
  const lost = failed ? t('sidebar.focus.failed', failed) : ''
  return {
    all: [rest, needs, lost].filter(Boolean).join(' · '),
    others: needs || lost ? `${rest} · ` : rest,
    needs: needs && lost ? `${needs} · ` : needs,
    failed: lost
  }
})

async function leave(event: MouseEvent): Promise<void> {
  const sidebar = (event.currentTarget as HTMLElement).closest('[data-sidebar]')
  const path = sessions.sidebarFocus
  sessions.leaveFocus()
  // A key press clicks with no pointer detail: this row unmounts under the keyboard, so hand
  // focus to the Focus button of the folder the operator was in.
  if (event.detail !== 0 || !path) return
  await nextTick()
  const trees = [...(sidebar?.querySelectorAll<HTMLElement>('[data-tree-folder]') ?? [])]
  const tree = trees.find((el) => el.dataset.treePaths?.split('|').includes(path)) ?? trees[0]
  tree?.querySelector<HTMLElement>('[data-focus-button]')?.focus()
}
</script>

<template>
  <button
    type="button"
    data-focus-back
    data-dsqa-part="back-row"
    class="sticky top-0 z-[4] mb-1.5 flex h-[35px] w-full shrink-0 cursor-pointer flex-wrap content-center items-baseline gap-x-1.5 border-b border-border bg-sidebar px-3.5 text-left text-[12px] whitespace-nowrap text-text-3 transition-colors duration-(--dur-fast) ease-(--ease) hover:text-text"
    @click="leave"
    @keydown.enter.stop
    @keydown.space.stop
  >
    <span class="flex items-baseline gap-1.5">
      <ChevronLeft :size="14" :stroke-width="1.7" class="shrink-0 self-center" aria-hidden="true" />
      <span data-focus-back-label>{{ $t('sidebar.focus.allFolders') }}</span>
    </span>
    <span
      v-if="meta"
      data-focus-back-meta
      class="flex flex-[1_0_auto] items-baseline justify-end text-[10.5px] text-warning tabular-nums"
      :title="meta.all"
    >
      <!-- No width of its own: it takes what the other two leave, down to nothing. Its padding is
           the space after its "·", so a gap survives when it truncates. -->
      <span data-focus-back-others class="w-0 min-w-0 flex-1 truncate pr-[3px] text-right">{{
        meta.others
      }}</span>
      <span data-focus-back-needs class="shrink-0 whitespace-pre">{{ meta.needs }}</span>
      <span data-focus-back-failed class="shrink-0 whitespace-pre">{{ meta.failed }}</span>
    </span>
  </button>
</template>
