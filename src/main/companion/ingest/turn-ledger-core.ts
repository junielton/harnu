/**
 * The per-turn ledger, pure (T389 P1W6 §7.5): from the host's usage readings and turn events it
 * produces the records that say what each main turn used and cost. No I/O, no clock, no Electron:
 * every method takes the host receive time `t`, and `turn-ledger.ts` is the shell that writes the
 * records to `<userData>/companion/turns/`.
 *
 * Tokens are exact (`turn.completed.usage`, smoke D7). Dollars are a measured delta of the
 * cumulative cost, attributed to the main turn it fell in and never to a subagent turn: a
 * subagent's dollars land in its parent's delta. Cost that fell outside any main turn is `other`.
 * The history a resumed session brought along is never attributed: the first reading of a
 * session is a baseline, not a delta. Records hold ids, counts and dollars only.
 */

import type { AuxUsage, TurnUsage } from '../contract'

/** The `measure` follows `turn.complete` by about 13 ms (smoke A4); this is the wait for it. */
export const COST_SETTLE_MS = 2_000

export interface TokenCounts {
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
}

export type GapWhy = 'lease-lost' | 'dropped' | 'host-restart' | 'cost-reset'

export type TurnLedgerRecord =
  | {
      v: 1
      k: 'open'
      t: number
      sessionId: string
      projectPath: string
      costAtOpen: number | null
      fresh: boolean
      /** The mod's `startedAt`, kept for later analysis; it takes no part in `fresh`. */
      startedAt?: number
    }
  | {
      v: 1
      k: 'turn'
      t: number
      sessionId: string
      turnId: string
      agentId?: string
      model: string | null
      tokens: TokenCounts | null
      durationMs: number
      wallMs: number | null
      reason: string
      costUsd: number | null
      costBasis: 'measured' | 'parent' | 'none'
    }
  | { v: 1; k: 'other'; t: number; sessionId: string; costUsd: number }
  | {
      v: 1
      k: 'aux'
      t: number
      sessionId: string
      kind: 'fork' | 'complete' | 'compaction'
      tokens: TokenCounts
    }
  | { v: 1; k: 'gap'; t: number; sessionId: string; why: GapWhy }
  | { v: 1; k: 'close'; t: number; sessionId: string; costAtClose: number | null }

export interface UsageReading {
  costUsd: number | null
  projectPath: string
  startedAt?: number
}

export interface TurnCompletion {
  turnId: string
  agentId?: string
  durationMs: number
  reason: string
  usage?: TurnUsage
  failure?: { type: string }
}

interface Open {
  turnId: string
  startedAt: number | null
  accrued: number
}

interface Settling {
  turnId: string
  completedAt: number
  deadline: number
  accrued: number
  wallMs: number | null
  durationMs: number
  reason: string
  usage: TurnUsage | undefined
}

interface SessionState {
  lastCost: number | null
  open: Open | null
  settling: Settling | null
}

export interface LedgerCore {
  usage(sid: string, t: number, r: UsageReading): TurnLedgerRecord[]
  turnStarted(sid: string, t: number, turnId: string, agentId?: string): TurnLedgerRecord[]
  turnCompleted(sid: string, t: number, c: TurnCompletion): TurnLedgerRecord[]
  /** Writes every turn whose settle deadline has passed. */
  tick(t: number): TurnLedgerRecord[]
  /** Lease loss, dropped events, a cost reset: a gap, and the session's in-memory state is gone. */
  gap(sid: string, t: number, why: GapWhy): TurnLedgerRecord[]
  /** A rebound or a session end. */
  close(sid: string, t: number): TurnLedgerRecord[]
  aux(
    sid: string,
    t: number,
    kind: 'fork' | 'complete' | 'compaction',
    u: AuxUsage
  ): TurnLedgerRecord[]
  hasState(sid: string): boolean
}

const counts = (u: AuxUsage): TokenCounts => ({
  input: u.inputTokens,
  output: u.outputTokens,
  cacheRead: u.cacheReadTokens,
  cacheCreation: u.cacheCreationTokens
})

