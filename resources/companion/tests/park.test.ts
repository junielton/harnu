/* eslint-disable @typescript-eslint/no-explicit-any -- test code reads wire bodies loosely */
import { expect, test, type ClassicFields } from 'claude-code/testing'
import type { ParkQueryData } from '../hooks/contract'
import { FIXTURE_SID } from './fixtures/hello'
import {
  FLEET_FEATURES,
  START,
  defaultScript,
  helloOk,
  installRig,
  type Rig,
  type Script
} from './support/rig'

/**
 * T456 W2: `park.query`, the mod's answer to "may Harnu park you?" (spec §5.2). The seven tests of
 * `docs/specs/T456-negotiated-hibernation/01-prototype.md` §P1.1 are ported here: the prototype
 * drove its answer through a stand-in slash command, these drive the real command channel — the
 * host hands `park.query` over the held poll and the answer is the `command.result`'s `data`.
 * The tests after the seven pin what the port adds: `fleet.idle` survives the turn's end and a
 * reload, the feature gate, and the fail-open paths (spec §9.2).
 */

type Surface = 'terminal' | 'desktop' | 'mobile' | 'vscode'

const base = { session_id: FIXTURE_SID, transcript_path: '/tmp/x.jsonl', cwd: '/tmp/x' }
const PARK_FEATURES = [...FLEET_FEATURES, 'act.channel', 'act.park']
/** A poll the host parks for this long when it has nothing to hand over. */
const HOLD_MS = 1_000

let seq = 0

interface Host {
  rig: Rig
  /** Commands the host hands over on the next poll. */
  pending: unknown[]
  /** What `$.session.surfaces()` reads beneath the plugin. */
  surfaces: { value: Surface[] | 'throw' }
}

function parkHost(on: any, opts: { enable?: string[]; surfaces?: Surface[] } = {}): Host {
  const pending: unknown[] = []
  const script: Script = (route, body, n) => {
    if (route === 'hello') return helloOk(opts.enable ?? PARK_FEATURES)
    if (route === 'poll') {
      if (pending.length > 0)
        return { kind: 'body', body: { ok: true, commands: pending.splice(0) } }
      return { kind: 'after', ms: HOLD_MS, body: { ok: true, commands: [] } }
    }
    return defaultScript(route, body, n)
  }
  const rig = installRig(on, { script })
  const surfaces: Host['surfaces'] = { value: opts.surfaces ?? ['terminal'] }
  on('session.surfaces', async () => {
    if (surfaces.value === 'throw') throw new Error('surfaces unavailable')
    return { value: surfaces.value }
  })
  return { rig, pending, surfaces }
}

const results = (rig: Rig): any[] =>
  rig
    .events()
    .filter((e) => e.t === 'command.result')
    .map((e) => e.d)

/** Hands the session one `park.query` and returns its one `command.result`. */
async function query(h: Host, over: Record<string, unknown> = {}): Promise<any> {
  const now = h.rig.clock.now()
  const c = {
    cmd: `cmd_park_${++seq}`,
    n: seq,
    name: 'park.query',
    args: { cause: 'sweep' },
    issuedAt: now,
    expiresAt: now + 5_000,
    ...over
  }
  h.pending.push(c)
  await h.rig.clock.advance(HOLD_MS) // the parked poll returns; the next one carries the command
  await h.rig.clock.settle()
  await h.rig.clock.advance(HOLD_MS) // the pump sends the result
  const mine = results(h.rig).filter((r) => r.cmd === c.cmd)
  expect(mine.length).toBe(1)
  return mine[0]
}

/** The answer of a `park.query` that ran: `ok: true` with `data` always (spec §5.2). */
async function probe(h: Host): Promise<ParkQueryData> {
  const r = await query(h)
  expect(r.ok).toBe(true)
  return r.data as ParkQueryData
}

async function boot($: any, h: Host): Promise<void> {
  await $.session.start(START)
  await h.rig.clock.settle()
}

type StopFields = ClassicFields<'Stop'>
const stop = (
  background_tasks: NonNullable<StopFields['background_tasks']>,
  session_crons: NonNullable<StopFields['session_crons']> = []
): StopFields => ({ ...base, stop_hook_active: false, background_tasks, session_crons })

// ---- the seven tests of 01-prototype.md §P1.1 ------------------------------------------------

test('an idle session with nothing running is not busy', async ($, on) => {
  const h = parkHost(on)
  await boot($, h)
  await $.classic.Stop(stop([], []))
  expect(await probe(h)).toEqual({ busy: [] })
})

