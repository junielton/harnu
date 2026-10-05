import { describe, it, expect } from 'vitest'
import {
  modelColor,
  deltaBadge,
  fmtTok,
  fmtMoney0,
  fmtInt,
  sparklinePoints,
  buildStackedRows,
  pctThresholdColor,
  fmtResetTime,
  sessionTokensTotal,
  sessionDominantModel,
  buildScatterScale,
  buildScatterPoints,
  buildInsight,
  buildCalendarCells,
  calendarMetricT,
  heatColor,
  sortRows,
  buildDayTableRows,
  buildModelTableRows,
  buildProjectTableRows,
  filterSessions,
  distinctModels,
  projectBasename
} from '../src/renderer/src/components/usage-dashboard-format'
import type {
  SessionAnatomy,
  UsageBiDay,
  ModelCostRollup,
  ProjectCostRollup,
  EnrichedWindow
} from '../src/preload'

// ---- Fixture helpers ---------------------------------------------------------

function session(overrides: Partial<SessionAnatomy> = {}): SessionAnatomy {
  return {
    sessionId: 's1',
    projectPath: '/p',
    title: 'a session',
    startedAtMs: 0,
    endedAtMs: 3_600_000,
    durationMs: 3_600_000,
    turns: 10,
    requestCount: 5,
    subagentCount: 0,
    tokens: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, cacheWriteTokens: 100 },
    costByModel: { 'claude-sonnet-4-6': 1 },
    costUsd: 1,
    peakContextPct: 20,
    estimated: false,
    ...overrides
  }
}

function day(overrides: Partial<UsageBiDay> = {}): UsageBiDay {
  return {
    day: '2026-07-08',
    peak5hPct: 40,
    peak7dPct: 60,
    costUsd: 10,
    costByModel: { 'claude-opus-4-8': 8, 'claude-sonnet-4-6': 2 },
    sessionsWorked: 3,
    dominantModel: 'claude-opus-4-8',
    estimated: false,
    weeklyReset: null,
    ...overrides
  }
}

// ---- modelColor ----------------------------------------------------------------

describe('modelColor', () => {
  it('assigns opus 4.7/4.8 a distinct color from other opus', () => {
    expect(modelColor('claude-opus-4-8')).not.toBe(modelColor('claude-opus-4-7'))
  })
  it('is deterministic and case-insensitive', () => {
    expect(modelColor('claude-Sonnet-4-6')).toBe(modelColor('claude-sonnet-4-6'))
  })
  it('falls back to the neutral color for an unknown family', () => {
    expect(modelColor('some-future-model')).toBe('var(--color-text-4)')
  })
  it('fable and mythos share the same color family', () => {
    expect(modelColor('claude-fable-5')).toBe(modelColor('claude-mythos-5'))
  })
})

// ---- deltaBadge ------------------------------------------------------------------

describe('deltaBadge', () => {
  it('flat when prev is null (nothing to compare against)', () => {
    expect(deltaBadge(50, null, true).tone).toBe('flat')
  })
  it('flat when prev is zero (a % delta off zero is meaningless)', () => {
    expect(deltaBadge(50, 0, true).tone).toBe('flat')
  })
  it('up-bad when higherIsBad and the value increased', () => {
    const d = deltaBadge(80, 60, true)
    expect(d.tone).toBe('up-bad')
    expect(d.arrow).toBe('↑')
    expect(d.pct).toBeCloseTo(33.33, 1)
  })
  it('up-good when higherIsBad=false and the value increased', () => {
    expect(deltaBadge(80, 60, false).tone).toBe('up-good')
  })
  it('down-good when higherIsBad and the value decreased', () => {
    expect(deltaBadge(40, 60, true).tone).toBe('down-good')
  })
})

// ---- Number formatting -----------------------------------------------------------

