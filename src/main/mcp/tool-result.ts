/**
 * The tiny, stateless `CallToolResult` shaping helpers shared by `server.ts`
 * (the confirm/park/actuate orchestration) and `tool-handlers.ts` (the per-op
 * handlers, T120) — extracted so neither module has to import the other
 * (`server.ts` imports `tool-handlers.ts` for `WIRED_TOOLS`; the reverse would
 * be a cycle).
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { shapeDenial } from './deny-hint'

/** Coerce an unknown tool-arg blob to a record for field plucking. */
export function asRecord(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}
}

/**
 * Whether a renderer-dispatch result (the `DispatchResult` a `CommandBridge`
 * round trip settles with) represents success — i.e. it carries no `error`
 * string field. Exists so a handler can never report the ACK's top-level `ok`
 * as `true` while `result` nests a failure (`{"ok":true,"result":{"error":
 * "FOLDER_NOT_FOUND"}}`) — an agent that trusts `ok` alone would believe the
 * call succeeded. See docs/lessons/code-patterns/004-ok-true-ack-must-not-carry-a-nested-error.md.
 */
export function dispatchSucceeded(result: unknown): boolean {
  const rec = asRecord(result)
  return typeof rec.error !== 'string'
}

/** A text-content tool result. */
export function textResult(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
}

/** An error tool result (`isError:true`) carrying a machine-readable reason. */
export function errorResult(reason: string): CallToolResult {
  return { content: [{ type: 'text', text: reason }], isError: true }
}

/**
 * Whether a FINAL `CallToolResult` (post-actuation) represents an action that
 * actually happened — the predicate `server.ts`'s grant-allowed mutation path
 * uses to decide whether to refund the reserved budget unit (this card, AC2).
 * `isError` is a failure outright; otherwise the JSON payload must parse to a
 * plain object with `ok === true`. A payload with no `ok` field (a read
 * handler that never sets one) is treated as success — only an explicit
 * `ok:false` (or an error result) should trigger a refund.
 */
export function ackIsSuccess(res: CallToolResult): boolean {
  if (res.isError) return false
  const first = res.content?.[0]
  if (!first || first.type !== 'text' || typeof first.text !== 'string') return true
  let parsed: unknown
  try {
    parsed = JSON.parse(first.text)
  } catch {
    return true
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return true
  return (parsed as Record<string, unknown>).ok !== false
}

/**
 * A denied tool result that STEERS (T44 Slice 1): if the gate reason has an
 * actionable hint, return it as a structured JSON error (`{error,message,
 * nextActions}`) so the agent can proceed or ask the operator precisely.
 * Otherwise fall back to the bare-reason error.
 */
export function steerError(
  result: string,
  folder: string | undefined,
  syntheticId?: string
): CallToolResult {
  const denial = shapeDenial(result, { folder, syntheticId })
  if (!denial) return errorResult(result)
  return { content: [{ type: 'text', text: JSON.stringify(denial) }], isError: true }
}
