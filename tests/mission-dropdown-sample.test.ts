// @vitest-environment jsdom
/**
 * Mission dropdown · S-5 · AC-15 (the sample) — the sample mission shows an open step fully: the states that open
 * a step carry criteria (verified ones and open ones, with who settles them) and links (a pull request, a
 * worktree, evidence, an address), as the mockup's `step-open` and `blocked` states draw them. The sample is
 * built from nothing and names no real session, folder or client (AC-27).
 */
import { describe, expect, it } from 'vitest'
import { sampleOf } from '../src/renderer/src/lib/mission-sample'
import type { MissionV4ViewReply } from '../src/main/mission-ipc'

type Mission = Extract<MissionV4ViewReply, { state: 'mission' }>

const stepOf = (state: 'step-open' | 'step-blocked'): Record<string, unknown> => {
  const s = sampleOf(state)
  const step = (s.reply as Mission).detail.steps.find(
    (x) => (x as { id: string }).id === s.ui.openStep
  )
  expect(step, `${state} opens a step that exists`).toBeDefined()
  return step as unknown as Record<string, unknown>
}

describe('the sample shows an open step fully', () => {
  it('step-open: verified and open criteria, and every kind of link', () => {
    const step = stepOf('step-open') as {
      criteria: Array<{ settled: boolean; by: string }>
      links: Array<{ kind: string; ref: string }>
      open: string[]
    }
    expect(step.criteria.filter((c) => c.settled).length).toBeGreaterThanOrEqual(2)
    expect(step.criteria.filter((c) => !c.settled).length).toBeGreaterThanOrEqual(2)
    expect(new Set(step.criteria.map((c) => c.by)).size).toBeGreaterThanOrEqual(2)
    expect(step.open).toHaveLength(step.criteria.filter((c) => !c.settled).length)
    expect(step.links.map((l) => l.kind)).toEqual(
      expect.arrayContaining(['pr', 'worktree', 'doc', 'url'])
    )
  })

  it('step-blocked: the blocker, an open criterion and links', () => {
    const step = stepOf('step-blocked') as {
      blockers: unknown[]
      criteria: Array<{ settled: boolean }>
      links: Array<{ kind: string }>
    }
    expect(step.blockers.length).toBeGreaterThan(0)
    expect(step.criteria.some((c) => !c.settled)).toBe(true)
    expect(step.links.length).toBeGreaterThanOrEqual(2)
  })

  it('the links are neutral: no absolute path of a real machine', () => {
    for (const state of ['step-open', 'step-blocked'] as const) {
      const links = (stepOf(state) as { links: Array<{ ref: string }> }).links
      for (const l of links) expect(l.ref).not.toMatch(/\/home\/|\/Users\/|Workspace/)
    }
  })
})
