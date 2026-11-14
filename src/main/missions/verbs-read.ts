/**
 * Missions v4 S-12 (AC-31, AC-32) — the read verbs: `mission_create`, `mission_get`, `mission_list`.
 *
 * Handlers, written and tested through this module's API. Nothing on main calls them until S-24
 * registers them, so the app behaves as before until then. Each takes the folder the caller works in
 * (a worktree is fine: S-11 resolves the repository's main checkout) and who is calling as a plain
 * {@link Actor}: this transport has no per-session identity, S-24 and S-25 supply it.
 *
 * - **`mission_create`** needs no approval. The creating session is attached and LEADS, the mission is
 *   open at once, a mission with no milestones is valid, and every step carries at least one criterion.
 *   It goes through S-11's `createMission` (the writing contract and the cross-references apply to the
 *   whole record; the store's `createMissionRecord` writes it). It creates no card: a step is not
 *   dispatched here (S-26 dispatches).
 * - **`mission_get`** gives the detail to a session attached to the mission and to a Harnu system worker
 *   bound to that mission or folder; any other caller is refused `NOT_ATTACHED` with the way out. The
 *   guard is S-11's `guardMission`: this module owns no copy of the rule. Progress, every step's state,
 *   the waiting list and the summary are derived ONCE per call and shared. **A read writes nothing**:
 *   a mission that exists only as a v3 file is read through S-9's compatibility reader and no v4 record
 *   is created.
 * - **`mission_list`** gives any session in the folder one row per open mission: id, title, headline,
 *   who leads, and never steps, criteria, links or history. A caller that may read a mission's detail
 *   also gets S-8's one-line row for it (`line`); that line names the next thing the operator owes,
 *   which can quote a step or a criterion, so a session that cannot read the mission never gets it.
 *
 * **What one `mission_list` costs.** S-9's store has no cache. A list parses every record of the repo
 * once: one directory listing per store directory, then N file reads and N parses for N v4 records, plus
 * one read and one conversion for each v3 mission or campaign not converted yet. It never reads a record
 * a second time for a row (no per-row `readMissionRecord`), and the derivation per row is pure. An id
 * lookup (`mission_get` with an id) lists its directories again and reads ONE record; with
 * `siblingRoots` it does that once per root.
 *
 * Electron-free. Writes only through S-11's `createMission`.
 */

import { promises as fs, statSync } from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'
import { repoRoot } from '../data-dir'
import { guardMission, headlineOf, leaderOf, openEntry, type Actor } from './guard'
import {
  CRITERION_BY,
  FACTS,
  LINK_KINDS,
  MILESTONE_ID_RE,
  STATE_LABELS,
  type AcceptanceCriterion,
  type Milestone,
  type MissionLink,
  type MissionV4,
  type SessionEntry,
  type StepV4
} from './model'
import { deriveProgress } from './progress'
import {
  listMissionRecords,
  readMissionRecord,
  type MissionRecordRead,
  type MissionRecordView
} from './record-store'
import { type StepInput } from './state'
import { buildMissionSummary, missionListRow } from './summary'
import { deriveStepResults, waitingListV4, type WaitingItemV4, type WaitingListV4 } from './waiting'
import { createMission, newMissionId, type WriteCode } from './write'

// ---- Results ---------------------------------------------------------------------

export type ReadCode = WriteCode | 'AMBIGUOUS_MISSION' | 'STEP_WITHOUT_CRITERION'

/** A refusal: `error` is `CODE: what to do`, `code` the typed reason. Never carries the refused text. */
export interface ReadRefusal {
  ok: false
  code: ReadCode
  error: string
}

const refuse = (code: ReadCode, message: string): ReadRefusal => ({
  ok: false,
  code,
  error: `${code}: ${message}`
})

/** The way out of `NOT_ATTACHED` for a session, worded once (the guard's own sentence says the same). */
const WAY_OUT =
  "Ask to join a mission with mission_attach (the operator allows or denies), or see the folder's missions with mission_list."

