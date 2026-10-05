import { describe, it, expect } from 'vitest'
import {
  isAwaitingReturn,
  selectForgotten,
  FORGOTTEN_THRESHOLD_MS,
  type ClosureCtx,
  type ClosureSession
} from '../src/renderer/src/stores/closure-core'

/**
 * T37 slice 1a — pure closure-axis predicate. Mirrors tests/attention.test.ts.
 * The "forgotten" set is needs-input ∧ not-viewed ∧ away ≥ threshold.
 */
const NOW = 1_000_000_000
const ctx = (over: Partial<ClosureCtx> = {}): ClosureCtx => ({
  nowMs: NOW,
  thresholdMs: 10 * 60_000,
  selectedId: null,
  lastViewedAt: () => NOW - 60 * 60_000, // an hour ago by default (so: away)
  isArchived: () => false,
  ...over
})
const sess = (over: Partial<ClosureSession> = {}): ClosureSession => ({
  sessionId: 's1',
  taskState: 'needs-input',
  ...over
})

describe('isAwaitingReturn', () => {
  it('forgotten when needs-input, unviewed past the threshold, not selected/archived', () => {
    expect(isAwaitingReturn(sess(), ctx())).toBe(true)
  })

  it('not forgotten unless taskState is needs-input', () => {
    expect(isAwaitingReturn(sess({ taskState: 'working' }), ctx())).toBe(false)
    expect(isAwaitingReturn(sess({ taskState: 'idle' }), ctx())).toBe(false)
    expect(isAwaitingReturn(sess({ taskState: undefined }), ctx())).toBe(false)
  })

  it('never nags the session you are currently viewing', () => {
    expect(isAwaitingReturn(sess({ sessionId: 's1' }), ctx({ selectedId: 's1' }))).toBe(false)
  })

  it('excludes archived sessions', () => {
    expect(isAwaitingReturn(sess(), ctx({ isArchived: () => true }))).toBe(false)
  })

  it('is not forgotten if you looked at it within the threshold', () => {
    // viewed 5 min ago, threshold 10 min → still fresh
    expect(isAwaitingReturn(sess(), ctx({ lastViewedAt: () => NOW - 5 * 60_000 }))).toBe(false)
    // exactly at the threshold → forgotten (>=)
    expect(isAwaitingReturn(sess(), ctx({ lastViewedAt: () => NOW - 10 * 60_000 }))).toBe(true)
  })
})

describe('selectForgotten', () => {
  it('returns only the forgotten sessions', () => {
    const all: ClosureSession[] = [
      sess({ sessionId: 'forgotten', taskState: 'needs-input' }),
      sess({ sessionId: 'working', taskState: 'working' }),
      sess({ sessionId: 'selected', taskState: 'needs-input' }),
      sess({ sessionId: 'fresh', taskState: 'needs-input' })
    ]
    const out = selectForgotten(
      all,
      ctx({
        selectedId: 'selected',
        lastViewedAt: (id) => (id === 'fresh' ? NOW - 60_000 : NOW - 60 * 60_000)
      })
    )
    expect(out.map((s) => s.sessionId)).toEqual(['forgotten'])
  })
})

describe('FORGOTTEN_THRESHOLD_MS', () => {
  it('is a sane default (10 minutes)', () => {
    expect(FORGOTTEN_THRESHOLD_MS).toBe(600_000)
  })
})
