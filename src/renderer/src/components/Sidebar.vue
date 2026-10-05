<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSessionsStore } from '../stores/sessions'
import { useUiStore } from '../stores/ui'
import { useLayoutStore } from '../stores/layout'
import { useClaudeChangelogStore } from '../stores/claudeChangelog'
import SidebarFolder from './SidebarFolder.vue'
import SidebarDrillView from './SidebarDrillView.vue'
import SidebarJumpPalette from './SidebarJumpPalette.vue'
import SidebarReturnZone from './SidebarReturnZone.vue'
import RepoGroupHeader from './RepoGroupHeader.vue'
import WatcherStatusPill from './WatcherStatusPill.vue'
import {
  isFolderGroup,
  nestByLineage,
  type FolderGroup,
  type LineageNode
} from '../stores/folder-zones'
import type { Folder } from '../stores/sessions'
import { persistedSet } from '../stores/persisted'
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
import { macWindowControlsInset } from '../lib/platform'

const sessions = useSessionsStore()
const ui = useUiStore()
const layout = useLayoutStore()
const claudeChangelog = useClaudeChangelogStore()
const { t } = useI18n()

type ZoneNode = Folder | FolderGroup<Folder>

function isGroup(node: ZoneNode): node is FolderGroup<Folder> {
  return isFolderGroup(node)
}

/**
 * T191: worktree lineage — which mothers cut which children, within ONE
 * `FolderGroup`'s member list (D4: nesting never reaches across a zone or
 * repo, which falls out for free since a valid `bornFrom` edge is only ever
 * recorded between two worktrees of the SAME repo — see `nestByLineage`'s own
 * doc comment in `folder-zones.ts`). Collapse state persists by mother path,
 * mirroring the group collapse mechanism.
 */
const lineageCollapsed = persistedSet<string>('om2tab.lineageCollapsed')

function withLineage(folders: Folder[]): Array<Folder | LineageNode<Folder>> {
  return nestByLineage(folders, lineageCollapsed.set.value)
}

function isLineageNode(node: Folder | LineageNode<Folder>): node is LineageNode<Folder> {
  return 'kind' in node && node.kind === 'lineage-nest'
}

function toggleLineage(motherPath: string): void {
  lineageCollapsed.toggle(motherPath)
}

const hiddenTriggerRef = ref<HTMLButtonElement | null>(null)
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
    const sel = `[data-folder-path="${CSS.escape(path)}"]`
    asideRef.value?.querySelector(sel)?.scrollIntoView({ block: 'nearest' })
    sessions.clearRevealFolder()
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
    // `data-folder-path` sits on the WRAPPER that holds the folder row AND its
    // whole expanded session list, so flashing it would paint the entire block.
    // The folder row is its only direct-child `<button>` — that is the row the
    // spec means. A headerless folder (drill-in depth 2 renders the folder's
    // sessions without its header) has no such button, and then there is
    // genuinely no row to flash.
    const sel =
      kind === 'session'
        ? `[data-session-id="${CSS.escape(value)}"]`
        : `[data-folder-path="${CSS.escape(value)}"] > button`
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

const anyExpanded = computed<boolean>(() => sessions.folders.some((f) => f.expanded === true))

/**
 * Drill button label. At depth 0 it names the action ("turn on"); at 1–2 it
 * names the CURRENT level, since the click advances rather than toggles.
 */
const drillLabel = computed(() =>
  sessions.drillDepth === 0
    ? t('sidebar.toolbar.drillOn')
    : t('sidebar.toolbar.drillLevel', { level: sessions.drillDepth, max: 2 })
)

function onHiddenClick(): void {
  if (ui.sidebarHiddenPopover.open) {
    ui.closeSidebarHiddenPopover()
    return
  }
  const btn = hiddenTriggerRef.value
  if (!btn) return
  const rect = btn.getBoundingClientRect()
  ui.openSidebarHiddenPopover({
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom
  })
}

/**
 * Rescan folders (BUG-55 AC6) — the manual refresh affordance / escape hatch
 * for any watcher gap. Carried over from the old `⋯` menu's first item when
 * that menu was replaced by this toolbar (design.md §6). `rescanning` drives
 * the icon's spin while the scan is in flight (design.md §7 Motion) — the
 * only feedback `sessions.rescan()` otherwise gives.
 */
const rescanning = ref(false)

async function onRescanClick(): Promise<void> {
  rescanning.value = true
  try {
    await sessions.rescan()
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    ui.pushToast({ kind: 'danger', title: t('sidebar.menu.rescanFailed'), description: message })
  } finally {
    rescanning.value = false
  }
}

function onCollapseAllClick(): void {
  if (anyExpanded.value) sessions.collapseAll()
  else sessions.expandAll()
}

/**
 * The header's search button (T288). It opens the JUMP PALETTE — search means
 * "take me there", not "filter the tree". The inline filter morph is still
 * reachable, but only through the palette's explicit `⇥` fallback.
 */
