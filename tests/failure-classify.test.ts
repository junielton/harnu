import { describe, it, expect } from 'vitest'
import { classifyFailure } from '../src/main/hook-state'

describe('classifyFailure', () => {
  it('maps the three known error types to themselves', () => {
    expect(classifyFailure('rate_limit')).toBe('rate_limit')
    expect(classifyFailure('overloaded')).toBe('overloaded')
    expect(classifyFailure('billing_error')).toBe('billing_error')
  })

  it('degrades anything unrecognized or absent to "unknown" without throwing', () => {
    for (const x of ['something_new', '', 'rate-limit', 'RateLimit', undefined, null, 42, {}]) {
      expect(classifyFailure(x)).toBe('unknown')
    }
  })
})
