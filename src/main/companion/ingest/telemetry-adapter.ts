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
import type { TurnLedger } from '../turn-ledger'
import { mapTurnCompleted, mapUsageMeasured, type MappedUsage } from './usage-map-core'
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
  host: Pick<
    CompanionHostFacade,
    'bus' | 'onBindingChange' | 'markProven' | 'registerEventTypes' | 'diagnostics'
  >
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
  /** The per-turn ledger (S3): written in `shadow` and `active`, never applied. */
  ledger?: Pick<TurnLedger, 'usage' | 'turnStarted' | 'turnCompleted' | 'gap' | 'close'>
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
const HANDLED: ReadonlySet<string> = new Set(['usage.measured', 'turn.started', 'turn.completed'])

/** One ledger detail of a mapped reading (§13: `ctx`, `cost`, `rl`), scrubbed by the ledger. */
function companionDetail(m: MappedUsage, extra: { source: string }): TelemetryParityDetail {
  const rl = m.part.rateLimits
  return {
    src: extra.source,
    chg: m.changed.join('+'),
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

  /** The ledger is evidence: a fault in it never reaches telemetry or the host's bus. */
  const ledgerDo = (fn: (l: NonNullable<TelemetryAdapterDeps['ledger']>) => void): void => {
    if (!deps.ledger) return
    try {
      fn(deps.ledger)
    } catch {
      // see above
    }
  }

  /** Per binding: the `dropped` count already turned into a gap. */
  const droppedSeen = new Map<number, number>()

  /** The mod discarded events (its ring overflowed): the ledger is not whole for this session. */
  function noteDropped(b: BindingView): void {
    const dropped =
      deps.host.diagnostics().bindings.find((x) => x.sid === b.sid && x.state === 'bound')?.counters
        .dropped ?? 0
    if (dropped > (droppedSeen.get(b.key) ?? 0)) {
      droppedSeen.set(b.key, dropped)
      ledgerDo((l) => l.gap(b.sid, now(), 'dropped'))
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
    ledgerDo((l) =>
      l.usage(b.sid, now(), {
        costUsd: mapped.part.cost?.usd ?? null,
        projectPath: b.cwd,
        ...(mapped.startedAt !== undefined ? { startedAt: mapped.startedAt } : {})
      })
    )
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

  /** `turn.started` and `turn.completed` (S3): the ledger's edges, and the `model` group. */
  function onTurn(b: BindingView, ev: WireEvent): void {
    if (b.state !== 'bound' || !b.enabled.includes('sense.turn')) return
    if (typeof ev.turnId !== 'string' || ev.turnId === '') return
    if (ev.t === 'turn.started') {
      ledgerDo((l) => l.turnStarted(b.sid, now(), ev.turnId!, ev.agentId))
      return
    }
    const m = mapTurnCompleted(ev.d)
    if (!m) return
    ledgerDo((l) =>
      l.turnCompleted(b.sid, now(), {
        turnId: ev.turnId!,
        ...(ev.agentId !== undefined ? { agentId: ev.agentId } : {}),
        durationMs: m.durationMs,
        reason: m.reason,
        ...(m.usage ? { usage: m.usage } : {}),
        ...(m.failure ? { failure: m.failure } : {})
      })
    )
    // The model group: the last MAIN-loop turn's model, never a subagent's (contract §8). Owned
    // only once `sense.usage` is proven and the family is active; `modelName` stays the statusLine's.
    if (ev.agentId === undefined && m.usage) {
      deps.store.ingestCompanion(
        b.sid,
        { cwd: b.cwd || null, model: { id: m.usage.model, atMs: now() } },
        ownsSafe(b.sid, 'telemetry')
      )
    }
  }

  // The server delivers only event types a wave registered (contract §8).
  deps.host.registerEventTypes([
    'usage.measured',
    'turn.started',
    'turn.completed',
    'session.rebound'
  ])

  const offs = [
    deps.host.bus.on('event', (b, ev) => {
      if (deps.ledger && HANDLED.has(ev.t)) noteDropped(b)
      if (ev.t === 'usage.measured') onUsage(b, ev)
      else if (ev.t === 'turn.started' || ev.t === 'turn.completed') onTurn(b, ev)
      else if (ev.t === 'session.rebound') {
        const prev = (ev.d as { prevSid?: unknown } | null)?.prevSid
        if (typeof prev === 'string') ledgerDo((l) => l.close(prev, now()))
      }
    }),
    deps.host.bus.on('lease', (b) => {
      ledgerDo((l) => l.gap(b.sid, now(), 'lease-lost'))
      reconcile()
    }),
    deps.host.bus.on('end', (b) => {
      // the session is over: nothing of the companion's outlives it
      ledgerDo((l) => l.close(b.sid, now()))
      droppedSeen.delete(b.key)
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
