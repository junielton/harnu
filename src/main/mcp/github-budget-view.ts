/**
 * T614 (T611 U3) — the `github_budget` payload an agent reads.
 *
 * A pure projection of the tracker's {@link BudgetSnapshot}: the same figures the footer pill shows,
 * with epoch times as ISO strings and the throttle `state` widened to `unavailable` when `gh` is
 * missing or not signed in (the call still succeeds). It reads, never decides: the throttle state,
 * the tighter bucket and the attribution all come from the tracker.
 */

import type { BudgetSnapshot, GhConsumer, ResourceView, ThrottleState } from '../github-budget-core'

export interface BudgetBucketView {
  limit: number
  remaining: number
  used: number
  /** ISO time the window resets. */
  resetAt: string
  /** GitHub's `used` growth over the last 10 minutes, per minute. */
  callsPerMin: number | null
  /** `remaining / callsPerMin`; `null` when nothing is being spent. */
  minutesToEmpty: number | null
}

export interface GithubBudgetPayload {
  ok: true
  /** The `gh` login. `null` while Harnu has not resolved it (or `gh` is missing or signed out). */
  login: string | null
  rest: BudgetBucketView | null
  graphql: BudgetBucketView | null
  tighter: 'rest' | 'graphql' | null
  throttle: {
    state: ThrottleState | 'unavailable'
    /** ISO time of the last state change. */
    since: string
    /** Percent remaining below which the budget reads `low`. */
    threshold: number
  }
  /** Why the budget is unavailable. Only present then. */
  reason?: 'missing' | 'unauthenticated' | 'error'
  /** Harnu's own calls in the tighter bucket's current window. */
  harnu: { byConsumer: Partial<Record<GhConsumer, number>> }
  /** What the tighter bucket spent that Harnu's calls do not explain (an estimate). */
  outside: number | null
  /** ISO time of the last good poll; `null` before the first. */
  sampledAt: string | null
}

const iso = (ms: number): string => new Date(ms).toISOString()

function bucketView(view: ResourceView | null): BudgetBucketView | null {
  if (!view) return null
  const { bucket, pace } = view
  return {
    limit: bucket.limit,
    remaining: bucket.remaining,
    used: bucket.used,
    resetAt: iso(bucket.reset * 1000),
    callsPerMin: pace.callsPerMin,
    minutesToEmpty: pace.minutesToEmpty
  }
}

export function githubBudgetPayload(snap: BudgetSnapshot): GithubBudgetPayload {
  const unavailable = snap.status === 'unavailable'
  // The tracker keeps the last known buckets while unavailable (the pill dims them); an agent gets none,
  // since stale figures would read as a live budget.
  const live = unavailable ? { rest: null, graphql: null, tighter: null } : snap
  const tighterView = live.tighter ? live[live.tighter] : null
  return {
    ok: true,
    login: snap.login,
    rest: bucketView(live.rest),
    graphql: bucketView(live.graphql),
    tighter: live.tighter,
    throttle: {
      state: unavailable ? 'unavailable' : snap.throttle.state,
      since: iso(snap.throttle.since),
      threshold: snap.throttle.threshold
    },
    ...(unavailable && snap.reason ? { reason: snap.reason } : {}),
    harnu: { byConsumer: tighterView ? { ...tighterView.byConsumer } : {} },
    outside: tighterView ? tighterView.outside : null,
    sampledAt: snap.sampledAt === null ? null : iso(snap.sampledAt)
  }
}
