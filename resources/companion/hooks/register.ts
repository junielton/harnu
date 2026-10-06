import type { EngineInterface, Register } from 'claude-code'
import {
  BACKOFF_MAX_MS,
  BACKOFF_MIN_MS,
  BYE_BUDGET_MS,
  DEFAULT_CONFIG,
  HEARTBEAT_MS,
  HELLO_WAIT_MS,
  DRIFT_CHECK_MIN_MS,
  PROTOCOL_VERSION,
  RING_MAX,
  type ByeRequest,
  type CmdId,
  type Config,
  type Conn,
  type EndpointName,
  type EventName,
  type EventPayloads,
  type EventsRequest,
  type FeatureId,
  type HelloRequest,
  type Sid
} from './contract'
import { MOD_VERSION, RENDEZVOUS_PATH } from './coords.gen'
import { toAdmitted, type Admitted } from './lib/admitted'
import { createRing } from './lib/ring'
import { endpointUrl, parseEndpoint, type Endpoint } from './lib/rendezvous-parse'

/**
 * The Harnu companion mod, wave P1W3: the handshake and the identity facts (spec P1W3).
 *
 * Every function that takes `$` is declared here, at the top of the module (MOD-1); helpers under
 * `lib/` are `$`-free. Every hook body is wrapped and ends in `next(e)`: a failure here must never
 * show in the session (MOD-2, SEC-1). Nothing is awaited on a turn's path except the first hello
 * (bounded by HELLO_WAIT_MS) and the one `bye`.
 */

type Dollar = EngineInterface
type Timer = { cancel: () => void }
type Boot = { cwd: string; surface: string | null; isInteractive: boolean }
type Probes = { classic: boolean; toolCheck: boolean }

const CONN = { plugin: 'harnu-companion', key: 'conn' } as const
const BOOT_ID = { plugin: 'harnu-companion', key: 'bootId' } as const
const SID = { plugin: 'harnu-companion', key: 'sid' } as const
const BOOT = { plugin: 'harnu-companion', key: 'boot' } as const
const PROBES = { plugin: 'harnu-companion', key: 'probes' } as const

/** The feature an event type belongs to. `null`: reportable whenever the channel is alive. */
const EVENT_FEATURE: Partial<Record<EventName, FeatureId | null>> = {
  'session.snapshot': 'sense.identity',
  'session.rebound': 'sense.identity',
  'session.end': 'sense.identity',
  'mod.admitted': 'sense.mods',
  'mod.error': null
}

// ---- module state: wiped by a reload; the durable twins live in `$.state` ---------------------

let conn: Conn | null = null
let bootId: string | null = null
let proto = PROTOCOL_VERSION
let enabledSet: FeatureId[] = []
let config: Config = { ...DEFAULT_CONFIG }
let sidBound: Sid | null = null
let boot: Boot | null = null
let probes: Probes = { classic: false, toolCheck: false }
let declared: FeatureId[] = []
let dormant = false
let inert = false
let helloFlight: Promise<void> | null = null
let retryBlocked = false
let retryTimer: Timer | null = null
let backoffMs = BACKOFF_MIN_MS
let heartbeat: Timer | null = null
let sentSinceBeat = false
let driftBlocked = false
let endpoint: Endpoint | null = null
let pumpFlight: Promise<void> | null = null
let registrationErrors: string[] = []
let ring = createRing(RING_MAX)
/** Modules admitted before the hello answered (the usual case: they load before `session.start`). */
let pendingAdmitted: Admitted[] = []

/** At most this many admissions wait for the first hello; a session loads a handful of mods. */
const PENDING_ADMITTED_MAX = 64

