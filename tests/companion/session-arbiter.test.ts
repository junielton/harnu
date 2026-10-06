import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { helloSpawnRequest } from '../../resources/companion/tests/fixtures/hello'
import { LEASE_TTL_MS, type EndpointFile } from '../../src/main/companion/contract'
import type { RolloutView } from '../../src/main/companion/arbitration-core'
import { createSessionArbiter } from '../../src/main/companion/session-arbiter'
import type { BindingView } from '../../src/main/companion/session-table'
import { post } from './support/client'
import { createCompanionHost, fakeMode, shortTmp } from './support/host-rig'

const TASK = ['sense.turn', 'sense.attention', 'sense.subagent']
const owner = { kind: 'pty', ptyId: 'pty-1' } as const
const dirs: string[] = []
const closers: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const c of closers.splice(0)) await c()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const rolloutOf = (over: Partial<RolloutView> = {}): RolloutView => ({
  enabled: true,
  cliGate: 'ok',
  families: { taskState: 'active', identity: 'active' },
  allFolders: true,
  rampFolders: new Set(),
  ...over
})

/** A real host core on a real socket: the lease clock is the table's, injected. */
async function rig(over: { rollout?: Partial<RolloutView>; enable?: string[] } = {}) {
  let t = 1_000
  const dir = join(shortTmp('hc-a-'), 'companion')
  dirs.push(join(dir, '..'))
  const host = createCompanionHost({
    dir,
    mode: fakeMode('shadow').mode,
    now: () => t,
    sessionKeyOf: (o) => (o.kind === 'pty' ? `key:${o.ptyId}` : null),
    log: () => undefined
  })
  closers.push(() => host.close())
  await host.register()
  host.facade.setEnablePolicy(() => over.enable ?? [...TASK, 'sense.identity'])
  const arbiter = createSessionArbiter({
    host: host.facade,
    rollout: () => rolloutOf(over.rollout)
  })
  closers.push(async () => arbiter.dispose())
  const ep = JSON.parse(readFileSync(join(dir, 'endpoint.json'), 'utf8')) as EndpointFile
  const token = host.facade.mintSpawnToken({ owner, trust: 'operator', cwd: '/work/example-web' })!
  const r = await post(ep, 'hello', { body: { ...helloSpawnRequest, spawn: token } })
  expect(r.json.ok).toBe(true)
  const view = (): BindingView => host.facade.getBinding('key:pty-1')!
  const prove = (features: string[]): void =>
    features.forEach((f) => host.facade.markProven(view(), f))
  return {
    host,
    arbiter,
    view,
    prove,
    advance: (ms: number) => void (t += ms),
    ping: async () => {
      return post(ep, 'events', {
        body: {
          v: 1,
          sid: helloSpawnRequest.sid,
          conn: (r.json as { conn: string }).conn,
          sentAt: 1,
          events: []
        }
      })
    }
  }
}

