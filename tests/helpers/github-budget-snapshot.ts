/**
 * Snapshot fixtures for the GitHub budget UI tests — the mockup's sample data
 * (docs/specs/2026-11-02-github-rate-limit/mockup.json): healthy, low and exhausted, all at
 * "now" = 13:22 local-independent epoch values the tests pass in.
 */
import type {
  BudgetPrefs,
  BudgetSnapshot,
  HistoryBucket,
  ResourceView
} from '../../src/main/github-budget-core'

/** A fixed "now" (epoch ms) every fixture is built around. */
export const NOW = Date.UTC(2026, 10, 2, 13, 22, 0)
const BUCKET_MS = 5 * 60_000

export function prefs(over: Partial<BudgetPrefs> = {}): BudgetPrefs {
  return {
    version: 1,
    threshold: 15,
    checkDelivered: false,
    pausePrStackWhenLow: true,
    notify: true,
    ...over
  }
}

function history(rows: Array<[number, number, number]>): HistoryBucket[] {
  // Oldest first; the last entry is the current 5-minute bucket.
  const startOfNow = Math.floor(NOW / BUCKET_MS) * BUCKET_MS
  return rows.map(([harnu, throttled, outside], i) => ({
    start: startOfNow - (rows.length - 1 - i) * BUCKET_MS,
    harnu,
    throttled,
    outside
  }))
}

const QUIET = history(Array.from({ length: 12 }, () => [0, 0, 0]))

function view(args: {
  remaining: number
  resetInMin: number
  byConsumer: Partial<Record<string, number>>
  outside: number
  history?: HistoryBucket[]
  callsPerMin?: number | null
  harnuPerMin?: number
  minutesToEmpty?: number | null
}): ResourceView {
  const byConsumer = {
    missions: 0,
    'pr-stack': 0,
    review: 0,
    cleanup: 0,
    steward: 0,
    'merge-batch': 0,
    ...args.byConsumer
  }
  const harnu = Object.values(byConsumer).reduce((a, b) => a + b, 0)
  return {
    bucket: {
      limit: 5000,
      remaining: args.remaining,
      used: 5000 - args.remaining,
      reset: Math.round((NOW + args.resetInMin * 60_000) / 1000)
    },
    byConsumer,
    harnu,
    outside: args.outside,
    history: args.history ?? QUIET,
    pace: {
      windowMinutes: 10,
      callsPerMin: args.callsPerMin ?? null,
      harnuCallsPerMin: args.harnuPerMin ?? 0,
      minutesToEmpty: args.minutesToEmpty ?? null
    }
  } as ResourceView
}

export function healthy(over: Partial<BudgetPrefs> = {}): BudgetSnapshot {
  return {
    status: 'ok',
    reason: null,
    sampledAt: NOW - 20_000,
    rest: view({
      remaining: 4112,
      resetInMin: 38,
      byConsumer: { missions: 412, 'pr-stack': 96, review: 38, cleanup: 22, steward: 14 },
      outside: 306,
      history: history([
        [60, 0, 30],
        [70, 0, 40],
        [65, 0, 45],
        [62, 0, 35],
        [58, 0, 50],
        [67, 0, 55],
        [200, 0, 51],
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0]
      ]),
      callsPerMin: 31,
      harnuPerMin: 18,
      minutesToEmpty: 132
    }),
    graphql: view({ remaining: 4690, resetInMin: 38, byConsumer: {}, outside: 0 }),
    tighter: 'rest',
    throttle: {
      state: 'normal',
      since: NOW - 3_600_000,
      threshold: 15,
      resetAt: null
    },
    prefs: prefs(over)
  }
}

export function low(over: Partial<BudgetPrefs> = {}): BudgetSnapshot {
  return {
    status: 'ok',
    reason: null,
    sampledAt: NOW - 20_000,
    rest: view({
      remaining: 640,
      resetInMin: 21,
      byConsumer: { missions: 1840, 'pr-stack': 310, review: 84, cleanup: 46, steward: 30 },
      outside: 2050,
      history: history([
        [240, 0, 100],
        [400, 0, 180],
        [440, 0, 260],
        [460, 0, 300],
        [420, 0, 380],
        [450, 0, 440],
        [410, 0, 480],
        [430, 0, 500],
        [0, 140, 520],
        [0, 120, 480],
        [0, 0, 0],
        [0, 0, 0]
      ]),
      callsPerMin: 104,
      harnuPerMin: 22,
      minutesToEmpty: 6.2
    }),
    graphql: view({ remaining: 3980, resetInMin: 21, byConsumer: {}, outside: 0 }),
    tighter: 'rest',
    throttle: {
      state: 'low',
      since: NOW - 43 * 60_000,
      threshold: 15,
      resetAt: null
    },
    prefs: prefs(over)
  }
}

export function exhausted(over: Partial<BudgetPrefs> = {}): BudgetSnapshot {
  const snap = low(over)
  const resetAt = NOW + 12 * 60_000
  return {
    ...snap,
    rest: view({
      remaining: 0,
      resetInMin: 12,
      byConsumer: { missions: 2110, 'pr-stack': 340, review: 92, cleanup: 48, steward: 30 },
      outside: 2380,
      callsPerMin: 0,
      harnuPerMin: 0
    }),
    graphql: view({ remaining: 3800, resetInMin: 12, byConsumer: {}, outside: 0 }),
    throttle: { state: 'exhausted', since: NOW - 5 * 60_000, threshold: 15, resetAt }
  }
}

export function unavailable(): BudgetSnapshot {
  return {
    status: 'unavailable',
    reason: 'missing',
    sampledAt: null,
    rest: null,
    graphql: null,
    tighter: null,
    throttle: { state: 'normal', since: NOW, threshold: 15, resetAt: null },
    prefs: prefs()
  }
}
