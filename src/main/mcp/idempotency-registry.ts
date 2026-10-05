/**
 * In-memory idempotency registry for mutating MCP tool calls (BUG-33 §3.1).
 *
 * The 120s server-side deadline (`deadline.ts`) resolves a `TOOL_TIMEOUT`
 * without cancelling the underlying handler — a call that was merely SLOW
 * keeps running and may complete its mutation after the client already got
 * the error and retried. Without this registry, that retry re-actuates the
 * SAME intent a second time (a duplicate `create_session`, a duplicate
 * board write, …).
 *
 * Every mutating call derives a stable `callId` (verb + normalized folder +
 * either a caller-supplied `idempotencyKey` or a hash of the args). A call
 * whose `callId` is already `in-flight` or already `applied` returns the
 * recorded outcome instead of actuating a second time — see `server.ts`'s
 * `actuate()`, the ONE call site that consults this registry.
 *
 * A call whose `callId` is recorded as `failed` is the ONE exception (BUG-57):
 * it is NOT replayed. A failure applied nothing durable, so replaying it for
 * the full TTL would turn a transient hiccup (e.g. `SPAWN_NOT_MATERIALIZED`)
 * into a guaranteed 10-minute dead end for an agent that correctly retries
 * with identical args. An identical retry re-actuates for real instead.
 *
 * IN-MEMORY ONLY (like the grant/inherit-once registries): a capability
 * surviving a restart is not the goal here, only surviving the retry window.
 * The TTL is comfortably above the tool deadline so a genuinely late
 * completion still lands before its entry expires.
 */

import { createHash } from 'node:crypto'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { McpOp } from './tool-catalog'

/** How long a callId's outcome is remembered — well above the 120s tool deadline. */
export const IDEMPOTENCY_TTL_MS = 10 * 60_000

export type CallStatus = 'in-flight' | 'applied' | 'failed'

interface RegistryEntry {
  status: CallStatus
  result?: CallToolResult
  expiresAt: number
}

/** What {@link beginCall} returns when `callId` is already known — dedupe, don't actuate. */
export interface ExistingCall {
  status: CallStatus
  result?: CallToolResult
}

const registry = new Map<string, RegistryEntry>()

/** Key-sorted JSON stringify so arg key order never changes the derived id. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const rec = value as Record<string, unknown>
    const keys = Object.keys(rec).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(rec[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * Derive a stable call id for a mutating verb: verb + normalized folder + a
 * caller-supplied `idempotencyKey` when present, else a hash of the
 * normalized args. Deterministic — the SAME retry of the SAME intent always
 * derives the SAME id, so {@link beginCall} recognizes it. Client-supplied
 * keys are honored but never required; an agent should not have to opt in to
 * correctness.
 */
export function deriveCallId(
  op: McpOp | string,
  folder: string,
  args: unknown,
  idempotencyKey?: string
): string {
  const basis = idempotencyKey ? `key:${idempotencyKey}` : `args:${stableStringify(args)}`
  const hash = createHash('sha256').update(`${op}\n${folder}\n${basis}`).digest('hex').slice(0, 24)
  return `${op}:${hash}`
}

/**
 * Begin a call: if `callId` is unknown (or its previous entry expired), marks
 * it `in-flight` and returns `undefined` — the caller proceeds to actuate. If
 * it is already known and live with status `in-flight` or `applied`, returns
 * its current outcome WITHOUT mutating state — the caller must not actuate a
 * second time (BUG-33 AC1): an `in-flight` retry gets a "still running"
 * signal, an `applied` retry replays the recorded {@link CallToolResult}.
 *
 * A `failed` entry is the BUG-57 exception: it is re-armed as `in-flight` and
 * `undefined` is returned so the caller actuates again for real, exactly as
 * if `callId` had never been seen — a recorded failure must not poison its
 * own retry. `peekCallStatus` lets the caller (`server.ts`) tell this case
 * apart from a genuinely first-time call for audit purposes, without this
 * function's own return contract needing to carry that distinction.
 */
export function beginCall(callId: string, now: number = Date.now()): ExistingCall | undefined {
  const existing = registry.get(callId)
  if (existing && existing.expiresAt > now) {
    if (existing.status === 'failed') {
      registry.set(callId, { status: 'in-flight', expiresAt: now + IDEMPOTENCY_TTL_MS })
      return undefined
    }
    return { status: existing.status, result: existing.result }
  }
  registry.set(callId, { status: 'in-flight', expiresAt: now + IDEMPOTENCY_TTL_MS })
  return undefined
}

/**
 * Read-only peek: does `callId` currently hold a live `failed` entry? Used
 * ONLY to audit a BUG-57 re-actuation distinctly from a fresh dispatch —
 * call this BEFORE {@link beginCall}, since `beginCall` re-arms a `failed`
 * entry to `in-flight` as a side effect and the signal would be lost after.
 */
export function wasRecentlyFailed(callId: string, now: number = Date.now()): boolean {
  const existing = registry.get(callId)
  return existing !== undefined && existing.expiresAt > now && existing.status === 'failed'
}

/**
 * Record a call's outcome (BUG-33 AC2 — also what the late-completion
 * continuation calls once a raced handler finally settles after its
 * `TOOL_TIMEOUT` already went out). Refreshes the TTL so a retry that lands
 * within the window replays the cached result instead of re-actuating.
 */
export function completeCall(
  callId: string,
  status: 'applied' | 'failed',
  result: CallToolResult,
  now: number = Date.now()
): void {
  registry.set(callId, { status, result, expiresAt: now + IDEMPOTENCY_TTL_MS })
}

/** Test-only reset. */
export function _resetIdempotencyRegistry(): void {
  registry.clear()
}
