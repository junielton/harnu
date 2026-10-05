import { describe, it, expect } from 'vitest'
import {
  decideNotification,
  parseNotifyPrefs,
  NOTIFY_STATES,
  DEFAULT_NOTIFY_PREFS,
  type NotifyPrefs,
  type NotifyDecisionCtx
} from '../src/renderer/src/stores/session-notify'
import type { TaskState } from '../src/preload'

/**
 * Pure decision logic for OS notifications (os-notifications spec §4). The store
 * routes every task-state transition through `decideNotification`; this is the
 * single place that decides whether a native notification fires and of what kind.
 * No electron, no i18n, no localStorage — just the truth table.
 */

const allOn: NotifyPrefs = {
  enabled: true,
  needsInput: true,
  completed: true,
  failed: true,
  sound: true,
  usageReset: true
}

function ctx(over: Partial<NotifyDecisionCtx> = {}): NotifyDecisionCtx {
  return { prefs: allOn, isSelected: false, windowFocused: false, ...over }
}

/** Most edge tests only care about the kind; channel/sound get dedicated specs. */
const kindOf = (d: ReturnType<typeof decideNotification>): string | null => d?.kind ?? null

describe('NOTIFY_STATES', () => {
  it('is exactly the three meaningful end-states (never working/idle/stopped)', () => {
    expect([...NOTIFY_STATES].sort()).toEqual(['completed', 'failed', 'needs-input'])
  })
})

describe('decideNotification — notify-states', () => {
  it('fires on the edge into needs-input', () => {
    expect(kindOf(decideNotification('working', 'needs-input', ctx()))).toBe('needs-input')
  })

  it('fires on the edge into completed', () => {
    expect(kindOf(decideNotification('working', 'completed', ctx()))).toBe('completed')
  })

  it('fires on the edge into failed', () => {
    expect(kindOf(decideNotification('working', 'failed', ctx()))).toBe('failed')
  })

  it.each<TaskState>(['working', 'stopped'])('never fires when the target is %s', (next) => {
    expect(decideNotification('needs-input', next, ctx())).toBeNull()
  })
})

describe('decideNotification — turn-end completion (task-complete spec §4)', () => {
  it('fires a completed notification on the genuine turn-end edge (working → idle)', () => {
    // The `Stop` hook reduces to `idle`, but a working → idle edge means Claude
    // finished its turn — worth a toast even though the FSM dot stays idle.
    expect(kindOf(decideNotification('working', 'idle', ctx()))).toBe('completed')
  })

  it('does NOT fire on → idle when prev was not working (no false completion)', () => {
    // SessionStart → idle, or a settled idle staying idle: never a completion.
    expect(decideNotification('idle', 'idle', ctx())).toBeNull()
    expect(decideNotification('needs-input', 'idle', ctx())).toBeNull()
    expect(decideNotification('completed', 'idle', ctx())).toBeNull()
    expect(decideNotification('stopped', 'idle', ctx())).toBeNull()
  })

  it('respects the completed pref for a turn-end edge', () => {
    const prefs: NotifyPrefs = { ...allOn, completed: false }
    expect(decideNotification('working', 'idle', ctx({ prefs }))).toBeNull()
  })

  it('still toasts (silently) the turn-end for the session you are staring at', () => {
    // Focus-aware routing: focused + selected is no longer SUPPRESSED — you get a
    // toast so you know the turn ended — but the chime is muted.
    expect(
      decideNotification('working', 'idle', ctx({ isSelected: true, windowFocused: true }))
    ).toEqual({ kind: 'completed', channel: 'toast', sound: false })
  })
})

describe('decideNotification — edge-only', () => {
  it('does not re-fire when staying in needs-input (prev === next)', () => {
    expect(decideNotification('needs-input', 'needs-input', ctx())).toBeNull()
  })

  it('re-fires on a real re-block: needs-input → working → needs-input is two edges', () => {
    // leaving needs-input for working: not a notify-state → null
    expect(decideNotification('needs-input', 'working', ctx())).toBeNull()
    // coming back: edge into needs-input → fires again
    expect(kindOf(decideNotification('working', 'needs-input', ctx()))).toBe('needs-input')
  })
})

describe('decideNotification — prefs', () => {
  it('master off suppresses everything', () => {
    const prefs: NotifyPrefs = { ...allOn, enabled: false }
    expect(decideNotification('working', 'needs-input', ctx({ prefs }))).toBeNull()
  })

  it('per-state off suppresses only that state', () => {
    const prefs: NotifyPrefs = { ...allOn, completed: false }
    expect(decideNotification('working', 'completed', ctx({ prefs }))).toBeNull()
    expect(kindOf(decideNotification('working', 'failed', ctx({ prefs })))).toBe('failed')
    expect(kindOf(decideNotification('working', 'needs-input', ctx({ prefs })))).toBe('needs-input')
  })
})

