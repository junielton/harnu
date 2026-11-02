/**
 * T611 U1 AC-5 / AC-6 — what the throttle does to the consumers.
 *
 *  - `low`: the mission gate caches (the PR list and a pending main-CI verdict) stretch from 60 s to
 *    5 min;
 *    PR Stack's background refresh is skipped (a load on open still runs).
 *  - `exhausted`: throttled reads skip `gh` and serve the last known value; normal polling resumes
 *    after the reset.
 *
 * `gh` is faked at the `execFile` seam and counted; git never runs (no worktree refs, an empty repo).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const gh = vi.hoisted(() => ({
  calls: [] as string[][],
  /** The workflow-run list `gh run list` answers with (a pending run by default). */
  runs: [{ status: 'in_progress', conclusion: '' }] as { status: string; conclusion: string }[]
}))

vi.mock('electron', () => ({ ipcMain: { handle: (): void => {} } }))
vi.mock('../src/main/appimage-env', () => ({
  spawnEnvOnce: async (): Promise<Record<string, string>> => ({ ...process.env }) as never
}))
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  type Cb = (err: Error | null, out?: { stdout: string; stderr: string }) => void
  const execFile = (file: string, args: string[], opts: object, cb: Cb): void => {
    if (file !== 'gh') {
      real.execFile(file, args, opts, (err, stdout, stderr) =>
        err ? cb(err) : cb(null, { stdout: String(stdout), stderr: String(stderr) })
      )
      return
    }
    gh.calls.push(args)
    const stdout =
      args[0] === 'pr' && args[1] === 'view'
        ? JSON.stringify({ mergeCommit: { oid: 'abc123' } })
        : args[0] === 'run'
          ? JSON.stringify(gh.runs)
          : args[0] === 'api'
            ? '{}'
            : '[]'
    setTimeout(() => cb(null, { stdout, stderr: '' }), 0)
  }
  return { ...real, execFile }
})

type PrStack = typeof import('../src/main/pr-stack')
type Tracker = typeof import('../src/main/github-budget-tracker')
let ps: PrStack
let t: Tracker
let seq = 0
const T0 = new Date('2026-11-02T12:00:00Z')

/** A repo path nobody has cached yet (the caches are keyed by path). */
const freshRepo = (): string => `/tmp/harnu-budget-repo-${++seq}`

const bucket = (remaining: number, resetInSec: number) => ({
  limit: 5000,
  remaining,
  used: 5000 - remaining,
  reset: Math.floor(Date.now() / 1000) + resetInSec
})
const poll = (graphqlRemaining: number, resetInSec = 3600): void =>
  t.githubBudget.applyPoll({
    ok: true,
    buckets: { rest: bucket(4900, resetInSec), graphql: bucket(graphqlRemaining, resetInSec) }
  })
const goLow = (): void => poll(500) // 10 % of 5000 — under the 15 % default
const goExhausted = (resetInSec = 600): void => poll(0, resetInSec)
const ghCount = (verb: string): number => gh.calls.filter((a) => a[0] === verb).length
const advance = (ms: number): void => {
  vi.setSystemTime(new Date(Date.now() + ms))
}

beforeEach(async () => {
  gh.calls.length = 0
  gh.runs = [{ status: 'in_progress', conclusion: '' }]
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  vi.resetModules()
  ps = await import('../src/main/pr-stack')
  t = await import('../src/main/github-budget-tracker')
})
afterEach(() => vi.useRealTimers())

const join = (repo: string): ReturnType<PrStack['findPrsForWorktrees']> =>
  ps.findPrsForWorktrees(repo, { worktrees: [], branches: [], numbers: [7] })

describe('mission PR cache TTL (AC-5)', () => {
  it('normal: one `gh pr list` serves a repo for 60 s', async () => {
    const repo = freshRepo()
    await join(repo)
    advance(59_000)
    await join(repo)
    expect(ghCount('pr')).toBe(1)
    advance(2_000)
    await join(repo)
    expect(ghCount('pr')).toBe(2)
  })

  it('low: the same cache stretches to 5 minutes', async () => {
    const repo = freshRepo()
    goLow()
    expect(t.githubBudget.state()).toBe('low')
    await join(repo)
    advance(4 * 60_000)
    await join(repo)
    expect(ghCount('pr')).toBe(1)
    advance(61_000)
    await join(repo)
    expect(ghCount('pr')).toBe(2)
  })

  it('low: a pending main-CI verdict stretches from 60 s to 5 minutes too', async () => {
    const repo = freshRepo()
    goLow()
    await ps.findMainCi(repo, [5])
    const first = gh.calls.length // pr view + run list
    expect(first).toBe(2)
    advance(4 * 60_000)
    await ps.findMainCi(repo, [5])
    expect(gh.calls.length).toBe(first)
    advance(61_000)
    await ps.findMainCi(repo, [5])
    // BUG-240: the merge commit is remembered, so only the run list is asked again.
    expect(gh.calls.length).toBe(first + 1)
    expect(gh.calls.at(-1)?.[0]).toBe('run')
  })

  it('normal: a pending main-CI verdict still refreshes after 60 s', async () => {
    const repo = freshRepo()
    await ps.findMainCi(repo, [5])
    advance(61_000)
    await ps.findMainCi(repo, [5])
    expect(gh.calls.length).toBe(3)
    expect(gh.calls.at(-1)?.[0]).toBe('run')
  })

  it('normal: a finished main-CI verdict is held for 10 minutes (BUG-240)', async () => {
    const repo = freshRepo()
    gh.runs = [{ status: 'completed', conclusion: 'success' }]
    await ps.findMainCi(repo, [5])
    advance(9 * 60_000)
    await ps.findMainCi(repo, [5])
    expect(gh.calls.length).toBe(2)
    advance(61_000)
    await ps.findMainCi(repo, [5])
    expect(gh.calls.length).toBe(3)
  })
})

