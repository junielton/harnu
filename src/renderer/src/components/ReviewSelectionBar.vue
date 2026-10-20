<script setup lang="ts">
/**
 * T257 U1 — the selection bar.
 *
 * Anchored at the bottom of the review body, deliberately NOT inside the
 * evidence header or the discrepancy strip: those are receipts, and this bar
 * will eventually carry a conversation's delivery state (spec §5.3).
 *
 * It names what is selected and offers to clear it. It renders no count, no
 * ratio and no percentage at any data combination — the only numbers on it are
 * the selected lines' own numbers (PRD D7, T243 AC-8). U1 delivers nothing; the
 * `actions` slot is where U2b's `Ask about this` / `Copy as text` land.
 *
 * design.md §6 "Review selection (ReviewSelectionBar.vue, T257)".
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useReviewSelectionStore } from '../stores/review-selection'
import { rangeLabelOf, type SelectionSide } from '../lib/review-selection'
import Button from './ui/Button.vue'

defineProps<{
  /** Below the pane's ~1000px breakpoint the bar wraps; no action hides. */
  narrow?: boolean
}>()

const { t } = useI18n()
const selection = useReviewSelectionStore()

const side = (s: SelectionSide): string =>
  t(s === 'LEFT' ? 'review.selection.side.old' : 'review.selection.side.new')

const rangeText = computed(() => {
  const sel = selection.live
  if (!sel) return ''
  const label = rangeLabelOf(sel)
  switch (label.kind) {
    case 'file':
      return t('review.selection.range.file')
    case 'line':
      return t(
        label.side === 'LEFT' ? 'review.selection.range.oldLine' : 'review.selection.range.line',
        {
          line: label.line
        }
      )
    case 'range':
      return t(
        label.side === 'LEFT' ? 'review.selection.range.oldLines' : 'review.selection.range.lines',
        {
          start: label.start,
          end: label.end
        }
      )
    default:
      return t('review.selection.range.mixed', {
        startSide: side(label.startSide),
        start: label.start,
        endSide: side(label.endSide),
        end: label.end
      })
  }
})

const hint = computed(() => {
  const n = selection.notice
  if (!n) return ''
  if (n.kind === 'clamp') return t('review.selection.hint.clamp')
  return t(
    n.kind === 'head-moved' ? 'review.selection.hint.headMoved' : 'review.selection.hint.baseMoved',
    {
      from: n.from,
      to: n.to
    }
  )
})
</script>

<template>
  <section
    v-if="selection.live || selection.notice"
    data-test="review-selection-bar"
    class="anim-fade-in flex flex-none flex-wrap gap-x-3 gap-y-1.5 rounded border border-border bg-surface px-3 py-2 text-[12px] text-text-2 shadow-pop"
    :class="narrow ? 'flex-col items-stretch' : 'items-center'"
    :aria-label="t('review.selection.barLabel')"
  >
    <div v-if="selection.live" class="flex min-w-0 items-center gap-2">
      <span class="h-4 w-0.5 flex-none rounded-full bg-accent" aria-hidden="true" />
      <span class="truncate font-mono text-text" :title="selection.live.path">{{
        selection.live.path
      }}</span>
      <span class="text-text-4" aria-hidden="true">·</span>
      <span class="flex-none whitespace-nowrap font-mono text-text" data-test="selection-range">{{
        rangeText
      }}</span>
    </div>

    <div class="flex flex-wrap items-center gap-[7px]" :class="narrow ? '' : 'ml-auto'">
      <slot name="actions" />
      <Button
        v-if="selection.live"
        variant="ghost"
        data-test="selection-clear"
        @click="selection.clear('user')"
      >
        {{ t('review.selection.action.clear') }}
      </Button>
      <Button
        v-else
        variant="ghost"
        data-test="selection-dismiss"
        @click="selection.dismissNotice()"
      >
        {{ t('review.selection.action.dismiss') }}
      </Button>
    </div>

    <!-- Always in the DOM so assistive tech has a live region to announce into;
         `empty:hidden` keeps it from taking a row while it has nothing to say. -->
    <p
      role="status"
      class="basis-full text-[11.5px] text-text-3 empty:hidden"
      data-test="selection-hint"
    >
      {{ hint }}
    </p>
  </section>
</template>
