/**
 * The poll endpoint of the command channel against a real host over a real socket (T389 P2W1,
 * contract §5.3, §6 commands): parking, supersede, bounded hold, resync and the headless rule.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { clampHold } from '../../src/main/companion/command-channel'
import { POLL_HOLD_MS } from '../../src/main/companion/contract'
import { uiText } from '../../src/main/companion/command-gate-core'
import { channelRig, sleep } from './support/channel-rig'

const open: { close(): Promise<void> }[] = []
afterEach(async () => {
  for (const r of open.splice(0)) await r.close()
})
const rig = async (o: Parameters<typeof channelRig>[0] = {}) => {
  const r = await channelRig(o)
  open.push(r)
  return r
}
const flush = (r: Awaited<ReturnType<typeof rig>>) =>
  r.channel.enqueue({
    sessionKey: 'key:pty-1',
    name: 'flush',
    args: {},
    cause: { kind: 'internal', subsystem: 'arbitration' }
  })

describe('poll parking', () => {
  it('enqueue answers a parked poll', async () => {
    const r = await rig({ pollHoldMs: 5_000 })
    const { conn } = await r.hello()
    const parked = r.poll(conn)
    await sleep(40)
    expect(r.channel.inspect().parked).toBe(1)
    const started = performance.now()
    const q = flush(r)
    expect(q.ok).toBe(true)
    const answer = await parked
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(answer.json.ok).toBe(true)
    expect(answer.json.commands.map((c: { name: string }) => c.name)).toEqual(['flush'])
    expect(r.channel.inspect().parked).toBe(0)
  })

  it('hold is bounded', async () => {
    const r = await rig({ pollHoldMs: 200 })
    const { conn } = await r.hello()
    const started = performance.now()
    const answer = await r.poll(conn)
    const held = performance.now() - started
    expect(answer.json).toEqual({ ok: true, commands: [] })
    expect(held).toBeGreaterThanOrEqual(180)
    expect(held).toBeLessThan(1_000)
    // the host never holds past the protocol's cap, whatever it is asked
    expect(clampHold(60_000)).toBe(POLL_HOLD_MS)
    expect(clampHold(Number.NaN)).toBe(POLL_HOLD_MS)
    expect(clampHold(3_000)).toBe(3_000)
    expect(clampHold(0)).toBeGreaterThan(0)
  })

  it('a second poll supersedes the first', async () => {
    const r = await rig({ pollHoldMs: 5_000 })
    const { conn } = await r.hello()
    const first = r.poll(conn)
    await sleep(40)
    const second = r.poll(conn)
    const answer = await first // released at once, not at the timer
    expect(answer.json).toEqual({ ok: true, commands: [] })
    await sleep(40)
    expect(r.channel.inspect().parked).toBe(1) // exactly one stays parked
    flush(r)
    expect((await second).json.commands.length).toBe(1)
  })

  it('a parked poll counts toward the lease', async () => {
    const r = await rig({ pollHoldMs: 5_000 })
    const { conn } = await r.hello()
    const parked = r.poll(conn)
    await sleep(40)
    r.clock.lease += 60_000
    r.core.sweepNow()
    expect(r.view().lease).toBe('live')
    flush(r)
    await parked
  })

  it('delivers what is queued before the poll arrived, without parking', async () => {
    const r = await rig({ pollHoldMs: 5_000 })
    const { conn } = await r.hello()
    expect(flush(r).ok).toBe(true)
    const answer = await r.poll(conn)
    expect(answer.json.commands.length).toBe(1)
    expect(r.channel.inspect().parked).toBe(0)
  })

  it('a cursor acknowledges delivery and stops the re-send', async () => {
    const r = await rig({ pollHoldMs: 100 })
    const { conn } = await r.hello()
    flush(r)
    const first = await r.poll(conn)
    const n = first.json.commands[0].n
    expect((await r.poll(conn, { cursor: 0 })).json.commands.length).toBe(1) // not acknowledged: again
    expect((await r.poll(conn, { cursor: n })).json.commands).toEqual([])
  })
})

describe('resync', () => {
  it('stale boot resyncs', async () => {
    const r = await rig({ pollHoldMs: 100 })
    const { conn } = await r.hello()
    flush(r)
    const answer = await r.poll(conn, { bootId: 'b_some-earlier-boot', cursor: 7 })
    expect(answer.json).toEqual({ ok: true, commands: [], resync: true })
    expect(r.channel.inspect().live).toBe(1) // nothing was released
  })

  it('an envelope sid that is not the bound sid resyncs and settles nothing', async () => {
    const r = await rig({ pollHoldMs: 100 })
    const { conn } = await r.hello()
    flush(r)
    const answer = await r.poll(conn, { sid: '44444444-4444-4444-8444-444444444444' })
    expect(answer.json).toEqual({ ok: true, commands: [], resync: true })
    // no command goes to an unsettled id, and none is accepted for it either
    const refused = flush(r)
    expect(refused).toEqual({ ok: false, reason: 'SID_UNSETTLED' })
    expect(r.channel.pendingFor(r.view())).toEqual([])
  })

  it('the rebound settles the id, drops the old id’s commands and keeps flush', async () => {
    const r = await rig({ pollHoldMs: 100 })
    const { conn } = await r.hello()
    const status = r.channel.enqueue({
      sessionKey: 'key:pty-1',
      name: 'ui.status',
      args: { text: uiText('status-test') },
      cause: { kind: 'internal', subsystem: 'arbitration' }
    })
    flush(r)
    if (!status.ok) throw new Error('refused')
    const next = '55555555-5555-4555-8555-555555555555'
    await r.poll(conn, { sid: next }) // /clear: the poll leads, the rebound follows
    r.core.facade.rebind(r.view(), next)
    expect(await status.settled).toEqual({ state: 'dropped', why: 'rebound', delivered: false })
    expect(r.channel.inspect().live).toBe(1)
    expect(flush(r).ok).toBe(true) // settled again
    const answer = await r.poll(conn, { sid: next })
    expect(answer.json.commands.map((c: { name: string }) => c.name)).toEqual(['flush'])
  })
})

describe('profiles', () => {
  it('headless has no poll', async () => {
    const r = await rig({ interactive: false })
    const { conn } = await r.hello()
    const answer = await r.poll(conn)
    expect(answer.json).toMatchObject({ ok: false, code: 'FEATURE_DISABLED' })
  })

  it('headless refuses commands', async () => {
    const r = await rig({ interactive: false })
    await r.hello()
    const out = r.channel.enqueue({
      sessionKey: 'key:pty-1',
      name: 'turn.abort',
      args: {},
      cause: { kind: 'operator', gesture: 'debug' }
    })
    expect(out).toEqual({ ok: false, reason: 'HEADLESS' })
  })

  it('a channel key of off answers poll FEATURE_DISABLED', async () => {
    const r = await rig({ pollHoldMs: 100 })
    const { conn } = await r.hello()
    r.state.mode = 'off'
    expect((await r.poll(conn)).json).toMatchObject({ ok: false, code: 'FEATURE_DISABLED' })
  })
})
