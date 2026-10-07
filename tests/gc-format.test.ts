import { describe, it, expect } from 'vitest'
import { durationParts, nextCycleIn } from '../src/renderer/src/lib/gc-format'

describe('durationParts', () => {
  it('picks the coarsest whole unit', () => {
    expect(durationParts(42 * 60_000)).toEqual({ unit: 'minute', n: 42 })
    expect(durationParts(3_600_000)).toEqual({ unit: 'hour', n: 1 })
    expect(durationParts(6 * 3_600_000)).toEqual({ unit: 'hour', n: 6 })
    expect(durationParts(86_400_000)).toEqual({ unit: 'day', n: 1 })
  })
  it('never says 0 minutes and survives junk', () => {
    expect(durationParts(1_000)).toEqual({ unit: 'minute', n: 1 })
    expect(durationParts(Number.NaN)).toEqual({ unit: 'minute', n: 1 })
    expect(durationParts(-5)).toEqual({ unit: 'minute', n: 1 })
  })
})

describe('nextCycleIn', () => {
  it('is null when the timer is off', () => {
    expect(nextCycleIn(null, 1000)).toBeNull()
  })
  it('measures from now and clamps a passed time to the minimum', () => {
    expect(nextCycleIn(10_000 + 42 * 60_000, 10_000)).toEqual({ unit: 'minute', n: 42 })
    expect(nextCycleIn(5_000, 10_000)).toEqual({ unit: 'minute', n: 1 })
  })
})
