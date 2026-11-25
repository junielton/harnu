<script setup lang="ts">
import { computed } from 'vue'
import { BotOff, Crown, EyeOff, PanelRight } from 'lucide-vue-next'
import { useHoverPreview } from '../composables/useHoverPreview'
import { checkoutLabel, treeHeaderCursor, type TreeFolder } from '../lib/sidebar-tree'
import { useHelpersStore } from '../stores/helpers'
import { useSessionsStore, type Folder } from '../stores/sessions'
import { useUiStore } from '../stores/ui'
import { densityMetrics } from './sidebar-density'
import { dotFor } from './session-dot'
import SidebarValueSlot from './SidebarValueSlot.vue'

/**
 * The folder header of the sidebar tree (design.md §6 "Sidebar tree → Folder
 * header"): one per repo or standalone folder — state ring, name, the signals
 * of any of its checkouts, and the shared value slot. A click selects the
 * folder's Folder View and opens it; only the chevron collapses.
 */
const props = defineProps<{ tree: TreeFolder }>()

const sessions = useSessionsStore()
const ui = useUiStore()
const helpers = useHelpersStore()
const hoverPreview = useHoverPreview()

const metrics = computed(() => densityMetrics(sessions.sidebarDensity))
const members = computed(() => props.tree.group?.folders ?? [props.tree.primary])
const allHidden = computed(() =>
  props.tree.paths.every((path) => sessions.manuallyHiddenPaths.has(path))
)
const current = computed(() => props.tree.paths.includes(sessions.selectedFolderPath ?? ''))
const cursor = computed(() => treeHeaderCursor(props.tree))
const focused = computed(
  () =>
    sessions.keyboardCursor?.kind === cursor.value.kind &&
    sessions.keyboardCursor.id === cursor.value.id
)
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
/** A non-git folder has no checkout to count: it shows its sessions only while folded. */
const count = computed(() => {
  if (props.tree.git) return props.tree.checkoutCount
  return props.tree.open
    ? undefined
    : sessions.sidebarSessionRows(props.tree.primary).rows.length || undefined
})

/** The hottest session of any checkout: needs input, then failed, then working. */
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

function select(): void {
  if (!props.tree.open) sessions.toggleTreeFolder(props.tree.key)
  sessions.selectFolder(props.tree.primary.path)
}

function openMenu(event: MouseEvent): void {
  ui.openFolderMenu({
    projectPath: props.tree.primary.path,
    x: event.clientX,
    y: event.clientY,
    groupKey: props.tree.group?.key
  })
}

function preview(event: MouseEvent): void {
  hoverPreview.enterFolder(
    props.tree.primary.path,
    (event.currentTarget as HTMLElement).getBoundingClientRect()
  )
}
</script>

<template>
  <div
    data-folder-head
    data-dsqa-part="folder-header"
    :data-folder-path="tree.git ? undefined : tree.primary.path"
    :data-sidebar-row="`${cursor.kind}:${cursor.id}`"
    :data-focused="focused ? 'true' : undefined"
    :data-current="current || undefined"
    class="sidebar-tree-head sidebar-row group sticky top-0 z-[3] flex w-full items-center gap-2 bg-sidebar pr-3"
    :style="{ height: `${metrics.folderRowHeight}px` }"
    @click="select"
    @contextmenu.prevent="openMenu"
    @mouseenter="preview"
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
      :count="count"
      :open="tree.open"
      :label="
        $t(tree.open ? 'sidebar.tree.foldFolder' : 'sidebar.tree.openFolder', { name: tree.label })
      "
      :class="allHidden && 'opacity-50'"
      @toggle="sessions.toggleTreeFolder(tree.key)"
    />
  </div>
</template>
