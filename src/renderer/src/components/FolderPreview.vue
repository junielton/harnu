<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { GitBranch } from 'lucide-vue-next'
import type { FolderGitStatus } from '../../../preload'
import { useUiStore } from '../stores/ui'
import { useSessionsStore } from '../stores/sessions'
import { useMemoryStore } from '../stores/memory'
import { useHoverPreview } from '../composables/useHoverPreview'
import { relativeTime } from '../composables/useRelativeTime'
import { displayAlias } from './folder-alias'
import { folderActivity } from './folder-sort'
import MarkdownRenderer from './MarkdownRenderer.vue'

/**
 * Folder hover card (T52 Slice 2/3) — the folder-row twin of `SessionPreview`.
 * Same anchoring / z-40 / INTERACTIVE `pointer-events: auto` contract (design.md
 * §3.9, T86); it shares `ui.preview` with the session preview (only one of
 * `sessionId` / `folderPath` is ever set). Cheap fields (alias, path, branch,
 * worktree kind, session count, last activity) read straight off the `Folder`; the
 * expensive dirty / ahead-behind fields load on open via the throttled
 * `foldersGitStatus` probe and degrade to nothing on failure. The hot-cue (hot.md)
 * renders in full and scrolls inside the card.
 */

const ui = useUiStore()
const sessions = useSessionsStore()
const memory = useMemoryStore()
// The card participates in the shared hover zone: keep the preview open while the
// cursor is over the card, and arm the grace-close when it leaves (T86).
const { cancelClose, scheduleClose } = useHoverPreview()

const PREVIEW_MAX_WIDTH = 360
const GAP_PX = 8
const VIEWPORT_MARGIN = 8

const folder = computed(() => {
  const path = ui.preview.folderPath
  if (!path) return null
  return sessions.findFolderByPath(path) ?? null
})

const label = computed(() => {
  const f = folder.value
  return f ? displayAlias(f, sessions.aliasFromBranchPaths.has(f.path)) : ''
})

const activityMs = computed(() => {
  const f = folder.value
  if (!f) return -Infinity
  return folderActivity({ alias: f.alias, sessions: f.sessions })
})

const isMainWorktree = computed(() => folder.value?.isMainWorktree === true)
const isGitFolder = computed(() => {
  const f = folder.value
  return !!f && ((typeof f.repoId === 'string' && f.repoId.length > 0) || !!f.gitBranch)
})

// --- Expensive fields: dirty count + ahead/behind, loaded on open -----------
const gitStatus = ref<FolderGitStatus | null>(null)
const gitLoading = ref(false)
let seq = 0

// --- Hot cue (T79 S3): the "where we left off" top of `hot.md`, loaded on open ---
// Cheap + cached (the memory store dedups + TTLs the confined read), and OFF the
// sidebar hot path — same discipline as the git status probe above. Degrades to
// nothing when the repo has no memory yet or the read is denied.
const hotPreview = ref<string>('')
let hotSeq = 0

watch(
  () => ui.preview.folderPath,
  (path) => {
    // Hot cue first — independent of the git probe, seeded from the sync cache
    // so a warm hover paints instantly, then refreshed from the (async) read.
    hotPreview.value = path ? (memory.peek(path)?.hotPreview ?? '') : ''
    if (path) {
      const mineHot = ++hotSeq
      memory
        .load(path)
        .then((data) => {
          if (mineHot === hotSeq) hotPreview.value = data?.hotPreview ?? ''
        })
        .catch(() => {
          /* degrade — no memory cue */
        })
    }

    gitStatus.value = null
    if (!path || typeof window.api?.foldersGitStatus !== 'function') return
    const mine = ++seq
    gitLoading.value = true
    window.api
      .foldersGitStatus(path)
      .then((s) => {
        if (mine === seq) gitStatus.value = s
      })
      .catch(() => {
        /* degrade — omit the expensive fields */
      })
      .finally(() => {
        if (mine === seq) gitLoading.value = false
      })
  }
)

