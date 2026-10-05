/**
 * Mission v3 §3.1 — the ONE progress computation, against the operator-reviewed
 * fixtures (spec §8 S-1, rev 2 column; plan Task 1.2). Each fixture under
 * `tests/fixtures/mission-v3/` is `{ name, mission, signals, expect }`, and a
 * leading `fixed-start` step is a legacy fixed start, excluded from progress.
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Mission } from '../src/main/mission-core'
import {
  computeProgress,
  progressHeadline,
  type MissionProgress,
  type StepSignalsLite
} from '../src/main/mission-progress'

interface Fixture {
  name: string
  mission: Mission
  signals: StepSignalsLite[]
  expect: Partial<MissionProgress>
}

const dir = path.join(__dirname, 'fixtures/mission-v3')
const fixtures: Fixture[] = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as Fixture)

const NOW = Date.parse('2026-10-01T12:00:00Z')

describe('computeProgress — operator-reviewed fixtures (spec §8 S-1)', () => {
  it('loads every fixture of the Task 1.2 table', () => {
    expect(fixtures.map((f) => f.name)).toEqual([
      'added-mid-flight',
      'blocked-future',
      'blocked-like',
      'delivered',
      'faq-like',
      'hero-like',
      'needs-human',
      'nothing',
      'owner-only-working',
      'parallel',
      'proven-start',
      'self-verified-all',
      'tools-listing-like'
    ])
  })

  it.each(fixtures.map((f) => [f.name, f] as const))('%s', (_n, f) => {
    const p = computeProgress(f.mission, f.signals, NOW)
    expect({
      current: p.current,
      allDone: p.allDone,
      total: p.total,
      done: p.done,
      verified: p.verified,
      states: p.states,
      leftBehind: p.leftBehind,
      unprovable: p.unprovable
    }).toMatchObject(f.expect)
    expect(p.computedAt).toBe(new Date(NOW).toISOString())
  })
})

describe('computeProgress — the legacy fixed start (AC-3)', () => {
  const byName = (n: string): Fixture => fixtures.find((f) => f.name === n)!

  it('never counts a legacy fixed start, proven or not', () => {
    for (const f of fixtures) {
      const p = computeProgress(f.mission, f.signals, NOW)
      expect(Object.keys(p.states)).not.toContain('stp-1')
      expect(p.total).toBe(f.mission.steps.length - 1)
    }
  })

  it('reads "Step M of M ✓" when every other step is done, even with the start unproven', () => {
    const f = byName('delivered')
    expect(f.mission.steps[0]).toMatchObject({ kind: 'fixed-start', proof: 'unproven' })
    expect(f.signals[0].existenceProven).toBe(false)
    const p = computeProgress(f.mission, f.signals, NOW)
    expect(progressHeadline(p)).toEqual({ kind: 'done', n: 5, to: 5, m: 5 })
  })

  it('an open step before the last done one keeps the headline off ✓ (Review Focus)', () => {
    const f = byName('tools-listing-like')
    const p = computeProgress(f.mission, f.signals, NOW)
    expect(progressHeadline(p)).toEqual({ kind: 'single', n: 5, to: 5, m: 5 })
    expect(p.leftBehind).toEqual(['stp-5'])
  })
})

describe('computeProgress — a mission with nothing to count (Delta 1)', () => {
  const owner = { sessionId: 'owner', folder: '/repo' }
  const legacyStart = {
    id: 'stp-1',
    ordinal: 1,
    kind: 'fixed-start' as const,
    title: 'Scope confirmed',
    verification: 'existence' as const,
    proof: 'unproven' as const,
    links: [],
    blockers: []
  }

  it.each([
    ['no steps at all', []],
    ['only a legacy fixed start', [legacyStart]]
  ])('%s: no current step, not allDone, an explicit empty headline', (_n, steps) => {
    const p = computeProgress({ owner, steps }, [], NOW)
    expect(p).toMatchObject({ total: 0, current: null, allDone: false, done: 0, verified: 0 })
    expect(p.leftBehind).toEqual([])
    expect(progressHeadline(p)).toEqual({ kind: 'empty', n: 0, to: 0, m: 0 })
  })
})

describe('progressHeadline', () => {
  it('is a range for parallel, done for allDone, single otherwise', () => {
    const base = {
      total: 9,
      done: 0,
      verified: 0,
      states: {},
      leftBehind: [],
      unprovable: [],
      computedAt: ''
    }
    expect(
      progressHeadline({ ...base, current: { from: 4, to: 7 }, allDone: false })
    ).toMatchObject({ kind: 'range', n: 4, to: 7, m: 9 })
    expect(progressHeadline({ ...base, current: null, allDone: true })).toMatchObject({
      kind: 'done',
      n: 9,
      m: 9
    })
    expect(
      progressHeadline({ ...base, current: { from: 8, to: 8 }, allDone: false })
    ).toMatchObject({ kind: 'single', n: 8, m: 9 })
  })
})
