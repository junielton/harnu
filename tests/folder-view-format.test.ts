import { describe, it, expect } from 'vitest'
import {
  ACTIVITY_DAYS,
  ACTIVITY_VIEWBOX,
  activityBars,
  activityBucket,
  BLOCK_SCOPE,
  bucketSessions,
  countActivity,
  fanoutRows,
  fanoutTally,
  featureRail,
  isGitFolder,
  RAIL_STEPS,
  prPill,
  resolveProfile,
  scopeOf,
  sessionsPerDay,
  VISIBLE_LIMIT,
  type FanoutFolder,
  type FolderViewBlock,
  type RailStepKey,
  type RailStepState
} from '../src/renderer/src/components/folder-view-format'
import type { Dot } from '../src/renderer/src/components/session-dot'

/**
 * T212 — the Folder View's session buckets. Pure, so the three sections
 * (current / older / archived) are proved without mounting anything.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function s(id: string, minutesAgo: number): any {
  return {
    sessionId: id,
    modified: new Date(Date.now() - minutesAgo * 60_000).toISOString()
  }
}

const noneArchived = (): boolean => false

describe('bucketSessions', () => {
  it('is all-empty for a folder with no sessions', () => {
    const out = bucketSessions([], noneArchived)
    expect(out).toEqual({ current: [], older: [], archived: [] })
  })

  it('sorts current newest first', () => {
    const out = bucketSessions([s('old', 50), s('new', 1)], noneArchived)
    expect(out.current.map((x) => x.sessionId)).toEqual(['new', 'old'])
  })

  it('spills past the visible limit into older', () => {
    const many = Array.from({ length: VISIBLE_LIMIT + 3 }, (_, i) => s(`s${i}`, i))
    const out = bucketSessions(many, noneArchived)
    expect(out.current).toHaveLength(VISIBLE_LIMIT)
    expect(out.older).toHaveLength(3)
  })

  it('routes archived sessions out of current and older', () => {
    const out = bucketSessions([s('a', 1), s('b', 2)], (id) => id === 'a')
    expect(out.current.map((x) => x.sessionId)).toEqual(['b'])
    expect(out.archived.map((x) => x.sessionId)).toEqual(['a'])
    expect(out.older).toEqual([])
  })
})

/**
 * T285 — the profile rule. A worktree cockpit is only offered to a folder git
 * itself calls a linked worktree; everything else (main checkout, plain pinned
 * folder, unprobed folder) gets the orchestration home.
 */
describe('resolveProfile', () => {
  it('gives a main checkout the main profile', () => {
    expect(resolveProfile({ repoId: 'r1', gitBranch: 'main', isMainWorktree: true })).toBe('main')
  })

  it('gives a linked worktree the worktree profile', () => {
    expect(resolveProfile({ repoId: 'r1', gitBranch: 'card/x', isMainWorktree: false })).toBe(
      'worktree'
    )
  })

  it('gives a plain non-git folder the main profile', () => {
    expect(resolveProfile({})).toBe('main')
    expect(resolveProfile(null)).toBe('main')
    expect(resolveProfile(undefined)).toBe('main')
  })

  /**
   * The distinction the rule turns on: a missing `isMainWorktree` means "not
   * probed", never "linked". Treating it as linked would hand the cockpit to
   * every folder whose git probe had not landed yet.
   */
  it('does not read an unprobed isMainWorktree as a worktree', () => {
    expect(resolveProfile({ repoId: 'r1', gitBranch: 'main' })).toBe('main')
  })

  it('never gives the cockpit to a folder with no repo, whatever the flag says', () => {
    expect(resolveProfile({ isMainWorktree: false })).toBe('main')
  })
})

describe('isGitFolder', () => {
  it('accepts a folder with a repoId or a branch', () => {
    expect(isGitFolder({ repoId: 'r1' })).toBe(true)
    expect(isGitFolder({ gitBranch: 'main' })).toBe(true)
  })

  it('rejects a folder with neither, and an empty repoId', () => {
    expect(isGitFolder({})).toBe(false)
    expect(isGitFolder({ repoId: '' })).toBe(false)
    expect(isGitFolder(null)).toBe(false)
  })
})

/**
 * T285 — the scope table is the contract. These assertions exist so a later
 * block cannot quietly re-scope itself: `memory`, `roadmap` and `worktrees` are
 * repo-wide because `resolveMemoryCheckout` / `resolveMemoryLocation` collapse
 * every worktree onto the repo's main checkout, and a tag that drifts from that
 * read is the exact lie the tags were added to stop.
 */
