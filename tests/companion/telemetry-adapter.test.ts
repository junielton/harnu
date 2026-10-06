import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { helloSpawnRequest } from '../../resources/companion/tests/fixtures/hello'
import type { RolloutView } from '../../src/main/companion/arbitration-core'
import { LEASE_TTL_MS, type Conn, type EndpointFile } from '../../src/main/companion/contract'
import {
  createTelemetryAdapter,
  type TelemetryParityDetail
} from '../../src/main/companion/ingest/telemetry-adapter'
import { createSessionArbiter } from '../../src/main/companion/session-arbiter'
import type { SessionTelemetry } from '../../src/main/statusline-parse'
import { createTelemetryStore } from '../../src/main/telemetry-store'
import { post } from './support/client'
import { createCompanionHost, fakeMode, shortTmp } from './support/host-rig'

const SID = helloSpawnRequest.sid
const owner = { kind: 'pty', ptyId: 'pty-1' } as const
const FEATURES = ['sense.identity', 'sense.usage']
const dirs: string[] = []
const closers: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const c of closers.splice(0)) await c()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const SL: SessionTelemetry = {
  sessionId: SID,
  cwd: '/work/example-web',
  modelId: 'claude-sl',
  modelName: 'SL',
  costUsd: 9.99,
  linesAdded: 12,
  linesRemoved: 3,
  durationMs: 45_000,
  contextPercent: 88,
  contextWindowSize: 123_456,
  exceeds200k: false,
  effortLevel: 'high',
  thinkingEnabled: true,
  outputStyle: 'default',
  pr: null,
  rateLimits: {
    fiveHour: { usedPercent: 77, resetsAtMs: 1_000 },
    sevenDay: { usedPercent: 66, resetsAtMs: 2_000 }
  },
  updatedAtMs: 1_790_000_000_000
}

const A3 = {
  source: 'measure',
  context: { window: 200000, tokens: 49284, percent: 25 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 21, resetsAt: '2026-10-02T18:00:00.000Z' },
    { kind: 'seven_day', percentUsed: 54, resetsAt: '2026-10-05T19:00:00.000Z' }
  ],
  costUsd: 0.19372685,
  changed: ['context', 'rateLimits', 'cost']
}

interface RigOpts {
  family?: 'active' | 'shadow' | 'off'
  enable?: string[]
  bound?: boolean
}

async function rig(opts: RigOpts = {}) {
  let t = 1_000
  const dir = join(shortTmp('hc-t-'), 'companion')
  dirs.push(join(dir, '..'))
  const rollout = {
    enabled: true,
    cliGate: 'ok',
    families: { telemetry: opts.family ?? 'active', planUsage: opts.family ?? 'active' },
    allFolders: true,
    rampFolders: new Set<string>()
  } as RolloutView
  const mode = fakeMode('active')
  const host = createCompanionHost({
    dir,
    mode: mode.mode,
    now: () => t,
    sessionKeyOf: () => 'key:pty-1',
    log: () => undefined
  })
  closers.push(() => host.close())
  await host.register()
  host.facade.setEnablePolicy(() => opts.enable ?? FEATURES)
  const arbiter = createSessionArbiter({ host: host.facade, rollout: () => rollout })
  closers.push(() => arbiter.dispose())
  const captured: unknown[] = []
  const store = createTelemetryStore({
    now: () => 1_790_000_100_000,
    captureFleet: (f) => void captured.push(f),
    cachePath: () => null,
    send: () => undefined
  })
  const facts: { source: string; sid: string; k: string; d: TelemetryParityDetail }[] = []
  const adapter = createTelemetryAdapter({
    host: host.facade,
    owns: (sid) => arbiter.owns(sid, 'telemetry'),
    onOwnershipChange: (fn) => arbiter.onOwnershipChange(fn),
    onModeChange: (fn) => mode.mode.onChange(fn),
    store,
    now: () => 1_790_000_050_000,
    recordFact: (source, sid, k, d) => void facts.push({ source, sid, k, d }),
    isBound: () => opts.bound ?? true
  })
  closers.push(() => adapter.dispose())
  const ep = JSON.parse(readFileSync(join(dir, 'endpoint.json'), 'utf8')) as EndpointFile
  const token = host.facade.mintSpawnToken({ owner, trust: 'operator', cwd: '/work/example-web' })!
  const hello = await post(ep, 'hello', {
    body: { ...helloSpawnRequest, spawn: token, declared: FEATURES }
  })
  expect(hello.json.ok).toBe(true)
  const conn = hello.json.conn as Conn
  let seq = 0
  const send = (d: unknown, type = 'usage.measured') =>
    post(ep, 'events', {
      body: {
        v: 1,
        sid: SID,
        conn,
        sentAt: 1,
        events: [{ seq: ++seq, t: type, ts: 1_790_000_000_000, d }]
      }
    })
  const view = () => host.facade.getBinding('key:pty-1')!
  return {
    host,
    arbiter,
    store,
    send,
    view,
    rollout,
    mode,
    facts,
    captured,
    advance: (ms: number) => {
      t += ms
      host.sweepNow()
    }
  }
}

const mine = (r: { store: ReturnType<typeof createTelemetryStore> }) =>
  r.store.getTelemetryPayload().perSession.find((x) => x.sessionId === SID)

