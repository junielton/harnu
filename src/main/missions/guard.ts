/**
 * Missions v4 S-11 (AC-30) — the one attachment guard.
 *
 * Who may read, write or lead a mission is decided here and nowhere else (spec "Who may read and
 * write"); every v4 verb and operator door calls {@link guardMission} (through `write.ts` for a write,
 * through {@link readMissionAs} for a read), so the verb slices own no copy of the rule.
 *
 * - **Attached** means the session has an open entry in the mission's `sessions` (`to` is `null`) as
 *   `leads` or `worked`. A session the mission released (`to` set) or never knew is not attached.
 * - **Read the detail** (`read`): an attached session, a Harnu system worker bound to the mission or
 *   to the folder, and the app itself (`operator`). Anyone else is refused `NOT_ATTACHED` with the way
 *   out.
 * - **List** ({@link listMissionRows}): any session in the folder, as one-line rows (id, title,
 *   headline, who leads) and never steps, criteria, links or history.
 * - **Ask to attach** (`ask-to-attach`): the one write an unattached session may make; it is how it
 *   leaves `NOT_ATTACHED`. `write.ts` limits what that write may change.
 * - **Write** (`write`): an attached session. **Lead** (`lead`): the leader only, for what a `worked`
 *   session (whose verbs are scoped to its own step) must never do. **Operator** (`operator`): the
 *   doors, which only the operator holds.
 *
 * Only the operator changes who leads (the operator's decision of 2026-11-14): no need here lets a
 * session ask to lead, and `write.ts` refuses a session's write that sets or moves `leads`.
 *
 * Pure apart from the two reads at the bottom, which only read through the v4 store. Never writes.
 */

import { repoRoot } from '../data-dir'
import { deriveProgress, type MissionProgress } from './progress'
import type { StepInput } from './state'
import type { MissionV4, SessionEntry, SessionRole } from './model'
import { listMissionRecords, readMissionRecord, type MissionRecordRead } from './record-store'

// ---- Actors and needs ------------------------------------------------------------

/**
 * Who is calling. A session is self-declared (S-25 makes it a credential for the sessions Harnu
 * spawns). `operator` is the app's own interface acting on the operator's hand: it is not a session,
 * reads everything and holds the doors. `harnu` is Harnu's own write (a dispatch attaching a worker,
 * recording where a session stopped, attaching a pull request it found): the guard treats it as it
 * treats the operator, and only its NAME differs, so a Log or an audit never says the operator did
 * what Harnu did. A `worker` is a Harnu system worker: with `missionId` it is
 * bound to that mission, without it to the folder whose records are being read (the caller has already
 * read them from that folder); it reads and never writes.
 */
export type Actor =
  | { kind: 'session'; sessionId: string }
  | { kind: 'operator' }
  | { kind: 'harnu' }
  | { kind: 'worker'; missionId?: string }

/** What a call needs: see the module comment. */
export type Need = 'read' | 'ask-to-attach' | 'write' | 'lead' | 'operator'

/** Where the caller stands on this mission. */
export type Standing = SessionRole | 'operator' | 'harnu' | 'worker' | 'unattached'

export type GuardCode =
  'NOT_ATTACHED' | 'NOT_LEADER' | 'OPERATOR_ONLY' | 'READ_ONLY' | 'MISSION_CLOSED'

export type Access =
  { ok: true; standing: Standing } | { ok: false; code: GuardCode; error: string }

// ---- The rule --------------------------------------------------------------------

/** The open entry of a session: the one a hand-off has not released. */
export function openEntry(record: MissionV4, sessionId: string): SessionEntry | undefined {
  return record.sessions.find((s) => s.id === sessionId && s.to === null)
}

/** The session that leads now, or null. */
export function leaderOf(record: MissionV4): string | null {
  return record.sessions.find((s) => s.role === 'leads' && s.to === null)?.id ?? null
}

const refuse = (code: GuardCode, error: string): Access => ({
  ok: false,
  code,
  error: `${code}: ${error}`
})

/**
 * The one decision. Order: who the caller is, then whether the mission is attached to it, then whether
 * the mission is closed (a session writes to an open mission only; the operator is never refused).
 */
