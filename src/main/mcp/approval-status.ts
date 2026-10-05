/**
 * Pure status mapping for the T44 S4 async-approval `get_approval` read tool.
 *
 * When an MCP mutation confirm PARKS (the operator was away), the server returns
 * a `pending` handle and stashes the request. The agent polls `get_approval` to
 * learn the disposition; when the human eventually answers, the confirm settles
 * and the mutation actuates server-side. This module is the framework-free
 * outcome→status projection (ADR-0001 pure core); the stash Map + TTL eviction
 * live in the env shell (`server.ts`).
 */

import type { ConfirmOutcome } from './confirm-core'

/** The disposition the agent sees for a parked approval. */
export type ApprovalStatus = 'pending' | 'allowed' | 'denied' | 'unknown'

/** The `get_approval` result wire. `result` on allowed, `reason` on denied. */
export interface ApprovalStatusResult {
  status: ApprovalStatus
  /** The mutation's result payload — present only when `allowed`. */
  result?: unknown
  /** The fail-closed / human reason — present only when `denied`. */
  reason?: string
}

/**
 * Project a SETTLED confirm outcome into the agent-facing status. `allow` (only
 * ever from an explicit human RESPONDED) → `allowed` (+ the mutation result);
 * every deny (human or fail-closed) → `denied` (+ the reason). Never returns
 * `pending`/`unknown` — those are stash states the shell owns.
 */
export function outcomeToStatus(outcome: ConfirmOutcome, result?: unknown): ApprovalStatusResult {
  if (outcome.verdict === 'allow') {
    return result !== undefined ? { status: 'allowed', result } : { status: 'allowed' }
  }
  return { status: 'denied', reason: outcome.reason }
}
