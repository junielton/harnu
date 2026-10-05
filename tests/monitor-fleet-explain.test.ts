import { describe, it, expect } from 'vitest'
import {
  explainFleet,
  DEFAULT_POLICY,
  type LiveSession,
  type Policy
} from '../src/main/fleet-policy'

const NOW = 1_700_000_000_000
const MIN = 60_000

const POLICY: Policy = { maxLive: 5, lruIdleMs: 15 * MIN, hardIdleMs: 60 * MIN }

/** A session that IS a valid eviction candidate unless a field is overridden. Mirrors tests/fleet-policy.test.ts's fixture. */
function cold(key: string, idleMin: number, over: Partial<LiveSession> = {}): LiveSession {
  return {
    sessionKey: key,
    kind: 'claude-resume',
    taskState: 'idle',
    lastFocusedAt: NOW - idleMin * MIN,
    lastActivityAt: NOW - idleMin * MIN,
    isSelected: false,
    hasPendingApproval: false,
    ...over
  }
}

function explanationFor(
  sessionKey: string,
  fleet: LiveSession[]
): ReturnType<typeof explainFleet>[number] {
  const found = explainFleet(fleet, NOW, POLICY).find((e) => e.sessionKey === sessionKey)
  if (!found) throw new Error(`no explanation for ${sessionKey}`)
  return found
}

describe('explainFleet — reason classification', () => {
  it('a hot session (idle under both thresholds) is "active"', () => {
    const fleet = [cold('warm', 2)]
    expect(explanationFor('warm', fleet)).toMatchObject({
      parkable: true,
      reason: 'active',
      sweepRank: null
    })
  })

  it('idle past lruIdleMs but under hardIdleMs is "lru"', () => {
    const fleet = [cold('mid', 20)]
    expect(explanationFor('mid', fleet)).toMatchObject({ reason: 'lru', sweepRank: null })
  })

  it('idle past hardIdleMs is "hard-idle" and gets a sweepRank', () => {
    const fleet = [cold('rotten', 90)]
    expect(explanationFor('rotten', fleet)).toMatchObject({ reason: 'hard-idle', sweepRank: 1 })
  })

  it('a non-parkable kind is "not-parkable" regardless of coldness', () => {
    const fleet = [cold('synthetic-x', 999, { kind: 'claude-new' })]
    expect(explanationFor('synthetic-x', fleet)).toMatchObject({
      parkable: false,
      reason: 'not-parkable',
      sweepRank: null
    })
  })

  it('the selected session is "selected" even when ice-cold', () => {
    const fleet = [cold('sel', 999, { isSelected: true })]
    expect(explanationFor('sel', fleet)).toMatchObject({ reason: 'selected', sweepRank: null })
  })

  it('a session with a pending approval is "pending-approval" even when ice-cold', () => {
    const fleet = [cold('pending', 999, { hasPendingApproval: true })]
    expect(explanationFor('pending', fleet)).toMatchObject({
      reason: 'pending-approval',
      sweepRank: null
    })
  })

  it('idleMs reports the warmer-of-focus-and-pulse figure, same math as evaluateFleet', () => {
    const fleet = [cold('x', 10)]
    expect(explanationFor('x', fleet).idleMs).toBe(10 * MIN)
  })
})

describe('explainFleet — sweepRank orders coldest-first among hard-idle candidates only', () => {
  it('ranks hard-idle sessions coldest-first, starting at 1', () => {
    const fleet = [cold('a', 61), cold('b', 120), cold('c', 90)]
    const explained = explainFleet(fleet, NOW, POLICY)
    const rankOf = (key: string): number | null =>
      explained.find((e) => e.sessionKey === key)?.sweepRank ?? null
    expect(rankOf('b')).toBe(1) // coldest
    expect(rankOf('c')).toBe(2)
    expect(rankOf('a')).toBe(3) // warmest of the three, still hard-idle
  })

  it('an lru-only (not hard-idle) session never gets a sweepRank', () => {
    const fleet = [cold('lru-only', 20), cold('sweepable', 90)]
    expect(explanationFor('lru-only', fleet).sweepRank).toBeNull()
    expect(explanationFor('sweepable', fleet).sweepRank).toBe(1)
  })
})

describe('DEFAULT_POLICY sanity for explainFleet callers', () => {
  it('matches the constants explainFleet is exercised against elsewhere', () => {
    expect(DEFAULT_POLICY.lruIdleMs).toBe(15 * MIN)
    expect(DEFAULT_POLICY.hardIdleMs).toBe(60 * MIN)
  })
})
