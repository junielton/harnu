/**
 * The event-loop heartbeat of the stall monitor (T697): a short interval that turns the loop's own
 * utilisation counters into {@link LoopSlice}s. Pure node (no electron import), so the perf suite
 * measures a job with exactly the probe the product runs.
 *
 * Each tick asks `performance.eventLoopUtilization()` how much of the time since the last tick the
 * loop spent running JavaScript. A single long task and a flood of short ones both show up as a
 * stretch of fully busy slices. The probe's own cost is one `setInterval` callback per period.
 */

import { performance } from 'node:perf_hooks'
import type { LoopSlice } from './stall-core'

/**
 * One wake-up of the event loop costs real CPU (measured: ~0.6% of a thread at 20 ms, ~1.8% at 5 ms,
 * even for an empty callback), so the heartbeat is slow. Detection does not need it fast: a slice that
 * holds a task is classified by its exact busy time (`stall-core.ts`, solo slices).
 */
export const PROBE_PERIOD_MS = 25

export interface LoopProbe {
  stop(): void
  /** Event-loop utilisation (0..1) since the previous call (or since start). `null` before any time has passed. */
  busyFractionSinceLast(): number | null
}

export function startLoopProbe(opts: {
  onSlice(slice: LoopSlice): void
  periodMs?: number
  /** Called on every tick, after the slice: the stall watchdog's shared heartbeat counter. */
  onTick?(): void
}): LoopProbe {
  const periodMs = opts.periodMs ?? PROBE_PERIOD_MS
  let lastElu = performance.eventLoopUtilization()
  let lastAt = performance.now()
  let sinceLastElu = lastElu

  const timer = setInterval(() => {
    const now = performance.now()
    const elu = performance.eventLoopUtilization()
    const delta = performance.eventLoopUtilization(elu, lastElu)
    opts.onSlice({ startMs: lastAt, endMs: now, activeMs: delta.active })
    lastElu = elu
    lastAt = now
    opts.onTick?.()
  }, periodMs)
  timer.unref()

  return {
    stop: () => clearInterval(timer),
    busyFractionSinceLast() {
      const elu = performance.eventLoopUtilization()
      const delta = performance.eventLoopUtilization(elu, sinceLastElu)
      sinceLastElu = elu
      const total = delta.active + delta.idle
      return total > 0 ? delta.active / total : null
    }
  }
}
