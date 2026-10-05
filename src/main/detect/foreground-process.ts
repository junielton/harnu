import { readFileSync } from 'node:fs'

/**
 * PTY foreground-process resolver (A2 — `match.process` classifier, W6.1).
 *
 * Resolves the name of the process currently in the FOREGROUND of a pty's
 * controlling terminal — e.g. `aider` / `codex` while it runs, `zsh` at a bare
 * prompt. This is the strongest, scroll-proof classifier signal: it identifies
 * the agent regardless of what's on screen, so an agent with weak on-screen
 * identity (aider sets no OSC title and its banner scrolls off) stays correctly
 * classified for the whole run.
 *
 * Linux-only (reads `/proc`); other platforms return `null` and the detector
 * falls back to the title/content signals. The `/proc/<pid>/stat` parse is split
 * out as a pure function so the field-offset logic (which is easy to get wrong —
 * `comm` can contain spaces and parens) is unit-tested without a real `/proc`.
 */

/**
 * Parse the `tpgid` (foreground process group id of the controlling terminal)
 * out of a `/proc/<pid>/stat` line. Pure.
 *
 * The format is `pid (comm) state ppid pgrp session tty_nr tpgid …`, where
 * `comm` is parenthesized and may itself contain spaces and `)` — so we split on
 * the LAST `)` and index the space-separated fields AFTER it: `[state, ppid,
 * pgrp, session, tty_nr, tpgid, …]`, making `tpgid` index 5.
 *
 * @returns the tpgid (a positive pid), or `null` when absent/unparseable (e.g.
 *   `-1` when the tty has no foreground group).
 */
export function parseTpgid(stat: string): number | null {
  const close = stat.lastIndexOf(')')
  if (close < 0) return null
  const after = stat.slice(close + 1).trim()
  if (after.length === 0) return null
  const fields = after.split(/\s+/)
  const tpgid = Number(fields[5])
  return Number.isInteger(tpgid) && tpgid > 0 ? tpgid : null
}

/**
 * Read the foreground process name of the terminal controlled by `pid` (the
 * pty's shell pid). Returns `null` on non-Linux, or when `/proc` can't be read
 * (the process exited, no foreground group, etc.) — never throws.
 */
export function foregroundProcessName(pid: number): string | null {
  if (process.platform !== 'linux') return null
  try {
    const tpgid = parseTpgid(readFileSync(`/proc/${pid}/stat`, 'utf8'))
    if (tpgid === null) return null
    const comm = readFileSync(`/proc/${tpgid}/comm`, 'utf8').trim()
    return comm.length > 0 ? comm : null
  } catch {
    return null
  }
}
