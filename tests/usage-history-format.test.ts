import { describe, it, expect } from 'vitest'
import {
  barChartRects,
  niceMax,
  pctBarClass,
  pickSentenceStat,
  verdictTone,
  shortDay,
  fmtPct,
  fmtUnit,
  labelIndices,
  axisTickIndices,
  weeklyAxisTickIndices,
  axisTickIndicesForRange,
  labelIndicesForRange,
  latestValue,
  summarizeUsage,
  projectWindowPeak,
  FIVE_HOUR_MS,
  localDayKey,
  dayIndexForMs,
  resetMarkerIndices,
  rangeSinceMs,
  windowSeriesFor
} from '../src/renderer/src/components/usage-history-format'
import type { PlanFitResult, PlanFitWindowStat, DailyRollup, WindowRecord } from '../src/preload'

describe('barChartRects', () => {
  it('lays bars across the width and scales height to max', () => {
    const rects = barChartRects([50, 100], { width: 100, height: 40, max: 100, gap: 0 })
    expect(rects).toHaveLength(2)
    expect(rects[1].height).toBe(40) // 100/100 * 40
    expect(rects[0].height).toBe(20) // 50/100 * 40
    expect(rects[1].y).toBe(0)
    expect(rects[0].y).toBe(20)
  })

  it('treats null as a zero-height gap', () => {
    const rects = barChartRects([null, 100], { width: 100, height: 40, max: 100, gap: 0 })
    expect(rects[0].height).toBe(0)
  })

  it('clamps over-max values to the full height', () => {
    const rects = barChartRects([200], { width: 10, height: 40, max: 100, gap: 0 })
    expect(rects[0].height).toBe(40)
  })

  it('returns nothing for empty input or zero viewbox', () => {
    expect(barChartRects([], { width: 10, height: 10, max: 1 })).toEqual([])
    expect(barChartRects([1], { width: 0, height: 10, max: 1 })).toEqual([])
  })
})

describe('niceMax', () => {
  it('rounds up to a clean magnitude', () => {
    expect(niceMax([12, 47, 33])).toBe(50)
    expect(niceMax([3, 4])).toBe(4)
    expect(niceMax([120, 470])).toBe(500)
  })
  it('respects the floor for tiny data', () => {
    expect(niceMax([0, 0], 1)).toBe(1)
  })
})

describe('pctBarClass / verdictTone', () => {
  it('colors percentage bars by threshold — as SVG fill-* classes (bg-* does not paint rects)', () => {
    expect(pctBarClass(10)).toBe('fill-green')
    expect(pctBarClass(85)).toBe('fill-accent')
    expect(pctBarClass(97)).toBe('fill-red')
    expect(pctBarClass(null)).toBe('fill-surface-2')
  })
  it('maps verdicts to signal tones', () => {
    expect(verdictTone('comfortable')).toBe('text-green')
    expect(verdictTone('tight')).toBe('text-accent')
    expect(verdictTone('over')).toBe('text-red')
    expect(verdictTone('insufficient_data')).toBe('text-text-3')
  })
})

describe('pickSentenceStat', () => {
  function stat(over: Partial<PlanFitWindowStat>): PlanFitWindowStat {
    return {
      kind: 'fiveHour',
      count: 5,
      medianPct: 0,
      p95Pct: 0,
      maxPct: 0,
      projectedMedianPct: 0,
      projectedP95Pct: 0,
      projectedMaxPct: 0,
      exceedRate: 0,
      ...over
    }
  }
  function result(stats: PlanFitWindowStat[]): PlanFitResult {
    return { fromTier: 'max20', toTier: 'max5', ratio: 4, verdict: 'over', stats }
  }

  it('picks the stat with the highest exceedRate', () => {
    const s = pickSentenceStat(
      result([stat({ kind: 'sevenDay', exceedRate: 0.1 }), stat({ exceedRate: 0.4 })])
    )
    expect(s?.kind).toBe('fiveHour')
  })

  it('tie-breaks by projected p95', () => {
    const s = pickSentenceStat(
      result([stat({ projectedP95Pct: 50 }), stat({ kind: 'sevenDay', projectedP95Pct: 90 })])
    )
    expect(s?.kind).toBe('sevenDay')
  })

  it('prefers usable stats (>= 3 complete windows) over under-sampled ones', () => {
    const s = pickSentenceStat(
      result([stat({ kind: 'sevenDay', count: 2, exceedRate: 1 }), stat({ exceedRate: 0.1 })])
    )
    expect(s?.kind).toBe('fiveHour')
  })

  it('returns null for no result / no stats', () => {
    expect(pickSentenceStat(null)).toBeNull()
    expect(pickSentenceStat(result([]))).toBeNull()
  })
})

