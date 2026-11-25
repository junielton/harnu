/**
 * T547 — the renderer's step pulse model: a live sign of movement inside the CURRENT
 * step, and a PR line with its CI state. The headline ("Step N of M") must not change because
 * of it. (The line that printed it, in the rail and the pill tooltip, is gone, S-37.)
 */
import { describe, it, expect } from 'vitest'
import {
  buildMissionModel,
  PULSE_QUIET_AFTER_MS,
  type StepModel
} from '../src/renderer/src/lib/mission-view'
import { FIXTURE_NOW, fixtureView } from './helpers/mission-v3-view'
import type { MissionView } from '../src/main/mission-ipc'
import type { MissionStepSignals } from '../src/main/mcp/tool-handlers'

const MIN = 60_000
const ago = (ms: number): string => new Date(FIXTURE_NOW - ms).toISOString()

/** The id of faq-like's current step (position 8). */
function currentId(): string {
  const v = fixtureView('faq-like')
  const counted = v.mission.steps.filter((s) => v.progress.states[s.id] !== undefined)
  return counted[v.progress.current!.from - 1].id
}

function withStep(patch: Partial<MissionStepSignals>): MissionView {
  return fixtureView('faq-like', { derivedStep: { [currentId()]: patch } })
}

const current = (v: MissionView): StepModel =>
  buildMissionModel(v, FIXTURE_NOW).steps.find((s) => s.current)!

const worktree = (commits: number | undefined, at: string, prs: unknown[] = []) =>
  ({
    kind: 'worktree',
    ref: '/wt',
    exists: true,
    branch: 'card/x',
    head: { sha: 'a', subject: 's', at },
    ...(commits !== undefined ? { commits } : {}),
    prs
  }) as MissionStepSignals['links'][number]

const pr = (number: number, state: string, ci: string, isDraft = false) => ({
  number,
  title: `PR ${number}`,
  state,
  isDraft,
  ci,
  url: `https://example.test/pull/${number}`,
  baseRefName: 'main'
})

describe('step pulse (AC-1)', () => {
  it('shows commits and a fresh activity time on the current step; the headline is untouched', () => {
    const quiet = buildMissionModel(fixtureView('faq-like'), FIXTURE_NOW)
    const v = withStep({
      links: [worktree(21, ago(3 * MIN))],
      pulse: { commits: 21, lastCommitAt: ago(3 * MIN), lastActivityAt: ago(2 * MIN) }
    })
    const step = current(v)
    expect(step.pulse).toEqual({ kind: 'moving', commits: 21, ageMs: 2 * MIN })
    expect(buildMissionModel(v, FIXTURE_NOW).headline).toEqual(quiet.headline)
  })

  it('only the current steps carry a pulse', () => {
    const v = withStep({
      links: [worktree(21, ago(MIN))],
      pulse: { commits: 21, lastCommitAt: ago(MIN), lastActivityAt: ago(MIN) }
    })
    const steps = buildMissionModel(v, FIXTURE_NOW).steps
    expect(steps.filter((s) => s.pulse !== null).map((s) => s.current)).toEqual([true])
  })

  it('a step that links neither a session nor a worktree claims nothing', () => {
    expect(current(withStep({ links: [], children: [] })).pulse).toBeNull()
  })

  it('a child that is working keeps the step moving whatever the timestamps say', () => {
    const v = withStep({
      children: [{ sessionId: 's1', known: true, taskState: 'working', pendingApprovals: 0 }],
      pulse: { commits: 3, lastCommitAt: ago(90 * MIN), lastActivityAt: ago(90 * MIN) }
    })
    expect(current(v).pulse?.kind).toBe('moving')
  })
})

describe('a stalled step still reads stalled (AC-4)', () => {
  const idleChild = [{ sessionId: 's1', known: true, taskState: 'idle', pendingApprovals: 0 }]

  it('is quiet once the newest activity is older than the quiet window', () => {
    const v = withStep({
      children: idleChild as never,
      pulse: {
        commits: 0,
        lastCommitAt: null,
        lastActivityAt: ago(PULSE_QUIET_AFTER_MS + MIN)
      }
    })
    expect(current(v).pulse).toEqual({
      kind: 'quiet',
      commits: 0,
      ageMs: PULSE_QUIET_AFTER_MS + MIN
    })
  })

  it('is quiet with no age when nothing was ever seen', () => {
    const v = withStep({
      children: idleChild as never,
      pulse: { commits: null, lastCommitAt: null, lastActivityAt: null }
    })
    expect(current(v).pulse).toEqual({ kind: 'quiet', commits: null, ageMs: null })
  })

  it('is still moving right at the window edge', () => {
    const v = withStep({
      children: idleChild as never,
      pulse: { commits: 1, lastCommitAt: null, lastActivityAt: ago(PULSE_QUIET_AFTER_MS) }
    })
    expect(current(v).pulse?.kind).toBe('moving')
  })
})

describe('PR line (AC-3)', () => {
  it('lists open and merged PRs of the step with their CI state, newest first', () => {
    const v = withStep({
      links: [
        worktree(5, ago(MIN), [pr(7, 'OPEN', 'pending'), pr(5, 'MERGED', 'passing')]),
        {
          kind: 'pr',
          ref: '#9',
          number: 9,
          exists: true,
          state: 'OPEN',
          url: 'https://example.test/pull/9'
        } as never
      ]
    })
    expect(current(v).prs).toEqual([
      { number: 9, state: 'OPEN', draft: false, ci: 'unknown', url: 'https://example.test/pull/9' },
      { number: 7, state: 'OPEN', draft: false, ci: 'pending', url: 'https://example.test/pull/7' },
      {
        number: 5,
        state: 'MERGED',
        draft: false,
        ci: 'passing',
        url: 'https://example.test/pull/5'
      }
    ])
  })

  it('dedupes a PR reached through two links and hides closed ones', () => {
    const p = pr(7, 'OPEN', 'failing', true)
    const v = withStep({
      links: [
        worktree(1, ago(MIN), [p, pr(3, 'CLOSED', 'failing')]),
        { kind: 'card', ref: 'T1', exists: true, status: 'review', prs: [p] }
      ]
    })
    expect(current(v).prs).toEqual([
      { number: 7, state: 'OPEN', draft: true, ci: 'failing', url: 'https://example.test/pull/7' }
    ])
  })

  it('an unknown CI value reads as unknown, and a step with no PR has none', () => {
    const v = withStep({ links: [worktree(1, ago(MIN), [pr(7, 'OPEN', 'none')])] })
    expect(current(v).prs[0].ci).toBe('unknown')
    expect(current(withStep({ links: [] })).prs).toEqual([])
  })

  it('shows the PRs of a step that is not current too', () => {
    const v = fixtureView('faq-like')
    const done = v.mission.steps.find((s) => v.progress.states[s.id] === 'verified')!
    const withPr = fixtureView('faq-like', {
      derivedStep: { [done.id]: { links: [worktree(2, ago(MIN), [pr(4, 'MERGED', 'passing')])] } }
    })
    const model = buildMissionModel(withPr, FIXTURE_NOW).steps.find((s) => s.step.id === done.id)!
    expect(model.current).toBe(false)
    expect(model.prs.map((p) => p.number)).toEqual([4])
  })
})
