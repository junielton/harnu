/**
 * T611 U1 — the GitHub API budget, pure part (no electron, no child_process).
 *
 * Every `gh` call Harnu makes spends the operator's personal GitHub budget: 5,000 REST requests and
 * 5,000 GraphQL points an hour, shared with every other session and script on the same token.
 * This module holds the three things that need no I/O and so are unit-tested directly:
 *
 *  - the **tracker**: per-consumer / per-resource call counts for GitHub's current window, the
 *    60-minute history, the 10-minute pace, and "outside Harnu" (GitHub's `used` minus our own count);
 *  - the **throttle state machine** (`normal` → `low` → `exhausted`) on the tighter of the two buckets;
 *  - the **prefs** (`normalizeBudgetPrefs`, same shape as `pr-stack-prefs.ts`).
 *
 * The shell (`github-budget.ts`) owns the poller, the disk and the IPC; `gh-runner.ts` is the one
 * place that spawns `gh` and feeds this tracker. Spec: docs/specs/2026-11-02-github-rate-limit/.
 */

/**
 * Who spent the call. `budget` is the budget feature itself: its one REST call per app run that
 * resolves the signed-in login (`gh api rate_limit`, the poll, is free and never counted).
 */
export type GhConsumer =
  'missions' | 'pr-stack' | 'review' | 'cleanup' | 'steward' | 'merge-batch' | 'budget'
export const GH_CONSUMERS: readonly GhConsumer[] = [
  'missions',
  'pr-stack',
  'review',
  'cleanup',
  'steward',
  'merge-batch',
  'budget'
]

/** GitHub keeps two separate buckets. Each GraphQL call is counted as one point (D-3). */
export type GhResource = 'rest' | 'graphql'
export const GH_RESOURCES: readonly GhResource[] = ['rest', 'graphql']

export type ThrottleState = 'normal' | 'low' | 'exhausted'

/** One bucket as `gh api rate_limit` reports it. `reset` is epoch SECONDS (GitHub's unit). */
export interface BudgetBucket {
  limit: number
  remaining: number
  used: number
  reset: number
}

export interface RateLimitBuckets {
  rest: BudgetBucket
  graphql: BudgetBucket
}

// ── Prefs ─────────────────────────────────────────────────────────────────────

export const THRESHOLDS = [10, 15, 25] as const
export type BudgetThreshold = (typeof THRESHOLDS)[number]

export interface BudgetPrefs {
  version: 1
  /** `low` begins when the tighter bucket's remaining is at or under this percentage. */
  threshold: BudgetThreshold
  /** D-5: delivered missions are never checked on GitHub unless the operator opts back in. */
  checkDelivered: boolean
  /** While `low`, PR Stack's background interval refresh is skipped (a load on open still runs). */
  pausePrStackWhenLow: boolean
  /** Toast on entering `low`, OS notification on `exhausted` (wired by the UI unit). */
  notify: boolean
}

export function defaultBudgetPrefs(): BudgetPrefs {
  return {
    version: 1,
    threshold: 15,
    checkDelivered: false,
    pausePrStackWhenLow: true,
    notify: true
  }
}

/**
 * Tolerates junk (wrong types, missing keys, out-of-range numbers) and always returns a
 * fully-populated, clamped object — a corrupt prefs file must not be able to stop the poller.
 * A numeric threshold snaps to the nearest allowed step.
 */
export function normalizeBudgetPrefs(raw: unknown): BudgetPrefs {
  const fallback = defaultBudgetPrefs()
  if (!raw || typeof raw !== 'object') return fallback
  const r = raw as Record<string, unknown>
  const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d)
  let threshold: BudgetThreshold = fallback.threshold
  if (typeof r.threshold === 'number' && Number.isFinite(r.threshold)) {
    const t = r.threshold
    threshold = THRESHOLDS.reduce((best, cur) =>
      Math.abs(cur - t) < Math.abs(best - t) ? cur : best
    )
  }
  return {
    version: 1,
    threshold,
    checkDelivered: bool(r.checkDelivered, fallback.checkDelivered),
    pausePrStackWhenLow: bool(r.pausePrStackWhenLow, fallback.pausePrStackWhenLow),
    notify: bool(r.notify, fallback.notify)
  }
}

