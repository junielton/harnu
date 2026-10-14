/**
 * T484 (agent terminals B6) — the pure lease / cooldown table with an injected clock
 * (AC-B6-4, AC-B6-5): what ends a lease, what extends it, and that a Deny is a cooldown.
 */
import { describe, it, expect } from 'vitest'
import { DENY_COOLDOWN_MS, LEASE_IDLE_MS, TerminalLeases } from '../src/main/terminal-lease'

function table(): { leases: TerminalLeases; clock: { t: number } } {
  const clock = { t: 1_000 }
  return { leases: new TerminalLeases(() => clock.t), clock }
}

describe('lease lifetime', () => {
  it('is active right after the grant and absent before it', () => {
    const { leases } = table()
    expect(leases.isActive('h-1')).toBe(false)
    leases.grant('h-1', '/work/app')
    expect(leases.isActive('h-1')).toBe(true)
  })

  it('is per terminal: a lease on one covers no other', () => {
    const { leases } = table()
    leases.grant('h-1', '/work/app')
    expect(leases.isActive('h-2')).toBe(false)
  })

  it('ends 10 minutes after the grant when nothing is written', () => {
    const { leases, clock } = table()
    leases.grant('h-1', '/work/app')
    clock.t += LEASE_IDLE_MS - 1
    expect(leases.isActive('h-1')).toBe(true)
    clock.t += 1
    expect(leases.isActive('h-1')).toBe(false)
  })

  it('ends 10 minutes after the LAST write, so a write extends it', () => {
    const { leases, clock } = table()
    leases.grant('h-1', '/work/app')
    clock.t += LEASE_IDLE_MS - 1_000
    leases.noteWrite('h-1')
    clock.t += LEASE_IDLE_MS - 1_000
    expect(leases.isActive('h-1')).toBe(true)
    clock.t += 1_000
    expect(leases.isActive('h-1')).toBe(false)
  })

  it('a write to a terminal with no lease creates none', () => {
    const { leases } = table()
    leases.noteWrite('h-1')
    expect(leases.isActive('h-1')).toBe(false)
  })

  it('an expired lease stays gone: a later write does not revive it', () => {
    const { leases, clock } = table()
    leases.grant('h-1', '/work/app')
    clock.t += LEASE_IDLE_MS
    expect(leases.isActive('h-1')).toBe(false)
    leases.noteWrite('h-1')
    expect(leases.isActive('h-1')).toBe(false)
  })
})

describe('explicit endings', () => {
  it('revoke ends one terminal', () => {
    const { leases } = table()
    leases.grant('h-1', '/work/app')
    leases.grant('h-2', '/work/app')
    leases.revoke('h-1')
    expect(leases.activeIds()).toEqual(['h-2'])
  })

  it('revokeUnder ends the folder and everything below it, nothing beside it', () => {
    const { leases } = table()
    leases.grant('h-repo', '/work/app')
    leases.grant('h-wt', '/work/app/.claude/worktrees/wt')
    leases.grant('h-sibling', '/work/app-two')
    leases.grant('h-other', '/work/other')
    leases.revokeUnder('/work/app')
    expect(leases.activeIds().sort()).toEqual(['h-other', 'h-sibling'])
  })

  it('revokeAll ends every lease (app quit, control server stopped)', () => {
    const { leases } = table()
    leases.grant('h-1', '/a')
    leases.grant('h-2', '/b')
    leases.revokeAll()
    expect(leases.activeIds()).toEqual([])
  })

  it('prune forgets terminals the registry no longer holds', () => {
    const { leases } = table()
    leases.grant('h-1', '/a')
    leases.grant('h-2', '/b')
    leases.deny('h-3')
    leases.prune((id) => id === 'h-2')
    expect(leases.activeIds()).toEqual(['h-2'])
    expect(leases.isDenied('h-3')).toBe(false)
  })
})

describe('Deny cooldown', () => {
  it('refuses for 5 minutes, then stops', () => {
    const { leases, clock } = table()
    leases.deny('h-1')
    expect(leases.isDenied('h-1')).toBe(true)
    clock.t += DENY_COOLDOWN_MS - 1
    expect(leases.isDenied('h-1')).toBe(true)
    clock.t += 1
    expect(leases.isDenied('h-1')).toBe(false)
  })

  it('a Deny also drops a lease the terminal held', () => {
    const { leases } = table()
    leases.grant('h-1', '/a')
    leases.deny('h-1')
    expect(leases.isActive('h-1')).toBe(false)
  })

  it('a later Allow overrides the cooldown', () => {
    const { leases } = table()
    leases.deny('h-1')
    leases.grant('h-1', '/a')
    expect(leases.isDenied('h-1')).toBe(false)
    expect(leases.isActive('h-1')).toBe(true)
  })

  it('is per terminal', () => {
    const { leases } = table()
    leases.deny('h-1')
    expect(leases.isDenied('h-2')).toBe(false)
  })
})
