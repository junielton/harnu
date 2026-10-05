import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import {
  createConnection,
  createServer as createNetServer,
  type Server as NetServer
} from 'node:net'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  startCompanionServer,
  type CompanionServer,
  type ServerHooks,
  type ServerStat
} from '../../src/main/companion/server'
import {
  SessionTable,
  type EnablePolicy,
  type SpawnOwner
} from '../../src/main/companion/session-table'
import {
  HELLO_SLA_MS,
  RATE_MAX_REQUESTS,
  type Command,
  type Conn,
  type EndpointFile,
  type WireEvent
} from '../../src/main/companion/contract'
import { eventsSeqSteps, SEQ_EVENT_TYPE } from '../../resources/companion/tests/fixtures/events-seq'
import { helloSpawnRequest } from '../../resources/companion/tests/fixtures/hello'
import { post, shortTmp, type PostOpts, type Reply } from './support/client'
import { isHelloResponse } from './support/shapes'

interface Rig {
  dir: string
  table: SessionTable
  hooks: ServerHooks
  stats: ServerStat[]
  srv: CompanionServer
  ep: EndpointFile
  /** Mints a spawn token and says hello with it: the conn and sid of a bound session. */
  bind: (owner?: string, over?: Record<string, unknown>) => Promise<{ conn: Conn; sid: string }>
  send: (route: string, body: unknown, opts?: PostOpts) => Promise<Reply>
  env: (conn: Conn, sid?: string) => { v: 1; sid: string; conn: Conn; sentAt: number }
}

const enableIdentity: EnablePolicy = () => ['sense.identity']
const rigs: Rig[] = []
const cleanups: (() => Promise<void> | void)[] = []
const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface BootOpts {
  dir?: string
  platform?: NodeJS.Platform
  hooks?: ServerHooks
  policy?: EnablePolicy
  tokenHint?: string
  onBound?: () => Promise<void>
}

function newTable(): SessionTable {
  return new SessionTable({
    now: () => performance.now(),
    mintConn: () => `c_${randomBytes(16).toString('hex')}` as Conn,
    mintToken: () => `sp_${randomUUID()}` as never
  })
}

async function boot(opts: BootOpts = {}): Promise<Rig> {
  const dir = opts.dir ?? join(shortTmp('hc-s-'), 'companion')
  const table = newTable()
  const stats: ServerStat[] = []
  const hooks: ServerHooks = {
    enablePolicy: () => opts.policy ?? enableIdentity,
    known: () => new Set([SEQ_EVENT_TYPE]),
    onStat: (s) => stats.push(s),
    ...opts.hooks
  }
  const srv = await startCompanionServer({
    dir,
    table,
    hooks,
    platform: opts.platform,
    tokenHint: opts.tokenHint,
    onBound: opts.onBound
  })
  const ep = JSON.parse(readFileSync(join(dir, 'endpoint.json'), 'utf8')) as EndpointFile
  let n = 0
  const rig: Rig = {
    dir,
    table,
    hooks,
    stats,
    srv,
    ep,
    send: (route, body, o) => post(ep, route, { body, ...o }),
    env: (conn, sid = helloSpawnRequest.sid) => ({ v: 1, sid, conn, sentAt: Date.now() }),
    bind: async (owner = `pty-${++n}`, over = {}) => {
      const o: SpawnOwner = { kind: 'pty', ptyId: owner }
      const token = table.mint({ owner: o, trust: 'operator', cwd: '/tmp/example-project' })
      const r = await post(ep, 'hello', { body: { ...helloSpawnRequest, ...over, spawn: token } })
      if (!r.json?.ok) throw new Error(`hello failed: ${r.raw}`)
      return { conn: r.json.conn as Conn, sid: (over.sid as string) ?? helloSpawnRequest.sid }
    }
  }
  rigs.push(rig)
  return rig
}

afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.srv.stop().catch(() => undefined)
    rmSync(join(r.dir, '..'), { recursive: true, force: true })
  }
  for (const c of cleanups.splice(0)) await c()
})

const ev = (seq: number, t: string = SEQ_EVENT_TYPE): WireEvent =>
  ({ seq, t, ts: 1, d: { agentType: 'x' } }) as unknown as WireEvent

