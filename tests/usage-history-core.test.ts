import { describe, it, expect } from 'vitest'
import {
  decideHistoryWrites,
  reconcileWindowsOnBoot,
  buildRollups,
  buildHeatmap,
  projectPlanFit,
  recommendTier,
  percentile,
  emptyHistoryState,
  utcDayKey,
  localDayKey,
  SAMPLE_MIN_INTERVAL_MS,
  WINDOW_DURATION_MS,
  type HistoryState,
  type LiveReading,
  type UsageSample,
  type WindowRecord
} from '../src/main/usage-history-core'
import { PLAN_TIERS } from '../src/main/plan-tiers'

const HOUR = 3600_000

function reading(over: Partial<LiveReading> = {}): LiveReading {
  return {
    costUsd: 0,
    sessionCount: 1,
    fiveHour: null,
    sevenDay: null,
    ...over
  }
}

describe('decideHistoryWrites — sampling cadence', () => {
  it('writes the first sample unconditionally', () => {
    const r = decideHistoryWrites(emptyHistoryState(), reading({ costUsd: 1.5 }), 1000)
    expect(r.sample).not.toBeNull()
    expect(r.sample?.costUsd).toBe(1.5)
    expect(r.next.lastSampleAtMs).toBe(1000)
  })

  it('suppresses a sample inside the min interval with no meaningful delta', () => {
    const now = 10 * HOUR
    const first = decideHistoryWrites(
      emptyHistoryState(),
      reading({ fiveHour: { usedPercent: 10, resetsAtMs: now + HOUR } }),
      now
    )
    const soon = now + 60_000 // 1 min later, same %
    const second = decideHistoryWrites(
      first.next,
      reading({ fiveHour: { usedPercent: 10.5, resetsAtMs: now + HOUR } }),
      soon
    )
    expect(second.sample).toBeNull()
    expect(second.next.lastSampleAtMs).toBe(first.next.lastSampleAtMs)
  })

  it('writes after the min interval elapses', () => {
    const now = 10 * HOUR
    const first = decideHistoryWrites(emptyHistoryState(), reading(), now)
    const later = now + SAMPLE_MIN_INTERVAL_MS + 1
    const second = decideHistoryWrites(first.next, reading(), later)
    expect(second.sample).not.toBeNull()
    expect(second.next.lastSampleAtMs).toBe(later)
  })

  it('forces an off-cadence sample on a >=2pp move', () => {
    const now = 10 * HOUR
    const win = now + HOUR
    const first = decideHistoryWrites(
      emptyHistoryState(),
      reading({ fiveHour: { usedPercent: 10, resetsAtMs: win } }),
      now
    )
    const soon = now + 30_000
    const jump = decideHistoryWrites(
      first.next,
      reading({ fiveHour: { usedPercent: 13, resetsAtMs: win } }),
      soon
    )
    expect(jump.sample).not.toBeNull()
    expect(jump.sample?.fiveHourPct).toBe(13)
  })

  it('preserves null rate-limit percentages as null (never a fake 0)', () => {
    const r = decideHistoryWrites(emptyHistoryState(), reading(), 1000)
    expect(r.sample?.fiveHourPct).toBeNull()
    expect(r.sample?.sevenDayPct).toBeNull()
  })
})

