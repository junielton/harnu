import { describe, it, expect } from 'vitest'
import {
  evaluateFleet,
  explainFleet,
  parkCandidates,
  type LiveSession,
  type Policy
} from '../src/main/fleet-policy'

/**
 * T456 W1 (spec §6.5): a session inside a granted delay is `declined` — not a victim of either
 * trigger, and labelled so the System Monitor can say why. The episode rides on `LiveSession` as
 * one more optional field, so every caller that predates it keeps its exact behavior.
 */

const NOW = 1_700_000_000_000
const MIN = 60_000
const POLICY: Policy = { maxLive: 2, lruIdleMs: 15 * MIN, hardIdleMs: 60 * MIN }

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

const deferred = { firstDeclineAt: NOW - MIN, declines: 1, until: NOW + 9 * MIN, reasons: ['x'] }
const lapsed = { ...deferred, until: NOW - 1 }

describe('explainFleet — the declined reason', () => {
  it('a hard-idle session inside its granted delay reads declined, with no sweep rank', () => {
    const [e] = explainFleet([cold('a', 90, { episode: deferred })], NOW, POLICY)
    expect(e).toMatchObject({ reason: 'declined', sweepRank: null })
  })

  it('an lru-cold session inside its granted delay reads declined', () => {
    const [e] = explainFleet([cold('a', 20, { episode: deferred })], NOW, POLICY)
    expect(e.reason).toBe('declined')
  })

  it('a warm session keeps reading active even with an open episode', () => {
    const [e] = explainFleet([cold('a', 1, { episode: deferred })], NOW, POLICY)
    expect(e.reason).toBe('active')
  })

  it('a lapsed delay is a candidate again (asked again at the next check)', () => {
    const [e] = explainFleet([cold('a', 90, { episode: lapsed })], NOW, POLICY)
    expect(e).toMatchObject({ reason: 'hard-idle', sweepRank: 1 })
  })

  it('sits after mission-owner and selected', () => {
    const fleet = [
      cold('m', 90, { episode: deferred, ownsLiveMission: true }),
      cold('s', 90, { episode: deferred, isSelected: true })
    ]
    expect(explainFleet(fleet, NOW, POLICY).map((e) => e.reason)).toEqual([
      'mission-owner',
      'selected'
    ])
  })
})

describe('evaluateFleet and parkCandidates skip a declined session', () => {
  it('sweep passes over it', () => {
    const fleet = [cold('a', 90, { episode: deferred }), cold('b', 80)]
    expect(evaluateFleet(fleet, NOW, POLICY, 'sweep')).toEqual(['b'])
  })

  it('cap passes over it to the next candidate', () => {
    const fleet = [cold('a', 50, { episode: deferred }), cold('b', 40), cold('c', 1)]
    expect(evaluateFleet(fleet, NOW, POLICY, 'cap')).toEqual(['b'])
  })

  it('parkCandidates lists every cap candidate coldest first, with the slots to free', () => {
    const fleet = [cold('a', 50), cold('b', 40), cold('c', 30), cold('d', 1)]
    expect(parkCandidates(fleet, NOW, POLICY, 'cap')).toEqual({
      candidates: ['a', 'b', 'c'],
      slots: 3
    })
  })

  it('parkCandidates under the cap names nobody', () => {
    expect(parkCandidates([cold('a', 50)], NOW, POLICY, 'cap')).toEqual({
      candidates: [],
      slots: 0
    })
  })

  it('parkCandidates for the sweep is every hard-idle session', () => {
    const fleet = [cold('a', 61), cold('b', 90), cold('c', 30)]
    expect(parkCandidates(fleet, NOW, POLICY, 'sweep')).toEqual({
      candidates: ['b', 'a'],
      slots: 2
    })
  })
})
