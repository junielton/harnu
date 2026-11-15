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
import { describeWaiting, type MissionYouItem, type WaitingItemV4 } from '../missions/waiting'
import type { MissionDetail } from '../missions/verbs-read'
import {
  reconcileSource,
  type CardKind,
  type CardLane,
  type StructuredDraft,
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
      case 'main-failing':
      case 'unblock':
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
  for (const item of view.you) {
    const m = mapping(item)
    if (!m) continue
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
  records: RecordViews = lastRecordViews
): YourMoveState {
  let next = s
  // The records are read after this pass and used by the next one (the list poll is the clock).
  if (records === lastRecordViews) void refreshRecordViews(queriedRoots)
  const present = new Set<string>()
  // A root the record store answered for is read from the records alone (one format at a time: a v3
  // snapshot beside a v4 copy says nothing). A root it has not answered for yet — the first poll —
  // keeps the list's views, so there is no gap while the first read runs.
  const covered = new Set(records.keys())
  const views: DraftView[] = [
    ...result.views.filter((v) => !covered.has(v.root)),
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
  if (unreadable) return next
  const roots = new Set(queriedRoots)
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
  if (gone.length === 0) return next
  return reconcileSource(next, { source: 'mission', missionIds: gone }, [], mintId, now)
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
  views: DraftView[]
  /** A file the store could not parse: nothing closes by absence while one exists. */
  unreadable: boolean
}
export type RecordViews = ReadonlyMap<string, RecordRead>

/** The last answer of {@link readRecordViews} {@link refreshRecordViews} kept, per root. */
let lastRecordViews: RecordViews = new Map()

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
    for (const { record, source, sourceIds } of listed.records) {
      if (record.status !== 'open') continue
      const leader =
        record.sessions.find((e) => e.role === 'leads' && e.to === null)?.id ??
        record.sessions[record.sessions.length - 1]?.id
      if (!leader) continue
      const detail = await readDetail(
        root,
        source === 'v3-campaign' ? (sourceIds[0] ?? record.id) : record.id
      )
      if (!detail || !detail.ok) continue
      views.push({
        root,
        mission: { id: record.id, owner: { sessionId: leader } },
        you: detail.waiting.items
      })
    }
    out.set(root, { views, unreadable: listed.unreadable.length > 0 })
  }
  return out
}

let refreshing: Promise<void> | null = null

/**
 * Read the records for `roots` and keep the answer for the next {@link reconcileMissions}. Single flight,
 * never throws: a failed read keeps the last good answer. The list poll that triggers it is its only clock.
 */
export function refreshRecordViews(roots: readonly string[]): Promise<void> {
  refreshing ??= readRecordViews(roots)
    .then((r) => {
      lastRecordViews = new Map([...lastRecordViews, ...r])
    })
    .catch(() => undefined)
    .finally(() => {
      refreshing = null
    })
  return refreshing
}
