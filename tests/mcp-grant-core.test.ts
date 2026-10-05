import { describe, it, expect } from 'vitest'
import {
  grantDecision,
  isLive,
  remaining,
  inFolderScope,
  buildGrantDisclosureText,
  augmentAckWithGrant,
  type MissionGrant
} from '../src/main/mcp/grant-core'

/**
 * T44 S5 — pure mission-grant decision core (the security heart). Verifies the
 * §0 invariants: scoped, bounded (budget + TTL → escalate), revocable, and
 * escalation-not-denial. `now`/`homeDir` are injected so it's deterministic.
 */

const HOME = '/home/u'
const NOW = 1_000_000

const grant = (over: Partial<MissionGrant> = {}): MissionGrant => ({
  id: 'g1',
  goal: 'review PRs',
  folders: ['/home/u/repo'],
  dynamicFolders: [],
  verbs: ['create_worktree'],
  budget: 5,
  spent: 0,
  expiresAt: NOW + 60_000,
  createdAt: NOW - 1000,
  revoked: false,
  ...over
})

describe('isLive / remaining', () => {
  it('live when not revoked, unexpired, budget left', () => {
    expect(isLive(grant(), NOW)).toBe(true)
  })
  it('dead when revoked', () => {
    expect(isLive(grant({ revoked: true }), NOW)).toBe(false)
  })
  it('dead when expired', () => {
    expect(isLive(grant({ expiresAt: NOW }), NOW)).toBe(false)
    expect(isLive(grant({ expiresAt: NOW - 1 }), NOW)).toBe(false)
  })
  it('dead when budget exhausted (spent >= budget)', () => {
    expect(isLive(grant({ spent: 5, budget: 5 }), NOW)).toBe(false)
    expect(remaining(grant({ spent: 5, budget: 5 }))).toBe(0)
    expect(remaining(grant({ spent: 2, budget: 5 }))).toBe(3)
  })
})

describe('inFolderScope', () => {
  it('matches the folder itself and descendants', () => {
    expect(inFolderScope('/home/u/repo', grant(), HOME)).toBe(true)
    expect(inFolderScope('/home/u/repo/sub/dir', grant(), HOME)).toBe(true)
  })
  it('rejects a sibling / outside folder', () => {
    expect(inFolderScope('/home/u/other', grant(), HOME)).toBe(false)
    expect(inFolderScope('/home/u/repository', grant(), HOME)).toBe(false) // prefix, not descendant
  })
  it('includes dynamicFolders (worktrees created in-grant, often outside the repo)', () => {
    const g = grant({ dynamicFolders: ['/tmp/wt/feat'] })
    expect(inFolderScope('/tmp/wt/feat', g, HOME)).toBe(true)
    expect(inFolderScope('/tmp/wt/feat/src', g, HOME)).toBe(true)
  })
})

describe('grantDecision', () => {
  const call = { folder: '/home/u/repo', verb: 'create_worktree' as const }

  it('none when no grant ambit covers the folder', () => {
    expect(
      grantDecision({ folder: '/elsewhere', verb: 'create_worktree' }, [grant()], NOW, HOME)
    ).toEqual({
      outcome: 'none'
    })
    expect(grantDecision(call, [], NOW, HOME)).toEqual({ outcome: 'none' })
  })

  it('allow when a live grant covers folder + verb', () => {
    expect(grantDecision(call, [grant()], NOW, HOME)).toEqual({ outcome: 'allow', grantId: 'g1' })
  })

  it('escalate out-of-scope when the folder is in ambit but the verb is not', () => {
    const g = grant({ verbs: ['create_session'] })
    expect(grantDecision(call, [g], NOW, HOME)).toEqual({
      outcome: 'escalate',
      reason: 'out-of-scope'
    })
  })

  it('escalate expired / exhausted / revoked when a verb-matching grant is dead', () => {
    expect(grantDecision(call, [grant({ expiresAt: NOW })], NOW, HOME)).toEqual({
      outcome: 'escalate',
      reason: 'expired'
    })
    expect(grantDecision(call, [grant({ spent: 5, budget: 5 })], NOW, HOME)).toEqual({
      outcome: 'escalate',
      reason: 'exhausted'
    })
    expect(grantDecision(call, [grant({ revoked: true })], NOW, HOME)).toEqual({
      outcome: 'escalate',
      reason: 'revoked'
    })
  })

  it('a live grant wins over a dead one for the same folder+verb', () => {
    const dead = grant({ id: 'dead', revoked: true })
    const live = grant({ id: 'live' })
    expect(grantDecision(call, [dead, live], NOW, HOME)).toEqual({
      outcome: 'allow',
      grantId: 'live'
    })
  })

  it('drains the soonest-to-expire live grant first (deterministic)', () => {
    const later = grant({ id: 'later', expiresAt: NOW + 120_000 })
    const sooner = grant({ id: 'sooner', expiresAt: NOW + 30_000 })
    expect(grantDecision(call, [later, sooner], NOW, HOME)).toEqual({
      outcome: 'allow',
      grantId: 'sooner'
    })
  })

  it('auto-allows a granted verb in a dynamic (in-grant-created) worktree', () => {
    const g = grant({ verbs: ['create_session'], dynamicFolders: ['/tmp/wt/pr-1'] })
    expect(
      grantDecision({ folder: '/tmp/wt/pr-1', verb: 'create_session' }, [g], NOW, HOME)
    ).toEqual({ outcome: 'allow', grantId: 'g1' })
  })
})

