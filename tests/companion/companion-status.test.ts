import { describe, expect, it, vi } from 'vitest'
import type { RolloutView } from '../../src/main/companion/arbitration-core'
import { buildCompanionStatus, type StatusDeps } from '../../src/main/companion/companion-status'
import { createSessionArbiter } from '../../src/main/companion/session-arbiter'
import type { BindingView, SpawnOwner } from '../../src/main/companion/session-table'

const owner = (n: number): SpawnOwner => ({ kind: 'pty', ptyId: `p${n}` })
const NOW = 1_790_000_100_000

const rollout = (over: Partial<RolloutView> = {}): RolloutView => ({
  enabled: true,
  cliGate: 'ok',
  families: {},
  allFolders: false,
  rampFolders: new Set(),
  ...over
})

function view(over: Partial<BindingView> = {}): BindingView {
  return {
    key: 1,
    owner: owner(1),
    trust: 'operator',
    sid: 'sid-1',
    sessionKey: 'row-1',
    cwd: '/work/example-web',
    profile: 'interactive',
    cliVersion: '2.1.290',
    modVersion: '0.1.0',
    declared: [],
    enabled: ['sense.identity'],
    proven: [],
    lease: 'live',
    state: 'bound',
    helloAfterSpawnMs: 700,
    ...over
  }
}

function rig(
  over: {
    bindings?: BindingView[]
    kinds?: Record<string, string | null>
    probe?: StatusDeps['probe']
    r?: RolloutView
    spawned?: { owner: SpawnOwner; atAgoMs: number; skip?: 'pre-disclosure' | 'cli-unknown' }[]
  } = {}
) {
  const r = over.r ?? rollout()
  const arbiter = createSessionArbiter({ host: null, rollout: () => r, now: () => NOW })
  const spawned = over.spawned ?? [{ owner: owner(1), atAgoMs: 60_000 }]
  for (const s of spawned) {
    arbiter.recordInjectDecision(
      s.owner,
      s.skip ? { inject: false, skip: s.skip } : { inject: true }
    )
    arbiter.noteMinted(s.owner)
  }
  const bindings = over.bindings ?? []
  const requestProbe = vi.fn()
  const deps: StatusDeps = {
    enabled: () => r.enabled,
    disclosureShownAt: () => 1_789_000_000_000,
    stagedDir: () => '/ud/companion/0.1.0/harnu-companion',
    modVersion: () => '0.1.0',
    rollout: () => r,
    arbiter: {
      ...arbiter,
      spawnOwners: () => spawned.map((s) => ({ owner: s.owner, at: NOW - s.atAgoMs }))
    },
    host: {
      bindingForSession: (k) => bindings.find((b) => b.sessionKey === k) ?? null,
      bindingForSid: (s) => bindings.find((b) => b.sid === s) ?? null,
      spawnRecord: (o) =>
        spawned.some((x) => JSON.stringify(x.owner) === JSON.stringify(o))
          ? { cwd: '/x', trust: 'operator', state: 'redeemed' }
          : null,
      helloRefusalFor: () => null
    },
    sessionKeyOf: (o) => (o.kind === 'pty' ? `row-${o.ptyId.slice(1)}` : null),
    kindOf: (o) => (o.kind === 'pty' ? (over.kinds?.[o.ptyId] ?? 'claude-new') : null),
    now: () => NOW,
    probe: over.probe ?? (() => null),
    requestProbe,
    refusalTexts: []
  }
  return { deps, requestProbe }
}

describe('buildCompanionStatus', () => {
  it('reports a live session under its row key and its bound sid, with the ownership of every family', () => {
    const { deps } = rig({ bindings: [view()] })
    const s = buildCompanionStatus(deps)
    expect(s.enabled).toBe(true)
    expect(s.disclosureShownAt).toBe(1_789_000_000_000)
    expect(s.stagedDir).toBe('/ud/companion/0.1.0/harnu-companion')
    expect(s.modVersion).toBe('0.1.0')
    expect(s.cliGate).toBe('ok')
    expect(s.families.taskState).toBe('shadow')
    expect(s.sessions['row-1'].state).toEqual({ state: 'live' })
    expect(s.sessions['sid-1']).toBe(s.sessions['row-1'])
    expect(Object.keys(s.sessions['row-1'].ownership).sort()).toEqual([
      'approval',
      'guard',
      'identity',
      'message',
      'planUsage',
      'startPrompt',
      'taskState',
      'telemetry'
    ])
    expect(s.sessions['row-1'].ownership.taskState.owner).toBe('legacy')
  })

  it('a session spawned before the notice reads legacy, started without it', () => {
    const { deps } = rig({
      spawned: [{ owner: owner(1), atAgoMs: 5_000, skip: 'pre-disclosure' }]
    })
    const s = buildCompanionStatus(deps)
    expect(s.sessions['row-1'].state).toEqual({ state: 'legacy', reason: 'notInjected' })
  })

  it('a shell row, or an owner with no kind, has no line', () => {
    const { deps } = rig({ kinds: { p1: 'shell' } })
    expect(buildCompanionStatus(deps).sessions['row-1'].state).toBeNull()
  })

  it('the kill switch off reads off for every row', () => {
    const { deps } = rig({ r: rollout({ enabled: false }), bindings: [view()] })
    expect(buildCompanionStatus(deps).sessions['row-1'].state).toEqual({ state: 'off' })
  })

  it('requests the probe only for a spawn past the grace with no hello and no other cause', () => {
    const young = rig({ spawned: [{ owner: owner(1), atAgoMs: 1_000 }] })
    buildCompanionStatus(young.deps)
    expect(young.requestProbe).not.toHaveBeenCalled()

    const old = rig({ spawned: [{ owner: owner(1), atAgoMs: 60_000 }] })
    const s = buildCompanionStatus(old.deps)
    expect(old.requestProbe).toHaveBeenCalledTimes(1)
    expect(s.sessions['row-1'].state).toEqual({ state: 'legacy', reason: 'noHello' })

    const bound = rig({ bindings: [view()] })
    buildCompanionStatus(bound.deps)
    expect(bound.requestProbe).not.toHaveBeenCalled()

    const gated = rig({ spawned: [{ owner: owner(1), atAgoMs: 60_000, skip: 'cli-unknown' }] })
    buildCompanionStatus(gated.deps)
    expect(gated.requestProbe).not.toHaveBeenCalled()
  })

  it('words the probe: mods off here, remotely, or loads', () => {
    for (const [probe, reason] of [
      ['off-here', 'modsOff'],
      ['off-remote', 'remoteOff'],
      ['loads', 'noHello'],
      ['unknown', 'noHello']
    ] as const) {
      const { deps } = rig({ probe: () => probe })
      const s = buildCompanionStatus(deps)
      expect(s.probe).toBe(probe)
      expect(s.sessions['row-1'].state).toEqual({ state: 'legacy', reason })
    }
  })

  it('two sessions are two rows', () => {
    const { deps } = rig({
      spawned: [
        { owner: owner(1), atAgoMs: 60_000 },
        { owner: owner(2), atAgoMs: 60_000, skip: 'pre-disclosure' }
      ],
      bindings: [view()]
    })
    const s = buildCompanionStatus(deps)
    expect(s.sessions['row-1'].state).toEqual({ state: 'live' })
    expect(s.sessions['row-2'].state).toEqual({ state: 'legacy', reason: 'notInjected' })
  })
})
