import { expect, test } from 'claude-code/testing'
import { BYE_BUDGET_MS, HELLO_WAIT_MS, HEARTBEAT_MS } from '../hooks/contract'
import { FIXTURE_CONN, FIXTURE_SID } from './fixtures/hello'
import {
  BOOT,
  CONN_2,
  OTHER_SID,
  START,
  must,
  defaultScript,
  endpointText,
  failure,
  helloOk,
  installRig
} from './support/rig'

const end = (reason: string): never =>
  ({ reason, sessionId: FIXTURE_SID, resume: { sessionId: FIXTURE_SID } }) as never

test('ensureHello is a no-op with a conn (conformance row 4)', async ($, on) => {
  const rig = installRig(on)
  await $.session.start(START)
  await rig.clock.settle()
  expect(rig.of('hello').length).toBe(1)
  await $.classic.SessionStart({ source: 'compact' })
  await $.session.end(end('clear'))
  await $.session.start(START) // a second start in the same process: still no second hello
  await rig.clock.settle()
  expect(rig.of('hello').length).toBe(1)
  expect(must(rig.of('hello')[0]).body.spawn).toMatch(/^sp_/)
})

test('re-hello with resume after a reload (conformance row 4)', async ($, on) => {
  // `$.state` holds what a reload left behind; the module's own variables are empty.
  const rig = installRig(on, {
    savedState: {
      conn: FIXTURE_CONN,
      bootId: BOOT,
      sid: OTHER_SID,
      boot: START
    },
    script: (route, body) =>
      route === 'hello' ? helloOk(['sense.identity'], CONN_2) : defaultScript(route, body, 1)
  })
  await $.session.start(START)
  await rig.clock.settle()
  const hellos = rig.of('hello')
  expect(hellos.length).toBe(1)
  const hello = must(hellos[0])
  expect(hello.body.resume).toEqual({ conn: FIXTURE_CONN })
  expect(hello.body.spawn).toBeUndefined()
  // the bound id comes from `$.state`, not from a fresh `$.session.id()` (it would say FIXTURE_SID)
  expect(hello.body.sid).toBe(OTHER_SID)
  expect(rig.state.get('conn')).toBe(CONN_2)
})

test('a hung host does not hold the prompt', async ($, on) => {
  const rig = installRig(on, { script: () => ({ kind: 'hang' }) })
  let done = false
  const p = $.session.start(START).then((r) => {
    done = true
    return r
  })
  await rig.clock.advance(HELLO_WAIT_MS - 1)
  expect(done).toBe(false)
  await rig.clock.advance(1)
  expect(await p).toEqual({ cwd: START.cwd })
  expect(done).toBe(true)
})

test('dormant after an unrecoverable failure', async ($, on) => {
  const rig = installRig(on, { script: () => failure('UNAUTHORIZED') })
  await $.session.start(START)
  await rig.clock.settle()
  expect(rig.sent.length).toBe(1)
  await $.classic.SessionStart({ source: 'clear', session_id: OTHER_SID })
  await $.session.end(end('other'))
  await rig.clock.advance(HEARTBEAT_MS * 3)
  expect(rig.sent.length).toBe(1)
})

test('not spawned by Harnu and not interactive: dormant', async ($, on) => {
  // P4W3 (contract §21 item 1): an interactive tokenless mod claims as an outside session; only
  // `claude -p` and the like stay silent. The outside path is in external.test.ts.
  const rig = installRig(on, { token: false })
  const headless = { ...START, isInteractive: false }
  expect(await $.session.start(headless)).toEqual({ cwd: START.cwd })
  await $.classic.SessionStart({ source: 'clear', session_id: OTHER_SID })
  await $.session.end(end('other'))
  await rig.clock.advance(HEARTBEAT_MS * 3)
  expect(rig.sent.length).toBe(0)
})

test('single flight', async ($, on) => {
  const rig = installRig(on, {
    script: (route, body, n) => (route === 'hello' ? helloOk() : defaultScript(route, body, n))
  })
  // the first hello answers late: both hooks arrive while it is in flight
  let release = false
  const slow = rig.script.fn
  rig.script.fn = (route, body, n) => {
    if (route === 'hello' && !release) {
      release = true
      return { kind: 'hang' }
    }
    return slow(route, body, n)
  }
  const a = $.session.start(START)
  const b = $.session.start(START)
  await rig.clock.advance(HELLO_WAIT_MS)
  await Promise.all([a, b])
  expect(rig.of('hello').length).toBe(1)
})

