import { describe, it, expect } from 'vitest'
import {
  cadenceFor,
  chartColumns,
  consumerKey,
  consumerRows,
  formatCountdown,
  intervalLabelParts,
  meterFillClass,
  meterValueClass,
  minutesUntil,
  outsideBarPct,
  paceView,
  pillToneClass,
  readyBudget,
  sharePercent,
  splitBar,
  usedPercent
} from '../src/renderer/src/lib/github-budget-view'
import { NOW, exhausted, healthy, low, unavailable } from './helpers/github-budget-snapshot'

describe('readyBudget', () => {
  it('hides the pill while unavailable or before the first poll', () => {
    expect(readyBudget(null)).toBeNull()
    expect(readyBudget(unavailable())).toBeNull()
  })

  it('follows the tighter bucket', () => {
    const r = readyBudget(healthy())!
    expect(r.tighter).toBe('rest')
    expect(r.tighterView.bucket.remaining).toBe(4112)
  })
})

describe('plan-usage ramp (80/95)', () => {
  it('matches the mockup percentages', () => {
    expect(Math.round(usedPercent(healthy().rest!.bucket))).toBe(18)
    expect(Math.round(usedPercent(low().rest!.bucket))).toBe(87)
    expect(usedPercent(exhausted().rest!.bucket)).toBe(100)
  })

  it('is green below 80, accent to 95, red from 95', () => {
    expect(meterFillClass(18)).toBe('bg-green')
    expect(meterFillClass(87)).toBe('bg-accent')
    expect(meterFillClass(100)).toBe('bg-red')
    expect(meterValueClass(18)).toBe('text-text-2')
    expect(meterValueClass(87)).toBe('text-accent')
    expect(meterValueClass(100)).toBe('text-red')
  })

  it('tones the pill by throttle state', () => {
    expect(pillToneClass('normal')).toContain('text-text-2')
    expect(pillToneClass('low')).toContain('text-warning')
    expect(pillToneClass('exhausted')).toContain('text-red')
  })
})

describe('countdowns', () => {
  it('rounds a reset up to whole minutes and never shows 0m while it is still ahead', () => {
    expect(minutesUntil(NOW + 38 * 60_000, NOW)).toBe(38)
    expect(minutesUntil(NOW + 5_000, NOW)).toBe(1)
    expect(minutesUntil(NOW - 1, NOW)).toBe(0)
  })

  it('formats minutes and hours', () => {
    expect(formatCountdown(38)).toBe('38m')
    expect(formatCountdown(60)).toBe('1h')
    expect(formatCountdown(65)).toBe('1h 5m')
  })
})

describe('attribution (mockup sample data)', () => {
  it('healthy: split widths are a share of the limit and rows keep the display order', () => {
    const view = healthy().rest!
    const split = splitBar(view)
    expect(split.harnu).toBe(582)
    expect(split.outside).toBe(306)
    expect(split.harnuPct).toBeCloseTo(11.64, 1)
    expect(split.outsidePct).toBeCloseTo(6.12, 1)
    const rows = consumerRows(view)
    expect(rows.map((r) => r.consumer)).toEqual([
      'missions',
      'pr-stack',
      'review',
      'cleanup',
      'steward'
    ])
    // Bars are relative to the busiest Harnu consumer; outside is clamped at 100.
    expect(rows.map((r) => r.barPct)).toEqual([100, 23, 9, 5, 3])
    expect(outsideBarPct(view, rows)).toBe(74)
  })

  it('low: Harnu 2,310 and outside 2,050 fill 46% and 41% of the bucket', () => {
    const split = splitBar(low().rest!)
    expect(split.harnu).toBe(2310)
    expect(split.outside).toBe(2050)
    expect(split.harnuPct).toBeCloseTo(46.2, 1)
    expect(split.outsidePct).toBeCloseTo(41, 1)
    expect(outsideBarPct(low().rest!, consumerRows(low().rest!))).toBe(100)
  })

  it('shows merge-batch only once it has spent a call', () => {
    const v = healthy().rest!
    expect(consumerRows(v).some((r) => r.consumer === 'merge-batch')).toBe(false)
    v.byConsumer['merge-batch'] = 3
    expect(consumerRows(v).some((r) => r.consumer === 'merge-batch')).toBe(true)
  })

  it('gives the budget probe no row, but keeps its call in the Harnu total', () => {
    const v = healthy().rest!
    v.byConsumer.budget = 1
    v.harnu += 1
    expect(consumerRows(v).some((r) => (r.consumer as string) === 'budget')).toBe(false)
    expect(splitBar(v).harnu).toBe(583)
  })

  it('shares are of everything spent this window', () => {
    // 412 of 888, the table's 46%.
    expect(sharePercent(412, 888)).toBe(46)
    expect(sharePercent(0, 0)).toBe(0)
  })

  it('maps consumer ids to camelCase i18n leaves', () => {
    expect(consumerKey('pr-stack')).toBe('prStack')
    expect(consumerKey('merge-batch')).toBe('mergeBatch')
    expect(consumerKey('missions')).toBe('missions')
  })
})

