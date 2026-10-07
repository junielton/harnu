import { describe, expect, it } from 'vitest'
import { FLEET_TRACES } from '../../resources/companion/tests/fixtures/fleet/traces'
import { reduceTaskState, type TaskState } from '../../src/main/hook-state'
import {
  initialMapState,
  mapWire,
  type MapState,
  type MappedEvent,
  type WireIn
} from '../../src/main/companion/ingest/task-state-map-core'

const w = (t: string, d: Record<string, unknown> = {}, extra: Partial<WireIn> = {}): WireIn =>
  ({ t, d, ...extra }) as WireIn

/** Folds mapped events the way the hub does, starting from `from`. */
function fold(from: TaskState, out: readonly MappedEvent[]): TaskState {
  let s = from
  for (const o of out)
    s = reduceTaskState(s, { hookEventName: o.event, matcher: o.matcher, sessionId: 's' })
  return s
}

const ev = (o: MappedEvent[]): { event: string; matcher?: string }[] =>
  o.map((x) => ({ event: x.event, ...(x.matcher !== undefined ? { matcher: x.matcher } : {}) }))

describe('wire to hook vocabulary', () => {
  const held: MapState = { ...initialMapState(), heldIdle: true, runningSubagents: 1 }

  const rows: {
    name: string
    wire: WireIn
    state?: MapState
    current?: TaskState
    out: { event: string; matcher?: string }[]
    folded: TaskState
  }[] = [
    {
      name: 'turn.started (main)',
      wire: w('turn.started', { origin: 'human' }),
      out: [{ event: 'UserPromptSubmit' }],
      folded: 'working'
    },
    {
      name: 'attention.raised check is recorded, not folded',
      wire: w('attention.raised', { kind: 'permission', source: 'check', toolUseId: 'u1' }),
      current: 'working',
      out: [],
      folded: 'working'
    },
    {
      name: 'attention.raised permission request',
      wire: w('attention.raised', { kind: 'permission', source: 'request' }),
      out: [{ event: 'PermissionRequest' }],
      folded: 'needs-input'
    },
    {
      name: 'attention.raised permission notification',
      wire: w('attention.raised', { kind: 'permission', source: 'notification' }),
      out: [{ event: 'Notification', matcher: 'permission_prompt' }],
      folded: 'needs-input'
    },
    {
      name: 'attention.raised input',
      wire: w('attention.raised', { kind: 'input', source: 'notification' }),
      out: [{ event: 'Notification', matcher: 'elicitation_dialog' }],
      folded: 'needs-input'
    },
    {
      name: 'attention.raised idle',
      wire: w('attention.raised', { kind: 'idle', source: 'notification' }),
      current: 'working',
      out: [{ event: 'Notification', matcher: 'idle_prompt' }],
      folded: 'idle'
    },
    {
      name: 'attention.cleared tool-settled',
      wire: w('attention.cleared', { kind: 'permission', cause: 'tool-settled' }),
      current: 'needs-input',
      out: [{ event: 'PostToolUse' }],
      folded: 'working'
    },
    {
      name: 'attention.cleared ask-resolved',
      wire: w('attention.cleared', { kind: 'permission', cause: 'ask-resolved' }),
      current: 'needs-input',
      out: [{ event: 'PostToolUse' }],
      folded: 'working'
    },
    {
      name: 'attention.cleared turn-completed',
      wire: w('attention.cleared', { kind: 'permission', cause: 'turn-completed' }),
      current: 'needs-input',
      out: [],
      folded: 'needs-input'
    },
    {
      name: 'attention.cleared prompt',
      wire: w('attention.cleared', { kind: 'idle', cause: 'prompt' }),
      current: 'idle',
      out: [],
      folded: 'idle'
    },
    {
      name: 'turn.completed main, error',
      wire: w('turn.completed', {
        reason: 'error',
        isAborted: false,
        failure: { type: 'rate_limit' }
      }),
      current: 'working',
      out: [{ event: 'StopFailure' }],
      folded: 'failed'
    },
    {
      name: 'turn.completed main, answer',
      wire: w('turn.completed', { reason: 'answer', isAborted: false, backgroundSubagents: 0 }),
      current: 'working',
      out: [{ event: 'Stop' }],
      folded: 'idle'
    },
    {
      name: 'turn.completed main, aborted',
      wire: w('turn.completed', { reason: 'aborted', isAborted: true }),
      current: 'needs-input',
      out: [{ event: 'Stop' }],
      folded: 'idle'
    },
    {
      name: 'turn.completed main, a subagent held',
      wire: w('turn.completed', { reason: 'answer', isAborted: false, backgroundSubagents: 1 }),
      current: 'working',
      out: [],
      folded: 'working'
    },
    {
      name: 'subagent.stopped, last one, held, no turn',
      wire: w('subagent.stopped', { agentType: 'general-purpose', agentId: 'a1' }),
      state: held,
      current: 'working',
      out: [{ event: 'Stop' }],
      folded: 'idle'
    },
    {
      name: 'turn.completed with agentId',
      wire: w('turn.completed', { reason: 'answer', isAborted: false }, { agentId: 'a1' }),
      current: 'working',
      out: [],
      folded: 'working'
    },
    {
      name: 'subagent.started',
      wire: w('subagent.started', { agentType: 'general-purpose', agentId: 'a1' }),
      current: 'working',
      out: [],
      folded: 'working'
    },
    {
      name: 'session.rebound clear',
      wire: w('session.rebound', { prevSid: 'old', sid: 'new', cause: 'clear' }),
      current: 'working',
      out: [
        { event: 'SessionEnd', matcher: 'clear' },
        { event: 'SessionStart', matcher: 'clear' }
      ],
      folded: 'idle'
    },
    {
      name: 'session.rebound resume',
      wire: w('session.rebound', { prevSid: 'old', sid: 'new', cause: 'resume' }),
      current: 'working',
      out: [{ event: 'SessionStart', matcher: 'resume' }],
      folded: 'idle'
    },
    {
      name: 'session.end',
      wire: w('session.end', { reason: 'logout' }),
      current: 'idle',
      out: [{ event: 'SessionEnd', matcher: 'logout' }],
      folded: 'completed'
    }
  ]

  for (const r of rows) {
    it(r.name, () => {
      const { out } = mapWire(r.state ?? initialMapState(), r.wire, { current: r.current })
      expect(ev(out)).toEqual(r.out)
      expect(fold(r.current ?? 'idle', out)).toBe(r.folded)
    })
  }

  it('the clear pair names the old sid first and the new sid second', () => {
    const { out } = mapWire(
      initialMapState(),
      w('session.rebound', { prevSid: 'old', sid: 'new', cause: 'clear' }),
      { current: 'idle' }
    )
    expect(out.map((o) => o.sid)).toEqual(['prev', 'cur'])
  })

  it('failureReason follows classifyFailure: known types keep their badge, the rest is unknown', () => {
    const f = (type: unknown): string | undefined =>
      mapWire(
        initialMapState(),
        w('turn.completed', { reason: 'error', isAborted: false, failure: { type } }),
        { current: 'working' }
      ).out[0]?.failureReason
    expect(f('rate_limit')).toBe('rate_limit')
    expect(f('overloaded')).toBe('overloaded')
    expect(f('billing_error')).toBe('billing_error')
    expect(f('server_error')).toBe('unknown')
    expect(f(undefined)).toBe('unknown')
    const none = mapWire(
      initialMapState(),
      w('turn.completed', { reason: 'error', isAborted: false }),
      { current: 'working' }
    )
    expect(none.out[0]?.failureReason).toBe('unknown')
  })
})

