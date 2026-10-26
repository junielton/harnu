<script setup lang="ts">
/**
 * Split menu (design.md §6, T564 U1): a chevron beside the Topbar's Split button that opens a small dropdown
 * of what to split off — a Terminal (the button's own one-click action) or a Browser pane. The dropdown is
 * teleported to `<body>` so no ancestor clips it, which also means the native-overlay freeze covers it
 * automatically: a browser pane under the menu freezes instead of drawing over it.
 */
import { nextTick, onBeforeUnmount, ref } from 'vue'
import { ChevronDown, Globe, Terminal } from 'lucide-vue-next'

const emit = defineEmits<{ terminal: []; browser: [] }>()

const open = ref(false)
const buttonEl = ref<HTMLButtonElement | null>(null)
const menuEl = ref<HTMLElement | null>(null)
const pos = ref({ top: 0, right: 0 })

async function toggle(): Promise<void> {
  if (open.value) return close()
  const r = buttonEl.value?.getBoundingClientRect()
  if (r) pos.value = { top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) }
  open.value = true
  window.addEventListener('mousedown', onOutside, true)
  window.addEventListener('keydown', onKey, true)
  await nextTick()
  menuEl.value?.querySelector<HTMLElement>('button')?.focus()
}

function close(): void {
  open.value = false
  window.removeEventListener('mousedown', onOutside, true)
  window.removeEventListener('keydown', onKey, true)
}

function onOutside(ev: MouseEvent): void {
  const target = ev.target as Node | null
  if (target && (menuEl.value?.contains(target) || buttonEl.value?.contains(target))) return
  close()
}
function onKey(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') {
    ev.stopPropagation()
    close()
  }
}

function pick(kind: 'terminal' | 'browser'): void {
  close()
  if (kind === 'terminal') emit('terminal')
  else emit('browser')
}

onBeforeUnmount(close)
</script>

<template>
  <button
    ref="buttonEl"
    type="button"
    class="flex items-center justify-center rounded text-text-3 transition hover:bg-surface hover:text-text"
    style="width: 16px; height: 26px; margin-left: -4px"
    :title="$t('splitMenu.label')"
    :aria-label="$t('splitMenu.label')"
    aria-haspopup="menu"
    :aria-expanded="open"
    data-test="topbar-split-menu"
    @click="toggle"
  >
    <ChevronDown :size="11" :stroke-width="1.5" />
  </button>
  <Teleport to="body">
    <div
      v-if="open"
      ref="menuEl"
      class="anim-fade-in fixed z-[60] min-w-[160px] rounded border border-border bg-surface py-1 text-[12px] text-text-2"
      :style="{ top: `${pos.top}px`, right: `${pos.right}px`, boxShadow: 'var(--shadow-pop)' }"
      role="menu"
      data-test="split-menu"
    >
      <button
        type="button"
        role="menuitem"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-2 hover:text-text focus:bg-surface-2 focus:outline-none"
        data-test="split-menu-terminal"
        @click="pick('terminal')"
      >
        <Terminal :size="13" :stroke-width="1.5" />
        {{ $t('splitMenu.terminal') }}
      </button>
      <button
        type="button"
        role="menuitem"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-2 hover:text-text focus:bg-surface-2 focus:outline-none"
        data-test="split-menu-browser"
        @click="pick('browser')"
      >
        <Globe :size="13" :stroke-width="1.5" />
        {{ $t('splitMenu.browser') }}
      </button>
    </div>
  </Teleport>
</template>
