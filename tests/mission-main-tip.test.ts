/**
 * BUG-294 — "main is failing" means the base branch is red NOW.
 *
 * A merged step's `main-green` used to be the CI of that step's own merge commit, read once and then
 * kept, so a red merge stayed red forever even after a later commit turned the branch green again.
 * Now the adapter also reads the base branch's current tip (one read per base branch per pass), and the
 * waiting list raises at most one `main-failing` item per base branch, naming the first step merged
 * since the last green commit. Every source is a plain fake: nothing here spawns `gh` or `git`.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { MissionV4 } from '../src/main/missions/model'
import type { StepInput } from '../src/main/missions/state'
import {
  gatherStepFacts,
  gatherStepInputs,
  resetStepFactsMemory,
  type FactsDeps,
  type PrJoin
} from '../src/main/missions/facts'
import { waitingListV4 } from '../src/main/missions/waiting'
import type { LinkResolution } from '../src/main/mission-link-cache'

const ROOT = '/repo'
const LEADER = '3f1c9a52-7d4e-4b8a-9c21-5e6a0b7d8f10'
const AT = '2026-11-14T10:00:00Z'

type Ci = 'passing' | 'failing' | 'pending' | 'unknown'
type PrRow = NonNullable<PrJoin['numbers'][number]>

const merged = (number: number, over: Partial<PrRow> = {}): PrRow =>
  ({
    number,
    title: 't',
    branch: `feat/${number}`,
    base: 'main',
    state: 'MERGED',
    isDraft: false,
    mergeable: true,
    reviewDecision: null,
    ci: 'passing',
    checks: [],
    url: `https://example.test/pull/${number}`,
    author: 'a',
    updatedAt: null,
    createdAt: null,
    mergedAt: `2026-11-1${number % 10}T10:00:00Z`,
    ...over
  }) as PrRow

function record(prs: number[]): MissionV4 {
  return {
    schemaVersion: 4,
    id: 'mnt-d0000001',
    title: 'Score report',
    doneWhen: 'Every candidate sees a score report',
    status: 'open',
    milestones: [],
    steps: prs.map((n, i) => ({
      id: `stp-${i + 1}`,
      title: `Step ${i + 1}`,
      acs: [{ id: 'ac-1', text: 'The pull request is merged', by: 'fact', fact: 'pr-merged' }],
      links: [{ kind: 'pr', ref: String(n) }],
      blockers: []
    })),
    sessions: [{ id: LEADER, role: 'leads', from: AT, to: null }],
    links: [],
    blockers: []
  } as MissionV4
}

interface Fakes {
  /** The merge commit's CI by pull request number. */
  merge?: Record<number, Ci | null>
  /** The base branch tip's CI by branch name. */
  tip?: Record<string, Ci | null>
  rows: PrRow[]
  sticky?: Record<number, LinkResolution>
}

function deps(f: Fakes): FactsDeps & { tipAsks: string[][]; mergeAsks: number[][] } {
  const tipAsks: string[][] = []
  const mergeAsks: number[][] = []
  const d: FactsDeps = {
    findPrs: async () => ({
      ghAvailable: true,
      worktrees: {},
      branches: {},
      numbers: Object.fromEntries(f.rows.map((r) => [r.number, r]))
    }),
    findMainCi: async (numbers) => {
      mergeAsks.push(numbers)
      return { ghAvailable: true, byNumber: f.merge ?? {} }
    },
    findBaseCi: async (bases) => {
      tipAsks.push(bases)
      return { ghAvailable: true, byBase: f.tip ?? {} }
    },
    lastKnown: (kind, ref) => (kind === 'pr-main' ? (f.sticky?.[Number(ref)] ?? null) : null),
    pathExists: async () => true,
    taskState: () => undefined
  }
  return Object.assign(d, { tipAsks, mergeAsks })
}

beforeEach(() => resetStepFactsMemory())

