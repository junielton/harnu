<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, ChevronLeft } from 'lucide-vue-next'
import type { PastRunView } from '../lib/walk-view'

/**
 * A past run, read-only (design.md §6 "Walks library" → Past run, spec S-4, AC-21): `← Walks`, the title, the
 * counts, a run selector with a `Read-only` chip, and the rail: one row per check THE RUN HAD, with how it was
 * verified and, under a failed or noted check, what the operator wrote, their screenshots, the agent's
 * correction and its evidence. Nothing here can change a run; the action bar (owned by the pane) holds Re-run and
 * Export markdown. It draws a `PastRunView` and reports clicks.
 */
const props = defineProps<{
  past: PastRunView
  /** A screenshot's data URL (the pane loads it from the run's folder); empty until it has loaded. */
  imageUrl: (path: string) => string
}>()
const emit = defineEmits<{
  back: []
  'select-run': [runId: string]
  'open-shot': [path: string]
}>()
const { t } = useI18n()

const glyphClass: Record<string, string> = {
  '✓': 'gl-ok',
  '✗': 'gl-bad',
  '!': 'gl-warn',
  '-': 'gl-off',
  '⚑': 'gl-you',
  '?': 'gl-ask'
}

// ---- the run selector: one control that lists the walk's runs ---------------------------------------
const open = ref(false)
const root = ref<HTMLElement | null>(null)
const only = (): boolean => props.past.run.options.length < 2

function onDocPointer(ev: PointerEvent): void {
  if (root.value && !root.value.contains(ev.target as Node)) close()
}
function close(): void {
  open.value = false
  document.removeEventListener('pointerdown', onDocPointer, true)
}
async function toggle(): Promise<void> {
  if (only()) return
  if (open.value) return close()
  open.value = true
  document.addEventListener('pointerdown', onDocPointer, true)
  await nextTick()
  root.value?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')?.focus()
}
function pick(runId: string, current: boolean): void {
  close()
  if (!current) emit('select-run', runId)
}
function onListKey(ev: KeyboardEvent): void {
  const items = [...(root.value?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])]
  const i = items.indexOf(document.activeElement as HTMLElement)
  if (ev.key === 'Escape') {
    ev.preventDefault()
    ev.stopPropagation()
    close()
    root.value?.querySelector<HTMLElement>('.sel')?.focus()
  } else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    ev.preventDefault()
    ev.stopPropagation()
    items[(i + (ev.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
  }
}
onBeforeUnmount(close)
</script>

<template>
  <button type="button" class="lost back" data-test="walk-past-back" @click="emit('back')">
    <ChevronLeft class="i i10" :size="10" />{{ past.back }}
  </button>
  <div class="wk-head">
    <h2 class="wk-title">{{ past.title }}</h2>
    <div class="sub" data-test="walk-past-sub">{{ past.sub }}</div>
  </div>

  <div ref="root" class="runbar" data-dsqa-part="run-select">
    <button
      type="button"
      class="sel"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-label="t('walksLibrary.past.runs')"
      data-test="walk-run-select"
      @click="toggle"
    >
      {{ past.run.label }}<ChevronDown v-if="!only()" class="i i10" :size="10" />
    </button>
    <span class="chipro">{{ past.readOnly }}</span>
    <ul
      v-if="open"
      class="sel-list"
      role="listbox"
      :aria-label="t('walksLibrary.past.runs')"
      @keydown="onListKey"
    >
      <li
        v-for="o in past.run.options"
        :key="o.runId"
        role="option"
        tabindex="-1"
        :aria-selected="o.current"
        :class="{ cur: o.current }"
        :data-run="o.runId"
        @click="pick(o.runId, o.current)"
        @keydown.enter.prevent="pick(o.runId, o.current)"
      >
        {{ o.label }}
      </li>
    </ul>
  </div>

  <ol class="rm" data-dsqa-part="past-run" data-test="walk-past-rows">
    <li v-for="r in past.rows" :key="r.id" class="rm-row" data-dsqa-part="closeout-row">
      <span class="g1"
        ><span class="gl" :class="glyphClass[r.glyph]" aria-hidden="true">{{ r.glyph }}</span></span
      >
      <span class="n num">{{ r.n ?? '' }}</span>
      <span class="t">{{ r.title }}</span>
      <span class="m">
        <span :class="{ warnt: r.tone === 'warn', redt: r.tone === 'bad' }">{{ r.how }}</span>
      </span>
      <div
        v-if="r.notes"
        class="note-q"
        :class="{ plain: !(r.notes.lines.length || r.notes.shots.length || r.notes.correction) }"
        data-dsqa-part="run-note"
      >
        <template v-if="r.notes.lines.length || r.notes.shots.length">
          <span class="eyebrow">{{ t('walksLibrary.past.wrote') }}</span>
          <p v-for="(l, i) in r.notes.lines" :key="i">“{{ l }}”</p>
          <button
            v-for="(s, i) in r.notes.shots"
            :key="s.path"
            type="button"
            class="att small"
            :title="t('walksLibrary.past.openShot')"
            data-test="walk-past-shot"
            @click="emit('open-shot', s.path)"
          >
            <img v-if="imageUrl(s.path)" :src="imageUrl(s.path)" alt="" />
            <span class="trunc">{{ t('walksLibrary.past.shot', { n: i + 1 }) }}</span>
          </button>
        </template>
        <template v-if="r.notes.correction">
          <span class="eyebrow">{{ t('walksLibrary.past.correction') }}</span>
          <p>{{ r.notes.correction }}</p>
        </template>
        <template v-if="r.notes.evidence">
          <span class="eyebrow">{{ t('walksLibrary.past.agent') }}</span>
          <p>{{ r.notes.evidence }}</p>
        </template>
      </div>
    </li>
  </ol>
</template>

<style>
/* a past run, read-only (docs/design/guided-walks/mockup.css, "a past run, read-only"); tokens only */
.wk .runbar {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: -4px;
}
.wk .runbar .sel {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 22px;
  padding: 0 8px;
  border: 1px solid var(--color-border-2);
  border-radius: var(--radius-sm);
  background: var(--color-surface-2);
  font-size: 11.5px;
  color: var(--color-text);
}
.wk .runbar .sel:hover {
  border-color: var(--color-text-4);
}
.wk .runbar .sel-list {
  position: absolute;
  top: 26px;
  left: 0;
  z-index: 5;
  margin: 0;
  padding: 3px;
  list-style: none;
  min-width: 160px;
  border: 1px solid var(--color-border-2);
  border-radius: var(--radius);
  background: var(--color-surface-2);
  box-shadow: var(--shadow-pop);
}
.wk .runbar .sel-list li {
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  font-size: 11.5px;
  color: var(--color-text-2);
  cursor: pointer;
  white-space: nowrap;
}
.wk .runbar .sel-list li:hover,
.wk .runbar .sel-list li:focus-visible {
  background: var(--color-surface);
  color: var(--color-text);
  outline: none;
}
.wk .runbar .sel-list li.cur {
  color: var(--color-text);
}
.wk .note-q {
  grid-column: 3;
  margin-top: 6px;
  border-left: 2px solid var(--color-red-line);
  padding: 0 0 0 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.wk .note-q.plain {
  border-left-color: var(--color-border-2);
}
.wk .note-q p {
  margin: 0;
  font-size: 12px;
  color: var(--color-text-2);
  overflow-wrap: anywhere;
}
.wk button.att {
  cursor: pointer;
}
.wk button.att:hover {
  border-color: var(--color-text-4);
}
</style>
