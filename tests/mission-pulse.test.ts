/**
 * T547 — the step "pulse": a live sign of movement inside a long step, from
 * facts Harnu already has (commits on the linked worktree, the child's
 * transitions and transcript writes, hook activity of its own subagents).
 * Pure functions; `now` is injected.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  HELPER_ACTIVE_WINDOW_MS,
  buildStepPulse,
  withHelperActivity
} from '../src/main/mission-pulse'
import {
  noteSubagentActivity,
  lastSubagentActivity,
  resetSubagentActivityForTests
} from '../src/main/subagent-activity'
import type { MissionChildState } from '../src/main/mcp/fleet-snapshot'
import type { MissionLinkSignal } from '../src/main/mcp/tool-handlers'

const NOW = Date.parse('2026-10-20T12:00:00.000Z')
const ago = (ms: number): string => new Date(NOW - ms).toISOString()
const MIN = 60_000

function child(over: Partial<MissionChildState> = {}): MissionChildState {
  return { sessionId: 's1', known: true, pendingApprovals: 0, taskState: 'idle', ...over }
}

function worktree(over: Partial<Extract<MissionLinkSignal, { kind: 'worktree' }>> = {}) {
  return {
    kind: 'worktree' as const,
    ref: '/wt',
    exists: true,
    branch: 'card/x',
    head: { sha: 'abc', subject: 's', at: ago(3 * MIN) },
    prs: [],
    commits: 21,
    ...over
  }
}

describe('withHelperActivity (AC-2)', () => {
  it('reads an idle child as working while its own subagents are active', () => {
    const out = withHelperActivity(child(), NOW - 30_000, NOW)
    expect(out.taskState).toBe('working')
    expect(out.waitingOnHelpers).toBe(true)
    expect(out.helperActivityAt).toBe(new Date(NOW - 30_000).toISOString())
  })

  it('leaves an idle child idle once the helpers went quiet', () => {
    const out = withHelperActivity(child(), NOW - HELPER_ACTIVE_WINDOW_MS - 1, NOW)
    expect(out.taskState).toBe('idle')
    expect(out.waitingOnHelpers).toBeUndefined()
  })

  it('leaves an idle child idle when no helper ever ran', () => {
    expect(withHelperActivity(child(), undefined, NOW).taskState).toBe('idle')
  })

  it('never overrides a child that needs input or failed', () => {
    expect(withHelperActivity(child({ taskState: 'needs-input' }), NOW, NOW).taskState).toBe(
      'needs-input'
    )
    expect(withHelperActivity(child({ taskState: 'failed' }), NOW, NOW).taskState).toBe('failed')
  })

  it('never overrides a child with a parked approval, a parked session or an unknown id', () => {
    expect(withHelperActivity(child({ pendingApprovals: 1 }), NOW, NOW).taskState).toBe('idle')
    expect(withHelperActivity(child({ hibernated: true }), NOW, NOW).taskState).toBe('idle')
    const unknown = withHelperActivity(child({ known: false, taskState: undefined }), NOW, NOW)
    expect(unknown.taskState).toBeUndefined()
    expect(unknown.waitingOnHelpers).toBeUndefined()
  })

  it('does not touch a child that is already working', () => {
    const out = withHelperActivity(child({ taskState: 'working' }), NOW, NOW)
    expect(out.waitingOnHelpers).toBeUndefined()
  })
})

describe('buildStepPulse (AC-1, AC-4)', () => {
  it('reports the commit count and the newest activity across commits and the child', () => {
    const pulse = buildStepPulse(
      [worktree()],
      [child({ lastTransitionAt: ago(10 * MIN), modified: ago(1 * MIN) })]
    )
    expect(pulse.commits).toBe(21)
    expect(pulse.lastCommitAt).toBe(ago(3 * MIN))
    expect(pulse.lastActivityAt).toBe(ago(1 * MIN))
  })

  it('counts the helper activity as activity', () => {
    const pulse = buildStepPulse([], [child({ helperActivityAt: ago(20_000) })])
    expect(pulse.lastActivityAt).toBe(ago(20_000))
  })

  it('sums commits over several worktrees and ignores ones git could not count', () => {
    const pulse = buildStepPulse(
      [
        worktree({ commits: 4 }),
        worktree({ ref: '/b', commits: undefined }),
        worktree({ ref: '/c', commits: 2 })
      ],
      []
    )
    expect(pulse.commits).toBe(6)
  })

  it('has no commit count when no linked worktree could be counted', () => {
    expect(buildStepPulse([worktree({ commits: undefined })], []).commits).toBeNull()
    expect(buildStepPulse([], []).commits).toBeNull()
  })

  it('has no activity at all for a step nothing touched (stays stalled)', () => {
    const pulse = buildStepPulse([], [child()])
    expect(pulse).toEqual({ commits: null, lastCommitAt: null, lastActivityAt: null })
  })

  it('ignores unparsable timestamps', () => {
    const pulse = buildStepPulse(
      [worktree({ head: { sha: 'a', subject: 's', at: 'not a date' } })],
      [child({ modified: 'nope' })]
    )
    expect(pulse.lastCommitAt).toBeNull()
    expect(pulse.lastActivityAt).toBeNull()
  })
})

describe('subagent activity registry', () => {
  beforeEach(() => resetSubagentActivityForTests())

  it('remembers the newest subagent hook per session', () => {
    noteSubagentActivity('s1', 100)
    noteSubagentActivity('s1', 300)
    noteSubagentActivity('s1', 200)
    expect(lastSubagentActivity('s1')).toBe(300)
    expect(lastSubagentActivity('other')).toBeUndefined()
  })
})