describe('decideHistoryWrites — window rollover', () => {
  it('tracks the running peak within a window without closing it', () => {
    const win = 100 * HOUR
    let st: HistoryState = emptyHistoryState()
    st = decideHistoryWrites(
      st,
      reading({ fiveHour: { usedPercent: 12, resetsAtMs: win } }),
      win - HOUR
    ).next
    const r = decideHistoryWrites(
      st,
      reading({ fiveHour: { usedPercent: 17, resetsAtMs: win } }),
      win - 30 * 60_000
    )
    expect(r.windows.length).toBe(0)
    expect(r.next.fiveHour?.peakPct).toBe(17)
  })

  it('emits a WindowRecord with the peak when resets_at changes', () => {
    const win1 = 100 * HOUR
    const win2 = win1 + 5 * HOUR
    let st = emptyHistoryState()
    // Observe from near the window start so it counts as complete.
    const start = win1 - WINDOW_DURATION_MS.fiveHour + 60_000
    st = decideHistoryWrites(
      st,
      reading({ fiveHour: { usedPercent: 5, resetsAtMs: win1 } }),
      start
    ).next
    st = decideHistoryWrites(
      st,
      reading({ fiveHour: { usedPercent: 22, resetsAtMs: win1 } }),
      start + HOUR
    ).next
    const rollover = decideHistoryWrites(
      st,
      reading({ fiveHour: { usedPercent: 3, resetsAtMs: win2 } }),
      win1 + 60_000
    )
    expect(rollover.windows.length).toBe(1)
    expect(rollover.windows[0].kind).toBe('fiveHour')
    expect(rollover.windows[0].peakPct).toBe(22)
    expect(rollover.windows[0].partial).toBe(false)
    // A rollover always forces a sample.
    expect(rollover.sample).not.toBeNull()
    expect(rollover.next.fiveHour?.resetsAtMs).toBe(win2)
  })

  it('flags a window joined mid-flight as partial', () => {
    const win = 100 * HOUR
    // First observe it well after its start → partial.
    const lateStart = win - HOUR // only 1h before reset, way past the 15min grace
    const r = decideHistoryWrites(
      emptyHistoryState(),
      reading({ fiveHour: { usedPercent: 40, resetsAtMs: win } }),
      lateStart
    )
    expect(r.next.fiveHour?.partial).toBe(true)
  })
})

describe('reconcileWindowsOnBoot', () => {
  it('carries persisted progress forward when no reading is available yet', () => {
    const persisted: HistoryState = {
      ...emptyHistoryState(),
      fiveHour: { resetsAtMs: 100 * HOUR, startedAtMs: 95 * HOUR, peakPct: 10, partial: false }
    }
    const r = reconcileWindowsOnBoot(persisted, null, 96 * HOUR)
    expect(r.windows).toEqual([])
    expect(r.next.fiveHour?.resetsAtMs).toBe(100 * HOUR)
  })

  it('closes a window that rolled over while the app was shut, flagged partial', () => {
    const persisted: HistoryState = {
      ...emptyHistoryState(),
      fiveHour: { resetsAtMs: 100 * HOUR, startedAtMs: 95 * HOUR, peakPct: 18, partial: false }
    }
    const now = 110 * HOUR
    const newWin = now + 2 * HOUR
    const r = reconcileWindowsOnBoot(
      persisted,
      reading({ fiveHour: { usedPercent: 4, resetsAtMs: newWin } }),
      now
    )
    expect(r.windows.length).toBe(1)
    expect(r.windows[0].peakPct).toBe(18)
    expect(r.windows[0].partial).toBe(true)
    expect(r.next.fiveHour?.resetsAtMs).toBe(newWin)
  })

  it('marks a still-open window partial because downtime fell inside it', () => {
    const win = 100 * HOUR
    const persisted: HistoryState = {
      ...emptyHistoryState(),
      fiveHour: {
        resetsAtMs: win,
        startedAtMs: win - WINDOW_DURATION_MS.fiveHour,
        peakPct: 12,
        partial: false
      }
    }
    const r = reconcileWindowsOnBoot(
      persisted,
      reading({ fiveHour: { usedPercent: 20, resetsAtMs: win } }),
      win - HOUR
    )
    expect(r.windows).toEqual([])
    expect(r.next.fiveHour?.partial).toBe(true)
    expect(r.next.fiveHour?.peakPct).toBe(20)
  })
})

