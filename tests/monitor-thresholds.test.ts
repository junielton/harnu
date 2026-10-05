import { describe, it, expect } from 'vitest'
import { heapStatus, WARN_RATIO, CRITICAL_RATIO } from '../src/main/monitor/thresholds'

const LIMIT = 1_000_000

describe('heapStatus', () => {
  it('is ok below the warn ratio', () => {
    expect(heapStatus(LIMIT * (WARN_RATIO - 0.01), LIMIT)).toBe('ok')
  })

  it('is warn exactly at the warn ratio', () => {
    expect(heapStatus(LIMIT * WARN_RATIO, LIMIT)).toBe('warn')
  })

  it('is warn between the warn and critical ratios', () => {
    expect(heapStatus(LIMIT * (WARN_RATIO + 0.05), LIMIT)).toBe('warn')
  })

  it('is critical exactly at the critical ratio', () => {
    expect(heapStatus(LIMIT * CRITICAL_RATIO, LIMIT)).toBe('critical')
  })

  it('is critical above the critical ratio', () => {
    expect(heapStatus(LIMIT * 0.99, LIMIT)).toBe('critical')
  })

  it('treats a non-positive limit as ok rather than dividing by zero', () => {
    expect(heapStatus(500, 0)).toBe('ok')
    expect(heapStatus(500, -1)).toBe('ok')
  })
})
