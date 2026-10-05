/**
 * `/proc/<pid>/stat` and `/proc/<pid>/statm` text parsing (T127). PURE — no I/O, no
 * clock. Mirrors the split already proven by `detect/foreground-process.ts#parseTpgid`:
 * the field-offset logic (easy to get wrong — `comm` can itself contain spaces and
 * parens) lives here, unit-tested against literal `/proc` text, and the real
 * `readFileSync` shell lives in `proc-linux.ts`.
 *
 * Spec: docs/specs/T127-system-monitor.md §6.1.
 */

/** The subset of `/proc/<pid>/stat` this feature needs. */
export interface ProcStat {
  pid: number
  ppid: number
  comm: string
  /** Jiffies of user-mode CPU time — cumulative since the process started. */
  utime: number
  /** Jiffies of kernel-mode CPU time — cumulative since the process started. */
  stime: number
}

/**
 * Parse one `/proc/<pid>/stat` line.
 *
 * Format: `pid (comm) state ppid pgrp session tty_nr tpgid flags minflt cminflt
 * majflt cmajflt utime stime …`, where `comm` is parenthesized and may itself
 * contain spaces and `)` — so we split on the LAST `)` and index the
 * space-separated fields AFTER it (same technique as `parseTpgid`):
 * `[state, ppid, pgrp, session, tty_nr, tpgid, flags, minflt, cminflt, majflt,
 * cmajflt, utime, stime, …]`, making `ppid` index 1, `utime` index 11, `stime`
 * index 12.
 *
 * @returns `null` when the line is unparseable (never throws).
 */
export function parseProcStat(stat: string): ProcStat | null {
  const pidEnd = stat.indexOf(' ')
  const open = stat.indexOf('(')
  const close = stat.lastIndexOf(')')
  if (pidEnd < 0 || open < 0 || close < 0 || close <= open) return null
  const pid = Number(stat.slice(0, pidEnd))
  const comm = stat.slice(open + 1, close)
  const after = stat.slice(close + 1).trim()
  if (after.length === 0) return null
  const fields = after.split(/\s+/)
  const ppid = Number(fields[1])
  const utime = Number(fields[11])
  const stime = Number(fields[12])
  if (![pid, ppid, utime, stime].every((n) => Number.isFinite(n))) return null
  return { pid, ppid, comm, utime, stime }
}

/**
 * Linux memory pages are 4096 bytes on every architecture Node/Electron targets
 * (`sysconf(_SC_PAGESIZE)`). No Node API surfaces this value, so it is a documented
 * constant rather than a syscall — same posture as `TICKS_PER_SEC` in `proc-linux.ts`.
 */
export const PAGE_SIZE_BYTES = 4096

/**
 * Parse a `/proc/<pid>/statm` line → resident set size in bytes.
 *
 * Format: `size resident shared text lib data dt`, all in pages. `resident`
 * (field index 1) is the RSS this feature reports.
 *
 * @returns `null` when the line is unparseable (never throws).
 */
export function parseProcStatm(statm: string, pageSizeBytes = PAGE_SIZE_BYTES): number | null {
  const fields = statm.trim().split(/\s+/)
  const residentPages = Number(fields[1])
  if (!Number.isFinite(residentPages)) return null
  return residentPages * pageSizeBytes
}
