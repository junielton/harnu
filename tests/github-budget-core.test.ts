/**
 * T611 U1 — the GitHub API budget, pure core: rate_limit parsing, attribution (AC-3), the throttle
 * state machine (AC-4), what each state does to consumers (AC-5, AC-6) and the prefs (AC-8).
 */
import { describe, it, expect } from 'vitest'
import {
  createBudgetTracker,
  defaultBudgetPrefs,
  evaluateThrottle,
  gateCacheTtlMs,
  initialThrottle,
  isRateLimitStderr,
  parseRetryAfterMs,
  SECONDARY_PAUSE_MAX_MS,
  normalizeBudgetPrefs,
  parseRateLimit,
  skipPrStackBackground,
  tighterOf,
  type BudgetBucket,
  type RateLimitBuckets
} from '../src/main/github-budget-core'

const T0 = Date.UTC(2026, 10, 2, 12, 0, 0)
const HOUR = 3_600_000

const bucket = (
  remaining: number,
  used = 5000 - remaining,
  reset = T0 / 1000 + 3000
): BudgetBucket => ({
  limit: 5000,
  remaining,
  used,
  reset
})
const buckets = (rest: BudgetBucket, graphql: BudgetBucket): RateLimitBuckets => ({ rest, graphql })

function rateLimitJson(core: BudgetBucket, graphql: BudgetBucket): string {
  return JSON.stringify({ resources: { core, graphql, search: { limit: 30 } }, rate: core })
}

describe('parseRateLimit (AC-2)', () => {
  it('reads core and graphql: limit, remaining, used, reset', () => {
    const out = parseRateLimit(
      rateLimitJson(
        { limit: 5000, remaining: 4200, used: 800, reset: 1_800_000_000 },
        { limit: 5000, remaining: 100, used: 4900, reset: 1_800_000_500 }
      )
    )
    expect(out).toEqual({
      rest: { limit: 5000, remaining: 4200, used: 800, reset: 1_800_000_000 },
      graphql: { limit: 5000, remaining: 100, used: 4900, reset: 1_800_000_500 }
    })
  })

  it('derives `used` when absent and rejects bodies that are not a rate_limit answer', () => {
    const out = parseRateLimit(
      JSON.stringify({
        resources: {
          core: { limit: 5000, remaining: 4000, reset: 1 },
          graphql: { limit: 5000, remaining: 5000, reset: 1 }
        }
      })
    )
    expect(out?.rest.used).toBe(1000)
    expect(parseRateLimit('not json')).toBeNull()
    expect(parseRateLimit('{}')).toBeNull()
    expect(parseRateLimit(JSON.stringify({ resources: { core: { limit: 0 } } }))).toBeNull()
  })
})

describe('tighterOf (D-2)', () => {
  it('picks the bucket with the lower remaining fraction; a tie is REST', () => {
    expect(tighterOf(buckets(bucket(4000), bucket(100)))).toBe('graphql')
    expect(tighterOf(buckets(bucket(100), bucket(4000)))).toBe('rest')
    expect(tighterOf(buckets(bucket(2000), bucket(2000)))).toBe('rest')
  })
})

