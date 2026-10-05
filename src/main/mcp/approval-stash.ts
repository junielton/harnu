/**
 * T44 S4 async-approval stash: parked MCP mutation confirms the agent polls via
 * `get_approval`. Keyed by the confirm id. A parked confirm returns a `pending`
 * handle immediately (the operator was away); the human's eventual Allow actuates
 * the mutation server-side and flips the record to `allowed` (+ result) / `denied`.
 * Bounded (oldest evicted past the cap) so it never grows unbounded.
 *
 * T120: extracted from `server.ts` so the SAME map is reachable from both the
 * confirm-park flow (`parkMutationConfirm`, still in `server.ts`, which WRITES a
 * record whenever a confirm parks) and the `get_approval` tool's handler (now in
 * `tool-handlers.ts`, which READS a record by id) — without either module
 * importing the other.
 */

import type { ApprovalStatusResult } from './approval-status'

export interface StashRecord extends ApprovalStatusResult {
  tool: string
  folder: string
  ts: number
}

const APPROVAL_STASH_CAP = 64
const approvalStash = new Map<string, StashRecord>()

/** Insert/replace a stash entry, evicting the oldest once the cap is reached. */
export function stashApproval(id: string, rec: StashRecord): void {
  if (!approvalStash.has(id) && approvalStash.size >= APPROVAL_STASH_CAP) {
    const oldest = approvalStash.keys().next().value
    if (oldest !== undefined) approvalStash.delete(oldest)
  }
  approvalStash.set(id, rec)
}

/** Look up a parked approval by id (undefined if unknown/never parked). */
export function getStashedApproval(id: string): StashRecord | undefined {
  return approvalStash.get(id)
}
