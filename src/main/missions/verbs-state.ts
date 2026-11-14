/**
 * Missions v4 S-14 (AC-35, AC-36) — the state verbs: `mission_set_blocker`, `mission_clear_blocker`,
 * `mission_set_done_when`, `mission_settle_ac`, `mission_request_close` and `mission_attach`.
 *
 * Each handler is one call of S-11's `writeMission` (the lock, the one guard, the caps and the copy on
 * first write), so this module owns no attachment rule and no store path: it takes the folder the
 * caller works in and the caller as plain arguments (this transport has no per-session identity; S-24
 * and S-25 supply them). What it adds is what each verb means:
 *
 * - **Blockers** carry an id (`blk-<n>`, counted across the whole mission and never reused: a cleared
 *   id stays in the Log). Setting the same one twice (same place, same reason, same owner) stores it
 *   once. A session clears an agent-owned blocker; an operator-owned one is the operator's to clear.
 * - **Done when** is never rewritten by a verb: a change is staged in `pendingDoneWhen` for the
 *   operator, who approves it at the door (S-15).
 * - **Settle**: a session that did NOT build the step settles a `by: session` criterion (`settled`); the
 *   builder's own call is a `selfCheck`, which never settles. A fact, the operator and another person
 *   settle the other three kinds, never a session by hand.
 * - **Ask to close** is refused `STEPS_OPEN` while a required step is not done (the state is S-7's), sets
 *   `closeRequested` and never closes: closing is the operator's door.
 * - **Ask to attach** is the one write an unattached session may make. It asks to JOIN (no role: only
 *   the operator changes who leads) and is recorded in the record's `attachRequests`.
 *
 * Every verb here except asking to attach refuses a session that is not attached (`NOT_ATTACHED`, with
 * the way out), through the guard. Nothing registers these until S-24: no agent or operator can reach
 * them yet. Electron-free.
 */

import { isBuilderOf, openEntry, type Actor } from './guard'
import {
  BLOCKER_OWNERS,
  CLEARS_WHEN,
  STATE_LABELS,
  type AcceptanceCriterion,
  type AttachRequest,
  type BlockerV4,
  type ClearsWhen,
  type MissionV4,
  type StepV4
} from './model'
import { deriveProgress } from './progress'
import type { RecordChange } from './record-store'
import type { StepInput } from './state'
import { writeMission, type WriteCode } from './write'

// ---- Results ---------------------------------------------------------------------

/** Why a state verb refused: the write path's codes, and the ones that are this slice's. */
export type StateCode =
  | WriteCode
  | 'STEP_NOT_FOUND'
  | 'CRITERION_NOT_FOUND'
  | 'BLOCKER_NOT_FOUND'
  | 'STEPS_OPEN'
  | 'ALREADY_SETTLED'
  | 'ALREADY_ATTACHED'
  | 'SESSION_ONLY'

/** A refusal: `error` is `CODE: what to do`, and never carries the refused text. */
export interface StateRefusal {
  ok: false
  code: StateCode
  error: string
}

export type StateResult<T> = ({ ok: true } & T) | StateRefusal

/** An error a verb throws inside the write: the store returns it typed, keeping its `code`. */
class Refusal extends Error {
  constructor(
    readonly code: StateCode,
    message: string
  ) {
    super(message)
  }
}

const refuse = (code: StateCode, message: string): StateRefusal => ({
  ok: false,
  code,
  error: `${code}: ${message}`
})

/**
 * Run one verb as one `writeMission`. `build` receives the record under the lock and returns the
 * change and what the verb reports; the store may run it more than once (a lost compare-and-swap
 * retries), and the report of the run that lands is the one returned, because each run overwrites it.
 */
async function run<T extends object>(
  folder: string,
  missionId: string,
  actor: Actor,
  need: 'write' | 'lead' | 'ask-to-attach',
  build: (record: MissionV4, log: string) => { next: RecordChange; report: T }
): Promise<StateResult<T>> {
  const box: { report?: T } = {}
  const written = await writeMission(folder, missionId, actor, need, (record, log) => {
    const { next, report } = build(record, log)
    box.report = report
    return next
  })
  if (!written.ok) return { ok: false, code: written.code, error: written.error }
  return { ok: true, ...(box.report as T) }
}

