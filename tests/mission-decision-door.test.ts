/**
 * Campaign spec §3.2 / §4 — the operator's Choose door as a pure function (`applyChooseDecision`).
 * Missions v4 S-40: the verbs that declared side steps, edges and decision nodes, the `mission:choose` channel
 * and the waiting list that listed an undecided decision are gone; the file goes with the v3 core in S-41.
 */
import { describe, it, expect } from 'vitest'
import { applyChooseDecision, type Mission } from '../src/main/mission-core'

const OWNER = '11111111-2222-4333-8444-555555555555'
const AT = '2026-10-30T15:00:00.000Z'

function mission(over: Partial<Mission> = {}): Mission {
  const step = (
    id: string,
    n: number,
    extra: Record<string, unknown> = {}
  ): Mission['steps'][0] => ({
    id,
    ordinal: n,
    kind: 'custom',
    title: `Step ${n}`,
    verification: 'verifier',
    proof: 'unproven',
    links: [],
    blockers: [],
    ...extra
  })
  return {
    id: 'mnt-00000594',
    slug: 'side-quests',
    folder: '/repo',
    owner: { sessionId: OWNER, folder: '/repo' },
    status: 'active',
    declaredEnd: { kind: 'code', target: 'PR merging the slice', evidence: 'green gates' },
    steps: [
      step('stp-1', 1),
      step('stp-2', 2, {
        verification: 'human',
        decision: { title: 'Which store?', options: ['SQLite', 'Files'], blocks: ['stp-3'] }
      }),
      step('stp-3', 3),
      { ...step('stp-4', 4, { title: 'Delivered and verified' }), kind: 'fixed-end' }
    ],
    blockers: [],
    openQuestions: [],
    createdAt: '2026-10-30T10:00:00.000Z',
    updatedAt: '2026-10-30T10:00:00.000Z',
    provenance: { author: 'agent', at: '2026-10-30T10:00:00.000Z' },
    ...over
  }
}

describe('applyChooseDecision — the operator door (AC-2c)', () => {
  it('writes chosen and bumps updatedAt, leaving the input untouched', () => {
    const m = mission()
    const next = applyChooseDecision(m, 'stp-2', 1, { at: AT })
    expect(next.steps[1].decision?.chosen).toBe(1)
    expect(next.updatedAt).toBe(AT)
    expect(m.steps[1].decision?.chosen).toBeUndefined()
  })

  it('refuses an unknown step, a step with no decision, a bad index, a second choice, a closed mission', () => {
    const m = mission()
    expect(() => applyChooseDecision(m, 'stp-99', 0, { at: AT })).toThrow(/^STEP_NOT_FOUND/)
    expect(() => applyChooseDecision(m, 'stp-1', 0, { at: AT })).toThrow(/^NOT_A_DECISION/)
    expect(() => applyChooseDecision(m, 'stp-2', 2, { at: AT })).toThrow(/^BAD_ARGS/)
    expect(() => applyChooseDecision(m, 'stp-2', -1, { at: AT })).toThrow(/^BAD_ARGS/)
    const chosen = applyChooseDecision(m, 'stp-2', 0, { at: AT })
    expect(() => applyChooseDecision(chosen, 'stp-2', 1, { at: AT })).toThrow(/^ALREADY_CHOSEN/)
    expect(() =>
      applyChooseDecision(mission({ status: 'closed' }), 'stp-2', 0, { at: AT })
    ).toThrow(/^MISSION_CLOSED/)
  })
})