/** What the caller supplies beyond the folder and the actor. */
export interface MissionReadOptions {
  /**
   * Per-step facts the record does not hold (card column, pull request state, facts read, a worker
   * working), keyed by step id: the caller's last-known values (see `state.ts`). With none, states
   * read from the record alone.
   */
  inputs?: Readonly<Record<string, StepInput>>
  /**
   * `mission_get` only. Other folders (clones of the same repository) the caller knows hold a copy of
   * the same mission: it answers the copy that was written last, wherever the call was addressed.
   */
  siblingRoots?: readonly string[]
}

// ---- mission_get -------------------------------------------------------------------

const GetInput = z.object({ missionId: z.string().min(1).optional() }).strict()
export type MissionGetInput = z.input<typeof GetInput>

export interface CriterionView {
  id: string
  text: string
  by: AcceptanceCriterion['by']
  fact?: AcceptanceCriterion['fact']
  person?: string
  /** Settled now, by whatever settles it. */
  settled: boolean
  /** How it settled: `fact`, `session`, `operator` or `person`; `null` while open. */
  via: AcceptanceCriterion['by'] | null
  /** A builder's own check: labelled, and never proof. */
  selfCheck?: AcceptanceCriterion['selfCheck']
}

export interface BlockerView {
  id: string
  reason: string
  ask?: string
  unblocks?: string
  owner: 'agent' | 'operator'
  raisedAt?: string
}

export interface StepView {
  id: string
  title: string
  milestone: string | null
  optional: boolean
  /** A state identifier (`todo`, `running`, `waiting-review`, `done`) and its English words. */
  state: string
  stateLabel: string
  /** The blocked mark: an active blocker on a step that is not done. */
  blocked: boolean
  card: string | null
  startedAt: string | null
  waitsFor: string | null
  criteria: CriterionView[]
  /** The ids of the criteria still open. */
  open: string[]
  /** The blockers that still show. */
  blockers: BlockerView[]
  links: MissionLink[]
}

export interface MilestoneView {
  id: string
  title: string
  optional: boolean
  waitsFor: string | null
  state: string
  stateLabel: string
  counts: { running: number; waitingReview: number; blocked: number }
}

export interface MissionDetail {
  ok: true
  /** The id of the record read; `requestedId` only when a v3 id resolved to another record. */
  id: string
  requestedId?: string
  title: string
  doneWhen: string
  status: 'open' | 'closed'
  /** `open`, `ready-to-close` or `closed`, and its words. */
  state: string
  stateLabel: string
  /** Where the caller stands: `leads`, `worked`, `worker` or `operator`. */
  standing: string
  leads: string | null
  source: MissionRecordView['source']
  progress: {
    unit: 'milestones' | 'steps'
    total: number
    done: number
    /** "4 of 21 steps done" or "1 of 10 milestones done". */
    headline: string
    current: { id: string; ordinal: number } | null
    allDone: boolean
    counts: { todo: number; running: number; waitingReview: number; done: number; blocked: number }
  }
  milestones: MilestoneView[]
  steps: StepView[]
  /** Your next step: the first waiting item, or `null`. */
  next: WaitingItemV4 | null
  waiting: WaitingListV4
  /** The mission summary a fresh session starts from (S-8). */
  summary: string
  links: MissionLink[]
  blockers: BlockerView[]
  sessions: SessionEntry[]
}

export type MissionGet = MissionDetail | ReadRefusal

const blockerView = (b: {
  id: string
  reason: string
  ask?: string
  unblocks?: string
  owner: 'agent' | 'operator'
  raisedAt?: string
}): BlockerView => ({
  id: b.id,
  reason: b.reason,
  ...(b.ask !== undefined ? { ask: b.ask } : {}),
  ...(b.unblocks !== undefined ? { unblocks: b.unblocks } : {}),
  owner: b.owner,
  ...(b.raisedAt !== undefined ? { raisedAt: b.raisedAt } : {})
})

/** The newest `### <time>` heading of a Log, in ms, or 0. A write records itself there. */
function newestLogStamp(log: string): number {
  let newest = 0
  for (const line of log.split(/\r?\n/)) {
    if (!line.startsWith('### ')) continue
    const at = Date.parse(line.slice(4).split(' · ')[0].trim())
    if (Number.isFinite(at) && at > newest) newest = at
  }
  return newest
}

/**
 * Read one id from the home root and from every sibling root that exists, and answer the copy written
 * last: by the newest Log entry, then by the file's own modification time, then by path (so the answer
 * never depends on the order the roots were given). A v4 record carries no `updatedAt`; its append-only
 * Log is how a write records itself. Reads only: a sibling with no `.harnu` is skipped, never created.
 */
