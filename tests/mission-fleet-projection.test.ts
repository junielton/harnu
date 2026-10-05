import { describe, it, expect } from 'vitest'

/**
 * T358 S6 — `buildMissionFleetProjection` (design
 * `docs/specs/2026-09-26-mission-progress/design.md` §7): the per-mission,
 * SCOPED read of the fleet that `mission_get` derives each linked child's live
 * state from. The T360 smoke test (Q4) measured the unscoped `get_fleet` at
 * hundreds of folder rows; this projection returns exactly the linked sessions
 * and nothing else — no folder rows, no other session, never a transcript.
 */
import {
  buildFleetSnapshot,
  buildMissionFleetProjection,
  type FleetFolderInput,
  type FleetSessionInput
} from '../src/main/mcp/fleet-snapshot'
import type { TaskState } from '../src/main/hook-state'

const ID = (n: number): string => `0000000${n}-0000-4000-8000-00000000000${n}`

const sess = (sessionId: string, folderPath: string, over: Partial<FleetSessionInput> = {}) =>
  ({
    sessionId,
    folderPath,
    status: 'idle',
    isSidechain: false,
    modified: '2026-09-28T10:00:00.000Z',
    ...over
  }) as FleetSessionInput

const folders: FleetFolderInput[] = [{ path: '/home/u/repo-a' }, { path: '/home/u/repo-b' }]

const fleet = {
  folders,
  sessions: [
    sess(ID(1), '/home/u/repo-a', { transcript: 'SECRET', lastLine: 'SECRET' }),
    sess(ID(2), '/home/u/repo-a', { hibernated: true }),
    sess(ID(3), '/home/u/repo-b', { peer: { pid: 42, socket: '/run/user/1000/s.sock' } }),
    sess(ID(4), '/home/u/repo-b'),
    sess(ID(5), '/home/u/repo-b')
  ],
  taskStates: { [ID(1)]: 'working', [ID(3)]: 'needs-input', [ID(4)]: 'idle' } as Record<
    string,
    TaskState
  >,
  inflightAgentSessions: [] as FleetSessionInput[]
}

const opts = { redactPaths: true, denyFolders: [] as string[] }

describe('buildMissionFleetProjection', () => {
  it('returns state only for the given session ids, not the full fleet', () => {
    const p = buildMissionFleetProjection('mnt-0000abcd', [ID(3), ID(1)], fleet, opts)
    expect(p.missionId).toBe('mnt-0000abcd')
    expect(p.sessions.map((s) => s.sessionId)).toEqual([ID(3), ID(1)])
    // The fleet has 5 sessions and 2 folders; the projection carries neither.
    expect(p).not.toHaveProperty('folders')
    expect(buildFleetSnapshot(fleet, opts).sessions).toHaveLength(5)
  })

  it('carries taskState / hibernated / peer per linked session, never a transcript', () => {
    const p = buildMissionFleetProjection('mnt-0000abcd', [ID(1), ID(2), ID(3)], fleet, opts)
    const [one, two, three] = p.sessions
    expect(one).toMatchObject({ sessionId: ID(1), known: true, taskState: 'working' })
    expect(two).toMatchObject({ sessionId: ID(2), known: true, hibernated: true })
    expect(two.taskState).toBeUndefined()
    expect(three).toMatchObject({
      known: true,
      taskState: 'needs-input',
      peer: { pid: 42, socket: '/run/user/1000/s.sock' }
    })
    expect(JSON.stringify(p)).not.toContain('SECRET')
    expect(JSON.stringify(p)).not.toContain('/home/u/')
  })

  it('reports a linked id the fleet does not know as known: false (not dropped)', () => {
    const ghost = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
    const p = buildMissionFleetProjection('mnt-0000abcd', [ghost, ID(4)], fleet, opts)
    expect(p.sessions).toEqual([
      { sessionId: ghost, known: false, pendingApprovals: 0 },
      expect.objectContaining({ sessionId: ID(4), known: true, taskState: 'idle' })
    ])
  })

  it('dedupes repeated ids, keeping the first position', () => {
    const p = buildMissionFleetProjection('mnt-0000abcd', [ID(4), ID(1), ID(4)], fleet, opts)
    expect(p.sessions.map((s) => s.sessionId)).toEqual([ID(4), ID(1)])
  })

  it('counts pending approvals and the last transition only for linked sessions', () => {
    const p = buildMissionFleetProjection(
      'mnt-0000abcd',
      [ID(3), ID(4)],
      {
        ...fleet,
        pendingApprovals: [{ sessionId: ID(3) }, { sessionId: ID(3) }, { sessionId: ID(5) }],
        lastTransitionAt: { [ID(3)]: Date.parse('2026-09-28T11:00:00.000Z'), [ID(5)]: 1 }
      },
      opts
    )
    expect(p.sessions[0]).toMatchObject({
      pendingApprovals: 2,
      lastTransitionAt: '2026-09-28T11:00:00.000Z'
    })
    expect(p.sessions[1].pendingApprovals).toBe(0)
    expect(p.sessions[1].lastTransitionAt).toBeUndefined()
  })

  it('an empty link set is an empty projection — no fleet read leaks through', () => {
    expect(buildMissionFleetProjection('mnt-0000abcd', [], fleet, opts).sessions).toEqual([])
  })
})
