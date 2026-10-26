import { describe, expect, it } from 'vitest'
import {
  admit,
  DEFAULT_FAMILY_MODE,
  effectiveMode,
  FAMILY_FEATURES,
  GRADUATED_FAMILIES,
  ownerOf,
  type ArbiterBinding,
  type RolloutView
} from '../../src/main/companion/arbitration-core'
import type { FactFamily } from '../../src/main/companion/mode'

const TASK_FEATURES = ['sense.turn', 'sense.attention', 'sense.subagent']

function rollout(over: Partial<RolloutView> = {}): RolloutView {
  return {
    enabled: true,
    cliGate: 'ok',
    families: { taskState: 'active' },
    allFolders: true,
    rampFolders: new Set(),
    ...over
  }
}

function binding(over: Partial<ArbiterBinding> = {}): ArbiterBinding {
  return {
    sessionKey: 'k1',
    folder: '/work/example-web',
    leaseLive: true,
    enabled: new Set(TASK_FEATURES),
    proven: new Set(TASK_FEATURES),
    revoked: new Set<FactFamily>(),
    ...over
  }
}

describe('effectiveMode', () => {
  it('every family ships in shadow (OD-1) except the graduated ones (T577)', () => {
    for (const f of Object.keys(FAMILY_FEATURES) as FactFamily[]) {
      expect(DEFAULT_FAMILY_MODE[f]).toBe(GRADUATED_FAMILIES.has(f) ? 'active' : 'shadow')
    }
    expect([...GRADUATED_FAMILIES].sort()).toEqual(['planUsage', 'telemetry'])
    expect(effectiveMode('taskState', null, rollout({ families: {} }))).toBe('shadow')
  })

  it('telemetry and planUsage are active by default, off the ramp and above the ceiling (T577)', () => {
    const shipped = rollout({ families: {}, allFolders: false, rampFolders: new Set() })
    for (const f of ['telemetry', 'planUsage'] as const) {
      expect(effectiveMode(f, '/work/elsewhere', shipped)).toBe('active')
      expect(effectiveMode(f, null, shipped)).toBe('active')
      expect(effectiveMode(f, '/x', { ...shipped, cliGate: 'above' })).toBe('active')
    }
    // the same rollout leaves every other family where it was
    expect(effectiveMode('taskState', '/x', { ...shipped, cliGate: 'above' })).toBe('shadow')
    expect(effectiveMode('identity', '/x', shipped)).toBe('shadow')
  })

  it('a graduated family still obeys the kill switch, the gate and the user (T577)', () => {
    const shipped = rollout({ families: {}, allFolders: false })
    expect(effectiveMode('telemetry', '/x', { ...shipped, enabled: false })).toBe('off')
    expect(effectiveMode('telemetry', '/x', { ...shipped, cliGate: 'below' })).toBe('off')
    expect(effectiveMode('telemetry', '/x', { ...shipped, cliGate: 'unknown' })).toBe('off')
    expect(
      effectiveMode('telemetry', '/x', { ...shipped, families: { telemetry: 'shadow' } })
    ).toBe('shadow')
    expect(effectiveMode('planUsage', '/x', { ...shipped, families: { planUsage: 'off' } })).toBe(
      'off'
    )
  })

  it('the kill switch and a below or unknown gate read off before anything else', () => {
    expect(effectiveMode('taskState', null, rollout({ enabled: false }))).toBe('off')
    expect(effectiveMode('taskState', null, rollout({ cliGate: 'below' }))).toBe('off')
    expect(effectiveMode('taskState', null, rollout({ cliGate: 'unknown' }))).toBe('off')
  })

  it('an explicit family value wins over the developer default, which wins over the shipped one', () => {
    const r = rollout({ families: { taskState: 'off' }, defaultMode: 'active' })
    expect(effectiveMode('taskState', '/x', r)).toBe('off')
    expect(effectiveMode('telemetry', '/x', r)).toBe('active')
  })

  it('off-ramp folder stays shadow', () => {
    const r = rollout({ allFolders: false, rampFolders: new Set(['/work/ramped']) })
    expect(effectiveMode('taskState', '/work/elsewhere', r)).toBe('shadow')
    expect(effectiveMode('taskState', null, r)).toBe('shadow')
    expect(effectiveMode('taskState', '/work/ramped', r)).toBe('active')
  })

  it('above ceiling forces shadow, except for the graduated families', () => {
    for (const f of Object.keys(FAMILY_FEATURES) as FactFamily[]) {
      const r = rollout({ cliGate: 'above', families: { [f]: 'active' } })
      expect(effectiveMode(f, '/x', r)).toBe(GRADUATED_FAMILIES.has(f) ? 'active' : 'shadow')
    }
  })

  it('a value outside the enum reads shadow', () => {
    const r = rollout({ families: { taskState: 'banana' as never } })
    expect(effectiveMode('taskState', '/x', r)).toBe('shadow')
  })
})