async function readWinner(
  folder: string,
  missionId: string,
  siblings: readonly string[]
): Promise<MissionRecordRead> {
  const home = repoRoot(folder)
  const roots = [home]
  for (const s of siblings) {
    const r = repoRoot(s)
    if (roots.includes(r)) continue
    try {
      if (!statSync(r).isDirectory() || !statSync(path.join(r, '.harnu')).isDirectory()) continue
    } catch {
      continue
    }
    roots.push(r)
  }
  const reads = await Promise.all(
    roots.map(async (root) => ({ root, read: await readMissionRecord(root, missionId) }))
  )
  const found = reads.filter(
    (r): r is { root: string; read: Extract<MissionRecordRead, { ok: true }> } => r.read.ok
  )
  if (found.length === 0) return reads[0].read
  if (found.length === 1) return found[0].read
  const ranked = await Promise.all(
    found.map(async (f) => ({
      ...f,
      stamp: newestLogStamp(f.read.log),
      modified: (await fs.stat(f.read.file).catch(() => null))?.mtimeMs ?? 0
    }))
  )
  ranked.sort(
    (a, b) =>
      b.stamp - a.stamp ||
      b.modified - a.modified ||
      (a.root < b.root ? -1 : a.root > b.root ? 1 : 0)
  )
  return ranked[0].read
}

/** The open mission a session is attached to when it names none: the one it leads, else the only one. */
async function attachedMission(folder: string, sessionId: string): Promise<MissionRecordRead> {
  const { records } = await listMissionRecords(repoRoot(folder))
  const mine = records.filter(
    (v) => v.record.status === 'open' && openEntry(v.record, sessionId) !== undefined
  )
  if (mine.length === 1) return { ok: true, ...mine[0] }
  if (mine.length === 0) {
    return {
      ok: false,
      code: 'NOT_ATTACHED',
      error: `NOT_ATTACHED: this session is not attached to any open mission in this folder. ${WAY_OUT}`
    }
  }
  const leading = mine.filter((v) => leaderOf(v.record) === sessionId)
  if (leading.length === 1) return { ok: true, ...leading[0] }
  return {
    ok: false,
    code: 'AMBIGUOUS_MISSION',
    error: `AMBIGUOUS_MISSION: this session is attached to ${mine.length} open missions (${mine
      .map((v) => v.record.id)
      .join(', ')}); name one with missionId.`
  }
}

/**
 * The detail of one mission. Refused `NOT_ATTACHED` with the way out unless the caller is a session
 * attached to it, a Harnu system worker bound to it or to the folder, or the app itself. With no
 * `missionId` a session gets the open mission it is attached to. Derives once, writes nothing.
 */