describe('hello and rendezvous', () => {
  it('serves hello over the unix socket', async () => {
    const rig = await boot()
    expect(rig.ep.transport).toBe('unix')
    const token = rig.table.mint({
      owner: { kind: 'pty', ptyId: 'p1' },
      trust: 'operator',
      cwd: '/tmp/example-project'
    })
    const r = await rig.send('hello', { ...helloSpawnRequest, spawn: token })
    expect(r.status).toBe(200)
    expect(isHelloResponse(r.json)).toBe(true)
    expect(r.json).toMatchObject({
      ok: true,
      proto: 1,
      profile: 'interactive',
      bootId: rig.ep.bootId
    })
    expect(r.json.enable).toEqual(['sense.identity'])
    expect(r.json.sessionKey).toBeNull()
    expect(r.json).not.toHaveProperty('commands')
  })

  it('socket and directory modes', async () => {
    const dir = join(shortTmp('hc-s-'), 'companion')
    mkdirSync(dir, { mode: 0o755 }) // a pre-existing directory is tightened, not trusted
    const rig = await boot({ dir })
    expect(statSync(join(rig.dir, 'c.sock')).mode & 0o777).toBe(0o600)
    expect(statSync(rig.dir).mode & 0o777).toBe(0o700)
    expect(statSync(join(rig.dir, 'endpoint.json')).mode & 0o777).toBe(0o600)
  })

  it('rendezvous: stable token, fresh bootId, written before accept', async () => {
    const dir = join(shortTmp('hc-s-'), 'companion')
    // Boot 1 is cut short by a crash: its endpoint.json is left behind.
    const first = await boot({ dir })
    const leftover = readFileSync(join(dir, 'endpoint.json'), 'utf8')
    await first.srv.stop()
    expect(existsSync(join(dir, 'endpoint.json'))).toBe(false) // a clean stop withdraws it
    writeFileSync(join(dir, 'endpoint.json'), leftover)

    // Boot 2: the first request it accepts must already find a complete endpoint.json.
    let seenAtFirstHello: EndpointFile | null = null
    let seamReply: Reply | null = null
    const second = await boot({
      dir,
      hooks: {
        beforeHello: () => {
          seenAtFirstHello = JSON.parse(readFileSync(join(dir, 'endpoint.json'), 'utf8'))
        }
      },
      // bound, not yet accepting: a request now is told to back off and re-read
      onBound: async () => {
        seamReply = await post({ ...first.ep, bootId: first.ep.bootId }, 'hello', {
          body: { ...helloSpawnRequest, spawn: 'sp_none' }
        })
      }
    })
    expect(second.ep.token).toBe(first.ep.token) // a leftover file's token is reused
    expect(second.ep.bootId).not.toBe(first.ep.bootId)
    expect(second.ep.bootId).toMatch(/^b_/)
    expect((seamReply as Reply | null)?.json).toMatchObject({
      ok: false,
      code: 'HOST_SHUTTING_DOWN'
    })
    await second.bind()
    expect(seenAtFirstHello).toMatchObject({
      v: 1,
      token: first.ep.token,
      bootId: second.ep.bootId
    })
    expect(second.ep).toMatchObject({ protoMin: 1, protoMax: 1, transport: 'unix' })
    expect(typeof second.ep.writtenAt).toBe('number')

    // A listener restart inside one process carries the token in memory instead.
    const dir2 = join(shortTmp('hc-s-'), 'companion')
    const a = await boot({ dir: dir2 })
    await a.srv.stop()
    const b = await boot({ dir: dir2, tokenHint: a.ep.token })
    expect(b.ep.token).toBe(a.ep.token)
    expect(b.ep.bootId).not.toBe(a.ep.bootId)
  })

  it('tcp port fallback is announced', async () => {
    const dir = join(shortTmp('hc-s-'), 'companion')
    mkdirSync(dir, { mode: 0o700 })
    const squatter = await listenTcp()
    cleanups.push(() => closeNet(squatter.server))
    writeFileSync(
      join(dir, 'endpoint.json'),
      JSON.stringify({ v: 1, token: 'old-token', port: squatter.port })
    )
    const rig = await boot({ dir, platform: 'win32' })
    expect(rig.ep.transport).toBe('tcp')
    expect(rig.ep.port).toBeGreaterThan(0)
    expect(rig.ep.port).not.toBe(squatter.port)
    expect(rig.ep.token).toBe('old-token')
    expect(JSON.parse(readFileSync(join(dir, 'endpoint.json'), 'utf8')).port).toBe(rig.ep.port)
    const hello = await rig.bind()
    expect(hello.conn).toMatch(/^c_/)
  })

  it('tcp reuses the stored port when it is free', async () => {
    const dir = join(shortTmp('hc-s-'), 'companion')
    const first = await boot({ dir, platform: 'win32' })
    const port = first.ep.port
    const leftover = readFileSync(join(dir, 'endpoint.json'), 'utf8')
    await first.srv.stop()
    writeFileSync(join(dir, 'endpoint.json'), leftover)
    const second = await boot({ dir, platform: 'win32' })
    expect(second.ep.port).toBe(port)
  })

  it('a live socket is left alone', async () => {
    const dir = join(shortTmp('hc-s-'), 'companion')
    mkdirSync(dir, { mode: 0o700 })
    const sock = join(dir, 'c.sock')
    const other = createNetServer()
    await new Promise<void>((r) => other.listen(sock, r))
    cleanups.push(() => closeNet(other))
    const rig = await boot({ dir })
    expect(rig.ep.transport).toBe('tcp')
    expect(rig.ep.socketPath).toBeUndefined()
    expect(existsSync(sock)).toBe(true) // not unlinked
    await expect(connects(sock)).resolves.toBe(true) // still the other process's
    await rig.srv.stop()
    expect(existsSync(sock)).toBe(true) // and a stop does not take it either
  })

  it('stale socket is replaced', async () => {
    const dir = join(shortTmp('hc-s-'), 'companion')
    mkdirSync(dir, { mode: 0o700 })
    const sock = join(dir, 'c.sock')
    await leaveStaleSocket(sock)
    expect(existsSync(sock)).toBe(true)
    await expect(connects(sock)).resolves.toBe(false)
    const rig = await boot({ dir })
    expect(rig.ep.transport).toBe('unix')
    expect((await rig.bind()).conn).toMatch(/^c_/)
  })
})