describe('buildRollups', () => {
  // Tests inject `utcDayKey` so day boundaries stay machine-TZ-independent;
  // production defaults to `localDayKey` (asserted separately below).
  it('groups samples into per-day peaks, sorted ascending', () => {
    const d1 = Date.UTC(2026, 5, 1, 8)
    const d1b = Date.UTC(2026, 5, 1, 20)
    const d2 = Date.UTC(2026, 5, 2, 9)
    const samples: UsageSample[] = [
      { t: d2, costUsd: 5, sessionCount: 2, fiveHourPct: 30, sevenDayPct: 50 },
      { t: d1, costUsd: 1, sessionCount: 1, fiveHourPct: 10, sevenDayPct: 40 },
      { t: d1b, costUsd: 3, sessionCount: 3, fiveHourPct: 25, sevenDayPct: 45 }
    ]
    const r = buildRollups(samples, utcDayKey)
    expect(r.map((x) => x.day)).toEqual(['2026-06-01', '2026-06-02'])
    expect(r[0].fiveHourPeak).toBe(25)
    expect(r[0].costPeakUsd).toBe(3)
    expect(r[0].sessionPeak).toBe(3)
    expect(r[0].sampleCount).toBe(2)
    expect(r[1].sevenDayPeak).toBe(50)
  })

  it('keeps a day-peak null when no sample reported that metric', () => {
    const samples: UsageSample[] = [
      { t: Date.UTC(2026, 5, 1), costUsd: 0, sessionCount: 0, fiveHourPct: null, sevenDayPct: null }
    ]
    expect(buildRollups(samples, utcDayKey)[0].fiveHourPeak).toBeNull()
  })

  it('returns an empty array for no samples', () => {
    expect(buildRollups([])).toEqual([])
  })

  it('utcDayKey formats correctly', () => {
    expect(utcDayKey(Date.UTC(2026, 0, 5, 23, 59))).toBe('2026-01-05')
  })

  it('localDayKey round-trips a local-time construction in any timezone', () => {
    // 23:59 local on Jan 5 must key as Jan 5 wherever the test runs — this is
    // exactly the boundary utcDayKey shifted for anyone west of UTC.
    expect(localDayKey(new Date(2026, 0, 5, 23, 59).getTime())).toBe('2026-01-05')
    expect(localDayKey(new Date(2026, 11, 31, 0, 0).getTime())).toBe('2026-12-31')
  })

  it('defaults to the local day key', () => {
    const t = new Date(2026, 0, 5, 23, 59).getTime()
    const samples: UsageSample[] = [
      { t, costUsd: 1, sessionCount: 1, fiveHourPct: 10, sevenDayPct: 10 }
    ]
    expect(buildRollups(samples)[0].day).toBe('2026-01-05')
  })
})

