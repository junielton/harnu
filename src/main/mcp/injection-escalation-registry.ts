/**
 * BUG-64 (part C) — surfaces a renderer-decided "prompt undelivered" verdict to
 * MCP. Before this, `markPromptUndelivered` (`sessions.ts`) only ever mutated
 * renderer Pinia state, and `inflightToFleetInputs` (`tool-handlers.ts`)
 * hardcodes `status: 'active'` for any unmaterialized session — so
 * `get_session`/`get_fleet` had no way to learn a session was stuck. T174's
 * live validation confirmed this: a session sitting dead, its pre-prompt never
 * delivered, was reported `status: "active"`, `inflight: true` for the entire
 * observation window (docs/reports/2026-07-20-orphan-spawn-postmortem.md).
 *
 * In-memory only, mirroring `inflight-session-registry.ts` /
 * `agent-inflight-registry.ts`: a renderer-reported fact about a PTY that no
 * longer exists after a restart is not worth resurrecting. Keyed by the
 * session id AS THE RENDERER KNOWS IT AT THE TIME OF THE PUSH — for the case
 * this exists to fix, that is always still the synthetic id (a session whose
 * prompt was truly never delivered never gains a transcript, so it never
 * migrates to a real uuid) — no rekey path is needed.
 *
 * `tool-handlers.ts` merges this into the fleet snapshot's `taskStates` (as
 * `'failed'`) and a new `failureReasons` map (the `reason` here), the exact
 * same two-field shape a genuinely hook-driven failure already uses — so an
 * MCP caller reads this the same way it reads any other failed session, no
 * new field to special-case.
 */

export type InjectionEscalationReason = 'prompt_undelivered'

export interface InjectionEscalationEntry {
  reason: InjectionEscalationReason
  at: number
}

const escalations = new Map<string, InjectionEscalationEntry>()

/** Record a renderer-reported delivery failure for `sessionId`. */
export function markInjectionEscalated(
  sessionId: string,
  reason: InjectionEscalationReason,
  at: number = Date.now()
): void {
  escalations.set(sessionId, { reason, at })
}

/**
 * Clear a previously-recorded escalation — the renderer's own recovery path
 * (`retryPromptInjection`) reports this the moment it clears the failed state,
 * so a retried-and-healthy session doesn't keep reporting `failed` forever.
 */
export function clearInjectionEscalation(sessionId: string): void {
  escalations.delete(sessionId)
}

/** Read-only view for `tool-handlers.ts`'s task-state / failure-reason merge. */
export function getInjectionEscalations(): ReadonlyMap<string, InjectionEscalationEntry> {
  return escalations
}

/** Test-only reset. */
export function _resetInjectionEscalations(): void {
  escalations.clear()
}
