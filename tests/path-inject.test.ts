import { describe, it, expect } from 'vitest'
import { shellEscapePath } from '../src/renderer/src/lib/path-inject'

/**
 * Cluster A — shared path-injection escaping. `shellEscapePath` reproduces the
 * backslash-escaping a terminal-native file drop emits (drag a file into GNOME
 * Terminal / iTerm), so Claude Code's paste-path detection parses it. Pure
 * string → string, so it is testable in isolation with no store or PTY.
 */
describe('shellEscapePath', () => {
  it('leaves a path with no special characters unchanged', () => {
    expect(shellEscapePath('/home/user/projects/harnu/design.md')).toBe(
      '/home/user/projects/harnu/design.md'
    )
    // The image-cache case: a UUID dir — no special chars, so a pass-through.
    expect(shellEscapePath('/home/user/.claude/image-cache/9f3a-1b2c/img.png')).toBe(
      '/home/user/.claude/image-cache/9f3a-1b2c/img.png'
    )
  })

  it('backslash-escapes spaces', () => {
    expect(shellEscapePath('/home/user/My Project/notes.md')).toBe(
      '/home/user/My\\ Project/notes.md'
    )
  })

  it('backslash-escapes quotes, parens and $', () => {
    expect(shellEscapePath('/tmp/a "b" (c) $x.txt')).toBe('/tmp/a\\ \\"b\\"\\ \\(c\\)\\ \\$x.txt')
  })

  it('escapes an empty string to an empty string', () => {
    expect(shellEscapePath('')).toBe('')
  })

  it('handles a realistic path with spaces and parens', () => {
    expect(shellEscapePath('/home/user/My Project/PRD (draft).md')).toBe(
      '/home/user/My\\ Project/PRD\\ \\(draft\\).md'
    )
  })

  it('escapes the full metacharacter set (backtick, backslash, glob, ; | & etc.)', () => {
    expect(shellEscapePath('/tmp/a`b\\c;d|e&f<g>h*i?j#k~l!m[n]o{p}q')).toBe(
      '/tmp/a\\`b\\\\c\\;d\\|e\\&f\\<g\\>h\\*i\\?j\\#k\\~l\\!m\\[n\\]o\\{p\\}q'
    )
  })
})
