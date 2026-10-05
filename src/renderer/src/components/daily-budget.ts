/**
 * Pure daily-budget math for the Plan usage panel (daily-budget spec).
 *
 * Splits what is left of the weekly (7d) allowance across the working days
 * that remain before it resets. The budget FREEZES at the start of the day:
 * the denominator is fixed for the whole day, so the bar can actually reach
 * 100% and "over" exists as a state. Were it recomputed on every spend, the
 * allowance would grow as the day went on and an overrun could never happen.
 *
 * No Vue, no i18n, no store access — the store wires real data to it.
 */

export type DailyBudgetState = 'on-track' | 'near-limit' | 'over' | 'day-off' | 'unavailable'

export interface DailyBudget {
  state: DailyBudgetState
  /** Points of the 7d allowance spent since the day began. */
  spentPct: number
  /** Today's frozen allowance in points; 0 when day-off or unavailable. */
  budgetPct: number
  /** Working days from today (inclusive) to the reset. */
  workingDaysLeft: number
  /** Per-day allowance the days AFTER today inherit — only set when `over`. */
  rebalancedPct: number | null
  /** Working days after today — the count the damage line quotes. */
  remainingDays: number
}

export interface DailyBudgetInput {
  /** Live account-wide 7d usage, or null when no window is known. */
  sevenDayPct: number | null
  /** When the 7d window resets, or null when unknown. */
  resetsAtMs: number | null
  /** 7d usage at the moment today began, or null when there's no history. */
  baselinePct: number | null
  /** Working weekdays, `0` = Sunday … `6` = Saturday. */
  workingDays: readonly number[]
  nowMs: number
}

/** Spend is at or above this share of the budget → `near-limit`. */
export const NEAR_LIMIT_RATIO = 0.8

const UNAVAILABLE: DailyBudget = {
  state: 'unavailable',
  spentPct: 0,
  budgetPct: 0,
  workingDaysLeft: 0,
  rebalancedPct: null,
  remainingDays: 0
}

/**
 * Working days whose LOCAL start falls in `[fromMs's day, untilMs)`. The day
 * containing `fromMs` counts (you can still spend the rest of it), and so does
 * the reset day itself — the old window is spendable right up to the reset, and
 * counting it makes the per-day budget smaller, which errs toward caution.
 *
 * A 7d window spans at most 8 local days; the walk is capped at 10 so a bad
 * `untilMs` can never spin.
 */
export function countWorkingDays(
  fromMs: number,
  untilMs: number,
  workingDays: readonly number[]
): number {
  if (untilMs <= fromMs) return 0
  const set = new Set(workingDays)
  const cursor = new Date(fromMs)
  cursor.setHours(0, 0, 0, 0)
  let count = 0
  for (let i = 0; i < 10 && cursor.getTime() < untilMs; i++) {
    if (set.has(cursor.getDay())) count++
    cursor.setDate(cursor.getDate() + 1)
  }
  return count
}

export function computeDailyBudget(input: DailyBudgetInput): DailyBudget {
  const { sevenDayPct, resetsAtMs, baselinePct, workingDays, nowMs } = input
  if (sevenDayPct === null || resetsAtMs === null || baselinePct === null) return UNAVAILABLE

  // A stale poll or clock skew can report less than the baseline; never negative.
  const spentPct = Math.max(0, sevenDayPct - baselinePct)
  const workingDaysLeft = countWorkingDays(nowMs, resetsAtMs, workingDays)

  // Order matters: no working day left anywhere in the window (every weekday
  // unchecked, or the reset already behind us) means the feature is simply off,
  // NOT that today happens to be a day off. `day-off` only makes sense while
  // there are still other days carrying the allowance.
  if (workingDaysLeft === 0) return UNAVAILABLE

  if (!new Set(workingDays).has(new Date(nowMs).getDay())) {
    return {
      state: 'day-off',
      spentPct,
      budgetPct: 0,
      workingDaysLeft,
      rebalancedPct: null,
      remainingDays: 0
    }
  }

  const budgetPct = Math.max(0, (100 - baselinePct) / workingDaysLeft)
  const remainingDays = workingDaysLeft - 1

  // Allowance already exhausted before the day started: over, but there is no
  // meaningful per-day figure left to quote.
  if (budgetPct === 0) {
    return {
      state: 'over',
      spentPct,
      budgetPct,
      workingDaysLeft,
      rebalancedPct: null,
      remainingDays
    }
  }

  const ratio = spentPct / budgetPct
  if (ratio < NEAR_LIMIT_RATIO) {
    return {
      state: 'on-track',
      spentPct,
      budgetPct,
      workingDaysLeft,
      rebalancedPct: null,
      remainingDays
    }
  }
  if (ratio < 1) {
    return {
      state: 'near-limit',
      spentPct,
      budgetPct,
      workingDaysLeft,
      rebalancedPct: null,
      remainingDays
    }
  }
  return {
    state: 'over',
    spentPct,
    budgetPct,
    workingDaysLeft,
    rebalancedPct: remainingDays > 0 ? Math.max(0, (100 - sevenDayPct) / remainingDays) : null,
    remainingDays
  }
}

/**
 * Toggle one weekday in the working set, kept sorted so the persisted value is
 * stable regardless of click order. Clearing every day is allowed: it turns the
 * daily budget off rather than being an error state.
 */
export function toggleWorkingDay(days: readonly number[], day: number): number[] {
  const next = days.includes(day) ? days.filter((d) => d !== day) : [...days, day]
  return [...next].sort((a, b) => a - b)
}
