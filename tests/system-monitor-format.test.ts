import { describe, it, expect } from 'vitest'
import { selfSample } from '../src/renderer/src/components/system-monitor-format'
import type { ProcSample } from '../src/preload'

function proc(overrides: Partial<ProcSample> = {}): ProcSample {
  return { pid: 1, name: 'node', cpuPct: 1, rssBytes: 1_000_000, ...overrides }
}

describe('selfSample', () => {
  it('subtracts every listed descendant from the subtree total', () => {
    const out = selfSample({ cpuPct: 10, rssBytes: 900_000_000 }, [
      proc({ pid: 2, cpuPct: 1, rssBytes: 83_000_000 }),
      proc({ pid: 3, cpuPct: 0, rssBytes: 1_000_000 }),
      proc({ pid: 4, cpuPct: 0, rssBytes: 106_000_000 })
    ])
    expect(out.rssBytes).toBe(900_000_000 - 83_000_000 - 1_000_000 - 106_000_000)
    expect(out.cpuPct).toBe(9)
  })

  it('is null when the total is unknown', () => {
    const out = selfSample({ cpuPct: null, rssBytes: null }, [proc()])
    expect(out).toEqual({ cpuPct: null, rssBytes: null })
  })

  it('is null when any one descendant reading is unknown, not a partial sum', () => {
    const out = selfSample({ cpuPct: 10, rssBytes: 900_000_000 }, [
      proc({ rssBytes: 83_000_000 }),
      proc({ rssBytes: null })
    ])
    expect(out.rssBytes).toBeNull()
  })

  it('returns the full total unchanged when there are no descendants', () => {
    const out = selfSample({ cpuPct: 3, rssBytes: 500_000_000 }, [])
    expect(out).toEqual({ cpuPct: 3, rssBytes: 500_000_000 })
  })
})

// ── T591: redesign helpers ────────────────────────────────────────────────

import {
  HEAP_CRIT_PCT,
  HEAP_WARN_PCT,
  MONITOR_VIEW_KEY,
  compositionSegments,
  formatCpu,
  formatPct1,
  monitorHeapFillClass,
  monitorHeapTextClass,
  monitorTotals,
  parseMonitorView,
  relativePct,
  sessionChildren,
  sparklinePolylines,
  splitBytes
} from '../src/renderer/src/components/system-monitor-format'
import type { SessionSample } from '../src/preload'

function sess(over: Partial<SessionSample> = {}): SessionSample {
  return {
    sessionKey: 's',
    kind: 'claude-resume',
    state: 'live',
    cpuPct: 1,
    rssBytes: 100_000_000,
    procs: [],
    idleMs: 0,
    parkable: true,
    reason: 'active',
    sweepRank: null,
    savedBytes: null,
    ...over
  }
}

describe('splitBytes / formatCpu / formatPct1', () => {
  it('splits a big number from its unit', () => {
    expect(splitBytes(940_000_000)).toEqual({ value: '940', unit: 'MB' })
    expect(splitBytes(1_200_000_000)).toEqual({ value: '1.20', unit: 'GB' })
    expect(splitBytes(null)).toBeNull()
  })
  it('formatCpu: one decimal under 10, whole numbers from 10, em dash when unknown', () => {
    expect(formatCpu(3.24)).toBe('3.2%')
    expect(formatCpu(0)).toBe('0.0%')
    expect(formatCpu(11.8)).toBe('12%')
    expect(formatCpu(null)).toBe('—')
  })
  it('formatPct1 always keeps one decimal', () => {
    expect(formatPct1(18.44)).toBe('18.4%')
    expect(formatPct1(null)).toBe('—')
  })
})

describe('monitorTotals (AC-2)', () => {
  const harnu = [
    { pid: 1, name: 'main', cpuPct: 0.4, rssBytes: 360_000_000 },
    { pid: 2, name: 'renderer', cpuPct: 2.1, rssBytes: 340_000_000 }
  ]
  const child = (pid: number) => ({ pid, name: 'node', cpuPct: 0, rssBytes: 1 })

  it('sums Harnu plus LIVE sessions only, with the split share', () => {
    const t = monitorTotals(harnu, [
      sess({ rssBytes: 700_000_000, cpuPct: 5, procs: [child(10), child(11)] }),
      sess({ rssBytes: null, cpuPct: null, state: 'parked', savedBytes: 290_000_000 })
    ])
    expect(t.harnuBytes).toBe(700_000_000)
    expect(t.sessionsBytes).toBe(700_000_000)
    expect(t.totalBytes).toBe(1_400_000_000)
    expect(t.harnuSharePct).toBeCloseTo(50)
    expect(t.cpuPct).toBeCloseTo(7.5)
  })
  it('counts listed processes: Harnu rows plus every live session child', () => {
    const t = monitorTotals(harnu, [sess({ procs: [child(10), child(11), child(12)] })])
    expect(t.processCount).toBe(5)
  })
  it('counts live and parked sessions', () => {
    const t = monitorTotals(harnu, [sess(), sess(), sess({ state: 'parked', rssBytes: null })])
    expect(t.live).toBe(2)
    expect(t.parked).toBe(1)
  })
  it('reclaimed is the sum of the known savedBytes; null when none is known', () => {
    const parked = (saved: number | null) =>
      sess({ state: 'parked', rssBytes: null, cpuPct: null, savedBytes: saved })
    expect(
      monitorTotals(harnu, [parked(290_000_000), parked(310_000_000), parked(null)]).reclaimedBytes
    ).toBe(600_000_000)
    expect(monitorTotals(harnu, [parked(null)]).reclaimedBytes).toBeNull()
  })
  it('CPU is null when no process reports one (NullSampler platforms)', () => {
    const t = monitorTotals([{ pid: 1, name: 'main', cpuPct: null, rssBytes: 1 }], [])
    expect(t.cpuPct).toBeNull()
  })
  it('an empty sample does not divide by zero', () => {
    const t = monitorTotals([], [])
    expect(t.totalBytes).toBe(0)
    expect(t.harnuSharePct).toBe(0)
  })
})

