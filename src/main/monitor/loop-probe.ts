/**
 * The event-loop heartbeat of the stall monitor (T697): a slow interval that turns each tick into a
 * {@link LoopSlice}. Pure node (no electron import), so the perf suite measures a job with exactly
 * the probe the product runs.
 *
 * How busy a slice was comes from two signals that need no cooperation from the loop:
 *  - the thread's own CPU time since the last tick (`process.threadCpuUsage()`): a task that computes;
 *  - the tick's lateness (it fired later than its period): a task that blocks without computing (a
 *    synchronous read waiting on the disk).
 * The larger of the two is the slice's busy time. `performance.eventLoopUtilization()` would be the
 * obvious source and is useless here: inside Electron's main process the loop is driven without ever
 * idling in libuv, so it reads 0 forever (verified live).
 *
 * One wake-up of the loop costs real CPU, far more inside Electron's main process than in plain node
 * (measured live, idle app: +1.3% of the main thread at 25 ms, so +0.6% at 50 ms), so the heartbeat is
 * slow. Detection does not need it fast: a slice that holds a computing task is classified by its exact
 * CPU time (`stall-core.ts`, solo slices); only a task that blocks without computing (a synchronous wait
 * on a child process or the disk) is measured to within one period.
 */

import { performance } from 'node:perf_hooks'
import type { LoopSlice } from './stall-core'

export const PROBE_PERIOD_MS = 50
/** A gap longer than this is the machine sleeping, not a stall: the slice is dropped. */
export const SUSPEND_GAP_MS = 120_000

export interface LoopProbe {
  stop(): void
  /** Share of the calling thread's time spent on-CPU since the previous call (or start), 0..1; `null` before any time passed. */
  busyFractionSinceLast(): number | null
}

/** Cumulative CPU time of the calling thread in ms; `null` when the runtime cannot say (node < 22.19). */
function threadCpuMs(): number | null {
  const fn = (process as { threadCpuUsage?: () => { user: number; system: number } }).threadCpuUsage
  if (typeof fn !== 'function') return null
  const u = fn.call(process)
  return (u.user + u.system) / 1000
}

export function startLoopProbe(opts: {
  onSlice(slice: LoopSlice): void
  periodMs?: number
  /** Called on every tick, after the slice: the stall watchdog's shared heartbeat counter. */
  onTick?(): void
}): LoopProbe {
  const periodMs = opts.periodMs ?? PROBE_PERIOD_MS
  let lastAt = performance.now()
  let lastCpu = threadCpuMs()
  let sinceAt = lastAt
  let sinceCpu = lastCpu

  const timer = setInterval(() => {
    const now = performance.now()
    const cpu = threadCpuMs()
    const wall = now - lastAt
    if (wall > SUSPEND_GAP_MS) {
      lastAt = now
      lastCpu = cpu
      opts.onTick?.()
      return
    }
    const late = Math.max(0, wall - periodMs)
    const computed = cpu !== null && lastCpu !== null ? cpu - lastCpu : 0
    // The watchdog's proof of life goes first: a stack sampled inside this tick must not be taken for
    // the stall that just ended.
    opts.onTick?.()
    opts.onSlice({
      startMs: lastAt,
      endMs: now,
      activeMs: Math.min(wall, Math.max(late, computed))
    })
    lastAt = now
    lastCpu = cpu
  }, periodMs)
  timer.unref()

  return {
    stop: () => clearInterval(timer),
    busyFractionSinceLast() {
      const cpu = threadCpuMs()
      const now = performance.now()
      const wall = now - sinceAt
      const busy = cpu !== null && sinceCpu !== null ? cpu - sinceCpu : null
      sinceAt = now
      sinceCpu = cpu
      if (wall <= 0 || busy === null) return null
      return Math.min(1, busy / wall)
    }
  }
}
