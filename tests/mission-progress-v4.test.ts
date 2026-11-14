/**
 * Missions v4 · S-7 · AC-15, AC-16 — what progress counts, which milestone is current, and what the
 * milestone summary shows.
 *
 * `src/main/missions/progress.ts` is pure: a v4 record plus per-step input facts in, numbers out.
 * Named `-v4` because `tests/mission-progress.test.ts` pins the v3 progress derivation.
 */
import { describe, expect, it } from 'vitest'
import type { MissionV4, StepV4 } from '../src/main/missions/model'
import { deriveProgress } from '../src/main/missions/progress'
import type { StepInput } from '../src/main/missions/state'

const AT = '2026-11-14T10:00:00Z'

/** A step with one session criterion: open until `done` is passed, which stamps a second session. */
function mkStep(id: string, extra: Partial<StepV4> & { done?: boolean } = {}): StepV4 {
  const { done, ...rest } = extra
  return {
    id,
    title: `Step ${id}`,
    acs: [
      {
        id: 'ac-1',
        text: 'It works',
        by: 'session',
        ...(done ? { settled: { at: AT, by: 'sess-checker', evidence: 'ran it' } } : {})
      }
    ],
    links: [],
    blockers: [],
    ...rest
  } as StepV4
}

function mkMission(extra: Partial<MissionV4>): MissionV4 {
  return {
    schemaVersion: 4,
    id: 'mnt-1a2b3c4d',
    title: 'A mission',
    doneWhen: 'It is done.',
    status: 'open',
    milestones: [],
    steps: [],
    sessions: [],
    links: [],
    blockers: [],
    ...extra
  } as MissionV4
}

const ms = (id: string, extra: Record<string, unknown> = {}): MissionV4['milestones'][number] =>
  ({
    id,
    title: `Milestone ${id}`,
    optional: false,
    waitsFor: null,
    ...extra
  }) as MissionV4['milestones'][number]

describe('the unit follows the plan', () => {
  it('counts steps when the mission has no milestones, leaving optional steps outside the count', () => {
    const m = mkMission({
      steps: [
        mkStep('stp-1', { done: true }),
        mkStep('stp-2'),
        mkStep('stp-3', { optional: true, done: true }),
        mkStep('stp-4', { optional: true }),
        mkStep('stp-5')
      ]
    })
    const p = deriveProgress(m)
    expect(p.unit).toBe('steps')
    expect(p.total).toBe(3) // stp-1, stp-2, stp-5
    expect(p.done).toBe(1) // the optional step that is done does not count
    expect(p.current).toEqual({ id: 'stp-2', ordinal: 2 })
    expect(p.allDone).toBe(false)
    expect(p.missionState).toBe('open')
  })

  it('counts milestones when the mission has them, whatever its steps do', () => {
    const m = mkMission({
      milestones: [ms('mls-1'), ms('mls-2'), ms('mls-3')],
      steps: [
        mkStep('stp-1', { milestone: 'mls-1', done: true }),
        mkStep('stp-2', { milestone: 'mls-1', done: true }),
        mkStep('stp-3', { milestone: 'mls-2' })
        // mls-3 has no steps yet: only the next ones are planned in detail.
      ]
    })
    const p = deriveProgress(m)
    expect(p.unit).toBe('milestones')
    expect(p.total).toBe(3)
    expect(p.done).toBe(1)
    expect(p.milestones.map((x) => [x.id, x.state])).toEqual([
      ['mls-1', 'done'],
      ['mls-2', 'in-progress'],
      ['mls-3', 'not-started']
    ])
  })

  it('an optional milestone stays outside the count', () => {
    const m = mkMission({
      milestones: [ms('mls-1'), ms('mls-2', { optional: true }), ms('mls-3')],
      steps: [
        mkStep('stp-1', { milestone: 'mls-1', done: true }),
        mkStep('stp-2', { milestone: 'mls-2', done: true }),
        mkStep('stp-3', { milestone: 'mls-3' })
      ]
    })
    const p = deriveProgress(m)
    expect(p.total).toBe(2)
    expect(p.done).toBe(1) // mls-2 is done but optional
    expect(p.milestones.find((x) => x.id === 'mls-2')).toMatchObject({
      optional: true,
      state: 'done'
    })
  })

  it('the current milestone is the first in plan order that is neither done nor optional', () => {
    const m = mkMission({
      // plan order is array order, not id order.
      milestones: [ms('mls-4'), ms('mls-2', { optional: true }), ms('mls-1'), ms('mls-3')],
      steps: [
        mkStep('stp-1', { milestone: 'mls-4', done: true }),
        mkStep('stp-2', { milestone: 'mls-2' }),
        mkStep('stp-3', { milestone: 'mls-1' }),
        mkStep('stp-4', { milestone: 'mls-3' })
      ]
    })
    const p = deriveProgress(m)
    // mls-4 done, mls-2 optional and open, so the first one still to do is mls-1: the 2nd counted.
    expect(p.current).toEqual({ id: 'mls-1', ordinal: 2 })
  })

  it('has no current milestone when every counted one is done, and says so', () => {
    const m = mkMission({
      milestones: [ms('mls-1'), ms('mls-2', { optional: true })],
      steps: [
        mkStep('stp-1', { milestone: 'mls-1', done: true }),
        mkStep('stp-2', { milestone: 'mls-2' })
      ]
    })
    const p = deriveProgress(m)
    expect(p.current).toBeNull()
    expect(p.allDone).toBe(true)
    expect(p.missionState).toBe('ready-to-close')
  })

  it('a required milestone with no step yet keeps the mission from being ready to close', () => {
    const m = mkMission({
      milestones: [ms('mls-1'), ms('mls-2')],
      steps: [mkStep('stp-1', { milestone: 'mls-1', done: true })]
    })
    const p = deriveProgress(m)
    expect(p.allDone).toBe(false)
    expect(p.missionState).toBe('open')
    expect(p.current).toEqual({ id: 'mls-2', ordinal: 2 })
  })

  it('a closed mission reads closed and an empty mission reads open', () => {
    expect(
      deriveProgress(mkMission({ status: 'closed', closedAs: 'delivered' })).missionState
    ).toBe('closed')
    const empty = deriveProgress(mkMission({}))
    expect(empty).toMatchObject({ unit: 'steps', total: 0, done: 0, current: null, allDone: false })
    expect(empty.missionState).toBe('open')
  })

  it('reads each step through its own input facts', () => {
    const m = mkMission({ steps: [mkStep('stp-1'), mkStep('stp-2')] })
    const inputs: Record<string, StepInput> = {
      'stp-1': { pr: 'merged' },
      'stp-2': { card: 'in-progress' }
    }
    const p = deriveProgress(m, inputs)
    expect(p.steps.map((s) => [s.id, s.state])).toEqual([
      ['stp-1', 'waiting-review'],
      ['stp-2', 'running']
    ])
  })
})

