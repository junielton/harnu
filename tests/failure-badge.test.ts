import { describe, it, expect } from 'vitest'
import { failureBadge } from '../src/renderer/src/components/failure-badge'

const NOW = 1_700_000_000_000

describe('failureBadge', () => {
  it('returns null for no reason or an unknown reason (today’s plain failed dot)', () => {
    expect(failureBadge(undefined, undefined, NOW)).toBeNull()
    expect(failureBadge('unknown', undefined, NOW)).toBeNull()
  })

  it('rate_limit without resetsAt: warning badge, no countdown', () => {
    expect(failureBadge('rate_limit', undefined, NOW)).toEqual({
      labelKey: 'session.failure.rateLimit',
      variant: 'warning',
      countdownMs: null
    })
  })

  it('rate_limit with a future resetsAt: countdown in ms', () => {
    const b = failureBadge('rate_limit', NOW + 12 * 60_000, NOW)!
    expect(b.countdownMs).toBe(12 * 60_000)
    expect(b.variant).toBe('warning')
    expect(b.labelKey).toBe('session.failure.rateLimit')
  })

  it('rate_limit with a past or invalid resetsAt: no negative / NaN countdown', () => {
    expect(failureBadge('rate_limit', NOW - 5000, NOW)!.countdownMs).toBeNull()
    expect(failureBadge('rate_limit', NaN, NOW)!.countdownMs).toBeNull()
  })

  it('overloaded: warning, no countdown', () => {
    expect(failureBadge('overloaded', undefined, NOW)).toEqual({
      labelKey: 'session.failure.overloaded',
      variant: 'warning',
      countdownMs: null
    })
  })

  it('billing_error: red, no countdown', () => {
    expect(failureBadge('billing_error', undefined, NOW)).toEqual({
      labelKey: 'session.failure.billing',
      variant: 'red',
      countdownMs: null
    })
  })

  it('prompt_undelivered: red, no countdown (injection watchdog escalation)', () => {
    expect(failureBadge('prompt_undelivered', undefined, NOW)).toEqual({
      labelKey: 'session.failure.promptUndelivered',
      variant: 'red',
      countdownMs: null
    })
  })
})
