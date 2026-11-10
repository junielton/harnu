/**
 * The pure planner behind the `archive_session` verb (T655): one outcome row per session
 * id, decided from plain lookups so every branch is testable without electron or fs.
 *
 * Order per id: `notFound` (no such session), then `refused` for a blocked folder, then
 * (archiving only) a `working` session, then (archiving only) a parked approval, then (archiving only) an open Your move card; only then
 * the idempotent archive / restore outcomes. An id that is already archived reads
 * `alreadyArchived` even when its session is busy: nothing would change, so nothing is refused.
 */

export type ArchiveOutcome =
  'archived' | 'alreadyArchived' | 'restored' | 'alreadyActive' | 'notFound' | 'refused'

export type ArchiveRefusal =
  'FOLDER_NOT_ALLOWED' | 'SESSION_WORKING' | 'PENDING_APPROVAL' | 'OPEN_CARDS'

export interface ArchiveRow {
  sessionId: string
  outcome: ArchiveOutcome
  /** Present exactly when `outcome` is `refused`. */
  reason?: ArchiveRefusal
}

export interface ArchivePlanDeps {
  /** The archive set right now. */
  archived: ReadonlySet<string>
  /** The folder a session lives in, or `undefined` when no such session exists. */
  folderOf: (sessionId: string) => string | undefined
  /** Whether the operator blocked this folder for agents. */
  isDenied: (folder: string) => boolean
  /** The session's live task state (`working`, `idle`, ...), if any. */
  taskStateOf: (sessionId: string) => string | undefined
  /** Whether an approval is parked for the session right now. */
  hasPendingApproval: (sessionId: string) => boolean
  /**
   * Whether the operator still owes the session something (an open Your move card). An agent's
   * archive must never close a card, so such a session is refused. Absent means no cards.
   */
  hasOpenCard?: (sessionId: string) => boolean
}

export interface ArchivePlan {
  rows: ArchiveRow[]
  /** Ids to add to the archive set. */
  toArchive: string[]
  /** Ids to drop from the archive set. */
  toRestore: string[]
}

export function planArchiveSession(
  sessionIds: readonly string[],
  unarchive: boolean,
  deps: ArchivePlanDeps
): ArchivePlan {
  const rows: ArchiveRow[] = []
  const toArchive: string[] = []
  const toRestore: string[] = []
  const seen = new Set<string>()

  for (const sessionId of sessionIds) {
    if (seen.has(sessionId)) continue
    seen.add(sessionId)

    const folder = deps.folderOf(sessionId)
    if (folder === undefined) {
      rows.push({ sessionId, outcome: 'notFound' })
      continue
    }
    if (deps.isDenied(folder)) {
      rows.push({ sessionId, outcome: 'refused', reason: 'FOLDER_NOT_ALLOWED' })
      continue
    }

    const isArchived = deps.archived.has(sessionId)
    if (unarchive) {
      if (isArchived) {
        rows.push({ sessionId, outcome: 'restored' })
        toRestore.push(sessionId)
      } else {
        rows.push({ sessionId, outcome: 'alreadyActive' })
      }
      continue
    }

    if (isArchived) {
      rows.push({ sessionId, outcome: 'alreadyArchived' })
      continue
    }
    if (deps.taskStateOf(sessionId) === 'working') {
      rows.push({ sessionId, outcome: 'refused', reason: 'SESSION_WORKING' })
      continue
    }
    if (deps.hasPendingApproval(sessionId)) {
      rows.push({ sessionId, outcome: 'refused', reason: 'PENDING_APPROVAL' })
      continue
    }
    if (deps.hasOpenCard?.(sessionId)) {
      rows.push({ sessionId, outcome: 'refused', reason: 'OPEN_CARDS' })
      continue
    }
    rows.push({ sessionId, outcome: 'archived' })
    toArchive.push(sessionId)
  }

  return { rows, toArchive, toRestore }
}

/** `archive 2 archived, 1 notFound`: counts only, for the audit row (never a title or a path). */
export function summarizeArchive(unarchive: boolean, rows: readonly ArchiveRow[]): string {
  const counts = new Map<ArchiveOutcome, number>()
  for (const r of rows) counts.set(r.outcome, (counts.get(r.outcome) ?? 0) + 1)
  const parts = [...counts].map(([outcome, n]) => `${n} ${outcome}`)
  return `${unarchive ? 'unarchive' : 'archive'} ${parts.join(', ')}`
}
