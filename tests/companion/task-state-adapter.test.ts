import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { admit, type RolloutView } from '../../src/main/companion/arbitration-core'
import type { CompanionMode } from '../../src/main/companion/mode'
import { createSessionArbiter } from '../../src/main/companion/session-arbiter'
import type { BindingView } from '../../src/main/companion/session-table'
import type { WireEvent } from '../../src/main/companion/contract'
import {
  createTaskStateAdapter,
  type TaskStateAdapter
} from '../../src/main/companion/ingest/task-state-adapter'
import {
  addTaskEventObserver,
  configureHub,
  getTaskState,
  ingest,
  resetHubForTests,
  type BridgeEvent
} from '../../src/main/detect/task-state-hub'
import {
  FLEET_TRACES,
  backgroundSubagent,
  denied,
  esc,
  type FleetTrace
} from '../../resources/companion/tests/fixtures/fleet/traces'

const S1 = '11111111-1111-4111-8111-111111111111'
const S2 = '22222222-2222-4222-8222-222222222222'
const FEATURES = ['sense.identity', 'sense.turn', 'sense.attention', 'sense.subagent']

type Handler = (...a: never[]) => void
interface Rig {
  view: BindingView
  rollout: RolloutView
  adapter: TaskStateAdapter
  sends: { channel: string; payload: Record<string, unknown> }[]
  edges: { sessionId: string; event: string; taskState: string; source?: string }[]
  facts: { source: string; sid: string; k: string; d?: Record<string, unknown>; ts?: number }[]
  registered: string[]
  proven: string[]
  wire(t: string, d?: Record<string, unknown>, extra?: Partial<WireEvent>): void
  legacy(event: string, matcher?: string, sid?: string): void
  lose(): void
  end(): void
  replay(trace: FleetTrace): void
}

function rig(mode: CompanionMode = 'active', over: Partial<BindingView> = {}): Rig {
  const view: BindingView = {
    key: 1,
    owner: { kind: 'pty', ptyId: 'p1' },
    trust: 'operator',
    sid: S1,
    sessionKey: S1,
    cwd: '/tmp/example-project',
    profile: 'interactive',
    cliVersion: '2.1.290',
    modVersion: '0.1.0',
    declared: FEATURES,
    enabled: FEATURES,
    proven: [],
    lease: 'live',
    state: 'bound',
    helloAfterSpawnMs: 100,
    ...over
  }
  const handlers: Record<string, Handler[]> = {}
  const registered: string[] = []
  const proven: string[] = []
  const host = {
    bus: {
      on(type: string, fn: Handler): () => void {
        ;(handlers[type] ??= []).push(fn)
        return () => void handlers[type]?.splice(handlers[type]!.indexOf(fn), 1)
      }
    },
    markProven(_b: BindingView, f: string): void {
      proven.push(f)
      if (!view.proven.includes(f)) view.proven = [...view.proven, f]
    },
    registerEventTypes(names: readonly string[]): void {
      registered.push(...names)
    },
    bindingForSid: (sid: string): BindingView | null => (sid === view.sid ? view : null),
    getBinding: (x: string): BindingView | null =>
      x === view.sid || x === view.sessionKey ? view : null,
    onBindingChange: (): (() => void) => () => undefined
  }
  const rollout: RolloutView = {
    enabled: true,
    cliGate: 'ok',
    families: { taskState: mode },
    allFolders: true,
    rampFolders: new Set()
  }
  const arbiter = createSessionArbiter({ host: host as never, rollout: () => rollout })
  const sends: Rig['sends'] = []
  const edges: Rig['edges'] = []
  const facts: Rig['facts'] = []
  const win = (() => ({
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, payload: Record<string, unknown>) =>
        void sends.push({ channel, payload })
    }
  })) as never
  const adapter = createTaskStateAdapter({
    host: host as never,
    ingest: (ev) => ingest(ev, win),
    currentState: getTaskState,
    recordFact: (source, sid, k, d, ts) => void facts.push({ source, sid, k, d, ts })
  })
  // the identity adapter (P1W3) re-keys the binding on a rebound; the host creates the task-state
  // adapter first, so its handler runs before this one, as it does in the app
  host.bus.on('event', ((_b: BindingView, ev: WireEvent): void => {
    if (ev.t === 'session.rebound') view.sid = (ev.d as { sid: string }).sid
  }) as Handler)
  configureHub({
    isHibernated: () => false,
    admit: (ev) =>
      admit(
        'taskState',
        ev.source === 'hook' ? 'legacy' : 'companion',
        ev.sessionId === view.sid ? arbiter.arbiterBinding(view) : null,
        rollout
      ),
    record: (ev: BridgeEvent) => adapter.observe(ev)
  })
  addTaskEventObserver((e) =>
    edges.push({ sessionId: e.sessionId, event: e.event, taskState: e.taskState, source: e.source })
  )
  let ts = 1_000
  let seq = 0
  const r: Rig = {
    view,
    rollout,
    adapter,
    sends,
    edges,
    facts,
    registered,
    proven,
    wire(t, d = {}, extra = {}) {
      const ev = { seq: ++seq, t, ts: ++ts * 1000, d, ...extra } as WireEvent
      for (const fn of handlers.event ?? [])
        (fn as (b: BindingView, e: WireEvent) => void)(view, ev)
    },
    legacy(event, matcher, sid = view.sid) {
      ingest({ sessionId: sid, event, matcher, ts: ++ts * 1000, source: 'hook' }, win)
    },
    lose() {
      view.lease = 'lost'
      for (const fn of handlers.lease ?? [])
        (fn as (b: BindingView, s: 'lost') => void)(view, 'lost')
    },
    end() {
      view.state = 'ended'
      for (const fn of handlers.end ?? []) (fn as (b: BindingView, why: string) => void)(view, 'x')
    },
    replay(trace) {
      for (const e of trace.wire)
        r.wire(e.t, e.d, {
          ...(e.turnId ? { turnId: e.turnId } : {}),
          ...(e.agentId ? { agentId: e.agentId } : {})
        })
    }
  }
  return r
}