describe('buildRollups — weekly reset split', () => {
  function sevenDayWindow(over: Partial<WindowRecord> = {}): WindowRecord {
    return {
      kind: 'sevenDay',
      resetsAtMs: 0,
      startedAtMs: 0,
      peakPct: 0,
      partial: false,
      closedAtMs: 0,
      ...over
    }
  }

  it('splits a day with a mid-day weekly reset into pre/post', () => {
    const resetsAtMs = Date.UTC(2026, 5, 1, 16, 0)
    const samples: UsageSample[] = [
      {
        t: Date.UTC(2026, 5, 1, 8, 0),
        costUsd: 0,
        sessionCount: 0,
        fiveHourPct: null,
        sevenDayPct: 70
      },
      {
        t: Date.UTC(2026, 5, 1, 17, 0),
        costUsd: 0,
        sessionCount: 0,
        fiveHourPct: null,
        sevenDayPct: 12
      },
      {
        t: Date.UTC(2026, 5, 1, 20, 0),
        costUsd: 0,
        sessionCount: 0,
        fiveHourPct: null,
        sevenDayPct: 18
      }
    ]
    const windows = [
      sevenDayWindow({
        resetsAtMs,
        startedAtMs: resetsAtMs - WINDOW_DURATION_MS.sevenDay,
        peakPct: 82,
        closedAtMs: resetsAtMs
      })
    ]
    const r = buildRollups(samples, utcDayKey, windows)
    const day = r.find((x) => x.day === '2026-06-01')!
    expect(day.weeklyReset).toEqual({ atMs: resetsAtMs, prePct: 82, postPct: 18 })
  })

  it('keeps weeklyReset null on a day with no reset', () => {
    const samples: UsageSample[] = [
      {
        t: Date.UTC(2026, 5, 1, 8, 0),
        costUsd: 0,
        sessionCount: 0,
        fiveHourPct: null,
        sevenDayPct: 40
      }
    ]
    const r = buildRollups(samples, utcDayKey, [])
    expect(r[0].weeklyReset).toBeNull()
  })

  it('attributes a reset exactly at a day boundary to the new day, not the old one', () => {
    const resetsAtMs = Date.UTC(2026, 5, 2, 0, 0, 0, 0) // exact midnight → June 2
    const samples: UsageSample[] = [
      {
        t: Date.UTC(2026, 5, 1, 12, 0),
        costUsd: 0,
        sessionCount: 0,
        fiveHourPct: null,
        sevenDayPct: 88
      },
      { t: resetsAtMs, costUsd: 0, sessionCount: 0, fiveHourPct: null, sevenDayPct: 5 }
    ]
    const windows = [
      sevenDayWindow({
        resetsAtMs,
        startedAtMs: resetsAtMs - WINDOW_DURATION_MS.sevenDay,
        peakPct: 90,
        closedAtMs: resetsAtMs
      })
    ]
    const r = buildRollups(samples, utcDayKey, windows)
    const june1 = r.find((x) => x.day === '2026-06-01')!
    const june2 = r.find((x) => x.day === '2026-06-02')!
    expect(june1.weeklyReset).toBeNull()
    expect(june2.weeklyReset).toEqual({ atMs: resetsAtMs, prePct: 90, postPct: 5 })
  })

  // Real-data bug (2026-07): after a mid-day reset the API keeps returning
  // *stale* old-window readings (the old peak) for a while — samples at
  // `t >= resetsAtMs` that still read ~100%. A naive `max(sevenDayPct)` over
  // post-reset samples captures those stragglers, so `postPct` shows the OLD
  // window's peak instead of the NEW window's early usage (the next day's
  // value is then far lower, which is the tell). postPct must track only the
  // new window: find the reset drop, then reject samples that jump implausibly
  // above the new window's running peak.
  it('rejects stale old-window stragglers when computing postPct', () => {
    const resetsAtMs = Date.UTC(2026, 5, 1, 16, 0)
    const at = (h: number, m: number): number => Date.UTC(2026, 5, 1, h, m)
    const mk = (t: number, sevenDayPct: number): UsageSample => ({
      t,
      costUsd: 0,
      sessionCount: 0,
      fiveHourPct: null,
      sevenDayPct
    })
    const samples: UsageSample[] = [
      mk(at(15, 0), 92), // pre-reset (old window still climbing) — excluded (t < reset)
      mk(at(16, 16), 100), // STRAGGLER: old window's final reading, but t >= reset
      mk(at(16, 17), 0), // new window starts here (the drop)
      mk(at(16, 30), 5),
      mk(at(17, 0), 12),
      mk(at(18, 0), 20), // new window's real peak that day
      mk(at(18, 56), 89) // STRAGGLER: another stale old-window reading, must be rejected
    ]
    const windows = [
      sevenDayWindow({
        resetsAtMs,
        startedAtMs: resetsAtMs - WINDOW_DURATION_MS.sevenDay,
        peakPct: 100,
        closedAtMs: resetsAtMs
      })
    ]
    const day = buildRollups(samples, utcDayKey, windows).find((x) => x.day === '2026-06-01')!
    // NOT 100 (the stragglers) — the new window only reached 20% that day.
    expect(day.weeklyReset).toEqual({ atMs: resetsAtMs, prePct: 100, postPct: 20 })
  })

  it('uses the max peakPct across window records sharing a resetsAtMs (append log is noisy)', () => {
    const resetsAtMs = Date.UTC(2026, 5, 1, 16, 0)
    const samples: UsageSample[] = [
      {
        t: Date.UTC(2026, 5, 1, 17, 0),
        costUsd: 0,
        sessionCount: 0,
        fiveHourPct: null,
        sevenDayPct: 8
      }
    ]
    // Same window, two appended snapshots: the earlier one caught the true 100%
    // peak, a later snapshot only shows 92%. prePct must be the max (100), not
    // whichever record happens to be iterated last.
    const windows = [
      sevenDayWindow({
        resetsAtMs,
        startedAtMs: resetsAtMs - WINDOW_DURATION_MS.sevenDay,
        peakPct: 100,
        closedAtMs: resetsAtMs
      }),
      sevenDayWindow({
        resetsAtMs,
        startedAtMs: resetsAtMs - WINDOW_DURATION_MS.sevenDay,
        peakPct: 92,
        closedAtMs: resetsAtMs
      })
    ]
    const day = buildRollups(samples, utcDayKey, windows).find((x) => x.day === '2026-06-01')!
    expect(day.weeklyReset?.prePct).toBe(100)
  })
})

