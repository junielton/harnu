/**
 * Missions v4 · S-23 · AC-62 — every other reader uses the v4 view.
 *
 * The sidebar chip, the Activity cue, Your move cards, the companion mod and the hibernation exemption
 * read the v4 view, through the record store, for v3 and v4 records alike. This file proves it one
 * reader at a time, against real files in a temporary repo (no mock of the store): a v4 record under
 * `.harnu/missions-v4/` and a v3 file under `.harnu/missions/` of the same repo.
 *
 * Hibernation first. The leader of an open mission, ready to close included, is never parked, whether
 * or not a session of its own is running under it. A closed mission leaves its leader free.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { missionOwnersWithLiveChildren } from '../src/main/hibernation'
import { readViewsFromRecords } from '../src/main/companion/mission-state'
import { projectMissions } from '../src/main/companion/mission-state-core'
import { missionGet } from '../src/main/missions/verbs-read'
import { emptyState, type YourMoveState } from '../src/main/your-move/core'
import { fixtureView } from './helpers/mission-v3-view'
import {
  readRecordViews,
  currentRecordViews,
  reconcileMissions,
  refreshRecordViews
} from '../src/main/your-move/source-mission'
import { buildMissionRecordContent, type MissionV4 } from '../src/main/missions/model'
import {
  buildMissionFileContent,
  missionFilePath,
  missionsDir,
  type Mission
} from '../src/main/mission-core'

const LEADER = '8f2c1e4a-1111-4222-8333-944455556666'
const WORKER = '2c9d0f1e-aaaa-4bbb-8ccc-ddddeeeeffff'
const BYSTANDER = '5b6a7c8d-2222-4333-8444-a55566667777'
const NOW = '2026-11-14T10:00:00Z'

let repo = ''

beforeEach(() => {
  repo = mkdtempSync(path.join(os.tmpdir(), 'harnu-s23-'))
  mkdirSync(path.join(repo, '.git'), { recursive: true })
})
afterEach(() => rmSync(repo, { recursive: true, force: true }))

/** A v4 record. `done` marks every step's criterion as settled by the operator: ready to close. */
function v4Record(over: Partial<MissionV4> = {}, done = false): MissionV4 {
  const settled = { at: NOW, by: 'operator' as const }
  return {
    schemaVersion: 4,
    id: 'mnt-a7230001',
    title: 'Score report',
    doneWhen: 'Every candidate sees a score report',
    status: 'open',
    milestones: [],
    steps: [
      {
        id: 'stp-1',
        title: 'Load the test files',
        acs: [
          {
            id: 'ac-1',
            text: 'The designer looked',
            by: 'operator',
            ...(done ? { settled } : {})
          }
        ],
        links: [],
        blockers: []
      }
    ],
    sessions: [{ id: LEADER, role: 'leads', from: NOW, to: null }],
    links: [],
    blockers: [],
    ...over
  }
}

function seedV4(record: MissionV4): void {
  const dir = path.join(repo, '.harnu', 'missions-v4')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, `${record.id}-score-report.md`), buildMissionRecordContent(record))
}

function v3Mission(over: Partial<Mission> = {}): Mission {
  return {
    id: 'mnt-0a1b2c3d',
    slug: 'legacy-rollout',
    folder: repo,
    owner: { sessionId: LEADER, folder: repo },
    status: 'active',
    declaredEnd: { kind: 'code', target: 'PR merging the slice', evidence: 'green gates' },
    steps: [
      {
        id: 'stp-1',
        ordinal: 1,
        kind: 'fixed-start',
        title: 'Scope confirmed',
        verification: 'existence',
        proof: 'verified',
        links: [{ kind: 'card', ref: 'T1-x' }],
        blockers: []
      },
      {
        id: 'stp-2',
        ordinal: 2,
        kind: 'fixed-end',
        title: 'Delivered and verified',
        verification: 'verifier',
        proof: 'unproven',
        links: [],
        blockers: []
      }
    ],
    blockers: [],
    openQuestions: [],
    createdAt: '2026-09-28T09:00:00.000Z',
    updatedAt: '2026-09-28T09:00:00.000Z',
    provenance: { author: 'agent', at: '2026-09-28T09:00:00.000Z' },
    ...over
  }
}

function seedV3(m: Mission): void {
  mkdirSync(missionsDir(repo), { recursive: true })
  writeFileSync(missionFilePath(repo, m.id, m.slug), buildMissionFileContent(m))
}

