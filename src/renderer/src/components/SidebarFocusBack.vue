<script setup lang="ts">
/**
 * The "All folders" row of Focus (design.md §6 "Sidebar tree → Focus"): sticky at the top of the
 * list, the whole row returns to the full list, and its right side counts what waits elsewhere.
 * It stays on one line at every width: whole parts are dropped as it narrows (see
 * `sidebar-focus-back.ts`), and the counts that need the operator never are.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronLeft } from 'lucide-vue-next'
import { useSessionsStore } from '../stores/sessions'
import { backRowLevel, type BackRowLevel } from './sidebar-focus-back'

const sessions = useSessionsStore()
const { t } = useI18n()

/** A dropped part leaves the flow but keeps its box, so its natural width can still be read. */
const DROPPED = 'invisible absolute'
const SEPARATOR = ' · '

/** The counts in words; a zero count is not shown. */
const meta = computed(() => {
  // Nothing to count while the folders are still on their way.
  if (sessions.folders.length === 0) return null
  const { others, needsYou, failed } = sessions.focusElsewhere
  const needs = needsYou ? t('sidebar.focus.needsYou', needsYou) : ''
  const short = needsYou ? t('sidebar.focus.needsYouShort', needsYou) : ''
  return {
    others: others ? t('sidebar.focus.others', others) : '',
    needs,
    needsShort: short === needs ? '' : short,
    failed: failed ? t('sidebar.focus.failed', failed) : ''
  }
})

/** Always the whole thing, whatever the row has room to draw. */
const full = computed(() =>
  [t('sidebar.focus.allFolders'), meta.value?.others, meta.value?.needs, meta.value?.failed]
    .filter(Boolean)
    .join(', ')
)

const row = ref<HTMLButtonElement | null>(null)
const level = ref<BackRowLevel>(0)

function measure(): void {
  const el = row.value
  if (!el) return
  const style = getComputedStyle(el)
  const px = (value: string): number => parseFloat(value) || 0
  const width = (part: string): number =>
    el.querySelector(`[data-focus-back-${part}]`)?.getBoundingClientRect().width ?? 0
  const needs = width('needs')
  level.value = backRowLevel(el.clientWidth - px(style.paddingLeft) - px(style.paddingRight), {
    chevron: width('chevron'),
    gap: px(style.columnGap),
    label: width('label'),
    others: width('others'),
    needs,
    needsShort: meta.value?.needsShort ? width('needs-short') : needs,
    failed: width('failed')
  })
}

let observer: ResizeObserver | null = null
onMounted(() => {
  measure()
  if (typeof ResizeObserver !== 'undefined' && row.value) {
    observer = new ResizeObserver(measure)
    observer.observe(row.value)
  }
  // The widths read before the app's font arrives are the fallback face's.
  void document.fonts?.ready.then(measure)
})
onBeforeUnmount(() => observer?.disconnect())
// New words (a count, the locale) are new widths; `post` reads them once they are on screen.
watch(full, measure, { flush: 'post' })

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
    ref="row"
    type="button"
    data-focus-back
    data-dsqa-part="back-row"
    :data-focus-back-level="level"
    class="sticky top-0 z-[4] mb-1.5 flex h-[35px] w-full shrink-0 cursor-pointer items-center gap-1.5 overflow-hidden border-b border-border bg-sidebar px-3.5 text-left text-[12px] whitespace-nowrap text-text-3 transition-colors duration-(--dur-fast) ease-(--ease) hover:text-text focus-visible:text-text"
    :title="full"
    :aria-label="full"
    @click="leave"
    @keydown.enter.stop
    @keydown.space.stop
  >
    <ChevronLeft
      data-focus-back-chevron
      :size="14"
      :stroke-width="1.7"
      class="shrink-0"
      aria-hidden="true"
    />
    <span class="flex min-w-0 flex-1 items-baseline gap-1.5">
      <span data-focus-back-label class="shrink-0" :class="level >= 2 && DROPPED">{{
        $t('sidebar.focus.allFolders')
      }}</span>
      <span
        v-if="meta"
        data-focus-back-meta
        class="ml-auto flex shrink-0 items-baseline text-[10.5px] tabular-nums"
      >
        <!-- Each part carries the "·" that follows it, so a dropped part takes it along. -->
        <span
          v-if="meta.others"
          data-focus-back-others
          class="shrink-0 whitespace-pre text-text-3"
          :class="level >= 1 && DROPPED"
          >{{ meta.others
          }}<span v-if="meta.needs || meta.failed" class="text-text-3">{{ SEPARATOR }}</span></span
        >
        <span
          v-if="meta.needs"
          data-focus-back-needs
          class="shrink-0 whitespace-pre text-warning"
          :class="level === 3 && DROPPED"
          >{{ meta.needs }}<span v-if="meta.failed" class="text-text-3">{{ SEPARATOR }}</span></span
        >
        <span
          v-if="meta.needsShort"
          data-focus-back-needs-short
          class="shrink-0 whitespace-pre text-warning"
          :class="level !== 3 && DROPPED"
          >{{ meta.needsShort
          }}<span v-if="meta.failed" class="text-text-3">{{ SEPARATOR }}</span></span
        >
        <span v-if="meta.failed" data-focus-back-failed class="shrink-0 whitespace-pre text-red">{{
          meta.failed
        }}</span>
      </span>
    </span>
  </button>
</template>
