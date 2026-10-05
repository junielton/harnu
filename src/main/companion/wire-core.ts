/**
 * Pure wire core of the companion host (T389 P1W1 §7.4): route parsing, structural validation of
 * every inbound body, protocol negotiation, the event sequence rule and the per-binding rate
 * bucket. No I/O, no clock of its own, no Electron: everything a request is allowed to mean is
 * decided here and unit-tested directly.
 *
 * Every body is untrusted input. Validation is structural and closed on what it reads: it copies
 * only the fields it knows into the value it returns, so an unknown field never travels further.
 */

import {
  ENDPOINT_NAMES,
  RATE_MAX_REQUESTS,
  RATE_WINDOW_MS,
  type ByeRequest,
  type Conn,
  type Envelope,
  type EndpointName,
  type EventsRequest,
  type HelloRequest,
  type WireEvent
} from './contract'

export const HOST_PROTO_MIN = 1
export const HOST_PROTO_MAX = 1

/** Hard caps on request fields (contract §5; the host's own wire limits). */
export const MAX_SID_LEN = 64
export const MAX_CWD_LEN = 4096
export const MAX_VERSION_LEN = 64
export const MAX_DECLARED = 64
export const MAX_FEATURE_LEN = 64
export const MAX_EVENTS_PER_BATCH = 256
export const MAX_EVENT_TYPE_LEN = 64
export const MAX_CONN_LEN = 64
export const MAX_SPAWN_LEN = 128
export const MAX_REASON_LEN = 256
export const MAX_ID_LEN = 128

export type Result<T> =
  { ok: true; value: T } | { ok: false; code: 'BAD_ENVELOPE'; message: string }

const bad = (message: string): { ok: false; code: 'BAD_ENVELOPE'; message: string } => ({
  ok: false,
  code: 'BAD_ENVELOPE',
  message
})

const ENDPOINTS: ReadonlySet<string> = new Set<string>(ENDPOINT_NAMES)

/** `POST /v1/<endpoint>`: 404 for an unknown route, 405 for another method (the route wins). */
export function parseRoute(method?: string, url?: string): EndpointName | { status: 404 | 405 } {
  const path = (url ?? '').split('?', 1)[0]
  const m = /^\/v1\/([a-z]+)$/.exec(path)
  if (!m || !ENDPOINTS.has(m[1])) return { status: 404 }
  if ((method ?? '').toUpperCase() !== 'POST') return { status: 405 }
  return m[1] as EndpointName
}

/** The highest protocol version both sides support, or `null` when the ranges do not overlap. */
export function negotiate(modMin: number, modMax: number): number | null {
  const high = Math.min(modMax, HOST_PROTO_MAX)
  const low = Math.max(modMin, HOST_PROTO_MIN)
  return high >= low ? high : null
}

// ---- field readers --------------------------------------------------------------------------

type Rec = Record<string, unknown>

const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)

const isStr = (v: unknown, max: number, min = 1): v is string =>
  typeof v === 'string' && v.length >= min && v.length <= max

const isPosInt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0

const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function readEnvelope(b: Rec): Result<Envelope> {
  if (!isPosInt(b.v)) return bad('v must be a positive integer')
  if (!isStr(b.sid, MAX_SID_LEN)) return bad('sid must be a string of 1 to 64 chars')
  if (!isStr(b.conn, MAX_CONN_LEN)) return bad('conn must be a string of 1 to 64 chars')
  if (!isFiniteNum(b.sentAt)) return bad('sentAt must be a number')
  return {
    ok: true,
    value: { v: b.v, sid: b.sid, conn: b.conn as Envelope['conn'], sentAt: b.sentAt }
  }
}

