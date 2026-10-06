/**
 * The telemetry adapter (T389 P1W6 §7.3): it turns the host's `usage.measured` events into
 * writes to the neutral telemetry store, and keeps the store honest about who may write.
 * Electron-free: the arbiter, the mode seam, the store and the ledger are injected.
 *
 * Rules that matter:
 *  - Proof comes first: the first `usage.measured` that carries a reading proves `sense.usage`,
 *    and only then is ownership asked, so the event that proves the feature may itself apply.
 *  - Ownership is the arbiter's alone (`owns(sid, 'telemetry')`); nothing in a payload raises it.
 *  - Whenever ownership may have changed (a lease lost, a binding revoked by the kill switch, a
 *    mode flip, a session end) every session the companion wrote for is re-asked, and one that
 *    is no longer owned is dropped at once: every group returns to the statusLine (ARB-4b).
 *  - Nothing here touches `~/.claude/settings.json` (lesson framework/005): the adapter imports
 *    the store only, never the statusLine install or settings modules.
 */

import type { FactSource } from '../arbitration-core'
import type { WireEvent } from '../contract'
import type { CompanionHostFacade } from '../host-core'
import type { BindingView } from '../session-table'
import type { SessionTelemetry } from '../../statusline-parse'
import type { TelemetryStore } from '../../telemetry-store'
import { mapUsageMeasured, type MappedUsage } from './usage-map-core'
import './parity-telemetry-rule' // registers the `telemetry` rule
import './parity-planusage-rule' // registers the `planUsage` rule

export interface PlanDetail {
  h5: number | null
  d7: number | null
  r5: number | null
  r7: number | null
}

export type TelemetryParityDetail = Record<string, string | number | boolean | null>

export interface TelemetryAdapterDeps {
  host: Pick<CompanionHostFacade, 'bus' | 'onBindingChange' | 'markProven' | 'registerEventTypes'>
  /** The arbiter's answer for one family of this session. */
  owns(sid: string, family: 'telemetry' | 'planUsage'): boolean
  onOwnershipChange(fn: () => void): () => void
  /** The mode seam's change listener (a flip to or from `off`, `shadow` or `active`). */
  onModeChange(fn: () => void): () => void
  store: Pick<
    TelemetryStore,
    'ingestCompanion' | 'dropCompanion' | 'companionSids' | 'onStatusline'
  >
  /** Host receive time, epoch ms: freshness is never the mod's clock. */
  now?(): number
  /** The plan-usage gate (S2): an owned reading with a window closes it for 90 s. */
  planGate?: {
    note(r: { owned: boolean; windows: number; hostNow: number }, detail?: PlanDetail): void
    clear(): void
  }
  /** The parity ledger (`recordFact`); a no-op until the app configures it. */
  recordFact?(
    source: FactSource,
    sid: string,
    k: string,
    d: TelemetryParityDetail,
    ctx?: { ts?: number }
  ): void
  /** Whether a session has a companion binding: a statusLine blob is worth a record only then. */
  isBound?(sid: string): boolean
}

export interface TelemetryAdapter {
  dispose(): void
}

const FEATURE = 'sense.usage'

/** One ledger detail of a mapped reading (§13: `ctx`, `cost`, `rl`), scrubbed by the ledger. */
function companionDetail(m: MappedUsage, extra: { source: string }): TelemetryParityDetail {
  const rl = m.part.rateLimits
  return {
    src: extra.source,
    pct: m.part.context?.percent ?? null,
    window: m.part.context?.window ?? null,
    usd: m.part.cost?.usd ?? null,
    h5: rl?.fiveHour?.usedPercent ?? null,
    d7: rl?.sevenDay?.usedPercent ?? null,
    r5: rl?.fiveHour?.resetsAtMs ?? null,
    r7: rl?.sevenDay?.resetsAtMs ?? null,
    ...(m.spendLimit ? { spend: m.spendLimit.percentUsed } : {})
  }
}

function legacyDetail(t: SessionTelemetry): TelemetryParityDetail {
  return {
    src: 'statusline',
    pct: t.contextPercent,
    window: t.contextWindowSize,
    usd: t.costUsd,
    h5: t.rateLimits.fiveHour?.usedPercent ?? null,
    d7: t.rateLimits.sevenDay?.usedPercent ?? null,
    r5: t.rateLimits.fiveHour?.resetsAtMs ?? null,
    r7: t.rateLimits.sevenDay?.resetsAtMs ?? null
  }
}

