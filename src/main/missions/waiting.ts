/**
 * Missions v4 S-8, S-40 (R-25) — the ONE waiting list: what a mission waits on the operator for.
 *
 * Built here, once, from a v4 record and plain input facts ({@link waitingListV4}). Nothing in this file
 * reads a file, the fleet or GitHub, writes anything, or wakes anything. The MCP read (`mission_get`),
 * the companion, Your move and the renderer all read THIS list. None builds its own list, none adds a
 * row, and the wording of an item (`ask`, `why`) is written here and nowhere else.
 *
 * The rank, stated once (spec "Progress, next step and the waiting list", D-14): `main-failing`,
 * `unblock`, `settle`, `review`, `close`, `attach`; plan order inside a rank.
 *
 * Until S-40 a second, v3 list lived here beside it (the operator-owed kinds of Mission v3 §3.12, built
 * from a v3 mission file and its derived signals, with `youSentence` and `youLine`). The v3 handlers and
 * the v3 view are gone, so that list is gone; only the item type {@link MissionYouItem} stays, because
 * stored Your move cards and the renderer's cue still carry the kind names.
 *
 * Pure and Electron-free: tests import it with nothing mocked.
 */

import type { BlockerV4, MissionV4, StepV4 } from './model'
import { deriveProgress, type MissionProgress as MissionProgressV4 } from './progress'
import {
  activeBlockers,
  deriveStepState,
  factReading,
  type StepInput,
  type StepStateResult
} from './state'

/** The `you` line when the operator owes this mission nothing (design §4). */
export const YOU_CLEAR = "— nothing, you're clear"

/** `ask`: what to do, at most this many characters (spec "Progress, next step and the waiting list"). */
export const WAITING_ASK_MAX = 90
/** `why`: what it unlocks, at most this many characters. */
export const WAITING_WHY_MAX = 60

/**
 * The v4 kinds of a waiting item, in the rank the v4 list will use: `main-failing` (a merged step
 * whose `main` fact is red), `unblock` (an operator-owned blocker, a decision included), `settle` (an
 * operator criterion to mark), `review` (pull requests that wait for the operator), `close` (ready to
 * close), `attach` (a session asks to join).
 */
export type WaitingKind = 'main-failing' | 'unblock' | 'settle' | 'review' | 'close' | 'attach'

/**
 * Mission v3 §3.12 — one thing the operator owes a mission: the detail of a waiting item, by v3
 * kind. `mission_get` reports the whole ordered list as `youItems` (and its first item as the `you`
 * line). A pending decision (`decide`) is in it since S-5: before, only the renderer knew about it.
 */
export type MissionYouItem =
  | { kind: 'rescope'; end: { kind: string; target: string; evidence: string } }
  | { kind: 'close' }
  | { kind: 'blocker'; reason: string; unblocks: string }
  /** An undecided decision node: the operator's to choose, and the steps it blocks stay locked. */
  | { kind: 'decide'; stepId: string; title: string }
  | { kind: 'checks'; count: number; stepIds: string[] }
  | { kind: 'human-steps'; stepIds: string[] }
  | { kind: 'review-import' }
  /** Campaign spec §3.2 — a step is done, its PR merged, and the merge commit's CI on main is red. */
  | { kind: 'main-red'; stepId: string; pr: number }
  | { kind: 'approvals'; count: number; sessionId: string }
  | { kind: 'needs-input'; sessionId: string }

/** One entry of the retired v3 list: a v3 item. */
export type WaitingItem = MissionYouItem

// ---- The v4 list (S-8) ------------------------------------------------------------

/** The six kinds in the one rank the v4 list uses (D-14). Index = rank. */
export const WAITING_RANK: readonly WaitingKind[] = [
  'main-failing',
  'unblock',
  'settle',
  'review',
  'close',
  'attach'
]

interface WaitingBase {
  /** A key that is unique within the list and stable while the thing it names is unchanged. */
  id: string
  /** What to do. The v4 list never cuts it: the cap is the writing contract's, enforced on write. */
  ask: string
  /** What it unlocks. Never cut either. */
  why: string
}

/** One thing the operator owes a v4 mission. One type, discriminated by the v4 kind. */
export type WaitingItemV4 =
  | (WaitingBase & { kind: 'main-failing'; stepId: string; pr: string | null })
  | (WaitingBase & { kind: 'unblock'; stepId: string | null; blockerId: string })
  | (WaitingBase & { kind: 'settle'; stepId: string; criterionId: string })
  | (WaitingBase & { kind: 'review'; stepIds: string[]; prs: string[] })
  | (WaitingBase & { kind: 'close'; requested: boolean })
  | (WaitingBase & { kind: 'attach'; requestId: string; sessionId: string })

