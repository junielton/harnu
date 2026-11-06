import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import type { HeapSample, MonitorSample } from '../../../preload'
import { sortByRssDesc, sumRssBytes, countSessions } from '../components/system-monitor-format'
import {
  appendSample,
  harnuHistoryKey,
  sessionHistoryKey,
  type MonitorHistory
} from '../lib/monitor-history'

/**
 * System Monitor data (T127 S2, design.md "System Monitor (takeover)"). Subscribes
 * to the two S1 channels — `monitor:heap` (always-on, 30s heartbeat) and
 * `monitor:sample` (1-2s, only while `monitorStart()` has an active caller) — and
 * holds the last payload of each. This store never redefines the S1 payload
 * shapes (`HeapSample`/`MonitorSample`, `src/main/monitor/types.ts`) — it only
 * consumes them and derives display-ready rows.
 *
 * Subscribing happens once, at store creation, and is never torn down — this is a
 * long-lived singleton store like the others (`notifications`, `settings`), and
 * listening for the heap heartbeat costs nothing when nobody is looking (spec §5).
 * The full sampler's actual start/stop (refcounted in main) is a SEPARATE
 * concern owned by `SystemMonitor.vue`'s mount/unmount/blur lifecycle — this
 * store only exposes the thin IPC passthrough so that lifecycle code has
 * something to call.
 *
 * It also keeps the sparkline history (T591): the last 40 RSS readings per Harnu
 * process and per session, appended from every sample that arrives anyway. It never
 * asks for samples itself; a key missing from the latest sample is pruned.
 */
export const useMonitorStore = defineStore('monitor', () => {
  const lastHeap = ref<HeapSample | null>(null)
  const lastSample = ref<MonitorSample | null>(null)
  /** Replaced (never mutated) per sample, so a `shallowRef` is all the reactivity it needs. */
  const history = shallowRef<MonitorHistory>(new Map())

  window.api.onMonitorHeap((sample) => {
    lastHeap.value = sample
  })
  window.api.onMonitorSample((sample) => {
    lastSample.value = sample
    history.value = appendSample(history.value, sample)
  })

  /** The 'Harnu' group, sorted by RAM desc (the takeover's default sort). */
  const harnuRows = computed(() => sortByRssDesc(lastSample.value?.harnu ?? []))
  /** The 'Sessions' group, sorted by RAM desc — parked rows (RSS `null`) sort last. */
  const sessionRows = computed(() => sortByRssDesc(lastSample.value?.sessions ?? []))

  const harnuTotalBytes = computed(() => sumRssBytes(lastSample.value?.harnu ?? []))
  const sessionCounts = computed(() => countSessions(lastSample.value?.sessions ?? []))

  /** The last ≤40 RSS readings of a session, oldest first (`[]` for an unknown key). */
  function sessionHistory(sessionKey: string): readonly (number | null)[] {
    return history.value.get(sessionHistoryKey(sessionKey)) ?? []
  }
  /** The last ≤40 RSS readings of a Harnu process, oldest first. */
  function harnuHistory(pid: number): readonly (number | null)[] {
    return history.value.get(harnuHistoryKey(pid)) ?? []
  }

  /** Thin passthrough — refcounted in main; the caller owns when to call these. */
  async function startSampler(): Promise<void> {
    await window.api.monitorStart()
  }
  async function stopSampler(): Promise<void> {
    await window.api.monitorStop()
  }

  return {
    lastHeap,
    lastSample,
    /** Raw ring buffer — read through `sessionHistory`/`harnuHistory`; exposed for devtools and fixtures. */
    history,
    harnuRows,
    sessionRows,
    harnuTotalBytes,
    sessionCounts,
    sessionHistory,
    harnuHistory,
    startSampler,
    stopSampler
  }
})
