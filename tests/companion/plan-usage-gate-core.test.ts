import { describe, expect, it } from 'vitest'
import { PLAN_USAGE_STALE_MS } from '../../src/main/companion/contract'
import {
  emptyGate,
  noteReading,
  shouldPoll
} from '../../src/main/companion/ingest/plan-usage-gate-core'

const NOW = 1_790_000_000_000

describe('plan-usage gate core (spec P1W6 §7.4)', () => {
  it('starts open: no leased reading means the poll runs', () => {
    expect(shouldPoll(emptyGate(), NOW)).toBe(true)
  })

  it('only owned readings suppress (AC-P1W6-13)', () => {
    // a reading from a session in shadow (or off, or without a lease): not owned
    const shadow = noteReading(emptyGate(), { owned: false, windows: 2, hostNow: NOW })
    expect(shadow).toEqual(emptyGate())
    expect(shouldPoll(shadow, NOW)).toBe(true)
    const owned = noteReading(emptyGate(), { owned: true, windows: 2, hostNow: NOW })
    expect(shouldPoll(owned, NOW + 1_000)).toBe(false)
  })

  it('a reading with no known window is not a reading (rateLimits [] on resume, API-key users)', () => {
    const s = noteReading(emptyGate(), { owned: true, windows: 0, hostNow: NOW })
    expect(s).toEqual(emptyGate())
    expect(shouldPoll(s, NOW)).toBe(true)
  })

  it('goes stale strictly after PLAN_USAGE_STALE_MS (90 s)', () => {
    expect(PLAN_USAGE_STALE_MS).toBe(90_000)
    const s = noteReading(emptyGate(), { owned: true, windows: 1, hostNow: NOW })
    expect(shouldPoll(s, NOW + 30_000)).toBe(false)
    expect(shouldPoll(s, NOW + PLAN_USAGE_STALE_MS)).toBe(false)
    expect(shouldPoll(s, NOW + PLAN_USAGE_STALE_MS + 1)).toBe(true)
    expect(shouldPoll(s, NOW + 91_000)).toBe(true)
  })

  it('advances to the newest reading and never moves back', () => {
    let s = noteReading(emptyGate(), { owned: true, windows: 1, hostNow: NOW })
    s = noteReading(s, { owned: true, windows: 1, hostNow: NOW + 60_000 })
    expect(s.lastLeasedReadingAt).toBe(NOW + 60_000)
    s = noteReading(s, { owned: true, windows: 1, hostNow: NOW + 10_000 })
    expect(s.lastLeasedReadingAt).toBe(NOW + 60_000)
    // an ineligible reading never refreshes the clock either
    s = noteReading(s, { owned: false, windows: 2, hostNow: NOW + 80_000 })
    expect(s.lastLeasedReadingAt).toBe(NOW + 60_000)
  })

  it('a clock that went backwards is not a reason to skip the poll for hours', () => {
    const s = noteReading(emptyGate(), { owned: true, windows: 1, hostNow: NOW })
    expect(shouldPoll(s, NOW - 3_600_000)).toBe(true)
  })

  it('uses the value it is given and never mutates its input', () => {
    const before = emptyGate()
    noteReading(before, { owned: true, windows: 1, hostNow: NOW })
    expect(before).toEqual({ lastLeasedReadingAt: null })
  })
})