describe('telemetry adapter', () => {
  it('the first reading proves sense.usage and is applied', async () => {
    const x = await rig()
    x.store.ingestStatusline(SL)
    expect(x.view().proven).not.toContain('sense.usage')
    const r = await x.send(A3)
    expect(r.json.ok).toBe(true)
    expect(x.view().proven).toContain('sense.usage')
    const t = mine(x)!
    expect(t.costUsd).toBe(0.19372685)
    expect(t.contextPercent).toBe(25)
    expect(t.rateLimits.fiveHour?.resetsAtMs).toBe(Date.parse('2026-10-02T18:00:00.000Z'))
    expect(t.linesAdded).toBe(12) // the statusLine's, always
    expect(x.store.lastContextTokens(SID)).toBe(49284)
    expect(x.captured.length).toBeGreaterThan(1) // the companion path fed usage history (R14)
  })

  it('a window-only first measure proves nothing and writes nothing (smoke A3)', async () => {
    const x = await rig()
    x.store.ingestStatusline(SL)
    await x.send({ source: 'measure', context: { window: 200000 }, rateLimits: [], changed: [] })
    expect(x.view().proven).not.toContain('sense.usage')
    expect(mine(x)).toEqual(SL)
  })

  it('shadow: the reading goes to the ledger and the payload stays the statusLine’s', async () => {
    const x = await rig({ family: 'shadow' })
    x.store.ingestStatusline(SL)
    await x.send(A3)
    expect(mine(x)).toEqual(SL)
    expect(x.facts.filter((f) => f.source === 'companion').length).toBe(1)
    expect(x.facts.find((f) => f.source === 'companion')!.d).toMatchObject({
      pct: 25,
      usd: 0.19372685,
      h5: 21,
      d7: 54
    })
  })

  it('an empty window list after a full reading keeps the windows (smoke A2)', async () => {
    const x = await rig()
    await x.send(A3)
    await x.send({ ...A3, source: 'read', rateLimits: [], costUsd: 0.2, changed: ['cost'] })
    const t = mine(x)!
    expect(t.costUsd).toBe(0.2)
    expect(t.rateLimits.fiveHour?.usedPercent).toBe(21)
  })

  it('lease loss returns every group at once, and the statusLine resumes (AC-P1W6-9)', async () => {
    const x = await rig()
    x.store.ingestStatusline(SL)
    await x.send(A3)
    expect(mine(x)?.costUsd).toBe(0.19372685)
    x.advance(LEASE_TTL_MS + 1)
    expect(mine(x)).toEqual(SL)
    expect(x.store.companionSids()).toEqual([])
    // sticky: a later reading is not owned again for the rest of the session (ARB-4c)
    await x.send({ ...A3, costUsd: 5 })
    expect(mine(x)).toEqual(SL)
  })

  it('the kill switch mid-session returns every group with no TTL wait (AC-P1W6-26)', async () => {
    const x = await rig()
    x.store.ingestStatusline(SL)
    await x.send(A3)
    expect(mine(x)?.costUsd).toBe(0.19372685)
    x.rollout.enabled = false
    x.host.facade.revoke(x.view()) // the host's revokeAll does exactly this per binding
    expect(mine(x)).toEqual(SL)
    expect(x.store.companionSids()).toEqual([])
  })

  it('a mode flip to shadow drops without waiting for the next reading', async () => {
    const x = await rig()
    x.store.ingestStatusline(SL)
    await x.send(A3)
    x.rollout.families = { telemetry: 'shadow', planUsage: 'shadow' }
    x.mode.set('shadow')
    expect(mine(x)).toEqual(SL)
  })

  it('a feature that is not enabled is ignored', async () => {
    const x = await rig({ enable: ['sense.identity'] })
    x.store.ingestStatusline(SL)
    await x.send(A3)
    expect(mine(x)).toEqual(SL)
    expect(x.view().proven).not.toContain('sense.usage')
  })

  it('a forged payload misreports a number at most: it is clamped, and junk is dropped', async () => {
    const x = await rig()
    const r = await x.send({
      source: 'measure',
      context: { window: 200000, tokens: 1e12, percent: 9999 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 1e9 }],
      costUsd: 'free',
      changed: ['context']
    })
    expect(r.json.ok).toBe(true)
    expect(mine(x)!.contextPercent).toBe(100)
    expect(mine(x)!.rateLimits.fiveHour?.usedPercent).toBe(1000)
    expect(mine(x)!.costUsd).toBeNull()
    await x.send('not an object')
    await x.send(null)
    expect(x.store.companionSids()).toEqual([SID])
  })

  it('a session end drops what the companion held', async () => {
    const x = await rig()
    x.store.ingestStatusline(SL)
    await x.send(A3)
    x.host.facade.releaseSpawn(owner, 'pty-exit')
    expect(mine(x)).toEqual(SL)
  })

  it('records the statusLine side of the parity rule only for a bound session', async () => {
    const bound = await rig()
    bound.store.ingestStatusline(SL)
    expect(bound.facts).toEqual([
      expect.objectContaining({
        source: 'legacy',
        k: 'reading',
        d: expect.objectContaining({ src: 'statusline', pct: 88 })
      })
    ])
    const loose = await rig({ bound: false })
    loose.store.ingestStatusline(SL)
    expect(loose.facts).toEqual([])
  })

  it('never throws when the ledger does', async () => {
    const x = await rig()
    vi.spyOn(x.store, 'ingestCompanion')
    await expect(x.send(A3)).resolves.toBeDefined()
  })
})