describe('ownerOf', () => {
  it('ownership needs mode, lease and proof', () => {
    const r = rollout()
    expect(ownerOf('taskState', binding(), r)).toEqual({ owner: 'companion', reason: 'owned' })

    expect(ownerOf('taskState', binding(), rollout({ families: { taskState: 'shadow' } }))).toEqual(
      {
        owner: 'legacy',
        reason: 'mode-shadow'
      }
    )
    expect(ownerOf('taskState', binding({ leaseLive: false }), r)).toEqual({
      owner: 'legacy',
      reason: 'lease-lost'
    })
    for (const missing of TASK_FEATURES) {
      const proven = new Set(TASK_FEATURES.filter((x) => x !== missing))
      expect(ownerOf('taskState', binding({ proven }), r)).toEqual({
        owner: 'legacy',
        reason: 'unproven'
      })
    }
  })

  it('names the reason: off, off-ramp, above the ceiling, no binding, revoked', () => {
    expect(ownerOf('taskState', binding(), rollout({ enabled: false })).reason).toBe('mode-off')
    expect(
      ownerOf('taskState', binding(), rollout({ allFolders: false, rampFolders: new Set() })).reason
    ).toBe('off-ramp')
    expect(ownerOf('taskState', binding(), rollout({ cliGate: 'above' })).reason).toBe(
      'cli-above-ceiling'
    )
    expect(ownerOf('taskState', null, rollout())).toEqual({ owner: 'legacy', reason: 'no-binding' })
    expect(
      ownerOf('taskState', binding({ revoked: new Set<FactFamily>(['taskState']) }), rollout())
    ).toEqual({ owner: 'legacy', reason: 'revoked' })
  })

  it('telemetry is owned by default, and every fallback case reads legacy (T577)', () => {
    const shipped = rollout({ families: {}, allFolders: false, rampFolders: new Set() })
    const mine = {
      enabled: new Set(['sense.usage' as const]),
      proven: new Set(['sense.usage' as const])
    }
    expect(ownerOf('telemetry', binding(mine), shipped)).toEqual({
      owner: 'companion',
      reason: 'owned'
    })
    expect(ownerOf('planUsage', binding(mine), shipped)).toEqual({
      owner: 'companion',
      reason: 'owned'
    })
    // CLI older than the minimum, or not probed yet: the mod is not even injected
    expect(ownerOf('telemetry', binding(mine), { ...shipped, cliGate: 'below' }).owner).toBe(
      'legacy'
    )
    expect(ownerOf('telemetry', binding(mine), { ...shipped, cliGate: 'unknown' }).owner).toBe(
      'legacy'
    )
    // kill switch
    expect(ownerOf('telemetry', binding(mine), { ...shipped, enabled: false })).toEqual({
      owner: 'legacy',
      reason: 'mode-off'
    })
    // a session the mod is not bound to (spawned outside Harnu, mod not loaded)
    expect(ownerOf('telemetry', null, shipped)).toEqual({ owner: 'legacy', reason: 'no-binding' })
    // lease lost, feature not proven, sticky reversion
    expect(ownerOf('telemetry', binding({ ...mine, leaseLive: false }), shipped).reason).toBe(
      'lease-lost'
    )
    expect(ownerOf('telemetry', binding({ ...mine, proven: new Set() }), shipped).reason).toBe(
      'unproven'
    )
    expect(
      ownerOf(
        'telemetry',
        binding({ ...mine, revoked: new Set<FactFamily>(['telemetry']) }),
        shipped
      ).reason
    ).toBe('revoked')
  })

  it('a sticky reversion of one family leaves the others alone', () => {
    const r = rollout({ families: { taskState: 'active', identity: 'active' } })
    const b = binding({
      revoked: new Set<FactFamily>(['taskState']),
      proven: new Set([...TASK_FEATURES, 'sense.identity'])
    })
    expect(ownerOf('identity', b, r).owner).toBe('companion')
    expect(ownerOf('taskState', b, r).owner).toBe('legacy')
  })

  it('a family with no proven features at all is never owned', () => {
    const r = rollout({ families: { approval: 'active' } })
    expect(ownerOf('approval', binding({ proven: new Set() }), r).reason).toBe('unproven')
  })
})

describe('admit', () => {
  const owned = rollout()
  const shadow = rollout({ families: { taskState: 'shadow' } })
  const off = rollout({ families: { taskState: 'off' } })

  it('legacy owner: legacy applies, companion is recorded in shadow and dropped in off', () => {
    expect(admit('taskState', 'legacy', binding(), shadow)).toBe('apply')
    expect(admit('taskState', 'companion', binding(), shadow)).toBe('record-only')
    expect(admit('taskState', 'companion', binding(), off)).toBe('drop')
    expect(admit('taskState', 'legacy', null, owned)).toBe('apply')
  })

  it('companion owner: companion applies, legacy is dropped', () => {
    expect(admit('taskState', 'companion', binding(), owned)).toBe('apply')
    expect(admit('taskState', 'legacy', binding(), owned)).toBe('drop')
  })

  it('an active family that is not yet owned records the companion and applies legacy', () => {
    const b = binding({ proven: new Set() })
    expect(admit('taskState', 'companion', b, owned)).toBe('record-only')
    expect(admit('taskState', 'legacy', b, owned)).toBe('apply')
  })

  it('no binding: a companion event can only be recorded', () => {
    expect(admit('taskState', 'companion', null, owned)).toBe('record-only')
  })
})