describe('subagents hold, other background work does not', () => {
  it('a main turn with backgroundTasks 2 and backgroundSubagents 0 is idle', () => {
    const { out } = mapWire(
      initialMapState(),
      w('turn.completed', {
        reason: 'answer',
        isAborted: false,
        backgroundTasks: 2,
        backgroundSubagents: 0
      }),
      { current: 'working' }
    )
    expect(ev(out)).toEqual([{ event: 'Stop' }])
  })

  it('the hold ends with the last subagent, not before', () => {
    let st = initialMapState()
    const run = (wire: WireIn, current: TaskState): MappedEvent[] => {
      const r = mapWire(st, wire, { current })
      st = r.state
      return r.out
    }
    run(w('turn.started', { origin: 'human' }), 'idle')
    run(w('subagent.started', { agentType: 'x', agentId: 'a1' }), 'working')
    run(w('subagent.started', { agentType: 'x', agentId: 'a2' }), 'working')
    expect(
      run(
        w('turn.completed', { reason: 'answer', isAborted: false, backgroundSubagents: 2 }),
        'working'
      )
    ).toEqual([])
    expect(st.heldIdle).toBe(true)
    expect(run(w('subagent.stopped', { agentType: 'x', agentId: 'a1' }), 'working')).toEqual([])
    expect(ev(run(w('subagent.stopped', { agentType: 'x', agentId: 'a2' }), 'working'))).toEqual([
      { event: 'Stop' }
    ])
    expect(st.heldIdle).toBe(false)
  })

  it('the next turn clears the hold and a later subagent stop emits nothing', () => {
    let st: MapState = { ...initialMapState(), heldIdle: true, runningSubagents: 1 }
    const a = mapWire(st, w('turn.started', { origin: 'unknown' }), { current: 'working' })
    st = a.state
    expect(st.heldIdle).toBe(false)
    expect(st.turnActive).toBe(true)
    const b = mapWire(st, w('subagent.stopped', { agentType: 'x', agentId: 'a1' }), {
      current: 'working'
    })
    expect(b.out).toEqual([]) // a turn is active: it ends the state, not the stop
  })

  it('idle_prompt is ignored while a subagent is held (OQ-a)', () => {
    const held: MapState = { ...initialMapState(), heldIdle: true, runningSubagents: 1 }
    const { out } = mapWire(held, w('attention.raised', { kind: 'idle', source: 'notification' }), {
      current: 'working'
    })
    expect(out).toEqual([])
  })

  it('counters are untrusted: clamped to [0, 256]', () => {
    let st = initialMapState()
    for (let i = 0; i < 300; i++) {
      st = mapWire(st, w('subagent.started', { agentType: 'x' }), { current: 'working' }).state
    }
    expect(st.runningSubagents).toBe(256)
    const huge = mapWire(
      initialMapState(),
      w('turn.completed', { reason: 'answer', isAborted: false, backgroundSubagents: 1e9 }),
      { current: 'working' }
    )
    expect(huge.state.runningSubagents).toBe(256)
    const down = mapWire(initialMapState(), w('subagent.stopped', { agentType: 'x' }), {
      current: 'working'
    })
    expect(down.state.runningSubagents).toBe(0)
  })
})

