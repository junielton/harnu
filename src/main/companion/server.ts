/**
 * The companion HTTP server (T389 P1W1 §7.3, contract §2): `startCompanionServer(opts)`.
 *
 * A dedicated HTTP/1.1 server on a Unix socket under the app's data directory (TCP loopback where
 * a socket cannot be used), announced through the rendezvous file. Every request is untrusted
 * input: the guard runs in the order of `mcp/http-guard.ts` (route, method, Host/Origin, bearer,
 * declared length, capped body, JSON), then the wire core validates, then the binding table decides.
 *
 * This file is the core of the host: it is exercised against real sockets in a temp directory,
 * with no Electron. Everything state-shaped that other waves extend arrives as a hook.
 */

import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  constantTimeEqual,
  hostnameOfAuthority,
  isAllowedOrigin,
  isLoopbackHostname
} from '../mcp/http-guard'
import {
  BODY_MAX_BYTES,
  DEFAULT_CONFIG,
  type AskRequest,
  type AskResponse,
  type BootId,
  type Command,
  type EndpointFile,
  type EndpointName,
  type ErrorCode,
  type PollRequest,
  type PollResponse,
  type WireEvent
} from './contract'
import {
  chooseTransport,
  probeSocket,
  readPreviousEndpoint,
  removeEndpoint,
  socketPathOf,
  writeEndpoint
} from './rendezvous'
import type { Binding, BindingView, EnablePolicy, SessionTable } from './session-table'
import {
  acceptEvents,
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
} from './wire-core'

export type PollHandler = (
  b: BindingView,
  req: PollRequest,
  reply: (r: PollResponse) => void
) => void
export type AskHandler = (b: BindingView, req: AskRequest, reply: (r: AskResponse) => void) => void

/** One answered request, for the diagnostics totals. Carries no secret and no body. */
export interface ServerStat {
  endpoint: EndpointName | null
  status: number
  ok: boolean
  code?: ErrorCode
}

/**
 * What the facade (`host.ts`) plugs into the server. The object is read at request time, so a
 * later `setPollHandler` takes effect without a restart. Every callback runs inside its own
 * `try/catch`: a consumer's failure never reaches the mod.
 */
export interface ServerHooks {
  enablePolicy?: () => EnablePolicy
  known?: () => ReadonlySet<string>
  /** Fills `commands` of the hello and events responses. */
  commandSource?: (b: BindingView, cursor?: number) => Command[]
  pollHandler?: PollHandler
  askHandler?: (kind: string) => AskHandler | undefined
  /** Synchronous, after the binding exists and before `commands` is read (R9: no awaited I/O). */
  beforeHello?: (b: BindingView, kind: 'spawn' | 'resume' | 'external') => void
  // The three below run after the HTTP response is written.
  onHello?: (b: BindingView, kind: 'spawn' | 'resume' | 'external') => void
  onEvent?: (b: BindingView, ev: WireEvent) => void
  onEnd?: (b: BindingView, reason: string) => void
  onStat?: (s: ServerStat) => void
}

export interface StartOptions {
  /** `<userData>/companion` */
  dir: string
  table: SessionTable
  hooks?: ServerHooks
  platform?: NodeJS.Platform
  /** Preferred endpoint token (a listener restart in one process keeps it). */
  tokenHint?: string
  /** Test seam: runs after the listener is bound and before the rendezvous file is written. */
  onBound?: () => Promise<void>
  log?: (message: string) => void
  now?: () => number
}

export interface CompanionServer {
  transport: 'unix' | 'tcp'
  bootId: BootId
  startedAt: number // epoch ms
  /** The rendezvous file as written. Holds the endpoint token: never log or expose it (SEC-8). */
  endpoint: EndpointFile
  stop(): Promise<void>
}

