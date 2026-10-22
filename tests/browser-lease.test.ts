/**
 * T571 (browser pane U4, AC-2) — the browser lease and Deny cooldown table (spec §7.1), the `send_terminal` model
 * applied to a pane: 10 minutes idle, 5 minutes deny, bound to one view, ended by close/Disconnect/block/opt-out.
 */
import { describe, it, expect } from 'vitest'
import { BrowserLeases, DENY_COOLDOWN_MS, LEASE_IDLE_MS } from '../src/main/browser/lease'

function rig() {
  let clock = 1_000
  const leases = new BrowserLeases(() => clock)
  return { leases, tick: (ms: number) => (clock += ms) }
}

describe('BrowserLeases', () => {
  it('is inactive until granted, and active for the granted view only', () => {
    const { leases } = rig()
    expect(leases.isActive('bp-1', 'v1')).toBe(false)
    leases.grant('bp-1', '/work/app', 'v1')
    expect(leases.isActive('bp-1', 'v1')).toBe(true)
    // A pane re-created under the same id is a page the operator never saw.
    expect(leases.isActive('bp-1', 'v2')).toBe(false)
    expect(leases.isActive('bp-1', 'v1')).toBe(false)
  })

  it('idles out 10 minutes after the last agent write, and a write restarts the clock', () => {
    const { leases, tick } = rig()
    leases.grant('bp-1', '/w', 'v1')
    tick(LEASE_IDLE_MS - 1)
    leases.noteWrite('bp-1')
    tick(LEASE_IDLE_MS - 1)
    expect(leases.isActive('bp-1', 'v1')).toBe(true)
    tick(2)
    expect(leases.isActive('bp-1', 'v1')).toBe(false)
  })

  it('noteWrite without a lease does nothing', () => {
    const { leases } = rig()
    leases.noteWrite('bp-1')
    expect(leases.idleEndsAt('bp-1')).toBeNull()
  })

  it('a Deny refuses for 5 minutes, ends a lease, and an Allow overrides it', () => {
    const { leases, tick } = rig()
    leases.grant('bp-1', '/w', 'v1')
    leases.deny('bp-1')
    expect(leases.isActive('bp-1', 'v1')).toBe(false)
    expect(leases.isDenied('bp-1')).toBe(true)
    tick(DENY_COOLDOWN_MS - 1)
    expect(leases.isDenied('bp-1')).toBe(true)
    tick(2)
    expect(leases.isDenied('bp-1')).toBe(false)
    leases.deny('bp-1')
    leases.grant('bp-1', '/w', 'v1')
    expect(leases.isDenied('bp-1')).toBe(false)
  })

  it('ends on revoke, folder block (and below), exact-folder opt-out, revokeAll, forget and prune', () => {
    const { leases } = rig()
    for (const [id, folder] of [
      ['a', '/work/app'],
      ['b', '/work/app/sub'],
      ['c', '/other']
    ] as const)
      leases.grant(id, folder, 'v')
    leases.revokeFolder('/work/app')
    expect(leases.activeIds().sort()).toEqual(['b', 'c'])
    leases.revokeUnder('/work/app')
    expect(leases.activeIds()).toEqual(['c'])
    leases.grant('a', '/work/app', 'v')
    leases.revoke('a')
    expect(leases.isActive('a', 'v')).toBe(false)
    leases.revokeAll()
    expect(leases.activeIds()).toEqual([])
    leases.grant('d', '/x', 'v')
    leases.deny('e')
    leases.prune(() => false)
    expect(leases.activeIds()).toEqual([])
    expect(leases.isDenied('e')).toBe(false)
    leases.deny('f')
    leases.forget('f')
    expect(leases.isDenied('f')).toBe(false)
  })

  it('tells listeners when a lease starts or ends, and survives a throwing listener', () => {
    const { leases } = rig()
    const seen: string[] = []
    leases.onChange(() => {
      throw new Error('display only')
    })
    const off = leases.onChange((id) => seen.push(id))
    leases.grant('bp-1', '/w', 'v1')
    leases.revoke('bp-1')
    expect(seen).toEqual(['bp-1', 'bp-1'])
    off()
    leases.grant('bp-2', '/w', 'v1')
    expect(seen).toHaveLength(2)
    expect(leases.isActive('bp-2', 'v1')).toBe(true)
  })
})
