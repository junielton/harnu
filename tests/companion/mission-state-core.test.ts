/**
 * T589: what the host tells the mod about the missions of one session. A mission is the session's when
 * it owns it or a step links it as a session; the projection keeps what the tick card draws (title,
 * position, the current step's executors, PRs, blockers, what the operator owes) and cuts the rest.
 */
import { describe, expect, it } from 'vitest'
import {
  missionStateKey,
  missionViewInOf,
  projectMissions,
  relationOf,
  type MissionViewIn
} from '../../src/main/companion/mission-state-core'
import type { MissionDetail } from '../../src/main/missions/verbs-read'
import { parseMissionState } from '../../resources/companion/hooks/lib/mission-state'

const OWNER = '19cc0181-9f04-41a9-b93a-18231ee36b64'
const CHILD = '2a2a2a2a-0000-4000-8000-000000000002'
const OTHER = '3b3b3b3b-0000-4000-8000-000000000003'

const step = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: `title of ${id}`,
  kind: 'custom',
  links: [] as { kind: string; ref: string }[],
  blockers: [] as { reason: string; owner: string }[],
  ...over
})

const view = (over: Record<string, unknown> = {}): MissionViewIn =>
  ({
    mission: {
      id: 'mnt-7be1529e',
      owner: { sessionId: OWNER },
      linkedCard: 'T589-acme-migration',
      steps: [
        step('stp-1', { kind: 'fixed-start' }),
        step('stp-2'),
        step('stp-3', {
          links: [
            { kind: 'session', ref: CHILD },
            { kind: 'card', ref: 'card-acme' }
          ]
        }),
        step('stp-4', { kind: 'fixed-end' })
      ],
      blockers: [{ reason: 'waiting for the vendor export', owner: 'agent' }]
    },
    title: 'Acme content migration',
    progress: {
      total: 3,
      current: { from: 2, to: 2 },
      allDone: false,
      done: 1,
      verified: 1,
      states: { 'stp-2': 'verified', 'stp-3': 'running', 'stp-4': 'todo' },
      leftBehind: [],
      unprovable: [],
      computedAt: '2026-10-28T16:00:00.000Z'
    },
    derived: {
      progress: undefined,
      steps: [
        {
          stepId: 'stp-3',
          children: [
            {
              sessionId: CHILD,
              taskState: 'working',
              lastTransitionAt: '2026-10-28T15:48:00.000Z'
            },
            { sessionId: OWNER, taskState: 'idle' }
          ],
          links: [
            { kind: 'card', ref: 'card-acme', exists: true, prs: [{ number: 264, state: 'OPEN' }] },
            { kind: 'pr', ref: '#266', number: 266, exists: true, state: 'OPEN' },
            { kind: 'pr', ref: '#264', number: 264, exists: true, state: 'OPEN' }
          ]
        }
      ]
    },
    you: [
      {
        kind: 'unblock',
        id: 'blk-1',
        ask: 'Unblock: cloud credentials (stp-4)',
        why: 'phase B starts',
        stepId: 'stp-4',
        blockerId: 'blk-1'
      },
      {
        kind: 'settle',
        id: 'stp-2:ac-1',
        ask: 'Tick 2 due checks on stp-2, stp-3',
        why: 'the steps are done',
        stepId: 'stp-2',
        criterionId: 'ac-1'
      },
      {
        kind: 'close',
        id: 'close',
        ask: 'Close the mission: its end is verified',
        why: 'it is done'
      }
    ],
    ...over
  }) as unknown as MissionViewIn

describe("which missions are a session's", () => {
  it('the owner, and a session a step links as a child; nobody else', () => {
    expect(relationOf(view(), OWNER)).toBe('owner')
    expect(relationOf(view(), CHILD)).toBe('child')
    expect(relationOf(view(), OTHER)).toBeNull()
  })

  it("keeps the owner's missions first and at most four", () => {
    const many = Array.from({ length: 6 }, (_, i) =>
      view({ mission: { ...view().mission, id: `mnt-0000000${i}` } })
    )
    const mine = projectMissions(many, OWNER)
    expect(mine).toHaveLength(4)
    expect(mine.every((m) => m.role === 'owner')).toBe(true)
    const mixed = projectMissions(
      [
        view({ mission: { ...view().mission, id: 'mnt-00000009', owner: { sessionId: OTHER } } }),
        view()
      ],
      CHILD
    )
    expect(mixed.map((m) => m.role)).toEqual(['child', 'child'])
    expect(projectMissions([view()], OTHER)).toEqual([])
  })
})