const hasReading = (m: MappedUsage): boolean =>
  m.part.cost !== undefined ||
  m.part.context !== undefined ||
  m.part.rateLimits !== undefined ||
  m.tokens !== null

export function createTelemetryAdapter(deps: TelemetryAdapterDeps): TelemetryAdapter {
  const now = deps.now ?? ((): number => Date.now())

  const ownsSafe = (sid: string, family: 'telemetry' | 'planUsage'): boolean => {
    try {
      return deps.owns(sid, family)
    } catch {
      return false // fail-safe: legacy writes
    }
  }

  /** Sessions whose owned reading is what keeps the plan-usage gate closed. */
  const planSids = new Set<string>()

  /**
   * Re-asks the arbiter for every session the companion writes for, and for every session that
   * counts toward the plan-usage gate. When the last of those stops owning `planUsage` (the kill
   * switch, a lease lost, a mode flip) the gate is cleared at once: the next tick polls.
   */
  function reconcile(): void {
    for (const sid of deps.store.companionSids()) {
      if (!ownsSafe(sid, 'telemetry')) deps.store.dropCompanion(sid)
    }
    if (planSids.size === 0) return
    for (const sid of [...planSids]) if (!ownsSafe(sid, 'planUsage')) planSids.delete(sid)
    if (planSids.size === 0) deps.planGate?.clear()
  }

  /** The `planUsage` family: an owned reading with a known window keeps the poll from spawning. */
  function noteGate(sid: string, m: MappedUsage): void {
    if (!deps.planGate) return
    const rl = m.part.rateLimits
    const windows = (rl?.fiveHour ? 1 : 0) + (rl?.sevenDay ? 1 : 0)
    const owned = ownsSafe(sid, 'planUsage')
    deps.planGate.note(
      { owned, windows, hostNow: now() },
      {
        h5: rl?.fiveHour?.usedPercent ?? null,
        d7: rl?.sevenDay?.usedPercent ?? null,
        r5: rl?.fiveHour?.resetsAtMs ?? null,
        r7: rl?.sevenDay?.resetsAtMs ?? null
      }
    )
    if (owned && windows > 0) planSids.add(sid)
  }

  function onUsage(b: BindingView, ev: WireEvent): void {
    if (b.state !== 'bound' || !b.enabled.includes(FEATURE)) return
    const mapped = mapUsageMeasured(ev.d, now(), b.cwd || null)
    if (!mapped) return
    // Proof before admission: the event that proves the feature may itself be applied.
    if (hasReading(mapped)) deps.host.markProven(b, FEATURE)
    deps.store.ingestCompanion(b.sid, mapped.part, ownsSafe(b.sid, 'telemetry'))
    noteGate(b.sid, mapped)
    try {
      deps.recordFact?.(
        'companion',
        b.sid,
        'reading',
        companionDetail(mapped, { source: mapped.source }),
        {
          ts: ev.ts
        }
      )
    } catch {
      // the ledger is evidence, never a dependency of telemetry
    }
  }

  // The server delivers only event types a wave registered (contract §8).
  deps.host.registerEventTypes(['usage.measured'])

  const offs = [
    deps.host.bus.on('event', (b, ev) => {
      if (ev.t === 'usage.measured') onUsage(b, ev)
    }),
    deps.host.bus.on('lease', () => reconcile()),
    deps.host.bus.on('end', (b) => {
      // the session is over: nothing of the companion's outlives it
      deps.store.dropCompanion(b.sid)
      reconcile()
    }),
    deps.host.bus.on('proof', () => reconcile()),
    deps.host.onBindingChange(() => reconcile()),
    deps.onOwnershipChange(reconcile),
    deps.onModeChange(reconcile),
    // The legacy side of the parity rule: every statusLine blob of a session the mod is bound to.
    deps.store.onStatusline((t) => {
      if (deps.isBound && !deps.isBound(t.sessionId)) return
      try {
        deps.recordFact?.('legacy', t.sessionId, 'reading', legacyDetail(t), { ts: t.updatedAtMs })
      } catch {
        // see above
      }
    })
  ]

  return {
    dispose() {
      for (const off of offs) off()
    }
  }
}
