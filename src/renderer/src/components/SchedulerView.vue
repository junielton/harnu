<script setup lang="ts">
/**
 * Scheduler takeover (T295 — T291 U5) — the global, footer-pill-launched
 * main-pane view over the recurring-worker engine (T294/U4). Anatomy per
 * `docs/specs/2026-09-07-scheduler-takeover/spec.html`, root `scheduler-takeover`
 * / `scheduler-empty`.
 *
 * Rendered through `TakeoverShell` like every other takeover (BUG-120): the
 * shell owns the root's height, the 40px header, the title and the close
 * button, so this file owns neither. This view's own header content (the
 * `Clock` icon, the live worker counter, the New worker button) reaches the
 * shell's header through the two `<Teleport>` landing zones at the bottom of
 * the template, the way `SystemMonitor.vue` does.
 *
 * The root is a plain `flex-1 min-h-0` flex child. `h-full` here asked for
 * 100% of the SHELL from BELOW the shell's 40px header — a declaration that is
 * wrong about its own box — but it never overflowed anything, and that was
 * measured, not reasoned: this view is the shell's ONLY flex child, so the
 * default `flex-shrink: 1` absorbs the 40px surplus exactly and a `h-full`
 * root still lands at `shell − 40px`. Rebuilt with `h-full` restored, and
 * again with the whole pre-BUG-120 component, the takeover's bottom edge sits
 * exactly on the footer's top edge. It is removed because the declaration is
 * a latent trap (one sibling at this level, or a `flex-none`, turns it into a
 * real 40px spill) and because every other takeover is sized this way — not
 * because it caused the reported bug. What the operator actually reported was
 * the DOUBLED BAR at the bottom: this view's own `footerNote` strip carried
 * the status footer's exact treatment and sat flush on it (see the caption's
 * own comment in the template below), plus the doubled header this migration
 * removes.
 *
 * Two pieces of state live here rather than in the store because they are
 * pure UI approximation, not persisted engine state:
 *
 * - `runningSinceById` — `SchedulerState` exposes only `runningIds` (T294),
 *   never a per-tick start timestamp. The moment a worker id first appears in
 *   that array is recorded as its approximate start; at most one 30s beat off,
 *   which never shows on screen. See `SchedulerWorkerRow.vue`'s prop doc.
 * - `nextAtFor` — `nextRunAt`'s formula (`lastRunAt + everyMinutes*60_000`) is
 *   duplicated here rather than imported: `scheduler-core.ts` is main-only per
 *   the process-boundary rule, and the renderer only ever sees `Worker` /
 *   `Run` as wire types via the preload re-export.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useNow } from '@vueuse/core'
import { Clock, Plus } from 'lucide-vue-next'
import { useSchedulerStore } from '../stores/scheduler'
import { useSessionsStore } from '../stores/sessions'
import SchedulerFolderGroup from './SchedulerFolderGroup.vue'
import SchedulerListFilters from './SchedulerListFilters.vue'
import SchedulerUpNext from './SchedulerUpNext.vue'
import SchedulerWorkerRow from './SchedulerWorkerRow.vue'
import { workerState } from './scheduler-format'
import {
  buildFolderGroups,
  chipCounts,
  cycleFraction,
  defaultSelectionId,
  filterEntries,
  nextDueAt,
  runTicks,
  stateFilterFor,
  upNext,
  type ListEntry,
  type StateFilter
} from './scheduler-list'
import SchedulerWorkerDetail from './SchedulerWorkerDetail.vue'
import Button from './ui/Button.vue'
import type { Worker } from '../../../preload'

const scheduler = useSchedulerStore()
const sessions = useSessionsStore()
const { t } = useI18n()

const now = useNow({ interval: 1000 })
const nowMs = computed(() => now.value.getTime())

// ── boot + a 30s history refresh (matches the ticker's own cadence). The store
// keeps EVERY worker's last runs warm (T590: ticks + cycle bar on every row);
// this sweep is the safety net under its event-driven refreshes. ────────────
let refreshTimer: ReturnType<typeof setInterval> | null = null

onMounted(async () => {
  await scheduler.init()
  refreshTimer = setInterval(() => {
    void scheduler.loadAllRuns()
  }, 30_000)
})
onBeforeUnmount(() => {
  if (refreshTimer) clearInterval(refreshTimer)
})

// ── running-since approximation (shared by rows + the detail pane) ─────────
const runningSinceById = ref<Record<string, number>>({})
watch(
  () => scheduler.runningIds,
  (curr, prev) => {
    const prevSet = new Set(prev ?? [])
    const next = { ...runningSinceById.value }
    for (const id of curr) {
      if (!prevSet.has(id)) next[id] = Date.now()
    }
    for (const id of Object.keys(next)) {
      if (!curr.includes(id)) delete next[id]
    }
    runningSinceById.value = next
  }
)

// ── entries → folder groups (T590) ────────────────────────────────────────
// Every worker with what the list needs to place and draw it. Group order and
// header stats come from ALL workers; the search and the chips only narrow which
// rows are shown, so a folder's hue, health and position don't jump while filtering.
function folderNameFor(path: string): string {
  const folder = sessions.folders.find((f) => f.path === path)
  return folder?.alias || path.split('/').filter(Boolean).pop() || path || '—'
}
function folderBranchFor(path: string): string | null {
  return sessions.folders.find((f) => f.path === path)?.gitBranch ?? null
}

const entries = computed<ListEntry[]>(() =>
  scheduler.workers.map((worker) => {
    const runs = scheduler.runsByWorker[worker.id] ?? []
    const running = scheduler.runningIds.includes(worker.id)
    const nextAt = nextDueAt(worker, runs)
    return {
      worker,
      runs,
      running,
      nextAt,
      state: workerState(worker, { running, nextAt, lastStatus: runs[runs.length - 1]?.status })
    }
  })
)

const groups = computed(() =>
  buildFolderGroups(entries.value, (path) => ({
    name: folderNameFor(path),
    branch: folderBranchFor(path)
  }))
)

// ── search + state chips (T590) ───────────────────────────────────────────
const query = ref('')
const stateFilter = ref<StateFilter>('all')

const searched = computed(() =>
  filterEntries(entries.value, { query: query.value, filter: 'all', folderName: folderNameFor })
)
const counts = computed(() => chipCounts(searched.value))
const visibleIds = computed(
  () =>
    new Set(
      searched.value
        .filter((e) => stateFilter.value === 'all' || stateFilterFor(e.state) === stateFilter.value)
        .map((e) => e.worker.id)
    )
)
const shownGroups = computed(() =>
  groups.value
    .map((group) => ({
      group,
      rows: group.entries.filter((e) => visibleIds.value.has(e.worker.id))
    }))
    .filter((g) => g.rows.length > 0)
)
const isFiltering = computed(() => query.value.trim() !== '' || stateFilter.value !== 'all')
function clearFilter(): void {
  query.value = ''
  stateFilter.value = 'all'
}

// ── selection: keep it valid, default to the first VISIBLE row (the first row
// of the first folder) ─────────────────────────────────────────────────────
watch(
  () => scheduler.workers,
  (workers) => {
    if (scheduler.selectedId && workers.some((w) => w.id === scheduler.selectedId)) return
    scheduler.selectedId = defaultSelectionId(groups.value)
  },
  { immediate: true }
)

const selectedWorker = computed<Worker | undefined>(() =>
  scheduler.workers.find((w) => w.id === scheduler.selectedId)
)

// ── collapse state (T590) — per-viewer conveniences, never load-bearing: every
// storage access is guarded and the view renders correctly without it. Collapsing
// never touches `selectedId`. ──────────────────────────────────────────────
const FOLDERS_COLLAPSED_KEY = 'om2tab.scheduler.collapsedFolders'
const UPNEXT_COLLAPSED_KEY = 'om2tab.scheduler.upNextCollapsed'

function readCollapsedFolders(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(FOLDERS_COLLAPSED_KEY) ?? '[]')
    return Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string') : []
  } catch {
    return []
  }
}
function readUpNextCollapsed(): boolean {
  try {
    return localStorage.getItem(UPNEXT_COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}
function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* storage unavailable — the in-memory state still works for this viewer */
  }
}

