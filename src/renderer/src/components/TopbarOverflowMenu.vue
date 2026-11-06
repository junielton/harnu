<script setup lang="ts">
/**
 * The Topbar's `…` "More actions" button and its menu (BUG-252, design.md §6 "Topbar overflow"). Holds
 * the actions the bar had no room for, with the icon, label, chord hint, state and handler they have in
 * the bar. Anatomy of the menu is the Context menu of §6; the anchoring is the Activity bell's.
 */
import { nextTick, ref, watch } from 'vue'
import { onClickOutside } from '@vueuse/core'
import { Ellipsis } from 'lucide-vue-next'
import { useNativeOverlay } from '../composables/useNativeOverlay'
import type { TopbarActionId, TopbarActionView } from '../lib/topbar-overflow'

const props = defineProps<{ actions: TopbarActionView[] }>()
const emit = defineEmits<{ select: [id: TopbarActionId] }>()

const rootRef = ref<HTMLElement | null>(null)
const triggerRef = ref<HTMLButtonElement | null>(null)
const menuRef = ref<HTMLElement | null>(null)
const itemRefs = ref<Array<HTMLElement | null>>([])
const open = ref(false)
const focusedIndex = ref(0)

// An in-app popover: a browser pane under it freezes instead of drawing over it.
useNativeOverlay('topbar-overflow-menu', menuRef)
onClickOutside(rootRef, () => {
  open.value = false
})

/** Indexes of the rows the arrows may land on (a disabled row is skipped). */
function enabledIndexes(): number[] {
  return props.actions.flatMap((a, i) => (a.disabled ? [] : [i]))
}

async function focusRow(index: number): Promise<void> {
  focusedIndex.value = index
  await nextTick()
  itemRefs.value[index]?.focus()
}

async function openMenu(where: 'first' | 'last' | 'none'): Promise<void> {
  open.value = true
  const rows = enabledIndexes()
  if (where === 'none' || rows.length === 0) return
  await focusRow(where === 'first' ? rows[0] : rows[rows.length - 1])
}

function closeMenu(returnFocus: boolean): void {
  open.value = false
  if (returnFocus) triggerRef.value?.focus()
}

function select(index: number): void {
  const action = props.actions[index]
  if (!action || action.disabled) return
  closeMenu(true)
  emit('select', action.id)
}

function move(step: 1 | -1): void {
  const rows = enabledIndexes()
  if (rows.length === 0) return
  const at = rows.indexOf(focusedIndex.value)
  const next = at === -1 ? 0 : (at + step + rows.length) % rows.length
  void focusRow(rows[next])
}

function onKeydown(e: KeyboardEvent): void {
  const consume = (): void => {
    e.preventDefault()
    e.stopPropagation()
  }
  if (!open.value) {
    // Only the trigger is focusable while closed.
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      consume()
      void openMenu('first')
    } else if (e.key === 'ArrowUp') {
      consume()
      void openMenu('last')
    }
    return
  }
  // The menu was opened with the mouse and focus is still on the trigger: it behaves like closed.
  if (e.target === triggerRef.value) {
    if (e.key === 'Enter' || e.key === ' ') {
      consume()
      closeMenu(false)
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      consume()
      void openMenu(e.key === 'ArrowDown' ? 'first' : 'last')
      return
    }
  }
  switch (e.key) {
    case 'ArrowDown':
      consume()
      move(1)
      break
    case 'ArrowUp':
      consume()
      move(-1)
      break
    case 'Home':
      consume()
      if (enabledIndexes().length) void focusRow(enabledIndexes()[0])
      break
    case 'End':
      consume()
      if (enabledIndexes().length) void focusRow(enabledIndexes().at(-1)!)
      break
    case 'Enter':
    case ' ':
      consume()
      select(focusedIndex.value)
      break
    case 'Escape':
      consume()
      closeMenu(true)
      break
    case 'Tab':
      closeMenu(false)
      break
  }
}

/** Space activates a button on key-up; `onKeydown` already handled it, so swallow the synthesized click. */
function onKeyup(e: KeyboardEvent): void {
  if (e.key === ' ') e.preventDefault()
}

// The menu can lose rows while open (the bar got wider and took them back).
watch(
  () => props.actions.length,
  (n) => {
    if (n === 0) open.value = false
    else if (focusedIndex.value >= n) focusedIndex.value = n - 1
  }
)
</script>

<template>
  <div ref="rootRef" class="relative" @keydown="onKeydown" @keyup="onKeyup">
    <button
      ref="triggerRef"
      type="button"
      class="flex items-center justify-center rounded transition"
      :class="open ? 'bg-accent-soft text-accent' : 'text-text-3 hover:bg-surface hover:text-text'"
      style="width: 26px; height: 26px"
      :title="$t('topbar.moreActions')"
      :aria-label="$t('topbar.moreActions')"
      aria-haspopup="menu"
      :aria-expanded="open"
      data-test="topbar-more"
      @click="open ? closeMenu(false) : openMenu('none')"
    >
      <Ellipsis :size="14" :stroke-width="1.5" />
    </button>

    <div
      v-if="open"
      ref="menuRef"
      role="menu"
      :aria-label="$t('topbar.moreActions')"
      class="anim-fade-in-scale absolute right-0 top-full z-50 mt-1.5 flex flex-col rounded border border-border-2 bg-surface shadow-pop"
      style="min-width: 200px; padding: 4px"
      data-test="topbar-overflow-menu"
    >
      <button
        v-for="(a, i) in actions"
        :key="a.id"
        :ref="(el) => (itemRefs[i] = el as HTMLElement | null)"
        type="button"
        :role="a.toggle ? 'menuitemcheckbox' : 'menuitem'"
        :aria-checked="a.toggle ? a.state === 'on' : undefined"
        :aria-disabled="a.disabled || undefined"
        :disabled="a.disabled"
        :tabindex="i === focusedIndex ? 0 : -1"
        class="flex w-full items-center rounded-sm text-left outline-none transition focus-visible:bg-surface-2"
        :class="
          a.disabled
            ? 'cursor-default text-text-disabled'
            : a.state === 'on'
              ? 'bg-accent-soft text-accent hover:bg-surface-2'
              : a.state === 'ink'
                ? 'text-accent hover:bg-surface-2'
                : 'text-text-2 hover:bg-surface-2'
        "
        style="padding: 6px 8px; gap: 9px; font-size: 12px"
        :data-test="`topbar-overflow-item-${a.id}`"
        @focus="focusedIndex = i"
        @click="select(i)"
      >
        <component :is="a.icon" v-bind="a.iconProps" class="shrink-0" />
        <span class="min-w-0 flex-1 truncate">{{ a.label }}</span>
        <span
          v-if="a.hint"
          class="shrink-0 font-mono text-text-4"
          style="font-size: 10.5px; margin-left: 12px"
          >{{ a.hint }}</span
        >
      </button>
    </div>
  </div>
</template>
