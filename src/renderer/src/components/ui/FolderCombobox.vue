<script lang="ts">
/**
 * Pure helpers for `FolderCombobox`, exported (and unit-tested) without
 * mounting per T291 Task 8. A plain `<script>` block in a Vue SFC runs once
 * at module scope and its top-level bindings are visible to the sibling
 * `<script setup>` block below (see `StatusFooter.vue`'s
 * `shouldBumpImagePill` for the established pattern in this repo).
 */
import type { Folder } from '../../stores/sessions'

/** One row in the panel: a repo header + its member folders, or a lone
 * folder with no header (`label` undefined). */
export interface FolderGroupEntry {
  key: string
  label?: string
  folders: Folder[]
}

/** Cross-platform basename — folders may come from Linux/macOS/Windows. */
function basenameOf(p: string): string {
  return (
    p
      .replace(/[/\\]+$/, '')
      .split(/[/\\]/)
      .pop() ?? ''
  )
}

/** Matches on alias, branch and path (AC-1) — whichever the operator types. */
export function filterFolders(folders: readonly Folder[], query: string): Folder[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...folders]
  return folders.filter(
    (f) =>
      f.alias.toLowerCase().includes(q) ||
      (f.gitBranch ?? '').toLowerCase().includes(q) ||
      f.path.toLowerCase().includes(q)
  )
}

/**
 * Groups folders sharing a `repoId` (2+ members) under one header, in
 * first-seen order — the same rule `groupByRepo` (`stores/folder-zones.ts`)
 * uses for the sidebar, so a repo's worktrees stay in the sidebar's own
 * order here too (AC-2). A folder with no repoId, or the only folder holding
 * one, passes through as its own ungrouped (headerless) entry.
 */
export function groupFoldersByRepo(folders: readonly Folder[]): FolderGroupEntry[] {
  const counts = new Map<string, number>()
  for (const f of folders) {
    if (f.repoId) counts.set(f.repoId, (counts.get(f.repoId) ?? 0) + 1)
  }

  const out: FolderGroupEntry[] = []
  const emitted = new Set<string>()

  for (const f of folders) {
    const repoId = f.repoId
    const isGrouped = repoId !== undefined && repoId !== '' && (counts.get(repoId) ?? 0) >= 2

    if (!isGrouped) {
      out.push({ key: f.path, folders: [f] })
      continue
    }

    if (emitted.has(repoId)) continue
    emitted.add(repoId)

    const members = folders.filter((m) => m.repoId === repoId)
    const main = members.find((m) => m.isMainWorktree === true) ?? members[0]
    const label = main?.alias?.trim() || basenameOf(main?.path ?? repoId) || repoId
    out.push({ key: `repo:${repoId}`, label, folders: members })
  }

  return out
}

/** Sentinel key for the trailing "Choose another folder…" row in the flat,
 * keyboard-navigable list — never collides with a real folder path. */
export const CHOOSE_ANOTHER_KEY = '__choose-another-folder__'
</script>

<script setup lang="ts">
/**
 * Searchable single-select over the folders Harnu already knows (T291 Task
 * 8, T293). Sibling of `ui/BranchCombobox.vue` — same anatomy (trigger that
 * looks like the `<select>` it replaces, filterable panel,
 * aria-haspopup/expanded on the trigger, role=listbox/option on the panel)
 * — deliberately NOT a generalization of it: `BranchCombobox` is scoped to
 * `BranchRef[]` with two call sites of its own, and folding folders into it
 * would risk a `NewWorktreeDialog` regression for nothing.
 *
 * A free-text path input is explicitly rejected by the spec this component
 * serves (the Scheduler worker form): a typo becomes a worker that dies
 * silently at 3am. So `modelValue` is always a path from `folders`, or a
 * stale one Harnu no longer knows about — see `triggerLabel` below.
 *
 * A11y baseline only, matching `BranchCombobox` — not the full WAI-ARIA
 * combobox pattern (aria-activedescendant etc.).
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { Check, ChevronDown, Folder as FolderIcon } from 'lucide-vue-next'

const props = withDefaults(
  defineProps<{
    modelValue: string
    folders: Folder[]
    placeholder: string
    searchPlaceholder: string
    noMatchLabel: string
    chooseAnotherLabel: string
    id?: string
  }>(),
  {}
)

const emit = defineEmits<{ 'update:modelValue': [value: string]; 'choose-folder': [] }>()

const open = ref(false)
const query = ref('')

const triggerRef = ref<HTMLElement | null>(null)
const panelRef = ref<HTMLElement | null>(null)
const searchInputRef = ref<HTMLInputElement | null>(null)

/**
 * `null` when `modelValue` doesn't match any known folder — a folder Harnu
 * adopted then lost (deleted worktree, moved dir). The trigger still shows
 * the raw value rather than falling back to the placeholder (AC-3): reading
 * as "nothing selected" would hide that a worker is pointed at a folder that
 * no longer resolves, the same synthetic-pill rule `SegmentedControl` follows
 * for a value with no matching option.
 */
