<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ChevronLeft,
  ChevronRight,
  Ellipsis,
  GitBranch,
  Folder as FolderIcon,
  PencilLine,
  Plus,
  Clock,
  Archive,
  RotateCcw,
  Trash2
} from 'lucide-vue-next'
import { useSessionsStore } from '../stores/sessions'
import { useUiStore } from '../stores/ui'
import { displayAlias } from './folder-alias'
import SidebarFolder from './SidebarFolder.vue'
import { isFolderGroup, type FolderGroup } from '../stores/folder-zones'
import type { Folder } from '../stores/sessions'

/**
 * Drill-in navigation (2026-07-19, docs/specs/2026-07-19-sidebar-drill-in-navigation.md):
 * one screen at a time instead of the always-expanded classic tree. Renders
 * whichever screen `sessions.drillStack` currently points at:
 *   - empty stack       -> ROOT: group headers + standalone folders, each a
 *     drillable row (never inline-expanded).
 *   - top is `{kind:'group'}`  -> that group's member folders, each drillable.
 *   - top is `{kind:'folder'}` -> that folder's own session list, reusing
 *     `SidebarFolder`'s existing row rendering (`headerless`) — no new
 *     session/teammate/terminal logic here.
 *
 * Every grouped folder is reachable here: since path-contained folders became
 * real `FolderGroup`s (T182) rather than the old inline-only `FolderNest`, a
 * non-git sibling group drills exactly like a repo group. The previous
 * iteration listed those children nowhere in drill mode.
 *
 * T289: every row here — the back row and both flavors of chooser row — carries
 * the same actions the classic tree has: right-click opens the matching menu,
 * and a trailing `⋯` does the same for mouse users.
 */

const sessions = useSessionsStore()
const ui = useUiStore()
const { t } = useI18n()

type RootNode = Folder | FolderGroup<Folder>

function isGroup(node: RootNode): node is FolderGroup<Folder> {
  return isFolderGroup(node)
}

const rootNodes = computed<RootNode[]>(() => sessions.visibleFolders)

const top = computed(() => sessions.drillStack[sessions.drillStack.length - 1] ?? null)

/**
 * Whether rows on the CURRENT screen may push another screen. Drill depth is a
 * budget (docs/specs/2026-07-29-sidebar-drill-depth-levels.md): once spent, a
 * screen's rows fall back to the classic inline tree instead of being chooser
 * rows, so level 1 lets you enter a group and then work inside it exactly as
 * the always-expanded tree does.
 */
const canDrill = computed(() => sessions.drillStack.length < sessions.drillDepth)

const groupScreen = computed<FolderGroup<Folder> | null>(() =>
  top.value?.kind === 'group' ? sessions.groupInVisible(top.value.key) : null
)

const folderScreen = computed<Folder | null>(() =>
  top.value?.kind === 'folder' ? sessions.findFolderByPath(top.value.path) : null
)

/** The owning group's label, shown as a dim subtitle next to a folder screen's title. */
const parentGroupLabel = computed<string | null>(() => {
  if (sessions.drillStack.length < 2) return null
  const parent = sessions.drillStack[sessions.drillStack.length - 2]
  if (parent.kind !== 'group') return null
  return sessions.groupInVisible(parent.key)?.label ?? null
})

function labelFor(node: RootNode | Folder): string {
  if (isGroup(node)) return node.label
  return displayAlias(node, sessions.aliasFromBranchPaths.has(node.path))
}

function onRootClick(node: RootNode): void {
  if (isGroup(node)) sessions.drillIntoGroup(node.key)
  else sessions.drillIntoFolder(node.path)
}

/** Trailing "+" on the back row (folder screen only) — opens the new-session flow. */
function onNewSessionClick(): void {
  if (!folderScreen.value) return
  ui.openNewSession(folderScreen.value.path)
}

// ── Row actions (T289 — right-click + trailing ⋯) ──────────────────────────

/**
 * Where a menu should open for `e`. A pointer event anchors at the cursor (the
 * classic right-click behavior); a keyboard activation has no cursor, so it
 * anchors at the bottom-left of the element that was activated — otherwise the
 * clamp below would run on `undefined` coords and place the menu at NaN.
 */
