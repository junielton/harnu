/**
 * Missions v4 S-11 (AC-30) — the one v4 write path.
 *
 * Every write of every v4 verb and operator door goes through {@link writeMission} (an existing
 * mission) or {@link createMission} (a new one), so the verb slices own no shared code. A write:
 *
 * 1. takes the lock: `updateMissionRecord` runs the whole read-modify-write of one mission under one
 *    lock, and the guard is judged INSIDE it, on the record being written, so an attachment that
 *    changed a moment ago is the one that counts;
 * 2. passes the guard (`guard.ts`): NOT_ATTACHED with the way out, NOT_LEADER, OPERATOR_ONLY,
 *    MISSION_CLOSED;
 * 3. is checked against what a session may never do (below);
 * 4. is checked against the writing contract (`contract.ts`) and the record's cross-references;
 * 5. is stored by S-9's store, which does the copy on first write for a mission born in v3 and never
 *    modifies a v3 file. A refused write stores nothing, and creates no v4 record.
 *
 * **What a session may never do** (the operator's decision of 2026-11-14: only the operator changes who
 * leads): set or move `leads` (the entries of `sessions` are append-only for a session, and what it
 * appends is a `worked` entry, which only the leader may do), close the mission, change Done when, or
 * decide an attach request. An unattached session may write one thing: its own request to attach
 * (`attachRequests`), and nothing else. The hand-off door is the operator's.
 *
 * **Caps on write, never on read.** The contract is applied to the fields a write ADDED or CHANGED,
 * compared with the record as it was read. A field the change did not touch is written back as it is,
 * so an old over-long text stays readable and an unrelated change can still land; touching that field
 * is judged against today's contract. The same goes for the cross-reference checks (a record read from
 * v3 that already breaks one is not refused for it; a write may not add a new breach).
 *
 * **The folder is any folder a session works in**, a worktree included: every function here resolves the
 * repository's main checkout itself (`repoRoot`, cached, no `git` spawned) and hands THAT to the store,
 * so every worktree of a repo reads and writes one record.
 *
 * Reads v3 only through the store (AC-26). Electron-free.
 */

import { randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { repoRoot } from '../data-dir'
import {
  checkAsk,
  checkBlockerReason,
  checkCriterion,
  checkMilestoneTitle,
  checkMissionTitle,
  checkStepTitle,
  checkWhy,
  type ContractCode,
  type ContractResult
} from './contract'
import { guardMission, isBuilderOf, type Actor, type GuardCode, type Need } from './guard'
import { AttachRequestSchema, MISSION_V4_ID_RE, type BlockerV4, type MissionV4 } from './model'
import {
  createMissionRecord,
  readMissionRecord,
  updateMissionRecord,
  type RecordChange
} from './record-store'

// ---- Results ---------------------------------------------------------------------

export type WriteCode =
  | GuardCode
  | ContractCode
  | 'LEADER_IS_OPERATORS'
  | 'TWO_LEADERS'
  | 'DUPLICATE_ID'
  | 'UNKNOWN_MILESTONE'
  | 'STEP_WITHOUT_MILESTONE'
  | 'MISSION_BLOCKER_FACT'
  | 'SETTLE_NOT_ALLOWED'
  | 'LEADER_NOT_CALLER'
  | 'MISSION_EXISTS'
  | 'BAD_ARGS'
  | 'WRITE_REFUSED'
  | 'MISSION_NOT_FOUND'
  | 'MISSION_UNREADABLE'
  | 'WRITE_CONFLICT'

export interface WriteRefusal {
  ok: false
  /** `CODE: what to do`; names where (`at`) and never carries the refused text. */
  error: string
  code: WriteCode
}

export type MissionWrite =
  | {
      ok: true
      record: MissionV4
      log: string
      file: string
      /** The first v4 write of a mission born in v3: its v4 record was just created by copy. */
      created: boolean
    }
  | WriteRefusal

class Refusal extends Error {
  constructor(
    readonly code: WriteCode,
    message: string
  ) {
    super(`${code}: ${message}`)
  }
}

const refusalOf = (e: Refusal): WriteRefusal => ({ ok: false, code: e.code, error: e.message })

/** A store refusal as this module's: the store already gives it a typed `code` and a `CODE: …` error. */
function typed(refusal: { code: string; error: string }): WriteRefusal {
  return { ok: false, code: refusal.code as WriteCode, error: refusal.error }
}

// ---- What a session may never do -------------------------------------------------

const LEAD_MSG =
  'only the operator changes who leads a mission: a session never sets or moves it. The hand-off door in the Mission pane does.'

/**
 * A session's change to `sessions`: every existing entry stays exactly as it was (so `leads` is never
 * set, moved, released or removed) and what it appends is an open `worked` entry, which only the leader
 * may do (it is a dispatch).
 */
function checkSessionsUntouched(before: MissionV4, after: MissionV4, standing: string): void {
  const prior = before.sessions
  const next = after.sessions
  const keeps = next.length >= prior.length && prior.every((s, i) => isDeepStrictEqual(s, next[i]))
  const added = next.slice(prior.length)
  if (!keeps || added.some((s) => s.role !== 'worked' || s.to !== null)) {
    throw new Refusal('LEADER_IS_OPERATORS', LEAD_MSG)
  }
  if (added.length > 0 && standing !== 'leads') {
    throw new Refusal('NOT_LEADER', 'only the session that leads this mission dispatches a worker.')
  }
}

/** The fields no session writes: the operator's doors. */
function checkOperatorFields(before: MissionV4, after: MissionV4): void {
  const same = (k: keyof MissionV4): boolean => isDeepStrictEqual(before[k], after[k])
  for (const [key, what] of [
    ['status', 'closing the mission'],
    ['closedAs', 'closing the mission'],
    ['closeReason', 'closing the mission'],
    ['doneWhen', 'changing Done when (stage a change for the operator instead)']
  ] as const) {
    if (!same(key))
      throw new Refusal('OPERATOR_ONLY', `${what} is the operator's door, not a session's.`)
  }
  if (!isDeepStrictEqual(before.attachRequests, after.attachRequests)) {
    throw new Refusal(
      'OPERATOR_ONLY',
      "deciding an attach request is the operator's door; a session asks with mission_attach."
    )
  }
}

/**
 * Who settles a criterion (spec "What settles a criterion"). A session writes a `settled` stamp only
 * on a criterion a second session settles (`by: session`), in its own name, and only on a step it did
 * not build: a builder's check is a `selfCheck`, labelled and never proof, which carries the builder's
 * own id and settles nothing. A fact settles itself, and the operator marks the other two; no session
 * writes a stamp for either. Judged only on stamps the write added or changed.
 */
function checkSettlements(before: MissionV4, after: MissionV4, sessionId: string): void {
  for (const step of after.steps) {
    const prev = before.steps.find((p) => p.id === step.id)
    for (const ac of step.acs) {
      const old = prev?.acs.find((p) => p.id === ac.id)
      const at = `step ${step.id} criterion ${ac.id}`
      if (ac.settled && !isDeepStrictEqual(ac.settled, old?.settled)) {
        if (ac.by !== 'session') {
          throw new Refusal(
            'SETTLE_NOT_ALLOWED',
            `${at} is settled by a fact or by the operator, not by a session.`
          )
        }
        if (ac.settled.by !== sessionId) {
          throw new Refusal('SETTLE_NOT_ALLOWED', `${at}: a session settles in its own name only.`)
        }
        if (isBuilderOf(after, sessionId, step.id)) {
          throw new Refusal(
            'SETTLE_NOT_ALLOWED',
            `${at}: this session built the step, so what it says of it is a self-check, which settles nothing. A second session settles it.`
          )
        }
      }
      if (
        ac.selfCheck &&
        !isDeepStrictEqual(ac.selfCheck, old?.selfCheck) &&
        ac.selfCheck.by !== sessionId
      ) {
        throw new Refusal(
          'SETTLE_NOT_ALLOWED',
          `${at}: a self-check carries the id of the session that wrote it.`
        )
      }
    }
  }
}

/**
 * A session that asks to attach writes its own request and nothing else: not a field, not a Log line,
 * not another session's request, not a decision, never a request to lead.
 */
function checkAskOnly(
  before: MissionV4,
  beforeLog: string,
  next: RecordChange,
  sessionId: string
): void {
  const strip = (r: MissionV4): Record<string, unknown> => {
    const { attachRequests: _ignored, ...rest } = r
    return rest
  }
  if (next.log !== beforeLog || !isDeepStrictEqual(strip(before), strip(next.record))) {
    throw new Refusal(
      'NOT_ATTACHED',
      'a session that is not attached writes only its request to attach, and nothing else.'
    )
  }
  const asked = (r: MissionV4): unknown[] => (r.attachRequests ?? []) as unknown[]
  const prior = asked(before)
  const now = asked(next.record)
  if (now.length < prior.length || !prior.every((p, i) => isDeepStrictEqual(p, now[i]))) {
    throw new Refusal('OPERATOR_ONLY', 'an earlier attach request is not changed by a session.')
  }
  for (const raw of now.slice(prior.length)) {
    if ((raw as { role?: unknown } | null)?.role === 'leads')
      throw new Refusal('LEADER_IS_OPERATORS', LEAD_MSG)
    const parsed = AttachRequestSchema.safeParse(raw)
    if (!parsed.success) throw new Refusal('BAD_ARGS', 'the attach request is not well formed.')
    const req = parsed.data
    if (req.decision !== null) {
      throw new Refusal('OPERATOR_ONLY', "deciding an attach request is the operator's door.")
    }
    if (req.sessionId !== sessionId || req.missionId !== before.id) {
      throw new Refusal(
        'NOT_ATTACHED',
        'a session asks to attach only itself, and only to this mission.'
      )
    }
  }
}

// ---- Cross-references --------------------------------------------------------------

/** Breaches of what the schema cannot say: unique ids, a step in a real milestone, one open leader. */
function breaches(record: MissionV4): string[] {
  const out: string[] = []
  const dup = (kind: string, ids: string[]): void => {
    for (const id of new Set(ids.filter((x, i) => ids.indexOf(x) !== i)))
      out.push(`DUPLICATE_ID:${kind} ${id}`)
  }
  dup(
    'milestone',
    record.milestones.map((m) => m.id)
  )
  dup(
    'step',
    record.steps.map((s) => s.id)
  )
  const milestones = new Set(record.milestones.map((m) => m.id))
  for (const s of record.steps) {
    if (s.milestone !== undefined && !milestones.has(s.milestone)) {
      out.push(`UNKNOWN_MILESTONE:${s.id} ${s.milestone}`)
    }
  }
  if (record.milestones.length > 0) {
    for (const s of record.steps) {
      if (s.milestone === undefined) out.push(`STEP_WITHOUT_MILESTONE:${s.id}`)
    }
  }
  for (const b of record.blockers) {
    if (b.clearsWhen !== undefined) out.push(`MISSION_BLOCKER_FACT:${b.id}`)
  }
  if (record.sessions.filter((s) => s.role === 'leads' && s.to === null).length > 1) {
    out.push('TWO_LEADERS:')
  }
  return out
}

/** The breaches a write ADDS (a record read from an older build may already hold some). */
function checkReferences(before: MissionV4 | null, after: MissionV4): void {
  const known = new Set(before ? breaches(before) : [])
  const found = breaches(after).find((b) => !known.has(b))
  if (!found) return
  const [code, what] = found.split(':') as [WriteCode, string]
  const message: Record<string, string> = {
    DUPLICATE_ID: `${what} is used twice; an id is never reused.`,
    UNKNOWN_MILESTONE: `step ${what.split(' ')[0]} names milestone ${what.split(' ')[1]}, which the mission does not have.`,
    STEP_WITHOUT_MILESTONE: `step ${what} names no milestone, and a mission that has milestones places every step in one.`,
    MISSION_BLOCKER_FACT: `blocker ${what} is on the mission and names a fact to clear on; a fact belongs to a step's blocker.`,
    TWO_LEADERS: 'a mission has at most one leader.'
  }
  throw new Refusal(code, message[code])
}

// ---- The writing contract, on what a write changed ----------------------------------

function demand(at: string, result: ContractResult): void {
  if (!result.ok) throw new Refusal(result.code, `${result.message} (at ${at})`)
}

function checkBlockers(
  before: readonly BlockerV4[],
  after: readonly BlockerV4[],
  at: string
): void {
  for (const b of after) {
    const prev = before.find((p) => p.id === b.id)
    const here = `${at} ${b.id}`
    if (!prev || prev.reason !== b.reason) demand(here, checkBlockerReason(b.reason))
    if (b.ask !== undefined && b.ask !== prev?.ask) demand(here, checkAsk(b.ask))
    if (b.unblocks !== undefined && b.unblocks !== prev?.unblocks) {
      const r = checkWhy(b.unblocks)
      demand(here, r.ok ? r : { ...r, field: 'unblocks' })
    }
  }
}

/** Judge every text the write added or changed, and no other. `before` is null for a new mission. */
function checkContract(before: MissionV4 | null, after: MissionV4): void {
  if (!before || after.title !== before.title)
    demand('the mission title', checkMissionTitle(after.title))
  for (const m of after.milestones) {
    const prev = before?.milestones.find((p) => p.id === m.id)
    if (!prev || prev.title !== m.title) demand(`milestone ${m.id}`, checkMilestoneTitle(m.title))
  }
  for (const s of after.steps) {
    const prev = before?.steps.find((p) => p.id === s.id)
    if (!prev || prev.title !== s.title) demand(`step ${s.id}`, checkStepTitle(s.title))
    for (const ac of s.acs) {
      const old = prev?.acs.find((p) => p.id === ac.id)
      if (!old || old.text !== ac.text)
        demand(`step ${s.id} criterion ${ac.id}`, checkCriterion(ac.text))
    }
    checkBlockers(prev?.blockers ?? [], s.blockers, `step ${s.id} blocker`)
  }
  checkBlockers(before?.blockers ?? [], after.blockers, 'mission blocker')
}

// ---- Writing an existing mission ----------------------------------------------------

/**
 * The one write. `change` receives the mission as it is under the lock and returns what it should
 * become; nothing is stored unless every check passes. `need` says what the verb or door is: `write`
 * (any attached session), `lead` (the leader only), `operator` (a door), `ask-to-attach` (the one write
 * an unattached session may make).
 */
export async function writeMission(
  folder: string,
  missionId: string,
  actor: Actor,
  need: Exclude<Need, 'read'>,
  change: (record: MissionV4, log: string) => RecordChange | Promise<RecordChange>
): Promise<MissionWrite> {
  const root = repoRoot(folder)

  // The guard first, before the store takes its lock: a session that is refused takes no lock and
  // creates no directory. It is judged again inside the lock, on the record being written.
  const peek = await readMissionRecord(root, missionId)
  if (!peek.ok) return typed(peek)
  const early = guardMission(peek.record, actor, need)
  if (!early.ok) return early

  // `change` of the store may run more than once (a compare-and-swap that lost retries it): this one
  // keeps no state outside the record it is given, so each run is the same function of it.
  const result = await updateMissionRecord(root, missionId, async (record, log) => {
    const access = guardMission(record, actor, need)
    if (!access.ok) throw new Refusal(access.code, access.error.replace(/^[A-Z_]+: /, ''))
    const next = await change(record, log)
    if (actor.kind === 'session') {
      if (need === 'ask-to-attach') checkAskOnly(record, log, next, actor.sessionId)
      else {
        checkOperatorFields(record, next.record)
        checkSessionsUntouched(record, next.record, access.standing)
        checkSettlements(record, next.record, actor.sessionId)
      }
    }
    checkReferences(record, next.record)
    if (!(actor.kind === 'session' && need === 'ask-to-attach')) checkContract(record, next.record)
    return next
  })
  // A throw inside `change` comes back from the store as a typed refusal that keeps its `code`.
  return result.ok ? result : typed(result)
}

// ---- Creating a mission --------------------------------------------------------------

/** A fresh mission id: `mnt-` and 8 hex. */
export function newMissionId(): string {
  return `mnt-${randomBytes(4).toString('hex')}`
}

/** The slug of a record's file name: its title, lower-case words joined by `-`. */
export function slugOfTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  return slug === '' ? 'mission' : slug
}