test('no bye on clear', async ($, on) => {
  const rig = installRig(on)
  await $.session.start(START)
  await $.session.end(end('clear'))
  await rig.clock.settle()
  expect(rig.of('bye').length).toBe(0)
})

test('endpoint outside the rendezvous directory is refused', async ($, on) => {
  const rig = installRig(on)
  rig.endpoint.text = endpointText({ socketPath: '/tmp/elsewhere/c.sock' })
  expect(await $.session.start(START)).toEqual({ cwd: START.cwd })
  await rig.clock.settle()
  expect(rig.sent.length).toBe(0)
})

test('inert after an empty enable', async ($, on) => {
  const rig = installRig(on, {
    script: (route) => (route === 'hello' ? helloOk([]) : { kind: 'body', body: { ok: true } })
  })
  await $.session.start(START)
  await rig.clock.settle()
  await $.classic.SessionStart({ source: 'clear', session_id: OTHER_SID })
  await rig.clock.advance(HEARTBEAT_MS * 3)
  expect(rig.sent.length).toBe(1)
  expect(rig.of('events').length).toBe(0)
})

test('dormant on FEATURE_DISABLED', async ($, on) => {
  const rig = installRig(on, { script: () => failure('FEATURE_DISABLED') })
  await $.session.start(START)
  await rig.clock.settle()
  await $.classic.SessionStart({ source: 'clear', session_id: OTHER_SID })
  await rig.clock.advance(HEARTBEAT_MS * 3)
  expect(rig.sent.length).toBe(1)
})

test('bye on a real end', async ($, on) => {
  const rig = installRig(on)
  await $.session.start(START)
  await rig.clock.settle()
  await $.session.end(end('other'))
  await rig.clock.settle()
  const byes = rig.of('bye')
  expect(byes.length).toBe(1)
  const bye = must(byes[0])
  expect(bye.body.reason).toBe('other')
  expect(bye.body.events.map((e: { t: string }) => e.t)).toContain('session.end')
  expect(bye.body.conn).toBe(FIXTURE_CONN)
})

test('bye within budget', async ($, on) => {
  const rig = installRig(on, {
    script: (route, body, n) => (route === 'bye' ? { kind: 'hang' } : defaultScript(route, body, n))
  })
  await $.session.start(START)
  await rig.clock.settle()
  let done = false
  const p = $.session.end(end('other')).then(() => {
    done = true
  })
  await rig.clock.advance(BYE_BUDGET_MS - 1)
  expect(done).toBe(false)
  await rig.clock.advance(1)
  await p
  expect(done).toBe(true)
  // never retried
  await rig.clock.advance(HEARTBEAT_MS * 3)
  expect(rig.of('bye').length).toBe(1)
})

test('inert keeps conn', async ($, on) => {
  const rig = installRig(on, {
    script: (route) => (route === 'hello' ? helloOk([]) : { kind: 'body', body: { ok: true } })
  })
  await $.session.start(START)
  await rig.clock.settle()
  expect(rig.state.get('conn')).toBe(FIXTURE_CONN)
  expect(rig.state.get('sid')).toBe(FIXTURE_SID)
})

test('revoked conn resumes', async ($, on) => {
  // The kill switch revokes the conn: the next request answers STALE_CONN, the mod resumes and the
  // host answers `enable: []`. From then on the mod is inert but keeps the conn it was given.
  let revoked = false
  const rig = installRig(on, {
    script: (route, body, n) => {
      if (route === 'hello') return body.resume ? helloOk([], CONN_2) : helloOk()
      if (route === 'events' && revoked) return failure('STALE_CONN')
      return defaultScript(route, body, n)
    }
  })
  await $.session.start(START)
  await rig.clock.settle()
  revoked = true
  await rig.clock.advance(HEARTBEAT_MS * 2) // the first tick skips: the hello snapshot was just sent
  await rig.clock.settle()
  const resumes = rig.of('hello').filter((h) => h.body.resume)
  expect(resumes.length).toBe(1)
  expect(must(resumes[0]).body.resume).toEqual({ conn: FIXTURE_CONN })
  const before = rig.sent.length
  await rig.clock.advance(HEARTBEAT_MS * 3)
  expect(rig.sent.length).toBe(before)
  expect(rig.state.get('conn')).toBe(CONN_2)
})
