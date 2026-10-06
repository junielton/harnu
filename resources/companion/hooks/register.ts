import type { EngineInterface, Register } from 'claude-code'
import {
  BACKOFF_MAX_MS,
  BACKOFF_MIN_MS,
  BYE_BUDGET_MS,
  DEFAULT_CONFIG,
  FETCH_HARD_CAP_MS,
  HEARTBEAT_MS,
  HELLO_WAIT_MS,
  DRIFT_CHECK_MIN_MS,
  PROTOCOL_VERSION,
  RING_MAX,
  type ByeRequest,
  type CmdId,
  type Command,
  type CommandResultData,
  type Config,
  type Conn,
  type EndpointName,
  type EventName,
  type EventPayloads,
  type EventsRequest,
  type ErrorCode,
  type FeatureId,
  type HelloRequest,
  type Sid
} from './contract'
import { MOD_VERSION, RENDEZVOUS_PATH } from './coords.gen'
import {
  neutralFleet,
  originOf,
  sanitizeFleet,
  snapshotFields,
  step as fleetStep,
  type FleetSensorState,
  type SensorInput
} from './lib/fleet-sensor'
import {
  classifyCommand,
  compactData,
  forBoot,
  isHardCapAbort,
  mapEngineRejection,
  markResulted,
  markStarted,
  parseChannel,
  parseCommands,
  parseConfigUpdate,
  IMPLEMENTED_COMMANDS,
  UI_TEXT_MAX,
  withCursor,
  type ChannelState
} from './lib/command-core'
import { createRing } from './lib/ring'
import { measurePayload, readPayload } from './lib/usage-sensor'
import { endpointUrl, parseEndpoint, type Endpoint } from './lib/rendezvous-parse'

/**
 * The Harnu companion mod: the handshake and the identity facts (spec P1W3) and the fleet
 * sensors (spec P1W5: turns, attention, subagents; the cores are in `lib/fleet-sensor.ts`).
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
const FLEET = { plugin: 'harnu-companion', key: 'fleet' } as const
const PERMISSION_MODE = { plugin: 'harnu-companion', key: 'permissionMode' } as const
const CHANNEL = { plugin: 'harnu-companion', key: 'channel' } as const

/** The feature an event type belongs to. `null`: reportable whenever the channel is alive. */
const EVENT_FEATURE: Partial<Record<EventName, FeatureId | null>> = {
  'session.snapshot': 'sense.identity',
  'session.rebound': 'sense.identity',
  'session.end': 'sense.identity',
  'turn.started': 'sense.turn',
  'turn.completed': 'sense.turn',
  'attention.raised': 'sense.attention',
  'attention.cleared': 'sense.attention',
  'subagent.started': 'sense.subagent',
  'subagent.stopped': 'sense.subagent',
  'usage.measured': 'sense.usage',
  'mod.error': null,
  // The answer to a command is owed whatever the command's own feature says (also FEATURE_DISABLED).
  'command.result': null
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
let pumpKick = false
let registrationErrors: string[] = []
let ring = createRing(RING_MAX)
let fleet: FleetSensorState = neutralFleet()
let fleetLoaded = false
let lastMode: string | null = null
/** P2W1: the poll loop's generation; a re-hello starts a new loop and retires the old one. */
let loopGen = 0
/** True when this process was spawned by Harnu with a token (the tokenless second lock). */
let tokenBacked = false
/** The in-memory twin of `$.state.channel`; null until first read. */
let channel: ChannelState | null = null
let stateChain: Promise<unknown> = Promise.resolve()
/** Command ids a running call of THIS load will answer. */
const inFlight = new Set<string>()

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
  pumpKick = false
  registrationErrors = []
  ring = createRing(RING_MAX)
  fleet = neutralFleet()
  fleetLoaded = false
  lastMode = null
  loopGen = 0
  tokenBacked = false
  channel = null
  stateChain = Promise.resolve()
  inFlight.clear()
  pollStale = 0
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
  | { kind: 'answer'; body: Record<string, unknown> }
  | { kind: 'transport'; aborted?: boolean }
  | { kind: 'rebooted' }

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
  } catch (err) {
    // The engine's 30 s fetch cap on a held poll is a normal reconnect: the coordinates are fine.
    if (isHardCapAbort(err)) return { kind: 'transport', aborted: true }
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
      ...snapshotFields(fleet),
      probes: { classic: probes.classic, toolCheck: probes.toolCheck }
    }
  })
  // A state re-send after a hello, a resync or a flush (`sense.usage`, P1W6 §7.1). Un-awaited.
  if (reason !== 'probe') void readUsage($)
}

