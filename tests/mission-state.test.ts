/**
 * Missions v4 · S-7 · AC-12, AC-13, AC-14 — one state vocabulary, four ways to settle a criterion,
 * and a fact that replaces stale state.
 *
 * `src/main/missions/state.ts` is pure: a v4 step plus plain input facts in, a state out. Nothing is
 * read from a file, git, `gh` or a clock, so every case here builds its input by hand.
 */
import { describe, expect, it } from 'vitest'
import {
  BlockerSchema,
  CriterionSchema,
  MILESTONE_STATES,
  MISSION_STATES,
  STEP_STATES,
  StepSchema,
  type AcceptanceCriterion,
  type BlockerV4,
  type StepState,
  type StepV4
} from '../src/main/missions/model'
import {
  activeBlockers,
  criterionSettlement,
  deriveMilestoneState,
  deriveMissionState,
  deriveStepState,
  factReading,
  type StepInput
} from '../src/main/missions/state'

const AT = '2026-11-14T10:00:00Z'

// Fixtures go through the model's schemas, so a misspelt field or a bad value fails here, not later.
function ac(
  id: string,
  by: AcceptanceCriterion['by'],
  extra: Partial<AcceptanceCriterion> = {}
): AcceptanceCriterion {
  return CriterionSchema.parse({ id, text: `criterion ${id}`, by, ...extra })
}

function step(acs: AcceptanceCriterion[], extra: Partial<StepV4> = {}): StepV4 {
  return StepSchema.parse({ id: 'stp-1', title: 'A step', acs, links: [], blockers: [], ...extra })
}

function blocker(extra: Partial<BlockerV4> = {}): BlockerV4 {
  return BlockerSchema.parse({ id: 'blk-1', reason: 'waiting', owner: 'operator', ...extra })
}

const state = (s: StepV4, input: StepInput = {}): StepState => deriveStepState(s, input).state