export function guardMission(record: MissionV4, actor: Actor, need: Need): Access {
  if (actor.kind === 'operator' || actor.kind === 'harnu') {
    return { ok: true, standing: actor.kind }
  }

  if (actor.kind === 'worker') {
    if (need !== 'read') {
      return refuse('READ_ONLY', 'a Harnu system worker reads a mission and never writes it.')
    }
    if (actor.missionId !== undefined && actor.missionId !== record.id) {
      return refuse(
        'NOT_ATTACHED',
        `this worker is bound to ${actor.missionId}, not to ${record.id}.`
      )
    }
    return { ok: true, standing: 'worker' }
  }

  const entry = openEntry(record, actor.sessionId)
  if (need === 'operator') {
    return refuse('OPERATOR_ONLY', 'only the operator does this, from the Mission pane.')
  }
  if (need === 'ask-to-attach') {
    return record.status === 'closed'
      ? refuse('MISSION_CLOSED', `${record.id} is closed; start a new mission instead.`)
      : { ok: true, standing: entry?.role ?? 'unattached' }
  }
  if (!entry) {
    return refuse(
      'NOT_ATTACHED',
      `this session is not attached to ${record.id}. Ask to join it with mission_attach (the operator allows or denies), or see the folder's missions with mission_list.`
    )
  }
  if (need === 'read') return { ok: true, standing: entry.role }
  if (record.status === 'closed') {
    return refuse(
      'MISSION_CLOSED',
      `${record.id} is closed; the operator ended it. Stop and report.`
    )
  }
  if (need === 'lead' && entry.role !== 'leads') {
    return refuse(
      'NOT_LEADER',
      `only the session that leads ${record.id} does this; this one worked a step.`
    )
  }
  return { ok: true, standing: entry.role }
}

/**
 * The sessions that built a step: the `session` links on it. A session that built a step only
 * self-checks it; a second session, one that is NOT in this list, may settle its criteria (the verb
 * that does is `mission_settle_ac`, which asks this).
 */
export function buildersOf(record: MissionV4, stepId: string): string[] {
  const step = record.steps.find((s) => s.id === stepId)
  return (step?.links ?? []).filter((l) => l.kind === 'session').map((l) => l.ref)
}

/** Whether `sessionId` built the step, so that anything it says of it is a self-check. */
export function isBuilderOf(record: MissionV4, sessionId: string, stepId: string): boolean {
  return buildersOf(record, stepId).includes(sessionId)
}

// ---- Reads -----------------------------------------------------------------------

export type GuardedRead = MissionRecordRead | { ok: false; error: string; code: GuardCode }

/** Read one mission's detail as `actor`: refused `NOT_ATTACHED` unless the guard allows it. */
export async function readMissionAs(
  folder: string,
  missionId: string,
  actor: Actor
): Promise<GuardedRead> {
  const read = await readMissionRecord(repoRoot(folder), missionId)
  if (!read.ok) return read
  const access = guardMission(read.record, actor, 'read')
  return access.ok ? read : access
}

/** One line per open mission: all a session needs to ask to join one. No steps, criteria, links or history. */
export interface MissionRow {
  id: string
  title: string
  /** "4 of 21 steps done", or "1 of 10 milestones done". */
  headline: string
  /** The session id that leads it, or null. */
  leads: string | null
}

/** The progress line the rows, the pill and the pane share: counts what the mission counts. */
export function headlineOf(progress: Pick<MissionProgress, 'unit' | 'total' | 'done'>): string {
  const unit = progress.total === 1 ? progress.unit.slice(0, -1) : progress.unit
  return `${progress.done} of ${progress.total} ${unit} done`
}

/**
 * The folder's open missions as one-line rows, for any session in the folder, attached or not (the
 * attach picker, and the observe workers). `inputs` carries each mission's per-step facts when the
 * caller has them (see `deriveProgress`); without them the headline counts only what the record says.
 */
export async function listMissionRows(
  folder: string,
  _actor: Actor,
  inputs: Readonly<Record<string, Readonly<Record<string, StepInput>>>> = {}
): Promise<MissionRow[]> {
  const { records } = await listMissionRecords(repoRoot(folder))
  return records
    .filter((r) => r.record.status === 'open')
    .map(({ record }) => ({
      id: record.id,
      title: record.title,
      headline: headlineOf(deriveProgress(record, inputs[record.id])),
      leads: leaderOf(record)
    }))
}