describe('throttle state machine (AC-4)', () => {
  const at = (s = 0): number => T0 + s * 1000

  it('normal → low at the threshold on the TIGHTER bucket, recording `since`', () => {
    let st = initialThrottle(at())
    st = evaluateThrottle(st, buckets(bucket(4900), bucket(900)), 15, at(10)) // graphql 18 %
    expect(st.state).toBe('normal')
    st = evaluateThrottle(st, buckets(bucket(4900), bucket(750)), 15, at(20)) // exactly 15 %
    expect(st).toMatchObject({ state: 'low', since: at(20) })
    // A second evaluation in the same state keeps the original `since`.
    st = evaluateThrottle(st, buckets(bucket(4900), bucket(700)), 15, at(30))
    expect(st).toMatchObject({ state: 'low', since: at(20) })
  })

  it('honours the 10 / 15 / 25 % thresholds', () => {
    const b = buckets(bucket(1000), bucket(5000)) // rest at 20 %
    expect(evaluateThrottle(initialThrottle(at()), b, 10, at(1)).state).toBe('normal')
    expect(evaluateThrottle(initialThrottle(at()), b, 15, at(1)).state).toBe('normal')
    expect(evaluateThrottle(initialThrottle(at()), b, 25, at(1)).state).toBe('low')
  })

  it('low → exhausted at remaining 0, then back to normal at that bucket reset', () => {
    const reset = at(600) / 1000
    let st = evaluateThrottle(
      initialThrottle(at()),
      buckets(bucket(4000), bucket(0, 5000, reset)),
      15,
      at(1)
    )
    expect(st).toMatchObject({
      state: 'exhausted',
      since: at(1),
      resetAt: reset * 1000
    })
    // Before the reset, with no fresh data, it stays exhausted…
    expect(evaluateThrottle(st, null, 15, at(599)).state).toBe('exhausted')
    // …and at the reset the clock alone releases it.
    st = evaluateThrottle(st, null, 15, at(600))
    expect(st).toMatchObject({ state: 'normal', since: at(600), resetAt: null })
  })

  it('a fresh poll that shows budget releases a poll-sourced exhaustion', () => {
    const st = evaluateThrottle(
      initialThrottle(at()),
      buckets(bucket(0, 5000, at(600) / 1000), bucket(5000)),
      15,
      at(1)
    )
    const after = evaluateThrottle(st, buckets(bucket(5000, 0), bucket(5000)), 15, at(60))
    expect(after.state).toBe('normal')
  })
})

describe('tracker: throttle driven by polls (AC-4)', () => {
  it('moves normal → low → exhausted → normal as polls and the clock say', () => {
    let now = T0
    const t = createBudgetTracker({ now: () => now })
    const seen: string[] = []
    t.onChange((s) => seen.push(s.throttle.state))
    expect(t.state()).toBe('normal')
    t.applyPoll({ ok: true, buckets: buckets(bucket(4900), bucket(500)) })
    expect(t.state()).toBe('low')
    now += 60_000
    t.applyPoll({ ok: true, buckets: buckets(bucket(4900), bucket(0, 5000, now / 1000 + 600)) })
    expect(t.state()).toBe('exhausted')
    expect(t.snapshot().throttle).toMatchObject({ state: 'exhausted', since: now, threshold: 15 })
    now += 600_000 // past the reset: state() reads the clock, no poll needed
    expect(t.state()).toBe('normal')
    expect(seen).toContain('low')
    expect(seen).toContain('exhausted')
  })

  it('changing the threshold re-evaluates against the last poll', () => {
    const t = createBudgetTracker({ now: () => T0 })
    t.applyPoll({ ok: true, buckets: buckets(bucket(900), bucket(5000)) }) // 18 %
    expect(t.state()).toBe('normal')
    t.setPrefs({ ...defaultBudgetPrefs(), threshold: 25 })
    expect(t.state()).toBe('low')
  })
})