describe('step and milestone states', () => {
  it('a step is to do, running, waiting for review or done, first match wins', () => {
    const s = step([ac('ac-1', 'fact', { fact: 'pr-merged' }), ac('ac-2', 'session')])

    // 4. to do: nothing started, nothing open on a pull request.
    expect(state(s)).toBe('todo')
    // 3. running: a session other than the leader works on it.
    expect(state(s, { workerWorking: true })).toBe('running')
    // 3. running: the leader started it and no pull request exists yet.
    expect(state(step(s.acs, { startedAt: AT }))).toBe('running')
    // 2. waiting for review: the work exists (a pull request is open) while a criterion is open.
    expect(state(s, { pr: 'open', workerWorking: true })).toBe('waiting-review')
    expect(state(s, { pr: 'merged' })).toBe('waiting-review')
    // a started step whose pull request exists is no longer "running".
    expect(state(step(s.acs, { startedAt: AT }), { pr: 'open' })).toBe('waiting-review')
    // 1. done: every criterion settled.
    const settled = step([
      ac('ac-1', 'fact', { fact: 'pr-merged' }),
      ac('ac-2', 'session', { settled: { at: AT, by: 'sess-checker', evidence: 'read it' } })
    ])
    expect(state(settled, { pr: 'merged', workerWorking: true })).toBe('done')
  })

  it('a step with no criterion at all is never done by its criteria', () => {
    expect(state(step([]))).toBe('todo')
    expect(state(step([]), { pr: 'open' })).toBe('waiting-review')
  })

  it('a step with no pull request reads waiting for review once only operator or person criteria are open (a sign-off step)', () => {
    const signOff = step([ac('ac-1', 'operator'), ac('ac-2', 'person', { person: 'the designer' })])
    expect(state(signOff)).toBe('waiting-review')

    // one operator criterion settled, the person's still open: still only human criteria open.
    const half = step([
      ac('ac-1', 'operator', { settled: { at: AT, by: 'operator' } }),
      ac('ac-2', 'person', { person: 'the designer' })
    ])
    expect(state(half)).toBe('waiting-review')

    // a session criterion still open means a session has work to do: not a sign-off yet.
    const mixed = step([ac('ac-1', 'session'), ac('ac-2', 'operator')])
    expect(state(mixed)).toBe('todo')
    // ...and a fact criterion still open too.
    const withFact = step([ac('ac-1', 'fact', { fact: 'ci-green' }), ac('ac-2', 'operator')])
    expect(state(withFact)).toBe('todo')
    expect(state(withFact, { workerWorking: true })).toBe('running')
  })

  it('the card column feeds the state: backlog and ready read to do, in progress running, review waiting, done done', () => {
    const s = step([ac('ac-1', 'session')])
    expect(state(s, { card: 'backlog' })).toBe('todo')
    expect(state(s, { card: 'ready' })).toBe('todo')
    expect(state(s, { card: 'in-progress' })).toBe('running')
    // rule 2 comes before running: a card in review is waiting for review even while a session works.
    expect(state(s, { card: 'review' })).toBe('waiting-review')
    expect(state(s, { card: 'review', workerWorking: true })).toBe('waiting-review')
    // the operator closing the card reads as done, with criteria still open.
    expect(state(s, { card: 'done' })).toBe('done')
    // no card is the same as a leader's own step.
    expect(state(s, { card: null })).toBe('todo')
  })

  it('blocked is a mark on a step and never a fifth state', () => {
    const s = step([ac('ac-1', 'session')], { blockers: [blocker()] })
    const todo = deriveStepState(s)
    expect(todo.state).toBe('todo')
    expect(todo.blocked).toBe(true)
    expect(deriveStepState(s, { workerWorking: true })).toMatchObject({
      state: 'running',
      blocked: true
    })
    expect(deriveStepState(step([ac('ac-1', 'session')])).blocked).toBe(false)
    // a done step shows no blocker mark: nothing is left to unblock.
    const done = step([ac('ac-1', 'operator', { settled: { at: AT, by: 'operator' } })], {
      blockers: [blocker()]
    })
    expect(deriveStepState(done)).toMatchObject({ state: 'done', blocked: false })
  })

  it('a milestone is not started, in progress, waiting for review or done, derived from its steps', () => {
    expect(deriveMilestoneState([])).toBe('not-started')
    expect(deriveMilestoneState(['todo', 'todo'])).toBe('not-started')
    expect(deriveMilestoneState(['done', 'done'])).toBe('done')
    expect(deriveMilestoneState(['done', 'todo'])).toBe('in-progress')
    expect(deriveMilestoneState(['running', 'todo'])).toBe('in-progress')
    expect(deriveMilestoneState(['waiting-review', 'todo'])).toBe('in-progress')
    // every unfinished step waits for review.
    expect(deriveMilestoneState(['waiting-review'])).toBe('waiting-review')
    expect(deriveMilestoneState(['done', 'waiting-review', 'waiting-review'])).toBe(
      'waiting-review'
    )
    expect(deriveMilestoneState(['waiting-review', 'running'])).toBe('in-progress')
  })

  it('the mission is open, ready to close (every required step done, derived) or closed', () => {
    const base = { status: 'open' } as const
    expect(deriveMissionState({ ...base }, ['done', 'done'])).toBe('ready-to-close')
    expect(deriveMissionState({ ...base }, ['done', 'waiting-review'])).toBe('open')
    // no required step at all is not "every step done".
    expect(deriveMissionState({ ...base }, [])).toBe('open')
    expect(deriveMissionState({ status: 'closed' }, ['done'])).toBe('closed')
    expect(deriveMissionState({ status: 'closed' }, ['todo'])).toBe('closed')
  })
})

