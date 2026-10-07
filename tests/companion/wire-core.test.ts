import { describe, expect, it } from 'vitest'
import {
  acceptEvents,
  createRateBucket,
  HOST_PROTO_MAX,
  HOST_PROTO_MIN,
  isRateExempt,
  negotiate,
  parseRoute,
  takeToken,
  validateBye,
  validateEnvelope,
  validateEvents,
  validateHello
} from '../../src/main/companion/wire-core'
import { RATE_MAX_REQUESTS, RATE_WINDOW_MS } from '../../src/main/companion/contract'
import type { WireEvent } from '../../src/main/companion/contract'
import { eventsSeqSteps, SEQ_EVENT_TYPE } from '../../resources/companion/tests/fixtures/events-seq'
import {
  FIXTURE_CONN,
  FIXTURE_SID,
  helloHeadlessRequest,
  helloResumeRequest,
  helloSpawnRequest
} from '../../resources/companion/tests/fixtures/hello'

const envelope = { v: 1, sid: FIXTURE_SID, conn: FIXTURE_CONN, sentAt: 1 }

describe('routes', () => {
  it('maps the five endpoints, 404 for anything else and 405 for a method other than POST', () => {
    for (const name of ['hello', 'events', 'poll', 'ask', 'bye']) {
      expect(parseRoute('POST', `/v1/${name}`)).toBe(name)
    }
    expect(parseRoute('POST', '/v1/events?x=1')).toBe('events')
    expect(parseRoute('POST', '/v1/nope')).toEqual({ status: 404 })
    expect(parseRoute('POST', '/mcp')).toEqual({ status: 404 })
    expect(parseRoute('POST', undefined)).toEqual({ status: 404 })
    expect(parseRoute('GET', '/v1/hello')).toEqual({ status: 405 })
    expect(parseRoute(undefined, '/v1/hello')).toEqual({ status: 405 })
    // the route wins over the method: an unknown route is 404 even for a GET
    expect(parseRoute('GET', '/v1/other')).toEqual({ status: 404 })
  })
})

describe('negotiation', () => {
  it('negotiation: highest common version (conformance row 17)', () => {
    expect(HOST_PROTO_MIN).toBe(1)
    expect(HOST_PROTO_MAX).toBe(1)
    expect(negotiate(1, 3)).toBe(1)
    expect(negotiate(1, 1)).toBe(1)
    expect(negotiate(0, 1)).toBe(1)
  })

  it('negotiation: no overlap (conformance row 17)', () => {
    expect(negotiate(2, 2)).toBeNull()
    expect(negotiate(2, 5)).toBeNull()
    expect(negotiate(0, 0)).toBeNull()
  })
})

describe('validateHello', () => {
  it('accepts the golden hello fixtures and keeps only what it reads', () => {
    for (const req of [helloSpawnRequest, helloResumeRequest, helloHeadlessRequest]) {
      const r = validateHello({ ...req, unexpected: { deep: true } })
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.value).toEqual(req)
        expect(r.value).not.toHaveProperty('unexpected')
      }
    }
  })

  it.each([
    ['a non-object', 'x'],
    ['null', null],
    ['an array', []],
    ['a missing sid', { ...helloSpawnRequest, sid: undefined }],
    ['a sid over 64 chars', { ...helloSpawnRequest, sid: 's'.repeat(65) }],
    ['a cwd over 4096 chars', { ...helloSpawnRequest, cwd: '/'.repeat(4097) }],
    ['a cli.version over 64 chars', { ...helloSpawnRequest, cli: { version: 'v'.repeat(65) } }],
    ['a mod.version over 64 chars', { ...helloSpawnRequest, mod: { version: 'v'.repeat(65) } }],
    ['65 declared features', { ...helloSpawnRequest, declared: Array(65).fill('sense.identity') }],
    ['a non-string declared entry', { ...helloSpawnRequest, declared: [1] }],
    ['a non-boolean isInteractive', { ...helloSpawnRequest, isInteractive: 'yes' }],
    ['a fractional protoMin', { ...helloSpawnRequest, protoMin: 1.5 }],
    ['protoMin above protoMax', { ...helloSpawnRequest, protoMin: 3, protoMax: 1 }],
    ['a spawn that is not a string', { ...helloSpawnRequest, spawn: 7 }],
    ['a resume without conn', { ...helloResumeRequest, resume: {} }],
    ['a non-finite sentAt', { ...helloSpawnRequest, sentAt: 'now' }]
  ])('rejects %s as BAD_ENVELOPE', (_label, body) => {
    const r = validateHello(body)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('BAD_ENVELOPE')
  })
})