describe('rate-limit message vs empty bucket vs secondary limit (AC-9, amended)', () => {
  /** A tracker whose end-of-pause timer is driven by hand. */
  function rig() {
    let now = T0
    const timers: Array<{ at: number; fn: () => void }> = []
    const t = createBudgetTracker({
      now: () => now,
      setTimer: (fn, ms) => {
        const e = { at: now + ms, fn }
        timers.push(e)
        return e
      },
      clearTimer: (h) => {
        const i = timers.indexOf(h as (typeof timers)[number])
        if (i >= 0) timers.splice(i, 1)
      }
    })
    const events: Array<string | null> = []
    t.onChange((s) => events.push(s.secondaryPauseUntil))
    const advance = (ms: number): void => {
      now += ms
      for (const e of [...timers]) {
        if (e.at <= now) {
          timers.splice(timers.indexOf(e), 1)
          e.fn()
        }
      }
    }
    return { t, events, advance, now: () => now, timers }
  }
  const FULL = buckets(bucket(2900, 2100, T0 / 1000 + 3000), bucket(2700, 2300, T0 / 1000 + 3000))

  it('(c) a message with budget left is a secondary limit: reads pause 60 s, the state does not change', () => {
    const { t, now } = rig()
    t.applyPoll({ ok: true, buckets: FULL })
    expect(t.readsPaused()).toBe(false)
    t.markRateLimited()
    expect(t.readsPaused()).toBe(true)
    expect(t.state()).toBe('normal')
    expect(t.snapshot().secondaryPauseUntil).toBe(new Date(now() + 60_000).toISOString())
    expect(t.snapshot().throttle.state).toBe('normal')
  })

  it('(a) asks the rate-limit listeners to poll at once, and stops when unsubscribed', () => {
    const { t } = rig()
    let polls = 0
    const off = t.onRateLimit(() => polls++)
    t.markRateLimited()
    expect(polls).toBe(1)
    off()
    t.markRateLimited()
    expect(polls).toBe(1)
  })

  it('(b) a poll that finds the buckets full leaves the state alone and the pause running', () => {
    const { t, advance } = rig()
    t.applyPoll({ ok: true, buckets: FULL })
    t.markRateLimited()
    advance(2_000)
    t.applyPoll({ ok: true, buckets: FULL })
    expect(t.state()).toBe('normal')
    expect(t.readsPaused()).toBe(true)
    expect(t.snapshot().secondaryPauseUntil).not.toBeNull()
  })

  it('(b) only a bucket at remaining 0 makes it exhausted — and that supersedes the timed pause', () => {
    const { t, advance } = rig()
    t.applyPoll({ ok: true, buckets: FULL })
    t.markRateLimited()
    advance(1_000)
    t.applyPoll({ ok: true, buckets: buckets(bucket(4000), bucket(0, 5000, T0 / 1000 + 900)) })
    expect(t.state()).toBe('exhausted')
    expect(t.snapshot().secondaryPauseUntil).toBeNull()
    expect(t.readsPaused()).toBe(true) // exhausted pauses them anyway
  })

  it('a rate-limit message alone never makes it exhausted, even with no poll yet', () => {
    const { t } = rig()
    t.markRateLimited()
    expect(t.state()).toBe('normal')
  })

  it('the pause ends by itself after 60 s', () => {
    const { t, advance } = rig()
    t.markRateLimited()
    advance(59_000)
    expect(t.readsPaused()).toBe(true)
    advance(2_000)
    expect(t.readsPaused()).toBe(false)
    expect(t.snapshot().secondaryPauseUntil).toBeNull()
  })

  it('honours the wait gh names (Retry-After) instead of 60 s', () => {
    const { t, advance, now } = rig()
    t.markRateLimited(parseRetryAfterMs('HTTP 403: retry-after: 120'))
    expect(t.snapshot().secondaryPauseUntil).toBe(new Date(now() + 120_000).toISOString())
    advance(119_000)
    expect(t.readsPaused()).toBe(true)
    advance(2_000)
    expect(t.readsPaused()).toBe(false)
  })

  it('pushes a change event when the pause starts and when it ends', () => {
    const { t, events, advance, now } = rig()
    const start = now()
    t.markRateLimited()
    expect(events).toEqual([new Date(start + 60_000).toISOString()])
    advance(61_000) // the end-of-pause timer fires with no poll and no read in between
    expect(events).toEqual([new Date(start + 60_000).toISOString(), null])
  })

  it('a second message during the pause extends it, never shortens it', () => {
    const { t, advance, now } = rig()
    t.markRateLimited(120_000)
    const first = t.snapshot().secondaryPauseUntil
    advance(10_000)
    t.markRateLimited() // a 60 s default would end sooner than the 110 s left
    expect(t.snapshot().secondaryPauseUntil).toBe(first)
    advance(10_000)
    t.markRateLimited(300_000)
    expect(t.snapshot().secondaryPauseUntil).toBe(new Date(now() + 300_000).toISOString())
  })
})

