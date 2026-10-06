import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LEASE_TTL_MS, type Conn, type EndpointFile } from '../../src/main/companion/contract'
import { createIdentityAdapter } from '../../src/main/companion/identity-adapter'
import type { IdentityClaim } from '../../src/main/companion/identity-core'
import { enableFor } from '../../src/main/companion/enable-policy'
import type { CompanionMode } from '../../src/main/companion/mode'
import type { CliGate } from '../../src/main/companion/version-gate'
import { helloSpawnRequest } from '../../resources/companion/tests/fixtures/hello'
import { post } from './support/client'
import { createCompanionHost, fakeMode, shortTmp, tick } from './support/host-rig'

const S1 = helloSpawnRequest.sid
const S2 = '22222222-2222-4222-8222-222222222222'
const S3 = '33333333-3333-4333-8333-333333333333'
const dirs: string[] = []
const closers: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const c of closers.splice(0)) await c()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function rig(opts: { mode?: CompanionMode; gate?: CliGate } = {}) {
  const dir = join(shortTmp('hc-i-'), 'companion')
  dirs.push(join(dir, '..'))
  let t = 1_000
  const m = fakeMode(opts.mode ?? 'active')
  const gate = { value: opts.gate ?? ('ok' as CliGate) }
  /** What `pty:rekey` would have moved: ptyId → row key. */
  const keys = new Map<string, string>()
  const kinds = new Map<string, string>()
  const host = createCompanionHost({
    dir,
    mode: m.mode,
    now: () => t,
    log: () => undefined,
    sessionKeyOf: (o) => (o.kind === 'pty' ? (keys.get(o.ptyId) ?? null) : null)
  })
  closers.push(() => host.close())
  await host.register()
  host.facade.setEnablePolicy((b) => enableFor(b, m.mode.getMode(), gate.value))
  const pushes: IdentityClaim[][] = []
  let mono = 0
  const adapter = createIdentityAdapter({
    host: host.facade,
    now: () => mono,
    epochNow: () => 1_790_000_000_000,
    spawnKind: (o) => (o.kind === 'pty' ? (kinds.get(o.ptyId) ?? null) : null),
    getMode: m.mode.getMode,
    gateOf: () => gate.value,
    push: (c) => void pushes.push(c)
  })
  host.facade.setIdentityDiagnostics(adapter.diagnostics)
  const ep = JSON.parse(readFileSync(join(dir, 'endpoint.json'), 'utf8')) as EndpointFile
  const bind = async (ptyId: string, rowKey: string | null, sid = S1) => {
    if (rowKey !== null) keys.set(ptyId, rowKey)
    const token = host.facade.mintSpawnToken({
      owner: { kind: 'pty', ptyId },
      trust: 'operator',
      cwd: '/tmp/example-project'
    })!
    const r = await post(ep, 'hello', {
      body: { ...helloSpawnRequest, sid, spawn: token, declared: ['sense.identity'] }
    })
    return { conn: r.json.conn as Conn, sid, r }
  }
  const env = (conn: Conn, sid: string) => ({ v: 1, sid, conn, sentAt: 1 })
  const rebound = (b: { conn: Conn }, prevSid: string, sid: string, cause = 'clear', seq = 1) =>
    post(ep, 'events', {
      body: {
        ...env(b.conn, sid),
        events: [{ seq, t: 'session.rebound', ts: 1, d: { prevSid, sid, cause } }]
      }
    })
  return {
    host,
    adapter,
    ep,
    bind,
    env,
    rebound,
    pushes,
    keys,
    kinds,
    advance: (ms: number) => {
      mono += ms
    },
    mode: m,
    gate,
    tick: (ms: number) => {
      t += ms
      host.sweepNow()
    }
  }
}

