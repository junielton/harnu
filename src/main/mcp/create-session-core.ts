/**
 * Pure core for `create_session`'s honest ACK (ADR-0003 / this card).
 *
 * `ok: true` must mean the session MATERIALIZED — a real process AND a
 * transcript under `~/.claude/projects/<slug>/` — not merely that the
 * renderer accepted the dispatch (a `syntheticId`, a receipt for intent).
 * `createSessionHandler` (`tool-handlers.ts`) is the thin shell: it resolves
 * the boot config (electron/fs-bound) and hands primitives to
 * {@link runCreateSession} here, which owns the actual decision — reserve →
 * dispatch → await materialization → release — deterministically, with every
 * side-effecting collaborator injected (ADR-0001). BUG-58: a materialization
 * TIMEOUT is the one exit path that does NOT release — the reservation is
 * held until the spawn resolves (see the timeout branch below).
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { asRecord, dispatchSucceeded, steerError, textResult } from './tool-result'

/** The renderer's report that a synthetic id migrated to a real, on-disk session. */
export interface Materialization {
  syntheticId: string
  sessionId: string
  folder: string
}

/** Side-effecting collaborators {@link runCreateSession} needs, injected by the shell. */
export interface CreateSessionDeps {
  /** Dispatch `session.create` (already includes the folder-adopt retry). */
  dispatchCreate: (payload: Record<string, unknown>) => Promise<unknown>
  /** Wait up to `timeoutMs` for `syntheticId` to materialize; `null` on timeout. */
  awaitMaterialization: (syntheticId: string, timeoutMs: number) => Promise<Materialization | null>
  /** Claim single occupancy for `folder`; `false` if already occupied. */
  tryReserve: (folder: string) => boolean
  /** Record the syntheticId the reserved folder's dispatch resolved to (AC5 lookup). */
  attachSyntheticId: (folder: string, syntheticId: string) => void
  /** Release the occupancy claimed by `tryReserve` — always called, success or not. */
  release: (folder: string) => void
  /**
   * BUG-33 AC5: polled right before `dispatchCreate` — the ONE commit point
   * `create_session` has. `true` means the 120s tool deadline already fired
   * (the caller's `TOOL_TIMEOUT` already went out): abort instead of
   * dispatching a session nobody will read the ACK for. Omitted ⇒ never
   * fired (existing callers/tests are unaffected).
   */
  deadlineFired?: () => boolean
  /**
   * Missions v4 S-26: runs once, after the session materialized and before the ACK, for a session
   * started for one step of a mission. It binds the step (its card, the attached worker) and returns
   * the fields the ACK gains. It never throws into the ACK: a failure is the returned `bindError`, the
   * session being alive either way. Omitted for a plain session.
   */
  bindMaterialized?: (mat: Materialization) => Promise<Record<string, unknown> | undefined>
  /**
   * BUG-296: the session did not materialize in time but was not torn down. A session started for a
   * step is still owed its attach, or the news that it never got one. Fire and forget.
   */
  onNotMaterialized?: (syntheticId: string) => void
  /**
   * Missions v4 S-34: runs once, after the session materialized, and returns the fields the ACK gains
   * (the proactive `missionHint`). A hint never fails the ACK: a throw is dropped. Omitted for a session
   * started for a step, and for a caller that is exempt.
   */
  hint?: () => Promise<Record<string, unknown> | undefined>
}

/** Echoed alongside the ACK; carried through unchanged from the resolved boot config. */
export interface CreateSessionAckExtras {
  effectiveModel?: string | null
  effectiveEffort?: string | null
}

/**
 * Bounded wait for a spawn to materialize (ADR-0003 §4). Tuned for caller
 * ergonomics, not worst-case coverage — the field observed a ~14-minute tail;
 * a deadline that generous makes the verb unusable. Safe only because a late
 * materialization is never attached to a folder that has since moved on
 * (AC4) — see the single-occupancy release below.
 */
export const MATERIALIZE_DEADLINE_MS = 60_000

/**
 * The full `create_session` decision (spec §3.2): refuse a folder with a spawn
 * already in flight (AC3 — the structural fix for the 2026-07-18 five-process
 * collision), else dispatch, then await materialization before ever claiming
 * `ok:true` (AC1/AC2). The folder's occupancy is released on every exit path
 * EXCEPT a materialization timeout (BUG-58) — see the timeout branch below —
 * so a legitimate retry after a real failure is never itself refused as a
 * phantom duplicate, while a spawn that is merely slow can't be raced by a
 * blind retry either.
 */
export async function runCreateSession(
  folder: string,
  payload: Record<string, unknown>,
  ack: CreateSessionAckExtras,
  deps: CreateSessionDeps,
  deadlineMs: number = MATERIALIZE_DEADLINE_MS
): Promise<CallToolResult> {
  if (!deps.tryReserve(folder)) {
    return steerError('SESSION_ALREADY_IN_FLIGHT', folder)
  }
  // BUG-58: set right before the timeout return below — every OTHER exit path
  // (including an unexpected throw from dispatchCreate/awaitMaterialization)
  // still releases via `finally`, exactly as before.
  let heldOnTimeout = false
  try {
    if (deps.deadlineFired?.()) {
      return steerError('DEADLINE_FIRED', folder)
    }
    const result = await deps.dispatchCreate(payload)
    if (!dispatchSucceeded(result)) {
      return textResult({ ok: false, op: 'create_session', result, ...ack })
    }
    const syntheticId = asRecord(result).syntheticId
    if (typeof syntheticId !== 'string' || syntheticId.length === 0) {
      // Defensive: a dispatch that "succeeded" but carries no syntheticId can't be
      // awaited for materialization. Never seen in practice (command-router always
      // mints one on success) — pass the raw result through rather than hang.
      return textResult({ ok: true, op: 'create_session', result, ...ack })
    }
    deps.attachSyntheticId(folder, syntheticId)
    const mat = await deps.awaitMaterialization(syntheticId, deadlineMs)
    if (!mat) {
      // BUG-58: the dispatched session is NOT torn down — the field has
      // observed a ~14-minute materialization tail, and killing a spawn that
      // is merely slow throws away healthy work. Hold the folder's reservation
      // (do not release below) so a blind retry can't land a second process in
      // the same working tree; ownership of the release transfers to whichever
      // resolves the in-flight registration first — real materialization or
      // the TTL reap — both wired through `evictObservedSessions` in
      // tool-handlers.ts. Carry the syntheticId so the caller can adopt/poll it.
      heldOnTimeout = true
      deps.onNotMaterialized?.(syntheticId)
      return steerError('SPAWN_NOT_MATERIALIZED', folder, syntheticId)
    }
    let bound: Record<string, unknown> | undefined
    if (deps.bindMaterialized) {
      try {
        bound = await deps.bindMaterialized(mat)
      } catch (err) {
        bound = { bindError: err instanceof Error ? err.message : String(err) }
      }
    }
    let hint: Record<string, unknown> | undefined
    if (deps.hint) {
      try {
        hint = await deps.hint()
      } catch {
        hint = undefined
      }
    }
    return textResult({
      ok: true,
      op: 'create_session',
      result: { ...asRecord(result), sessionId: mat.sessionId },
      ...ack,
      ...(bound ?? {}),
      ...(hint ?? {})
    })
  } finally {
    if (!heldOnTimeout) deps.release(folder)
  }
}
