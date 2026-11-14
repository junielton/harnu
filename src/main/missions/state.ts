/**
 * Missions v4 S-7 (AC-12, AC-13, AC-14) — one state vocabulary, pure.
 *
 * A v4 step (from `model.ts`) plus plain input facts go in; a state comes out. Nothing here reads a
 * file, runs git or `gh`, or looks at a clock: the caller (the store, the view builder) gathers the
 * facts once and hands them over as a {@link StepInput}, which is why every case is testable with a
 * hand-built object. A fact the caller could not read is simply absent, which reads as "does not hold".
 * The stickiness rule (a fact never downgrades when GitHub is unreachable) is the caller's: it hands
 * over the last known value.
 *
 * What this module decides, from the spec's "Design · The model":
 *
 * - **A step is `todo`, `running`, `waiting-review` or `done`; first match wins.** Blocked is a mark
 *   on a step ({@link StepStateResult.blocked}), never a fifth state.
 * - **A criterion is settled four ways and no other**: a fact (derived), a second session, the
 *   operator, or another person the operator marks. A self-check never settles it.
 * - **A fact replaces stale state**: a blocker that names the fact it waits for stops showing when the
 *   fact holds, and a criterion tied to a fact is never settled by a stamp.
 *
 * The state identifiers (`todo`, `running`, `waiting-review`, `done`, the milestone and mission ones)
 * are defined once in `model.ts` (`STEP_STATES`, `MILESTONE_STATES`, `MISSION_STATES`); this module
 * returns them and defines none.
 *
 * The card column is an input (owner's decision for AC-29): a card in `review` reads waiting for
 * review (rule 2), `backlog` and `ready` read to do, `in-progress` reads running, and the operator
 * closing the card (`done`) reads the step done. This module produces nothing from the board; the
 * caller hands the column over as a plain value.
 */

import type {
  AcceptanceCriterion,
  BlockerV4,
  CriterionBy,
  Fact,
  MilestoneState,
  MissionState,
  StepState,
  StepV4
} from './model'

// ---- Input ------------------------------------------------------------------------

/** The board column of a dispatched step's card; `null` or absent for a step that has no card. */
export type CardColumn = 'backlog' | 'ready' | 'in-progress' | 'review' | 'done'

/**
 * The state of the step's pull request: none yet, open, closed without merging, or merged. A closed
 * pull request counts as none everywhere: the work it carried does not exist.
 */
export type PrState = 'none' | 'open' | 'closed' | 'merged'

/** The facts a pull request's state does not already carry. */
export type ReadFact = 'ci-green' | 'main-green' | 'link-exists'

/**
 * Everything the derivation needs to know about one step that the record does not hold. All optional:
 * an empty input is a step with no card, no pull request, no worker and no fact read yet.
 *
 * **Unknown is not false.** A fact that is absent (no `pr`, or no entry in `facts`) is "not read yet":
 * the caller could not or did not read it, which is never a failure. `false` is "read, and it does not
 * hold". Both settle nothing and clear nothing, so a step reads the same either way; the difference
 * is for the surfaces that must tell them apart, as the waiting list's `main-failing` item does:
 * `main-green: false` means main is red, absent means nothing. Ask {@link factReading} for the three
 * values instead of testing the input yourself.
 */
export interface StepInput {
  /** The step's card column, when it has a card. */
  card?: CardColumn | null
  /** The step's pull request; absent reads `none`. */
  pr?: PrState
  /** The facts Harnu reads beyond the pull request's own state; absent reads false. */
  facts?: Partial<Record<ReadFact, boolean>>
  /** A session other than the leader is working on the step right now. */
  workerWorking?: boolean
  /**
   * Session ids that built the step and are not named by a `session` link on it (the leader, for a
   * step it did itself). A stamp from one of these is a self-check.
   */
  extraBuilders?: readonly string[]
}

// ---- Facts ------------------------------------------------------------------------

/** What the input says about one fact: it holds, it was read and does not hold, or it was not read. */
export type FactReading = 'holds' | 'does-not-hold' | 'unknown'

