<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  GitBranch,
  Plus,
  KanbanSquare,
  GitPullRequest,
  FolderOpen,
  FolderTree,
  Code,
  Terminal
} from 'lucide-vue-next'
import type { PrEntry } from '../../../main/pr-stack-core'
import type { FolderGitStatus, RoadmapPeekCard, RoadmapPeekResult } from '../../../preload'
import type { Folder, Session } from '../stores/sessions'
import { useSessionsStore } from '../stores/sessions'
import { useUiStore } from '../stores/ui'
import { useHelpersStore } from '../stores/helpers'
import { useMemoryStore } from '../stores/memory'
import { displayAlias } from './folder-alias'
import MarkdownRenderer from './MarkdownRenderer.vue'
import ScopeTag from './ui/ScopeTag.vue'
import FolderViewSessions from './FolderViewSessions.vue'
import FolderViewRoadmap from './FolderViewRoadmap.vue'
import FolderViewWorktrees from './FolderViewWorktrees.vue'
import FolderViewFanout from './FolderViewFanout.vue'
import FolderViewOwnedCard from './FolderViewOwnedCard.vue'
import { dotFor } from './session-dot'
import {
  ACTIVITY_VIEWBOX,
  activityBars,
  activityBucket,
  bucketSessions,
  fanoutRows,
  fanoutTally,
  isGitFolder as isGitFolderOf,
  resolveProfile,
  scopeOf,
  sessionsPerDay,
  type FanoutFolder
} from './folder-view-format'

/**
 * T212 — the main-pane view a folder click opens. Selection-driven (like
 * `TerminalPane`), NOT one of the five takeovers: a takeover opened from here
 * still wins the pane, and closing it returns to this view because the folder
 * selection was never lost.
 *
 * Both expensive reads (`foldersGitStatus`, `roadmapPeek`) fire on open behind a
 * sequence guard — the same discipline as `FolderPreview` — so a fast folder
 * switch can never paint the previous folder's data. Both degrade to nothing.
 *
 * T285 — scope-aware. Two profiles of one view (`main` = the repo's
 * orchestration home, `worktree` = one feature's cockpit), chosen by
 * `resolveProfile`, and every block carrying the scope it really has. Half of
 * what this view shows is repo-wide (`hot.md`, the roadmap counts, the sibling
 * list all collapse onto the repo's main checkout), and printed untagged it read
 * as a description of the folder you clicked. See design.md §6 "Folder View".
 *
 * T286 fills the main profile: the KPI strip, the `Worktrees in flight` fan-out
 * that leads the stack, and the 14-day activity strip in the rail. The three
 * extra reads the fan-out needs (per-sibling git, per-branch card ownership, one
 * PR snapshot for the repo) run behind their own sequence guard, in the main
 * profile only, and every one of them degrades to an empty cell.
 */

const sessions = useSessionsStore()
const ui = useUiStore()
const helpers = useHelpersStore()
const memory = useMemoryStore()

const folder = computed(() => {
  const path = sessions.selectedFolderPath
  return path ? (sessions.findFolderByPath(path) ?? null) : null
})

const label = computed(() => {
  const f = folder.value
  return f ? displayAlias(f, sessions.aliasFromBranchPaths.has(f.path)) : ''
})

const isGitFolder = computed(() => isGitFolderOf(folder.value))

/** `main` (orchestration home) or `worktree` (one feature's cockpit). */
const profile = computed(() => resolveProfile(folder.value))

// --- Expensive fields, loaded on open ---------------------------------------
const gitStatus = ref<FolderGitStatus | null>(null)
const peek = ref<RoadmapPeekResult | null>(null)
const hotPreview = ref<string>('')
let seq = 0

watch(
  () => sessions.selectedFolderPath,
  (path) => {
    const mine = ++seq
    gitStatus.value = null
    peek.value = null
    // Seed the memory cue from the sync cache so a warm folder paints instantly,
    // then refresh from the (async) confined read.
    hotPreview.value = path ? (memory.peek(path)?.hotPreview ?? '') : ''
    if (!path) return

    memory
      .load(path)
      .then((data) => {
        if (mine === seq) hotPreview.value = data?.hotPreview ?? ''
      })
      .catch(() => {
        /* degrade — no memory cue */
      })

    if (typeof window.api?.foldersGitStatus === 'function') {
      window.api
        .foldersGitStatus(path)
        .then((s) => {
          if (mine === seq) gitStatus.value = s
        })
        .catch(() => {
          /* degrade — omit the git fields */
        })
    }

    if (typeof window.api?.roadmapPeek === 'function') {
      window.api
        .roadmapPeek(path)
        .then((p) => {
          if (mine === seq) peek.value = p
        })
        .catch(() => {
          /* degrade — omit the roadmap section */
        })
    }
  },
  { immediate: true }
)

