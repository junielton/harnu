/* eslint-disable @typescript-eslint/no-explicit-any -- test code reads wire bodies loosely */
import { expect, test } from 'claude-code/testing'
import { FIXTURE_CONN, FIXTURE_SID } from './fixtures/hello'
import {
  FLEET_TRACES,
  approved,
  backgroundSubagent,
  denied,
  type FleetStep
} from './fixtures/fleet/traces'
import { expectWire, fleetScript, fleetWire, play } from './support/fleet'
import { BOOT, FLEET_FEATURES, NEW_SID, START, helloOk, installRig, must } from './support/rig'

const base = { session_id: FIXTURE_SID, transcript_path: '/tmp/x.jsonl', cwd: '/tmp/x' }

async function boot($: any, on: any, over: Record<string, unknown> = {}) {
  const rig = installRig(on, { script: fleetScript, ...over })
  await $.session.start(START)
  await rig.clock.settle()
  return rig
}

test('approved permission', async ($, on) => {
  const rig = await boot($, on)
  await play($, rig, approved.steps)
  expect(fleetWire(rig).map((e) => e.t)).toEqual([
    'turn.started',
    'attention.raised',
    'attention.raised',
    'attention.cleared',
    'turn.completed'
  ])
  expectWire(rig, approved.wire)
})

for (const trace of FLEET_TRACES) {
  test(`golden trace: ${trace.name}`, async ($, on) => {
    const rig = await boot($, on)
    await play($, rig, trace.steps)
    expectWire(rig, trace.wire)
  })
}

test('user No ends the turn', async ($, on) => {
  const rig = await boot($, on)
  await play($, rig, denied.steps)
  const w = fleetWire(rig)
  const last = w.slice(-2)
  expect(last.map((e) => e.t)).toEqual(['attention.cleared', 'turn.completed'])
  expect(last[0]?.d).toMatchObject({ kind: 'permission', cause: 'turn-completed' })
  expect(last[1]?.d).toMatchObject({ reason: 'answer', isAborted: false })
})

test('stray SubagentStop is dropped', async ($, on) => {
  const rig = await boot($, on)
  await $.classic.SubagentStart({
    ...base,
    agent_id: 'a1',
    agent_type: 'general-purpose'
  })
  await $.classic.SubagentStop({ ...base, agent_id: '', agent_type: '', stop_hook_active: false })
  await rig.clock.settle()
  expect(fleetWire(rig).map((e) => e.t)).toEqual(['subagent.started'])
  expect((rig.state.get('fleet') as any).runningSubagents).toBe(1)
})

test('sensor failure is pass-through', async ($, on) => {
  const rig = await boot($, on)
  // a `null` entry in `background_tasks` makes the core step throw
  const out = await $.classic.Stop({
    ...base,
    stop_hook_active: false,
    background_tasks: [null]
  })
  await rig.clock.settle()
  expect(out).toEqual({})
  const errors = rig.events().filter((e) => e.t === 'mod.error')
  expect(errors.length).toBe(1)
  expect((errors[0] as any).d.where).toBe('classic.Stop')
  // the verdict of tool.check is never altered, whatever the sensor does
  rig.verdict.value = 'ask'
  const verdict = await $.tool.check({ tool: 'Bash', input: {}, tool_use_id: 'u9' })
  expect(verdict.decision).toBe('ask')
})

test('rebound resets fleet', async ($, on) => {
  const rig = await boot($, on)
  await $.classic.Notification({ ...base, message: 'm', notification_type: 'permission_prompt' })
  await $.classic.Stop({ ...base, stop_hook_active: false, permission_mode: 'acceptEdits' })
  await $.turn.start({ text: 'p', turnId: 't1' })
  await rig.clock.settle()
  expect((rig.state.get('fleet') as any).activeTurnId).toBe('t1')
  await $.classic.SessionStart({ source: 'clear', session_id: NEW_SID })
  await rig.clock.settle()
  expect(rig.state.get('fleet')).toEqual({
    activeTurnId: null,
    nextOrigin: 'unknown',
    open: [],
    checks: [],
    runningSubagents: 0,
    lastStop: null,
    pendingFailure: null,
    agents: {}
  })
  expect(rig.state.get('permissionMode')).toBe('acceptEdits')
})

