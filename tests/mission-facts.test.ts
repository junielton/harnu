/**
 * Missions v4 · S-16a · V-2 — one adapter gathers the facts.
 *
 * `src/main/missions/facts.ts` builds each step's `StepInput` (the input of S-7's state function) from
 * what Harnu already holds: the board, chapter 2's pull request join and its last-known facts, and the
 * session list. Every source is injected, so each case here hands over a plain fake. The module spawns
 * nothing and reads no file itself; a spy on `node:child_process` and on the synchronous `node:fs`
 * calls proves it. A fact the adapter could not read is ABSENT from the input, never `false`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const spies = vi.hoisted(() => ({
  spawn: vi.fn(),
  sync: vi.fn()
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const wrap = <T extends (...a: never[]) => unknown>(f: T): T =>
    ((...a: Parameters<T>) => {
      spies.spawn()
      return f(...a)
    }) as T
  return {
    ...actual,
    spawn: wrap(actual.spawn),
    spawnSync: wrap(actual.spawnSync),
    exec: wrap(actual.exec),
    execFile: wrap(actual.execFile),
    execFileSync: wrap(actual.execFileSync),
    execSync: wrap(actual.execSync),
    fork: wrap(actual.fork)
  }
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const wrap = <T extends (...a: never[]) => unknown>(f: T): T =>
    ((...a: Parameters<T>) => {
      spies.sync()
      return f(...a)
    }) as T
  const patched = {
    ...actual,
    readFileSync: wrap(actual.readFileSync),
    statSync: wrap(actual.statSync),
    lstatSync: wrap(actual.lstatSync),
    existsSync: wrap(actual.existsSync),
    readdirSync: wrap(actual.readdirSync),
    realpathSync: wrap(actual.realpathSync)
  }
  return { ...patched, default: patched }
})

import { buildNewCardContent } from '../src/main/roadmap-core'
import type { MissionV4 } from '../src/main/missions/model'
import type { CardFile } from '../src/main/missions/cards'
import {
  gatherStepFacts,
  gatherStepInputs,
  type FactsDeps,
  type PrJoin
} from '../src/main/missions/facts'

const ROOT = '/repo'
const LEADER = '3f1c9a52-7d4e-4b8a-9c21-5e6a0b7d8f10'
const WORKER = '8a2d4c6e-1b3f-4a5c-9d7e-2f4a6c8e0b1d'
const ID = 'mnt-d0000001'
const AT = '2026-11-14T10:00:00Z'

type PrRow = PrJoin['numbers'][number]
const pr = (over: Partial<NonNullable<PrRow>> = {}): NonNullable<PrRow> =>
  ({
    number: 12,
    title: 't',
    branch: 'feat/x',
    base: 'main',
    state: 'OPEN',
    isDraft: false,
    mergeable: true,
    reviewDecision: null,
    ci: 'passing',
    checks: [],
    url: 'https://example.test/pull/12',
    author: 'a',
    updatedAt: null,
    createdAt: null,
    mergedAt: null,
    ...over
  }) as NonNullable<PrRow>

function record(steps: Array<Record<string, unknown>>): MissionV4 {
  return {
    schemaVersion: 4,
    id: ID,
    title: 'Score report',
    doneWhen: 'Every candidate sees a score report',
    status: 'open',
    milestones: [],
    steps: steps.map((s, i) => ({
      id: `stp-${i + 1}`,
      title: `Step ${i + 1}`,
      acs: [{ id: 'ac-1', text: 'The pull request is merged', by: 'fact', fact: 'pr-merged' }],
      links: [],
      blockers: [],
      ...s
    })),
    sessions: [{ id: LEADER, role: 'leads', from: AT, to: null }],
    links: [],
    blockers: []
  } as MissionV4
}

function cardFile(
  slug: string,
  over: { status?: string; step?: string; executedIn?: string }
): CardFile {
  let content = buildNewCardContent({
    slug,
    id: slug,
    title: slug,
    body: 'x',
    mission: ID,
    step: over.step ?? 'stp-1',
    provenance: { author: 'agent', at: AT }
  })
  content = content.replace('status: backlog', `status: ${over.status ?? 'backlog'}`)
  if (over.executedIn)
    content = content.replace(/^status: .*$/m, (m) => `${m}\nexecutedIn: ${over.executedIn}`)
  return { slug, content }
}

const emptyJoin = (over: Partial<PrJoin> = {}): PrJoin => ({
  ghAvailable: true,
  worktrees: {},
  branches: {},
  numbers: {},
  ...over
})

function deps(over: Partial<FactsDeps> = {}): FactsDeps & {
  calls: { findPrs: unknown[]; findMainCi: unknown[]; board: number }
} {
  const calls = { findPrs: [] as unknown[], findMainCi: [] as unknown[], board: 0 }
  const base: FactsDeps = {
    board: async () => {
      calls.board++
      return []
    },
    findPrs: async (refs) => {
      calls.findPrs.push(refs)
      return emptyJoin()
    },
    findMainCi: async (numbers) => {
      calls.findMainCi.push(numbers)
      return { ghAvailable: true, byNumber: {} }
    },
    lastKnown: () => null,
    pathExists: async () => true,
    taskState: () => undefined
  }
  return Object.assign({ ...base, ...over }, { calls })
}

beforeEach(() => {
  spies.spawn.mockClear()
  spies.sync.mockClear()
})

describe('facts come from what Harnu holds', () => {
  it('builds every step input from the board, the pull request join, the last-known cache and the session list, with no spawn and no sync read', async () => {
    const rec = record([
      {
        // stp-1: a dispatched step with a card in review and an open pull request with passing CI.
        card: 'T1-a',
        links: [
          { kind: 'pr', ref: '12' },
          { kind: 'worktree', ref: '.claude/worktrees/a' },
          { kind: 'doc', ref: 'docs/a.md' },
          { kind: 'url', ref: 'https://example.test/never-checked' },
          { kind: 'session', ref: WORKER }
        ]
      },
      // stp-2: a merged pull request whose merge commit is green on main.
      { links: [{ kind: 'pr', ref: '20' }] },
      // stp-3: nothing at all.
      {}
    ])
    const d = deps({
      board: async () => [
        cardFile('T1-a', { status: 'review', step: 'stp-1', executedIn: 'feat/x' })
      ],
      findPrs: async () =>
        emptyJoin({
          numbers: {
            12: pr({ number: 12, ci: 'passing' }),
            20: pr({ number: 20, state: 'MERGED' })
          },
          worktrees: {
            '/repo/.claude/worktrees/a': {
              exists: true,
              branch: 'feat/x',
              head: null,
              prs: [pr({ number: 12 })]
            }
          },
          branches: { 'feat/x': [pr({ number: 12 })] }
        }),
      findMainCi: async () => ({ ghAvailable: true, byNumber: { 20: 'passing' } }),
      taskState: (id) => (id === WORKER ? 'working' : undefined)
    })

    const inputs = await gatherStepInputs(ROOT, rec, d)

    expect(inputs['stp-1']).toEqual({
      card: 'review',
      pr: 'open',
      facts: { 'ci-green': true, 'link-exists': true },
      workerWorking: true
    })
    expect(inputs['stp-2']).toEqual({
      pr: 'merged',
      facts: { 'main-green': true, 'link-exists': true }
    })
    // Nothing to read: every key is absent, none is false.
    expect(inputs['stp-3']).toEqual({})
    expect(spies.spawn).not.toHaveBeenCalled()
    expect(spies.sync).not.toHaveBeenCalled()
  })

  it('asks the join ONCE for the whole mission: the pr links, the worktree paths and the card branches', async () => {
    const rec = record([
      {
        card: 'T1-a',
        links: [
          { kind: 'pr', ref: '#12' },
          { kind: 'worktree', ref: 'wt/a' }
        ]
      },
      { links: [{ kind: 'pr', ref: 'https://example.test/o/r/pull/30' }] }
    ])
    const d = deps({
      board: async () => [cardFile('T1-a', { executedIn: 'feat/x' })]
    })
    await gatherStepInputs(ROOT, rec, d)
    expect(d.calls.findPrs).toEqual([
      { worktrees: ['/repo/wt/a'], branches: ['feat/x'], numbers: [12, 30] }
    ])
  })

  it('reads the board once, and only when a step names a card', async () => {
    const none = deps()
    await gatherStepInputs(ROOT, record([{}, { links: [{ kind: 'pr', ref: '5' }] }]), none)
    expect(none.calls.board).toBe(0)

    const some = deps({ board: async () => [cardFile('T1-a', { status: 'in-progress' })] })
    const inputs = await gatherStepInputs(ROOT, record([{ card: 'T1-a' }, { card: 'T1-a' }]), some)
    expect(inputs['stp-1'].card).toBe('in-progress')
    // The same card stamped for stp-1 is not stp-2's card: absent, never a wrong column.
    expect(inputs['stp-2'].card).toBeUndefined()
  })

  it('finds a card by the name the step records, and leaves an unreadable board absent', async () => {
    const stamped = deps({
      board: async () => [cardFile('T9-z', { status: 'ready', step: 'stp-1' })]
    })
    expect((await gatherStepInputs(ROOT, record([{ card: 'T9-z' }]), stamped))['stp-1'].card).toBe(
      'ready'
    )

    const broken = deps({
      board: async () => {
        throw new Error('no board')
      }
    })
    const inputs = await gatherStepInputs(ROOT, record([{ card: 'T1-a' }]), broken)
    expect(inputs['stp-1']).toEqual({})
  })
})

describe('a fact that was not read is absent, never false', () => {
  it('leaves the pull request absent when GitHub could not be reached and nothing was seen before', async () => {
    const d = deps({ findPrs: async () => emptyJoin({ ghAvailable: false }) })
    const inputs = await gatherStepInputs(ROOT, record([{ links: [{ kind: 'pr', ref: '12' }] }]), d)
    expect(inputs['stp-1'].pr).toBeUndefined()
    expect(inputs['stp-1'].facts?.['ci-green']).toBeUndefined()
    expect(inputs['stp-1'].facts?.['link-exists']).toBeUndefined()
  })

  it('keeps the last-known state through an unreachable GitHub: never a downgrade', async () => {
    const d = deps({
      findPrs: async () => emptyJoin({ ghAvailable: false }),
      lastKnown: (kind, ref) =>
        kind === 'pr' && ref === '12'
          ? { state: 'MERGED', prNumber: 12, at: AT }
          : kind === 'pr-main' && ref === '12'
            ? { state: 'passing', prNumber: 12, at: AT }
            : null
    })
    const inputs = await gatherStepInputs(ROOT, record([{ links: [{ kind: 'pr', ref: '12' }] }]), d)
    expect(inputs['stp-1']).toEqual({
      pr: 'merged',
      facts: { 'main-green': true, 'link-exists': true }
    })
  })

  it('leaves a number GitHub does not list (aged out) absent rather than none', async () => {
    const d = deps({ findPrs: async () => emptyJoin({ numbers: { 12: null } }) })
    const inputs = await gatherStepInputs(ROOT, record([{ links: [{ kind: 'pr', ref: '12' }] }]), d)
    expect(inputs['stp-1'].pr).toBeUndefined()
  })

  it('reads none when GitHub answered and the step branch has no pull request', async () => {
    const d = deps({
      board: async () => [cardFile('T1-a', { executedIn: 'feat/x' })],
      findPrs: async () => emptyJoin({ branches: { 'feat/x': [] } })
    })
    const inputs = await gatherStepInputs(ROOT, record([{ card: 'T1-a' }]), d)
    expect(inputs['stp-1'].pr).toBe('none')
  })

  it('reads ci-green from the pull request ci: passing true, failing false, pending or unknown absent', async () => {
    for (const [ci, expected] of [
      ['passing', true],
      ['failing', false],
      ['pending', undefined],
      ['unknown', undefined]
    ] as const) {
      const d = deps({ findPrs: async () => emptyJoin({ numbers: { 12: pr({ ci }) } }) })
      const inputs = await gatherStepInputs(
        ROOT,
        record([{ links: [{ kind: 'pr', ref: '12' }] }]),
        d
      )
      expect(inputs['stp-1'].facts?.['ci-green'], ci).toBe(expected)
    }
  })

  it('reads main-green from main CI for merged pull requests only: passing true, failing false, else absent', async () => {
    for (const [verdict, expected] of [
      ['passing', true],
      ['failing', false],
      ['pending', undefined],
      [null, undefined]
    ] as const) {
      const d = deps({
        findPrs: async () => emptyJoin({ numbers: { 12: pr({ state: 'MERGED' }) } }),
        findMainCi: async () => ({ ghAvailable: true, byNumber: { 12: verdict } })
      })
      const inputs = await gatherStepInputs(
        ROOT,
        record([{ links: [{ kind: 'pr', ref: '12' }] }]),
        d
      )
      expect(inputs['stp-1'].facts?.['main-green'], String(verdict)).toBe(expected)
    }
    const open = deps({ findPrs: async () => emptyJoin({ numbers: { 12: pr() } }) })
    await gatherStepInputs(ROOT, record([{ links: [{ kind: 'pr', ref: '12' }] }]), open)
    expect(open.calls.findMainCi).toEqual([])
  })

  it('does not call the join at all when the mission has nothing for it to resolve', async () => {
    const d = deps()
    await gatherStepInputs(
      ROOT,
      record([{}, { links: [{ kind: 'url', ref: 'https://x.test' }] }]),
      d
    )
    expect(d.calls.findPrs).toEqual([])
  })
})

describe('link-exists (V-2)', () => {
  const links = (...l: Array<[string, string]>): Array<{ kind: string; ref: string }> =>
    l.map(([kind, ref]) => ({ kind, ref }))

  it('holds when the step has a pr, worktree or doc link and each resolves', async () => {
    const d = deps({ findPrs: async () => emptyJoin({ numbers: { 12: pr() } }) })
    const rec = record([
      { links: links(['doc', 'docs/a.md']) },
      { links: links(['pr', '12'], ['worktree', 'wt/a'], ['doc', 'docs/a.md']) }
    ])
    const inputs = await gatherStepInputs(ROOT, rec, d)
    expect(inputs['stp-1'].facts?.['link-exists']).toBe(true)
    expect(inputs['stp-2'].facts?.['link-exists']).toBe(true)
  })

  it('does not hold when one link does not resolve: a missing path, a closed pull request', async () => {
    const d = deps({
      pathExists: async (p) => !p.endsWith('gone.md'),
      findPrs: async () => emptyJoin({ numbers: { 12: pr({ state: 'CLOSED' }) } })
    })
    const rec = record([
      { links: links(['doc', 'docs/a.md'], ['doc', 'docs/gone.md']) },
      { links: links(['pr', '12']) }
    ])
    const inputs = await gatherStepInputs(ROOT, rec, d)
    expect(inputs['stp-1'].facts?.['link-exists']).toBe(false)
    expect(inputs['stp-2'].facts?.['link-exists']).toBe(false)
  })

  it('never checks a url link, and a step with only url links has nothing to read', async () => {
    const probe = vi.fn(async () => false)
    const d = deps({ pathExists: probe })
    const inputs = await gatherStepInputs(
      ROOT,
      record([{ links: links(['url', 'https://example.test/x']) }]),
      d
    )
    expect(inputs['stp-1']).toEqual({})
    expect(probe).not.toHaveBeenCalled()
  })

  it('ignores a url link next to a doc link: the doc decides', async () => {
    const d = deps()
    const inputs = await gatherStepInputs(
      ROOT,
      record([{ links: links(['url', 'https://example.test/x'], ['doc', 'docs/a.md']) }]),
      d
    )
    expect(inputs['stp-1'].facts?.['link-exists']).toBe(true)
  })
})

describe('a worker working', () => {
  it('is true for a session link other than the leader whose task state is working', async () => {
    const d = deps({ taskState: () => 'working' })
    const inputs = await gatherStepInputs(
      ROOT,
      record([
        { links: [{ kind: 'session', ref: LEADER }] },
        { links: [{ kind: 'session', ref: WORKER }] }
      ]),
      d
    )
    expect(inputs['stp-1'].workerWorking).toBeUndefined()
    expect(inputs['stp-2'].workerWorking).toBe(true)
  })

  it('is absent for an idle or unknown worker', async () => {
    for (const state of ['idle', 'needs-input', 'completed', undefined]) {
      const d = deps({ taskState: () => state })
      const inputs = await gatherStepInputs(
        ROOT,
        record([{ links: [{ kind: 'session', ref: WORKER }] }]),
        d
      )
      expect(inputs['stp-1'].workerWorking, String(state)).toBeUndefined()
    }
  })
})

describe('what the observer needs beyond the inputs', () => {
  it('returns the sticky sightings and the pull requests found per step, and writes nothing itself', async () => {
    const rec = record([
      { card: 'T1-a', links: [{ kind: 'pr', ref: '12' }] },
      { links: [{ kind: 'pr', ref: '20' }] }
    ])
    const d = deps({
      board: async () => [cardFile('T1-a', { executedIn: 'feat/x' })],
      findPrs: async () =>
        emptyJoin({
          numbers: {
            12: pr({ number: 12, ci: 'failing' }),
            20: pr({ number: 20, state: 'MERGED' })
          },
          branches: {
            'feat/x': [pr({ number: 12 }), pr({ number: 13, state: 'CLOSED', branch: 'feat/x' })]
          }
        }),
      findMainCi: async () => ({ ghAvailable: true, byNumber: { 20: 'passing' } })
    })
    const got = await gatherStepFacts(ROOT, rec, d)

    expect(got.sightings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'pr',
          ref: '12',
          seen: expect.objectContaining({ state: 'OPEN' })
        }),
        expect.objectContaining({
          kind: 'pr-ci',
          ref: '12',
          seen: expect.objectContaining({ state: 'failing' })
        }),
        expect.objectContaining({
          kind: 'pr',
          ref: '20',
          seen: expect.objectContaining({ state: 'MERGED' })
        }),
        expect.objectContaining({
          kind: 'pr-main',
          ref: '20',
          seen: expect.objectContaining({ state: 'passing' })
        })
      ])
    )
    // A pull request seen closed is never remembered as resolved.
    expect(got.sightings.some((s) => s.ref === '13')).toBe(false)
    // Found per step, by the step the facts came from; the closed one is reported as closed.
    expect(got.found).toEqual(
      expect.arrayContaining([
        { stepId: 'stp-1', number: 12, state: 'open' },
        { stepId: 'stp-1', number: 13, state: 'closed' },
        { stepId: 'stp-2', number: 20, state: 'merged' }
      ])
    )
    expect(spies.spawn).not.toHaveBeenCalled()
  })
})
