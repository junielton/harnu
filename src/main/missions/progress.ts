/**
 * Missions v4 S-7 (AC-15, AC-16) — progress, pure.
 *
 * One function from a v4 record and the per-step input facts to the numbers every surface reads: the
 * unit that is counted, how many are done, the current milestone, every milestone's state and its
 * summary counts. Pure like `state.ts`, which it builds on: no file, no git, no `gh`, no clock.
 *
 * - **The unit follows the plan.** Milestones when the mission has them ("1 of 10 milestones done",
 *   D-10), steps when it has none. Optional milestones and optional steps are outside the count (D-13);
 *   a step inside an optional milestone is optional too.
 * - **The current one is the first in plan order that is neither done nor optional.** Plan order is
 *   the order of the record's arrays, never the order of the ids.
 * - **More than one milestone can be open at once** (D-9): `openMilestones` lists every one that is in
 *   progress or waiting for review.
 * - **The milestone summary counts running, waiting for review and blocked steps.** To do steps are
 *   not in it. Only required steps are counted, the same rule as the headline.
 *
 * A step that names a milestone the record does not have counts nowhere in a mission with milestones;
 * it still appears in {@link MissionProgress.steps}.
 */

import type { MissionV4, StepV4 } from './model'
import {
  deriveMilestoneState,
  deriveMissionState,
  deriveStepState,
  type MilestoneState,
  type MissionState,
  type StepInput,
  type StepState
} from './state'

/** What the milestone summary shows: running, waiting for review and blocked. Never to do. */
export interface MilestoneCounts {
  running: number
  waitingReview: number
  blocked: number
}

export interface MilestoneProgress {
  id: string
  title: string
  optional: boolean
  state: MilestoneState
  counts: MilestoneCounts
}

export interface StepProgress {
  id: string
  milestone: string | undefined
  /** Outside the count: the step is optional, or it sits in an optional milestone. */
  optional: boolean
  state: StepState
  blocked: boolean
}

/** The position of the current unit: its id and its 1-based place among the counted ones. */
export interface CurrentUnit {
  id: string
  ordinal: number
}

export interface MissionProgress {
  /** What is counted: milestones when the mission has them, steps otherwise. */
  unit: 'milestones' | 'steps'
  /** How many units count (the required ones). */
  total: number
  /** How many of them are done. */
  done: number
  /** The first unit in plan order that is neither done nor optional; `null` when none is left. */
  current: CurrentUnit | null
  /** Every counted unit is done and there is at least one. */
  allDone: boolean
  missionState: MissionState
  /** Every milestone in plan order, optional ones included. */
  milestones: MilestoneProgress[]
  /** Ids of the milestones in progress or waiting for review, in plan order. */
  openMilestones: string[]
  /** Every step in plan order, optional ones included. */
  steps: StepProgress[]
  /** The four states and the blocked mark across the counted (required) steps. */
  counts: { todo: number; running: number; waitingReview: number; done: number; blocked: number }
}

/**
 * Derive the progress of a v4 record.
 *
 * @param inputs per-step input facts keyed by step id; a step with no entry reads as an empty input
 */
export function deriveProgress(
  mission: MissionV4,
  inputs: Readonly<Record<string, StepInput>> = {}
): MissionProgress {
  const milestoneById = new Map(mission.milestones.map((m) => [m.id, m]))

  const derived = mission.steps.map((step) => ({
    step,
    result: deriveStepState(step, inputs[step.id] ?? {}),
    optional: isOptionalStep(step, milestoneById)
  }))

  const steps: StepProgress[] = derived.map(({ step, result, optional }) => ({
    id: step.id,
    milestone: step.milestone,
    optional,
    state: result.state,
    blocked: result.blocked
  }))

  const milestones: MilestoneProgress[] = mission.milestones.map((m) => {
    const own = derived.filter((d) => d.step.milestone === m.id)
    // The required steps decide the state; a milestone whose steps are all optional reads from all of
    // them, so an optional milestone still shows where it is.
    const required = own.filter((d) => !d.optional)
    const deciding = required.length > 0 ? required : own
    return {
      id: m.id,
      title: m.title,
      optional: m.optional === true,
      state: deriveMilestoneState(deciding.map((d) => d.result.state)),
      counts: {
        running: required.filter((d) => d.result.state === 'running').length,
        waitingReview: required.filter((d) => d.result.state === 'waiting-review').length,
        blocked: required.filter((d) => d.result.blocked).length
      }
    }
  })

  const countedSteps = steps.filter((s) => !s.optional)
  const counts = {
    todo: countedSteps.filter((s) => s.state === 'todo').length,
    running: countedSteps.filter((s) => s.state === 'running').length,
    waitingReview: countedSteps.filter((s) => s.state === 'waiting-review').length,
    done: countedSteps.filter((s) => s.state === 'done').length,
    blocked: countedSteps.filter((s) => s.blocked).length
  }

  const byMilestones = mission.milestones.length > 0
  const units: { id: string; optional: boolean; done: boolean }[] = byMilestones
    ? milestones.map((m) => ({ id: m.id, optional: m.optional, done: m.state === 'done' }))
    : steps.map((s) => ({ id: s.id, optional: s.optional, done: s.state === 'done' }))
  const counted = units.filter((u) => !u.optional)
  const currentIndex = counted.findIndex((u) => !u.done)
  const done = counted.filter((u) => u.done).length

  const requiredMilestones = milestones.filter((m) => !m.optional)
  const missionState = deriveMissionState(
    mission,
    countedSteps.map((s) => s.state),
    requiredMilestones.map((m) => m.state)
  )

  return {
    unit: byMilestones ? 'milestones' : 'steps',
    total: counted.length,
    done,
    current: currentIndex >= 0 ? { id: counted[currentIndex].id, ordinal: currentIndex + 1 } : null,
    allDone: counted.length > 0 && done === counted.length,
    missionState,
    milestones,
    openMilestones: milestones
      .filter((m) => m.state === 'in-progress' || m.state === 'waiting-review')
      .map((m) => m.id),
    steps,
    counts
  }
}

/** A step is outside the count when it is optional itself or sits in an optional milestone. */
function isOptionalStep(
  step: StepV4,
  milestoneById: ReadonlyMap<string, { optional?: boolean }>
): boolean {
  if (step.optional === true) return true
  return step.milestone !== undefined && milestoneById.get(step.milestone)?.optional === true
}
