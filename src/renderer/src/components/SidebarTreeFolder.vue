<script setup lang="ts">
import { computed } from 'vue'
import { BotOff, Crown, EyeOff, GitBranch, Home, PanelRight } from 'lucide-vue-next'
import { useHoverPreview } from '../composables/useHoverPreview'
import { checkoutLabel, treeHeaderCursor, type TreeFolder } from '../lib/sidebar-tree'
import { useHelpersStore } from '../stores/helpers'
import { useSessionsStore, type Folder } from '../stores/sessions'
import { useUiStore } from '../stores/ui'
import { densityMetrics } from './sidebar-density'
import { dotFor } from './session-dot'
import SidebarFolder from './SidebarFolder.vue'
import SidebarShelvedSection from './SidebarShelvedSection.vue'
import SidebarValueSlot from './SidebarValueSlot.vue'

const props = defineProps<{ tree: TreeFolder }>()

const sessions = useSessionsStore()
const ui = useUiStore()
const helpers = useHelpersStore()
const hoverPreview = useHoverPreview()

const metrics = computed(() => densityMetrics(sessions.sidebarDensity))
const members = computed(() => props.tree.group?.folders ?? [props.tree.primary])
const allHidden = computed(() => props.tree.paths.every(isHidden))
const current = computed(() => props.tree.paths.includes(sessions.selectedFolderPath ?? ''))
const headerCursor = computed(() => treeHeaderCursor(props.tree))
const idleOpen = computed(() => sessions.isIdleWorktreesOpen(props.tree.key))
const paneFolders = computed(() => members.value.filter((folder) => paneCount(folder) > 0))
const unseen = computed(() =>
  paneFolders.value.reduce((count, folder) => count + paneCount(folder), 0)
)
const blocked = computed(() =>
  members.value.filter((folder) => sessions.agentDeniedPaths.has(folder.path))
)
const orchestrators = computed(() =>
  members.value.filter((folder) => sessions.orchestratorDefaultPaths.has(folder.path))
)
const listed = computed(() =>
  props.tree.checkouts.map((folder) => {
    const count = sessionCount(folder)
    return {
      folder,
      hasRows: count > 0 || sessions.terminalsForFolder(folder).length > 0,
      folded: sessions.isCheckoutFolded(folder.path),
      count
    }
  })
)

const ringStates = ['idle', 'working', 'errored', 'needs-input'] as const
const ring = computed(() => {
  let hottest = 0
  for (const folder of members.value) {
    for (const session of folder.sessions) {
      if (sessions.isArchived(session.sessionId) || session.status === 'archived') continue
      const dot = dotFor(
        session.taskState,
        session.status,
        sessions.activityOf(session, sessions.nowTick),
        session.transcriptState
      )
      if (dot === 'needs-input') return 'needs-input'
      if (dot === 'failed') hottest = 2
      else if (dot === 'working' || dot === 'stuck') hottest = Math.max(hottest, 1)
    }
  }
  return ringStates[hottest]
})

const ringLabel = {
  idle: 'session.statusIdle',
  working: 'session.statusActive',
  errored: 'session.statusFailed',
  'needs-input': 'session.statusNeedsInput'
} as const

function paneCount(folder: Folder): number {
  return helpers.unseenAgentPaneCount(folder.path)
}

function signalLabel(label: string, folders: Folder[]): string {
  return props.tree.checkoutCount > 1
    ? `${label} · ${folders.map(checkoutLabel).join(', ')}`
    : label
}

function sessionCount(folder: Folder): number {
  return sessions.sidebarSessionRows(folder).rows.length
}

function isHidden(path: string): boolean {
  return sessions.manuallyHiddenPaths.has(path)
}

function focused(kind: 'group' | 'folder', id: string): 'true' | undefined {
  const cursor = sessions.keyboardCursor
  return cursor?.kind === kind && cursor.id === id ? 'true' : undefined
}

function selectHeader(): void {
  if (!props.tree.open) sessions.toggleTreeFolder(props.tree.key)
  sessions.selectFolder(props.tree.primary.path)
}

function openMenu(event: MouseEvent, path: string, groupKey?: string): void {
  ui.openFolderMenu({ projectPath: path, x: event.clientX, y: event.clientY, groupKey })
}

