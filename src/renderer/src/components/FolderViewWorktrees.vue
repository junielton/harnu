<script setup lang="ts">
import { computed } from 'vue'
import { GitBranch, GitFork } from 'lucide-vue-next'
import type { Folder } from '../stores/sessions'
import { useSessionsStore } from '../stores/sessions'
import { displayAlias } from './folder-alias'
import ScopeTag from './ui/ScopeTag.vue'
import { dotFor } from './session-dot'
import {
  activityBucket,
  scopeOf,
  type ActivityBucket,
  type FolderViewProfile
} from './folder-view-format'

/**
 * T212 — the other worktrees of this repo, and which of them were cut from
 * here. Pure model read: `repoId` groups them and `bornFrom` (T191, already in
 * the folder model) names the mother. Renders nothing for a folder with no repo
 * or no siblings — a lone checkout has no lineage worth a section.
 *
 * T285 — a rail card, tagged `repo`: this is every worktree the repo has, not
 * this folder's children. The heading follows the profile — "Worktrees in this
 * repo" from main, "Sibling worktrees" from inside one, which is the honest name
 * when you are standing in one of them.
 *
 * T287 — every row carries its worktree's session state, so a blocked upstream
 * branch is visible without leaving the folder you are in. That is the whole
 * point of the block from inside a worktree: "what am I stacked on, and is it
 * waiting on me?" is a question you should not have to click to answer.
 */

const props = defineProps<{ folder: Folder; profile?: FolderViewProfile }>()

const sessions = useSessionsStore()

const siblings = computed<Folder[]>(() => {
  const repoId = props.folder.repoId
  if (!repoId) return []
  return sessions.folders.filter((f) => f.repoId === repoId)
})

/** Show the section only when there is more than just this folder. */
const hasSiblings = computed(() => siblings.value.length > 1)

const headingKey = computed(() =>
  props.profile === 'worktree' ? 'folderView.siblingWorktrees' : 'folderView.worktrees'
)

function label(f: Folder): string {
  return f.gitBranch || displayAlias(f, sessions.aliasFromBranchPaths.has(f.path))
}

function isThisOne(f: Folder): boolean {
  return f.path === props.folder.path
}

/** Was `f` cut from the folder this view is showing? (T191 lineage edge.) */
function isChildOfThis(f: Folder): boolean {
  return f.bornFrom === props.folder.path
}

/**
 * T287 — one worktree's state, folded from its sessions.
 *
 * The per-session recipe is the canonical one (`dotFor` over `activityOf`,
 * archive overriding), exactly as `FolderViewSessions` and `SidebarFolder`
 * resolve it — a branch must never read `working` in one list and `idle` in
 * another. The fold to a single row dot is worst-first: **needs-input beats
 * working beats idle**, because the reason to show a sibling's state at all is
 * to surface the one that is blocked on you.
 */
function stateOf(f: Folder): ActivityBucket {
  let working = false
  for (const s of f.sessions) {
    const dot = sessions.isArchived(s.sessionId)
      ? 'archived'
      : dotFor(s.taskState, s.status, sessions.activityOf(s, sessions.nowTick), s.transcriptState)
    const bucket = activityBucket(dot)
    if (bucket === 'needs-input') return 'needs-input'
    if (bucket === 'working') working = true
  }
  return working ? 'working' : 'idle'
}

/** design.md §6 — the sidebar's own dot colours, per bucket. No raw hex. */
const DOT_CLASS: Record<ActivityBucket, string> = {
  working: 'anim-pulse-dot bg-green',
  'needs-input': 'anim-attention-dot bg-warning',
  idle: 'bg-text-4'
}

/** Reuses the status labels the sidebar already ships — no new i18n keys. */
const DOT_LABEL: Record<ActivityBucket, string> = {
  working: 'session.statusActive',
  'needs-input': 'session.statusNeedsInput',
  idle: 'session.statusIdle'
}
</script>

<template>
  <section
    v-if="hasSiblings"
    class="flex flex-col border border-border bg-surface"
    style="gap: 10px; border-radius: var(--radius); padding: 14px 16px"
    data-test="folder-view-worktrees"
  >
    <div class="flex items-center justify-between" style="gap: 8px">
      <span class="eyebrow text-text-4">{{ $t(headingKey) }}</span>
      <ScopeTag :scope="scopeOf('worktrees')" />
    </div>

    <!-- BUG-118 — the same `--fv-rail-list-max-h` cap the roadmap list carries,
         for the identical reason: 102 branches in a 320px rail is a column of
         names three screens tall. The two rail lists are the same shape of block
         and must not disagree about how much room a rail list gets. -->
    <div
      class="scrollable flex flex-col"
      style="gap: 2px; margin: 0 -10px; max-height: var(--fv-rail-list-max-h); overflow-y: auto"
      data-test="folder-view-worktree-list"
    >
      <button
        v-for="f in siblings"
        :key="f.path"
        class="flex w-full cursor-pointer items-center text-left text-text-2 transition hover:bg-surface-2 hover:text-text"
        style="gap: 8px; border-radius: var(--radius-sm); padding: 6px 10px; font-size: 12.5px"
        :disabled="isThisOne(f)"
        data-test="folder-view-worktree"
        @click="sessions.selectFolder(f.path)"
      >
        <span
          class="shrink-0 rounded-full"
          :class="DOT_CLASS[stateOf(f)]"
          style="width: 6px; height: 6px"
          :aria-label="$t(DOT_LABEL[stateOf(f)])"
          data-test="folder-view-worktree-dot"
          :data-state="stateOf(f)"
        />
        <GitBranch :size="12" :stroke-width="1.6" class="shrink-0 text-text-4" />
        <span class="min-w-0 flex-1 truncate font-mono">{{ label(f) }}</span>
        <span v-if="isThisOne(f)" class="shrink-0 text-text-4" style="font-size: 10.5px">{{
          $t('folderView.thisWorktree')
        }}</span>
        <span
          v-else-if="isChildOfThis(f)"
          class="flex shrink-0 items-center text-text-4"
          style="gap: 4px; font-size: 10.5px"
        >
          <GitFork :size="10" :stroke-width="1.6" />{{ $t('folderView.cutFromHere') }}
        </span>
      </button>
    </div>
  </section>
</template>
