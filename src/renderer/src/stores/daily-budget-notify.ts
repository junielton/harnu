import type { DailyBudget } from '../components/daily-budget'

/**
 * Pure threshold detection for the daily-budget alert (daily-budget spec), the
 * same shape as `usage-reset-notify.ts`: the truth table lives here, the store
 * only wires real data to it. No Vue, no i18n, no store access.
 *
 * Fires at most twice a day — once crossing 80% of the day's budget (still
 * correctable) and once crossing 100% (the overrun). The caller persists the
 * returned threshold against the day key so an app restart mid-day cannot
 * refire, while a new day re-arms both steps.
 */

/** The two points of the day's budget worth interrupting the user for. */
export type BudgetThreshold = 80 | 100

/** The highest threshold already notified, and the local day it belongs to. */
export interface BudgetNotifyMark {
  day: string
  threshold: BudgetThreshold
}

/**
 * @param budget Today's budget as computed by `computeDailyBudget`.
 * @param dayKey The local day the budget belongs to (`useDailyBudgetStore().dayKey`).
 *   It is what re-arms both steps: a mark from another day never suppresses.
 * @param last The highest threshold already notified, or null if none yet.
 * @returns The threshold to notify for, or null to stay quiet.
 */
export function shouldNotifyDailyBudget(
  budget: DailyBudget,
  dayKey: string,
  last: BudgetNotifyMark | null
): BudgetThreshold | null {
  // `on-track` is below 80% by construction; `day-off` and `unavailable` have
  // no budget to be a share of, so neither can be crossed.
  if (budget.state !== 'near-limit' && budget.state !== 'over') return null
  // A zero (or nonsensical) allowance means "any spend is already over" — not a
  // threshold the user can act on, so it never interrupts.
  if (budget.budgetPct <= 0) return null
  const reached: BudgetThreshold = budget.state === 'over' ? 100 : 80
  // Monotonic within a day: 80 → 100 still escalates, but never the reverse
  // (a late poll that dips back under 100% must not re-fire the 80% alert).
  const alreadyOnThisDay = last && last.day === dayKey ? last.threshold : 0
  return reached > alreadyOnThisDay ? reached : null
}

/**
 * Shape guard for a persisted {@link BudgetNotifyMark}. A corrupt or
 * hand-edited entry must degrade to "never notified" rather than suppress the
 * alert forever, so the caller validates what it reads back from storage.
 */
export function isBudgetNotifyMark(v: unknown): v is BudgetNotifyMark | null {
  if (v === null) return true
  if (!v || typeof v !== 'object') return false
  const m = v as Record<string, unknown>
  return typeof m.day === 'string' && (m.threshold === 80 || m.threshold === 100)
}
