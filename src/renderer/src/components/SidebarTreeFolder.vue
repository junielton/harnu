<script setup lang="ts">
import { computed } from 'vue'
import { EyeOff, GitBranch, Home } from 'lucide-vue-next'
import { useHoverPreview } from '../composables/useHoverPreview'
import { checkoutLabel, railState, type RailState, type TreeFolder } from '../lib/sidebar-tree'
import { useSessionsStore } from '../stores/sessions'
import { useUiStore } from '../stores/ui'
import { densityMetrics } from './sidebar-density'
import RepoGroupHeader from './RepoGroupHeader.vue'
import SidebarFolder from './SidebarFolder.vue'
import SidebarShelvedSection from './SidebarShelvedSection.vue'
import SidebarValueSlot from './SidebarValueSlot.vue'

/**
 * One folder of the sidebar tree (design.md §6 "Sidebar tree"): its header, the
 * checkout rows with their sessions, the idle-worktrees row and the Shelved
 * section, in that order.
 */
const props = defineProps<{ tree: TreeFolder }>()

const sessions = useSessionsStore()
const ui = useUiStore()
const hoverPreview = useHoverPreview()

const metrics = computed(() => densityMetrics(sessions.sidebarDensity))
const idleOpen = computed(() => sessions.isIdleWorktreesOpen(props.tree.key))
const listed = computed(() =>
  props.tree.checkouts.map((folder) => {
    const count = sessions.sidebarSessionRows(folder).rows.length
    return {
      folder,
      hasRows: count > 0 || sessions.terminalsForFolder(folder).length > 0,
      folded: sessions.isCheckoutFolded(folder.path),
      count,
      rail: railState(sessions.folderRingLevel(folder.path))
    }
  })
)

const railLabel: Record<RailState, string> = {
  working: 'sidebar.tree.railWorking',
  failed: 'sidebar.tree.railFailed',
  'needs-input': 'sidebar.tree.railNeedsInput'
}

function isHidden(path: string): boolean {
  return sessions.manuallyHiddenPaths.has(path)
}

function focused(kind: 'group' | 'folder', id: string): 'true' | undefined {
  const cursor = sessions.keyboardCursor
  return cursor?.kind === kind && cursor.id === id ? 'true' : undefined
}

function openMenu(event: MouseEvent, path: string): void {
  ui.openFolderMenu({ projectPath: path, x: event.clientX, y: event.clientY })
}

function preview(event: MouseEvent, path: string): void {
  hoverPreview.enterFolder(path, (event.currentTarget as HTMLElement).getBoundingClientRect())
}
</script>

<template>
  <section :data-tree-folder="tree.key" :data-tree-paths="tree.paths.join('|')">
    <RepoGroupHeader :tree="tree" />

    <div data-folder-content :data-open="tree.open" class="sidebar-disclosure" :inert="!tree.open">
      <div class="sidebar-disclosure-content">
        <div class="pt-0.5 pb-2">
          <SidebarFolder v-if="!tree.git" :folder="tree.primary" />
          <!-- The group rail (design.md "Group rail") is painted on this box: the
               checkout row and its sessions. -->
          <div
            v-for="{ folder, hasRows, folded, count, rail } in listed"
            :key="folder.path"
            :data-folder-path="folder.path"
            data-checkout-group
            data-dsqa-part="checkout-group"
            :data-group-rail="rail"
          >
            <button
              type="button"
              data-checkout-row
              data-row-bar="checkout"
              data-dsqa-part="checkout-row"
              :data-checkout-path="folder.path"
              :data-sidebar-row="`folder:${folder.path}`"
              :data-focused="focused('folder', folder.path)"
              :aria-expanded="hasRows ? !folded : undefined"
              :aria-label="rail && $t(railLabel[rail], { branch: checkoutLabel(folder) })"
              class="sidebar-row relative group flex w-full items-center gap-2 pr-3 text-left text-text-4"
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
              <span class="min-w-0 flex-1 truncate font-mono text-[11.5px] leading-[14px]">{{
                checkoutLabel(folder)
              }}</span>
              <SidebarValueSlot
                :count="folded && count ? count : undefined"
                :open="hasRows ? !folded : undefined"
              />
            </button>
            <div v-if="hasRows" class="sidebar-disclosure" :data-open="!folded" :inert="folded">
              <div class="sidebar-disclosure-content">
                <SidebarFolder :folder="folder" />
              </div>
            </div>
          </div>
          <template v-if="tree.idle.length">
            <button
              type="button"
              data-idle-row
              data-row-bar="checkout"
              data-dsqa-part="idle-row"
              :data-sidebar-row="`group:idle:${tree.key}`"
              :data-focused="focused('group', `idle:${tree.key}`)"
              :aria-expanded="idleOpen"
              class="sidebar-row relative group flex w-full cursor-pointer items-center gap-2 pr-3 pl-3.5 text-left text-text-4 opacity-85"
              :style="{ height: `${metrics.checkoutRowHeight}px` }"
              @click="sessions.toggleIdleWorktrees(tree.key)"
            >
              <GitBranch :size="13" :stroke-width="1.6" class="shrink-0" aria-hidden="true" />
              <span class="min-w-0 flex-1 truncate text-[11.5px] leading-[14px]">{{
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
                  data-row-bar="checkout"
                  :data-sidebar-row="`folder:${folder.path}`"
                  :data-focused="focused('folder', folder.path)"
                  :data-guide-last="index === tree.idle.length - 1 || undefined"
                  class="sidebar-row group relative flex w-full cursor-pointer items-center gap-2 pr-3 pl-3.5 text-left text-text-4"
                  :class="isHidden(folder.path) && 'opacity-50'"
                  :style="{ height: `${metrics.checkoutRowHeight}px` }"
                  @click="sessions.selectFolder(folder.path)"
                  @contextmenu.prevent="openMenu($event, folder.path)"
                  @mouseenter="preview($event, folder.path)"
                  @mouseleave="hoverPreview.leave()"
                >
                  <span class="w-[13px] shrink-0" aria-hidden="true" />
                  <span class="min-w-0 flex-1 truncate font-mono text-[11.5px] leading-[14px]">{{
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