describe('pace', () => {
  it('healthy: lasts past the reset, outside = total minus Harnu', () => {
    const p = paceView(healthy().rest!, 'normal', NOW)
    expect(p.callsPerMin).toBe(31)
    expect(p.harnuPerMin).toBe(18)
    expect(p.outsidePerMin).toBe(13)
    expect(p.emptyInMinutes).toBeNull()
    expect(p.harnuWasPerMin).toBeNull()
  })

  it('low: empty before the reset and remembers how fast Harnu was before slowing down', () => {
    const p = paceView(low().rest!, 'low', NOW)
    expect(p.emptyInMinutes).toBe(7)
    expect(p.harnuWasPerMin).toBeCloseTo(92, 0)
  })

  it('has no verdict before two polls', () => {
    const view = healthy().rest!
    view.pace.callsPerMin = null
    view.pace.minutesToEmpty = null
    const p = paceView(view, 'normal', NOW)
    expect(p.outsidePerMin).toBeNull()
    expect(p.emptyInMinutes).toBeNull()
  })
})

describe('last-hour chart', () => {
  it('draws twelve columns, labels every other one, stacked in proportion', () => {
    const cols = chartColumns(low().rest!.history, 'en')
    expect(cols).toHaveLength(12)
    expect(cols.filter((c) => c.label !== null)).toHaveLength(6)
    // A slowed bucket carries the warn segment; a normal one does not.
    expect(cols[8].throttledPct).toBeGreaterThan(0)
    expect(cols[8].harnuPct).toBe(0)
    expect(cols[2].throttledPct).toBe(0)
    // The tallest column stays inside the chart.
    const tallest = Math.max(...cols.map((c) => c.harnuPct + c.throttledPct + c.outsidePct))
    expect(tallest).toBeLessThanOrEqual(100)
  })

  it('does not blow a quiet hour up to full height', () => {
    const cols = chartColumns(healthy().rest!.history, 'en')
    const busiest = Math.max(...cols.map((c) => c.harnuPct + c.outsidePct))
    expect(busiest).toBeLessThan(100)
    expect(chartColumns(unavailable().rest?.history ?? [], 'en')).toEqual([])
  })
})

describe('cadence ("Checks every")', () => {
  const base = {
    pausePrStackWhenLow: true,
    prStackIntervalMs: 90_000,
    prStackAutoRefresh: true,
    cleanupIntervalMs: 900_000
  }

  it('healthy: nothing is held back', () => {
    const c = cadenceFor('missions', { ...base, state: 'normal' })
    expect(c.base).toEqual({ kind: 'every', ms: 60_000 })
    expect(c.now).toBeNull()
  })

  it('low: missions stretch to 5 min, PR Stack falls back to on open, the rest are unchanged', () => {
    const i = { ...base, state: 'low' as const }
    expect(cadenceFor('missions', i).now).toEqual({ kind: 'every', ms: 300_000 })
    expect(cadenceFor('pr-stack', i).now).toEqual({ kind: 'onOpen' })
    expect(cadenceFor('review', i).now).toBeNull()
    expect(cadenceFor('cleanup', i).now).toBeNull()
    expect(cadenceFor('steward', i).now).toBeNull()
  })

  it('low with the pause switch off: PR Stack keeps its interval', () => {
    const i = { ...base, state: 'low' as const, pausePrStackWhenLow: false }
    expect(cadenceFor('pr-stack', i).now).toBeNull()
  })

  it('exhausted: every Harnu consumer reads as paused', () => {
    const i = { ...base, state: 'exhausted' as const }
    for (const c of ['missions', 'pr-stack', 'review', 'cleanup', 'steward'] as const) {
      expect(cadenceFor(c, i).now).toEqual({ kind: 'paused' })
    }
  })

  it('a PR Stack with auto-refresh off is already on open', () => {
    const i = { ...base, state: 'normal' as const, prStackAutoRefresh: false }
    expect(cadenceFor('pr-stack', i).base).toEqual({ kind: 'onOpen' })
  })

  it('names an interval in the unit a person says it in', () => {
    expect(intervalLabelParts(30_000)).toEqual({ unit: 's', n: 30 })
    expect(intervalLabelParts(90_000)).toEqual({ unit: 'min', n: 2 })
    expect(intervalLabelParts(3_600_000)).toEqual({ unit: 'h', n: 1 })
  })
})
