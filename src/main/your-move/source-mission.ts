/**
 * The mission source: what a mission still owes the operator, as cards.
 *
 * A mission card is a pointer. It never writes to the mission: the operator's doors stay where
 * they are, and the card closes when the record stops owing the item. It reuses the list the
 * renderer already polls, so no extra GitHub budget is spent.
 *
 * Pure: the caller hands over the list result and gets the next state back.
 */

import type { MissionListResult } from '../mission-ipc'
import { repoRoot } from '../data-dir'
import { leaderOf as leaderOfRecord } from '../missions/guard'
import { reportUnreadableMissionFiles } from '../missions/store'
import type { MissionYouItem, WaitingItemV4 } from '../missions/waiting'
import type { MissionDetail } from '../missions/verbs-read'
import {
  reconcileSource,
  type CardKind,
  type CardLane,
  type StructuredDraft,
  type YourMoveCard,
  type YourMoveState
} from './core'

/** What the cards read of a mission: where it lives, who leads it and the one waiting list. */
export interface DraftView {
  root: string
  mission: { id: string; owner: { sessionId: string } }
  you: readonly WaitingItemV4[]
}

/** The card kind and the key suffix of one owed item; null for the ones that file no card. */
function mapping(item: WaitingItemV4): { kind: CardKind; suffix: string } {
  switch (item.kind) {
    // A blocker's `blk-N` is a position and a v3 record renumbers it when a neighbour is cleared, so its card
    // is keyed as main keyed a v3 blocker: by its words (`blocker:<reason>`). Clearing a neighbour never
    // closes and re-files it, and updating Harnu does not re-file what main already had.
    case 'unblock':
      return { kind: 'do', suffix: `blocker:${item.ask}` }
    case 'main-failing':
      return { kind: 'do', suffix: item.id }
    // A re-scope an older mission staged: Approve or Decline, as before (its key is the one main filed it under).
    case 'rescope':
      return { kind: 'go_no_go', suffix: item.id }
    case 'settle':
    case 'review':
      return { kind: 'check', suffix: item.id }
    case 'close':
    case 'attach':
      return { kind: 'go_no_go', suffix: item.id }
  }
}

export function missionDrafts(view: DraftView, lane: CardLane): StructuredDraft[] {
  const drafts: StructuredDraft[] = []
  const keys = new Set<string>()
  for (const item of view.you) {
    const m = mapping(item)
    // Two items with the same key are one card (main's v3 blockers with the same reason were too).
    if (keys.has(m.suffix)) continue
    keys.add(m.suffix)
    drafts.push({
      sessionId: view.mission.owner.sessionId,
      folder: view.root,
      kind: m.kind,
      ask: item.ask,
      source: 'mission',
      sourceKey: `${view.mission.id}:${m.suffix}`,
      lane,
      // `MissionPointer.item` (core.ts) is typed as a v3 item; nothing reads it, so a v4 item rides along.
      mission: {
        missionId: view.mission.id,
        root: view.root,
        item: item as unknown as MissionYouItem
      }
    })
  }
  return drafts
}

/**
 * Make the open mission cards match what the missions owe now. A mission that is absent from
 * the result under a queried root was ended: its cards close. Nothing is closed by absence
 * while any mission file failed to parse, because the missing mission may be that very file.
 */