test('background shell, monitor and a wakeup from the last Stop', async ($, on) => {
  const h = parkHost(on)
  await boot($, h)
  await $.classic.Stop(
    stop(
      [
        { id: 'b1', type: 'shell', status: 'running', description: 'push', command: 'git push' },
        { id: 'm1', type: 'monitor', status: 'running', description: 'ci' },
        { id: 'b0', type: 'shell', status: 'completed', description: 'old' }
      ],
      [{ id: 'c1', schedule: '30 14 9 10 *', recurring: false, prompt: '/loop' }]
    )
  )
  const a = await probe(h)
  expect(a.busy).toEqual([
    { kind: 'background-task', count: 2, types: ['shell', 'monitor'] },
    { kind: 'scheduled-wakeup', count: 1, recurring: 0 }
  ])
  expect(a.retryAfterMs).toBeUndefined()
  // No command text or prompt leaves the mod: counts and type labels only (spec §5.3).
  expect(JSON.stringify(a)).not.toContain('git push')
  expect(JSON.stringify(h.rig.sent)).not.toContain('git push')
  expect(JSON.stringify(h.rig.state.get('fleet'))).not.toContain('git push')
})

test('a subagent that already stopped is not counted', async ($, on) => {
  const h = parkHost(on)
  await boot($, h)
  // The companion's sensor only counts subagents it saw start (P1W5); the prototype had no such rule.
  await $.classic.SubagentStart({ ...base, agent_id: 'a1', agent_type: 'general-purpose' })
  await $.classic.SubagentStart({ ...base, agent_id: 'a2', agent_type: 'general-purpose' })
  await $.classic.SubagentStop({
    ...base,
    stop_hook_active: false,
    agent_id: 'a1',
    agent_transcript_path: '/tmp/a1.jsonl',
    agent_type: 'general-purpose'
  })
  await $.classic.Stop(
    stop([
      { id: 'a1', type: 'subagent', status: 'running', description: 'done already' },
      { id: 'a2', type: 'subagent', status: 'running', description: 'still going' }
    ])
  )
  expect((await probe(h)).busy).toEqual([{ kind: 'background-subagent', count: 1 }])
})

test('a turn in flight is busy, and its end clears it', async ($, on) => {
  const h = parkHost(on)
  await boot($, h)
  await $.turn.start({ text: 'p', turnId: 't1' })
  expect(await probe(h)).toEqual({ busy: [{ kind: 'turn' }], retryAfterMs: 120_000 })
  await $.turn.complete({
    answer: '',
    durationMs: 1,
    isAborted: false,
    turnId: 't1',
    reason: 'answer'
  } as never)
  expect(await probe(h)).toEqual({ busy: [] })
})

test('a permission dialog shown to a person is busy until its tool settles', async ($, on) => {
  const h = parkHost(on)
  await boot($, h)
  await $.classic.PermissionRequest({
    ...base,
    tool_name: 'Bash',
    tool_input: { command: 'git push' }
  })
  expect(await probe(h)).toEqual({
    busy: [{ kind: 'permission', count: 1 }],
    retryAfterMs: 300_000
  })
  await $.classic.PostToolUse({
    ...base,
    tool_name: 'Bash',
    tool_input: {},
    tool_response: {},
    tool_use_id: 'u1'
  })
  expect((await probe(h)).busy).toEqual([])
})

test('a denied or failed tool settles its dialog too', async ($, on) => {
  const h = parkHost(on)
  await boot($, h)
  await $.classic.PermissionRequest({ ...base, tool_name: 'Bash', tool_input: {} })
  await $.classic.PermissionRequest({ ...base, tool_name: 'Edit', tool_input: {} })
  expect((await probe(h)).busy).toEqual([{ kind: 'permission', count: 2 }])
  await $.classic.PostToolUseFailure({
    ...base,
    tool_name: 'Bash',
    tool_input: {},
    tool_use_id: 'u2',
    error: 'denied'
  })
  expect((await probe(h)).busy).toEqual([{ kind: 'permission', count: 1 }])
})

test('an attached phone is busy, read at ask time', async ($, on) => {
  const h = parkHost(on, { surfaces: ['terminal', 'mobile'] })
  await boot($, h)
  expect((await probe(h)).busy).toEqual([{ kind: 'remote-surface', surfaces: ['mobile'] }])
  h.surfaces.value = ['terminal'] // the phone detached: read again at the next question
  expect((await probe(h)).busy).toEqual([])
})

// ---- what the port adds ----------------------------------------------------------------------

