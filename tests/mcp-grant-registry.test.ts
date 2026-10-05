import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  createGrant,
  reserve,
  release,
  remainingFor,
  revokeGrant,
  _resetGrants
} from '../src/main/mcp/grant-registry'

/**
 * T77c — `remainingFor` is the race-free budget reader the server snapshots right
 * after `reserve` to echo the mission's remaining budget in a grant-allowed ACK.
 * Since spend is committed at reserve (refunded via release on failure), the reader
 * reflects this action's own spend the instant the reserve returns. Also exercises
 * the reserve/release/revoke atomicity the registry never had direct coverage for.
 */
const NOW = 1_000_000

function mkGrant(budget = 3) {
  return createGrant({
    goal: 'review PRs',
    folders: ['/home/u/repo'],
    verbs: ['create_worktree'],
    budget,
    ttlMinutes: 30,
    homeDir: '/home/u',
    now: NOW
  })
}

describe('grant-registry remainingFor', () => {
  beforeEach(() => _resetGrants())
  afterEach(() => _resetGrants())

  it('returns the full budget before any reserve', () => {
    const g = mkGrant(3)
    expect(remainingFor(g.id)).toBe(3)
  })

  it('drops by one per successful reserve (spend committed at reserve)', () => {
    const g = mkGrant(3)
    expect(reserve(g.id, NOW)).toBe(true)
    expect(remainingFor(g.id)).toBe(2)
    expect(reserve(g.id, NOW)).toBe(true)
    expect(remainingFor(g.id)).toBe(1)
  })

  it('exhausts at budget: reserve fails and remaining floors at 0', () => {
    const g = mkGrant(1)
    expect(reserve(g.id, NOW)).toBe(true)
    expect(remainingFor(g.id)).toBe(0)
    expect(reserve(g.id, NOW)).toBe(false) // no budget left → caller escalates
    expect(remainingFor(g.id)).toBe(0)
  })

  it('release refunds a reserved unit (commit only on success)', () => {
    const g = mkGrant(2)
    reserve(g.id, NOW)
    expect(remainingFor(g.id)).toBe(1)
    release(g.id)
    expect(remainingFor(g.id)).toBe(2)
  })

  it('a revoked grant blocks new reserves; remaining reflects committed spend only', () => {
    const g = mkGrant(3)
    reserve(g.id, NOW)
    expect(revokeGrant(g.id)).toBe(true)
    expect(reserve(g.id, NOW)).toBe(false)
    expect(remainingFor(g.id)).toBe(2)
  })

  it('returns 0 for an unknown/absent grant id', () => {
    expect(remainingFor('grant-nope')).toBe(0)
  })
})