describe('session arbiter', () => {
  it('owns a family once mode, lease and every feature agree, and says why not before', async () => {
    const x = await rig()
    expect(x.arbiter.ownerFor('key:pty-1', 'taskState')).toEqual({
      owner: 'legacy',
      reason: 'unproven'
    })
    x.prove(TASK)
    expect(x.arbiter.owns('key:pty-1', 'taskState')).toBe(true)
    expect(x.arbiter.owns(helloSpawnRequest.sid, 'taskState')).toBe(true) // by sid too
    expect(x.arbiter.ownerFor('nobody', 'taskState')).toEqual({
      owner: 'legacy',
      reason: 'no-binding'
    })
  })

  it('reversion is sticky', async () => {
    const x = await rig()
    x.prove(TASK)
    expect(x.arbiter.owns('key:pty-1', 'taskState')).toBe(true)
    const changes: string[] = []
    x.arbiter.onOwnershipChange((k) => void changes.push(String(k)))
    x.advance(LEASE_TTL_MS + 1)
    x.host.sweepNow()
    expect(x.arbiter.ownerFor('key:pty-1', 'taskState')).toEqual({
      owner: 'legacy',
      reason: 'revoked'
    })
    expect(changes).toContain('key:pty-1')
    // the lease comes back: a request lands, the mod is polling again
    await x.ping()
    expect(x.view().lease).toBe('live')
    expect(x.view().state).toBe('bound')
    for (const f of ['taskState', 'identity', 'telemetry', 'approval'] as const) {
      expect(x.arbiter.ownerFor('key:pty-1', f).owner).toBe('legacy')
    }
    expect(x.arbiter.isStickyLegacy('key:pty-1')).toBe(true)
    expect(x.arbiter.isStickyLegacy('key:pty-1', 'taskState')).toBe(true)
    expect(x.arbiter.bindingCounters('key:pty-1').leaseLosses).toBe(1)
  })

  it('a surviving process without the mod', async () => {
    const everyFamilyActive: RolloutView['families'] = {
      identity: 'active',
      taskState: 'active',
      telemetry: 'active',
      planUsage: 'active',
      approval: 'active'
    }
    const x = await rig({ rollout: { families: everyFamilyActive } })
    x.prove(TASK)
    // the PTY is alive (no release) and the mod never speaks again
    x.advance(LEASE_TTL_MS)
    x.host.sweepNow()
    x.advance(1)
    x.host.sweepNow()
    expect(x.view().lease).toBe('lost')
    for (const f of ['identity', 'taskState', 'telemetry', 'planUsage', 'approval'] as const) {
      expect(x.arbiter.ownerFor('key:pty-1', f)).toEqual({ owner: 'legacy', reason: 'revoked' })
    }
  })

  it('an inert binding has no lease to lose and no sticky reason', async () => {
    const x = await rig({ enable: [] })
    x.advance(LEASE_TTL_MS * 5)
    x.host.sweepNow()
    expect(x.view().enabled).toEqual([])
    expect(x.arbiter.isStickyLegacy('key:pty-1')).toBe(false)
    expect(x.arbiter.bindingCounters('key:pty-1').leaseLosses).toBe(0)
  })

  it('a failed proof is sticky', async () => {
    const x = await rig()
    x.prove(TASK)
    expect(x.arbiter.owns('key:pty-1', 'taskState')).toBe(true)
    x.arbiter.reportFailedProof('key:pty-1', 'sense.attention')
    expect(x.arbiter.ownerFor('key:pty-1', 'taskState')).toEqual({
      owner: 'legacy',
      reason: 'revoked'
    })
    // a proof re-marked later does not undo it
    x.prove(TASK)
    expect(x.arbiter.owns('key:pty-1', 'taskState')).toBe(false)
    // only the families that need the feature are reverted
    expect(x.arbiter.isStickyLegacy('key:pty-1', 'identity')).toBe(false)
    expect(x.arbiter.isStickyLegacy('key:pty-1', 'taskState')).toBe(true)
  })

  it('a proof revoked on the table reverts the families that need it', async () => {
    const x = await rig()
    x.prove(TASK)
    x.host.facade.revokeProof(x.view(), 'sense.turn')
    expect(x.arbiter.owns('key:pty-1', 'taskState')).toBe(false)
  })

  it('revocation ends with the session: a new binding starts clean', async () => {
    const x = await rig()
    x.prove(TASK)
    x.arbiter.reportFailedProof('key:pty-1', 'sense.turn')
    x.host.facade.releaseSpawn(owner, 'pty-exit')
    expect(x.arbiter.isStickyLegacy('key:pty-1')).toBe(false)
  })

  it('counts the mod errors reported on the bus per binding', async () => {
    const x = await rig()
    expect(x.arbiter.bindingCounters('key:pty-1')).toEqual({ modErrors: 0, leaseLosses: 0 })
  })

  it('keeps the inject decision and the sideload exit per spawn owner', () => {
    const a = createSessionArbiter({
      host: null,
      rollout: () => rolloutOf()
    })
    expect(a.injectDecisionFor(owner)).toBeNull()
    a.recordInjectDecision(owner, { inject: false, skip: 'pre-disclosure' })
    expect(a.injectDecisionFor(owner)).toEqual({ inject: false, skip: 'pre-disclosure' })
    expect(a.sideloadExitFor(owner)).toBeNull()
    a.reportSideloadExit(owner, 'x'.repeat(5000))
    expect(a.sideloadExitFor(owner)?.length).toBeLessThanOrEqual(2048)
    a.forgetSpawn(owner)
    expect(a.injectDecisionFor(owner)).toBeNull()
  })

  it('with no host wired every answer is legacy / no-binding', () => {
    const a = createSessionArbiter({ host: null, rollout: () => rolloutOf() })
    expect(a.ownerFor('k', 'taskState')).toEqual({ owner: 'legacy', reason: 'no-binding' })
    expect(a.owns('k', 'identity')).toBe(false)
    expect(a.bindingCounters('k')).toEqual({ modErrors: 0, leaseLosses: 0 })
  })
})
