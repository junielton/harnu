/**
 * T611 U2 — when the GitHub budget speaks up (spec U2 AC-4, mockup D "Tell me when it happens").
 *
 * Pure decision, no I/O: given the previous and the next snapshot and what was already announced,
 * say whether to raise a toast (entering `low`), an OS notification (reaching `exhausted`), or
 * nothing. Both fire **once per window**: GitHub's budget resets on the hour, and a poll that flips
 * `low` ↔ `normal` around the threshold must not toast every minute.
 */

import { readyBudget, type BudgetSnapshot, type ThrottleState } from './github-budget-view'

export interface NoticeMemory {
  /** Window (the tighter bucket's reset, epoch s) whose `low` was already announced. */
  lowWindow: number | null
  /** Window whose `exhausted` was already announced. */
  exhaustedWindow: number | null
}

export function freshNoticeMemory(): NoticeMemory {
  return { lowWindow: null, exhaustedWindow: null }
}

export type Notice = { kind: 'low' | 'exhausted'; window: number } | null

/** The window an event belongs to: the tighter bucket's reset time, in epoch seconds. */
export function windowOf(snap: BudgetSnapshot): number | null {
  const ready = readyBudget(snap)
  return ready ? ready.tighterView.bucket.reset : null
}

/**
 * `prev` is the throttle state the renderer last saw (`null` before the first snapshot: the first
 * read only seeds, so opening the app while already low is not "entering" it).
 */
export function decideNotice(
  prev: ThrottleState | null,
  next: BudgetSnapshot,
  memory: NoticeMemory
): Notice {
  if (prev === null || !next.prefs.notify) return null
  const window = windowOf(next)
  if (window === null) return null
  const state = next.throttle.state
  if (state === 'low' && prev === 'normal' && memory.lowWindow !== window) {
    return { kind: 'low', window }
  }
  if (state === 'exhausted' && prev !== 'exhausted' && memory.exhaustedWindow !== window) {
    return { kind: 'exhausted', window }
  }
  return null
}

export function remember(memory: NoticeMemory, notice: NonNullable<Notice>): NoticeMemory {
  return notice.kind === 'low'
    ? { ...memory, lowWindow: notice.window }
    : { ...memory, exhaustedWindow: notice.window }
}
