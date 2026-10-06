/* eslint-disable @typescript-eslint/no-explicit-any -- test code reads wire bodies loosely */
import { expect, test } from 'claude-code/testing'
import { DRIFT_CHECK_MIN_MS, HEARTBEAT_MS } from '../hooks/contract'
import { FIXTURE_CONN, FIXTURE_SID } from './fixtures/hello'
import { NEW_SID, OTHER_SID, START, installRig, must } from './support/rig'

const rebounds = (events: { t: string; d: any }[]) =>
  events.filter((e) => e.t === 'session.rebound')

test('/clear rebounds from the payload (conformance row 15)', async ($, on) => {
  const rig = installRig(on)
  await $.session.start(START)
  await rig.clock.settle()
  await $.classic.SessionStart({ source: 'clear', session_id: NEW_SID })
  await rig.clock.settle()
  const r = rebounds(rig.events())
  expect(r.length).toBe(1)
  expect(must(r[0]).d).toEqual({ prevSid: FIXTURE_SID, sid: NEW_SID, cause: 'clear' })
  // posted on the same conn, and `$.state` written again
  const carrying = rig
    .of('events')
    .find((s) => s.body.events.some((e: { t: string }) => e.t === 'session.rebound'))
  expect(carrying?.body.conn).toBe(FIXTURE_CONN)
  expect(carrying?.body.sid).toBe(NEW_SID)
  expect(rig.state.get('sid')).toBe(NEW_SID)
  expect(rig.state.get('conn')).toBe(FIXTURE_CONN)
  expect(rig.of('hello').length).toBe(1)
  expect(rig.of('bye').length).toBe(0)
})

test('/resume uses the payload id, not $.session.id() (conformance row 15)', async ($, on) => {
  const rig = installRig(on)
  await $.session.start(START)
  await rig.clock.settle()
  // inside that hook the engine still says the old id (C10): rig.sid is left alone
  await $.classic.SessionStart({ source: 'resume', session_id: OTHER_SID })
  await rig.clock.settle()
  const r = rebounds(rig.events())
  expect(r.length).toBe(1)
  expect(must(r[0]).d).toEqual({ prevSid: FIXTURE_SID, sid: OTHER_SID, cause: 'resume' })
})

test('no drift check with classic', async ($, on) => {
  const rig = installRig(on)
  await $.session.start(START)
  await $.classic.SessionStart({ source: 'startup', session_id: FIXTURE_SID })
  await rig.clock.settle()
  rig.sid.value = OTHER_SID // a stale or changed `$.session.id()` must not be trusted now
  await rig.clock.advance(DRIFT_CHECK_MIN_MS + 1)
  await $.classic.SessionStart({ source: 'compact', session_id: FIXTURE_SID })
  await rig.clock.advance(HEARTBEAT_MS * 2)
  expect(rebounds(rig.events()).length).toBe(0)
})

test('drift check without classic', async ($, on) => {
  const rig = installRig(on)
  await $.session.start(START)
  await rig.clock.settle()
  rig.sid.value = OTHER_SID
  await rig.clock.advance(HEARTBEAT_MS) // the heartbeat runs the check
  await rig.clock.settle()
  const r = rebounds(rig.events())
  expect(r.length).toBe(1)
  expect(must(r[0]).d).toEqual({ prevSid: FIXTURE_SID, sid: OTHER_SID, cause: 'unknown' })
  // once is enough: the bound id is now the new one
  await rig.clock.advance(HEARTBEAT_MS * 2)
  expect(rebounds(rig.events()).length).toBe(1)
})
