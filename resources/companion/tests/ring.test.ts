import { expect, test } from 'claude-code/testing'
import { BACKOFF_MAX_MS, HEARTBEAT_MS } from '../hooks/contract'
import { FIXTURE_CONN } from './fixtures/hello'
import {
  CONN_2,
  NEW_SID,
  START,
  ackAll,
  defaultScript,
  failure,
  helloOk,
  installRig,
  must
} from './support/rig'

test('ring keeps events until acknowledged (conformance row 6)', async ($, on) => {
  // The first events request dies in transit; nothing may be forgotten.
  const rig = installRig(on, {
    script: (route, body, n) =>
      route === 'events' && n === 1 ? { kind: 'throw' } : defaultScript(route, body, n)
  })
  await $.session.start(START)
  await rig.clock.settle()
  const first = must(rig.of('events')[0]).body.events
  expect(first.map((e: { seq: number; t: string }) => [e.seq, e.t])).toEqual([
    [1, 'session.snapshot']
  ])
  await rig.clock.advance(BACKOFF_MAX_MS) // past the backoff
  const again = rig.of('events')
  expect(again.length).toBeGreaterThan(1)
  const resent = must(again[1]).body.events[0]
  expect(resent.seq).toBe(1)
  expect(resent.t).toBe('session.snapshot')
  // acknowledged now: no later batch carries seq 1 again
  const after = rig.of('events').length
  await $.classic.SessionStart({ source: 'clear', session_id: NEW_SID })
  await rig.clock.settle()
  const later = rig
    .of('events')
    .slice(after)
    .flatMap((s) => s.body.events as { seq: number; t: string }[])
  expect(later.length).toBeGreaterThan(0)
  expect(later.map((e) => e.seq)).not.toContain(1)
  expect(later.map((e) => e.t)).toContain('session.rebound')
})

test('stale conn re-hello and renumber', async ($, on) => {
  let stale = false
  const rig = installRig(on, {
    script: (route, body, n) => {
      if (route === 'hello') return body.resume ? helloOk(['sense.identity'], CONN_2) : helloOk()
      if (route === 'events' && stale && body.conn === FIXTURE_CONN) return failure('STALE_CONN')
      return route === 'events' ? ackAll(body) : defaultScript(route, body, n)
    }
  })
  await $.session.start(START)
  await rig.clock.settle() // the hello snapshot is acknowledged: seq 1
  stale = true
  await $.classic.SessionStart({ source: 'clear', session_id: NEW_SID }) // seq 2, meets STALE_CONN
  await rig.clock.settle()
  await rig.clock.advance(HEARTBEAT_MS)
  await rig.clock.settle()
  const resumes = rig.of('hello').filter((h) => h.body.resume)
  expect(resumes.length).toBe(1)
  const onNewConn = rig.of('events').filter((s) => s.body.conn === CONN_2)
  expect(onNewConn.length).toBeGreaterThan(0)
  const firstBatch = must(onNewConn[0]).body.events
  expect(must(firstBatch[0]).seq).toBe(1) // renumbered from 1 on the new conn
  expect(firstBatch.map((e: { t: string }) => e.t)).toContain('session.rebound')
})