const collapsedFolders = ref<string[]>(readCollapsedFolders())
function isCollapsed(path: string): boolean {
  return collapsedFolders.value.includes(path)
}
function setCollapsedFolders(next: string[]): void {
  collapsedFolders.value = next
  writeStorage(FOLDERS_COLLAPSED_KEY, JSON.stringify(next))
}
function toggleFolder(path: string): void {
  setCollapsedFolders(
    isCollapsed(path)
      ? collapsedFolders.value.filter((p) => p !== path)
      : [...collapsedFolders.value, path]
  )
}
const allCollapsed = computed(
  () => shownGroups.value.length > 0 && shownGroups.value.every((g) => isCollapsed(g.group.path))
)
function toggleAllFolders(): void {
  if (allCollapsed.value) {
    const shown = new Set(shownGroups.value.map((g) => g.group.path))
    setCollapsedFolders(collapsedFolders.value.filter((p) => !shown.has(p)))
  } else {
    setCollapsedFolders([
      ...new Set([...collapsedFolders.value, ...shownGroups.value.map((g) => g.group.path)])
    ])
  }
}

const upNextCollapsed = ref(readUpNextCollapsed())
function toggleUpNext(): void {
  upNextCollapsed.value = !upNextCollapsed.value
  writeStorage(UPNEXT_COLLAPSED_KEY, upNextCollapsed.value ? '1' : '0')
}
// Up next answers "what is next", not "what matches": it steps aside while filtering.
const upNextItems = computed(() => (isFiltering.value ? [] : upNext(entries.value, nowMs.value)))

