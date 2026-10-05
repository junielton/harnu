/**
 * In-memory in-flight agent-session registry (BUG-30). Closes the structural gap
 * where `get_session`/`get_fleet` could not see a session an agent just created
 * via `create_session` until it produced a real disk artifact (a JSONL transcript
 * from an actual PTY boot) — not a timing race, since a synthetic never reaches
 * `scanFolders()` on its own without a window opening/selecting it.
 *
 * IN-MEMORY ONLY, mirroring `grant-registry.ts` / `inherit-once-registry.ts`: a
 * synthetic that never booted before a restart is not a fact worth resurrecting,
 * and the restart itself is the eviction.
 *
 * The pure core (`emptyRegistry`/`register`/`list`/`evictObserved`) operates on an
 * explicit, immutable `InflightRegistryState` value — same discipline as
 * `grant-core.ts` (injected `now`, no fake timers needed) — so it is exhaustively
 * unit-tested (see `tests/inflight-session-registry.test.ts`). The shell below owns
 * the single module-level mutable instance the MCP handlers read/write.
 *
 * Eviction (spec D5, widened by BUG-89): an entry drops when ANY holds —
 *  - disk appearance (primary): `evictObserved`, called by the read handlers as a
 *    side effect of the same read once they know the real on-disk session set;
 *  - materialization report (BUG-89): `evictInflightSessionById`, called by the
 *    `command-bridge-ipc.ts` shell the instant the renderer reports
 *    `renderer:session-materialized` — evicts immediately by `syntheticId`
 *    rather than waiting for the next read or the TTL to catch up. A
 *    `create_session` whose ACK already timed out (`SPAWN_NOT_MATERIALIZED`,
 *    no `awaitMaterialization` waiter left parked) is still covered: this
 *    trigger doesn't consult the waiter table at all;
 *  - TTL (backstop): 60 minutes from `createdAt` — comfortably past the worst
 *    observed legitimate boot latency (~24 min, a cold `npx` MCP download), so it
 *    bounds a ghost entry without evicting a healthy one and re-creating the exact
 *    blindness this registry fixes.
 * The 64-entry cap (mirroring `GRANT_CAP`) evicts the oldest `createdAt` first on
 * a burst, independent of TTL.
 *
 * BUG-58: the shell's {@link evictObservedSessions} ACTIVELY removes both kinds
 * of resolved entry (not just hides TTL-dead ones from `list()`) and returns
 * them, because `tool-handlers.ts` uses that exact moment — materialize or
 * reap — to release the corresponding per-folder single-occupancy reservation
 * in `agent-inflight-registry.ts` (`releaseIfCurrentHolder`). Without an active
 * eviction there is no event to hook a release onto. BUG-89's
 * {@link evictInflightSessionById} follows the same active-eviction-returns-the-
 * entry contract so its caller can release through that identical path.
 */

/** One agent-created synthetic Harnu believes it dispatched but hasn't observed on disk yet. */
export interface InflightEntry {
  syntheticId: string
  folderPath: string
  /** The `AgentSession` correlation token, when the caller has one to hand. */
  correlationId?: string
  createdAt: number
}

/** The pure core's state: an immutable list of live entries (cap already applied). */
export type InflightRegistryState = readonly InflightEntry[]

/** Max concurrent entries; a `register` over this evicts the oldest `createdAt` first. */
export const INFLIGHT_CAP = 64

/** Backstop eviction age (D5) — comfortably past the worst observed legitimate boot. */
export const INFLIGHT_TTL_MS = 60 * 60_000

/** The empty registry — the starting state and the shell's `_reset` target. */
export function emptyRegistry(): InflightRegistryState {
  return []
}

/**
 * Add (or refresh) one entry. A repeat `syntheticId` replaces the prior entry
 * rather than duplicating it. When the result exceeds {@link INFLIGHT_CAP}, the
 * globally oldest-`createdAt` entries are dropped first — TTL-expired ghosts sort
 * oldest, so they are always the first evicted under a burst.
 */
export function register(
  state: InflightRegistryState,
  entry: InflightEntry
): InflightRegistryState {
  const next = [...state.filter((e) => e.syntheticId !== entry.syntheticId), entry]
  if (next.length <= INFLIGHT_CAP) return next
  const overflow = next.length - INFLIGHT_CAP
  const oldestIds = new Set(
    [...next]
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, overflow)
      .map((e) => e.syntheticId)
  )
  return next.filter((e) => !oldestIds.has(e.syntheticId))
}

/**
 * Drop every entry whose `syntheticId` is in `observedIds` — the primary,
 * evidence-based eviction (D5): the moment a session is observable on disk, the
 * shim's job for it is done. A no-op (same reference) when nothing matches.
 */
