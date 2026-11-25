<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSessionsStore } from '../stores/sessions'
import { useUiStore } from '../stores/ui'
import { useKeybindingsStore } from '../stores/keybindings'
import { useLayoutStore } from '../stores/layout'
import { useClaudeChangelogStore } from '../stores/claudeChangelog'
import SidebarTreeFolder from './SidebarTreeFolder.vue'
import { densityMetrics } from './sidebar-density'
import SidebarDrillView from './SidebarDrillView.vue'
import SidebarJumpPalette from './SidebarJumpPalette.vue'
import SidebarAttention from './SidebarAttention.vue'
import SidebarNeedsYou from './SidebarNeedsYou.vue'
import SidebarReturnZone from './SidebarReturnZone.vue'
import WatcherStatusPill from './WatcherStatusPill.vue'
import {
  ChevronsDownUp,
  ChevronsUpDown,
  Columns2,
  Columns3,
  EyeOff,
  ListTree,
  Plus,
  RefreshCw,
  Search,
  Settings,
  X
} from 'lucide-vue-next'
import FolderDropOverlay from './ui/FolderDropOverlay.vue'
import { useFolderDrop } from '../composables/useFolderDrop'
import { useSidebarActions } from '../composables/useSidebarActions'
import { macWindowControlsInset } from '../lib/platform'

const sessions = useSessionsStore()
const ui = useUiStore()
const keybindings = useKeybindingsStore()
const layout = useLayoutStore()
const claudeChangelog = useClaudeChangelogStore()
const { t } = useI18n()

/**
 * Whether the folder list has a status message (loading / nothing yet / filter
 * matched nothing) to show instead of rows. The drill view mounts outside the
 * tree scroller (BUG-248), so on the ROOT screen this decides which of the two hosts
 * renders; a drilled screen keeps the drill view and shows the same status under its
 * Back row (BUG-257).
 */
const treeStatus = computed(
  () =>
    sessions.folders.length === 0 ||
    (sessions.visibleFolders.length === 0 && !!sessions.filterQuery.trim())
)

const filterInputRef = ref<HTMLInputElement | null>(null)
const asideRef = ref<HTMLElement | null>(null)

// T69 fix: when a `harnu .` adoption raises the reveal signal, scroll the matching
// folder row into view (it was just expanded by the store), then consume the signal.
// Purely a scroll — the folder view must be active and the row present in the DOM.
watch(
  () => sessions.revealFolderPath,
  async (path) => {
    if (!path) return
    await nextTick()
    const selector = `[data-folder-path="${CSS.escape(path)}"]`
    const row =
      asideRef.value?.querySelector(`${selector}[data-folder-head], ${selector} > button`) ??
      asideRef.value?.querySelector(selector)
    row?.scrollIntoView({ block: 'nearest' })
    sessions.clearRevealFolder()
  }
)

// A repo that loses its last other worktree becomes a standalone folder, whose
// open state is its own: carry the header's over, so it does not snap shut. Lives
// here, not in the store, so the tree is only built while it is on screen.
watch(
  () => sessions.sidebarTree,
  (next, previous) => {
    if (sessions.filterQuery.trim()) return
    for (const node of next) {
      if (node.group) continue
      const was = previous?.find((old) => old.group && old.paths.includes(node.primary.path))
      if (was?.open) node.primary.expanded = true
    }
  }
)

// BUG-31 fix: `activateSession` raises this once it has already expanded the
// folder (and any teammate group) the target session lives behind — scroll
// the now-rendered row into view, then consume the signal. `nextTick` lets
// those reveal-state writes flush to the DOM first.
watch(
  () => sessions.revealSessionId,
  async (sessionId) => {
    if (!sessionId) return
    await nextTick()
    const sel = `[data-session-id="${CSS.escape(sessionId)}"]`
    asideRef.value?.querySelector(sel)?.scrollIntoView({ block: 'nearest' })
    sessions.clearRevealSession()
  }
)

