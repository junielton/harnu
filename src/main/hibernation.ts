import { readdirSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import { mainCheckoutRoot } from './data-dir'
import { missionsDir, parseMissionFile, type Mission } from './mission-core'

/**
 * The set of session keys currently PARKED — process killed to reclaim memory, conversation
 * intact on disk, resumable via the normal `claude --resume` path.
 *
 * This CANNOT be derived from PTY liveness, which is the non-obvious part. `pty.ts` calls
 * `pruneTaskState` on every teardown, and `mcp/server.ts#taskStateRecord` filters the hook
 * FSM through `liveSessionKeys()` — so a parked session (which by definition has no PTY)
 * would silently vanish from the fleet disclosure at exactly the moment an orchestrator
 * needs to read "parked, not dead". Hence a registry that outlives the process.
 *
 * Spec: docs/specs/T119-session-hibernation.md §5.1. See also the
 * `orchestrator-idle-not-stalled` lesson.
 */
const hibernated = new Set<string>()

export function markHibernated(sessionKey: string): void {
  hibernated.add(sessionKey)
}

/**
 * Called from `pty:create` for the spawning key, so waking a session ALWAYS clears the flag.
 * Self-healing by construction: a live session can never stay flagged as parked.
 */
export function clearHibernated(sessionKey: string): void {
  hibernated.delete(sessionKey)
}

export function isHibernated(sessionKey: string): boolean {
  return hibernated.has(sessionKey)
}

export function hibernatedKeys(): ReadonlySet<string> {
  return new Set(hibernated)
}

/**
 * Park provenance (BUG-70 §3.1). `hibernateSession` removes the sessionKey→ptyId
 * index entry BEFORE the process actually exits, so by the time `pty.onExit`
 * fires the reverse lookup is gone — the ptyId is the only identifier that
 * survives. Tag it here, before `.kill()`, so `onExit` can tell a park apart
 * from a natural death and stamp `pty:exit`'s `reason` accordingly.
 */
const parkingPtyIds = new Set<string>()

/** Tag a ptyId as being killed FOR A PARK. Must be called before `.kill()`. */
export function markParking(ptyId: string): void {
  parkingPtyIds.add(ptyId)
}

/** True iff this ptyId's imminent exit is a park. Does not consume. */
export function isParking(ptyId: string): boolean {
  return parkingPtyIds.has(ptyId)
}

/** Drop the tag — called from `onExit` after the reason is stamped. */
export function clearParking(ptyId: string): void {
  parkingPtyIds.delete(ptyId)
}

/**
 * The park ledger (BUG-70 §4). Replaces `clearHibernated`'s silent erase: a
 * wake is now a recorded event (when, and — once the caller threads it
 * through — how), not a flag flip nobody can look back at. Bounded ring so a
 * long-running app can't grow this unbounded.
 */
/**
 * How a parked session came back.
 *
 * `'peer-message'` (T215) is the one gesture that is NOT a human's: an agent
 * called `message_session` against a parked recipient and Harnu un-parked it to
 * deliver. The park ledger is the ONLY place that distinction can be read back
 * — BUG-70 built it precisely so a wake stops being an untraceable flag flip —
 * so an agent-driven wake must be legible here, not folded into `'unknown'`.
 */
export type WakeGesture = 'select' | 'restart' | 'notification-click' | 'peer-message' | 'unknown'

export interface ParkEvent {
  sessionKey: string
  parkedAt: number
  wokenAt: number | null
  wakeGesture: WakeGesture | null
}

const PARK_HISTORY_CAP = 200
const parkLedger: ParkEvent[] = []

/** Record a park. Called alongside `markHibernated`, with a caller-injected clock. */
export function recordPark(sessionKey: string, atMs: number): void {
  parkLedger.push({ sessionKey, parkedAt: atMs, wokenAt: null, wakeGesture: null })
  if (parkLedger.length > PARK_HISTORY_CAP) parkLedger.shift()
}

/**
 * Record a wake against the most recent still-open park entry for this
 * session. A no-op (not a throw) when there is no open entry — waking a
 * session that was never parked (the common case: every `pty:create` clears
 * the flag unconditionally, per `clearHibernated`'s self-healing contract)
 * must not fabricate ledger history.
 */
export function recordWake(sessionKey: string, atMs: number, gesture: WakeGesture): void {
  for (let i = parkLedger.length - 1; i >= 0; i--) {
    const entry = parkLedger[i]
    if (entry.sessionKey === sessionKey && entry.wokenAt === null) {
      entry.wokenAt = atMs
      entry.wakeGesture = gesture
      return
    }
  }
}

/** Read-only, oldest-first snapshot of the park ledger. */
export function parkHistory(): readonly ParkEvent[] {
  return [...parkLedger]
}

/** Test-only: drop all state between cases. */
export function resetHibernation(): void {
  hibernated.clear()
  parkingPtyIds.clear()
  parkLedger.length = 0
}

/**
 * The mission-owner exemption (T363 — plan Slice S2, design.md §8 / §13 Resolved B).
 *
 * An orchestrator that owns an `active` Mission is usually IDLE by design: it dispatched its
 * children and is waiting for their reports. Parking it is exactly wrong — a child's
 * report lands on a dead process (smoke test T360 Q2, then observed live on T356). So a
 * session that owns an active mission with at least one `session` step link naming a
 * currently-live session is never a hibernation victim, whatever its own idle state.
 *
 * Scoped to a LIVE child, not to "owns an active mission": an idle mission with nothing
 * running under it must not pin its owner's hundreds of MB indefinitely. The pin also
 * self-releases — once every child is parked or closed, the owner is eligible again.
 *
 * Missions are read straight from disk with S1's `parseMissionFile` (no `mission_*` verb
 * exists at this point in the stack). Fails OPEN: an unreadable directory or a malformed
 * file exempts nobody, which is exactly the behavior before this exemption existed.
 */
export function ownsMissionWithLiveChild(
  sessionKey: string,
  missions: readonly Mission[],
  liveKeys: ReadonlySet<string>
): boolean {
  return missions.some(
    (m) =>
      m.status === 'active' &&
      m.owner.sessionId === sessionKey &&
      m.steps.some((step) =>
        step.links.some(
          // A self-link is not a child: an owner naming itself would otherwise pin itself.
          (l) => l.kind === 'session' && l.ref !== sessionKey && liveKeys.has(l.ref)
        )
      )
  )
}

// `mainCheckoutRoot` lives in `./data-dir` (the one resolver); re-exported for existing callers.
export { mainCheckoutRoot }

/**
 * Every well-formed `active` mission under `root`; `[]` when there is no missions dir.
 *
 * Synchronous on purpose (the fleet snapshot it feeds is). A repo the boot pass never saw
 * has its legacy `.capy/` copied lazily, so the FIRST sweep over it can read no missions and
 * park an owner whose child is live. That self-heals on the next sweep, once the copy has
 * landed — and a parked session is intact on disk (selecting the row resumes it), so the
 * miss costs a resume, never work. Pinned by the AC-3e test in `tests/hibernation.test.ts`.
 */
function readActiveMissions(root: string): Mission[] {
  const dir = missionsDir(root)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const out: Mission[] = []
  for (const name of names) {
    if (!name.endsWith('.md')) continue
    try {
      const parsed = parseMissionFile(readFileSync(path.join(dir, name), 'utf8'))
      if (!('error' in parsed) && parsed.status === 'active') out.push(parsed)
    } catch {
      // Unreadable file — fail open, skip it.
    }
  }
  return out
}

/**
 * The keys of every live session that {@link ownsMissionWithLiveChild} exempts. `sessions`
 * is the whole live fleet (it doubles as the liveness set); `cwd` locates each session's
 * repo, and each distinct repo's missions are read once.
 */
export function missionOwnersWithLiveChildren(
  sessions: readonly { sessionKey: string; cwd?: string }[]
): Set<string> {
  const liveKeys = new Set(sessions.map((s) => s.sessionKey))
  const roots = new Set<string>()
  for (const s of sessions) {
    const root = s.cwd ? mainCheckoutRoot(s.cwd) : null
    if (root) roots.add(root)
  }
  const missions = [...roots].flatMap(readActiveMissions)
  const owners = new Set<string>()
  if (missions.length === 0) return owners
  for (const key of liveKeys) {
    if (ownsMissionWithLiveChild(key, missions, liveKeys)) owners.add(key)
  }
  return owners
}