/**
 * Read one fact from the step's input. The pull request facts follow `pr` (absent is `unknown`; any
 * given value was read, and `none` and `closed` hold neither fact; a merged pull request was opened);
 * the others follow `facts` (absent is `unknown`, `true` holds, `false` does not).
 */
export function factReading(fact: Fact, input: StepInput): FactReading {
  switch (fact) {
    case 'pr-opened':
    case 'pr-merged': {
      const pr = input.pr
      if (pr === undefined) return 'unknown'
      const holds = fact === 'pr-merged' ? pr === 'merged' : pr === 'open' || pr === 'merged'
      return holds ? 'holds' : 'does-not-hold'
    }
    case 'ci-green':
    case 'main-green':
    case 'link-exists': {
      const read = input.facts?.[fact]
      if (read === undefined) return 'unknown'
      return read ? 'holds' : 'does-not-hold'
    }
  }
}

/** Whether `fact` holds now. An unknown fact does not hold, and is never a failure. */
export function factHolds(fact: Fact, input: StepInput): boolean {
  return factReading(fact, input) === 'holds'
}

// ---- Criteria ---------------------------------------------------------------------

/** The session ids that built the step: its `session` links plus the caller's extra builders. */
function stepBuilders(step: Pick<StepV4, 'links'>, input: StepInput): Set<string> {
  const ids = new Set<string>(input.extraBuilders ?? [])
  for (const link of step.links ?? []) if (link.kind === 'session') ids.add(link.ref)
  return ids
}

export interface Settlement {
  settled: boolean
  /** How it settled: the four ways, or `null` while open. */
  via: CriterionBy | null
}

const OPEN: Settlement = { settled: false, via: null }

/**
 * Whether a criterion is settled and how. The four ways and no other (spec "What settles a criterion"):
 *
 * - `fact`: the fact holds now. A `settled` stamp on a criterion tied to a fact is ignored, whoever
 *   wrote it: the fact is the only thing that settles it, so a hand tick can never leave it stale.
 * - the operator: a stamp whose `by` is `operator`. The door writes it for an operator criterion, for
 *   a person's criterion (with `person`), and the operator may also close a session criterion.
 * - a second session: a stamp on a `session` criterion whose author did not build the step. A stamp
 *   from a builder is a self-check, and a self-check never settles.
 *
 * A session's stamp never settles an operator or person criterion.
 */
export function criterionSettlement(
  criterion: AcceptanceCriterion,
  step: Pick<StepV4, 'links'>,
  input: StepInput
): Settlement {
  if (criterion.by === 'fact') {
    return criterion.fact !== undefined && factHolds(criterion.fact, input)
      ? { settled: true, via: 'fact' }
      : OPEN
  }
  const stamp = criterion.settled
  if (!stamp || stamp.by.length === 0) return OPEN
  if (stamp.by === 'operator') {
    return { settled: true, via: criterion.by === 'person' ? 'person' : 'operator' }
  }
  if (criterion.by === 'session' && !stepBuilders(step, input).has(stamp.by)) {
    return { settled: true, via: 'session' }
  }
  return OPEN
}

// ---- Blockers ---------------------------------------------------------------------

/**
 * The blockers that still show. One that names the fact it waits for (`clearsWhen`) stops showing when
 * that fact holds and needs no manual clear (D-12); one with no `clearsWhen` stays until a person
 * clears it. Order is kept.
 */
export function activeBlockers(blockers: readonly BlockerV4[], input: StepInput): BlockerV4[] {
  return blockers.filter((b) => b.clearsWhen === undefined || !factHolds(b.clearsWhen, input))
}

// ---- Step -------------------------------------------------------------------------

export interface CriterionState {
  id: string
  by: CriterionBy
  settled: boolean
  via: CriterionBy | null
}

export interface StepStateResult {
  state: StepState
  /** The blocked mark: an active blocker on a step that is not done. Never a state. */
  blocked: boolean
  /** The blockers that still show (empty on a done step). */
  blockers: BlockerV4[]
  /** Every criterion in plan order, settled or not. */
  criteria: CriterionState[]
  /** The criteria still open. */
  open: AcceptanceCriterion[]
}

