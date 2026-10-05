import { describe, it, expect } from 'vitest'

import { clampSpokenText, normalizeSpokenText, SPEAK_MAX_CHARS } from '../src/main/speech-text'
import { clampSpeechText } from '../src/renderer/src/lib/speech'

/**
 * T238 — the utterance cap (AC-4): over-long text is TRUNCATED, never rejected.
 *
 * Separate from the gate's tests because `speech-text.ts` is a deliberate leaf —
 * the two modules that only need the cap import it without dragging the cascade
 * in — and because the agreement test below is really about the DUPLICATION
 * between main and the renderer engine, not about the gate.
 */

describe('AC-4 — the length cap truncates, it never rejects', () => {
  it('leaves a short line alone, minus whitespace normalisation', () => {
    expect(clampSpokenText('  The migration\nfinished,  zero conflicts. ')).toBe(
      'The migration finished, zero conflicts.'
    )
  })

  it('truncates at a word boundary instead of returning nothing', () => {
    const long = 'word '.repeat(200)
    const out = clampSpokenText(long)
    expect(out.length).toBeGreaterThan(0)
    expect(out.length).toBeLessThanOrEqual(SPEAK_MAX_CHARS)
    expect(out.endsWith('word')).toBe(true)
  })

  it('a single over-long word is cut hard rather than emptied', () => {
    const out = clampSpokenText('x'.repeat(SPEAK_MAX_CHARS * 2))
    expect(out).toHaveLength(SPEAK_MAX_CHARS)
  })

  it('strips leading dashes so an utterance can never be read as a flag', () => {
    expect(clampSpokenText('--rm -rf everything')).toBe('rm -rf everything')
  })

  it('non-strings and whitespace-only input normalise to the empty string', () => {
    for (const bad of [undefined, null, 42, {}, '   ', '\n\t'])
      expect(clampSpokenText(bad)).toBe('')
  })

  it('normalizeSpokenText is the same rule with no cap — so truncation is measurable', () => {
    const raw = 'a  b\nc'
    expect(normalizeSpokenText(raw)).toBe('a b c')
    expect(clampSpokenText(raw)).toBe(normalizeSpokenText(raw))
  })

  it("AGREES with the engine's own clampSpeechText — the two copies cannot drift", () => {
    // `clampSpokenText` duplicates `clampSpeechText` because main must not import
    // a renderer module. This table is what keeps the duplication honest.
    const table = [
      'short',
      '  padded  ',
      '--flagish',
      'multi\nline\ttext',
      'word '.repeat(400),
      'x'.repeat(1000),
      ''
    ]
    for (const t of table) {
      for (const cap of [1, 17, SPEAK_MAX_CHARS, 800]) {
        expect(clampSpokenText(t, cap)).toBe(clampSpeechText(t, cap))
      }
    }
  })
})
