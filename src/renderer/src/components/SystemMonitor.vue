<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Cpu, Info } from 'lucide-vue-next'
import { useUiStore } from '../stores/ui'
import { useMonitorStore } from '../stores/monitor'
import { useSessionsStore } from '../stores/sessions'
import { useCompanionStore } from '../stores/companion'
import SystemMonitorRow from './SystemMonitorRow.vue'
import { formatBytes, heapPercent, heapBarClass, selfSample } from './system-monitor-format'
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

/** Close a row's session — reuses the sidebar's own close, no new verb (spec §3). */
function onCloseRow(sessionKey: string): void {
  sessions.closeSession(sessionKey)
}

// ---- Row expand/collapse (session children) --------------------------------

const expandedKeys = ref<Set<string>>(new Set())
function toggleExpanded(sessionKey: string): void {
  const next = new Set(expandedKeys.value)
  if (next.has(sessionKey)) next.delete(sessionKey)
  else next.add(sessionKey)
  expandedKeys.value = next
}

// ---- Session label (folder alias + branch) ----------------------------------

function resolveSessionLabel(sample: SessionSample): { name: string; path: string | null } {
  const alias = sessions.folderAliasOf(sample.sessionKey)
  const session = sessions.findSessionById(sample.sessionKey)
  if (alias) return { name: alias, path: session?.gitBranch || null }
  if (session)
    return { name: projectBasename(session.projectPath), path: session.gitBranch || null }
  // Not resolvable locally (e.g. a teammate/other-kind key) — fall back to the raw key.
  return { name: sample.sessionKey, path: null }
}

/** Resolved once per render per row (not per-binding) — keyed by `sessionKey`. */
const sessionLabels = computed(() => {
  const map = new Map<string, { name: string; path: string | null }>()
  for (const row of monitor.sessionRows) map.set(row.sessionKey, resolveSessionLabel(row))
  return map
})

/**
 * The session root's own cost (system-monitor-format.ts#selfSample) — the piece of
 * the row's total that `row.procs` never lists, since `sampler.ts` deliberately
 * excludes the root pid from that array. Rendered as an extra, visually-distinct
 * "own memory" row so an expanded session's children visibly sum to its total
 * instead of falling short of it for no apparent reason.
 */
const sessionSelfSamples = computed(() => {
  const map = new Map<string, ReturnType<typeof selfSample>>()
  for (const row of monitor.sessionRows) {
    if (row.procs.length === 0) continue
    map.set(row.sessionKey, selfSample({ cpuPct: row.cpuPct, rssBytes: row.rssBytes }, row.procs))
  }
  return map
})

// ---- Group summaries ----------------------------------------------------------

const harnuCountLabel = computed(() =>
  t('systemMonitor.harnuCount', {
    count: monitor.harnuRows.length,
    size: formatBytes(monitor.harnuTotalBytes)
  })
)
const sessionsCountLabel = computed(() =>
  t('systemMonitor.sessionsCount', {
    live: monitor.sessionCounts.live,
    parked: monitor.sessionCounts.parked
  })
)

const heapPct = computed(() => heapPercent(monitor.lastHeap))
const headerHeapFillClass = computed(() => heapBarClass(monitor.lastHeap?.status))
</script>