describe('number formatters', () => {
  it('fmtTok compacts to K/M', () => {
    expect(fmtTok(500)).toBe('500')
    expect(fmtTok(4200)).toBe('4K')
    expect(fmtTok(3_400_000)).toBe('3.4M')
    expect(fmtTok(15_000_000)).toBe('15M')
  })
  it('fmtMoney0 rounds, no cents', () => {
    expect(fmtMoney0(1234.56)).toBe('$1,235')
  })
  it('fmtInt handles null/undefined as 0', () => {
    expect(fmtInt(null)).toBe('0')
    expect(fmtInt(undefined)).toBe('0')
  })
})

// ---- sparklinePoints --------------------------------------------------------------

describe('sparklinePoints', () => {
  it('returns empty points for an empty series', () => {
    expect(sparklinePoints([]).points).toBe('')
  })
  it('centers a single-value series', () => {
    const { points } = sparklinePoints([5], 100, 26)
    expect(points).toContain('50.0')
  })
  it('produces one point per value', () => {
    const { points } = sparklinePoints([1, 2, 3, 4])
    expect(points.split(' ')).toHaveLength(4)
  })
})

// ---- buildStackedRows --------------------------------------------------------------

describe('buildStackedRows', () => {
  const days = [day({ day: '2026-07-07' }), day({ day: '2026-07-08' })]

  it('cost metric stacks per-model segments filtered by visibleModels', () => {
    const rows = buildStackedRows(days, 'cost', new Set(['claude-opus-4-8']), '2026-07-08')
    expect(rows[0].segments).toHaveLength(1)
    expect(rows[0].segments[0].model).toBe('claude-opus-4-8')
    expect(rows[0].total).toBe(8)
  })
  it('rate metric ignores visibleModels — single segment from peak7dPct', () => {
    const rows = buildStackedRows(days, 'rate', new Set(), '2026-07-08')
    expect(rows[0].isRateMetric).toBe(true)
    expect(rows[0].total).toBe(60)
    expect(rows[0].weeklyReset).toBeUndefined()
  })
  it('rate metric exposes weeklyReset directly (no segments) for a mid-day reset', () => {
    const resetDay = day({
      day: '2026-07-08',
      weeklyReset: { atMs: 1751990400000, prePct: 82, postPct: 18 }
    })
    const rows = buildStackedRows([resetDay], 'rate', new Set(), '2026-07-08')
    expect(rows[0].isRateMetric).toBe(true)
    expect(rows[0].weeklyReset).toEqual({ atMs: 1751990400000, prePct: 82, postPct: 18 })
    // no summed total — the two bars are independently scaled, so `total` is
    // only ever the scale-reference max, never rendered as a combined label.
    expect(rows[0].total).toBe(82)
    expect(rows[0].segments).toHaveLength(0)
  })
  it('rate metric weeklyReset total is the max of pre/post regardless of which is bigger', () => {
    const resetDay = day({
      day: '2026-07-08',
      weeklyReset: { atMs: 1751990400000, prePct: 30, postPct: 65 }
    })
    const rows = buildStackedRows([resetDay], 'rate', new Set(), '2026-07-08')
    expect(rows[0].total).toBe(65)
  })
  it('sessions metric is a single segment (engine has no per-model session counts)', () => {
    const rows = buildStackedRows(days, 'sessions', new Set(['claude-opus-4-8']), '2026-07-08')
    expect(rows[0].segments).toHaveLength(1)
    expect(rows[0].total).toBe(3)
  })
  it('sessions metric zeroes out a day whose dominant model is filtered off', () => {
    const rows = buildStackedRows(days, 'sessions', new Set(['claude-sonnet-4-6']), '2026-07-08')
    expect(rows[0].total).toBe(0)
    expect(rows[0].segments).toHaveLength(0)
  })
  it('flags the today bar', () => {
    const rows = buildStackedRows(
      days,
      'cost',
      new Set(['claude-opus-4-8', 'claude-sonnet-4-6']),
      '2026-07-08'
    )
    expect(rows[1].isToday).toBe(true)
    expect(rows[0].isToday).toBe(false)
  })
})