function menuOrigin(e: Event): { x: number; y: number } {
  if (e instanceof MouseEvent && (e.clientX !== 0 || e.clientY !== 0)) {
    return { x: e.clientX, y: e.clientY }
  }
  const rect = (e.currentTarget as HTMLElement | null)?.getBoundingClientRect()
  return rect ? { x: rect.left, y: rect.bottom } : { x: 0, y: 0 }
}

/**
 * Clamp a menu's origin against a conservative size estimate so a menu opened
 * near the viewport edge stays on-screen. Same idiom as
 * `SidebarFolder.onFolderContext` / `RepoGroupHeader.openMenu`, shared here by
 * both menus (they only differ in the estimate they pass).
 */
function clampMenu(e: Event, width: number, height: number): { x: number; y: number } {
  const VIEWPORT_MARGIN = 8
  let { x, y } = menuOrigin(e)
  if (x + width > window.innerWidth - VIEWPORT_MARGIN) {
    x = Math.max(VIEWPORT_MARGIN, x - width)
  }
  if (y + height > window.innerHeight - VIEWPORT_MARGIN) {
    y = Math.max(VIEWPORT_MARGIN, y - height)
  }
  return { x, y }
}

/**
 * Open the shared `FolderMenu` for a folder row / the folder screen's back row.
 * Same estimate as `SidebarFolder.onFolderContext`, so the two clamp alike.
 */
function openFolderMenuAt(e: Event, folderPath: string): void {
  e.preventDefault()
  const { x, y } = clampMenu(e, 180, 60)
  ui.openFolderMenu({ projectPath: folderPath, x, y })
}

/**
 * The repo/path group menu (Rename group / Reset name / Cleanup), rendered
 * locally here rather than reached through `RepoGroupHeader`: that menu lives
 * inside the header component itself, and this screen never mounts a
 * `RepoGroupHeader` (the back row plays that role). Same items, same store
 * actions, same dismissal idiom — no behavior forked, only the host.
 */
const groupMenu = ref<{ open: boolean; x: number; y: number; key: string | null }>({
  open: false,
  x: 0,
  y: 0,
  key: null
})
const groupMenuRef = ref<HTMLElement | null>(null)

/** The group the open menu targets, re-resolved each render (folders come and go). */
const groupMenuTarget = computed<FolderGroup<Folder> | null>(() =>
  groupMenu.value.key ? sessions.groupInVisible(groupMenu.value.key) : null
)

/** Whether the targeted group carries a custom alias (gates "Reset name"). */
const groupMenuHasAlias = computed<boolean>(() =>
  groupMenu.value.key ? !!sessions.groupAliases[groupMenu.value.key] : false
)

function openGroupMenuAt(e: Event, key: string): void {
  e.preventDefault()
  // Up to three short rows (Rename, Reset name when aliased, Cleanup) —
  // the same estimate `RepoGroupHeader` clamps against.
  const { x, y } = clampMenu(e, 172, 108)
  groupMenu.value = { open: true, x, y, key }
  window.addEventListener('mousedown', onGroupMenuDismiss, true)
  window.addEventListener('keydown', onGroupMenuKeydown, true)
  window.addEventListener('wheel', closeGroupMenu, { passive: true })
}

function closeGroupMenu(): void {
  if (!groupMenu.value.open) return
  groupMenu.value = { open: false, x: 0, y: 0, key: null }
  window.removeEventListener('mousedown', onGroupMenuDismiss, true)
  window.removeEventListener('keydown', onGroupMenuKeydown, true)
  window.removeEventListener('wheel', closeGroupMenu)
}

function onGroupMenuDismiss(e: MouseEvent): void {
  if (groupMenuRef.value?.contains(e.target as Node)) return
  closeGroupMenu()
}

function onGroupMenuKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.stopPropagation()
    e.preventDefault()
    closeGroupMenu()
  }
}

