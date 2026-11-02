/**
 * T611 U1 — the shared `gh` runner: every call is counted per consumer and resource (AC-1, AC-3),
 * reads are refused while the budget is spent but writes never are (AC-6), and a rate-limit error in
 * gh's stderr marks the budget exhausted immediately (AC-9).
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
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  // Two shapes, as in production: the promisified form (cb(err, {stdout, stderr})) and the plain
  // callback form the stdin path uses (cb(err, stdout, stderr)).
  const execFile = (file: string, args: string[], _opts: object, cb: (...a: unknown[]) => void) => {
    const call: { file: string; args: string[]; stdin?: string } = { file, args }
    sp.calls.push(call)
    const n = sp.next
    const done = (): void => {
      if (n.kind === 'ok') cb(null, { stdout: n.stdout, stderr: '' })
      else cb(Object.assign(new Error('gh failed'), { code: n.code ?? 1, stderr: n.stderr }))
    }
    const plain = (): void => {
      if (n.kind === 'ok') cb(null, n.stdout, '')
      else cb(Object.assign(new Error('gh failed'), { code: n.code ?? 1 }), '', n.stderr)
    }
    // `promisify(execFile)` calls with a 4-arg callback expecting one result object; the stdin path
    // marks itself by reading `child.stdin` right after the call.
    queueMicrotask(() => (call.stdin !== undefined ? plain() : done()))
    return {
      stdin: {
        on: (): void => {},
        end: (body: string): void => {
          call.stdin = body
        }
      }
    }
  }
  return { ...real, execFile }
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

describe('runGh — a rate-limit error marks the budget exhausted at once (AC-9)', () => {
  it('flips to exhausted on the failing call, with no poll', async () => {
    expect(t.githubBudget.state()).toBe('normal')
    sp.next = { kind: 'fail', stderr: 'GraphQL: API rate limit exceeded for user ID 1.' }
    const err = (await r
      .runGh(['pr', 'list'], { consumer: 'pr-stack', resource: 'graphql' })
      .catch((e: unknown) => e)) as { stderr: string }
    expect(err.stderr).toContain('rate limit')
    expect(t.githubBudget.state()).toBe('exhausted')
    // …and the very next read is refused without a spawn.
    sp.calls.length = 0
    await expect(
      r.runGh(['pr', 'list'], { consumer: 'pr-stack', resource: 'graphql' })
    ).rejects.toMatchObject({ code: 'GH_THROTTLED' })
    expect(sp.calls).toHaveLength(0)
  })

  it('also reacts to a failing WRITE (it is not throttled, but it is information)', async () => {
    sp.next = { kind: 'fail', stderr: 'gh: You have exceeded a secondary rate limit' }
    await expect(
      r.runGh(['pr', 'merge', '1'], { consumer: 'merge-batch', resource: 'graphql', write: true })
    ).rejects.toBeDefined()
    expect(t.githubBudget.state()).toBe('exhausted')
  })

  it('leaves the budget alone for an ordinary failure', async () => {
    sp.next = { kind: 'fail', stderr: 'no pull requests found for branch', code: 1 }
    await expect(
      r.runGh(['pr', 'view'], { consumer: 'review', resource: 'graphql' })
    ).rejects.toBeDefined()
    expect(t.githubBudget.state()).toBe('normal')
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
    expect(t.githubBudget.state()).toBe('exhausted')
  })
})
