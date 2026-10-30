<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Cpu, Info, TriangleAlert } from 'lucide-vue-next'
import { useUiStore } from '../stores/ui'
import { useMonitorStore } from '../stores/monitor'
import { useSessionsStore } from '../stores/sessions'
import { useCompanionStore } from '../stores/companion'
import { pingToast } from '../lib/companion-view'
import SystemMonitorCard from './SystemMonitorCard.vue'
import SystemMonitorKpis from './SystemMonitorKpis.vue'
import SystemMonitorRow from './SystemMonitorRow.vue'
import SystemMonitorSidebar from './SystemMonitorSidebar.vue'
import {
  MONITOR_VIEW_KEY,
  TABLE_GRID,
  formatBytes,
  heapPercent,
  monitorHeapFillClass,
  monitorHeapTextClass,
  monitorTotals,
  parseMonitorView,
  type MonitorView,
  type SessionView
} from './system-monitor-format'
import { folderHue, folderInitial } from '../lib/folder-hue'
import { projectBasename } from './usage-dashboard-format'
import type { SessionSample } from '../../../preload'

/**
 * System Monitor — main-pane takeover (design.md "System Monitor (takeover,
 * T127 S2)"). Same anatomy as `UsageDashboard`/`RoadmapBoard`: replaces the
 * `<main>` content, sidebar and topbar stay visible.
 *
 * Owns the full sampler's start/stop lifecycle (spec §5): acquires it on
 * mount and on window focus, releases it on unmount and on window blur. The
 * `acquired` guard prevents a focus-while-already-acquired double `monitorStart`
 * from ever landing (main's refcount only balances if start/stop calls here are
 * 1:1) — `monitor:stop` on main is `Math.max(0, refcount - 1)`-clamped, so an
 * extra `release()` is harmless, but an extra `acquire()` would leak a live
 * refcount that never reaches zero, silently keeping the full sampler running
 * forever after this pane closes.
 */
const ui = useUiStore()
const monitor = useMonitorStore()
const sessions = useSessionsStore()
const companion = useCompanionStore()
const { t } = useI18n()

let acquired = false
async function acquire(): Promise<void> {
  if (acquired) return
  acquired = true
  await monitor.startSampler()
}
async function release(): Promise<void> {
  if (!acquired) return
  acquired = false
  await monitor.stopSampler()
}

onMounted(() => {
  acquire()
  window.addEventListener('blur', release)
  window.addEventListener('focus', acquire)
})
onUnmounted(() => {
  release()
  window.removeEventListener('blur', release)
  window.removeEventListener('focus', acquire)
})

function onEditPolicy(): void {
  ui.openSettings('hibernationPolicy')
}

// ---- Per-row actions (T127 S4) ----------------------------------------------

/**
 * Park a session on demand (BUG-69). ONE call: `ptyPark` runs main's
 * `hibernateSession` — kill + flag + broadcast `pty:hibernated` as a single
 * transaction, the same one the automatic sweep uses. The renderer's
 * `onPtyHibernated` handler (`TerminalPane.vue`) disposes the `LiveTerminal`
 * and calls `sessions.markHibernated` FROM the broadcast — no optimistic call
 * here, or a divergent state (parked flag set but terminal never disposed)
 * could outlive the event that was supposed to prevent it.
 */
async function onPark(sessionKey: string): Promise<void> {
  await window.api.ptyPark(sessionKey)
}

/**
 * "Test Harnu mod channel" (T389 P2W1): a `flush` and a terminal toast to one session, answered
 * by one Harnu toast. Main builds the cause; the renderer only names the session.
 */
async function onPingChannel(sessionKey: string): Promise<void> {
  const answer = await window.api
    .companionPing(sessionKey)
    .catch(() => ({ ok: false, roundTripMs: 0 }))
  ui.pushToast({ ...pingToast(answer, t), sessionId: sessionKey })
}

/** Close a row's session — reuses the sidebar's own close, no new verb (spec §3). */
function onCloseRow(sessionKey: string): void {
  sessions.closeSession(sessionKey)
}

// ---- Expand / collapse (per session, both views; not persisted) -------------

const expandedKeys = ref<Set<string>>(new Set())
function toggleExpanded(sessionKey: string): void {
  const next = new Set(expandedKeys.value)
  if (next.has(sessionKey)) next.delete(sessionKey)
  else next.add(sessionKey)
  expandedKeys.value = next
}

// ---- Cards / Table toggle (persisted) ------------------------------------------