// --- T286: the fan-out (main profile only) -----------------------------------

/**
 * Every worktree of this repo, this one included. A folder with no `repoId` (a
 * plain pinned directory, or an unprobed one) is a repo of one — which is what
 * makes the fan-out absent rather than empty for it (AC-10).
 */
const siblings = computed<Folder[]>(() => {
  const f = folder.value
  if (!f) return []
  if (!f.repoId) return [f]
  return sessions.folders.filter((s) => s.repoId === f.repoId)
})

/** AC-10 — a lone checkout fans out to nothing, so the section is not rendered. */
const hasFanout = computed(() => profile.value === 'main' && siblings.value.length > 1)

/**
 * The same status recipe `FolderViewSessions` paints a row with — archive
 * overrides, then the canonical `dotFor`, then `activityBucket`'s three-way
 * fold. Copied deliberately rather than shared through a store getter: the
 * projection needs `nowTick`, and the two surfaces must never disagree about
 * whether a session is live (BUG-13's split, on a third surface).
 */
function bucketOf(s: Session): ReturnType<typeof activityBucket> {
  const dot = sessions.isArchived(s.sessionId)
    ? 'archived'
    : dotFor(s.taskState, s.status, sessions.activityOf(s, sessions.nowTick), s.transcriptState)
  return activityBucket(dot)
}

/** AC-3 — sessions and liveness straight off the store's folder model, no IPC. */
const fanoutFolders = computed<FanoutFolder[]>(() =>
  siblings.value.map((f) => {
    let live = 0
    let needsInput = 0
    for (const s of f.sessions) {
      const bucket = bucketOf(s)
      if (bucket === 'idle') continue
      live++
      if (bucket === 'needs-input') needsInput++
    }
    return {
      path: f.path,
      branch: f.gitBranch ?? '',
      label: displayAlias(f, sessions.aliasFromBranchPaths.has(f.path)),
      isSelf: f.path === folder.value?.path,
      sessionCount: f.sessions.length,
      liveCount: live,
      needsInputCount: needsInput
    }
  })
)

const gitByPath = ref(new Map<string, FolderGitStatus | null>())
const cardByPath = ref(new Map<string, RoadmapPeekCard | null>())
/** `null` until PR state has been read at all, and again whenever it cannot be. */
const prByBranch = ref<Map<string, PrEntry> | null>(null)

/**
 * Re-run the fan-out reads when the folder changes **or** when the sibling set
 * does — a worktree cut from a running session appears through the watcher, with
 * no folder selection in between, and a fan-out that missed it would be quietly
 * out of date.
 *
 * Its own sequence guard, same discipline as the view's other reads: the key
 * carries the branch as well as the path, so a rebased worktree re-reads too.
 *
 * Gated on the KPI strip's own condition, NOT on {@link hasFanout}: a lone main
 * checkout draws no fan-out but still draws the needs-you tile, and skipping the
 * reads there would leave `prByBranch` at `null` — which the tile is obliged to
 * report as "PR state unavailable" (AC-8). Declaring a signal missing because we
 * chose not to ask for it is the same under-reporting AC-8 exists to prevent,
 * pointed the other way. One checkout is one cheap read.
 */
const fanoutKey = computed(() =>
  profile.value === 'main' && isGitFolder.value
    ? siblings.value.map((f) => `${f.path}@${f.gitBranch ?? ''}`).join('\n')
    : ''
)

let fanSeq = 0

/**
 * Run `task` over `items` a few at a time. `roadmap:peek` re-scans the board
 * directory per call, so a 47-worktree repo would otherwise fire 47 concurrent
 * full scans at the main process the moment a folder is clicked.
 */
async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await task(items[i])
  })
  await Promise.all(workers)
  return out
}