const sessionOnly = (verb: string): StateRefusal =>
  refuse(
    'SESSION_ONLY',
    `${verb} is a session's verb; the operator does this from the Mission pane, and a system worker only reads.`
  )

// ---- Small helpers -----------------------------------------------------------------

/** One line of plain text: every run of white space (and U+0085) becomes one space. */
const oneLine = (text: string): string => text.replace(/[\s\u0085]+/g, ' ').trim()

/** A step as a reader names it: its title, in quotes. */
const quoted = (step: Pick<StepV4, 'title'>): string => `"${oneLine(step.title)}"`

/**
 * A Log entry, in the one shape a session may write (S-11's Log rule): a single heading
 * `### <ISO time> · note`, with `· stp-<n>` when it is about a step, then ONE plain line. The line says
 * what happened in words a reader understands (the step by its quoted title, "another session" for a
 * second session, never an id), and it is squeezed to one line so text a session handed in can never
 * add a heading or a line break. Who did it is never in the heading: that is Harnu's to write. The Log
 * is append-only.
 */
function appendLog(log: string, at: string, text: string, stepId?: string): string {
  const gap = log === '' || log.endsWith('\n') ? '' : '\n'
  return `${log}${gap}\n### ${at} · note${stepId ? ` · ${stepId}` : ''}\n\n${oneLine(text)}\n`
}

const trimmed = (text: unknown): string => (typeof text === 'string' ? text.trim() : '')

/** The highest number among ids like `blk-3` (0 when none). */
const highest = (ids: Iterable<string>, prefix: string): number => {
  let top = 0
  for (const id of ids) {
    const n = Number(id.slice(prefix.length + 1))
    if (id.startsWith(`${prefix}-`) && Number.isInteger(n) && n > top) top = n
  }
  return top
}

/** Every blocker of the record, the mission's and the steps', with the step it is on. */
function allBlockers(record: MissionV4): Array<{ blocker: BlockerV4; stepId?: string }> {
  return [
    ...record.blockers.map((blocker) => ({ blocker })),
    ...record.steps.flatMap((s) => s.blockers.map((blocker) => ({ blocker, stepId: s.id })))
  ]
}

/**
 * The next blocker id: past every id the record holds AND every `blk-<n>` the Log ever named, so a
 * blocker that was cleared never gives its id to another.
 */
function nextBlockerId(record: MissionV4, log: string): string {
  const seen = allBlockers(record).map((b) => b.blocker.id)
  for (const m of log.matchAll(/\bblk-\d+\b/g)) seen.push(m[0])
  return `blk-${highest(seen, 'blk') + 1}`
}

/**
 * A step by id. A record converted from a v3 campaign renumbers its steps and keeps the old ids in
 * `legacyV3.stepIds` (old → new): an id the record does not have is looked up there. The caller reads
 * the new id from the result. An old id that was more than one step (two chapters each had a `stp-1`)
 * picks none and names the candidates.
 */
function resolveStep(record: MissionV4, stepId: string): StepV4 {
  const direct = record.steps.find((s) => s.id === stepId)
  if (direct) return direct
  const legacy = record.legacyV3 as { stepIds?: unknown } | null | undefined
  const entries = Array.isArray(legacy?.stepIds) ? (legacy?.stepIds as unknown[]) : []
  const candidates = [
    ...new Set(
      entries.flatMap((e) => {
        const { step, id } = (e ?? {}) as { step?: unknown; id?: unknown }
        return step === stepId && typeof id === 'string' && record.steps.some((s) => s.id === id)
          ? [id]
          : []
      })
    )
  ]
  if (candidates.length === 1) return record.steps.find((s) => s.id === candidates[0]) as StepV4
  if (candidates.length > 1) {
    throw new Refusal(
      'STEP_NOT_FOUND',
      `${stepId} was more than one step in the files this mission came from (now ${candidates.join(', ')}). Use the new id.`
    )
  }
  throw new Refusal(
    'STEP_NOT_FOUND',
    `${record.id} has no step ${stepId}; its steps are ${record.steps.map((s) => s.id).join(', ') || 'none yet'}.`
  )
}

