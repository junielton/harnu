<script setup lang="ts">
import { computed } from 'vue'
import { Check, X } from 'lucide-vue-next'
import type { QuizAnswer, QuizSpec } from '../lib/lesson-blocks'

/**
 * One quiz question inside a lesson (design.md §6 — Quiz block; T120).
 *
 * PRESENTATIONAL: it renders a `QuizSpec` and reports the learner's selection
 * upward. It never grades and never touches IPC — `MarkdownPane` owns the exam
 * state, the grading (against the key embedded in the file) and the delivery to
 * the teacher session. Keeping the widget dumb is what lets the real logic live
 * in the pure, unit-tested `lesson-blocks.ts`.
 *
 * Three forms, decided by the parsed spec: exactly one correct option → radio;
 * more than one → checkbox (exact set match); `open: true` → textarea (never
 * graded here — the teacher grades free text).
 *
 * A `checkpoint` block (T123 — `mode: check`) additionally shows its OWN submit
 * button while ungraded (design.md §6 — Checkpoint). Pressing it only EMITS
 * `check` — grading and delivery still happen in `MarkdownPane`, same boundary.
 */
interface Props {
  spec: QuizSpec
  /** The learner's current answer (null = untouched). */
  answer: QuizAnswer | null
  /** This block is graded (by the exam submit OR by its own Check). */
  graded: boolean
}
const props = defineProps<Props>()
const emit = defineEmits<{ answer: [value: QuizAnswer]; check: [] }>()

const selected = computed<number[]>(() =>
  props.answer?.kind === 'choice' ? props.answer.selected : []
)
const openText = computed<string>(() => (props.answer?.kind === 'open' ? props.answer.text : ''))

function isSelected(i: number): boolean {
  return selected.value.includes(i)
}

/** Radio: replace the selection. Checkbox: toggle within it. */
function pick(i: number): void {
  if (props.graded) return // one submit per lesson — answers freeze after grading
  if (props.spec.multi) {
    const next = isSelected(i) ? selected.value.filter((n) => n !== i) : [...selected.value, i]
    emit('answer', { kind: 'choice', selected: [...next].sort((a, b) => a - b) })
  } else {
    emit('answer', { kind: 'choice', selected: [i] })
  }
}

function onOpenInput(ev: Event): void {
  emit('answer', { kind: 'open', text: (ev.target as HTMLTextAreaElement).value })
}

/**
 * Per-option visual state (design.md §6 — Quiz block · Estados). Before grading
 * only selection matters; after grading the key is revealed — INCLUDING the
 * `graded-missed` case (a correct option the learner did NOT pick), so the right
 * answer is always visible without pretending they got it.
 */
type OptionState = 'unanswered' | 'selected' | 'graded-correct' | 'graded-wrong' | 'graded-missed'
function optionState(i: number): OptionState {
  const picked = isSelected(i)
  if (!props.graded) return picked ? 'selected' : 'unanswered'
  const correct = props.spec.options[i]?.correct ?? false
  if (picked && correct) return 'graded-correct'
  if (picked && !correct) return 'graded-wrong'
  if (!picked && correct) return 'graded-missed'
  return 'unanswered'
}

const OPTION_CLASS: Record<OptionState, string> = {
  unanswered: 'border-border bg-surface-2 text-text-2 hover:border-border-2',
  selected: 'border-accent-line bg-accent-soft text-text',
  'graded-correct': 'border-green bg-green-soft text-text',
  'graded-wrong': 'border-red bg-red-soft text-text',
  'graded-missed': 'border-green border-dashed bg-surface-2 text-text-2'
}
</script>