describe('percentile', () => {
  it('returns the median and p95 by interpolation', () => {
    expect(percentile([10, 20, 30], 50)).toBe(20)
    expect(percentile([1, 2, 3, 4], 50)).toBeCloseTo(2.5)
    expect(percentile([], 50)).toBe(0)
    expect(percentile([42], 95)).toBe(42)
  })
})

describe('projectPlanFit', () => {
  function win(kind: WindowRecord['kind'], peakPct: number, partial = false): WindowRecord {
    return { kind, resetsAtMs: 0, startedAtMs: 0, peakPct, partial, closedAtMs: 0 }
  }

  it('returns insufficient_data below the minimum window count', () => {
    const r = projectPlanFit([win('fiveHour', 17), win('fiveHour', 18)], 'max20', 'max5')
    expect(r.verdict).toBe('insufficient_data')
  })

  it('returns insufficient_data when the ratio is unknown', () => {
    const wins = [win('fiveHour', 10), win('fiveHour', 12), win('fiveHour', 14)]
    const r = projectPlanFit(wins, 'max20', 'nonsense')
    expect(r.ratio).toBeNull()
    expect(r.verdict).toBe('insufficient_data')
  })

  it('projects max20 → max5 by the 20/5 = 4× factor', () => {
    const wins = [win('fiveHour', 10), win('fiveHour', 15), win('fiveHour', 17)]
    const r = projectPlanFit(wins, 'max20', 'max5')
    expect(r.ratio).toBe(4)
    const five = r.stats.find((s) => s.kind === 'fiveHour')!
    expect(five.maxPct).toBe(17)
    expect(five.projectedMaxPct).toBe(68) // 17 * 4
  })

  it('excludes partial windows from the stats', () => {
    const wins = [
      win('fiveHour', 10),
      win('fiveHour', 12),
      win('fiveHour', 99, true) // partial — must be ignored
    ]
    const r = projectPlanFit(wins, 'max20', 'max20')
    const five = r.stats.find((s) => s.kind === 'fiveHour')!
    expect(five.count).toBe(2)
    expect(five.maxPct).toBe(12)
  })

  it('says over when the projection blows past 100% too often', () => {
    const wins = [
      win('fiveHour', 30),
      win('fiveHour', 40),
      win('fiveHour', 50),
      win('fiveHour', 60)
    ]
    const r = projectPlanFit(wins, 'max20', 'max5') // 4× → 120/160/200/240
    expect(r.verdict).toBe('over')
  })

  it('says comfortable when even the projection stays low', () => {
    const wins = [win('fiveHour', 3), win('fiveHour', 4), win('fiveHour', 5)]
    const r = projectPlanFit(wins, 'max20', 'max5') // 4× → 12/16/20
    expect(r.verdict).toBe('comfortable')
  })

  it('honors a manual ratio override', () => {
    const wins = [win('fiveHour', 10), win('fiveHour', 10), win('fiveHour', 10)]
    const r = projectPlanFit(wins, 'max20', 'max5', { ratioOverride: 2 })
    expect(r.ratio).toBe(2)
    expect(r.stats[0].projectedMaxPct).toBe(20)
  })

  it('reports the exceedRate of projections past 100%', () => {
    const wins = [win('fiveHour', 10), win('fiveHour', 20), win('fiveHour', 30)] // ×4 → 40/80/120
    const r = projectPlanFit(wins, 'max20', 'max5')
    expect(r.stats[0].exceedRate).toBeCloseTo(1 / 3)
  })

  it('scopes to windows closed at/after sinceMs', () => {
    const old = { ...win('fiveHour', 90), closedAtMs: 1000 }
    const recent = [10, 12, 14].map((p, i) => ({ ...win('fiveHour', p), closedAtMs: 5000 + i }))
    const all = projectPlanFit([old, ...recent], 'max20', 'max20')
    expect(all.stats[0].count).toBe(4)
    const scoped = projectPlanFit([old, ...recent], 'max20', 'max20', { sinceMs: 5000 })
    expect(scoped.stats[0].count).toBe(3)
    expect(scoped.stats[0].maxPct).toBe(14)
  })
})

