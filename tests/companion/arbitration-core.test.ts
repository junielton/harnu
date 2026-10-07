import { describe, expect, it } from 'vitest'
import {
  admit,
  DEFAULT_FAMILY_MODE,
  effectiveMode,
  FAMILY_FEATURES,
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
  it('every family ships in shadow (OD-1)', () => {
    for (const f of Object.keys(FAMILY_FEATURES) as FactFamily[]) {
      expect(DEFAULT_FAMILY_MODE[f]).toBe('shadow')
    }
    expect(effectiveMode('taskState', null, rollout({ families: {} }))).toBe('shadow')
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

  it('above ceiling forces shadow', () => {
    for (const f of Object.keys(FAMILY_FEATURES) as FactFamily[]) {
      const r = rollout({ cliGate: 'above', families: { [f]: 'active' } })
      expect(effectiveMode(f, '/x', r)).toBe('shadow')
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
