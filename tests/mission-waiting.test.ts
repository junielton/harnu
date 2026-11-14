/**
 * Missions v4 S-5 (AC-7, R-25): ONE server-owned waiting list. `waitingList` (src/main/missions/waiting.ts)
 * is the only place a list of what waits on the operator, and the wording of one item, is built. The MCP
 * read, the companion, Your move and the renderer all read that list: none builds its own, none adds a row.
 *
 * The list is typed with the v4 kinds (rank) from the start; the v3 sources feed it through an adapter, so
 * the v3 detail of each item (the `kind` and its fields) is still there for the readers that use it.
 */
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { computeProgress } from '../src/main/mission-progress'
import type { Mission } from '../src/main/mission-core'
import {
  WAITING_ASK_MAX,
  WAITING_WHY_MAX,
  describeWaiting,
  waitingList,
  type WaitingItem
} from '../src/main/missions/waiting'
import { youItems, youLine, youSentence } from '../src/main/mcp/tool-handlers'
import { missionDrafts } from '../src/main/your-move/source-mission'
import { projectMissions, type MissionViewIn } from '../src/main/companion/mission-state-core'
import { buildMissionModel, youRows, youRowText } from '../src/renderer/src/lib/mission-view'
import { fixtureView, FIXTURE_NOW } from './helpers/mission-v3-view'

const OWNER = '11111111-2222-4333-8444-555555555555'
const AT = '2026-11-14T10:00:00.000Z'

function mission(over: Partial<Mission> = {}): Mission {
  const step = (
    id: string,
    n: number,
    extra: Record<string, unknown> = {}
  ): Mission['steps'][0] => ({
    id,
    ordinal: n,
    kind: 'custom',
    title: `Step ${n}`,
    verification: 'verifier',
    proof: 'unproven',
    links: [],
    blockers: [],
    ...extra
  })
  return {
    id: 'mnt-0000a5a5',
    slug: 'waiting',
    folder: '/repo',
    owner: { sessionId: OWNER, folder: '/repo' },
    status: 'active',
    declaredEnd: { kind: 'code', target: 'the slice merged', evidence: 'green gates' },
    steps: [
      step('stp-1', 1, {
        proof: 'verified',
        verifiedBy: { sessionId: 'other', at: AT, verdict: 'met' }
      }),
      step('stp-2', 2, {
        verification: 'human',
        decision: { title: 'Which store?', options: ['SQLite', 'Files'], blocks: ['stp-3'] }
      }),
      step('stp-3', 3),
      { ...step('stp-4', 4, { title: 'Delivered and verified' }), kind: 'fixed-end' }
    ],
    blockers: [
      {
        reason: 'needs the API key',
        unblocks: 'the key is in the vault',
        owner: 'operator',
        raisedAt: AT
      }
    ],
    openQuestions: [],
    createdAt: AT,
    updatedAt: AT,
    provenance: { author: 'agent', at: AT },
    ...over
  } as Mission
}

const progressOf = (m: Mission): ReturnType<typeof computeProgress> =>
  computeProgress(m, [], Date.parse(AT))

