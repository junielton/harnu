/**
 * Process hygiene for the mission behavior eval (T358 S5).
 *
 * The harness starts processes that bill the operator: an isolated Harnu
 * instance, and the `claude` sessions that instance spawns. This module makes
 * sure every one of them dies, and that nothing else does:
 *
 *  - a LEDGER records the exact processes the harness started — the instance's
 *    process tree, identified by pid AND kernel start time, so a recycled pid is
 *    never mistaken for one of ours. node-pty puts each spawned `claude` in its
 *    own session and they are reparented to init once the instance exits, so the
 *    tree is snapshotted while it is still intact, not reconstructed afterwards;
 *  - ESCALATION sends SIGTERM, waits a grace period, and SIGKILLs whatever is
 *    still alive.
 *
 * The `/proc` readers and `kill` are injected, so the logic is unit-tested with a
 * fake process table (`tests/eval-mission-procs.test.ts`).
 */
import { readdirSync, readFileSync, readlinkSync } from 'node:fs'

// ---- /proc readers (Linux) ------------------------------------------------------

/**
 * Parse `/proc/<pid>/stat` text. The command name is parenthesized and may hold
 * spaces or parens, so fields are counted from the LAST `)`.
 *
 * @returns {{ pid: number, ppid: number, pgid: number, starttime: string } | null}
 */
export function parseStat(text) {
  const close = text.lastIndexOf(')')
  if (close === -1) return null
  const pid = Number(text.slice(0, text.indexOf(' ')))
  // After ") ": state(3) ppid(4) pgrp(5) session(6) … starttime(22).
  const rest = text
    .slice(close + 2)
    .trim()
    .split(/\s+/)
  const starttime = rest[22 - 3]
  if (!Number.isInteger(pid) || starttime === undefined) return null
  return { pid, ppid: Number(rest[1]), pgid: Number(rest[2]), starttime }
}

/** The real `/proc` readers. Every reader returns `null` for a process that is gone. */
export const procfs = {
  listPids() {
    try {
      return readdirSync('/proc')
        .filter((n) => /^\d+$/.test(n))
        .map(Number)
    } catch {
      return []
    }
  },
  readStat(pid) {
    try {
      return parseStat(readFileSync(`/proc/${pid}/stat`, 'utf8'))
    } catch {
      return null
    }
  },
  readCwd(pid) {
    try {
      return readlinkSync(`/proc/${pid}/cwd`)
    } catch {
      return null
    }
  }
}

/** `process.kill` that treats "already gone" as success. */
export function safeKill(target, signal) {
  try {
    process.kill(target, signal)
  } catch {
    /* gone, or not ours */
  }
}

// ---- the ledger -----------------------------------------------------------------

/**
 * Records the processes the harness started. `trackRoot(pid)` names a process
 * the harness spawned itself; `snapshot()` adds every current descendant of a
 * recorded process. Only recorded processes are ever signalled.
 */
export function createLedger({ fs = procfs, kill = safeKill } = {}) {
  /** key `pid:starttime` → { pid, ppid, starttime } */
  const known = new Map()
  const key = (s) => `${s.pid}:${s.starttime}`

  function isAlive(entry) {
    const s = fs.readStat(entry.pid)
    return s !== null && s.starttime === entry.starttime
  }

  /** Every descendant of `rootKeys` in the recorded tree (the roots included). */
  function subtreeOf(rootKeys) {
    const out = new Set(rootKeys)
    let grew = true
    while (grew) {
      grew = false
      for (const [k, e] of known) {
        if (out.has(k)) continue
        const parent = [...known.values()].find(
          (p) => p.pid === e.ppid && out.has(key(p)) && p !== e
        )
        if (parent) {
          out.add(k)
          grew = true
        }
      }
    }
    return [...out].map((k) => known.get(k)).filter(Boolean)
  }

  return {
    trackRoot(pid) {
      const s = fs.readStat(pid)
      if (s) known.set(key(s), { pid: s.pid, ppid: s.ppid, starttime: s.starttime })
    },
    /** Add every live process whose parent is a live, already-recorded process. */
    snapshot() {
      const table = fs
        .listPids()
        .map((pid) => fs.readStat(pid))
        .filter(Boolean)
      let grew = true
      while (grew) {
        grew = false
        const livePids = new Set([...known.values()].filter(isAlive).map((e) => e.pid))
        for (const s of table) {
          if (known.has(key(s)) || !livePids.has(s.ppid)) continue
          known.set(key(s), { pid: s.pid, ppid: s.ppid, starttime: s.starttime })
          grew = true
        }
      }
    },
    /** Recorded processes still alive (same pid AND start time). */
    alive() {
      return [...known.values()].filter(isAlive)
    },
    /**
     * Recorded, live processes whose cwd is inside `dir`, plus everything they
     * spawned — the `claude` children a scenario ran in its sandbox, but never
     * the instance's own Electron helpers.
     */
    aliveUnder(dir) {
      const inDir = [...known.values()].filter((e) => {
        const cwd = fs.readCwd(e.pid)
        return isAlive(e) && cwd !== null && (cwd === dir || cwd.startsWith(dir + '/'))
      })
      return subtreeOf(inDir.map(key)).filter(isAlive)
    },
    /** A kill target for one recorded process. */
    target(entry) {
      return {
        label: `pid ${entry.pid}`,
        alive: () => isAlive(entry),
        send: (signal) => {
          if (isAlive(entry)) kill(entry.pid, signal)
        }
      }
    }
  }
}

/**
 * A kill target for a whole process group the harness started with
 * `detached: true` (its pgid is the spawned pid). `process.kill(-pgid, 0)`
 * throws ESRCH once no member is left.
 */
export function groupTarget(pgid, { kill = process.kill.bind(process) } = {}) {
  return {
    label: `process group ${pgid}`,
    alive: () => {
      try {
        kill(-pgid, 0)
        return true
      } catch (e) {
        return e.code === 'EPERM'
      }
    },
    send: (signal) => {
      try {
        kill(-pgid, signal)
      } catch {
        /* gone */
      }
    }
  }
}

// ---- escalation -----------------------------------------------------------------

/**
 * SIGTERM every live target, wait up to `graceMs` for them to exit, then SIGKILL
 * the survivors.
 *
 * @returns {Promise<{ terminated: string[], killed: string[] }>}
 */
export async function escalate(
  targets,
  { graceMs = 5_000, pollMs = 100, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}
) {
  const live = targets.filter((t) => t.alive())
  for (const t of live) t.send('SIGTERM')
  for (let waited = 0; waited < graceMs && live.some((t) => t.alive()); waited += pollMs) {
    await sleep(pollMs)
  }
  const survivors = live.filter((t) => t.alive())
  for (const t of survivors) t.send('SIGKILL')
  return {
    terminated: live.filter((t) => !survivors.includes(t)).map((t) => t.label),
    killed: survivors.map((t) => t.label)
  }
}