// ---- pctThresholdColor (used directly by both weekly-reset bars) --------------

describe('pctThresholdColor', () => {
  it('matches the 80/95 thresholds — same ruler used by both independent bars', () => {
    expect(pctThresholdColor(96)).toBe('var(--color-red)')
    expect(pctThresholdColor(85)).toBe('var(--color-accent)')
    expect(pctThresholdColor(50)).toBe('var(--color-green)')
  })
})

// ---- fmtResetTime ---------------------------------------------------------------

describe('fmtResetTime', () => {
  it('formats local HH:MM, zero-padded', () => {
    expect(fmtResetTime(new Date(2026, 6, 11, 14, 32).getTime())).toBe('14:32')
    expect(fmtResetTime(new Date(2026, 6, 11, 4, 5).getTime())).toBe('04:05')
  })
})

// ---- Session anatomy scatter --------------------------------------------------------

describe('sessionTokensTotal / sessionDominantModel', () => {
  it('sums all 4 token buckets', () => {
    expect(sessionTokensTotal(session())).toBe(1000 + 500 + 200 + 100)
  })
  it('picks the highest-cost model', () => {
    const s = session({ costByModel: { a: 5, b: 20, c: 1 } })
    expect(sessionDominantModel(s)).toBe('b')
  })
  it('returns null for a session with no costByModel entries', () => {
    expect(sessionDominantModel(session({ costByModel: {} }))).toBeNull()
  })
})

describe('buildScatterScale / buildScatterPoints', () => {
  it('places sessions within the plot bounds', () => {
    const sessions = [
      session({ sessionId: 's1', durationMs: 3_600_000, costUsd: 10 }),
      session({ sessionId: 's2', durationMs: 7_200_000, costUsd: 50 })
    ]
    const scale = buildScatterScale(sessions, 700, 350)
    const points = buildScatterPoints(sessions, scale)
    for (const p of points) {
      expect(p.cx).toBeGreaterThanOrEqual(0)
      expect(p.cx).toBeLessThanOrEqual(700)
      expect(p.cy).toBeGreaterThanOrEqual(0)
      expect(p.cy).toBeLessThanOrEqual(350)
      expect(p.r).toBeGreaterThanOrEqual(8)
      expect(p.r).toBeLessThanOrEqual(40)
    }
  })
  it('does not throw on an empty session list', () => {
    const scale = buildScatterScale([], 700, 350)
    expect(buildScatterPoints([], scale)).toEqual([])
  })
})

describe('buildInsight', () => {
  it('compares the two highest-cost-per-hour dominant models', () => {
    const sessions = [
      session({ sessionId: 's1', costByModel: { opus: 100 }, costUsd: 100, durationMs: 3_600_000 }),
      session({ sessionId: 's2', costByModel: { sonnet: 10 }, costUsd: 10, durationMs: 3_600_000 })
    ]
    const insight = buildInsight(sessions)
    expect(insight?.modelA).toBe('opus')
    expect(insight?.modelB).toBe('sonnet')
    expect(insight?.ratio).toBeCloseTo(10, 5)
  })
  it('returns null with fewer than 2 distinct dominant models', () => {
    const sessions = [session({ costByModel: { opus: 10 } })]
    expect(buildInsight(sessions)).toBeNull()
  })
  it('skips sessions with zero duration (division-safe)', () => {
    const sessions = [
      session({ sessionId: 's1', costByModel: { opus: 10 }, durationMs: 0 }),
      session({ sessionId: 's2', costByModel: { sonnet: 5 }, durationMs: 3_600_000 })
    ]
    expect(buildInsight(sessions)).toBeNull() // only 1 model has a valid rate
  })
})

// ---- Activity calendar ----------------------------------------------------------