export type MissionCreate = { ok: true; record: MissionV4; file: string } | WriteRefusal

/**
 * Create a mission. A session that creates one leads it, with no confirmation (the record names that
 * session as its only entry, `leads`, open); the operator may create one with any shape. The caps and
 * the cross-references apply to the whole record. An id already taken is never overwritten.
 */
export async function createMission(
  folder: string,
  actor: Actor,
  record: MissionV4,
  log: string
): Promise<MissionCreate> {
  try {
    if (actor.kind === 'worker') {
      throw new Refusal('READ_ONLY', 'a Harnu system worker reads a mission and never creates one.')
    }
    if (!MISSION_V4_ID_RE.test(record.id))
      throw new Refusal('BAD_ARGS', `${record.id} is not a mission id.`)
    if (actor.kind === 'session') {
      const [only, ...rest] = record.sessions
      const asked = record.attachRequests ?? []
      if (
        !only ||
        rest.length > 0 ||
        only.id !== actor.sessionId ||
        only.role !== 'leads' ||
        only.to !== null ||
        asked.length > 0
      ) {
        throw new Refusal(
          'LEADER_NOT_CALLER',
          'a mission is created by the session that leads it: its only session is the caller, as leader.'
        )
      }
      if (record.status !== 'open') throw new Refusal('OPERATOR_ONLY', 'a new mission starts open.')
    }
    checkReferences(null, record)
    checkContract(null, record)
    const result = await createMissionRecord(
      repoRoot(folder),
      record,
      log,
      slugOfTitle(record.title)
    )
    return result.ok ? { ok: true, record, file: result.file } : typed(result)
  } catch (e) {
    if (e instanceof Refusal) return refusalOf(e)
    throw e
  }
}
