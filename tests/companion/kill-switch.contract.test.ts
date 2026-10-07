import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { helloSpawnRequest } from '../../resources/companion/tests/fixtures/hello'
import { LEASE_TTL_MS, type EndpointFile } from '../../src/main/companion/contract'
import {
  getCompanionMode,
  hydrateCompanionMode,
  listenerWanted,
  onModeChange
} from '../../src/main/companion/mode'
import {
  setCompanionCliGate,
  setCompanionEnabled,
  setCompanionPrefsPath,
  rolloutView
} from '../../src/main/companion/companion-prefs'
import {
  createEnablePolicy,
  registerP1FeaturePolicies,
  resetFeaturePoliciesForTests
} from '../../src/main/companion/feature-policy'
import { post } from './support/client'
import { createCompanionHost, shortTmp, tick } from './support/host-rig'

const owner = { kind: 'pty', ptyId: 'pty-1' } as const
const dirs: string[] = []
const closers: (() => Promise<void>)[] = []

beforeEach(() => {
  const d = shortTmp('hc-ks-')
  dirs.push(d)
  setCompanionPrefsPath(join(d, 'companion-prefs.json'))
  setCompanionCliGate('ok')
  resetFeaturePoliciesForTests()
  registerP1FeaturePolicies()
})

afterEach(async () => {
  for (const c of closers.splice(0)) await c()
  setCompanionPrefsPath(null)
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function rig() {
  let t = 1_000
  const dir = join(shortTmp('hc-ks-'), 'companion')
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
    sessionKeyOf: (o) => (o.kind === 'pty' ? `key:${o.ptyId}` : null),
    log: () => undefined
  })
  closers.push(() => host.close())
  await host.register()
  host.facade.setEnablePolicy(createEnablePolicy({ rollout: rolloutView, ceiling: '2.1.290' }))
  const ep = JSON.parse(readFileSync(join(dir, 'endpoint.json'), 'utf8')) as EndpointFile
  const token = host.facade.mintSpawnToken({ owner, trust: 'operator', cwd: '/work/example-web' })!
  const hello = await post(ep, 'hello', {
    body: { ...helloSpawnRequest, cli: { version: '2.1.290' }, spawn: token }
  })
  expect(hello.json.ok).toBe(true)
  const conn = hello.json.conn as string
  const env = (c: string): Record<string, unknown> => ({
    v: 1,
    sid: helloSpawnRequest.sid,
    conn: c,
    sentAt: 1,
    events: []
  })
  const { spawn: _spawn, ...resumeBase } = { ...helloSpawnRequest, cli: { version: '2.1.290' } }
  return {
    advance: (ms: number) => void (t += ms),
    host,
    ep,
    conn,
    first: hello,
    events: (c: string) => post(ep, 'events', { body: env(c) }),
    resume: (c: string) => post(ep, 'hello', { body: { ...resumeBase, resume: { conn: c } } })
  }
}

describe('the kill switch (ARB-7d)', () => {
  it('off revokes and disables', async () => {
    const x = await rig()
    expect(x.first.json.enable).toContain('sense.identity')
    expect((await x.events(x.conn)).json.ok).toBe(true)

    await setCompanionEnabled(false)
    await tick()

    const stale = await x.events(x.conn)
    expect(stale.json).toMatchObject({ ok: false, code: 'STALE_CONN' })

    const again = await x.resume(x.conn)
    expect(again.json.ok).toBe(true)
    expect(again.json.enable).toEqual([])
    expect(again.json.conn).not.toBe(x.conn)
    // the listener stays up: the re-hello was answered at all
    expect(x.host.facade.diagnostics().listener.state).toBe('listening')
  })

  it('switching back on reaches new sessions only', async () => {
    const x = await rig()
    await setCompanionEnabled(false)
    await tick()
    await setCompanionEnabled(true)
    await tick()
    // the running mod's next request is stale, and its re-hello is answered with nothing: no flapping
    expect((await x.events(x.conn)).json).toMatchObject({ code: 'STALE_CONN' })
    const again = await x.resume(x.conn)
    expect(again.json.enable).toEqual([])
    // a new spawn is enabled again
    const token = x.host.facade.mintSpawnToken({
      owner: { kind: 'pty', ptyId: 'pty-2' },
      trust: 'operator',
      cwd: '/work/example-web'
    })!
    const fresh = await post(x.ep, 'hello', {
      body: {
        ...helloSpawnRequest,
        sid: '22222222-2222-4222-8222-222222222222',
        cli: { version: '2.1.290' },
        spawn: token
      }
    })
    expect(fresh.json.enable).toContain('sense.identity')
  })

  it('an inert binding is never reported as a lease loss', async () => {
    const x = await rig()
    await setCompanionEnabled(false)
    await tick()
    await x.resume(x.conn)
    x.advance(LEASE_TTL_MS * 5) // the inert mod sends nothing, by design
    const lost: string[] = []
    x.host.facade.bus.on('lease', (b) => void lost.push(b.sid))
    x.host.sweepNow()
    expect(lost).toEqual([])
  })
})