const replaceStep = (record: MissionV4, step: StepV4): MissionV4 => ({
  ...record,
  steps: record.steps.map((s) => (s.id === step.id ? step : s))
})

// ---- mission_set_blocker -------------------------------------------------------------

export interface SetBlockerArgs {
  missionId: string
  /** The step it blocks; absent = the mission. */
  stepId?: string
  /** The exact thing needed (the writing contract judges it). */
  reason: string
  ask?: string
  unblocks?: string
  owner: 'agent' | 'operator'
  /** A fact that ends the blocker by itself; allowed on a step's blocker only. */
  clearsWhen?: ClearsWhen
}

/**
 * Set a blocker. One owned by the operator says what to do (`ask`) and what it unblocks, because it
 * lands on their list. The same blocker twice (same place, reason and owner) is stored once and the
 * result says `deduped`. Any attached session may set one (S-25 scopes a worker to its own step).
 */
export async function setBlocker(
  folder: string,
  actor: Actor,
  args: SetBlockerArgs
): Promise<StateResult<{ blockerId: string; stepId?: string; deduped: boolean }>> {
  const at = new Date().toISOString()
  return run<{ blockerId: string; stepId?: string; deduped: boolean }>(
    folder,
    args.missionId,
    actor,
    'write',
    (record, log) => {
      const reason = trimmed(args.reason)
      if (reason === '') throw new Refusal('BAD_ARGS', 'a blocker needs a reason.')
      if (!BLOCKER_OWNERS.includes(args.owner)) {
        throw new Refusal('BAD_ARGS', `owner is ${BLOCKER_OWNERS.join(' or ')}.`)
      }
      if (args.clearsWhen !== undefined && !CLEARS_WHEN.includes(args.clearsWhen)) {
        throw new Refusal('BAD_ARGS', `clearsWhen is one of ${CLEARS_WHEN.join(', ')}.`)
      }
      const ask = trimmed(args.ask)
      const unblocks = trimmed(args.unblocks)
      if (args.owner === 'operator') {
        if (ask === '') {
          throw new Refusal('BAD_ARGS', 'a blocker the operator owns says what to do: add the ask.')
        }
        if (unblocks === '') {
          throw new Refusal('BAD_ARGS', 'a blocker the operator owns says what it unblocks.')
        }
      }

      const step = args.stepId === undefined ? undefined : resolveStep(record, args.stepId)
      const here = step ? step.blockers : record.blockers
      const same = here.find((b) => b.owner === args.owner && trimmed(b.reason) === reason)
      if (same) {
        return {
          next: { record, log },
          report: { blockerId: same.id, ...(step ? { stepId: step.id } : {}), deduped: true }
        }
      }

      const blocker: BlockerV4 = {
        id: nextBlockerId(record, log),
        reason,
        ...(ask !== '' ? { ask } : {}),
        ...(unblocks !== '' ? { unblocks } : {}),
        owner: args.owner,
        ...(args.clearsWhen !== undefined ? { clearsWhen: args.clearsWhen } : {}),
        raisedAt: at
      }
      const next = step
        ? replaceStep(record, { ...step, blockers: [...step.blockers, blocker] })
        : { ...record, blockers: [...record.blockers, blocker] }
      const where = step ? quoted(step) : 'the mission'
      return {
        next: {
          record: next,
          log: appendLog(
            log,
            at,
            `Blocker raised on ${where}: ${reason} (${blocker.id}).`,
            step?.id
          )
        },
        report: { blockerId: blocker.id, ...(step ? { stepId: step.id } : {}), deduped: false }
      }
    }
  )
}

// ---- mission_clear_blocker -----------------------------------------------------------

export interface ClearBlockerArgs {
  missionId: string
  blockerId: string
}

