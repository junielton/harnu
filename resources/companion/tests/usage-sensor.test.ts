import { expect, test } from 'claude-code/testing'
import { HEARTBEAT_MS } from '../hooks/contract'
import { FIXTURE_SID } from './fixtures/hello'
import { START, helloOk, installRig, must, defaultScript } from './support/rig'

/** The payload of smoke A3 (`docs/studies/T389-smoke-evidence.md`): a measure after a turn. */
const A3_MEASURE = {
  context: { tokens: 37302, window: 200000, percent: 19 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 21, resetsAt: '2026-10-02T18:00:00.000Z' },
    { kind: 'seven_day', percentUsed: 54, resetsAt: '2026-10-05T19:00:00.000Z' }
  ],
  cost: { usd: 0.0185783 },
  changed: ['context', 'cost']
} as const

/** `$.session.usage()` of smoke A3. */
const A3_USAGE = {
  startedAt: 1790948659078,
  context: { tokens: 49284, window: 200000, percent: 25 },
  rateLimits: A3_MEASURE.rateLimits,
  cost: { usd: 0.19372685 }
}

const WITH_USAGE = ['sense.identity', 'sense.usage']

/** The reads are un-awaited calls: let their continuations and the pump run. */
async function drain(rig: {
  clock: { settle(): Promise<unknown>; advance(ms: number): Promise<unknown> }
}): Promise<void> {
  for (let i = 0; i < 4; i++) await rig.clock.settle()
  // an event queued just as a pump ended waits for the next heartbeat (contract §6)
  await rig.clock.advance(HEARTBEAT_MS)
  await rig.clock.settle()
}

function usageScript(enable: string[], resyncOnce = false) {
  let resynced = false
  return (route: string, body: unknown, n: number) => {
    if (route === 'hello') return helloOk(enable)
    if (route === 'events') {
      const evs = ((body as { events?: { seq: number }[] }).events ?? []) as { seq: number }[]
      const ackSeq = Math.max(0, ...evs.map((e) => e.seq))
      const resync = resyncOnce && !resynced && evs.length > 0
      if (resync) resynced = true
      return { kind: 'body' as const, body: { ok: true, ackSeq, ...(resync ? { resync } : {}) } }
    }
    return defaultScript(route as never, body, n)
  }
}

test('measure is forwarded (AC-P1W6-1)', async ($, on) => {
  const rig = installRig(on, { script: usageScript(WITH_USAGE) })
  // The bottom hooks stand for the engine: the usage reads of the post-hello `read`, and the
  // measure hook, which records what reached it.
  on('session.usage', async () => ({ value: A3_USAGE }))
  on('session.model', async () => ({ value: 'claude-haiku-4-5-20251001' }))
  const reached: unknown[] = []
  on('session.measure', async (_$, e) => {
    reached.push(e)
    return { changed: e.changed }
  })
  await $.session.start(START)
  await drain(rig)
  const sent = (): { d: Record<string, unknown> }[] =>
    rig.events().filter((e) => e.t === 'usage.measured' && e.d.source === 'measure')
  const before = sent().length

  const out = await $.session.measure(A3_MEASURE as never)
  await drain(rig)

  // next(e) is returned unchanged
  expect(out).toEqual({ changed: ['context', 'cost'] })
  expect(reached.length).toBe(1)
  expect(reached[0]).toEqual(A3_MEASURE)

  const measured = sent()
  expect(measured.length).toBe(before + 1)
  const ev = must(measured.at(-1))
  expect(ev.d).toEqual({
    source: 'measure',
    context: { window: 200000, tokens: 37302, percent: 19 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 21, resetsAt: '2026-10-02T18:00:00.000Z' },
      { kind: 'seven_day', percentUsed: 54, resetsAt: '2026-10-05T19:00:00.000Z' }
    ],
    costUsd: 0.0185783,
    changed: ['context', 'cost']
  })
})

