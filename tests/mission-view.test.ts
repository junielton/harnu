/**
 * Mission v3 S3 (spec §3.1/§3.2, AC-2) — the renderer's mission view model
 * (`lib/mission-view.ts`) renders the SERVER's `progress` and never recounts:
 * the headline ("Step N of M" / "Steps a–b of M" / "Step M of M ✓" / nothing),
 * the seven step visuals, the left-behind marks, the current marker, the tone
 * (no draft, no separate `flagged` chip variant) and the once-only child rows.
 * Every fixture is an S1 progress fixture turned into a `mission:list` view.
 */
import { describe, it, expect } from 'vitest'
import { OPERATOR_VERIFIER } from '../src/main/mission-core'
import { progressHeadline } from '../src/main/mission-progress'
import {
  buildMissionModel,
  formatDuration,
  missionForSession,
  missionState,
  OPERATOR_VERIFIER_ID,
  pillTone,
  type MissionState
} from '../src/renderer/src/lib/mission-view'
import { FIXTURE_NAMES, FIXTURE_NOW, fixtureView } from './helpers/mission-v3-view'

const NOW = FIXTURE_NOW

describe('buildMissionModel — the server progress, per fixture (AC-2)', () => {
  it.each(FIXTURE_NAMES.map((n) => [n] as const))('%s', (name) => {
    const view = fixtureView(name)
    const p = view.progress
    const m = buildMissionModel(view, NOW)
    expect(m.headline).toEqual(progressHeadline(p))
    expect({ total: m.total, done: m.done, verified: m.verified }).toEqual({
      total: p.total,
      done: p.done,
      verified: p.verified
    })
    expect(m.leftBehind).toBe(p.leftBehind.length)
    // The rail is the counted steps — a legacy fixed start is scope, not a step.
    expect(m.steps.map((s) => s.step.id)).toEqual(Object.keys(p.states))
    for (const s of m.steps) {
      const expected = p.leftBehind.includes(s.step.id) ? 'left-behind' : p.states[s.step.id]
      expect(s.visual, s.step.id).toBe(expected)
      const inCurrent =
        p.current !== null && s.position >= p.current.from && s.position <= p.current.to
      expect(s.current, s.step.id).toBe(inCurrent)
    }
  })

  it('faq-like: "Step 8 of 9", the marker on step 8, stp-3 left behind', () => {
    const m = buildMissionModel(fixtureView('faq-like'), NOW)
    expect(m.headline).toEqual({ kind: 'single', n: 8, to: 8, m: 9 })
    expect(m.steps.filter((s) => s.current).map((s) => s.position)).toEqual([8])
    expect(m.steps.find((s) => s.step.id === 'stp-3')?.visual).toBe('left-behind')
    expect({ done: m.done, verified: m.verified, leftBehind: m.leftBehind }).toEqual({
      done: 6,
      verified: 6,
      leftBehind: 1
    })
  })

  it('parallel: "Steps 4–7 of 9", four running steps carry the marker', () => {
    const m = buildMissionModel(fixtureView('parallel'), NOW)
    expect(m.headline).toEqual({ kind: 'range', n: 4, to: 7, m: 9 })
    expect(m.steps.filter((s) => s.current).map((s) => s.position)).toEqual([4, 5, 6, 7])
    expect(m.steps.filter((s) => s.visual === 'running')).toHaveLength(4)
  })

  it('delivered: "Step 5 of 5 ✓" with no current marker', () => {
    const m = buildMissionModel(fixtureView('delivered'), NOW)
    expect(m.headline).toEqual({ kind: 'done', n: 5, to: 5, m: 5 })
    expect(m.steps.some((s) => s.current)).toBe(false)
  })

  it('a mission with nothing to count has an empty headline', () => {
    const view = fixtureView('delivered', { mission: { steps: [] } })
    expect(buildMissionModel(view, NOW).headline.kind).toBe('empty')
  })

  it('never recounts: stored proofs that disagree with progress change nothing', () => {
    const view = fixtureView('faq-like')
    const before = buildMissionModel(view, NOW)
    // Wipe every stored proof: a renderer that recounted would now read 0 done.
    for (const s of view.mission.steps) s.proof = 'unproven'
    const after = buildMissionModel(view, NOW)
    expect(after.headline).toEqual(before.headline)
    expect(after.done).toBe(6)
    expect(after.steps.map((s) => s.visual)).toEqual(before.steps.map((s) => s.visual))
  })

  it('every one of the seven visuals is reachable from the fixtures', () => {
    const seen = new Set(
      FIXTURE_NAMES.flatMap((n) =>
        buildMissionModel(fixtureView(n), NOW).steps.map((s) => s.visual)
      )
    )
    expect([...seen].sort()).toEqual(
      ['blocked', 'done', 'left-behind', 'running', 'todo', 'verified', 'waiting'].sort()
    )
  })
})