/**
 * Clear a blocker by id. A session clears an agent-owned one; an operator-owned blocker is the
 * operator's to clear (their door in the pane), and a session that tries is refused `OPERATOR_ONLY`.
 */
export async function clearBlocker(
  folder: string,
  actor: Actor,
  args: ClearBlockerArgs
): Promise<StateResult<{ blockerId: string; stepId?: string }>> {
  const at = new Date().toISOString()
  return run(folder, args.missionId, actor, 'write', (record, log) => {
    const found = allBlockers(record).find((b) => b.blocker.id === args.blockerId)
    if (!found) {
      throw new Refusal(
        'BLOCKER_NOT_FOUND',
        `${record.id} has no open blocker ${args.blockerId}; it may already be cleared.`
      )
    }
    if (found.blocker.owner === 'operator' && actor.kind !== 'operator') {
      throw new Refusal(
        'OPERATOR_ONLY',
        `${args.blockerId} is the operator's to clear: they do it in the Mission pane, or a fact it waits for ends it.`
      )
    }
    const without = (list: readonly BlockerV4[]): BlockerV4[] =>
      list.filter((b) => b.id !== args.blockerId)
    const next: MissionV4 = {
      ...record,
      blockers: without(record.blockers),
      steps: record.steps.map((s) => ({ ...s, blockers: without(s.blockers) }))
    }
    const onStep = found.stepId ? record.steps.find((s) => s.id === found.stepId) : undefined
    const where = onStep ? quoted(onStep) : 'the mission'
    return {
      next: {
        record: next,
        log: appendLog(log, at, `Blocker cleared on ${where} (${args.blockerId}).`, found.stepId)
      },
      report: { blockerId: args.blockerId, ...(found.stepId ? { stepId: found.stepId } : {}) }
    }
  })
}

// ---- mission_set_done_when -----------------------------------------------------------

/**
 * The record's key for a Done when the leader proposed. The model has no field for it (a gap the spec
 * lists), so it rides on the record's passthrough, like `attachRequests` did before S-6 gave it a type;
 * the operator's door (S-15) approves it by writing `doneWhen` and removing this key, or drops it.
 */
export const PENDING_DONE_WHEN_KEY = 'pendingDoneWhen'

export interface PendingDoneWhen {
  /** The proposed Done when. */
  text: string
  /** Why it changes. */
  reason: string
  at: string
  /** Who proposed it, by name: the session's id, or `harnu` / `operator`. */
  by: string
}

export interface StageDoneWhenArgs {
  missionId: string
  doneWhen: string
  reason: string
}

/**
 * Stage a new Done when for the operator. The mission keeps the one it has: a verb never rewrites it
 * (the write path refuses a session's change to `doneWhen` too). One change is staged at a time: the
 * same text again is a no-op, a different one replaces it. The leader's verb.
 */
export async function stageDoneWhen(
  folder: string,
  actor: Actor,
  args: StageDoneWhenArgs
): Promise<StateResult<{ staged: PendingDoneWhen; deduped: boolean }>> {
  const at = new Date().toISOString()
  // By name: a session's id, `operator` or `harnu`. Harnu's own write is never recorded as the operator's.
  const by = actor.kind === 'session' ? actor.sessionId : actor.kind
  return run<{ staged: PendingDoneWhen; deduped: boolean }>(
    folder,
    args.missionId,
    actor,
    'lead',
    (record, log) => {
      const text = trimmed(args.doneWhen)
      const reason = trimmed(args.reason)
      if (text === '') throw new Refusal('BAD_ARGS', 'the new Done when is empty.')
      if (reason === '') throw new Refusal('BAD_ARGS', 'say why Done when changes.')
      if (text === record.doneWhen.trim()) {
        throw new Refusal('BAD_ARGS', 'that is the Done when the mission already has.')
      }
      const pending = (record as unknown as Record<string, PendingDoneWhen | undefined>)[
        PENDING_DONE_WHEN_KEY
      ]
      if (pending && pending.text === text) {
        return { next: { record, log }, report: { staged: pending, deduped: true } }
      }
      const staged: PendingDoneWhen = { text, reason, at, by }
      return {
        next: {
          record: { ...record, [PENDING_DONE_WHEN_KEY]: staged } as MissionV4,
          log: appendLog(log, at, `A new Done when is waiting for the operator: ${reason}`)
        },
        report: { staged, deduped: false }
      }
    }
  )
}