describe('the projection', () => {
  const [m] = projectMissions([view()], OWNER)

  it('is a push the mod accepts', () => {
    expect(parseMissionState({ missions: [m] })).not.toBeNull()
  })

  it("carries the title, the card and the server's own progress, never a recount", () => {
    expect(m.id).toBe('mnt-7be1529e')
    expect(m.title).toBe('Acme content migration')
    expect(m.card).toBe('T589-acme-migration')
    expect(m.role).toBe('owner')
    expect(m.progress).toEqual({
      total: 3,
      current: { from: 2, to: 2 },
      done: 1,
      verified: 1,
      allDone: false
    })
  })

  it('lists the steps the progress counts, not a legacy fixed start, with their state', () => {
    expect(m.steps.map((s) => [s.id, s.state])).toEqual([
      ['stp-2', 'verified'],
      ['stp-3', 'running'],
      ['stp-4', 'todo']
    ])
  })

  it('gives the current step its executors, its card and its PRs (once each)', () => {
    const s = m.steps.find((x) => x.id === 'stp-3')!
    expect(s.card).toBe('card-acme')
    expect(s.children).toEqual([
      { taskState: 'working', lastTransitionAt: Date.parse('2026-10-28T15:48:00.000Z') }
    ])
    expect(s.prs).toEqual([
      { number: 264, state: 'OPEN' },
      { number: 266, state: 'OPEN' }
    ])
    expect(m.steps.find((x) => x.id === 'stp-2')!.children).toEqual([]) // not current: none
  })

  it("carries open blockers with their owner, and words what the operator owes in the waiting list's words", () => {
    expect(m.blockers).toEqual([{ reason: 'waiting for the vendor export', owner: 'agent' }])
    expect(m.you).toEqual([
      { kind: 'unblock', text: 'Unblock: cloud credentials (stp-4)' },
      { kind: 'settle', text: 'Tick 2 due checks on stp-2, stp-3' },
      { kind: 'close', text: 'Close the mission: its end is verified' }
    ])
  })

  it("strips control characters and cuts long text, so the mod's own check never refuses it", () => {
    const [x] = projectMissions(
      [
        view({
          title: `Acme\n${'long '.repeat(60)}`,
          you: [
            {
              kind: 'unblock',
              id: 'blk-9',
              ask: `${'r'.repeat(300)}\u0007`,
              why: 'x',
              stepId: null,
              blockerId: 'blk-9'
            }
          ]
        })
      ],
      OWNER
    )
    expect(x.title.length).toBeLessThanOrEqual(120)
    expect(x.title).not.toMatch(/\n/)
    expect(x.you[0].text.length).toBeLessThanOrEqual(120)
    expect(parseMissionState({ missions: [x] })).not.toBeNull()
  })

  it('a mission with no steps or no derive still projects, with nothing to draw but its title', () => {
    const bare = view({
      mission: { ...view().mission, steps: [] },
      progress: { ...view().progress, total: 0, current: null, done: 0, verified: 0, states: {} },
      derived: { steps: [] },
      you: []
    })
    const [x] = projectMissions([bare], OWNER)
    expect(x.steps).toEqual([])
    expect(parseMissionState({ missions: [x] })).not.toBeNull()
  })
})

describe('the key that says whether anything changed', () => {
  it('is the same for the same state and different when a step moves or a PR merges', () => {
    const a = projectMissions([view()], OWNER)
    expect(missionStateKey(a)).toBe(missionStateKey(projectMissions([view()], OWNER)))
    const moved = view({
      derived: {
        steps: [
          {
            stepId: 'stp-3',
            children: [],
            links: [{ kind: 'pr', ref: '#264', number: 264, exists: true, state: 'MERGED' }]
          }
        ]
      }
    })
    expect(missionStateKey(projectMissions([moved], OWNER))).not.toBe(missionStateKey(a))
    expect(missionStateKey([])).toBe(missionStateKey([]))
  })
})

