import { readdirSync, readFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { parseProcStat, parseProcStatm } from './proc-parse'

/**
 * `/proc` walk (T127) — the thin shell behind `proc-parse.ts`'s pure parsers. Reads
 * ONLY `/proc`, a memory-backed pseudo-filesystem — the one disk this feature is
 * allowed to touch (spec §2). Never `scanFolders()`, never a JSONL, never a git probe.
 *
 * Spec: docs/specs/T127-system-monitor.md §6.2.
 */

/** One process reading, ready for `cpu-delta.ts` + `aggregate.ts`. */
export interface ProcRawSample {
  pid: number
  ppid: number
  comm: string
  utime: number
  stime: number
  /** `null` when `/proc/<pid>/statm` couldn't be read (race with the process exiting). */
  rssBytes: number | null
}

/**
 * Jiffies per second (`sysconf(_SC_CLK_TCK)`) — effectively always 100 on every Linux
 * architecture Node/Electron targets. No Node API surfaces this value, so it's a
 * documented constant rather than a syscall, mirroring `PAGE_SIZE_BYTES` in `proc-parse.ts`.
 */
export const TICKS_PER_SEC = 100

/** Machine core count, for `cpu-delta.ts`'s defensive clamp. Never less than 1. */
export function coreCount(): number {
  return Math.max(1, cpus().length)
}

/**
 * Walk every readable `/proc/<pid>` entry right now. Best-effort: a pid that exits
 * between the `readdirSync` and its `readFileSync` calls (ESRCH/ENOENT race — expected
 * under a live, churning process tree) is silently skipped, not treated as an error.
 * Returns `[]` if `/proc` itself can't be read (non-Linux, or a sandboxed environment).
 */
export function readProcTable(): ProcRawSample[] {
  let names: string[]
  try {
    names = readdirSync('/proc')
  } catch {
    return []
  }
  const out: ProcRawSample[] = []
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue
    try {
      const stat = parseProcStat(readFileSync(`/proc/${name}/stat`, 'utf8'))
      if (!stat) continue
      let rssBytes: number | null = null
      try {
        rssBytes = parseProcStatm(readFileSync(`/proc/${name}/statm`, 'utf8'))
      } catch {
        rssBytes = null
      }
      out.push({ ...stat, rssBytes })
    } catch {
      // Process exited mid-walk, or /proc/<pid>/stat is unreadable — skip it.
    }
  }
  return out
}

/**
 * The platform seam. Linux gets the real `/proc` walk; macOS/Windows get a
 * `NullSampler` that reports no processes at all — the Sessions group there ships
 * showing state (live/parked, idle reasoning) but no consumption numbers, until
 * someone writes an adapter. `pidusage` was considered and rejected (spec §6.2): on
 * macOS/Windows it shells out to `ps`/`wmic` on every tick, and a monitor that spawns
 * a process per tick edges toward being the disease it diagnoses.
 */
export interface ProcessSampler {
  readonly supported: boolean
  /** One sampling tick over the whole `/proc` table. `[]` when `!supported`. */
  tick(): ProcRawSample[]
}

class LinuxProcessSampler implements ProcessSampler {
  readonly supported = true
  tick(): ProcRawSample[] {
    return readProcTable()
  }
}

class NullProcessSampler implements ProcessSampler {
  readonly supported = false
  tick(): ProcRawSample[] {
    return []
  }
}

export function createSampler(): ProcessSampler {
  return process.platform === 'linux' ? new LinuxProcessSampler() : new NullProcessSampler()
}