describe('criterion settlement', () => {
  it('four ways to settle and a self-check does not', () => {
    const s = step([], { links: [{ kind: 'session', ref: 'sess-builder' }] })

    // 1. a fact: derived, nothing stored.
    const byFact = ac('ac-1', 'fact', { fact: 'pr-merged' })
    expect(criterionSettlement(byFact, s, { pr: 'merged' })).toEqual({ settled: true, via: 'fact' })
    expect(criterionSettlement(byFact, s, { pr: 'open' })).toEqual({ settled: false, via: null })

    // 2. a second session: a stamp whose author did not build the step.
    const bySession = ac('ac-2', 'session', {
      settled: { at: AT, by: 'sess-checker', evidence: 'ran it' }
    })
    expect(criterionSettlement(bySession, s, {})).toEqual({ settled: true, via: 'session' })

    // 3. the operator.
    const byOperator = ac('ac-3', 'operator', { settled: { at: AT, by: 'operator' } })
    expect(criterionSettlement(byOperator, s, {})).toEqual({ settled: true, via: 'operator' })

    // 4. another person, marked by the operator.
    const byPerson = ac('ac-4', 'person', {
      person: 'the designer',
      settled: { at: AT, by: 'operator', person: 'the designer' }
    })
    expect(criterionSettlement(byPerson, s, {})).toEqual({ settled: true, via: 'person' })

    // a self-check never settles: the stamp comes from a session that built the step.
    const selfChecked = ac('ac-5', 'session', {
      settled: { at: AT, by: 'sess-builder', evidence: 'I checked my own work' }
    })
    expect(criterionSettlement(selfChecked, s, {})).toEqual({ settled: false, via: null })
    // the leader that did the step itself is named by the caller and is a builder too.
    expect(criterionSettlement(bySession, s, { extraBuilders: ['sess-checker'] })).toEqual({
      settled: false,
      via: null
    })

    // the model's `selfCheck` field is a builder's labelled check and is never proof: a criterion
    // that carries only a self-check is open, whoever wrote it.
    const checkOnly = ac('ac-8', 'session', {
      selfCheck: { at: AT, by: 'sess-builder', evidence: 'I ran it myself' }
    })
    expect(criterionSettlement(checkOnly, s, {})).toEqual({ settled: false, via: null })
    const checkByOther = ac('ac-9', 'session', {
      selfCheck: { at: AT, by: 'sess-checker', evidence: 'looks right' }
    })
    expect(criterionSettlement(checkByOther, s, {})).toEqual({ settled: false, via: null })
    expect(state(step([checkOnly]), { pr: 'open' })).toBe('waiting-review')
    // beside a second session's stamp the self-check changes nothing: the stamp settles it.
    const both = ac('ac-10', 'session', {
      selfCheck: { at: AT, by: 'sess-builder', evidence: 'I ran it myself' },
      settled: { at: AT, by: 'sess-checker', evidence: 'ran it again' }
    })
    expect(criterionSettlement(both, s, {})).toEqual({ settled: true, via: 'session' })

    // no stamp, no settlement.
    expect(criterionSettlement(ac('ac-6', 'session'), s, {})).toEqual({
      settled: false,
      via: null
    })
    expect(criterionSettlement(ac('ac-7', 'operator'), s, {})).toEqual({
      settled: false,
      via: null
    })
  })

  it('a session cannot settle an operator or person criterion', () => {
    const s = step([])
    const forged = ac('ac-1', 'operator', { settled: { at: AT, by: 'sess-checker' } })
    expect(criterionSettlement(forged, s, {}).settled).toBe(false)
    const forgedPerson = ac('ac-2', 'person', {
      person: 'the designer',
      settled: { at: AT, by: 'sess-checker', person: 'the designer' }
    })
    expect(criterionSettlement(forgedPerson, s, {}).settled).toBe(false)
  })

  it('every fact reads from the input and a missing reading is false', () => {
    const s = step([])
    const reads = (fact: AcceptanceCriterion['fact'], input: StepInput): boolean =>
      criterionSettlement(ac('ac-1', 'fact', { fact }), s, input).settled
    expect(reads('pr-opened', { pr: 'open' })).toBe(true)
    expect(reads('pr-opened', { pr: 'merged' })).toBe(true) // a merged pull request was opened
    expect(reads('pr-opened', { pr: 'none' })).toBe(false)
    expect(reads('pr-merged', { pr: 'open' })).toBe(false)
    expect(reads('ci-green', { facts: { 'ci-green': true } })).toBe(true)
    expect(reads('ci-green', {})).toBe(false)
    expect(reads('main-green', { facts: { 'main-green': true } })).toBe(true)
    expect(reads('main-green', { facts: { 'ci-green': true } })).toBe(false)
    expect(reads('link-exists', { facts: { 'link-exists': true } })).toBe(true)
    expect(reads('link-exists', {})).toBe(false)
  })
})

