/**
 * How the perf harness judges growth (T697 delta, AC-3b).
 *
 * A timing under the noise floor is not a measurement: dividing by a 3 ms small run turned a
 * linear job into a "16x" one on a quiet machine. Under the floor, growth is judged on the exact
 * counters (fs calls, field reads) instead of time.
 */

import { describe, expect, it } from 'vitest'
import {
  NOISE_FLOOR_MS,
  assembleCaseResult,
  violations,
  type Measurement,
  type SizeResult
} from './support/harness'
import { REFERENCE_SCALE } from './support/scale-fixture'

function size(
  factor: number,
  costMs: number,
  fsCalls: number,
  reads: number,
  completed = true
): SizeResult {
  const best: Measurement = {
    busyRunMs: 1,
    cpuMs: costMs,
    wallMs: costMs,
    costMs,
    fsCalls,
    completed
  }
  return { factor, spec: REFERENCE_SCALE, best, reads }
}

describe('harness growth judgement', () => {
  it('passes a 3 ms small run against a 60 ms reference run when the counters are linear', () => {
    const r = assembleCaseResult('case', size(0.25, 3, 251, 250), size(1, 60, 1001, 1000))
    expect(r.growth).toBeNull() // never a ratio over a timing under the floor
    expect(r.fsGrowth).toBeCloseTo(1001 / 251)
    expect(violations(r)).toEqual([])
  })

  it('fails a super-linear fs counter even when the small run is under the floor', () => {
    const r = assembleCaseResult('case', size(0.25, 3, 251, 0), size(1, 60, 4000, 0))
    expect(r.growth).toBeNull()
    expect(violations(r).join('\n')).toMatch(/filesystem calls grew/)
  })

  it('fails super-linear field reads even when the small run is under the floor', () => {
    const r = assembleCaseResult('case', size(0.25, 2, 0, 300), size(1, 40, 0, 3000))
    expect(violations(r).join('\n')).toMatch(/reads of fleet fields grew/)
  })

  it('still judges time when both runs are above the floor', () => {
    const r = assembleCaseResult(
      'case',
      size(0.25, NOISE_FLOOR_MS + 2, 0, 0),
      size(1, (NOISE_FLOOR_MS + 2) * 10, 0, 0)
    )
    expect(r.growth).toBeCloseTo(10)
    expect(violations(r).join('\n')).toMatch(/cost grew/)
  })

  it('does not judge time when the reference run is under the floor', () => {
    const r = assembleCaseResult('case', size(0.25, 1, 0, 0), size(1, NOISE_FLOOR_MS - 1, 0, 0))
    expect(r.growth).toBeNull()
    expect(violations(r)).toEqual([])
  })

  it('does not judge growth for a run that was cut off', () => {
    const r = assembleCaseResult('case', size(0.25, 20, 251, 0), size(1, 400, 4000, 0, false))
    expect(r.growth).toBeNull()
    expect(r.fsGrowth).toBeNull()
  })
})
