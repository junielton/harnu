import { readdirSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import { mainCheckoutRoot } from './data-dir'
import { leaderOf as leaderOfRecord } from './missions/guard'
import { parseMissionRecordFile } from './missions/model'
import { migratedDir, v4RecordsDir } from './missions/record-store'
import { leaderOf, readMissionsDedupedSync } from './missions/store'

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

/** T616: the folder each parked session was staged for, so the skills prune can keep its dir. */
const hibernatedFolderOf = new Map<string, string>()

export function markHibernated(sessionKey: string, folder?: string): void {
  hibernated.add(sessionKey)
  if (folder !== undefined) hibernatedFolderOf.set(sessionKey, folder)
}

/** Folders of the sessions currently parked (T616). Sessions parked without a folder are absent. */
export function hibernatedFolders(): string[] {
  return [...hibernatedFolderOf.values()]
}

/**
 * Called from `pty:create` for the spawning key, so waking a session ALWAYS clears the flag.
 * Self-healing by construction: a live session can never stay flagged as parked.
 */
export function clearHibernated(sessionKey: string): void {
  hibernated.delete(sessionKey)
  hibernatedFolderOf.delete(sessionKey)
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
  hibernatedFolderOf.clear()
  parkingPtyIds.clear()
  parkLedger.length = 0
}

/**
 * The leader exemption (T363, Missions v4 S-23 · AC-62).
 *
 * The leader of an OPEN mission is never a hibernation victim, ready to close included: it is usually
 * idle by design (it dispatched its work and waits for the reports), and a report, an answer to a
 * request to join or the operator's hand-off would land on a dead process. This used to hold only
 * while a live child session was linked under the mission; the v4 pane made the leader the one session
 * the mission stands on (R-9), so it holds for as long as the mission is open. A closed mission frees
 * its leader.
 *
 * The missions are read through the record store's own files and rules, for v3 and v4 alike: a v4
 * record under `.harnu/missions-v4/` is the mission (one format at a time, and the record's own
 * `leaderOf` names the leader), and a v3 mission nobody copied yet is read with the v3 reader, its
 * leader being the owner while it is not closed (a delivered one, waiting for the operator to close
 * it, is ready to close). The record store reads asynchronously and this runs inside the synchronous
 * fleet snapshot, so the same files are read here with the same parser. Fails OPEN: an unreadable
 * directory or a malformed file exempts nobody, which is what happened before this exemption existed.
 */

/** The leaders of the open v4 records under `root`, and every mission id a v4 record or sidecar covers. */
function readV4Leaders(root: string): {
  leaders: Map<string, string | null>
  covered: Set<string>
} {
  const leaders = new Map<string, string | null>()
  const covered = new Set<string>()
  try {
    for (const name of readdirSync(v4RecordsDir(root))) {
      const m = /^(mnt-[0-9a-f]{8})-.+\.md$/.exec(name)
      if (!m) continue
      try {
        const record = parseMissionRecordFile(
          readFileSync(path.join(v4RecordsDir(root), name), 'utf8')
        )
        if ('error' in record) continue
        covered.add(record.id)
        leaders.set(record.id, record.status === 'open' ? leaderOfRecord(record) : null)
      } catch {
        /* one unreadable file exempts nobody */
      }
    }
  } catch {
    /* no v4 directory yet */
  }
  try {
    // A campaign converted to v4 supersedes its own id and every chapter mission's: the v3 files stay
    // beside the record as snapshots and read as nothing.
    for (const name of readdirSync(migratedDir(root))) {
      if (name.endsWith('.json')) covered.add(name.slice(0, -5))
    }
  } catch {
    /* no sidecars */
  }
  return { leaders, covered }
}

/**
 * The keys of the sessions that lead an open mission in the repos of `roots`: v4 records first, then
 * the v3 missions no v4 record covers. Pure of the fleet: it names leaders, the caller keeps the live ones.
 */
export function openMissionLeaders(roots: readonly string[]): Set<string> {
  const out = new Set<string>()
  const covered = new Set<string>()
  for (const root of roots) {
    const v4 = readV4Leaders(root)
    for (const id of v4.covered) covered.add(id)
    for (const leader of v4.leaders.values()) if (leader) out.add(leader)
  }
  // The store's one v3 read: the newest copy of each mission across the clones, so a stale twin in
  // another clone pins nobody. `includeClosed: false` leaves the closed ones out.
  for (const { mission } of readMissionsDedupedSync([...roots], { includeClosed: false })
    .missions) {
    if (covered.has(mission.id)) continue
    const leader = leaderOf(mission)
    if (leader) out.add(leader)
  }
  return out
}

// `mainCheckoutRoot` lives in `./data-dir` (the one resolver); re-exported for existing callers.
export { mainCheckoutRoot }

/**
 * The keys of every live session that leads an open mission (see {@link openMissionLeaders}). `sessions`
 * is the whole live fleet; `cwd` locates each session's repo, and each distinct repo's missions are
 * read once. The name is the one the callers know: before S-23 it asked for a live child too.
 */
export function missionOwnersWithLiveChildren(
  sessions: readonly { sessionKey: string; cwd?: string }[]
): Set<string> {
  const roots = new Set<string>()
  for (const s of sessions) {
    const root = s.cwd ? mainCheckoutRoot(s.cwd) : null
    if (root) roots.add(root)
  }
  const leaders = openMissionLeaders([...roots])
  return new Set(sessions.map((s) => s.sessionKey).filter((key) => leaders.has(key)))
}
