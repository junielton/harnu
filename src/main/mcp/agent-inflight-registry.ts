/**
 * In-memory single-occupancy registry for `create_session` spawns in flight
 * (this card, spec §3.3). Mirrors `grant-registry.ts`'s shape: a bare mutable
 * Map, no persistence (a capability/claim surviving a restart is meaningless
 * here — a restarted process has no in-flight spawns), pure enough to unit
 * test without electron.
 *
 * The guarantee this exists for: a second `create_session` for a folder with
 * an un-materialized spawn already in flight is REFUSED, never silently
 * queued — the 2026-07-18 incident (five processes landing at once in one
 * working tree) happened precisely because nothing enforced this.
 *
 * Reservation happens BEFORE the folder's `syntheticId` is known (it must —
 * two concurrent calls have to race on the folder alone), so occupancy is a
 * two-step claim: {@link tryReserveInFlight} stakes the folder, then
 * {@link attachSyntheticId} records the id once the dispatch resolves. A
 * dispatch that never resolves to a syntheticId simply never attaches one —
 * {@link releaseInFlight} still clears the folder-level claim.
 */

import { normalizePath } from './permission-core'

interface InFlightEntry {
  syntheticId: string | undefined
  startedAt: number
}

const inFlightByFolder = new Map<string, InFlightEntry>()
const folderBySyntheticId = new Map<string, string>()

function key(folder: string, homeDir?: string): string {
  return normalizePath(folder, homeDir)
}

/**
 * Claim single occupancy for `folder`. Returns `false` (no-op) if a spawn is
 * already in flight there; otherwise stakes the claim and returns `true`.
 * Call {@link releaseInFlight} in every exit path — success, failure, or
 * timeout — so a legitimate retry is never refused as a phantom duplicate.
 */
export function tryReserveInFlight(folder: string, homeDir?: string): boolean {
  const k = key(folder, homeDir)
  if (inFlightByFolder.has(k)) return false
  inFlightByFolder.set(k, { syntheticId: undefined, startedAt: Date.now() })
  return true
}

/** Record the `syntheticId` a reserved folder's dispatch resolved to (AC5 lookup). */
export function attachSyntheticId(folder: string, syntheticId: string, homeDir?: string): void {
  const k = key(folder, homeDir)
  const entry = inFlightByFolder.get(k)
  if (!entry) return
  entry.syntheticId = syntheticId
  folderBySyntheticId.set(syntheticId, k)
}

/** Release the occupancy claimed by {@link tryReserveInFlight} for `folder`. Idempotent. */
export function releaseInFlight(folder: string, homeDir?: string): void {
  const k = key(folder, homeDir)
  const entry = inFlightByFolder.get(k)
  if (entry?.syntheticId) folderBySyntheticId.delete(entry.syntheticId)
  inFlightByFolder.delete(k)
}

/**
 * BUG-58: release `folder`'s reservation, but ONLY if `syntheticId` is still
 * the folder's currently-attached holder. Called from the BUG-30 in-flight
 * registry's eviction path (`inflight-session-registry.ts`'s
 * `evictObservedSessions`, wired in `tool-handlers.ts`) once a timed-out spawn
 * finally resolves — either it materializes late or its registration is
 * reaped past the TTL. A no-op when the reservation was already released (the
 * ordinary materialize-in-time path releases synchronously inside
 * `runCreateSession`, before this ever runs) or when a NEWER spawn has since
 * claimed the folder — never releases someone else's reservation.
 */
export function releaseIfCurrentHolder(
  folder: string,
  syntheticId: string,
  homeDir?: string
): void {
  if (inFlightSyntheticIdFor(folder, homeDir) === syntheticId) {
    releaseInFlight(folder, homeDir)
  }
}

/** Whether `folder` currently has an un-materialized spawn in flight. */
export function isInFlight(folder: string, homeDir?: string): boolean {
  return inFlightByFolder.has(key(folder, homeDir))
}

/**
 * The in-flight `syntheticId` for `folder`, or `undefined` (either nothing is
 * in flight, or the dispatch hasn't resolved to an id yet). Lets `get_session`
 * report a `spawning` session instead of a bare `SESSION_NOT_FOUND` (AC5) —
 * the ambiguity between "never happened" and "still coming" is what triggers
 * retry storms.
 */
export function inFlightSyntheticIdFor(folder: string, homeDir?: string): string | undefined {
  return inFlightByFolder.get(key(folder, homeDir))?.syntheticId
}

/** The folder a `syntheticId` is currently in flight for, or `undefined`. */
export function inFlightFolderFor(syntheticId: string): string | undefined {
  return folderBySyntheticId.get(syntheticId)
}

/** Test-only reset. */
export function _resetInFlightRegistry(): void {
  inFlightByFolder.clear()
  folderBySyntheticId.clear()
}