const PROBE_TIMEOUT_MS = 250
const KEEP_ALIVE_TIMEOUT_MS = 35_000 // OQ-3: harmless if the engine's fetch does not keep alive
const HEADERS_TIMEOUT_MS = 40_000
const DRAIN_LIMIT_BYTES = 4 * BODY_MAX_BYTES

type Body = Record<string, unknown>
interface Outcome {
  body: Body
  after?: () => void
}

const failure = (code: ErrorCode, message?: string, retryAfterMs?: number): Body => {
  const f: Body = { ok: false, code }
  if (message !== undefined) f.message = message
  if (retryAfterMs !== undefined) f.retryAfterMs = retryAfterMs
  return f
}

const SHUTTING_DOWN = failure('HOST_SHUTTING_DOWN')

function safe(fn: () => void): void {
  try {
    fn()
  } catch {
    // a consumer's failure is the consumer's problem
  }
}

interface InFlight {
  answer(body: Body): void
  done: Promise<void>
}

export async function startCompanionServer(opts: StartOptions): Promise<CompanionServer> {
  const { dir, table } = opts
  const hooks = opts.hooks ?? {}
  const platform = opts.platform ?? process.platform
  const now = opts.now ?? ((): number => performance.now())
  const log = opts.log ?? ((): void => undefined)

  // 1. Directory 0700 (created, or tightened when it already exists).
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  if (platform !== 'win32') await fs.chmod(dir, 0o700)

  // 2. A stable endpoint token, and the previous port as the TCP preference.
  const prev = await readPreviousEndpoint(dir)
  const token = opts.tokenHint ?? prev.token ?? randomUUID()
  // 3. A new boot id on every boot.
  const bootId: BootId = `b_${randomUUID()}`

  let accepting = false
  let usingUnix = false
  const inflight = new Set<InFlight>()
  const server = createServer((req, res) => handle(req, res))
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS
  server.headersTimeout = HEADERS_TIMEOUT_MS
  server.on('error', (err) =>
    log(`companion server error: ${(err as NodeJS.ErrnoException).code ?? err.name}`)
  )

  // 4./5. Listen: Unix when it can be used, TCP loopback otherwise.
  const socketPath = socketPathOf(dir)
  const choice = chooseTransport(socketPath, platform)
  if (choice.transport === 'unix') {
    const probe = await probeSocket(choice.socketPath, PROBE_TIMEOUT_MS)
    if (probe === 'live') {
      log('companion socket is owned by another live process; using tcp')
    } else {
      if (probe === 'stale') await fs.unlink(choice.socketPath).catch(() => undefined)
      try {
        await listenOn(server, choice.socketPath)
        await fs.chmod(choice.socketPath, 0o600)
        usingUnix = true
      } catch (err) {
        log(
          `companion unix listen failed (${(err as NodeJS.ErrnoException).code ?? 'error'}); using tcp`
        )
        if (server.listening) await closeServer(server)
      }
    }
  }
  let port: number | undefined
  if (!usingUnix) {
    try {
      port = await listenTcp(server, prev.port)
    } catch (err) {
      await closeServer(server)
      throw err
    }
  }

  const stopListening = async (): Promise<void> => {
    server.closeAllConnections()
    await closeServer(server)
    if (usingUnix) await fs.unlink(socketPath).catch(() => undefined)
  }

  // 6. The rendezvous file, complete before the first request is accepted.
  const startedAt = Date.now()
  const endpoint: EndpointFile = {
    v: 1,
    transport: usingUnix ? 'unix' : 'tcp',
    ...(usingUnix ? { socketPath } : { port }),
    token,
    bootId,
    protoMin: HOST_PROTO_MIN,
    protoMax: HOST_PROTO_MAX,
    writtenAt: startedAt
  }
  try {
    await opts.onBound?.()
    await writeEndpoint(dir, endpoint)
  } catch (err) {
    await stopListening()
    throw err
  }
  // 7. Flip accepting.
  accepting = true

  let stopping: Promise<void> | null = null
  const stop = (): Promise<void> => (stopping ??= doStop())
  async function doStop(): Promise<void> {
    accepting = false
    const waits = [...inflight].map((r) => {
      r.answer(SHUTTING_DOWN)
      return r.done
    })
    await removeEndpoint(dir, bootId)
    await Promise.race([Promise.all(waits), new Promise((r) => setTimeout(r, 1000))])
    await stopListening()
  }

  return { transport: endpoint.transport, bootId, startedAt, endpoint, stop }

  // ---- request handling -------------------------------------------------------------------

  function handle(req: IncomingMessage, res: ServerResponse): void {
    let answered = false
    let endpointName: EndpointName | null = null
    let markDone: () => void = () => undefined
    const done = new Promise<void>((r) => (markDone = r))
    res.once('close', () => markDone())
    const entry: InFlight = { answer: (body) => answer(200, body), done }
    inflight.add(entry)

    const answer = (status: number, body: Body = {}, after?: () => void): void => {
      if (answered) return
      answered = true
      inflight.delete(entry)
      const payload = JSON.stringify(body)
      res.writeHead(status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      })
      res.end(payload)
      safe(() =>
        hooks.onStat?.({
          endpoint: endpointName,
          status,
          ok: status === 200 && body.ok === true,
          ...(typeof body.code === 'string' ? { code: body.code as ErrorCode } : {})
        })
      )
      if (after) setImmediate(() => safe(after))
    }

    const refuse = (status: number): void => {
      answer(status)
      drain(req)
    }

    const route = parseRoute(req.method, req.url)
    if (typeof route === 'object') return refuse(route.status)
    endpointName = route

    // Host and Origin: the DNS-rebinding guard (TCP), or the fixed Host of the socket (Unix).
    const host = typeof req.headers.host === 'string' ? req.headers.host : undefined
    if (usingUnix) {
      if (host !== 'harnu') return refuse(403)
    } else {
      if (host === undefined || !isLoopbackHostname(hostnameOfAuthority(host))) return refuse(403)
      const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined
      if (origin !== undefined && !isAllowedOrigin(origin)) return refuse(403)
    }
    // The bearer: defence in depth only, never a capability (contract §3).
    if (!constantTimeEqual(bearerOf(req.headers.authorization), token)) return refuse(403)

    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > BODY_MAX_BYTES) return refuse(413)

    // A request that arrives between listen and the rendezvous write, or during stop.
    if (!accepting) {
      answer(200, SHUTTING_DOWN)
      drain(req)
      return
    }

    const chunks: Buffer[] = []
    let size = 0
    let over = false
    req.on('data', (c: Buffer) => {
      size += c.length
      if (over) {
        if (size > DRAIN_LIMIT_BYTES) req.destroy()
        return
      }
      if (size > BODY_MAX_BYTES) {
        over = true
        chunks.length = 0
        answer(413)
        return
      }
      chunks.push(c)
    })
    req.on('error', () => {
      answered = true
      inflight.delete(entry)
      markDone()
    })
    req.on('end', () => {
      if (over || answered) return
      let parsed: unknown
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        return answer(200, failure('BAD_ENVELOPE', 'body is not JSON'))
      }
      Promise.resolve()
        .then(() => dispatch(route, parsed))
        .then((out) => answer(200, out.body, out.after))
        .catch(() => answer(500))
    })
  }

  async function dispatch(route: EndpointName, body: unknown): Promise<Outcome> {
    switch (route) {
      case 'hello':
        return hello(body)
      case 'events':
        return events(body)
      case 'poll':
        return poll(body)
      case 'ask':
        return ask(body)
      case 'bye':
        return bye(body)
    }
  }

  /** `resolve → rate bucket → touch` (hello is exempt and never comes through here). */
  function authenticate(route: EndpointName, conn: string): { b: Binding } | { fail: Body } {
    const b = table.resolve(conn as never)
    if (b === 'STALE_CONN') return { fail: failure('STALE_CONN') }
    if (!isRateExempt(route)) {
      const taken = takeToken(b.rate, now())
      if ('retryAfterMs' in taken) {
        b.counters.refused++
        return { fail: failure('SLOW_DOWN', undefined, taken.retryAfterMs) }
      }
    }
    table.touch(b)
    return { b }
  }

  function hello(body: unknown): Outcome {
    const v = validateHello(body)
    if (!v.ok) return { body: failure(v.code, v.message) }
    const req = v.value
    if (negotiate(req.protoMin, req.protoMax) === null)
      return { body: failure('PROTO_UNSUPPORTED') }
    if (req.spawn !== undefined && req.resume !== undefined) {
      return { body: failure('BAD_ENVELOPE', 'spawn and resume are exclusive') }
    }
    // Neither: the external claim, off until P4W3 registers its handler (contract §5.1, §21).
    if (req.spawn === undefined && req.resume === undefined) {
      return { body: failure('FEATURE_DISABLED') }
    }
    const out = table.hello(req, hooks.enablePolicy?.() ?? (() => []))
    if (!out.ok) return { body: failure(out.code) }
    const b = out.binding
    safe(() => hooks.beforeHello?.(table.viewOf(b), out.kind))
    let commands: Command[] | undefined
    safe(() => {
      const c = hooks.commandSource?.(table.viewOf(b))
      if (c && c.length > 0) commands = c
    })
    return {
      body: {
        ok: true,
        proto: b.proto,
        conn: b.conn,
        bootId,
        sessionKey: table.viewOf(b).sessionKey,
        profile: b.profile,
        enable: [...b.enabled],
        config: { ...DEFAULT_CONFIG },
        ...(commands ? { commands } : {})
      },
      after: () => hooks.onHello?.(table.viewOf(b), out.kind)
    }
  }

  /** The sequence rule, the counters and the accepted events of one batch. */
  function ingest(
    b: Binding,
    batch: readonly WireEvent[],
    dropped: number | undefined
  ): { ackSeq: number; resync: boolean; accepted: WireEvent[] } {
    const r = acceptEvents(b.seq, batch, dropped, hooks.known?.() ?? new Set())
    b.seq = r.next
    b.counters.events += r.accepted.length
    b.counters.duplicates += r.duplicates
    b.counters.unknown += r.unknown
    b.counters.dropped += dropped ?? 0
    if (r.resync && !((dropped ?? 0) > 0)) b.counters.gaps++
    return { ackSeq: r.ackSeq, resync: r.resync, accepted: r.accepted }
  }

  function deliver(b: Binding, accepted: readonly WireEvent[]): void {
    for (const e of accepted) safe(() => hooks.onEvent?.(table.viewOf(b), e))
  }

  function events(body: unknown): Outcome {
    const v = validateEvents(body)
    if (!v.ok) return { body: failure(v.code, v.message) }
    const req = v.value
    const auth = authenticate('events', req.conn)
    if ('fail' in auth) return { body: auth.fail }
    const b = auth.b
    const r = ingest(b, req.events, req.dropped)
    // An envelope sid that is not the bound sid never re-keys: resync, wait for session.rebound.
    const resync = r.resync || req.sid !== b.sid
    let commands: Command[] | undefined
    safe(() => {
      const c = hooks.commandSource?.(table.viewOf(b), req.cursor)
      if (c && c.length > 0) commands = c
    })
    return {
      body: {
        ok: true,
        ackSeq: r.ackSeq,
        ...(resync ? { resync: true } : {}),
        ...(commands ? { commands } : {})
      },
      after: () => deliver(b, r.accepted)
    }
  }

  function bye(body: unknown): Outcome {
    const v = validateBye(body)
    if (!v.ok) return { body: failure(v.code, v.message) }
    const req = v.value
    const auth = authenticate('bye', req.conn)
    if ('fail' in auth) return { body: auth.fail }
    const b = auth.b
    const r = ingest(b, req.events ?? [], undefined)
    table.end(b, req.reason)
    return {
      body: { ok: true },
      after: () => {
        deliver(b, r.accepted)
        safe(() => hooks.onEnd?.(table.viewOf(b), req.reason))
      }
    }
  }

  async function poll(body: unknown): Promise<Outcome> {
    const v = validateEnvelope(body)
    if (!v.ok) return { body: failure(v.code, v.message) }
    const raw = body as Body
    const auth = authenticate('poll', v.value.conn)
    if ('fail' in auth) return { body: auth.fail }
    const b = auth.b
    const handler = hooks.pollHandler
    // A headless binding never polls (contract §16).
    if (!handler || b.profile === 'headless') return { body: failure('FEATURE_DISABLED') }
    if (typeof raw.bootId !== 'string' || typeof raw.cursor !== 'number' || raw.cursor < 0) {
      return { body: failure('BAD_ENVELOPE', 'poll needs bootId and cursor') }
    }
    const req = { ...v.value, bootId: raw.bootId, cursor: raw.cursor } as PollRequest
    return new Promise<Outcome>((resolve) => {
      try {
        handler(table.viewOf(b), req, (r) => resolve({ body: r as unknown as Body }))
      } catch {
        resolve({ body: failure('FEATURE_DISABLED') })
      }
    })
  }

  async function ask(body: unknown): Promise<Outcome> {
    const v = validateEnvelope(body)
    if (!v.ok) return { body: failure(v.code, v.message) }
    const raw = body as Body
    if (typeof raw.askId !== 'string' || raw.askId.length < 1 || raw.askId.length > 128) {
      return { body: failure('BAD_ENVELOPE', 'askId must be a short string') }
    }
    if (typeof raw.kind !== 'string' || raw.kind.length < 1 || raw.kind.length > 32) {
      return { body: failure('BAD_ENVELOPE', 'kind must be a short string') }
    }
    const auth = authenticate('ask', v.value.conn)
    if ('fail' in auth) return { body: auth.fail }
    const b = auth.b
    const handler = b.profile === 'headless' ? undefined : hooks.askHandler?.(raw.kind)
    if (!handler) return { body: failure('FEATURE_DISABLED') }
    const req = { ...v.value, askId: raw.askId, kind: raw.kind, d: raw.d } as unknown as AskRequest
    return new Promise<Outcome>((resolve) => {
      try {
        handler(table.viewOf(b), req, (r) => resolve({ body: r as unknown as Body }))
      } catch {
        resolve({ body: failure('FEATURE_DISABLED') })
      }
    })
  }
}

