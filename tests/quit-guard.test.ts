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
    expect(d).toEqual({
      confirm: true,
      sessionIds: ['a', 'c'],
      unsavedFiles: [],
      allowDontAsk: true
    })
  })

  it('never asks when nothing is working (idle / done / error / needs-input)', () => {
    const d = decideQuitConfirm({
      taskStates: states(['a', 'idle'], ['b', 'done'], ['c', 'error'], ['d', 'needs-input']),
      confirmEnabled: true,
      reason: 'user'
    })
    expect(d).toEqual({
      confirm: false,
      sessionIds: [],
      unsavedFiles: [],
      allowDontAsk: true
    })
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
      expect(d).toEqual({
        confirm: false,
        sessionIds: [],
        unsavedFiles: [],
        allowDontAsk: true
      })
    }
  )
})

describe('decideQuitConfirm with unsaved files', () => {
  it('asks about unsaved files even when the preference is off', () => {
    const d = decideQuitConfirm({
      taskStates: states(['a', 'working']),
      confirmEnabled: false,
      reason: 'user',
      unsavedFiles: ['note.md (wt)']
    })
    expect(d).toEqual({
      confirm: true,
      sessionIds: [],
      unsavedFiles: ['note.md (wt)'],
      allowDontAsk: false
    })
  })

  it('lists both when the preference is on', () => {
    const d = decideQuitConfirm({
      taskStates: states(['a', 'working']),
      confirmEnabled: true,
      reason: 'user',
      unsavedFiles: ['note.md (wt)']
    })
    expect(d.sessionIds).toEqual(['a'])
    expect(d.unsavedFiles).toEqual(['note.md (wt)'])
    expect(d.allowDontAsk).toBe(false)
  })

  it.each(['update-install', 'system-shutdown'] as const)(
    'never blocks a %s quit, even with unsaved files',
    (reason) => {
      const d = decideQuitConfirm({
        taskStates: [],
        confirmEnabled: true,
        reason,
        unsavedFiles: ['note.md (wt)']
      })
      expect(d).toEqual({
        confirm: false,
        sessionIds: [],
        unsavedFiles: [],
        allowDontAsk: true
      })
    }
  )

  it('stays instant with nothing dirty and nothing working', () => {
    const d = decideQuitConfirm({
      taskStates: states(['a', 'idle']),
      confirmEnabled: false,
      reason: 'user',
      unsavedFiles: []
    })
    expect(d.confirm).toBe(false)
  })
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

describe('buildQuitDialogContent with unsaved files', () => {
  const build = (
    unsavedNames: string[],
    names: string[] = []
  ): ReturnType<typeof buildQuitDialogContent> =>
    buildQuitDialogContent({
      appName: 'Harnu',
      names,
      unsavedNames,
      strings: DEFAULT_QUIT_STRINGS
    })

  it('one file', () => {
    const c = build(['a.md (wt)'])
    expect(c.message).toBe('1 file has unsaved changes')
    expect(c.detail).toBe('• a.md (wt)\n\nQuitting Harnu now discards them.')
    expect(c.buttons).toEqual(['Quit without saving', 'Cancel'])
    expect(c.defaultId).toBe(1)
    expect(c.cancelId).toBe(1)
    expect(c.checkboxLabel).toBe('')
  })

  it('seven files cap at five plus "and 2 more"', () => {
    const c = build(['1', '2', '3', '4', '5', '6', '7'].map((n) => `${n}.md`))
    expect(c.message).toBe('7 files have unsaved changes')
    const bullets = c.detail.split('\n').filter((l) => l.startsWith('•'))
    expect(bullets).toEqual(['• 1.md', '• 2.md', '• 3.md', '• 4.md', '• 5.md', '• and 2 more'])
  })

  it('files first, then a blank line and the agents block', () => {
    const c = build(['a.md'], ['Fix login', 'Other'])
    expect(c.message).toBe('1 file has unsaved changes')
    expect(c.detail).toBe(
      [
        '• a.md',
        '',
        'Quitting Harnu now discards them.',
        '',
        '2 agents are still working',
        '• Fix login',
        '• Other',
        '',
        'Quitting Harnu now interrupts them.'
      ].join('\n')
    )
    expect(c.buttons).toEqual(['Quit without saving', 'Cancel'])
    expect(c.checkboxLabel).toBe('')
  })

  it('an empty unsaved list gives exactly the agents-only output', () => {
    expect(build([], ['a'])).toEqual(
      buildQuitDialogContent({ appName: 'Harnu', names: ['a'], strings: DEFAULT_QUIT_STRINGS })
    )
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

  it('falls back to English when a newer key is missing', () => {
    const { unsavedMany: _omit, ...old } = DEFAULT_QUIT_STRINGS
    expect(normalizeQuitStrings({ ...old, cancel: 'Cancelar' })).toBe(DEFAULT_QUIT_STRINGS)
  })
})
