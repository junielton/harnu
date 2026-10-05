import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { buildPosixMissingDirNotice } from '../src/main/pty'

/**
 * Regression guard for the command injection in `buildMissingDirNotice`: the
 * stale-directory notice embeds the session cwd, which is attacker-influenced
 * (it comes from on-disk session metadata). The old implementation interpolated
 * the cwd into the `/bin/sh -c` script with only one level of single-quote
 * escaping, so a cwd like `$(touch …)` or one containing backticks executed.
 *
 * These assert the cwd reaches the shell only as a positional parameter — never
 * as part of the interpreted `-c` script body.
 */
describe('buildPosixMissingDirNotice — command injection guard', () => {
  const MALICIOUS = [
    '$(touch /tmp/PWNED)',
    '`touch /tmp/PWNED`',
    "'; touch /tmp/PWNED; '",
    "a' && touch /tmp/PWNED && echo '",
    '$(id)',
    '"; rm -rf ~; "'
  ]

  it('always spawns the static /bin/sh notice, cwd as the trailing positional arg', () => {
    for (const cwd of MALICIOUS) {
      const { command, args } = buildPosixMissingDirNotice(cwd)
      expect(command).toBe('/bin/sh')
      // args = ['-c', script, 'sh' ($0), cwd ($1)]
      expect(args[0]).toBe('-c')
      expect(args[2]).toBe('sh')
      expect(args[3]).toBe(cwd)
    }
  })

  it('never interpolates the cwd into the interpreted -c script body', () => {
    for (const cwd of MALICIOUS) {
      const { args } = buildPosixMissingDirNotice(cwd)
      const script = args[1]
      // The script is fixed: a printf of a static format with %s placeholders
      // fed by "$1". None of the cwd's bytes appear in it.
      expect(script).not.toContain(cwd)
      expect(script).not.toContain('touch')
      expect(script).not.toContain('PWNED')
      expect(script).not.toContain('rm -rf')
      // It must reference the cwd only via the positional parameter.
      expect(script).toContain('"$1"')
    }
  })

  it('actually running the notice does not execute the malicious cwd', () => {
    // End-to-end proof: run /bin/sh with the built argv and confirm (a) it
    // exits cleanly, (b) the marker file is never created, (c) the cwd is
    // printed verbatim in the output.
    const marker = `/tmp/harnu-pwned-${process.pid}-${Math.random().toString(36).slice(2)}`
    const cwd = `$(touch ${marker})\`touch ${marker}\``
    const { command, args } = buildPosixMissingDirNotice(cwd)
    const out = execFileSync(command, args, { encoding: 'utf8' })
    // The literal cwd string is rendered (ANSI-wrapped) in the notice.
    expect(out).toContain(cwd)
    // No command substitution ran.
    expect(existsSync(marker)).toBe(false)
  })
})