<template>
  <div class="scrollable min-h-0 flex-1 overflow-y-auto">
    <table class="w-full border-collapse">
      <thead class="sticky top-0 z-10 bg-bg">
        <tr>
          <th
            class="px-4 py-2 text-left text-[10.5px] font-medium uppercase tracking-wide text-text-4"
          >
            {{ t('systemMonitor.columnName') }}
          </th>
          <th
            class="px-4 py-2 text-right text-[10.5px] font-medium uppercase tracking-wide text-text-4"
          >
            <span class="inline-flex items-center justify-end gap-1">
              {{ t('systemMonitor.columnRam') }}
              <Info
                :size="11"
                :stroke-width="1.8"
                class="shrink-0 cursor-help normal-case text-text-4"
                :aria-label="t('systemMonitor.ramColumnHint')"
                :title="t('systemMonitor.ramColumnHint')"
              />
            </span>
          </th>
          <th
            class="px-4 py-2 text-right text-[10.5px] font-medium uppercase tracking-wide text-text-4"
          >
            {{ t('systemMonitor.columnCpu') }}
          </th>
          <th
            class="px-4 py-2 text-right text-[10.5px] font-medium uppercase tracking-wide text-text-4"
          >
            {{ t('systemMonitor.columnState') }}
          </th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td
            colspan="4"
            class="border-b border-border bg-surface px-4 py-2 text-[10.5px] font-semibold uppercase tracking-wide text-text-3"
          >
            {{ t('systemMonitor.groupHarnu') }}
            <span class="ml-2 font-medium normal-case text-text-4">{{ harnuCountLabel }}</span>
          </td>
        </tr>
        <SystemMonitorRow
          v-for="proc in monitor.harnuRows"
          :key="proc.pid"
          row-kind="harnu"
          :name="proc.name"
          :cpu-pct="proc.cpuPct"
          :rss-bytes="proc.rssBytes"
          :heap="proc.name === 'main' ? monitor.lastHeap : null"
        />
        <tr v-if="monitor.harnuRows.length === 0">
          <td colspan="4" class="px-4 py-6 text-center text-[12px] text-text-3">
            {{ t('systemMonitor.loading') }}
          </td>
        </tr>

        <tr>
          <td
            colspan="4"
            class="border-b border-border bg-surface px-4 py-2 text-[10.5px] font-semibold uppercase tracking-wide text-text-3"
          >
            {{ t('systemMonitor.groupSessions') }}
            <span class="ml-2 font-medium normal-case text-text-4">{{ sessionsCountLabel }}</span>
          </td>
        </tr>
        <template v-for="row in monitor.sessionRows" :key="row.sessionKey">
          <SystemMonitorRow
            row-kind="session"
            :name="sessionLabels.get(row.sessionKey)?.name ?? row.sessionKey"
            :path="sessionLabels.get(row.sessionKey)?.path ?? null"
            :cpu-pct="row.cpuPct"
            :rss-bytes="row.rssBytes"
            :state="row.state"
            :reason="row.reason"
            :idle-ms="row.idleMs"
            :sweep-rank="row.sweepRank"
            :saved-bytes="row.savedBytes"
            :has-children="row.procs.length > 0"
            :expanded="expandedKeys.has(row.sessionKey)"
            :parkable="row.parkable"
            :companion="companion.stateFor(row.sessionKey)"
            @toggle="toggleExpanded(row.sessionKey)"
            @park="onPark(row.sessionKey)"
            @close="onCloseRow(row.sessionKey)"
          />
          <template v-if="expandedKeys.has(row.sessionKey)">
            <SystemMonitorRow
              v-if="sessionSelfSamples.has(row.sessionKey)"
              :key="`${row.sessionKey}-self`"
              row-kind="child"
              is-self
              :name="t('systemMonitor.ownMemory')"
              :cpu-pct="sessionSelfSamples.get(row.sessionKey)?.cpuPct ?? null"
              :rss-bytes="sessionSelfSamples.get(row.sessionKey)?.rssBytes ?? null"
            />
            <SystemMonitorRow
              v-for="proc in row.procs"
              :key="`${row.sessionKey}-${proc.pid}`"
              row-kind="child"
              :name="proc.name"
              :cpu-pct="proc.cpuPct"
              :rss-bytes="proc.rssBytes"
            />
          </template>
        </template>
        <tr v-if="monitor.sessionRows.length === 0 && monitor.lastSample">
          <td colspan="4" class="px-4 py-6 text-center text-[12px] text-text-3">
            {{ t('systemMonitor.noSessions') }}
          </td>
        </tr>
      </tbody>
    </table>
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
    <span class="flex-1" />
    <div
      v-if="monitor.lastHeap"
      class="flex items-center gap-1.5 font-mono text-[11.5px] text-text-2"
    >
      <span>{{ t('systemMonitor.heapLabel') }}</span>
      <span class="h-1.5 w-24 overflow-hidden rounded-full bg-surface-2">
        <span
          class="block h-full rounded-full"
          :class="headerHeapFillClass"
          :style="{ width: `${heapPct}%` }"
        />
      </span>
      <span>{{ Math.round(heapPct) }}%</span>
    </div>
  </Teleport>
</template>
