<script setup lang="ts">
/**
 * T257 U1 — the selection bar.
 *
 * Anchored at the bottom of the review body, deliberately NOT inside the
 * evidence header or the discrepancy strip: those are receipts, and this bar
 * will eventually carry a conversation's delivery state (spec §5.3).
 *
 * It names what is selected, offers `Ask about this` / `Copy as text` / `Clear`
 * (U2b), and carries the one chip for the most recent delivery. It renders no
 * count, no ratio and no percentage at any data combination — the only numbers
 * on it are the selected lines' own numbers (PRD D7, T243 AC-8).
 *
 * Every sentence the chip shows is a `review.selection.*` key chosen by a stable
 * code from `lib/review-selection-delivery.ts`; no text from the mod or the model
 * reaches this template (spec §7.3), and the bar reads no companion content
 * (spec §11 G-5): the chip says a turn happened, never what it said.
 *
 * design.md §6 "Review selection (ReviewSelectionBar.vue, T257)".
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useReviewSelectionStore } from '../stores/review-selection'
import { useUiStore } from '../stores/ui'
import { rangeLabelOf, type RangeLabel, type SelectionSide } from '../lib/review-selection'
import { chipOf, copyWithheld, stepsFor } from '../lib/review-selection-delivery'
import Button from './ui/Button.vue'

defineProps<{
  /** Below the pane's ~1000px breakpoint the bar wraps; no action hides. */
  narrow?: boolean
}>()

const { t } = useI18n()
const selection = useReviewSelectionStore()
const ui = useUiStore()

const side = (s: SelectionSide): string =>
  t(s === 'LEFT' ? 'review.selection.side.old' : 'review.selection.side.new')

function describeRange(label: RangeLabel): string {
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
}

const rangeText = computed(() => {
  const sel = selection.live
  return sel ? describeRange(rangeLabelOf(sel)) : ''
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

// ── Delivery (U2b) ─────────────────────────────────────────────────────────

const rec = computed(() => (selection.live ? selection.last : null))
const chip = computed(() => (rec.value ? chipOf(rec.value) : null))
/** A mixed-side range sends no lines (main cannot recover the rows between its two ends). */
const liveMixed = computed(() => !!selection.live && rangeLabelOf(selection.live).kind === 'mixed')
/** The companion has the row, whatever has happened in its conversation since. */
const SEEN_PHASES = new Set([
  'delivered',
  'asked',
  'answered',
  'turn-stopped',
  'turn-declined',
  'turn-failed'
])
const sentMixed = computed(
  () => !!rec.value && rec.value.range.kind === 'mixed' && SEEN_PHASES.has(rec.value.phase)
)

/** With no companion open nothing is sent: a quiet line says so, no error styling. */
const noCompanion = computed(() => !!selection.live && selection.companionSid === null)
const copyDisabled = computed(() => !selection.live || copyWithheld(rec.value))

const steps = computed(() => (rec.value ? stepsFor(rec.value) : []))
/** `reselect` is a button after a moved head and plain guidance after a refused selection. */
const reselectIsGuide = computed(
  () => rec.value?.code === 'BAD_ARGS' || rec.value?.code === 'CMD_PRECONDITION'
)
const showTryAgain = computed(() => steps.value.includes('try-again'))
const showReselect = computed(() => steps.value.includes('reselect') && !reselectIsGuide.value)
const showNarrow = computed(() => steps.value.includes('reselect') && reselectIsGuide.value)

const copyState = ref<'idle' | 'copied' | 'failed'>('idle')
let copyTimer: ReturnType<typeof setTimeout> | null = null

async function onCopy(): Promise<void> {
  const result = await selection.copy()
  if (result === 'refused') return // the chip says why
  copyState.value = result === 'copied' ? 'copied' : 'failed'
  if (copyTimer) clearTimeout(copyTimer)
  copyTimer = setTimeout(() => (copyState.value = 'idle'), 2000)
}

onBeforeUnmount(() => {
  if (copyTimer) clearTimeout(copyTimer)
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
      <template v-if="selection.live">
        <Button data-test="selection-copy" :disabled="copyDisabled" @click="onCopy()">
          {{
            copyState === 'copied'
              ? t('review.selection.copied')
              : t('review.selection.action.copy')
          }}
        </Button>
        <span v-if="liveMixed" class="text-[11.5px] text-text-3" data-test="selection-mixed">{{
          t('review.selection.mixedNote')
        }}</span>
        <span
          v-if="noCompanion"
          class="text-[11.5px] text-text-3"
          data-test="selection-no-companion"
          >{{ t('review.selection.outcome.no-companion') }}</span
        >
      </template>
      <Button
        v-if="selection.live"
        variant="ghost"
        data-test="selection-clear"
        @click="selection.clear('user')"
      >
        {{ t('review.selection.action.clear') }}
      </Button>
      <Button v-else variant="ghost" data-test="selection-dismiss" @click="selection.dismiss()">
        {{ t('review.selection.action.dismiss') }}
      </Button>
    </div>

    <!-- The one chip: the most recent delivery, a closed vocabulary in the neutral tone for
         every state (no success colour, no icon). Always in the DOM for the live region. -->
    <div
      role="status"
      class="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-text-2 empty:hidden"
      :class="narrow ? '' : 'basis-full'"
      data-test="delivery-chip"
    >
      <template v-if="chip">
        <span data-test="delivery-state">{{ t(chip.key) }}</span>
        <span v-if="chip.reasonKey" class="text-[11.5px] text-text-3" data-test="delivery-reason">{{
          t(chip.reasonKey)
        }}</span>
        <span v-if="sentMixed" class="text-[11.5px] text-text-3" data-test="delivery-mixed">{{
          t('review.selection.mixedNote')
        }}</span>
        <Button
          v-if="showTryAgain"
          variant="ghost"
          data-test="step-try-again"
          @click="selection.retry()"
        >
          {{ t('review.selection.action.tryAgain') }}
        </Button>
        <Button
          v-if="steps.includes('open-mods-settings')"
          variant="ghost"
          data-test="step-open-mods"
          @click="ui.openSettings('mods')"
        >
          {{ t('review.selection.action.openMods') }}
        </Button>
        <Button
          v-if="showReselect"
          variant="ghost"
          data-test="step-reselect"
          @click="selection.clear('user')"
        >
          {{ t('review.selection.action.reselect') }}
        </Button>
        <span v-if="showNarrow" class="text-[11.5px] text-text-3" data-test="guide-narrow">{{
          t('review.selection.action.narrow')
        }}</span>
        <span
          v-if="steps.includes('refresh')"
          class="text-[11.5px] text-text-3"
          data-test="guide-refresh"
          >{{ t('review.selection.guide.refresh', { action: t('review.refresh') }) }}</span
        >
        <span
          v-if="steps.includes('reopen-companion')"
          class="text-[11.5px] text-text-3"
          data-test="guide-reopen"
          >{{ t('review.selection.guide.freshCompanion', { action: t('review.companion') }) }}</span
        >
      </template>
      <span
        v-if="copyState === 'failed'"
        class="text-[11.5px] text-text-3"
        data-test="copy-failed"
        >{{ t('review.selection.copyFailed') }}</span
      >
    </div>

    <!-- Always in the DOM so assistive tech has a live region to announce into;
         `empty:hidden` keeps it from taking a row while it has nothing to say. -->
    <p
      role="status"
      class="text-[11.5px] text-text-3 empty:hidden"
      :class="narrow ? '' : 'basis-full'"
      data-test="selection-hint"
    >
      {{ hint }}
    </p>
  </section>
</template>