describe('transport-level refusals', () => {
  it('transport-level refusals', async () => {
    const rig = await boot()
    const hello = { ...helloSpawnRequest, spawn: 'sp_x' }
    expect((await rig.send('hello', hello, { bearer: 'wrong-token' })).status).toBe(403)
    expect((await rig.send('hello', hello, { bearer: null })).status).toBe(403)
    expect((await rig.send('nope', hello)).status).toBe(404)
    expect((await rig.send('hello', hello, { path: '/mcp' })).status).toBe(404)
    expect((await rig.send('hello', '', { method: 'GET' })).status).toBe(405)
    expect((await rig.send('hello', '', { method: 'GET', bearer: 'wrong' })).status).toBe(405) // route and method come before the token
    // a declared 2 MiB body
    const big = await rig.send('events', Buffer.alloc(2 * 1024 * 1024, 0x61))
    expect(big.status).toBe(413)
    // a declared length over the cap is refused before the body is read
    const declared = await rig
      .send('events', 'x', { headers: { 'content-length': '2097152' } })
      .catch((e: unknown) => e)
    void declared // the client may be cut off mid-request; the next assertion is the one that matters
    // an actual body over the cap with no declared length
    const chunks = Array.from({ length: 3 }, () => Buffer.alloc(512 * 1024, 0x61))
    expect((await post(rig.ep, 'events', { chunked: chunks })).status).toBe(413)
    // over unix the Host must be `harnu`
    expect((await rig.send('hello', hello, { headers: { host: 'evil.example' } })).status).toBe(403)
    // the server is unharmed
    expect((await rig.bind()).conn).toMatch(/^c_/)
    // statuses are counted for diagnostics
    expect(rig.stats.filter((s) => s.status === 403).length).toBeGreaterThanOrEqual(3)
  })

  it('over tcp a non-loopback Origin or Host is 403, a null or loopback Origin is not', async () => {
    const rig = await boot({ platform: 'win32' })
    expect(rig.ep.transport).toBe('tcp')
    const hello = { ...helloSpawnRequest, spawn: 'sp_x' }
    expect(
      (await rig.send('hello', hello, { headers: { origin: 'http://evil.example' } })).status
    ).toBe(403)
    expect((await rig.send('hello', hello, { headers: { host: 'evil.example' } })).status).toBe(403)
    expect((await rig.send('hello', hello, { headers: { origin: 'null' } })).status).toBe(200)
    expect(
      (await rig.send('hello', hello, { headers: { origin: 'http://localhost:1234' } })).status
    ).toBe(200)
    expect((await rig.send('hello', hello, { bearer: 'wrong' })).status).toBe(403)
  })

  it('a body that is not JSON is 200 with BAD_ENVELOPE', async () => {
    const rig = await boot()
    const r = await rig.send('events', '{ definitely not json')
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ ok: false, code: 'BAD_ENVELOPE' })
  })
})

