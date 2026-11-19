/**
 * Missions v4 S-5 (AC-7, R-25): ONE server-owned waiting list. `waitingListV4` (src/main/missions/waiting.ts)
 * is the only place a list of what waits on the operator, and the wording of one item, is built. The MCP
 * read, the companion, Your move and the renderer all read that list: none builds its own, none adds a row.
 *
 * Missions v4 S-40: the v3 list (`waitingList`, `describeWaiting`, `youItems`, `youLine`) is gone. This
 * suite keeps what outlived it: the readers draw the one list as given, in its own words. The list's
 * ranks, caps and wording are pinned in `tests/mission-waiting-v4.test.ts`.
 */
import { describe, it, expect } from 'vitest'
import type { MissionV4 } from '../src/main/missions/model'
import { WAITING_RANK, waitingListV4, type WaitingItemV4 } from '../src/main/missions/waiting'
import { missionDrafts } from '../src/main/your-move/source-mission'
import { projectMissions, type MissionViewIn } from '../src/main/companion/mission-state-core'
import { buildMissionModel, youRows } from '../src/renderer/src/lib/mission-view'
import { fixtureView, FIXTURE_NOW } from './helpers/mission-v3-view'

const OWNER = '11111111-2222-4333-8444-555555555555'
const AT = '2026-11-14T10:00:00.000Z'
const ID = 'mnt-0000a5a5'

function mission(over: Partial<MissionV4> = {}): MissionV4 {
  return {
    schemaVersion: 4,
    id: ID,
    title: 'Waiting',
    doneWhen: 'The slice is merged',
    status: 'open',
    milestones: [],
    steps: [
      {
        id: 'stp-1',
        title: 'Pick the store',
        acs: [{ id: 'ac-1', text: 'The store is chosen', by: 'operator' }],
        links: [],
        blockers: []
      },
      {
        id: 'stp-2',
        title: 'Wire the store',
        acs: [{ id: 'ac-1', text: 'The wiring is merged', by: 'fact', fact: 'pr-merged' }],
        links: [],
        blockers: [
          {
            id: 'blk-1',
            reason: 'The API key is not on this machine.',
            ask: 'Put the API key in the vault',
            unblocks: 'The wiring can run',
            owner: 'operator'
          }
        ]
      }
    ],
    sessions: [{ id: OWNER, role: 'leads', from: AT, to: null }],
    links: [],
    blockers: [],
    ...over
  } as unknown as MissionV4
}

describe('one list feeds every reader (AC-7)', () => {
  const m = mission()
  const list = waitingListV4(m).items

  it('the list is typed with v4 kinds, each item with an ask and a why', () => {
    expect(list.length).toBeGreaterThan(0)
    for (const i of list) {
      expect(WAITING_RANK).toContain(i.kind)
      expect(i.ask.length).toBeGreaterThan(0)
      expect(i.why.length).toBeGreaterThan(0)
    }
  })

  it('keeps one order: what blocks comes before what only needs a tick', () => {
    expect(list.map((i) => i.kind)).toEqual(['unblock', 'settle'])
  })

  it('a closed mission waits on nothing', () => {
    expect(waitingListV4(mission({ status: 'closed' } as Partial<MissionV4>)).items).toEqual([])
  })

  const viewIn = (you: WaitingItemV4[]): MissionViewIn =>
    ({
      mission: { id: m.id, owner: { sessionId: OWNER }, steps: [], blockers: [] },
      title: 'Waiting',
      progress: { total: 2, current: null, done: 0, verified: 0, allDone: false, states: {} },
      derived: { steps: [] },
      you
    }) as unknown as MissionViewIn

  it('the companion draws the list as given, in the list’s own words', () => {
    const [entry] = projectMissions([viewIn(list)], OWNER)
    expect(entry.you.map((y) => y.kind)).toEqual(list.map((i) => i.kind))
    expect(entry.you.map((y) => y.text)).toEqual(list.map((i) => i.ask))
  })

  it('Your move files a card per item the list carries, with the list’s wording', () => {
    const drafts = missionDrafts(
      { root: '/repo', mission: { id: m.id, owner: { sessionId: OWNER } }, you: list },
      'live'
    )
    expect(drafts).toHaveLength(list.length)
    const unblock = list.find((i) => i.kind === 'unblock')!
    const blocker = drafts.find((d) => d.sourceKey === `${m.id}:blocker:${unblock.ask}`)
    expect(blocker).toMatchObject({ kind: 'do', source: 'mission', ask: unblock.ask })
    const settle = list.find((i) => i.kind === 'settle')!
    expect(drafts.find((d) => d.sourceKey === `${m.id}:${settle.id}`)).toMatchObject({
      kind: 'check',
      ask: settle.ask
    })
  })

  it('the renderer adds no row of its own: a decision node the server did not list is not a row', () => {
    const steps = fixtureView('faq-like').mission.steps.map((s, i) =>
      i === 1
        ? { ...s, decision: { title: 'Which store?', options: ['SQLite', 'Files'], blocks: [] } }
        : s
    )
    const view = fixtureView('faq-like', { mission: { steps }, view: { you: [] } })
    expect(youRows(view, FIXTURE_NOW)).toEqual([])
    expect(buildMissionModel(view, FIXTURE_NOW).youRows).toEqual([])
    // ...and when the server lists the decision, the row is there, in the server's place.
    const listed = fixtureView('faq-like', {
      mission: { steps },
      view: {
        you: [
          { kind: 'blocker', reason: 'needs the API key', unblocks: 'the key is in the vault' },
          { kind: 'decide', stepId: steps[1].id, title: 'Which store?' }
        ]
      }
    })
    const rows = youRows(listed, FIXTURE_NOW)
    expect(rows.map((r) => r.kind)).toEqual(['blocker', 'decide'])
    expect(rows.find((r) => r.kind === 'decide')).toMatchObject({
      stepId: steps[1].id,
      risk: 'high'
    })
  })
})

describe('the list is a pure read of the record (S-3: a read leaves nothing behind)', () => {
  const deepFreeze = <T>(o: T): T => {
    if (o && typeof o === 'object') {
      Object.values(o as object).forEach(deepFreeze)
      Object.freeze(o)
    }
    return o
  }

  it('builds from a frozen record and returns the same list twice, so it writes nothing it reads', () => {
    const m = deepFreeze(mission())
    const a = waitingListV4(m)
    expect(waitingListV4(m)).toEqual(a)
    expect(a.items.map((i) => i.kind)).toEqual(['unblock', 'settle'])
  })
})
