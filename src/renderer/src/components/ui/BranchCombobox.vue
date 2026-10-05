<script setup lang="ts">
/**
 * Searchable single-select for a repo's git branches. The closed trigger
 * looks like the native `<select>` it replaces; opening it reveals a
 * filterable Local/Remote list. Used by `NewWorktreeDialog.vue`'s Base ref
 * and Branch-to-check-out fields (design.md §6 "New worktree"). Scoped to
 * `BranchRef[]` — not a generic combobox.
 *
 * A11y baseline only (aria-haspopup/expanded on the trigger, role=listbox/
 * option on the panel) — not the full WAI-ARIA combobox pattern
 * (aria-activedescendant etc.), which isn't warranted for a two-call-site
 * internal primitive.
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { Check, ChevronDown } from 'lucide-vue-next'
import type { BranchRef } from '../../../../preload'

const props = withDefaults(
  defineProps<{
    modelValue: string
    branches: BranchRef[]
    loading?: boolean
    placeholder: string
    localLabel: string
    remoteLabel: string
    noMatchLabel: string
    searchPlaceholder: string
    id?: string
  }>(),
  { loading: false }
)

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const open = ref(false)
const query = ref('')

const triggerRef = ref<HTMLElement | null>(null)
const panelRef = ref<HTMLElement | null>(null)
const searchInputRef = ref<HTMLInputElement | null>(null)

const selectedBranch = computed(
  () => props.branches.find((b) => b.name === props.modelValue) ?? null
)
const triggerLabel = computed(() => selectedBranch.value?.name ?? props.modelValue)

function matchesQuery(b: BranchRef): boolean {
  const q = query.value.trim().toLowerCase()
  if (!q) return true
  return b.name.toLowerCase().includes(q)
}

const filteredLocal = computed(() => props.branches.filter((b) => !b.remote && matchesQuery(b)))
const filteredRemote = computed(() => props.branches.filter((b) => b.remote && matchesQuery(b)))
const defaultRowVisible = computed(() => query.value.trim().length === 0)
const hasNoMatches = computed(
  () =>
    !defaultRowVisible.value &&
    filteredLocal.value.length === 0 &&
    filteredRemote.value.length === 0
)

const highlightedIndex = ref(0)

/** Flat, keyboard-navigable name list: default row (`''`) if visible, then Local, then Remote. */
const visibleNames = computed<string[]>(() => {
  const names: string[] = []
  if (defaultRowVisible.value) names.push('')
  for (const b of filteredLocal.value) names.push(b.name)
  for (const b of filteredRemote.value) names.push(b.name)
  return names
})

function isHighlighted(name: string): boolean {
  return visibleNames.value[highlightedIndex.value] === name
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
  if (props.loading) return
  open.value = true
  query.value = ''
  await nextTick()
  const idx = visibleNames.value.indexOf(props.modelValue)
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

function selectBranch(name: string): void {
  emit('update:modelValue', name)
  closePanel()
  triggerRef.value?.focus()
}

function onSearchKeydown(e: KeyboardEvent): void {
  const names = visibleNames.value
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    if (names.length === 0) return
    highlightedIndex.value = (highlightedIndex.value + 1) % names.length
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    if (names.length === 0) return
    highlightedIndex.value = (highlightedIndex.value - 1 + names.length) % names.length
  } else if (e.key === 'Enter') {
    e.preventDefault()
    const name = names[highlightedIndex.value]
    if (name !== undefined) selectBranch(name)
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
    class="flex w-full items-center justify-between border border-border bg-bg text-text transition focus:border-accent-line"
    style="border-radius: 5px; padding: 0 10px; font-size: 13px; height: 32px"
    :style="{ opacity: loading ? 0.6 : 1, cursor: loading ? 'not-allowed' : 'pointer' }"
    :disabled="loading"
    aria-haspopup="listbox"
    :aria-expanded="open"
    data-branch-combobox-trigger
    @click="toggle()"
  >
    <span class="truncate font-mono" :class="selectedBranch ? 'text-text' : 'text-text-4'">
      {{ triggerLabel || placeholder }}
    </span>
    <ChevronDown
      :size="13"
      :stroke-width="1.8"
      class="shrink-0 text-text-3"
      style="margin-left: 6px"
    />
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
      data-branch-combobox-panel
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
        data-branch-combobox-search
        @keydown="onSearchKeydown"
      />
      <ul
        role="listbox"
        class="scrollable overflow-y-auto"
        style="max-height: 260px; margin: 0; padding: 4px 0; list-style: none"
      >
        <li v-if="defaultRowVisible">
          <button
            type="button"
            role="option"
            class="w-full text-left text-text-4 transition hover:bg-surface-2"
            :class="{ 'bg-surface-2': isHighlighted('') }"
            style="padding: 6px 10px; font-size: 12.5px"
            data-branch-combobox-row
            data-branch-name=""
            @click="selectBranch('')"
          >
            {{ placeholder }}
          </button>
        </li>
        <template v-if="filteredLocal.length">
          <li class="eyebrow text-text-4" style="padding: 6px 10px 2px">
            {{ localLabel }}
          </li>
          <li v-for="b in filteredLocal" :key="'l-' + b.name">
            <button
              type="button"
              role="option"
              :aria-selected="b.name === modelValue"
              class="flex w-full items-center justify-between text-left text-text transition hover:bg-surface-2"
              :class="{ 'bg-surface-2': isHighlighted(b.name) }"
              style="padding: 6px 10px; font-size: 12.5px"
              data-branch-combobox-row
              :data-branch-name="b.name"
              @click="selectBranch(b.name)"
            >
              <span class="truncate font-mono">{{ b.name }}</span>
              <Check
                v-if="b.name === modelValue"
                :size="12"
                :stroke-width="2"
                class="shrink-0 text-accent"
              />
            </button>
          </li>
        </template>
        <template v-if="filteredRemote.length">
          <li class="eyebrow text-text-4" style="padding: 6px 10px 2px">
            {{ remoteLabel }}
          </li>
          <li v-for="b in filteredRemote" :key="'r-' + b.name">
            <button
              type="button"
              role="option"
              :aria-selected="b.name === modelValue"
              class="flex w-full items-center justify-between text-left text-text transition hover:bg-surface-2"
              :class="{ 'bg-surface-2': isHighlighted(b.name) }"
              style="padding: 6px 10px; font-size: 12.5px"
              data-branch-combobox-row
              :data-branch-name="b.name"
              @click="selectBranch(b.name)"
            >
              <span class="truncate font-mono">{{ b.name }}</span>
              <Check
                v-if="b.name === modelValue"
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
          data-branch-combobox-empty
        >
          {{ noMatchLabel }}
        </li>
      </ul>
    </div>
  </Teleport>
</template>
