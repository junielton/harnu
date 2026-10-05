<script setup lang="ts">
/**
 * T305 — the Scheduler worker's Prompt field: a textarea, a `/` skill
 * autocomplete, and a chip row that says whether each named skill actually
 * resolves. Anatomy in `design.md` §6, "Prompt field — skill mentions".
 *
 * **Why this exists.** A tick is spawned with `--setting-sources ''`, so it
 * never discovers `~/.claude/skills/` or the repo's `.claude/skills/` the way a
 * session does. The only skills it can see are the ones Harnu copies into its
 * staged plugin dir — and until this field existed the hint under the textarea
 * promised the opposite (BUG-116). Naming a skill here is what stages it.
 *
 * **The whole control is a VIEW of one string.** No `skills` array is stored
 * beside the prompt: `mentionChips` recomputes the row from the text on every
 * render, and `parseSkillMentions` in `src/main/scheduler-core.ts` recomputes
 * the same set from the same string when the tick fires. Deleting a mention by
 * hand removes its chip and unstages it; typing one by hand adds it. A stored
 * list would drift from the text the first time anyone edited the prompt
 * without the picker.
 *
 * A11y baseline matches `ui/FolderCombobox.vue` / `ui/BranchCombobox.vue` —
 * `aria-expanded` on the control, `role="listbox"`/`role="option"` on the
 * panel — not the full WAI-ARIA combobox pattern.
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { TriangleAlert } from 'lucide-vue-next'
import {
  filterSkills,
  insertMention,
  mentionChips,
  mentionTrigger,
  pickerSkills,
  type MentionTrigger
} from './scheduler-mentions'
import type { AvailableSkill } from '../../../preload'

const props = defineProps<{
  modelValue: string
  /** Everything this worker's folder could stage. Re-read when the folder changes. */
  skills: AvailableSkill[]
  placeholder?: string
}>()

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const { t } = useI18n()

const textareaRef = ref<HTMLTextAreaElement | null>(null)
const trigger = ref<MentionTrigger | null>(null)
const highlighted = ref(0)

/**
 * The chip row, minus the mention the caret is still inside.
 *
 * Still a pure view of the text — `mentionChips` sees the whole prompt; this
 * only declines to render the ONE token that is mid-keystroke. Without it every
 * partial name (`/l`, `/la`, `/lan`) flashes its own "not found" chip while the
 * operator is picking from the very list that would resolve it.
 */
const chips = computed(() => {
  const all = mentionChips(props.modelValue, props.skills)
  const active = trigger.value
  if (active === null) return all
  const typing = props.modelValue.slice(active.start + 1, active.start + 1 + active.query.length)
  const i = all.findIndex((c) => c.mention === typing)
  return i === -1 ? all : [...all.slice(0, i), ...all.slice(i + 1)]
})

const matches = computed<AvailableSkill[]>(() =>
  trigger.value === null ? [] : filterSkills(pickerSkills(props.skills), trigger.value.query)
)

/** Open only while a `/` token is live at the caret. An empty result set still
 *  shows the panel — "no skill matches" is the answer to the question asked. */
const open = computed(() => trigger.value !== null)

watch(matches, () => {
  highlighted.value = 0
})

function syncTrigger(el: HTMLTextAreaElement): void {
  trigger.value = mentionTrigger(el.value, el.selectionStart ?? el.value.length)
}

function onInput(e: Event): void {
  const el = e.target as HTMLTextAreaElement
  emit('update:modelValue', el.value)
  syncTrigger(el)
}

/** Caret moves (click, arrows, Home/End) change which token is live. */
function onCaretMove(e: Event): void {
  syncTrigger(e.target as HTMLTextAreaElement)
}

function close(): void {
  trigger.value = null
}

async function pick(skill: AvailableSkill): Promise<void> {
  const el = textareaRef.value
  const active = trigger.value
  if (!el || !active) return
  const caret = el.selectionStart ?? el.value.length
  const next = insertMention(el.value, active, caret, skill.name)
  emit('update:modelValue', next.text)
  close()
  await nextTick()
  el.focus()
  el.setSelectionRange(next.caret, next.caret)
}