/**
 * `$.session.usage()` and `$.session.model()` as one `usage.measured {source: 'read'}`. Never on a
 * turn's path (MOD-6): callers do not await it. A rejected call is a `mod.error`, not a retry.
 */
async function readUsage($: Dollar): Promise<void> {
  if (!enabled('sense.usage')) return
  try {
    const [usage, model] = await Promise.all([$.session.usage(), $.session.model()])
    emit($, { t: 'usage.measured', d: readPayload(usage, model) })
  } catch (err) {
    reportModError('session.usage', err)
  }
}

// ---- fleet sensors (P1W5) ---------------------------------------------------------------------

const noop = (): void => undefined

/** Once per load: what a reload left in `$.state`, made safe. In-memory changes always win. */
async function loadFleet($: Dollar): Promise<void> {
  if (fleetLoaded) return
  fleetLoaded = true
  try {
    const saved = await $.state.get(FLEET)
    fleet = sanitizeFleet(saved.value)
  } catch {
    // an unreadable key reads as the neutral state
  }
}

function persistFleet($: Dollar): void {
  void Promise.resolve($.state.set(FLEET, fleet)).catch(noop)
}

/** True while at least one of the three sensor features is enabled. */
function senseOn(): boolean {
  return enabled('sense.turn') || enabled('sense.attention') || enabled('sense.subagent')
}

/** Runs one step of the core and emits what it returns. A throw is the caller's to catch (MOD-2). */
function feed($: Dollar, input: SensorInput): void {
  if (!senseOn()) return
  const before = JSON.stringify(fleet)
  const out = fleetStep(fleet, input)
  fleet = out.state
  if (JSON.stringify(fleet) !== before) persistFleet($)
  for (const ev of out.events) emit($, ev as never)
}

/** The first step of every `classic.*` body: the probe, and the last `permission_mode` (§11.4). */
function noteClassic($: Dollar, e: { permission_mode?: string }): void {
  if (!probes.classic) {
    probes = { ...probes, classic: true }
    void Promise.resolve($.state.set(PROBES, probes)).catch(noop)
    if (conn !== null) snapshot($, 'probe')
  }
  const mode = e.permission_mode
  if (typeof mode === 'string' && mode !== '' && mode !== lastMode) {
    lastMode = mode
    void Promise.resolve($.state.set(PERMISSION_MODE, mode)).catch(noop)
  }
}

