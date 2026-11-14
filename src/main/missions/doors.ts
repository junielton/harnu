/**
 * Missions v4 S-15 (AC-37) — the operator doors.
 *
 * Mark a criterion, clear a blocker, approve a staged Done when, close as delivered or discarded, allow
 * or deny an attach request. They are the operator's: a session has no way to call them (the write path
 * judges `need: 'operator'`, so a session that tries is `OPERATOR_ONLY`), and none of them refuses the
 * operator for a state the mission is in: a closed mission, no session attached, a released leader, open
 * matters. Open matters at close are **warnings** returned to the caller ({@link closeWarningsOf}),
 * never a refusal. What a door can still answer is that its target is not there (`NOT_FOUND`) or that
 * nothing can be done to it (`SETTLES_ITSELF`: a criterion a fact settles is never ticked by hand).
 *
 * Each door writes through the one v4 write path with the operator as the actor (so the lock, the caps
 * and the copy on first write apply and a v3 file is never modified) and leaves one entry in the
 * mission's Log saying what the operator did. A door that finds its target already as asked changes
 * nothing and says `changed: false`, so a double click is harmless.
 *
 * The staged Done when is the record's `pendingDoneWhen { text, at }`, written by `mission_set_done_when`
 * (S-14); approving it replaces `doneWhen` and drops the old verification, because the end changed.
 *
 * Nothing on main calls these until the doors are registered (S-24 for the verbs, S-16 for the view):
 * {@link runDoor} is the entry the IPC channel `mission:v4Door` routes to. Electron-free.
 */

import { openEntry } from './guard'
import type { BlockerV4, MissionV4, Settled, WithUnknownKeys } from './model'
import type { StepInput } from './state'
import {
  appendWorked,
  applyChange,
  attachFromPicker,
  doorError,
  logEntry,
  resolveStepId,
  type DoorRefusal,
  type DoorResult
} from './sessions'
import { deriveStepResults } from './waiting'

const OPERATOR = { kind: 'operator' } as const

const now = (at: string | undefined): string => at ?? new Date().toISOString()

// ---- Mark a criterion ---------------------------------------------------------------

/**
 * "Mark done": the operator settles a criterion in their own name. An `operator` criterion is stamped
 * `{ at, by: operator }`; a `person` one `{ at, by: operator, person }`, the operator marking it when
 * that person approves; a `session` one is stamped the same way (the operator is never refused where a
 * second session could settle). A criterion a fact settles is read, not ticked: `SETTLES_ITSELF`. A
 * criterion that is already settled keeps its first stamp.
 */
export async function markCriterion(
  folder: string,
  missionId: string,
  args: { stepId: string; criterionId: string; evidence?: string; at?: string }
): Promise<DoorResult<{ stepId: string; criterionId: string }>> {
  const at = now(args.at)
  const result = await applyChange(folder, missionId, OPERATOR, 'operator', (record, log) => {
    const stepId = resolveStepId(record, args.stepId)
    const step = record.steps.find((s) => s.id === stepId)
    const criterion = step?.acs.find((a) => a.id === args.criterionId)
    if (!step || !criterion) {
      throw doorError(
        'NOT_FOUND',
        `${record.id} has no step ${args.stepId} criterion ${args.criterionId}.`
      )
    }
    if (criterion.by === 'fact') {
      throw doorError(
        'SETTLES_ITSELF',
        `step ${step.id} criterion ${criterion.id} is settled by a fact Harnu reads; it is never ticked by hand.`
      )
    }
    if (criterion.settled) return null
    const settled: Settled = {
      at,
      by: 'operator',
      ...(args.evidence !== undefined ? { evidence: args.evidence } : {}),
      ...(criterion.by === 'person' && criterion.person !== undefined
        ? { person: criterion.person }
        : {})
    }
    return {
      record: {
        ...record,
        steps: record.steps.map((s) =>
          s.id === step.id
            ? { ...s, acs: s.acs.map((a) => (a.id === criterion.id ? { ...a, settled } : a)) }
            : s
        )
      },
      log: logEntry(
        log,
        at,
        `operator marked step ${step.id} criterion ${criterion.id} done${
          settled.person ? ` for ${settled.person}` : ''
        }`
      )
    }
  })
  return result.ok
    ? {
        ...result,
        stepId: resolveStepId(result.record, args.stepId) ?? args.stepId,
        criterionId: args.criterionId
      }
    : result
}

// ---- Clear a blocker -----------------------------------------------------------------

/**
 * The operator clears a blocker: of one step when `stepId` is given, else the mission's own and then
 * any step's that has this id. A blocker that is not there is `NOT_FOUND` (it may already have been
 * cleared by whoever got there first).
 */