watch(
  fanoutKey,
  (key) => {
    const mine = ++fanSeq
    gitByPath.value = new Map()
    cardByPath.value = new Map()
    prByBranch.value = null
    if (!key) return
    const rowsNow = siblings.value.slice()
    const repoPath = folder.value?.path
    if (!repoPath) return

    // AC-4 — one `folders:gitStatus` per sibling. A probe that throws leaves its
    // entry out of the map, and the row's git cell simply stays empty.
    if (typeof window.api?.foldersGitStatus === 'function') {
      void mapLimited(rowsNow, 4, async (f) => {
        try {
          const status = await window.api.foldersGitStatus(f.path)
          if (mine === fanSeq) gitByPath.value = new Map(gitByPath.value).set(f.path, status)
        } catch {
          /* degrade — no git cell for this row */
        }
      })
    }

    // AC-2 — D1's branch ownership, one peek per branch. Asked against THIS
    // folder rather than the sibling's own path: `resolveRoadmap` collapses
    // every worktree onto the repo's main checkout anyway, and a sibling whose
    // directory has since been removed still deserves an answer.
    if (typeof window.api?.roadmapPeek === 'function') {
      const withBranch = rowsNow.filter((f) => !!f.gitBranch)
      void mapLimited(withBranch, 4, async (f) => {
        try {
          const result = await window.api.roadmapPeek(repoPath, f.gitBranch)
          if (mine === fanSeq)
            cardByPath.value = new Map(cardByPath.value).set(f.path, result.owned ?? null)
        } catch {
          /* degrade — an em-dash in the card cell */
        }
      })
    }

    // AC-5/AC-6 — ONE existing `pr-stack:load` for the whole repo, never a new
    // main-process call. `ghAvailable: false` (no `gh`, unauthenticated, rate
    // limited, not a GitHub remote) is a legitimate answer, not an error: the
    // map stays `null`, every PR cell stays empty, and the KPI tile says the
    // signal is missing instead of counting it as zero.
    if (typeof window.api?.prStackLoad === 'function') {
      window.api
        .prStackLoad(repoPath)
        .then((snapshot) => {
          if (mine !== fanSeq) return
          if (!snapshot?.ghAvailable) return
          const byBranch = new Map<string, PrEntry>()
          for (const node of snapshot.graph?.nodes ?? []) byBranch.set(node.pr.branch, node.pr)
          prByBranch.value = byBranch
        })
        .catch(() => {
          /* degrade — no PR column, and the needs-you tile says so */
        })
    }
  },
  { immediate: true }
)

const rows = computed(() =>
  fanoutRows(fanoutFolders.value, gitByPath.value, cardByPath.value, prByBranch.value)
)

/** AC-8 — `prByBranch === null` is "could not read", never "no PRs". */
const tally = computed(() => fanoutTally(rows.value, prByBranch.value !== null))

// --- T286: KPI strip + activity strip ----------------------------------------

/** Sessions of THIS checkout, split the way the sessions block itself splits. */
const hereBuckets = computed(() =>
  bucketSessions(folder.value?.sessions ?? [], (id) => sessions.isArchived(id))
)

const roadmapTotal = computed(() =>
  peek.value ? Object.values(peek.value.counts).reduce((a, b) => a + b, 0) : 0
)

/**
 * The pipeline bar's four segments. `flex` is the count itself, with a `min-width`
 * in the stylesheet so a column with one card still shows up — one hue, backlog
 * to review as light to dark, per the approved spec's `.seg`.
 */
const pipeline = computed(() => {
  const counts = peek.value?.counts
  if (!counts) return []
  return (['backlog', 'ready', 'in-progress', 'review'] as const).map((column, i) => ({
    column,
    step: i + 1,
    count: counts[column]
  }))
})

/** AC-9 — repo-scoped: every sibling's sessions, not just this folder's. */
const activityDays = computed(() =>
  sessionsPerDay(
    siblings.value.flatMap((f) => f.sessions),
    sessions.nowTick
  )
)

const activityBarsShaped = computed(() => activityBars(activityDays.value))

const activityTotal = computed(() =>
  activityDays.value.reduce((total, day) => total + day.count, 0)
)

const activityToday = computed(() => activityDays.value.at(-1)?.count ?? 0)

/** The strip's left axis label — the oldest day it covers, in the OS locale. */
const activityFrom = computed(() => {
  const first = activityDays.value[0]
  if (!first) return ''
  const parsed = new Date(`${first.day}T00:00:00`)
  return Number.isNaN(parsed.getTime())
    ? first.day
    : parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
})