describe('a mission with more than 40 steps (T589 review)', () => {
  const many = (): MissionViewIn => {
    const steps = Array.from({ length: 60 }, (_, i) => step('stp-' + (i + 2)))
    const states: Record<string, string> = {}
    steps.forEach(
      (s, i) => (states[s.id] = i + 1 < 50 ? 'verified' : i + 1 === 50 ? 'running' : 'todo')
    )
    return view({
      mission: { ...view().mission, steps },
      progress: {
        total: 60,
        current: { from: 50, to: 50 },
        allDone: false,
        done: 49,
        verified: 49,
        states,
        leftBehind: [],
        unprovable: [],
        computedAt: 'x'
      },
      derived: {
        steps: [
          {
            stepId: 'stp-51',
            children: [
              {
                sessionId: CHILD,
                taskState: 'working',
                lastTransitionAt: '2026-10-28T15:48:00.000Z'
              }
            ],
            links: []
          }
        ]
      }
    })
  }

  it('keeps the window around the current step, with the offset of its first step', () => {
    const [m] = projectMissions([many()], OWNER)
    expect(m.steps).toHaveLength(40)
    expect(m.progress.current).toEqual({ from: 50, to: 50 }) // the server's, never rewritten
    expect(m.offset).toBeGreaterThan(0)
    const at = m.steps[50 - 1 - (m.offset ?? 0)]
    expect(at.id).toBe('stp-51')
    expect(at.children).toEqual([
      { taskState: 'working', lastTransitionAt: Date.parse('2026-10-28T15:48:00.000Z') }
    ])
    expect(parseMissionState({ missions: [m] })).not.toBeNull()
  })

  it('a mission within the cap carries no offset', () => {
    const [m] = projectMissions([view()], OWNER)
    expect(m.offset).toBeUndefined()
  })
})

// ---- Missions v4 S-40 (Decision 12): a v4 record shows its executors and its pull request badges --------------

/** The slice of a v4 `mission_get` detail the companion reads; two steps, the second one running. */
function detailOf(): MissionDetail {
  const base = { milestone: null, optional: false, card: null, startedAt: null, waitsFor: null }
  const crit = { criteria: [], open: [], blockers: [], blocked: false }
  return {
    ok: true,
    id: 'mnt-7be1529e',
    title: 'Score report',
    doneWhen: 'Every candidate sees a score report',
    status: 'open',
    state: 'open',
    stateLabel: 'open',
    standing: 'leads',
    leads: OWNER,
    source: 'v4',
    progress: {} as MissionDetail['progress'],
    milestones: [],
    steps: [
      {
        ...base,
        ...crit,
        id: 'stp-1',
        title: 'Load the test files',
        state: 'done',
        stateLabel: 'done',
        links: [{ kind: 'pr', ref: '#264' }]
      },
      {
        ...base,
        ...crit,
        id: 'stp-2',
        title: 'Score one file',
        state: 'running',
        stateLabel: 'running',
        links: [
          { kind: 'session', ref: CHILD },
          { kind: 'session', ref: OWNER },
          { kind: 'pr', ref: 'org/repo#266' }
        ]
      }
    ],
    next: null,
    waiting: { items: [], others: [], emptyLine: '' } as unknown as MissionDetail['waiting'],
    summary: '',
    links: [],
    blockers: [],
    sessions: []
  } as unknown as MissionDetail
}

describe('a v4 record read through the view (S-40)', () => {
  const facts = {
    steps: { 'stp-1': { pr: 'merged' }, 'stp-2': { pr: 'open', workerWorking: true } },
    taskState: (sid: string): string | undefined => (sid === CHILD ? 'working' : undefined)
  }

  it('draws the executors of the running step (never the leader) and the pull request badges', () => {
    const [m] = projectMissions([missionViewInOf(detailOf(), facts)], OWNER)
    const running = m.steps.find((s) => s.id === 'stp-2')
    expect(running?.children).toEqual([{ taskState: 'working', lastTransitionAt: null }])
    expect(running?.prs).toEqual([{ number: 266, state: 'OPEN' }])
    expect(m.steps.find((s) => s.id === 'stp-1')?.prs).toEqual([{ number: 264, state: 'MERGED' }])
    expect(parseMissionState({ missions: [m] })).not.toBeNull()
  })

  it("without the view's facts an executor shows with an unknown state and no pull request gets a badge", () => {
    const [m] = projectMissions([missionViewInOf(detailOf())], OWNER)
    const running = m.steps.find((s) => s.id === 'stp-2')
    expect(running?.children).toEqual([{ taskState: 'unknown', lastTransitionAt: null }])
    for (const s of m.steps) expect(s.prs).toEqual([])
  })

  it('a pull request whose state was not read gets no badge', () => {
    const [m] = projectMissions(
      [missionViewInOf(detailOf(), { steps: { 'stp-2': { workerWorking: true } } })],
      OWNER
    )
    expect(m.steps.find((s) => s.id === 'stp-2')?.prs).toEqual([])
  })
})
