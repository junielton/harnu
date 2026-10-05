import { describe, it, expect } from 'vitest'
import { sanitizeShellSessions } from '../src/main/detect/shell-session-core'

/**
 * W6.2 — `sanitizeShellSessions` narrows the UNTRUSTED `fleet:shell-sessions`
 * report from the renderer into well-formed entries before main stores them for
 * the MCP fleet. Invariants pinned: drop malformed items, never throw, carry
 * only id/folder/timestamp (no transcript could even sneak through the shape).
 */

describe('sanitizeShellSessions', () => {
  it('keeps well-formed entries verbatim', () => {
    const out = sanitizeShellSessions([
      { sessionId: 'shellterm-1', folderPath: '/home/u/repo', modified: '2026-06-30T00:00:00Z' }
    ])
    expect(out).toEqual([
      { sessionId: 'shellterm-1', folderPath: '/home/u/repo', modified: '2026-06-30T00:00:00Z' }
    ])
  })

  it('defaults a missing/non-string modified to empty string', () => {
    const out = sanitizeShellSessions([{ sessionId: 'shellterm-1', folderPath: '/p' }])
    expect(out[0].modified).toBe('')
  })

  it('drops items missing a non-empty sessionId or a string folderPath', () => {
    const out = sanitizeShellSessions([
      { sessionId: '', folderPath: '/p' }, // empty id
      { folderPath: '/p' }, // no id
      { sessionId: 'ok', folderPath: 42 }, // non-string folder
      { sessionId: 'keep', folderPath: '/p' } // good
    ])
    expect(out).toEqual([{ sessionId: 'keep', folderPath: '/p', modified: '' }])
  })

  it('ignores non-array / garbage input without throwing', () => {
    for (const bad of [null, undefined, 'x', 42, {}, [null, 1, 'str']]) {
      expect(sanitizeShellSessions(bad)).toEqual([])
    }
  })

  it('strips any extra fields (no transcript/lastLine can pass through)', () => {
    const out = sanitizeShellSessions([
      { sessionId: 's', folderPath: '/p', modified: '', transcript: 'SECRET', lastLine: 'SECRET' }
    ])
    expect(out[0]).toEqual({ sessionId: 's', folderPath: '/p', modified: '' })
    expect('transcript' in out[0]).toBe(false)
  })
})