<template>
  <div class="quiz-card">
    <p class="quiz-question">{{ spec.question }}</p>

    <!-- Open question: free text, no local grading. Frozen after submit. -->
    <template v-if="spec.open">
      <textarea
        class="quiz-open scrollable"
        :value="openText"
        :readonly="graded"
        :placeholder="$t('markdownPane.lesson.openPlaceholder')"
        :aria-label="spec.question"
        rows="3"
        spellcheck="false"
        @input="onOpenInput"
      ></textarea>
      <p class="quiz-hint">{{ $t('markdownPane.lesson.openHint') }}</p>
    </template>

    <!-- Choice question: radio (single key) or checkbox (multi key). -->
    <div
      v-else
      class="quiz-options"
      :role="spec.multi ? 'group' : 'radiogroup'"
      :aria-label="spec.question"
    >
      <label
        v-for="(opt, i) in spec.options"
        :key="i"
        class="quiz-option"
        :class="[OPTION_CLASS[optionState(i)], graded ? 'cursor-default' : 'cursor-pointer']"
      >
        <input
          class="quiz-input"
          :type="spec.multi ? 'checkbox' : 'radio'"
          :name="spec.id"
          :checked="isSelected(i)"
          :disabled="graded"
          @change="pick(i)"
        />
        <span class="min-w-0 flex-1">{{ opt.text }}</span>
        <Check
          v-if="optionState(i) === 'graded-correct'"
          :size="12"
          :stroke-width="2"
          class="shrink-0 text-green"
        />
        <X
          v-else-if="optionState(i) === 'graded-wrong'"
          :size="12"
          :stroke-width="2"
          class="shrink-0 text-red"
        />
      </label>
    </div>

    <!-- Checkpoint (design.md §6 — Checkpoint): its OWN submit, secondary on purpose
         (accent belongs to the exam bar) — only while this block isn't graded yet. -->
    <div v-if="spec.checkpoint && !graded" class="quiz-check-bar">
      <button class="quiz-check" :disabled="answer === null" @click="emit('check')">
        {{ $t('markdownPane.lesson.check') }}
      </button>
    </div>

    <!-- The answer key lives in the file: `explain` must NEVER render before the
         learner submits, or the lesson spoils itself. -->
    <p v-if="graded && spec.explain" class="quiz-explain anim-fade-in">
      <strong>{{ $t('markdownPane.lesson.explain') }}:</strong> {{ spec.explain }}
    </p>
  </div>
</template>

<style scoped>
/* design.md §6 — Quiz block. Tokens only; no raw colors, no new keyframes. */
.quiz-card {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  padding: 10px 12px;
  margin: 0 0 12px;
}
.quiz-question {
  margin: 0 0 8px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--color-text);
  line-height: 1.5;
}
.quiz-options {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.quiz-option {
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid;
  border-radius: var(--radius-sm);
  padding: 6px 8px;
  font-size: 12px;
  line-height: 1.45;
  transition:
    background var(--dur-fast) var(--ease),
    border-color var(--dur-fast) var(--ease);
}
.quiz-input {
  flex-shrink: 0;
  accent-color: var(--color-accent);
}
.quiz-open {
  width: 100%;
  resize: vertical;
  min-height: 56px;
  max-height: 140px;
  background: var(--color-surface-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: 6px 8px;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.5;
  color: var(--color-text);
  outline: none;
}
.quiz-open:focus {
  border-color: var(--color-accent-line);
}
.quiz-open:read-only {
  border-color: var(--color-border-2);
  color: var(--color-text-2);
}
.quiz-hint,
.quiz-explain {
  margin: 6px 0 0;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--color-text-3);
}
.quiz-explain strong {
  color: var(--color-text-2);
  font-weight: 600;
}

/* Checkpoint's OWN submit (design.md §6 — Checkpoint): secondary on purpose — the
   accent belongs to the exam bar, not to a per-block practice check. */
.quiz-check-bar {
  display: flex;
  margin-top: 8px;
}
.quiz-check {
  background: var(--color-surface-2);
  border: 1px solid var(--color-border);
  color: var(--color-text-2);
  border-radius: var(--radius-sm);
  padding: 4px 10px;
  font-size: 11.5px;
  font-weight: 600;
  transition:
    border-color var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}
.quiz-check:hover:not(:disabled) {
  border-color: var(--color-border-2);
  color: var(--color-text);
}
.quiz-check:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
