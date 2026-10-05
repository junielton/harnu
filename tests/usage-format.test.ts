import { describe, it, expect } from 'vitest'
import {
  clampPct,
  barClass,
  contextIsSignal,
  contextTextClass,
  footerPctClass,
  humanizeDuration,
  resetDisplay,
  footerWindowCountdown,
  formatCostUsd,
  formatLines,
  mergeRateWindows
} from '../src/renderer/src/components/usage-format'
import type { FleetTelemetry } from '../src/main/statusline-parse'
import type { UsageSnapshot } from '../src/main/usage-parse'

describe('clampPct', () => {
  it('clamps into 0..100', () => {
    expect(clampPct(-5)).toBe(0)
    expect(clampPct(150)).toBe(100)
    expect(clampPct(42)).toBe(42)
  })
  it('treats non-finite as 0 (garbage → empty bar, not a full one)', () => {
    expect(clampPct(NaN)).toBe(0)
    expect(clampPct(Infinity)).toBe(0)
  })
})

describe('barClass', () => {
  it('is green below 80%', () => {
    expect(barClass(0)).toBe('bg-green')
    expect(barClass(79.9)).toBe('bg-green')
  })
  it('is accent in the 80–95% warn band', () => {
    expect(barClass(80)).toBe('bg-accent')
    expect(barClass(94)).toBe('bg-accent')
  })
  it('is red at/above 95%', () => {
    expect(barClass(95)).toBe('bg-red')
    expect(barClass(100)).toBe('bg-red')
  })
})

describe('contextTextClass (muted sidebar variant)', () => {
  it('stays muted below 80%', () => {
    expect(contextTextClass(0)).toBe('text-text-4')
    expect(contextTextClass(79.9)).toBe('text-text-4')
  })
  it('signals accent/red near the cap', () => {
    expect(contextTextClass(80)).toBe('text-accent')
    expect(contextTextClass(95)).toBe('text-red')
  })
})

describe('contextIsSignal (hover-only sidebar chip pin — T118)', () => {
  it('is quiet (hover-only) below 80%', () => {
    expect(contextIsSignal(0)).toBe(false)
    expect(contextIsSignal(79.9)).toBe(false)
  })
  it('pins the chip visible at/above 80% — same breakpoint contextTextClass colors at', () => {
    expect(contextIsSignal(80)).toBe(true)
    expect(contextIsSignal(95)).toBe(true)
  })
})

describe('footerPctClass (bright HUD variant)', () => {
  it('reads at the HUD tone below 80% — not muted', () => {
    expect(footerPctClass(0)).toBe('text-text-2')
    expect(footerPctClass(5)).toBe('text-text-2')
    expect(footerPctClass(79.9)).toBe('text-text-2')
  })
  it('diverges to a signal color near the cap, same 80/95 breakpoints as barClass', () => {
    expect(footerPctClass(80)).toBe('text-accent')
    expect(footerPctClass(94)).toBe('text-accent')
    expect(footerPctClass(95)).toBe('text-red')
    expect(footerPctClass(100)).toBe('text-red')
  })
})

describe('humanizeDuration', () => {
  it('uses minutes under an hour', () => {
    expect(humanizeDuration(57 * 60_000)).toBe('57m')
  })
  it('rounds sub-minute down to <1m', () => {
    expect(humanizeDuration(30_000)).toBe('<1m')
  })
  it('uses hours under a day', () => {
    expect(humanizeDuration(90 * 60_000)).toBe('1h')
  })
  it('uses days beyond 24h', () => {
    expect(humanizeDuration(4 * 24 * 3600_000)).toBe('4d')
    expect(humanizeDuration(25 * 3600_000)).toBe('1d')
  })
  it('clamps non-positive to 0m', () => {
    expect(humanizeDuration(0)).toBe('0m')
    expect(humanizeDuration(-100)).toBe('0m')
  })
})

describe('resetDisplay', () => {
  const NOW = 1_000_000

  it('returns a relative countdown with the raw text as the title when the reset is in the future', () => {
    const d = resetDisplay(NOW + 57 * 60_000, 'Jun 10, 8:40pm (America/Sao_Paulo)', NOW)
    expect(d).toEqual({
      kind: 'relative',
      time: '57m',
      title: 'Jun 10, 8:40pm (America/Sao_Paulo)'
    })
  })

  it('falls back to the absolute text when there is no parsed timestamp', () => {
    const d = resetDisplay(null, 'Jun 15, 4pm', NOW)
    expect(d).toEqual({ kind: 'absolute', text: 'Jun 15, 4pm' })
  })

  it('falls back to absolute when the parsed reset is already in the past', () => {
    const d = resetDisplay(NOW - 5000, 'Jun 15, 4pm', NOW)
    expect(d).toEqual({ kind: 'absolute', text: 'Jun 15, 4pm' })
  })

  it('returns none when there is neither a timestamp nor text', () => {
    expect(resetDisplay(null, '', NOW)).toEqual({ kind: 'none' })
  })
})

describe('footerWindowCountdown', () => {
  const NOW = 1_000_000

  it('renders the humanized time remaining when the reset is in the future', () => {
    expect(footerWindowCountdown(NOW + 90 * 60_000, NOW)).toBe('1h')
    expect(footerWindowCountdown(NOW + 4 * 24 * 3600_000, NOW)).toBe('4d')
  })
  it('returns null when there is no reset timestamp (degrade to the plain chip)', () => {
    expect(footerWindowCountdown(null, NOW)).toBeNull()
  })
  it('returns null when the reset has already passed (no stale 0m/<1m countdown)', () => {
    expect(footerWindowCountdown(NOW - 5000, NOW)).toBeNull()
    expect(footerWindowCountdown(NOW, NOW)).toBeNull()
  })
  it('renders <1m for a reset under a minute away', () => {
    expect(footerWindowCountdown(NOW + 30_000, NOW)).toBe('<1m')
  })
})