function renameGroup(): void {
  const group = groupMenuTarget.value
  if (group) ui.openRenameRepo(group.key, group.derivedLabel)
  closeGroupMenu()
}

function resetGroupName(): void {
  const group = groupMenuTarget.value
  if (group) sessions.setGroupAlias(group.key, '')
  closeGroupMenu()
}

/**
 * The Reaper snapshot groups by main-worktree folder path, not by the group's
 * own key — so the Cleanup takeover's scroll target is that folder's path.
 * Only a REPO group has a meaningful target (a path group is an arbitrary set
 * of sibling directories with no shared git history to sweep).
 */
function openGroupCleanup(): void {
  const group = groupMenuTarget.value
  const mainPath = group?.folders.find((f) => f.isMainWorktree)?.path ?? group?.folders[0]?.path
  if (mainPath) ui.openCleanup(mainPath)
  closeGroupMenu()
}

/**
 * A root-screen chooser row's actions (right-click OR its `⋯`) → the menu
 * matching its node kind: `FolderMenu` for a folder, the group menu for a group.
 */
function onRootActions(e: Event, node: RootNode): void {
  if (isGroup(node)) openGroupMenuAt(e, node.key)
  else openFolderMenuAt(e, node.path)
}

/**
 * The back row's actions (right-click OR its `⋯`) → the drilled-into folder's
 * `FolderMenu` on a folder screen, the group menu on a repo screen.
 */
function onBackActions(e: Event): void {
  if (folderScreen.value) openFolderMenuAt(e, folderScreen.value.path)
  else if (groupScreen.value) openGroupMenuAt(e, groupScreen.value.key)
}

/** Whether a row's hover-only `⋯` must stay visible because its menu is open. */
function folderActionsOpen(path: string): boolean {
  return ui.folderMenu.open && ui.folderMenu.projectPath === path
}

function groupActionsOpen(key: string): boolean {
  return groupMenu.value.open && groupMenu.value.key === key
}

/**
 * Close the group menu when the group it targets stops rendering (a reload
 * drops the group, its last worktree goes away). The `v-if` below already
 * hides the menu in that case, but hiding is not closing: `groupMenu.open`
 * would stay `true` with the three capture-phase window listeners still
 * attached, so the next Escape would be swallowed by an invisible menu.
 */
watch(groupMenuTarget, (target) => {
  if (!target) closeGroupMenu()
})

onBeforeUnmount(() => {
  window.removeEventListener('mousedown', onGroupMenuDismiss, true)
  window.removeEventListener('keydown', onGroupMenuKeydown, true)
  window.removeEventListener('wheel', closeGroupMenu)
})

/**
 * Trailing older/archived peeks on the back row (folder screen only) — the
 * same inline action cluster the classic tree's folder row shows, carried
 * over here since the drill-in folder screen renders `SidebarFolder`
 * `headerless` (its own folder row, and with it this cluster, never renders).
 * Always visible (no hover-gating) — the back row is a persistent header,
 * not a row that fades stats in on hover.
 */
const peekActions = computed(() => {
  const folder = folderScreen.value
  if (!folder) return []
  const olderRevealed = sessions.isOlderRevealed(folder.path)
  const archivedRevealed = sessions.isArchivedRevealed(folder.path)
  return [
    {
      kind: 'older' as const,
      icon: Clock,
      count: sessions.olderSessionCount(folder),
      revealed: olderRevealed,
      label: olderRevealed
        ? t('sidebar.hideOlder')
        : t('sidebar.showOlder', { n: sessions.olderSessionCount(folder) })
    },
    {
      kind: 'archived' as const,
      icon: Archive,
      count: sessions.archivedSessionCount(folder),
      revealed: archivedRevealed,
      label: archivedRevealed
        ? t('sidebar.hideArchived')
        : t('sidebar.showArchived', { n: sessions.archivedSessionCount(folder) })
    }
  ].filter((p) => p.count > 0)
})

function onPeekClick(kind: 'older' | 'archived'): void {
  const path = folderScreen.value?.path
  if (!path) return
  if (kind === 'older') sessions.toggleRevealOlder(path)
  else sessions.toggleRevealArchived(path)
}
</script>

