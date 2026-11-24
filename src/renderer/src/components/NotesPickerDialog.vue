<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { CornerDownLeft, Search } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { useUiStore } from '../stores/ui'
import Dialog from './ui/Dialog.vue'
import { basename } from './folder-alias'
import {
  filterPickerRows,
  openNoteInStack,
  pickerRows,
  relativeHint,
  type PickerRow
} from '../lib/notes'

/**
 * Quick notes picker: every daily note of a repo, today first, behind a focused search box
 * (design.md §6 "Notes picker"). Search row and result rows mirror `SidebarJumpPalette`.
 * `↑`/`↓` move the selection (clamped), `↵` or a click opens the row, `Esc` closes (the shared
 * `Dialog` owns Esc).
 */

const ui = useUiStore()
const { t, locale } = useI18n()

const isOpen = computed(() => ui.dialog === 'notesPicker')
const folder = computed(() => ui.folderActionPath ?? '')

const status = ref<'loading' | 'ready' | 'error'>('loading')
const today = ref('')
const all = ref<PickerRow[]>([])
const query = ref('')
const selectedIndex = ref(0)
const opening = ref(false)
/** Guards `load` against a slower, older reply landing after a newer open. */
let loadToken = 0

const rows = computed(() => filterPickerRows(all.value, query.value))

async function load(): Promise<void> {
  const token = ++loadToken
  status.value = 'loading'
  all.value = []
  let res: Awaited<ReturnType<typeof window.api.notesList>> | null = null
  try {
    res = await window.api.notesList(folder.value)
  } catch {
    res = null
  }
  if (token !== loadToken) return
  if (res?.ok) {
    today.value = res.today
    all.value = pickerRows(res.notes, res.today)
    status.value = 'ready'
  } else {
    status.value = 'error'
  }
}

watch(
  isOpen,
  (open) => {
    if (!open) {
      loadToken++
      return
    }
    query.value = ''
    selectedIndex.value = 0
    opening.value = false
    void load()
  },
  { immediate: true }
)

watch(query, () => {
  selectedIndex.value = 0
})

/** Day-of-week 0-6 as a localized long name; the reference week starts on a Sunday. */
function weekdayName(weekday: number): string {
  return new Intl.DateTimeFormat(locale.value, { weekday: 'long' }).format(
    new Date(2024, 0, 7 + weekday)
  )
}

function hintFor(date: string): string {
  const hint = relativeHint(date, today.value)
  if (hint === 'today') return t('notes.picker.today')
  if (hint === 'yesterday') return t('notes.picker.yesterday')
  return weekdayName(hint.weekday)
}

async function choose(row: PickerRow): Promise<void> {
  if (opening.value) return
  opening.value = true
  try {
    // A null filePath is today's note, which main creates on demand: ask for it without a date.
    await openNoteInStack(folder.value, row.filePath ? row.date : undefined)
  } finally {
    opening.value = false
    ui.closeDialog()
  }
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    // stopPropagation: the window-level sidebar cursor would otherwise also walk the tree behind us.
    e.preventDefault()
    e.stopPropagation()
    const last = rows.value.length - 1
    if (last < 0) return
    const step = e.key === 'ArrowDown' ? 1 : -1
    selectedIndex.value = Math.min(last, Math.max(0, selectedIndex.value + step))
    return
  }
  if (e.key === 'Enter') {
    e.preventDefault()
    e.stopPropagation()
    const row = rows.value[selectedIndex.value]
    if (row) void choose(row)
  }
}
</script>

<template>
  <Dialog
    :open="isOpen"
    size="md"
    placement="top"
    :title="$t('notes.picker.title')"
    :subtitle="basename(folder)"
    initial-focus="[data-notes-picker-input]"
    @close="ui.closeDialog()"
  >
    <div class="-mx-4.5 -my-3.5" @keydown="onKeydown">
      <div
        class="flex shrink-0 items-center border-b border-border"
        style="height: 34px; padding: 0 10px; gap: 8px"
      >
        <Search :size="14" :stroke-width="1.5" class="shrink-0 text-text-3" />
        <input
          v-model="query"
          data-notes-picker-input
          type="text"
          class="min-w-0 flex-1 bg-transparent text-text outline-none placeholder:text-text-4"
          style="font-size: 12.5px"
          autocomplete="off"
          spellcheck="false"
          :placeholder="$t('notes.picker.searchPlaceholder')"
        />
        <kbd
          class="shrink-0 border border-border-2 bg-surface font-mono text-text-3"
          style="font-size: 10px; line-height: 14px; border-radius: 4px; padding: 0 4px"
          >esc</kbd
        >
      </div>

      <div
        class="scrollable overflow-y-auto"
        style="max-height: 46vh; padding: 4px 0"
        role="listbox"
      >
        <button
          v-for="(row, i) in rows"
          :key="row.date"
          type="button"
          role="option"
          data-notes-picker-row
          :data-date="row.date"
          :aria-selected="i === selectedIndex"
          tabindex="-1"
          class="relative flex w-full items-center text-left transition focus:outline-none"
          :class="
            i === selectedIndex
              ? 'bg-surface-2 text-text'
              : 'text-text-2 hover:bg-surface-2 hover:text-text'
          "
          style="height: 28px; padding: 0 10px; gap: 8px"
          @mouseenter="selectedIndex = i"
          @click="choose(row)"
        >
          <span
            v-if="i === selectedIndex"
            class="absolute bg-accent"
            style="left: 0; top: 0; bottom: 0; width: 2px; border-radius: 0 2px 2px 0"
            aria-hidden="true"
          />
          <span class="min-w-0 flex-1 truncate font-mono" style="font-size: 12.5px">{{
            row.date
          }}</span>
          <span class="shrink-0 truncate text-text-4" style="font-size: 11px">{{
            hintFor(row.date)
          }}</span>
          <CornerDownLeft
            v-if="i === selectedIndex"
            :size="12"
            :stroke-width="1.8"
            class="shrink-0 text-text-4"
          />
        </button>

        <div
          v-if="status === 'error'"
          data-notes-picker-error
          class="text-text-3"
          style="padding: 14px 12px; font-size: 11.5px; line-height: 1.5"
        >
          {{ $t('notes.picker.loadFailed') }}
        </div>
        <div
          v-else-if="status === 'ready' && rows.length === 0"
          data-notes-picker-empty
          class="text-text-3"
          style="padding: 14px 12px; font-size: 11.5px; line-height: 1.5"
        >
          {{ $t('notes.picker.empty') }}
        </div>
      </div>

      <div
        class="flex shrink-0 items-center border-t border-border text-text-4"
        style="height: 26px; padding: 0 10px; gap: 10px; font-size: 10.5px"
      >
        <span
          ><kbd
            class="border border-border-2 bg-surface font-mono text-text-3"
            style="font-size: 10px; border-radius: 4px; padding: 0 4px"
            >↑↓</kbd
          >
          {{ $t('notes.picker.hints.move') }}</span
        >
        <span
          ><kbd
            class="border border-border-2 bg-surface font-mono text-text-3"
            style="font-size: 10px; border-radius: 4px; padding: 0 4px"
            >↵</kbd
          >
          {{ $t('notes.picker.hints.open') }}</span
        >
      </div>
    </div>
  </Dialog>
</template>