export async function clearBlocker(
  folder: string,
  missionId: string,
  args: { blockerId: string; stepId?: string; at?: string }
): Promise<DoorResult<{ blockerId: string; stepId: string | null }>> {
  const at = now(args.at)
  let where: string | null = null
  const result = await applyChange(folder, missionId, OPERATOR, 'operator', (record, log) => {
    const has = (list: readonly BlockerV4[]): boolean => list.some((b) => b.id === args.blockerId)
    let stepId: string | null = null
    let onMission = false
    if (args.stepId !== undefined) {
      const step = record.steps.find((s) => s.id === resolveStepId(record, args.stepId as string))
      if (step && has(step.blockers)) stepId = step.id
    } else if (has(record.blockers)) {
      onMission = true
    } else {
      stepId = record.steps.find((s) => has(s.blockers))?.id ?? null
    }
    if (stepId === null && !onMission) {
      throw doorError('NOT_FOUND', `${record.id} has no open blocker ${args.blockerId}.`)
    }
    where = stepId
    const keep = (list: readonly BlockerV4[]): BlockerV4[] =>
      list.filter((b) => b.id !== args.blockerId)
    return {
      record: onMission
        ? { ...record, blockers: keep(record.blockers) }
        : {
            ...record,
            steps: record.steps.map((s) =>
              s.id === stepId ? { ...s, blockers: keep(s.blockers) } : s
            )
          },
      log: logEntry(
        log,
        at,
        `operator cleared blocker ${args.blockerId}${stepId !== null ? ` on step ${stepId}` : ''}`
      )
    }
  })
  return result.ok ? { ...result, blockerId: args.blockerId, stepId: where } : result
}

// ---- Approve a staged Done when ---------------------------------------------------------

/** The Done when a session staged for the operator's approval, or null. */
export function stagedDoneWhenOf(record: MissionV4): { text: string; at?: string } | null {
  const staged = (record as WithUnknownKeys<MissionV4>).pendingDoneWhen
  if (typeof staged !== 'object' || staged === null) return null
  const text = (staged as { text?: unknown }).text
  return typeof text === 'string' && text !== '' ? { text } : null
}

/**
 * The operator approves the Done when a session staged. It replaces `doneWhen`, clears the staging and
 * the old verification (the end changed, so the proof does not carry over). With nothing staged it
 * changes nothing.
 */
export async function approveDoneWhen(
  folder: string,
  missionId: string,
  args: { at?: string } = {}
): Promise<DoorResult> {
  const at = now(args.at)
  return applyChange(folder, missionId, OPERATOR, 'operator', (record, log) => {
    const staged = stagedDoneWhenOf(record)
    if (!staged) return null
    const {
      pendingDoneWhen: _staged,
      doneWhenVerified: _verified,
      ...rest
    } = record as WithUnknownKeys<MissionV4>
    return {
      record: { ...(rest as MissionV4), doneWhen: staged.text },
      log: logEntry(log, at, `operator approved a new Done when: ${staged.text}`)
    }
  })
}

// ---- Close as delivered or discarded ------------------------------------------------------

/** An open matter the operator is told about when closing. A warning, never a refusal. */
export interface CloseWarning {
  kind: 'unfinished-steps' | 'open-blockers' | 'staged-done-when' | 'attach-requests'
  count: number
  /** The words the dialog shows. */
  text: string
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many)

/**
 * What is still open on a mission, for the end dialog. Pure. `inputs` are the per-step facts the caller
 * has read (see `state.ts`); without them a step that needs a fact reads as not done. Optional steps,
 * and the steps of optional milestones, are outside the count.
 */
export function closeWarningsOf(
  record: MissionV4,
  inputs: Readonly<Record<string, StepInput>> = {}
): CloseWarning[] {
  const warnings: CloseWarning[] = []
  const optionalMilestones = new Set(record.milestones.filter((m) => m.optional).map((m) => m.id))
  const results = deriveStepResults(record, inputs)
  const unfinished = record.steps.filter(
    (s) =>
      s.optional !== true &&
      !(s.milestone !== undefined && optionalMilestones.has(s.milestone)) &&
      results[s.id]?.state !== 'done'
  ).length
  if (unfinished > 0) {
    warnings.push({
      kind: 'unfinished-steps',
      count: unfinished,
      text: `${unfinished} ${plural(unfinished, 'step is', 'steps are')} not done`
    })
  }
  const blockers = record.blockers.length + record.steps.reduce((n, s) => n + s.blockers.length, 0)
  if (blockers > 0) {
    warnings.push({
      kind: 'open-blockers',
      count: blockers,
      text: `${blockers} ${plural(blockers, 'blocker is', 'blockers are')} still open`
    })
  }
  if (stagedDoneWhenOf(record)) {
    warnings.push({
      kind: 'staged-done-when',
      count: 1,
      text: 'A new Done when is waiting for your approval'
    })
  }
  const asking = (record.attachRequests ?? []).filter((r) => r.decision === null).length
  if (asking > 0) {
    warnings.push({
      kind: 'attach-requests',
      count: asking,
      text: `${asking} ${plural(asking, 'session is', 'sessions are')} waiting to join`
    })
  }
  return warnings
}

/**
 * The one end door: close as delivered or discard, with an optional reason. Open matters come back in
 * `warnings` and never stop it. Closing a mission that is already closed changes nothing.
 */