function resetState(): void {
  conn = null
  bootId = null
  proto = PROTOCOL_VERSION
  enabledSet = []
  config = { ...DEFAULT_CONFIG }
  sidBound = null
  boot = null
  probes = { classic: false, toolCheck: false }
  declared = []
  dormant = false
  inert = false
  helloFlight = null
  retryBlocked = false
  retryTimer = null
  backoffMs = BACKOFF_MIN_MS
  heartbeat = null
  sentSinceBeat = false
  driftBlocked = false
  endpoint = null
  pumpFlight = null
  registrationErrors = []
  ring = createRing(RING_MAX)
  pendingAdmitted = []
}

// ---- runtime helpers other waves call ---------------------------------------------------------

/** The bound sid of contract §15: what the envelope carries. */
function boundSid(): Sid | null {
  return sidBound
}

/** False when dormant or inert. */
function enabled(feature: FeatureId): boolean {
  return !dormant && !inert && conn !== null && enabledSet.includes(feature)
}

/** Queues into the ring and starts the pump. Never awaited on a turn's path. */
function emit<N extends EventName>(
  $: Dollar,
  ev: { t: N; d: EventPayloads[N]; turnId?: string; agentId?: string }
): void {
  if (dormant || inert || conn === null) return
  const feature = EVENT_FEATURE[ev.t]
  if (feature === undefined) return
  if (feature !== null && !enabledSet.includes(feature)) return
  ring.push({
    t: ev.t,
    ts: Date.now(),
    d: ev.d,
    ...(ev.turnId !== undefined ? { turnId: ev.turnId } : {}),
    ...(ev.agentId !== undefined ? { agentId: ev.agentId } : {})
  })
  pump($)
}

/**
 * Wraps a caught error as `mod.error` (message capped at 512 chars). It needs no `$`: the event
 * goes into the ring and the next pump or heartbeat sends it (`$` is never stored, MOD-1).
 */
function reportModError(where: string, err: unknown, cmd?: CmdId): void {
  if (dormant || inert || conn === null) return
  const raw = err instanceof Error ? err.message : String(err)
  ring.push({
    t: 'mod.error',
    ts: Date.now(),
    d: { where, kind: 'throw', message: raw.slice(0, 512), ...(cmd !== undefined ? { cmd } : {}) }
  })
}

// ---- transport --------------------------------------------------------------------------------

type Posted =
  { kind: 'answer'; body: Record<string, unknown> } | { kind: 'transport' } | { kind: 'rebooted' }

async function readEndpoint($: Dollar): Promise<Endpoint | null> {
  try {
    const raw = await $.fs.read(RENDEZVOUS_PATH)
    return parseEndpoint(typeof raw === 'string' ? raw : '', RENDEZVOUS_PATH)
  } catch {
    return null
  }
}

/**
 * One POST. The endpoint is cached only until the first failure (contract §2.5: never cache
 * coordinates across a failure). A changed `bootId` read after a failure means the host restarted:
 * the caller resumes, exactly as for STALE_CONN.
 */