describe('missionState and tone — no draft, needs-you from the you list', () => {
  const active = fixtureView('faq-like')

  it('active, rescope-pending, needs-you, blocked, stale, delivered, total-changed', () => {
    expect(missionState(active)).toBe('active')
    const end = { kind: 'code' as const, target: 't2', evidence: 'e2' }
    expect(
      missionState(
        fixtureView('faq-like', {
          mission: { pendingRescope: end },
          view: { you: [{ kind: 'rescope', end }] }
        })
      )
    ).toBe('rescope-pending')
    const dueChecks = fixtureView('faq-like', {
      view: { you: [{ kind: 'checks', count: 2, stepIds: ['stp-4'] }] }
    })
    expect(missionState(dueChecks)).toBe('needs-you')
    expect(missionState(fixtureView('blocked-like'))).toBe('blocked')
    const stale = fixtureView('faq-like')
    stale.derived.stale = true
    expect(missionState(stale)).toBe('stale')
    const delivered = fixtureView('delivered', {
      mission: { status: 'delivered' },
      view: { you: [{ kind: 'close' }] }
    })
    expect(missionState(delivered)).toBe('delivered')
    const added = fixtureView('faq-like')
    added.mission.steps[3].addedReason = 'scope grew'
    expect(missionState(added)).toBe('total-changed')
  })

  it('a dead legacy draft (read active, stale, owing nothing) is just stale', () => {
    const dead = fixtureView('nothing', { mission: { status: 'draft' } })
    dead.derived.stale = true
    expect(missionState(dead)).toBe('stale')
    expect(buildMissionModel(dead, NOW).needsYou).toBe(false)
  })

  it('maps states to the five tones', () => {
    const expected: Record<MissionState, string> = {
      active: 'accent',
      'total-changed': 'accent',
      blocked: 'warning',
      'needs-you': 'warning',
      stale: 'warning',
      'rescope-pending': 'warning',
      delivered: 'success'
    }
    for (const [state, tone] of Object.entries(expected)) {
      expect(pillTone(state as MissionState), state).toBe(tone)
    }
  })

  it('needsYou and the you look follow the you list; there is no flagged variant', () => {
    const m = buildMissionModel(active, NOW)
    expect(m.needsYou).toBe(false)
    expect(m.youLook).toBe('clear')
    expect('flagged' in m).toBe(false)
    const close = buildMissionModel(
      fixtureView('delivered', {
        mission: { status: 'delivered' },
        view: { you: [{ kind: 'close' }], closeWarnings: [] }
      }),
      NOW
    )
    expect(close).toMatchObject({ needsYou: true, youLook: 'success', tone: 'success' })
    const warned = buildMissionModel(
      fixtureView('delivered', {
        mission: { status: 'delivered' },
        view: {
          you: [{ kind: 'close' }],
          closeWarnings: [{ kind: 'checks-open', detail: '1 unticked check(s)' }]
        }
      }),
      NOW
    )
    expect(warned.youLook).toBe('warning')
  })
})