const selectedFolder = computed(
  () => props.folders.find((f) => f.path === props.modelValue) ?? null
)

const visibleGroups = computed(() => groupFoldersByRepo(filterFolders(props.folders, query.value)))
const hasNoMatches = computed(
  () => query.value.trim().length > 0 && visibleGroups.value.length === 0
)

const highlightedIndex = ref(0)

/** Flat, keyboard-navigable key list: every visible folder path, then the
 * "Choose another folder…" sentinel — always present regardless of query. */
const flatKeys = computed<string[]>(() => {
  const keys: string[] = []
  for (const group of visibleGroups.value) {
    for (const f of group.folders) keys.push(f.path)
  }
  keys.push(CHOOSE_ANOTHER_KEY)
  return keys
})

function isHighlighted(key: string): boolean {
  return flatKeys.value[highlightedIndex.value] === key
}

watch(query, () => {
  highlightedIndex.value = 0
})

const panelStyle = ref({ left: '0px', top: '0px', bottom: 'auto', width: '0px' })

async function measureAndPosition(): Promise<void> {
  await nextTick()
  const trigger = triggerRef.value
  const panel = panelRef.value
  if (!trigger || !panel) return
  const rect = trigger.getBoundingClientRect()
  const panelHeight = panel.getBoundingClientRect().height
  const margin = 4
  const fitsBelow = rect.bottom + margin + panelHeight <= window.innerHeight
  panelStyle.value = fitsBelow
    ? {
        left: `${rect.left}px`,
        top: `${rect.bottom + margin}px`,
        bottom: 'auto',
        width: `${rect.width}px`
      }
    : {
        left: `${rect.left}px`,
        top: 'auto',
        bottom: `${window.innerHeight - rect.top + margin}px`,
        width: `${rect.width}px`
      }
}

async function openPanel(): Promise<void> {
  open.value = true
  query.value = ''
  await nextTick()
  const idx = flatKeys.value.indexOf(props.modelValue)
  highlightedIndex.value = idx >= 0 ? idx : 0
  searchInputRef.value?.focus()
  await measureAndPosition()
}

function closePanel(): void {
  open.value = false
}

function toggle(): void {
  if (open.value) closePanel()
  else void openPanel()
}

function selectFolder(path: string): void {
  emit('update:modelValue', path)
  closePanel()
  triggerRef.value?.focus()
}

function chooseAnother(): void {
  emit('choose-folder')
  closePanel()
  triggerRef.value?.focus()
}

function activate(key: string): void {
  if (key === CHOOSE_ANOTHER_KEY) chooseAnother()
  else selectFolder(key)
}

function onSearchKeydown(e: KeyboardEvent): void {
  const keys = flatKeys.value
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    if (keys.length === 0) return
    highlightedIndex.value = (highlightedIndex.value + 1) % keys.length
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    if (keys.length === 0) return
    highlightedIndex.value = (highlightedIndex.value - 1 + keys.length) % keys.length
  } else if (e.key === 'Enter') {
    e.preventDefault()
    const key = keys[highlightedIndex.value]
    if (key !== undefined) activate(key)
  } else if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    closePanel()
    triggerRef.value?.focus()
  }
}

function onWindowMousedown(e: MouseEvent): void {
  if (!open.value) return
  const target = e.target as Node
  if (triggerRef.value?.contains(target)) return
  if (panelRef.value?.contains(target)) return
  closePanel()
}

