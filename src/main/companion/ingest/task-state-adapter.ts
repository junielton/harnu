/**
 * The task-state adapter (T389 P1W5 §7.2, §13). It subscribes to the fleet wire events of every
 * binding, runs the pure map (`task-state-map-core.ts`) and hands the result to the hub as
 * `source: 'companion'` BridgeEvents. The hub decides what happens to them (ARB-2): applied only
 * when the companion owns `taskState` for that session, recorded otherwise, never a second fold.
 * Electron-free: the hub's `ingest`, the folded state and the ledger are injected.
 *
 * Also here, because it needs the same events: the two SHADOW folds of the pure reducer, one per
 * source, fed by every BridgeEvent the hub sees (applied, dropped or record-only). Each state
 * transition is recorded as a parity fact (`state:<s>`), so the `taskState` rule can compare the
 * two timelines, in `shadow` and after the flip alike (ADR-0018 kill criterion 5).
 *
 * Nothing here holds or answers an approval (P3W1), and nothing sends a synthetic edge of its own:
 * a lost `bye` is the hub's terminal-edge rule (ARB-2d), a lost lease is legacy taking over.
 */

import type { FeatureId, WireEvent } from '../contract'
import type { CompanionHostFacade } from '../host-core'
import type { FactSource } from '../arbitration-core'
import { reduceTaskState, type TaskState } from '../../hook-state'
import type { BridgeEvent } from '../../detect/task-state-hub'
import type { BindingView } from '../session-table'
import { initialMapState, mapWire, type MapState } from './task-state-map-core'

export interface TaskStateAdapterDeps {
  host: Pick<CompanionHostFacade, 'bus' | 'markProven' | 'registerEventTypes' | 'bindingForSid'>
  /** The hub's `ingest`, with the window already bound. Must never throw to us. */
  ingest(ev: BridgeEvent): void
  /** The hub's folded state for a session, for the snapshot reconcile. */
  currentState(sid: string): TaskState | undefined
  /** One parity fact (`recordFact('taskState', …)`); `ts` is the source event time. */
  recordFact(
    source: FactSource,
    sid: string,
    k: string,
    d: Record<string, string | number | boolean | null>,
    ts?: number
  ): void
}

export interface TaskStateAdapter {
  /** Feed every BridgeEvent the hub saw, from either source. A no-op for a session with no binding. */
  observe(ev: BridgeEvent): void
  dispose(): void
}

/** The wire events this adapter consumes. `session.rebound`, `session.end` and `session.snapshot` are P1W3's types. */
export const TASK_STATE_EVENT_TYPES = [
  'turn.started',
  'turn.completed',
  'attention.raised',
  'attention.cleared',
  'subagent.started',
  'subagent.stopped'
] as const

const HANDLED: ReadonlySet<string> = new Set([
  ...TASK_STATE_EVENT_TYPES,
  'session.snapshot',
  'session.rebound',
  'session.end'
])

/** Proof of contract §11.2: the first turn event; `probes.classic` for the two classic features. */
function proofsFor(b: BindingView, ev: WireEvent): FeatureId[] {
  const out: FeatureId[] = []
  if (ev.t === 'turn.started' || ev.t === 'turn.completed') out.push('sense.turn')
  if (ev.t === 'session.snapshot') {
    const probes = (ev.d as { probes?: { classic?: unknown } }).probes
    if (probes?.classic === true) out.push('sense.attention', 'sense.subagent')
  }
  return out.filter((f) => b.enabled.includes(f) && !b.proven.includes(f))
}

export function createTaskStateAdapter(deps: TaskStateAdapterDeps): TaskStateAdapter {
  /** Per binding (the table's ordinal follows a re-key, never a sid). */
  const maps = new Map<number, MapState>()
  /** The two shadow folds, per sid. */
  const shadow = new Map<string, { legacy: TaskState; companion: TaskState }>()

  deps.host.registerEventTypes(TASK_STATE_EVENT_TYPES)

  function observe(ev: BridgeEvent): void {
    // a legacy event is worth a fact only for a session the mod is bound to (the ledger's rule)
    if (!deps.host.bindingForSid(ev.sessionId)) return
    const source: FactSource = ev.source === 'hook' ? 'legacy' : 'companion'
    const folds = shadow.get(ev.sessionId) ?? { legacy: 'idle', companion: 'idle' }
    const before = folds[source]
    const after = reduceTaskState(before, {
      hookEventName: ev.event,
      matcher: ev.matcher,
      sessionId: ev.sessionId
    })
    folds[source] = after
    shadow.set(ev.sessionId, folds)
    if (after === before) return
    deps.recordFact(
      source,
      ev.sessionId,
      `state:${after}`,
      { ev: ev.event, m: ev.matcher ?? null },
      ev.ts
    )
  }

  function onEvent(b: BindingView, ev: WireEvent): void {
    if (!HANDLED.has(ev.t) || b.owner?.kind !== 'pty') return
    // a `bye` ends the binding before it delivers its events: `session.end` is the one that matters
    if (b.state === 'closed' || (b.state === 'ended' && ev.t !== 'session.end')) return
    const d = (typeof ev.d === 'object' && ev.d !== null ? ev.d : {}) as Record<string, unknown>
    // proof first: the event that proves a feature may itself be applied (arbiter contract)
    for (const f of proofsFor(b, ev)) deps.host.markProven(b, f)
    const before = maps.get(b.key) ?? initialMapState()
    const { state, out } = mapWire(
      before,
      { t: ev.t, d, ...(ev.agentId !== undefined ? { agentId: ev.agentId } : {}) },
      { current: deps.currentState(b.sid) }
    )
    maps.set(b.key, state)
    if (state.heldIdle && !before.heldIdle) {
      // the hold is not a state transition, so it needs a fact of its own (rule class E2)
      deps.recordFact('companion', b.sid, 'hold:subagent', { n: state.runningSubagents }, ev.ts)
    }
    for (const m of out) {
      const toPrev = m.sid === 'prev' && typeof d.prevSid === 'string'
      const toCur = m.sid === 'cur' && typeof d.sid === 'string'
      const bridge: BridgeEvent = {
        sessionId: toPrev ? (d.prevSid as string) : toCur ? (d.sid as string) : b.sid,
        event: m.event,
        ...(m.matcher !== undefined ? { matcher: m.matcher } : {}),
        ts: ev.ts,
        ...(m.failureReason !== undefined ? { failureReason: m.failureReason } : {}),
        source: 'companion'
      }
      // The identity adapter re-keys the binding to the new sid inside this same bus emit. The
      // hub finds a binding by sid, so the old half of a `/clear` pair goes now (the binding still
      // answers to it) and the new half right after the re-key: the order is the legacy order.
      if (toCur) queueMicrotask(() => send(bridge))
      else send(bridge)
    }
  }

  function send(ev: BridgeEvent): void {
    try {
      deps.ingest(ev)
    } catch {
      // the hub guards its own faults; a throw here must never reach the host's bus
    }
  }

  const offs = [
    deps.host.bus.on('event', (b, ev) => {
      try {
        onEvent(b, ev)
      } catch {
        // an adapter fault reads as "the companion said nothing": legacy keeps driving
      }
    }),
    deps.host.bus.on('end', (b) => {
      maps.delete(b.key)
      shadow.delete(b.sid)
    })
  ]

  return {
    observe,
    dispose() {
      for (const off of offs) off()
    }
  }
}
