import { describe, it, expect } from 'vitest'
import { parseTpgid } from '../src/main/detect/foreground-process'

/**
 * W6.1 — `parseTpgid` extracts the foreground process-group id (field 8) from a
 * `/proc/<pid>/stat` line. The risk it pins: `comm` (field 2) is parenthesized
 * and may itself contain spaces and `)`, so naive whitespace-splitting picks the
 * wrong field. We split on the LAST `)` and index the rest, where tpgid is at
 * offset 5 (`state ppid pgrp session tty_nr tpgid`).
 */

describe('parseTpgid', () => {
  it('reads tpgid from a normal stat line', () => {
    // pid (comm) state ppid pgrp session tty_nr tpgid ...
    expect(parseTpgid('1234 (zsh) S 1000 1234 1234 34816 5678 0 0 0')).toBe(5678)
  })

  it('handles a comm containing spaces', () => {
    expect(parseTpgid('42 (my proc) S 1 42 42 0 99 0')).toBe(99)
  })

  it('handles a comm containing parens (splits on the LAST close paren)', () => {
    expect(parseTpgid('42 (weird(comm)) R 1 42 42 0 77 0')).toBe(77)
  })

  it('returns null when the tty has no foreground group (tpgid -1)', () => {
    expect(parseTpgid('5 (sh) S 1 5 5 0 -1 0')).toBeNull()
  })

  it('returns null for a malformed line (no close paren / too few fields)', () => {
    expect(parseTpgid('garbage with no paren')).toBeNull()
    expect(parseTpgid('5 (sh)')).toBeNull()
    expect(parseTpgid('')).toBeNull()
  })
})