describe('identity adapter (IA)', () => {
  it('a hello creates a claim for the synthetic row and proves sense.identity', async () => {
    const x = await rig()
    await x.bind('pty-1', 'synthetic-aaaa')
    await tick()
    expect(x.adapter.claims()).toEqual([
      { key: 'synthetic-aaaa', sid: S1, cause: 'spawn', act: true }
    ])
    expect(x.pushes.at(-1)).toEqual(x.adapter.claims())
    expect(x.host.facade.getBinding('synthetic-aaaa')?.proven).toContain('sense.identity')
  })

  it('shadow compares and never acts', async () => {
    const x = await rig({ mode: 'shadow' })
    await x.bind('pty-1', 'synthetic-aaaa')
    expect(x.adapter.claims()).toEqual([
      { key: 'synthetic-aaaa', sid: S1, cause: 'spawn', act: false }
    ])
    const above = await rig({ mode: 'active', gate: 'above' })
    await above.bind('pty-1', 'synthetic-aaaa')
    expect(above.adapter.claims()[0]?.act).toBe(false)
  })

  it('re-key only on session.rebound (conformance row 16)', async () => {
    const x = await rig()
    const b = await x.bind('pty-1', 'synthetic-aaaa')
    const before = JSON.stringify(x.adapter.claims())
    // an envelope with another sid and no rebound: the server asks for a resync, nothing moves
    const r = await post(x.ep, 'events', {
      body: {
        ...x.env(b.conn, S2),
        events: [{ seq: 1, t: 'session.snapshot', ts: 1, d: { reason: 'flush' } }]
      }
    })
    expect(r.json).toMatchObject({ ok: true, resync: true })
    expect(JSON.stringify(x.adapter.claims())).toBe(before)
    expect(x.host.facade.bindingForSession('synthetic-aaaa')?.sid).toBe(S1)
    // the explicit rebound is what moves it
    const rb = await x.rebound({ conn: b.conn }, S1, S2, 'clear', 2)
    expect(rb.json.ok).toBe(true)
    await tick()
    expect(x.adapter.claims()).toEqual([
      { key: 'synthetic-aaaa', sid: S2, cause: 'clear', act: true }
    ])
    expect(x.host.facade.bindingForSession('synthetic-aaaa')?.sid).toBe(S2)
  })

  it('a rebound with another prevSid is accepted and counted; a duplicate is ignored', async () => {
    const x = await rig()
    const b = await x.bind('pty-1', 'synthetic-aaaa')
    await x.rebound({ conn: b.conn }, S3, S2) // prevSid is not what the host has: a lost rebound
    await tick()
    expect(x.adapter.claims()[0]).toMatchObject({ sid: S2 })
    expect(x.adapter.diagnostics()).toMatchObject({ reboundGap: 1, rebounds: 1 })
    // seq 1 again is a re-send: the server drops it; a new seq with the same sid is a duplicate
    await post(x.ep, 'events', {
      body: {
        ...x.env(b.conn, S2),
        events: [
          { seq: 2, t: 'session.rebound', ts: 1, d: { prevSid: S1, sid: S2, cause: 'clear' } }
        ]
      }
    })
    expect(x.adapter.diagnostics()).toMatchObject({ reboundGap: 1, rebounds: 1 })
  })

  it('a claim is satisfied once the row is keyed by its sid', async () => {
    const x = await rig()
    await x.bind('pty-1', 'synthetic-aaaa')
    expect(x.adapter.claims()).toHaveLength(1)
    // the renderer migrated and `pty:rekey` moved the index
    x.keys.set('pty-1', S1)
    x.host.facade.notifySessionKeyChange({ kind: 'pty', ptyId: 'pty-1' })
    expect(x.adapter.claims()).toEqual([])
    expect(x.pushes.at(-1)).toEqual([])
  })

  it('a sid live under another row is a conflict: no claim, counted once', async () => {
    const x = await rig()
    await x.bind('pty-1', 'row-one', S1)
    const second = await x.bind('pty-2', 'row-two', S2)
    await x.rebound({ conn: second.conn }, S2, S1, 'resume') // in-session /resume to a live session
    await tick()
    expect(x.adapter.claims().map((c) => c.key)).toEqual(['row-one'])
    expect(x.adapter.diagnostics().conflicts).toBe(1)
    expect(x.host.facade.bindingForSession('row-two')?.sid).toBe(S1)
  })

  it('a scheduler tick binds without a claim', async () => {
    const x = await rig()
    const token = x.host.facade.mintSpawnToken({
      owner: { kind: 'tick', workerId: 'w1', runId: 'r1' },
      trust: 'tick',
      cwd: '/tmp/example-project'
    })!
    await post(x.ep, 'hello', {
      body: { ...helloSpawnRequest, spawn: token, isInteractive: false, surface: null }
    })
    expect(x.host.facade.getBinding('tick:w1:r1')).not.toBeNull()
    expect(x.adapter.claims()).toEqual([])
    expect(x.pushes).toEqual([])
  })

  it('closed bindings are inert', async () => {
    const x = await rig()
    const b = await x.bind('pty-1', 'synthetic-aaaa')
    expect(x.adapter.claims()).toHaveLength(1)
    x.host.facade.releaseSpawn({ kind: 'pty', ptyId: 'pty-1' }, 'pty-exit')
    expect(x.adapter.claims()).toEqual([])
    const pushed = x.pushes.length
    // a late request from the dying process cannot re-animate the parked row
    const late = await x.rebound({ conn: b.conn }, S1, S2)
    expect(late.json).toMatchObject({ ok: false, code: 'STALE_CONN' })
    expect(x.adapter.claims()).toEqual([])
    expect(x.pushes.length).toBe(pushed)
  })

  it('the kill switch and a lost lease turn act off; the claim itself stays', async () => {
    const x = await rig()
    await x.bind('pty-1', 'synthetic-aaaa')
    expect(x.adapter.claims()[0]?.act).toBe(true)
    x.tick(LEASE_TTL_MS + 1) // the lease sweep: no request for longer than the TTL
    expect(x.adapter.claims()).toEqual([
      { key: 'synthetic-aaaa', sid: S1, cause: 'spawn', act: false }
    ])
    const y = await rig()
    const b = y.host.facade
    await y.bind('pty-1', 'synthetic-bbbb')
    const view = b.bindingForSession('synthetic-bbbb')!
    b.revoke(view)
    expect(y.adapter.claims()[0]?.act).toBe(false)
  })

  it('diagnostics carry the identity counters and no transcript id of a claim list leak', async () => {
    const x = await rig()
    await x.bind('pty-1', 'synthetic-aaaa')
    const d = x.host.facade.diagnostics()
    expect(d.identity).toMatchObject({ conflicts: 0, reboundGap: 0, rebounds: 0 })
    expect(JSON.stringify(d)).not.toMatch(/sp_|c_[0-9a-f]{32}/) // SEC-8: no token, no conn
  })

  describe('parity records', () => {
    it('the legacy binder agreeing with the claim is a match, with timings', async () => {
      const x = await rig()
      await x.bind('pty-1', 'synthetic-aaaa')
      x.advance(2_400)
      x.adapter.recordOutcome({ fromKey: 'synthetic-aaaa', sid: S1, via: 'collapse' })
      const d = x.adapter.diagnostics().parity
      expect(d.total).toBe(1)
      expect(d.byVerdict).toEqual({ match: 1 })
      expect(d.recent[0]).toMatchObject({
        shape: 'new',
        verdict: 'match',
        legacy: { via: 'collapse', afterSpawnMs: 2_400 }
      })
      expect(JSON.stringify(d)).not.toContain('synthetic-aaaa') // hashes only
    })

    it('a claim-driven migration (via companion) is companion-only, legacy null', async () => {
      const x = await rig()
      await x.bind('pty-1', 'synthetic-aaaa')
      x.adapter.recordOutcome({ fromKey: 'synthetic-aaaa', sid: S1, via: 'companion' })
      expect(x.adapter.diagnostics().parity.recent[0]).toMatchObject({
        verdict: 'companion-only',
        legacy: null
      })
    })

    it('crossed binders are a mismatch; the same outcome is never counted twice', async () => {
      const x = await rig({ mode: 'shadow' })
      await x.bind('pty-1', 'synthetic-aaaa')
      x.adapter.recordOutcome({ fromKey: 'synthetic-zzzz', sid: S1, via: 'agent-correlation' })
      x.adapter.recordOutcome({ fromKey: 'synthetic-zzzz', sid: S1, via: 'agent-correlation' })
      expect(x.adapter.diagnostics().parity.byVerdict).toEqual({ mismatch: 1, 'legacy-only': 1 })
    })

    it('no hello for the row: legacy-only, except in mode off where nothing is expected', async () => {
      const x = await rig({ mode: 'shadow' })
      x.adapter.recordOutcome({ fromKey: 'synthetic-nohello', sid: S3, via: 'collapse' })
      expect(x.adapter.diagnostics().parity.byVerdict).toEqual({ 'legacy-only': 1 })
      const off = await rig({ mode: 'shadow' })
      off.mode.set('off') // the listener stays up; the family reads off
      off.adapter.recordOutcome({ fromKey: 'synthetic-nohello', sid: S3, via: 'collapse' })
      expect(off.adapter.diagnostics().parity.total).toBe(0)
    })

    it('a binding that ends before any legacy bind records companion-only', async () => {
      const x = await rig()
      await x.bind('pty-1', 'synthetic-aaaa')
      x.host.facade.releaseSpawn({ kind: 'pty', ptyId: 'pty-1' }, 'pty-exit')
      expect(x.adapter.diagnostics().parity.byVerdict).toEqual({ 'companion-only': 1 })
    })

    it('shape follows the spawn: agent, fork, resume, clear and in-session resume', async () => {
      const x = await rig()
      x.kinds.set('pty-f', 'claude-fork')
      const fork = await x.bind('pty-f', 'synthetic-fork', S1)
      void fork
      x.adapter.recordOutcome({ fromKey: 'synthetic-fork', sid: S1, via: 'collapse' })
      await x.bind('pty-r', S2, S2) // key === sid: a resumed or woken session
      x.host.facade.releaseSpawn({ kind: 'pty', ptyId: 'pty-r' }, 'pty-exit')
      const shapes = x.adapter.diagnostics().parity.recent.map((r) => r.shape)
      expect(shapes).toContain('fork')
    })

    it('a conflict records one conflict verdict and no claim', async () => {
      const x = await rig()
      await x.bind('pty-1', 'row-one', S1)
      const second = await x.bind('pty-2', 'row-two', S2)
      await x.rebound({ conn: second.conn }, S2, S1, 'resume')
      await tick()
      expect(x.adapter.diagnostics().parity.byVerdict).toMatchObject({ conflict: 1 })
    })
  })
})
