import { describe, it, expect } from 'vitest'
import { pickBaseline } from '../src/main/usage-history-core'
import type { DailyRollup } from '../src/main/usage-history-core'

function rollup(day: string, sevenDayPeak: number | null, reset = false): DailyRollup {
  return {
    day,
    sampleCount: 1,
    fiveHourPeak: null,
    sevenDayPeak,
    costPeakUsd: 0,
    sessionPeak: 0,
    weeklyReset: reset ? { atMs: 0, prePct: 90, postPct: 3 } : null
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
})
