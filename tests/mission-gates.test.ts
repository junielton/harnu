/**
 * Campaign ch.1 (T593, spec §3.2) — the derived `gates` of a step. Pure: the
 * facts (PR, CI, main CI) come in, five states go out; nothing is stored.
 */
import { describe, it, expect } from 'vitest'
import { ciOfRuns, computeStepGates, GATE_NAMES, type GateInput } from '../src/main/mission-gates'

const base: GateInput = {
  step: { verification: 'verifier', proof: 'unproven' },
  pr: null,
  mainCi: null
}

describe('computeStepGates', () => {
  it('always reports the five keys', () => {
    const g = computeStepGates(base)
    expect(Object.keys(g).sort()).toEqual([...GATE_NAMES].sort())
  })

  it('a step with no PR has nothing green or red yet', () => {
    expect(computeStepGates(base)).toEqual({
      pr: 'off',
      ci: 'off',
      main: 'off',
      verifier: 'off',
      checks: 'na'
    })
  })

  it('an open PR is running; its CI maps passing/failing/pending', () => {
    const open = (
      ci: 'passing' | 'failing' | 'pending' | 'unknown'
    ): ReturnType<typeof computeStepGates> =>
      computeStepGates({ ...base, pr: { number: 7, state: 'OPEN', ci } })
    expect(open('passing')).toMatchObject({ pr: 'running', ci: 'green', main: 'off' })
    expect(open('failing')).toMatchObject({ pr: 'running', ci: 'red' })
    expect(open('pending')).toMatchObject({ pr: 'running', ci: 'running' })
    expect(open('unknown')).toMatchObject({ pr: 'running', ci: 'off' })
  })

  it('a merged PR is green and main reads the merge commit CI', () => {
    const merged = (mainCi: GateInput['mainCi']): ReturnType<typeof computeStepGates> =>
      computeStepGates({ ...base, pr: { number: 7, state: 'MERGED', ci: 'passing' }, mainCi })
    expect(merged('passing')).toMatchObject({ pr: 'green', main: 'green' })
    expect(merged('failing')).toMatchObject({ pr: 'green', main: 'red' })
    expect(merged('pending')).toMatchObject({ pr: 'green', main: 'running' })
    expect(merged(null)).toMatchObject({ pr: 'green', main: 'off' })
  })

  it('a PR closed unmerged is red and main does not apply', () => {
    expect(
      computeStepGates({ ...base, pr: { number: 7, state: 'CLOSED', ci: 'passing' } })
    ).toMatchObject({ pr: 'red', main: 'na' })
  })

  it('verifier follows the step proof', () => {
    const v = (step: GateInput['step']): string => computeStepGates({ ...base, step }).verifier
    expect(v({ verification: 'verifier', proof: 'unproven' })).toBe('off')
    expect(v({ verification: 'verifier', proof: 'claimed' })).toBe('running')
    expect(v({ verification: 'verifier', proof: 'self-verified' })).toBe('running')
    expect(
      v({
        verification: 'verifier',
        proof: 'verified',
        verifiedBy: { sessionId: 's', at: 'x', verdict: 'met' }
      })
    ).toBe('green')
    expect(
      v({
        verification: 'verifier',
        proof: 'unproven',
        verifiedBy: { sessionId: 's', at: 'x', verdict: 'unmet' }
      })
    ).toBe('red')
    expect(
      v({
        verification: 'verifier',
        proof: 'verified',
        verifiedBy: { sessionId: 's', at: 'x', verdict: 'needs-human' }
      })
    ).toBe('green')
    expect(v({ verification: 'existence', proof: 'unproven' })).toBe('na')
  })

  it('BUG-235 AC-2: a verified needs-human verdict is green; the human part lives on the checks gate', () => {
    const step = (proof: GateInput['step']['proof']): GateInput['step'] => ({
      verification: 'verifier',
      proof,
      verifiedBy: { sessionId: 's', at: 'x', verdict: 'needs-human' },
      checks: [{ id: 'chk-1', label: 'DSQA', source: 'agent', createdAt: 'x' }]
    })
    expect(computeStepGates({ ...base, step: step('verified') })).toMatchObject({
      verifier: 'green',
      checks: 'running'
    })
    // not independently verified: still waiting on a verifier
    expect(computeStepGates({ ...base, step: step('self-verified') }).verifier).toBe('running')
    expect(computeStepGates({ ...base, step: step('claimed') }).verifier).toBe('running')
  })

  it('checks: na without any, running while one is unticked, green when all are ticked', () => {
    const c = (checks: NonNullable<GateInput['step']['checks']>): string =>
      computeStepGates({ ...base, step: { ...base.step, checks } }).checks
    const chk = (
      id: string,
      ticked: boolean
    ): NonNullable<GateInput['step']['checks']>[number] => ({
      id,
      label: id,
      source: 'agent',
      createdAt: 'x',
      ...(ticked ? { ticked: { at: 'x' } } : {})
    })
    expect(c([])).toBe('na')
    expect(c([chk('chk-1', true), chk('chk-2', false)])).toBe('running')
    expect(c([chk('chk-1', true), chk('chk-2', true)])).toBe('green')
  })

  it('marks the result stale when the facts are last-known, not live', () => {
    const g = computeStepGates({
      ...base,
      pr: { number: 7, state: 'MERGED', ci: 'passing' },
      mainCi: 'passing',
      stale: true
    })
    expect(g.stale).toBe(true)
    expect(computeStepGates(base).stale).toBeUndefined()
  })
})

describe('ciOfRuns — CI of a merge commit from its workflow runs', () => {
  it('no runs is unknown, not green', () => {
    expect(ciOfRuns([])).toBe('unknown')
  })

  it('any failing run wins, then any unfinished run, then all-success', () => {
    expect(
      ciOfRuns([
        { status: 'completed', conclusion: 'success' },
        { status: 'completed', conclusion: 'failure' }
      ])
    ).toBe('failing')
    expect(
      ciOfRuns([{ status: 'completed', conclusion: 'success' }, { status: 'in_progress' }])
    ).toBe('pending')
    expect(
      ciOfRuns([
        { status: 'completed', conclusion: 'success' },
        { status: 'completed', conclusion: 'skipped' }
      ])
    ).toBe('passing')
  })

  it('a cancelled or timed-out run is failing', () => {
    expect(ciOfRuns([{ status: 'completed', conclusion: 'cancelled' }])).toBe('failing')
    expect(ciOfRuns([{ status: 'completed', conclusion: 'timed_out' }])).toBe('failing')
  })
})