// ── `gh api rate_limit` ───────────────────────────────────────────────────────

function parseBucket(raw: unknown): BudgetBucket | null {
  if (!raw || typeof raw !== 'object') return null
  const b = raw as Record<string, unknown>
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
  const limit = num(b.limit)
  const remaining = num(b.remaining)
  const reset = num(b.reset)
  if (limit === null || remaining === null || reset === null || limit <= 0) return null
  // `used` is derived when absent: older responses omit it.
  const used = num(b.used) ?? Math.max(0, limit - remaining)
  return { limit, remaining, used, reset }
}

/** `{ resources: { core, graphql } }` → the two buckets, or `null` when the body is not that. */
export function parseRateLimit(stdout: string): RateLimitBuckets | null {
  try {
    const body = JSON.parse(stdout) as { resources?: Record<string, unknown> }
    const rest = parseBucket(body?.resources?.core)
    const graphql = parseBucket(body?.resources?.graphql)
    return rest && graphql ? { rest, graphql } : null
  } catch {
    return null
  }
}

/** Why `gh api rate_limit` could not answer. */
export type PollFailure = 'missing' | 'unauthenticated' | 'error'

/** `gh` is not installed (ENOENT) or not signed in; anything else is a transient `error`. */
export function classifyPollFailure(err: unknown): PollFailure {
  const e: { code?: unknown; stderr?: unknown } = err && typeof err === 'object' ? err : {}
  if (e.code === 'ENOENT') return 'missing'
  const stderr = typeof e.stderr === 'string' ? e.stderr : ''
  if (
    /gh auth login|not logged in|authentication required|GH_TOKEN|HTTP 401|bad credentials/i.test(
      stderr
    )
  ) {
    return 'unauthenticated'
  }
  return 'error'
}

/**
 * A `gh` stderr that talks about a rate limit. It does NOT say which: an empty bucket and GitHub's
 * secondary (abuse) limit read alike, so this only triggers a look at `gh api rate_limit` (AC-9).
 */
export function isRateLimitStderr(stderr: string): boolean {
  return /rate limit|API rate|secondary rate|abuse detection|retry[- ]after/i.test(stderr)
}

/** How long reads pause on a secondary limit when `gh` names no wait. */
export const SECONDARY_PAUSE_MS = 60_000
/** A wait `gh` names is honoured up to here, so a bogus value cannot freeze reads for a day. */
export const SECONDARY_PAUSE_MAX_MS = 60 * 60_000

/**
 * The wait GitHub asked for in `gh`'s stderr: `Retry-After: 120`, `retry after 30 seconds`,
 * `retry-after 2 minutes`. Seconds unless a minutes unit follows. `null` when it names none.
 */
export function parseRetryAfterMs(stderr: string): number | null {
  const m = /retry[- ]after\b[:=\s]*(\d+)\s*(minutes?|mins?|m\b)?/i.exec(stderr)
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.min(SECONDARY_PAUSE_MAX_MS, n * (m[2] ? 60_000 : 1000))
}

// ── Tighter bucket and the state machine ──────────────────────────────────────

export function remainingFraction(b: BudgetBucket): number {
  return b.limit > 0 ? b.remaining / b.limit : 1
}

/** D-2: the bucket with the lower remaining fraction. A tie goes to REST. */
export function tighterOf(buckets: RateLimitBuckets): GhResource {
  return remainingFraction(buckets.graphql) < remainingFraction(buckets.rest) ? 'graphql' : 'rest'
}

export interface ThrottleStatus {
  state: ThrottleState
  /** Epoch ms of the last transition (or of the first evaluation). */
  since: number
  /** Epoch ms at which `exhausted` ends. `null` outside `exhausted`. */
  resetAt: number | null
}

export function initialThrottle(now: number): ThrottleStatus {
  return { state: 'normal', since: now, resetAt: null }
}

function moved(
  prev: ThrottleStatus,
  next: Omit<ThrottleStatus, 'since'>,
  now: number
): ThrottleStatus {
  return { ...next, since: next.state === prev.state ? prev.since : now }
}

/**
 * D-4 on the tighter bucket, evaluated against a fresh poll (or the clock alone when `buckets` is
 * null). `normal` → `low` at remaining ≤ threshold; `exhausted` ONLY at remaining 0 (AC-9: a
 * rate-limit message alone never does it — a secondary limit leaves the buckets full); back to
 * `normal` at that bucket's reset.
 */
