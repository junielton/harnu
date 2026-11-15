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
import { describeWaiting, type MissionYouItem, type WaitingItemV4 } from '../missions/waiting'
import type { MissionDetail } from '../missions/verbs-read'
import {
  reconcileSource,
  type CardKind,
  type CardLane,
  type StructuredDraft,
  type YourMoveCard,
  type YourMoveState
} from './core'

/** One owed item: a v3 item (a list that still serves v3 views) or a v4 waiting item. */
type OwedItem = MissionYouItem | WaitingItemV4

/** What the cards read of a mission: where it lives, who leads it and the one waiting list. */
export interface DraftView {
  root: string
  mission: { id: string; owner: { sessionId: string } }
  you: readonly OwedItem[]
}

/**
 * The words of one item: a v4 item carries its own `ask`, and a v3 item is worded by `describeWaiting`.
 * There is no second wording here (S-23 retired `youSentence` for this reader).
 */
const askOf = (item: OwedItem): string => ('ask' in item ? item.ask : describeWaiting(item).ask)

/** The card kind and the key suffix of one owed item; null for the ones that file no card. */
function mapping(item: OwedItem): { kind: CardKind; suffix: string } | null {
  if ('ask' in item) {
    switch (item.kind) {
      // A blocker's `blk-N` is a position and a v3 record renumbers it when a neighbour is cleared, so its card
      // is keyed as main keyed a v3 blocker: by its words (`blocker:<reason>`). Clearing a neighbour never
      // closes and re-files it, and updating Harnu does not re-file what main already had.
      case 'unblock':
        return { kind: 'do', suffix: `blocker:${item.ask}` }
      case 'main-failing':
        return { kind: 'do', suffix: item.id }
      case 'settle':
      case 'review':
        return { kind: 'check', suffix: item.id }
      case 'close':
      case 'attach':
        return { kind: 'go_no_go', suffix: item.id }
    }
  }
  switch (item.kind) {
    case 'rescope':
      return { kind: 'go_no_go', suffix: `rescope:${item.end.target}` }
    case 'close':
      return { kind: 'go_no_go', suffix: 'close' }
    case 'steward-paused':
      return { kind: 'do', suffix: 'steward-paused' }
    case 'blocker':
      return { kind: 'do', suffix: `blocker:${item.reason}` }
    case 'decide':
      return { kind: 'decide', suffix: `decide:${item.stepId}` }
    case 'checks':
      return { kind: 'check', suffix: 'checks' }
    case 'human-steps':
      return { kind: 'check', suffix: 'human-steps' }
    case 'review-import':
      return { kind: 'check', suffix: 'review-import' }
    case 'main-red':
      return { kind: 'do', suffix: `main-red:${item.stepId}` }
    // A child's approvals and needs-input already have a card of their own, in the child.
    case 'approvals':
    case 'needs-input':
      return null
  }
}

export function missionDrafts(view: DraftView, lane: CardLane): StructuredDraft[] {
  const drafts: StructuredDraft[] = []
  const keys = new Set<string>()
  for (const item of view.you) {
    const m = mapping(item)
    if (!m) continue
    // Two items with the same key are one card (main's v3 blockers with the same reason were too).
    if (keys.has(m.suffix)) continue
    keys.add(m.suffix)
    drafts.push({
      sessionId: view.mission.owner.sessionId,
      folder: view.root,
      kind: m.kind,
      ask: askOf(item),
      source: 'mission',
      sourceKey: `${view.mission.id}:${m.suffix}`,
      lane,
      // `MissionPointer.item` (core.ts) is typed as a v3 item; nothing reads it, so a v4 item rides along.
      mission: { missionId: view.mission.id, root: view.root, item: item as MissionYouItem }
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
  result: Pick<MissionListResult, 'views' | 'unreadable'>,
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
  // A v3 mission keeps main's cards: the list's own view of it (its items, its keys, as `mapping` maps them)
  // is what files them, so updating Harnu closes and re-files nothing. Only a mission the record store says
  // is a v4 record is read from the records: a v4 file is the mission (one format at a time), so a v3
  // snapshot beside it says nothing. A root the store has not answered for yet (the first poll) is all v3.
  const v4Ids = new Set([...records.values()].flatMap((r) => [...r.v4Ids]))
  const views: DraftView[] = [
    ...result.views.filter((v) => !v4Ids.has(v.mission.id)),
    ...[...records.values()].flatMap((r) => r.views)
  ]
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
  result: Pick<MissionListResult, 'views' | 'unreadable'>,
  roots: readonly string[],
  off: { ownerArchived(sessionId: string): boolean; folderOff(root: string): boolean }
): { result: Pick<MissionListResult, 'views' | 'unreadable'>; roots: string[] } {
  const views = result.views.filter(
    (v) => !off.ownerArchived(v.mission.owner.sessionId) && !off.folderOff(v.root)
  )
  return {
    result: { views, unreadable: result.unreadable },
    roots: roots.filter((r) => !off.folderOff(r))
  }
}

/** What the record store answered for one repo root: its open missions as card views. */
export interface RecordRead {
  /** The open v4 records of the repo (a v3 file is not here: the list's own view files its cards). */
  views: DraftView[]
  /** Every v4 record's id, open or closed: the v3 snapshot of such an id says nothing. */
  v4Ids: ReadonlySet<string>
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
  for (const root of new Set(roots.map((r) => repoRoot(r)))) {
    const listed = await listMissionRecords(root)
    const views: DraftView[] = []
    const v4Ids = new Set<string>()
    for (const { record, source, sourceIds } of listed.records) {
      // A v3 file keeps main's cards (they come from the list's v3 view, see `reconcileMissions`): reading
      // its converted waiting list would close the cards main filed and file others, and a v3 file cannot
      // hold a request to join (that lives in a v4 record), so there is nothing to add from here.
      if (source !== 'v4') continue
      v4Ids.add(record.id)
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
    out.set(root, { views, v4Ids, unreadable: listed.unreadable.length > 0 })
  }
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
          /* a failed read keeps the last good answer */
        }
      } while (again)
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}