describe('buildGrantDisclosureText (verbatim, no summarization)', () => {
  it('shows the goal, every real folder + verb, and the exact bounds', () => {
    const text = buildGrantDisclosureText({
      goal: 'review 6 PRs',
      folders: ['/home/u/repo', '/tmp/wt/pr-1'],
      verbs: ['create_worktree', 'create_session'],
      budget: 12,
      ttlMinutes: 60
    })
    expect(text).toContain('review 6 PRs')
    expect(text).toContain('/home/u/repo')
    expect(text).toContain('/tmp/wt/pr-1') // every path, verbatim
    expect(text).toContain('create_worktree, create_session')
    expect(text).toContain('up to 12 actions')
    expect(text).toContain('60 min')
  })

  it('singularizes a budget of 1', () => {
    const text = buildGrantDisclosureText({
      goal: 'x',
      folders: ['/a'],
      verbs: ['adopt_folder'],
      budget: 1,
      ttlMinutes: 5
    })
    expect(text).toContain('up to 1 action,')
  })
})

/**
 * T77c — the grant-allowed ACK echoes the mission's remaining budget so an agent
 * acting under a grant has proprioception of what's left. `augmentAckWithGrant`
 * ONLY touches a success ACK (`ok:true`); everything else passes through by ref.
 */
describe('augmentAckWithGrant', () => {
  const info = { grantId: 'grant-2-abc', grantBudgetRemaining: 4 }

  it('adds grantId + grantBudgetRemaining to a success ACK', () => {
    const out = augmentAckWithGrant({ ok: true, op: 'create_worktree', path: '/wt/x' }, info)
    expect(out).toEqual({
      ok: true,
      op: 'create_worktree',
      path: '/wt/x',
      grantId: 'grant-2-abc',
      grantBudgetRemaining: 4
    })
  })

  it('carries a remaining of 0 (exhausted-after-this-action) faithfully', () => {
    const out = augmentAckWithGrant(
      { ok: true, op: 'create_session' },
      {
        grantId: 'g',
        grantBudgetRemaining: 0
      }
    ) as Record<string, unknown>
    expect(out.grantBudgetRemaining).toBe(0)
  })

  it('does not mutate the input payload (returns a fresh object)', () => {
    const input = { ok: true, op: 'adopt_folder' }
    const out = augmentAckWithGrant(input, info)
    expect(out).not.toBe(input)
    expect(input).toEqual({ ok: true, op: 'adopt_folder' }) // untouched
  })

  it('leaves an ok:false payload untouched (same reference)', () => {
    const input = { ok: false, op: 'create_worktree' }
    expect(augmentAckWithGrant(input, info)).toBe(input)
  })

  it('leaves a non-object / array / null payload untouched (same reference)', () => {
    const arr = [{ ok: true }]
    expect(augmentAckWithGrant('BAD_ARGS', info)).toBe('BAD_ARGS')
    expect(augmentAckWithGrant(arr, info)).toBe(arr)
    expect(augmentAckWithGrant(null, info)).toBe(null)
    expect(augmentAckWithGrant(undefined, info)).toBe(undefined)
  })

  it('leaves a payload without an explicit ok:true untouched', () => {
    const input = { op: 'create_worktree', path: '/wt/x' }
    expect(augmentAckWithGrant(input, info)).toBe(input)
  })
})