// ---- helpers --------------------------------------------------------------------------------

function bearerOf(authorization: string | undefined): string {
  if (!authorization) return ''
  const m = /^Bearer\s+(.+)$/i.exec(authorization.trim())
  return m ? m[1] : ''
}

/** Discard the rest of a refused request's body without buffering it, up to a bound. */
function drain(req: IncomingMessage): void {
  let n = 0
  req.on('data', (c: Buffer) => {
    n += c.length
    if (n > DRAIN_LIMIT_BYTES) req.destroy()
  })
  req.resume()
}

function listenOn(server: Server, target: string | number, host?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      server.off('listening', onListening)
      reject(err)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    if (typeof target === 'number') server.listen(target, host)
    else server.listen(target)
  })
}

/** The stored port first, any free one when it cannot be bound (`mcp/server.ts` `listenOnce` shape). */
async function listenTcp(server: Server, preferred: number | null): Promise<number> {
  if (preferred !== null) {
    try {
      await listenOn(server, preferred, '127.0.0.1')
      return (server.address() as AddressInfo).port
    } catch {
      // occupied: a changed port orphans nobody, the mod re-reads the rendezvous file
    }
  }
  await listenOn(server, 0, '127.0.0.1')
  return (server.address() as AddressInfo).port
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) return resolve()
    server.close(() => resolve())
  })
}