describe('session.snapshot reconciles', () => {
  const snap = (over: Record<string, unknown>): WireIn =>
    w('session.snapshot', {
      reason: 'resync',
      activeTurnId: null,
      openAttention: [],
      runningSubagents: 0,
      probes: { classic: true, toolCheck: true },
      ...over
    })

  it('an active turn with the state not working becomes UserPromptSubmit', () => {
    const { out } = mapWire(initialMapState(), snap({ activeTurnId: 't1' }), { current: 'idle' })
    expect(ev(out)).toEqual([{ event: 'UserPromptSubmit' }])
  })

  it('an active turn while needs-input stays as it is', () => {
    const { out } = mapWire(initialMapState(), snap({ activeTurnId: 't1' }), {
      current: 'needs-input'
    })
    expect(out).toEqual([])
  })

  it('no turn and working and not held becomes Stop', () => {
    const { out } = mapWire(initialMapState(), snap({}), { current: 'working' })
    expect(ev(out)).toEqual([{ event: 'Stop' }])
  })

  it('no turn, working and a subagent running stays held', () => {
    const { out, state } = mapWire(initialMapState(), snap({ runningSubagents: 1 }), {
      current: 'working'
    })
    expect(out).toEqual([])
    expect(state.runningSubagents).toBe(1)
  })

  it('a held turn whose subagent count dropped to zero releases', () => {
    const held: MapState = { ...initialMapState(), heldIdle: true, runningSubagents: 1 }
    const { out, state } = mapWire(held, snap({ runningSubagents: 0 }), { current: 'working' })
    expect(ev(out)).toEqual([{ event: 'Stop' }])
    expect(state.heldIdle).toBe(false)
  })

  it('a snapshot with a state of idle and no turn emits nothing', () => {
    expect(mapWire(initialMapState(), snap({}), { current: 'idle' }).out).toEqual([])
  })
})

describe('the golden traces', () => {
  for (const trace of FLEET_TRACES) {
    it(`${trace.name}: wire to bridge to folded state`, () => {
      let st = initialMapState()
      let cur: TaskState = 'idle'
      const out: MappedEvent[] = []
      for (const e of trace.wire) {
        const r = mapWire(st, w(e.t, e.d, { agentId: e.agentId } as Partial<WireIn>), {
          current: cur
        })
        st = r.state
        out.push(...r.out)
        cur = fold(cur, r.out)
      }
      expect(ev(out)).toEqual(trace.bridge)
      expect(cur).toBe(trace.final)
    })
  }
})
