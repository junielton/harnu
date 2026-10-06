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
  /** Which writer produced the event. */
  source: 'hook' | 'companion'
}

// Per-session task-state, folded in main so the renderer never imports the
// reducer from src/main — the store just applies the resolved state. The
// registry adds the liveness axis (T13): `pruneTaskState` drops a dead session's
// state and the MCP disclosure filters to live sessions only.
const registry = new TaskStateRegistry()

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

/**
 * Fold an event into the per-session task-state FSM and fan it out to in-main observers + the
 * renderer — UNLESS the session is parked (T178 row #8, the one surface in the audit needing a
 * real new guard): a `Stop`/`SessionEnd` POSTed by a dying (or already-dead) process can land
 * AFTER the kill and, unguarded, both notify and re-animate a parked row's `taskState`. Guarded
 * in MAIN (not the renderer) — beside the existing `pruneTaskState` convention — so the MCP
 * disclosure (`getTaskStates`) and the in-main digest observers (`addTaskEventObserver`) see the
 * same truth as the renderer.
 */
export function ingest(ev: BridgeEvent, getWindow: () => BrowserWindow | null): void {
  if (isHibernated(ev.sessionId)) return
  const next = registry.fold(ev.sessionId, {
    hookEventName: ev.event,
    matcher: ev.matcher,
    sessionId: ev.sessionId
  })
  // T79 S2: forward the folded edge to in-main observers (the auto-digest
  // engine) BEFORE the renderer send. An observer throw never breaks the fold.
  if (taskEventObservers.size > 0) {
    const edge: HookTaskEvent = {
      sessionId: ev.sessionId,
      taskState: next,
      event: ev.event,
      ts: ev.ts,
      ...(next === 'failed'
        ? { failureReason: ev.failureReason ?? 'unknown', resetsAt: ev.resetsAt }
        : {})
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
      ...(next === 'failed'
        ? { failureReason: ev.failureReason ?? 'unknown', resetsAt: ev.resetsAt }
        : {})
    })
  }
}
