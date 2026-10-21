/**
 * T568 (browser pane U1, AC-8) — chord forwarding rules of spec §2.5, from the U0 A8 measurements.
 */
import { describe, it, expect } from 'vitest'
import { chordOf, decideForward, isBareModifier, type GuestInput } from '../src/main/browser/chord'

const key = (over: Partial<GuestInput> & { key: string }): GuestInput => ({
  type: 'keyDown',
  control: false,
  alt: false,
  shift: false,
  meta: false,
  ...over
})

const bound = new Set(['Cmd+Shift+C', 'Cmd+R', 'Cmd+L', 'F5', 'Cmd+B', 'Cmd+C'])

describe('chordOf', () => {
  it('folds Control to Cmd off macOS and Meta to Cmd on macOS', () => {
    expect(chordOf(key({ key: 'c', control: true, shift: true }), false)).toBe('Cmd+Shift+C')
    expect(chordOf(key({ key: 'c', meta: true, shift: true }), true)).toBe('Cmd+Shift+C')
    expect(chordOf(key({ key: 'c', control: true }), true)).toBe('Ctrl+C')
  })

  it('returns null for bare modifiers and plain keys', () => {
    for (const k of ['Control', 'Shift', 'Alt', 'Meta']) {
      expect(chordOf(key({ key: k, control: true }), false), k).toBeNull()
      expect(isBareModifier(k)).toBe(true)
    }
    expect(chordOf(key({ key: 'a' }), false)).toBeNull()
    expect(chordOf(key({ key: 'Escape' }), false)).toBeNull()
    expect(chordOf(key({ key: 'A', shift: true }), false)).toBeNull()
  })

  it('treats function keys as chords on their own', () => {
    expect(chordOf(key({ key: 'F5' }), false)).toBe('F5')
    expect(chordOf(key({ key: 'F12', shift: true }), false)).toBe('Shift+F12')
  })
})

describe('decideForward', () => {
  it('forwards a bound chord on keyDown', () => {
    expect(decideForward(key({ key: 'r', control: true }), bound, false)).toEqual({
      forward: true,
      chord: 'Cmd+R'
    })
    expect(decideForward(key({ key: 'F5' }), bound, false).forward).toBe(true)
  })

  it('leaves a chord Harnu does not bind to the page', () => {
    expect(decideForward(key({ key: 't', control: true }), bound, false).forward).toBe(false)
  })

  it('never intercepts keyUp, so the page never sees an orphaned keyup', () => {
    expect(
      decideForward(key({ key: 'r', control: true, type: 'keyUp' }), bound, false).forward
    ).toBe(false)
  })

  it('never intercepts while composing or for the IME Process key', () => {
    expect(
      decideForward(key({ key: 'r', control: true, isComposing: true }), bound, false).forward
    ).toBe(false)
    expect(decideForward(key({ key: 'Process', control: true }), bound, false).forward).toBe(false)
  })

  it('ignores bare modifier presses even when a chord using them is bound', () => {
    expect(decideForward(key({ key: 'Control', control: true }), bound, false)).toEqual({
      forward: false,
      chord: null
    })
    expect(
      decideForward(key({ key: 'Shift', shift: true, control: true }), bound, false).forward
    ).toBe(false)
  })

  it('keeps the page-owns list for the page even if Harnu binds the chord', () => {
    // Cmd+C is bound in the set on purpose: the page still keeps copy.
    expect(decideForward(key({ key: 'c', control: true }), bound, false).forward).toBe(false)
    for (const k of ['v', 'x', 'a', 'z', 'f']) {
      expect(
        decideForward(key({ key: k, control: true }), new Set([`Cmd+${k.toUpperCase()}`]), false)
          .forward,
        k
      ).toBe(false)
    }
  })

  it("leaves the pane's own zoom chords alone", () => {
    const zoom = new Set(['Cmd+=', 'Cmd+-', 'Cmd+0'])
    for (const k of ['=', '-', '0']) {
      expect(decideForward(key({ key: k, control: true }), zoom, false).forward, k).toBe(false)
    }
  })
})