// ---- mission_settle_ac ---------------------------------------------------------------

export interface SettleCriterionArgs {
  missionId: string
  stepId: string
  criterionId: string
  /** What the session saw: required. */
  evidence: string
  /**
   * Session ids the caller knows built the step without a `session` link on it (the leader, for a step
   * it did itself): the same list `StepInput.extraBuilders` carries. A call from one is a self-check.
   */
  extraBuilders?: readonly string[]
}

const NOT_BY_HAND: Record<Exclude<AcceptanceCriterion['by'], 'session'>, string> = {
  fact: 'a fact settles itself: Harnu reads it, and nobody ticks what Harnu can see.',
  operator: 'the operator marks it in the Mission pane; a session never does.',
  person: 'the operator marks it for the other person in the Mission pane; a session never does.'
}

/**
 * Settle one criterion with evidence. A session that did NOT build the step settles a `by: session`
 * criterion (`settled { at, by, evidence }`, `by` its own id). The builder's own call is a self-check
 * (`selfCheck { at, by, evidence }`): labelled, and never proof, so the criterion stays open. The
 * builder is S-11's `isBuilderOf` (the step's `session` links), plus the ids the caller names. A fact,
 * an operator criterion and a person's are never settled by hand: the verb refuses each.
 */
export async function settleCriterion(
  folder: string,
  actor: Actor,
  args: SettleCriterionArgs
): Promise<
  StateResult<{ outcome: 'settled' | 'self-check'; stepId: string; criterionId: string }>
> {
  if (actor.kind !== 'session') return sessionOnly('mission_settle_ac')
  const sessionId = actor.sessionId
  const at = new Date().toISOString()
  return run(folder, args.missionId, actor, 'write', (record, log) => {
    const evidence = trimmed(args.evidence)
    if (evidence === '') {
      throw new Refusal('BAD_ARGS', 'a settlement carries its evidence: say what you saw.')
    }
    const step = resolveStep(record, args.stepId)
    const ac = step.acs.find((c) => c.id === args.criterionId)
    if (!ac) {
      throw new Refusal(
        'CRITERION_NOT_FOUND',
        `step ${step.id} has no criterion ${args.criterionId}; it has ${step.acs.map((c) => c.id).join(', ') || 'none'}.`
      )
    }
    if (ac.by !== 'session') {
      throw new Refusal('SETTLE_NOT_ALLOWED', `${step.id} ${ac.id}: ${NOT_BY_HAND[ac.by]}`)
    }
    if (ac.settled) {
      throw new Refusal(
        'ALREADY_SETTLED',
        `${step.id} ${ac.id} is settled; the first settlement stands. If it is wrong, tell the operator.`
      )
    }
    const builder =
      isBuilderOf(record, sessionId, step.id) || (args.extraBuilders ?? []).includes(sessionId)
    const settled = !builder
    const updated: AcceptanceCriterion = settled
      ? { ...ac, settled: { at, by: sessionId, evidence } }
      : { ...ac, selfCheck: { at, by: sessionId, evidence } }
    const next = replaceStep(record, {
      ...step,
      acs: step.acs.map((c) => (c.id === ac.id ? updated : c))
    })
    const line = settled
      ? `${quoted(step)}: a criterion was settled by another session.`
      : `${quoted(step)}: a criterion was checked by the session that built it; it stays open.`
    return {
      next: { record: next, log: appendLog(log, at, line, step.id) },
      report: {
        outcome: settled ? 'settled' : 'self-check',
        stepId: step.id,
        criterionId: ac.id
      }
    }
  })
}

// ---- mission_request_close -----------------------------------------------------------

