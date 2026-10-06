/* eslint-disable @typescript-eslint/no-explicit-any -- test code reads wire bodies loosely */
import { mock } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'
import { RENDEZVOUS_PATH } from '../../hooks/coords.gen'
import { DEFAULT_CONFIG, type EndpointName } from '../../hooks/contract'
import { FIXTURE_CONN, FIXTURE_SID, FIXTURE_SPAWN } from '../fixtures/hello'

/**
 * The world beneath the mod in an L3 test (P1W3 §11): a scripted host behind `$.http.fetch`, an
 * in-memory `$.state`, the rendezvous file behind `$.fs.read`, `$.session.id()` / `version()`,
 * a held clock and the spawn token in `$.env`. Nothing here talks to a real socket.
 */

export const NEW_SID = '22222222-2222-4222-8222-222222222222'
export const OTHER_SID = '33333333-3333-4333-8333-333333333333'
export const CONN_2 = 'c_00000000000000000000000000000002'
export const BOOT = 'b_00000000-0000-4000-8000-0000000000b1'

export type Answer =
  | { kind: 'body'; body: unknown }
  | { kind: 'status'; status: number; text?: string }
  | { kind: 'text'; text: string }
  | { kind: 'hang' }
  | { kind: 'throw' }
  /** Answers `body` after `ms` of the held clock: a poll the host parks. */
  | { kind: 'after'; ms: number; body: unknown }
  /** The engine's hard cap: no answer for 30 s, then the fetch rejects (smoke C2, B1.1). */
  | { kind: 'abort' }

export interface Sent {
  route: EndpointName
  url: string
  socketPath?: string
  headers: Record<string, string>
  body: any
}

export type Script = (route: EndpointName, body: any, n: number) => Answer

export const helloOk = (enable: string[] = ['sense.identity'], conn = FIXTURE_CONN): Answer => ({
  kind: 'body',
  body: {
    ok: true,
    proto: 1,
    conn,
    bootId: BOOT,
    sessionKey: 'row-key',
    profile: 'interactive',
    enable,
    config: { ...DEFAULT_CONFIG }
  }
})

export const failure = (code: string, extra: Record<string, unknown> = {}): Answer => ({
  kind: 'body',
  body: { ok: false, code, ...extra }
})

export const ackAll = (body: any): Answer => ({
  kind: 'body',
  body: {
    ok: true,
    ackSeq: Math.max(0, ...((body.events ?? []) as { seq: number }[]).map((e) => e.seq))
  }
})

/** Hello ok with identity enabled; events acknowledged in full; bye ok; a poll is parked. */
export const defaultScript: Script = (route, body) => {
  if (route === 'hello') return helloOk()
  if (route === 'events') return ackAll(body)
  if (route === 'poll') return { kind: 'after', ms: 25_000, body: { ok: true, commands: [] } }
  return { kind: 'body', body: { ok: true } }
}

export interface Rig {
  clock: MockClock
  sent: Sent[]
  state: Map<string, unknown>
  /** What `$.session.id()` answers; change it to simulate a drift. */
  sid: { value: string }
  /** What the engine's own `tool.check` answers (P1W5). */
  verdict: { value: 'allow' | 'ask' | 'deny' }
  script: { fn: Script }
  /** The rendezvous file's content; null makes the read fail. */
  endpoint: { text: string | null }
  of(route: EndpointName): Sent[]
  /** Every event the host has been sent, in order, across all `events` and `bye` requests. */
  events(): { seq: number; t: string; d: any }[]
}

export interface RigOptions {
  token?: boolean
  savedState?: Record<string, unknown>
  script?: Script
}

export const endpointText = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    v: 1,
    transport: 'unix',
    socketPath: `${RENDEZVOUS_PATH.slice(0, RENDEZVOUS_PATH.lastIndexOf('/'))}/c.sock`,
    token: 'endpoint-token-fixture',
    bootId: BOOT,
    protoMin: 1,
    protoMax: 1,
    writtenAt: 1_790_000_000_000,
    ...over
  })