export function evictObserved(
  state: InflightRegistryState,
  observedIds: readonly string[]
): InflightRegistryState {
  if (observedIds.length === 0) return state
  const ids = new Set(observedIds)
  const next = state.filter((e) => !ids.has(e.syntheticId))
  return next.length === state.length ? state : next
}

/**
 * BUG-89: drop the entry for `syntheticId` unconditionally — not gated by TTL
 * or by disk-observation evidence. This is the registry's THIRD eviction
 * trigger: the renderer's own `renderer:session-materialized` report is
 * authoritative for this exact id, so there is nothing to reconcile it
 * against — evict it the instant the report arrives instead of waiting for
 * the next `get_fleet`/`get_session` read's {@link evictObserved} or the
 * {@link INFLIGHT_TTL_MS} backstop to catch up. A no-op (same reference,
 * `evicted: null`) when nothing matches.
 */
export function evictById(
  state: InflightRegistryState,
  syntheticId: string
): { state: InflightRegistryState; evicted: InflightEntry | null } {
  const evicted = state.find((e) => e.syntheticId === syntheticId) ?? null
  if (!evicted) return { state, evicted: null }
  return { state: state.filter((e) => e.syntheticId !== syntheticId), evicted }
}

/**
 * BUG-58: {@link evictObserved} plus an ACTIVE TTL sweep, in one pass, and —
 * unlike `evictObserved` — returns the entries it removed. The read handlers
 * use this to release the matching per-folder in-flight reservation
 * (`agent-inflight-registry.ts`) for each entry that resolves, whether by
 * observation or by aging out.
 */
export function reconcile(
  state: InflightRegistryState,
  observedIds: readonly string[],
  now: number
): { state: InflightRegistryState; evicted: InflightEntry[] } {
  const observed = new Set(observedIds)
  const cutoff = now - INFLIGHT_TTL_MS
  const evicted: InflightEntry[] = []
  const next = state.filter((e) => {
    if (observed.has(e.syntheticId) || e.createdAt <= cutoff) {
      evicted.push(e)
      return false
    }
    return true
  })
  return next.length === state.length ? { state, evicted: [] } : { state: next, evicted }
}

/** Read options for {@link list}: `now` drives the TTL cutoff; `folderPath` scopes the read. */
export interface ListOptions {
  now: number
  folderPath?: string
}

/**
 * The live (non-TTL-expired, optionally folder-scoped) entries at `now`. Pure —
 * does not itself prune `state`; a TTL-dead entry simply stops being listed until
 * the next cap-driven `register` (or an explicit `evictObserved`) removes it.
 */
export function list(state: InflightRegistryState, opts: ListOptions): InflightEntry[] {
  const cutoff = opts.now - INFLIGHT_TTL_MS
  return state.filter(
    (e) =>
      e.createdAt > cutoff && (opts.folderPath === undefined || e.folderPath === opts.folderPath)
  )
}

// ---- module shell — the single mutable instance the MCP handlers use ---------

let store: InflightRegistryState = emptyRegistry()

/** Register a successful `create_session` dispatch (D3 — never call this on failure). */
export function registerInflightSession(entry: {
  syntheticId: string
  folderPath: string
  correlationId?: string
  createdAt?: number
}): void {
  store = register(store, { ...entry, createdAt: entry.createdAt ?? Date.now() })
}

/** The live entries `get_session`/`get_fleet` merge into `inflightAgentSessions`. */
export function listInflightSessions(opts?: {
  folderPath?: string
  now?: number
}): InflightEntry[] {
  return list(store, { now: opts?.now ?? Date.now(), folderPath: opts?.folderPath })
}

/**
 * Evict every entry now observable on disk OR past the TTL backstop, as a side
 * effect of a read (D5). Returns the evicted entries (BUG-58) so the caller
 * (`tool-handlers.ts`) can release the matching per-folder in-flight
 * reservation for each one.
 */
export function evictObservedSessions(
  observedIds: readonly string[],
  now: number = Date.now()
): InflightEntry[] {
  const { state, evicted } = reconcile(store, observedIds, now)
  store = state
  return evicted
}

/**
 * BUG-89: evict `syntheticId` the instant the renderer reports it materialized
 * (`renderer:session-materialized`), instead of waiting for the next
 * `get_fleet`/`get_session` poll's {@link evictObservedSessions} or the
 * 60-minute TTL backstop. Returns the evicted entry, or `null` if it was
 * already gone, so the caller can release its matching per-folder reservation
 * through the SAME `releaseResolvedInflightReservations` path
 * {@link evictObservedSessions} uses — not a second, divergent release.
 */
export function evictInflightSessionById(syntheticId: string): InflightEntry | null {
  const { state, evicted } = evictById(store, syntheticId)
  store = state
  return evicted
}

/** Test-only reset. */
export function _resetInflightRegistry(): void {
  store = emptyRegistry()
}
