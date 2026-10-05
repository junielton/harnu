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
import SchedulerWorkerRow from './SchedulerWorkerRow.vue'
import SchedulerWorkerDetail from './SchedulerWorkerDetail.vue'
import Button from './ui/Button.vue'
import type { Run, Worker } from '../../../preload'

const scheduler = useSchedulerStore()
const sessions = useSessionsStore()
const { t } = useI18n()

const now = useNow({ interval: 1000 })
const nowMs = computed(() => now.value.getTime())

// ── boot + a 30s history refresh (matches the ticker's own cadence) ─────────
let refreshTimer: ReturnType<typeof setInterval> | null = null

async function refreshAllRuns(): Promise<void> {
  await Promise.all(scheduler.workers.map((w) => scheduler.loadRuns(w.id)))
}

onMounted(async () => {
  await scheduler.init()
  await refreshAllRuns()
  refreshTimer = setInterval(() => {
    void refreshAllRuns()
  }, 30_000)
})
onBeforeUnmount(() => {
  if (refreshTimer) clearInterval(refreshTimer)
})

// A worker created between refresh ticks (e.g. "New worker") gets its
// (empty) run history loaded right away rather than waiting up to 30s.
watch(
  () => scheduler.workers.map((w) => w.id),
  (ids, prevIds) => {
    const prevSet = new Set(prevIds ?? [])
    for (const id of ids) {
      if (!prevSet.has(id)) void scheduler.loadRuns(id)
    }
  }
)

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
    // A tick that just finished may have changed this worker's last-run
    // status — refresh its history so the row/detail reflect it right away
    // instead of waiting for the next 30s sweep.
    for (const id of prevSet) {
      if (!curr.includes(id)) void scheduler.loadRuns(id)
    }
  }
)

// ── selection: keep it valid, default to the first worker ──────────────────
watch(
  () => scheduler.workers,
  (workers) => {
    if (scheduler.selectedId && workers.some((w) => w.id === scheduler.selectedId)) return
    scheduler.selectedId = workers[0]?.id ?? null
  },
  { immediate: true }
)

const selectedWorker = computed<Worker | undefined>(() =>
  scheduler.workers.find((w) => w.id === scheduler.selectedId)
)

// ── grouping (Task 9) — "Enabled" then "Off"; a disabled-by-streak worker is
// still `enabled === false`, so it groups under "Off" alongside a worker the
// operator switched off — the row itself is what tells the two apart. ──────
const enabledWorkers = computed(() => scheduler.workers.filter((w) => w.enabled))
const offWorkers = computed(() => scheduler.workers.filter((w) => !w.enabled))

function folderAliasFor(path: string): string {
  return sessions.folders.find((f) => f.path === path)?.alias || path || '—'
}
function folderBranchFor(path: string): string | null {
  return sessions.folders.find((f) => f.path === path)?.gitBranch ?? null
}

function nextAtFor(worker: Worker): number {
  const runs = scheduler.runsByWorker[worker.id] ?? []
  const last = runs[runs.length - 1]
  return last ? last.startedAt + worker.everyMinutes * 60_000 : 0
}
function lastStatusFor(worker: Worker): Run['status'] | undefined {
  const runs = scheduler.runsByWorker[worker.id] ?? []
  return runs[runs.length - 1]?.status
}

// ── actions ──────────────────────────────────────────────────────────────
function selectWorker(id: string): void {
  scheduler.selectedId = id
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
          class="scrollable w-[300px] flex-none overflow-y-auto border-r border-border bg-sidebar"
          role="listbox"
          :aria-label="t('scheduler.title')"
        >
          <template v-if="enabledWorkers.length > 0">
            <div
              class="flex h-6 items-center bg-surface px-3 text-[11px] uppercase tracking-wide text-text-3"
            >
              {{ t('scheduler.groupEnabled', { n: enabledWorkers.length }) }}
            </div>
            <SchedulerWorkerRow
              v-for="w in enabledWorkers"
              :key="w.id"
              :worker="w"
              :selected="w.id === scheduler.selectedId"
              :running="scheduler.runningIds.includes(w.id)"
              :last-status="lastStatusFor(w)"
              :next-at="nextAtFor(w)"
              :running-since-ms="runningSinceById[w.id]"
              :now-ms="nowMs"
              :folder-label="folderAliasFor(w.folder)"
              :branch-label="folderBranchFor(w.folder)"
              @select="selectWorker(w.id)"
              @run-now="runNow(w.id)"
              @stop="stopWorker(w.id)"
              @delete="deleteWorker(w.id)"
            />
          </template>
          <template v-if="offWorkers.length > 0">
            <div
              class="flex h-6 items-center bg-surface px-3 text-[11px] uppercase tracking-wide text-text-3"
            >
              {{ t('scheduler.groupOff', { n: offWorkers.length }) }}
            </div>
            <SchedulerWorkerRow
              v-for="w in offWorkers"
              :key="w.id"
              :worker="w"
              :selected="w.id === scheduler.selectedId"
              :running="scheduler.runningIds.includes(w.id)"
              :last-status="lastStatusFor(w)"
              :next-at="nextAtFor(w)"
              :running-since-ms="runningSinceById[w.id]"
              :now-ms="nowMs"
              :folder-label="folderAliasFor(w.folder)"
              :branch-label="folderBranchFor(w.folder)"
              @select="selectWorker(w.id)"
              @run-now="runNow(w.id)"
              @stop="stopWorker(w.id)"
              @delete="deleteWorker(w.id)"
            />
          </template>
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
