/**
 * Campaign spec §3.2 / §8 AC-2 — side steps, typed edges and decision nodes in the
 * ONE progress computation (`computeProgress`). A `required: false` step lives in
 * the Side bucket and never moves the headline; a step that is the target of an
 * open `blocks` edge, or listed in an undecided decision's `blocks`, reads `locked`.
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Mission, MissionStep } from '../src/main/mission-core'
import {
  computeProgress,
  progressHeadline,
  type MissionProgress,
  type StepSignalsLite
} from '../src/main/mission-progress'

const NOW = Date.parse('2026-10-30T12:00:00Z')
const OWNER = '11111111-2222-4333-8444-555555555555'

function step(id: string, extra: Partial<MissionStep> = {}): MissionStep {
  const n = Number(id.slice(4))
  return {
    id,
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

const done = (id: string, extra: Partial<MissionStep> = {}): MissionStep =>
  step(id, {
    proof: 'verified',
    verifiedBy: { sessionId: 'other', at: '2026-10-30T10:00:00Z', verdict: 'met' },
    ...extra
  })

function mission(steps: MissionStep[]): Pick<Mission, 'steps' | 'owner'> {
  return { steps, owner: { sessionId: OWNER, folder: '/repo' } }
}

const progress = (steps: MissionStep[], signals: StepSignalsLite[] = []): MissionProgress =>
  computeProgress(mission(steps), signals, NOW)

describe('AC-2 — a required:false step is a side step', () => {
  const base = (): MissionStep[] => [done('stp-1'), step('stp-2'), step('stp-3')]
  const withSide = (): MissionStep[] => [
    done('stp-1'),
    step('stp-2'),
    step('stp-4', { required: false, discoveredFrom: 'stp-2' }),
    step('stp-3')
  ]

  it('never changes total, current, done, verified, leftBehind or the headline', () => {
    const a = progress(base())
    const b = progress(withSide())
    expect({ ...b, states: undefined, side: undefined }).toEqual({
      ...a,
      states: undefined,
      side: undefined
    })
    expect(progressHeadline(b)).toEqual(progressHeadline(a))
  })

  it('never appears in leftBehind, even when a later step is done and it is still todo', () => {
    const p = progress([step('stp-1', { required: false, discoveredFrom: 'stp-2' }), done('stp-2')])
    expect(p.leftBehind).toEqual([])
  })

  it('does not stop allDone: only the required steps count', () => {
    const p = progress([
      done('stp-1'),
      step('stp-2', { required: false, discoveredFrom: 'stp-1' }),
      done('stp-3')
    ])
    expect(p.allDone).toBe(true)
    expect(p.total).toBe(2)
  })

  it('is listed under progress.side with its state and its origin', () => {
    const p = progress(withSide())
    expect(p.side).toEqual({
      count: 1,
      steps: [{ id: 'stp-4', state: 'todo', discoveredFrom: 'stp-2' }]
    })
    expect(p.states['stp-4']).toBe('todo')
  })

  it('reads a null origin when the side step names none', () => {
    const p = progress([step('stp-1'), step('stp-2', { required: false })])
    expect(p.side?.steps).toEqual([{ id: 'stp-2', state: 'todo', discoveredFrom: null }])
  })

  it('a running side step does not move current', () => {
    const p = progress(withSide(), [
      {
        stepId: 'stp-4',
        existenceProven: false,
        children: [{ sessionId: 'c', taskState: 'working' }]
      }
    ])
    expect(p.states['stp-4']).toBe('running')
    expect(p.current).toEqual({ from: 2, to: 2 })
  })
})

describe('AC-2b — locked steps', () => {
  it('a step that is the target of a blocks edge from an unfinished step reads locked', () => {
    const p = progress([
      step('stp-1', { edges: [{ kind: 'blocks', to: 'stp-2' }] }),
      step('stp-2'),
      step('stp-3')
    ])
    expect(p.states).toMatchObject({ 'stp-1': 'todo', 'stp-2': 'locked' })
  })

  it('finishing the source unlocks it', () => {
    const p = progress([
      done('stp-1', { edges: [{ kind: 'blocks', to: 'stp-2' }] }),
      step('stp-2'),
      step('stp-3')
    ])
    expect(p.states['stp-2']).toBe('todo')
  })

  it('validates and related edges never lock', () => {
    const p = progress([
      step('stp-1', {
        edges: [
          { kind: 'validates', to: 'stp-2' },
          { kind: 'related', to: 'stp-3' }
        ]
      }),
      step('stp-2'),
      step('stp-3')
    ])
    expect(p.states).toMatchObject({ 'stp-2': 'todo', 'stp-3': 'todo' })
  })

  it('a locked step never advances current: the marker skips it', () => {
    const p = progress([
      done('stp-1'),
      step('stp-2'),
      step('stp-3'),
      step('stp-4', { edges: [{ kind: 'blocks', to: 'stp-3' }] })
    ])
    // stp-2 is the first open step; with it done, stp-3 is locked by stp-4 (open)
    expect(p.current).toEqual({ from: 2, to: 2 })
    const q = progress([
      done('stp-1'),
      done('stp-2'),
      step('stp-3'),
      step('stp-4', { edges: [{ kind: 'blocks', to: 'stp-3' }] })
    ])
    expect(q.states['stp-3']).toBe('locked')
    expect(q.current).toEqual({ from: 4, to: 4 })
  })

  it('a locked step is not left behind and does not count as done', () => {
    const p = progress([
      step('stp-1', { edges: [{ kind: 'blocks', to: 'stp-2' }] }),
      step('stp-2'),
      done('stp-3')
    ])
    expect(p.leftBehind).toEqual(['stp-1'])
    expect(p.done).toBe(1)
    expect(p.allDone).toBe(false)
  })

  it('a step that already has a done state is never locked after the fact', () => {
    const p = progress([step('stp-1', { edges: [{ kind: 'blocks', to: 'stp-2' }] }), done('stp-2')])
    expect(p.states['stp-2']).toBe('verified')
  })

  it('a side step can lock a required step', () => {
    const p = progress([
      step('stp-1'),
      step('stp-2', {
        required: false,
        discoveredFrom: 'stp-1',
        edges: [{ kind: 'blocks', to: 'stp-1' }]
      })
    ])
    expect(p.states['stp-1']).toBe('locked')
  })
})

describe('AC-2b — decision nodes', () => {
  const decision = (chosen?: number): MissionStep =>
    step('stp-1', {
      verification: 'human',
      decision: {
        title: 'Which store?',
        options: ['SQLite', 'Files'],
        blocks: ['stp-2'],
        ...(chosen !== undefined ? { chosen } : {})
      }
    })

  it('the blocked steps read locked until chosen is set', () => {
    expect(progress([decision(), step('stp-2'), step('stp-3')]).states['stp-2']).toBe('locked')
    expect(progress([decision(0), step('stp-2'), step('stp-3')]).states['stp-2']).toBe('todo')
  })

  it('a decided decision node reads done: the choice is its work', () => {
    expect(progress([decision(1), step('stp-2'), step('stp-3')]).states['stp-1']).toBe('done')
    expect(progress([decision(), step('stp-2'), step('stp-3')]).states['stp-1']).toBe('todo')
  })
})

describe('AC-P — no new field, no change', () => {
  const dir = path.join(__dirname, 'fixtures/mission-v3')
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'))

  it.each(files)('%s keeps exactly the v3 progress shape', (f) => {
    const fx = JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as {
      mission: Mission
      signals: StepSignalsLite[]
    }
    const p = computeProgress(fx.mission, fx.signals, NOW)
    expect(Object.keys(p).sort()).toEqual(
      [
        'allDone',
        'computedAt',
        'current',
        'done',
        'leftBehind',
        'states',
        'total',
        'unprovable',
        'verified'
      ].sort()
    )
    expect(Object.values(p.states).every((s) => s !== 'locked')).toBe(true)
  })
})