describe('a fact replaces stale state', () => {
  it('a merged pull request clears the blocker that waited for it', () => {
    const waits = blocker({ id: 'blk-1', clearsWhen: 'pr-merged' })
    const manual = blocker({ id: 'blk-2' })
    const ciWaits = blocker({ id: 'blk-3', clearsWhen: 'ci-green' })
    const all = [waits, manual, ciWaits]

    expect(activeBlockers(all, { pr: 'open' }).map((b) => b.id)).toEqual([
      'blk-1',
      'blk-2',
      'blk-3'
    ])
    // the fact holds now: the blocker stops showing with no manual clear.
    expect(activeBlockers(all, { pr: 'merged' }).map((b) => b.id)).toEqual(['blk-2', 'blk-3'])
    // a blocker with no `clearsWhen` only a person clears.
    expect(activeBlockers([manual], { pr: 'merged', facts: { 'ci-green': true } })).toEqual([
      manual
    ])
    expect(
      activeBlockers(all, { pr: 'merged', facts: { 'ci-green': true } }).map((b) => b.id)
    ).toEqual(['blk-2'])

    // ...and the step's blocked mark follows.
    const s = step([ac('ac-1', 'session')], { blockers: [waits] })
    expect(deriveStepState(s, { pr: 'open' }).blocked).toBe(true)
    expect(deriveStepState(s, { pr: 'merged' }).blocked).toBe(false)
    expect(deriveStepState(s, { pr: 'merged' }).blockers).toEqual([])

    // a fact replaces stale state on the criterion side too: a hand tick on a criterion tied to a
    // fact never settles it. Open while the pull request is open, settled by the fact once merged.
    const handTicked = ac('ac-9', 'fact', {
      fact: 'pr-merged',
      settled: { at: AT, by: 'operator' }
    })
    expect(criterionSettlement(handTicked, step([]), { pr: 'open' })).toEqual({
      settled: false,
      via: null
    })
    expect(criterionSettlement(handTicked, step([]), { pr: 'merged' })).toEqual({
      settled: true,
      via: 'fact'
    })
  })

  it('a criterion tied to a fact is never ticked by hand', () => {
    const s = step([])
    // a stamp on a fact criterion (hand-edited file, or a door that should have refused) is ignored.
    const ticked = ac('ac-1', 'fact', {
      fact: 'pr-merged',
      settled: { at: AT, by: 'operator' }
    })
    expect(criterionSettlement(ticked, s, { pr: 'open' })).toEqual({ settled: false, via: null })
    expect(criterionSettlement(ticked, s, { pr: 'merged' })).toEqual({
      settled: true,
      via: 'fact'
    })
    // so the step never reads done because of a hand tick on a fact criterion.
    expect(state(step([ticked]), { pr: 'open' })).toBe('waiting-review')
  })

  it('a fact that falls back un-settles the criterion: nothing is stored, so nothing is stale', () => {
    const s = step([ac('ac-1', 'fact', { fact: 'ci-green' })])
    expect(state(s, { pr: 'open', facts: { 'ci-green': true } })).toBe('done')
    expect(state(s, { pr: 'open', facts: { 'ci-green': false } })).toBe('waiting-review')
  })
})

describe('the step result carries what the surfaces show', () => {
  it('lists each criterion with how it settled and which are open', () => {
    const s = step([
      ac('ac-1', 'fact', { fact: 'pr-merged' }),
      ac('ac-2', 'session'),
      ac('ac-3', 'person', { person: 'the designer' })
    ])
    const out = deriveStepState(s, { pr: 'merged' })
    expect(out.criteria).toEqual([
      { id: 'ac-1', by: 'fact', settled: true, via: 'fact' },
      { id: 'ac-2', by: 'session', settled: false, via: null },
      { id: 'ac-3', by: 'person', settled: false, via: null }
    ])
    expect(out.open.map((c) => c.id)).toEqual(['ac-2', 'ac-3'])
  })
})

describe('the mission state with milestones', () => {
  it('a required milestone that is not done keeps the mission open, even with every step done', () => {
    const open = { status: 'open' } as const
    expect(deriveMissionState(open, ['done'], ['done', 'not-started'])).toBe('open')
    expect(deriveMissionState(open, ['done'], ['done', 'done'])).toBe('ready-to-close')
  })
})