export function evaluateThrottle(
  prev: ThrottleStatus,
  buckets: RateLimitBuckets | null,
  threshold: number,
  now: number
): ThrottleStatus {
  if (buckets === null) {
    // No data: only the clock can move us, and only out of `exhausted`, at its reset.
    if (prev.state !== 'exhausted') return prev
    if (prev.resetAt !== null && now < prev.resetAt) return prev
    return moved(prev, { state: 'normal', resetAt: null }, now)
  }
  const tighter = buckets[tighterOf(buckets)]
  if (tighter.remaining <= 0) {
    return moved(prev, { state: 'exhausted', resetAt: tighter.reset * 1000 }, now)
  }
  if (remainingFraction(tighter) * 100 <= threshold) {
    return moved(prev, { state: 'low', resetAt: null }, now)
  }
  return moved(prev, { state: 'normal', resetAt: null }, now)
}

// ── Tracker: counts, history, pace ────────────────────────────────────────────

export const HISTORY_BUCKET_MS = 5 * 60_000
export const HISTORY_BUCKETS = 12
export const PACE_WINDOW_MS = 10 * 60_000
export const MAX_CALL_STAMPS = 5000

export interface HistoryBucket {
  /** Epoch ms of the bucket start (aligned to 5 minutes). */
  start: number
  /** Harnu's calls made while the budget was `normal`. */
  harnu: number
  /** Harnu's calls made while it was `low` or `exhausted`. */
  throttled: number
  /** GitHub's `used` growth that Harnu's own calls do not explain. */
  outside: number
}

export interface Pace {
  windowMinutes: number
  /** Everything spent on this bucket over the last 10 minutes, per minute (GitHub's `used`). */
  callsPerMin: number | null
  /** Harnu's own share, per minute. */
  harnuCallsPerMin: number
  /** `remaining / callsPerMin`; `null` when nothing is being spent. */
  minutesToEmpty: number | null
}

export interface ResourceView {
  bucket: BudgetBucket
  /** Harnu's calls in the current window, by consumer (zeroes included). */
  byConsumer: Record<GhConsumer, number>
  harnu: number
  /** `max(0, used − harnu)`: an estimate, since only GitHub knows the real figure. */
  outside: number
  history: HistoryBucket[]
  pace: Pace
}

export type BudgetStatus = 'ok' | 'unavailable'

export interface BudgetSnapshot {
  status: BudgetStatus
  /** Why the budget is unavailable. `null` while `ok`. */
  reason: PollFailure | null
  /** Epoch ms of the last good poll; `null` before the first. */
  sampledAt: number | null
  /**
   * The GitHub user of the `gh` token (`@login` in the popover header). Resolved once per app run;
   * `null` while `gh` is missing or signed out, or until the lookup has answered.
   */
  login: string | null
  rest: ResourceView | null
  graphql: ResourceView | null
  tighter: GhResource | null
  /**
   * ISO time until which throttled reads are paused because GitHub's SECONDARY limit hit while the
   * buckets still had budget (AC-9). `null` when no such pause is on. It does not change `throttle`.
   */
  secondaryPauseUntil: string | null
  throttle: { state: ThrottleState; since: number; threshold: number; resetAt: number | null }
  prefs: BudgetPrefs
}

function zeroByConsumer(): Record<GhConsumer, number> {
  return Object.fromEntries(GH_CONSUMERS.map((c) => [c, 0])) as Record<GhConsumer, number>
}

interface ResourceState {
  bucket: BudgetBucket | null
  /** Epoch ms the counting window ends; `null` until a poll tells us. */
  windowEnd: number | null
  byConsumer: Record<GhConsumer, number>
  history: Map<number, HistoryBucket>
  /** Timestamps of our own calls (pruned to the pace window). */
  stamps: number[]
  /** Our own calls since the last poll, to explain that poll's `used` delta. */
  sincePoll: number
  /** `used` samples of the last pace window, oldest first. */
  samples: Array<{ at: number; used: number }>
  /** `used` at the previous poll of the SAME window. */
  lastUsed: number | null
}