describe('shortDay / fmtPct', () => {
  it('shortens an ISO day to MM/DD', () => {
    expect(shortDay('2026-06-23')).toBe('06/23')
    expect(shortDay('garbage')).toBe('garbage')
  })
  it('rounds percentages and renders null as a dash', () => {
    expect(fmtPct(23.4)).toBe('23%')
    expect(fmtPct(null)).toBe('—')
  })
})

describe('fmtUnit', () => {
  it('formats by unit', () => {
    expect(fmtUnit(44.6, 'pct')).toBe('45%')
    expect(fmtUnit(16.3, 'usd')).toBe('$16.30')
    expect(fmtUnit(4.2, 'count')).toBe('4')
    expect(fmtUnit(null, 'usd')).toBe('—')
  })
})

describe('labelIndices', () => {
  it('labels the peak and the latest non-null bar', () => {
    expect(labelIndices([10, 40, 20, 15])).toEqual([1, 3])
  })
  it('collapses to one when peak is the latest', () => {
    expect(labelIndices([10, 20, 40])).toEqual([2])
  })
  it('ignores nulls and returns empty for all-null', () => {
    expect(labelIndices([null, 30, null])).toEqual([1])
    expect(labelIndices([null, null])).toEqual([])
  })
})

describe('axisTickIndices', () => {
  it('always includes first and last, evenly spread', () => {
    expect(axisTickIndices(14, 4)).toEqual([0, 4, 9, 13])
  })
  it('returns every index when there are fewer bars than ticks', () => {
    expect(axisTickIndices(3, 4)).toEqual([0, 1, 2])
    expect(axisTickIndices(0)).toEqual([])
  })
})

describe('weeklyAxisTickIndices', () => {
  it('steps every 7th index and always includes the last', () => {
    expect(weeklyAxisTickIndices(30)).toEqual([0, 7, 14, 21, 28, 29])
    expect(weeklyAxisTickIndices(7)).toEqual([0, 6])
    expect(weeklyAxisTickIndices(90)).toEqual([
      0, 7, 14, 21, 28, 35, 42, 49, 56, 63, 70, 77, 84, 89
    ])
  })
  it('is empty for n <= 0', () => {
    expect(weeklyAxisTickIndices(0)).toEqual([])
  })
})

describe('axisTickIndicesForRange', () => {
  it('7d labels every bar', () => {
    expect(axisTickIndicesForRange(7, '7d')).toEqual([0, 1, 2, 3, 4, 5, 6])
  })
  it('24h keeps the original 4-tick spread', () => {
    expect(axisTickIndicesForRange(24, '24h')).toEqual(axisTickIndices(24, 4))
  })
  it('30d/60d/90d/all use weekly-spaced ticks', () => {
    expect(axisTickIndicesForRange(30, '30d')).toEqual(weeklyAxisTickIndices(30))
    expect(axisTickIndicesForRange(60, '60d')).toEqual(weeklyAxisTickIndices(60))
    expect(axisTickIndicesForRange(90, '90d')).toEqual(weeklyAxisTickIndices(90))
    expect(axisTickIndicesForRange(45, 'all')).toEqual(weeklyAxisTickIndices(45))
  })
})

describe('labelIndicesForRange', () => {
  it('7d labels every non-null bar', () => {
    expect(labelIndicesForRange([10, null, 40, 15], '7d')).toEqual([0, 2, 3])
  })
  it('other ranges fall back to peak+latest', () => {
    expect(labelIndicesForRange([10, 40, 20, 15], '30d')).toEqual(labelIndices([10, 40, 20, 15]))
    expect(labelIndicesForRange([10, 40, 20, 15], '90d')).toEqual(labelIndices([10, 40, 20, 15]))
  })
})