export interface RequestCloseArgs {
  missionId: string
  /** Each step's facts (pull request, card, worker) as the caller read them; absent = none known. */
  inputs?: Readonly<Record<string, StepInput>>
}

/**
 * Ask the operator to close the mission. Refused `STEPS_OPEN` while a required step is not done (the
 * state is S-7's `deriveProgress`, from the facts the caller passes: a fact criterion holds only when
 * the caller says so). It sets `closeRequested` and never closes: close is the operator's door, which
 * is never refused. Asking again keeps the first request. The leader's verb.
 */
export async function requestClose(
  folder: string,
  actor: Actor,
  args: RequestCloseArgs
): Promise<StateResult<{ closeRequested: { at: string }; deduped: boolean }>> {
  const at = new Date().toISOString()
  return run<{ closeRequested: { at: string }; deduped: boolean }>(
    folder,
    args.missionId,
    actor,
    'lead',
    (record, log) => {
      const open = deriveProgress(record, args.inputs).steps.filter(
        (s) => !s.optional && s.state !== 'done'
      )
      if (open.length > 0) {
        const shown = open
          .slice(0, 5)
          .map((s) => {
            const step = record.steps.find((x) => x.id === s.id)
            return `${step ? quoted(step) : s.id} (${STATE_LABELS[s.state]})`
          })
          .join(', ')
        const more = open.length > 5 ? ` and ${open.length - 5} more` : ''
        throw new Refusal(
          'STEPS_OPEN',
          `${open.length === 1 ? '1 step is' : `${open.length} steps are`} not done: ${shown}${more}. Finish ${open.length === 1 ? 'it' : 'them'} first; the operator can still close the mission from the pane.`
        )
      }
      if (record.closeRequested) {
        return {
          next: { record, log },
          report: { closeRequested: record.closeRequested, deduped: true }
        }
      }
      return {
        next: {
          record: { ...record, closeRequested: { at } },
          log: appendLog(log, at, 'Every step is done: the agent asks the operator to close.')
        },
        report: { closeRequested: { at }, deduped: false }
      }
    }
  )
}

// ---- mission_attach ------------------------------------------------------------------

export interface AskToAttachArgs {
  missionId: string
}

/**
 * Ask to JOIN a mission. The one write an unattached session may make, and how it leaves
 * `NOT_ATTACHED`. It carries no role: a session that joins is `worked`, and only the operator changes
 * who leads. The request lands in `attachRequests`; asking again while it is undecided stores nothing
 * new and returns the same id; deciding it is the operator's (S-15). A session already attached has
 * nothing to ask. A Harnu-dispatched worker is attached by its dispatch, not by this verb (S-26).
 */
export async function askToAttach(
  folder: string,
  actor: Actor,
  args: AskToAttachArgs
): Promise<StateResult<{ requestId: string; deduped: boolean }>> {
  if (actor.kind !== 'session') return sessionOnly('mission_attach')
  const sessionId = actor.sessionId
  const at = new Date().toISOString()
  return run<{ requestId: string; deduped: boolean }>(
    folder,
    args.missionId,
    actor,
    'ask-to-attach',
    (record, log) => {
      if (openEntry(record, sessionId)) {
        throw new Refusal('ALREADY_ATTACHED', `this session is already attached to ${record.id}.`)
      }
      const prior = record.attachRequests ?? []
      const pending = prior.find((r) => r.sessionId === sessionId && r.decision === null)
      if (pending) {
        return { next: { record, log }, report: { requestId: pending.id, deduped: true } }
      }
      const request: AttachRequest = {
        id: `atr-${
          highest(
            prior.map((r) => r.id),
            'atr'
          ) + 1
        }`,
        missionId: record.id,
        sessionId,
        at,
        decision: null
      }
      // The Log is not touched: an unattached session writes its request and nothing else.
      const next: MissionV4 = { ...record, attachRequests: [...prior, request] }
      return {
        next: { record: next, log },
        report: { requestId: request.id, deduped: false }
      }
    }
  )
}
