/**
 * The renderer's You-lane rows after the merge-in-order door was removed (T701):
 *  - open green PRs are NOT an owed item any more (no merge row, whatever the PR count).
 * (The `steward-paused` row went with the steward, S-38/S-40.)
 */
import { describe, it, expect } from 'vitest'
import { buildMissionModel, youRows } from '../src/renderer/src/lib/mission-view'
import { fixtureView, FIXTURE_NOW } from './helpers/mission-v3-view'

const GATES_READY = {
  pr: 'running',
  ci: 'green',
  main: 'off',
  verifier: 'off',
  checks: 'na'
} as const

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