test('toolCheck probe is verdict-independent', async ($, on) => {
  const rig = await boot($, on)
  rig.verdict.value = 'allow'
  await $.tool.check({ tool: 'Read', input: {}, tool_use_id: 'u1' })
  await rig.clock.settle()
  expect((rig.state.get('probes') as any).toolCheck).toBe(true)
  expect((rig.state.get('fleet') as any)?.checks ?? []).toEqual([])
  expect(fleetWire(rig)).toEqual([])
  // the flip is reported once, as a snapshot
  const snaps = rig.events().filter((e) => e.t === 'session.snapshot' && e.d.reason === 'probe')
  expect(snaps.length).toBe(1)
  expect((snaps[0] as any).d.probes.toolCheck).toBe(true)
})

test('a tool.check without a tool_use_id is not a real dispatch', async ($, on) => {
  const rig = await boot($, on)
  await $.tool.check({ tool: 'Read', input: {} })
  await rig.clock.settle()
  expect((rig.state.get('probes') as any)?.toolCheck ?? false).toBe(false)
})

test('permission mode is recorded', async ($, on) => {
  const rig = await boot($, on)
  expect(rig.state.get('permissionMode')).toBeUndefined()
  await $.classic.Stop({ ...base, stop_hook_active: false, permission_mode: 'acceptEdits' })
  await rig.clock.settle()
  expect(rig.state.get('permissionMode')).toBe('acceptEdits')
  // a payload without the field leaves the last value
  await $.classic.Notification({ ...base, message: 'm', notification_type: 'other' })
  await rig.clock.settle()
  expect(rig.state.get('permissionMode')).toBe('acceptEdits')
})

test('per-agent facts keyed on agent id', async ($, on) => {
  const rig = await boot($, on)
  await $.classic.SubagentStart({ ...base, agent_id: 'a1', agent_type: 'general-purpose' })
  // a stop for an id the sensor never counted (a teammate, say) moves nothing
  await $.classic.SubagentStop({
    ...base,
    agent_id: 'mate@team',
    agent_type: 'teammate',
    stop_hook_active: false
  })
  await rig.clock.settle()
  const fleet = rig.state.get('fleet') as any
  expect(fleet.runningSubagents).toBe(1)
  expect(fleet.agents).toEqual({ a1: 'general-purpose' })
  expect(fleetWire(rig).map((e) => e.t)).toEqual(['subagent.started'])
  await $.classic.SubagentStop({
    ...base,
    agent_id: 'a1',
    agent_type: 'general-purpose',
    stop_hook_active: false
  })
  await rig.clock.settle()
  expect((rig.state.get('fleet') as any).runningSubagents).toBe(0)
})

test('a teammate never counts as a background subagent', async ($, on) => {
  const rig = await boot($, on)
  await $.turn.start({ text: 'p', turnId: 't1' })
  await $.classic.Stop({
    ...base,
    stop_hook_active: false,
    background_tasks: [
      { id: 'm1', type: 'teammate', status: 'idle', description: 'd' },
      { id: 'a1', type: 'subagent', status: 'completed', description: 'd' }
    ]
  })
  await $.turn.complete({
    answer: '',
    durationMs: 1,
    isAborted: false,
    turnId: 't1',
    reason: 'answer'
  })
  await rig.clock.settle()
  const done = fleetWire(rig).find((e) => e.t === 'turn.completed') as any
  expect(done.d.backgroundSubagents).toBe(0)
  expect(done.d.backgroundTasks).toBe(2)
})

test('a failure reaches the completion of the same turn', async ($, on) => {
  const rig = await boot($, on)
  await $.turn.start({ text: 'p', turnId: 't1' })
  await $.classic.StopFailure({ ...base, stop_hook_active: false, error: 'rate_limit' })
  await $.turn.complete({
    answer: '',
    durationMs: 1,
    isAborted: false,
    turnId: 't1',
    reason: 'error'
  })
  await rig.clock.settle()
  const done = fleetWire(rig).find((e) => e.t === 'turn.completed') as any
  expect(done.d).toMatchObject({ reason: 'error', failure: { type: 'rate_limit' } })
  expect((rig.state.get('fleet') as any).pendingFailure).toBeNull()
})

