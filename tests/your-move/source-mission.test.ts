import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { MissionListResult, MissionView } from '../../src/main/mission-ipc'
import type { MissionYouItem } from '../../src/main/mcp/tool-handlers'
import { emptyState, type YourMoveState } from '../../src/main/your-move/core'
import { missionDrafts, reconcileMissions } from '../../src/main/your-move/source-mission'

const view = (
  id: string,
  you: MissionYouItem[],
  over: { root?: string; owner?: string } = {}
): Pick<MissionView, 'root' | 'mission' | 'you'> =>
  ({
    root: over.root ?? '/org/proj/www',
    mission: { id, owner: { sessionId: over.owner ?? 'sess-owner-1', folder: '/org/proj/www' } },
    you
  }) as never

const result = (views: ReturnType<typeof view>[], unreadable: string[] = []): MissionListResult =>
  ({ views, unreadable, shadowed: [] }) as unknown as MissionListResult

let n = 0
const mint = (): string => `card-${++n}`

const allKinds: MissionYouItem[] = [
  { kind: 'rescope', end: { kind: 'code', target: 'ship the thing', evidence: 'tests' } as never },
  { kind: 'close' },
  { kind: 'steward-paused', reason: 'cost', at: '2026-11-09T10:00:00Z' },
  { kind: 'blocker', reason: 'need the API key', unblocks: 'the key is in the vault' },
  { kind: 'checks', count: 2, stepIds: ['stp-1'] },
  { kind: 'human-steps', stepIds: ['stp-2'] },
  { kind: 'review-import' },
  { kind: 'main-red', stepId: 'stp-3', pr: 305 },
  { kind: 'approvals', count: 1, sessionId: 'sess-child-1' },
  { kind: 'needs-input', sessionId: 'sess-child-1' }
]

const open = (s: YourMoveState) => s.cards.filter((c) => c.closedAt === undefined)

describe('missionDrafts', () => {
  it('maps each owed kind to the table above, and approvals and needs-input to nothing', () => {
    const drafts = missionDrafts(view('mnt-1', allKinds), 'live')
    expect(drafts.map((d) => [d.kind, d.sourceKey])).toEqual([
      ['go_no_go', 'mnt-1:rescope:ship the thing'],
      ['go_no_go', 'mnt-1:close'],
      ['do', 'mnt-1:steward-paused'],
      ['do', 'mnt-1:blocker:need the API key'],
      ['check', 'mnt-1:checks'],
      ['check', 'mnt-1:human-steps'],
      ['check', 'mnt-1:review-import'],
      ['do', 'mnt-1:main-red:stp-3']
    ])
  })

  it('files each card under the mission owner, in the repo root, as source mission', () => {
    const [d] = missionDrafts(
      view('mnt-1', [{ kind: 'close' }], { owner: 'sess-owner-9' }),
      'observe'
    )
    expect(d).toMatchObject({
      sessionId: 'sess-owner-9',
      folder: '/org/proj/www',
      source: 'mission',
      lane: 'observe',
      mission: { missionId: 'mnt-1', root: '/org/proj/www', item: { kind: 'close' } }
    })
  })

  it('writes the ask as the English sentence the mission would say', () => {
    const drafts = missionDrafts(
      view('mnt-1', [
        { kind: 'blocker', reason: 'need the API key', unblocks: 'the key is in the vault' }
      ]),
      'live'
    )
    expect(drafts[0].ask).toBe('Unblock: need the API key — unblocks when the key is in the vault.')
  })

  it('two operator blockers with different reasons are two cards', () => {
    const drafts = missionDrafts(
      view('mnt-1', [
        { kind: 'blocker', reason: 'a', unblocks: 'x' },
        { kind: 'blocker', reason: 'b', unblocks: 'y' }
      ]),
      'live'
    )
    expect(new Set(drafts.map((d) => d.sourceKey)).size).toBe(2)
  })
})