const anchorStyle = computed<Record<string, string>>(() => {
  const rect = ui.preview.rect
  if (!rect) return { display: 'none' }
  const vw = window.innerWidth
  const vh = window.innerHeight
  // Horizontal: default to the right side of the row, flip left if clipped —
  // then ALWAYS clamp into the viewport. Flipping alone assumes the other
  // side has room, which isn't true in a narrow window; without a final
  // clamp the card can render mostly off-screen with no visible padding.
  const overflowsRight = rect.right + GAP_PX + PREVIEW_MAX_WIDTH > vw - VIEWPORT_MARGIN
  const preferredLeft = overflowsRight
    ? rect.left - GAP_PX - PREVIEW_MAX_WIDTH
    : rect.right + GAP_PX
  const maxLeft = Math.max(VIEWPORT_MARGIN, vw - VIEWPORT_MARGIN - PREVIEW_MAX_WIDTH)
  const horizontal: Record<string, string> = {
    left: `${Math.min(Math.max(preferredLeft, VIEWPORT_MARGIN), maxLeft)}px`
  }
  // The hot cue block adds height; assume taller so the viewport-bottom clamp
  // keeps the whole card on-screen when the cue is present.
  const ASSUMED_PREVIEW_HEIGHT = hotPreview.value ? 280 : 150
  let top = rect.top
  if (top + ASSUMED_PREVIEW_HEIGHT > vh - VIEWPORT_MARGIN) {
    top = Math.max(VIEWPORT_MARGIN, vh - VIEWPORT_MARGIN - ASSUMED_PREVIEW_HEIGHT)
  }
  // Bound the card to the viewport from its anchored top so a long hot cue scrolls
  // INSIDE the card (T86) instead of spilling off-screen.
  const maxHeight = `${Math.max(120, vh - top - VIEWPORT_MARGIN)}px`
  return { ...horizontal, top: `${top}px`, maxHeight } as Record<string, string>
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="ui.preview.open && folder"
      class="anim-fade-in scrollable fixed border border-border-2 bg-surface"
      :style="{
        ...anchorStyle,
        maxWidth: `${PREVIEW_MAX_WIDTH}px`,
        padding: '12px 14px',
        borderRadius: '7px',
        boxShadow: 'var(--shadow-pop)',
        zIndex: 40,
        pointerEvents: 'auto',
        overflowY: 'auto',
        overscrollBehavior: 'contain'
      }"
      role="tooltip"
      :aria-label="$t('preview.folder.label')"
      @mouseenter="cancelClose"
      @mouseleave="scheduleClose"
    >
      <!-- Header: alias + last activity -->
      <div class="flex items-center justify-between" style="gap: 8px; margin-bottom: 6px">
        <span class="truncate text-text" style="font-size: 12.5px; font-weight: 600">{{
          label
        }}</span>
        <span class="tabular-nums shrink-0 text-text-4" style="font-size: 11px">
          {{
            Number.isFinite(activityMs)
              ? $t('preview.folder.activity', {
                  time: relativeTime(new Date(activityMs).toISOString())
                })
              : $t('preview.folder.noActivity')
          }}
        </span>
      </div>

      <!-- Path -->
      <div class="truncate font-mono text-text-4" style="font-size: 11px; margin-bottom: 8px">
        {{ folder.path }}
      </div>

      <!-- Branch + worktree kind -->
      <div
        v-if="isGitFolder"
        class="flex items-center text-text-3"
        style="font-size: 11.5px; gap: 6px; margin-bottom: 6px"
      >
        <GitBranch :size="12" :stroke-width="1.6" class="shrink-0 text-text-4" />
        <span class="truncate font-mono">{{
          folder.gitBranch || $t('preview.folder.detached')
        }}</span>
        <span
          class="shrink-0 border border-border text-text-4"
          style="border-radius: 4px; padding: 1px 6px; font-size: 10px"
        >
          {{ isMainWorktree ? $t('preview.folder.mainWorktree') : $t('preview.folder.worktree') }}
        </span>
      </div>

      <!-- Expensive git status: dirty + ahead/behind (T52 Slice 3) -->
      <div
        v-if="isGitFolder"
        class="flex items-center"
        style="font-size: 11px; gap: 10px; margin-bottom: 6px; min-height: 15px"
      >
        <template v-if="gitStatus">
          <span
            v-if="gitStatus.dirtyCount != null"
            :class="gitStatus.dirtyCount > 0 ? 'text-warning' : 'text-text-4'"
          >
            {{
              gitStatus.dirtyCount > 0
                ? $t('preview.folder.changes', { count: gitStatus.dirtyCount })
                : $t('preview.folder.clean')
            }}
          </span>
          <span
            v-if="gitStatus.ahead != null && gitStatus.ahead > 0"
            class="tabular-nums text-text-3"
            :aria-label="$t('preview.folder.ahead', { n: gitStatus.ahead })"
            >↑{{ gitStatus.ahead }}</span
          >
          <span
            v-if="gitStatus.behind != null && gitStatus.behind > 0"
            class="tabular-nums text-text-3"
            :aria-label="$t('preview.folder.behind', { n: gitStatus.behind })"
            >↓{{ gitStatus.behind }}</span
          >
        </template>
        <span v-else-if="gitLoading" class="text-text-4">…</span>
      </div>

      <!-- Session count -->
      <div class="font-mono text-text-4 tabular-nums" style="font-size: 11px">
        {{ $t('preview.folder.sessions', { count: folder.sessions.length }) }}
      </div>

      <!-- Hot cue (T79 S3): the top of `hot.md` — "where we left off" in 1s, no click.
           Only shown when the repo has memory with real content. -->
      <div
        v-if="hotPreview"
        class="border-t border-border"
        style="margin-top: 8px; padding-top: 8px"
      >
        <div
          class="text-text-4"
          style="
            font-size: 10px;
            letter-spacing: 0.04em;
            text-transform: uppercase;
            margin-bottom: 4px;
          "
        >
          {{ $t('preview.folder.memoryLabel') }}
        </div>
        <!-- T86: the hot cue renders in full; the card itself scrolls (no inner
             clamp/mask) so the whole "where we left off" is reachable with the wheel. -->
        <MarkdownRenderer :source="hotPreview" />
      </div>
    </div>
  </Teleport>
</template>
