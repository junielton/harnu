/**
 * T589: what the host tells the mod about the missions of one session. A mission is the session's when
 * it owns it or a step links it as a session; the projection keeps what the tick card draws (title,
 * position, the current step's executors, PRs, blockers, what the operator owes) and cuts the rest.
 */
import { describe, expect, it } from 'vitest'
import {
  missionStateKey,
  projectMissions,
  relationOf,
  type MissionViewIn
} from '../../src/main/companion/mission-state-core'
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
      { kind: 'blocker', reason: 'cloud credentials (stp-4)', unblocks: 'phase B' },
      { kind: 'checks', count: 2, stepIds: ['stp-2', 'stp-3'] },
      { kind: 'close' }
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

  it('carries open blockers with their owner, and words what the operator owes', () => {
    expect(m.blockers).toEqual([{ reason: 'waiting for the vendor export', owner: 'agent' }])
    expect(m.you).toEqual([
      { kind: 'blocker', text: 'cloud credentials (stp-4)' },
      { kind: 'checks', text: '2 due checks on stp-2, stp-3' },
      { kind: 'close', text: 'close the mission' }
    ])
  })

  it("strips control characters and cuts long text, so the mod's own check never refuses it", () => {
    const [x] = projectMissions(
      [
        view({
          title: `Acme\n${'long '.repeat(60)}`,
          you: [{ kind: 'blocker', reason: `${'r'.repeat(300)}\u0007`, unblocks: 'x' }]
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