export function installRig(on: On, opts: RigOptions = {}): Rig {
  const clock = mock.clock(on, { now: 1_790_000_000_000 })
  mock.env(on, opts.token === false ? {} : { HARNU_SPAWN_TOKEN: FIXTURE_SPAWN })
  const rig: Rig = {
    clock,
    sent: [],
    state: new Map(Object.entries(opts.savedState ?? {})),
    sid: { value: FIXTURE_SID },
    verdict: { value: 'allow' },
    script: { fn: opts.script ?? defaultScript },
    endpoint: { text: endpointText() },
    of: (route) => rig.sent.filter((s) => s.route === route),
    events: () =>
      rig.sent.flatMap((s) =>
        s.route === 'events' || s.route === 'bye' ? (s.body.events ?? []) : []
      )
  }
  const counts: Record<string, number> = {}

  on('http.fetch', async (_$, e) => {
    const route = e.url.slice(e.url.lastIndexOf('/') + 1) as EndpointName
    const body = JSON.parse(e.init?.body ?? 'null')
    rig.sent.push({
      route,
      url: e.url,
      socketPath: e.init?.socketPath,
      headers: e.init?.headers ?? {},
      body
    })
    counts[route] = (counts[route] ?? 0) + 1
    const a = rig.script.fn(route, body, counts[route])
    if (a.kind === 'hang') await clock.sleep(3_600_000)
    if (a.kind === 'abort') {
      await clock.sleep(30_000)
      throw new Error('no complete answer within 30000ms')
    }
    if (a.kind === 'throw' || a.kind === 'hang') throw new Error('transport failure')
    if (a.kind === 'after') {
      await clock.sleep(a.ms)
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(a.body) } }
    }
    if (a.kind === 'status')
      return { value: { status: a.status, ok: false, headers: {}, text: a.text ?? '' } }
    const text = a.kind === 'text' ? a.text : JSON.stringify(a.body)
    return { value: { status: 200, ok: true, headers: {}, text } }
  })
  on('fs.read', async (_$, e) => {
    if (e.path !== RENDEZVOUS_PATH || rig.endpoint.text === null) throw new Error('ENOENT')
    return { value: rig.endpoint.text }
  })
  on('state.get', async (_$, e) => ({
    value: { value: rig.state.get(e.key), version: rig.state.has(e.key) ? 1 : 0 }
  }))
  on('state.set', async (_$, e) => {
    rig.state.set(e.key, e.value)
    return { value: { isSet: true, version: 1 } }
  })
  // The engine's own answers, beneath the plugin.
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.end', async (_$, e) => ({ sessionId: e.sessionId }))
  on('classic.SessionStart', async () => ({}))
  // P1W5: the engine's answers beneath the fleet sensors.
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', async () => ({ text: '' }))
  on('tool.check', async () => ({ decision: rig.verdict.value }))
  on('classic.PermissionRequest', async () => ({}))
  on('classic.Notification', async () => ({}))
  on('classic.PostToolUse', async () => ({}))
  on('classic.PostToolUseFailure', async () => ({}))
  on('classic.Stop', async () => ({}))
  on('classic.StopFailure', async () => ({}))
  on('classic.SubagentStart', async () => ({}))
  on('classic.SubagentStop', async () => ({}))
  on('session.id', async () => ({ value: rig.sid.value }))
  on('session.version', async () => ({ value: { version: '2.1.290' } }))
  return rig
}

/** An element that the test knows is there; fails loudly when it is not. */
export function must<T>(v: T | undefined, what = 'element'): T {
  if (v === undefined) throw new Error(`missing ${what}`)
  return v
}

/** The features a hello enables for the fleet sensors (P1W5). */
export const FLEET_FEATURES = [
  'sense.identity',
  'sense.turn',
  'sense.attention',
  'sense.subagent'
] as const

export const START = {
  cwd: '/tmp/example-project',
  surface: 'terminal',
  isInteractive: true
} as const

export type { Engine }