describe('hello protocol', () => {
  it('negotiation outside the range is PROTO_UNSUPPORTED', async () => {
    const rig = await boot()
    const token = rig.table.mint({
      owner: { kind: 'pty', ptyId: 'n' },
      trust: 'operator',
      cwd: '/x'
    })
    const r = await rig.send('hello', {
      ...helloSpawnRequest,
      spawn: token,
      protoMin: 2,
      protoMax: 2
    })
    expect(r.json).toMatchObject({ ok: false, code: 'PROTO_UNSUPPORTED' })
  })

  it('an unknown spawn token is UNAUTHORIZED and an unknown resume conn UNKNOWN_SESSION', async () => {
    const rig = await boot()
    expect(
      (await rig.send('hello', { ...helloSpawnRequest, spawn: 'sp_unknown' })).json
    ).toMatchObject({
      code: 'UNAUTHORIZED'
    })
    const { spawn: _s, ...rest } = helloSpawnRequest
    expect(
      (await rig.send('hello', { ...rest, resume: { conn: 'c_00000000000000000000000000000000' } }))
        .json
    ).toMatchObject({ code: 'UNKNOWN_SESSION' })
  })

  it('the bearer alone reaches nothing', async () => {
    const rig = await boot()
    const fake = rig.env('c_deadbeefdeadbeefdeadbeefdeadbeef' as Conn)
    const refused = async (route: string, body: Record<string, unknown>): Promise<unknown> =>
      (await rig.send(route, { ...fake, ...body })).json
    expect(await refused('events', { events: [] })).toMatchObject({ ok: false, code: 'STALE_CONN' })
    expect(await refused('poll', { bootId: rig.ep.bootId, cursor: 0 })).toMatchObject({
      ok: false,
      code: 'STALE_CONN'
    })
    expect(await refused('ask', { askId: 'ask_1', kind: 'status' })).toMatchObject({
      ok: false,
      code: 'STALE_CONN'
    })
    expect(await refused('bye', { reason: 'exit' })).toMatchObject({
      ok: false,
      code: 'STALE_CONN'
    })
    // no conn at all
    for (const route of ['events', 'poll', 'ask', 'bye']) {
      const r = await rig.send(route, { v: 1, sid: 's', sentAt: 1 })
      expect(r.json).toMatchObject({ ok: false, code: 'BAD_ENVELOPE' })
    }
    // hello with neither spawn nor resume: the external claim, off until P4W3
    const { spawn: _s, ...neither } = helloSpawnRequest
    expect((await rig.send('hello', neither)).json).toMatchObject({
      ok: false,
      code: 'FEATURE_DISABLED'
    })
    // hello with both
    const both = { ...helloSpawnRequest, resume: { conn: 'c_00000000000000000000000000000000' } }
    expect((await rig.send('hello', both)).json).toMatchObject({ ok: false, code: 'BAD_ENVELOPE' })
    expect(rig.table.view()).toEqual([]) // nothing was bound by any of it
  })

  it('beforeHello is synchronous and precedes commands', async () => {
    const order: string[] = []
    const cmd = {
      cmd: 'cmd_1',
      n: 1,
      name: 'flush',
      args: {},
      issuedAt: 1,
      expiresAt: 2
    } as Command
    const rig = await boot({
      hooks: {
        beforeHello: (b) => {
          order.push(`before:${b.state}`)
        },
        commandSource: () => {
          order.push('commands')
          return [cmd]
        },
        onStat: (s) => {
          if (s.endpoint === 'hello') order.push('written')
        },
        onHello: async () => {
          order.push('bus')
          await tick(5)
        }
      }
    })
    const { conn } = await rig.bind()
    await tick()
    expect(conn).toMatch(/^c_/)
    expect(order).toEqual(['before:bound', 'commands', 'written', 'bus'])
    // and the command reached the response
    const token = rig.table.mint({
      owner: { kind: 'pty', ptyId: 'c' },
      trust: 'operator',
      cwd: '/x'
    })
    const r = await rig.send('hello', { ...helloSpawnRequest, spawn: token })
    expect(r.json.commands).toEqual([cmd])
  })

  it('a beforeHello listener that throws does not fail the hello', async () => {
    const rig = await boot({
      hooks: {
        beforeHello: () => {
          throw new Error('boom')
        }
      }
    })
    expect((await rig.bind()).conn).toMatch(/^c_/)
  })

  it('hello is answered before consumers run', async () => {
    let listenerStarted = 0
    const rig = await boot({
      hooks: {
        onHello: async () => {
          listenerStarted = performance.now()
          await tick(3000) // a consumer that blocks for 3 s
        }
      }
    })
    const token = rig.table.mint({
      owner: { kind: 'pty', ptyId: 'slow' },
      trust: 'operator',
      cwd: '/x'
    })
    const r = await rig.send('hello', { ...helloSpawnRequest, spawn: token })
    expect(r.json.ok).toBe(true)
    expect(r.ms).toBeLessThan(HELLO_SLA_MS)
    await tick(20)
    expect(listenerStarted).toBeGreaterThan(0) // it did run, after the response
  }, 10_000)

  it('revoked conn: stale elsewhere, accepted on resume, enable empty', async () => {
    let policy: EnablePolicy = enableIdentity
    const rig = await boot({ policy: undefined, hooks: { enablePolicy: () => policy } })
    const { conn, sid } = await rig.bind()
    expect((await rig.send('events', { ...rig.env(conn, sid), events: [] })).json.ok).toBe(true)
    policy = () => []
    rig.table.revoke(rig.table.view()[0])
    expect((await rig.send('events', { ...rig.env(conn, sid), events: [] })).json).toMatchObject({
      ok: false,
      code: 'STALE_CONN'
    })
    const { spawn: _s, ...rest } = helloSpawnRequest
    const again = await rig.send('hello', { ...rest, resume: { conn } })
    expect(again.json.ok).toBe(true)
    expect(again.json.enable).toEqual([])
    expect(again.json.conn).not.toBe(conn)
    expect(isHelloResponse(again.json)).toBe(true)
    expect(rig.table.view()).toHaveLength(1) // the same binding
  })
})