/** A criterion that waits for another person: shown as waiting for them, never as the operator's move. */
export interface WaitingPerson {
  person: string
  stepId: string
  criterionId: string
  text: string
}

export interface WaitingListV4 {
  /** Every item, in rank order (plan order inside a rank). */
  items: WaitingItemV4[]
  /** "Your next step": the first item, or `null` when nothing waits on the operator. */
  next: WaitingItemV4 | null
  /** The others, one click away. */
  more: WaitingItemV4[]
  /** "N more waiting on you", or `null` when there is nothing more. */
  moreLine: string | null
  /** What waits for other people. Not in `items`. */
  people: WaitingPerson[]
  /** "Waiting for the designer" for one person, "Waiting for other people" for several, else `null`. */
  peopleLine: string | null
  /** One "Waiting for <person>" line per distinct person, in plan order. */
  peopleLines: string[]
}

/** The one empty line: what a mission says when nothing waits on the operator. Worded here only. */
export const WAITING_EMPTY_LINE = 'Nothing waits on the operator.'
/** The line for several people at once. */
export const WAITING_OTHERS_LINE = 'Waiting for other people'
/** The line for one person: a person's sign-off is never the operator's move. */
export const waitingForLine = (person: string): string => `Waiting for ${person}`

/** Every step's derived state, keyed by step id. Derive it once and hand it to every reader of a view. */
export type StepResults = Readonly<Record<string, StepStateResult>>

/** Derive every step of a mission once (`state.ts`), from the caller's plain input facts. */
export function deriveStepResults(
  mission: Pick<MissionV4, 'steps'>,
  inputs: Readonly<Record<string, StepInput>> = {}
): StepResults {
  return Object.fromEntries(
    mission.steps.map((step) => [step.id, deriveStepState(step, inputs[step.id] ?? {})])
  )
}

/** Input facts the record does not hold. All optional: no input is a mission with nothing read. */
export interface WaitingInputV4 {
  /** Per-step input facts keyed by step id (see `state.ts`); the caller's sticky last-known values. */
  inputs?: Readonly<Record<string, StepInput>>
  /** The mission's progress, when the caller already derived it from the same inputs. */
  progress?: MissionProgressV4
  /** Every step's derived state ({@link deriveStepResults}), when the caller already derived it. */
  results?: StepResults
}

/** The number a `pr` link names (`256`, `#256`, `org/proj#7`, a pull request URL), or `null`. */
function prNumber(step: Pick<StepV4, 'links'>): string | null {
  const link = (step.links ?? []).find((l) => l.kind === 'pr')
  return link ? (/(\d+)\s*$/.exec(link.ref)?.[1] ?? null) : null
}

/** A blocker as an item: its own `ask` and `unblocks` when it has them (a v3 blocker has neither). */
function blockerItem(b: BlockerV4, step: Pick<StepV4, 'id'> | null): WaitingItemV4 {
  return {
    kind: 'unblock',
    id: `unblock:${step?.id ?? 'mission'}:${b.id}`,
    stepId: step?.id ?? null,
    blockerId: b.id,
    // An old record's blocker has no `ask`: its reason is the ask, whole, with nothing in front of it.
    ask: b.ask ?? b.reason,
    why:
      b.unblocks ??
      (step ? 'The step cannot go on until then' : 'The mission cannot go on until then')
  }
}

/**
 * What a v4 mission waits on the operator for, with the next step first. Pure: the record and the plain
 * input facts in, a list out. It reads no file, starts no `git` or `gh`, and never reads the clock.
 *
 * - `main-failing`: a merged step whose `main-green` fact was read and is `false`. A fact that was
 *   never read does not make `main` failing.
 * - `unblock`: an operator-owned blocker that still shows (a `clearsWhen` fact that holds hides it); a
 *   decision is one of these. The blocker's own `ask` and `unblocks` are the wording. A mission-level
 *   blocker's `clearsWhen` is ignored: the write path refuses it, because a fact belongs to a step.
 * - `settle`: one item per open operator criterion on a started step (not `todo`, not done).
 * - `review`: the pull requests the operator can look over, grouped into one item: the step waits for
 *   review, is not blocked, and its checks are not known to be red (`ci-green` read and false).
 * - `close`: the mission is ready to close (derived); `requested` says the agent asked.
 * - `attach`: a pending request in the record's `attachRequests`: a session asks to join the mission.
 *
 * A criterion that waits for another person is not an item: it is in `people`, and `peopleLine` says so.
 * A closed mission owes nothing.
 */
