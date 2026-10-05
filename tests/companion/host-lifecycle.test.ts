import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LEASE_SWEEP_MS, LEASE_TTL_MS, type Conn } from '../../src/main/companion/contract'
import type { AuditRecord } from '../../src/main/companion/audit-core'
import { helloSpawnRequest } from '../../resources/companion/tests/fixtures/hello'
import { post } from './support/client'
import {
  createCompanionHost,
  fakeMode,
  shortTmp,
  stubServer,
  tick,
  type StartOptions
} from './support/host-rig'
import type { EndpointFile } from '../../src/main/companion/contract'

const owner = { kind: 'pty', ptyId: 'pty-1' } as const
const meta = { owner, trust: 'operator', cwd: '/tmp/example-project' } as const
const dirs: string[] = []
const closers: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const c of closers.splice(0)) await c()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('listener lifecycle (reconcileListener)', () => {
  it('the listener follows the mode inputs', async () => {
    const m = fakeMode('off')
    const start = vi.fn(async (_o: StartOptions) => stubServer())
    const host = createCompanionHost({ dir: '/nowhere', mode: m.mode, start, log: () => undefined })
    closers.push(() => host.close())
    await host.register()
    // the mode inputs read off at boot: nothing started, no spawn token
    expect(start).not.toHaveBeenCalled()
    expect(host.facade.mintSpawnToken(meta)).toBeNull()
    expect(host.facade.diagnostics().listener).toEqual({ state: 'off' })
    // they change and onModeChange fires: the listener starts once
    m.set('shadow')
    await tick()
    expect(start).toHaveBeenCalledTimes(1)
    expect(host.facade.mintSpawnToken(meta)).toMatch(/^sp_/)
    expect(host.facade.diagnostics().listener).toMatchObject({
      state: 'listening',
      transport: 'unix',
      bootId: 'b_stub'
    })
    // a second change never starts a second one
    m.set('active')
    await tick()
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('never stops a running listener when the inputs go back to off', async () => {
    const m = fakeMode('shadow')
    const stop = vi.fn(async () => undefined)
    const host = createCompanionHost({
      dir: '/nowhere',
      mode: m.mode,
      start: async () => stubServer({ stop }),
      log: () => undefined
    })
    closers.push(() => host.close())
    await host.register()
    m.set('off')
    await tick()
    expect(stop).not.toHaveBeenCalled()
    expect(host.facade.mintSpawnToken(meta)).toMatch(/^sp_/) // still serving: a revoked mod can re-hello
    await host.close()
    expect(stop).toHaveBeenCalledTimes(1)
    expect(host.facade.mintSpawnToken({ ...meta, owner: { kind: 'pty', ptyId: 'p2' } })).toBeNull()
  })

  it('a start failure is logged once and every spawn is a legacy spawn', async () => {
    const m = fakeMode('shadow')
    const log = vi.fn()
    const start = vi.fn(async () => {
      throw Object.assign(
        new Error('listen EACCES: permission denied /home/u/.config/Harnu/companion/c.sock'),
        {
          code: 'EACCES'
        }
      )
    })
    const host = createCompanionHost({ dir: '/nowhere', mode: m.mode, start, log })
    closers.push(() => host.close())
    await host.register()
    expect(host.facade.mintSpawnToken(meta)).toBeNull()
    const diag = host.facade.diagnostics()
    expect(diag.listener).toEqual({ state: 'failed', reason: 'EACCES' })
    expect(JSON.stringify(diag)).not.toContain('/home/u') // no path in diagnostics (SEC-8)
    // a later input change retries, and logs nothing more
    m.set('active')
    await tick()
    expect(start).toHaveBeenCalledTimes(2)
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('the lease sweep emits one lost edge per binding and writes one audit row', async () => {
    let t = 1_000
    const audit: AuditRecord[] = []
    const dir = join(shortTmp('hc-h-'), 'companion')
    dirs.push(join(dir, '..'))
    const host = createCompanionHost({
      dir,
      mode: fakeMode('shadow').mode,
      now: () => t,
      epochNow: () => 1_790_000_000_000,
      appendAudit: (r) => void audit.push(r),
      log: () => undefined
    })
    closers.push(() => host.close())
    await host.register()
    host.facade.setEnablePolicy(() => ['sense.identity'])
    const lost: string[] = []
    host.facade.bus.on('lease', (b, state) => void lost.push(`${b.sid}:${state}`))
    const changes: string[] = []
    host.facade.onBindingChange((b) => void changes.push(b.state))
    const ep = JSON.parse(readFileSync(join(dir, 'endpoint.json'), 'utf8')) as EndpointFile
    const token = host.facade.mintSpawnToken(meta)!
    const r = await post(ep, 'hello', { body: { ...helloSpawnRequest, spawn: token } })
    expect(r.json.ok).toBe(true)
    await tick()
    host.sweepNow()
    expect(lost).toEqual([]) // lease is live
    t += LEASE_TTL_MS + 1
    host.sweepNow()
    host.sweepNow()
    expect(lost).toEqual([`${helloSpawnRequest.sid}:lost`])
    expect(audit.map((a) => (a.kind === 'binding' ? a.change : a.kind))).toEqual([
      'bound',
      'lease-lost'
    ])
    expect(changes).toEqual(['bound', 'bound']) // hello, then the lease edge
    expect(LEASE_SWEEP_MS).toBe(5000)
  })

  it('resume from suspend gives every binding one TTL before the loss counts', async () => {
    let t = 1_000
    let resume: () => void = () => undefined
    const dir = join(shortTmp('hc-h-'), 'companion')
    dirs.push(join(dir, '..'))
    const host = createCompanionHost({
      dir,
      mode: fakeMode('shadow').mode,
      now: () => t,
      onResume: (fn) => {
        resume = fn
        return () => undefined
      },
      log: () => undefined
    })
    closers.push(() => host.close())
    await host.register()
    host.facade.setEnablePolicy(() => ['sense.identity'])
    const ep = JSON.parse(readFileSync(join(dir, 'endpoint.json'), 'utf8')) as EndpointFile
    const token = host.facade.mintSpawnToken(meta)!
    await post(ep, 'hello', { body: { ...helloSpawnRequest, spawn: token } })
    const lost: string[] = []
    host.facade.bus.on('lease', (b) => void lost.push(b.sid))
    t += LEASE_TTL_MS * 50 // the machine slept
    resume()
    host.sweepNow()
    expect(lost).toEqual([])
    t += LEASE_TTL_MS
    host.sweepNow()
    expect(lost).toHaveLength(1)
  })
})

describe('facade, bus and extension points', () => {
  async function liveHost(over: { appendAudit?: (r: AuditRecord) => void } = {}) {
    const dir = join(shortTmp('hc-h-'), 'companion')
    dirs.push(join(dir, '..'))
    const host = createCompanionHost({
      dir,
      mode: fakeMode('shadow').mode,
      log: () => undefined,
      sessionKeyOf: (o) => (o.kind === 'pty' ? `key:${o.ptyId}` : null),
      ...over
    })
    closers.push(() => host.close())
    await host.register()
    const ep = JSON.parse(readFileSync(join(dir, 'endpoint.json'), 'utf8')) as EndpointFile
    const bind = async (ptyId = 'pty-1', over: Record<string, unknown> = {}) => {
      const token = host.facade.mintSpawnToken({ ...meta, owner: { kind: 'pty', ptyId } })!
      const r = await post(ep, 'hello', { body: { ...helloSpawnRequest, ...over, spawn: token } })
      return { conn: r.json.conn as Conn, sid: (over.sid as string) ?? helloSpawnRequest.sid, r }
    }
    const env = (conn: Conn, sid = helloSpawnRequest.sid) => ({ v: 1, sid, conn, sentAt: 1 })
    return { host, ep, bind, env }
  }

  it('pty exit closes the binding and the bus emits end', async () => {
    const audit: AuditRecord[] = []
    const { host, ep, bind, env } = await liveHost({ appendAudit: (r) => void audit.push(r) })
    host.facade.setEnablePolicy(() => ['sense.identity'])
    const ends: string[] = []
    host.facade.bus.on('end', (b, reason) => void ends.push(`${b.state}:${reason}`))
    const { conn, sid } = await bind()
    await post(ep, 'events', { body: { ...env(conn, sid), events: [] } })
    host.facade.releaseSpawn({ kind: 'pty', ptyId: 'pty-1' }, 'pty-exit')
    expect(ends).toEqual(['closed:pty-exit'])
    const after = await post(ep, 'events', { body: { ...env(conn, sid), events: [] } })
    expect(after.json).toMatchObject({ ok: false, code: 'STALE_CONN' })
    expect(host.facade.getBinding('key:pty-1')?.state).toBe('closed')
    expect(host.facade.spawnRecord({ kind: 'pty', ptyId: 'pty-1' })?.state).toBe('released')
    expect(audit.map((a) => (a.kind === 'binding' ? a.change : ''))).toEqual(['bound', 'ended'])
    // releasing something that never bound is quiet
    host.facade.releaseSpawn({ kind: 'pty', ptyId: 'never' }, 'spawn-aborted')
    expect(ends).toHaveLength(1)
  })

  it('hello, event and end reach the bus after the response, with token-free views', async () => {
    const { host, ep, bind, env } = await liveHost()
    host.facade.registerEventTypes(['subagent.started'])
    const seen: string[] = []
    host.facade.bus.on('hello', (b, kind) => void seen.push(`hello:${kind}:${b.sessionKey}`))
    host.facade.bus.on('event', (b, e) => void seen.push(`event:${e.t}:${b.sid}`))
    host.facade.bus.on('end', (_b, reason) => void seen.push(`end:${reason}`))
    // a throwing listener does not stop the next one
    host.facade.bus.on('event', () => {
      throw new Error('boom')
    })
    const { conn, sid } = await bind()
    await post(ep, 'events', {
      body: {
        ...env(conn, sid),
        events: [{ seq: 1, t: 'subagent.started', ts: 1, d: { agentType: 'x' } }]
      }
    })
    await post(ep, 'bye', { body: { ...env(conn, sid), reason: 'exit' } })
    await tick()
    expect(seen).toEqual([
      'hello:spawn:key:pty-1',
      `event:subagent.started:${helloSpawnRequest.sid}`,
      'end:exit'
    ])
  })

  it('looks bindings up by session key, by sid, and by either', async () => {
    const { host, bind } = await liveHost()
    await bind('pty-1')
    const other = '55555555-5555-4555-8555-555555555555'
    await bind('pty-2', { sid: other })
    expect(host.facade.bindingForSession('key:pty-2')?.sid).toBe(other)
    expect(host.facade.bindingForSid(helloSpawnRequest.sid)?.sessionKey).toBe('key:pty-1')
    expect(host.facade.getBinding('key:pty-1')?.sid).toBe(helloSpawnRequest.sid)
    expect(host.facade.getBinding(other)?.sessionKey).toBe('key:pty-2')
    expect(host.facade.getBinding('nobody')).toBeNull()
    expect(host.facade.bindingForSession('nobody')).toBeNull()
  })

  it('revoke and rebind notify, audit and change what a later read sees', async () => {
    const audit: AuditRecord[] = []
    const { host, ep, bind, env } = await liveHost({ appendAudit: (r) => void audit.push(r) })
    host.facade.setEnablePolicy(() => ['sense.identity'])
    const changes: number[] = []
    host.facade.onBindingChange((b) => void changes.push(b.key))
    const { conn, sid } = await bind()
    const view = host.facade.getBinding(sid)!
    host.facade.rebind(view, '66666666-6666-4666-8666-666666666666')
    expect(host.facade.getBinding('66666666-6666-4666-8666-666666666666')?.key).toBe(view.key)
    host.facade.revoke(
      host.facade.getBinding(view.sid === sid ? '66666666-6666-4666-8666-666666666666' : sid)!
    )
    const r = await post(ep, 'events', { body: { ...env(conn, sid), events: [] } })
    expect(r.json.code).toBe('STALE_CONN')
    const rows = audit.map((a) => (a.kind === 'binding' ? a.change : ''))
    expect(rows).toEqual(['bound', 'rebound', 'revoked'])
    expect(audit[1]).toMatchObject({ prevSid: sid })
    expect(changes).toHaveLength(3)
  })

  it('markProven and revokeProof edit the proven set a view reports', async () => {
    const { host, bind } = await liveHost()
    await bind()
    const v = host.facade.getBinding(helloSpawnRequest.sid)!
    host.facade.markProven(v, 'sense.identity')
    expect(host.facade.getBinding(v.sid)?.proven).toEqual(['sense.identity'])
    host.facade.revokeProof(v, 'sense.identity')
    expect(host.facade.getBinding(v.sid)?.proven).toEqual([])
  })

  it('poll and ask handlers, the command source and beforeHello plug into the endpoints', async () => {
    const { host, ep, bind, env } = await liveHost()
    const { conn, sid } = await bind()
    const poll = { ...env(conn, sid), bootId: ep.bootId, cursor: 0 }
    expect((await post(ep, 'poll', { body: poll })).json.code).toBe('FEATURE_DISABLED')
    host.facade.setPollHandler((_b, _req, reply) => reply({ ok: true, commands: [] }))
    expect((await post(ep, 'poll', { body: poll })).json).toEqual({ ok: true, commands: [] })

    const ask = { ...env(conn, sid), askId: 'ask_q1', kind: 'status', d: {} }
    expect((await post(ep, 'ask', { body: ask })).json.code).toBe('FEATURE_DISABLED')
    host.facade.registerAskKind('status', (_b, _req, reply) =>
      reply({ ok: true, state: 'released', reason: 'abstain' })
    )
    expect((await post(ep, 'ask', { body: ask })).json).toEqual({
      ok: true,
      state: 'released',
      reason: 'abstain'
    })

    const cmd = { cmd: 'cmd_1', n: 1, name: 'flush', args: {}, issuedAt: 1, expiresAt: 2 } as const
    host.facade.setCommandSource(() => [cmd])
    const order: string[] = []
    const off = host.facade.beforeHello(() => void order.push('before'))
    const second = await bind('pty-2', { sid: '77777777-7777-4777-8777-777777777777' })
    expect(second.r.json.commands).toEqual([cmd])
    expect(order).toEqual(['before'])
    off()
    await bind('pty-3', { sid: '88888888-8888-4888-8888-888888888888' })
    expect(order).toEqual(['before'])
  })

  it('hold keeps a lease live while a request is parked', async () => {
    let t = 1_000
    const dir = join(shortTmp('hc-h-'), 'companion')
    dirs.push(join(dir, '..'))
    const host = createCompanionHost({
      dir,
      mode: fakeMode('shadow').mode,
      now: () => t,
      log: () => undefined
    })
    closers.push(() => host.close())
    await host.register()
    host.facade.setEnablePolicy(() => ['sense.identity'])
    const ep = JSON.parse(readFileSync(join(dir, 'endpoint.json'), 'utf8')) as EndpointFile
    const token = host.facade.mintSpawnToken(meta)!
    await post(ep, 'hello', { body: { ...helloSpawnRequest, spawn: token } })
    const view = host.facade.getBinding(helloSpawnRequest.sid)!
    const release = host.facade.hold(view)
    t += LEASE_TTL_MS * 4
    expect(host.facade.getBinding(view.sid)?.lease).toBe('live')
    host.sweepNow()
    release()
    expect(host.facade.verifyStamp('000000000000', 'n', 't', 'm')).toBe('unknown-binding')
  })
})

describe('electron shell', () => {
  it('registerCompanionHost with no prefs file creates no directory and no socket', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'hc-ud-'))
    dirs.push(userData)
    const handlers = new Map<string, unknown>()
    const electron = {
      app: { getPath: () => userData, isPackaged: false },
      powerMonitor: { on: vi.fn(), removeListener: vi.fn() },
      ipcMain: { handle: vi.fn((ch: string, fn: unknown) => void handlers.set(ch, fn)) }
    }
    vi.doMock('electron', () => electron)
    vi.resetModules()
    const mod = await import('../../src/main/companion/host')
    await mod.registerCompanionHost(() => null)
    expect(existsSync(join(userData, 'companion'))).toBe(false)
    expect(existsSync(join(userData, 'companion', 'c.sock'))).toBe(false)
    expect(mod.companionHost.mintSpawnToken(meta)).toBeNull()
    expect(handlers.has('companion:diagnostics')).toBe(true)
    const diag = (await (handlers.get('companion:diagnostics') as () => Promise<unknown>)()) as {
      mode: string
      listener: { state: string }
    }
    expect(diag).toMatchObject({ mode: 'off', listener: { state: 'off' } })
    // unpackaged: the dev mint is served, and it refuses while nothing listens
    const mint = handlers.get('companion:devMintSpawn') as () => Promise<unknown>
    expect(await mint()).toBeNull()
    await mod.closeCompanionHost()
    vi.doUnmock('electron')
  })

  it('a packaged build registers no dev mint', async () => {
    const handlers = new Set<string>()
    vi.doMock('electron', () => ({
      app: { getPath: () => tmpdir(), isPackaged: true },
      powerMonitor: { on: vi.fn(), removeListener: vi.fn() },
      ipcMain: { handle: (ch: string) => void handlers.add(ch) }
    }))
    vi.resetModules()
    const { registerCompanionIpc } = await import('../../src/main/companion/companion-ipc')
    const { companionHost } = await import('../../src/main/companion/host')
    registerCompanionIpc(companionHost)
    expect([...handlers]).toEqual(['companion:diagnostics'])
    vi.doUnmock('electron')
  })
})