function onKeydown(e: KeyboardEvent): void {
  if (!open.value) return
  const rows = matches.value
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    close()
  } else if (e.key === 'ArrowDown' && rows.length > 0) {
    e.preventDefault()
    highlighted.value = (highlighted.value + 1) % rows.length
  } else if (e.key === 'ArrowUp' && rows.length > 0) {
    e.preventDefault()
    highlighted.value = (highlighted.value - 1 + rows.length) % rows.length
  } else if ((e.key === 'Enter' || e.key === 'Tab') && rows.length > 0) {
    e.preventDefault()
    const row = rows[highlighted.value]
    if (row) void pick(row)
  }
}

const ORIGIN_LABEL = {
  bundled: 'scheduler.settings.skillOrigin.bundled',
  personal: 'scheduler.settings.skillOrigin.personal',
  project: 'scheduler.settings.skillOrigin.project'
} as const
</script>

<template>
  <div class="flex flex-col gap-1.5" data-dsqa="worker-prompt-field">
    <!-- The popup is anchored to the TEXTAREA's own box, not the whole control:
         the chip row below grows, and a popup measured against the control would
         drift further from the caret with every skill named. -->
    <div class="relative">
      <textarea
        ref="textareaRef"
        :value="modelValue"
        rows="4"
        role="combobox"
        aria-autocomplete="list"
        :aria-expanded="open"
        class="w-full resize-y rounded-sm border border-border-2 bg-surface px-2.5 py-2 text-[12px] leading-[1.55] text-text"
        :placeholder="placeholder"
        @input="onInput"
        @keydown="onKeydown"
        @keyup="onCaretMove"
        @click="onCaretMove"
        @blur="close"
      />

      <div
        v-if="open"
        role="listbox"
        data-dsqa="skill-mention-popup"
        class="anim-fade-in absolute left-0 right-0 top-full z-20 mt-1 max-h-[220px] overflow-y-auto rounded border border-border-2 bg-surface shadow-pop"
      >
        <button
          v-for="(skill, i) in matches"
          :key="`${skill.origin}:${skill.name}`"
          type="button"
          role="option"
          :aria-selected="i === highlighted"
          class="flex h-[26px] w-full items-center gap-2 px-2.5 text-left text-[12px] text-text"
          :class="i === highlighted ? 'bg-surface-2' : ''"
          @mousedown.prevent="pick(skill)"
          @mouseenter="highlighted = i"
        >
          <span class="truncate font-mono">{{ skill.name }}</span>
          <span class="ml-auto shrink-0 text-[11px] text-text-4">{{
            t(ORIGIN_LABEL[skill.origin])
          }}</span>
        </button>
        <div
          v-if="matches.length === 0"
          class="flex h-[26px] items-center px-2.5 text-[11px] text-text-4"
        >
          {{ t('scheduler.settings.skillNoMatch') }}
        </div>
      </div>
    </div>

    <div v-if="chips.length > 0" class="flex flex-wrap gap-1.5 pt-0.5" data-dsqa="skill-chips">
      <span
        v-for="chip in chips"
        :key="chip.mention"
        class="inline-flex h-5 items-center gap-1 rounded-sm border px-2 text-[11px]"
        :class="
          chip.origin
            ? 'border-border-2 bg-surface-2 text-text-2'
            : 'border-red-line bg-red-soft text-warning'
        "
        :data-skill-chip="chip.origin ?? 'not-found'"
      >
        <TriangleAlert v-if="!chip.origin" :size="11" :stroke-width="1.7" class="shrink-0" />
        <span class="font-mono">{{ chip.mention }}</span>
        <span :class="chip.origin ? 'text-text-4' : ''">
          · {{ chip.origin ? t(ORIGIN_LABEL[chip.origin]) : t('scheduler.settings.skillNotFound') }}
        </span>
      </span>
    </div>
  </div>
</template>
