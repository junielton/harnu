<script setup lang="ts">
import { computed, nextTick, ref, watch, type Component } from 'vue'
import { useI18n } from 'vue-i18n'
import { onClickOutside } from '@vueuse/core'
import {
  Ellipsis,
  FolderOpen,
  FolderTree,
  GitBranch,
  GitPullRequest,
  KanbanSquare,
  Plus,
  Terminal
} from 'lucide-vue-next'
import type { FolderGitStatus, RoadmapPeekResult } from '../../../preload'
import { useSessionsStore } from '../stores/sessions'
import { useUiStore } from '../stores/ui'
import { useHelpersStore } from '../stores/helpers'
import { useFolderActions } from '../composables/useFolderActions'
import { useEditorButton } from '../composables/useEditorButton'
import { useNativeOverlay } from '../composables/useNativeOverlay'
import EditorIcon from './EditorIcon.vue'
import FolderViewRoadmap from './FolderViewRoadmap.vue'
import { displayAlias } from './folder-alias'
import { gitSummary, isGitFolder, roadmapLine, type GitSummaryPart } from './folder-view-format'

/**
 * T212 — the main-pane view a folder click opens. Selection-driven (like
 * `TerminalPane`), NOT one of the takeovers: a takeover opened from here still
 * wins the pane, and closing it returns to this view because the folder
 * selection was never lost.
 *
 * It is identity and actions, plus one roadmap line (design.md §6 "Folder
 * View"). What the sidebar already shows is not repeated here, and nothing is
 * read for it.
 */

const sessions = useSessionsStore()
const ui = useUiStore()
const helpers = useHelpersStore()
const folderActions = useFolderActions()
const editorButton = useEditorButton()
const { t } = useI18n()

const folder = computed(() => {
  const path = sessions.selectedFolderPath
  return path ? (sessions.findFolderByPath(path) ?? null) : null
})

const label = computed(() => {
  const f = folder.value
  return f ? displayAlias(f, sessions.aliasFromBranchPaths.has(f.path)) : ''
})

const isGit = computed(() => isGitFolder(folder.value))

const menuOpen = ref(false)

// --- Reads on open, behind a sequence guard so a fast folder switch can never
// paint the previous folder's data. Both degrade to nothing. ------------------
const gitStatus = ref<FolderGitStatus | null>(null)
const peek = ref<RoadmapPeekResult | null>(null)
let seq = 0

watch(
  () => sessions.selectedFolderPath,
  (path) => {
    const mine = ++seq
    gitStatus.value = null
    peek.value = null
    menuOpen.value = false
    if (!path) return

    if (typeof window.api?.foldersGitStatus === 'function') {
      window.api
        .foldersGitStatus(path)
        .then((s) => {
          if (mine === seq) gitStatus.value = s
        })
        .catch(() => {
          /* degrade — omit the git summary */
        })
    }

    if (typeof window.api?.roadmapPeek === 'function') {
      window.api
        .roadmapPeek(path)
        .then((p) => {
          if (mine === seq) peek.value = p
        })
        .catch(() => {
          /* degrade — no roadmap line and no board button */
        })
    }
  },
  { immediate: true }
)

const git = computed(() => (isGit.value ? gitSummary(gitStatus.value) : null))
const road = computed(() => roadmapLine(peek.value))

function gitText(part: GitSummaryPart): string {
  if (part.key === 'changes') return t('preview.folder.changes', { count: part.n })
  if (part.key === 'clean') return t('preview.folder.clean')
  return `${part.key === 'ahead' ? '↑' : '↓'}${part.n}`
}

function gitAriaLabel(part: GitSummaryPart): string | undefined {
  if (part.key === 'ahead') return t('preview.folder.ahead', { n: part.n })
  if (part.key === 'behind') return t('preview.folder.behind', { n: part.n })
  return undefined
}

// --- Actions -----------------------------------------------------------------
function onNewSession(): void {
  if (folder.value) ui.openNewSession(folder.value.path)
}

function onTerminalHere(): void {
  if (folder.value) sessions.createFolderTerminal(folder.value.path)
}

function onBrowseFiles(): void {
  if (folder.value) helpers.addExplorerHelper(folder.value.path, folder.value.path)
}

function onRoadmap(): void {
  if (folder.value) ui.openRoadmap(folder.value.path, label.value)
}

// --- The More menu: PR Stack, the editor, Open folder. Anatomy is the Context
// menu of §6, the keyboard contract the Topbar overflow's. --------------------
interface MenuItem {
  id: 'open-pr-stack' | 'editor' | 'open-folder'
  label: string
  icon: Component
  iconProps: Record<string, unknown>
  run: () => void
}

