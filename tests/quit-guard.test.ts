import { describe, it, expect } from 'vitest'
import {
  DEFAULT_QUIT_STRINGS,
  buildQuitDialogContent,
  decideQuitConfirm,
  defaultQuitGuardPrefs,
  normalizeQuitGuardPrefs,
  normalizeQuitStrings,
  resolveSessionNames,
  shortSessionId
} from '../src/main/quit-guard'

const states = (...entries: [string, string][]): Map<string, string> => new Map(entries)

describe('decideQuitConfirm', () => {
  it('asks when at least one session is working, and lists exactly those', () => {
    const d = decideQuitConfirm({
      taskStates: states(['a', 'working'], ['b', 'idle'], ['c', 'working']),
      confirmEnabled: true,
      reason: 'user'
    })
    expect(d).toEqual({ confirm: true, sessionIds: ['a', 'c'] })
  })

  it('never asks when nothing is working (idle / done / error / needs-input)', () => {
    const d = decideQuitConfirm({
      taskStates: states(['a', 'idle'], ['b', 'done'], ['c', 'error'], ['d', 'needs-input']),
      confirmEnabled: true,
      reason: 'user'
    })
    expect(d).toEqual({ confirm: false, sessionIds: [] })
  })

  it('never asks with no sessions at all', () => {
    expect(
      decideQuitConfirm({ taskStates: [], confirmEnabled: true, reason: 'user' }).confirm
    ).toBe(false)
  })

  it('does not ask when the preference is off', () => {
    const d = decideQuitConfirm({
      taskStates: states(['a', 'working']),
      confirmEnabled: false,
      reason: 'user'
    })
    expect(d.confirm).toBe(false)
  })

  it.each(['update-install', 'system-shutdown'] as const)(
    'never blocks a %s quit, even with working sessions',
    (reason) => {
      const d = decideQuitConfirm({
        taskStates: states(['a', 'working']),
        confirmEnabled: true,
        reason
      })
      expect(d).toEqual({ confirm: false, sessionIds: [] })
    }
  )
})

describe('quit-guard prefs', () => {
  it('defaults to asking', () => {
    expect(defaultQuitGuardPrefs()).toEqual({ version: 1, confirmOnQuit: true })
  })

  it('keeps a stored boolean and falls back to asking on junk', () => {
    expect(normalizeQuitGuardPrefs({ confirmOnQuit: false }).confirmOnQuit).toBe(false)
    expect(normalizeQuitGuardPrefs({ confirmOnQuit: 'no' }).confirmOnQuit).toBe(true)
    expect(normalizeQuitGuardPrefs(null).confirmOnQuit).toBe(true)
    expect(normalizeQuitGuardPrefs('x').confirmOnQuit).toBe(true)
  })
})

describe('resolveSessionNames', () => {
  it('uses the label, falling back to the short id for missing or blank ones', () => {
    const names = resolveSessionNames(['11111111-aaaa', '22222222-bbbb', '33333333-cccc'], {
      '11111111-aaaa': '  Fix login  ',
      '22222222-bbbb': '   '
    })
    expect(names).toEqual(['Fix login', '22222222', '33333333'])
    expect(shortSessionId('abcdef1234567')).toBe('abcdef12')
  })
})

describe('buildQuitDialogContent', () => {
  const build = (names: string[]): ReturnType<typeof buildQuitDialogContent> =>
    buildQuitDialogContent({ appName: 'Harnu', names, strings: DEFAULT_QUIT_STRINGS })

  it('singular message and one bullet', () => {
    const c = build(['Fix login'])
    expect(c.message).toBe('1 agent is still working')
    expect(c.detail).toBe('• Fix login\n\nQuitting Harnu now interrupts them.')
  })

  it('plural message with the count', () => {
    expect(build(['a', 'b']).message).toBe('2 agents are still working')
  })

  it('lists up to 5 names and collapses the rest into "and N more"', () => {
    const five = build(['1', '2', '3', '4', '5'])
    expect(five.detail.split('\n').filter((l) => l.startsWith('•'))).toHaveLength(5)
    expect(five.detail).not.toContain('more')

    const seven = build(['1', '2', '3', '4', '5', '6', '7'])
    const bullets = seven.detail.split('\n').filter((l) => l.startsWith('•'))
    expect(bullets).toEqual(['• 1', '• 2', '• 3', '• 4', '• 5', '• and 2 more'])
    expect(seven.message).toBe('7 agents are still working')
  })

  it('makes Cancel the default and cancel button, Quit anyway the first', () => {
    const c = build(['a'])
    expect(c.buttons).toEqual(['Quit anyway', 'Cancel'])
    expect(c.defaultId).toBe(1)
    expect(c.cancelId).toBe(1)
    expect(c.checkboxLabel).toBe("Don't ask again")
  })
})

describe('normalizeQuitStrings', () => {
  it('accepts a complete set and rejects partial or junk input wholesale', () => {
    const full = { ...DEFAULT_QUIT_STRINGS, cancel: 'Cancelar' }
    expect(normalizeQuitStrings(full).cancel).toBe('Cancelar')
    expect(normalizeQuitStrings({ ...full, detail: '' })).toBe(DEFAULT_QUIT_STRINGS)
    expect(normalizeQuitStrings({ cancel: 'x' })).toBe(DEFAULT_QUIT_STRINGS)
    expect(normalizeQuitStrings(undefined)).toBe(DEFAULT_QUIT_STRINGS)
  })
})
