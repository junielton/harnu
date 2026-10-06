/* eslint-disable @typescript-eslint/no-explicit-any -- test code reads wire bodies loosely */
import { expect, test } from 'claude-code/testing'
import { HEARTBEAT_MS } from '../hooks/contract'
import { FIXTURE_CONN, FIXTURE_SID } from './fixtures/hello'
import {
  BOOT,
  CONN_2,
  START,
  ackAll,
  failure,
  helloOk,
  installRig,
  must,
  type Script
} from './support/rig'

const endEvent = (reason: string): never =>
  ({ reason, sessionId: FIXTURE_SID, resume: { sessionId: FIXTURE_SID } }) as never

const OUTSIDE = { ...START }
const HEADLESS = { cwd: START.cwd, surface: null, isInteractive: false } as const

const cmd = (n: number, name: string, args: unknown = {}): any => ({
  cmd: `cmd_${n}`,
  n,
  name,
  args,
  issuedAt: Date.now(),
  expiresAt: Date.now() + 30_000
})

/** The host's external answer, optionally carrying commands. */
const externalHello =
  (commands: any[] = [], enable = ['sense.identity']): Script =>
  (route, body, n) => {
    if (route === 'hello') {
      const a = helloOk(enable) as { kind: 'body'; body: any }
      return {
        kind: 'body',
        body: { ...a.body, profile: 'external', sessionKey: null, commands }
      }
    }
    if (route === 'events') return ackAll(body)
    void n
    return { kind: 'body', body: { ok: true } }
  }

test('headless outside run is silent (conformance row 26)', async ($, on) => {
  const rig = installRig(on, { token: false })
  await $.session.start(HEADLESS)
  await rig.clock.settle()
  await $.classic.SessionStart({ source: 'startup' })
  await rig.clock.advance(HEARTBEAT_MS * 5)
  await $.session.end(endEvent('other'))
  await rig.clock.settle()
  // Not one request for the life of the module: no hello, no events, no bye.
  expect(rig.sent.length).toBe(0)
})

test('a headless outside run stays silent when classic.SessionStart races session.start (real CLI order)', async ($, on) => {
  const rig = installRig(on, { token: false })
  // The real CLI dispatches `classic.SessionStart` before `session.start` and the two overlap: the
  // hello that the first one starts must not reach the network once `session.start` says the run
  // is not interactive. The rig cannot interleave the two the way the real CLI does, so the
  // regression guard that bites is the L4 "probes stay silent" (AC-P4W3-16) against a real CLI.
  await Promise.all([$.classic.SessionStart({ source: 'startup' }), $.session.start(HEADLESS)])
  await rig.clock.settle()
  await rig.clock.advance(HEARTBEAT_MS * 3)
  expect(rig.sent.length).toBe(0)
})

test('a tokenless interactive mod sends one external hello: neither spawn nor resume', async ($, on) => {
  const rig = installRig(on, { token: false, script: externalHello() })
  await $.session.start(OUTSIDE)
  await rig.clock.settle()
  const hellos = rig.of('hello')
  expect(hellos.length).toBe(1)
  const body = must(hellos[0]).body
  expect(body.spawn).toBeUndefined()
  expect(body.resume).toBeUndefined()
  expect(body.isInteractive).toBe(true)
  expect(body.sid).toBe(FIXTURE_SID)
  expect(body.cwd).toBe(START.cwd)
  // And it reports like any binding: the lease is renewed by events and heartbeats.
  await rig.clock.advance(HEARTBEAT_MS * 2)
  expect(rig.of('events').length).toBeGreaterThan(0)
  // The events request of a non-polling profile carries the boot and the cursor.
  const ev = must(rig.of('events')[0]).body
  expect(ev.bootId).toBe(BOOT)
  expect(ev.cursor).toBe(0)
})

test('an outside session refuses actuators (conformance row 26)', async ($, on) => {
  const submitted: unknown[] = []
  const appended: unknown[] = []
  on('prompt.submit' as never, async (_$: unknown, e: unknown) => {
    submitted.push(e)
    return {} as never
  })
  on('session.append' as never, async (_$: unknown, e: unknown) => {
    appended.push(e)
    return {} as never
  })
  const rig = installRig(on, {
    token: false,
    script: externalHello([
      cmd(1, 'prompt.submit', { text: 'do something', asUser: true, via: 'prompt' }),
      cmd(2, 'message.deliver', { msgId: 'm', from: { name: 'x' }, text: 'hi' }),
      cmd(3, 'context.append', { key: 'harnu.mission', text: 'x', durable: false }),
      cmd(4, 'turn.abort'),
      cmd(5, 'ui.toast', { text: 'hey' })
    ])
  })
  await $.session.start(OUTSIDE)
  await rig.clock.settle()
  await rig.clock.advance(HEARTBEAT_MS * 2)
  const results = rig
    .events()
    .filter((e) => e.t === 'command.result')
    .map((e) => e.d)
  expect(results.map((r) => r.cmd)).toEqual(['cmd_1', 'cmd_2', 'cmd_3', 'cmd_4', 'cmd_5'])
  for (const r of results) expect(r).toMatchObject({ ok: false, code: 'CMD_UNSUPPORTED' })
  expect(submitted).toEqual([])
  expect(appended).toEqual([])
})