/** What the renderer would have seen: the `claude:hook` payloads without the clock. */
const hookPayloads = (r: Rig): Record<string, unknown>[] =>
  r.sends
    .filter((s) => s.channel === 'claude:hook')
    .map((s) => ({ ...s.payload, ts: undefined, source: undefined }))

const proveAll = (r: Rig): void => {
  r.wire('session.snapshot', {
    reason: 'hello',
    activeTurnId: null,
    openAttention: [],
    runningSubagents: 0,
    probes: { classic: true, toolCheck: true }
  })
  r.wire('turn.started', { origin: 'human' }, { turnId: 't0' })
  r.wire(
    'turn.completed',
    { reason: 'answer', isAborted: false, backgroundSubagents: 0 },
    { turnId: 't0' }
  )
}

beforeEach(() => resetHubForTests())
afterEach(() => resetHubForTests())

describe('proof and registration', () => {
  it('registers the six event types it consumes', () => {
    const r = rig()
    expect(r.registered.sort()).toEqual(
      [
        'attention.cleared',
        'attention.raised',
        'subagent.started',
        'subagent.stopped',
        'turn.completed',
        'turn.started'
      ].sort()
    )
  })

  it('the first turn event proves sense.turn; a classic probe proves attention and subagent', () => {
    const r = rig()
    r.wire('turn.started', { origin: 'human' }, { turnId: 't1' })
    expect(r.proven).toEqual(['sense.turn'])
    r.wire('session.snapshot', {
      reason: 'probe',
      activeTurnId: 't1',
      openAttention: [],
      runningSubagents: 0,
      probes: { classic: true, toolCheck: false }
    })
    expect(r.proven.sort()).toEqual(['sense.attention', 'sense.subagent', 'sense.turn'])
  })

  it('a snapshot without the classic probe proves neither of the classic features', () => {
    const r = rig()
    r.wire('session.snapshot', {
      reason: 'hello',
      activeTurnId: null,
      openAttention: [],
      runningSubagents: 0,
      probes: { classic: false, toolCheck: false }
    })
    expect(r.proven).toEqual([])
  })

  it('proof is marked before the event is admitted: the proving event itself is applied', () => {
    const r = rig('active')
    r.wire('turn.started', { origin: 'human' }, { turnId: 't1' })
    // sense.attention and sense.subagent are still unproven: legacy owns. Prove them, then go.
    expect(r.edges).toEqual([])
    proveAll(r)
    r.wire('turn.started', { origin: 'human' }, { turnId: 't2' })
    expect(getTaskState(S1)).toBe('working')
  })
})