/** `tool.check` was dispatched for a real call (one with an id), whatever its verdict. */
function noteToolCheck($: Dollar): void {
  if (probes.toolCheck) return
  probes = { ...probes, toolCheck: true }
  void Promise.resolve($.state.set(PROBES, probes)).catch(noop)
  if (conn !== null) snapshot($, 'probe')
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
    await loadFleet($) // a reload re-sends a correct snapshot (MOD-4)
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
      const spawned = await $.env.get('HARNU_SPAWN_TOKEN')
      tokenBacked = typeof spawned === 'string' && spawned !== ''
    } else {
      const token = await $.env.get('HARNU_SPAWN_TOKEN')
      if (typeof token !== 'string' || token === '') {
        goDormant() // not spawned by Harnu (the external profile is P4W3)
        return
      }
      sid = await $.session.id()
      request.spawn = token as `sp_${string}`
      tokenBacked = true
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
      return
    }
    for (const where of registrationErrors.splice(0)) {
      emit($, {
        t: 'mod.error',
        d: { where, kind: 'registration', message: 'hook registration failed' }
      })
    }
    snapshot($, 'hello')
    startHeartbeatOnce($)
    pump($)
    // P2W1: the cursor belongs to this boot; the loop starts (or restarts) under a new generation.
    channel = forBoot(await ensureChannel($), bootId)
    void writeChannel($)
    restartPollLoop($)
    await acceptCommands($, parseCommands(b.commands))
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
  if (conn === null || dormant || inert) return
  if (pumpFlight !== null) {
    // an event pushed while the loop is on its way out would wait for the heartbeat: ask for one
    // more pass once the flight is over (found by the Esc trace of P1W5: `turn.completed` is the
    // event the sidebar waits for)
    pumpKick = true
    return
  }
  if (ring.size() === 0 && !beat) return
  if (retryBlocked) return
  pumpFlight = pumpLoop($, beat)
    .catch(() => scheduleRetry($))
    .finally(() => {
      pumpFlight = null
      if (pumpKick) {
        pumpKick = false
        pump($)
      }
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
      ...(dropped > 0 ? { dropped } : {}),
      // A profile that does not poll receives its commands on this response (contract §5.2).
      ...(boot?.isInteractive === false && bootId !== null
        ? { bootId: bootId as EventsRequest['bootId'], cursor: (await ensureChannel($)).cursor }
        : {})
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
      await acceptCommands($, parseCommands(body.commands))
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
  loopGen++ // the poll loop ends with the session
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

/** A sensor body: never throws, never awaited beyond the first hello (and the first state read). */
async function sense($: Dollar, where: string, run: () => void): Promise<void> {
  try {
    await ensureHello($)
    await loadFleet($)
    run()
  } catch (err) {
    reportModError(where, err)
  }
}

/** `classic.*` bodies start with the probe and the permission mode, then sense (§11.4). */
async function classic(
  $: Dollar,
  where: string,
  e: { permission_mode?: string },
  run: () => void
): Promise<void> {
  try {
    noteClassic($, e)
  } catch (err) {
    reportModError(where, err)
  }
  await sense($, where, run)
}

/** `classic.PostToolUse` and the optional `classic.PostToolUseFailure`: a tool settled. */
function settled(
  $: Dollar,
  failed: boolean,
  e: { permission_mode?: string; tool_use_id: string; tool_name: string; agent_id?: string }
): Promise<void> {
  return classic($, failed ? 'classic.PostToolUseFailure' : 'classic.PostToolUse', e, () =>
    feed($, {
      k: 'post-tool',
      toolUseId: e.tool_use_id,
      tool: e.tool_name,
      failed,
      ...(e.agent_id !== undefined ? { agentId: e.agent_id } : {})
    })
  )
}

// ---- command channel (P2W1) ---------------------------------------------------------------------

/** What a command handler answers; the executor wraps it in the one `command.result`. */
type HandlerResult =
  { ok: true; data?: unknown } | { ok: false; code: ErrorCode; message?: string; data?: unknown }
/** What a command handler returns (the executor wraps it in the one `command.result`). */
type Handled = HandlerResult | Promise<HandlerResult>

/** A poll answered faster than this with nothing is not a hold: wait before asking again. */
const IMMEDIATE_MS = 200
let pollStale = 0 // consecutive STALE_CONN answers across loops: a host that keeps refusing

const okResult = (data?: unknown): HandlerResult =>
  data === undefined ? { ok: true } : { ok: true, data }
const precondition = (message: string): HandlerResult => ({
  ok: false,
  code: 'CMD_PRECONDITION',
  message
})

async function ensureChannel($: Dollar): Promise<ChannelState> {
  if (channel !== null) return channel
  const saved = await $.state.get(CHANNEL)
  if (channel !== null) return channel // another caller read it while this one waited
  channel = parseChannel(saved.value)
  return channel
}

/** Writes the mirror to `$.state`, in order; a failed write only costs a reload its dedupe. */
function writeChannel($: Dollar): Promise<unknown> {
  if (channel === null || channel.bootId === null) return Promise.resolve()
  const snap = {
    ...channel,
    bootId: channel.bootId,
    started: [...channel.started],
    resulted: [...channel.resulted]
  }
  stateChain = stateChain.then(() => $.state.set(CHANNEL, snap)).catch(() => undefined)
  return stateChain
}

/**
 * The cursor is written BEFORE a command starts (delivery), the `started` id before its `$` call
 * (execution), and the loop never awaits a command (MOD-6, contract §6).
 */
async function acceptCommands($: Dollar, commands: Command[]): Promise<void> {
  for (const c of commands) {
    channel = withCursor(await ensureChannel($), c.n)
    await writeChannel($)
    void runCommand($, c)
  }
}

function sendResult($: Dollar, c: Command, r: HandlerResult): void {
  channel = markResulted(channel ?? parseChannel(null), c.cmd)
  emit($, {
    t: 'command.result',
    d: {
      cmd: c.cmd,
      ok: r.ok,
      ...(r.ok ? {} : { code: r.code }),
      ...(r.ok ? {} : r.message !== undefined ? { message: r.message } : {}),
      ...(r.data !== undefined
        ? { data: r.data as CommandResultData[keyof CommandResultData] }
        : {})
    }
  })
  void writeChannel($)
}

/** Exactly one `command.result` per `cmd` (spec §7.7 executor table). Never rejects. */
async function runCommand($: Dollar, c: Command): Promise<void> {
  try {
    const state = await ensureChannel($)
    const d = classifyCommand(c, {
      state,
      inFlight,
      now: await $.clock.now(),
      tokenBacked,
      featureEnabled: enabled,
      known: (name) => IMPLEMENTED_COMMANDS.has(name)
    })
    if (d.kind === 'skip') return
    if (d.kind === 'answer') {
      sendResult($, c, {
        ok: false,
        code: d.code,
        ...(d.message !== undefined ? { message: d.message } : {}),
        ...(d.data !== undefined ? { data: d.data } : {})
      })
      return
    }
    // Everything from here to the `$` call is synchronous: two deliveries of one `cmd` cannot both pass.
    channel = markStarted(state, c.cmd)
    inFlight.add(c.cmd)
    await writeChannel($)
    let out: HandlerResult
    try {
      out = await runHandler($, c)
    } catch (err) {
      out = { ok: false, ...mapEngineRejection(err) }
    }
    inFlight.delete(c.cmd)
    sendResult($, c, out)
  } catch (err) {
    inFlight.delete(c.cmd)
    reportModError('command', err, c.cmd)
  }
}

function runFlush($: Dollar): Handled {
  snapshot($, 'flush')
  return okResult()
}

function runConfigUpdate($: Dollar, c: Command<'config.update'>): Handled {
  const next = parseConfigUpdate(c.args)
  if (next === null) return precondition('a config value is outside its bounds')
  const beat = config.heartbeatMs
  config = { ...config, ...next }
  if (next.heartbeatMs !== undefined && next.heartbeatMs !== beat) {
    heartbeat?.cancel()
    heartbeat = null
    startHeartbeatOnce($)
  }
  return okResult()
}

async function runTurnAbort($: Dollar, c: Command<'turn.abort'>): Promise<HandlerResult> {
  const own = typeof c.args.turnId === 'string' && c.args.turnId !== '' ? c.args.turnId : null
  const turnId = own ?? channel?.turnId ?? null
  if (turnId === null) return precondition('no turn id is known')
  await $.turn.abort({ turnId }) // an engine rejection is mapped by the executor
  return okResult()
}

async function runCompact($: Dollar): Promise<HandlerResult> {
  const r = await $.session.compact()
  return okResult(compactData(r))
}

function runToast($: Dollar, c: Command<'ui.toast'>): Handled {
  const text = c.args.text
  if (typeof text !== 'string' || text === '' || text.length > UI_TEXT_MAX) {
    return precondition('toast text must be 1 to 200 characters')
  }
  $.ui.toast(text)
  return okResult()
}

function runStatus($: Dollar, c: Command<'ui.status'>): Handled {
  const text = c.args.text
  if (text !== null && (typeof text !== 'string' || text.length > UI_TEXT_MAX)) {
    return precondition('status text must be at most 200 characters, or null')
  }
  $.ui.status(text === null ? undefined : text)
  return okResult()
}

/**
 * The closed switch (SEC-5, contract §9): the only place a command name becomes a `$` call. The
 * engine refuses a `$` passed through a dynamic callee, so a later wave adds its `case` here, and
 * its name to `IMPLEMENTED_COMMANDS`, instead of registering a function.
 */
function runHandler($: Dollar, c: Command): Handled {
  switch (c.name) {
    case 'flush':
      return runFlush($)
    case 'config.update':
      return runConfigUpdate($, c as Command<'config.update'>)
    case 'turn.abort':
      return runTurnAbort($, c as Command<'turn.abort'>)
    case 'session.compact':
      return runCompact($)
    case 'ui.toast':
      return runToast($, c as Command<'ui.toast'>)
    case 'ui.status':
      return runStatus($, c as Command<'ui.status'>)
    default:
      return { ok: false, code: 'CMD_UNSUPPORTED' }
  }
}

// ---- the poll loop ------------------------------------------------------------------------------

function pollEligible(): boolean {
  return (
    !dormant &&
    !inert &&
    conn !== null &&
    boot?.isInteractive === true &&
    enabledSet.includes('act.channel')
  )
}

/**
 * Starts a poll loop under a new generation and retires the old one: a hello (the first, or a
 * re-hello) is the only caller, so there is one loop per load, never awaited by a hook.
 */
function restartPollLoop($: Dollar): void {
  const gen = ++loopGen
  if (pollEligible()) void pollLoop($, gen)
}

async function pollLoop($: Dollar, gen: number): Promise<void> {
  let backoff = BACKOFF_MIN_MS
  try {
    while (gen === loopGen && pollEligible()) {
      const sid = sidBound
      const boot0 = bootId
      if (sid === null || conn === null || boot0 === null) return
      channel = forBoot(await ensureChannel($), boot0)
      const cursor = channel.cursor
      const t0 = await $.clock.now()
      const r = await post(
        $,
        'poll',
        { v: proto, sid, conn, sentAt: Date.now(), bootId: boot0, cursor },
        false
      )
      if (gen !== loopGen) return
      if (r.kind === 'transport') {
        // The engine's 30 s cap on a held request is a reconnect: ask again at once. The message is
        // the engine's, so the time it took counts too. Any other failure backs off.
        if (r.aborted || (await $.clock.now()) - t0 >= FETCH_HARD_CAP_MS - 500) continue
        await $.clock.sleep(backoff)
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
        continue
      }
      if (r.kind === 'rebooted') {
        if (++pollStale > 2) await $.clock.sleep(backoff)
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
        await rehello($)
        continue
      }
      const body = r.body
      if (body.ok === true) {
        backoff = BACKOFF_MIN_MS
        pollStale = 0
        const commands = parseCommands(body.commands)
        if (body.resync === true) {
          channel = { ...(await ensureChannel($)), bootId: boot0, cursor: 0 }
          void writeChannel($)
          snapshot($, 'resync')
          // A resync from a host that restarted under a live `conn` is the only way this mod learns
          // the new boot: the next request re-reads the rendezvous file and, seeing another
          // `bootId`, says hello again. For any other resync the re-read changes nothing.
          endpoint = null
        }
        await acceptCommands($, commands)
        // A host that answers at once with nothing (a resync, a supersede) is not holding: do not spin.
        if (commands.length === 0 && (await $.clock.now()) - t0 < IMMEDIATE_MS) {
          await $.clock.sleep(body.resync === true ? 500 : 250)
        }
        continue
      }
      const code = typeof body.code === 'string' ? body.code : ''
      if (code === 'FEATURE_DISABLED') return // the loop ends until the next hello
      if (code === 'STALE_CONN') {
        if (++pollStale > 2) {
          await $.clock.sleep(backoff)
          backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
        }
        await rehello($)
        continue
      }
      if (DORMANT_CODES.has(code)) return goDormant()
      const wait =
        code === 'SLOW_DOWN' && typeof body.retryAfterMs === 'number' ? body.retryAfterMs : backoff
      await $.clock.sleep(Math.min(Math.max(wait, 0), 60_000))
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
    }
  } catch (err) {
    reportModError('poll', err) // a failure ends this loop; the next hello starts another
  }
}

// ---- the module -------------------------------------------------------------------------------

export const register: Register = (on) => {
  resetState()
  const registered: Record<string, boolean> = {}
  /** One registration: a failure is reported later as `mod.error` and drops its features (§11.2). */
  const hook = (name: string, add: () => void): void => {
    try {
      add()
      registered[name] = true
    } catch {
      registrationErrors.push(name)
    }
  }

  hook('session.start', () => {
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
  })

  hook('classic.SessionStart', () => {
    on('classic.SessionStart', async ($, e, next) => {
      try {
        noteClassic($, e) // first: the drift check of ensureHello must see `probes.classic` (C10)
        void ensureHello($) // not awaited: this hook is not on the first prompt's path
        if ((e.source === 'clear' || e.source === 'resume') && e.session_id !== sidBound) {
          await rebound($, e.session_id, e.source)
          // a new conversation has no turn, no open item and no record (contract §22)
          fleet = neutralFleet()
          persistFleet($)
        }
      } catch (err) {
        reportModError('classic.SessionStart', err)
      }
      return next(e)
    })
  })

  hook('session.end', () => {
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
  })

  // ---- the shared fleet registrations (contract §11.4). Each body: ensureHello, the sensor
  // step, then `next(e)` unchanged. The steps other waves add (P2W1 `channel.turnId`, P2W2 own
  // submits, P3W1 the hold, P3W2 the sentinel) go at the marked places, never in a second `on()`.

  hook('prompt.submit', () => {
    on('prompt.submit', async ($, e, next) => {
      await sense($, 'prompt.submit', () => {
        // (1) sense.turn: remember the origin; (2) sense.attention: clear what is open
        feed($, { k: 'prompt', originKind: e.origin?.kind })
        // (3) P2W2 / P2W3: pop the mod's own queue of submits (insertion point)
      })
      return next(e)
    })
  })

  hook('turn.start', () => {
    on('turn.start', async ($, e, next) => {
      try {
        await ensureHello($)
        // (1) act.turn (P2W1): the id of the running turn, for `turn.abort`. Nothing clears it: a
        // stale id is answered by the engine's own rejection, the source of truth for "no turn".
        if (enabled('act.turn')) {
          channel = { ...(await ensureChannel($)), turnId: e.turnId }
          void writeChannel($)
        }
      } catch (err) {
        reportModError('turn.start', err)
      }
      await sense($, 'turn.start', () => feed($, { k: 'turn.start', turnId: e.turnId }))
      return next(e)
    })
  })

  hook('turn.complete', () => {
    on('turn.complete', async ($, e, next) => {
      await sense($, 'turn.complete', () => {
        // (1) sense.attention clears what is open and (3) sense.turn completes, in the core;
        // (2) P3W1: `ask.settled {turn-ended}` goes between them (insertion point)
        feed($, {
          k: 'turn.complete',
          turnId: e.turnId,
          reason: e.reason,
          isAborted: e.isAborted,
          durationMs: e.durationMs,
          usage: e.usage,
          ...(e.agentId !== undefined ? { agentId: e.agentId } : {})
        })
      })
      return next(e)
    })
  })

  hook('tool.check', () => {
    on('tool.check', async ($, e, next) => {
      try {
        await ensureHello($)
      } catch (err) {
        reportModError('tool.check', err)
      }
      const r = await next(e) // (1) the verdict is the engine's; this wave never alters it
      try {
        if (e.tool_use_id !== undefined) noteToolCheck($)
        // (2) P3W2: the sentinel ask for a watched tool (insertion point)
        await loadFleet($)
        feed($, {
          k: 'tool.check',
          tool: e.tool,
          decision: r.decision,
          at: Date.now(),
          ...(e.tool_use_id !== undefined ? { toolUseId: e.tool_use_id } : {}),
          ...(e.agentId !== undefined ? { agentId: e.agentId } : {}),
          ...(typeof r.hook === 'string' ? { hook: r.hook } : {})
        })
      } catch (err) {
        reportModError('tool.check', err)
      }
      return r
    })
  })

  hook('classic.PermissionRequest', () => {
    on('classic.PermissionRequest', async ($, e, next) => {
      await classic($, 'classic.PermissionRequest', e, () =>
        feed($, {
          k: 'permission.request',
          tool: e.tool_name,
          ...(e.agent_id !== undefined ? { agentId: e.agent_id } : {})
        })
      )
      // (2) P3W1: the hold of contract §10.1 returns the decision here (insertion point)
      return next(e)
    })
  })

  hook('classic.Notification', () => {
    on('classic.Notification', async ($, e, next) => {
      await classic($, 'classic.Notification', e, () =>
        feed($, { k: 'notification', type: e.notification_type })
      )
      return next(e)
    })
  })

  hook('classic.PostToolUse', () => {
    on('classic.PostToolUse', async ($, e, next) => {
      await settled($, false, e)
      // (2) P3W1: `ask.settled {tool-ran}` and `attention.cleared {ask-resolved}` (insertion point)
      return next(e)
    })
  })

  hook('classic.Stop', () => {
    on('classic.Stop', async ($, e, next) => {
      await classic($, 'classic.Stop', e, () => feed($, { k: 'stop', tasks: e.background_tasks }))
      return next(e)
    })
  })

  hook('classic.SubagentStart', () => {
    on('classic.SubagentStart', async ($, e, next) => {
      await classic($, 'classic.SubagentStart', e, () =>
        feed($, { k: 'subagent.start', agentType: e.agent_type, agentId: e.agent_id })
      )
      return next(e)
    })
  })

  hook('classic.SubagentStop', () => {
    on('classic.SubagentStop', async ($, e, next) => {
      await classic($, 'classic.SubagentStop', e, () =>
        feed($, { k: 'subagent.stop', agentType: e.agent_type, agentId: e.agent_id })
      )
      return next(e)
    })
  })

  // Optional hooks (contract §11.1): a failed registration is reported and removes no feature.
  hook('classic.PostToolUseFailure', () => {
    on('classic.PostToolUseFailure', async ($, e, next) => {
      await settled($, true, e) // never relied on: it was never observed firing (C3)
      return next(e)
    })
  })

  hook('classic.StopFailure', () => {
    on('classic.StopFailure', async ($, e, next) => {
      await classic($, 'classic.StopFailure', e, () =>
        feed($, { k: 'stop-failure', error: String(e.error) })
      )
      return next(e)
    })
  })

  hook('session.measure', () => {
    on('session.measure', async ($, e, next) => {
      try {
        void ensureHello($) // not awaited: a measure is never on the first prompt's path
        emit($, { t: 'usage.measured', d: measurePayload(e) })
      } catch (err) {
        reportModError('session.measure', err)
      }
      return next(e)
    })
  })

  const all = (...names: string[]): boolean => names.every((n) => registered[n] === true)
  const features: FeatureId[] = []
  if (all('session.start', 'session.end', 'classic.SessionStart')) {
    // `act.channel`, `act.compact` and `act.ui` need no hook of their own: the poll loop and `$`.
    features.push('sense.identity', 'act.channel', 'act.compact', 'act.ui')
    if (all('turn.start')) features.push('act.turn')
  }
  if (all('prompt.submit', 'turn.start', 'turn.complete')) features.push('sense.turn')
  if (
    all(
      'tool.check',
      'classic.PermissionRequest',
      'classic.Notification',
      'classic.PostToolUse',
      'classic.Stop'
    )
  ) {
    features.push('sense.attention')
  }
  if (all('classic.SubagentStart', 'classic.SubagentStop')) features.push('sense.subagent')
  if (all('session.measure')) features.push('sense.usage')
  declared = features
}

export { boundSid, enabled, emit, reportModError, originOf }