describe('BLOCK_SCOPE', () => {
  it('tags the folder-local blocks as folder', () => {
    expect(scopeOf('sessions')).toBe('folder')
    expect(scopeOf('git')).toBe('folder')
    expect(scopeOf('ownedCard')).toBe('folder')
  })

  it('tags every repo-wide block as repo', () => {
    expect(scopeOf('memory')).toBe('repo')
    expect(scopeOf('roadmap')).toBe('repo')
    expect(scopeOf('worktrees')).toBe('repo')
    expect(scopeOf('fanout')).toBe('repo')
    expect(scopeOf('activity')).toBe('repo')
  })

  it('declares a scope for every block, including the ones not built yet', () => {
    const blocks: FolderViewBlock[] = [
      'sessions',
      'git',
      'memory',
      'roadmap',
      'worktrees',
      'fanout',
      'ownedCard',
      'activity'
    ]
    for (const b of blocks) expect(BLOCK_SCOPE[b]).toBeDefined()
    expect(Object.keys(BLOCK_SCOPE).sort()).toEqual([...blocks].sort())
  })
})

/**
 * T285 AC-4 — the activity shaping the follow-up units consume. Pure by
 * construction: no jsdom, no store, no clock beyond the `now` that is passed in.
 */

/** A session created `daysAgo` days ago at local noon (DST-safe midpoint). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function born(id: string, daysAgo: number, now = Date.now()): any {
  const d = new Date(now)
  d.setHours(12, 0, 0, 0)
  d.setDate(d.getDate() - daysAgo)
  return { sessionId: id, created: d.toISOString(), modified: d.toISOString() }
}

describe('sessionsPerDay', () => {
  const NOW = new Date(2026, 8, 7, 15, 30).getTime() // 2026-09-07, local

  it('returns one bucket per day, oldest first, ending today', () => {
    const out = sessionsPerDay([], NOW)
    expect(out).toHaveLength(ACTIVITY_DAYS)
    expect(out[0].day).toBe('2026-08-25')
    expect(out[ACTIVITY_DAYS - 1].day).toBe('2026-09-07')
    expect(out[ACTIVITY_DAYS - 1].isToday).toBe(true)
    expect(out.filter((d) => d.isToday)).toHaveLength(1)
  })

  it('keeps empty days rather than collapsing them', () => {
    const out = sessionsPerDay([born('a', 0, NOW)], NOW)
    expect(out).toHaveLength(ACTIVITY_DAYS)
    expect(out.every((d) => d.count === 0 || d.count === 1)).toBe(true)
    expect(out.reduce((n, d) => n + d.count, 0)).toBe(1)
  })

  it('counts sessions into the local day they were created on', () => {
    const out = sessionsPerDay([born('a', 0, NOW), born('b', 0, NOW), born('c', 3, NOW)], NOW)
    const byDay = new Map(out.map((d) => [d.day, d.count]))
    expect(byDay.get('2026-09-07')).toBe(2)
    expect(byDay.get('2026-09-04')).toBe(1)
    expect(byDay.get('2026-09-05')).toBe(0)
  })

  it('buckets on created, never modified', () => {
    const stale = {
      sessionId: 'x',
      created: born('x', 5, NOW).created,
      modified: new Date(NOW).toISOString()
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = sessionsPerDay([stale as any], NOW)
    const byDay = new Map(out.map((d) => [d.day, d.count]))
    expect(byDay.get('2026-09-02')).toBe(1)
    expect(byDay.get('2026-09-07')).toBe(0)
  })

  it('drops sessions outside the window instead of piling them on an edge day', () => {
    const out = sessionsPerDay([born('old', 40, NOW), born('now', 0, NOW)], NOW)
    expect(out.reduce((n, d) => n + d.count, 0)).toBe(1)
    expect(out[0].count).toBe(0)
  })

  it('drops an unparseable created rather than throwing', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = sessionsPerDay([{ sessionId: 'bad', created: 'not a date' } as any], NOW)
    expect(out.reduce((n, d) => n + d.count, 0)).toBe(0)
  })

  it('honours a custom span', () => {
    expect(sessionsPerDay([], NOW, 7)).toHaveLength(7)
    expect(sessionsPerDay([], NOW, 0)).toHaveLength(1)
  })
})

describe('activityBucket', () => {
  it('folds stuck into working — a stalled session is not idle', () => {
    expect(activityBucket('working')).toBe('working')
    expect(activityBucket('stuck')).toBe('working')
  })

  it('keeps needs-input its own bucket', () => {
    expect(activityBucket('needs-input')).toBe('needs-input')
  })

  it('folds every terminal and lifecycle state into idle', () => {
    for (const dot of ['idle', 'completed', 'failed', 'archived'] as Dot[]) {
      expect(activityBucket(dot)).toBe('idle')
    }
  })
})

describe('countActivity', () => {
  it('is all-zero for an empty working set', () => {
    expect(countActivity([], () => 'idle')).toEqual({ working: 0, needsInput: 0, idle: 0 })
  })

  it('counts each bucket, folding stuck into working', () => {
    const dots: Dot[] = ['working', 'stuck', 'needs-input', 'idle', 'completed', 'archived']
    expect(countActivity(dots, (d) => d)).toEqual({ working: 2, needsInput: 1, idle: 3 })
  })

  it('agrees with activityBucket for every dot it can be given', () => {
    const dots: Dot[] = [
      'working',
      'stuck',
      'needs-input',
      'idle',
      'completed',
      'failed',
      'archived'
    ]
    for (const dot of dots) {
      const counts = countActivity([dot], (d) => d)
      const bucket = activityBucket(dot)
      expect(counts[bucket === 'needs-input' ? 'needsInput' : bucket]).toBe(1)
    }
  })
})

/**
 * T287 — the worktree hero's four-step rail. The interesting half is AC-5: a
 * step whose evidence could not be read must render as "not yet", never as
 * done. `null` (read it, there is none) and `undefined` (could not read it) are
 * therefore different inputs with different answers, and these tests are what
 * hold them apart.
 */
