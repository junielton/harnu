/**
 * Campaign ch.5b (T609) — the renderer's You-lane rows for the two new operator doors:
 *  - `merge-batch`: derived when 2+ steps have an open PR with green CI, in step order;
 *  - `steward-paused`: the server's item, whose age is part of its sentence.
 */
import { describe, it, expect } from 'vitest'
import {
  buildMissionModel,
  mergeReadyPrs,
  missionState,
  pillTone,
  youRowAge,
  youRowText,
  youRows
} from '../src/renderer/src/lib/mission-view'
import { fixtureView, FIXTURE_NOW } from './helpers/mission-v3-view'

const GATES_READY = {
  pr: 'running',
  ci: 'green',
  main: 'off',
  verifier: 'off',
  checks: 'na'
} as const

/** The `faq-like` fixture with the named steps carrying an open PR. */
function withPrs(prs: Record<string, { n: number; gates?: Partial<typeof GATES_READY> }>) {
  return fixtureView('faq-like', {
    derivedStep: Object.fromEntries(
      Object.entries(prs).map(([id, p]) => [
        id,
        { prNumber: p.n, gates: { ...GATES_READY, ...(p.gates ?? {}) } }
      ])
    )
  })
}

const t = (key: string, v: Record<string, unknown> = {}): string =>
  `${key}${Object.keys(v).length ? ' ' + JSON.stringify(v) : ''}`

describe('mergeReadyPrs', () => {
  it('lists steps whose PR is open and whose CI is green, in step order', () => {
    const view = withPrs({ 'stp-6': { n: 306 }, 'stp-5': { n: 305 }, 'stp-7': { n: 308 } })
    expect(mergeReadyPrs(view).map((p) => p.number)).toEqual([305, 306, 308])
  })

  it('leaves out a red or running CI, a merged or closed PR, and a step with no PR', () => {
    const view = withPrs({
      'stp-4': { n: 304, gates: { ci: 'red' } },
      'stp-5': { n: 305 },
      'stp-6': { n: 306, gates: { ci: 'running' } },
      'stp-7': { n: 308, gates: { pr: 'green' } }, // merged
      'stp-2': { n: 302, gates: { pr: 'red' } } // closed unmerged
    })
    expect(mergeReadyPrs(view).map((p) => p.number)).toEqual([305])
  })

  it('carries the step title for the dialog', () => {
    const view = withPrs({ 'stp-5': { n: 305 }, 'stp-6': { n: 306 } })
    expect(mergeReadyPrs(view)[0]).toMatchObject({ number: 305, stepId: 'stp-5' })
    expect(mergeReadyPrs(view)[0].title).toBeTruthy()
  })
})

describe('the merge-batch You row', () => {
  it('appears for two or more ready PRs, after the blocking items, mid risk, no age', () => {
    const view = withPrs({ 'stp-5': { n: 305 }, 'stp-6': { n: 306 }, 'stp-7': { n: 308 } })
    const rows = youRows(view, FIXTURE_NOW)
    const row = rows.find((r) => r.kind === 'merge-batch')
    expect(row).toBeDefined()
    expect(row).toMatchObject({ risk: 'mid', ageMs: null, stepId: null })
    expect(row?.prs?.map((p) => p.number)).toEqual([305, 306, 308])
    expect(buildMissionModel(view, FIXTURE_NOW).youRows.some((r) => r.kind === 'merge-batch')).toBe(
      true
    )
  })

  it('does not appear for a single ready PR, or none', () => {
    expect(youRows(withPrs({ 'stp-5': { n: 305 } }), FIXTURE_NOW).map((r) => r.kind)).not.toContain(
      'merge-batch'
    )
    expect(youRows(fixtureView('faq-like'), FIXTURE_NOW).map((r) => r.kind)).not.toContain(
      'merge-batch'
    )
  })

  it('reads in the operator’s words, with the chain of PR numbers', () => {
    const view = withPrs({ 'stp-5': { n: 305 }, 'stp-6': { n: 306 }, 'stp-7': { n: 308 } })
    const row = youRows(view, FIXTURE_NOW).find((r) => r.kind === 'merge-batch')!
    expect(youRowText(t as never, view, row, (s) => s)).toBe(
      'mission.you.mergeBatch {"n":3,"chain":"#305 → #306 → #308"}'
    )
  })
})

describe('the steward-paused You row', () => {
  const pausedAt = new Date(FIXTURE_NOW - 2 * 3_600_000).toISOString()
  const paused = (): ReturnType<typeof fixtureView> =>
    fixtureView('faq-like', {
      mission: { stewardPause: { at: pausedAt, reason: 'CI is flaky today' } },
      view: { you: [{ kind: 'steward-paused', reason: 'CI is flaky today', at: pausedAt }] }
    })

  it('is the first row, with the age inside its sentence (and none in its own slot)', () => {
    const view = paused()
    const row = youRows(view, FIXTURE_NOW)[0]
    expect(row.kind).toBe('steward-paused')
    expect(row.ageMs).toBe(2 * 3_600_000)
    expect(youRowAge(row)).toBeNull()
    expect(youRowText(t as never, view, row, (s) => s)).toBe(
      'mission.you.stewardPaused {"age":"2h 0m","reason":"CI is flaky today"}'
    )
  })

  it('turns the mission needs-you, so the pill goes warning', () => {
    const view = paused()
    expect(missionState(view)).toBe('needs-you')
    expect(pillTone(missionState(view))).toBe('warning')
    expect(buildMissionModel(view, FIXTURE_NOW).tone).toBe('warning')
  })
})
