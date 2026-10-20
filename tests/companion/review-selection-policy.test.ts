/**
 * T257 U2a-i-AC-7 — `act.context` and `ui.band` are enabled only for an interactive `read-only`
 * binding with the mod on. Every other binding class gets neither.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerChannelPolicies } from '../../src/main/companion/command-channel'
import {
  rolloutView,
  setCompanionCliGate,
  setCompanionEnabled,
  setCompanionPrefsPath,
  setPrefsKey
} from '../../src/main/companion/companion-prefs'
import {
  computeEnable,
  registerFeaturePolicy,
  registerP1FeaturePolicies,
  resetFeaturePoliciesForTests
} from '../../src/main/companion/feature-policy'
import type { BindingView, TrustClass } from '../../src/main/companion/session-table'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hc-rs-'))
  setCompanionPrefsPath(join(dir, 'companion-prefs.json'))
  setCompanionCliGate('ok')
  resetFeaturePoliciesForTests()
  registerP1FeaturePolicies()
  registerChannelPolicies()
})
afterEach(() => {
  setCompanionPrefsPath(null)
  rmSync(dir, { recursive: true, force: true })
})

const DECLARED = ['sense.identity', 'sense.turn', 'act.channel', 'act.context', 'ui.band']

function enable(
  trust: TrustClass,
  profile: 'interactive' | 'headless' | 'external' = 'interactive'
): string[] {
  const binding = {
    key: 1,
    owner: { kind: 'pty', ptyId: 'p1' },
    trust,
    sid: '11111111-1111-4111-8111-111111111111',
    sessionKey: null,
    cwd: '/work/example-web',
    profile,
    cliVersion: '2.1.290',
    modVersion: '0.1.0',
    declared: DECLARED,
    enabled: [],
    proven: [],
    lease: 'live',
    state: 'bound',
    helloAfterSpawnMs: 0
  } as BindingView
  return computeEnable(DECLARED, {
    profile,
    folder: '/work/example-web',
    rollout: rolloutView(),
    trust,
    binding
  })
}

describe('U2a-i-AC-7 — the review companion class, and no other', () => {
  it('an interactive read-only binding gets both', () => {
    const on = enable('read-only')
    expect(on).toContain('act.context')
    expect(on).toContain('ui.band')
  })

  it('an operator, agent or tick binding gets neither', () => {
    for (const trust of ['operator', 'agent', 'tick'] as const) {
      const on = enable(trust)
      expect(on, trust).not.toContain('act.context')
      expect(on, trust).not.toContain('ui.band')
    }
  })

  it('a headless or external read-only binding gets neither', () => {
    for (const profile of ['headless', 'external'] as const) {
      const on = enable('read-only', profile)
      expect(on, profile).not.toContain('act.context')
      expect(on, profile).not.toContain('ui.band')
    }
  })

  it('the mod off closes both, kill switch included', async () => {
    await setCompanionEnabled(false)
    expect(enable('read-only')).toEqual([])
    await setCompanionEnabled(true)
    setCompanionCliGate('below')
    expect(enable('read-only')).toEqual([])
  })

  it('channel off closes act.context and leaves the display-only band', () => {
    setPrefsKey('channel', 'off')
    const on = enable('read-only')
    expect(on).not.toContain('act.context')
    expect(on).toContain('ui.band')
  })

  it('channel shadow is enough (the O-3 carve-out) and active changes nothing for the class', () => {
    setPrefsKey('channel', 'shadow')
    expect(enable('read-only')).toContain('act.context')
    setPrefsKey('channel', 'active')
    expect(enable('read-only')).toContain('act.context')
  })

  it('a feature the mod did not declare is not enabled', () => {
    const b = { profile: 'interactive', trust: 'read-only' } as BindingView
    const got = computeEnable(['sense.identity'], {
      profile: 'interactive',
      folder: null,
      rollout: rolloutView(),
      trust: 'read-only',
      binding: b
    })
    expect(got).toEqual(['sense.identity'])
  })

  it('a later wave replacing a rule is a deliberate act: the reset helper restores ours', () => {
    registerFeaturePolicy('act.context', () => false)
    expect(enable('read-only')).not.toContain('act.context')
    resetFeaturePoliciesForTests()
    registerP1FeaturePolicies()
    expect(enable('read-only')).toContain('act.context')
  })
})
