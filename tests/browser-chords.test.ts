/**
 * T568 (browser pane U1, AC-8) — the chord set a guest forwards and the action each one runs.
 */
import { describe, it, expect } from 'vitest'
import {
  INACTIVE_BROWSER_ACTIONS,
  actionForChord,
  boundChordsFrom
} from '../src/renderer/src/lib/browser-chords'
import { resolveKeybindings } from '../src/main/keybindings-core'

const list = resolveKeybindings(null, { mac: false }).list

describe('boundChordsFrom', () => {
  it('collects global and browser chords and skips terminal, sidebar and modal scopes', () => {
    const chords = boundChordsFrom(
      [
        { id: 'session.new', keys: 'Cmd+N', scope: 'global' },
        { id: 'browser.reload', keys: 'Cmd+R', scope: 'browser' },
        { id: 'sidebar.cursor.down', keys: 'ArrowDown', scope: 'sidebar' },
        { id: 'x', keys: null, scope: 'global' }
      ],
      false
    )
    expect(chords.sort()).toEqual(['Cmd+N', 'Cmd+R'])
  })

  it('folds Ctrl onto Cmd off macOS but keeps them apart on macOS', () => {
    const rows = [{ id: 'a', keys: 'Ctrl+B', scope: 'global' as const }]
    expect(boundChordsFrom(rows, false)).toEqual(['Cmd+B'])
    expect(boundChordsFrom(rows, true)).toEqual(['Ctrl+B'])
  })

  it('includes the real defaults: the browser actions and the global ones', () => {
    const chords = new Set(boundChordsFrom(list, false))
    for (const c of ['Cmd+R', 'Cmd+L', 'Cmd+[', 'Cmd+]', 'Cmd+Alt+I', 'Cmd+N', 'Cmd+K']) {
      expect(chords.has(c), c).toBe(true)
    }
  })
})

describe('actionForChord', () => {
  it('prefers the browser scope over global for the same chord', () => {
    const rows = [
      { id: 'app.reloadish', keys: 'Cmd+R', scope: 'global' as const },
      { id: 'browser.reload', keys: 'Cmd+R', scope: 'browser' as const }
    ]
    expect(actionForChord(rows, 'Cmd+R', false)).toEqual({ id: 'browser.reload', scope: 'browser' })
  })

  it('falls back to global and returns null for an unbound chord', () => {
    expect(actionForChord(list, 'Cmd+K', false)).toEqual({ id: 'app.search', scope: 'global' })
    expect(actionForChord(list, 'Cmd+Q', false)).toBeNull()
  })

  it('resolves each ACTIVE §2.5 action id from its default chord', () => {
    const expected: Record<string, string> = {
      'browser.devtools': 'Cmd+Alt+I',
      'browser.reload': 'Cmd+R',
      'browser.back': 'Cmd+[',
      'browser.forward': 'Cmd+]',
      'browser.focusAddress': 'Cmd+L',
      'browser.zoom.in': 'Cmd+=',
      'browser.zoom.out': 'Cmd+-',
      'browser.zoom.reset': 'Cmd+0'
    }
    for (const [id, chord] of Object.entries(expected)) {
      expect(actionForChord(list, chord, false), id).toEqual({ id, scope: 'browser' })
    }
  })
})

describe('inactive actions are not swallowed (delta 2)', () => {
  it('every browser chord is in the set main swallows: nothing is inactive any more', () => {
    const chords = new Set(boundChordsFrom(list, false))
    // Zoom went live with U5 (T572), the point-and-comment toggle with U6 (T573).
    for (const c of [
      'Cmd+R',
      'Cmd+L',
      'Cmd+[',
      'Cmd+]',
      'Cmd+Alt+I',
      'Cmd+=',
      'Cmd+-',
      'Cmd+0',
      'Cmd+Shift+C'
    ])
      expect(chords.has(c), c).toBe(true)
  })

  it('resolves the zoom and overlay chords to their actions, and nothing is inactive', () => {
    expect(actionForChord(list, 'Cmd+=', false)).toEqual({
      id: 'browser.zoom.in',
      scope: 'browser'
    })
    expect(actionForChord(list, 'Cmd+Shift+C', false)).toEqual({
      id: 'browser.overlay.toggle',
      scope: 'browser'
    })
    expect([...INACTIVE_BROWSER_ACTIONS]).toEqual([])
  })
})
