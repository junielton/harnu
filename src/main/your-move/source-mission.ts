/**
 * The mission source: what a mission still owes the operator, as cards.
 *
 * A mission card is a pointer. It never writes to the mission: the operator's doors stay where
 * they are, and the card closes when the record stops owing the item. It reuses the list the
 * renderer already polls, so no extra GitHub budget is spent.
 *
 * Pure: the caller hands over the list result and gets the next state back.
 */

import type { MissionListResult, MissionView } from '../mission-ipc'
import { youSentence, type MissionYouItem } from '../mcp/tool-handlers'
import {
  reconcileSource,
  type CardKind,
  type CardLane,
  type StructuredDraft,
  type YourMoveState
} from './core'

/** The card kind and the key suffix of one owed item; null for the ones that file no card. */
function mapping(item: MissionYouItem): { kind: CardKind; suffix: string } | null {
  switch (item.kind) {
    case 'rescope':
      return { kind: 'go_no_go', suffix: `rescope:${item.end.target}` }
    case 'close':
      return { kind: 'go_no_go', suffix: 'close' }
    case 'steward-paused':
      return { kind: 'do', suffix: 'steward-paused' }
    case 'blocker':
      return { kind: 'do', suffix: `blocker:${item.reason}` }
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

export function missionDrafts(
  view: Pick<MissionView, 'root' | 'mission' | 'you'>,
  lane: CardLane
): StructuredDraft[] {
  const drafts: StructuredDraft[] = []
  for (const item of view.you) {
    const m = mapping(item)
    if (!m) continue
    drafts.push({
      sessionId: view.mission.owner.sessionId,
      folder: view.root,
      kind: m.kind,
      ask: youSentence(item),
      source: 'mission',
      sourceKey: `${view.mission.id}:${m.suffix}`,
      lane,
      mission: { missionId: view.mission.id, root: view.root, item }
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
  now: number
): YourMoveState {
  let next = s
  const present = new Set<string>()
  for (const v of result.views) {
    present.add(v.mission.id)
    next = reconcileSource(
      next,
      { source: 'mission', missionIds: [v.mission.id] },
      missionDrafts(v, lane),
      mintId,
      now
    )
  }
  if (result.unreadable.length > 0) return next
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