function readView(): MonitorView {
  try {
    return parseMonitorView(localStorage.getItem(MONITOR_VIEW_KEY))
  } catch {
    return 'cards'
  }
}
const view = ref<MonitorView>(readView())
function setView(next: MonitorView): void {
  view.value = next
  try {
    localStorage.setItem(MONITOR_VIEW_KEY, next)
  } catch {
    // Private mode / blocked storage: the toggle still works for this visit.
  }
}

// ---- Session label (folder alias + branch) and folder hue -----------------------

function resolveSessionView(row: SessionSample): SessionView {
  const alias = sessions.folderAliasOf(row.sessionKey)
  const session = sessions.findSessionById(row.sessionKey)
  // Not resolvable locally (e.g. a teammate/other-kind key) — fall back to the raw key.
  const name = alias || (session ? projectBasename(session.projectPath) : row.sessionKey)
  return {
    row,
    name,
    branch: session?.gitBranch || null,
    // The hue follows the folder path, like the Scheduler; an unknown session hashes its key.
    hue: folderHue(session?.projectPath ?? row.sessionKey),
    initial: folderInitial(name)
  }
}

const sessionViews = computed(() => monitor.sessionRows.map(resolveSessionView))

// ---- Totals, header summary and the heap gauges ---------------------------------

const totals = computed(() => monitorTotals(monitor.harnuRows, monitor.sessionRows))
/** The RAM bar of a table row is relative to the largest live session. */
const maxSessionRss = computed(() =>
  Math.max(0, ...monitor.sessionRows.map((s) => s.rssBytes ?? 0))
)
const headerSummary = computed(() =>
  t('systemMonitor.headerSummary', {
    count: monitor.harnuRows.length,
    live: totals.value.live,
    parked: totals.value.parked
  })
)
const sessionsSummary = computed(() =>
  t('systemMonitor.sessionsSummary', {
    live: totals.value.live,
    size: formatBytes(totals.value.sessionsBytes)
  })
)

const heapPct = computed(() => heapPercent(monitor.lastHeap))
const headerHeapFillClass = computed(() => monitorHeapFillClass(monitor.lastHeap?.status))
const headerHeapTextClass = computed(() => monitorHeapTextClass(monitor.lastHeap?.status))
</script>

