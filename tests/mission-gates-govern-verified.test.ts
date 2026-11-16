/**
 * Campaign ch.3a (T595, spec Amendments (a), operator decision 2026-10-31) — gates now
 * GOVERN `verified`: a step whose stored proof is `verified` reads `done` — not `verified` —
 * while any applicable gate is `red` or `running`. Applicable = not `off`, not `na`. The
 * `checks` gate applies only when the step has checks. A step with no PR (pr gate `off`) is
 * unchanged. The `verified` count in `derived.progress` follows. (AC-3a.5)
 *
 * Missions v4 S-40: this file keeps the pure `computeProgress` rule. The second layer (`mission_get` end to
 * end, the v3 handler that fed the gates into progress) went with the v3 handler; the file goes with the v3
 * core in S-41.
 */
import { describe, it, expect } from 'vitest'
import type { Mission, MissionStep } from '../src/main/mission-core'
import type { GateName, GateState, StepGates } from '../src/main/mission-gates'
import { computeProgress, type StepSignalsLite } from '../src/main/mission-progress'

const NOW = Date.parse('2026-10-31T12:00:00.000Z')
const OWNER = '11111111-2222-4333-8444-555555555555'
const VERIFIER = 'cccccccc-dddd-4eee-8fff-000000000000'

function step(id: string, over: Partial<MissionStep> = {}): MissionStep {
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
    ...over
  }
}

const verified = (id: string, over: Partial<MissionStep> = {}): MissionStep =>
  step(id, {
    proof: 'verified',
    verifiedBy: { sessionId: VERIFIER, at: '2026-10-30T09:00:00.000Z', verdict: 'met' },
    ...over
  })

const GREEN: StepGates = {
  pr: 'green',
  ci: 'green',
  main: 'green',
  verifier: 'green',
  checks: 'na'
}
const gates = (over: Partial<Record<GateName, GateState>> = {}): StepGates => ({
  ...GREEN,
  ...over
})

function signal(stepId: string, g?: StepGates): StepSignalsLite {
  return { stepId, children: [], existenceProven: false, ...(g ? { gates: g } : {}) }
}

const mission = (steps: MissionStep[]): Pick<Mission, 'steps' | 'owner'> => ({
  steps,
  owner: { sessionId: OWNER, folder: '/x' }
})

describe('AC-3a.5 — the rule, pure', () => {
  it('a verified step with every applicable gate green still reads verified', () => {
    const p = computeProgress(mission([verified('stp-1')]), [signal('stp-1', GREEN)], NOW)
    expect(p.states['stp-1']).toBe('verified')
    expect(p.verified).toBe(1)
  })

  it.each<[GateName, GateState]>([
    ['pr', 'running'], // PR still open
    ['pr', 'red'], // PR closed unmerged
    ['ci', 'running'],
    ['ci', 'red'],
    ['main', 'running'],
    ['main', 'red'],
    ['verifier', 'running'],
    ['verifier', 'red']
  ])('a verified step reads done while its %s gate is %s', (gate, state) => {
    const p = computeProgress(
      mission([verified('stp-1')]),
      [signal('stp-1', gates({ [gate]: state }))],
      NOW
    )
    expect(p.states['stp-1']).toBe('done')
  })

  it.each<[GateName, GateState]>([
    ['pr', 'off'],
    ['ci', 'off'],
    ['main', 'off'],
    ['main', 'na'],
    ['verifier', 'na'],
    ['verifier', 'off'],
    ['checks', 'na']
  ])('a %s gate that is %s is not applicable and does not hold verified back', (gate, state) => {
    const p = computeProgress(
      mission([verified('stp-1')]),
      [signal('stp-1', gates({ [gate]: state }))],
      NOW
    )
    expect(p.states['stp-1']).toBe('verified')
  })

  it('a step with no PR (every PR-derived gate off) is unchanged: verified', () => {
    const noPr = gates({ pr: 'off', ci: 'off', main: 'off', checks: 'na' })
    const p = computeProgress(mission([verified('stp-1')]), [signal('stp-1', noPr)], NOW)
    expect(p.states['stp-1']).toBe('verified')
  })

  it('the checks gate applies only when the step HAS checks', () => {
    const open = gates({ checks: 'running' })
    const withoutChecks = computeProgress(
      mission([verified('stp-1')]),
      [signal('stp-1', open)],
      NOW
    )
    expect(withoutChecks.states['stp-1']).toBe('verified')

    const checks = [
      {
        id: 'chk-1',
        label: 'Validated visually',
        source: 'agent' as const,
        createdAt: '2026-10-30T00:00:00.000Z'
      }
    ]
    const withChecks = computeProgress(
      mission([verified('stp-1', { checks })]),
      [signal('stp-1', open)],
      NOW
    )
    expect(withChecks.states['stp-1']).toBe('done')

    const ticked = computeProgress(
      mission([
        verified('stp-1', {
          checks: [{ ...checks[0], ticked: { at: '2026-10-30T01:00:00.000Z' } }]
        })
      ]),
      [signal('stp-1', gates({ checks: 'green' }))],
      NOW
    )
    expect(ticked.states['stp-1']).toBe('verified')
  })

  it('a step with no gates in its signals (none derived yet) is unchanged', () => {
    const p = computeProgress(mission([verified('stp-1')]), [signal('stp-1')], NOW)
    expect(p.states['stp-1']).toBe('verified')
  })

  it('gates never UPGRADE: an unproven step with all-green gates is not verified', () => {
    const p = computeProgress(mission([step('stp-1')]), [signal('stp-1', GREEN)], NOW)
    expect(p.states['stp-1']).toBe('todo')
  })

  it('the verified count and done count follow: gated steps count as done, not verified', () => {
    const p = computeProgress(
      mission([verified('stp-1'), verified('stp-2'), verified('stp-3')]),
      [
        signal('stp-1', GREEN),
        signal('stp-2', gates({ ci: 'running' })),
        signal('stp-3', gates({ main: 'red' }))
      ],
      NOW
    )
    expect(p.states).toEqual({ 'stp-1': 'verified', 'stp-2': 'done', 'stp-3': 'done' })
    expect(p.verified).toBe(1)
    expect(p.done).toBe(3)
    expect(p.allDone).toBe(true)
  })

  it('a side step is gated the same way, and stays out of the headline', () => {
    const side = verified('stp-2', { required: false })
    const p = computeProgress(
      mission([verified('stp-1'), side]),
      [signal('stp-1', GREEN), signal('stp-2', gates({ pr: 'running' }))],
      NOW
    )
    expect(p.states['stp-2']).toBe('done')
    expect(p.verified).toBe(1)
    expect(p.total).toBe(1)
  })
})