function lastStartedAt(e: ListEntry): number | undefined {
  return e.runs[e.runs.length - 1]?.startedAt
}
function cycleFor(e: ListEntry): number | null {
  return cycleFraction({
    enabled: e.worker.enabled,
    running: e.running,
    lastStartedAt: lastStartedAt(e),
    everyMinutes: e.worker.everyMinutes,
    nowMs: nowMs.value
  })
}

// ── actions ──────────────────────────────────────────────────────────────
function selectWorker(id: string): void {
  scheduler.selectedId = id
}
function togglePin(w: Worker): void {
  void scheduler.setPinned(w.id, typeof w.pinnedAt !== 'number')
}
function runNow(id: string): void {
  void scheduler.runNow(id)
}
function stopWorker(id: string): void {
  void scheduler.stop(id)
}
// Row delete is one click away behind a hover-revealed icon (right next to
// Run now, in a 46px row) — unlike the Settings tab's inline confirm panel,
// there's no room here for a styled confirm, so this mirrors `SessionMenu.vue`
// `onDelete`'s `window.confirm` for the same class of one-click-destroys-data
// action, reusing the Settings tab's own `scheduler.delete.*` copy.
function deleteWorker(id: string): void {
  const worker = scheduler.workers.find((w) => w.id === id)
  const name = worker?.name || t('scheduler.settings.namePlaceholder')
  const runCount = scheduler.runsByWorker[id]?.length ?? 0
  const message = `${t('scheduler.delete.title', { name })}\n\n${t('scheduler.delete.body', { n: runCount })}`
  if (!window.confirm(message)) return
  void scheduler.remove(id)
}

const detailRef = ref<InstanceType<typeof SchedulerWorkerDetail> | null>(null)

/** "New worker": append with main's defaults, select it, jump to Settings, focus Name (Task 11). */
async function createWorker(): Promise<void> {
  const folder = sessions.selectedSession?.projectPath ?? sessions.folders[0]?.path ?? ''
  await scheduler.create({ folder })
  await nextTick()
  detailRef.value?.openSettingsAndFocusName()
}
</script>