describe('relativePct', () => {
  it('is value / max as a percentage, clamped, 0 for unknown or empty', () => {
    expect(relativePct(50, 200)).toBe(25)
    expect(relativePct(300, 200)).toBe(100)
    expect(relativePct(null, 200)).toBe(0)
    expect(relativePct(5, 0)).toBe(0)
  })
})

describe('compositionSegments (AC-3)', () => {
  const p = (pid: number, name: string, rss: number | null) => ({
    pid,
    name,
    cpuPct: 0,
    rssBytes: rss
  })
  it('lists own first, then children by size, widths relative to the session total', () => {
    const segs = compositionSegments(940, 85, [
      p(1, 'node', 184),
      p(2, 'claude', 612),
      p(3, 'bash', 21)
    ])
    expect(segs.map((s) => s.label)).toEqual(['own', 'claude', 'node', 'bash'])
    expect(segs[0].isSelf).toBe(true)
    expect(segs[1].pct).toBeCloseTo((612 / 940) * 100)
    expect(segs.map((s) => s.shade)).toEqual([0, 1, 2, 3])
  })
  it('folds everything past five entries into one "other" entry', () => {
    const procs = [1, 2, 3, 4, 5, 6].map((i) => p(i, `c${i}`, 10 * (7 - i)))
    const segs = compositionSegments(1000, 100, procs)
    expect(segs).toHaveLength(5)
    expect(segs[4].label).toBe('other')
    expect(segs[4].isOther).toBe(true)
    expect(segs[4].bytes).toBe(30 + 20 + 10)
  })
  it('omits an unknown own memory and unknown children instead of faking 0', () => {
    const segs = compositionSegments(500, null, [p(1, 'a', 300), p(2, 'b', null)])
    expect(segs.map((s) => s.label)).toEqual(['a'])
  })
  it('is empty when the session total is unknown', () => {
    expect(compositionSegments(null, 1, [p(1, 'a', 1)])).toEqual([])
  })
})

describe('sessionChildren (AC-5)', () => {
  it('puts the own-memory entry first, then children biggest first', () => {
    const rows = sessionChildren(
      sess({
        rssBytes: 900,
        cpuPct: 10,
        procs: [
          { pid: 2, name: 'small', cpuPct: 1, rssBytes: 100 },
          { pid: 3, name: 'big', cpuPct: 2, rssBytes: 600 }
        ]
      })
    )
    expect(rows.map((r) => r.name)).toEqual(['', 'big', 'small'])
    expect(rows[0]).toMatchObject({ isSelf: true, rssBytes: 200, cpuPct: 7 })
  })
  it('own memory is null — never 0 — when a child reading is unknown', () => {
    const rows = sessionChildren(
      sess({ rssBytes: 900, procs: [{ pid: 2, name: 'x', cpuPct: 1, rssBytes: null }] })
    )
    expect(rows[0].rssBytes).toBeNull()
  })
  it('has no entries when the session lists no children', () => {
    expect(sessionChildren(sess({ procs: [] }))).toEqual([])
  })
})

describe('sparklinePolylines', () => {
  it('scales to its own min–max inside a 1px inset, newest on the right', () => {
    const [line] = sparklinePolylines([0, 10, 5], 100, 20)
    expect(line.split(' ')).toEqual(['0.0,19.0', '50.0,1.0', '100.0,10.0'])
  })
  it('draws a flat series mid-height rather than dividing by zero', () => {
    const [line] = sparklinePolylines([4, 4, 4], 10, 10)
    expect(line.split(' ').every((pt) => pt.endsWith(',5.0'))).toBe(true)
  })
  it('draws nothing for fewer than two readings', () => {
    expect(sparklinePolylines([], 10, 10)).toEqual([])
    expect(sparklinePolylines([3], 10, 10)).toEqual([])
  })
  it('breaks the line at a null reading', () => {
    expect(sparklinePolylines([1, 2, null, 3, 4], 40, 10)).toHaveLength(2)
  })
})

describe('view mode persistence key (AC-4)', () => {
  it('uses an om2tab.* key and defaults to cards for anything unknown', () => {
    expect(MONITOR_VIEW_KEY.startsWith('om2tab.')).toBe(true)
    expect(parseMonitorView('table')).toBe('table')
    expect(parseMonitorView('cards')).toBe('cards')
    expect(parseMonitorView('grid')).toBe('cards')
    expect(parseMonitorView(null)).toBe('cards')
  })
})

describe('heap state classes (AC-8)', () => {
  it('keeps the thresholds the sampler uses', () => {
    expect(HEAP_WARN_PCT).toBe(70)
    expect(HEAP_CRIT_PCT).toBe(85)
  })
  it('ok is neutral, warn is --warning, critical is --red', () => {
    expect(monitorHeapFillClass('ok')).toBe('bg-text-3')
    expect(monitorHeapFillClass('warn')).toBe('bg-warning')
    expect(monitorHeapFillClass('critical')).toBe('bg-red')
    expect(monitorHeapTextClass('ok')).toBe('text-text')
    expect(monitorHeapTextClass('warn')).toBe('text-warning')
    expect(monitorHeapTextClass('critical')).toBe('text-red')
    expect(monitorHeapFillClass(undefined)).toBe('bg-text-3')
  })
})
