import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_FAMILY_MODE,
  effectiveMode,
  FAMILY_FEATURES,
  ownerOf,
  ROW_PARTITION,
  rowGroupOwner,
  type ArbiterBinding,
  type RolloutView,
  type RowGroup
} from '../../src/main/companion/arbitration-core'
import {
  hydrateCompanionPrefs,
  rolloutView,
  setCompanionCliGate,
  setCompanionPrefsPath
} from '../../src/main/companion/companion-prefs'
import { parsePrefs } from '../../src/main/companion/companion-prefs-core'
import { buildCompanionStatus } from '../../src/main/companion/companion-status'
import {
  computeEnable,
  registerP1FeaturePolicies,
  resetFeaturePoliciesForTests
} from '../../src/main/companion/feature-policy'
import { registerRowFeaturePolicy } from '../../src/main/companion/ingest/row-adapter'
import { familyMode, type FactFamily } from '../../src/main/companion/mode'
import type { BindingView } from '../../src/main/companion/session-table'

/** T455 W2 AC-3: the `row` fact family and its design-time partition (spec §7.1). */

const rollout = (over: Partial<RolloutView> = {}): RolloutView => ({
  enabled: true,
  cliGate: 'ok',
  families: {},
  allFolders: true,
  rampFolders: new Set(),
  ...over
})

const binding = (over: Partial<ArbiterBinding> = {}): ArbiterBinding => ({
  sessionKey: 'k1',
  folder: '/work/example-web',
  leaseLive: true,
  enabled: new Set(['sense.identity', 'sense.row']),
  proven: new Set(['sense.identity', 'sense.row']),
  revoked: new Set<FactFamily>(),
  ...over
})

describe('the row family (AC-3)', () => {
  it('needs sense.identity and sense.row, and ships in shadow', () => {
    expect(FAMILY_FEATURES.row).toEqual(['sense.identity', 'sense.row'])
    expect(DEFAULT_FAMILY_MODE.row).toBe('shadow')
    expect(effectiveMode('row', '/work/example-web', rollout())).toBe('shadow')
  })

  it('is owned only with both proofs, on the ramp, in active', () => {
    const r = rollout({ families: { row: 'active' } })
    expect(ownerOf('row', binding(), r)).toEqual({ owner: 'companion', reason: 'owned' })
    expect(ownerOf('row', binding({ proven: new Set(['sense.identity']) }), r).reason).toBe(
      'unproven'
    )
    expect(ownerOf('row', binding({ proven: new Set(['sense.row']) }), r).reason).toBe('unproven')
    expect(ownerOf('row', binding(), rollout()).reason).toBe('mode-shadow')
    expect(ownerOf('row', binding({ revoked: new Set<FactFamily>(['row']) }), r).reason).toBe(
      'revoked'
    )
  })

  it('the partition is data, fixed at design time (§7.1)', () => {
    expect(ROW_PARTITION).toEqual({
      prompt: 'companion',
      count: 'companion',
      activity: 'companion',
      assistant: 'companion',
      title: 'legacy',
      tools: 'legacy'
    })
  })

  it('flips as one: every group follows the family owner, no group flips alone', () => {
    const groups = Object.keys(ROW_PARTITION) as RowGroup[]
    for (const g of groups) expect(rowGroupOwner(g, 'legacy')).toBe('legacy')
    expect(groups.filter((g) => rowGroupOwner(g, 'companion') === 'companion').sort()).toEqual([
      'activity',
      'assistant',
      'count',
      'prompt'
    ])
    expect(rowGroupOwner('title', 'companion')).toBe('legacy')
    expect(rowGroupOwner('tools', 'companion')).toBe('legacy')
  })

  it('the status line lists the new family like every other (exhaustive over FactFamily)', () => {
    const s = buildCompanionStatus({
      enabled: () => true,
      disclosureShownAt: () => 1,
      stagedDir: () => null,
      modVersion: () => '0.1.0',
      rollout: () => rollout(),
      arbiter: {
        ownerFor: () => ({ owner: 'legacy', reason: 'mode-shadow' }),
        injectDecisionFor: () => null,
        sideloadExitFor: () => null,
        wasMinted: () => false,
        spawnOwners: () => [],
        bindingCounters: () => ({ modErrors: 0, leaseLosses: 0 })
      } as never,
      host: { diagnostics: () => ({ bindings: [] }), externalBindings: () => [] } as never,
      sessionKeyOf: () => null,
      kindOf: () => null,
      now: () => 1,
      probe: () => null,
      requestProbe: () => undefined,
      refusalTexts: []
    })
    expect(s.families.row).toBe('shadow')
  })
})

