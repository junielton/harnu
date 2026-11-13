/**
 * T611 U1 — the shared `gh` runner: every call is counted per consumer and resource (AC-1, AC-3),
 * reads are refused while the budget is spent but writes never are (AC-6), and a rate-limit error in
 * gh's stderr pauses throttled reads and asks for a poll (AC-9, amended).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const sp = vi.hoisted(() => ({
  calls: [] as Array<{ file: string; args: string[]; stdin?: string }>,
  /** What the next spawn does. */
  next: { kind: 'ok', stdout: '[]' } as
    { kind: 'ok'; stdout: string } | { kind: 'fail'; stderr: string; code?: number | string }
}))

vi.mock('../src/main/appimage-env', () => ({
  spawnEnvOnce: async (): Promise<Record<string, string>> => ({ PATH: '/usr/bin' })
}))
vi.mock('../src/main/spawn-runner', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/main/spawn-runner')>()
  // BUG-266: every `gh` call goes through the spawn runner's `runFile`; this fake is the process boundary.
  const runFile = (file: string, args: readonly string[], opts: { stdin?: string }) => {
    sp.calls.push({ file, args: [...args], stdin: opts.stdin })
    const n = sp.next
    const promise =
      n.kind === 'ok'
        ? Promise.resolve({ stdout: n.stdout, stderr: '' })
        : Promise.reject(
            Object.assign(new Error('gh failed'), {
              code: n.code ?? 1,
              stdout: '',
              stderr: n.stderr
            })
          )
    return Object.assign(promise, { kill: (): boolean => true })
  }
  return { ...real, runFile }
})

type Runner = typeof import('../src/main/gh-runner')
type Tracker = typeof import('../src/main/github-budget-tracker')
let r: Runner
let t: Tracker

beforeEach(async () => {
  sp.calls.length = 0
  sp.next = { kind: 'ok', stdout: '[]' }
  vi.resetModules()
  r = await import('../src/main/gh-runner')
  t = await import('../src/main/github-budget-tracker')
})

const exhaust = (): void => {
  t.githubBudget.applyPoll({
    ok: true,
    buckets: {
      rest: { limit: 5000, remaining: 4000, used: 1000, reset: Date.now() / 1000 + 600 },
      graphql: { limit: 5000, remaining: 0, used: 5000, reset: Date.now() / 1000 + 600 }
    }
  })
}

