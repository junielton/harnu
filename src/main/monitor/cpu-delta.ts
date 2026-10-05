/**
 * CPU% from two `/proc` jiffie samples (T127). PURE — no `Date.now()`, no
 * `/proc` reads. `/proc` reports CUMULATIVE jiffies since process start, so CPU%
 * is the derivative between two samples over wall-clock time — the caller supplies
 * both timestamps as data, never reads the clock itself.
 *
 * Convention: unnormalized, Chrome-Task-Manager / `htop`-default style — a process
 * pegging 2 full cores on an 8-core box reports ~200%, not ~25%. `coreCount` is NOT
 * a divisor; it is a defensive upper clamp (`coreCount * 100`) against a bogus delta
 * (e.g. a wall-clock hiccup or a jiffie counter that raced ahead of the sample
 * window), so a transient anomaly can't render as an absurd four-digit percentage.
 *
 * Spec: docs/specs/T127-system-monitor.md §6.1.
 */

/** One `/proc/<pid>/stat` CPU-time reading, timestamped by the caller. */
export interface CpuTimeSample {
  /** Cumulative user-mode jiffies at `atMs`. */
  utime: number
  /** Cumulative kernel-mode jiffies at `atMs`. */
  stime: number
  /** Wall-clock epoch ms this sample was taken — supplied by the caller, never read internally. */
  atMs: number
}

/**
 * CPU% between two samples of the same pid.
 *
 * @param prev The prior sample, or `null` for a pid's first-ever tick (no delta yet).
 * @param curr The current sample.
 * @param ticksPerSec Jiffies per second (`sysconf(_SC_CLK_TCK)` — effectively always 100 on Linux).
 * @param coreCount Machine core count, used only as a defensive clamp (see module doc).
 * @returns `null` when there is no prior sample, the elapsed wall time is not
 *   positive, or the jiffie counters went backward (a pid-reuse artifact — jiffies
 *   never decrease for a live process).
 */
export function cpuPercent(
  prev: CpuTimeSample | null,
  curr: CpuTimeSample,
  ticksPerSec: number,
  coreCount: number
): number | null {
  if (prev === null) return null
  if (ticksPerSec <= 0) return null
  const deltaMs = curr.atMs - prev.atMs
  if (deltaMs <= 0) return null
  const deltaJiffies = curr.utime + curr.stime - (prev.utime + prev.stime)
  if (deltaJiffies < 0) return null
  const deltaCpuSeconds = deltaJiffies / ticksPerSec
  const deltaWallSeconds = deltaMs / 1000
  const pct = (deltaCpuSeconds / deltaWallSeconds) * 100
  const clampMax = Math.max(1, coreCount) * 100
  return Math.min(pct, clampMax)
}
