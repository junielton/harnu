/**
 * Missions v4 S-3 (R-25, AC-4) — the observer: the one place a mission read is allowed to write.
 *
 * `deriveMission` (`./derive.ts`) only reads. What a read learned comes back as a
 * `MissionObservation`, and {@link observeMission} acts on it:
 *
 *  - the sticky last-known facts (Mission v3 §3.7) go into the link cache;
 *  - the progress it computed is remembered for `mission_list`;
 *  - a PR opened or merged, a CI change or a builder ending (campaign spec §3.2) is appended to
 *    the sidecar ledger, once per new fact;
 *  - one wake goes to the mission's steward, named for the most specific thing seen.
 *
 * It never rewrites the mission file: `updatedAt` stays a pure evidence signal. A read that is
 * not observed leaves the world exactly as it found it.
 */
import { wakeStewardForMission } from '../scheduler-shell'
import type { WakeReason } from '../steward-core'
import type { MissionChildState } from '../mcp/fleet-snapshot'
import type { LedgerRow, Mission } from '../mission-core'
import {
  addObservedLedger,
  forgetResolved,
  getObservedLedger,
  rememberResolved
} from '../mission-link-cache'
import { hasLedgerRow, lastLedgerDetail, mergeLedger, type LedgerRowInput } from '../mission-ledger'
import type { MissionProgress } from '../mission-progress'
import {
  deriveMission,
  type DeriveDeps,
  type MissionDerived,
  type MissionObservation,
  type MissionReading,
  type MissionStepSignals
} from './derive'

/**
 * Mission v3 §3.10 — the last progress every observed read computed, per mission, so
 * `mission_list` can report it without deriving (it may be one poll old; `computedAt` says
 * when). Shared by the MCP and IPC paths (one main process).
 */
const lastProgress = new Map<string, MissionProgress>()
/** Bound on {@link lastProgress} — the oldest entry is dropped past it. */
const LAST_PROGRESS_MAX = 1000

function rememberProgress(missionId: string, progress: MissionProgress): void {
  lastProgress.delete(missionId) // re-insert last: Map order = recency
  lastProgress.set(missionId, progress)
  if (lastProgress.size > LAST_PROGRESS_MAX) {
    const oldest = lastProgress.keys().next().value
    if (oldest !== undefined) lastProgress.delete(oldest)
  }
}

/** The progress of the last observed read of `missionId`; `undefined` before any. */
export function lastKnownProgress(missionId: string): MissionProgress | undefined {
  return lastProgress.get(missionId)
}

/** `taskState`s of a session whose process has ended — the ledger's `session-died`. */
const SESSION_DEATH_STATES: ReadonlySet<string> = new Set(['completed', 'failed', 'stopped'])
/** `taskState`s that prove a session is alive right now. */
const SESSION_ALIVE_STATES: ReadonlySet<string> = new Set(['working', 'needs-input', 'idle'])
/**
 * Linked sessions seen alive by a read in this process. A session whose PTY is gone has
 * no disclosed `taskState` at all (the hook state is hidden without a live PTY), so its
 * death is "alive before, no state now" — which needs the "before". The ledger's own
 * `dispatched` row is the same evidence across a restart.
 */
const seenAlive = new Set<string>()
const SEEN_ALIVE_MAX = 2000

/** Wake a mission's steward; fire-and-forget, and never a reason for the caller to fail. */
export function wakeSteward(missionId: string, reason: WakeReason): Promise<unknown> {
  return wakeStewardForMission(missionId, reason).catch((err) => {
    console.warn(`[steward] could not wake the steward of ${missionId}:`, err)
  })
}

/**
 * Campaign spec §3.2 — record what a read OBSERVED: a PR opened or merged, a CI change, a
 * linked builder ending. Only a new fact appends a row (deduped against the ledger so far,
 * file rows and observed rows together), so N reads of an unchanged world record nothing. The
 * rows go to the link-cache sidecar, never to the mission file (Mission v3 §3.7).
 * Synchronous on purpose — the check and the insert share one tick, so two concurrent reads
 * cannot both add a row.
 */