describe('owned by the companion', () => {
  let r: Rig
  beforeEach(() => {
    r = rig('active')
    proveAll(r)
    r.edges.length = 0
  })

  it('Esc ends working', () => {
    r.replay(esc)
    expect(getTaskState(S1)).toBe('idle')
    expect(r.edges.map((e) => [e.event, e.taskState, e.source])).toEqual([
      ['UserPromptSubmit', 'working', 'companion'],
      ['Stop', 'idle', 'companion']
    ])
  })

  it('subagent holds the turn', () => {
    r.wire('turn.started', { origin: 'human' }, { turnId: 't1' })
    r.wire('subagent.started', { agentType: 'general-purpose', agentId: 'a1' })
    r.wire(
      'turn.completed',
      { reason: 'answer', isAborted: false, backgroundTasks: 1, backgroundSubagents: 1 },
      { turnId: 't1' }
    )
    expect(getTaskState(S1)).toBe('working')
    r.wire('subagent.stopped', { agentType: 'general-purpose', agentId: 'a1' })
    expect(getTaskState(S1)).toBe('idle')
  })

  it('background shells do not hold', () => {
    r.wire('turn.started', { origin: 'human' }, { turnId: 't1' })
    r.wire(
      'turn.completed',
      { reason: 'answer', isAborted: false, backgroundTasks: 2, backgroundSubagents: 0 },
      { turnId: 't1' }
    )
    expect(getTaskState(S1)).toBe('idle')
  })

  it('check alone is not needs-input', () => {
    r.wire('turn.started', { origin: 'human' }, { turnId: 't1' })
    r.wire('attention.raised', {
      kind: 'permission',
      source: 'check',
      toolUseId: 'u1',
      tool: 'Bash'
    })
    expect(getTaskState(S1)).toBe('working')
    expect(r.edges.map((e) => e.event)).toEqual(['UserPromptSubmit'])
  })

  it('a request is needs-input and the tool settling is working again', () => {
    r.wire('turn.started', { origin: 'human' }, { turnId: 't1' })
    r.wire('attention.raised', { kind: 'permission', source: 'request', tool: 'Bash' })
    expect(getTaskState(S1)).toBe('needs-input')
    r.wire('attention.cleared', { kind: 'permission', cause: 'tool-settled' })
    expect(getTaskState(S1)).toBe('working')
  })

  it('every golden trace ends where it says, with the bridge events it lists', () => {
    for (const trace of FLEET_TRACES) {
      resetHubForTests()
      const x = rig('active')
      proveAll(x)
      x.edges.length = 0
      x.replay(trace)
      expect(x.edges.map((e) => e.event)).toEqual(trace.bridge.map((b) => b.event))
      expect(getTaskState(S1)).toBe(trace.final)
    }
  })

  it('a failed turn carries its classified reason to the renderer', () => {
    r.wire('turn.started', { origin: 'human' }, { turnId: 't1' })
    r.wire(
      'turn.completed',
      { reason: 'error', isAborted: false, failure: { type: 'overloaded' } },
      { turnId: 't1' }
    )
    const last = r.sends.at(-1)?.payload
    expect(last).toMatchObject({ taskState: 'failed', failureReason: 'overloaded' })
    expect((last as { resetsAt?: unknown }).resetsAt).toBeUndefined()
  })

  it('relies on the hub terminal edge', () => {
    r.wire('turn.started', { origin: 'human' }, { turnId: 't1' })
    // the mod's bye never arrives; the legacy SessionEnd does
    r.edges.length = 0
    r.legacy('SessionEnd', 'logout')
    expect(getTaskState(S1)).toBe('completed')
    expect(r.edges.map((e) => [e.event, e.source])).toEqual([['SessionEnd', 'hook']])
    // the adapter added nothing of its own
    expect(r.edges.length).toBe(1)
  })

  it('clear keeps the legacy edge order', async () => {
    r.wire('turn.started', { origin: 'human' }, { turnId: 't1' })
    r.edges.length = 0
    r.wire('session.rebound', { prevSid: S1, sid: S2, cause: 'clear' })
    await Promise.resolve() // the new half goes after the identity re-key
    expect(r.edges.map((e) => [e.sessionId, e.event, e.taskState, e.source])).toEqual([
      [S1, 'SessionEnd', 'idle', 'companion'],
      [S2, 'SessionStart', 'idle', 'companion']
    ])
  })

  it('lease loss falls back without a respawn', () => {
    r.wire('turn.started', { origin: 'human' }, { turnId: 't1' })
    expect(getTaskState(S1)).toBe('working')
    r.lose()
    r.edges.length = 0
    r.legacy('Stop')
    expect(getTaskState(S1)).toBe('idle')
    expect(r.edges.map((e) => [e.event, e.source])).toEqual([['Stop', 'hook']])
    // and a late companion event is not applied
    r.wire('turn.started', { origin: 'human' }, { turnId: 't2' })
    expect(getTaskState(S1)).toBe('idle')
  })

  it('kill switch mid-session', () => {
    r.wire('turn.started', { origin: 'human' }, { turnId: 't1' })
    r.rollout.enabled = false
    r.edges.length = 0
    r.wire('attention.raised', { kind: 'permission', source: 'request', tool: 'Bash' })
    r.legacy('Stop')
    expect(r.edges.map((e) => [e.event, e.source])).toEqual([['Stop', 'hook']])
    expect(getTaskState(S1)).toBe('idle')
  })

  it('a snapshot after a re-hello reconciles a lost turn.completed', () => {
    r.wire('turn.started', { origin: 'human' }, { turnId: 't1' })
    r.wire('session.snapshot', {
      reason: 'resync',
      activeTurnId: null,
      openAttention: [],
      runningSubagents: 0,
      probes: { classic: true, toolCheck: true }
    })
    expect(getTaskState(S1)).toBe('idle')
  })

  it('a snapshot with a running subagent keeps the parent working', () => {
    r.wire('turn.started', { origin: 'human' }, { turnId: 't1' })
    r.wire('session.snapshot', {
      reason: 'resync',
      activeTurnId: null,
      openAttention: [],
      runningSubagents: 1,
      probes: { classic: true, toolCheck: true }
    })
    expect(getTaskState(S1)).toBe('working')
    r.wire('subagent.stopped', { agentType: 'general-purpose', agentId: 'a1' })
    expect(getTaskState(S1)).toBe('idle')
  })

  it('an ended binding and a tick binding produce nothing', () => {
    r.end()
    r.edges.length = 0
    r.wire('turn.started', { origin: 'human' }, { turnId: 't9' })
    expect(r.edges).toEqual([])
    const t = rig('active', { owner: { kind: 'tick', workerId: 'w', runId: 'r' } })
    t.wire('turn.started', { origin: 'human' }, { turnId: 't1' })
    expect(t.edges).toEqual([])
  })

  it('a throwing hub never reaches the bus', () => {
    const x = rig('active')
    configureHub({
      admit: () => {
        throw new Error('boom')
      }
    })
    expect(() => x.wire('turn.started', { origin: 'human' }, { turnId: 't1' })).not.toThrow()
  })
})