/**
 * T288 — flash the row a jump just landed on. The paint lives here rather than
 * in the row components because `SidebarFolder.vue` renders folder AND session
 * rows and is owned elsewhere; `Sidebar.vue` already resolves both grains by
 * selector for the scroll-into-view above, so it resolves them once more and
 * runs `.anim-jump-flash` (design.md §7 — "Jump flash"). `prefers-reduced-motion`
 * is neutralized by the global reset in `main.css`.
 */
watch(
  () => sessions.jumpFlash,
  async (signal) => {
    if (!signal) return
    // Two ticks: the first flushes the expand/reveal writes, the second lets the
    // row that was just expanded into existence actually mount.
    await nextTick()
    await nextTick()
    const [kind, ...rest] = signal.token.split(':')
    const value = rest.join(':')
    const path = `[data-folder-path="${CSS.escape(value)}"]`
    const sel =
      kind === 'session'
        ? `[data-session-id="${CSS.escape(value)}"]`
        : `${path}[data-folder-head], ${path} > button`
    const el = asideRef.value?.querySelector(sel)
    sessions.clearJumpFlash()
    if (!(el instanceof HTMLElement)) return
    el.classList.remove('anim-jump-flash')
    // Force a reflow so re-adding the class restarts the animation when the
    // operator jumps to the same row twice.
    void el.offsetWidth
    el.classList.add('anim-jump-flash')
    el.addEventListener('animationend', () => el.classList.remove('anim-jump-flash'), {
      once: true
    })
  }
)

// The arrow cursor and keyboard focus draw the same bar (design.md §6 "Row states"),
// so only one row may show it: a row still holding DOM focus (it was clicked) gives it
// up when the cursor moves elsewhere.
watch(
  () => sessions.keyboardCursor,
  async (cursor) => {
    if (!cursor) return
    await nextTick()
    const active = document.activeElement
    if (!(active instanceof HTMLElement) || !asideRef.value?.contains(active)) return
    const row = active.closest('[data-row-bar]')
    if (row && row.getAttribute('data-focused') !== 'true') active.blur()
  }
)

// The header buttons and their keyboard bindings (App.vue) run the same functions.
const { rescanning, anyExpanded, rescan, toggleCollapseAll, toggleJump, toggleHiddenFolders } =
  useSidebarActions()

const collapseLabel = computed(() => {
  if (sessions.drillModeEnabled) {
    return t(anyExpanded.value ? 'sidebar.menu.collapseAll' : 'sidebar.menu.expandAll')
  }
  if (sessions.collapseLevel === 2) return t('sidebar.menu.collapseSessions')
  if (sessions.collapseLevel === 1) return t('sidebar.menu.collapseFolders')
  return t('sidebar.menu.expandAll')
})

const willCollapse = computed(() =>
  sessions.drillModeEnabled ? anyExpanded.value : sessions.collapseLevel > 0
)

const treeHeaderHeight = computed(() => densityMetrics(sessions.sidebarDensity).folderRowHeight)

// What the dock sections must leave the list island (design.md "Bottom dock"): the folder list's
// own minimum plus Needs attention at its full height (a 37px head, and up to six 28px rows), so
// an open dock body scrolls before a session that needs the operator leaves the screen. The cap
// keeps both dock heads and Add folder (111px) on screen: only on a very short window does Needs
// attention give way, down to its head.
const listIslandMinHeight = computed(() => {
  const rows = sessions.attentionSessions.length
  if (rows === 0) return 'min(160px, 40vh)'
  const attention = 37 + (layout.attentionOpen ? Math.min(rows * 28, 168) : 0)
  return `min(calc(min(160px, 40vh) + ${attention}px), calc(100% - 111px))`
})

/**
 * Drill button label. At depth 0 it names the action ("turn on"); at 1–2 it
 * names the CURRENT level, since the click advances rather than toggles.
 */
const drillLabel = computed(() =>
  sessions.drillDepth === 0
    ? t('sidebar.toolbar.drillOn')
    : t('sidebar.toolbar.drillLevel', { level: sessions.drillDepth, max: 2 })
)

// `⇥` in the jump palette flips `filterActive` on from outside this component;
// focus the input once it renders so the operator can keep typing.
watch(
  () => sessions.filterActive,
  async (active) => {
    if (!active) return
    await nextTick()
    filterInputRef.value?.focus()
  }
)

