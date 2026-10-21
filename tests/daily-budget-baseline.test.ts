import { describe, it, expect } from 'vitest'
import { pickBaseline } from '../src/main/usage-history-core'
import type { DailyRollup } from '../src/main/usage-history-core'
import { computeDailyBudget } from '../src/renderer/src/components/daily-budget'

function rollup(day: string, sevenDayPeak: number | null, reset = false, postPct = 3): DailyRollup {
  return {
    day,
    sampleCount: 1,
    fiveHourPeak: null,
    sevenDayPeak,
    costPeakUsd: 0,
    sessionPeak: 0,
    weeklyReset: reset ? { atMs: 0, prePct: 90, postPct } : null
  }
}

describe('pickBaseline', () => {
  it("uses the previous day's 7d peak — a 7d window is monotonic, so it is the value at midnight", () => {
    const rollups = [rollup('2026-08-22', 20), rollup('2026-08-23', 32), rollup('2026-08-24', 36)]
    expect(pickBaseline(rollups, '2026-08-24')).toBe(32)
  })

  it('skips gaps and uses the most recent prior day', () => {
    const rollups = [rollup('2026-08-20', 41), rollup('2026-08-24', 46)]
    expect(pickBaseline(rollups, '2026-08-24')).toBe(41)
  })

  it('is 0 when the weekly window reset earlier today', () => {
    const rollups = [rollup('2026-08-23', 88), rollup('2026-08-24', 12, true)]
    expect(pickBaseline(rollups, '2026-08-24')).toBe(0)
  })

  it('is null when there is no prior day at all', () => {
    expect(pickBaseline([rollup('2026-08-24', 12)], '2026-08-24')).toBeNull()
  })

  it('is null when the prior day never reported a 7d figure', () => {
    const rollups = [rollup('2026-08-23', null), rollup('2026-08-24', 12)]
    expect(pickBaseline(rollups, '2026-08-24')).toBeNull()
  })

  it('is null on an empty history', () => {
    expect(pickBaseline([], '2026-08-24')).toBeNull()
  })

  it('ignores days after the requested one', () => {
    const rollups = [rollup('2026-08-23', 32), rollup('2026-08-24', 36), rollup('2026-08-25', 51)]
    expect(pickBaseline(rollups, '2026-08-24')).toBe(32)
  })

  describe('weekly reset on the previous day (BUG-204)', () => {
    // Real data, 2026-10-20: the window reset Mon 19 16:00 local. Oct 19 samples
    // run 47 → 53 (old window) → 12 (new window), so the day's peak is the OLD
    // window's 53 while the 7d% at midnight of Oct 20 is the new window's 12.
    const rollups = [
      rollup('2026-10-18', 47),
      rollup('2026-10-19', 53, true, 12),
      rollup('2026-10-20', 16)
    ]

    it("uses the prior day's post-reset figure, not its pre-reset peak", () => {
      expect(pickBaseline(rollups, '2026-10-20')).toBe(12)
    })

    it('feeds the daily budget: 4 spent of a ~14.67 allowance', () => {
      // Tue 2026-10-20 noon; 7d window resets Mon 2026-10-26 16:00 local, so the
      // Mon–Sat working days left are Tue, Wed, Thu, Fri, Sat and Mon = 6.
      const nowMs = new Date(2026, 9, 20, 12, 0).getTime()
      const resetsAtMs = new Date(2026, 9, 26, 16, 0).getTime()
      const budget = computeDailyBudget({
        sevenDayPct: 16,
        resetsAtMs,
        baselinePct: pickBaseline(rollups, '2026-10-20'),
        workingDays: [1, 2, 3, 4, 5, 6],
        nowMs
      })
      expect(budget.spentPct).toBe(4)
      expect(budget.budgetPct).toBeCloseTo(88 / 6, 5)
      expect(budget.workingDaysLeft).toBe(6)
      expect(budget.state).toBe('on-track')
    })
  })
})