describe('latestValue', () => {
  it('returns the last non-null value', () => {
    expect(latestValue([1, 2, null])).toBe(2)
    expect(latestValue([null, null])).toBeNull()
  })
})

describe('projectWindowPeak', () => {
  it('linearly extrapolates current pace to the reset', () => {
    // Half the 5h window elapsed at 30% → projects to 60% at reset.
    const resetsAt = 1_000_000_000
    const now = resetsAt - FIVE_HOUR_MS / 2
    expect(projectWindowPeak(30, resetsAt, now)).toBeCloseTo(60)
  })
  it('echoes the current value very early in the window (avoids explosion)', () => {
    const resetsAt = 1_000_000_000
    const now = resetsAt - FIVE_HOUR_MS * 0.98 // ~2% elapsed
    expect(projectWindowPeak(5, resetsAt, now)).toBe(5)
  })
  it('is null when the reset time is unknown', () => {
    expect(projectWindowPeak(50, null, 0)).toBeNull()
  })
})

describe('summarizeUsage', () => {
  const now = new Date(2026, 6, 3, 12, 0).getTime() // local noon, Jul 3 2026
  function roll(over: Partial<DailyRollup> & { day: string }): DailyRollup {
    return {
      sampleCount: 1,
      fiveHourPeak: null,
      sevenDayPeak: null,
      costPeakUsd: 0,
      sessionPeak: 0,
      weeklyReset: null,
      ...over
    }
  }
  function win(peakPct: number, closedAtMs: number, partial = false): WindowRecord {
    return { kind: 'fiveHour', resetsAtMs: 0, startedAtMs: 0, peakPct, partial, closedAtMs }
  }

  it('peaks the in-scope rollups and counts near-cap 5h windows', () => {
    const rollups = [
      roll({
        day: '2026-07-01',
        fiveHourPeak: 40,
        sevenDayPeak: 5,
        costPeakUsd: 12,
        sessionPeak: 3
      }),
      roll({
        day: '2026-07-03',
        fiveHourPeak: 67,
        sevenDayPeak: 6,
        costPeakUsd: 34,
        sessionPeak: 9
      })
    ]
    const windows = [
      win(96, now - 2 * 3600_000), // near cap, in scope → counts
      win(80, now - 3 * 3600_000), // below 95 → no
      win(99, now - 60 * 24 * 3600_000) // out of 30d scope → no
    ]
    const t = summarizeUsage(rollups, windows, now, 30)
    expect(t.peakFivePct).toBe(67)
    expect(t.peakSevenPct).toBe(6)
    expect(t.peakCostUsd).toBe(34)
    expect(t.peakSessions).toBe(9)
    expect(t.nearCapCount).toBe(1)
  })

  it('counts a partial window that already reached the cap (a real observation)', () => {
    const t = summarizeUsage([], [win(97, now - 3600_000, true)], now, 30)
    expect(t.nearCapCount).toBe(1)
  })

  it('returns null peaks with nothing in scope — never a fake 0', () => {
    const t = summarizeUsage([roll({ day: '2026-01-01', fiveHourPeak: 50 })], [], now, 30)
    expect(t.peakFivePct).toBeNull()
    expect(t.peakSessions).toBeNull()
    expect(t.nearCapCount).toBe(0)
  })
})

describe('localDayKey / dayIndexForMs (T47 P4.5)', () => {
  it('formats a local YYYY-MM-DD', () => {
    const ms = new Date(2026, 6, 8, 23, 30).getTime() // local Jul 8 2026, 23:30
    expect(localDayKey(ms)).toBe('2026-07-08')
  })
  it('finds the matching day index in an ascending day list', () => {
    const days = ['2026-07-06', '2026-07-07', '2026-07-08']
    const ms = new Date(2026, 6, 7, 9, 0).getTime()
    expect(dayIndexForMs(days, ms)).toBe(1)
  })
  it('returns null when the day is outside the list', () => {
    const days = ['2026-07-06', '2026-07-07']
    const ms = new Date(2026, 6, 20, 9, 0).getTime()
    expect(dayIndexForMs(days, ms)).toBeNull()
  })
})