describe('runGh — counting (AC-1, AC-3)', () => {
  it('runs gh with the login-shell env and counts the call under its consumer and resource', async () => {
    sp.next = { kind: 'ok', stdout: '[{"n":1}]' }
    const out = await r.runGh(['pr', 'list'], {
      consumer: 'pr-stack',
      resource: 'graphql',
      cwd: '/x'
    })
    expect(out.stdout).toBe('[{"n":1}]')
    expect(sp.calls).toEqual([{ file: 'gh', args: ['pr', 'list'] }])
    // The tracker has no poll yet; feed one so the snapshot shows counts.
    t.githubBudget.applyPoll({
      ok: true,
      buckets: {
        rest: { limit: 5000, remaining: 5000, used: 0, reset: Date.now() / 1000 + 600 },
        graphql: { limit: 5000, remaining: 5000, used: 0, reset: Date.now() / 1000 + 600 }
      }
    })
    const snap = t.githubBudget.snapshot()
    expect(snap.graphql?.byConsumer['pr-stack']).toBe(1)
    expect(snap.rest?.harnu).toBe(0)
  })

  it('counts REST and GraphQL separately, one point per call', async () => {
    await r.runGh(['run', 'list'], { consumer: 'missions', resource: 'rest' })
    await r.runGh(['pr', 'view', '1'], { consumer: 'missions', resource: 'graphql' })
    await r.runGh(['pr', 'view', '2'], { consumer: 'review', resource: 'graphql' })
    t.githubBudget.applyPoll({
      ok: true,
      buckets: {
        rest: { limit: 5000, remaining: 5000, used: 0, reset: Date.now() / 1000 + 600 },
        graphql: { limit: 5000, remaining: 5000, used: 0, reset: Date.now() / 1000 + 600 }
      }
    })
    const snap = t.githubBudget.snapshot()
    expect(snap.rest?.byConsumer.missions).toBe(1)
    expect(snap.graphql?.byConsumer).toMatchObject({ missions: 1, review: 1 })
  })

  it('counts the login lookup under its own `budget` consumer, REST (AC-8b)', async () => {
    await r.runGh(['api', 'user', '--jq', '.login'], { consumer: 'budget', resource: 'rest' })
    t.githubBudget.applyPoll({
      ok: true,
      buckets: {
        rest: { limit: 5000, remaining: 5000, used: 0, reset: Date.now() / 1000 + 600 },
        graphql: { limit: 5000, remaining: 5000, used: 0, reset: Date.now() / 1000 + 600 }
      }
    })
    expect(t.githubBudget.snapshot().rest?.byConsumer.budget).toBe(1)
    expect(sp.calls[0].args).toEqual(['api', 'user', '--jq', '.login'])
  })

  it('re-attributes a whole call tree with withGhConsumer', async () => {
    await r.withGhConsumer('steward', async () => {
      await r.runGh(['pr', 'view', '1'], { consumer: 'missions', resource: 'graphql' })
    })
    t.githubBudget.applyPoll({
      ok: true,
      buckets: {
        rest: { limit: 5000, remaining: 5000, used: 0, reset: Date.now() / 1000 + 600 },
        graphql: { limit: 5000, remaining: 5000, used: 0, reset: Date.now() / 1000 + 600 }
      }
    })
    expect(t.githubBudget.snapshot().graphql?.byConsumer).toMatchObject({ steward: 1, missions: 0 })
  })

  it('infers the resource and write-ness of a generic argv', () => {
    expect(r.inferGhResource(['api', 'graphql', '-f', 'query=x'])).toBe('graphql')
    expect(r.inferGhResource(['api', 'repos/{owner}/{repo}/pulls'])).toBe('rest')
    expect(r.inferGhResource(['run', 'list'])).toBe('rest')
    expect(r.inferGhResource(['pr', 'view', '3'])).toBe('graphql')
    expect(r.inferGhWrite(['pr', 'merge', '3', '--squash'])).toBe(true)
    expect(r.inferGhWrite(['pr', 'view', '3'])).toBe(false)
    expect(r.inferGhWrite(['api', 'graphql'])).toBe(false)
  })

  it('writes a stdin payload to the child and resolves with its output', async () => {
    const out = await r.runGh(['pr', 'review', '4', '--body-file', '-'], {
      consumer: 'review',
      resource: 'graphql',
      stdin: 'LGTM',
      write: true
    })
    expect(sp.calls[0]).toMatchObject({
      args: ['pr', 'review', '4', '--body-file', '-'],
      stdin: 'LGTM'
    })
    expect(out.stdout).toBe('[]')
  })
})