/** Absent, not empty: a repo with no sessions at all has no fortnight to draw. */
const hasActivity = computed(() => profile.value === 'main' && activityTotal.value > 0)

// --- Action bar --------------------------------------------------------------
function onNewSession(): void {
  if (folder.value) ui.openNewSession(folder.value.path)
}

function onRoadmap(): void {
  if (folder.value) ui.openRoadmap(folder.value.path, label.value)
}

function onPrStack(): void {
  if (folder.value) ui.openPrStack(folder.value.path, label.value)
}

function onBrowseFiles(): void {
  if (folder.value) helpers.addExplorerHelper(folder.value.path, folder.value.path)
}

function onOpenInVSCode(): void {
  if (folder.value) void window.api.openInVSCode(folder.value.path)
}

function onOpenFolder(): void {
  if (folder.value) void window.api.openPath(folder.value.path)
}

function onTerminalHere(): void {
  if (folder.value) sessions.createFolderTerminal(folder.value.path)
}
</script>

<template>
  <div v-if="folder" class="scrollable anim-fade-in flex h-full w-full flex-col overflow-y-auto">
    <div
      class="fv flex w-full flex-col"
      style="padding: 24px; gap: 24px"
      data-test="folder-view"
      :data-profile="profile"
    >
      <!-- Header: identity + git truth. No scope tag — the header IS the
           folder, and tagging it would imply the rest is equally local. -->
      <header class="flex flex-col" style="gap: 6px">
        <div class="flex items-center" style="gap: 10px">
          <h1 class="truncate text-text" style="font-size: 18px; font-weight: 600">{{ label }}</h1>
          <!-- T285 — `min-w-0` + `truncate`, not `shrink-0`. A card branch name
               runs to ~295px, and the pane can be far narrower than the window
               (sidebar + Fleet rail). Left unshrinkable it pushed the header out
               of the view instead of truncating (AC-3). -->
          <span
            v-if="isGitFolder"
            class="flex min-w-0 items-center font-mono text-text-3"
            style="gap: 5px; font-size: 12px"
            :title="folder.gitBranch || undefined"
          >
            <GitBranch :size="12" :stroke-width="1.6" class="shrink-0 text-text-4" />
            <span class="truncate">{{ folder.gitBranch || $t('preview.folder.detached') }}</span>
          </span>
          <span
            v-if="isGitFolder"
            class="shrink-0 border border-border text-text-4"
            style="border-radius: 4px; padding: 1px 6px; font-size: 10px"
          >
            {{
              folder.isMainWorktree
                ? $t('preview.folder.mainWorktree')
                : $t('preview.folder.worktree')
            }}
          </span>
        </div>

        <div class="truncate font-mono text-text-4" style="font-size: 11.5px">
          {{ folder.path }}
        </div>

        <div
          v-if="isGitFolder && gitStatus"
          class="flex items-center"
          style="font-size: 11.5px; gap: 10px"
        >
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
        </div>
      </header>

      <!-- Action bar. Deliberately duplicates the Topbar: this view is the
           folder's home, and a home you must leave to act on is not one.
           Identical in both profiles. -->
      <div class="flex flex-wrap items-center" style="gap: 8px">
        <button
          class="flex cursor-pointer items-center bg-accent text-accent-ink transition hover:opacity-90"
          style="
            gap: 6px;
            border-radius: var(--radius-sm);
            padding: 7px 12px;
            font-size: 12px;
            font-weight: 500;
          "
          data-test="folder-view-new-session"
          @click="onNewSession"
        >
          <Plus :size="13" :stroke-width="1.8" />{{ $t('folderView.newSession') }}
        </button>
        <button
          class="flex cursor-pointer items-center border border-border text-text-2 transition hover:bg-surface hover:text-text"
          style="gap: 6px; border-radius: var(--radius-sm); padding: 7px 12px; font-size: 12px"
          data-test="folder-view-open-roadmap"
          @click="onRoadmap"
        >
          <KanbanSquare :size="13" :stroke-width="1.6" />{{ $t('folderView.openRoadmap') }}
        </button>
        <button
          class="flex cursor-pointer items-center border border-border text-text-2 transition hover:bg-surface hover:text-text"
          style="gap: 6px; border-radius: var(--radius-sm); padding: 7px 12px; font-size: 12px"
          data-test="folder-view-open-pr-stack"
          @click="onPrStack"
        >
          <GitPullRequest :size="13" :stroke-width="1.6" />{{ $t('folderView.openPrStack') }}
        </button>
        <button
          class="flex cursor-pointer items-center border border-border text-text-2 transition hover:bg-surface hover:text-text"
          style="gap: 6px; border-radius: var(--radius-sm); padding: 7px 12px; font-size: 12px"
          data-test="folder-view-browse-files"
          @click="onBrowseFiles"
        >
          <FolderTree :size="13" :stroke-width="1.6" />{{ $t('folderView.browseFiles') }}
        </button>
        <button
          class="flex cursor-pointer items-center border border-border text-text-2 transition hover:bg-surface hover:text-text"
          style="gap: 6px; border-radius: var(--radius-sm); padding: 7px 12px; font-size: 12px"
          data-test="folder-view-vscode"
          @click="onOpenInVSCode"
        >
          <Code :size="13" :stroke-width="1.6" />{{ $t('folderView.openInVSCode') }}
        </button>
        <button
          class="flex cursor-pointer items-center border border-border text-text-2 transition hover:bg-surface hover:text-text"
          style="gap: 6px; border-radius: var(--radius-sm); padding: 7px 12px; font-size: 12px"
          data-test="folder-view-open-folder"
          @click="onOpenFolder"
        >
          <FolderOpen :size="13" :stroke-width="1.6" />{{ $t('folderView.openFolder') }}
        </button>
        <button
          class="flex cursor-pointer items-center border border-border text-text-2 transition hover:bg-surface hover:text-text"
          style="gap: 6px; border-radius: var(--radius-sm); padding: 7px 12px; font-size: 12px"
          data-test="folder-view-terminal"
          @click="onTerminalHere"
        >
          <Terminal :size="13" :stroke-width="1.6" />{{ $t('folderView.terminalHere') }}
        </button>
      </div>

      <!-- Hero — worktree profile only: the card this branch owns (T287). The
           component reads its own ownership answer and renders nothing at all
           when the branch owns no card, so there is no data `v-if` here — only
           the profile gate. -->
      <FolderViewOwnedCard v-if="profile === 'worktree'" :folder="folder" />

      <!-- T286 — the main checkout's KPI strip: what needs you, what is in
           flight, what the board holds, what is running here. Gated on a git
           folder: a plain pinned directory has no fan-out and no board, so
           three of the four tiles would be a frame around nothing. -->
      <div v-if="profile === 'main' && isGitFolder" class="fv-kpis" data-test="folder-view-kpis">
        <div class="fv-tile" data-test="folder-view-kpi-needs-you">
          <div class="v tabular-nums">
            {{ tally.needsYou }} <small>{{ $t('folderView.kpi.needYou') }}</small>
          </div>
          <div class="k">
            {{ $t('folderView.kpi.needYouAcross', { n: tally.worktrees }) }}
          </div>
          <div class="s">
            <span
              v-if="tally.needsYou > 0"
              class="shrink-0 rounded-full bg-warning"
              style="width: 5px; height: 5px"
            />
            <!-- AC-8 — an unreadable signal is named, never counted as zero. -->
            <span class="truncate">{{
              tally.needsYouPrs === null
                ? $t('folderView.kpi.needYouPrsUnavailable', { sessions: tally.needsYouSessions })
                : $t('folderView.kpi.needYouBreakdown', {
                    sessions: tally.needsYouSessions,
                    prs: tally.needsYouPrs
                  })
            }}</span>
          </div>
        </div>

        <div class="fv-tile" data-test="folder-view-kpi-in-flight">
          <div class="v tabular-nums">
            {{ tally.inFlight }} <small>{{ $t('folderView.kpi.inFlight') }}</small>
          </div>
          <div class="k">{{ $t('folderView.kpi.inFlightK') }}</div>
          <div class="s">
            {{ $t('folderView.kpi.inFlightSub', { total: tally.worktrees, idle: tally.idle }) }}
          </div>
        </div>

        <div v-if="peek && roadmapTotal > 0" class="fv-tile" data-test="folder-view-kpi-roadmap">
          <div class="v tabular-nums">
            {{ peek.counts.review }} <small>{{ $t('folderView.kpi.inReview') }}</small>
          </div>
          <div class="k">
            {{
              $t('folderView.kpi.roadmapK', {
                inProgress: peek.counts['in-progress'],
                ready: peek.counts.ready
              })
            }}
          </div>
          <div class="fv-seg">
            <i
              v-for="segment in pipeline"
              :key="segment.column"
              :class="`s${segment.step}`"
              :style="{ flex: segment.count }"
              :title="`${$t(`roadmap.columns.${segment.column}`)} ${segment.count}`"
            />
          </div>
        </div>

        <div class="fv-tile" data-test="folder-view-kpi-sessions">
          <div class="v tabular-nums">
            {{ hereBuckets.current.length }}
            <small>{{ $t('folderView.kpi.sessionsHere') }}</small>
          </div>
          <div class="k">
            {{ $t('folderView.kpi.sessionsHereK', { older: hereBuckets.older.length }) }}
          </div>
          <div class="s">{{ $t('folderView.kpi.sessionsHereSub') }}</div>
        </div>
      </div>

      <div class="fv-grid">
        <div class="fv-stack">
          <!-- Stack lead — main profile only: the fan-out table (T286). -->
          <FolderViewFanout
            v-if="hasFanout"
            :rows="rows"
            :repo-path="folder.path"
            :repo-label="label"
          />

          <FolderViewSessions :folder="folder" />
        </div>

        <aside class="fv-rail">
          <!-- Where we left off — omitted entirely when the repo has no memory.
               Repo-scoped: a worktree shows its main checkout's snapshot. -->
          <section
            v-if="hotPreview"
            class="flex flex-col border border-border bg-surface"
            style="gap: 10px; border-radius: var(--radius); padding: 14px 16px"
            data-test="folder-view-memory"
          >
            <div class="flex items-center justify-between" style="gap: 8px">
              <span class="eyebrow text-text-4">{{ $t('folderView.whereWeLeftOff') }}</span>
              <ScopeTag :scope="scopeOf('memory')" />
            </div>
            <MarkdownRenderer :source="hotPreview" />
          </section>

          <template v-if="profile === 'worktree'">
            <FolderViewWorktrees :folder="folder" :profile="profile" />
            <FolderViewRoadmap :peek="peek" :folder-path="folder.path" :repo-label="label" />
          </template>
          <template v-else>
            <!-- T286 AC-9 — sessions started per day, last 14 days. Main profile
                 only, and repo-scoped: it counts every sibling's sessions, which
                 is exactly why it carries the `repo` tag. -->
            <section
              v-if="hasActivity"
              class="flex flex-col border border-border bg-surface"
              style="gap: 10px; border-radius: var(--radius); padding: 14px 16px"
              data-test="folder-view-activity"
            >
              <div class="flex items-center justify-between" style="gap: 8px">
                <span class="flex min-w-0 items-center" style="gap: 8px">
                  <span class="eyebrow text-text-4">{{ $t('folderView.activity.title') }}</span>
                  <ScopeTag :scope="scopeOf('activity')" />
                </span>
                <span class="tabular-nums shrink-0 text-text-4" style="font-size: 11px">{{
                  $t('folderView.activity.sessions', { n: activityTotal })
                }}</span>
              </div>

              <svg
                class="fv-spark"
                :viewBox="`0 0 ${ACTIVITY_VIEWBOX.width} ${ACTIVITY_VIEWBOX.height}`"
                preserveAspectRatio="none"
                role="img"
                :aria-label="$t('folderView.activity.chartLabel')"
              >
                <line x1="0" y1="43.5" :x2="ACTIVITY_VIEWBOX.width" y2="43.5" />
                <rect
                  v-for="bar in activityBarsShaped"
                  :key="bar.day"
                  :x="bar.x"
                  :y="bar.y"
                  :width="bar.width"
                  :height="bar.height"
                  :class="bar.isZero ? 'zero' : bar.isToday ? 'today' : undefined"
                />
              </svg>

              <div class="flex items-center justify-between text-text-4" style="font-size: 10px">
                <span>{{ activityFrom }}</span>
                <span class="tabular-nums">{{
                  $t('folderView.activity.today', { n: activityToday })
                }}</span>
              </div>
            </section>

            <!-- BUG-118 — the two long lists follow the 44px chart, not the
                 other way round. Rendered last, the activity strip sat under
                 ~230 rows on a 102-worktree repo: the operator scrolled past
                 every branch and every card to reach the one block that reads at
                 a glance. Order in a rail is a claim about how long a block
                 takes to read. -->
            <FolderViewRoadmap :peek="peek" :folder-path="folder.path" :repo-label="label" />
            <FolderViewWorktrees :folder="folder" :profile="profile" />
          </template>
        </aside>
      </div>
    </div>
  </div>