describe('featureRail (T287)', () => {
  /** The rail as `{ step: state }`, which is what every assertion below reads. */
  function states(steps: ReturnType<typeof featureRail>): Record<RailStepKey, RailStepState> {
    return Object.fromEntries(steps.map((s) => [s.key, s.state])) as Record<
      RailStepKey,
      RailStepState
    >
  }

  it('prints the four steps in order, always', () => {
    const steps = featureRail({ dispatched: true, commits: null, pr: null })
    expect(steps.map((s) => s.key)).toEqual([...RAIL_STEPS])
    expect(RAIL_STEPS).toEqual(['dispatched', 'commits', 'pr', 'merge'])
  })

  it('marks everything before the frontier done and everything after pending', () => {
    // The approved spec's own state: 11 commits, PR open, not merged.
    const steps = featureRail({
      dispatched: true,
      commits: 11,
      pr: { number: 195, merged: false }
    })
    expect(states(steps)).toEqual({
      dispatched: 'done',
      commits: 'done',
      pr: 'current',
      merge: 'pending'
    })
  })

  it('has exactly one current step, ever', () => {
    const cases = [
      { dispatched: true, commits: null, pr: undefined },
      { dispatched: true, commits: 0, pr: null },
      { dispatched: true, commits: 4, pr: null },
      { dispatched: true, commits: 4, pr: { number: 1, merged: false } },
      { dispatched: true, commits: 4, pr: { number: 1, merged: true } }
    ]
    for (const input of cases) {
      const currents = featureRail(input).filter((s) => s.state === 'current')
      expect(currents.length).toBeLessThanOrEqual(1)
    }
  })

  it('reads a merged PR as the terminal state — all four done, none current', () => {
    const steps = featureRail({
      dispatched: true,
      commits: 11,
      pr: { number: 195, merged: true }
    })
    expect(states(steps)).toEqual({
      dispatched: 'done',
      commits: 'done',
      pr: 'done',
      merge: 'done'
    })
    expect(steps.every((s) => s.state === 'done')).toBe(true)
  })

  /** AC-5 — the rule this component exists to not break. */
  it('AC-5: an unreadable commit count never reads as done', () => {
    const steps = featureRail({ dispatched: true, commits: null, pr: undefined })
    expect(states(steps)).toEqual({
      dispatched: 'current',
      commits: 'pending',
      pr: 'pending',
      merge: 'pending'
    })
    expect(steps.find((s) => s.key === 'commits')?.known).toBe(false)
  })

  /** AC-5 — no `gh` is "we did not look", not "there is no PR". */
  it('AC-5: an unreadable PR never reads as done, even with commits landed', () => {
    const steps = featureRail({ dispatched: true, commits: 11, pr: undefined })
    expect(states(steps)).toEqual({
      dispatched: 'done',
      commits: 'current',
      pr: 'pending',
      merge: 'pending'
    })
    for (const key of ['pr', 'merge'] as const) {
      expect(steps.find((s) => s.key === key)?.known).toBe(false)
    }
  })

  it('AC-5: no step is ever done when nothing at all could be read', () => {
    const steps = featureRail({ dispatched: false, commits: null, pr: undefined })
    expect(steps.every((s) => s.state === 'pending')).toBe(true)
  })

  it('distinguishes "no PR" from "could not read the PR"', () => {
    const none = featureRail({ dispatched: true, commits: 4, pr: null })
    const unread = featureRail({ dispatched: true, commits: 4, pr: undefined })
    // Both stop at the same place — but only the read one KNOWS it is empty.
    expect(states(none).pr).toBe('pending')
    expect(states(unread).pr).toBe('pending')
    expect(none.find((s) => s.key === 'pr')?.known).toBe(true)
    expect(unread.find((s) => s.key === 'pr')?.known).toBe(false)
  })

  it('treats zero commits as read-and-empty, holding the frontier at dispatch', () => {
    const steps = featureRail({ dispatched: true, commits: 0, pr: null })
    expect(states(steps)).toEqual({
      dispatched: 'current',
      commits: 'pending',
      pr: 'pending',
      merge: 'pending'
    })
    expect(steps.find((s) => s.key === 'commits')?.known).toBe(true)
  })

  it('never lets a later step outrun an earlier unreadable one', () => {
    // A merged PR with an unreadable commit count must NOT paint merge done.
    const steps = featureRail({
      dispatched: true,
      commits: null,
      pr: { number: 9, merged: true }
    })
    expect(states(steps).merge).toBe('pending')
    expect(states(steps).pr).toBe('pending')
  })
})