export async function missionGet(
  folder: string,
  actor: Actor,
  input: MissionGetInput,
  opts: MissionReadOptions = {}
): Promise<MissionGet> {
  const parsed = GetInput.safeParse(input ?? {})
  if (!parsed.success) return refuse('BAD_ARGS', describe(parsed.error))
  const { missionId } = parsed.data

  let read: MissionRecordRead
  if (missionId !== undefined) {
    read = await readWinner(folder, missionId, opts.siblingRoots ?? [])
  } else if (actor.kind === 'session') {
    read = await attachedMission(folder, actor.sessionId)
  } else {
    return refuse('BAD_ARGS', 'name the mission with missionId.')
  }
  if (!read.ok) return { ok: false, code: read.code as ReadCode, error: read.error }

  const access = guardMission(read.record, actor, 'read')
  if (!access.ok) return { ok: false, code: access.code, error: access.error }

  const { record, log } = read
  const inputs = opts.inputs ?? {}
  // Derived once and shared: the waiting list and the summary take these instead of deriving again.
  const progress = deriveProgress(record, inputs)
  const results = deriveStepResults(record, inputs)
  const waiting = waitingListV4(record, { inputs, progress, results })
  const summary = buildMissionSummary(record, log, { inputs, progress, results }).text

  const steps: StepView[] = record.steps.map((step) => {
    const result = results[step.id]
    const stepProgress = progress.steps.find((s) => s.id === step.id)
    return {
      id: step.id,
      title: step.title,
      milestone: step.milestone ?? null,
      optional: stepProgress?.optional ?? step.optional === true,
      state: result.state,
      stateLabel: STATE_LABELS[result.state],
      blocked: result.blocked,
      card: step.card ?? null,
      startedAt: step.startedAt ?? null,
      waitsFor: step.waitsFor ?? null,
      criteria: step.acs.map((ac) => {
        const c = result.criteria.find((x) => x.id === ac.id)
        return {
          id: ac.id,
          text: ac.text,
          by: ac.by,
          ...(ac.fact !== undefined ? { fact: ac.fact } : {}),
          ...(ac.person !== undefined ? { person: ac.person } : {}),
          settled: c?.settled ?? false,
          via: c?.via ?? null,
          ...(ac.selfCheck !== undefined ? { selfCheck: ac.selfCheck } : {})
        }
      }),
      open: result.open.map((c) => c.id),
      blockers: result.blockers.map(blockerView),
      links: step.links
    }
  })

  const milestones: MilestoneView[] = progress.milestones.map((m) => ({
    id: m.id,
    title: m.title,
    optional: m.optional,
    waitsFor: record.milestones.find((x) => x.id === m.id)?.waitsFor ?? null,
    state: m.state,
    stateLabel: STATE_LABELS[m.state],
    counts: m.counts
  }))

  return {
    ok: true,
    id: record.id,
    ...(missionId !== undefined && missionId !== record.id ? { requestedId: missionId } : {}),
    title: record.title,
    doneWhen: record.doneWhen,
    status: record.status,
    state: progress.missionState,
    stateLabel: STATE_LABELS[progress.missionState],
    standing: access.standing,
    leads: leaderOf(record),
    source: read.source,
    progress: {
      unit: progress.unit,
      total: progress.total,
      done: progress.done,
      headline: headlineOf(progress),
      current: progress.current,
      allDone: progress.allDone,
      counts: progress.counts
    },
    milestones,
    steps,
    next: waiting.next,
    waiting,
    summary,
    links: record.links,
    blockers: record.blockers.map(blockerView),
    sessions: record.sessions
  }
}

// ---- mission_list --------------------------------------------------------------------

/** One line per open mission. No step, criterion, link or history, ever. */
export interface ListedMission {
  id: string
  title: string
  /** "4 of 21 steps done", or "1 of 10 milestones done". */
  headline: string
  /** The session id that leads it, or null. */
  leads: string | null
  /**
   * S-8's one-line row (title, progress in words, the next thing the operator owes). Present only for a
   * caller that may read this mission's detail: the next thing can quote a step or a criterion.
   */
  line?: string
}

export type MissionList = { ok: true; missions: ListedMission[] } | ReadRefusal

/**
 * The folder's open missions as one-line rows, for any session in the folder, attached or not. One
 * store pass for the whole list; see the module comment for its cost.
 */
export async function missionList(
  folder: string,
  actor: Actor,
  opts: { inputs?: Readonly<Record<string, Readonly<Record<string, StepInput>>>> } = {}
): Promise<MissionList> {
  const { records } = await listMissionRecords(repoRoot(folder))
  const missions = records
    .filter((v) => v.record.status === 'open')
    .map(({ record }): ListedMission => {
      const stepInputs = opts.inputs?.[record.id] ?? {}
      const row: ListedMission = {
        id: record.id,
        title: record.title,
        headline: headlineOf(deriveProgress(record, stepInputs)),
        leads: leaderOf(record)
      }
      if (guardMission(record, actor, 'read').ok) {
        row.line = missionListRow(record, { inputs: stepInputs })
      }
      return row
    })
  return { ok: true, missions }
}

// ---- mission_create ------------------------------------------------------------------

const LinkInput = z.object({ kind: z.enum(LINK_KINDS), ref: z.string().min(1) }).strict()

const CriterionInput = z.union([
  z.string().min(1),
  z
    .object({
      text: z.string().min(1),
      by: z.enum(CRITERION_BY).optional(),
      fact: z.enum(FACTS).optional(),
      person: z.string().min(1).optional()
    })
    .strict()
])

const MilestoneInput = z
  .object({
    title: z.string().min(1),
    optional: z.boolean().optional(),
    waitsFor: z.string().min(1).nullable().optional()
  })
  .strict()