</template>

<style scoped>
/*
 * design.md §6 "Folder View → Container and grid". 1100 and 760 are this view's
 * own breakpoints (they match the approved spec's viewports) and belong here
 * rather than in the global Tailwind screens — no other surface shares them.
 *
 * They are CONTAINER queries, not media queries, and that is not a stylistic
 * preference. The Folder View is a pane, not a page: the sidebar and the Fleet
 * rail can take most of the window, so a 1440px window routinely gives this view
 * 850px and an 820px window gives it 230px. Keyed on the viewport, the rail's
 * 2-up fold fires in a 230px pane and produces two ~110px columns of one-letter
 * lines. Keyed on the pane, it folds when the pane is actually narrow.
 *
 * Every grid child gets `min-width: 0` so a long branch name truncates instead
 * of widening its column.
 */
.fv {
  container-type: inline-size;
  container-name: folder-view;
}

.fv-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  gap: 24px;
  align-items: start;
}

.fv-stack {
  display: flex;
  flex-direction: column;
  gap: 24px;
  min-width: 0;
}

.fv-rail {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}

/*
 * T286 — the main checkout's KPI strip. The tile is the `UsageStatTiles` idiom
 * (design.md §6): a `--surface` card whose value line is 20px/500 with an 11px
 * unit beside it, then a key line and a sub line down the text ramp.
 */