describe('validateEnvelope / validateEvents / validateBye', () => {
  it('accepts a well-formed envelope and rejects missing or oversized fields', () => {
    expect(validateEnvelope(envelope).ok).toBe(true)
    expect(validateEnvelope({ ...envelope, conn: undefined }).ok).toBe(false)
    expect(validateEnvelope({ ...envelope, sid: 's'.repeat(65) }).ok).toBe(false)
    expect(validateEnvelope({ ...envelope, v: 0 }).ok).toBe(false)
    expect(validateEnvelope([]).ok).toBe(false)
  })

  it('validates events: seq a positive safe integer, at most 256 per batch, unknown fields ignored', () => {
    const good = {
      ...envelope,
      events: [{ seq: 1, t: 'x.y', ts: 5, d: {}, extra: 1 }],
      dropped: 2
    }
    const r = validateEvents(good)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.events[0]).not.toHaveProperty('extra')
      expect(r.value.dropped).toBe(2)
    }
    const bad = (events: unknown): boolean => validateEvents({ ...envelope, events }).ok
    expect(bad([])).toBe(true)
    expect(bad([{ seq: 0, t: 'x', ts: 1, d: {} }])).toBe(false)
    expect(bad([{ seq: 1.5, t: 'x', ts: 1, d: {} }])).toBe(false)
    expect(bad([{ seq: Number.MAX_SAFE_INTEGER + 1, t: 'x', ts: 1, d: {} }])).toBe(false)
    expect(bad([{ seq: 1, t: 7, ts: 1, d: {} }])).toBe(false)
    expect(bad(Array.from({ length: 257 }, (_, i) => ({ seq: i + 1, t: 'x', ts: 1, d: {} })))).toBe(
      false
    )
    expect(bad(Array.from({ length: 256 }, (_, i) => ({ seq: i + 1, t: 'x', ts: 1, d: {} })))).toBe(
      true
    )
    expect(bad('nope')).toBe(false)
    expect(validateEvents({ ...envelope, events: [], dropped: -1 }).ok).toBe(false)
  })

  it('validates bye: a reason, and an optional final batch', () => {
    expect(validateBye({ ...envelope, reason: 'exit' }).ok).toBe(true)
    expect(validateBye({ ...envelope, reason: 'exit', events: [] }).ok).toBe(true)
    expect(validateBye({ ...envelope }).ok).toBe(false)
    expect(validateBye({ ...envelope, reason: 'x'.repeat(257) }).ok).toBe(false)
    expect(validateBye({ ...envelope, reason: 'exit', events: [{ seq: 0 }] }).ok).toBe(false)
  })
})

