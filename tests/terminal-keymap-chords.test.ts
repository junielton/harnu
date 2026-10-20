// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import {
  installTerminalKeymap,
  TERMINAL_KEYMAP_CHORDS
} from '../src/renderer/src/lib/terminalKeymap'
import { chordFromEvent, normalizeChord } from '../src/main/keybindings-core'

/**
 * T486 U5a (§5.2, AC-51) — `TERMINAL_KEYMAP_CHORDS` is the data the Settings
 * pane reads to say "the terminal keeps this chord". It must be exactly the set
 * of chords the handler swallows, per platform, in the canonical grammar the
 * recorder produces (`chordFromEvent`). This test drives the REAL handler with
 * every modifier combination over every key it looks at and compares.
 *
 * Off macOS the Super key (`metaKey`) is never what a user means by a shortcut
 * (`chordFromEvent` folds Ctrl onto Cmd there), so only Ctrl/Alt/Shift vary.
 */

const CODES: Array<{ code: string; key: string }> = [
  { code: 'KeyC', key: 'c' },
  { code: 'KeyV', key: 'v' },
  { code: 'Enter', key: 'Enter' },
  { code: 'Backspace', key: 'Backspace' },
  { code: 'Equal', key: '=' },
  { code: 'Minus', key: '-' },
  { code: 'Digit0', key: '0' }
]

type Handler = (e: KeyboardEvent) => boolean
let handler: Handler

beforeAll(() => {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { readText: async () => '', writeText: async () => {} }
  })
  const term = {
    attachCustomKeyEventHandler: (h: Handler) => {
      handler = h
    },
    hasSelection: () => false,
    getSelection: () => '',
    paste: () => {}
  } as unknown as Terminal
  installTerminalKeymap(term, { write: () => {}, fontStep: () => {}, fontReset: () => {} })
})

function swallowedSet(mac: boolean): Set<string> {
  const out = new Set<string>()
  const bits = [false, true]
  for (const metaKey of mac ? bits : [false])
    for (const ctrlKey of bits)
      for (const altKey of bits)
        for (const shiftKey of bits)
          for (const { code, key } of CODES) {
            const e = new KeyboardEvent('keydown', {
              code,
              key,
              metaKey,
              ctrlKey,
              altKey,
              shiftKey,
              cancelable: true
            })
            if (handler(e) !== false) continue
            const chord = chordFromEvent(e, { mac })
            if (chord) out.add(normalizeChord(chord))
          }
  return out
}

describe('TERMINAL_KEYMAP_CHORDS mirrors the handler', () => {
  it('macOS', () => {
    expect(new Set(TERMINAL_KEYMAP_CHORDS.mac)).toEqual(swallowedSet(true))
  })
  it('Linux / Windows', () => {
    expect(new Set(TERMINAL_KEYMAP_CHORDS.other)).toEqual(swallowedSet(false))
  })
  it('lists the chords §7.1 names', () => {
    expect(TERMINAL_KEYMAP_CHORDS.other).toEqual(
      expect.arrayContaining([
        'Cmd+Shift+C',
        'Cmd+Shift+V',
        'Shift+Enter',
        'Cmd+Backspace',
        'Shift+Backspace',
        'Cmd+=',
        'Cmd+-',
        'Cmd+0'
      ])
    )
    expect(TERMINAL_KEYMAP_CHORDS.mac).toEqual(
      expect.arrayContaining([
        'Cmd+C',
        'Cmd+V',
        'Ctrl+Shift+C',
        'Ctrl+Shift+V',
        'Shift+Enter',
        'Ctrl+Backspace'
      ])
    )
  })
})
