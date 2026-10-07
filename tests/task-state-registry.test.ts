import { describe, it, expect, beforeEach } from 'vitest'
import { TaskStateRegistry } from '../src/main/detect/task-state-registry'
import type { HookEvent } from '../src/main/hook-state'

/** A hook event with only the fields the reducer reads. */
const ev = (
  hookEventName: string,
  sessionId: string,
  matcher?: string,
  agentId?: string
): HookEvent => ({
  hookEventName,
  sessionId,
  ...(matcher ? { matcher } : {}),
  ...(agentId ? { agentId } : {})
})

describe('TaskStateRegistry (T13 — hook FSM + liveness axis)', () => {
  let reg: TaskStateRegistry
  beforeEach(() => {
    reg = new TaskStateRegistry()
  })

  it('fold composes over reduceTaskState', () => {
    expect(reg.fold('s', ev('UserPromptSubmit', 's'))).toBe('working')
    expect(reg.get('s')).toBe('working')
    expect(reg.fold('s', ev('Stop', 's'))).toBe('idle')
    expect(reg.get('s')).toBe('idle')
  })

  it('folds a PermissionRequest to needs-input and does NOT time-decay it', () => {
    reg.fold('s', ev('PreToolUse', 's'))
    expect(reg.fold('s', ev('Notification', 's', 'permission_prompt'))).toBe('needs-input')
    // An informational event leaves needs-input intact (no decay axis).
    expect(reg.fold('s', ev('PreCompact', 's'))).toBe('needs-input')
  })

  describe('an open question wins over a running background subagent', () => {
    // The order Claude Code emitted in a live capture: a background agent was launched, then the
    // main thread opened an AskUserQuestion dialog while the agent kept calling tools.
    const openQuestion = (): void => {
      reg.fold('s', ev('UserPromptSubmit', 's'))
      reg.fold('s', ev('PreToolUse', 's')) // main: the Agent tool
      reg.fold('s', ev('PreToolUse', 's')) // main: AskUserQuestion
      reg.fold('s', ev('PermissionRequest', 's'))
    }

    it("stays needs-input while the subagent's own tool events keep arriving", () => {
      openQuestion()
      expect(reg.get('s')).toBe('needs-input')
      expect(reg.fold('s', ev('PreToolUse', 's', undefined, 'a1'))).toBe('needs-input')
      expect(reg.fold('s', ev('Notification', 's', 'permission_prompt'))).toBe('needs-input')
      expect(reg.fold('s', ev('PostToolUse', 's', undefined, 'a1'))).toBe('needs-input')
      expect(reg.fold('s', ev('PreToolUse', 's', undefined, 'a1'))).toBe('needs-input')
    })

    it('leaves needs-input once the main thread answers (its own PostToolUse)', () => {
      openQuestion()
      reg.fold('s', ev('PostToolUse', 's', undefined, 'a1'))
      expect(reg.fold('s', ev('PostToolUse', 's'))).toBe('working')
    })

    it('a block the subagent raised itself is cleared by that subagent, as before', () => {
      reg.fold('s', ev('UserPromptSubmit', 's'))
      expect(reg.fold('s', ev('PermissionRequest', 's', undefined, 'a1'))).toBe('needs-input')
      expect(reg.fold('s', ev('Notification', 's', 'permission_prompt'))).toBe('needs-input')
      expect(reg.fold('s', ev('PostToolUse', 's', undefined, 'a1'))).toBe('working')
    })

    it('a main-thread block raised after a subagent block takes ownership', () => {
      reg.fold('s', ev('PermissionRequest', 's', undefined, 'a1'))
      reg.fold('s', ev('PermissionRequest', 's')) // the main thread now asks too
      expect(reg.fold('s', ev('PostToolUse', 's', undefined, 'a1'))).toBe('needs-input')
    })

    it('keeps the plain "turn ended, agents still running" case working', () => {
      reg.fold('s', ev('UserPromptSubmit', 's'))
      reg.fold('s', ev('Stop', 's'))
      expect(reg.fold('s', ev('PreToolUse', 's', undefined, 'a1'))).toBe('working')
    })

    it('prune forgets who raised the block', () => {
      reg.fold('s', ev('PermissionRequest', 's', undefined, 'a1'))
      reg.prune('s')
      reg.fold('s', ev('PermissionRequest', 's'))
      expect(reg.fold('s', ev('PostToolUse', 's', undefined, 'a1'))).toBe('needs-input')
    })
  })

  it('prune deletes a session state', () => {
    reg.fold('s', ev('PreToolUse', 's'))
    expect(reg.get('s')).toBe('working')
    reg.prune('s')
    expect(reg.get('s')).toBeUndefined()
  })

  it('liveSnapshot drops a working entry whose session is not live, keeps the live one', () => {
    reg.fold('dead', ev('PreToolUse', 'dead')) // working, but process gone
    reg.fold('alive', ev('PreToolUse', 'alive')) // working, still running
    const live = new Set(['alive'])
    expect(reg.liveSnapshot((id) => live.has(id))).toEqual({ alive: 'working' })
  })

  it('liveSnapshot of an all-dead map is empty (phantom fully suppressed)', () => {
    reg.fold('a', ev('PreToolUse', 'a'))
    reg.fold('b', ev('Notification', 'b', 'permission_prompt'))
    expect(reg.liveSnapshot(() => false)).toEqual({})
  })
})
