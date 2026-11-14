/**
 * Missions v4 S-15 (AC-38, AC-39) — attaching a session, and the mission's history of sessions.
 *
 * **Attaching.** The operator's confirmation is needed in exactly two cases, and both end in this
 * module's `worked` entry: a session asks to join (the operator allows it at the door, `doors.ts`
 * `decideAttachRequest`), and the pane's picker attaches a session ({@link attachFromPicker}, which is
 * the confirmed act itself). It is needed in no other case: a session that creates the mission leads it
 * (`createMission` in `write.ts`), and a session dispatched for a step is attached as a worker on that
 * step with no prompt ({@link attachDispatchedWorker}, called by the dispatch paths of S-26): a worker
 * holds only the scoped verbs of its own step, so it can neither lead nor touch another mission (D-19).
 *
 * **Nothing here makes a session lead.** Only the operator's hand-off changes who leads (spec amendment
 * C3-32): every entry these functions append is `worked`, an entry that is already open is never
 * replaced or demoted, and the one-leader rule is the write path's (`TWO_LEADERS`).
 *
 * **The history** is `record.sessions`: one row per attachment with `role`, `from`, `to` and
 * `stoppedAt` (the step it was on and what it was waiting for). It only grows. A row is closed once
 * (`to` and `stoppedAt` set), never reopened, never removed; a session that comes back is a new row.
 * The pure helpers ({@link appendWorked}, {@link releaseEntry}) are exported so a hand-off can compose
 * both changes in one write.
 *
 * Every write goes through the one v4 write path (`write.ts`), so the lock, the caps, the guard and the
 * copy on first write apply, and no v3 file is modified. Electron-free.
 */

import type { RecordChange } from './record-store'
import { openEntry, type Actor, type Need, type Standing } from './guard'
import type { MissionV4, SessionEntry, StepV4, StoppedAt, WithUnknownKeys } from './model'
import { writeMission, type WriteCode } from './write'

// ---- Results shared with the doors ---------------------------------------------------

/** What a door or an attach adds to the write path's refusals: the target is not there. */
export type DoorCode = WriteCode | 'NOT_FOUND' | 'SETTLES_ITSELF'

export interface DoorRefusal {
  ok: false
  code: DoorCode
  /** `CODE: what to do`; never the refused text. */
  error: string
}

/** A door that landed. `changed: false` means the target was already in the state asked for. */
export type DoorResult<X extends object = object> =
  | ({
      ok: true
      changed: boolean
      record: MissionV4
      file: string
      /** Who wrote, by name (S-11): `harnu` for Harnu's own writes, never `operator`. */
      standing: Standing
    } & X)
  | DoorRefusal

/** An error the store turns into a typed refusal with this code. */
export function doorError(code: DoorCode, message: string): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code })
}

/**
 * The one way a door or an attach writes: through `writeMission`, as `actor`, needing `need`. `change`
 * returns the next record and Log, or `null` when the target is already as asked (nothing to change:
 * the record and Log are handed back as they were). It may throw {@link doorError}. It must be a pure
 * function of the record it is given, since the store may run it again on a fresher record.
 */
export async function applyChange(
  folder: string,
  missionId: string,
  actor: Actor,
  need: Exclude<Need, 'read'>,
  change: (record: MissionV4, log: string) => RecordChange | null
): Promise<DoorResult> {
  let changed = false
  const written = await writeMission(folder, missionId, actor, need, (record, log) => {
    const next = change(record, log)
    changed = next !== null
    return next ?? { record, log }
  })
  return written.ok
    ? { ok: true, changed, record: written.record, file: written.file, standing: written.standing }
    : { ok: false, code: written.code, error: written.error }
}

// ---- Small shared helpers -------------------------------------------------------------

/** Every character a reader may take for the end of a line: LF, CR, VT, FF, NEL, LS and PS. */
const LINE_BREAK_CODES = new Set([0x0a, 0x0d, 0x0b, 0x0c, 0x85, 0x2028, 0x2029])

/** `text` on one line: each run of line breaks becomes a single space. */
function oneLine(text: string): string {
  let out = ''
  let inBreak = false
  for (const ch of text) {
    if (LINE_BREAK_CODES.has(ch.codePointAt(0) as number)) {
      if (!inBreak) out += ' '
      inBreak = true
    } else {
      out += ch
      inBreak = false
    }
  }
  return out
}