describe('sequence acceptance', () => {
  const known = new Set<string>([SEQ_EVENT_TYPE])

  it('dedupe, gap and resync (conformance row 5)', () => {
    let state = { last: 0 }
    const acks: number[] = []
    const resyncs: boolean[] = []
    let duplicates = 0
    for (const step of eventsSeqSteps) {
      const r = acceptEvents(state, step.events, step.dropped, known)
      expect(r.accepted.map((e) => e.seq)).toEqual(step.expect.accepted)
      expect(r.duplicates).toBe(step.expect.duplicates)
      expect(r.ackSeq).toBe(step.expect.ackSeq)
      expect(r.resync).toBe(step.expect.resync)
      acks.push(r.ackSeq)
      resyncs.push(r.resync)
      duplicates += r.duplicates
      state = r.next
    }
    expect(acks).toEqual([3, 4, 7])
    expect(duplicates).toBe(2) // the pair 2 and 3 of the second batch
    expect(resyncs).toEqual([false, false, true]) // only the last answer carries resync
  })

  it('a gap is closed by the resync: the ack is the highest seq received', () => {
    const r = acceptEvents({ last: 3 }, [ev(7), ev(8)], undefined, known)
    expect(r.ackSeq).toBe(8)
    expect(r.next.last).toBe(8)
    expect(r.resync).toBe(true)
    expect(r.accepted).toHaveLength(2)
  })

  it('dropped > 0 sets resync and an empty batch is a heartbeat', () => {
    expect(acceptEvents({ last: 5 }, [], 3, known)).toMatchObject({ resync: true, ackSeq: 5 })
    expect(acceptEvents({ last: 5 }, [], undefined, known)).toMatchObject({
      resync: false,
      ackSeq: 5,
      accepted: []
    })
    expect(acceptEvents({ last: 5 }, [], 0, known).resync).toBe(false)
  })

  it('does not mutate the state it was given', () => {
    const state = { last: 2 }
    acceptEvents(state, [ev(3)], undefined, known)
    expect(state.last).toBe(2)
  })

  it('unknown types are ignored and counted (conformance row 18)', () => {
    const odd = { seq: 1, t: 'future.thing', ts: 1, d: { brandNew: true } } as unknown as WireEvent
    const r = acceptEvents({ last: 0 }, [odd, ev(2)], undefined, known)
    expect(r.accepted.map((e) => e.t)).toEqual([SEQ_EVENT_TYPE])
    expect(r.unknown).toBe(1)
    expect(r.ackSeq).toBe(2) // seq advanced past the unknown event
    expect(r.resync).toBe(false)
  })

  it('an empty known set delivers nothing and still advances seq', () => {
    const r = acceptEvents({ last: 0 }, [ev(1), ev(2)], undefined, new Set())
    expect(r.accepted).toEqual([])
    expect(r.unknown).toBe(2)
    expect(r.ackSeq).toBe(2)
  })
})

describe('rate bucket', () => {
  it('rate bucket', () => {
    const bucket = createRateBucket(0)
    for (let i = 0; i < RATE_MAX_REQUESTS; i++) {
      expect(takeToken(bucket, 0)).toEqual({ ok: true })
    }
    expect(takeToken(bucket, 0)).toEqual({ retryAfterMs: 1000 }) // the 201st in the window
    // hello is exempt, whatever the bucket says
    expect(isRateExempt('hello')).toBe(true)
    expect(isRateExempt('events')).toBe(false)
    expect(isRateExempt('poll')).toBe(false)
    expect(isRateExempt('ask')).toBe(false)
    expect(isRateExempt('bye')).toBe(false)
  })

  it('refills continuously: a full window later the bucket is full again', () => {
    const bucket = createRateBucket(0)
    for (let i = 0; i < RATE_MAX_REQUESTS; i++) takeToken(bucket, 0)
    expect('retryAfterMs' in takeToken(bucket, 0)).toBe(true)
    // half a window refills half the bucket
    const half = RATE_WINDOW_MS / 2
    let granted = 0
    while ('ok' in takeToken(bucket, half)) granted++
    expect(granted).toBe(RATE_MAX_REQUESTS / 2)
    // a full window after that refills everything, but never beyond capacity
    let again = 0
    while ('ok' in takeToken(bucket, half + RATE_WINDOW_MS * 5)) again++
    expect(again).toBe(RATE_MAX_REQUESTS)
  })
})

function ev(seq: number): WireEvent {
  return { seq, t: SEQ_EVENT_TYPE, ts: 1, d: { agentType: 'x' } }
}