describe('parseRetryAfterMs (AC-9)', () => {
  it('reads Retry-After / retry after N, seconds by default, minutes when said', () => {
    expect(parseRetryAfterMs('HTTP 403: Retry-After: 45')).toBe(45_000)
    expect(parseRetryAfterMs('please retry after 30 seconds')).toBe(30_000)
    expect(parseRetryAfterMs('retry-after 2 minutes')).toBe(120_000)
    expect(parseRetryAfterMs('Retry-After=90')).toBe(90_000)
  })

  it('is null when gh names no wait, and clamps a silly one', () => {
    expect(parseRetryAfterMs('GraphQL: API rate limit exceeded')).toBeNull()
    expect(parseRetryAfterMs('retry after 0')).toBeNull()
    expect(parseRetryAfterMs('Retry-After: 999999')).toBe(SECONDARY_PAUSE_MAX_MS)
  })
})

describe('isRateLimitStderr (AC-9)', () => {
  it('matches the rate-limit wording gh prints', () => {
    expect(isRateLimitStderr('GraphQL: API rate limit exceeded for user ID 1.')).toBe(true)
    expect(isRateLimitStderr('gh: You have exceeded a secondary rate limit')).toBe(true)
    expect(isRateLimitStderr('error connecting to api.github.com')).toBe(false)
  })
})