function preview(event: MouseEvent, path: string): void {
  hoverPreview.enterFolder(path, (event.currentTarget as HTMLElement).getBoundingClientRect())
}
</script>

<template>
  <section :data-tree-folder="tree.key" :data-tree-paths="tree.paths.join('|')">
    <div
      data-folder-head
      data-dsqa-part="folder-header"
      :data-folder-path="tree.git ? undefined : tree.primary.path"
      :data-sidebar-row="`${headerCursor.kind}:${headerCursor.id}`"
      :data-focused="focused(headerCursor.kind === 'group' ? 'group' : 'folder', tree.key)"
      :data-current="current || undefined"
      class="sidebar-tree-head sidebar-row group sticky top-0 z-[3] flex w-full items-center gap-2 bg-sidebar pr-3"
      :style="{ height: `${metrics.folderRowHeight}px` }"
      @click="selectHeader"
      @contextmenu.prevent="openMenu($event, tree.primary.path, tree.group?.key)"
      @mouseenter="preview($event, tree.primary.path)"
      @mouseleave="hoverPreview.leave()"
    >
      <button
        type="button"
        class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 self-stretch pl-3 text-left text-[12.5px] font-medium text-text"
        :class="allHidden && 'opacity-50'"
        :aria-current="current ? 'page' : undefined"
      >
        <EyeOff v-if="allHidden" :size="16" :stroke-width="1.6" class="shrink-0 text-text-4" />
        <span
          v-else
          class="fleet-ring"
          :class="`fleet-ring--${ring}`"
          role="img"
          :aria-label="$t(ringLabel[ring])"
        >
          <span class="fleet-ring-track" />
          <span v-if="ring === 'working'" class="fleet-ring-arc" />
          <span v-if="ring !== 'idle'" class="fleet-ring-dot" />
        </span>
        <span class="flex min-w-0 flex-1 items-baseline gap-2">
          <span class="truncate">{{ tree.label }}</span>
          <span v-if="tree.parentHint" class="truncate text-[10.5px] text-text-4"
            >· {{ tree.parentHint }}</span
          >
        </span>
        <span
          v-if="unseen"
          data-signal="agent-panes"
          class="flex shrink-0 items-center gap-[3px] rounded-full border border-accent-line bg-accent-soft px-1.5 py-0.5 text-[10px] text-accent tabular-nums"
          :title="signalLabel($t('sidebar.agentPaneBadge', { n: unseen }), paneFolders)"
          :aria-label="signalLabel($t('sidebar.agentPaneBadge', { n: unseen }), paneFolders)"
        >
          <PanelRight :size="11" :stroke-width="1.6" aria-hidden="true" />
          {{ unseen }}
        </span>
        <span
          v-if="blocked.length"
          data-signal="agent-blocked"
          class="shrink-0 text-text-4"
          :title="signalLabel($t('sidebar.agentBlockedBadge'), blocked)"
          :aria-label="signalLabel($t('sidebar.agentBlockedBadge'), blocked)"
          ><BotOff :size="11" :stroke-width="1.6" aria-hidden="true"
        /></span>
        <span
          v-if="orchestrators.length"
          data-signal="orchestrator-default"
          class="shrink-0 text-accent"
          :title="signalLabel($t('sidebar.orchestratorDefaultIndicator'), orchestrators)"
          :aria-label="signalLabel($t('sidebar.orchestratorDefaultIndicator'), orchestrators)"
          ><Crown :size="11" :stroke-width="1.6" aria-hidden="true"
        /></span>
      </button>
      <SidebarValueSlot
        :count="tree.git ? tree.checkoutCount : tree.open ? undefined : sessionCount(tree.primary)"
        :open="tree.open"
        :label="
          $t(tree.open ? 'sidebar.tree.foldFolder' : 'sidebar.tree.openFolder', {
            name: tree.label
          })
        "
        :class="allHidden && 'opacity-50'"
        @toggle="sessions.toggleTreeFolder(tree.key)"
      />
    </div>

    <div data-folder-content :data-open="tree.open" class="sidebar-disclosure" :inert="!tree.open">
      <div class="sidebar-disclosure-content">
        <div class="pt-0.5 pb-2">
          <SidebarFolder v-if="!tree.git" :folder="tree.primary" embedded />
          <div
            v-for="{ folder, hasRows, folded, count } in listed"
            :key="folder.path"
            :data-folder-path="folder.path"
          >
            <button
              type="button"
              data-checkout-row
              data-dsqa-part="checkout-row"
              :data-checkout-path="folder.path"
              :data-sidebar-row="`folder:${folder.path}`"
              :data-focused="focused('folder', folder.path)"
              :aria-expanded="hasRows ? !folded : undefined"
              class="sidebar-row relative group flex w-full items-center gap-2 pr-3 text-left text-text-4 hover:bg-surface hover:text-text"
              :class="[hasRows && 'cursor-pointer', isHidden(folder.path) && 'opacity-50']"
              :style="{ height: `${metrics.checkoutRowHeight}px`, paddingLeft: '14px' }"
              @click="hasRows && sessions.toggleCheckoutFold(folder.path)"
              @contextmenu.prevent="openMenu($event, folder.path)"
              @mouseenter="preview($event, folder.path)"
              @mouseleave="hoverPreview.leave()"
            >
              <component
                :is="isHidden(folder.path) ? EyeOff : folder.isMainWorktree ? Home : GitBranch"
                :size="13"
                :stroke-width="1.6"
                class="shrink-0"
                aria-hidden="true"
              />
              <span class="min-w-0 flex-1 truncate font-mono text-[11.5px]">{{
                checkoutLabel(folder)
              }}</span>
              <SidebarValueSlot
                :count="folded && hasRows ? count : undefined"
                :open="hasRows ? !folded : undefined"
              />
            </button>
            <div v-if="hasRows" class="sidebar-disclosure" :data-open="!folded" :inert="folded">
              <div class="sidebar-disclosure-content">
                <SidebarFolder :folder="folder" embedded />
              </div>
            </div>
          </div>
          <template v-if="tree.idle.length">
            <button
              type="button"
              data-idle-row
              data-dsqa-part="idle-row"
              :data-sidebar-row="`group:idle:${tree.key}`"
              :data-focused="focused('group', `idle:${tree.key}`)"
              :aria-expanded="idleOpen"
              class="sidebar-row relative group flex w-full cursor-pointer items-center gap-2 pr-3 pl-3.5 text-left text-text-4 opacity-85 hover:bg-surface hover:text-text"
              :style="{ height: `${metrics.checkoutRowHeight}px` }"
              @click="sessions.toggleIdleWorktrees(tree.key)"
            >
              <GitBranch :size="13" :stroke-width="1.6" class="shrink-0" aria-hidden="true" />
              <span class="min-w-0 flex-1 truncate text-[11.5px]">{{
                $t('sidebar.tree.idleWorktrees', tree.idle.length)
              }}</span>
              <SidebarValueSlot :open="idleOpen" />
            </button>
            <template v-if="idleOpen">
              <div
                v-for="(folder, index) in tree.idle"
                :key="folder.path"
                :data-folder-path="folder.path"
              >
                <button
                  type="button"
                  data-idle-worktree
                  :data-sidebar-row="`folder:${folder.path}`"
                  :data-focused="focused('folder', folder.path)"
                  :data-guide-last="index === tree.idle.length - 1 || undefined"
                  class="sidebar-row sidebar-tree-guide group relative flex w-full cursor-pointer items-center gap-2 pr-3 pl-3.5 text-left text-text-4 hover:bg-surface hover:text-text"
                  :class="isHidden(folder.path) && 'opacity-50'"
                  :style="{ height: `${metrics.checkoutRowHeight}px` }"
                  @click="sessions.selectFolder(folder.path)"
                  @contextmenu.prevent="openMenu($event, folder.path)"
                >
                  <span class="w-[13px] shrink-0" aria-hidden="true" />
                  <span class="min-w-0 flex-1 truncate font-mono text-[11.5px]">{{
                    checkoutLabel(folder)
                  }}</span>
                  <SidebarValueSlot />
                </button>
              </div>
            </template>
          </template>
          <SidebarShelvedSection v-if="tree.group?.shelved?.length" :group="tree.group" />
        </div>
      </div>
    </div>
  </section>
</template>
