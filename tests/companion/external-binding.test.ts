// The host side of an outside session, against the real server on a real socket in a temp dir.
import { readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AuditRecord } from '../../src/main/companion/audit-core'
import {
  EXTERNAL_CORROBORATE_MS,
  EXTERNAL_MAX_BINDINGS,
  type Command,
  type Conn,
  type EndpointFile,
  type WireEvent
} from '../../src/main/companion/contract'
import {
  createExternalBinding,
  externalCommandAllowed,
  type ExternalBinding
} from '../../src/main/companion/external-binding'
import { createCompanionHost, type CompanionHostCore } from '../../src/main/companion/host-core'
import type { CompanionMode } from '../../src/main/companion/mode'
import { createSessionArbiter } from '../../src/main/companion/session-arbiter'
import { helloSpawnRequest } from '../../resources/companion/tests/fixtures/hello'
import { post, shortTmp } from './support/client'
import { tick } from './support/host-rig'

const SID = '22222222-2222-4222-8222-222222222222'
const CWD = '/tmp/example-project'

interface Rig {
  core: CompanionHostCore
  ext: ExternalBinding
  ep: EndpointFile
  audits: AuditRecord[]
  busEvents: { sid: string; t: string; seq: number }[]
  state: {
    on: boolean
    mode: CompanionMode
    enabled: boolean
    corroborated: Set<string>
    owned: Set<string>
    clock: number
    commands: Command[]
  }
  setEnabled(v: boolean): void
  hello(over?: Record<string, unknown>): Promise<{ json: Record<string, unknown>; conn: Conn }>
  events(conn: Conn, sid: string, evs: Partial<WireEvent>[]): Promise<Record<string, unknown>>
  send(route: string, body: Record<string, unknown>): Promise<Record<string, unknown>>
}