watch(open, (isOpen) => {
  if (isOpen) {
    window.addEventListener('mousedown', onWindowMousedown, true)
  } else {
    window.removeEventListener('mousedown', onWindowMousedown, true)
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('mousedown', onWindowMousedown, true)
})
</script>

<template>
  <button
    :id="id"
    ref="triggerRef"
    type="button"
    class="flex w-full items-center border border-border-2 bg-surface text-text transition focus:border-accent-line"
    style="border-radius: 5px; padding: 0 8px 0 10px; height: 32px; gap: 7px"
    aria-haspopup="listbox"
    :aria-expanded="open"
    data-folder-combobox-trigger
    @click="toggle()"
  >
    <FolderIcon :size="11" :stroke-width="1.6" class="shrink-0 text-text-3" />
    <span class="flex-1 truncate text-left" style="font-size: 12px">
      <template v-if="selectedFolder">
        <span :class="selectedFolder ? 'text-text' : 'text-text-4'">{{
          selectedFolder.alias
        }}</span>
        <span v-if="selectedFolder.gitBranch" class="text-text-4">
          · {{ selectedFolder.gitBranch }}</span
        >
      </template>
      <template v-else>
        <span :class="modelValue ? 'text-text' : 'text-text-4'">{{
          modelValue || placeholder
        }}</span>
      </template>
    </span>
    <ChevronDown :size="11" :stroke-width="1.6" class="shrink-0 text-text-3" />
  </button>

  <Teleport to="body">
    <div
      v-if="open"
      ref="panelRef"
      class="fixed border border-border-2 bg-surface"
      :style="{
        left: panelStyle.left,
        top: panelStyle.top,
        bottom: panelStyle.bottom,
        width: panelStyle.width,
        zIndex: 70
      }"
      style="border-radius: 7px; box-shadow: var(--shadow-pop)"
      data-folder-combobox-panel
    >
      <input
        ref="searchInputRef"
        v-model="query"
        type="text"
        autocomplete="off"
        spellcheck="false"
        class="w-full border-b border-border bg-transparent text-text"
        style="padding: 8px 10px; font-size: 12.5px; outline: none"
        :placeholder="searchPlaceholder"
        data-folder-combobox-search
        @keydown="onSearchKeydown"
      />
      <ul
        role="listbox"
        class="scrollable overflow-y-auto"
        style="max-height: 260px; margin: 0; padding: 4px 0; list-style: none"
      >
        <template v-for="group in visibleGroups" :key="group.key">
          <li v-if="group.label" class="eyebrow text-text-4" style="padding: 6px 10px 2px">
            {{ group.label }}
          </li>
          <li v-for="f in group.folders" :key="f.path">
            <button
              type="button"
              role="option"
              :aria-selected="f.path === modelValue"
              class="flex w-full items-center justify-between text-left text-text transition hover:bg-surface-2"
              :class="{ 'bg-surface-2': isHighlighted(f.path) }"
              style="padding: 6px 10px; font-size: 12.5px"
              data-folder-combobox-row
              :data-folder-path="f.path"
              @click="selectFolder(f.path)"
            >
              <span class="flex min-w-0 items-center gap-1 truncate">
                <span class="truncate">{{ f.alias }}</span>
                <span v-if="f.gitBranch" class="shrink-0 text-text-4">· {{ f.gitBranch }}</span>
              </span>
              <Check
                v-if="f.path === modelValue"
                :size="12"
                :stroke-width="2"
                class="shrink-0 text-accent"
              />
            </button>
          </li>
        </template>
        <li
          v-if="hasNoMatches"
          class="text-text-4"
          style="padding: 8px 10px; font-size: 12px"
          data-folder-combobox-empty
        >
          {{ noMatchLabel }}
        </li>
        <li>
          <button
            type="button"
            role="option"
            class="w-full text-left text-text-3 transition hover:bg-surface-2"
            :class="{ 'bg-surface-2': isHighlighted(CHOOSE_ANOTHER_KEY) }"
            style="padding: 6px 10px; font-size: 12.5px; border-top: 1px solid var(--color-border)"
            data-folder-combobox-choose-another
            @click="chooseAnother()"
          >
            {{ chooseAnotherLabel }}
          </button>
        </li>
      </ul>
    </div>
  </Teleport>
</template>
