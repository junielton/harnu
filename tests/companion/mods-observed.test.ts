/**
 * T389 P4W1 part B (AC-P4W1-18, -21, and the enable rules of contract §11.1/§11.5): the host
 * keeps what the companion observed through `plugin.register` for sessions with a live lease,
 * in memory only. Driven against the real host core over a real socket.
 */
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { helloSpawnRequest } from '../../resources/companion/tests/fixtures/hello'
import { LEASE_TTL_MS, type EndpointFile } from '../../src/main/companion/contract'
import {
  rolloutView,
  resetPrefsKeysForTests,
  setCompanionCliGate,
  setCompanionEnabled,
  setCompanionPrefsPath,
  setPrefsKey
} from '../../src/main/companion/companion-prefs'
import {
  computeEnable,
  createEnablePolicy,
  registerP1FeaturePolicies,
  resetFeaturePoliciesForTests
} from '../../src/main/companion/feature-policy'
import {
  getCompanionMode,
  hydrateCompanionMode,
  listenerWanted,
  onModeChange
} from '../../src/main/companion/mode'
import { registerModsObserved } from '../../src/main/companion/mods-observed'
import type { BindingView } from '../../src/main/companion/session-table'
import { post } from './support/client'
import { createCompanionHost, shortTmp, tick } from './support/host-rig'

const S1 = helloSpawnRequest.sid
const S2 = '22222222-2222-4222-8222-222222222222'
const dirs: string[] = []
const closers: (() => Promise<void> | void)[] = []

const CHART = {
  name: 'token-chart',
  tier: 'user',
  root: '/work/mods/token-chart',
  version: '0.3.1',
  provenance: 'token-chart@inline',
  uses: {
    events: ['prompt.submit'],
    calls: ['http.fetch'],
    env: { reads: [], writes: [] },
    state: { reads: [], writes: [] }
  }
}
const SECOND = {
  ...CHART,
  name: 'second',
  root: '/work/mods/second',
  provenance: 'second@skills-dir'
}

beforeEach(() => {
  const d = shortTmp('hc-mo-')
  dirs.push(d)
  setCompanionPrefsPath(join(d, 'companion-prefs.json'))
  setCompanionCliGate('ok')
  resetFeaturePoliciesForTests()
  resetPrefsKeysForTests()
  registerP1FeaturePolicies()
})