describe('resetMarkerIndices', () => {
  function win(kind: WindowRecord['kind'], resetsAtMs: number, partial = false): WindowRecord {
    return { kind, resetsAtMs, startedAtMs: 0, peakPct: 50, partial, closedAtMs: resetsAtMs }
  }

  it('maps a sevenDay window close to its day bar, filtering out other kinds', () => {
    const days = ['2026-07-06', '2026-07-07', '2026-07-08']
    const resetsAt = new Date(2026, 6, 7, 14, 0).getTime()
    const windows = [
      win('sevenDay', resetsAt),
      win('fiveHour', new Date(2026, 6, 7, 15, 0).getTime()) // wrong kind, ignored
    ]
    expect(resetMarkerIndices(windows, 'sevenDay', days)).toEqual([1])
  })

  it('dedupes multiple closes landing on the same day and sorts the result', () => {
    const days = ['2026-07-06', '2026-07-07', '2026-07-08']
    const windows = [
      win('sevenDay', new Date(2026, 6, 8, 1, 0).getTime()),
      win('sevenDay', new Date(2026, 6, 8, 20, 0).getTime()),
      win('sevenDay', new Date(2026, 6, 6, 10, 0).getTime())
    ]
    expect(resetMarkerIndices(windows, 'sevenDay', days)).toEqual([0, 2])
  })

  it('drops a close whose day is out of the visible range', () => {
    const days = ['2026-07-07', '2026-07-08']
    const windows = [win('sevenDay', new Date(2026, 5, 1).getTime())]
    expect(resetMarkerIndices(windows, 'sevenDay', days)).toEqual([])
  })
})

describe('rangeSinceMs', () => {
  const now = new Date(2026, 6, 8, 12, 0).getTime()
  it('maps each range to its day count in ms', () => {
    expect(rangeSinceMs('24h', now)).toBe(now - 24 * 3600_000)
    expect(rangeSinceMs('7d', now)).toBe(now - 7 * 24 * 3600_000)
    expect(rangeSinceMs('30d', now)).toBe(now - 30 * 24 * 3600_000)
    expect(rangeSinceMs('60d', now)).toBe(now - 60 * 24 * 3600_000)
    expect(rangeSinceMs('90d', now)).toBe(now - 90 * 24 * 3600_000)
  })
  it('"all" has no lower bound', () => {
    expect(rangeSinceMs('all', now)).toBe(-Infinity)
  })
})

describe('windowSeriesFor', () => {
  function win(over: Partial<WindowRecord> & { startedAtMs: number }): WindowRecord {
    return {
      kind: 'fiveHour',
      resetsAtMs: over.startedAtMs + FIVE_HOUR_MS,
      peakPct: 50,
      partial: false,
      closedAtMs: over.startedAtMs + FIVE_HOUR_MS,
      ...over
    }
  }

  it('filters by kind and the [sinceMs, nowMs] range, sorted chronologically', () => {
    const now = 1_000_000_000
    const windows = [
      win({ startedAtMs: now - 10 * FIVE_HOUR_MS, peakPct: 30 }), // out of range
      win({ startedAtMs: now - 3 * FIVE_HOUR_MS, peakPct: 95 }),
      win({ startedAtMs: now - 5 * FIVE_HOUR_MS, peakPct: 40 }),
      win({ startedAtMs: now - FIVE_HOUR_MS, peakPct: 20, kind: 'sevenDay' }) // wrong kind
    ]
    const since = now - 6 * FIVE_HOUR_MS
    const points = windowSeriesFor(windows, 'fiveHour', since, now)
    expect(points.map((p) => p.value)).toEqual([40, 95])
  })

  it('passes the partial flag through untouched', () => {
    const now = 1_000_000_000
    const windows = [win({ startedAtMs: now - FIVE_HOUR_MS, peakPct: 97, partial: true })]
    const points = windowSeriesFor(windows, 'fiveHour', now - 2 * FIVE_HOUR_MS, now)
    expect(points).toHaveLength(1)
    expect(points[0].partial).toBe(true)
    expect(points[0].value).toBe(97)
  })

  it('returns an empty series with nothing in range', () => {
    expect(windowSeriesFor([], 'fiveHour', 0, 1000)).toEqual([])
  })
})