.fv-kpis {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}

.fv-tile {
  border: 1px solid var(--color-border);
  background: var(--color-surface);
  border-radius: var(--radius);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.fv-tile .v {
  font-size: 20px;
  line-height: 28px;
  font-weight: 500;
  letter-spacing: -0.015em;
  color: var(--color-text);
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.fv-tile .v small {
  font-size: 11px;
  font-weight: 400;
  color: var(--color-text-3);
  letter-spacing: 0;
}

.fv-tile .k {
  font-size: 11px;
  color: var(--color-text-3);
}

.fv-tile .s {
  font-size: 11px;
  color: var(--color-text-4);
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

/*
 * Roadmap pipeline. ONE hue at four intensities — backlog to review is
 * light to dark of the accent, never four different colours: these are four
 * stages of one thing, and a categorical palette would say they are four
 * unrelated things. `min-width` keeps a one-card column visible.
 */
.fv-seg {
  display: flex;
  gap: 2px;
  height: 8px;
  border-radius: 999px;
  overflow: hidden;
  margin-top: 4px;
}

.fv-seg > i {
  display: block;
  height: 100%;
  min-width: 6px;
  background: var(--color-accent);
}

.fv-seg .s1 {
  opacity: 0.18;
}

.fv-seg .s2 {
  opacity: 0.4;
}

.fv-seg .s3 {
  opacity: 0.7;
}

.fv-seg .s4 {
  opacity: 1;
}

/*
 * Activity strip. Single series, so one accent at one opacity; today is the
 * only emphasis. A zero day is a `--border-2` tick rather than a gap — a
 * sparkline with holes punched out of it reads as a shorter, busier history.
 */
.fv-spark {
  width: 100%;
  height: 44px;
  display: block;
}

.fv-spark rect {
  fill: var(--color-accent);
  opacity: 0.55;
  rx: 2;
}

.fv-spark rect.today {
  opacity: 1;
}

.fv-spark rect.zero {
  fill: var(--color-border-2);
  opacity: 1;
}

.fv-spark line {
  stroke: var(--color-border);
  stroke-width: 1;
}

@container folder-view (max-width: 1100px) {
  .fv-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  /*
   * `align-items: start` is load-bearing, not tidying. The rail is a flex
   * COLUMN at full width, where every card is its own content's height; turning
   * it into a grid here would default to `stretch` and make each card as tall as
   * the tallest one in its row. On a real repo that is not a rounding error: a
   * roadmap card listing 88 review cards, or a worktree list with 90 rows, drags
   * its row-mate to ~3000px — so the 44px activity chart ends up floating at the
   * top of a bordered box three screens tall. Cards are sized by their content
   * in both layouts, or the fold changes what a card means.
   */
  .fv-rail {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px;
    align-items: start;
  }

  .fv-kpis {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@container folder-view (max-width: 760px) {
  .fv-rail,
  .fv-kpis {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
