/**
 * T571 (browser pane U4, AC-4) — the key vocabulary of `browser_press` as CDP key events (spec §6.2): the
 * `send_terminal` names plus Meta+/Alt+/Shift+ modifiers; anything else is refused before a key is pressed.
 */
import { describe, it, expect } from 'vitest'
import {
  MAX_PRESS_KEYS,
  MOD,
  chordEvents,
  firstUnknownKey,
  parseChord
} from '../src/main/browser/cdp-keys'

describe('parseChord', () => {
  it.each([
    ['Enter', 13, ''],
    ['Tab', 9, ''],
    ['Esc', 27, ''],
    ['Backspace', 8, ''],
    ['Delete', 46, ''],
    ['Space', 32, ' '],
    ['Up', 38, ''],
    ['Down', 40, ''],
    ['Left', 37, ''],
    ['Right', 39, ''],
    ['Home', 36, ''],
    ['End', 35, ''],
    ['PageUp', 33, ''],
    ['PageDown', 34, ''],
    ['F1', 112, ''],
    ['F12', 123, '']
  ])('%s is a key (vk %i)', (name, vk) => {
    expect(parseChord(name)?.def.windowsVirtualKeyCode).toBe(vk)
  })

  it('knows Ctrl+A…Z, Meta+K, Alt and Shift combinations, and a bare letter or digit', () => {
    expect(parseChord('Ctrl+A')).toMatchObject({
      modifiers: MOD.ctrl,
      def: { code: 'KeyA', key: 'a' }
    })
    expect(parseChord('Meta+K')?.modifiers).toBe(MOD.meta)
    expect(parseChord('Alt+F4')).toMatchObject({ modifiers: MOD.alt, def: { code: 'F4' } })
    expect(parseChord('Ctrl+Shift+Z')?.modifiers).toBe(MOD.ctrl | MOD.shift)
    expect(parseChord('Shift+Tab')).toMatchObject({ modifiers: MOD.shift, def: { code: 'Tab' } })
    expect(parseChord('a')?.def.text).toBe('a')
    expect(parseChord('7')?.def.code).toBe('Digit7')
  })

  it('does not type the letter of a shortcut, but does type a plain or shifted one', () => {
    expect(parseChord('Ctrl+A')?.def.text).toBeUndefined()
    expect(parseChord('Meta+K')?.def.text).toBeUndefined()
    expect(parseChord('Shift+a')?.def).toMatchObject({ key: 'A', text: 'A' })
    expect(parseChord('Enter')?.def.text).toBe('\r')
  })

  it.each([
    '',
    'Hyper',
    'F13',
    'Ctrl+',
    'Ctrl+Ctrl+A',
    'Ctrl+Nope',
    'enter',
    'AB',
    '+',
    'a'.repeat(40)
  ])('refuses %j', (raw) => {
    expect(parseChord(raw)).toBeNull()
  })

  it('names the first unknown key of a list', () => {
    expect(firstUnknownKey(['Enter', 'Ctrl+A'])).toBeNull()
    expect(firstUnknownKey(['Enter', 'Banana', 'Nope'])).toBe('Banana')
    expect(MAX_PRESS_KEYS).toBe(64)
  })
})

describe('chordEvents', () => {
  it('is a keyDown with text for a typing key and a rawKeyDown for the rest, each followed by a keyUp', () => {
    const typing = chordEvents(parseChord('a')!)
    expect(typing.map((e) => e.type)).toEqual(['keyDown', 'keyUp'])
    expect(typing[0]?.text).toBe('a')
    const raw = chordEvents(parseChord('Ctrl+A')!)
    expect(raw.map((e) => e.type)).toEqual(['rawKeyDown', 'keyUp'])
    expect(raw[0]).toMatchObject({ modifiers: MOD.ctrl, windowsVirtualKeyCode: 65 })
    expect(raw[0]?.text).toBeUndefined()
  })
})