describe('one list feeds every reader (AC-7)', () => {
  const m = mission()
  const list = waitingList(m, [], progressOf(m))

  it('a pending decision is in the list, typed with a v4 kind, with the ask and the why', () => {
    const decide = list.find((i) => i.kind === 'decide')
    expect(decide).toMatchObject({ kind: 'decide', stepId: 'stp-2', title: 'Which store?' })
    expect(describeWaiting(decide!).rank).toBe('unblock')
    expect(describeWaiting(decide!).ask).toContain('Which store?')
    // Every item has a v4 kind, an ask of at most 90 characters and a why of at most 60.
    for (const i of list) {
      const w = describeWaiting(i)
      expect(['main-failing', 'unblock', 'settle', 'review', 'close', 'attach']).toContain(w.rank)
      expect(w.ask.length).toBeGreaterThan(0)
      expect(w.ask.length).toBeLessThanOrEqual(WAITING_ASK_MAX)
      expect(w.why.length).toBeGreaterThan(0)
      expect(w.why.length).toBeLessThanOrEqual(WAITING_WHY_MAX)
    }
  })

  it('keeps the order the operator already saw: blockers, then the decision, then the rest', () => {
    expect(list.map((i) => i.kind)).toEqual(['blocker', 'decide'])
  })

  it('a decision at the human level is listed once, as a decision, not again as a human step', () => {
    expect(m.steps[1].verification).toBe('human')
    expect(list.filter((i) => i.kind === 'decide')).toHaveLength(1)
    const human = list.find((i) => i.kind === 'human-steps')
    expect(human).toBeUndefined()
    // A human step that is not a decision is still listed as one.
    const plain = mission()
    delete plain.steps[1].decision
    expect(waitingList(plain, [], progressOf(plain)).map((i) => i.kind)).toContain('human-steps')
  })

  it('a decided decision is not waiting, and a closed mission waits on nothing', () => {
    const decided = mission()
    decided.steps[1].decision!.chosen = 0
    expect(waitingList(decided, [], progressOf(decided)).some((i) => i.kind === 'decide')).toBe(
      false
    )
    const closed = { ...mission(), status: 'closed' } as Mission
    expect(waitingList(closed, [], progressOf(closed))).toEqual([])
  })

  it('the MCP read is that list: same items in the same order, the same line', () => {
    const mcp = youItems(m, [], progressOf(m))
    expect(mcp).toEqual(list)
    expect(youLine(mcp)).toBe(youLine(list))
    expect(mcp).toContainEqual({ kind: 'decide', stepId: 'stp-2', title: 'Which store?' })
  })

  const viewIn = (you: WaitingItem[]): MissionViewIn =>
    ({
      mission: { id: m.id, owner: { sessionId: OWNER }, steps: [], blockers: [] },
      title: 'Waiting',
      progress: progressOf(m),
      derived: { steps: [] },
      you
    }) as unknown as MissionViewIn

  it('the companion draws the list as given, in the list’s own words', () => {
    const [entry] = projectMissions([viewIn(list)], OWNER)
    expect(entry.you.map((y) => y.kind)).toEqual(list.map((i) => i.kind))
    expect(entry.you.map((y) => y.text)).toEqual(list.map((i) => describeWaiting(i).ask))
  })

  it('Your move files a card per item the list carries, with the list’s wording, and the decision too', () => {
    const drafts = missionDrafts(
      { root: '/repo', mission: { id: m.id, owner: { sessionId: OWNER } } as never, you: list },
      'live'
    )
    const decide = drafts.find((d) => d.sourceKey === `${m.id}:decide:stp-2`)
    expect(decide).toMatchObject({ kind: 'decide', source: 'mission' })
    expect(decide?.ask).toBe(youSentence(list.find((i) => i.kind === 'decide')!))
  })

  it('the renderer adds no row of its own: a decision node the server did not list is not a row', () => {
    const view = fixtureView('faq-like', {
      mission: {
        steps: mission().steps
      },
      view: { you: [] }
    })
    expect(youRows(view, FIXTURE_NOW)).toEqual([])
    expect(buildMissionModel(view, FIXTURE_NOW).youRows).toEqual([])
    // ...and when the server lists the decision, the row is there, in the server's place.
    const listed = fixtureView('faq-like', {
      mission: { steps: mission().steps },
      view: { you: list }
    })
    const rows = youRows(listed, FIXTURE_NOW)
    expect(rows.map((r) => r.kind)).toEqual(list.map((i) => i.kind))
    const decideRow = rows.find((r) => r.kind === 'decide')
    expect(decideRow).toMatchObject({ stepId: 'stp-2', risk: 'high' })
    const t = (key: string, v: Record<string, unknown> = {}): string =>
      `${key} ${JSON.stringify(v)}`
    expect(youRowText(t as never, listed, decideRow!, (s) => s)).toBe(
      'mission.you.decide {"title":"Which store?"}'
    )
  })
})

describe('the list is a pure read of derived values (S-3: a read leaves nothing behind)', () => {
  const deepFreeze = <T>(o: T): T => {
    if (o && typeof o === 'object') {
      Object.values(o as object).forEach(deepFreeze)
      Object.freeze(o)
    }
    return o
  }

  it('builds from frozen inputs and returns the same list twice, so it writes nothing it reads', () => {
    const m = deepFreeze(mission())
    const p = deepFreeze(progressOf(m))
    const kids = deepFreeze([
      { sessionId: 'child-1', pendingApprovals: 2, taskState: 'needs-input' as const }
    ])
    const a = waitingList(m, kids, p)
    expect(waitingList(m, kids, p)).toEqual(a)
    expect(a.map((i) => i.kind)).toEqual(['blocker', 'decide', 'approvals', 'needs-input'])
  })

  it('imports no file system, Electron, observer, ledger or store: it cannot write, cache or wake', () => {
    const src = readFileSync('src/main/missions/waiting.ts', 'utf8')
    const imports = [...src.matchAll(/^import[^\n]*from '([^']+)'/gm)].map((x) => x[1])
    for (const spec of imports) {
      expect(spec).not.toMatch(/^node:|^electron|observer|ledger|store|steward|fs/)
    }
  })
})