const menuItems = computed<MenuItem[]>(() => {
  const stroke = { size: 14, strokeWidth: 1.6 }
  const items: MenuItem[] = []
  // A plain directory has no pull requests to stack.
  if (isGit.value) {
    items.push({
      id: 'open-pr-stack',
      label: t('folderView.openPrStack'),
      icon: GitPullRequest,
      iconProps: stroke,
      run: () => {
        if (folder.value) ui.openPrStack(folder.value.path, label.value)
      }
    })
  }
  items.push(
    {
      id: 'editor',
      label: editorButton.label.value,
      icon: EditorIcon,
      iconProps: { editorId: editorButton.editorId.value, size: 14 },
      run: () => void folderActions.openInEditor()
    },
    {
      id: 'open-folder',
      label: t('folderView.openFolder'),
      icon: FolderOpen,
      iconProps: stroke,
      run: () => {
        if (folder.value) void window.api.openPath(folder.value.path)
      }
    }
  )
  return items
})

const moreTitle = computed(() =>
  t('folderView.moreTitle', { actions: menuItems.value.map((i) => i.label).join(', ') })
)

/** Opens leftwards when the pane is too narrow to the right of the button. */
const menuAlignEnd = ref(false)
const focusedIndex = ref(0)
const viewRef = ref<HTMLElement | null>(null)
const moreRef = ref<HTMLElement | null>(null)
const triggerRef = ref<HTMLButtonElement | null>(null)
const menuRef = ref<HTMLElement | null>(null)

// An in-app popover: a browser pane under it freezes instead of drawing over it.
useNativeOverlay('folder-view-menu', menuRef)
onClickOutside(moreRef, () => {
  menuOpen.value = false
})

function menuButtons(): HTMLButtonElement[] {
  return Array.from(menuRef.value?.querySelectorAll('button') ?? [])
}

function focusRow(index: number): void {
  const rows = menuButtons()
  if (rows.length === 0) return
  focusedIndex.value = (index + rows.length) % rows.length
  rows[focusedIndex.value].focus()
}

async function openMenu(focus: 'first' | 'last' | 'none'): Promise<void> {
  menuAlignEnd.value = false
  focusedIndex.value = 0
  menuOpen.value = true
  await nextTick()
  const menu = menuRef.value?.getBoundingClientRect()
  const view = viewRef.value?.getBoundingClientRect()
  menuAlignEnd.value = !!menu && !!view && menu.right > view.right
  if (focus !== 'none') focusRow(focus === 'first' ? 0 : -1)
}

function closeMenu(returnFocus: boolean): void {
  menuOpen.value = false
  if (returnFocus) triggerRef.value?.focus()
}

function pick(item: MenuItem): void {
  closeMenu(true)
  item.run()
}

function onMenuKeydown(e: KeyboardEvent): void {
  const consume = (): void => {
    e.preventDefault()
    e.stopPropagation()
  }
  if (!menuOpen.value || e.target === triggerRef.value) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      consume()
      void openMenu(e.key === 'ArrowDown' ? 'first' : 'last')
    } else if (e.key === 'Escape' && menuOpen.value) {
      consume()
      closeMenu(false)
    }
    // Enter and Space reach the trigger's own click, which toggles the menu.
    return
  }
  switch (e.key) {
    case 'ArrowDown':
      consume()
      focusRow(focusedIndex.value + 1)
      break
    case 'ArrowUp':
      consume()
      focusRow(focusedIndex.value - 1)
      break
    case 'Home':
      consume()
      focusRow(0)
      break
    case 'End':
      consume()
      focusRow(-1)
      break
    case 'Escape':
      consume()
      closeMenu(true)
      break
    case 'Tab':
      closeMenu(false)
      break
    case 'Enter':
    case ' ':
      // The row's own click runs it; keep the key away from the window shortcuts.
      e.stopPropagation()
      break
  }
}

/** Click toggles; a keyboard activation (`detail === 0`) also lands on the first row. */
function onMoreClick(e: MouseEvent): void {
  if (menuOpen.value) closeMenu(false)
  else void openMenu(e.detail === 0 ? 'first' : 'none')
}

const ACTION =
  'flex h-7.5 cursor-pointer items-center gap-1.75 whitespace-nowrap rounded-sm border text-ui transition'
const SECONDARY = 'border-border-2 text-text-2 hover:bg-surface-2 hover:text-text'
</script>