describe('formatCostUsd', () => {
  it('formats a cost to two decimals with a dollar sign', () => {
    expect(formatCostUsd(0.01234)).toBe('$0.01')
    expect(formatCostUsd(1.5)).toBe('$1.50')
    expect(formatCostUsd(0)).toBe('$0.00')
  })
  it('treats null / non-finite as $0.00 (no NaN leaking into the UI)', () => {
    expect(formatCostUsd(null)).toBe('$0.00')
    expect(formatCostUsd(NaN)).toBe('$0.00')
    expect(formatCostUsd(Infinity)).toBe('$0.00')
  })
})

describe('formatLines', () => {
  it('formats added/removed line counts', () => {
    expect(formatLines(156, 23)).toBe('+156/-23')
    expect(formatLines(0, 0)).toBe('+0/-0')
  })
  it('treats null as 0', () => {
    expect(formatLines(null, null)).toBe('+0/-0')
    expect(formatLines(12, null)).toBe('+12/-0')
  })
})

describe('mergeRateWindows (freshest source per window)', () => {
  const NOW = 1_750_000_000_000
  const FUTURE = NOW + 3_600_000
  const PAST = NOW - 60_000

  function fleet(over: Partial<FleetTelemetry> = {}): FleetTelemetry {
    return {
      totalCostUsd: 0,
      sessionCount: 1,
      fiveHour: null,
      sevenDay: null,
      fiveHourAtMs: null,
      sevenDayAtMs: null,
      ...over
    }
  }

  function snap(over: Partial<UsageSnapshot> = {}): UsageSnapshot {
    return {
      available: true,
      subscription: true,
      session: { key: 'session', usedPercent: 39, resetsAtText: 'Jun 10, 8pm', resetsAtMs: FUTURE },
      weekAll: {
        key: 'week_all',
        usedPercent: 11,
        resetsAtText: 'Jun 15, 4pm',
        resetsAtMs: FUTURE
      },
      perModel: [],
      fetchedAtMs: NOW - 30_000,
      stale: false,
      status: 'ready',
      ...over
    }
  }

  it('returns nulls when there is no source at all', () => {
    expect(mergeRateWindows(null, null, NOW)).toEqual({ fiveHour: null, sevenDay: null })
  })

  it('uses the /usage buckets when the cockpit has not reported (cold start)', () => {
    const m = mergeRateWindows(fleet(), snap(), NOW)
    expect(m.fiveHour?.usedPercent).toBe(39)
    expect(m.fiveHour?.source).toBe('usage')
    expect(m.fiveHour?.resetsAtText).toBe('Jun 10, 8pm')
    expect(m.sevenDay?.usedPercent).toBe(11)
  })

  it('a fresher cockpit window beats an older /usage poll', () => {
    const f = fleet({
      fiveHour: { usedPercent: 55, resetsAtMs: FUTURE },
      fiveHourAtMs: NOW - 1_000
    })
    const m = mergeRateWindows(f, snap(), NOW)
    expect(m.fiveHour?.usedPercent).toBe(55)
    expect(m.fiveHour?.source).toBe('statusline')
    // 7d: cockpit never reported it → /usage still fills the row
    expect(m.sevenDay?.source).toBe('usage')
  })

  it('a fresher /usage poll beats a frozen cockpit (the staleness bug)', () => {
    const f = fleet({
      fiveHour: { usedPercent: 74, resetsAtMs: FUTURE },
      fiveHourAtMs: NOW - 6 * 3_600_000 // cockpit frozen for 6h
    })
    const m = mergeRateWindows(f, snap(), NOW)
    expect(m.fiveHour?.usedPercent).toBe(39)
    expect(m.fiveHour?.source).toBe('usage')
  })

  it('a window past its reset moment does not compete (its % is definitionally stale)', () => {
    const f = fleet({
      fiveHour: { usedPercent: 90, resetsAtMs: PAST }, // already reset — 90% is a lie
      fiveHourAtMs: NOW - 1_000 // even though it is the "freshest" datum
    })
    const m = mergeRateWindows(f, snap(), NOW)
    expect(m.fiveHour?.usedPercent).toBe(39)
    expect(m.fiveHour?.source).toBe('usage')
  })

  it('when every candidate is past its reset, still shows the freshest (last known)', () => {
    const f = fleet({
      fiveHour: { usedPercent: 90, resetsAtMs: PAST },
      fiveHourAtMs: NOW - 1_000
    })
    const s = snap({
      session: { key: 'session', usedPercent: 39, resetsAtText: '', resetsAtMs: PAST },
      weekAll: null
    })
    const m = mergeRateWindows(f, s, NOW)
    expect(m.fiveHour?.usedPercent).toBe(90)
    expect(m.fiveHour?.source).toBe('statusline')
  })

  it('an unavailable snapshot contributes nothing', () => {
    const s = snap({ available: false, session: null, weekAll: null })
    expect(mergeRateWindows(fleet(), s, NOW)).toEqual({ fiveHour: null, sevenDay: null })
  })

  it('a null resets moment is treated as live (never discards for lack of data)', () => {
    const f = fleet({
      fiveHour: { usedPercent: 20, resetsAtMs: null },
      fiveHourAtMs: NOW
    })
    const m = mergeRateWindows(f, null, NOW)
    expect(m.fiveHour?.usedPercent).toBe(20)
  })
})
