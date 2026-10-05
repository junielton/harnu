<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import {
  ChevronRight,
  Folder as FolderIcon,
  GitBranch,
  PencilLine,
  RotateCcw,
  Trash2
} from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { useSessionsStore } from '../stores/sessions'
import { useUiStore } from '../stores/ui'
import type { FolderGroup } from '../stores/folder-zones'
import type { Folder } from '../stores/sessions'

/**
 * Collapsible header for a sidebar group — 2+ visible folders that belong
 * together (spec §5.3, design.md §6), either as worktrees of one repo
 * (`source: 'repo'`) or as folders sharing a direct parent directory
 * (`source: 'path'`, T182). Reuses the existing sidebar-row anatomy
 * (Section-label typography, no new tokens); the only per-source difference is
 * the 13px icon. The chevron is 13px like the section menu. Clicking the row
 * toggles every member folder via `toggleGroup(key)`.
 *
 * T88: the label prefers a group alias (the grouping functions resolve it), a
 * right-click context menu renames/resets that alias, and a dim `parentHint`
 * disambiguates two groups that resolve to the same label.
 */
const props = defineProps<{ group: FolderGroup<Folder> }>()

const sessions = useSessionsStore()
const ui = useUiStore()
const { t } = useI18n()

const focused = computed(
  () => sessions.keyboardCursor?.kind === 'group' && sessions.keyboardCursor.id === props.group.key
)

function toggle(): void {
  sessions.toggleGroup(props.group.key)
}

// ── Context menu (T88 — Rename repo / Reset name) ─────────────────────────
const menu = ref<{ open: boolean; x: number; y: number }>({ open: false, x: 0, y: 0 })
const menuRef = ref<HTMLElement | null>(null)
/** Whether this group currently has a custom alias (gates "Reset name"). */
const hasAlias = computed<boolean>(() => !!sessions.groupAliases[props.group.key])

function openMenu(e: MouseEvent): void {
  e.preventDefault()
  // Clamp against the right/bottom edges so a small menu near the viewport edge
  // stays on-screen (approx size — up to three short rows: Rename, Reset name
  // when aliased, Cleanup).
  const MENU_W = 172
  const MENU_H = 108
  const margin = 8
  const x = Math.min(e.clientX, window.innerWidth - MENU_W - margin)
  const y = Math.min(e.clientY, window.innerHeight - MENU_H - margin)
  menu.value = { open: true, x: Math.max(margin, x), y: Math.max(margin, y) }
  window.addEventListener('mousedown', onDismiss, true)
  window.addEventListener('keydown', onMenuKeydown, true)
  window.addEventListener('wheel', closeMenu, { passive: true })
}

function closeMenu(): void {
  if (!menu.value.open) return
  menu.value = { open: false, x: 0, y: 0 }
  window.removeEventListener('mousedown', onDismiss, true)
  window.removeEventListener('keydown', onMenuKeydown, true)
  window.removeEventListener('wheel', closeMenu)
}

function onDismiss(e: MouseEvent): void {
  if (menuRef.value?.contains(e.target as Node)) return
  closeMenu()
}

function onMenuKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.stopPropagation()
    e.preventDefault()
    closeMenu()
  }
}

function rename(): void {
  ui.openRenameRepo(props.group.key, props.group.derivedLabel)
  closeMenu()
}

function resetName(): void {
  sessions.setGroupAlias(props.group.key, '')
  closeMenu()
}

/**
 * The Reaper snapshot groups by main-worktree folder path (`repoPath`), not
 * by `repoId` (folder-zones' own git-derived key) — so the Cleanup takeover's
 * scroll target has to be that folder's path, not the group's id. Only a REPO
 * group has a meaningful target: a path group is an arbitrary set of sibling
 * directories with no shared git history to sweep.
 */
function openCleanup(): void {
  const mainPath =
    props.group.folders.find((f) => f.isMainWorktree)?.path ?? props.group.folders[0]?.path
  if (mainPath) ui.openCleanup(mainPath)
  closeMenu()
}

onBeforeUnmount(() => {
  window.removeEventListener('mousedown', onDismiss, true)
  window.removeEventListener('keydown', onMenuKeydown, true)
  window.removeEventListener('wheel', closeMenu)
})
</script>

