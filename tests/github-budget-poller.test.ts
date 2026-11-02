/**
 * T611 U1 AC-2 — the `gh api rate_limit` poller: every 60 s, `unavailable` + 10 min backoff when gh is
 * missing or signed out, an exponential (never storming) retry on a transient error, and one extra
 * poll just after an exhausted reset so normal polling resumes on its own.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: (): string => '/nonexistent' },
  BrowserWindow: { getAllWindows: (): unknown[] => [] },
  ipcMain: { handle: (): void => {} }
}))

import {
  createBudgetPoller,
  nextPollDelayMs,
  probeRateLimit,
  POLL_INTERVAL_MS,
  RESET_SLACK_MS,
  UNAVAILABLE_BACKOFF_MS,
  type ProbeResult
} from '../src/main/github-budget'
import { createBudgetTracker, type RateLimitBuckets } from '../src/main/github-budget-core'

const T0 = Date.UTC(2026, 10, 2, 12, 0, 0)

const okBuckets = (remaining = 4000, reset = T0 / 1000 + 3600): RateLimitBuckets => ({
  rest: { limit: 5000, remaining, used: 5000 - remaining, reset },
  graphql: { limit: 5000, remaining, used: 5000 - remaining, reset }
})
const rateLimitBody = JSON.stringify({
  resources: {
    core: { limit: 5000, remaining: 4999, used: 1, reset: 1_900_000_000 },
    graphql: { limit: 5000, remaining: 4000, used: 1000, reset: 1_900_000_100 }
  }
})

describe('probeRateLimit', () => {
  it('parses core + graphql from `gh api rate_limit`', async () => {
    const r = await probeRateLimit(async () => ({ stdout: rateLimitBody }))
    expect(r.ok && r.buckets.graphql.remaining).toBe(4000)
    expect(r.ok && r.buckets.rest.limit).toBe(5000)
  })

  it('is `missing` when gh is not installed, `unauthenticated` when signed out, else `error`', async () => {
    const fail = (e: object) => async (): Promise<{ stdout: string }> => {
      throw Object.assign(new Error('x'), e)
    }
    expect(await probeRateLimit(fail({ code: 'ENOENT' }))).toEqual({ ok: false, reason: 'missing' })
    expect(
      await probeRateLimit(
        fail({ code: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login' })
      )
    ).toEqual({ ok: false, reason: 'unauthenticated' })
    expect(await probeRateLimit(fail({ code: 1, stderr: 'dial tcp: no such host' }))).toEqual({
      ok: false,
      reason: 'error'
    })
    expect(await probeRateLimit(async () => ({ stdout: '<html>' }))).toEqual({
      ok: false,
      reason: 'error'
    })
  })
})

describe('nextPollDelayMs', () => {
  const base = { consecutiveErrors: 0, exhaustedResetAt: null, now: T0 }
  it('60 s when it works, 10 min when gh is missing or signed out', () => {
    expect(nextPollDelayMs({ ...base, reason: null })).toBe(POLL_INTERVAL_MS)
    expect(nextPollDelayMs({ ...base, reason: 'missing' })).toBe(UNAVAILABLE_BACKOFF_MS)
    expect(nextPollDelayMs({ ...base, reason: 'unauthenticated' })).toBe(UNAVAILABLE_BACKOFF_MS)
  })

  it('backs a transient error off exponentially, capped at 10 min', () => {
    const delays = [0, 1, 2, 3, 4, 9].map((n) =>
      nextPollDelayMs({ ...base, reason: 'error', consecutiveErrors: n })
    )
    expect(delays).toEqual([60_000, 120_000, 240_000, 480_000, 600_000, 600_000])
  })

  it('schedules a poll just after an exhausted reset when that comes sooner', () => {
    expect(nextPollDelayMs({ ...base, reason: null, exhaustedResetAt: T0 + 20_000 })).toBe(
      20_000 + RESET_SLACK_MS
    )
    // A reset further away than the normal cadence does not stretch it.
    expect(nextPollDelayMs({ ...base, reason: null, exhaustedResetAt: T0 + 900_000 })).toBe(
      POLL_INTERVAL_MS
    )
    // Unavailable + exhausted-by-stderr still gets its post-reset look.
    expect(nextPollDelayMs({ ...base, reason: 'missing', exhaustedResetAt: T0 + 30_000 })).toBe(
      30_000 + RESET_SLACK_MS
    )
  })
})

describe('createBudgetPoller (AC-2)', () => {
  function harness(results: ProbeResult[]) {
    let now = T0
    const timers: Array<{ at: number; fn: () => void; id: number }> = []
    let nextId = 1
    const probe = vi.fn(
      async (): Promise<ProbeResult> =>
        (results.length > 1 ? results.shift() : results[0]) ?? { ok: true, buckets: okBuckets() }
    )
    const tracker = createBudgetTracker({ now: () => now })
    const poller = createBudgetPoller({
      tracker,
      probe,
      now: () => now,
      setTimer: (fn, ms) => {
        const id = nextId++
        timers.push({ at: now + ms, fn, id })
        return id
      },
      clearTimer: (h) => {
        const i = timers.findIndex((t) => t.id === h)
        if (i >= 0) timers.splice(i, 1)
      }
    })
    /** Advance the clock to the next scheduled poll and let it finish. */
    const fire = async (): Promise<number> => {
      timers.sort((a, b) => a.at - b.at)
      const next = timers.shift()
      expect(next).toBeDefined()
      const waited = next!.at - now
      now = next!.at
      next!.fn()
      await vi.waitFor(() => expect(timers.length).toBeGreaterThan(0))
      return waited
    }
    return { poller, probe, tracker, fire, timers, clock: () => now }
  }

  it('polls at start and then every 60 s', async () => {
    const h = harness([{ ok: true, buckets: okBuckets() }])
    h.poller.start()
    await vi.waitFor(() => expect(h.probe).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(h.timers).toHaveLength(1))
    expect(await h.fire()).toBe(60_000)
    expect(h.probe).toHaveBeenCalledTimes(2)
    expect(h.tracker.snapshot().status).toBe('ok')
    expect(h.tracker.snapshot().rest?.bucket.remaining).toBe(4000)
    h.poller.stop()
  })

  it('goes `unavailable` and polls every 10 min when gh is missing — no retry storm', async () => {
    const h = harness([{ ok: false, reason: 'missing' }])
    h.poller.start()
    await vi.waitFor(() => expect(h.timers).toHaveLength(1))
    expect(h.tracker.snapshot()).toMatchObject({ status: 'unavailable', reason: 'missing' })
    for (let i = 0; i < 3; i++) expect(await h.fire()).toBe(UNAVAILABLE_BACKOFF_MS)
    expect(h.probe).toHaveBeenCalledTimes(4)
    h.poller.stop()
  })

  it('recovers on its own once gh answers again', async () => {
    const h = harness([
      { ok: false, reason: 'unauthenticated' },
      { ok: true, buckets: okBuckets(3000) }
    ])
    h.poller.start()
    await vi.waitFor(() => expect(h.timers).toHaveLength(1))
    expect(h.tracker.snapshot().status).toBe('unavailable')
    expect(await h.fire()).toBe(UNAVAILABLE_BACKOFF_MS)
    expect(h.tracker.snapshot()).toMatchObject({ status: 'ok' })
    expect(await h.fire()).toBe(POLL_INTERVAL_MS)
    h.poller.stop()
  })

  it('one pollNow in flight is shared, and stop() cancels the schedule', async () => {
    const h = harness([{ ok: true, buckets: okBuckets() }])
    h.poller.start()
    await Promise.all([h.poller.pollNow(), h.poller.pollNow()])
    expect(h.probe.mock.calls.length).toBeLessThanOrEqual(2)
    h.poller.stop()
    expect(h.timers).toHaveLength(0)
  })

  it('schedules a poll right after an exhausted reset so normal polling resumes', async () => {
    const reset = T0 / 1000 + 20
    const h = harness([
      {
        ok: true,
        buckets: { ...okBuckets(), graphql: { limit: 5000, remaining: 0, used: 5000, reset } }
      },
      { ok: true, buckets: okBuckets(5000, reset + 3600) }
    ])
    h.poller.start()
    await vi.waitFor(() => expect(h.timers).toHaveLength(1))
    expect(h.tracker.state()).toBe('exhausted')
    expect(await h.fire()).toBe(20_000 + RESET_SLACK_MS)
    expect(h.tracker.state()).toBe('normal')
    h.poller.stop()
  })
})
