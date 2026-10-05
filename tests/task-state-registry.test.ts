import { describe, it, expect, beforeEach } from 'vitest'
import { TaskStateRegistry } from '../src/main/detect/task-state-registry'
import type { HookEvent } from '../src/main/hook-state'

/** A hook event with only the fields the reducer reads. */
const ev = (hookEventName: string, sessionId: string, matcher?: string): HookEvent => ({
  hookEventName,
  sessionId,
  ...(matcher ? { matcher } : {})
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