describe('reconcileMissions', () => {
  const roots = ['/org/proj/www']

  it('files the owed cards and keeps their clock across polls', () => {
    const v = view('mnt-1', [{ kind: 'close' }])
    const a = reconcileMissions(emptyState(), result([v]), roots, 'live', mint, 1_000)
    const b = reconcileMissions(a, result([v]), roots, 'live', mint, 9_000)
    expect(open(b)).toHaveLength(1)
    expect(open(b)[0]).toMatchObject({ openedAt: 1_000, updatedAt: 9_000 })
  })

  it('a cleared blocker closes its card as source-resolved', () => {
    const withBlocker = view('mnt-1', [
      { kind: 'blocker', reason: 'a', unblocks: 'x' },
      { kind: 'close' }
    ])
    const a = reconcileMissions(emptyState(), result([withBlocker]), roots, 'live', mint, 1_000)
    expect(open(a)).toHaveLength(2)
    const cleared = view('mnt-1', [{ kind: 'close' }])
    const b = reconcileMissions(a, result([cleared]), roots, 'live', mint, 2_000)
    expect(open(b)).toHaveLength(1)
    const gone = b.cards.find((c) => c.sourceKey === 'mnt-1:blocker:a')
    expect(gone).toMatchObject({ closedBy: 'source-resolved', closedAt: 2_000 })
  })

  it('a mission absent from the result under a queried root closes its cards', () => {
    const a = reconcileMissions(
      emptyState(),
      result([view('mnt-1', [{ kind: 'close' }])]),
      roots,
      'live',
      mint,
      1_000
    )
    const b = reconcileMissions(a, result([]), roots, 'live', mint, 2_000)
    expect(open(b)).toHaveLength(0)
    expect(b.cards[0]).toMatchObject({ closedBy: 'source-resolved' })
  })

  it('a mission under a root that was not queried is untouched', () => {
    const a = reconcileMissions(
      emptyState(),
      result([view('mnt-9', [{ kind: 'close' }], { root: '/org/other/www' })]),
      ['/org/other/www'],
      'live',
      mint,
      1_000
    )
    const b = reconcileMissions(a, result([]), roots, 'live', mint, 2_000)
    expect(open(b)).toHaveLength(1)
  })

  it('an unreadable mission file closes nothing', () => {
    const a = reconcileMissions(
      emptyState(),
      result([view('mnt-1', [{ kind: 'close' }])]),
      roots,
      'live',
      mint,
      1_000
    )
    const b = reconcileMissions(a, result([], ['mnt-broken.md']), roots, 'live', mint, 2_000)
    expect(open(b)).toHaveLength(1)
  })

  it('never touches a card of another source or of another mission', () => {
    const two = reconcileMissions(
      emptyState(),
      result([view('mnt-1', [{ kind: 'close' }]), view('mnt-2', [{ kind: 'close' }])]),
      roots,
      'live',
      mint,
      1_000
    )
    const withJudgeCard: YourMoveState = {
      ...two,
      cards: [
        ...two.cards,
        {
          id: 'judge-1',
          sessionId: 'sess-owner-1',
          folder: '/org/proj/www',
          kind: 'decide',
          ask: 'Which one?',
          source: 'judge',
          lane: 'live',
          openedAt: 1,
          updatedAt: 1
        }
      ]
    }
    const next = reconcileMissions(
      withJudgeCard,
      result([view('mnt-1', []), view('mnt-2', [{ kind: 'close' }])]),
      roots,
      'live',
      mint,
      2_000
    )
    expect(
      open(next)
        .map((c) => c.id)
        .sort()
    ).toEqual(['judge-1', two.cards.find((c) => c.mission?.missionId === 'mnt-2')!.id].sort())
  })

  it('a mission card never writes to the mission', () => {
    const src = readFileSync(
      path.join(__dirname, '../../src/main/your-move/source-mission.ts'),
      'utf8'
    )
    // no door, no mission_* verb, no file write: it only reads the list the poll already made
    expect(src).not.toMatch(/mission_[a-z_]+\(/)
    expect(src).not.toMatch(
      /runOperatorDoor|operatorDoor|atomicWrite|writeFile|from '\.\.\/mission-ipc'/
    )
    expect(src).not.toMatch(/from '\.\.\/mission-store'|from '\.\.\/mcp\/mission/)
  })
})
