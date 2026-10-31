/**
 * Campaign spec §3.2 / §5, AC-2 / AC-2b / AC-UI — the renderer's view model draws
 * the SERVER's side bucket, locked steps and decision nodes (`buildMissionModel`):
 * the main rail never lists a side step, the Side bucket lists it with its origin
 * as a rail letter, a locked step reads `locked`, and a decision node carries its
 * options and whether the operator may still choose.
 */
import { describe, expect, it } from 'vitest'
import type { MissionStep } from '../src/main/mission-core'
import { buildMissionModel } from '../src/renderer/src/lib/mission-view'
import { FIXTURE_NOW, fixtureView } from './helpers/mission-v3-view'

function step(n: number, extra: Partial<MissionStep> = {}): MissionStep {
  return {
    id: `stp-${n}`,
    ordinal: n,
    kind: 'custom',
    title: `Step ${n}`,
    verification: 'verifier',
    proof: 'unproven',
    links: [],
    blockers: [],
    ...extra
  }
}
const done = (n: number, extra: Partial<MissionStep> = {}): MissionStep =>
  step(n, {
    proof: 'verified',
    verifiedBy: { sessionId: 'other', at: '2026-10-01T10:00:00Z', verdict: 'met' },
    ...extra
  })
const end = (n: number): MissionStep =>
  step(n, { kind: 'fixed-end', title: 'Delivered and verified' })

const model = (steps: MissionStep[]) =>
  buildMissionModel(fixtureView('faq-like', { mission: { steps } }), FIXTURE_NOW)

describe('the Side bucket', () => {
  const steps = [
    done(1),
    step(2),
    step(5, { required: false, discoveredFrom: 'stp-2', title: 'Fix main after #316' }),
    done(6, { required: false, discoveredFrom: 'stp-1', title: 'Lighter images' }),
    end(3)
  ]

  it('keeps side steps out of the main rail and the counts', () => {
    const m = model(steps)
    expect(m.steps.map((s) => s.step.id)).toEqual(['stp-1', 'stp-2', 'stp-3'])
    expect(m.total).toBe(3)
    expect(m.headline).toEqual({ kind: 'single', n: 2, to: 2, m: 3 })
  })

  it('lists them in the bucket with their state, open/done counts and origin letter', () => {
    const { side } = model(steps)
    expect(side.count).toBe(2)
    expect({ open: side.open, done: side.done }).toEqual({ open: 1, done: 1 })
    expect(side.steps.map((s) => [s.step.id, s.state, s.origin])).toEqual([
      ['stp-5', 'todo', 'B'],
      ['stp-6', 'verified', 'A']
    ])
  })

  it('an origin that is a side step reads its title; no origin reads null', () => {
    const { side } = model([
      step(1),
      step(2, { required: false, title: 'Loose end' }),
      step(3, { required: false, discoveredFrom: 'stp-2' }),
      end(4)
    ])
    expect(side.steps.map((s) => s.origin)).toEqual([null, 'Loose end'])
  })

  it('a mission with no side step has an empty bucket', () => {
    const { side } = model([step(1), end(2)])
    expect(side).toEqual({ count: 0, open: 0, done: 0, steps: [] })
  })
})

describe('rail letters', () => {
  it('main steps are lettered A, B, C by position; the end step has none', () => {
    const m = model([step(1), step(2), step(3), end(4)])
    expect(m.steps.map((s) => s.letter)).toEqual(['A', 'B', 'C', null])
  })
})

describe('locked steps', () => {
  it('a step behind an open blocks edge draws the locked visual and never the marker', () => {
    const m = model([
      done(1),
      step(2),
      step(3, { edges: [{ kind: 'blocks', to: 'stp-2' }] }),
      end(4)
    ])
    const locked = m.steps.find((s) => s.step.id === 'stp-2')!
    expect(locked.visual).toBe('locked')
    expect(locked.current).toBe(false)
    expect(m.steps.find((s) => s.step.id === 'stp-3')!.current).toBe(true)
  })
})

describe('decision nodes', () => {
  const decision = (chosen?: number): MissionStep[] => [
    step(1, {
      verification: 'human',
      decision: {
        title: 'SQLite vs files',
        options: ['SQLite', 'Files'],
        blocks: ['stp-2', 'stp-3'],
        ...(chosen !== undefined ? { chosen } : {})
      }
    }),
    step(2),
    step(3),
    end(4)
  ]

  it('an undecided node carries its options, what it blocks and may be chosen', () => {
    const d = model(decision()).steps[0].decision!
    expect(d).toEqual({
      title: 'SQLite vs files',
      options: ['SQLite', 'Files'],
      chosen: null,
      blocks: ['B', 'C'],
      canChoose: true
    })
    expect(
      model(decision())
        .steps.slice(1, 3)
        .map((s) => s.visual)
    ).toEqual(['locked', 'locked'])
  })

  it('a decided node shows the choice, cannot be chosen again, and unlocks its steps', () => {
    const m = model(decision(1))
    expect(m.steps[0].decision).toMatchObject({ chosen: 1, canChoose: false })
    expect(m.steps[1].visual).not.toBe('locked')
  })

  it('a decision node offers Choose, not "Mark verified": the choice is its work', () => {
    expect(model(decision()).steps[0].canTick).toBe(false)
    expect(model([step(1, { verification: 'human' }), end(2)]).steps[0].canTick).toBe(true)
  })

  it('a step with no decision has none', () => {
    expect(model([step(1), end(2)]).steps[0].decision).toBeNull()
  })
})