test('a notification raises its kind and the prompt clears every open item', async ($, on) => {
  const rig = await boot($, on)
  await $.classic.Notification({ ...base, message: 'm', notification_type: 'elicitation_dialog' })
  await $.classic.Notification({ ...base, message: 'm', notification_type: 'idle_prompt' })
  await $.classic.Notification({ ...base, message: 'm', notification_type: 'auth_success' })
  await $.prompt.submit({ text: 'p', origin: { kind: 'composer' } })
  await rig.clock.settle()
  const w = fleetWire(rig)
  expect(w.map((e) => e.t)).toEqual([
    'attention.raised',
    'attention.raised',
    'attention.cleared',
    'attention.cleared'
  ])
  expect(w[0]?.d).toMatchObject({ kind: 'input', source: 'notification' })
  expect(w[1]?.d).toMatchObject({ kind: 'idle', source: 'notification' })
  expect(w[2]?.d).toMatchObject({ cause: 'prompt' })
})

test('PostToolUseFailure settles like PostToolUse', async ($, on) => {
  const rig = await boot($, on)
  rig.verdict.value = 'ask'
  await $.tool.check({ tool: 'Bash', input: {}, tool_use_id: 'u1' })
  await $.classic.PostToolUseFailure({
    ...base,
    tool_name: 'Bash',
    tool_input: {},
    tool_use_id: 'u1',
    error: 'e'
  })
  await rig.clock.settle()
  const w = fleetWire(rig)
  expect(w.map((e) => e.t)).toEqual(['attention.raised', 'attention.cleared'])
  expect(w[1]?.d).toMatchObject({ cause: 'tool-settled', toolUseId: 'u1' })
})

test('the next turn origin comes from the preceding prompt', async ($, on) => {
  const rig = await boot($, on)
  await $.prompt.submit({ text: 'p', origin: { kind: 'peer' } })
  await $.turn.start({ text: 'p', turnId: 't1' })
  await $.turn.start({ text: 'p', turnId: 't2' }) // no prompt in between: unknown
  await rig.clock.settle()
  const origins = fleetWire(rig)
    .filter((e) => e.t === 'turn.started')
    .map((e) => e.d.origin)
  expect(origins).toEqual(['peer', 'unknown'])
})

test('a hot reload restores the sensor state and the snapshot is correct', async ($, on) => {
  const saved = {
    conn: FIXTURE_CONN,
    bootId: BOOT,
    sid: FIXTURE_SID,
    boot: START,
    probes: { classic: true, toolCheck: true },
    fleet: {
      activeTurnId: 't7',
      nextOrigin: 'human',
      open: [{ kind: 'permission', toolUseId: 'u1', tool: 'Bash' }],
      checks: [],
      runningSubagents: 2,
      lastStop: null,
      pendingFailure: null,
      agents: { a1: 'general-purpose', a2: 'general-purpose' }
    }
  }
  const rig = installRig(on, {
    savedState: saved,
    script: (route, body, n) =>
      route === 'hello' ? helloOk([...FLEET_FEATURES]) : fleetScript(route, body, n)
  })
  await $.session.start(START)
  await rig.clock.settle()
  const snap = must(rig.events().find((e) => e.t === 'session.snapshot'))
  expect(snap.d).toEqual({
    reason: 'hello',
    activeTurnId: 't7',
    openAttention: [{ kind: 'permission', toolUseId: 'u1' }],
    runningSubagents: 2,
    probes: { classic: true, toolCheck: true }
  })
})

test('the same trace twice leaves no leftover state', async ($, on) => {
  const rig = await boot($, on)
  await play($, rig, backgroundSubagent.steps as FleetStep[])
  const fleet = rig.state.get('fleet') as any
  expect(fleet.activeTurnId).toBeNull()
  expect(fleet.open).toEqual([])
  expect(fleet.runningSubagents).toBe(0)
})

test('inert and dormant sensors send nothing', async ($, on) => {
  const rig = installRig(on, {
    script: (route, body, n) => (route === 'hello' ? helloOk([]) : fleetScript(route, body, n))
  })
  await $.session.start(START)
  await rig.clock.settle()
  await play($, rig, approved.steps)
  expect(fleetWire(rig)).toEqual([])
})