describe('companion-prefs.json families.row (AC-3)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'row-prefs-'))
    setCompanionPrefsPath(join(dir, 'companion-prefs.json'))
    setCompanionCliGate('ok')
  })
  afterEach(() => {
    setCompanionPrefsPath(null)
    rmSync(dir, { recursive: true, force: true })
  })

  it('parses off / shadow / active and reads an invalid value as shadow', () => {
    for (const m of ['off', 'shadow', 'active'] as const) {
      expect(parsePrefs(JSON.stringify({ families: { row: m } })).families.row).toBe(m)
    }
    expect(parsePrefs(JSON.stringify({ families: { row: 'loud' } })).families.row).toBe('shadow')
  })

  it('the file is honoured end to end: familyMode reads it', async () => {
    writeFileSync(
      join(dir, 'companion-prefs.json'),
      JSON.stringify({ families: { row: 'off' }, allFolders: true })
    )
    await hydrateCompanionPrefs()
    expect(rolloutView().families.row).toBe('off')
    expect(familyMode('row', '/work/example-web')).toBe('off')
    writeFileSync(
      join(dir, 'companion-prefs.json'),
      JSON.stringify({ families: { row: 'active' }, allFolders: true })
    )
    await hydrateCompanionPrefs()
    expect(familyMode('row', '/work/example-web')).toBe('active')
  })
})

describe('the sense.row feature policy (AC-2, AC-3)', () => {
  let dir: string
  const view = (over: Partial<BindingView> = {}): BindingView => ({
    key: 1,
    owner: { kind: 'pty', ptyId: 'p1' },
    trust: 'operator',
    sid: '11111111-1111-4111-8111-111111111111',
    sessionKey: 'k1',
    cwd: '/work/example-web',
    profile: 'interactive',
    cliVersion: '2.1.290',
    modVersion: '0.1.0',
    declared: ['sense.identity', 'sense.row'],
    enabled: [],
    proven: [],
    lease: 'live',
    state: 'bound',
    helloAfterSpawnMs: 700,
    ...over
  })
  const enable = (b: BindingView, profile: BindingView['profile'] = 'interactive') =>
    computeEnable(b.declared, {
      profile,
      folder: b.cwd,
      rollout: rolloutView(),
      trust: b.trust,
      binding: b
    })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'row-policy-'))
    setCompanionPrefsPath(join(dir, 'companion-prefs.json'))
    setCompanionCliGate('ok')
    resetFeaturePoliciesForTests()
    registerP1FeaturePolicies()
  })
  afterEach(() => {
    setCompanionPrefsPath(null)
    resetFeaturePoliciesForTests()
    registerP1FeaturePolicies()
    rmSync(dir, { recursive: true, force: true })
  })

  it('without the row adapter, sense.row has no rule and is never enabled', () => {
    expect(enable(view())).toEqual(['sense.identity'])
  })

  it('enabled while the row family is not off, in shadow and active', async () => {
    registerRowFeaturePolicy()
    expect(enable(view())).toEqual(['sense.identity', 'sense.row'])
    writeFileSync(join(dir, 'companion-prefs.json'), JSON.stringify({ families: { row: 'off' } }))
    await hydrateCompanionPrefs()
    expect(enable(view())).toEqual(['sense.identity'])
    writeFileSync(
      join(dir, 'companion-prefs.json'),
      JSON.stringify({ families: { row: 'active' } })
    )
    await hydrateCompanionPrefs()
    expect(enable(view())).toEqual(['sense.identity', 'sense.row'])
  })

  it('an outside session never gets sense.row (Q3: not in the external ceiling)', () => {
    registerRowFeaturePolicy()
    expect(enable(view({ profile: 'external' }), 'external')).not.toContain('sense.row')
  })
})