describe('attribution (AC-3)', () => {
  it('counts per consumer and per resource, and outside = max(0, used − harnu)', () => {
    let now = T0
    const t = createBudgetTracker({ now: () => now })
    const reset = now / 1000 + 3000
    t.applyPoll({ ok: true, buckets: buckets(bucket(5000, 0, reset), bucket(5000, 0, reset)) })
    for (let i = 0; i < 6; i++) t.record('missions', 'graphql')
    for (let i = 0; i < 4; i++) t.record('pr-stack', 'graphql')
    t.record('cleanup', 'rest')
    now += 60_000
    t.applyPoll({ ok: true, buckets: buckets(bucket(4990, 10, reset), bucket(4950, 50, reset)) })
    const snap = t.snapshot()
    expect(snap.graphql?.byConsumer).toMatchObject({ missions: 6, 'pr-stack': 4, review: 0 })
    expect(snap.graphql?.harnu).toBe(10)
    expect(snap.graphql?.outside).toBe(40) // 50 used − 10 ours
    expect(snap.rest?.byConsumer.cleanup).toBe(1)
    expect(snap.rest?.outside).toBe(9)
  })

  it('never reports a negative outside', () => {
    const t = createBudgetTracker({ now: () => T0 })
    const reset = T0 / 1000 + 3000
    t.applyPoll({ ok: true, buckets: buckets(bucket(5000, 0, reset), bucket(5000, 0, reset)) })
    for (let i = 0; i < 20; i++) t.record('missions', 'graphql')
    t.applyPoll({ ok: true, buckets: buckets(bucket(5000, 0, reset), bucket(4995, 5, reset)) })
    expect(t.snapshot().graphql?.outside).toBe(0)
  })

  it('resets the counts at the window boundary', () => {
    let now = T0
    const t = createBudgetTracker({ now: () => now })
    const reset = now / 1000 + 600
    t.applyPoll({
      ok: true,
      buckets: buckets(bucket(4000, 1000, reset), bucket(4000, 1000, reset))
    })
    t.record('missions', 'graphql')
    expect(t.snapshot().graphql?.byConsumer.missions).toBe(1)
    // GitHub opens a new window: the next poll carries a later reset.
    now += 601_000
    t.applyPoll({
      ok: true,
      buckets: buckets(bucket(5000, 0, now / 1000 + 3600), bucket(5000, 0, now / 1000 + 3600))
    })
    expect(t.snapshot().graphql?.byConsumer.missions).toBe(0)
    // And a call after the boundary but before the next poll also starts the new count.
    t.record('missions', 'graphql')
    now += 3_601_000
    t.record('review', 'graphql')
    expect(t.snapshot().graphql?.byConsumer).toMatchObject({ missions: 0, review: 1 })
  })

  it('keeps 60 minutes of history in 5-minute buckets: Harnu, Harnu while throttled, outside', () => {
    let now = Math.floor(T0 / (5 * 60_000)) * 5 * 60_000
    const t = createBudgetTracker({ now: () => now })
    const reset = now / 1000 + 3600
    t.applyPoll({ ok: true, buckets: buckets(bucket(5000, 0, reset), bucket(5000, 0, reset)) })
    t.record('missions', 'graphql')
    t.record('missions', 'graphql') // 2 calls while normal
    now += 5 * 60_000
    t.applyPoll({ ok: true, buckets: buckets(bucket(5000, 0, reset), bucket(4980, 20, reset)) }) // 18 outside
    // Push into `low`, then spend two throttled calls in a later bucket.
    now += 5 * 60_000
    t.applyPoll({ ok: true, buckets: buckets(bucket(5000, 0, reset), bucket(600, 4400, reset)) })
    expect(t.state()).toBe('low')
    t.record('review', 'graphql')
    t.record('review', 'graphql')
    const hist = t.snapshot().graphql!.history
    expect(hist).toHaveLength(12)
    expect(hist.map((b) => b.start)).toEqual([...hist.map((b) => b.start)].sort((a, b) => a - b))
    expect(hist[hist.length - 1].start).toBe(now)
    expect(hist[hist.length - 1]).toMatchObject({ throttled: 2 })
    expect(hist[hist.length - 3]).toMatchObject({ harnu: 2 })
    expect(hist[hist.length - 2].outside).toBe(18)
    // Old buckets fall off after an hour.
    now += HOUR + 10 * 60_000
    expect(t.snapshot().graphql!.history.every((b) => b.harnu === 0 && b.throttled === 0)).toBe(
      true
    )
  })

  it('paces over the last 10 minutes: calls/min and projected time to empty', () => {
    let now = T0
    const t = createBudgetTracker({ now: () => now })
    const reset = now / 1000 + 3600
    t.applyPoll({ ok: true, buckets: buckets(bucket(5000, 0, reset), bucket(4000, 1000, reset)) })
    for (let i = 0; i < 20; i++) t.record('missions', 'graphql')
    now += 10 * 60_000
    // 1000 → 1600 used in 10 minutes = 60 / min; 2400 left → 40 minutes to empty.
    t.applyPoll({ ok: true, buckets: buckets(bucket(5000, 0, reset), bucket(3400, 1600, reset)) })
    const pace = t.snapshot().graphql!.pace
    expect(pace.windowMinutes).toBe(10)
    expect(pace.callsPerMin).toBeCloseTo(60, 5)
    expect(pace.harnuCallsPerMin).toBeCloseTo(2, 5)
    expect(pace.minutesToEmpty).toBeCloseTo(3400 / 60, 5)
  })

  it('has no projection when nothing is being spent', () => {
    let now = T0
    const t = createBudgetTracker({ now: () => now })
    const reset = now / 1000 + 3600
    t.applyPoll({ ok: true, buckets: buckets(bucket(5000, 0, reset), bucket(5000, 0, reset)) })
    now += 60_000
    t.applyPoll({ ok: true, buckets: buckets(bucket(5000, 0, reset), bucket(5000, 0, reset)) })
    expect(t.snapshot().graphql!.pace.minutesToEmpty).toBeNull()
  })

  it('reports `unavailable` for a missing or signed-out gh, and ignores one transient error', () => {
    const t = createBudgetTracker({ now: () => T0 })
    t.applyPoll({ ok: true, buckets: buckets(bucket(4000), bucket(4000)) })
    t.applyPoll({ ok: false, reason: 'error' })
    expect(t.snapshot().status).toBe('ok')
    t.applyPoll({ ok: false, reason: 'missing' })
    expect(t.snapshot()).toMatchObject({ status: 'unavailable', reason: 'missing' })
    t.applyPoll({ ok: true, buckets: buckets(bucket(4000), bucket(4000)) })
    expect(t.snapshot()).toMatchObject({ status: 'ok', reason: null })
  })
})