describe('exhausted: last known value, then resume (AC-6)', () => {
  it('serves the cached PR list however old it is, with no gh call', async () => {
    const repo = freshRepo()
    await join(repo)
    expect(ghCount('pr')).toBe(1)
    goExhausted()
    advance(30 * 60_000 - 1) // far past any TTL, still before nothing resets it
    // keep the budget exhausted for the window we are testing
    goExhausted(3600)
    const again = await join(repo)
    expect(ghCount('pr')).toBe(1)
    expect(again.ghAvailable).toBe(true) // the cached answer, not a failure
  })

  it('a repo never read before degrades to "unknown" without spawning gh', async () => {
    goExhausted()
    const out = await join(freshRepo())
    expect(gh.calls).toHaveLength(0)
    expect(out.ghAvailable).toBe(false) // missions then read their sticky last-known states
  })

  it('serves the last known main-CI too, and the throttled lookup spawns nothing', async () => {
    const repo = freshRepo()
    gh.runs = [{ status: 'completed', conclusion: 'success' }]
    const first = await ps.findMainCi(repo, [5])
    expect(first.byNumber[5]).toBe('passing')
    const spawned = gh.calls.length
    goExhausted(3600)
    advance(20 * 60_000)
    goExhausted(3600)
    const again = await ps.findMainCi(repo, [5])
    expect(gh.calls.length).toBe(spawned)
    expect(again.byNumber[5]).toBe('passing')
    // A PR never looked up has no cached value: unknown, and still no spawn.
    const unseen = await ps.findMainCi(repo, [6])
    expect(gh.calls.length).toBe(spawned)
    expect(unseen.ghAvailable).toBe(false)
  })

  it('resumes by itself once the reset passes', async () => {
    const repo = freshRepo()
    goExhausted(600)
    await join(repo)
    expect(gh.calls).toHaveLength(0)
    advance(601_000) // no poll in between: the clock alone releases the throttle
    expect(t.githubBudget.state()).toBe('normal')
    await join(repo)
    expect(ghCount('pr')).toBe(1)
  })
})

describe('secondary-limit pause (AC-9 amended)', () => {
  it('serves the cached PR list while paused, with no gh call, then resumes', async () => {
    const repo = freshRepo()
    await join(repo)
    expect(ghCount('pr')).toBe(1)
    t.githubBudget.markRateLimited() // budget is fine; GitHub said slow down
    advance(5 * 60_000 - 1 - 60_000) // past the 60 s cache, still inside nothing else
    t.githubBudget.markRateLimited() // keep the pause alive for the read below
    await join(repo)
    expect(ghCount('pr')).toBe(1)
    advance(61_000)
    await join(repo)
    expect(ghCount('pr')).toBe(2)
  })

  it('pauses the PR Stack background refresh, but a load on open still reads', async () => {
    const repo = freshRepo()
    await ps.loadPrStackThrottled(repo, [])
    const before = gh.calls.length
    t.githubBudget.markRateLimited()
    await ps.loadPrStackThrottled(repo, [], { background: true })
    expect(gh.calls.length).toBe(before)
  })
})

describe('PR Stack background refresh (AC-5)', () => {
  const load = (repo: string, opts?: { background?: boolean }, wt: never[] = []) =>
    ps.loadPrStackThrottled(repo, wt, opts)
  /** `gh pr list` + the thread query = what one full load spends. */
  const SPEND = 2

  it('normal: background and open loads both run', async () => {
    const repo = freshRepo()
    await load(repo)
    await load(repo, { background: true })
    expect(gh.calls.length).toBe(SPEND * 2)
  })

  it('low: the background refresh is skipped, the last snapshot comes back, a load on open runs', async () => {
    const repo = freshRepo()
    const first = await load(repo)
    goLow()
    const before = gh.calls.length
    const bg = await load(repo, { background: true })
    expect(gh.calls.length).toBe(before)
    expect(bg.fetchedAt).toBe(first.fetchedAt)
    await load(repo) // open / manual refresh: never skipped
    expect(gh.calls.length).toBe(before + SPEND)
  })

  it('low with "pause PR Stack when low" off: the background refresh still runs', async () => {
    const repo = freshRepo()
    await load(repo)
    t.githubBudget.setPrefs({ ...t.githubBudget.getPrefs(), pausePrStackWhenLow: false })
    goLow()
    const before = gh.calls.length
    await load(repo, { background: true })
    expect(gh.calls.length).toBe(before + SPEND)
  })

  it('exhausted: the background refresh is skipped whatever the pref says', async () => {
    const repo = freshRepo()
    await load(repo)
    t.githubBudget.setPrefs({ ...t.githubBudget.getPrefs(), pausePrStackWhenLow: false })
    goExhausted()
    const before = gh.calls.length
    await load(repo, { background: true })
    expect(gh.calls.length).toBe(before)
  })

  it('with nothing to serve yet, a background load still runs', async () => {
    goLow()
    const repo = freshRepo()
    await load(repo, { background: true })
    expect(gh.calls.length).toBe(SPEND)
  })

  it('the skipped refresh hands back the worktrees the caller just sent', async () => {
    const repo = freshRepo()
    await load(repo)
    goLow()
    const wt = [{ path: '/w/a', branch: 'a', verdict: 'keep', isMain: false }] as never[]
    const bg = await load(repo, { background: true }, wt)
    expect(bg.worktrees).toBe(wt)
  })
})