<template>
  <div class="scrollable @container min-h-0 flex-1 overflow-y-auto">
    <div class="grid min-h-full grid-cols-[320px_1fr] @max-[1000px]:grid-cols-1">
      <SystemMonitorSidebar
        :processes="monitor.harnuRows"
        :heap="monitor.lastHeap"
        :totals="totals"
      />

      <section class="flex min-w-0 flex-col gap-3.5 px-[18px] pb-5 pt-4">
        <SystemMonitorKpis :totals="totals" />

        <div class="flex items-center gap-2.5">
          <span class="text-[10.5px] font-semibold uppercase tracking-wide text-text-2">{{
            t('systemMonitor.groupSessions')
          }}</span>
          <span class="text-[11px] text-text-3">{{ sessionsSummary }}</span>
          <span class="flex-1" />
          <span
            class="inline-flex overflow-hidden rounded-[var(--radius-sm)] border border-border-2"
            role="group"
            :aria-label="t('systemMonitor.viewToggle')"
            data-testid="view-toggle"
          >
            <button
              type="button"
              class="h-6 px-2.5 text-[11px]"
              :class="view === 'cards' ? 'bg-surface-2 text-text' : 'bg-transparent text-text-3'"
              :aria-pressed="view === 'cards'"
              data-testid="view-cards"
              @click="setView('cards')"
            >
              {{ t('systemMonitor.viewCards') }}
            </button>
            <button
              type="button"
              class="h-6 px-2.5 text-[11px]"
              :class="view === 'table' ? 'bg-surface-2 text-text' : 'bg-transparent text-text-3'"
              :aria-pressed="view === 'table'"
              data-testid="view-table"
              @click="setView('table')"
            >
              {{ t('systemMonitor.viewTable') }}
            </button>
          </span>
        </div>

        <div
          v-if="sessionViews.length === 0 && monitor.lastSample"
          class="py-6 text-center text-[12px] text-text-3"
        >
          {{ t('systemMonitor.noSessions') }}
        </div>

        <div
          v-else-if="view === 'cards'"
          class="grid grid-cols-[repeat(auto-fill,minmax(270px,1fr))] items-start gap-3"
          data-testid="cards-view"
        >
          <SystemMonitorCard
            v-for="v in sessionViews"
            :key="v.row.sessionKey"
            :view="v"
            :expanded="expandedKeys.has(v.row.sessionKey)"
            :history="monitor.sessionHistory(v.row.sessionKey)"
            :companion="companion.stateFor(v.row.sessionKey)"
            @toggle="toggleExpanded(v.row.sessionKey)"
            @park="onPark(v.row.sessionKey)"
            @close="onCloseRow(v.row.sessionKey)"
            @ping-channel="onPingChannel(v.row.sessionKey)"
          />
        </div>

        <div
          v-else
          class="@container overflow-hidden rounded-[var(--radius)] border border-border bg-sidebar"
          data-testid="table-view"
        >
          <div
            class="h-[30px] items-center gap-3 bg-surface px-3 text-[10.5px] uppercase tracking-wide text-text-4"
            :class="TABLE_GRID"
          >
            <span>{{ t('systemMonitor.columnName') }}</span>
            <span class="inline-flex items-center gap-1">
              {{ t('systemMonitor.columnRam') }}
              <Info
                :size="10"
                :stroke-width="1.8"
                class="shrink-0 cursor-help normal-case text-text-4"
                :aria-label="t('systemMonitor.ramColumnHint')"
                :title="t('systemMonitor.ramColumnHint')"
              />
            </span>
            <span class="text-right">{{ t('systemMonitor.columnCpu') }}</span>
            <span class="@max-[760px]:hidden">{{ t('systemMonitor.columnLast60') }}</span>
            <span class="text-right">{{ t('systemMonitor.columnState') }}</span>
          </div>
          <SystemMonitorRow
            v-for="v in sessionViews"
            :key="v.row.sessionKey"
            :view="v"
            :expanded="expandedKeys.has(v.row.sessionKey)"
            :history="monitor.sessionHistory(v.row.sessionKey)"
            :companion="companion.stateFor(v.row.sessionKey)"
            :max-rss="maxSessionRss"
            @toggle="toggleExpanded(v.row.sessionKey)"
            @park="onPark(v.row.sessionKey)"
            @close="onCloseRow(v.row.sessionKey)"
            @ping-channel="onPingChannel(v.row.sessionKey)"
          />
        </div>
      </section>
    </div>
  </div>

  <footer
    class="flex h-9 shrink-0 items-center gap-2 border-t border-border bg-sidebar px-3 text-[11.5px] text-text-3"
  >
    <span>{{ t('systemMonitor.footerSampling') }}</span>
    <button class="ml-auto text-accent hover:underline" type="button" @click="onEditPolicy">
      {{ t('systemMonitor.policyLink') }}
    </button>
  </footer>

  <!-- T300/U3: header markup rendered into the shared TakeoverShell (design.md §6
       "TakeoverShell — shared chrome") via Teleport, since a dynamically swapped
       view can't fill a named slot of the ancestor wrapping it. Placed after the
       real body content (not first) so this stays a component whose first root
       node is a real element — Vue Test Utils resolves `wrapper.element` off the
       first root, and a Teleport placeholder there breaks every `find`/`get`. -->
  <Teleport to="#takeover-shell-icon" defer>
    <Cpu :size="15" :stroke-width="1.7" class="shrink-0 text-accent" />
  </Teleport>
  <Teleport to="#takeover-shell-actions" defer>
    <span v-if="monitor.lastSample" class="text-[11px] text-text-3" data-testid="header-summary">{{
      headerSummary
    }}</span>
    <span class="flex-1" />
    <div
      v-if="monitor.lastHeap"
      class="flex items-center gap-1.5 font-mono text-[11.5px] text-text-2"
      data-testid="header-heap"
      :data-status="monitor.lastHeap.status"
    >
      <span>{{ t('systemMonitor.heapLabel') }}</span>
      <span class="h-1.5 w-24 overflow-hidden rounded-full bg-border-2">
        <span
          class="block h-full rounded-full"
          :class="headerHeapFillClass"
          :style="{ width: `${heapPct}%` }"
        />
      </span>
      <span :class="monitor.lastHeap.status === 'ok' ? '' : headerHeapTextClass"
        >{{ Math.round(heapPct) }}%</span
      >
      <TriangleAlert
        v-if="monitor.lastHeap.status !== 'ok'"
        :size="12"
        :stroke-width="1.8"
        :class="headerHeapTextClass"
      />
    </div>
  </Teleport>
</template>