const StepInputSchema = z
  .object({
    title: z.string().min(1),
    milestone: z.string().min(1).optional(),
    optional: z.boolean().optional(),
    criteria: z.array(CriterionInput),
    links: z.array(LinkInput).optional(),
    waitsFor: z.string().min(1).nullable().optional()
  })
  .strict()

const CreateInput = z
  .object({
    title: z.string().min(1),
    doneWhen: z.string().min(1),
    milestones: z.array(MilestoneInput).optional(),
    steps: z.array(StepInputSchema),
    links: z.array(LinkInput).optional()
  })
  .strict()
export type MissionCreateInput = z.input<typeof CreateInput>

export interface RecallEntry {
  page: string
  line: number
  text: string
}

export interface MissionCreateOptions {
  /** The clock, for tests. */
  now?: () => Date
  /**
   * Live memory entries that watch this scope, which the caller read (S-24 reads memory); echoed in the
   * ACK so the leader reads them before planning. They are context, not instructions.
   */
  recall?: readonly RecallEntry[]
}

export interface MissionCreated {
  ok: true
  id: string
  title: string
  state: string
  stateLabel: string
  standing: string
  leads: string | null
  headline: string
  milestones: { id: string; title: string }[]
  steps: { id: string; title: string; milestone: string | null }[]
  summary: string
  recall: RecallEntry[]
  file: string
}

export type MissionCreate = MissionCreated | ReadRefusal

/** One line of what is wrong with an input, never the text that was passed. */
function describe(error: z.ZodError): string {
  const dropped = new Set(['campaignId', 'chapterId', 'steward', 'declaredEnd'])
  return error.issues
    .map((i) => {
      const where = i.path.length > 0 ? i.path.join('.') : '(input)'
      if (i.code === 'unrecognized_keys') {
        const keys = i.keys.join(', ')
        const gone = i.keys.some((k) => dropped.has(k))
          ? ' A v4 mission has no campaign, chapter, steward or declared end: it has a title, a Done when, milestones and steps.'
          : ''
        return `${where}: ${keys} is not a field of this verb.${gone}`
      }
      return `${where}: ${i.message}`
    })
    .join('; ')
}

/** A milestone named by its id (`mls-2`) or by its exact title; `undefined` when it names none. */
function resolveMilestone(ref: string, milestones: readonly Milestone[]): Milestone | undefined {
  if (MILESTONE_ID_RE.test(ref)) {
    const byId = milestones.find((m) => m.id === ref)
    if (byId) return byId
  }
  const wanted = ref.trim().toLowerCase()
  const byTitle = milestones.filter((m) => m.title.trim().toLowerCase() === wanted)
  return byTitle.length === 1 ? byTitle[0] : undefined
}

const knownMilestones = (milestones: readonly Milestone[]): string =>
  milestones.length === 0
    ? 'the mission has no milestones'
    : `known: ${milestones.map((m) => `${m.id} "${m.title}"`).join(', ')}`

/**
 * Create a mission. The creating session is attached and leads it, with no confirmation; the mission is
 * open at once. Needs no card, no approval and no milestone. The writing contract applies on write
 * (S-11's path), and a refusal stores nothing.
 */