function readEvents(raw: unknown): Result<WireEvent[]> {
  if (!Array.isArray(raw)) return bad('events must be an array')
  if (raw.length > MAX_EVENTS_PER_BATCH) return bad('too many events in one batch')
  const out: WireEvent[] = []
  for (const e of raw) {
    if (!isRec(e)) return bad('an event must be an object')
    if (!isPosInt(e.seq)) return bad('event seq must be a positive safe integer')
    if (!isStr(e.t, MAX_EVENT_TYPE_LEN)) return bad('event t must be a short string')
    if (!isFiniteNum(e.ts)) return bad('event ts must be a number')
    const ev: Rec = { seq: e.seq, t: e.t, ts: e.ts, d: e.d }
    if (typeof e.turnId === 'string') ev.turnId = e.turnId
    if (typeof e.agentId === 'string') ev.agentId = e.agentId
    out.push(ev as unknown as WireEvent)
  }
  return { ok: true, value: out }
}

// ---- validators -----------------------------------------------------------------------------

export function validateHello(body: unknown): Result<HelloRequest> {
  if (!isRec(body)) return bad('body must be an object')
  const { protoMin, protoMax } = body
  if (!isPosInt(protoMin) && protoMin !== 0) return bad('protoMin must be a non-negative integer')
  if (!isPosInt(protoMax) && protoMax !== 0) return bad('protoMax must be a non-negative integer')
  if ((protoMin as number) > (protoMax as number)) return bad('protoMin is above protoMax')
  if (!isStr(body.sid, MAX_SID_LEN)) return bad('sid must be a string of 1 to 64 chars')
  if (body.spawn !== undefined && !isStr(body.spawn, MAX_SPAWN_LEN)) return bad('bad spawn')
  let resume: HelloRequest['resume']
  if (body.resume !== undefined) {
    if (!isRec(body.resume) || !isStr(body.resume.conn, MAX_CONN_LEN)) return bad('bad resume')
    resume = { conn: body.resume.conn as Conn }
  }
  if (!isRec(body.cli) || !isStr(body.cli.version, MAX_VERSION_LEN, 0)) return bad('bad cli')
  if (!isRec(body.mod) || !isStr(body.mod.version, MAX_VERSION_LEN, 0)) return bad('bad mod')
  if (body.surface !== null && !isStr(body.surface, MAX_VERSION_LEN, 0)) return bad('bad surface')
  if (typeof body.isInteractive !== 'boolean') return bad('isInteractive must be a boolean')
  if (!isStr(body.cwd, MAX_CWD_LEN, 0)) return bad('cwd must be a string of at most 4096 chars')
  if (!Array.isArray(body.declared) || body.declared.length > MAX_DECLARED) {
    return bad('declared must be an array of at most 64 entries')
  }
  if (!body.declared.every((f) => isStr(f, MAX_FEATURE_LEN))) return bad('bad declared entry')
  if (!isFiniteNum(body.sentAt)) return bad('sentAt must be a number')

  const value: HelloRequest = {
    protoMin: protoMin as number,
    protoMax: protoMax as number,
    sid: body.sid,
    cli: { version: body.cli.version },
    mod: { version: body.mod.version },
    surface: body.surface,
    isInteractive: body.isInteractive,
    cwd: body.cwd,
    declared: [...(body.declared as string[])],
    sentAt: body.sentAt
  }
  if (body.spawn !== undefined) value.spawn = body.spawn as HelloRequest['spawn']
  if (resume) value.resume = resume
  return { ok: true, value }
}

/** The common head of every request but hello. */
export function validateEnvelope(body: unknown): Result<Envelope> {
  if (!isRec(body)) return bad('body must be an object')
  return readEnvelope(body)
}