// --- T286: fan-out shaping ---------------------------------------------------

/** A PR entry, in the shape `pr-stack-core` hands one over. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pr(over: Record<string, unknown> = {}): any {
  return {
    number: 12,
    branch: 'card/x',
    state: 'OPEN',
    isDraft: false,
    reviewDecision: null,
    ci: 'unknown',
    url: 'https://example.test/pr/12',
    ...over
  }
}

function sibling(over: Partial<FanoutFolder> = {}): FanoutFolder {
  return {
    path: '/repo/wt',
    branch: 'card/x',
    label: 'wt',
    isSelf: false,
    sessionCount: 0,
    liveCount: 0,
    needsInputCount: 0,
    ...over
  }
}

describe('prPill', () => {
  it('reports the worst news first', () => {
    // A draft carrying changes requested still needs you — the review decision
    // must not be hidden behind the draft flag.
    expect(
      prPill(pr({ isDraft: true, reviewDecision: 'CHANGES_REQUESTED', ci: 'passing' }))
    ).toMatchObject({
      key: 'changesRequested',
      tone: 'warn',
      needsYou: true
    })
    expect(prPill(pr({ isDraft: true, ci: 'passing' }))).toMatchObject({
      key: 'draft',
      tone: 'mute'
    })
    expect(prPill(pr({ ci: 'failing' }))).toMatchObject({ key: 'checksFailing', tone: 'bad' })
    expect(prPill(pr({ ci: 'pending' }))).toMatchObject({ key: 'checksRunning', tone: 'mute' })
    expect(prPill(pr({ ci: 'passing' }))).toMatchObject({ key: 'checksPassing', tone: 'ok' })
    expect(prPill(pr())).toMatchObject({ key: 'open', tone: 'mute' })
  })

  it('marks only changes-requested as needing you', () => {
    expect(prPill(pr({ ci: 'failing' })).needsYou).toBe(false)
    expect(prPill(pr({ isDraft: true })).needsYou).toBe(false)
    expect(prPill(pr({ reviewDecision: 'CHANGES_REQUESTED' })).needsYou).toBe(true)
  })

  it('carries the lifecycle states even though the snapshot filters them out', () => {
    expect(prPill(pr({ state: 'MERGED' }))).toMatchObject({ key: 'merged', tone: 'mute' })
    expect(prPill(pr({ state: 'CLOSED' }))).toMatchObject({ key: 'closed', tone: 'mute' })
  })
})

describe('fanoutRows', () => {
  it('keeps a row whose async reads all failed, with empty cells', () => {
    const rows = fanoutRows([sibling()], new Map(), new Map(), null)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ ahead: null, behind: null, card: null, pr: null })
  })

  it('puts the folder you are standing in last, others alphabetically', () => {
    const rows = fanoutRows(
      [
        sibling({ path: '/a', branch: 'main', isSelf: true }),
        sibling({ path: '/c', branch: 'card/z' }),
        sibling({ path: '/b', branch: 'card/a' })
      ],
      new Map(),
      new Map(),
      null
    )
    expect(rows.map((r) => r.branch)).toEqual(['card/a', 'card/z', 'main'])
  })

  it('joins git, card ownership and PR state by their own keys', () => {
    const rows = fanoutRows(
      [sibling({ path: '/wt', branch: 'card/x' })],
      new Map([['/wt', { ahead: 4, behind: 0 }]]),
      new Map([['/wt', { slug: 's', id: 'T9', title: 'Nine', status: 'review', blocked: false }]]),
      new Map([['card/x', pr({ ci: 'passing' })]])
    )
    expect(rows[0].ahead).toBe(4)
    expect(rows[0].card?.id).toBe('T9')
    expect(rows[0].pr?.key).toBe('checksPassing')
  })

  it('never matches a PR to a detached worktree', () => {
    const rows = fanoutRows([sibling({ branch: '' })], new Map(), new Map(), new Map([['', pr()]]))
    expect(rows[0].pr).toBeNull()
  })
})

describe('fanoutTally', () => {
  const rows = (): ReturnType<typeof fanoutRows> =>
    fanoutRows(
      [
        sibling({ path: '/a', branch: 'card/a', liveCount: 1, needsInputCount: 1 }),
        sibling({ path: '/b', branch: 'card/b', liveCount: 1 }),
        sibling({ path: '/c', branch: 'card/c' })
      ],
      new Map(),
      new Map(),
      new Map([['card/b', pr({ reviewDecision: 'CHANGES_REQUESTED' })]])
    )

  it('counts worktrees in flight and both needs-you signals', () => {
    expect(fanoutTally(rows(), true)).toMatchObject({
      worktrees: 3,
      inFlight: 2,
      idle: 1,
      needsYou: 2,
      needsYouSessions: 1,
      needsYouPrs: 1
    })
  })

  it('excludes the PR signal rather than counting it as zero when unreadable', () => {
    const tally = fanoutTally(rows(), false)
    expect(tally.needsYouPrs).toBeNull()
    // The session signal still counts, and the total never silently absorbs the gap.
    expect(tally.needsYou).toBe(1)
    expect(tally.needsYouSessions).toBe(1)
  })
})

describe('activityBars', () => {
  it('gives a zero day a visible tick rather than a gap', () => {
    const bars = activityBars([
      { day: '2026-09-01', count: 0, isToday: false },
      { day: '2026-09-02', count: 4, isToday: true }
    ])
    expect(bars[0]).toMatchObject({ isZero: true, height: 2 })
    expect(bars[1].height).toBeGreaterThan(bars[0].height)
    expect(bars[1].isToday).toBe(true)
  })

  it('lays every bar inside the viewbox, tallest at the peak', () => {
    const days = Array.from({ length: ACTIVITY_DAYS }, (_, i) => ({
      day: `d${i}`,
      count: i,
      isToday: i === ACTIVITY_DAYS - 1
    }))
    const bars = activityBars(days)
    expect(bars).toHaveLength(ACTIVITY_DAYS)
    for (const bar of bars) {
      expect(bar.x).toBeGreaterThanOrEqual(0)
      expect(bar.x + bar.width).toBeLessThanOrEqual(ACTIVITY_VIEWBOX.width)
      expect(bar.y).toBeGreaterThanOrEqual(0)
      expect(bar.y + bar.height).toBeLessThanOrEqual(ACTIVITY_VIEWBOX.height)
    }
    // A single session must not round down to invisible.
    expect(bars[1].height).toBeGreaterThanOrEqual(4)
  })

  it('returns nothing for an empty window', () => {
    expect(activityBars([])).toEqual([])
  })
})