/** What `pty.ts#fleetSnapshot` asks: which of these live sessions the exemption keeps from being parked. */
const exempt = (...keys: string[]): string[] =>
  [...missionOwnersWithLiveChildren(keys.map((sessionKey) => ({ sessionKey, cwd: repo })))].sort()

describe('readers use the v4 view', () => {
  describe('hibernation: the leader of an open mission is never parked', () => {
    it('a v4 record that is open pins its leader, with no session of its own running under it', () => {
      seedV4(v4Record())
      expect(exempt(LEADER, BYSTANDER)).toEqual([LEADER])
    })

    it('a v4 record that is ready to close (every criterion settled) still pins its leader', () => {
      seedV4(v4Record({}, true))
      expect(exempt(LEADER, BYSTANDER)).toEqual([LEADER])
    })

    it('a v4 record whose agent asked to close pins its leader', () => {
      seedV4(v4Record({ closeRequested: { at: NOW } }, true))
      expect(exempt(LEADER)).toEqual([LEADER])
    })

    it('only the leader is pinned: a worker session on the mission stays eligible', () => {
      seedV4(
        v4Record({
          sessions: [
            { id: LEADER, role: 'leads', from: NOW, to: null },
            { id: WORKER, role: 'worked', from: NOW, to: null }
          ]
        })
      )
      expect(exempt(LEADER, WORKER)).toEqual([LEADER])
    })

    it('a leader that handed off is free; the new leader is pinned', () => {
      seedV4(
        v4Record({
          sessions: [
            { id: LEADER, role: 'leads', from: NOW, to: '2026-11-14T11:00:00Z' },
            { id: WORKER, role: 'leads', from: '2026-11-14T11:00:00Z', to: null }
          ]
        })
      )
      expect(exempt(LEADER, WORKER)).toEqual([WORKER])
    })

    it('a closed mission frees its leader', () => {
      seedV4(v4Record({ status: 'closed', closedAs: 'delivered' }, true))
      expect(exempt(LEADER)).toEqual([])
    })

    it('a v3 mission that is active pins its leader; one the operator closed does not', () => {
      seedV3(v3Mission())
      expect(exempt(LEADER)).toEqual([LEADER])
      rmSync(missionsDir(repo), { recursive: true, force: true })
      seedV3(v3Mission({ status: 'closed', closedAs: 'delivered' } as Partial<Mission>))
      expect(exempt(LEADER)).toEqual([])
    })

    it('a v3 mission waiting for the operator to close it (delivered) is ready to close: its leader is pinned', () => {
      seedV3(
        v3Mission({
          status: 'delivered',
          pendingClose: { at: NOW, requestedBy: LEADER }
        } as Partial<Mission>)
      )
      expect(exempt(LEADER)).toEqual([LEADER])
    })

    it('one format at a time: a v3 mission already copied to v4 is read as the v4 record', () => {
      seedV3(v3Mission())
      // The v4 copy was closed: the v3 file left beside it is a snapshot and pins nobody.
      seedV4(
        v4Record({
          id: 'mnt-0a1b2c3d',
          status: 'closed',
          closedAs: 'delivered'
        })
      )
      expect(exempt(LEADER)).toEqual([])
    })

    it('fails open: an unreadable v4 file exempts nobody and never throws', () => {
      const dir = path.join(repo, '.harnu', 'missions-v4')
      mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(dir, 'mnt-a7230001-bad.md'), 'not a record')
      expect(exempt(LEADER)).toEqual([])
    })
  })

  describe('the companion mod: the missions of a session, read from the records', () => {
    /** The detail the view channel serves, read from the real record store (no GitHub facts: none known). */
    const readDetail = async (
      folder: string,
      missionId: string
    ): Promise<Awaited<ReturnType<typeof missionGet>> | null> =>
      missionGet(folder, { kind: 'operator' }, { missionId })

    const operatorBlocker = {
      id: 'blk-1',
      reason: 'The vendor export is late',
      ask: 'Ask the vendor for the export',
      unblocks: 'Step 1 can load the files',
      owner: 'operator' as const
    }

    it('a v4 record: the leader owns it, a worker is a child, a bystander has none; you carries the one wording', async () => {
      seedV4(
        v4Record({
          sessions: [
            { id: LEADER, role: 'leads', from: NOW, to: null },
            { id: WORKER, role: 'worked', from: NOW, to: null }
          ],
          steps: [{ ...v4Record().steps[0], blockers: [operatorBlocker] }]
        })
      )
      const { views, unreadable } = await readViewsFromRecords(
        [repo],
        [LEADER, WORKER, BYSTANDER],
        {
          readDetail
        }
      )
      expect(unreadable).toEqual([])
      const owner = projectMissions(views, LEADER)
      expect(owner).toHaveLength(1)
      expect(owner[0]).toMatchObject({ id: 'mnt-a7230001', title: 'Score report', role: 'owner' })
      expect(owner[0].steps.map((s) => [s.id, s.state])).toEqual([['stp-1', 'blocked']])
      expect(owner[0].you[0]).toEqual({ kind: 'unblock', text: 'Ask the vendor for the export' })
      expect(projectMissions(views, WORKER)[0].role).toBe('child')
      expect(projectMissions(views, BYSTANDER)).toEqual([])
    })

    it('a v3 file reads the same way: converted in memory, never rewritten', async () => {
      seedV3(v3Mission())
      const { views } = await readViewsFromRecords([repo], [LEADER], { readDetail })
      const owner = projectMissions(views, LEADER)
      expect(owner).toHaveLength(1)
      expect(owner[0].role).toBe('owner')
      expect(owner[0].title).toBeTruthy()
    })

    it("a closed mission is not the session's; a mission ready to close says so in you", async () => {
      seedV4(v4Record({ status: 'closed', closedAs: 'delivered' }, true))
      expect((await readViewsFromRecords([repo], [LEADER], { readDetail })).views).toEqual([])
      rmSync(path.join(repo, '.harnu', 'missions-v4'), { recursive: true, force: true })
      seedV4(v4Record({}, true))
      const { views } = await readViewsFromRecords([repo], [LEADER], { readDetail })
      expect(projectMissions(views, LEADER)[0].you.map((y) => y.kind)).toEqual(['close'])
    })
  })

  describe('Your move: the cards of what a mission owes, read from the records', () => {
    const readDetail = async (folder: string, missionId: string) =>
      missionGet(folder, { kind: 'operator' }, { missionId })
    const blocker = {
      id: 'blk-1',
      reason: 'The vendor export is late',
      ask: 'Ask the vendor for the export',
      unblocks: 'Step 1 can load the files',
      owner: 'operator' as const
    }
    let n = 0
    const mint = (): string => `card-${++n}`
    const open = (
      s: YourMoveState
    ): { kind: string; ask: string; sessionId: string; key?: string }[] =>
      s.cards
        .filter((c) => c.closedAt === undefined)
        .map((c) => ({ kind: c.kind, ask: c.ask, sessionId: c.sessionId, key: c.sourceKey }))
    const NONE = { views: [], unreadable: [] }

    it('a v4 record files a card per thing it owes, in the one wording, for its leader', async () => {
      seedV4(
        v4Record({
          steps: [{ ...v4Record().steps[0], blockers: [blocker] }],
          attachRequests: [
            {
              id: 'atr-1',
              missionId: 'mnt-a7230001',
              sessionId: BYSTANDER,
              at: NOW,
              decision: null
            }
          ]
        })
      )
      const views = await readRecordViews([repo], { readDetail })
      const s = reconcileMissions(emptyState(), NONE, [repo], 'live', mint, 1, views)
      const cards = open(s)
      expect(cards.find((c) => c.kind === 'do')?.ask).toBe('Ask the vendor for the export')
      expect(cards.some((c) => c.kind === 'go_no_go' && c.key?.includes('attach:atr-1'))).toBe(true)
      expect(new Set(cards.map((c) => c.sessionId))).toEqual(new Set([LEADER]))
    })

    it("a v3 file files its cards from the list's own v3 view (main's items), in the waiting list's one wording", async () => {
      seedV3(v3Mission())
      const view = fixtureView('parallel', {
        mission: { id: 'mnt-0a1b2c3d', owner: { sessionId: LEADER, folder: repo } } as never,
        view: {
          root: repo,
          you: [
            { kind: 'blocker', reason: 'Waiting on the vendor key', unblocks: 'a key' }
          ] as never
        }
      })
      const records = await readRecordViews([repo], { readDetail })
      const s = reconcileMissions(
        emptyState(),
        { views: [view], unreadable: [] },
        [repo],
        'live',
        mint,
        1,
        records
      )
      expect(open(s).map((c) => c.ask)).toEqual(['Unblock: Waiting on the vendor key'])
      expect(open(s)[0].key).toBe('mnt-0a1b2c3d:blocker:Waiting on the vendor key')
    })

    it('a card closes when the record stops owing the item', async () => {
      seedV4(v4Record({ steps: [{ ...v4Record().steps[0], blockers: [blocker] }] }))
      let s = reconcileMissions(
        emptyState(),
        NONE,
        [repo],
        'live',
        mint,
        1,
        await readRecordViews([repo], { readDetail })
      )
      expect(open(s).some((c) => c.kind === 'do')).toBe(true)
      rmSync(path.join(repo, '.harnu', 'missions-v4'), { recursive: true, force: true })
      seedV4(v4Record({ steps: [{ ...v4Record().steps[0], blockers: [] }] }))
      s = reconcileMissions(
        s,
        NONE,
        [repo],
        'live',
        mint,
        2,
        await readRecordViews([repo], { readDetail })
      )
      expect(open(s).some((c) => c.kind === 'do')).toBe(false)
    })

    it('one format at a time: a v3 snapshot beside a closed v4 copy files nothing', async () => {
      seedV3(
        v3Mission({
          blockers: [
            {
              reason: 'Waiting on the vendor',
              unblocks: 'a key',
              owner: 'operator',
              raisedAt: NOW
            } as never
          ]
        })
      )
      seedV4(v4Record({ id: 'mnt-0a1b2c3d', status: 'closed', closedAs: 'delivered' }, true))
      const views = await readRecordViews([repo], { readDetail })
      // The list still serves the v3 snapshot (it owes a blocker); the closed v4 record is the mission.
      const snapshot = fixtureView('parallel', {
        mission: { id: 'mnt-0a1b2c3d', owner: { sessionId: LEADER, folder: repo } } as never,
        view: {
          root: repo,
          you: [{ kind: 'blocker', reason: 'Waiting on the vendor', unblocks: 'a key' }] as never
        }
      })
      expect(
        open(
          reconcileMissions(
            emptyState(),
            { views: [snapshot], unreadable: [] },
            [repo],
            'live',
            mint,
            1,
            views
          )
        )
      ).toEqual([])
    })
  })

  describe('Your move: who a card is filed for, and which roots it remembers', () => {
    const readDetail = async (folder: string, missionId: string) =>
      missionGet(folder, { kind: 'operator' }, { missionId })
    const blocker = {
      id: 'blk-1',
      reason: 'The vendor export is late',
      ask: 'Ask the vendor for the export',
      unblocks: 'Step 1 can load the files',
      owner: 'operator' as const
    }
    const NONE = { views: [], unreadable: [] }
    let n = 0
    const mint = (): string => `c2-${++n}`
    // The blocker's own card (the step also owes an operator criterion, which is not what this tests).
    const asks = (s: YourMoveState): string[] =>
      s.cards.filter((c) => c.closedAt === undefined && c.kind === 'do').map((c) => c.ask)

    it('a mission with no open leader files nothing: a session that already left is not handed a card', async () => {
      seedV4(
        v4Record({
          sessions: [{ id: LEADER, role: 'leads', from: NOW, to: '2026-11-14T11:00:00Z' }],
          steps: [{ ...v4Record().steps[0], blockers: [blocker] }]
        })
      )
      const views = await readRecordViews([repo], { readDetail })
      expect(views.get(repo)?.views).toEqual([])
    })

    it("a v3 file is not read from the records for cards: its owner and cards come from the list's v3 view", async () => {
      seedV3(v3Mission())
      const views = await readRecordViews([repo], { readDetail })
      expect(views.get(repo)?.views).toEqual([])
      expect([...(views.get(repo)?.v4Ids ?? [])]).toEqual([])
    })

    it("a v3 blocker keeps main's card key, and clearing a neighbour never closes and re-files it", async () => {
      const viewOf = (reasons: string[]): never =>
        fixtureView('parallel', {
          mission: { id: 'mnt-0a1b2c3d', owner: { sessionId: LEADER, folder: repo } } as never,
          view: {
            root: repo,
            you: reasons.map((reason) => ({ kind: 'blocker', reason, unblocks: 'a key' })) as never
          }
        }) as never
      seedV3(v3Mission())
      const records = await readRecordViews([repo], { readDetail })
      let s = reconcileMissions(
        emptyState(),
        {
          views: [viewOf(['Waiting on the vendor key', 'Merge the pull request'])],
          unreadable: []
        },
        [repo],
        'live',
        mint,
        1,
        records
      )
      expect(
        s.cards
          .filter((c) => c.closedAt === undefined)
          .map((c) => c.sourceKey)
          .sort()
      ).toEqual([
        'mnt-0a1b2c3d:blocker:Merge the pull request',
        'mnt-0a1b2c3d:blocker:Waiting on the vendor key'
      ])
      const stepCard = s.cards.find((c) => c.sourceKey?.endsWith('Merge the pull request'))!
      s = reconcileMissions(
        s,
        { views: [viewOf(['Merge the pull request'])], unreadable: [] },
        [repo],
        'live',
        mint,
        2,
        records
      )
      expect(s.cards.find((c) => c.id === stepCard.id)!.closedAt).toBeUndefined()
      expect(s.cards.filter((c) => c.sourceKey?.endsWith('Merge the pull request'))).toHaveLength(1)
    })

    it("a v3 mission keeps main's cards: the same keys and the same count for every kind it can owe", async () => {
      const END = { kind: 'code', target: 'The slice is merged', evidence: 'green gates' }
      const owed = [
        { kind: 'rescope', end: END },
        { kind: 'steward-paused', reason: 'checking', at: NOW },
        { kind: 'close' },
        { kind: 'checks', count: 2, stepIds: ['stp-2'] },
        { kind: 'human-steps', stepIds: ['stp-2'] },
        { kind: 'decide', stepId: 'stp-3', title: 'Which store?' },
        { kind: 'review-import' },
        { kind: 'blocker', reason: 'Waiting on the vendor key', unblocks: 'a key' },
        { kind: 'main-red', stepId: 'stp-2', pr: 12 }
      ]
      // What main filed for these: `<mission id>:<its mapping's key>`, one card each (approvals and needs-input none).
      const main = [
        'rescope:The slice is merged',
        'steward-paused',
        'close',
        'checks',
        'human-steps',
        'decide:stp-3',
        'review-import',
        'blocker:Waiting on the vendor key',
        'main-red:stp-2'
      ].map((k) => `mnt-0a1b2c3d:${k}`)
      seedV3(v3Mission())
      const view = fixtureView('parallel', {
        mission: { id: 'mnt-0a1b2c3d', owner: { sessionId: LEADER, folder: repo } } as never,
        view: { root: repo, you: owed as never }
      })
      const records = await readRecordViews([repo], { readDetail })
      const s = reconcileMissions(
        emptyState(),
        { views: [view], unreadable: [] },
        [repo],
        'live',
        mint,
        1,
        records
      )
      const keys = s.cards
        .filter((c) => c.closedAt === undefined)
        .map((c) => c.sourceKey)
        .sort()
      expect(keys).toEqual([...main].sort())
      // And a second pass changes nothing: no card closed, none re-filed.
      const again = reconcileMissions(
        s,
        { views: [view], unreadable: [] },
        [repo],
        'live',
        mint,
        2,
        records
      )
      expect(again.cards.map((c) => [c.id, c.closedAt])).toEqual(
        s.cards.map((c) => [c.id, c.closedAt])
      )
    })

    it('only the roots of the latest query are remembered, even when two queries overlap', async () => {
      const other = mkdtempSync(path.join(os.tmpdir(), 'harnu-s23-other-'))
      try {
        mkdirSync(path.join(other, '.git'), { recursive: true })
        seedV4(v4Record({ steps: [{ ...v4Record().steps[0], blockers: [blocker] }] }))
        // The same record in the other repo, with a different blocker, so a card says which root it came from.
        const dir = path.join(other, '.harnu', 'missions-v4')
        mkdirSync(dir, { recursive: true })
        writeFileSync(
          path.join(dir, 'mnt-a7230002-other.md'),
          buildMissionRecordContent(
            v4Record({
              id: 'mnt-a7230002',
              steps: [
                { ...v4Record().steps[0], blockers: [{ ...blocker, ask: 'Ask the other vendor' }] }
              ]
            })
          )
        )
        // Two overlapping queries: the second (other) is the latest. The first one's root must be forgotten.
        const first = refreshRecordViews([repo], { readDetail })
        const second = refreshRecordViews([other], { readDetail })
        await Promise.all([first, second])
        let s = reconcileMissions(
          emptyState(),
          NONE,
          [other],
          'live',
          mint,
          1,
          currentRecordViews()
        )
        expect(asks(s)).toEqual(['Ask the other vendor'])
        // Asking again for the first root alone drops the other one.
        await refreshRecordViews([repo], { readDetail })
        s = reconcileMissions(emptyState(), NONE, [repo], 'live', mint, 2, currentRecordViews())
        expect(asks(s)).toEqual(['Ask the vendor for the export'])
        s = reconcileMissions(emptyState(), NONE, [other], 'live', mint, 3, currentRecordViews())
        expect(asks(s)).toEqual([])
      } finally {
        rmSync(other, { recursive: true, force: true })
      }
    })
  })
})
