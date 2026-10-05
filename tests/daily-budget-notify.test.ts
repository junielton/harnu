import { describe, it, expect } from 'vitest'
import {
  isBudgetNotifyMark,
  shouldNotifyDailyBudget
} from '../src/renderer/src/stores/daily-budget-notify'
import type { DailyBudget } from '../src/renderer/src/components/daily-budget'

function budget(state: DailyBudget['state'], spentPct: number, budgetPct = 17): DailyBudget {
  return { state, spentPct, budgetPct, workingDaysLeft: 4, rebalancedPct: null, remainingDays: 3 }
}

describe('shouldNotifyDailyBudget', () => {
  it('fires at 80% of the budget', () => {
    expect(shouldNotifyDailyBudget(budget('near-limit', 14), 'd1', null)).toBe(80)
  })

  it('fires at 100% of the budget', () => {
    expect(shouldNotifyDailyBudget(budget('over', 18), 'd1', null)).toBe(100)
  })

  it('does not fire twice for the same threshold on the same day', () => {
    expect(
      shouldNotifyDailyBudget(budget('near-limit', 14), 'd1', { day: 'd1', threshold: 80 })
    ).toBeNull()
  })

  it('does not fire again at 80 once 100 has already fired today', () => {
    expect(
      shouldNotifyDailyBudget(budget('near-limit', 14), 'd1', { day: 'd1', threshold: 100 })
    ).toBeNull()
  })

  it('still escalates from 80 to 100 on the same day', () => {
    expect(shouldNotifyDailyBudget(budget('over', 18), 'd1', { day: 'd1', threshold: 80 })).toBe(
      100
    )
  })

  it('does not fire twice for the same threshold on the same day (over)', () => {
    expect(
      shouldNotifyDailyBudget(budget('over', 18), 'd1', { day: 'd1', threshold: 100 })
    ).toBeNull()
  })

  it('never fires below 80%', () => {
    expect(shouldNotifyDailyBudget(budget('on-track', 9), 'd1', null)).toBeNull()
  })

  it('re-arms on a new day', () => {
    expect(
      shouldNotifyDailyBudget(budget('near-limit', 14), 'd2', { day: 'd1', threshold: 100 })
    ).toBe(80)
  })

  it('re-arms at 100 on a new day too', () => {
    expect(shouldNotifyDailyBudget(budget('over', 18), 'd2', { day: 'd1', threshold: 100 })).toBe(
      100
    )
  })

  it('never fires on a day off or when unavailable', () => {
    expect(shouldNotifyDailyBudget(budget('day-off', 40), 'd1', null)).toBeNull()
    expect(shouldNotifyDailyBudget(budget('unavailable', 40), 'd1', null)).toBeNull()
  })

  it('never fires without a real budget to be a share of', () => {
    expect(shouldNotifyDailyBudget(budget('near-limit', 14, 0), 'd1', null)).toBeNull()
    expect(shouldNotifyDailyBudget(budget('over', 14, -1), 'd1', null)).toBeNull()
  })
})

describe('isBudgetNotifyMark', () => {
  it('accepts a well-formed mark and an absent one', () => {
    expect(isBudgetNotifyMark({ day: 'd1', threshold: 80 })).toBe(true)
    expect(isBudgetNotifyMark({ day: 'd1', threshold: 100 })).toBe(true)
    expect(isBudgetNotifyMark(null)).toBe(true)
  })

  it('rejects a corrupt mark so a bad entry cannot suppress the alert forever', () => {
    expect(isBudgetNotifyMark({ day: 'd1', threshold: 90 })).toBe(false)
    expect(isBudgetNotifyMark({ day: 1, threshold: 80 })).toBe(false)
    expect(isBudgetNotifyMark({ threshold: 80 })).toBe(false)
    expect(isBudgetNotifyMark('nope')).toBe(false)
    expect(isBudgetNotifyMark(undefined)).toBe(false)
  })
})