/**
 * The Log with one more heading: `### <at> · <what>`. The Log is append-only, and the summary reads its
 * `### ` headings, so the heading is ONE line: a text a session staged (a Done when, a request's session
 * id) may hold a line break, and it must not be able to start a line that reads as the operator's.
 * Every line break in `at` and `what` (`\r`, `\n`, U+2028, U+2029, U+0085, vertical tab, form feed)
 * becomes a single space, so no text starts a line.
 */
export function logEntry(log: string, at: string, what: string): string {
  const base = log === '' || log.endsWith('\n') ? log : `${log}\n`
  return `${base}${base === '' ? '' : '\n'}### ${oneLine(at)} · ${oneLine(what)}\n`
}

/** `"<title>"` of a step, the way a reader sees it in the Log; its id only when the record lost the step. */
export function quotedTitle(record: MissionV4, stepId: string): string {
  const step = record.steps.find((s) => s.id === stepId)
  return step ? `"${step.title}"` : stepId
}

/**
 * The Log line for what a dispatch or Harnu did, by who wrote it. Harnu's own writes say `Harnu` and the
 * operator's say `operator`, so a Log never says the operator did what Harnu did. A SESSION may append
 * only `### <time> · note` (the write path refuses any other heading from it), so the text goes under
 * that heading.
 */
function entryBy(log: string, at: string, actor: Actor, what: string): string {
  if (actor.kind === 'session') return `${logEntry(log, at, 'note')}${oneLine(what)}\n`
  return logEntry(log, at, `${actor.kind === 'harnu' ? 'Harnu' : 'operator'} ${what}`)
}

/**
 * The id a step has in this record. A record converted from a v3 campaign renumbers its steps and keeps
 * the old ids in `legacyV3.stepIds` (old to new): a step id the record does not have is looked up there.
 * `null` when neither names a step.
 */
export function resolveStepId(record: MissionV4, stepId: string): string | null {
  if (record.steps.some((s) => s.id === stepId)) return stepId
  const legacy = record.legacyV3
  if (typeof legacy !== 'object' || legacy === null) return null
  const map = (legacy as WithUnknownKeys<object>).stepIds
  if (typeof map !== 'object' || map === null) return null
  const renamed = (map as Record<string, unknown>)[stepId]
  return typeof renamed === 'string' && record.steps.some((s) => s.id === renamed) ? renamed : null
}

// ---- The history: pure helpers ---------------------------------------------------------

/**
 * The sessions with `sessionId` attached as a worker from `at`. A session that already has an open
 * entry (the leader included) is left exactly as it is: never a second entry, never a demotion.
 */
export function appendWorked(
  sessions: readonly SessionEntry[],
  sessionId: string,
  at: string
): SessionEntry[] {
  if (sessions.some((s) => s.id === sessionId && s.to === null)) return [...sessions]
  return [...sessions, { id: sessionId, role: 'worked', from: at, to: null, stoppedAt: null }]
}

/**
 * The sessions with the open entry of `sessionId` closed at `at`, and where it stopped. An entry that
 * is already closed is never touched again; with no open entry nothing changes. Every other row is
 * returned as it was.
 */
export function releaseEntry(
  sessions: readonly SessionEntry[],
  sessionId: string,
  at: string,
  stoppedAt: StoppedAt = {}
): SessionEntry[] {
  const index = sessions.findIndex((s) => s.id === sessionId && s.to === null)
  if (index < 0) return [...sessions]
  return sessions.map((s, i) => (i === index ? { ...s, to: at, stoppedAt } : s))
}

/**
 * Where a session stopped. The caller's own words win; otherwise the step is the last one that links
 * this session, and what it waited for is that step's `waitsFor`. A key with no answer is left out.
 */
export function stoppedAtOf(record: MissionV4, sessionId: string, hint: StoppedAt = {}): StoppedAt {
  const linked: StepV4 | undefined = [...record.steps]
    .reverse()
    .find((s) => s.links.some((l) => l.kind === 'session' && l.ref === sessionId))
  const named = hint.step !== undefined ? record.steps.find((s) => s.id === hint.step) : linked
  const step = hint.step ?? linked?.id
  const waitingFor =
    hint.waitingFor ?? (typeof named?.waitsFor === 'string' ? named.waitsFor : undefined)
  return {
    ...(step !== undefined ? { step } : {}),
    ...(waitingFor !== undefined ? { waitingFor } : {})
  }
}

/** One row of the history as the pane reads it. */
export interface SessionHistoryRow {
  id: string
  role: SessionEntry['role']
  from: string
  to: string | null
  stoppedAt: StoppedAt | null
  /** Still attached: the hand-off or the end has not closed it. */
  open: boolean
}