describe('shadow', () => {
  it('shadow changes nothing', () => {
    // run A: the legacy hooks of the denied trace only
    const legacyOnly = (): Record<string, unknown>[] => {
      resetHubForTests()
      const a = rig('shadow')
      a.legacy('UserPromptSubmit')
      a.legacy('PermissionRequest')
      a.legacy('Notification', 'permission_prompt')
      return hookPayloads(a)
    }
    const want = legacyOnly()
    // run B: both sources, interleaved the way the real paths arrive (legacy is later)
    resetHubForTests()
    const b = rig('shadow')
    proveAll(b)
    const base = b.sends.length
    b.wire('turn.started', { origin: 'human' }, { turnId: 't1' })
    b.legacy('UserPromptSubmit')
    b.wire('attention.raised', { kind: 'permission', source: 'request', tool: 'Bash' })
    b.legacy('PermissionRequest')
    b.wire('attention.raised', { kind: 'permission', source: 'notification' })
    b.legacy('Notification', 'permission_prompt')
    b.wire(
      'turn.completed',
      { reason: 'answer', isAborted: false, backgroundSubagents: 0 },
      { turnId: 't1' }
    )
    const got = b.sends
      .slice(base)
      .filter((s) => s.channel === 'claude:hook')
      .map((s) => ({ ...s.payload, ts: undefined, source: undefined }))
    expect(got).toEqual(want)
    expect(getTaskState(S1)).toBe('needs-input') // the companion's Stop was only recorded
    // the ledger holds both timelines
    const states = (src: string): string[] =>
      b.facts.filter((f) => f.source === src && f.k.startsWith('state:')).map((f) => f.k)
    expect(states('legacy')).toEqual(['state:working', 'state:needs-input'])
    expect(states('companion').slice(-3)).toEqual([
      'state:working',
      'state:needs-input',
      'state:idle'
    ])
    void denied
  })
})

describe('shadow folds and the ledger', () => {
  it('records each state transition once per source, with the event that caused it', () => {
    const r = rig('shadow')
    r.legacy('UserPromptSubmit')
    r.legacy('PreToolUse')
    r.legacy('Stop')
    expect(r.facts.map((f) => [f.source, f.k, f.d?.ev, f.d?.m ?? null])).toEqual([
      ['legacy', 'state:working', 'UserPromptSubmit', null],
      ['legacy', 'state:idle', 'Stop', null]
    ])
  })

  it('a legacy event for a session the mod is not bound to records nothing', () => {
    const r = rig('shadow')
    r.legacy('UserPromptSubmit', undefined, S2)
    expect(r.facts).toEqual([])
  })

  it('a held completion leaves a hold fact the parity rule can read', () => {
    const r = rig('shadow')
    r.wire('turn.started', { origin: 'human' }, { turnId: 't1' })
    r.wire(
      'turn.completed',
      { reason: 'answer', isAborted: false, backgroundTasks: 1, backgroundSubagents: 1 },
      { turnId: 't1' }
    )
    expect(r.facts.some((f) => f.source === 'companion' && f.k === 'hold:subagent')).toBe(true)
  })

  it('the subagent trace leaves the companion fold idle at its end', () => {
    const r = rig('shadow')
    r.replay(backgroundSubagent)
    const last = r.facts.filter((f) => f.source === 'companion' && f.k.startsWith('state:')).at(-1)
    expect(last?.k).toBe('state:idle')
  })
})
