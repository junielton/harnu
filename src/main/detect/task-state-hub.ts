/**
 * The task-state hub (T389 P1W4 §7.4): the fold of per-session task state and its fan-out,
 * extracted from `hook-bridge.ts` so a second source can feed the same fold. Every consumer of
 * task state (the renderer's `claude:hook`, the four in-main observers, `getTaskStates`,
 * `hooks:stateFor`) keeps reading it from here, whichever source wrote it (ARB-5).
 *
 * `hook-bridge.ts` keeps `handleBridgeEvent` as a one-line delegate that stamps `source: 'hook'`
 * and re-exports the public surface, so no importer changes.
 */
import type { BrowserWindow } from 'electron'
import type { Admit } from '../companion/arbitration-core'
import { type FailureReason, type TaskState } from '../hook-state'
import { isHibernated } from '../hibernation'
import { TaskStateRegistry } from './task-state-registry'

export interface BridgeEvent {
  sessionId: string
  event: string
  matcher?: string
  ts: number
  /** Only on StopFailure: the classified `error_type`. */
  failureReason?: FailureReason
  /** Only on StopFailure: the rate-limit reset, normalized to epoch-ms. */
  resetsAt?: number
  /** Claude Code's `agent_id`: set only for a hook fired by a subagent's own tool call. */
  agentId?: string
  /** Which writer produced the event. */
  source: 'hook' | 'companion'
}

// Per-session task-state, folded in main so the renderer never imports the
// reducer from src/main — the store just applies the resolved state. The
// registry adds the liveness axis (T13): `pruneTaskState` drops a dead session's
// state and the MCP disclosure filters to live sessions only.
let registry = new TaskStateRegistry()

export type Disposition = 'applied' | 'record-only' | 'dropped'

export interface HubDeps {
  /** The T178 row #8 guard: a parked session's events are dropped before anything else. */
  isHibernated(sessionId: string): boolean
  /** What the arbiter says about this event. The default applies every hook event. */
  admit(ev: BridgeEvent): Admit
  /** The parity ledger's hook; the shell decides which events are worth a record. */
  record(ev: BridgeEvent, disposition: Disposition): void
}

const defaultDeps: HubDeps = {
  isHibernated,
  admit: (ev) => (ev.source === 'hook' ? 'apply' : 'record-only'),
  record: () => undefined
}
let deps: HubDeps = defaultDeps

/** Wired once by `companion/host.ts`; with no wiring the hub behaves exactly as it did in the bridge. */
export function configureHub(next: Partial<HubDeps>): void {
  deps = { ...deps, ...next }
}

/** Sessions whose terminal edge (a non-`clear` SessionEnd) was already admitted (ARB-2d). */
const ended = new Set<string>()

export function resetHubForTests(): void {
  deps = defaultDeps
  registry = new TaskStateRegistry()
  ended.clear()
  taskEventObservers.clear()
}

/**
 * Read-only view of the per-session hook FSM state. Exposed so the MCP server
 * (`mcp/server.ts`) can fold the same sidebar-dot truth into the redacted fleet
 * snapshot it discloses to agents. Returns the LIVE map (read-only typed) — the
 * caller iterates it into a plain record; it must never mutate it.
 */
export function getTaskStates(): ReadonlyMap<string, TaskState> {
  return registry.entries()
}

/** The folded state of one session, for `hooks:stateFor` (the synth→real migration resync). */
export function getTaskState(sessionId: string): TaskState | undefined {
  return registry.get(sessionId)
}

/**
 * Drop a session's folded hook state — called by `pty.ts` on every PTY teardown
 * (`onExit` / `pty:destroy` / `killAllPtys`) so a dead session stops being
 * disclosed as `working`/`needs-input` and the map can't grow unbounded (T13/BUG-1).
 */
export function pruneTaskState(sessionId: string): void {
  registry.prune(sessionId)
  ended.delete(sessionId)
}

/**
 * A folded per-session task-state edge, forwarded to in-main observers (T79 S2). DISTINCT from
 * the renderer `claude:hook` wire: observers run inside the main process, so a feature (the
 * auto-digest engine) can react to a session going idle / ending WITHOUT round-tripping through
 * the renderer — and thus survive a renderer reload, like the hook bridge itself.
 */
export interface HookTaskEvent {
  sessionId: string
  /** The folded state AFTER this event (`reduceTaskState`). */
  taskState: TaskState
  /** The raw hook event name (`Stop`, `SessionEnd`, `UserPromptSubmit`, …). */
  event: string
  /** Event timestamp (epoch ms). */
  ts: number
  /** Only when `taskState === 'failed'` (BUG-54 terminal ledger): the classified reason. */
  failureReason?: FailureReason
  /** Only when `taskState === 'failed'`: the rate-limit reset, epoch-ms. */
  resetsAt?: number
  /** Which writer produced the event (additive). */
  source?: 'hook' | 'companion'
}