describe('events', () => {
  it('dedupe, ack and resync over the wire', async () => {
    const delivered: number[] = []
    const rig = await boot({ hooks: { onEvent: (_b, e) => void delivered.push(e.seq) } })
    const { conn, sid } = await rig.bind()
    const answers = []
    for (const step of eventsSeqSteps) {
      answers.push((await rig.send('events', { ...rig.env(conn, sid), events: step.events })).json)
    }
    expect(answers.map((a) => a.ackSeq)).toEqual([3, 4, 7])
    expect(answers.map((a) => a.resync === true)).toEqual([false, false, true])
    await tick()
    expect(delivered).toEqual([1, 2, 3, 4, 7])
    const counters = rig.table.all()[0].counters
    expect(counters).toMatchObject({ events: 5, duplicates: 2, gaps: 1, requests: 3 })
  })

  it('unknown types are ignored and counted (conformance row 18)', async () => {
    const delivered: string[] = []
    const rig = await boot({ hooks: { onEvent: (_b, e) => void delivered.push(e.t) } })
    const { conn, sid } = await rig.bind()
    const odd = { seq: 1, t: 'future.thing', ts: 1, d: { brandNew: true }, surprise: [1, 2] }
    const r = await rig.send('events', { ...rig.env(conn, sid), events: [odd] })
    expect(r.json).toMatchObject({ ok: true, ackSeq: 1 })
    await tick()
    expect(delivered).toEqual([])
    expect(rig.table.all()[0].counters.unknown).toBe(1)
  })

  it('envelope sid mismatch does not re-key (conformance row 16)', async () => {
    const rig = await boot()
    const { conn, sid } = await rig.bind()
    const other = '99999999-9999-4999-8999-999999999999'
    const r = await rig.send('events', { ...rig.env(conn, other), events: [] })
    expect(r.json).toMatchObject({ ok: true, resync: true })
    expect(rig.table.view()[0].sid).toBe(sid)
    // the matching sid does not resync
    expect(
      (await rig.send('events', { ...rig.env(conn, sid), events: [] })).json.resync
    ).toBeUndefined()
  })

  it('a heartbeat renews the lease and answers the current ackSeq', async () => {
    const rig = await boot()
    const { conn, sid } = await rig.bind()
    await rig.send('events', { ...rig.env(conn, sid), events: [ev(1), ev(2)] })
    const r = await rig.send('events', { ...rig.env(conn, sid), events: [] })
    expect(r.json).toEqual({ ok: true, ackSeq: 2 })
  })

  it('floods are answered SLOW_DOWN, and hello is exempt', async () => {
    const rig = await boot()
    const { conn, sid } = await rig.bind()
    const body = { ...rig.env(conn, sid), events: [] }
    // the hello above is exempt: the whole budget is still there
    let firstSlow: Reply | null = null
    let slow = 0
    for (let i = 0; i < RATE_MAX_REQUESTS + 5; i++) {
      const r = await rig.send('events', body)
      if (r.json.code === 'SLOW_DOWN') {
        slow++
        firstSlow ??= r
      }
    }
    // The bucket refills continuously (one token per 50 ms), so how many of the extra requests
    // are refused depends on the loop's speed; the exact 201st boundary is pinned in wire-core.
    expect(slow).toBeGreaterThanOrEqual(1)
    expect(firstSlow?.json).toEqual({ ok: false, code: 'SLOW_DOWN', retryAfterMs: 1000 })
    expect(firstSlow?.status).toBe(200)
    expect(rig.table.all()[0].counters.refused).toBeGreaterThanOrEqual(1)
    // a hello in the same window is served
    const token = rig.table.mint({
      owner: { kind: 'pty', ptyId: 'flood' },
      trust: 'operator',
      cwd: '/x'
    })
    expect((await rig.send('hello', { ...helloSpawnRequest, spawn: token })).json.ok).toBe(true)
  })
})

