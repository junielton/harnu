import { beforeEach, describe, expect, it } from 'vitest'
import {
  allClaims,
  claimedAway,
  claimFor,
  claimOfKey,
  isClaimedKey,
  replaceAll,
  sidClaimedByOther
} from '../src/renderer/src/lib/identity-claims'

const acting = { key: 'synthetic-a', sid: 'real-a', cause: 'spawn', act: true } as const
const shadow = { key: 'synthetic-b', sid: 'real-b', cause: 'spawn', act: false } as const

describe('identity claims (CL)', () => {
  beforeEach(() => replaceAll([]))

  it('looks a claim up by transcript or by row key', () => {
    replaceAll([acting, shadow])
    expect(claimFor('real-a')).toEqual(acting)
    expect(claimOfKey('synthetic-b')).toEqual(shadow)
    expect(claimFor('nope')).toBeUndefined()
    expect(isClaimedKey('synthetic-a')).toBe(true)
    expect(isClaimedKey('synthetic-zzz')).toBe(false)
  })

  it('replaceAll is a full replacement, never a merge', () => {
    replaceAll([acting, shadow])
    replaceAll([shadow])
    expect(allClaims()).toEqual([shadow])
    replaceAll(null)
    expect(allClaims()).toEqual([])
  })

  it('drops a malformed entry and keeps the rest', () => {
    replaceAll([
      acting,
      { key: '', sid: 'x', cause: 'spawn', act: true },
      42,
      null,
      { ...shadow, cause: 'bogus' }
    ])
    expect(allClaims()).toEqual([acting])
  })

  it('keeps no reference to the pushed objects', () => {
    const pushed = { ...acting }
    replaceAll([pushed])
    pushed.sid = 'tampered'
    expect(claimOfKey('synthetic-a')?.sid).toBe('real-a')
  })

  it('a row with an acting claim for another transcript is claimed away', () => {
    replaceAll([acting, shadow])
    expect(claimedAway('synthetic-a', 'real-other')).toBe(true)
    expect(claimedAway('synthetic-a', 'real-a')).toBe(false) // its own transcript is fine
    expect(claimedAway('synthetic-b', 'real-other')).toBe(false) // a shadow claim never narrows
    expect(claimedAway('synthetic-none', 'real-other')).toBe(false)
  })

  it('a transcript that an acting claim names is not offered to another row', () => {
    replaceAll([acting, shadow])
    expect(sidClaimedByOther('real-a', 'synthetic-z')).toBe(true)
    expect(sidClaimedByOther('real-a', 'synthetic-a')).toBe(false)
    expect(sidClaimedByOther('real-b', 'synthetic-z')).toBe(false) // shadow: legacy as today
  })
})