test('the last Stop outlives the end of its turn (fleet.idle)', async ($, on) => {
  const h = parkHost(on)
  await boot($, h)
  await $.turn.start({ text: 'p', turnId: 't1' })
  // A main turn ends with its Stop, then turn.complete: the query comes after both (spec §5.2).
  await $.classic.Stop(
    stop(
      [{ id: 'b1', type: 'shell', status: 'running', description: 'e2e' }],
      [{ id: 'c1', schedule: '*/5 * * * *', recurring: true, prompt: '/loop' }]
    )
  )
  await $.turn.complete({
    answer: '',
    durationMs: 1,
    isAborted: false,
    turnId: 't1',
    reason: 'answer'
  } as never)
  expect(await probe(h)).toEqual({
    busy: [
      { kind: 'background-task', count: 1, types: ['shell'] },
      { kind: 'scheduled-wakeup', count: 1, recurring: 1 }
    ]
  })
  expect((h.rig.state.get('fleet') as any).idle).toEqual({
    tasks: [{ id: 'b1', type: 'shell' }],
    crons: [{ recurring: true }]
  })
  // The next Stop replaces it: the work finished.
  await $.classic.Stop(stop([], []))
  expect(await probe(h)).toEqual({ busy: [] })
})

test('fleet.idle lives in $.state, so a reload keeps the answer', async ($, on) => {
  const pending: unknown[] = []
  const rig = installRig(on, {
    savedState: {
      fleet: {
        activeTurnId: null,
        open: [],
        checks: [],
        runningSubagents: 0,
        lastStop: null,
        pendingFailure: null,
        agents: {},
        stopped: [],
        idle: { tasks: [{ id: 'b9', type: 'monitor' }], crons: [] }
      }
    },
    script: (route, body, n) => {
      if (route === 'hello') return helloOk(PARK_FEATURES)
      if (route === 'poll' && pending.length > 0)
        return { kind: 'body', body: { ok: true, commands: pending.splice(0) } }
      if (route === 'poll') return { kind: 'after', ms: HOLD_MS, body: { ok: true, commands: [] } }
      return defaultScript(route, body, n)
    }
  })
  on('session.surfaces', async () => ({ value: ['terminal'] as Surface[] }))
  const h: Host = { rig, pending, surfaces: { value: ['terminal'] } }
  await boot($, h)
  expect((await probe(h)).busy).toEqual([{ kind: 'background-task', count: 1, types: ['monitor'] }])
})

test('at most four task type labels leave the mod', async ($, on) => {
  const h = parkHost(on)
  await boot($, h)
  const types = ['shell', 'monitor', 'workflow', 'mcp', 'other', 'another']
  await $.classic.Stop(
    stop(
      types.map((type, i) => ({ id: `t${i}`, type, status: 'running', description: 'x' })) as never
    )
  )
  expect((await probe(h)).busy).toEqual([
    { kind: 'background-task', count: 6, types: ['shell', 'monitor', 'workflow', 'mcp'] }
  ])
})

test('without act.park enabled the mod answers FEATURE_DISABLED and reads nothing', async ($, on) => {
  const h = parkHost(on, { enable: [...FLEET_FEATURES, 'act.channel'], surfaces: ['mobile'] })
  let read = 0
  on('session.surfaces', async () => {
    read++
    return { value: ['mobile'] as Surface[] }
  })
  await boot($, h)
  const r = await query(h)
  expect(r).toEqual({ cmd: r.cmd, ok: false, code: 'FEATURE_DISABLED' })
  expect(read).toBe(0)
})

test('a late park.query is refused CMD_EXPIRED and never answered', async ($, on) => {
  const h = parkHost(on)
  await boot($, h)
  const now = h.rig.clock.now()
  const r = await query(h, { issuedAt: now - 10_000, expiresAt: now - 5_000 })
  expect(r).toEqual({ cmd: r.cmd, ok: false, code: 'CMD_EXPIRED' })
})

test('a throwing surfaces read is CMD_FAILED, which the host reads as silent', async ($, on) => {
  const h = parkHost(on)
  h.surfaces.value = 'throw'
  await boot($, h)
  const r = await query(h)
  expect(r.ok).toBe(false)
  expect(r.code).toBe('CMD_FAILED')
  expect(r.data).toBeUndefined()
})

test('a malformed Stop fails toward less busy and the event passes', async ($, on) => {
  const h = parkHost(on)
  await boot($, h)
  await $.classic.Stop(stop([{ id: 'b1', type: 'shell', status: 'running', description: 'x' }]))
  // A `null` entry makes the sensor step throw: the hook reports it and returns next(e).
  const out = await $.classic.Stop({
    ...base,
    stop_hook_active: false,
    background_tasks: [null as never]
  })
  expect(out).toEqual({})
  const a = await probe(h)
  expect(a.busy.length).toBeLessThanOrEqual(1)
  expect(h.rig.events().some((e) => e.t === 'mod.error')).toBe(true)
})