function onSearchClick(): void {
  if (ui.sidebarJumpPalette.open) ui.closeSidebarJumpPalette()
  else ui.openSidebarJumpPalette()
}

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
    class="scrollable relative flex shrink-0 select-none flex-col bg-sidebar"
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
    <header
      role="toolbar"
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
            :title="$t('sidebar.menu.rescan')"
            :aria-label="$t('sidebar.menu.rescan')"
            @click="onRescanClick()"
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
            :title="drillLabel"
            :aria-label="drillLabel"
            @click="sessions.cycleDrillDepth()"
          >
            <Columns3 v-if="sessions.drillDepth === 2" :size="14" :stroke-width="1.7" />
            <Columns2 v-else-if="sessions.drillDepth === 1" :size="14" :stroke-width="1.7" />
            <ListTree v-else :size="14" :stroke-width="1.7" />
          </button>
          <button
            v-if="sessions.drillDepth < 2"
            class="flex items-center justify-center rounded text-text-4 transition hover:bg-surface hover:text-text"
            style="width: 26px; height: 26px"
            :title="anyExpanded ? $t('sidebar.menu.collapseAll') : $t('sidebar.menu.expandAll')"
            :aria-label="
              anyExpanded ? $t('sidebar.menu.collapseAll') : $t('sidebar.menu.expandAll')
            "
            @click="onCollapseAllClick"
          >
            <ChevronsDownUp v-if="anyExpanded" :size="14" :stroke-width="1.7" />
            <ChevronsUpDown v-else :size="14" :stroke-width="1.7" />
          </button>
          <button
            ref="hiddenTriggerRef"
            data-sidebar-hidden-trigger
            class="flex items-center rounded text-text-4 transition hover:bg-surface hover:text-text"
            :class="ui.sidebarHiddenPopover.open ? 'bg-surface text-text' : ''"
            style="height: 26px; padding: 0 7px; gap: 4px"
            :title="$t('sidebar.menu.hidden', { count: sessions.dismissedFolders.length })"
            :aria-label="$t('sidebar.menu.hidden', { count: sessions.dismissedFolders.length })"
            :aria-expanded="ui.sidebarHiddenPopover.open"
            @click.stop="onHiddenClick"
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
          :title="$t('sidebar.jump.label')"
          :aria-label="$t('sidebar.jump.label')"
          :aria-expanded="ui.sidebarJumpPalette.open"
          @click.stop="onSearchClick"
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

    <!-- Jump palette (T288) — floats above the tree, anchored under the header.
         The tree behind it is never filtered. -->
    <SidebarJumpPalette />

    <!-- RETURN HERE zone (T37 — closure axis) — forgotten needs-input sessions.
         Self-hides when the forgotten set is empty (calm-tech); sits above the
         folder list so a blocked-and-abandoned session stays at the top. -->
    <SidebarReturnZone />

    <!-- Tree (folder view) -->
    <div class="scrollable flex-1 overflow-y-auto" style="padding: 6px 0">
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

      <!-- Single flat list: every visible folder (pinned ∪ active), one
           classify → sort → groupByRepo → groupByParentDir pass (BUG-39,
           T182). No section header, no zone divider, no visual distinction
           between a pinned and a merely-active folder. Replaced by
           SidebarDrillView when drill-in mode is on (design.md §6). -->
      <template v-if="!sessions.drillModeEnabled">
        <template
          v-for="node in sessions.visibleFolders"
          :key="isGroup(node) ? node.key : node.path"
        >
          <template v-if="isGroup(node)">
            <RepoGroupHeader :group="node" />
            <div
              class="overflow-hidden transition-[max-height] duration-300 ease-out"
              :style="{ maxHeight: node.expanded ? '4000px' : '0' }"
            >
              <!-- T191: worktree lineage — a mother's fork badge + its children,
                   indented one level with a guide line, nested within this repo
                   group's member list (design.md § "Worktree lineage"). -->
              <template
                v-for="ln in withLineage(node.folders)"
                :key="isLineageNode(ln) ? ln.mother.path : ln.path"
              >
                <template v-if="isLineageNode(ln)">
                  <SidebarFolder
                    :folder="ln.mother"
                    nested
                    :lineage-child-count="ln.children.length"
                    :lineage-expanded="ln.expanded"
                    @toggle-lineage="toggleLineage(ln.mother.path)"
                  />
                  <div
                    v-if="ln.expanded"
                    class="border-l border-border-2"
                    style="margin-left: 20px"
                  >
                    <SidebarFolder
                      v-for="c in ln.children"
                      :key="c.path"
                      :folder="c"
                      nested
                      lineage-child
                    />
                  </div>
                </template>
                <SidebarFolder v-else :folder="ln" nested />
              </template>
            </div>
          </template>
          <SidebarFolder v-else :folder="node" />
        </template>
      </template>
      <SidebarDrillView v-else />
    </div>

    <!-- Footer -->
    <footer
      class="flex shrink-0 items-center gap-1 border-t border-border"
      style="padding: 6px 8px"
    >
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
            claudeChangelog.hasUnread ? $t('sidebar.settingsWithUpdate') : $t('sidebar.settings')
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
    </footer>

    <!-- Drop-to-pin affordance (design.md — "Dropping a folder onto the
         sidebar"), dimmed against the sidebar's own surface. -->
    <FolderDropOverlay v-if="dragOver" scrim="sidebar" />
  </aside>
</template>