describe('the gh login on the snapshot (AC-8b)', () => {
  it('is null until resolved, is exposed once set, and tells listeners', () => {
    const t = createBudgetTracker({ now: () => T0 })
    const seen: Array<string | null> = []
    t.onChange((s) => seen.push(s.login))
    t.applyPoll({ ok: true, buckets: buckets(bucket(4000), bucket(4000)) })
    expect(t.snapshot().login).toBeNull()
    t.setLogin('octocat')
    expect(t.snapshot().login).toBe('octocat')
    t.setLogin('octocat') // no change, no event
    expect(seen.filter((l) => l === 'octocat')).toHaveLength(1)
  })

  it('is forgotten when gh goes missing or signed out, kept through a transient error', () => {
    const t = createBudgetTracker({ now: () => T0 })
    t.applyPoll({ ok: true, buckets: buckets(bucket(4000), bucket(4000)) })
    t.setLogin('octocat')
    t.applyPoll({ ok: false, reason: 'error' })
    expect(t.snapshot().login).toBe('octocat')
    t.applyPoll({ ok: false, reason: 'unauthenticated' })
    expect(t.snapshot().login).toBeNull()
    t.applyPoll({ ok: true, buckets: buckets(bucket(4000), bucket(4000)) })
    expect(t.snapshot().login).toBeNull() // back, but not re-resolved until the poller asks
  })
})

describe('what a state does to consumers (AC-5, AC-6)', () => {
  it('mission gate caches: 60 s normal → 5 min low → last known value while exhausted', () => {
    expect(gateCacheTtlMs('normal')).toBe(60_000)
    expect(gateCacheTtlMs('low')).toBe(5 * 60_000)
    expect(gateCacheTtlMs('exhausted')).toBe(Number.POSITIVE_INFINITY)
  })

  it('PR Stack background refresh pauses on low (when the pref is on) and on exhausted', () => {
    const on = defaultBudgetPrefs()
    const off = { ...on, pausePrStackWhenLow: false }
    expect(skipPrStackBackground('normal', on)).toBe(false)
    expect(skipPrStackBackground('low', on)).toBe(true)
    expect(skipPrStackBackground('low', off)).toBe(false)
    expect(skipPrStackBackground('exhausted', off)).toBe(true)
  })
})

describe('prefs (AC-8)', () => {
  it('defaults: 15 %, delivered missions unchecked, PR Stack paused when low, notify on', () => {
    expect(defaultBudgetPrefs()).toEqual({
      version: 1,
      threshold: 15,
      checkDelivered: false,
      pausePrStackWhenLow: true,
      notify: true
    })
  })

  it('normalizes junk into a fully populated, clamped object', () => {
    expect(normalizeBudgetPrefs(null)).toEqual(defaultBudgetPrefs())
    expect(normalizeBudgetPrefs('x')).toEqual(defaultBudgetPrefs())
    expect(
      normalizeBudgetPrefs({ threshold: 'high', checkDelivered: 'yes', pausePrStackWhenLow: 1 })
    ).toEqual(defaultBudgetPrefs())
    expect(normalizeBudgetPrefs({ threshold: 25, checkDelivered: true, notify: false })).toEqual({
      version: 1,
      threshold: 25,
      checkDelivered: true,
      pausePrStackWhenLow: true,
      notify: false
    })
  })

  it('snaps a numeric threshold to the nearest allowed step', () => {
    expect(normalizeBudgetPrefs({ threshold: 1 }).threshold).toBe(10)
    expect(normalizeBudgetPrefs({ threshold: 14 }).threshold).toBe(15)
    expect(normalizeBudgetPrefs({ threshold: 21 }).threshold).toBe(25)
    expect(normalizeBudgetPrefs({ threshold: 99 }).threshold).toBe(25)
    expect(normalizeBudgetPrefs({ threshold: Number.NaN }).threshold).toBe(15)
  })
})