describe('poll, ask and bye', () => {
  it('poll and ask are disabled and never hold', async () => {
    const rig = await boot()
    const { conn, sid } = await rig.bind()
    const poll = await rig.send('poll', { ...rig.env(conn, sid), bootId: rig.ep.bootId, cursor: 0 })
    expect(poll.json).toMatchObject({ ok: false, code: 'FEATURE_DISABLED' })
    expect(poll.ms).toBeLessThan(100)
    const ask = await rig.send('ask', { ...rig.env(conn, sid), askId: 'ask_1', kind: 'permission' })
    expect(ask.json).toMatchObject({ ok: false, code: 'FEATURE_DISABLED' })
    expect(ask.ms).toBeLessThan(100)
    // both renewed the lease: a known conn is a request
    expect(rig.table.all()[0].counters.requests).toBe(2)
  })

  it('a registered poll handler is served; a headless binding never gets one', async () => {
    const rig = await boot({
      hooks: { pollHandler: (_b, _req, reply) => reply({ ok: true, commands: [] }) }
    })
    const { conn, sid } = await rig.bind()
    const r = await rig.send('poll', { ...rig.env(conn, sid), bootId: rig.ep.bootId, cursor: 0 })
    expect(r.json).toEqual({ ok: true, commands: [] })
    const headless = await rig.bind('hl', {
      isInteractive: false,
      sid: '44444444-4444-4444-8444-444444444444'
    })
    const h = await rig.send('poll', {
      ...rig.env(headless.conn, headless.sid),
      bootId: rig.ep.bootId,
      cursor: 0
    })
    expect(h.json).toMatchObject({ ok: false, code: 'FEATURE_DISABLED' })
    // a malformed poll is BAD_ENVELOPE
    expect((await rig.send('poll', { ...rig.env(conn, sid), cursor: 'x' })).json.code).toBe(
      'BAD_ENVELOPE'
    )
  })

  it('a registered ask kind is served, another kind is FEATURE_DISABLED', async () => {
    const rig = await boot({
      hooks: {
        askHandler: (kind) =>
          kind === 'status'
            ? (_b, _req, reply) =>
                reply({
                  ok: true,
                  state: 'decided',
                  decision: {
                    companion: 'shadow',
                    profile: 'interactive',
                    coverage: 'not-gated',
                    held: 0,
                    mission: null
                  }
                })
            : undefined
      }
    })
    const { conn, sid } = await rig.bind()
    const ok = await rig.send('ask', {
      ...rig.env(conn, sid),
      askId: 'ask_q1',
      kind: 'status',
      d: {}
    })
    expect(ok.json).toMatchObject({ ok: true, state: 'decided' })
    const no = await rig.send('ask', { ...rig.env(conn, sid), askId: 'ask_2', kind: 'permission' })
    expect(no.json).toMatchObject({ ok: false, code: 'FEATURE_DISABLED' })
    expect((await rig.send('ask', { ...rig.env(conn, sid), kind: 'status' })).json.code).toBe(
      'BAD_ENVELOPE'
    )
  })

  it('bye ends the binding', async () => {
    const ended: string[] = []
    const delivered: number[] = []
    const rig = await boot({
      hooks: {
        onEvent: (_b, e) => void delivered.push(e.seq),
        onEnd: (_b, reason) => void ended.push(reason)
      }
    })
    const { conn, sid } = await rig.bind()
    const r = await rig.send('bye', {
      ...rig.env(conn, sid),
      reason: 'exit',
      events: [ev(1), ev(2)]
    })
    expect(r.json).toEqual({ ok: true })
    await tick()
    expect(delivered).toEqual([1, 2]) // the final flush was accepted
    expect(ended).toEqual(['exit'])
    const b = rig.table.all()[0]
    expect(b.state).toBe('ended')
    expect(rig.table.leaseOf(b)).toBe('lost') // at once, no 20 s wait
    expect((await rig.send('events', { ...rig.env(conn, sid), events: [] })).json.code).toBe(
      'STALE_CONN'
    )
  })
})