describe('decideNotification — focus-aware routing (os-notifications spec §4)', () => {
  it('focused → in-app toast (with chime, background session)', () => {
    expect(decideNotification('working', 'needs-input', ctx({ windowFocused: true }))).toEqual({
      kind: 'needs-input',
      channel: 'toast',
      sound: true
    })
  })

  it('not focused → native OS notification', () => {
    expect(decideNotification('working', 'needs-input', ctx({ windowFocused: false }))).toEqual({
      kind: 'needs-input',
      channel: 'os',
      sound: true
    })
  })

  it('focused + selected: still toasts, but mutes the chime (no beep on what you stare at)', () => {
    expect(
      decideNotification('working', 'failed', ctx({ isSelected: true, windowFocused: true }))
    ).toEqual({ kind: 'failed', channel: 'toast', sound: false })
  })

  it('focused + a DIFFERENT session: toast WITH chime (a background session needs you)', () => {
    expect(
      decideNotification('working', 'needs-input', ctx({ isSelected: false, windowFocused: true }))
    ).toEqual({ kind: 'needs-input', channel: 'toast', sound: true })
  })

  it('selected but window NOT focused: OS notification, chime on', () => {
    expect(
      decideNotification('working', 'failed', ctx({ isSelected: true, windowFocused: false }))
    ).toEqual({ kind: 'failed', channel: 'os', sound: true })
  })

  it('sound pref off mutes the chime regardless of focus/selection', () => {
    const prefs: NotifyPrefs = { ...allOn, sound: false }
    expect(
      decideNotification('working', 'needs-input', ctx({ prefs, windowFocused: true }))
    ).toEqual({ kind: 'needs-input', channel: 'toast', sound: false })
  })
})

describe('parseNotifyPrefs', () => {
  it('null (no stored value) → defaults', () => {
    expect(parseNotifyPrefs(null)).toEqual(DEFAULT_NOTIFY_PREFS)
  })

  it('defaults are opt-out: everything on, except usageReset (opt-in)', () => {
    expect(DEFAULT_NOTIFY_PREFS).toEqual({
      enabled: true,
      needsInput: true,
      completed: true,
      failed: true,
      sound: true,
      usageReset: false,
      dailyBudget: true
    })
  })

  it('defaults sound on', () => {
    expect(DEFAULT_NOTIFY_PREFS.sound).toBe(true)
  })

  it('defaults sound to true when the field is absent (backward compat)', () => {
    expect(parseNotifyPrefs(JSON.stringify({ enabled: true })).sound).toBe(true)
  })

  it('usageReset defaults to false (opt-in, unlike the other flags)', () => {
    expect(DEFAULT_NOTIFY_PREFS.usageReset).toBe(false)
  })

  it('honors an explicit usageReset:true', () => {
    expect(parseNotifyPrefs(JSON.stringify({ usageReset: true })).usageReset).toBe(true)
  })

  it('dailyBudget defaults to true (the alert is the point of the feature)', () => {
    expect(DEFAULT_NOTIFY_PREFS.dailyBudget).toBe(true)
    expect(parseNotifyPrefs(JSON.stringify({ enabled: true })).dailyBudget).toBe(true)
  })

  it('honors an explicit dailyBudget:false', () => {
    expect(parseNotifyPrefs(JSON.stringify({ dailyBudget: false })).dailyBudget).toBe(false)
  })

  it('honors an explicit sound:false', () => {
    expect(parseNotifyPrefs(JSON.stringify({ sound: false })).sound).toBe(false)
  })

  it('round-trips a full object', () => {
    const stored = JSON.stringify({
      enabled: false,
      needsInput: false,
      completed: true,
      failed: true,
      sound: false,
      usageReset: true,
      dailyBudget: false
    })
    expect(parseNotifyPrefs(stored)).toEqual({
      enabled: false,
      needsInput: false,
      completed: true,
      failed: true,
      sound: false,
      usageReset: true,
      dailyBudget: false
    })
  })

  it('fills missing keys from defaults (forward-compatible partial)', () => {
    expect(parseNotifyPrefs(JSON.stringify({ enabled: false }))).toEqual({
      enabled: false,
      needsInput: true,
      completed: true,
      failed: true,
      sound: true,
      usageReset: false,
      dailyBudget: true
    })
  })

  it('corrupt JSON → defaults', () => {
    expect(parseNotifyPrefs('{not json')).toEqual(DEFAULT_NOTIFY_PREFS)
  })

  it('non-object JSON → defaults', () => {
    expect(parseNotifyPrefs('42')).toEqual(DEFAULT_NOTIFY_PREFS)
    expect(parseNotifyPrefs('null')).toEqual(DEFAULT_NOTIFY_PREFS)
  })

  it('coerces non-boolean values to booleans', () => {
    expect(parseNotifyPrefs(JSON.stringify({ enabled: 1, needsInput: 0 }))).toEqual({
      enabled: true,
      needsInput: false,
      completed: true,
      failed: true,
      sound: true,
      usageReset: false,
      dailyBudget: true
    })
  })
})