/** The mission's sessions, oldest first, as rows. */
export function sessionHistory(record: MissionV4): SessionHistoryRow[] {
  return record.sessions.map((s) => ({
    id: s.id,
    role: s.role,
    from: s.from,
    to: s.to,
    stoppedAt: s.stoppedAt ?? null,
    open: s.to === null
  }))
}

// ---- Attaching -------------------------------------------------------------------------

/**
 * The pane's picker attaches a session. The operator has confirmed in the dialog, and this is that
 * confirmed act: it attaches the session as a `worked` one. It never makes it lead, whether or not
 * anyone leads, and a session that is already attached is left as it is.
 */
export async function attachFromPicker(
  folder: string,
  missionId: string,
  args: { sessionId: string; at?: string }
): Promise<DoorResult> {
  const at = args.at ?? new Date().toISOString()
  return applyChange(folder, missionId, { kind: 'operator' }, 'operator', (record, log) => {
    if (openEntry(record, args.sessionId)) return null
    return {
      record: { ...record, sessions: appendWorked(record.sessions, args.sessionId, at) },
      log: logEntry(log, at, `operator attached session ${args.sessionId} as a worker`)
    }
  })
}

/**
 * Attaches a dispatched session as a worker on its step, with no prompt: a session started through
 * `submit_manifest`, a board dispatch, or `create_session` by the leader. The step links the session
 * (it is a builder of that step, so what it says of it is a self-check). `actor` is who dispatched: the
 * leader (a session, which needs to lead) or the app acting for the operator. Idempotent. The role is
 * `worked` and the entry of a session that is already attached, the leader included, is left alone.
 */
export async function attachDispatchedWorker(
  folder: string,
  missionId: string,
  args: { sessionId: string; stepId: string; actor: Actor; at?: string }
): Promise<DoorResult<{ stepId: string }>> {
  const at = args.at ?? new Date().toISOString()
  const need = args.actor.kind === 'session' ? 'lead' : 'operator'
  const result = await applyChange(folder, missionId, args.actor, need, (record, log) => {
    const stepId = resolveStepId(record, args.stepId)
    if (stepId === null) {
      throw doorError('NOT_FOUND', `${record.id} has no step ${args.stepId}.`)
    }
    const link = { kind: 'session', ref: args.sessionId } as const
    const step = record.steps.find((s) => s.id === stepId) as StepV4
    const linked = step.links.some((l) => l.kind === link.kind && l.ref === link.ref)
    const attached = openEntry(record, args.sessionId) !== undefined
    if (linked && attached) return null
    return {
      record: {
        ...record,
        sessions: appendWorked(record.sessions, args.sessionId, at),
        steps: record.steps.map((s) =>
          s.id === stepId && !linked ? { ...s, links: [...s.links, link] } : s
        )
      },
      log: entryBy(
        log,
        at,
        args.actor,
        `attached session ${args.sessionId} as a worker on step ${quotedTitle(record, stepId)}`
      )
    }
  })
  return result.ok
    ? { ...result, stepId: resolveStepId(result.record, args.stepId) ?? args.stepId }
    : result
}

/**
 * A session ends, or the mission releases it: its open entry gets `to` and `stoppedAt` (the caller's
 * `step` and `waitingFor`, else what the record says). The row stays: history is append-only. An
 * entry already closed keeps its first `to`.
 */
export async function endSession(
  folder: string,
  missionId: string,
  args: {
    sessionId: string
    at?: string
    step?: string
    waitingFor?: string
    how?: 'ended' | 'released'
  }
): Promise<DoorResult> {
  const at = args.at ?? new Date().toISOString()
  return applyChange(folder, missionId, { kind: 'harnu' }, 'operator', (record, log) => {
    if (!openEntry(record, args.sessionId)) return null
    const hint: StoppedAt = {
      ...(args.step !== undefined ? { step: resolveStepId(record, args.step) ?? args.step } : {}),
      ...(args.waitingFor !== undefined ? { waitingFor: args.waitingFor } : {})
    }
    return {
      record: {
        ...record,
        sessions: releaseEntry(
          record.sessions,
          args.sessionId,
          at,
          stoppedAtOf(record, args.sessionId, hint)
        )
      },
      log: logEntry(log, at, `Harnu recorded that session ${args.sessionId} ${args.how ?? 'ended'}`)
    }
  })
}
