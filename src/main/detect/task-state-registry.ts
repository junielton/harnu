/**
 * The hook-driven task-state map, extracted as a framework-free core (ADR-0001,
 * mirroring `state-merge-core.ts` / `stickiness-core.ts` / `fleet-snapshot.ts`).
 *
 * It folds hook events into a per-session {@link TaskState} via the pure
 * {@link reduceTaskState} reducer and adds the missing **liveness axis** (T13 /
 * BUG-1 half b): the map is pruned when a process dies, and {@link liveSnapshot}
 * only surfaces states whose session still has a live PTY. The staleness axis is
 * "is the process alive", NOT "how long since the last event" — a time-based TTL
 * would wrongly hide a long build (`working`) or a 20-minute block (`needs-input`).
 *
 * `hook-bridge.ts` owns one instance; `pty.ts` drives `prune` on teardown and
 * `mcp/server.ts` supplies the `isLive` predicate at disclosure time.
 */
import { reduceTaskState, type HookEvent, type TaskState } from '../hook-state'

export class TaskStateRegistry {
  private map = new Map<string, TaskState>()
  /** Sessions whose current `needs-input` was raised by a subagent, not the main thread. */
  private agentBlocked = new Set<string>()

  /** Fold one hook event into the session's state and return the new state. */
  fold(sessionId: string, ev: HookEvent): TaskState {
    const current = this.map.get(sessionId) ?? 'idle'
    const next = reduceTaskState(current, {
      ...ev,
      blockRaisedByAgent: this.agentBlocked.has(sessionId)
    })
    this.map.set(sessionId, next)
    this.trackBlockOwner(sessionId, current, next, ev)
    return next
  }

  /**
   * Remember who raised a block, so a subagent's tool events can tell "my own approval went
   * through" (clears) from "the main thread is still on its dialog" (must not clear). A
   * `PermissionRequest` names its owner (`agent_id` or not); a Notification only adds the
   * attribution when it opens a block (`worker_permission_prompt` is a subagent's by definition).
   */
  private trackBlockOwner(
    sessionId: string,
    current: TaskState,
    next: TaskState,
    ev: HookEvent
  ): void {
    if (next !== 'needs-input') {
      this.agentBlocked.delete(sessionId)
      return
    }
    let byAgent: boolean
    if (ev.hookEventName === 'PermissionRequest') byAgent = ev.agentId !== undefined
    else if (current !== 'needs-input') byAgent = ev.matcher === 'worker_permission_prompt'
    else return // a repeat notice for a block already open keeps its owner
    if (byAgent) this.agentBlocked.add(sessionId)
    else this.agentBlocked.delete(sessionId)
  }

  /** Current folded state for a session, or undefined if none recorded. */
  get(sessionId: string): TaskState | undefined {
    return this.map.get(sessionId)
  }

  /** Drop a session's state (called when its PTY dies — the liveness prune). */
  prune(sessionId: string): void {
    this.map.delete(sessionId)
    this.agentBlocked.delete(sessionId)
  }

  /** The raw folded map (read-only view). */
  entries(): ReadonlyMap<string, TaskState> {
    return this.map
  }

  /** Only the states whose session still has a live process. */
  liveSnapshot(isLive: (sessionId: string) => boolean): Record<string, TaskState> {
    const out: Record<string, TaskState> = {}
    for (const [id, st] of this.map) if (isLive(id)) out[id] = st
    return out
  }
}
