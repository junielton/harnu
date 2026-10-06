import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  setCompanionCliGate,
  setCompanionEnabled,
  setCompanionPrefsPath,
  setFamilyMode,
  rolloutView
} from '../../src/main/companion/companion-prefs'
import {
  computeEnable,
  registerFeaturePolicy,
  registerP1FeaturePolicies,
  resetFeaturePoliciesForTests
} from '../../src/main/companion/feature-policy'
import type { BindingView } from '../../src/main/companion/session-table'

let dir: string

const binding = (over: Partial<BindingView> = {}): BindingView => ({
  key: 1,
  owner: { kind: 'pty', ptyId: 'p1' },
  trust: 'operator',
  sid: '11111111-1111-4111-8111-111111111111',
  sessionKey: 'k1',
  cwd: '/work/example-web',
  profile: 'interactive',
  cliVersion: '2.1.290',
  modVersion: '0.1.0',
  declared: [],
  enabled: [],
  proven: [],
  lease: 'live',
  state: 'bound',
  helloAfterSpawnMs: 700,
  ...over
})

const ALL = [
  'sense.identity',
  'sense.turn',
  'sense.attention',
  'sense.subagent',
  'sense.usage',
  'act.channel',
  'gate.guard'
]

function enable(profile: 'interactive' | 'headless' | 'external' = 'interactive', declared = ALL) {
  const b = binding({ profile, declared })
  return computeEnable(declared, {
    profile,
    folder: '/work/example-web',
    rollout: rolloutView(),
    trust: 'operator',
    binding: b
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hc-fp-'))
  setCompanionPrefsPath(join(dir, 'companion-prefs.json'))
  setCompanionCliGate('ok')
  resetFeaturePoliciesForTests()
  registerP1FeaturePolicies()
})

afterEach(() => {
  setCompanionPrefsPath(null)
  rmSync(dir, { recursive: true, force: true })
})

describe('computeEnable', () => {
  it('enables the P1 sensors in a default install and nothing a later wave has not registered', () => {
    expect(enable()).toEqual([
      'sense.identity',
      'sense.turn',
      'sense.attention',
      'sense.subagent',
      'sense.usage'
    ])
  })

  it('only what the mod declared can be enabled', () => {
    expect(enable('interactive', ['sense.identity', 'sense.turn'])).toEqual([
      'sense.identity',
      'sense.turn'
    ])
    expect(enable('interactive', [])).toEqual([])
  })

  it('the kill switch overrides every rule', async () => {
    registerFeaturePolicy('act.channel', () => true)
    registerFeaturePolicy('gate.guard', () => true)
    expect(enable()).toContain('act.channel')
    await setCompanionEnabled(false)
    expect(enable()).toEqual([])
  })

  it('a gate below or unknown overrides every rule', () => {
    registerFeaturePolicy('act.channel', () => true)
    setCompanionCliGate('below')
    expect(enable()).toEqual([])
    setCompanionCliGate('unknown')
    expect(enable()).toEqual([])
  })

  it('a family set to off removes its sensors and no others', async () => {
    await setFamilyMode('taskState', 'off')
    expect(enable()).toEqual(['sense.identity', 'sense.usage'])
    await setFamilyMode('telemetry', 'off')
    expect(enable()).toContain('sense.usage') // planUsage is still on
    await setFamilyMode('planUsage', 'off')
    expect(enable()).toEqual(['sense.identity'])
  })

  it('a feature with no registered rule is not enabled', () => {
    expect(enable()).not.toContain('act.channel')
    expect(enable()).not.toContain('gate.guard')
  })

  it('a throwing rule enables nothing for that feature and breaks no other', () => {
    registerFeaturePolicy('act.channel', () => {
      throw new Error('boom')
    })
    expect(enable()).not.toContain('act.channel')
    expect(enable()).toContain('sense.turn')
  })

  it('the profile narrows the result: headless gets sense.* only, external the §21 set', () => {
    registerFeaturePolicy('act.channel', () => true)
    registerFeaturePolicy('gate.guard', () => true)
    registerFeaturePolicy('ui.band', () => true)
    registerFeaturePolicy('sense.compact', () => true)
    const declared = [...ALL, 'ui.band', 'sense.compact']
    expect(enable('headless', declared).every((f) => f.startsWith('sense.'))).toBe(true)
    expect(enable('headless', declared)).toContain('sense.compact')
    const ext = enable('external', declared)
    expect(ext).toEqual(expect.arrayContaining(['sense.identity', 'sense.turn', 'ui.band']))
    expect(ext).not.toContain('act.channel')
    expect(ext).not.toContain('gate.guard')
    expect(ext).not.toContain('sense.compact')
  })
})
