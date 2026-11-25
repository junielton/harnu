/**
 * The mission ledger — Harnu's record of what it did and saw (a dispatch, a worktree cut, a pull
 * request opening or merging, a CI change, a builder ending). Pure: the caller does the reading and
 * the storing (`missions/ledger-store.ts` stores the rows beside the mission). No helper edits or
 * removes a row, and no MCP verb takes a row as input.
 *
 * Missions v4 S-40: the ledger's row type lives here, no longer in the v3 mission module, and the
 * helpers read any mission-shaped value (a v4 record, a converted v3 file) through a small structural
 * type. The kinds `verified` and `owner-transfer` stay in {@link LEDGER_KINDS}: v3 builds wrote them,
 * and a stored row of either kind must still read.
 */

/**
 * The events Harnu itself records on a mission. A row's `kind` is validated against it on every read of
 * the store, so a stray string can never land in the ledger.
 */
export const LEDGER_KINDS = [
  'dispatched',
  'worktree',
  'pr-opened',
  'pr-merged',
  'ci',
  'verified',
  'session-died',
  'compaction',
  'owner-transfer'
] as const
export type LedgerKind = (typeof LEDGER_KINDS)[number]

/** One row of what Harnu did or observed. Written server-side only; the only operation is append. */
export interface LedgerRow {
  at: string
  kind: LedgerKind
  /** The step the event belongs to, when one could be named. */
  stepId?: string
  /** The thing the event is about: a session id, a worktree path, `#<pr>`, a card slug. */
  ref: string
  sessionId?: string
  worktree?: string
  branch?: string
  pr?: number
  /** A short fact: the CI state, the verdict, the folder. */
  detail?: string
}

/** How many rows a read of a mission returns (the most recent). */
export const LEDGER_TAIL = 20

/** A row as its writer states it: `at` is stamped by the store. */
export type LedgerRowInput = Omit<LedgerRow, 'at'>

/** Has a row of this `kind` about `ref` been recorded? */
export function hasLedgerRow(
  mission: { ledger?: readonly LedgerRow[] },
  kind: LedgerKind,
  ref: string
): boolean {
  return (mission.ledger ?? []).some((r) => r.kind === kind && r.ref === ref)
}

/** `detail` of the newest row of this `kind` about `ref`, or `undefined` when there is none. */
export function lastLedgerDetail(
  mission: { ledger?: readonly LedgerRow[] },
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

/** The part of a mission {@link pickLedgerTargets} reads: a v4 record has it, and so does a v3 file. */
export interface LedgerCandidate {
  id: string
  /** Anything but `closed` is open (a v4 record is `open` or `closed`; a v3 file has more). */
  status: string
  steps: ReadonlyArray<{
    id: string
    /** A dispatched v4 step names its board card here. */
    card?: string
    links: ReadonlyArray<{ kind: string; ref: string }>
  }>
}

/**
 * Which mission(s) (and step) an event belongs to. A step that links the event's worktree path, or
 * names the event's card, names both. Failing that, the repo's single open mission gets the row without
 * a step; with several open missions and no link, nobody is guessed — the transport has no per-session
 * identity, and a wrong row in a ledger is worse than a missing one. A closed mission never gets a row.
 */
export function pickLedgerTargets(
  missions: readonly LedgerCandidate[],
  hints: LedgerHints
): LedgerTarget[] {
  const open = missions.filter((m) => m.status !== 'closed')
  const linked: LedgerTarget[] = []
  for (const m of open) {
    for (const s of m.steps) {
      const hit =
        (hints.card !== undefined && s.card === hints.card) ||
        s.links.some(
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
 * The ledger as a reader sees it: the rows written into a v3 mission file (a converted record keeps them)
 * and the rows observed (stored beside the mission by `missions/ledger-store.ts`), in time order. Equal
 * times keep the file's rows first, then the observed ones, so the order never depends on the sort engine.
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