describe('runGh — exhausted budget (AC-6)', () => {
  it('refuses a read without spawning gh, and says so with a recognisable error', async () => {
    exhaust()
    expect(t.githubBudget.state()).toBe('exhausted')
    const err = await r
      .runGh(['pr', 'list'], { consumer: 'missions', resource: 'graphql' })
      .catch((e: unknown) => e)
    expect(r.isGhThrottled(err)).toBe(true)
    expect(sp.calls).toHaveLength(0)
  })

  it('never throttles a write: an operator gesture still reaches GitHub', async () => {
    exhaust()
    await r.runGh(['pr', 'merge', '9', '--squash'], {
      consumer: 'merge-batch',
      resource: 'graphql',
      write: true
    })
    expect(sp.calls).toHaveLength(1)
  })

  it('resumes by itself once the reset has passed', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-11-02T12:00:00Z'))
      vi.resetModules()
      r = await import('../src/main/gh-runner')
      t = await import('../src/main/github-budget-tracker')
      const reset = Date.now() / 1000 + 300
      t.githubBudget.applyPoll({
        ok: true,
        buckets: {
          rest: { limit: 5000, remaining: 4000, used: 1000, reset },
          graphql: { limit: 5000, remaining: 0, used: 5000, reset }
        }
      })
      await expect(
        r.runGh(['pr', 'list'], { consumer: 'missions', resource: 'graphql' })
      ).rejects.toMatchObject({ code: 'GH_THROTTLED' })
      vi.setSystemTime(new Date('2026-11-02T12:05:01Z'))
      await r.runGh(['pr', 'list'], { consumer: 'missions', resource: 'graphql' })
      expect(sp.calls).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('runGh — a rate-limit message (AC-9, amended)', () => {
  const full = (graphqlRemaining = 2700) => ({
    rest: { limit: 5000, remaining: 3100, used: 1900, reset: Date.now() / 1000 + 1800 },
    graphql: {
      limit: 5000,
      remaining: graphqlRemaining,
      used: 5000 - graphqlRemaining,
      reset: Date.now() / 1000 + 1800
    }
  })

  it('(a) asks for a poll at once and pauses throttled reads — without changing the state', async () => {
    t.githubBudget.applyPoll({ ok: true, buckets: full() })
    let polls = 0
    t.githubBudget.onRateLimit(() => polls++)
    sp.next = { kind: 'fail', stderr: 'GraphQL: API rate limit exceeded for user ID 1.' }
    const err = (await r
      .runGh(['pr', 'list'], { consumer: 'pr-stack', resource: 'graphql' })
      .catch((e: unknown) => e)) as { stderr: string }
    expect(err.stderr).toContain('rate limit')
    expect(polls).toBe(1)
    expect(t.githubBudget.state()).toBe('normal') // (c): budget left → not exhausted
    expect(t.githubBudget.snapshot().secondaryPauseUntil).not.toBeNull()
    // …and the next read is refused without a spawn.
    sp.calls.length = 0
    await expect(
      r.runGh(['pr', 'list'], { consumer: 'pr-stack', resource: 'graphql' })
    ).rejects.toMatchObject({ code: 'GH_THROTTLED' })
    expect(sp.calls).toHaveLength(0)
  })

  it('(b) when the poll then finds an empty bucket, the state becomes exhausted', async () => {
    t.githubBudget.applyPoll({ ok: true, buckets: full() })
    t.githubBudget.onRateLimit(() => t.githubBudget.applyPoll({ ok: true, buckets: full(0) }))
    sp.next = { kind: 'fail', stderr: 'API rate limit exceeded' }
    await r.runGh(['pr', 'list'], { consumer: 'review', resource: 'graphql' }).catch(() => {})
    expect(t.githubBudget.state()).toBe('exhausted')
  })

  it('(c) reads resume after the 60 s pause, or the Retry-After it names', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-11-02T12:00:00Z'))
      vi.resetModules()
      r = await import('../src/main/gh-runner')
      t = await import('../src/main/github-budget-tracker')
      t.githubBudget.applyPoll({ ok: true, buckets: full() })
      sp.next = { kind: 'fail', stderr: 'HTTP 403: secondary rate limit. Retry-After: 90' }
      await r.runGh(['pr', 'list'], { consumer: 'missions', resource: 'graphql' }).catch(() => {})
      sp.next = { kind: 'ok', stdout: '[]' }
      sp.calls.length = 0
      vi.setSystemTime(new Date('2026-11-02T12:01:00Z')) // 60 s: still inside the 90 s named
      await expect(
        r.runGh(['pr', 'list'], { consumer: 'missions', resource: 'graphql' })
      ).rejects.toMatchObject({ code: 'GH_THROTTLED' })
      vi.setSystemTime(new Date('2026-11-02T12:01:31Z'))
      await r.runGh(['pr', 'list'], { consumer: 'missions', resource: 'graphql' })
      expect(sp.calls).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('(d) writes are never throttled by a secondary pause', async () => {
    t.githubBudget.markRateLimited()
    await r.runGh(['pr', 'merge', '9'], {
      consumer: 'merge-batch',
      resource: 'graphql',
      write: true
    })
    expect(sp.calls).toHaveLength(1)
  })

  it('(d) a failing WRITE with a rate-limit message also starts the pause (information), not exhaustion', async () => {
    sp.next = { kind: 'fail', stderr: 'gh: You have exceeded a secondary rate limit' }
    await expect(
      r.runGh(['pr', 'merge', '1'], { consumer: 'merge-batch', resource: 'graphql', write: true })
    ).rejects.toBeDefined()
    expect(t.githubBudget.state()).toBe('normal')
    expect(t.githubBudget.readsPaused()).toBe(true)
  })

  it('leaves the budget alone for an ordinary failure', async () => {
    sp.next = { kind: 'fail', stderr: 'no pull requests found for branch', code: 1 }
    await expect(
      r.runGh(['pr', 'view'], { consumer: 'review', resource: 'graphql' })
    ).rejects.toBeDefined()
    expect(t.githubBudget.state()).toBe('normal')
    expect(t.githubBudget.readsPaused()).toBe(false)
  })

  it('the stdin path reports a rate-limit failure the same way', async () => {
    sp.next = { kind: 'fail', stderr: 'API rate limit exceeded' }
    const err = (await r
      .runGh(['pr', 'review', '4'], {
        consumer: 'review',
        resource: 'graphql',
        stdin: 'x',
        write: true
      })
      .catch((e: unknown) => e)) as { stderr: string }
    expect(err.stderr).toContain('rate limit')
    expect(t.githubBudget.readsPaused()).toBe(true)
  })
})
