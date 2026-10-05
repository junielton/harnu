import { describe, it, expect } from 'vitest'
import { outcomeToStatus } from '../src/main/mcp/approval-status'

/**
 * T44 S4 — pure outcome→status projection for the async `get_approval` read.
 * allow (only from a human RESPONDED) → allowed (+result); every deny → denied
 * (+reason). Never pending/unknown (those are stash states the shell owns).
 */
describe('outcomeToStatus', () => {
  it('allow → allowed, carrying the mutation result', () => {
    expect(
      outcomeToStatus({ verdict: 'allow', reason: 'RESPONDED' }, { ok: true, path: '/x' })
    ).toEqual({
      status: 'allowed',
      result: { ok: true, path: '/x' }
    })
  })

  it('allow with no result → allowed without a result field', () => {
    expect(outcomeToStatus({ verdict: 'allow', reason: 'RESPONDED' })).toEqual({
      status: 'allowed'
    })
  })

  it('deny (operator) → denied with the reason', () => {
    expect(outcomeToStatus({ verdict: 'deny', reason: 'RESPONDED' })).toEqual({
      status: 'denied',
      reason: 'RESPONDED'
    })
  })

  it('deny (fail-closed TTL) → denied with the reason', () => {
    expect(outcomeToStatus({ verdict: 'deny', reason: 'TTL_EXPIRED' })).toEqual({
      status: 'denied',
      reason: 'TTL_EXPIRED'
    })
  })

  it('never returns allowed for a deny, even if a result is passed', () => {
    const r = outcomeToStatus({ verdict: 'deny', reason: 'CANCELLED' }, { ok: true })
    expect(r.status).toBe('denied')
    expect('result' in r).toBe(false)
  })
})
