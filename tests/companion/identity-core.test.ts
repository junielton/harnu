import { describe, expect, it } from 'vitest'
import { classifyIdentity, mayAct, type IdentityFact } from '../../src/main/companion/identity-core'
import { enableFor, gateForCli, identityEnablePolicy } from '../../src/main/companion/enable-policy'
import type { BindingView } from '../../src/main/companion/session-table'

const SID = '11111111-1111-4111-8111-111111111111'
const base = {
  key: 'synthetic-aaaa',
  sid: SID,
  cause: 'spawn' as const,
  ownerKind: 'pty' as const,
  liveKeyForSid: null
}

describe('identity classification (IC)', () => {
  it('classification table', () => {
    // a synthetic row and a real sid: a claim
    expect(classifyIdentity(base)).toEqual({
      kind: 'claim',
      key: 'synthetic-aaaa',
      sid: SID,
      cause: 'spawn'
    })
    // the row is already keyed by that id (resume, wake): confirmed, nothing to claim
    expect(classifyIdentity({ ...base, key: SID })).toEqual({
      kind: 'confirmed',
      key: SID,
      sid: SID
    })
    // the sid is live under another key: a conflict, no claim
    expect(classifyIdentity({ ...base, liveKeyForSid: 'other-key' })).toEqual({
      kind: 'conflict',
      key: 'synthetic-aaaa',
      sid: SID,
      heldBy: 'other-key'
    })
    // a scheduler tick has no row; a PTY with no key yet has nothing to claim for
    expect(classifyIdentity({ ...base, ownerKind: 'tick', key: 'tick:w:r' })).toEqual({
      kind: 'none'
    })
    expect(classifyIdentity({ ...base, key: null })).toEqual({ kind: 'none' })
  })

  it('a rebound cause is carried onto the claim', () => {
    expect(classifyIdentity({ ...base, key: 'old-real-id', cause: 'clear' })).toMatchObject({
      kind: 'claim',
      cause: 'clear'
    })
  })

  it('the key that already holds the sid is not a conflict with itself', () => {
    expect(classifyIdentity({ ...base, key: SID, liveKeyForSid: SID })).toMatchObject({
      kind: 'confirmed'
    })
  })
})

describe('mayAct', () => {
  const claim: IdentityFact = { kind: 'claim', key: 'k', sid: SID, cause: 'spawn' }
  it('a claim acts only when owned (ARB-3)', () => {
    expect(mayAct({ mode: 'active', gate: 'ok', lease: 'live', fact: claim })).toBe(true)
    expect(mayAct({ mode: 'shadow', gate: 'ok', lease: 'live', fact: claim })).toBe(false)
    expect(mayAct({ mode: 'off', gate: 'ok', lease: 'live', fact: claim })).toBe(false)
    expect(mayAct({ mode: 'active', gate: 'above', lease: 'live', fact: claim })).toBe(false)
    expect(mayAct({ mode: 'active', gate: 'below', lease: 'live', fact: claim })).toBe(false)
    expect(mayAct({ mode: 'active', gate: 'unknown', lease: 'live', fact: claim })).toBe(false)
    expect(mayAct({ mode: 'active', gate: 'ok', lease: 'lost', fact: claim })).toBe(false)
    expect(mayAct({ mode: 'active', gate: 'ok', lease: 'live', fact: { kind: 'none' } })).toBe(
      false
    )
    expect(
      mayAct({
        mode: 'active',
        gate: 'ok',
        lease: 'live',
        fact: { kind: 'conflict', key: 'k', sid: SID, heldBy: 'x' }
      })
    ).toBe(false)
  })
})

describe('enable policy (first policy: sense.identity only)', () => {
  const view = (declared: string[]): BindingView =>
    ({ declared, enabled: [] }) as unknown as BindingView

  it('enables only sense.identity, and only when the mode and the CLI gate allow it', () => {
    const v = view(['sense.identity', 'gate.approval'])
    expect(enableFor(v, 'shadow', 'ok')).toEqual(['sense.identity'])
    expect(enableFor(v, 'active', 'above')).toEqual(['sense.identity']) // served; it just never acts
    expect(enableFor(v, 'off', 'ok')).toEqual([])
    expect(enableFor(v, 'shadow', 'below')).toEqual([])
    expect(enableFor(v, 'shadow', 'unknown')).toEqual([]) // unknown is treated as below
    expect(enableFor(view([]), 'active', 'ok')).toEqual([]) // nothing declared, nothing enabled
  })
})

describe('the policy as the host registers it', () => {
  const ceiling = '2.1.289'
  it('evaluates the gate per binding on the CLI version it reported', () => {
    const policy = identityEnablePolicy({ getMode: () => 'shadow', ceiling })
    const v = (cliVersion: string): BindingView =>
      ({ declared: ['sense.identity'], cliVersion }) as unknown as BindingView
    expect(policy(v('2.1.289'))).toEqual(['sense.identity'])
    expect(policy(v('2.1.290'))).toEqual(['sense.identity']) // above the ceiling: served
    expect(policy(v('2.1.286'))).toEqual([]) // below the minimum
    expect(policy(v('not a version'))).toEqual([]) // unparseable is unknown, treated as below
    expect(gateForCli('2.1.290', ceiling)).toBe('above')
    expect(gateForCli('2.1.288', ceiling)).toBe('ok')
  })

  it('follows the mode live', () => {
    let mode: 'off' | 'shadow' = 'off'
    const policy = identityEnablePolicy({ getMode: () => mode, ceiling })
    const view = { declared: ['sense.identity'], cliVersion: '2.1.289' } as unknown as BindingView
    expect(policy(view)).toEqual([])
    mode = 'shadow'
    expect(policy(view)).toEqual(['sense.identity'])
  })
})