describe('buildCalendarCells', () => {
  it('produces full weeks (length divisible by 7) with Monday-first padding', () => {
    // July 2026: 1st is a Wednesday.
    const anchor = new Date(2026, 6, 8).getTime()
    const cells = buildCalendarCells(anchor, new Map(), '2026-07-08')
    expect(cells.length % 7).toBe(0)
    // 2 leading pad cells (Mon, Tue) before July 1 (Wed).
    expect(cells[0].dayKey).toBeNull()
    expect(cells[1].dayKey).toBeNull()
    expect(cells[2].dayOfMonth).toBe(1)
  })
  it('maps data by local day key and flags today', () => {
    const anchor = new Date(2026, 6, 8).getTime()
    const d = day({ day: '2026-07-08' })
    const cells = buildCalendarCells(anchor, new Map([['2026-07-08', d]]), '2026-07-08')
    const todayCell = cells.find((c) => c.dayKey === '2026-07-08')
    expect(todayCell?.isToday).toBe(true)
    expect(todayCell?.data).toEqual(d)
  })
})

describe('calendarMetricT', () => {
  it('rate metric is the raw pct / 100, ignoring min/max', () => {
    expect(calendarMetricT(day({ peak7dPct: 50 }), 'rate', 0, 100)).toBeCloseTo(0.5)
  })
  it('cost/sessions metric is relative to the visible min/max', () => {
    expect(calendarMetricT(day({ costUsd: 50 }), 'cost', 0, 100)).toBeCloseTo(0.5)
    expect(calendarMetricT(day({ costUsd: 50 }), 'cost', 50, 50)).toBe(0.5) // zero span -> midpoint
  })
})

describe('heatColor', () => {
  it('is a valid rgb() string at both extremes and midpoint', () => {
    expect(heatColor(0)).toMatch(/^rgb\(\d+, \d+, \d+\)$/)
    expect(heatColor(0.5)).toMatch(/^rgb\(\d+, \d+, \d+\)$/)
    expect(heatColor(1)).toMatch(/^rgb\(\d+, \d+, \d+\)$/)
  })
})

// ---- sortRows --------------------------------------------------------------------

describe('sortRows', () => {
  it('sorts numbers ascending/descending', () => {
    const rows = [{ v: 3 }, { v: 1 }, { v: 2 }]
    expect(sortRows(rows, (r) => r.v, 'asc').map((r) => r.v)).toEqual([1, 2, 3])
    expect(sortRows(rows, (r) => r.v, 'desc').map((r) => r.v)).toEqual([3, 2, 1])
  })
  it('sorts strings via localeCompare', () => {
    const rows = [{ n: 'banana' }, { n: 'apple' }]
    expect(sortRows(rows, (r) => r.n, 'asc').map((r) => r.n)).toEqual(['apple', 'banana'])
  })
  it('does not mutate the input array', () => {
    const rows = [{ v: 3 }, { v: 1 }]
    sortRows(rows, (r) => r.v, 'asc')
    expect(rows[0].v).toBe(3)
  })
})

// ---- Explorer table row builders --------------------------------------------------

describe('buildDayTableRows', () => {
  it('computes day-over-day cost delta and attaches this-day window peaks', () => {
    const days = [day({ day: '2026-07-07', costUsd: 10 }), day({ day: '2026-07-08', costUsd: 20 })]
    const windows: EnrichedWindow[] = [
      {
        kind: 'fiveHour',
        // 2026-07-08T10:00:00Z falls on 2026-07-08 in every reasonable TZ offset used in CI.
        startedAtMs: Date.UTC(2026, 6, 8, 10),
        resetsAtMs: Date.UTC(2026, 6, 8, 15),
        peakPct: 42,
        partial: false,
        closedAtMs: Date.UTC(2026, 6, 8, 15),
        costDeltaUsd: 1,
        sessionsActive: [],
        dominantModel: null
      }
    ]
    const rows = buildDayTableRows(days, windows)
    expect(rows[0].deltaPct).toBeNull() // no previous day
    expect(rows[1].deltaPct).toBeCloseTo(100) // 10 -> 20 = +100%
    expect(rows[1].windowPeaks).toEqual([42])
    expect(rows[0].windowPeaks).toEqual([])
  })
})