export async function missionCreate(
  folder: string,
  actor: Actor,
  input: MissionCreateInput,
  opts: MissionCreateOptions = {}
): Promise<MissionCreate> {
  if (actor.kind === 'session' && actor.sessionId.trim() === '') {
    return refuse(
      'BAD_ARGS',
      'a session that creates a mission names itself: the session id is empty.'
    )
  }
  const parsed = CreateInput.safeParse(input)
  if (!parsed.success) return refuse('BAD_ARGS', describe(parsed.error))
  const given = parsed.data
  // Whole seconds, as every other timestamp of a record.
  const now = (opts.now ?? (() => new Date()))()
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')

  // Milestones first (ids in plan order), so a step and a `waitsFor` can name one.
  const milestones: Milestone[] = (given.milestones ?? []).map((m, i) => ({
    id: `mls-${i + 1}`,
    title: m.title,
    optional: m.optional === true,
    waitsFor: null
  }))
  for (const [i, m] of (given.milestones ?? []).entries()) {
    if (m.waitsFor === undefined || m.waitsFor === null) continue
    const target = resolveMilestone(m.waitsFor, milestones)
    if (!target || target.id === milestones[i].id) {
      return refuse(
        'UNKNOWN_MILESTONE',
        `milestone ${milestones[i].id} waits for a milestone the mission does not have (${knownMilestones(milestones)}).`
      )
    }
    milestones[i].waitsFor = target.id
  }

  const steps: StepV4[] = []
  for (const [i, s] of given.steps.entries()) {
    const id = `stp-${i + 1}`
    if (s.criteria.length === 0) {
      return refuse(
        'STEP_WITHOUT_CRITERION',
        `step ${id} "${s.title}" has no criterion; add at least one fact that is true when it is done.`
      )
    }
    let milestone: string | undefined
    if (s.milestone !== undefined) {
      const m = resolveMilestone(s.milestone, milestones)
      if (!m) {
        return refuse(
          'UNKNOWN_MILESTONE',
          `step ${id} names a milestone the mission does not have (${knownMilestones(milestones)}).`
        )
      }
      milestone = m.id
    }
    const acs: AcceptanceCriterion[] = []
    for (const [j, c] of s.criteria.entries()) {
      const at = `step ${id} criterion ${j + 1}`
      const spec = typeof c === 'string' ? { text: c } : c
      const by =
        spec.by ??
        ('fact' in spec && spec.fact
          ? 'fact'
          : 'person' in spec && spec.person
            ? 'person'
            : 'session')
      const fact = 'fact' in spec ? spec.fact : undefined
      const person = 'person' in spec ? spec.person : undefined
      if (by === 'fact' && fact === undefined) {
        return refuse(
          'BAD_ARGS',
          `${at}: a criterion a fact settles names the fact (${FACTS.join(', ')}).`
        )
      }
      if (by !== 'fact' && fact !== undefined) {
        return refuse('BAD_ARGS', `${at}: fact is only for a criterion with by: fact.`)
      }
      if (by === 'person' && person === undefined) {
        return refuse('BAD_ARGS', `${at}: a criterion another person approves names the person.`)
      }
      if (by !== 'person' && person !== undefined) {
        return refuse('BAD_ARGS', `${at}: person is only for a criterion with by: person.`)
      }
      acs.push({
        id: `ac-${j + 1}`,
        text: spec.text,
        by,
        ...(fact !== undefined ? { fact } : {}),
        ...(person !== undefined ? { person } : {})
      })
    }
    steps.push({
      id,
      ...(milestone !== undefined ? { milestone } : {}),
      title: s.title,
      ...(s.optional === true ? { optional: true } : {}),
      acs,
      links: s.links ?? [],
      blockers: [],
      ...(s.waitsFor !== undefined ? { waitsFor: s.waitsFor } : {})
    })
  }

  const record: MissionV4 = {
    schemaVersion: 4,
    id: newMissionId(),
    title: given.title,
    doneWhen: given.doneWhen,
    status: 'open',
    milestones,
    steps,
    // The creating session leads, open, with no request and no confirmation. The operator's own
    // creation has no leader: it is not a session.
    sessions:
      actor.kind === 'session' ? [{ id: actor.sessionId, role: 'leads', from: now, to: null }] : [],
    links: given.links ?? [],
    blockers: []
  }
  const log = `### ${now}\nMission created${actor.kind === 'session' ? ` by session ${actor.sessionId}, which leads it` : ' by the operator'}.\n`

  const created = await createMission(folder, actor, record, log)
  if (!created.ok) return { ok: false, code: created.code, error: created.error }

  const progress = deriveProgress(record)
  return {
    ok: true,
    id: record.id,
    title: record.title,
    state: progress.missionState,
    stateLabel: STATE_LABELS[progress.missionState],
    standing: actor.kind === 'session' ? 'leads' : 'operator',
    leads: leaderOf(record),
    headline: headlineOf(progress),
    milestones: milestones.map((m) => ({ id: m.id, title: m.title })),
    steps: steps.map((s) => ({ id: s.id, title: s.title, milestone: s.milestone ?? null })),
    summary: buildMissionSummary(record, log, { progress }).text,
    recall: [...(opts.recall ?? [])],
    file: created.file
  }
}