async function post(
  $: Dollar,
  route: EndpointName,
  body: unknown,
  ignoreBoot: boolean
): Promise<Posted> {
  let ep = endpoint
  if (ep === null) {
    ep = await readEndpoint($)
    if (ep === null) return { kind: 'transport' }
    if (!ignoreBoot && bootId !== null && ep.bootId !== bootId) {
      endpoint = ep
      return { kind: 'rebooted' }
    }
    endpoint = ep
  }
  try {
    const res = await $.http.fetch(endpointUrl(ep, route), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ep.token}` },
      body: JSON.stringify(body),
      ...(ep.socketPath !== undefined ? { socketPath: ep.socketPath } : {})
    })
    if (res.status !== 200) {
      endpoint = null
      return { kind: 'transport' }
    }
    const parsed: unknown = JSON.parse(res.text)
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as { ok?: unknown }).ok !== 'boolean'
    ) {
      endpoint = null
      return { kind: 'transport' }
    }
    return { kind: 'answer', body: parsed as Record<string, unknown> }
  } catch {
    endpoint = null
    return { kind: 'transport' }
  }
}

/** Resolves when `p` settles or after `ms`, whichever comes first. `p` is never cancelled. */
function raceWithTimer($: Dollar, p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let timer: Timer | null = null
    const finish = (): void => {
      timer?.cancel()
      resolve()
    }
    timer = $.clock.after(ms, () => resolve())
    p.then(finish, finish)
  })
}

/** Arms one retry timer. Retries are driven by this timer, by the next hook and by the heartbeat. */
function scheduleRetry($: Dollar, afterMs?: number): void {
  endpoint = null
  retryBlocked = true
  const wait = Math.min(Math.max(afterMs ?? backoffMs, 0), 60_000)
  backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS)
  retryTimer?.cancel()
  retryTimer = $.clock.after(wait, () => {
    retryBlocked = false
    retryTimer = null
    resumeWork($)
  })
}

function resumeWork($: Dollar): void {
  if (dormant || inert) return
  if (conn === null) void ensureHello($)
  else pump($)
}

function goDormant(): void {
  dormant = true
  retryTimer?.cancel()
  retryTimer = null
  heartbeat?.cancel()
  heartbeat = null
  ring.clear()
  pendingAdmitted = []
}

// ---- hello ------------------------------------------------------------------------------------

const DORMANT_CODES: ReadonlySet<string> = new Set([
  'PROTO_UNSUPPORTED',
  'UNAUTHORIZED',
  'UNKNOWN_SESSION',
  'FEATURE_DISABLED'
])

function snapshot($: Dollar, reason: EventPayloads['session.snapshot']['reason']): void {
  emit($, {
    t: 'session.snapshot',
    d: {
      reason,
      activeTurnId: null,
      openAttention: [],
      runningSubagents: 0,
      probes: { classic: probes.classic, toolCheck: probes.toolCheck }
    }
  })
}

/** Sends what waited for the hello, when `sense.mods` is enabled; otherwise forgets it. */
function flushAdmitted($: Dollar): void {
  const held = pendingAdmitted
  pendingAdmitted = []
  if (!enabledSet.includes('sense.mods')) return
  for (const d of held) emit($, { t: 'mod.admitted', d })
}

/**
 * One module the engine admitted after this one. Sent at once when the channel is already up,
 * otherwise held for the first hello. Never throws and never needs a conn.
 */
function noteAdmitted($: Dollar, input: unknown): void {
  if (dormant || inert) return
  const d = toAdmitted(input)
  if (d === null) return
  if (conn !== null) {
    emit($, { t: 'mod.admitted', d })
    return
  }
  pendingAdmitted = pendingAdmitted.filter((p) => p.root !== d.root)
  pendingAdmitted.push(d)
  if (pendingAdmitted.length > PENDING_ADMITTED_MAX) pendingAdmitted.shift()
}

async function persistConn($: Dollar): Promise<void> {
  if (conn === null) return
  try {
    await $.state.set(CONN, conn)
    if (bootId !== null) await $.state.set(BOOT_ID, bootId)
    if (sidBound !== null) await $.state.set(SID, sidBound)
  } catch {
    // a failed write only costs a reload its resume: it then goes dormant (OQ-6)
  }
}

function startHeartbeatOnce($: Dollar): void {
  if (heartbeat !== null) return
  heartbeat = $.clock.every(Math.max(1, config.heartbeatMs || HEARTBEAT_MS), () => void beat($))
}

/** Single flight. `resumeConn` is the conn a STALE_CONN just invalidated. Never rejects. */
async function doHello($: Dollar, resumeConn?: Conn): Promise<void> {
  try {
    let resume: Conn | undefined = resumeConn
    if (resume === undefined) {
      const saved = await $.state.get(CONN)
      if (saved.value) resume = saved.value
    }
    if (boot === null) {
      const b = await $.state.get(BOOT)
      if (b.value) boot = b.value
    }
    const request: Partial<HelloRequest> = {}
    let sid: Sid | null
    if (resume !== undefined) {
      sid = sidBound ?? (await $.state.get(SID)).value ?? null
      if (sid === null) sid = await $.session.id()
      const p = await $.state.get(PROBES)
      if (p.value)
        probes = {
          classic: probes.classic || p.value.classic,
          toolCheck: probes.toolCheck || p.value.toolCheck
        }
      request.resume = { conn: resume }
    } else {
      const token = await $.env.get('HARNU_SPAWN_TOKEN')
      if (typeof token !== 'string' || token === '') {
        goDormant() // not spawned by Harnu (the external profile is P4W3)
        return
      }
      sid = await $.session.id()
      request.spawn = token as `sp_${string}`
    }
    if (boot === null) return // no session.start yet: the next hook tries again
    const cli = await $.session.version()
    const hello: HelloRequest = {
      protoMin: PROTOCOL_VERSION,
      protoMax: PROTOCOL_VERSION,
      sid,
      ...request,
      cli: { version: cli.version },
      mod: { version: MOD_VERSION },
      surface: boot.surface,
      isInteractive: boot.isInteractive,
      cwd: boot.cwd,
      declared: [...declared],
      sentAt: Date.now()
    }
    const r = await post($, 'hello', hello, true)
    if (r.kind !== 'answer') {
      scheduleRetry($)
      return
    }
    const b = r.body
    if (b.ok !== true) {
      const code = typeof b.code === 'string' ? b.code : ''
      if (DORMANT_CODES.has(code)) {
        goDormant()
        return
      }
      scheduleRetry($, typeof b.retryAfterMs === 'number' ? b.retryAfterMs : undefined)
      return
    }
    if (
      typeof b.conn !== 'string' ||
      typeof b.bootId !== 'string' ||
      typeof b.proto !== 'number' ||
      !Array.isArray(b.enable)
    ) {
      scheduleRetry($)
      return
    }
    conn = b.conn as Conn
    bootId = b.bootId
    proto = b.proto
    enabledSet = (b.enable as unknown[]).filter((f): f is string => typeof f === 'string')
    config = { ...DEFAULT_CONFIG, ...pickConfig(b.config) }
    sidBound = sid
    backoffMs = BACKOFF_MIN_MS
    retryBlocked = false
    ring.renumber()
    await persistConn($)
    if (enabledSet.length === 0) {
      // inert: behave as if no feature exists, keep `conn` so a revoked one can resume
      inert = true
      retryTimer?.cancel()
      retryTimer = null
      heartbeat?.cancel()
      heartbeat = null
      ring.clear()
      pendingAdmitted = []
      return
    }
    for (const where of registrationErrors.splice(0)) {
      emit($, {
        t: 'mod.error',
        d: { where, kind: 'registration', message: 'hook registration failed' }
      })
    }
    snapshot($, 'hello')
    flushAdmitted($)
    startHeartbeatOnce($)
    pump($)
  } catch (err) {
    scheduleRetry($)
    void err
  }
}

function pickConfig(raw: unknown): Partial<Config> {
  const out: Partial<Config> = {}
  if (typeof raw !== 'object' || raw === null) return out
  for (const k of Object.keys(DEFAULT_CONFIG) as (keyof Config)[]) {
    const v = (raw as Record<string, unknown>)[k]
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = v
  }
  return out
}

/** At the head of every hook. A no-op with a conn in memory; bounded when it has to ask. */
async function ensureHello($: Dollar): Promise<void> {
  if (dormant || inert) return
  if (conn !== null) {
    await maybeDriftCheck($)
    return
  }
  if (helloFlight !== null) return raceWithTimer($, helloFlight, HELLO_WAIT_MS)
  if (retryBlocked) return
  helloFlight = doHello($).finally(() => {
    helloFlight = null
  })
  return raceWithTimer($, helloFlight, HELLO_WAIT_MS)
}

/** A STALE_CONN or a changed bootId: forget the conn and say hello again with `resume`. */
async function rehello($: Dollar): Promise<void> {
  const lost = conn
  conn = null
  endpoint = null
  if (helloFlight !== null) return helloFlight
  helloFlight = doHello($, lost ?? undefined).finally(() => {
    helloFlight = null
  })
  return helloFlight
}

// ---- events pump ------------------------------------------------------------------------------

/** Single flight; never awaited by a hook. With `beat`, an empty batch is sent as a heartbeat. */
function pump($: Dollar, beat = false): void {
  if (pumpFlight !== null || conn === null || dormant || inert) return
  if (ring.size() === 0 && !beat) return
  if (retryBlocked) return
  pumpFlight = pumpLoop($, beat)
    .catch(() => scheduleRetry($))
    .finally(() => {
      pumpFlight = null
    })
}

async function pumpLoop($: Dollar, beat: boolean): Promise<void> {
  let first = true
  let maxEvents = config.batchMaxEvents
  let stale = 0
  while (conn !== null && sidBound !== null && !dormant && !inert) {
    const batch = ring.batch(maxEvents, config.batchMaxBytes)
    if (batch.length === 0 && !(beat && first)) return
    first = false
    const dropped = ring.dropped()
    const lastSeq = batch.at(-1)?.seq ?? 0
    const request: EventsRequest = {
      v: proto,
      sid: sidBound,
      conn,
      sentAt: Date.now(),
      events: batch,
      ...(dropped > 0 ? { dropped } : {})
    }
    sentSinceBeat = true
    const r = await post($, 'events', request, false)
    if (r.kind === 'transport') {
      scheduleRetry($)
      return
    }
    if (r.kind === 'rebooted') {
      if (++stale > 2) return scheduleRetry($)
      await rehello($)
      continue
    }
    const body = r.body
    if (body.ok === true && typeof body.ackSeq === 'number') {
      ring.ack(Math.min(body.ackSeq, lastSeq))
      ring.settleDropped(dropped)
      backoffMs = BACKOFF_MIN_MS
      if (body.resync === true) snapshot($, 'resync')
      // no progress (the host acknowledged nothing we sent): do not spin
      if (batch.length > 0 && ring.batch(1, Infinity)[0]?.seq === batch[0]?.seq) return
      continue
    }
    const code = typeof body.code === 'string' ? body.code : ''
    if (code === 'STALE_CONN') {
      if (++stale > 2) return scheduleRetry($)
      await rehello($)
      continue
    }
    if (code === 'BAD_ENVELOPE' || (code === 'TOO_LARGE' && batch.length <= 1)) {
      ring.ack(lastSeq) // this batch can never be accepted: drop it and say so
      reportModError('events', new Error(code))
      continue
    }
    if (code === 'TOO_LARGE') {
      maxEvents = Math.max(1, Math.floor(batch.length / 2))
      continue
    }
    if (DORMANT_CODES.has(code)) return goDormant()
    return scheduleRetry($, typeof body.retryAfterMs === 'number' ? body.retryAfterMs : undefined)
  }
}

/** The heartbeat tick: retry a pending hello, run the drift check, renew the lease. */
async function beat($: Dollar): Promise<void> {
  try {
    if (dormant || inert) return
    if (conn === null) {
      await ensureHello($)
      return
    }
    await maybeDriftCheck($)
    if (ring.size() > 0) pump($)
    else if (!sentSinceBeat) pump($, true)
    sentSinceBeat = false
  } catch (err) {
    void err
  }
}

// ---- identity: rebound ------------------------------------------------------------------------

/** At most once per DRIFT_CHECK_MIN_MS, only while no `classic.*` hook has ever been dispatched. */
async function maybeDriftCheck($: Dollar): Promise<void> {
  if (probes.classic || driftBlocked || conn === null || sidBound === null) return
  driftBlocked = true
  $.clock.after(DRIFT_CHECK_MIN_MS, () => {
    driftBlocked = false
  })
  try {
    const cur = await $.session.id()
    if (typeof cur === 'string' && cur !== '' && cur !== sidBound) await rebound($, cur, 'unknown')
  } catch {
    // the engine's answer is advisory: a failed read changes nothing
  }
}

async function rebound(
  $: Dollar,
  sid: Sid,
  cause: EventPayloads['session.rebound']['cause']
): Promise<void> {
  const prev = sidBound
  if (prev === null || prev === sid) return
  sidBound = sid // the payload is the source of truth; `$.session.id()` can be stale (C10)
  emit($, { t: 'session.rebound', d: { prevSid: prev, sid, cause } })
  await persistConn($) // CQ3: written again after every rebound
}

// ---- bye --------------------------------------------------------------------------------------

/** Best effort and never retried: the ring's contents plus `session.end`, within BYE_BUDGET_MS. */
async function sayBye($: Dollar, reason: string): Promise<void> {
  if (dormant || inert || conn === null || sidBound === null) return
  ring.push({ t: 'session.end', ts: Date.now(), d: { reason } })
  const request: ByeRequest = {
    v: proto,
    sid: sidBound,
    conn,
    sentAt: Date.now(),
    reason,
    events: ring.batch(config.ringMax, 512 * 1024)
  }
  await raceWithTimer($, post($, 'bye', request, false), BYE_BUDGET_MS)
}

// ---- the module -------------------------------------------------------------------------------

export const register: Register = (on) => {
  resetState()
  const registered = { start: false, end: false, classic: false, mods: false }

  try {
    on('session.start', async ($, e, next) => {
      try {
        boot = { cwd: e.cwd, surface: e.surface, isInteractive: e.isInteractive }
        await $.state.set(BOOT, boot).catch(() => undefined)
        await ensureHello($)
      } catch (err) {
        reportModError('session.start', err)
      }
      return next(e)
    })
    registered.start = true
  } catch {
    registrationErrors.push('session.start')
  }

  try {
    on('classic.SessionStart', async ($, e, next) => {
      try {
        const first = !probes.classic
        probes = { ...probes, classic: true }
        void ensureHello($) // not awaited: this hook is not on the first prompt's path
        if (first && conn !== null) {
          await $.state.set(PROBES, probes).catch(() => undefined)
          snapshot($, 'probe')
        }
        if ((e.source === 'clear' || e.source === 'resume') && e.session_id !== sidBound) {
          await rebound($, e.session_id, e.source)
        }
      } catch (err) {
        reportModError('classic.SessionStart', err)
      }
      return next(e)
    })
    registered.classic = true
  } catch {
    registrationErrors.push('classic.SessionStart')
  }

  try {
    on('session.end', async ($, e, next) => {
      try {
        // `clear` and `resume` are followed by a classic.SessionStart: not a goodbye. No hello
        // here: the end hook has a short budget of its own.
        if (e.reason !== 'clear' && e.reason !== 'resume') await sayBye($, e.reason)
      } catch (err) {
        reportModError('session.end', err)
      }
      return next(e)
    })
    registered.end = true
  } catch {
    registrationErrors.push('session.end')
  }

  // sense.mods:begin (the CLI suite of P4W1 strips exactly this block to price the hook, AC-P4W1-16)
  // P4W1 part B, `sense.mods`: the only `plugin.register` registration the companion may have
  // (MOD-3, R25). A pure observer: it asks the rest of the chain first, reports a module only if
  // that allowed it, and always returns what `next(e)` returned. It does not wait for the hello:
  // a module is admitted at load, before `session.start`, so the admission is held until then.
  try {
    on('plugin.register', async ($, e, next) => {
      const result = await next(e)
      try {
        if (result.allow === true) noteAdmitted($, e)
      } catch {
        // observing is best effort: a failure here must not touch the verdict
      }
      return result
    })
    registered.mods = true
  } catch {
    registrationErrors.push('plugin.register')
  }
  // sense.mods:end

  declared = [
    ...(registered.start && registered.end && registered.classic ? ['sense.identity'] : []),
    ...(registered.mods ? ['sense.mods'] : [])
  ]
}

export { boundSid, enabled, emit, reportModError }
