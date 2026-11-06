/**
 * Campaign spec §3.2 — the mission ledger helpers. Pure: the caller does the locked
 * read → append → write. The ledger is Harnu's record of what it did and saw, so the
 * only operation is {@link appendLedgerRow}; no helper edits or removes a row, and no
 * MCP verb takes a row as input.
 */
import type { LedgerKind, LedgerRow, Mission } from './mission-core'

/** How many rows `mission_get` returns (the most recent). */
export const LEDGER_TAIL = 20

/** A row as its writer states it: `at` is stamped here. */
export type LedgerRowInput = Omit<LedgerRow, 'at'>

/** Append one row. Returns a copy; the input mission is untouched. */
export function appendLedgerRow(
  mission: Mission,
  row: LedgerRowInput,
  at: string = new Date().toISOString()
): Mission {
  const next = structuredClone(mission)
  next.ledger = [...(next.ledger ?? []), { at, ...row }]
  return next
}

/** The last {@link LEDGER_TAIL} rows, oldest first; `[]` for a mission with no ledger. */
export function ledgerTail(mission: Pick<Mission, 'ledger'>, n: number = LEDGER_TAIL): LedgerRow[] {
  return (mission.ledger ?? []).slice(-n)
}

/** Has a row of this `kind` about `ref` been recorded? */
export function hasLedgerRow(
  mission: Pick<Mission, 'ledger'>,
  kind: LedgerKind,
  ref: string
): boolean {
  return (mission.ledger ?? []).some((r) => r.kind === kind && r.ref === ref)
}

/** `detail` of the newest row of this `kind` about `ref`, or `undefined` when there is none. */
export function lastLedgerDetail(
  mission: Pick<Mission, 'ledger'>,
  kind: LedgerKind,
  ref: string
): string | undefined {
  const rows = mission.ledger ?? []
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].kind === kind && rows[i].ref === ref) return rows[i].detail
  }
  return undefined
}

/** What a write-time event knows about itself, to find the mission it belongs to. */
export interface LedgerHints {
  /** The folder the session / worktree was created in. */
  folder?: string
  /** A board card slug. */
  card?: string
  /** A branch name. */
  branch?: string
}

export interface LedgerTarget {
  missionId: string
  stepId?: string
}

/**
 * Which mission(s) (and step) an event belongs to. A step that links the event's
 * worktree path or card names both. Failing that, the repo's single open mission
 * gets the row without a step; with several open missions and no link, nobody is
 * guessed — the transport has no per-session identity, and a wrong row in a ledger
 * is worse than a missing one. A closed mission never receives a row.
 */
export function pickLedgerTargets(
  missions: readonly Mission[],
  hints: LedgerHints
): LedgerTarget[] {
  const open = missions.filter((m) => m.status !== 'closed')
  const linked: LedgerTarget[] = []
  for (const m of open) {
    for (const s of m.steps) {
      const hit = s.links.some(
        (l) =>
          (l.kind === 'worktree' && hints.folder !== undefined && l.ref === hints.folder) ||
          (l.kind === 'card' && hints.card !== undefined && l.ref === hints.card)
      )
      if (hit) {
        linked.push({ missionId: m.id, stepId: s.id })
        break
      }
    }
  }
  if (linked.length > 0) return linked
  return open.length === 1 ? [{ missionId: open[0].id }] : []
}

/**
 * The ledger as `mission_get` reads it: the rows written into the mission file
 * (dispatch, worktree, manifest, verdict, compaction) and the rows observed while
 * reading it (kept beside the link cache), in time order. Equal times keep the file's
 * rows first, then the observed ones, so the order never depends on the sort engine.
 */
export function mergeLedger(
  file: readonly LedgerRow[] | undefined,
  observed: readonly LedgerRow[]
): LedgerRow[] {
  return [...(file ?? []), ...observed]
    .map((row, i) => ({ row, i, t: Date.parse(row.at) }))
    .sort((a, b) =>
      Number.isFinite(a.t) && Number.isFinite(b.t) && a.t !== b.t ? a.t - b.t : a.i - b.i
    )
    .map((x) => x.row)
}