describe('step rows — blockers, checks, ticks, children', () => {
  const CHILD = '00000000-0000-4000-8000-000000000105'

  it('a child session row appears once: on its running step, else its last linked step', () => {
    const view = fixtureView('parallel')
    // 105 runs on stp-7; link it also to stp-3 and stp-9.
    for (const id of ['stp-3', 'stp-9']) {
      view.derived.steps
        .find((s) => s.stepId === id)!
        .children.push({ sessionId: CHILD, known: true, taskState: 'idle', pendingApprovals: 0 })
    }
    const steps = buildMissionModel(view, NOW).steps
    const rows = steps.filter((s) => s.children.some((c) => c.sessionId === CHILD))
    expect(rows.map((s) => s.step.id)).toEqual(['stp-7'])
    expect(steps.find((s) => s.step.id === 'stp-3')?.elsewhere).toBe(1)
    expect(steps.find((s) => s.step.id === 'stp-9')?.elsewhere).toBe(1)
    expect(steps.find((s) => s.step.id === 'stp-7')?.elsewhere).toBe(0)

    // Not running anywhere: the row moves to its LAST linked step.
    for (const d of view.derived.steps)
      for (const c of d.children) if (c.sessionId === CHILD) c.taskState = 'idle'
    const idle = buildMissionModel(view, NOW).steps
    expect(
      idle.filter((s) => s.children.some((c) => c.sessionId === CHILD)).map((s) => s.step.id)
    ).toEqual(['stp-9'])
  })

  it('carries a step’s checks and flags the due ones on a reached step only', () => {
    const view = fixtureView('faq-like')
    const check = (id: string, ticked = false) => ({
      id,
      label: `check ${id}`,
      source: 'operator' as const,
      createdAt: '2026-10-01T10:00:00.000Z',
      ...(ticked ? { ticked: { at: '2026-10-01T11:00:00.000Z' } } : {})
    })
    view.mission.steps.find((s) => s.id === 'stp-4')!.checks = [
      check('chk-1'),
      check('chk-2', true)
    ]
    view.mission.steps.find((s) => s.id === 'stp-10')!.checks = [check('chk-1')]
    const steps = buildMissionModel(view, NOW).steps
    const reached = steps.find((s) => s.step.id === 'stp-4')!
    expect(reached.checks.map((c) => c.id)).toEqual(['chk-1', 'chk-2'])
    expect(reached.checksDue).toBe(true)
    // stp-10 is todo: its unticked check is not due yet.
    expect(steps.find((s) => s.step.id === 'stp-10')!.checksDue).toBe(false)
  })

  it('mission-level blockers render under the first current step', () => {
    const blocker = {
      reason: 'npm ci fails',
      unblocks: 'lockfile regenerated',
      owner: 'agent' as const,
      raisedAt: '2026-10-01T10:00:00.000Z'
    }
    const steps = buildMissionModel(
      fixtureView('parallel', { mission: { blockers: [blocker] } }),
      NOW
    ).steps
    expect(steps.find((s) => s.position === 4)?.blockers).toEqual([blocker])
    expect(steps.find((s) => s.position === 5)?.blockers).toEqual([])
  })

  it('the end step is found by kind, and a human step can be ticked', () => {
    const view = fixtureView('faq-like')
    view.mission.steps.find((s) => s.id === 'stp-9')!.verification = 'human'
    const steps = buildMissionModel(view, NOW).steps
    expect(steps.filter((s) => s.isEnd).map((s) => s.step.id)).toEqual(['stp-10'])
    expect(steps.filter((s) => s.canTick).map((s) => s.step.id)).toEqual(['stp-9'])
  })
})

describe('missionForSession', () => {
  it('picks the newest mission the session owns, and nothing for a stranger', () => {
    const older = fixtureView('faq-like', { mission: { id: 'mnt-00000001' } })
    const newer = fixtureView('faq-like', { mission: { id: 'mnt-00000002' } })
    const owner = older.mission.owner.sessionId
    expect(missionForSession([newer, older], owner)?.mission.id).toBe('mnt-00000002')
    expect(missionForSession([newer], 'someone-else')).toBeNull()
    expect(missionForSession([newer], null)).toBeNull()
  })
})

describe('formatDuration', () => {
  it('formats minutes, hours and days', () => {
    expect(formatDuration(45 * 60_000)).toBe('45m')
    expect(formatDuration(135 * 60_000)).toBe('2h 15m')
    expect(formatDuration((3 * 24 + 4) * 3_600_000)).toBe('3d 4h')
  })
})

describe('OPERATOR_VERIFIER_ID', () => {
  it('mirrors the main-process OPERATOR_VERIFIER', () => {
    expect(OPERATOR_VERIFIER_ID).toBe(OPERATOR_VERIFIER)
  })
})
