/**
 * BUG-173 S5 (spec §3.5, I-8) — the pure selectors behind the Missions review
 * dialog: which owed missions land in which group, which of them a bulk close
 * may touch, and the reason every bulk door carries.
 */
import { describe, it, expect } from 'vitest'
import type { MissionView } from '../src/main/mission-ipc'
import {
  bulkCloseReason,
  groupReviewMissions,
  isBulkCloseable,
  readyIds
} from '../src/renderer/src/lib/mission-view'

function view(
  id: string,
  over: {
    status?: string
    pendingClose?: boolean
    allDone?: boolean
    you?: MissionView['you']
  } = {}
): MissionView {
  return {
    root: '/repo',
    mission: {
      id,
      status: over.status ?? 'active',
      updatedAt: '2026-10-09T10:00:00.000Z',
      owner: { sessionId: `owner-${id}`, folder: '/repo' },
      ...(over.pendingClose
        ? { pendingClose: { at: '2026-10-09T09:00:00.000Z', requestedBy: 'x' } }
        : {}),
      steps: []
    },
    title: `Mission ${id}`,
    derived: { stale: false },
    progress: { allDone: over.allDone ?? false },
    you: over.you ?? [{ kind: 'checks', count: 1, stepIds: ['stp-1'] }],
    closeWarnings: []
  } as unknown as MissionView
}

const ready = (id: string): MissionView =>
  view(id, { status: 'delivered', pendingClose: true, allDone: true, you: [{ kind: 'close' }] })
const finished = (id: string): MissionView => view(id, { allDone: true })
const other = (id: string): MissionView =>
  view(id, { you: [{ kind: 'blocker', reason: 'merge PR', unblocks: 'merged' }] } as never)

describe('groupReviewMissions', () => {
  it('puts delivered+pendingClose in ready, active+allDone in finished, the rest in other', () => {
    const g = groupReviewMissions([other('o1'), ready('r1'), finished('f1'), ready('r2')])
    expect(g.ready.map((v) => v.mission.id)).toEqual(['r1', 'r2'])
    expect(g.finished.map((v) => v.mission.id)).toEqual(['f1'])
    expect(g.other.map((v) => v.mission.id)).toEqual(['o1'])
  })

  it('lists an active, all-done mission in finished even when it owes nothing', () => {
    const quiet = view('q1', { allDone: true, you: [] })
    const g = groupReviewMissions([quiet, ready('r1')])
    expect(g.finished.map((v) => v.mission.id)).toEqual(['q1'])
    expect(g.ready.map((v) => v.mission.id)).toEqual(['r1'])
    expect(g.other).toEqual([])
  })

  it('does not list an active, not-all-done mission that owes nothing', () => {
    const quiet = view('q1', { allDone: false, you: [] })
    expect(groupReviewMissions([quiet])).toEqual({ ready: [], finished: [], other: [] })
  })

  it('does not preselect or ready-list a quiet finished mission', () => {
    const g = groupReviewMissions([view('q1', { allDone: true, you: [] }), ready('r1')])
    expect(readyIds(g)).toEqual(['r1'])
  })

  it('does not count approvals or needs-input as owed (the cue never speaks about them)', () => {
    const quiet = view('q1', { allDone: false, you: [{ kind: 'approvals', count: 2 }] as never })
    const g = groupReviewMissions([quiet])
    expect(g).toEqual({ ready: [], finished: [], other: [] })
  })

  it('sends a delivered mission with no pendingClose to other, never to ready', () => {
    const g = groupReviewMissions([view('d1', { status: 'delivered', allDone: true })])
    expect(g.ready).toEqual([])
    expect(g.other.map((v) => v.mission.id)).toEqual(['d1'])
  })

  it('keeps an active mission that is not all done in other, even when it owes a close-like item', () => {
    const g = groupReviewMissions([view('a1', { allDone: false })])
    expect(g.finished).toEqual([])
    expect(g.other.map((v) => v.mission.id)).toEqual(['a1'])
  })

  it('drops a repeated mission id (first wins) and a closed mission', () => {
    const g = groupReviewMissions([ready('r1'), ready('r1'), view('c1', { status: 'closed' })])
    expect(g.ready.map((v) => v.mission.id)).toEqual(['r1'])
    expect(g.other).toEqual([])
  })
})

describe('isBulkCloseable / readyIds', () => {
  it('qualifies groups ready and finished only', () => {
    expect(isBulkCloseable(ready('r1'))).toBe(true)
    expect(isBulkCloseable(finished('f1'))).toBe(true)
    expect(isBulkCloseable(other('o1'))).toBe(false)
    expect(isBulkCloseable(view('d1', { status: 'delivered', allDone: true }))).toBe(false)
  })

  it('pre-selects exactly the ready group', () => {
    const g = groupReviewMissions([ready('r1'), finished('f1'), other('o1')])
    expect(readyIds(g)).toEqual(['r1'])
  })
})

describe('bulkCloseReason', () => {
  it('is "bulk close" alone when the operator typed nothing', () => {
    expect(bulkCloseReason()).toBe('bulk close')
    expect(bulkCloseReason('')).toBe('bulk close')
    expect(bulkCloseReason('   ')).toBe('bulk close')
  })

  it('prefixes the trimmed text with "bulk close: "', () => {
    expect(bulkCloseReason('  docs pass merged ')).toBe('bulk close: docs pass merged')
  })
})