test('a measure before the first response has no tokens and still goes out (smoke A3)', async ($, on) => {
  const rig = installRig(on, { script: usageScript(WITH_USAGE) })
  on('session.usage', async () => ({ value: A3_USAGE }))
  on('session.model', async () => ({ value: 'm' }))
  on('session.measure', async (_$, e) => ({ changed: e.changed }))
  await $.session.start(START)
  await drain(rig)
  await $.session.measure({
    context: { window: 200000 },
    rateLimits: [],
    cost: { usd: 0 },
    changed: ['context', 'cost']
  } as never)
  await drain(rig)
  const ev = must(
    rig
      .events()
      .filter((e) => e.t === 'usage.measured' && e.d.source === 'measure')
      .at(-1)
  )
  expect(ev.d.context).toEqual({ window: 200000 })
  expect(ev.d.rateLimits).toEqual([])
  expect(ev.d.costUsd).toBe(0)
})

test('read on resync (AC-P1W6-2)', async ($, on) => {
  const rig = installRig(on, { script: usageScript(WITH_USAGE, true) })
  let usageCalls = 0
  on('session.usage', async () => {
    usageCalls++
    return { value: A3_USAGE }
  })
  on('session.model', async () => ({ value: 'claude-haiku-4-5-20251001' }))
  on('session.measure', async (_$, e) => ({ changed: e.changed }))
  await $.session.start(START)
  await drain(rig)
  const reads = (): { d: Record<string, unknown> }[] =>
    rig.events().filter((e) => e.t === 'usage.measured' && e.d.source === 'read')
  // the hello's read is on the wire (the host answers the first batch with `resync`)
  expect(reads().length).toBeGreaterThanOrEqual(1)
  const first = must(reads()[0])
  expect(first.d).toEqual({
    source: 'read',
    startedAt: 1790948659078,
    model: 'claude-haiku-4-5-20251001',
    context: { window: 200000, tokens: 49284, percent: 25 },
    rateLimits: A3_USAGE.rateLimits,
    costUsd: 0.19372685,
    changed: ['context', 'rateLimits', 'cost']
  })
  // the resync produced one more read: the host asked for the state again
  expect(usageCalls).toBeGreaterThanOrEqual(2)
  void FIXTURE_SID
})

test('a read of a session with no cost ledger and no windows names only what it has', async ($, on) => {
  const rig = installRig(on, { script: usageScript(WITH_USAGE) })
  on('session.usage', async () => ({
    value: { startedAt: 5, context: { window: 1000000 }, rateLimits: [] }
  }))
  on('session.model', async () => ({ value: 'm' }))
  on('session.measure', async (_$, e) => ({ changed: e.changed }))
  await $.session.start(START)
  await drain(rig)
  const ev = must(rig.events().find((e) => e.t === 'usage.measured'))
  expect(ev.d.changed).toEqual(['context'])
  expect(ev.d.costUsd).toBeUndefined()
  expect(ev.d.rateLimits).toEqual([])
})

test('a rejected read is a mod.error, not a retry loop', async ($, on) => {
  const rig = installRig(on, { script: usageScript(WITH_USAGE) })
  let calls = 0
  on('session.usage', async () => {
    calls++
    throw new Error('boom')
  })
  on('session.model', async () => ({ value: 'm' }))
  on('session.measure', async (_$, e) => ({ changed: e.changed }))
  await $.session.start(START)
  await drain(rig)
  expect(calls).toBe(1)
  expect(rig.events().some((e) => e.t === 'mod.error' && e.d.where === 'session.usage')).toBe(true)
})

test('usage is neither read nor sent while sense.usage is not enabled', async ($, on) => {
  const rig = installRig(on, { script: usageScript(['sense.identity']) })
  let reads = 0
  on('session.usage', async () => {
    reads++
    return { value: A3_USAGE }
  })
  on('session.model', async () => ({ value: 'm' }))
  on('session.measure', async (_$, e) => ({ changed: e.changed }))
  await $.session.start(START)
  await drain(rig)
  await $.session.measure(A3_MEASURE as never)
  await drain(rig)
  expect(reads).toBe(0)
  expect(rig.events().some((e) => e.t === 'usage.measured')).toBe(false)
})

test('a throwing sensor never changes the answer of session.measure', async ($, on) => {
  installRig(on, { script: usageScript(WITH_USAGE) })
  on('session.usage', async () => ({ value: A3_USAGE }))
  on('session.model', async () => ({ value: 'm' }))
  on('session.measure', async (_$, e) => ({ changed: e.changed }))
  await $.session.start(START)
  // a hostile shape: no rateLimits array at all
  const out = await $.session.measure({ context: { window: 1 }, changed: ['context'] } as never)
  expect(out).toEqual({ changed: ['context'] })
})
