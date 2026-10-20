/**
 * The newest hook a session's own SUBAGENTS fired (T547).
 *
 * A session that hands work to a subagent goes idle on the main thread while the
 * subagent keeps calling tools; every one of those hooks carries `agent_id` and
 * the PARENT's `session_id`. The task-state fold deliberately ignores that to
 * keep the parent's own state honest, but a mission needs it: a child that is
 * idle only because its helpers are running is not stalled.
 *
 * In-memory: after a restart only activity since then is known, which can only
 * make a helper look quieter than it is, never busier.
 */
const lastByParent = new Map<string, number>()

/** Bound on {@link lastByParent} — the oldest entry is dropped past it. */
const MAX_SESSIONS = 2000

/** Record a subagent hook of `sessionId` at `ts` (epoch ms); an older `ts` never wins. */
export function noteSubagentActivity(sessionId: string, ts: number): void {
  const prev = lastByParent.get(sessionId)
  lastByParent.delete(sessionId) // re-insert last: Map order = recency
  lastByParent.set(sessionId, prev !== undefined && prev > ts ? prev : ts)
  if (lastByParent.size > MAX_SESSIONS) {
    const oldest = lastByParent.keys().next().value
    if (oldest !== undefined) lastByParent.delete(oldest)
  }
}

/** Epoch ms of the session's newest subagent hook, or `undefined` when none was seen. */
export function lastSubagentActivity(sessionId: string): number | undefined {
  return lastByParent.get(sessionId)
}

export function resetSubagentActivityForTests(): void {
  lastByParent.clear()
}
