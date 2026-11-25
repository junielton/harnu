/**
 * The mission's `review` waiting item must not flap between polls.
 *
 * GitHub's pull request list is read through a 60 s cache with a short wait on a miss, so once a minute a
 * poll gets back "nothing in time" for a whole repo. That read says nothing about the pull request, and
 * the step must keep what the previous read showed ("unread is not a reason to drop"). The observer's
 * sticky cache is no help for a mission it never observed (the v4 observer skips v3 records), for a pull
 * request found only through a worktree or card branch, or when it holds an older CI verdict than the
 * last read. Each case below polls twice with GitHub unchanged and expects the same answer both times.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  gatherStepInputs,
  resetStepFactsMemory,
  type FactsDeps,
  type PrJoin
} from '../src/main/missions/facts'
import type { MissionV4 } from '../src/main/missions/model'
import { waitingListV4 } from '../src/main/missions/waiting'

const ROOT = '/repo'
const LEADER = '3f1c9a52-7d4e-4b8a-9c21-5e6a0b7d8f10'
const AT = '2026-11-18T10:00:00Z'

type PrRow = NonNullable<PrJoin['numbers'][number]>
const pr = (over: Partial<PrRow> = {}): PrRow =>
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
  }) as PrRow

function mission(links: Array<{ kind: string; ref: string }>, id = 'mnt-d0000001'): MissionV4 {
  return {
    schemaVersion: 4,
    id,
    title: 'Score report',
    doneWhen: 'Every candidate sees a score report',
    status: 'open',
    milestones: [],
    steps: [
      {
        id: 'stp-1',
        title: 'Build the report',
        acs: [{ id: 'ac-1', text: 'The pull request is merged', by: 'fact', fact: 'pr-merged' }],
        links,
        blockers: []
      }
    ],
    sessions: [{ id: LEADER, role: 'leads', from: AT, to: null }],
    links: [],
    blockers: []
  } as unknown as MissionV4
}

/** A join that answers: the pull request list arrived. */
const read = (rows: PrRow[], over: Partial<PrJoin> = {}): PrJoin => ({
  ghAvailable: true,
  worktrees: {},
  branches: {},
  numbers: Object.fromEntries(rows.map((p) => [p.number, p])),
  ...over
})

/** The join a read that did not arrive in time gives: no rows, and the numbers it was asked about unknown. */
const missed = (numbers: number[] = []): PrJoin => ({
  ghAvailable: false,
  worktrees: {},
  branches: {},
  numbers: Object.fromEntries(numbers.map((n) => [n, null]))
})

function deps(join: () => PrJoin, lastKnown: FactsDeps['lastKnown'] = () => null): FactsDeps {
  return {
    findPrs: async () => join(),
    findMainCi: async () => ({ ghAvailable: true, byNumber: {} }),
    lastKnown,
    pathExists: async () => true,
    taskState: () => undefined
  }
}

async function review(record: MissionV4, d: FactsDeps): Promise<string | null> {
  const inputs = await gatherStepInputs(ROOT, record, d)
  const item = waitingListV4(record, { inputs }).items.find((i) => i.kind === 'review')
  return item ? item.ask : null
}

const OWED = 'Look over the pull request for "Build the report"'

beforeEach(() => resetStepFactsMemory())

describe('the review item survives a read that did not arrive', () => {
  it('keeps an open pull request that the observer never sighted (a v3 mission)', async () => {
    const record = mission([{ kind: 'pr', ref: '12' }])
    expect(
      await review(
        record,
        deps(() => read([pr()]))
      )
    ).toBe(OWED)
    expect(
      await review(
        record,
        deps(() => missed([12]))
      )
    ).toBe(OWED)
  })

  it('keeps a pull request found only through its worktree, which no link names yet', async () => {
    const record = mission([{ kind: 'worktree', ref: '.claude/worktrees/a' }])
    const wt = '/repo/.claude/worktrees/a'
    const found = read([], {
      worktrees: { [wt]: { exists: true, branch: 'feat/x', head: null, prs: [pr()] } }
    })
    expect(
      await review(
        record,
        deps(() => found)
      )
    ).toBe(OWED)
    expect(
      await review(
        record,
        deps(() => missed())
      )
    ).toBe(OWED)
  })

  it('keeps it when the cache holds an older failing CI than the last read showed', async () => {
    const record = mission([{ kind: 'pr', ref: '12' }])
    const stale: FactsDeps['lastKnown'] = (kind) =>
      kind === 'pr'
        ? { state: 'OPEN', prNumber: 12, at: AT }
        : kind === 'pr-ci'
          ? { state: 'failing', prNumber: 12, at: AT }
          : null
    expect(
      await review(
        record,
        deps(() => read([pr({ ci: 'pending' })]), stale)
      )
    ).toBe(OWED)
    expect(
      await review(
        record,
        deps(() => missed([12]), stale)
      )
    ).toBe(OWED)
  })
})

describe('a read that did arrive still decides', () => {
  it('keeps a pull request with red checks out of the list on both polls', async () => {
    const record = mission([{ kind: 'pr', ref: '12' }])
    const sticky: FactsDeps['lastKnown'] = (kind) =>
      kind === 'pr'
        ? { state: 'OPEN', prNumber: 12, at: AT }
        : kind === 'pr-ci'
          ? { state: 'passing', prNumber: 12, at: AT }
          : null
    expect(
      await review(
        record,
        deps(() => read([pr({ ci: 'failing' })]), sticky)
      )
    ).toBeNull()
    expect(
      await review(
        record,
        deps(() => missed([12]), sticky)
      )
    ).toBeNull()
  })

  it('drops the item when a read that arrived finds the pull request gone', async () => {
    const record = mission([{ kind: 'worktree', ref: '.claude/worktrees/a' }])
    const wt = '/repo/.claude/worktrees/a'
    const found = read([], {
      worktrees: { [wt]: { exists: true, branch: 'feat/x', head: null, prs: [pr()] } }
    })
    const gone = read([], {
      worktrees: { [wt]: { exists: true, branch: 'feat/x', head: null, prs: [] } }
    })
    expect(
      await review(
        record,
        deps(() => found)
      )
    ).toBe(OWED)
    expect(
      await review(
        record,
        deps(() => gone)
      )
    ).toBeNull()
    expect(
      await review(
        record,
        deps(() => missed())
      )
    ).toBeNull()
  })

  it('does not carry a reading over to another mission, repository or step', async () => {
    const record = mission([{ kind: 'pr', ref: '12' }])
    expect(
      await review(
        record,
        deps(() => read([pr()]))
      )
    ).toBe(OWED)
    const other = mission([{ kind: 'pr', ref: '12' }], 'mnt-d0000002')
    expect(
      await review(
        other,
        deps(() => missed([12]))
      )
    ).toBeNull()
    const inputs = await gatherStepInputs(
      '/elsewhere',
      record,
      deps(() => missed([12]))
    )
    expect(inputs['stp-1']?.pr).toBeUndefined()
  })
})