describe('AC-3 · main-green holds when the merge commit OR a later commit on the base is green', () => {
  it('a red merge commit under a green tip reads green', async () => {
    const d = deps({ rows: [merged(12)], merge: { 12: 'failing' }, tip: { main: 'passing' } })
    const inputs = await gatherStepInputs(ROOT, record([12]), d)
    expect(inputs['stp-1'].facts?.['main-green']).toBe(true)
  })

  it('a green merge commit reads green whatever the tip says', async () => {
    const d = deps({ rows: [merged(12)], merge: { 12: 'passing' }, tip: { main: 'failing' } })
    const inputs = await gatherStepInputs(ROOT, record([12]), d)
    expect(inputs['stp-1'].facts?.['main-green']).toBe(true)
  })

  it('a red merge commit under a red tip reads red', async () => {
    const d = deps({ rows: [merged(12)], merge: { 12: 'failing' }, tip: { main: 'failing' } })
    const inputs = await gatherStepInputs(ROOT, record([12]), d)
    expect(inputs['stp-1'].facts?.['main-green']).toBe(false)
  })

  it('a red merge commit stays red while the tip has no verdict yet (pending, unknown or unread)', async () => {
    for (const tip of ['pending', 'unknown', null] as const) {
      const d = deps({ rows: [merged(12)], merge: { 12: 'failing' }, tip: { main: tip } })
      const inputs = await gatherStepInputs(ROOT, record([12]), d)
      expect(inputs['stp-1'].facts?.['main-green'], String(tip)).toBe(false)
    }
  })

  it('a mission without a tip source reads exactly as before', async () => {
    const d = deps({ rows: [merged(12)], merge: { 12: 'failing' } })
    delete d.findBaseCi
    const inputs = await gatherStepInputs(ROOT, record([12]), d)
    expect(inputs['stp-1'].facts?.['main-green']).toBe(false)
  })

  it('a tip read that throws leaves the merge commit verdict alone', async () => {
    const d = deps({ rows: [merged(12)], merge: { 12: 'failing' } })
    d.findBaseCi = async () => {
      throw new Error('gh down')
    }
    const inputs = await gatherStepInputs(ROOT, record([12]), d)
    expect(inputs['stp-1'].facts?.['main-green']).toBe(false)
  })

  it('a red merge that a green tip superseded is remembered as green, so a later red tip does not blame it', async () => {
    const green = deps({ rows: [merged(12)], merge: { 12: 'failing' }, tip: { main: 'passing' } })
    const first = await gatherStepFacts(ROOT, record([12]), green)
    // What the observer would persist from that pass.
    const seen = first.sightings.find((s) => s.kind === 'pr-main' && s.ref === '12')
    expect(seen?.seen.state).toBe('passing')

    // Later main broke again for another reason: the old merge commit still reads red, the tip too.
    const red = deps({
      rows: [merged(12)],
      merge: { 12: 'failing' },
      tip: { main: 'failing' },
      sticky: { 12: { state: 'passing', prNumber: 12, at: 1 } as LinkResolution }
    })
    const inputs = await gatherStepInputs(ROOT, record([12]), red)
    expect(inputs['stp-1'].facts?.['main-green']).toBe(true)
  })
})

describe('AC-4 · one tip read per base branch per pass, never one per step', () => {
  it('asks once for N steps on one base', async () => {
    const d = deps({
      rows: [merged(12), merged(13), merged(14)],
      merge: { 12: 'failing', 13: 'failing', 14: 'failing' },
      tip: { main: 'passing' }
    })
    await gatherStepInputs(ROOT, record([12, 13, 14]), d)
    expect(d.tipAsks).toEqual([['main']])
  })

  it('asks once per distinct base branch', async () => {
    const d = deps({
      rows: [merged(12), merged(13, { base: 'release' }), merged(14)],
      merge: { 12: 'failing', 13: 'failing', 14: 'failing' },
      tip: { main: 'passing', release: 'failing' }
    })
    const inputs = await gatherStepInputs(ROOT, record([12, 13, 14]), d)
    expect(d.tipAsks).toHaveLength(1)
    expect([...d.tipAsks[0]].sort()).toEqual(['main', 'release'])
    expect(inputs['stp-1'].facts?.['main-green']).toBe(true)
    expect(inputs['stp-2'].facts?.['main-green']).toBe(false)
    expect(inputs['stp-3'].facts?.['main-green']).toBe(true)
  })

  it('does not ask at all when every merge commit is green, or nothing is merged', async () => {
    const green = deps({ rows: [merged(12)], merge: { 12: 'passing' }, tip: { main: 'failing' } })
    await gatherStepInputs(ROOT, record([12]), green)
    expect(green.tipAsks).toEqual([])
    const open = deps({ rows: [merged(12, { state: 'OPEN' })] })
    await gatherStepInputs(ROOT, record([12]), open)
    expect(open.tipAsks).toEqual([])
  })
})