afterEach(async () => {
  for (const c of closers.splice(0)) await c()
  setCompanionPrefsPath(null)
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function rig(opts: { keyOn?: boolean } = {}) {
  let t = 1_000
  const dir = join(shortTmp('hc-mo-'), 'companion')
  dirs.push(join(dir, '..'))
  const host = createCompanionHost({
    dir,
    mode: {
      getMode: getCompanionMode,
      listenerWanted,
      hydrate: hydrateCompanionMode,
      onChange: onModeChange,
      enabled: () => rolloutView().enabled
    },
    now: () => t,
    log: () => undefined,
    sessionKeyOf: (o) => (o.kind === 'pty' ? `row:${o.ptyId}` : null)
  })
  closers.push(() => host.close())
  await host.register()
  host.facade.setEnablePolicy(createEnablePolicy({ rollout: rolloutView, ceiling: '2.1.290' }))
  const observed = registerModsObserved({ host: host.facade, epochNow: () => 1_790_000_000_000 })
  closers.push(() => observed.dispose())
  // the identity adapter registers this one in the app; the rig has none
  host.facade.registerEventTypes(['session.rebound'])
  if (opts.keyOn !== false) setPrefsKey('modsLive', true)
  const ep = JSON.parse(readFileSync(join(dir, 'endpoint.json'), 'utf8')) as EndpointFile
  const bind = async (ptyId: string, sid = S1, cwd = '/work/example-web') => {
    const token = host.facade.mintSpawnToken({
      owner: { kind: 'pty', ptyId },
      trust: 'operator',
      cwd
    })!
    const r = await post(ep, 'hello', {
      body: {
        ...helloSpawnRequest,
        sid,
        cwd,
        cli: { version: '2.1.290' },
        spawn: token,
        declared: ['sense.identity', 'sense.mods']
      }
    })
    return { conn: r.json.conn as string, sid, enable: r.json.enable as string[] }
  }
  const send = (b: { conn: string; sid: string }, events: { t: string; d: unknown }[], seq = 1) =>
    post(ep, 'events', {
      body: {
        v: 1,
        sid: b.sid,
        conn: b.conn,
        sentAt: 1,
        events: events.map((e, i) => ({ seq: seq + i, ts: 1, ...e }))
      }
    })
  return {
    host,
    observed,
    ep,
    bind,
    send,
    tick: (ms: number) => {
      t += ms
      host.sweepNow()
    }
  }
}

describe('what the host keeps', () => {
  it('records the admissions of a session with a live lease, and proves sense.mods', async () => {
    const x = await rig()
    const b = await x.bind('pty-1')
    expect(b.enable).toContain('sense.mods')
    await x.send(b, [
      { t: 'mod.admitted', d: CHART },
      { t: 'mod.admitted', d: SECOND }
    ])
    const sessions = x.observed.sessions(null)
    expect(sessions.length).toBe(1)
    expect(sessions[0]).toMatchObject({
      sid: S1,
      sessionKey: 'row:pty-1',
      cwd: '/work/example-web'
    })
    expect(sessions[0]!.mods.map((m) => [m.name, m.provenance, m.order])).toEqual([
      ['token-chart', 'token-chart@inline', 1],
      ['second', 'second@skills-dir', 2]
    ])
    expect(x.host.facade.getBinding('row:pty-1')?.proven).toContain('sense.mods')
  })

  it('answers per folder', async () => {
    const x = await rig()
    const a = await x.bind('pty-1', S1, '/work/example-web')
    const c = await x.bind('pty-2', S2, '/work/portal')
    await x.send(a, [{ t: 'mod.admitted', d: CHART }])
    await x.send(c, [{ t: 'mod.admitted', d: SECOND }])
    expect(x.observed.sessions('/work/portal').map((s) => s.sid)).toEqual([S2])
    expect(x.observed.sessions(null).length).toBe(2)
  })

  it('keeps the arrival order, the host half of AC-P4W1-20', async () => {
    const x = await rig()
    const b = await x.bind('pty-1')
    await x.send(b, [
      { t: 'mod.admitted', d: SECOND },
      { t: 'mod.admitted', d: CHART }
    ])
    expect(x.observed.loadOrder(S1).map((m) => m.provenance)).toEqual([
      'second@skills-dir',
      'token-chart@inline'
    ])
    expect(x.observed.loadOrder('99999999-9999-4999-8999-999999999999')).toEqual([])
  })

  it('ignores a payload that is not an admission and keeps the session healthy', async () => {
    const x = await rig()
    const b = await x.bind('pty-1')
    const r = await x.send(b, [{ t: 'mod.admitted', d: { name: 7 } }])
    expect(r.json.ok).toBe(true)
    expect(x.observed.sessions(null)).toEqual([])
  })
})

describe('observations die with the lease (AC-P4W1-18)', () => {
  it('a lost lease removes the lines at once', async () => {
    const x = await rig()
    const b = await x.bind('pty-1')
    await x.send(b, [{ t: 'mod.admitted', d: CHART }])
    expect(x.observed.sessions(null).length).toBe(1)
    x.tick(LEASE_TTL_MS + 1) // no request for longer than the TTL
    expect(x.observed.held()).toBe(0) // gone from memory, not only hidden
    expect(x.observed.sessions(null)).toEqual([])
    expect(x.observed.loadOrder(S1)).toEqual([])
  })

  it('a session that ends removes them, and the others stay', async () => {
    const x = await rig()
    const a = await x.bind('pty-1', S1)
    const c = await x.bind('pty-2', S2)
    await x.send(a, [{ t: 'mod.admitted', d: CHART }])
    await x.send(c, [{ t: 'mod.admitted', d: SECOND }])
    await post(x.ep, 'bye', {
      body: { v: 1, sid: S1, conn: a.conn, sentAt: 1, reason: 'exit', events: [] }
    })
    await tick()
    expect(x.observed.sessions(null).map((s) => s.sid)).toEqual([S2])
  })

  it('a /clear (session.rebound) removes them: the mod announced them to the old session', async () => {
    const x = await rig()
    const b = await x.bind('pty-1')
    await x.send(b, [{ t: 'mod.admitted', d: CHART }])
    await x.send(b, [{ t: 'session.rebound', d: { prevSid: S1, sid: S2, cause: 'clear' } }], 2)
    await tick()
    expect(x.observed.sessions(null)).toEqual([])
  })
})

describe('the kill switch (AC-P4W1-21)', () => {
  it('drops every observation of a revoked binding at once, with no TTL wait', async () => {
    const x = await rig()
    const a = await x.bind('pty-1', S1)
    const c = await x.bind('pty-2', S2)
    await x.send(a, [{ t: 'mod.admitted', d: CHART }])
    await x.send(c, [{ t: 'mod.admitted', d: SECOND }])
    expect(x.observed.sessions(null).length).toBe(2)

    await setCompanionEnabled(false)
    await tick()

    expect(x.observed.held()).toBe(0) // gone from memory, not only hidden
    expect(x.observed.sessions(null)).toEqual([])
    expect(x.observed.loadOrder(S1)).toEqual([])
    // the revoked mod's late events find no home: it is inert and sends nothing, and if it did
    expect((await x.send(a, [{ t: 'mod.admitted', d: CHART }], 2)).json.ok).toBe(false)
    expect(x.observed.sessions(null)).toEqual([])
  })
})

describe('when sense.mods is enabled (contract §11.1, §11.5)', () => {
  it('modsLive off: not enabled, and an event nobody asked for is not kept', async () => {
    const x = await rig({ keyOn: false })
    const b = await x.bind('pty-1')
    expect(b.enable).not.toContain('sense.mods')
    await x.send(b, [{ t: 'mod.admitted', d: CHART }])
    expect(x.observed.sessions(null)).toEqual([])
  })

  it('a CLI above the tested ceiling caps the key at off', async () => {
    const x = await rig()
    setCompanionCliGate('above')
    const b = await x.bind('pty-1')
    expect(b.enable).not.toContain('sense.mods')
    await x.send(b, [{ t: 'mod.admitted', d: CHART }])
    expect(x.observed.sessions(null)).toEqual([])
  })

  it('the kill switch off enables nothing', async () => {
    const x = await rig()
    await setCompanionEnabled(false)
    await tick()
    const b = await x.bind('pty-1')
    expect(b.enable ?? []).toEqual([])
  })

  const view = (profile: BindingView['profile']): BindingView => ({
    key: 1,
    owner: { kind: 'pty', ptyId: 'p' },
    trust: 'operator',
    sid: S1,
    sessionKey: 'row',
    cwd: '/work/example-web',
    profile,
    cliVersion: '2.1.290',
    modVersion: '0.1.0',
    declared: ['sense.identity', 'sense.mods'],
    enabled: [],
    proven: [],
    lease: 'live',
    state: 'bound',
    helloAfterSpawnMs: 0
  })
  const ctx = (profile: BindingView['profile']) => ({
    profile,
    folder: '/work/example-web',
    rollout: { ...rolloutView(), cliGate: 'ok' as const },
    trust: 'operator' as const,
    binding: view(profile)
  })

  it('a headless session may enable it: it is a sensor', async () => {
    await rig()
    expect(computeEnable(['sense.mods'], ctx('headless'))).toEqual(['sense.mods'])
  })

  it('the external profile never enables it (contract §21 item 3)', async () => {
    await rig()
    expect(computeEnable(['sense.mods'], ctx('external'))).toEqual([])
  })
})