<template>
  <!-- BUG-120: `flex-1 min-h-0`, never `h-full` — this is a flex child of
       `TakeoverShell`'s column, sitting BELOW its 40px header, so `h-full`
       asks for a whole shell's height from one header lower down. Measured
       rather than assumed: it does not currently overflow (this view is the
       shell's only flex child, so `flex-shrink` absorbs the 40px exactly), but
       it is a latent trap — a sibling here, or `flex-none`, makes it a real
       spill over the status footer. `min-h-0` is what lets the list/detail
       split below actually shrink and scroll. -->
  <div
    class="flex min-h-0 flex-1 flex-col bg-bg"
    :data-dsqa="scheduler.workers.length === 0 ? 'scheduler-empty' : 'scheduler-takeover'"
  >
    <div
      v-if="scheduler.workers.length === 0"
      class="flex flex-1 flex-col items-center justify-center gap-2.5 px-10 text-center"
    >
      <Clock :size="26" :stroke-width="1.4" class="text-text-4" />
      <div class="text-[13px] font-medium text-text">{{ t('scheduler.emptyTitle') }}</div>
      <p class="max-w-[380px] text-[12px] leading-[1.6] text-text-3">
        {{ t('scheduler.emptyBody') }}
      </p>
      <Button variant="primary" class="mt-1" @click="createWorker">
        <Plus :size="12" :stroke-width="1.8" />
        {{ t('scheduler.newWorker') }}
      </Button>
    </div>

    <template v-else>
      <div class="flex min-h-0 flex-1">
        <div
          class="flex w-[340px] flex-none flex-col overflow-hidden border-r border-border bg-sidebar"
          data-worker-list
        >
          <SchedulerListFilters
            v-model:query="query"
            v-model:filter="stateFilter"
            :counts="counts"
            :all-collapsed="allCollapsed"
            @toggle-all="toggleAllFolders"
          />
          <SchedulerUpNext
            :items="upNextItems"
            :collapsed="upNextCollapsed"
            :folder-name="folderNameFor"
            @toggle="toggleUpNext"
          />

          <div
            class="scrollable min-h-0 flex-1 overflow-y-auto"
            role="listbox"
            :aria-label="t('scheduler.title')"
          >
            <SchedulerFolderGroup
              v-for="{ group, rows } in shownGroups"
              :key="group.path"
              :group="group"
              :collapsed="isCollapsed(group.path)"
              :now-ms="nowMs"
              @toggle="toggleFolder(group.path)"
            >
              <SchedulerWorkerRow
                v-for="e in rows"
                :key="e.worker.id"
                :worker="e.worker"
                :selected="e.worker.id === scheduler.selectedId"
                :running="e.running"
                :last-status="e.runs[e.runs.length - 1]?.status"
                :next-at="e.nextAt"
                :running-since-ms="runningSinceById[e.worker.id]"
                :now-ms="nowMs"
                :ticks="runTicks(e.runs, e.running)"
                :cycle="cycleFor(e)"
                @select="selectWorker(e.worker.id)"
                @pin="togglePin(e.worker)"
                @run-now="runNow(e.worker.id)"
                @stop="stopWorker(e.worker.id)"
                @delete="deleteWorker(e.worker.id)"
              />
            </SchedulerFolderGroup>

            <div
              v-if="shownGroups.length === 0"
              class="px-5 py-10 text-center text-[12px] text-text-3"
              data-list-empty
            >
              <b class="mb-1 block font-medium text-text-2">{{
                query.trim()
                  ? t('scheduler.list.emptyTitle', { q: query.trim() })
                  : t('scheduler.list.emptyTitleFilter')
              }}</b>
              {{ t('scheduler.list.emptyBody') }}
              <div>
                <button
                  type="button"
                  class="mt-2.5 h-[22px] rounded-sm border border-border-2 bg-transparent px-2 text-[11px] text-text-2 transition-colors hover:bg-surface hover:text-text"
                  data-clear-filter
                  @click="clearFilter"
                >
                  {{ t('scheduler.list.clearFilter') }}
                </button>
              </div>
            </div>
          </div>
        </div>

        <SchedulerWorkerDetail
          v-if="selectedWorker"
          ref="detailRef"
          :worker="selectedWorker"
          :running="scheduler.runningIds.includes(selectedWorker.id)"
          :running-since-ms="runningSinceById[selectedWorker.id]"
          :now-ms="nowMs"
        />
      </div>

      <!-- BUG-120: a caption on the view's own ground, NOT a bar. With
           `border-t border-border bg-surface` this carried the app status
           footer's exact treatment — same background token, same top border,
           same 11px type — and sat flush on it: 54px of chrome reading as one
           doubled bar, the mirror of the doubled header above. The footer keeps
           its border as the single real boundary at the bottom of the window. -->
      <div class="flex h-[30px] flex-none items-center gap-1.5 px-3 text-[11px] text-text-4">
        <Clock :size="11" :stroke-width="1.6" class="shrink-0" />
        {{ t('scheduler.footerNote') }}
      </div>
    </template>
  </div>

  <!-- BUG-120: this view's header content, rendered into the shared
       `TakeoverShell` header (design.md §6 "TakeoverShell — shared chrome") via
       `Teleport` — a dynamically swapped view can't fill a named slot of the
       ancestor wrapping it. `defer` is required, not decorative: opening the
       Scheduler as the FIRST takeover of a session mounts the shell's landing
       zones and this source in the same synchronous pass, and without it Vue
       resolves the target before the header span is in the document — a silent
       no-icon, no error. Placed AFTER the body so the first root node stays a
       real element (Vue Test Utils resolves `wrapper.element` off the first
       root, and a Teleport placeholder there breaks every `find`/`get`). -->
  <Teleport to="#takeover-shell-icon" defer>
    <Clock :size="15" :stroke-width="1.7" class="shrink-0 text-accent" />
  </Teleport>
  <Teleport to="#takeover-shell-actions" defer>
    <span v-if="scheduler.workers.length > 0" class="text-[11px] text-text-3">
      {{
        t('scheduler.subtitle', {
          workers: scheduler.workers.length,
          running: scheduler.runningIds.length
        })
      }}
    </span>
    <span class="flex-1" />
    <Button
      v-if="scheduler.workers.length > 0"
      variant="primary"
      class="shrink-0"
      @click="createWorker"
    >
      <Plus :size="12" :stroke-width="1.8" />
      {{ t('scheduler.newWorker') }}
    </Button>
  </Teleport>
</template>