/**
 * The state of one step, first match wins:
 *
 * 1. `done`: every criterion settled (a step with no criterion is never done by its criteria), or the
 *    operator closed the step's card.
 * 2. `waiting-review`: the card is in review; or not done, a pull request exists (open or merged)
 *    while a criterion is open; or no pull request exists and only operator or person criteria are
 *    still open, which is how a sign-off step reads.
 * 3. `running`: a session other than the leader works on it, its card is in progress, or the leader
 *    started it (`startedAt`) and no pull request exists yet, unless its card sits in Backlog or Ready
 *    (re-queued: it reads to do, whatever `startedAt` says).
 * 4. `todo`: otherwise (Backlog and Ready both read to do, D-6).
 */
export function deriveStepState(step: StepV4, input: StepInput = {}): StepStateResult {
  const criteria: CriterionState[] = []
  const open: AcceptanceCriterion[] = []
  for (const c of step.acs ?? []) {
    const s = criterionSettlement(c, step, input)
    criteria.push({ id: c.id, by: c.by, settled: s.settled, via: s.via })
    if (!s.settled) open.push(c)
  }

  // A pull request closed without merging counts as none: the work does not exist.
  const pr = input.pr === undefined || input.pr === 'closed' ? 'none' : input.pr
  const card = input.card ?? null
  const allSettled = criteria.length > 0 && open.length === 0

  let state: StepState
  if (allSettled || card === 'done') {
    state = 'done'
  } else if (
    card === 'review' ||
    pr !== 'none' ||
    (pr === 'none' &&
      open.length > 0 &&
      open.every((c) => c.by === 'operator' || c.by === 'person'))
  ) {
    state = 'waiting-review'
  } else if (
    input.workerWorking === true ||
    card === 'in-progress' ||
    // A card in Backlog or Ready was re-queued: it reads to do whatever `startedAt` says.
    (step.startedAt !== undefined && pr === 'none' && card !== 'backlog' && card !== 'ready')
  ) {
    state = 'running'
  } else {
    state = 'todo'
  }

  const blockers = state === 'done' ? [] : activeBlockers(step.blockers ?? [], input)
  return { state, blocked: blockers.length > 0, blockers, criteria, open }
}

// ---- Milestone and mission ----------------------------------------------------------

/**
 * A milestone's state, derived from the states of its steps: `not-started` (no step, or every step to
 * do), `done` (every step done), `waiting-review` (not done, and every unfinished step waits for
 * review), otherwise `in-progress`. Several milestones may be open at once (D-9).
 */
export function deriveMilestoneState(steps: readonly StepState[]): MilestoneState {
  if (steps.length === 0) return 'not-started'
  if (steps.every((s) => s === 'done')) return 'done'
  if (steps.every((s) => s === 'todo')) return 'not-started'
  const unfinished = steps.filter((s) => s !== 'done')
  if (unfinished.every((s) => s === 'waiting-review')) return 'waiting-review'
  return 'in-progress'
}

/**
 * The mission is `closed` (the operator's door), `ready-to-close` (derived: every required step done
 * and every required milestone done, with at least one step) or `open`. `closeRequested` is a separate
 * fact and changes none of this.
 *
 * @param stepStates the states of the required steps
 * @param milestoneStates the states of the required milestones (omit for a mission with none): a
 *   required milestone with no step yet is `not-started`, so it keeps the mission open
 */
export function deriveMissionState(
  mission: { status: 'open' | 'closed' },
  stepStates: readonly StepState[],
  milestoneStates: readonly MilestoneState[] = []
): MissionState {
  if (mission.status === 'closed') return 'closed'
  const ready =
    stepStates.length > 0 &&
    stepStates.every((s) => s === 'done') &&
    milestoneStates.every((s) => s === 'done')
  return ready ? 'ready-to-close' : 'open'
}
