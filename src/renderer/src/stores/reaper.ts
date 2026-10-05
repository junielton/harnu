import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  ReaperSnapshot,
  ReapItem,
  CleanResult,
  Tombstone,
  DehydrateResult,
  RehydrateResult
} from '../../../preload'
import { i18n } from '../i18n'
import { useNotificationsStore } from './notifications'
import { formatBytes } from '../components/system-monitor-format'
import { isIdleDehydratable, type HydrationOp } from '../components/cleanup-row'

/** Mirrors `defaultPrefs().dehydrateIdleDays` until the real prefs arrive. */
const DEFAULT_DEHYDRATE_IDLE_DAYS = 7

/**
 * Reaper cleanup engine — renderer store (plan Task 8, `docs/plans/2026-07-15-reaper-cleanup.md`).
 * Thin cache over the `window.api.reaper*` IPC surface: holds the last snapshot,
 * the derived KPIs the Cleanup takeover needs, and the scan/clean/sweep actions.
 * No IPC logic beyond what's here — the engine (classifier/scan-core/executor)
 * stays entirely in `src/main/reaper/`.
 */

interface Totals {
  items: number
  harvestable: number
  reclaimableBytes: number
}

function computeTotals(snapshot: ReaperSnapshot | null): Totals {
  const totals: Totals = { items: 0, harvestable: 0, reclaimableBytes: 0 }
  if (!snapshot) return totals
  for (const repo of snapshot.repos) {
    for (const item of repo.items) {
      totals.items++
      if (item.verdict === 'harvestable') {
        totals.harvestable++
        totals.reclaimableBytes += item.diskBytes ?? 0
      }
    }
  }
  return totals
}