export function validateEvents(body: unknown): Result<EventsRequest> {
  if (!isRec(body)) return bad('body must be an object')
  const env = readEnvelope(body)
  if (!env.ok) return env
  const events = readEvents(body.events)
  if (!events.ok) return events
  const value: EventsRequest = { ...env.value, events: events.value }
  if (body.dropped !== undefined) {
    if (
      typeof body.dropped !== 'number' ||
      !Number.isSafeInteger(body.dropped) ||
      body.dropped < 0
    ) {
      return bad('dropped must be a non-negative integer')
    }
    value.dropped = body.dropped
  }
  if (typeof body.bootId === 'string' && body.bootId.length <= MAX_ID_LEN) {
    value.bootId = body.bootId as EventsRequest['bootId']
  }
  if (typeof body.cursor === 'number' && Number.isSafeInteger(body.cursor) && body.cursor >= 0) {
    value.cursor = body.cursor
  }
  return { ok: true, value }
}

export function validateBye(body: unknown): Result<ByeRequest> {
  if (!isRec(body)) return bad('body must be an object')
  const env = readEnvelope(body)
  if (!env.ok) return env
  if (!isStr(body.reason, MAX_REASON_LEN, 0)) return bad('reason must be a string')
  const value: ByeRequest = { ...env.value, reason: body.reason }
  if (body.events !== undefined) {
    const events = readEvents(body.events)
    if (!events.ok) return events
    value.events = events.value
  }
  return { ok: true, value }
}

// ---- sequence rule --------------------------------------------------------------------------

export interface SeqState {
  last: number // highest seq accepted on this conn
}

export interface AcceptResult {
  accepted: WireEvent[] // known types, seq > state.last, in order
  duplicates: number
  unknown: number // seq advanced, event not delivered (contract §8, last rule)
  ackSeq: number
  resync: boolean
  next: SeqState
}

/**
 * Contract §6. For each event in array order: `seq <= last` is a duplicate and dropped;
 * `seq === last + 1` is accepted; a larger seq is a gap: accepted, `resync` set. `last` ends at
 * the highest seq seen and `ackSeq` equals it, also after a gap, because the missing events cannot
 * be re-sent and an ack held at the pre-gap value would pin the post-gap events for ever.
 * `dropped > 0` also sets `resync`. An empty batch is a heartbeat.
 */
export function acceptEvents(
  state: SeqState,
  events: readonly WireEvent[],
  dropped: number | undefined,
  known: ReadonlySet<string>
): AcceptResult {
  let last = state.last
  let duplicates = 0
  let unknown = 0
  let resync = (dropped ?? 0) > 0
  const accepted: WireEvent[] = []
  for (const e of events) {
    if (e.seq <= last) {
      duplicates++
      continue
    }
    if (e.seq > last + 1) resync = true
    last = e.seq
    if (known.has(e.t)) accepted.push(e)
    else unknown++
  }
  return { accepted, duplicates, unknown, ackSeq: last, resync, next: { last } }
}

// ---- rate bucket ----------------------------------------------------------------------------

/** A token bucket refilled continuously: `RATE_MAX_REQUESTS` per `RATE_WINDOW_MS`. */
export interface RateBucket {
  tokens: number
  updatedAt: number
}

export function createRateBucket(now: number): RateBucket {
  return { tokens: RATE_MAX_REQUESTS, updatedAt: now }
}

/** `hello` is exempt: a mod that lost its `conn` must always be able to recover. */
export function isRateExempt(endpoint: EndpointName): boolean {
  return endpoint === 'hello'
}

export const SLOW_DOWN_RETRY_MS = 1000

/** Takes one token, mutating the bucket. Over the limit: `retryAfterMs` for `SLOW_DOWN`. */
export function takeToken(
  bucket: RateBucket,
  now: number
): { ok: true } | { retryAfterMs: number } {
  const elapsed = Math.max(0, now - bucket.updatedAt)
  bucket.tokens = Math.min(
    RATE_MAX_REQUESTS,
    bucket.tokens + (elapsed * RATE_MAX_REQUESTS) / RATE_WINDOW_MS
  )
  bucket.updatedAt = now
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1
    return { ok: true }
  }
  return { retryAfterMs: SLOW_DOWN_RETRY_MS }
}
