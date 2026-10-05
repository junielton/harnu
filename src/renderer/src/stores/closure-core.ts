import type { TaskState } from '../../../preload'

/**
 * Pure closure-axis logic (T37). The closure axis is ORTHOGONAL to `taskState`:
 * `taskState` answers "what is Claude doing?"; closure answers "have YOU closed
 * the loop — seen this session's current resting state?". A session is
 * `awaiting-return` (forgotten) when it needs you AND you haven't looked at it in
 * a while. Mirrors `attention.ts` / `session-sort.ts`: no Pinia / electron / DOM,
 * so it's unit-tested in isolation (`tests/closure.test.ts`). The store injects
 * the clock, threshold, and `lastViewedAt`/`isArchived` lookups.
 *
 * Slice 1 = flavor A only (needs-input ∧ away). Flavor B ("finished while you
 * were away") + a Haiku-on-Stop closure judgment are deferred (T37 slice 2).
 */

/** The minimal slice the closure logic inspects. */
export interface ClosureSession {
  sessionId: string
  taskState?: TaskState
}

/** Everything the pure predicate needs, injected by the store (keeps it pure). */
export interface ClosureCtx {
  /** Current epoch ms. */
  nowMs: number
  /** How long a needs-input session must go unviewed to count as forgotten. */
  thresholdMs: number
  /** The session you're currently looking at (never nagged). */
  selectedId: string | null
  /** Effective last-view time for a session (stored, or the boot time for unseen ones). */
  lastViewedAt: (id: string) => number
  /** Whether the session is archived (excluded). */
  isArchived: (id: string) => boolean
}

/** Default "forgotten" threshold: 10 minutes unviewed while blocked on you. */
export const FORGOTTEN_THRESHOLD_MS = 10 * 60_000

/**
 * A session is `awaiting-return` (forgotten) when it is blocked on you
 * (`needs-input`), is NOT the one you're viewing, is not archived, and you last
 * looked at it at least `thresholdMs` ago. Pure.
 */
export function isAwaitingReturn(s: ClosureSession, ctx: ClosureCtx): boolean {
  if (s.taskState !== 'needs-input') return false
  if (s.sessionId === ctx.selectedId) return false
  if (ctx.isArchived(s.sessionId)) return false
  return ctx.nowMs - ctx.lastViewedAt(s.sessionId) >= ctx.thresholdMs
}

/** The forgotten sessions (those `awaiting-return`) — the "return here" set. */
export function selectForgotten<T extends ClosureSession>(all: readonly T[], ctx: ClosureCtx): T[] {
  return all.filter((s) => isAwaitingReturn(s, ctx))
}
