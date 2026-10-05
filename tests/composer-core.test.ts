import { describe, it, expect } from 'vitest'
import {
  buildBracketedPaste,
  composeSubmitSequence,
  normalizeDraft,
  PASTE_START,
  PASTE_END,
  SUBMIT
} from '../src/renderer/src/lib/composer-core'

/** T40 slice 1 — pure Composer send-sequence core (bracketed paste + submit). */
describe('normalizeDraft', () => {
  it('collapses CRLF and lone LF to CR', () => {
    expect(normalizeDraft('a\r\nb\nc')).toBe('a\rb\rc')
  })
  it('leaves single-line text untouched', () => {
    expect(normalizeDraft('hello world')).toBe('hello world')
  })
})

describe('buildBracketedPaste', () => {
  it('fences the body in ESC[200~ … ESC[201~', () => {
    const out = buildBracketedPaste('line 1\nline 2')
    expect(out.startsWith(PASTE_START)).toBe(true)
    expect(out.endsWith(PASTE_END)).toBe(true)
    expect(out).toBe(`${PASTE_START}line 1\rline 2${PASTE_END}`)
  })

  it('strips an embedded paste terminator (injection escape)', () => {
    // A draft that tries to close the fence early + run `rm -rf /`.
    const evil = `hi${PASTE_END}rm -rf /`
    const out = buildBracketedPaste(evil)
    // Exactly one closing terminator — the final fence — and it's last.
    expect(out.split(PASTE_END)).toHaveLength(2)
    expect(out.endsWith(PASTE_END)).toBe(true)
    expect(out).toBe(`${PASTE_START}hirm -rf /${PASTE_END}`)
  })

  it('wraps an empty body as an empty paste', () => {
    expect(buildBracketedPaste('')).toBe(`${PASTE_START}${PASTE_END}`)
  })
})

describe('composeSubmitSequence', () => {
  it('returns [paste, submit] for real text', () => {
    const seq = composeSubmitSequence('do the thing')
    expect(seq).toEqual([`${PASTE_START}do the thing${PASTE_END}`, SUBMIT])
    expect(SUBMIT).toBe('\r')
  })

  it('returns null for empty / whitespace-only drafts', () => {
    expect(composeSubmitSequence('')).toBeNull()
    expect(composeSubmitSequence('   \n  ')).toBeNull()
  })

  it('submit byte is sent OUTSIDE the paste fence', () => {
    const seq = composeSubmitSequence('x')
    expect(seq).not.toBeNull()
    const [paste, submit] = seq as [string, string]
    expect(paste.includes(submit)).toBe(false) // \r is not inside the fenced body
  })
})