/** In-main observers of the folded task-state edge (T79 S2 digest engine, …). */
type TaskEventObserver = (ev: HookTaskEvent) => void
const taskEventObservers = new Set<TaskEventObserver>()

/**
 * Subscribe to the folded per-session task-state edge in the MAIN process (T79 S2). Returns an
 * unsubscribe. An observer that throws is swallowed so it can never break the hook fold or the
 * renderer forward. Multiple observers are supported; each receives every event.
 */
export function addTaskEventObserver(cb: TaskEventObserver): () => void {
  taskEventObservers.add(cb)
  return () => {
    taskEventObservers.delete(cb)
  }
}

/** Never throws: an arbiter failure reads "legacy decides" (SEC-1). */
function admitSafely(ev: BridgeEvent): Admit {
  try {
    return deps.admit(ev)
  } catch {
    return ev.source === 'hook' ? 'apply' : 'drop'
  }
}

function recordSafely(ev: BridgeEvent, disposition: Disposition): void {
  try {
    deps.record(ev, disposition)
  } catch {
    // the ledger is evidence, never a dependency of the fold
  }
}

/**
 * A dropped legacy event for an owned session is still a sign of life: `claude:liveness` makes
 * the renderer bump its `lastEvent` anchor, so the stuck timer is not starved (ARB-2b).
 */
export function noteLiveness(
  sessionId: string,
  ts: number,
  getWindow: () => BrowserWindow | null
): void {
  const win = getWindow()
  if (win && !win.isDestroyed()) win.webContents.send('claude:liveness', { sessionId, ts })
}

const isTerminalEdge = (ev: BridgeEvent): boolean =>
  ev.event === 'SessionEnd' && ev.matcher !== 'clear'

/**
 * Fold an event into the per-session task-state FSM and fan it out to in-main observers + the
 * renderer — UNLESS the session is parked (T178 row #8, the one surface in the audit needing a
 * real new guard): a `Stop`/`SessionEnd` POSTed by a dying (or already-dead) process can land
 * AFTER the kill and, unguarded, both notify and re-animate a parked row's `taskState`. Guarded
 * in MAIN (not the renderer) — beside the existing `pruneTaskState` convention — so the MCP
 * disclosure (`getTaskStates`) and the in-main digest observers (`addTaskEventObserver`) see the
 * same truth as the renderer.
 *
 * Then the arbiter's say (ARB-2): an event the arbiter does not admit is recorded and never
 * applied. The terminal edge is the one exception (ARB-2d): a lost `bye` must not swallow the
 * edge the in-main observers depend on, so the first non-`clear` SessionEnd of a session is
 * admitted from either source and later ones are dropped. A companion event is never applied
 * outside `active`, the terminal edge included: it selects one event, it merges no value.
 */
export function ingest(ev: BridgeEvent, getWindow: () => BrowserWindow | null): void {
  if (deps.isHibernated(ev.sessionId)) return
  let verdict = admitSafely(ev)
  if (isTerminalEdge(ev)) {
    const eligible = ev.source === 'hook' || verdict === 'apply'
    if (!eligible) {
      recordSafely(ev, verdict === 'drop' ? 'dropped' : 'record-only')
      return
    }
    if (ended.has(ev.sessionId)) {
      recordSafely(ev, 'dropped')
      if (ev.source === 'hook') noteLiveness(ev.sessionId, ev.ts, getWindow)
      return
    }
    ended.add(ev.sessionId)
    verdict = 'apply'
  }
  if (verdict !== 'apply') {
    recordSafely(ev, verdict === 'drop' ? 'dropped' : 'record-only')
    if (ev.source === 'hook') noteLiveness(ev.sessionId, ev.ts, getWindow)
    return
  }
  recordSafely(ev, 'applied')
  const next = registry.fold(ev.sessionId, {
    hookEventName: ev.event,
    matcher: ev.matcher,
    sessionId: ev.sessionId,
    ...(ev.agentId !== undefined ? { agentId: ev.agentId } : {})
  })
  // T79 S2: forward the folded edge to in-main observers (the auto-digest
  // engine) BEFORE the renderer send. An observer throw never breaks the fold.
  const failure =
    next === 'failed' ? { failureReason: ev.failureReason ?? 'unknown', resetsAt: ev.resetsAt } : {}
  if (taskEventObservers.size > 0) {
    const edge: HookTaskEvent = {
      sessionId: ev.sessionId,
      taskState: next,
      event: ev.event,
      ts: ev.ts,
      ...failure,
      source: ev.source
    }
    for (const obs of taskEventObservers) {
      try {
        obs(edge)
      } catch (err) {
        console.error('[hook-bridge] task-event observer threw', err)
      }
    }
  }
  const win = getWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send('claude:hook', {
      sessionId: ev.sessionId,
      taskState: next,
      event: ev.event,
      ts: ev.ts,
      ...failure,
      source: ev.source
    })
  }
}