export function reconcileMissions(
  s: YourMoveState,
  result: Pick<MissionListResult, 'unreadable'>,
  queriedRoots: readonly string[],
  lane: CardLane,
  mintId: () => string,
  now: number,
  explicit?: RecordViews
): YourMoveState {
  let next = s
  // The records are read after this pass and used by the next one (the list poll is the clock).
  if (explicit === undefined) void refreshRecordViews(queriedRoots)
  // Only the roots this pass is about: a root nobody queries now files no card, whatever the cache holds.
  const asked = new Set(queriedRoots)
  const records = new Map([...(explicit ?? lastRecordViews)].filter(([root]) => asked.has(root)))
  const present = new Set<string>()
  // Every mission is read from the records, whichever file holds it (a v3 file is read in memory): the list
  // poll no longer carries a v3 view of it (S-40), so a mission that still lives in a v3 file files the same
  // cards as any other, worded once by the waiting list.
  const views: DraftView[] = [...records.values()]
    .flatMap((r) => r.views)
    .filter((v) => !ownerArchived(v.mission.owner.sessionId))
  const unreadable = result.unreadable.length > 0 || [...records.values()].some((r) => r.unreadable)
  for (const v of views) {
    present.add(v.mission.id)
    next = reconcileSource(
      next,
      { source: 'mission', missionIds: [v.mission.id] },
      missionDrafts(v, lane),
      mintId,
      now
    )
  }
  if (unreadable) return dedupeOpenMissionCards(next, now)
  // A root whose records are not read yet (the first poll after a start) says nothing about a v4 record: its
  // cards are not in the list's v3 views, so closing "what is absent" would close them, and the next poll would
  // file them again. Nothing closes by absence there until the records have been read.
  const roots = new Set(queriedRoots.filter((r) => records.has(r)))
  const gone = [
    ...new Set(
      next.cards
        .filter(
          (c) =>
            c.closedAt === undefined &&
            c.source === 'mission' &&
            c.mission !== undefined &&
            roots.has(c.mission.root) &&
            !present.has(c.mission.missionId)
        )
        .map((c) => (c.mission as { missionId: string }).missionId)
    )
  ]
  if (gone.length === 0) return dedupeOpenMissionCards(next, now)
  return dedupeOpenMissionCards(
    reconcileSource(next, { source: 'mission', missionIds: gone }, [], mintId, now),
    now
  )
}

/**
 * One open card per key: when an earlier build left two open mission cards for one `sourceKey`, the older stays
 * and the others close as resolved. Nothing else is touched, so an upgrade closes and re-files nothing.
 */
function dedupeOpenMissionCards(s: YourMoveState, now: number): YourMoveState {
  const seen = new Map<string, YourMoveCard>()
  const drop = new Set<string>()
  for (const c of s.cards) {
    if (c.closedAt !== undefined || c.source !== 'mission' || c.sourceKey === undefined) continue
    const first = seen.get(c.sourceKey)
    if (first === undefined) seen.set(c.sourceKey, c)
    else if (c.openedAt < first.openedAt) {
      drop.add(first.id)
      seen.set(c.sourceKey, c)
    } else drop.add(c.id)
  }
  if (drop.size === 0) return s
  return {
    ...s,
    cards: s.cards.map((c) =>
      drop.has(c.id) ? { ...c, closedAt: now, closedBy: 'source-resolved' as const } : c
    )
  }
}

/**
 * Which missions the queue follows this poll. A mission whose owner session is archived leaves
 * the pass (its cards were closed by the archive and must not come back), and a folder
 * switched off leaves it altogether: its views AND its root, so the cards it already holds are
 * neither refreshed nor read as "the mission ended". Absent is not the same as switched off.
 */
export function selectForReconcile(
  result: Pick<MissionListResult, 'unreadable'>,
  roots: readonly string[],
  off: { ownerArchived(sessionId: string): boolean; folderOff(root: string): boolean }
): { result: Pick<MissionListResult, 'unreadable'>; roots: string[] } {
  // The poll no longer carries views to filter (S-40): the owner test applies where the records are read.
  ownerArchived = off.ownerArchived
  return {
    result: { unreadable: result.unreadable },
    roots: roots.filter((r) => !off.folderOff(r))
  }
}

/** Whether a session's cards are off the queue because the session is archived: set by the latest selection. */
let ownerArchived: (sessionId: string) => boolean = () => false

/** What the record store answered for one repo root: its open missions as card views. */
export interface RecordRead {
  /** The open records of the repo, a mission still in a v3 file included (the store reads it in memory). */
  views: DraftView[]
  /** A file the store could not parse: nothing closes by absence while one exists. */
  unreadable: boolean
}
export type RecordViews = ReadonlyMap<string, RecordRead>