describe('the input names the base branch and the merge time', () => {
  it('carries base and mergedAt for a merged pull request only', async () => {
    const d = deps({
      rows: [
        merged(12, { base: 'release', mergedAt: '2026-11-14T09:00:00Z' }),
        merged(13, { state: 'OPEN' })
      ],
      merge: { 12: 'passing' }
    })
    const inputs = await gatherStepInputs(ROOT, record([12, 13]), d)
    expect(inputs['stp-1']).toMatchObject({ base: 'release', mergedAt: '2026-11-14T09:00:00Z' })
    expect(inputs['stp-2'].base).toBeUndefined()
  })
})

describe('AC-1 / AC-5 · a red merge under a green tip is not on the waiting list', () => {
  it('a mission_get of the reported shape shows the next real item, not "Fix the main branch"', async () => {
    // One step merged four days ago with a red merge commit; a later fix made the tip green.
    const rec = record([12])
    const d = deps({
      rows: [merged(12, { mergedAt: '2026-11-14T09:00:00Z' })],
      merge: { 12: 'failing' },
      tip: { main: 'passing' }
    })
    const inputs = await gatherStepInputs(ROOT, rec, d)
    const list = waitingListV4(
      {
        ...rec,
        attachRequests: [{ id: 'atr-1', sessionId: 'sess-2', decision: null, at: AT }]
      } as MissionV4,
      { inputs }
    )
    expect(list.items.map((i) => i.kind)).not.toContain('main-failing')
    expect(list.next?.kind).toBe('close')
  })

  it('the same mission with a red tip does raise it', async () => {
    const rec = record([12])
    const d = deps({ rows: [merged(12)], merge: { 12: 'failing' }, tip: { main: 'failing' } })
    const inputs = await gatherStepInputs(ROOT, rec, d)
    const list = waitingListV4(rec, { inputs })
    expect(list.next).toMatchObject({ kind: 'main-failing', stepId: 'stp-1', pr: '12' })
  })
})

describe('AC-2 · at most one main-failing item per base branch, naming the first step since the last green', () => {
  const red = (base: string, mergedAt: string, extra = {}): StepInput => ({
    pr: 'merged',
    base,
    mergedAt,
    facts: { 'main-green': false },
    ...extra
  })
  const green = (base: string, mergedAt: string): StepInput => ({
    pr: 'merged',
    base,
    mergedAt,
    facts: { 'main-green': true }
  })

  it('three red merges raise ONE item, naming the first merged', () => {
    const rec = record([12, 13, 14])
    const list = waitingListV4(rec, {
      inputs: {
        // Plan order is not merge order: stp-2 merged first.
        'stp-1': red('main', '2026-11-15T10:00:00Z'),
        'stp-2': red('main', '2026-11-14T10:00:00Z'),
        'stp-3': red('main', '2026-11-16T10:00:00Z')
      }
    })
    const items = list.items.filter((i) => i.kind === 'main-failing')
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'main-failing', stepId: 'stp-2', pr: '13' })
    expect(items[0].ask).toContain('Step 2')
  })

  it('a green merge in between resets the cause to the first red after it', () => {
    const rec = record([12, 13, 14])
    const list = waitingListV4(rec, {
      inputs: {
        'stp-1': red('main', '2026-11-14T10:00:00Z'),
        'stp-2': green('main', '2026-11-15T10:00:00Z'),
        'stp-3': red('main', '2026-11-16T10:00:00Z')
      }
    })
    const items = list.items.filter((i) => i.kind === 'main-failing')
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ stepId: 'stp-3' })
  })

  it('two base branches raise one item each', () => {
    const rec = record([12, 13])
    const list = waitingListV4(rec, {
      inputs: {
        'stp-1': red('main', '2026-11-14T10:00:00Z'),
        'stp-2': red('release', '2026-11-14T11:00:00Z')
      }
    })
    const items = list.items.filter((i) => i.kind === 'main-failing')
    expect(items.map((i) => (i as { stepId: string }).stepId)).toEqual(['stp-1', 'stp-2'])
    expect(new Set(items.map((i) => i.id)).size).toBe(2)
  })

  it('an item stays keyed by the step it names, so its Your move card does not re-file', () => {
    const rec = record([12])
    const list = waitingListV4(rec, { inputs: { 'stp-1': red('main', '2026-11-14T10:00:00Z') } })
    expect(list.items[0].id).toBe('main-failing:stp-1')
  })

  it('steps that carry no base or time still group together (one default base)', () => {
    const rec = record([12, 13])
    const list = waitingListV4(rec, {
      inputs: {
        'stp-1': { pr: 'merged', facts: { 'main-green': false } },
        'stp-2': { pr: 'merged', facts: { 'main-green': false } }
      }
    })
    const items = list.items.filter((i) => i.kind === 'main-failing')
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ stepId: 'stp-1' })
  })
})
