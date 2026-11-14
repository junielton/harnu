/**
 * The renderer's You-lane rows after the Merge batch door was removed (T701):
 *  - open green PRs are NOT an owed item any more (no merge row, whatever the PR count);
 *  - `steward-paused`: the server's item, whose age is part of its sentence.
 */
import { describe, it, expect } from 'vitest'
import {
  buildMissionModel,
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

const t = (key: string, v: Record<string, unknown> = {}): string =>
  `${key}${Object.keys(v).length ? ' ' + JSON.stringify(v) : ''}`

describe('open green PRs are not an owed item (T701)', () => {
  it('a mission whose steps have open PRs with green CI has no merge row in the You lane or the model', () => {
    const view = fixtureView('faq-like', {
      derivedStep: {
        'stp-5': { prNumber: 305, gates: GATES_READY },
        'stp-6': { prNumber: 306, gates: GATES_READY },
        'stp-7': { prNumber: 308, gates: GATES_READY }
      }
    })
    const without = fixtureView('faq-like')
    expect(youRows(view, FIXTURE_NOW).map((r) => r.kind)).toEqual(
      youRows(without, FIXTURE_NOW).map((r) => r.kind)
    )
    expect(buildMissionModel(view, FIXTURE_NOW).youRows.map((r) => r.kind)).toEqual(
      buildMissionModel(without, FIXTURE_NOW).youRows.map((r) => r.kind)
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
