/**
 * The turn ledger's shell (T389 P1W6 §7.5): files `<userData>/companion/turns/<YYYY-MM>.ndjson`,
 * mode 0600. This is Harnu's own data, one ledger per instance, never a file shared between
 * instances (lesson framework/005): `usage-history.ts` persists under `~/.claude/om2tab/`, a
 * directory every Harnu instance shares, and is deliberately not used here. The ledger honours
 * usage history's opt-out and retention setting. Electron-free: `userData` and the policy are
 * injected, the decisions are in `ingest/turn-ledger-core.ts`.
 *
 * A write that fails is swallowed: the ledger is evidence and calibration input, never a
 * dependency of a session.
 */

import { appendFile, mkdir, readFile, readdir, unlink } from 'node:fs/promises'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AuxUsage } from './contract'
import {
  COST_SETTLE_MS,
  createLedgerCore,
  measuredUsdByDay,
  summarizeLedger,
  type GapWhy,
  type LedgerCore,
  type TurnCompletion,
  type TurnLedgerRecord,
  type UsageReading
} from './ingest/turn-ledger-core'

export type { TurnCompletion, UsageReading }

export const turnLedgerDir = (userData: string): string => join(userData, 'companion', 'turns')

const monthOf = (ms: number): string => new Date(ms).toISOString().slice(0, 7)

export const turnLedgerFile = (userData: string, ms: number): string =>
  join(turnLedgerDir(userData), `${monthOf(ms)}.ndjson`)

export interface LedgerPolicy {
  /** Usage history's capture switch: opted out, nothing is written. */
  enabled: boolean
  /** Usage history's retention, in days. */
  retentionDays: number | 'forever'
}

export interface TurnLedgerDeps {
  userData: string
  now(): number
  policy(): Promise<LedgerPolicy>
  settleMs?: number
}

export interface TurnLedger {
  usage(sid: string, t: number, r: UsageReading): void
  turnStarted(sid: string, t: number, turnId: string, agentId?: string): void
  turnCompleted(sid: string, t: number, c: TurnCompletion): void
  gap(sid: string, t: number, why: GapWhy): void
  close(sid: string, t: number): void
  aux(sid: string, t: number, kind: 'fork' | 'complete' | 'compaction', u: AuxUsage): void
  /** Writes the turns whose settle deadline passed. The shell's interval calls it. */
  tick(): void
  flush(): Promise<void>
  read(): Promise<TurnLedgerRecord[]>
  /** Deletes the month files past the retention window. */
  sweep(): Promise<void>
  /**
   * Measured USD per `(session, local day)` for the sessions the ledger fully covers and whose
   * project `isActive` (the `telemetry` family is `active` for it): the input of calibration.
   */
  calibrationTotals(isActive: (projectPath: string) => boolean): Promise<Map<string, number>>
}

/** Session ids the previous boots ledgered: read once, synchronously, at construction. */
function knownSids(userData: string): Set<string> {
  const out = new Set<string>()
  try {
    const files = readdirSync(turnLedgerDir(userData)).filter((f) =>
      /^\d{4}-\d{2}\.ndjson$/.test(f)
    )
    for (const f of files.sort().slice(-2)) {
      for (const line of readFileSync(join(turnLedgerDir(userData), f), 'utf8').split('\n')) {
        const m = /"sessionId":"([^"]+)"/.exec(line)
        if (m) out.add(m[1]!)
      }
    }
  } catch {
    // no ledger yet
  }
  return out
}

export function createTurnLedger(deps: TurnLedgerDeps): TurnLedger {
  const core: LedgerCore = createLedgerCore({
    settleMs: deps.settleMs ?? COST_SETTLE_MS,
    knownSids: knownSids(deps.userData)
  })
  let chain: Promise<void> = Promise.resolve()

  function write(recs: TurnLedgerRecord[]): void {
    if (recs.length === 0) return
    chain = chain.then(async () => {
      try {
        if (!(await deps.policy()).enabled) return
        const byFile = new Map<string, string>()
        for (const r of recs) {
          const file = turnLedgerFile(deps.userData, r.t)
          byFile.set(file, (byFile.get(file) ?? '') + JSON.stringify(r) + '\n')
        }
        await mkdir(turnLedgerDir(deps.userData), { recursive: true, mode: 0o700 })
        for (const [file, text] of byFile) await appendFile(file, text, { mode: 0o600 })
      } catch {
        // evidence only: a failed write is not a reason to disturb the session
      }
    })
  }

  async function read(): Promise<TurnLedgerRecord[]> {
    await chain
    const out: TurnLedgerRecord[] = []
    try {
      const files = (await readdir(turnLedgerDir(deps.userData)))
        .filter((f) => /^\d{4}-\d{2}\.ndjson$/.test(f))
        .sort()
      for (const f of files) {
        const text = await readFile(join(turnLedgerDir(deps.userData), f), 'utf8')
        for (const line of text.split('\n')) {
          if (!line) continue
          try {
            const r = JSON.parse(line) as TurnLedgerRecord
            if (r && r.v === 1 && typeof r.sessionId === 'string') out.push(r)
          } catch {
            // a torn last line after a crash
          }
        }
      }
    } catch {
      // no ledger yet
    }
    return out
  }

  return {
    usage: (sid, t, r) => write(core.usage(sid, t, r)),
    turnStarted: (sid, t, turnId, agentId) => write(core.turnStarted(sid, t, turnId, agentId)),
    turnCompleted: (sid, t, c) => write(core.turnCompleted(sid, t, c)),
    gap: (sid, t, why) => write(core.gap(sid, t, why)),
    close: (sid, t) => write(core.close(sid, t)),
    aux: (sid, t, kind, u) => write(core.aux(sid, t, kind, u)),
    tick: () => write(core.tick(deps.now())),
    flush: () => chain,
    read,

    async sweep() {
      try {
        const { retentionDays } = await deps.policy()
        if (retentionDays === 'forever') return
        const cutoff = monthOf(deps.now() - retentionDays * 24 * 3_600_000)
        for (const f of await readdir(turnLedgerDir(deps.userData))) {
          const m = /^(\d{4}-\d{2})\.ndjson$/.exec(f)
          if (m && m[1]! < cutoff)
            await unlink(join(turnLedgerDir(deps.userData), f)).catch(() => {})
        }
      } catch {
        // nothing to sweep
      }
    },

    async calibrationTotals(isActive) {
      const records = await read()
      const out = new Map<string, number>()
      for (const [sid, s] of summarizeLedger(records)) {
        if (!s.covered || !isActive(s.projectPath)) continue
        for (const [day, usd] of measuredUsdByDay(records, sid)) out.set(`${sid} ${day}`, usd)
      }
      return out
    }
  }
}

// ---- The app's one ledger ------------------------------------------------------------------

let current: TurnLedger | null = null

/** Called once by `host.ts`; `null` detaches it. */
export function configureTurnLedger(l: TurnLedger | null): void {
  current = l
}
export const turnLedger = (): TurnLedger | null => current

/**
 * Named non-turn usage — a fork, a complete, a compaction — from the result that carries it. P4W4
 * and P4W5 call this with the usage their own request returned; it writes an `aux` record. The
 * dollars of the same request still arrive as a cost delta and are written once, as `other`.
 */
export function recordAuxSpend(rec: {
  kind: 'fork' | 'complete' | 'compaction'
  sid: string
  usage: AuxUsage
  ts: number
}): void {
  try {
    current?.aux(rec.sid, rec.ts, rec.kind, rec.usage)
  } catch {
    // evidence only
  }
}