describe('more than one milestone can be open', () => {
  it('three milestones can wait for review at once', () => {
    const m = mkMission({
      milestones: [ms('mls-1'), ms('mls-2'), ms('mls-3'), ms('mls-4')],
      steps: [
        mkStep('stp-1', { milestone: 'mls-1' }),
        mkStep('stp-2', { milestone: 'mls-2' }),
        mkStep('stp-3', { milestone: 'mls-2' }),
        mkStep('stp-4', { milestone: 'mls-3' }),
        mkStep('stp-5', { milestone: 'mls-4' })
      ]
    })
    const inputs: Record<string, StepInput> = {
      'stp-1': { pr: 'open' },
      'stp-2': { pr: 'open' },
      'stp-3': { pr: 'merged' },
      'stp-4': { pr: 'open' }
      // mls-4's step has not started.
    }
    const p = deriveProgress(m, inputs)
    expect(p.milestones.map((x) => [x.id, x.state])).toEqual([
      ['mls-1', 'waiting-review'],
      ['mls-2', 'waiting-review'],
      ['mls-3', 'waiting-review'],
      ['mls-4', 'not-started']
    ])
    expect(p.openMilestones).toEqual(['mls-1', 'mls-2', 'mls-3'])
    // the first one in plan order is still the one the headline names.
    expect(p.current).toEqual({ id: 'mls-1', ordinal: 1 })
  })

  it('the milestone summary counts running, waiting for review and blocked steps, never to do', () => {
    const m = mkMission({
      milestones: [ms('mls-1')],
      steps: [
        mkStep('stp-1', { milestone: 'mls-1' }), // running
        mkStep('stp-2', { milestone: 'mls-1' }), // waiting for review
        mkStep('stp-3', { milestone: 'mls-1' }), // waiting for review
        mkStep('stp-4', {
          milestone: 'mls-1',
          blockers: [{ id: 'blk-1', reason: 'needs a key', owner: 'operator' }]
        }), // to do, blocked
        mkStep('stp-5', { milestone: 'mls-1' }), // to do
        mkStep('stp-6', { milestone: 'mls-1', done: true }) // done
      ]
    })
    const inputs: Record<string, StepInput> = {
      'stp-1': { workerWorking: true },
      'stp-2': { pr: 'open' },
      'stp-3': { pr: 'open' }
    }
    const [mls] = deriveProgress(m, inputs).milestones
    expect(mls.counts).toEqual({ running: 1, waitingReview: 2, blocked: 1 })
    // to do steps are not shown in the summary: the field does not exist.
    expect(Object.keys(mls.counts)).not.toContain('todo')
  })

  it('a blocker that names a fact the step now holds stops counting as blocked', () => {
    const m = mkMission({
      milestones: [ms('mls-1')],
      steps: [
        mkStep('stp-1', {
          milestone: 'mls-1',
          blockers: [
            { id: 'blk-1', reason: 'waits for the PR', owner: 'agent', clearsWhen: 'pr-merged' }
          ]
        })
      ]
    })
    expect(deriveProgress(m, { 'stp-1': { pr: 'open' } }).milestones[0].counts.blocked).toBe(1)
    expect(deriveProgress(m, { 'stp-1': { pr: 'merged' } }).milestones[0].counts.blocked).toBe(0)
  })

  it('optional steps stay out of the milestone counts', () => {
    const m = mkMission({
      milestones: [ms('mls-1')],
      steps: [
        mkStep('stp-1', { milestone: 'mls-1' }),
        mkStep('stp-2', { milestone: 'mls-1', optional: true })
      ]
    })
    const p = deriveProgress(m, { 'stp-1': { pr: 'open' }, 'stp-2': { pr: 'open' } })
    expect(p.milestones[0].counts.waitingReview).toBe(1)
  })

  it('counts the four states across the counted steps of a mission with no milestones', () => {
    const m = mkMission({
      steps: [
        mkStep('stp-1', { done: true }),
        mkStep('stp-2'),
        mkStep('stp-3'),
        mkStep('stp-4'),
        mkStep('stp-5', { optional: true })
      ]
    })
    const p = deriveProgress(m, {
      'stp-2': { workerWorking: true },
      'stp-3': { pr: 'open' }
    })
    expect(p.counts).toEqual({ todo: 1, running: 1, waitingReview: 1, done: 1, blocked: 0 })
  })
})