describe('buildModelTableRows / buildProjectTableRows', () => {
  function model(overrides: Partial<ModelCostRollup> = {}): ModelCostRollup {
    return {
      model: 'claude-opus-4-8',
      tierLabel: 'opus-4.5-4.6',
      estimated: false,
      costUsd: 10,
      requestCount: 5,
      tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      ...overrides
    }
  }
  function project(overrides: Partial<ProjectCostRollup> = {}): ProjectCostRollup {
    return {
      projectPath: '/p',
      costUsd: 10,
      requestCount: 5,
      sessionCount: 2,
      estimated: false,
      ...overrides
    }
  }

  it('model rows: avg per request + share of total cost', () => {
    const rows = buildModelTableRows([
      model({ costUsd: 30, requestCount: 3 }),
      model({ costUsd: 70 })
    ])
    expect(rows[0].avgPerRequest).toBeCloseTo(10)
    expect(rows[0].shareOfCostPct).toBeCloseTo(30)
  })
  it('model rows: avgPerRequest is 0 when requestCount is 0 (never divides by zero)', () => {
    const rows = buildModelTableRows([model({ requestCount: 0 })])
    expect(rows[0].avgPerRequest).toBe(0)
  })
  it('project rows: avg per session + share of total cost', () => {
    const rows = buildProjectTableRows([
      project({ costUsd: 20, sessionCount: 4 }),
      project({ costUsd: 80 })
    ])
    expect(rows[0].avgPerSession).toBeCloseTo(5)
    expect(rows[0].shareOfCostPct).toBeCloseTo(20)
  })
})

// ---- Filtering ---------------------------------------------------------------------

describe('filterSessions', () => {
  const sessions = [
    session({ sessionId: 's1', projectPath: '/a', costByModel: { opus: 1 } }),
    session({ sessionId: 's2', projectPath: '/b', costByModel: { sonnet: 1 } })
  ]

  it('filters by dominant model visibility', () => {
    const filtered = filterSessions(sessions, new Set(['opus']), null)
    expect(filtered.map((s) => s.sessionId)).toEqual(['s1'])
  })
  it('filters by project path', () => {
    const filtered = filterSessions(sessions, new Set(['opus', 'sonnet']), '/b')
    expect(filtered.map((s) => s.sessionId)).toEqual(['s2'])
  })
  it('keeps a session with no dominant model when the model filter is empty (nothing to exclude on)', () => {
    const noModel = session({ sessionId: 's3', costByModel: {} })
    expect(filterSessions([noModel], new Set(), null)).toEqual([noModel])
  })
})

describe('distinctModels', () => {
  it('unions models from both the models rollup and per-day cost breakdowns', () => {
    const snapshot = {
      models: [
        {
          model: 'opus',
          tierLabel: '',
          estimated: false,
          costUsd: 1,
          requestCount: 1,
          tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
        }
      ],
      days: [day({ costByModel: { sonnet: 1, haiku: 1 } })]
    }
    expect(distinctModels(snapshot)).toEqual(['haiku', 'opus', 'sonnet'])
  })
})

describe('projectBasename', () => {
  it('returns the trailing path segment', () => {
    expect(projectBasename('/home/u/Workspace/me/harnu')).toBe('harnu')
  })
  it('strips a trailing slash before taking the basename', () => {
    expect(projectBasename('/home/u/Workspace/me/harnu/')).toBe('harnu')
  })
  it('falls back to the full path for a root-only path', () => {
    expect(projectBasename('/')).toBe('/')
  })
})