/** The last answer of {@link readRecordViews} {@link refreshRecordViews} kept, per root. */
let lastRecordViews: RecordViews = new Map()

/** The cache {@link refreshRecordViews} keeps: what the next pass reads (a test passes it back explicitly). */
export const currentRecordViews = (): RecordViews => lastRecordViews

type DetailRead = MissionDetail | { ok: false } | null

async function defaultReadDetail(folder: string, missionId: string): Promise<DetailRead> {
  const { buildMissionV4View } = await import('../mission-ipc')
  const reply = await buildMissionV4View({ folder, sessionId: 'harnu-your-move', missionId })
  return reply.state === 'mission' ? reply.detail : null
}

/**
 * Missions v4 S-23 — what each repo's open missions owe, read through the record store (a v4 record, or a
 * v3 file converted in memory) and worded once by the waiting list. Reads only. A mission nobody leads any
 * more files nothing (a card needs a session to open).
 */
export async function readRecordViews(
  roots: readonly string[],
  opts: { readDetail?: (folder: string, missionId: string) => Promise<DetailRead> } = {}
): Promise<RecordViews> {
  const readDetail = opts.readDetail ?? defaultReadDetail
  const { listMissionRecords } = await import('../missions/record-store')
  const out = new Map<string, RecordRead>()
  const unreadableFiles: string[] = []
  for (const root of new Set(roots.map((r) => repoRoot(r)))) {
    const listed = await listMissionRecords(root)
    const views: DraftView[] = []
    for (const { record, sourceIds } of listed.records) {
      if (record.status !== 'open') continue
      // Who leads is the record's own rule (`leaderOf`, the one hibernation uses): the session with an open
      // `leads` entry. A mission nobody leads files nothing: a session that already left is not handed a
      // card. A v3 record's owner leads it until it is closed (the conversion writes that entry).
      const leader = leaderOfRecord(record)
      if (!leader) continue
      const detail = await readDetail(root, sourceIds[0] ?? record.id)
      if (!detail || !detail.ok) continue
      views.push({
        root,
        mission: { id: record.id, owner: { sessionId: leader } },
        you: detail.waiting.items
      })
    }
    out.set(root, { views, unreadable: listed.unreadable.length > 0 })
    unreadableFiles.push(...listed.unreadable)
  }
  // A file the store could not parse is named to the app's unreadable list: never a silent skip.
  reportUnreadableMissionFiles('your-move', unreadableFiles)
  return out
}

let refreshing: Promise<void> | null = null
/** The roots of the latest query: what the next read is for, whichever caller asked first. */
let latestRoots: readonly string[] = []
let again = false

/**
 * Read the records for `roots` and keep the answer for the next {@link reconcileMissions}. Single flight,
 * never throws: a failed read keeps the last good answer. Only the roots of the LATEST query are kept: a
 * query that arrives while a read is running makes it run once more for the new roots, and the answer
 * replaces the cache whole, so a root nobody asks about any more files no card. The list poll that
 * triggers it is its only clock.
 */
export function refreshRecordViews(
  roots: readonly string[],
  opts: { readDetail?: (folder: string, missionId: string) => Promise<DetailRead> } = {}
): Promise<void> {
  latestRoots = roots
  if (refreshing) {
    again = true
    return refreshing
  }
  refreshing = (async () => {
    try {
      do {
        again = false
        try {
          lastRecordViews = await readRecordViews(latestRoots, opts)
        } catch {
          // A failed read keeps the last good answer, and is never silent: the folders it could not read
          // are named to the app's unreadable list (a thrown read has no single file to name, so the
          // directory of the records stands for it), where one Activity notice names them.
          reportUnreadableMissionFiles(
            'your-move',
            latestRoots.map((r) => `${repoRoot(r)}/.harnu/missions-v4`)
          )
        }
      } while (again)
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}