export function createLedgerCore(
  opts: {
    settleMs?: number
    /** Sessions the previous boot already ledgered: their first reading here follows a restart. */
    knownSids?: ReadonlySet<string>
  } = {}
): LedgerCore {
  const settleMs = opts.settleMs ?? COST_SETTLE_MS
  const sessions = new Map<string, SessionState>()
  const restarted = new Set(opts.knownSids ?? [])

  const stateOf = (sid: string): SessionState => {
    let s = sessions.get(sid)
    if (!s) sessions.set(sid, (s = { lastCost: null, open: null, settling: null }))
    return s
  }

  function writeSettling(sid: string, s: SessionState): TurnLedgerRecord[] {
    const w = s.settling
    if (!w) return []
    s.settling = null
    const hasCost = s.lastCost !== null
    return [
      {
        v: 1,
        k: 'turn',
        t: w.completedAt,
        sessionId: sid,
        turnId: w.turnId,
        model: w.usage?.model ?? null,
        tokens: w.usage ? counts(w.usage) : null,
        durationMs: w.durationMs,
        wallMs: w.wallMs,
        reason: w.reason,
        costUsd: hasCost ? w.accrued : null,
        costBasis: hasCost ? 'measured' : 'none'
      }
    ]
  }

  return {
    usage(sid, t, r) {
      const out: TurnLedgerRecord[] = []
      const s = stateOf(sid)
      if (r.costUsd === null) return out
      if (restarted.delete(sid) && s.lastCost === null) {
        out.push({ v: 1, k: 'gap', t, sessionId: sid, why: 'host-restart' })
      }
      const c = r.costUsd
      if (s.lastCost === null) {
        // The baseline: a resumed session's history is never attributed (smoke A2).
        s.lastCost = c
        out.push({
          v: 1,
          k: 'open',
          t,
          sessionId: sid,
          projectPath: r.projectPath,
          costAtOpen: c,
          fresh: c === 0,
          ...(r.startedAt !== undefined ? { startedAt: r.startedAt } : {})
        })
        return out
      }
      const delta = c - s.lastCost
      if (delta < 0) {
        s.lastCost = c
        out.push({ v: 1, k: 'gap', t, sessionId: sid, why: 'cost-reset' })
        return out
      }
      s.lastCost = c
      if (s.settling) {
        s.settling.accrued += delta
        out.push(...writeSettling(sid, s))
      } else if (s.open) {
        s.open.accrued += delta
      } else if (delta > 0) {
        out.push({ v: 1, k: 'other', t, sessionId: sid, costUsd: delta })
      }
      return out
    },

    turnStarted(sid, t, turnId, agentId) {
      if (agentId !== undefined) return [] // a subagent's own edges carry no cost of their own
      const s = stateOf(sid)
      const out = writeSettling(sid, s)
      s.open = { turnId, startedAt: t, accrued: 0 }
      return out
    },

    turnCompleted(sid, t, c) {
      const s = stateOf(sid)
      if (c.agentId !== undefined) {
        // written at once: its dollars are in the parent's delta (smoke D7)
        return [
          {
            v: 1,
            k: 'turn',
            t,
            sessionId: sid,
            turnId: c.turnId,
            agentId: c.agentId,
            model: c.usage?.model ?? null,
            tokens: c.usage ? counts(c.usage) : null,
            durationMs: c.durationMs,
            wallMs: null,
            reason: c.reason,
            costUsd: null,
            costBasis: 'parent'
          }
        ]
      }
      const out = writeSettling(sid, s)
      const open = s.open && s.open.turnId === c.turnId ? s.open : null
      s.open = null
      s.settling = {
        turnId: c.turnId,
        completedAt: t,
        deadline: t + settleMs,
        accrued: open?.accrued ?? 0,
        wallMs: open?.startedAt != null ? t - open.startedAt : null,
        durationMs: c.durationMs,
        reason: c.reason,
        usage: c.usage
      }
      return out
    },

    tick(t) {
      const out: TurnLedgerRecord[] = []
      for (const [sid, s] of sessions) {
        if (s.settling && t > s.settling.deadline) out.push(...writeSettling(sid, s))
      }
      return out
    },

    gap(sid, t, why) {
      if (!sessions.has(sid)) return []
      sessions.delete(sid)
      return [{ v: 1, k: 'gap', t, sessionId: sid, why }]
    },

    close(sid, t) {
      const s = sessions.get(sid)
      if (!s) return []
      const out = writeSettling(sid, s)
      sessions.delete(sid)
      out.push({ v: 1, k: 'close', t, sessionId: sid, costAtClose: s.lastCost })
      return out
    },

    aux(sid, t, kind, u) {
      return [{ v: 1, k: 'aux', t, sessionId: sid, kind, tokens: counts(u) }]
    },

    hasState: (sid) => sessions.has(sid)
  }
}

// ---- Reading a ledger back: coverage and measured dollars ------------------------------------

export interface LedgerSummary {
  /** `open { fresh: true }` and no `gap` anywhere in the session's records. */
  covered: boolean
  projectPath: string
}

/**
 * Which sessions the ledger fully covers. Whether `telemetry` is `active` is the caller's call,
 * per project, at the moment of use: the ledger is written in `shadow` and `active` alike.
 */
export function summarizeLedger(records: readonly TurnLedgerRecord[]): Map<string, LedgerSummary> {
  const out = new Map<string, LedgerSummary & { sawFresh: boolean; sawGap: boolean }>()
  for (const r of records) {
    let s = out.get(r.sessionId)
    if (!s)
      out.set(
        r.sessionId,
        (s = { covered: false, projectPath: '', sawFresh: false, sawGap: false })
      )
    if (r.k === 'open') {
      if (r.fresh) s.sawFresh = true
      if (r.projectPath) s.projectPath = r.projectPath
    }
    if (r.k === 'gap') s.sawGap = true
    s.covered = s.sawFresh && !s.sawGap
  }
  return new Map([...out].map(([k, v]) => [k, { covered: v.covered, projectPath: v.projectPath }]))
}

/** Local-timezone `YYYY-MM-DD`, the key the Usage Dashboard's buckets use (`localDayKey`). */
export function localDay(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * Measured USD per local day for one session: the sum of its `turn` and `other` records. `aux`
 * records name tokens, never dollars: the dollars of the same request are in a delta already, so
 * nothing is counted twice.
 */
export function measuredUsdByDay(
  records: readonly TurnLedgerRecord[],
  sid: string
): Map<string, number> {
  const out = new Map<string, number>()
  for (const r of records) {
    if (r.sessionId !== sid) continue
    if (r.k !== 'turn' && r.k !== 'other') continue
    const usd = r.costUsd
    if (usd === null) continue
    const day = localDay(r.t)
    out.set(day, (out.get(day) ?? 0) + usd)
  }
  return out
}
