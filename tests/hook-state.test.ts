import { describe, it, expect } from 'vitest'
import { reduceTaskState, type TaskState } from '../src/main/hook-state'

/**
 * Hook reducer FSM (session-state real-state spec §3.3/§6.1). Pure transition
 * table: (current task-state, hook event) → next task-state. The headline is
 * `Notification:permission_prompt` → `needs-input`, which must NOT decay like
 * the old 5s `scheduleIdle` timer — it only leaves on a real subsequent event.
 */
const ev = (
  hookEventName: string,
  matcher?: string
): { hookEventName: string; matcher?: string; sessionId: string } => ({
  hookEventName,
  matcher,
  sessionId: 'X'
})

const ALL: TaskState[] = ['working', 'needs-input', 'idle', 'completed', 'failed', 'stopped']

describe('reduceTaskState', () => {
  it('UserPromptSubmit → working', () => {
    expect(reduceTaskState('idle', ev('UserPromptSubmit'))).toBe('working')
  })

  it('PreToolUse / PostToolUse → working (activity refresh)', () => {
    expect(reduceTaskState('idle', ev('PreToolUse', '*'))).toBe('working')
    expect(reduceTaskState('needs-input', ev('PostToolUse'))).toBe('working')
  })

  it('Notification:permission_prompt → needs-input from ANY state (the headline)', () => {
    for (const s of ALL) {
      expect(reduceTaskState(s, ev('Notification', 'permission_prompt'))).toBe('needs-input')
    }
  })

  it('PermissionRequest → needs-input', () => {
    expect(reduceTaskState('working', ev('PermissionRequest'))).toBe('needs-input')
  })

  it('Notification:idle_prompt → idle (the 60s nudge is NOT a block — T92 divergence)', () => {
    expect(reduceTaskState('working', ev('Notification', 'idle_prompt'))).toBe('idle')
  })

  it('T92: Notification:worker_permission_prompt → needs-input (sub-agent needs approval)', () => {
    for (const s of ALL) {
      expect(reduceTaskState(s, ev('Notification', 'worker_permission_prompt'))).toBe('needs-input')
    }
  })

  it('T92: Notification:elicitation_dialog → needs-input (structured prompt awaiting you)', () => {
    for (const s of ALL) {
      expect(reduceTaskState(s, ev('Notification', 'elicitation_dialog'))).toBe('needs-input')
    }
  })

  it('Stop → idle (NOT completed) — proves the idle/completed split', () => {
    expect(reduceTaskState('working', ev('Stop'))).toBe('idle')
    expect(reduceTaskState('needs-input', ev('Stop'))).toBe('idle')
  })

  it('StopFailure → failed', () => {
    expect(reduceTaskState('working', ev('StopFailure'))).toBe('failed')
  })

  it('SessionStart → idle (the first UserPromptSubmit then moves it to working)', () => {
    expect(reduceTaskState('completed', ev('SessionStart', 'resume'))).toBe('idle')
  })

  it('SessionEnd → completed, but SessionEnd(reason=clear) → idle', () => {
    expect(reduceTaskState('idle', ev('SessionEnd'))).toBe('completed')
    expect(reduceTaskState('working', ev('SessionEnd', 'clear'))).toBe('idle')
  })

  it('SubagentStop / PreCompact / PostCompact are informational — no change', () => {
    expect(reduceTaskState('working', ev('SubagentStop'))).toBe('working')
    expect(reduceTaskState('needs-input', ev('PreCompact'))).toBe('needs-input')
    expect(reduceTaskState('working', ev('PostCompact'))).toBe('working')
  })

  it('needs-input survives an informational event (does not decay)', () => {
    expect(reduceTaskState('needs-input', ev('PreCompact'))).toBe('needs-input')
    expect(reduceTaskState('needs-input', ev('SubagentStop'))).toBe('needs-input')
  })

  it('unknown events leave the state unchanged', () => {
    expect(reduceTaskState('working', ev('SomethingBrandNew'))).toBe('working')
    expect(reduceTaskState('needs-input', ev('Notification', 'mystery_prompt'))).toBe('needs-input')
  })
})