function observeLedger(
  mission: Mission,
  steps: readonly MissionStepSignals[],
  prByStep: MissionObservation['prByStep'],
  now: number
): void {
  if (mission.status === 'closed') return
  const at = new Date(now).toISOString()
  const seen = { ledger: mergeLedger(mission.ledger, getObservedLedger(mission.id)) }
  const added: LedgerRow[] = []
  /**
   * `eventAt`: omitted = the event has no single time of its own (CI, a session end),
   * the observation time stands. A PR event passes GitHub's time (ISO) or `null` when
   * GitHub gave none, and then the row falls back to the observation, saying so.
   */
  const push = (row: LedgerRowInput, eventAt?: string | null): void => {
    const t = eventAt ? Date.parse(eventAt) : NaN
    const full: LedgerRow = Number.isFinite(t)
      ? { at: new Date(t).toISOString(), ...row }
      : eventAt === undefined
        ? { at, ...row }
        : { at, ...row, detail: 'observed' }
    added.push(full)
    seen.ledger.push(full)
  }
  steps.forEach((st, i) => {
    const stepId = st.stepId
    const facts = prByStep[i]?.facts
    if (facts) {
      const ref = `#${facts.number}`
      if (facts.state === 'OPEN' && !hasLedgerRow(seen, 'pr-opened', ref)) {
        push({ kind: 'pr-opened', stepId, ref, pr: facts.number }, facts.createdAt ?? null)
      }
      if (facts.state === 'MERGED' && !hasLedgerRow(seen, 'pr-merged', ref)) {
        push({ kind: 'pr-merged', stepId, ref, pr: facts.number }, facts.mergedAt ?? null)
      }
      if (
        facts.ci !== 'unknown' &&
        lastLedgerDetail(seen, 'ci', ref) !== facts.ci &&
        facts.state !== 'CLOSED'
      ) {
        push({ kind: 'ci', stepId, ref, pr: facts.number, detail: facts.ci })
      }
    }
    for (const c of st.children) {
      if (c.sessionId === mission.owner.sessionId || !c.known) continue
      if (c.taskState !== undefined && SESSION_ALIVE_STATES.has(c.taskState)) {
        seenAlive.add(c.sessionId)
        if (seenAlive.size > SEEN_ALIVE_MAX) {
          const oldest = seenAlive.values().next().value
          if (oldest !== undefined) seenAlive.delete(oldest)
        }
        continue
      }
      if (hasLedgerRow(seen, 'session-died', c.sessionId)) continue
      // Parked and still-spawning sessions are not dead; a session with no state and
      // no process is, once it is known to have lived.
      const exited = c.taskState === undefined && !c.hibernated && !c.inflight
      const ended = c.taskState !== undefined && SESSION_DEATH_STATES.has(c.taskState)
      const wasAlive = seenAlive.has(c.sessionId) || hasLedgerRow(seen, 'dispatched', c.sessionId)
      if (!ended && !(exited && wasAlive)) continue
      push({
        kind: 'session-died',
        stepId,
        ref: c.sessionId,
        sessionId: c.sessionId,
        detail: c.taskState ?? 'exited'
      })
    }
  })
  addObservedLedger(mission.id, added)
  // Campaign ch.5a: what a read OBSERVED is an event too — a CI change, a PR opening or
  // merging, a builder ending. One wake per observation, named for the most specific thing seen.
  if (added.length > 0) {
    void wakeSteward(
      mission.id,
      added.some((r) => r.kind === 'ci')
        ? 'ci'
        : added.some((r) => r.kind === 'session-died')
          ? 'child-idle'
          : 'ledger'
    )
  }
}

/** Act on one reading: the only place a read of a mission turns into a write. */
export function observeMission(mission: Mission, reading: MissionReading, now: number): void {
  for (const op of reading.observation.sticky) {
    if (op.op === 'remember') rememberResolved(op.root, op.kind, op.ref, op.seen)
    else forgetResolved(op.root, op.kind, op.ref)
  }
  rememberProgress(mission.id, reading.derived.progress)
  observeLedger(mission, reading.derived.steps, reading.observation.prByStep, now)
}

/**
 * Derive a mission and observe the reading — what the verbs, the renderer IPC and the steward
 * do on every read. The two halves stay separate: a caller that wants a read with no effect
 * calls {@link deriveMission} alone.
 */
export async function deriveAndObserve(
  root: string,
  mission: Mission,
  log: string,
  deps: DeriveDeps,
  now: number,
  /** `prWaitMs`: how long to wait for GitHub before reading the sticky last-known states. */
  opts: { prWaitMs?: number; mainCiWaitMs?: number } = {}
): Promise<{ derived: MissionDerived; children: MissionChildState[] }> {
  const reading = await deriveMission(root, mission, log, deps, now, opts)
  observeMission(mission, reading, now)
  return { derived: reading.derived, children: reading.children }
}