describe('delta 1 · a re-queued card, a closed pull request, and unknown is not false', () => {
  it('a card in Backlog or Ready reads to do unless a pull request exists, whatever startedAt says', () => {
    const started = step([ac('ac-1', 'session')], { startedAt: AT })
    // the card was re-queued: the board column wins over the leader's old start stamp.
    expect(state(started, { card: 'backlog' })).toBe('todo')
    expect(state(started, { card: 'ready' })).toBe('todo')
    // with no card, or a card already in progress, a started step is still running.
    expect(state(started)).toBe('running')
    expect(state(started, { card: 'in-progress' })).toBe('running')
    // a pull request still wins by rule 2.
    expect(state(started, { card: 'backlog', pr: 'open' })).toBe('waiting-review')
    expect(state(started, { card: 'ready', pr: 'merged' })).toBe('waiting-review')
  })

  it('a pull request closed without merging counts as no pull request', () => {
    const started = step([ac('ac-1', 'session')], { startedAt: AT })
    // the work does not exist: a started step is back to running, not waiting for review.
    expect(state(started, { pr: 'closed' })).toBe('running')
    expect(state(step([ac('ac-1', 'session')]), { pr: 'closed' })).toBe('todo')
    // a sign-off step reads waiting for review by the no-pull-request rule, as it does with none.
    expect(state(step([ac('ac-1', 'operator')]), { pr: 'closed' })).toBe('waiting-review')
    // no fact reads a closed pull request as opened or merged.
    const reads = (fact: AcceptanceCriterion['fact']): boolean =>
      criterionSettlement(ac('ac-1', 'fact', { fact }), step([]), { pr: 'closed' }).settled
    expect(reads('pr-opened')).toBe(false)
    expect(reads('pr-merged')).toBe(false)
  })

  it('a fact that is absent is not read yet and false is read and does not hold', () => {
    // main-green absent: nothing was read. main-green false: it was read and main is red.
    expect(factReading('main-green', {})).toBe('unknown')
    expect(factReading('main-green', { facts: {} })).toBe('unknown')
    expect(factReading('main-green', { facts: { 'main-green': false } })).toBe('does-not-hold')
    expect(factReading('main-green', { facts: { 'main-green': true } })).toBe('holds')
    expect(factReading('ci-green', {})).toBe('unknown')
    expect(factReading('link-exists', { facts: { 'link-exists': false } })).toBe('does-not-hold')
    // the pull request facts follow `pr`: absent is unknown, anything given was read.
    expect(factReading('pr-merged', {})).toBe('unknown')
    expect(factReading('pr-merged', { pr: 'none' })).toBe('does-not-hold')
    expect(factReading('pr-merged', { pr: 'closed' })).toBe('does-not-hold')
    expect(factReading('pr-merged', { pr: 'open' })).toBe('does-not-hold')
    expect(factReading('pr-merged', { pr: 'merged' })).toBe('holds')
    expect(factReading('pr-opened', { pr: 'merged' })).toBe('holds')
    expect(factReading('pr-opened', { pr: 'closed' })).toBe('does-not-hold')
  })

  it('an unknown fact is never a failure: it settles nothing and clears nothing, as a false one does', () => {
    const fact = step([ac('ac-1', 'fact', { fact: 'main-green' })], {
      blockers: [blocker({ clearsWhen: 'main-green' })]
    })
    const unknown = deriveStepState(fact, { pr: 'merged' })
    const red = deriveStepState(fact, { pr: 'merged', facts: { 'main-green': false } })
    expect(unknown).toEqual(red)
    expect(unknown.state).toBe('waiting-review')
    expect(unknown.blocked).toBe(true)
  })
})

describe('the state identifiers come from the model', () => {
  it('every state the derivation returns is one the model names, and every one the model names is reachable', () => {
    const sign = step([ac('ac-1', 'operator')])
    const open = step([ac('ac-1', 'session')])
    const doneStep = step([ac('ac-1', 'operator', { settled: { at: AT, by: 'operator' } })])
    const steps = [
      state(open),
      state(open, { workerWorking: true }),
      state(open, { pr: 'open' }),
      state(doneStep),
      state(sign)
    ]
    expect(new Set(steps)).toEqual(new Set(STEP_STATES))
    const milestones = [
      deriveMilestoneState([]),
      deriveMilestoneState(['running', 'todo']),
      deriveMilestoneState(['waiting-review']),
      deriveMilestoneState(['done'])
    ]
    expect(new Set(milestones)).toEqual(new Set(MILESTONE_STATES))
    const open4 = { status: 'open' } as const
    const missions = [
      deriveMissionState(open4, ['todo']),
      deriveMissionState(open4, ['done']),
      deriveMissionState({ status: 'closed' }, ['done'])
    ]
    expect(new Set(missions)).toEqual(new Set(MISSION_STATES))
  })
})