export async function closeMission(
  folder: string,
  missionId: string,
  args: {
    closedAs: 'delivered' | 'discarded'
    reason?: string
    inputs?: Readonly<Record<string, StepInput>>
    at?: string
  }
): Promise<DoorResult<{ warnings: CloseWarning[] }>> {
  const at = now(args.at)
  let warnings: CloseWarning[] = []
  const result = await applyChange(folder, missionId, OPERATOR, 'operator', (record, log) => {
    warnings = record.status === 'closed' ? [] : closeWarningsOf(record, args.inputs)
    if (record.status === 'closed') return null
    const reason = args.reason?.trim()
    return {
      record: {
        ...record,
        status: 'closed',
        closedAs: args.closedAs,
        ...(reason ? { closeReason: reason } : {})
      },
      log: logEntry(
        log,
        at,
        `operator closed the mission as ${args.closedAs}${reason ? `: ${reason}` : ''}`
      )
    }
  })
  return result.ok ? { ...result, warnings } : result
}

// ---- Allow or deny an attach request -------------------------------------------------------

/**
 * The operator allows or denies a session's request to join. Allowed, the session is attached as a
 * `worked` one (never as the leader, whether or not anyone leads; a session already attached is not
 * attached twice). A request that was already decided keeps its first decision.
 */
export async function decideAttachRequest(
  folder: string,
  missionId: string,
  args: { requestId: string; decision: 'allowed' | 'denied'; at?: string }
): Promise<DoorResult> {
  const at = now(args.at)
  return applyChange(folder, missionId, OPERATOR, 'operator', (record, log) => {
    const request = (record.attachRequests ?? []).find((r) => r.id === args.requestId)
    if (!request)
      throw doorError('NOT_FOUND', `${record.id} has no attach request ${args.requestId}.`)
    if (request.decision !== null) return null
    const decided = (record.attachRequests ?? []).map((r) =>
      r.id === request.id ? { ...r, decision: args.decision, decidedAt: at } : r
    )
    const attached = args.decision === 'allowed' && !openEntry(record, request.sessionId)
    return {
      record: {
        ...record,
        attachRequests: decided,
        sessions:
          args.decision === 'allowed'
            ? appendWorked(record.sessions, request.sessionId, at)
            : record.sessions
      },
      log: logEntry(
        log,
        at,
        args.decision === 'allowed'
          ? `operator allowed session ${request.sessionId} to join as a worker${attached ? '' : ' (already attached)'}`
          : `operator denied session ${request.sessionId} the request to join`
      )
    }
  })
}

// ---- The IPC entry ----------------------------------------------------------------------

const bad = (what: string): DoorRefusal => ({
  ok: false,
  code: 'BAD_ARGS',
  error: `BAD_ARGS: ${what}`
})

const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

/**
 * Routes one door call from the renderer: `{ door, folder, missionId, … }`. The time is always the
 * app's own (a caller never sets `at`), and an unknown door or a missing field is `BAD_ARGS`.
 */
export async function runDoor(raw: unknown): Promise<DoorResult<object>> {
  if (typeof raw !== 'object' || raw === null) return bad('a door call is an object')
  const a = raw as Record<string, unknown>
  const folder = text(a.folder)
  const missionId = text(a.missionId)
  if (folder === null || missionId === null) return bad('a door call names a folder and a mission')
  switch (a.door) {
    case 'mark': {
      const stepId = text(a.stepId)
      const criterionId = text(a.criterionId)
      if (stepId === null || criterionId === null) return bad('mark needs a step and a criterion')
      return markCriterion(folder, missionId, {
        stepId,
        criterionId,
        ...(text(a.evidence) !== null ? { evidence: text(a.evidence) as string } : {})
      })
    }
    case 'clearBlocker': {
      const blockerId = text(a.blockerId)
      if (blockerId === null) return bad('clearBlocker needs a blocker')
      const stepId = text(a.stepId)
      return clearBlocker(folder, missionId, { blockerId, ...(stepId !== null ? { stepId } : {}) })
    }
    case 'approveDoneWhen':
      return approveDoneWhen(folder, missionId)
    case 'close': {
      if (a.closedAs !== 'delivered' && a.closedAs !== 'discarded') {
        return bad('close is delivered or discarded')
      }
      const reason = text(a.reason)
      return closeMission(folder, missionId, {
        closedAs: a.closedAs,
        ...(reason !== null ? { reason } : {})
      })
    }
    case 'decideAttach': {
      const requestId = text(a.requestId)
      if (requestId === null || (a.decision !== 'allowed' && a.decision !== 'denied')) {
        return bad('decideAttach needs a request and allowed or denied')
      }
      return decideAttachRequest(folder, missionId, { requestId, decision: a.decision })
    }
    case 'attach': {
      const sessionId = text(a.sessionId)
      if (sessionId === null) return bad('attach needs a session')
      return attachFromPicker(folder, missionId, { sessionId })
    }
    default:
      return bad('unknown door')
  }
}

/**
 * What the renderer gets back: the outcome and what the dialog needs, never the record or the file's
 * path (the view channel serves the refreshed mission).
 */
export function doorReply(result: DoorResult<object>): Record<string, unknown> {
  if (!result.ok) return { ok: false, code: result.code, error: result.error }
  const { record: _record, file: _file, ...rest } = result
  return rest
}