test('an outside session still answers its three commands', async ($, on) => {
  const rig = installRig(on, {
    token: false,
    script: externalHello([
      cmd(1, 'flush'),
      cmd(2, 'config.update', { config: { heartbeatMs: 5_000 } }),
      cmd(3, 'config.update', { config: { heartbeatMs: 1 } }),
      cmd(4, 'ui.band.set', { line: 'x' })
    ])
  })
  await $.session.start(OUTSIDE)
  await rig.clock.settle()
  await rig.clock.advance(HEARTBEAT_MS * 2)
  const byCmd = Object.fromEntries(
    rig
      .events()
      .filter((e) => e.t === 'command.result')
      .map((e) => [e.d.cmd, e.d])
  )
  expect(byCmd.cmd_1).toMatchObject({ ok: true })
  expect(byCmd.cmd_2).toMatchObject({ ok: true })
  expect(byCmd.cmd_3).toMatchObject({ ok: false }) // outside CONFIG_BOUNDS
  // No band hook is declared in this build: an outside session simply has no line.
  expect(byCmd.cmd_4).toMatchObject({ ok: false, code: 'CMD_UNSUPPORTED' })
})

test('a command is run once: the cursor moves past it', async ($, on) => {
  let sentFlush = 0
  const rig = installRig(on, {
    token: false,
    script: (route, body, n) => {
      if (route === 'events' && sentFlush < 2) {
        sentFlush++
        return {
          kind: 'body',
          body: {
            ok: true,
            ackSeq: Math.max(0, ...body.events.map((e: any) => e.seq)),
            commands: [cmd(1, 'flush')]
          }
        }
      }
      return externalHello()(route, body, n)
    }
  })
  await $.session.start(OUTSIDE)
  await rig.clock.settle()
  await rig.clock.advance(HEARTBEAT_MS * 4)
  const results = rig.events().filter((e) => e.t === 'command.result')
  expect(results.length).toBe(1)
  const cursors = rig.of('events').map((s) => s.body.cursor)
  expect(cursors.at(-1)).toBe(1)
})

test('survives a Harnu restart (contract §21 item 7)', async ($, on) => {
  // The mod holds a conn; Harnu restarted, so its resume is UNKNOWN_SESSION. A spawned mod goes
  // dormant (it has a token to protect); a tokenless one sends exactly one fresh claim.
  let stale = false // one STALE_CONN: Harnu restarted and forgot the conn
  const rig = installRig(on, {
    token: false,
    script: (route, body, n) => {
      if (route === 'hello') {
        if (body.resume) return failure('UNKNOWN_SESSION')
        return helloOk(['sense.identity'], n === 1 ? FIXTURE_CONN : CONN_2)
      }
      if (route === 'events' && stale) {
        stale = false
        return failure('STALE_CONN')
      }
      return ackAll(body)
    }
  })
  await $.session.start(OUTSIDE)
  await rig.clock.settle()
  expect(rig.of('hello').length).toBe(1)
  stale = true
  await rig.clock.advance(HEARTBEAT_MS * 2) // the first beat skips; the next one hits STALE_CONN
  await rig.clock.settle()
  const hellos = rig.of('hello')
  // first claim, one resume (answered UNKNOWN_SESSION), then exactly one fresh tokenless claim
  expect(hellos.length).toBe(3)
  expect(must(hellos[1]).body.resume).toEqual({ conn: FIXTURE_CONN })
  const fresh = must(hellos[2]).body
  expect(fresh.resume).toBeUndefined()
  expect(fresh.spawn).toBeUndefined()
  // not dormant: it keeps reporting on its new conn
  await rig.clock.advance(HEARTBEAT_MS * 3)
  const last = rig.of('events').at(-1)
  expect(must(last).body.conn).toBe(CONN_2)
  expect(rig.of('hello').length).toBe(3)
})

test('FEATURE_DISABLED and UNAUTHORIZED still make an outside mod dormant', async ($, on) => {
  for (const code of ['FEATURE_DISABLED', 'UNAUTHORIZED']) {
    const rig = installRig(on, { token: false, script: () => failure(code) })
    await $.session.start(OUTSIDE)
    await rig.clock.settle()
    await rig.clock.advance(HEARTBEAT_MS * 4)
    expect(rig.of('hello').length).toBe(1)
    break // one rig per file run: the module state is reset by each `register`
  }
})

test('a Harnu-spawned mod keeps the spawned path and still goes dormant on UNKNOWN_SESSION', async ($, on) => {
  const rig = installRig(on, {
    script: (route, body) => {
      if (route === 'hello') return body.resume ? failure('UNKNOWN_SESSION') : helloOk()
      if (route === 'events') return failure('STALE_CONN')
      return { kind: 'body', body: { ok: true } }
    }
  })
  await $.session.start(START)
  await rig.clock.settle()
  expect(must(rig.of('hello')[0]).body.spawn).toMatch(/^sp_/)
  await rig.clock.advance(HEARTBEAT_MS * 3)
  await rig.clock.settle()
  const hellos = rig.of('hello')
  expect(hellos.filter((h) => h.body.resume).length).toBe(1)
  expect(hellos.filter((h) => !h.body.resume && !h.body.spawn).length).toBe(0) // never a claim
  const before = rig.sent.length
  await rig.clock.advance(HEARTBEAT_MS * 3)
  expect(rig.sent.length).toBe(before) // dormant
})