function onFilterClose(): void {
  sessions.setFilterActive(false)
}

function onFilterEsc(e: KeyboardEvent): void {
  e.stopPropagation()
  onFilterClose()
}

// Drag & drop: dropping a directory anywhere on the sidebar pins it as a folder.
// Shared with the onboarding hero — see `useFolderDrop` for the dragleave and
// stranded-overlay subtleties it handles.
const { dragOver, onDragOver, onDragLeave, onDrop } = useFolderDrop()
</script>

<template>
  <aside
    ref="asideRef"
    data-sidebar
    data-column="sidebar"
    class="sidebar-contain scrollable relative flex shrink-0 select-none flex-col bg-sidebar"
    :style="{ width: layout.sidebarWidth + 'px' }"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <!-- Header (42px) — ONE row (T288): the old separate toolbar row merged into
         it, so the tree starts directly under the header. Order, right-aligned:
         rescan · drill depth · collapse-all · hidden(n) · divider · search, with
         search LAST. It still morphs to the inline filter input, which is now
         reached only via the jump palette's `⇥` fallback. On macOS the left
         padding also clears the window controls (traffic lights), which the
         `hiddenInset` title bar paints over this corner (design.md §4 — "macOS
         window-controls inset"). -->
    <!-- The list island (design.md §6 "Floating panels layout"): the toolbar is the HEAD of the
         folder list, so with Floating panels on they read as ONE island (the toolbar's own bottom
         border is the inner rule). Off, this wrapper is an invisible flex column. The Jump palette
         is absolute against the aside, so it stays a sibling of the island. -->
    <SidebarJumpPalette />
    <div
      class="flex min-h-0 flex-1 flex-col"
      :style="{ minHeight: listIslandMinHeight }"
      data-island="sidebar-list"
    >
      <header
        role="toolbar"
        data-dsqa-part="toolbar"
        data-island-head="sidebar-toolbar"
        data-island-band
        :aria-label="$t('sidebar.menu.label')"
        class="flex shrink-0 items-center border-b border-border"
        style="height: 42px; padding: 8px 8px 8px 12px; gap: 2px; justify-content: flex-end"
        :style="
          macWindowControlsInset ? { paddingLeft: `${12 + macWindowControlsInset}px` } : undefined
        "
      >
        <template v-if="!sessions.filterActive">
          <template v-if="sessions.folders.length > 0">
            <button
              data-sidebar-rescan
              class="flex items-center justify-center rounded text-text-4 transition hover:bg-surface hover:text-text"
              style="width: 26px; height: 26px"
              :title="keybindings.withChord($t('sidebar.menu.rescan'), 'sidebar.rescan')"
              :aria-label="$t('sidebar.menu.rescan')"
              @click="rescan()"
            >
              <RefreshCw :size="14" :stroke-width="1.7" :class="rescanning ? 'anim-spin' : ''" />
            </button>
            <button
              data-drill-toggle
              class="flex items-center justify-center rounded transition"
              :class="
                sessions.drillDepth > 0
                  ? 'bg-accent-soft text-accent'
                  : 'text-text-4 hover:bg-surface hover:text-text'
              "
              style="width: 26px; height: 26px"
              :title="keybindings.withChord(drillLabel, 'sidebar.cycleDrillDepth')"
              :aria-label="drillLabel"
              @click="sessions.cycleDrillDepth()"
            >
              <Columns3 v-if="sessions.drillDepth === 2" :size="14" :stroke-width="1.7" />
              <Columns2 v-else-if="sessions.drillDepth === 1" :size="14" :stroke-width="1.7" />
              <ListTree v-else :size="14" :stroke-width="1.7" />
            </button>
            <button
              v-if="sessions.drillDepth < 2"
              :data-collapse-level="sessions.drillModeEnabled ? undefined : sessions.collapseLevel"
              class="relative flex size-[26px] items-center justify-center rounded text-text-4 transition hover:bg-surface hover:text-text"
              :title="keybindings.withChord(collapseLabel, 'sidebar.toggleCollapseAll')"
              :aria-label="collapseLabel"
              @click="toggleCollapseAll"
            >
              <ChevronsDownUp v-if="willCollapse" :size="14" :stroke-width="1.7" />
              <ChevronsUpDown v-else :size="14" :stroke-width="1.7" />
              <span
                v-if="!sessions.drillModeEnabled"
                class="absolute bottom-0.5 flex gap-0.5"
                aria-hidden="true"
              >
                <span
                  v-for="dot in sessions.collapseLevel + 1"
                  :key="dot"
                  data-level-dot
                  class="size-0.5 rounded-full bg-current"
                />
              </span>
            </button>
            <button
              data-sidebar-hidden-trigger
              class="flex items-center rounded text-text-4 transition hover:bg-surface hover:text-text"
              :class="ui.sidebarHiddenPopover.open ? 'bg-surface text-text' : ''"
              style="height: 26px; padding: 0 7px; gap: 4px"
              :title="
                keybindings.withChord(
                  $t('sidebar.menu.hidden', { count: sessions.dismissedFolders.length }),
                  'sidebar.hiddenFolders'
                )
              "
              :aria-label="$t('sidebar.menu.hidden', { count: sessions.dismissedFolders.length })"
              :aria-expanded="ui.sidebarHiddenPopover.open"
              @click.stop="toggleHiddenFolders"
              @keydown.enter.stop
              @keydown.space.stop
            >
              <EyeOff :size="14" :stroke-width="1.7" />
              <span
                v-if="sessions.dismissedFolders.length > 0"
                class="tabular-nums"
                style="font-size: 11px"
                >{{ sessions.dismissedFolders.length }}</span
              >
            </button>
            <!-- Divider between the tree actions and the search affordance. -->
            <div
              class="bg-border-2"
              style="width: 1px; height: 16px; margin: 0 4px"
              aria-hidden="true"
            />
          </template>
          <button
            data-sidebar-jump-trigger
            class="flex items-center justify-center rounded transition"
            :class="
              ui.sidebarJumpPalette.open
                ? 'bg-accent-soft text-accent'
                : 'text-text-4 hover:bg-surface hover:text-text'
            "
            style="width: 26px; height: 26px"
            :title="keybindings.withChord($t('sidebar.jump.label'), 'sidebar.jump')"
            :aria-label="$t('sidebar.jump.label')"
            :aria-expanded="ui.sidebarJumpPalette.open"
            @click.stop="toggleJump"
          >
            <Search :size="14" :stroke-width="1.5" />
          </button>
        </template>
        <template v-else>
          <input
            ref="filterInputRef"
            type="text"
            class="flex-1 bg-transparent text-text placeholder:text-text-4 focus:outline-none"
            style="font-size: 12.5px; min-width: 0"
            :placeholder="$t('sidebar.filter.placeholder')"
            :value="sessions.filterQuery"
            @input="(e) => sessions.setFilterQuery((e.target as HTMLInputElement).value)"
            @keydown.escape="onFilterEsc"
          />
          <button
            class="flex items-center justify-center rounded text-text-3 transition hover:bg-surface hover:text-text"
            style="width: 24px; height: 24px"
            :title="$t('sidebar.filter.clear')"
            :aria-label="$t('sidebar.filter.clear')"
            @click="onFilterClose"
          >
            <X :size="14" :stroke-width="1.5" />
          </button>
        </template>
      </header>

      <!-- Needs attention: pinned under the toolbar, outside the scroller, so it never leaves the
         screen with the tree. Part of the list island (design.md §6 "Needs attention"). -->
      <SidebarAttention />

      <!-- Tree (folder view). In drill mode the drill view owns its own scroller so
         its Back row can sit ABOVE it (BUG-248); this wrapper then only mounts to
         host the loading / empty states while the root screen has nothing to show. -->
      <div
        v-if="!sessions.drillModeEnabled || (treeStatus && sessions.drillStack.length === 0)"
        data-dsqa-part="tree"
        class="scrollable sidebar-tree-scroll flex-1 overflow-y-auto"
        :style="{
          '--sidebar-tree-header-height': `${treeHeaderHeight}px`,
          minHeight: 'calc(min(160px, 40vh) - 42px)'
        }"
      >
        <!-- Spacer elements, not padding, so the sticky header sticks flush. Rows only:
             the loading and empty states fill the scroller exactly. -->
        <div v-if="!treeStatus" class="h-2" aria-hidden="true" />
        <template v-if="sessions.folders.length === 0 && sessions.foldersLoading">
          <div data-sidebar-loading class="flex h-full flex-col items-center justify-center gap-3">
            <RefreshCw :size="20" :stroke-width="1.5" class="text-accent anim-spin" />
            <div class="text-text-3" style="font-size: 11.5px">{{ $t('sidebar.loading') }}</div>
          </div>
        </template>
        <template v-else-if="sessions.folders.length === 0">
          <div class="text-text-3" style="padding: 14px 12px; font-size: 11.5px; line-height: 1.5">
            {{ $t('sidebar.emptyShort') }}
          </div>
        </template>
        <template v-else-if="sessions.visibleFolders.length === 0 && sessions.filterQuery.trim()">
          <div class="text-text-3" style="padding: 14px 12px; font-size: 11.5px; line-height: 1.5">
            {{ $t('sidebar.filter.empty') }}
          </div>
        </template>

        <template v-if="!sessions.drillModeEnabled">
          <SidebarTreeFolder v-for="tree in sessions.sidebarTree" :key="tree.key" :tree="tree" />
        </template>
        <div v-if="!treeStatus" class="h-2" aria-hidden="true" />
      </div>
      <SidebarDrillView
        v-if="sessions.drillModeEnabled && !(treeStatus && sessions.drillStack.length === 0)"
      />
    </div>

    <!-- The bottom dock (design.md §6 "Bottom dock"): Needs you, Return here, then Add folder.
         Each of the two is absent while empty and folded until the operator opens it; the list
         island above keeps a minimum height, so an open body never squeezes it away. -->
    <SidebarNeedsYou />
    <SidebarReturnZone />

    <!-- Dock (design.md §6 "Sidebar dock (slot)"): the lower island is a slot that stacks N
         sections. Each `data-dock-section` child owns its padding; a new section is a drop-in
         sibling of this one. Off, it is the same one-row footer it always was. -->
    <footer class="shrink-0 border-t border-border" data-island="sidebar-dock">
      <div data-dock-section class="flex items-center gap-1" style="padding: 6px 8px">
        <button
          class="group flex flex-1 items-center gap-[7px] rounded text-text-3 transition hover:bg-surface hover:text-text"
          style="padding: 6px 8px; font-size: 12px"
          @click="ui.openDialog('addFolder')"
        >
          <Plus :size="13" :stroke-width="1.6" />
          <span>{{ $t('sidebar.addFolder') }}</span>
        </button>
        <WatcherStatusPill />
        <div class="relative flex items-center justify-center">
          <button
            class="flex items-center justify-center rounded text-text-3 transition hover:bg-surface hover:text-text"
            style="width: 26px; height: 26px"
            :title="
              keybindings.withChord(
                claudeChangelog.hasUnread
                  ? $t('sidebar.settingsWithUpdate')
                  : $t('sidebar.settings'),
                'view.settings'
              )
            "
            :aria-label="
              claudeChangelog.hasUnread ? $t('sidebar.settingsWithUpdate') : $t('sidebar.settings')
            "
            @click="ui.openDialog('settings')"
          >
            <Settings :size="14" :stroke-width="1.5" />
          </button>
          <span
            v-if="claudeChangelog.hasUnread"
            class="bg-accent"
            style="
              position: absolute;
              top: 3px;
              right: 3px;
              width: 6px;
              height: 6px;
              border-radius: 100%;
              pointer-events: none;
            "
            aria-hidden="true"
          />
        </div>
      </div>
    </footer>

    <!-- Drop-to-pin affordance (design.md — "Dropping a folder onto the
         sidebar"), dimmed against the sidebar's own surface. -->
    <FolderDropOverlay v-if="dragOver" scrim="sidebar" />
  </aside>
</template>