export function waitingListV4(mission: MissionV4, opts: WaitingInputV4 = {}): WaitingListV4 {
  const none: WaitingListV4 = {
    items: [],
    next: null,
    more: [],
    moreLine: null,
    people: [],
    peopleLine: null,
    peopleLines: []
  }
  if (mission.status === 'closed') return none

  const inputs = opts.inputs ?? {}
  const progress = opts.progress ?? deriveProgress(mission, inputs)
  const results = opts.results ?? deriveStepResults(mission, inputs)
  const steps = mission.steps.map((step) => ({
    step,
    input: inputs[step.id] ?? {},
    result: results[step.id] ?? deriveStepState(step, inputs[step.id] ?? {})
  }))

  const mainFailing: WaitingItemV4[] = []
  const unblock: WaitingItemV4[] = []
  const settle: WaitingItemV4[] = []
  const people: WaitingPerson[] = []
  const reviewing: { stepId: string; title: string; pr: string | null }[] = []

  for (const b of activeBlockers(mission.blockers ?? [], {})) {
    if (b.owner === 'operator') unblock.push(blockerItem(b, null))
  }
  for (const { step, input, result } of steps) {
    const started = result.state !== 'todo' && result.state !== 'done'
    // A merged step whose `main` was READ and does not hold. A `main` nobody read is never a failure.
    if (
      factReading('pr-merged', input) === 'holds' &&
      factReading('main-green', input) === 'does-not-hold'
    ) {
      mainFailing.push({
        kind: 'main-failing',
        id: `main-failing:${step.id}`,
        stepId: step.id,
        pr: prNumber(step),
        ask: `Fix the main branch: it broke after "${step.title}"`,
        why: 'Everything that merges next starts from a broken base'
      })
    }
    for (const b of result.blockers) {
      if (b.owner === 'operator') unblock.push(blockerItem(b, step))
    }
    if (started) {
      for (const c of result.open) {
        if (c.by === 'operator') {
          settle.push({
            kind: 'settle',
            id: `settle:${step.id}:${c.id}`,
            stepId: step.id,
            criterionId: c.id,
            ask: `Mark done: ${c.text}`,
            why:
              result.open.length === 1
                ? 'It is the last thing open on this step'
                : `${result.open.length - 1} more ${result.open.length === 2 ? 'thing is' : 'things are'} open on this step`
          })
        } else if (c.by === 'person') {
          people.push({
            person: c.person ?? 'another person',
            stepId: step.id,
            criterionId: c.id,
            text: c.text
          })
        }
      }
    }
    // A pull request the operator can look over: its step waits for review, is not blocked, and its
    // checks are not known to be red (unread checks are not a reason to hold it back).
    if (
      input.pr === 'open' &&
      result.state === 'waiting-review' &&
      !result.blocked &&
      factReading('ci-green', input) !== 'does-not-hold'
    ) {
      reviewing.push({ stepId: step.id, title: step.title, pr: prNumber(step) })
    }
  }

  const review: WaitingItemV4[] = []
  if (reviewing.length > 0) {
    const n = reviewing.length
    review.push({
      kind: 'review',
      id: 'review',
      stepIds: reviewing.map((r) => r.stepId),
      prs: reviewing.flatMap((r) => (r.pr ? [r.pr] : [])),
      ask:
        n === 1
          ? `Look over the pull request for "${reviewing[0].title}"`
          : `Look over ${n} pull requests`,
      why: n === 1 ? 'The step cannot finish until you do' : `${n} steps cannot finish until you do`
    })
  }

  const close: WaitingItemV4[] = []
  if (progress.missionState === 'ready-to-close') {
    const requested = mission.closeRequested !== undefined
    close.push({
      kind: 'close',
      id: 'close',
      requested,
      ask: requested
        ? 'Close the mission: the session says it is ready'
        : 'Close the mission: every step is done',
      why: 'The mission is finished once you close it'
    })
  }

  // A session's request to join lives in the record; only an undecided one waits on the operator.
  const attach: WaitingItemV4[] = (mission.attachRequests ?? [])
    .filter((r) => r.decision === null)
    .map((r) => ({
      kind: 'attach' as const,
      id: `attach:${r.id}`,
      requestId: r.id,
      // The session id is the door's target (Allow, Deny); it is never in the text.
      sessionId: r.sessionId,
      ask: 'Let another session join this mission',
      why: 'It asked to work on it and waits for your answer'
    }))

  const byKind: Record<WaitingKind, WaitingItemV4[]> = {
    'main-failing': mainFailing,
    unblock,
    settle,
    review,
    close,
    attach
  }
  const items = WAITING_RANK.flatMap((k) => byKind[k])
  const more = items.slice(1)
  const persons = [...new Set(people.map((p) => p.person))]
  return {
    items,
    next: items[0] ?? null,
    more,
    moreLine: more.length > 0 ? `${more.length} more waiting on you` : null,
    people,
    peopleLine:
      persons.length === 0
        ? null
        : persons.length === 1
          ? waitingForLine(persons[0])
          : WAITING_OTHERS_LINE,
    peopleLines: persons.map(waitingForLine)
  }
}