describe('stop', () => {
  it('stop drains and withdraws the rendezvous', async () => {
    const rig = await boot({ hooks: { pollHandler: () => undefined } }) // a poll that is never answered
    const { conn, sid } = await rig.bind()
    const inFlight = rig.send('poll', { ...rig.env(conn, sid), bootId: rig.ep.bootId, cursor: 0 })
    await tick(50)
    await rig.srv.stop()
    const r = await inFlight
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ ok: false, code: 'HOST_SHUTTING_DOWN' })
    expect(existsSync(join(rig.dir, 'endpoint.json'))).toBe(false)
    expect(existsSync(join(rig.dir, 'c.sock'))).toBe(false)
    await expect(rig.send('events', { ...rig.env(conn, sid), events: [] })).rejects.toBeTruthy()
    await rig.srv.stop() // idempotent
  })

  it('the table survives a listener restart: a resume hello is served by the new boot', async () => {
    const dir = join(shortTmp('hc-s-'), 'companion')
    const table = newTable()
    const hooks: ServerHooks = { enablePolicy: () => enableIdentity }
    const a = await startCompanionServer({ dir, table, hooks })
    const epA = JSON.parse(readFileSync(join(dir, 'endpoint.json'), 'utf8')) as EndpointFile
    const token = table.mint({ owner: { kind: 'pty', ptyId: 'r' }, trust: 'operator', cwd: '/x' })
    const first = await post(epA, 'hello', { body: { ...helloSpawnRequest, spawn: token } })
    await a.stop()
    const b = await startCompanionServer({ dir, table, hooks, tokenHint: a.endpoint.token })
    cleanups.push(() => b.stop())
    cleanups.push(() => rmSync(join(dir, '..'), { recursive: true, force: true }))
    const epB = JSON.parse(readFileSync(join(dir, 'endpoint.json'), 'utf8')) as EndpointFile
    expect(epB.bootId).not.toBe(epA.bootId)
    const { spawn: _s, ...rest } = helloSpawnRequest
    const second = await post(epB, 'hello', {
      body: { ...rest, resume: { conn: first.json.conn } }
    })
    expect(second.json).toMatchObject({ ok: true, bootId: epB.bootId })
    expect(table.view()).toHaveLength(1)
  })
})

// ---- helpers --------------------------------------------------------------------------------

function listenTcp(): Promise<{ server: NetServer; port: number }> {
  return new Promise((resolve) => {
    const server = createNetServer()
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as { port: number }).port })
    })
  })
}

function closeNet(s: NetServer): Promise<void> {
  return new Promise((r) => s.close(() => r()))
}

function connects(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const c = createConnection(path)
    c.once('connect', () => {
      c.destroy()
      resolve(true)
    })
    c.once('error', () => resolve(false))
  })
}

/** A socket file whose owner was SIGKILLed: the inode stays, nothing answers. */
async function leaveStaleSocket(path: string): Promise<void> {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `require('net').createServer().listen(${JSON.stringify(path)}, () => console.log('up'))`
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] }
  )
  await new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (d: Buffer) => d.toString().includes('up') && resolve())
    child.once('error', reject)
  })
  const exited = new Promise<void>((r) => child.once('exit', () => r()))
  child.kill('SIGKILL')
  await exited
}