function freshResource(): ResourceState {
  return {
    bucket: null,
    windowEnd: null,
    byConsumer: zeroByConsumer(),
    history: new Map(),
    stamps: [],
    sincePoll: 0,
    samples: [],
    lastUsed: null
  }
}

export interface BudgetTracker {
  /** Count one `gh` call. Never throws. */
  record(consumer: GhConsumer, resource: GhResource): void
  /** Feed a poll result. */
  applyPoll(
    result: { ok: true; buckets: RateLimitBuckets } | { ok: false; reason: PollFailure }
  ): void
  /**
   * A `gh` call failed with a rate-limit message (AC-9). Pauses throttled reads at once for
   * `retryAfterMs` (default 60 s) and asks the rate-limit listeners to poll `gh api rate_limit` now.
   * The poll then decides: an empty bucket makes the state `exhausted`; otherwise the pause (a
   * secondary limit) simply runs out. Never changes the state by itself.
   */
  markRateLimited(retryAfterMs?: number | null): void
  /** True while throttled reads must not run: `exhausted`, or inside a secondary-limit pause. */
  readsPaused(): boolean
  /** Subscribe to rate-limit hits (the poller listens to poll at once); returns the unsubscribe. */
  onRateLimit(listener: () => void): () => void
  /** The resolved `gh` login (or `null` to forget it). Emits a change when it moves. */
  setLogin(login: string | null): void
  /** Move out of `exhausted` when its reset has passed. Call from a timer. */
  tick(): void
  setPrefs(prefs: BudgetPrefs): void
  getPrefs(): BudgetPrefs
  state(): ThrottleState
  snapshot(): BudgetSnapshot
  /** Subscribe to snapshot-affecting changes; returns the unsubscribe. */
  onChange(listener: (snap: BudgetSnapshot) => void): () => void
}

