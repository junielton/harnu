import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  UsageSnapshot,
  UsageBucket,
  UsageStatus,
  SessionTelemetry,
  FleetTelemetry
} from '../../../preload'
import { mergeRateWindows, type MergedRateLimits } from '../components/usage-format'

/**
 * Usage + telemetry store. Holds two sources:
 *  1. The legacy {@link UsageSnapshot} from the `claude -p "/usage"` poller
 *     (cold-start fallback for rate-limits — `usage-parse.ts`, unit-tested).
 *  2. The zero-token per-session {@link SessionTelemetry} tailed from the
 *     statusLine inbox (`statusline-parse.ts`, unit-tested) plus its
 *     {@link FleetTelemetry} aggregate.
 *
 * The store is a thin reactive mirror; all parsing/folding lives in main. The
 * `UsagePanel` prefers the statusLine rate-limit cockpit and falls back to the
 * `/usage` buckets; per-row HUD reads {@link contextPercentFor} / {@link telemetryFor}.
 */
export const useUsageStore = defineStore('usage', () => {
  const snapshot = ref<UsageSnapshot | null>(null)
  const telemetryBySession = ref<Map<string, SessionTelemetry>>(new Map())
  const fleet = ref<FleetTelemetry | null>(null)

  let started = false
  let unsubscribeUsage: (() => void) | null = null
  let unsubscribeTelemetry: (() => void) | null = null

  /** Adopt the cached snapshot + telemetry and subscribe to live pushes. Idempotent. */
  async function init(): Promise<void> {
    if (started) return
    started = true
    snapshot.value = await window.api.usageGet()
    unsubscribeUsage = window.api.onUsageUpdated((s) => {
      snapshot.value = s
    })
    const payload = await window.api.telemetryGet()
    telemetryBySession.value = new Map(payload.perSession.map((t) => [t.sessionId, t]))
    fleet.value = payload.fleet
    unsubscribeTelemetry = window.api.onTelemetryUpdated((p) => {
      telemetryBySession.value = new Map(p.perSession.map((t) => [t.sessionId, t]))
      fleet.value = p.fleet
    })
  }

  /** Force a fresh `/usage` spawn and adopt the result. */
  async function refresh(): Promise<void> {
    snapshot.value = await window.api.usageRefresh()
  }

  /** Telemetry for a session (statusLine), or null if it hasn't reported yet. */
  function telemetryFor(sessionId: string): SessionTelemetry | null {
    return telemetryBySession.value.get(sessionId) ?? null
  }

  /**
   * Telemetry for a session object, tolerant of the pre-migration window (BUG-8).
   * The telemetry map is keyed by the REAL Claude uuid, but a freshly-created
   * session is still `synthetic-<uuid>` until its JSONL hits disk — so an exact
   * lookup misses and the footer stays empty until the first turn. Fall back to
   * correlating by `cwd === projectPath` for synthetic sessions (the blob lands
   * seconds after spawn, keyed by the real uuid + cwd), picking the freshest
   * blob for that folder. Once migrated, the exact-id path takes over silently.
   */
  function telemetryForSession(
    session: { sessionId: string; projectPath: string; synthetic?: boolean } | null
  ): SessionTelemetry | null {
    if (!session) return null
    const exact = telemetryBySession.value.get(session.sessionId)
    if (exact) return exact
    if (!session.synthetic) return null
    let best: SessionTelemetry | null = null
    for (const t of telemetryBySession.value.values()) {
      if (t.cwd && t.cwd === session.projectPath && (!best || t.updatedAtMs > best.updatedAtMs)) {
        best = t
      }
    }
    return best
  }

  /** Context-window used % for a session, or null when unknown (never a fake 0). */
  function contextPercentFor(sessionId: string): number | null {
    return telemetryBySession.value.get(sessionId)?.contextPercent ?? null
  }

  /**
   * Rate-limit windows for the cockpit, merged per window from the freshest
   * source (`mergeRateWindows`): the statusLine fleet aggregate (zero-token, but
   * frozen while no session takes a turn) vs the `/usage` poll (90s cadence
   * while focused). "Cockpit always wins" was the staleness bug — a frozen
   * cockpit shadowed fresh polls for hours. Recomputes on every telemetry or
   * snapshot push, so `Date.now()` here is at worst one poll interval old.
   */
  const rateLimits = computed<MergedRateLimits | null>(() => {
    const merged = mergeRateWindows(fleet.value, snapshot.value, Date.now())
    if (!merged.fiveHour && !merged.sevenDay) return null
    return merged
  })

  /**
   * Epoch ms of the OLDEST datum currently shown in the cockpit (honest "updated
   * X ago" — never overpromises when the two windows differ in freshness), or
   * null when there is nothing to show.
   */
  const rateLimitsUpdatedAtMs = computed<number | null>(() => {
    const rl = rateLimits.value
    if (!rl) return null
    const ats = [rl.fiveHour?.updatedAtMs, rl.sevenDay?.updatedAtMs].filter(
      (n): n is number => n != null
    )
    return ats.length ? Math.min(...ats) : null
  })

  /** Fleet cost summary from statusLine, or null when no tab has reported. */
  const fleetSummary = computed<{ totalCostUsd: number; sessionCount: number } | null>(() => {
    const f = fleet.value
    if (!f || f.sessionCount === 0) return null
    return { totalCostUsd: f.totalCostUsd, sessionCount: f.sessionCount }
  })

  const available = computed<boolean>(
    () => rateLimits.value !== null || (snapshot.value?.available ?? false)
  )

  /**
   * Display state for the panel. `null` snapshot AND no telemetry = first fetch
   * still in flight → `loading`. Otherwise `ready` when we have any source, else
   * mirror the snapshot's own status.
   */
  const status = computed<UsageStatus>(() => {
    if (rateLimits.value || fleetSummary.value) return 'ready'
    return snapshot.value?.status ?? 'loading'
  })

  const loading = computed<boolean>(() => status.value === 'loading')

  /** Ordered, null-skipped `/usage` windows (fallback): session, weekly-all, per-model. */
  const buckets = computed<UsageBucket[]>(() => {
    const s = snapshot.value
    if (!s || !s.available) return []
    const out: UsageBucket[] = []
    if (s.session) out.push(s.session)
    if (s.weekAll) out.push(s.weekAll)
    out.push(...s.perModel)
    return out
  })

  function dispose(): void {
    unsubscribeUsage?.()
    unsubscribeTelemetry?.()
    unsubscribeUsage = null
    unsubscribeTelemetry = null
    started = false
  }

  return {
    snapshot,
    telemetryBySession,
    fleet,
    available,
    status,
    loading,
    buckets,
    rateLimits,
    rateLimitsUpdatedAtMs,
    fleetSummary,
    telemetryFor,
    telemetryForSession,
    contextPercentFor,
    init,
    refresh,
    dispose
  }
})