export const useReaperStore = defineStore('reaper', () => {
  const snapshot = ref<ReaperSnapshot | null>(null)
  const scanning = ref(false)
  const sweeping = ref(false)
  const progress = ref<CleanResult[]>([])
  const journal = ref<Tombstone[]>([])
  /** Per-item dehydrate results for the open confirm dialog (T250). */
  const dehydrateProgress = ref<DehydrateResult[]>([])
  /** Items with a dehydrate/rehydrate in flight — what the row's meta line and cluster read. */
  const hydrationOps = ref<Map<string, HydrationOp>>(new Map())
  /** `ReaperPrefs.dehydrateIdleDays` — the repo pill's "idle" threshold. */
  const dehydrateIdleDays = ref(DEFAULT_DEHYDRATE_IDLE_DAYS)

  let unsubUpdate: (() => void) | null = null
  let unsubProgress: (() => void) | null = null
  let unsubHarvestable: (() => void) | null = null
  let unsubDehydrate: (() => void) | null = null

  function setOps(ids: string[], op: HydrationOp | null): void {
    const next = new Map(hydrationOps.value)
    for (const id of ids) {
      if (op) next.set(id, op)
      else next.delete(id)
    }
    hydrationOps.value = next
  }

  const totals = computed(() => computeTotals(snapshot.value))

  const harvestable = computed<ReapItem[]>(() => {
    if (!snapshot.value) return []
    return snapshot.value.repos.flatMap((repo) =>
      repo.items.filter((item) => item.verdict === 'harvestable')
    )
  })

  const remoteCount = computed(
    () => harvestable.value.filter((item) => item.needsRemoteDelete).length
  )

  /**
   * Grouped for the takeover's per-repo sections. A live session (`verdict:
   * 'active'`) is filtered out here — Reaper can't offer to clean up a folder
   * a Harnu session is running in, so the row would just be noise (design.md
   * "Cleanup takeover" — the `cleanup-row--active` variant is documented as a
   * canonical capture target only, not something the real view renders).
   * Repos with nothing left to show after that filter are dropped entirely.
   */
  const repoGroups = computed<Array<{ repoPath: string; label: string; items: ReapItem[] }>>(() => {
    if (!snapshot.value) return []
    return snapshot.value.repos
      .map((repo) => ({
        repoPath: repo.repoPath,
        label: repo.repoPath.split('/').pop() ?? repo.repoPath,
        items: repo.items.filter((item) => item.verdict !== 'active')
      }))
      .filter((group) => group.items.length > 0)
  })

  /** A repo group's rows the "Dehydrate N idle" pill acts on — real state, never the filtered view. */
  function idleDehydratable(repoPath: string): ReapItem[] {
    const group = repoGroups.value.find((g) => g.repoPath === repoPath)
    return group
      ? group.items.filter(
          (item) =>
            isIdleDehydratable(item, dehydrateIdleDays.value) && !hydrationOps.value.has(item.id)
        )
      : []
  }

  async function loadPrefs(): Promise<void> {
    try {
      const prefs = await window.api.reaperPrefs()
      if (prefs && typeof prefs.dehydrateIdleDays === 'number') {
        dehydrateIdleDays.value = prefs.dehydrateIdleDays
      }
    } catch {
      // keep the default; the pill's threshold is a convenience, not a guard
    }
  }

  async function init(): Promise<void> {
    snapshot.value = await window.api.reaperSnapshot()
    journal.value = await window.api.reaperJournal()
    unsubUpdate?.()
    unsubProgress?.()
    unsubHarvestable?.()
    unsubDehydrate?.()
    unsubUpdate = window.api.onReaperUpdate((snap) => {
      snapshot.value = snap
    })
    unsubProgress = window.api.onReaperProgress((result) => {
      progress.value = [...progress.value, result]
    })
    unsubDehydrate =
      window.api.onReaperDehydrateProgress?.((result) => {
        dehydrateProgress.value = [...dehydrateProgress.value, result]
        setOps([result.itemId], null)
      }) ?? null
    void loadPrefs()
    // Slice 2 (plan Task 14): a background tick found items that just became
    // harvestable. This is a QUIET alert — it only records a notification-center
    // entry (no toast, no sound, no OS attention), matching the spec.
    unsubHarvestable = window.api.onReaperHarvestable(({ count, reclaimableBytes }) => {
      const { t } = i18n.global
      useNotificationsStore().notify({
        ts: Date.now(),
        source: 'app',
        kind: 'info',
        title: t('cleanup.notifyTitle', { count }),
        description: t('cleanup.notifyBody', { size: formatBytes(reclaimableBytes) }),
        // T163: the row's own copy says "open Cleanup to sweep" — make that
        // literally true on click instead of a dead instruction.
        target: { view: 'cleanup' }
      })
    })
  }

  /** Explicit user-triggered rescan — always bypasses the `gh` disk cache. */
  async function scanNow(): Promise<void> {
    scanning.value = true
    try {
      snapshot.value = await window.api.reaperScan(true)
    } finally {
      scanning.value = false
    }
  }

  async function cleanItem(itemId: string, deleteRemote: boolean): Promise<CleanResult> {
    const result = await window.api.reaperClean({ itemId, deleteRemote })
    journal.value = await window.api.reaperJournal()
    return result
  }

  /** Sweeps exactly the given items — the primitive both scoped sweep paths
   * (per-repo, per-selection) and `sweepAll` build on. */
  async function sweepItems(itemIds: string[], deleteRemote: boolean): Promise<CleanResult[]> {
    if (itemIds.length === 0) return []
    sweeping.value = true
    progress.value = []
    try {
      const results = await window.api.reaperSweep({ itemIds, deleteRemote })
      journal.value = await window.api.reaperJournal()
      return results
    } finally {
      sweeping.value = false
    }
  }

  /** Sweeps every currently-harvestable item. */
  async function sweepAll(deleteRemote: boolean): Promise<CleanResult[]> {
    return sweepItems(
      harvestable.value.map((item) => item.id),
      deleteRemote
    )
  }

  /**
   * Dehydrates exactly the given items (T250). Each row reads `dehydrating`
   * until its own progress event lands; the `finally` clears any the main
   * process never reported on (a rejected call), so no row rests in a half state.
   */
  async function dehydrate(itemIds: string[]): Promise<DehydrateResult[]> {
    if (itemIds.length === 0) return []
    dehydrateProgress.value = []
    setOps(itemIds, 'dehydrating')
    try {
      return await window.api.reaperDehydrate({ itemIds })
    } finally {
      setOps(itemIds, null)
    }
  }

  async function rehydrate(itemId: string): Promise<RehydrateResult> {
    setOps([itemId], 'rehydrating')
    try {
      return await window.api.reaperRehydrate({ itemId })
    } finally {
      setOps([itemId], null)
    }
  }

  return {
    snapshot,
    scanning,
    sweeping,
    progress,
    journal,
    totals,
    harvestable,
    remoteCount,
    repoGroups,
    dehydrateProgress,
    hydrationOps,
    dehydrateIdleDays,
    idleDehydratable,
    init,
    scanNow,
    cleanItem,
    sweepItems,
    sweepAll,
    dehydrate,
    rehydrate
  }
})