<template>
  <button
    class="sidebar-row group flex w-full cursor-pointer items-center text-left text-text transition hover:bg-surface"
    style="height: 26px; padding: 0 12px 0 8px; gap: 4px; font-size: 12.5px; font-weight: 500"
    :data-focused="focused ? 'true' : null"
    @click="toggle"
    @contextmenu="openMenu"
  >
    <span
      class="flex shrink-0 items-center justify-center text-text-4"
      style="width: 16px; height: 16px"
    >
      <ChevronRight
        :size="13"
        :stroke-width="1.8"
        class="transition-transform"
        :style="{
          transform: group.expanded ? 'rotate(90deg)' : 'rotate(0deg)',
          transitionDuration: 'var(--dur)',
          transitionTimingFunction: 'var(--ease)'
        }"
      />
    </span>
    <GitBranch
      v-if="group.source === 'repo'"
      :size="13"
      :stroke-width="1.6"
      class="shrink-0 text-text-3"
      style="margin-right: 2px"
    />
    <FolderIcon
      v-else
      :size="13"
      :stroke-width="1.6"
      class="shrink-0 text-text-3"
      style="margin-right: 2px"
    />
    <span class="flex-1 truncate">{{ group.label }}</span>
    <!-- T88 disambiguator: dim parent-dir hint when two groups share a label. -->
    <span
      v-if="group.parentHint"
      class="shrink-0 truncate text-text-4"
      style="font-size: 10.5px; max-width: 45%"
      :title="group.parentHint"
      >· {{ group.parentHint }}</span
    >
    <!-- Member count — "Stats sob demanda" (T118): hover-only while the group is
         expanded (the member rows below count themselves); visible while
         collapsed (the only hint of how many worktrees are hidden) and under the
         keyboard cursor. -->
    <span
      class="shrink-0 text-text-4 tabular-nums transition-opacity"
      :class="
        group.expanded && !focused
          ? 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
          : 'opacity-100'
      "
      style="font-size: 10.5px"
      >{{ group.folders.length }}</span
    >
  </button>

  <!-- Group context menu (T88): Rename / Reset name. Inline + Teleported;
       dismissed on Esc / click-outside / wheel — same idiom as FolderMenu. -->
  <Teleport to="body">
    <div
      v-if="menu.open"
      ref="menuRef"
      class="anim-fade-in-scale fixed border border-border-2 bg-surface"
      style="
        min-width: 172px;
        padding: 4px;
        border-radius: 7px;
        box-shadow: var(--shadow-pop);
        z-index: 50;
        transform-origin: top left;
      "
      :style="{ left: menu.x + 'px', top: menu.y + 'px' }"
      role="menu"
      :aria-label="t('repoGroup.menuLabel')"
    >
      <button
        role="menuitem"
        class="flex w-full items-center text-left text-text-2 transition hover:bg-surface-2 hover:text-text focus:bg-surface-2 focus:text-text focus:outline-none"
        style="gap: 9px; padding: 6px 8px; font-size: 12px; border-radius: 4px; outline: none"
        @click="rename"
      >
        <PencilLine :size="13" :stroke-width="1.6" class="shrink-0" />
        <span class="flex-1 truncate">{{ t('repoGroup.rename') }}</span>
      </button>
      <button
        v-if="hasAlias"
        role="menuitem"
        class="flex w-full items-center text-left text-text-2 transition hover:bg-surface-2 hover:text-text focus:bg-surface-2 focus:text-text focus:outline-none"
        style="gap: 9px; padding: 6px 8px; font-size: 12px; border-radius: 4px; outline: none"
        @click="resetName"
      >
        <RotateCcw :size="13" :stroke-width="1.6" class="shrink-0" />
        <span class="flex-1 truncate">{{ t('repoGroup.resetName') }}</span>
      </button>
      <button
        v-if="group.source === 'repo'"
        role="menuitem"
        class="flex w-full items-center text-left text-text-2 transition hover:bg-surface-2 hover:text-text focus:bg-surface-2 focus:text-text focus:outline-none"
        style="gap: 9px; padding: 6px 8px; font-size: 12px; border-radius: 4px; outline: none"
        @click="openCleanup"
      >
        <Trash2 :size="13" :stroke-width="1.6" class="shrink-0" />
        <span class="flex-1 truncate">{{ t('repoGroup.cleanup') }}</span>
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.sidebar-row[data-focused='true'] {
  outline: 2px solid var(--color-accent-line);
  outline-offset: 1px;
  position: relative;
  z-index: 1;
}
</style>