<template>
  <div
    v-if="folder"
    ref="viewRef"
    class="scrollable anim-fade-in h-full w-full overflow-y-auto bg-bg px-8 py-7"
    data-test="folder-view"
    data-dsqa="folder-view"
    data-dsqa-part="folder-view"
  >
    <!-- Three text sizes on one line: they share a baseline, and the branch icon
         centres on its own text. In a narrow pane the branch gives way first and
         the name last (a card branch name runs to ~295px). -->
    <header class="flex min-w-0 items-baseline gap-2.5">
      <h1 class="m-0 max-w-1/2 shrink-0 truncate text-[18px] font-semibold text-text">
        {{ label }}
      </h1>
      <span
        v-if="isGit"
        class="flex min-w-8 shrink-[9999] items-baseline gap-1 overflow-hidden font-mono text-[11.5px] text-text-3"
        :title="folder.gitBranch || undefined"
      >
        <GitBranch :size="12" :stroke-width="1.6" class="mb-px shrink-0 self-center" />
        <span class="truncate" data-test="folder-view-branch">{{
          folder.gitBranch || $t('preview.folder.detached')
        }}</span>
      </span>
      <span
        v-if="git"
        class="min-w-0 truncate text-[12px] tabular-nums"
        :class="git.attention ? 'text-warning' : 'text-text-4'"
        data-test="folder-view-git"
      >
        <template v-for="(part, i) in git.parts" :key="part.key">
          <template v-if="i">{{ ' · ' }}</template>
          <span :aria-label="gitAriaLabel(part)">{{ gitText(part) }}</span>
        </template>
      </span>
    </header>

    <div
      class="mt-1 truncate font-mono text-[12px] text-text-4"
      :title="folder.path"
      data-test="folder-view-path"
    >
      {{ folder.path }}
    </div>

    <div class="mt-5 flex flex-wrap gap-1.5" data-test="folder-view-actions">
      <button
        type="button"
        class="border-accent bg-accent px-3 font-medium text-accent-ink hover:opacity-90"
        :class="ACTION"
        data-test="folder-view-new-session"
        @click="onNewSession"
      >
        <Plus :size="14" :stroke-width="1.8" />{{ $t('folderView.newSession') }}
      </button>
      <button
        type="button"
        class="px-3"
        :class="[ACTION, SECONDARY]"
        data-test="folder-view-terminal"
        @click="onTerminalHere"
      >
        <Terminal :size="14" :stroke-width="1.6" />{{ $t('folderView.terminalHere') }}
      </button>
      <button
        type="button"
        class="px-3"
        :class="[ACTION, SECONDARY]"
        data-test="folder-view-browse-files"
        @click="onBrowseFiles"
      >
        <FolderTree :size="14" :stroke-width="1.6" />{{ $t('folderView.browseFiles') }}
      </button>
      <button
        v-if="road"
        type="button"
        class="px-3"
        :class="[ACTION, SECONDARY]"
        data-test="folder-view-open-roadmap"
        @click="onRoadmap"
      >
        <KanbanSquare :size="14" :stroke-width="1.6" />{{ $t('folderView.openRoadmap') }}
      </button>

      <div ref="moreRef" class="relative" @keydown="onMenuKeydown">
        <button
          ref="triggerRef"
          type="button"
          class="w-7.5 justify-center"
          :class="[ACTION, SECONDARY, menuOpen && 'bg-surface-2 text-text']"
          :title="moreTitle"
          :aria-label="$t('folderView.moreActions')"
          aria-haspopup="menu"
          :aria-expanded="menuOpen"
          data-test="folder-view-more"
          @click="onMoreClick"
        >
          <Ellipsis :size="14" :stroke-width="1.6" />
        </button>
        <div
          v-if="menuOpen"
          ref="menuRef"
          role="menu"
          :aria-label="$t('folderView.moreActions')"
          class="anim-fade-in-scale absolute top-full z-50 mt-1.5 flex min-w-50 flex-col rounded border border-border-2 bg-surface p-1 shadow-pop"
          :class="menuAlignEnd ? 'right-0' : 'left-0'"
          data-test="folder-view-menu"
        >
          <button
            v-for="(item, i) in menuItems"
            :key="item.id"
            type="button"
            role="menuitem"
            :tabindex="i === focusedIndex ? 0 : -1"
            class="flex w-full cursor-pointer items-center gap-2.25 whitespace-nowrap rounded-sm px-2 py-1.5 text-left text-[12px] text-text-2 transition hover:bg-surface-2 hover:text-text focus-visible:bg-surface-2"
            :data-test="`folder-view-${item.id}`"
            @focus="focusedIndex = i"
            @click="pick(item)"
          >
            <component :is="item.icon" v-bind="item.iconProps" class="shrink-0" />
            <span>{{ item.label }}</span>
          </button>
        </div>
      </div>
    </div>

    <FolderViewRoadmap v-if="road" :line="road" />
  </div>
</template>
