import { describe, it, expect, beforeEach } from 'vitest'
import {
  markInjectionEscalated,
  clearInjectionEscalation,
  getInjectionEscalations,
  _resetInjectionEscalations
} from '../src/main/mcp/injection-escalation-registry'

/**
 * BUG-64 (part C) — the main-side registry that lets `get_session`/`get_fleet`
 * learn a renderer-reported "prompt undelivered" verdict, instead of the
 * `inflightToFleetInputs`/`taskStateRecord` gap that used to make a stuck
 * session unconditionally report `active`/no-taskState forever.
 */

describe('injection-escalation-registry', () => {
  beforeEach(() => {
    _resetInjectionEscalations()
  })

  it('starts empty', () => {
    expect(getInjectionEscalations().size).toBe(0)
  })

  it('markInjectionEscalated records a reason + timestamp, readable by sessionId', () => {
    markInjectionEscalated('synthetic-a', 'prompt_undelivered', 1_700_000_000_000)
    const entry = getInjectionEscalations().get('synthetic-a')
    expect(entry).toEqual({ reason: 'prompt_undelivered', at: 1_700_000_000_000 })
  })

  it('defaults `at` to now when omitted', () => {
    const before = Date.now()
    markInjectionEscalated('synthetic-a', 'prompt_undelivered')
    const entry = getInjectionEscalations().get('synthetic-a')!
    expect(entry.at).toBeGreaterThanOrEqual(before)
  })

  it('a repeat mark for the same id replaces the prior entry', () => {
    markInjectionEscalated('synthetic-a', 'prompt_undelivered', 100)
    markInjectionEscalated('synthetic-a', 'prompt_undelivered', 200)
    expect(getInjectionEscalations().size).toBe(1)
    expect(getInjectionEscalations().get('synthetic-a')?.at).toBe(200)
  })

  it('independent entries for different session ids', () => {
    markInjectionEscalated('synthetic-a', 'prompt_undelivered')
    markInjectionEscalated('synthetic-b', 'prompt_undelivered')
    expect(getInjectionEscalations().size).toBe(2)
  })

  it('clearInjectionEscalation removes the entry — the retry-recovery path', () => {
    markInjectionEscalated('synthetic-a', 'prompt_undelivered')
    clearInjectionEscalation('synthetic-a')
    expect(getInjectionEscalations().has('synthetic-a')).toBe(false)
  })

  it('clearInjectionEscalation on an unknown id is a no-op, never throws', () => {
    expect(() => clearInjectionEscalation('never-marked')).not.toThrow()
    expect(getInjectionEscalations().size).toBe(0)
  })
})