describe('buildHeatmap', () => {
  const HOUR = 3600_000
  function sample(t: number, fiveHourPct: number | null): UsageSample {
    return { t, costUsd: 0, sessionCount: 0, fiveHourPct, sevenDayPct: null }
  }
  // Build local-time instants so weekday/hour are TZ-independent in the test.
  const tueAfternoon = new Date(2026, 6, 7, 15, 0).getTime() // Tue 15:00 → bucket 7 (14–16h)
  const now = new Date(2026, 6, 8, 12, 0).getTime()

  it('averages 5h% into local weekday × hour buckets and finds the heaviest', () => {
    const hm = buildHeatmap(
      [sample(tueAfternoon, 60), sample(tueAfternoon + 5 * 60_000, 80), sample(tueAfternoon, null)],
      now
    )
    expect(hm.buckets).toBe(12)
    const cell = hm.cells.find((c) => c.dow === 2 && c.bucket === 7)!
    expect(cell.n).toBe(2) // the null one is ignored
    expect(cell.avgPct).toBe(70)
    expect(hm.maxAvgPct).toBe(70)
    expect(hm.heaviest).toEqual({ dow: 2, hourStart: 14, hourEnd: 16, avgPct: 70 })
  })

  it('excludes samples older than the scope and returns empty heaviest when nothing counts', () => {
    const old = tueAfternoon - 40 * 24 * HOUR
    const hm = buildHeatmap([sample(old, 90)], now, 28)
    expect(hm.maxAvgPct).toBeNull()
    expect(hm.heaviest).toBeNull()
    expect(hm.cells).toHaveLength(7 * 12)
  })
})

describe('recommendTier', () => {
  function win(peakPct: number): WindowRecord {
    return {
      kind: 'fiveHour',
      resetsAtMs: 0,
      startedAtMs: 0,
      peakPct,
      partial: false,
      closedAtMs: 0
    }
  }

  it('recommends the smallest tier with a comfortable verdict', () => {
    // Peaks of ~3% on max20 → 12% on max5 (comfortable), 60% on pro (comfortable).
    const r = recommendTier([win(2), win(3), win(3)], 'max20', PLAN_TIERS)
    expect(r).toEqual({ tierId: 'pro', verdict: 'comfortable' })
  })

  it('skips tiers the peaks would blow past', () => {
    // 10–17% on max20 → up to 68% on max5 (comfortable) but 340% on pro (over).
    const r = recommendTier([win(10), win(15), win(17)], 'max20', PLAN_TIERS)
    expect(r).toEqual({ tierId: 'max5', verdict: 'comfortable' })
  })

  it('falls back to the smallest tight tier when nothing is comfortable', () => {
    // 22% peaks ×4 = 88% on max5 (tight); ×20 on pro = over; max20 at 22% is comfortable…
    // so force tight-only by projecting peaks that stay ≥80 even on max20.
    const r = recommendTier([win(85), win(88), win(90)], 'max20', PLAN_TIERS)
    expect(r).toEqual({ tierId: 'max20', verdict: 'tight' })
  })

  it('returns null on insufficient data — never guesses', () => {
    expect(recommendTier([win(10)], 'max20', PLAN_TIERS)).toBeNull()
  })
})