const rigs: Rig[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    r.ext.dispose()
    await r.core.close()
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function boot(): Promise<Rig> {
  const dir = join(shortTmp('hc-x-'), 'companion')
  dirs.push(dirname(dir))
  const listeners = new Set<() => void>()
  const state: Rig['state'] = {
    on: true,
    mode: 'shadow',
    enabled: true,
    corroborated: new Set(),
    owned: new Set(),
    clock: 1_000,
    commands: []
  }
  const audits: AuditRecord[] = []
  const core = createCompanionHost({
    dir,
    mode: {
      getMode: () => (state.enabled ? state.mode : 'off'),
      listenerWanted: () => true,
      hydrate: async () => undefined,
      onChange: (fn) => {
        listeners.add(fn)
        return () => void listeners.delete(fn)
      },
      enabled: () => state.enabled
    },
    appendAudit: (r) => audits.push(r),
    log: () => undefined
  })
  const busEvents: Rig['busEvents'] = []
  core.facade.bus.on('event', (b, ev) => busEvents.push({ sid: b.sid, t: ev.t, seq: ev.seq }))
  core.facade.registerEventTypes(['session.snapshot', 'session.rebound'])
  const ext = createExternalBinding({
    host: core.facade,
    isOn: () => state.on,
    mode: () => (state.enabled ? state.mode : 'off'),
    sessionOwnedByHarnu: (sid) => state.owned.has(sid),
    corroborates: async (sid) => state.corroborated.has(sid),
    now: () => state.clock,
    epochNow: () => 1_790_000_000_000,
    appendAudit: (r) => audits.push(r)
  })
  core.facade.setEnablePolicy(ext.wrapPolicy((b) => [...b.declared]))
  core.facade.setCommandSource(() => state.commands)
  await core.register()
  const ep = JSON.parse(readFileSync(join(dir, 'endpoint.json'), 'utf8')) as EndpointFile
  const rig: Rig = {
    core,
    ext,
    ep,
    audits,
    busEvents,
    state,
    setEnabled(v) {
      state.enabled = v
      for (const l of [...listeners]) l()
    },
    async hello(over = {}) {
      const { spawn: _s, ...base } = helloSpawnRequest
      const r = await post(ep, 'hello', {
        body: { ...base, sid: SID, cwd: CWD, declared: ['sense.identity'], ...over }
      })
      return { json: r.json, conn: r.json?.conn as Conn }
    },
    async events(conn, sid, evs) {
      const events = evs.map((e, i) => ({ seq: i + 1, ts: 1, d: {}, ...e }))
      const r = await post(ep, 'events', { body: { v: 1, sid, conn, sentAt: 1, events } })
      return r.json
    },
    async send(route, body) {
      return (await post(ep, route, { body })).json
    }
  }
  rigs.push(rig)
  return rig
}

describe('a tokenless hello (contract §21)', () => {
  it('off means refused: the key off, the mode off, and the bound', async () => {
    const r = await boot()
    r.state.on = false
    expect((await r.hello()).json).toMatchObject({ ok: false, code: 'FEATURE_DISABLED' })
    r.state.on = true
    r.state.mode = 'off'
    expect((await r.hello()).json).toMatchObject({ ok: false, code: 'FEATURE_DISABLED' })
    r.state.mode = 'shadow'
    expect(r.core.facade.externalBindings()).toEqual([])
    expect((await r.hello()).json).toMatchObject({ ok: true, profile: 'external' })

    // Over the bound: SLOW_DOWN with a retry hint, and nothing new is bound.
    for (let i = 1; i < EXTERNAL_MAX_BINDINGS; i++) {
      const sid = `33333333-3333-4333-8333-${String(i).padStart(12, '0')}`
      expect((await r.hello({ sid })).json.ok).toBe(true)
    }
    expect(r.core.facade.externalBindings()).toHaveLength(EXTERNAL_MAX_BINDINGS)
    const over = await r.hello({ sid: '44444444-4444-4444-8444-444444444444' })
    expect(over.json).toMatchObject({ ok: false, code: 'SLOW_DOWN' })
    expect(typeof over.json.retryAfterMs).toBe('number')
    // The same sid again replaces its binding: it does not count against the bound.
    expect((await r.hello()).json.ok).toBe(true)
    expect(r.core.facade.externalBindings()).toHaveLength(EXTERNAL_MAX_BINDINGS)
  })

  it('answers the external profile with no commands and the external set', async () => {
    const r = await boot()
    r.state.commands = [cmd('prompt.submit')] // nothing may reach it, not even on the hello
    const h = await r.hello({ declared: ['sense.identity', 'act.prompt', 'gate.guard'] })
    expect(h.json).toMatchObject({ ok: true, profile: 'external', sessionKey: null })
    expect(h.json.commands).toBeUndefined()
    const view = r.core.facade.bindingForSid(SID)!
    expect(view).toMatchObject({ profile: 'external', owner: null, trust: 'read-only' })
    expect(view.corroborated).toBe(false)
  })

  it('validates the claim: sid is a uuid, cwd is absolute', async () => {
    const r = await boot()
    expect((await r.hello({ sid: 'not-a-uuid' })).json).toMatchObject({
      ok: false,
      code: 'BAD_ENVELOPE'
    })
    expect((await r.hello({ cwd: 'relative/dir' })).json).toMatchObject({
      ok: false,
      code: 'BAD_ENVELOPE'
    })
    expect(r.core.facade.externalBindings()).toEqual([])
  })

  it('a claim never displaces a spawned session', async () => {
    const r = await boot()
    const owner = { kind: 'pty', ptyId: 'pty-1' } as const
    const token = r.core.facade.mintSpawnToken({ owner, trust: 'operator', cwd: CWD })!
    const spawned = await post(r.ep, 'hello', {
      body: { ...helloSpawnRequest, sid: SID, spawn: token, declared: ['sense.identity'] }
    })
    expect(spawned.json.ok).toBe(true)
    const before = r.core.facade.bindingForSid(SID)!
    const claim = await r.hello()
    expect(claim.json).toMatchObject({ ok: false, code: 'UNAUTHORIZED' })
    // The spawned binding is untouched: same key, same state, and its conn still answers.
    const after = r.core.facade.bindingForSid(SID)!
    expect(after).toMatchObject({ key: before.key, state: 'bound', profile: 'interactive' })
    const still = await r.events(spawned.json.conn as Conn, SID, [{ t: 'session.snapshot' }])
    expect(still.ok).toBe(true)
    expect(r.core.facade.externalBindings()).toEqual([])

    // A session Harnu owns that has no live binding (parked, or its mod never said hello) too.
    r.state.owned.add('55555555-5555-4555-8555-555555555555')
    expect((await r.hello({ sid: '55555555-5555-4555-8555-555555555555' })).json).toMatchObject({
      ok: false,
      code: 'UNAUTHORIZED'
    })
  })
})

describe('corroboration (contract §21 item 6)', () => {
  it('nothing is shown before corroboration, and the buffer replays in order after it', async () => {
    const r = await boot()
    const { conn } = await r.hello()
    await r.events(conn, SID, [
      { t: 'session.snapshot' },
      { t: 'session.snapshot' },
      { t: 'session.snapshot' }
    ])
    await tick()
    await r.ext.sweep()
    expect(r.busEvents).toEqual([]) // no consumer saw a thing
    expect(r.ext.counts()).toMatchObject({ live: 1, corroborated: 0, held: 3 })
    expect(r.core.facade.bindingForSid(SID)!.corroborated).toBe(false)

    r.state.corroborated.add(SID) // the transcript watcher reports the session
    await r.ext.sweep()
    expect(r.busEvents.map((e) => e.seq)).toEqual([1, 2, 3])
    expect(r.core.facade.bindingForSid(SID)!.corroborated).toBe(true)
    expect(r.core.facade.bindingForSid(SID)!.proven).toContain('sense.identity')
    expect(r.ext.lastSeenAt()).not.toBeNull()

    // After that, events pass straight through.
    await r.events(conn, SID, [{ t: 'session.snapshot', seq: 4 }])
    await tick()
    expect(r.busEvents.map((e) => e.seq)).toEqual([1, 2, 3, 4])
  })

  it('answers a status ask "released: abstain" until corroborated', async () => {
    const r = await boot()
    const { conn } = await r.hello()
    const ask = await r.send('ask', {
      v: 1,
      sid: SID,
      conn,
      sentAt: 1,
      askId: 'ask_1',
      kind: 'status',
      d: { columns: 80, isFullscreen: false }
    })
    expect(ask).toEqual({ ok: true, state: 'released', reason: 'abstain' })
  })

  it('has no poll: an outside binding is told FEATURE_DISABLED', async () => {
    const r = await boot()
    r.core.facade.setPollHandler((_b, _req, reply) => reply({ ok: true, commands: [] }))
    const { conn } = await r.hello()
    const poll = await r.send('poll', { v: 1, sid: SID, conn, sentAt: 1, bootId: 'b_x', cursor: 0 })
    expect(poll).toMatchObject({ ok: false, code: 'FEATURE_DISABLED' })
  })

  it('the corroboration clock starts at the first turn', async () => {
    const r = await boot()
    const a = await r.hello()
    // No turn.started: kept, however long it waits.
    r.state.clock += EXTERNAL_CORROBORATE_MS * 10
    await r.ext.sweep()
    expect(r.core.facade.externalBindings()).toHaveLength(1)

    // The first turn.started starts the clock; just short of the limit it is still kept.
    await r.events(a.conn, SID, [{ t: 'turn.started', turnId: 't1', d: { origin: 'human' } }])
    await tick()
    await r.ext.sweep()
    r.state.clock += EXTERNAL_CORROBORATE_MS - 1
    await r.ext.sweep()
    expect(r.core.facade.externalBindings()).toHaveLength(1)

    // At the limit with no corroboration: dropped, and the mod's next request is STALE_CONN.
    r.state.clock += 1
    await r.ext.sweep()
    expect(r.core.facade.externalBindings()).toHaveLength(0)
    const next = await r.events(a.conn, SID, [{ t: 'session.snapshot', seq: 2 }])
    expect(next).toMatchObject({ ok: false, code: 'STALE_CONN' })
    expect(r.busEvents).toEqual([]) // nothing it said was ever shown

    // It may hello again; its resume says UNKNOWN_SESSION, a fresh claim is accepted.
    const resume = await r.send('hello', {
      ...helloSpawnRequest,
      spawn: undefined,
      sid: SID,
      cwd: CWD,
      resume: { conn: a.conn }
    })
    expect(resume).toMatchObject({ ok: false, code: 'UNKNOWN_SESSION' })
    expect((await r.hello()).json.ok).toBe(true)
  })

  it('a corroborated binding is never dropped by the clock', async () => {
    const r = await boot()
    const a = await r.hello()
    await r.events(a.conn, SID, [{ t: 'turn.started', turnId: 't1', d: { origin: 'human' } }])
    r.state.corroborated.add(SID)
    await tick()
    await r.ext.sweep()
    r.state.clock += EXTERNAL_CORROBORATE_MS * 5
    await r.ext.sweep()
    expect(r.core.facade.externalBindings()).toHaveLength(1)
  })

  it('a rebound needs corroborating again for the new id', async () => {
    const r = await boot()
    const a = await r.hello()
    r.state.corroborated.add(SID)
    await r.events(a.conn, SID, [{ t: 'session.snapshot' }])
    await tick()
    await r.ext.sweep()
    expect(r.core.facade.bindingForSid(SID)!.corroborated).toBe(true)

    // The mod says the session was /clear-ed: new sid, no transcript for it yet.
    const NEW = '66666666-6666-4666-8666-666666666666'
    await r.events(a.conn, SID, [
      { seq: 2, t: 'session.rebound', d: { prevSid: SID, sid: NEW, cause: 'clear' } }
    ])
    await tick()
    // Without an identity adapter in this rig the bus does not re-key; do what it does.
    const view = r.core.facade.bindingForSid(SID)!
    r.core.facade.rebind(view, NEW)
    await tick()
    expect(r.core.facade.bindingForSid(NEW)!.corroborated).toBe(false)
    const held: number[] = []
    r.core.facade.bus.on('event', (b, ev) => {
      if (b.sid === NEW) held.push(ev.seq)
    })
    await r.events(a.conn, NEW, [{ seq: 3, t: 'session.snapshot' }])
    await tick()
    expect(held).toEqual([]) // held until the new id is corroborated
    r.state.corroborated.add(NEW)
    await r.ext.sweep()
    expect(held).toEqual([3])
  })
})

const cmd = (name: string): Command =>
  ({ cmd: `cmd_${name}`, n: 1, name, args: {}, issuedAt: 1, expiresAt: 2 }) as unknown as Command

describe('the origin gate (contract §21 item 5)', () => {
  it('host refuses actuators for external', async () => {
    const r = await boot()
    expect(['flush', 'config.update', 'ui.band.set'].every(externalCommandAllowed)).toBe(true)
    for (const n of [
      'prompt.submit',
      'message.deliver',
      'context.append',
      'context.drop',
      'guard.set',
      'sentinel.set',
      'plan.capture',
      'turn.abort',
      'session.compact',
      'ui.toast',
      'ui.status'
    ]) {
      expect(externalCommandAllowed(n)).toBe(false)
    }
    const { conn } = await r.hello()
    r.state.commands = [
      cmd('prompt.submit'),
      cmd('flush'),
      cmd('message.deliver'),
      cmd('context.append'),
      cmd('ui.toast'),
      cmd('ui.band.set')
    ]
    const res = await r.events(conn, SID, [])
    const names = (res.commands as Command[]).map((c) => c.name)
    expect(names).toEqual(['flush', 'ui.band.set'])
    const refused = r.audits.filter((a) => a.kind === 'command-refused') as {
      command: string
      profile: string
    }[]
    expect(refused.map((a) => a.command)).toEqual([
      'prompt.submit',
      'message.deliver',
      'context.append',
      'ui.toast'
    ])
    expect(refused.every((a) => a.profile === 'external')).toBe(true)
    expect(JSON.stringify(r.audits)).not.toMatch(/"conn"|"text"|"args"/)
  })

  it('a spawned binding keeps every command', async () => {
    const r = await boot()
    r.state.commands = [cmd('prompt.submit'), cmd('flush')]
    const owner = { kind: 'pty', ptyId: 'pty-9' } as const
    const token = r.core.facade.mintSpawnToken({ owner, trust: 'operator', cwd: CWD })!
    const h = await post(r.ep, 'hello', {
      body: {
        ...helloSpawnRequest,
        sid: '77777777-7777-4777-8777-777777777777',
        spawn: token,
        declared: ['sense.identity']
      }
    })
    expect((h.json.commands as Command[]).map((c) => c.name)).toEqual(['prompt.submit', 'flush'])
  })
})

describe('the switch and the kill switch (contract §21 item 8)', () => {
  async function twoBindings(r: Rig): Promise<Conn[]> {
    const B = '88888888-8888-4888-8888-888888888888'
    const a = await r.hello()
    const b = await r.hello({ sid: B })
    r.state.corroborated.add(SID)
    r.state.corroborated.add(B)
    await r.events(a.conn, SID, [{ t: 'session.snapshot' }])
    await r.events(b.conn, B, [{ t: 'session.snapshot' }])
    await tick()
    await r.ext.sweep()
    expect(r.core.facade.externalBindings()).toHaveLength(2)
    return [a.conn, b.conn]
  }

  it('switch off revokes every external binding', async () => {
    const r = await boot()
    const [ca, cb] = await twoBindings(r)
    const seen = r.busEvents.length
    r.state.on = false
    r.ext.setSwitch(false)
    expect(r.core.facade.externalBindings()).toHaveLength(0)
    const B = '88888888-8888-4888-8888-888888888888'
    expect(await r.events(ca, SID, [{ seq: 2, t: 'session.snapshot' }])).toMatchObject({
      ok: false,
      code: 'STALE_CONN'
    })
    expect(await r.events(cb, B, [{ seq: 2, t: 'session.snapshot' }])).toMatchObject({
      ok: false,
      code: 'STALE_CONN'
    })
    expect(r.busEvents.length).toBe(seen) // no hub input after the revoke
    // The mod's resume re-hello is accepted and answered with nothing enabled.
    const again = await r.send('hello', {
      ...helloSpawnRequest,
      spawn: undefined,
      sid: SID,
      cwd: CWD,
      declared: ['sense.identity'],
      resume: { conn: ca }
    })
    expect(again).toMatchObject({ ok: true, profile: 'external', enable: [] })
    // A fresh claim with the key off is FEATURE_DISABLED.
    expect((await r.hello({ sid: '99999999-9999-4999-8999-999999999999' })).json).toMatchObject({
      ok: false,
      code: 'FEATURE_DISABLED'
    })
  })

  it('kill switch off revokes every external binding', async () => {
    const r = await boot()
    const [ca, cb] = await twoBindings(r)
    const seen = r.busEvents.length
    r.setEnabled(false)
    await tick()
    expect(r.core.facade.externalBindings()).toHaveLength(0)
    expect(await r.events(ca, SID, [{ seq: 2, t: 'session.snapshot' }])).toMatchObject({
      ok: false,
      code: 'STALE_CONN'
    })
    expect(await r.events(cb, '88888888-8888-4888-8888-888888888888', [])).toMatchObject({
      ok: false,
      code: 'STALE_CONN'
    })
    expect(r.busEvents.length).toBe(seen)
    // Turning the kill switch back on reaches new sessions only: the revoked one stays empty.
    r.setEnabled(true)
    const again = await r.send('hello', {
      ...helloSpawnRequest,
      spawn: undefined,
      sid: SID,
      cwd: CWD,
      declared: ['sense.identity'],
      resume: { conn: ca }
    })
    expect(again).toMatchObject({ ok: true, enable: [] })
  })
})

describe('approvals (§7.7)', () => {
  it('gate.approval is enabled only for a corroborated binding on the ramp with an active family', async () => {
    const r = await boot()
    // Re-create the binding module with the ramp wired.
    r.ext.dispose()
    let ramp = false
    let active = false
    const ext = createExternalBinding({
      host: r.core.facade,
      isOn: () => true,
      mode: () => 'shadow',
      sessionOwnedByHarnu: () => false,
      corroborates: async (sid) => r.state.corroborated.has(sid),
      now: () => r.state.clock,
      onRamp: () => ramp,
      approvalActive: () => active
    })
    r.core.facade.setEnablePolicy(ext.wrapPolicy((b) => [...b.declared]))
    await r.hello({ declared: ['sense.identity', 'gate.approval'] })
    const view = (): ReturnType<typeof r.core.facade.bindingForSid> =>
      r.core.facade.bindingForSid(SID)
    expect(view()!.enabled).toEqual(['sense.identity'])
    expect(ext.approvalEligible(view()!)).toBe(false)
    r.state.corroborated.add(SID)
    await ext.sweep()
    ramp = true
    expect(ext.approvalEligible(view()!)).toBe(false) // family not active
    active = true
    expect(ext.approvalEligible(view()!)).toBe(true)
    ext.dispose()
  })
})

describe('ownership of an outside session (§13, QA-9)', () => {
  it('stays legacy until corroborated AND the external flip gate opens', async () => {
    const r = await boot()
    let open = false
    const arbiter = createSessionArbiter({
      host: r.core.facade,
      rollout: () => ({
        enabled: true,
        cliGate: 'ok',
        families: { identity: 'active' },
        allFolders: true,
        rampFolders: new Set()
      }),
      externalMayOwn: () => open
    })
    try {
      await r.hello()
      r.state.corroborated.add(SID)
      await r.ext.sweep()
      const view = r.core.facade.bindingForSid(SID)!
      expect(view.corroborated).toBe(true)
      expect(view.proven).toContain('sense.identity')
      // Corroborated and proven, family active, lease live: still not an owner.
      expect(arbiter.ownerFor(SID, 'identity').owner).toBe('legacy')
      open = true
      expect(arbiter.ownerFor(SID, 'identity')).toEqual({ owner: 'companion', reason: 'owned' })
      // The gate open never lets an uncorroborated binding own anything.
      r.core.facade.corroborate(view, false)
      expect(arbiter.ownerFor(SID, 'identity').owner).toBe('legacy')
    } finally {
      arbiter.dispose()
    }
  })
})