export function createBudgetTracker(
  deps: {
    now?: () => number
    prefs?: BudgetPrefs
    /** Schedules the end-of-pause tick. Defaults to an unref'd `setTimeout`. */
    setTimer?: (fn: () => void, ms: number) => unknown
    clearTimer?: (handle: unknown) => void
  } = {}
): BudgetTracker {
  const now = deps.now ?? Date.now
  const setTimer =
    deps.setTimer ??
    ((fn: () => void, ms: number): unknown => {
      const t = setTimeout(fn, ms)
      t.unref?.()
      return t
    })
  const clearTimer =
    deps.clearTimer ?? ((h: unknown): void => clearTimeout(h as ReturnType<typeof setTimeout>))
  let prefs = deps.prefs ?? defaultBudgetPrefs()
  let status: BudgetStatus = 'ok'
  let reason: PollFailure | null = null
  let sampledAt: number | null = null
  let login: string | null = null
  let throttle = initialThrottle(now())
  const res: Record<GhResource, ResourceState> = { rest: freshResource(), graphql: freshResource() }
  const listeners = new Set<(snap: BudgetSnapshot) => void>()
  // The last poll's buckets: a prefs change re-evaluates against them.
  let lastBuckets: RateLimitBuckets | null = null
  /** Epoch ms until which a secondary limit pauses throttled reads; `null` = none. */
  let secondaryUntil: number | null = null
  let pauseTimer: unknown = null
  const rateLimitListeners = new Set<() => void>()

  const emit = (): void => {
    if (listeners.size === 0) return
    const snap = snapshot()
    for (const l of listeners) {
      try {
        l(snap)
      } catch {
        /* a listener must never break the tracker */
      }
    }
  }

  /** The counting window ends at GitHub's `reset`; past it the counts start over. */
  const rollWindow = (r: ResourceState, at: number): void => {
    if (r.windowEnd !== null && at >= r.windowEnd) {
      r.byConsumer = zeroByConsumer()
      r.windowEnd = null
      r.lastUsed = null
      r.sincePoll = 0
    }
  }

  const bucketAt = (r: ResourceState, at: number): HistoryBucket => {
    const start = Math.floor(at / HISTORY_BUCKET_MS) * HISTORY_BUCKET_MS
    let b = r.history.get(start)
    if (!b) {
      b = { start, harnu: 0, throttled: 0, outside: 0 }
      r.history.set(start, b)
      const oldest = start - (HISTORY_BUCKETS - 1) * HISTORY_BUCKET_MS
      for (const k of r.history.keys()) if (k < oldest) r.history.delete(k)
    }
    return b
  }

  const setThrottle = (next: ThrottleStatus): boolean => {
    const changed = next.state !== throttle.state || next.resetAt !== throttle.resetAt
    throttle = next
    return changed
  }

  function record(consumer: GhConsumer, resource: GhResource): void {
    const at = now()
    const r = res[resource]
    rollWindow(r, at)
    r.byConsumer[consumer] += 1
    r.sincePoll += 1
    const b = bucketAt(r, at)
    if (throttle.state === 'normal') b.harnu += 1
    else b.throttled += 1
    r.stamps.push(at)
    const cutoff = at - PACE_WINDOW_MS
    while (r.stamps.length > 0 && (r.stamps[0] < cutoff || r.stamps.length > MAX_CALL_STAMPS)) {
      r.stamps.shift()
    }
  }

  function applyPoll(
    result: { ok: true; buckets: RateLimitBuckets } | { ok: false; reason: PollFailure }
  ): void {
    const at = now()
    if (!result.ok) {
      if (result.reason === 'error') return // transient: keep the last good picture
      const changed = status !== 'unavailable' || reason !== result.reason
      status = 'unavailable'
      reason = result.reason
      // No gh, or signed out: whoever signs in next may be someone else, so forget the login.
      login = null
      if (changed) emit()
      return
    }
    status = 'ok'
    reason = null
    sampledAt = at
    lastBuckets = result.buckets
    for (const resource of GH_RESOURCES) {
      const r = res[resource]
      const bucket = result.buckets[resource]
      const newEnd = bucket.reset * 1000
      if (r.windowEnd !== null && newEnd > r.windowEnd) {
        // GitHub opened a new window: counts, deltas and pace samples belong to the old one.
        r.byConsumer = zeroByConsumer()
        r.lastUsed = null
        r.sincePoll = 0
        r.samples = []
      }
      // `used` growth since the previous poll of this window, minus what we know we spent.
      const delta = r.lastUsed === null ? 0 : Math.max(0, bucket.used - r.lastUsed)
      if (delta > 0) bucketAt(r, at).outside += Math.max(0, delta - r.sincePoll)
      r.sincePoll = 0
      r.lastUsed = bucket.used
      r.windowEnd = newEnd
      r.bucket = bucket
      r.samples.push({ at, used: bucket.used })
      const cutoff = at - PACE_WINDOW_MS
      while (r.samples.length > 1 && r.samples[0].at < cutoff) r.samples.shift()
    }
    setThrottle(evaluateThrottle(throttle, result.buckets, prefs.threshold, at))
    // An empty bucket is the stronger fact: `exhausted` already pauses every throttled read.
    if (throttle.state === 'exhausted') clearPause()
    emit()
  }

  function setLogin(next: string | null): void {
    if (next === login) return
    login = next
    emit()
  }

  function clearPause(): void {
    secondaryUntil = null
    if (pauseTimer !== null) clearTimer(pauseTimer)
    pauseTimer = null
  }

  function markRateLimited(retryAfterMs?: number | null): void {
    const at = now()
    const wait = retryAfterMs && retryAfterMs > 0 ? retryAfterMs : SECONDARY_PAUSE_MS
    // Several failures in a row (calls already in flight) extend the pause, never shorten it.
    const until = Math.max(secondaryUntil ?? 0, at + Math.min(wait, SECONDARY_PAUSE_MAX_MS))
    const extended = until !== secondaryUntil
    secondaryUntil = until
    if (extended) {
      if (pauseTimer !== null) clearTimer(pauseTimer)
      pauseTimer = setTimer(() => tick(), until - at + 5)
      emit() // the pause started (or was extended)
    }
    for (const l of rateLimitListeners) {
      try {
        l()
      } catch {
        /* a listener must never break the tracker */
      }
    }
  }

  function tick(): void {
    const at = now()
    for (const resource of GH_RESOURCES) rollWindow(res[resource], at)
    const next = evaluateThrottle(throttle, null, prefs.threshold, at)
    let changed = false
    if (next !== throttle) {
      setThrottle(next)
      changed = true
    }
    if (secondaryUntil !== null && at >= secondaryUntil) {
      clearPause() // the pause ended
      changed = true
    }
    if (changed) emit()
  }

  function readsPaused(): boolean {
    if (throttle.state === 'exhausted' || secondaryUntil !== null) tick()
    return throttle.state === 'exhausted' || secondaryUntil !== null
  }

  function setPrefs(next: BudgetPrefs): void {
    prefs = next
    if (lastBuckets) setThrottle(evaluateThrottle(throttle, lastBuckets, prefs.threshold, now()))
    emit()
  }

  function viewOf(resource: GhResource, at: number): ResourceView | null {
    const r = res[resource]
    if (!r.bucket) return null
    const harnu = GH_CONSUMERS.reduce((n, c) => n + r.byConsumer[c], 0)
    const minutes = PACE_WINDOW_MS / 60_000
    const cutoff = at - PACE_WINDOW_MS
    const first = r.samples.find((s) => s.at >= cutoff) ?? r.samples[0]
    const last = r.samples[r.samples.length - 1]
    let callsPerMin: number | null = null
    if (first && last && last.at > first.at) {
      callsPerMin = Math.max(0, (last.used - first.used) / ((last.at - first.at) / 60_000))
    }
    const harnuCallsPerMin = r.stamps.filter((s) => s >= cutoff).length / minutes
    const history: HistoryBucket[] = []
    const startOfNow = Math.floor(at / HISTORY_BUCKET_MS) * HISTORY_BUCKET_MS
    for (let i = HISTORY_BUCKETS - 1; i >= 0; i--) {
      const start = startOfNow - i * HISTORY_BUCKET_MS
      history.push(r.history.get(start) ?? { start, harnu: 0, throttled: 0, outside: 0 })
    }
    return {
      bucket: r.bucket,
      byConsumer: { ...r.byConsumer },
      harnu,
      outside: Math.max(0, r.bucket.used - harnu),
      history,
      pace: {
        windowMinutes: minutes,
        callsPerMin,
        harnuCallsPerMin,
        minutesToEmpty:
          callsPerMin !== null && callsPerMin > 0 ? r.bucket.remaining / callsPerMin : null
      }
    }
  }

  function snapshot(): BudgetSnapshot {
    const at = now()
    const rest = viewOf('rest', at)
    const graphql = viewOf('graphql', at)
    return {
      status,
      reason,
      sampledAt,
      login,
      rest,
      graphql,
      tighter: rest && graphql ? tighterOf({ rest: rest.bucket, graphql: graphql.bucket }) : null,
      secondaryPauseUntil:
        secondaryUntil !== null && at < secondaryUntil
          ? new Date(secondaryUntil).toISOString()
          : null,
      throttle: {
        state: throttle.state,
        since: throttle.since,
        threshold: prefs.threshold,
        resetAt: throttle.resetAt
      },
      prefs
    }
  }

  return {
    record,
    applyPoll,
    markRateLimited,
    readsPaused,
    onRateLimit(listener) {
      rateLimitListeners.add(listener)
      return () => rateLimitListeners.delete(listener)
    },
    setLogin,
    tick,
    setPrefs,
    getPrefs: () => prefs,
    state: () => {
      // `exhausted` ends on the clock, not only on a poll: read it fresh.
      if (throttle.state === 'exhausted') tick()
      return throttle.state
    },
    snapshot,
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}

// ── What the throttle does to consumers ───────────────────────────────────────

/** Mission gate caches (`PR_CACHE_TTL_MS`, `mainCiCache`): 60 s normally, 5 min while `low`. */
export const GATE_CACHE_TTL_MS = 60_000
export const GATE_CACHE_TTL_LOW_MS = 5 * 60_000

/**
 * TTL of a mission gate cache entry. `Infinity` while `exhausted`: the last known value is served
 * until normal polling resumes after the reset (AC-6).
 */
export function gateCacheTtlMs(state: ThrottleState): number {
  if (state === 'exhausted') return Number.POSITIVE_INFINITY
  return state === 'low' ? GATE_CACHE_TTL_LOW_MS : GATE_CACHE_TTL_MS
}

/** Should PR Stack skip a BACKGROUND refresh right now? A load on open never asks. */
export function skipPrStackBackground(state: ThrottleState, prefs: BudgetPrefs): boolean {
  return state === 'exhausted' || (state === 'low' && prefs.pausePrStackWhenLow)
}