<template>
  <div class="flex flex-1 flex-col overflow-hidden">
    <!-- Back row — replaces the drilled screen's own title. Shown whenever
         the stack is non-empty (repo screen or folder screen). The whole row
         is the back button (not just the chevron) — same "full row is
         clickable" convention every other sidebar row follows. Right-clicking
         it opens the drilled-into folder's / group's menu (T289), so every
         action is reachable without leaving drill-in first. -->
    <button
      v-if="top"
      data-drill-back
      class="sidebar-row group flex w-full shrink-0 cursor-pointer items-center border-b border-border text-left text-text transition hover:bg-surface"
      style="height: 30px; padding: 0 10px; gap: 6px"
      :title="$t('sidebar.drill.back')"
      :aria-label="$t('sidebar.drill.back')"
      @click="sessions.drillBack()"
      @contextmenu="onBackActions"
    >
      <ChevronLeft :size="15" :stroke-width="1.8" class="shrink-0 text-text-2" />
      <GitBranch v-if="groupScreen" :size="12" :stroke-width="1.8" class="shrink-0 text-text-3" />
      <span class="min-w-0 flex-1 truncate text-[13px] font-semibold text-text">
        {{ groupScreen ? groupScreen.label : folderScreen ? labelFor(folderScreen) : '' }}
      </span>
      <span v-if="parentGroupLabel" class="shrink-0 truncate text-[11px] text-text-4">{{
        parentGroupLabel
      }}</span>
      <span v-if="folderScreen" class="flex shrink-0 items-center" style="gap: 9px">
        <span
          v-for="p in peekActions"
          :key="p.kind"
          role="button"
          tabindex="0"
          :data-drill-peek="p.kind"
          class="flex cursor-pointer items-center transition"
          :class="p.revealed ? 'text-accent' : 'text-text-4 hover:text-text-2'"
          style="gap: 3px; font-size: 10.5px"
          :title="p.label"
          :aria-label="p.label"
          @click.stop="onPeekClick(p.kind)"
          @keydown.enter.stop.prevent="onPeekClick(p.kind)"
          @keydown.space.stop.prevent="onPeekClick(p.kind)"
        >
          <component :is="p.icon" :size="11" :stroke-width="1.6" />
          <span class="tabular-nums">{{ p.count }}</span>
        </span>

        <span
          role="button"
          tabindex="0"
          data-drill-new-session
          class="flex shrink-0 items-center justify-center rounded text-text-4 transition hover:text-accent"
          style="width: 20px; height: 20px"
          :title="$t('sidebar.newSession')"
          :aria-label="$t('sidebar.newSession')"
          @click.stop="onNewSessionClick"
          @keydown.enter.stop.prevent="onNewSessionClick"
          @keydown.space.stop.prevent="onNewSessionClick"
        >
          <Plus :size="14" :stroke-width="1.8" />
        </span>

        <!-- Folder actions (T289) — always visible, same posture as the `+`
             beside it: the back row is a persistent header, not a row that
             fades stats in on hover. -->
        <span
          role="button"
          tabindex="0"
          data-drill-back-actions
          class="flex shrink-0 items-center justify-center rounded text-text-4 transition hover:text-text-2"
          style="width: 20px; height: 20px"
          :title="$t('folderMenu.label')"
          :aria-label="$t('folderMenu.label')"
          @click.stop="onBackActions"
          @keydown.enter.stop.prevent="onBackActions"
          @keydown.space.stop.prevent="onBackActions"
        >
          <Ellipsis :size="14" :stroke-width="1.8" />
        </span>
      </span>

      <!-- Repo screen: the group's own menu, same trailing slot (T289). -->
      <span
        v-else-if="groupScreen"
        role="button"
        tabindex="0"
        data-drill-back-actions
        class="flex shrink-0 items-center justify-center rounded text-text-4 transition hover:text-text-2"
        style="width: 20px; height: 20px"
        :title="$t('repoGroup.menuLabel')"
        :aria-label="$t('repoGroup.menuLabel')"
        @click.stop="onBackActions"
        @keydown.enter.stop.prevent="onBackActions"
        @keydown.space.stop.prevent="onBackActions"
      >
        <Ellipsis :size="14" :stroke-width="1.8" />
      </span>
    </button>

    <div class="scrollable flex-1 overflow-y-auto" style="padding: 6px 0">
      <!-- Root screen -->
      <template v-if="!top">
        <button
          v-for="node in rootNodes"
          :key="isGroup(node) ? node.key : node.path"
          :data-drill-root-row="isGroup(node) ? node.key : node.path"
          class="sidebar-row group flex w-full items-center text-left text-text transition hover:bg-surface"
          style="height: 30px; padding: 0 10px; gap: 7px; font-size: 12.5px"
          @click="onRootClick(node)"
          @contextmenu="onRootActions($event, node)"
        >
          <GitBranch
            v-if="isGroup(node) && node.source === 'repo'"
            :size="13"
            :stroke-width="1.8"
            class="shrink-0 text-text-3"
          />
          <FolderIcon v-else :size="13" :stroke-width="1.8" class="shrink-0 text-text-3" />
          <span
            class="min-w-0 flex-1 truncate"
            :class="isGroup(node) ? 'font-semibold' : 'font-medium text-text-2'"
            >{{ labelFor(node) }}</span
          >
          <span v-if="isGroup(node)" class="shrink-0 text-[11px] text-text-4">{{
            node.source === 'repo'
              ? $t('sidebar.drill.worktreeCount', { n: node.folders.length })
              : $t('sidebar.drill.folderCount', { n: node.folders.length })
          }}</span>
          <!-- Chooser-row actions (T289) — "Stats on demand": invisible at
               rest with the space preserved, revealed on hover/focus, forced
               visible while its own menu is open. -->
          <span
            role="button"
            tabindex="0"
            :data-drill-row-actions="isGroup(node) ? node.key : node.path"
            class="flex shrink-0 items-center justify-center rounded text-text-4 transition hover:text-text-2"
            :class="
              (isGroup(node) ? groupActionsOpen(node.key) : folderActionsOpen(node.path))
                ? 'opacity-100'
                : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
            "
            style="width: 20px; height: 20px"
            :title="isGroup(node) ? $t('repoGroup.menuLabel') : $t('folderMenu.label')"
            :aria-label="isGroup(node) ? $t('repoGroup.menuLabel') : $t('folderMenu.label')"
            @click.stop="onRootActions($event, node)"
            @keydown.enter.stop.prevent="onRootActions($event, node)"
            @keydown.space.stop.prevent="onRootActions($event, node)"
          >
            <Ellipsis :size="14" :stroke-width="1.8" />
          </span>
          <ChevronRight :size="13" :stroke-width="1.8" class="shrink-0 text-text-4" />
        </button>
      </template>

      <!-- Group screen: member folders. Drillable chooser rows while the depth
           budget allows another screen; otherwise the same `SidebarFolder`
           component the classic tree renders inside a group, so expansion,
           sessions, teammates, terminals, and the inline action cluster all
           come along unchanged. Rendered WITHOUT `nested` (unlike the classic
           tree's own in-group folders): `nested`'s extra indent exists to
           read as "inside a RepoGroupHeader disclosure", but this screen has
           no `RepoGroupHeader` in the DOM — the back row above already
           establishes "you're inside this group", so the default `flat`
           indent is correct here (see design.md's "Drill-in navigation"
           section for the reasoning). -->
      <template v-else-if="groupScreen">
        <template v-if="canDrill">
          <button
            v-for="f in groupScreen.folders"
            :key="f.path"
            :data-drill-folder-row="f.path"
            class="sidebar-row group flex w-full items-center text-left text-text transition hover:bg-surface"
            style="height: 30px; padding: 0 10px; gap: 7px; font-size: 12.5px"
            @click="sessions.drillIntoFolder(f.path)"
            @contextmenu="openFolderMenuAt($event, f.path)"
          >
            <FolderIcon :size="13" :stroke-width="1.8" class="shrink-0 text-text-3" />
            <span class="min-w-0 flex-1 truncate font-medium text-text-2">{{ labelFor(f) }}</span>
            <span
              role="button"
              tabindex="0"
              :data-drill-row-actions="f.path"
              class="flex shrink-0 items-center justify-center rounded text-text-4 transition hover:text-text-2"
              :class="
                folderActionsOpen(f.path)
                  ? 'opacity-100'
                  : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
              "
              style="width: 20px; height: 20px"
              :title="$t('folderMenu.label')"
              :aria-label="$t('folderMenu.label')"
              @click.stop="openFolderMenuAt($event, f.path)"
              @keydown.enter.stop.prevent="openFolderMenuAt($event, f.path)"
              @keydown.space.stop.prevent="openFolderMenuAt($event, f.path)"
            >
              <Ellipsis :size="14" :stroke-width="1.8" />
            </span>
            <ChevronRight :size="13" :stroke-width="1.8" class="shrink-0 text-text-4" />
          </button>
        </template>
        <template v-else>
          <SidebarFolder v-for="f in groupScreen.folders" :key="f.path" :folder="f" />
        </template>
      </template>

      <!-- Folder screen: the folder's own sessions, reusing SidebarFolder's
           row rendering headerless — the back row above already names it. -->
      <SidebarFolder v-else-if="folderScreen" :folder="folderScreen" headerless />
    </div>

    <!-- Group context menu (T289): the same Rename / Reset name / Cleanup items
         `RepoGroupHeader` shows, hosted here because that header never mounts
         in drill-in. Inline + Teleported; dismissed on Esc / click-outside /
         wheel — same idiom as `FolderMenu`. -->
    <Teleport to="body">
      <div
        v-if="groupMenu.open && groupMenuTarget"
        ref="groupMenuRef"
        data-drill-group-menu
        class="anim-fade-in-scale fixed border border-border-2 bg-surface"
        style="
          min-width: 172px;
          padding: 4px;
          border-radius: 7px;
          box-shadow: var(--shadow-pop);
          z-index: 50;
          transform-origin: top left;
        "
        :style="{ left: groupMenu.x + 'px', top: groupMenu.y + 'px' }"
        role="menu"
        :aria-label="t('repoGroup.menuLabel')"
      >
        <button
          role="menuitem"
          class="flex w-full items-center text-left text-text-2 transition hover:bg-surface-2 hover:text-text focus:bg-surface-2 focus:text-text focus:outline-none"
          style="gap: 9px; padding: 6px 8px; font-size: 12px; border-radius: 4px; outline: none"
          @click="renameGroup"
        >
          <PencilLine :size="13" :stroke-width="1.6" class="shrink-0" />
          <span class="flex-1 truncate">{{ t('repoGroup.rename') }}</span>
        </button>
        <button
          v-if="groupMenuHasAlias"
          role="menuitem"
          class="flex w-full items-center text-left text-text-2 transition hover:bg-surface-2 hover:text-text focus:bg-surface-2 focus:text-text focus:outline-none"
          style="gap: 9px; padding: 6px 8px; font-size: 12px; border-radius: 4px; outline: none"
          @click="resetGroupName"
        >
          <RotateCcw :size="13" :stroke-width="1.6" class="shrink-0" />
          <span class="flex-1 truncate">{{ t('repoGroup.resetName') }}</span>
        </button>
        <button
          v-if="groupMenuTarget.source === 'repo'"
          role="menuitem"
          class="flex w-full items-center text-left text-text-2 transition hover:bg-surface-2 hover:text-text focus:bg-surface-2 focus:text-text focus:outline-none"
          style="gap: 9px; padding: 6px 8px; font-size: 12px; border-radius: 4px; outline: none"
          @click="openGroupCleanup"
        >
          <Trash2 :size="13" :stroke-width="1.6" class="shrink-0" />
          <span class="flex-1 truncate">{{ t('repoGroup.cleanup') }}</span>
        </button>
      </div>
    </Teleport>
  </div>
</template>
