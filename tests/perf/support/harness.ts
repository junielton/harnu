/**
 * Measures one job or computed against the scale fixture (T697, performance contract P1/P4/P8).
 *
 * A job is measured with the SAME probe the product runs (`startLoopProbe` + the busy-run tracker),
 * so "a stall over 50 ms" means the same thing in CI and in the System Monitor: the longest run of
 * a busy event loop, whether it is one long task or tens of thousands of short ones back to back.
 * Two numbers come out of a run, plus the cost used for the super-linear check:
 *
 *   busyRunMs  longest uninterrupted busy stretch (must stay under 50 ms)
 *   cpuMs      process CPU (user + system, every thread) spent during the run
 *   wallMs     elapsed time
 *
 * A job that is still running at `deadlineMs` is cut off (`completed: false`): a job that cannot
 * finish in that time has already failed, and the suite must stay fast on a regressed branch.
 */

import { performance } from 'node:perf_hooks'
import { createBusyRunTracker, STALL_THRESHOLD_MS } from '../../../src/main/monitor/stall-core'
import { startLoopProbe } from '../../../src/main/monitor/loop-probe'
import { startFsCounter } from './fs-counter'
import { buildScaleFixture, scaled, REFERENCE_SCALE, type ScaleFixture } from './scale-fixture'

export interface Measurement {
  busyRunMs: number
  cpuMs: number
  wallMs: number
  /**
   * What the growth and budget checks use: wall time for a synchronous call (process CPU is noisy at a
   * few milliseconds: GC and JIT threads count), process CPU for async work (the threadpool counts).
   */
  costMs: number
  /** Filesystem calls the run made (exact, machine-independent). */
  fsCalls: number
  completed: boolean
}

/** `run` gets a `expired()` it should consult between units of work, and a `signal` flag-equivalent. */
export interface JobContext {
  fixture: ScaleFixture
  /** True once the deadline passed: a job wrapper uses it to stop doing real work. */
  expired(): boolean
}

export interface PerfCase {
  /** Stable id, also the key in KNOWN_OFFENDERS. */
  id: string
  thread: 'main' | 'renderer'
  /** What it is, in a line: shown in the failure message. */
  describes: string
  /**
   * Prepares anything per fixture (env, deps) and returns the thing to measure. Async jobs resolve
   * when the work is done; sync computeds just return.
   */
  prepare(ctx: JobContext): (() => Promise<void> | void) | Promise<() => Promise<void> | void>
}

const cpuNow = (): number => {
  const u = process.cpuUsage()
  return (u.user + u.system) / 1000
}

/** Runs `fn` once and measures it. */
export async function measureOnce(
  fn: () => Promise<void> | void,
  deadlineMs: number,
  expiredRef: { value: boolean }
): Promise<Measurement> {
  let busyRunMs = 0
  const tracker = createBusyRunTracker({
    thresholdMs: 1,
    onRun: (r) => {
      busyRunMs = Math.max(busyRunMs, r.durationMs)
    }
  })
  const probe = startLoopProbe({ onSlice: (s) => tracker.push(s), periodMs: 2 })
  const counter = startFsCounter()
  const cpu0 = cpuNow()
  const t0 = performance.now()
  expiredRef.value = false
  let completed = true
  let sync = true
  const timer = setTimeout(() => {
    expiredRef.value = true
    completed = false
  }, deadlineMs)
  try {
    const result = fn()
    if (result instanceof Promise) {
      sync = false
      await result
    }
  } finally {
    clearTimeout(timer)
  }
  const fsCalls = counter.stop()
  const wallMs = performance.now() - t0
  const cpuMs = cpuNow() - cpu0
  // Let the probe see the quiet loop after the job so the last busy run closes.
  await new Promise((r) => setTimeout(r, 20))
  tracker.flush()
  probe.stop()
  // A synchronous task cannot be observed by the probe while it runs, but it shows as one slice
  // as long as the task: the same value, taken directly.
  busyRunMs = Math.max(busyRunMs, 0)
  return { busyRunMs, cpuMs, wallMs, costMs: sync ? wallMs : cpuMs, fsCalls, completed }
}

export interface SizeResult {
  factor: number
  spec: ScaleFixture['spec']
  best: Measurement
}

export interface CaseResult {
  id: string
  small: SizeResult
  reference: SizeResult
  /** cost(reference) / cost(small), `null` when the reference cost is under the noise floor or a run did not finish. */
  growth: number | null
  /** fsCalls(reference) / fsCalls(small), `null` when the reference run made few calls or a run did not finish. */
  fsGrowth: number | null
  /** What a linear job would cost more at the reference size (reference factor / small factor). */
  linear: number
}

export const SMALL_FACTOR = 0.25
export const REFERENCE_FACTOR = 1
/** Below this CPU a ratio is noise. */
export const NOISE_FLOOR_MS = 8
/** Allowed excess over linear before growth is called super-linear. */
export const GROWTH_TOLERANCE = 1.5
/** Below this many fs calls a ratio is not worth reading. */
export const FS_FLOOR = 200
/**
 * CPU one run of a job may burn at reference scale. A job that yields between every await never has a
 * 50 ms task, yet a probe of every slug for every session still spends seconds of the main thread's
 * time (BUG-261 measured 20 s of saturation): total cost per run is the second limit.
 */
export const CPU_BUDGET_MS = 250
const REPEATS = 6

async function runSize(c: PerfCase, factor: number, deadlineMs: number): Promise<SizeResult> {
  const spec = factor === 1 ? REFERENCE_SCALE : scaled(REFERENCE_SCALE, factor)
  const fixture = await buildScaleFixture(spec)
  const expiredRef = { value: false }
  const ctx: JobContext = { fixture, expired: () => expiredRef.value }
  try {
    let best: Measurement | null = null
    for (let i = 0; i < REPEATS; i++) {
      const run = await c.prepare(ctx)
      const m = await measureOnce(run, deadlineMs, expiredRef)
      if (!m.completed) {
        best = m // already over the deadline: another run adds only time
        break
      }
      if (i === 0) continue // the first run only warms the JIT and the page cache
      // Best = the run with the smallest busy run, then the smallest CPU: noise only adds.
      if (
        !best ||
        m.busyRunMs < best.busyRunMs ||
        (m.busyRunMs === best.busyRunMs && m.costMs < best.costMs)
      )
        best = m
    }
    return { factor, spec, best: best as Measurement }
  } finally {
    await fixture.cleanup()
  }
}

export async function measureCase(c: PerfCase, deadlineMs = 1500): Promise<CaseResult> {
  const small = await runSize(c, SMALL_FACTOR, deadlineMs)
  const reference = await runSize(c, REFERENCE_FACTOR, deadlineMs)
  const comparable =
    small.best.completed && reference.best.completed && reference.best.costMs >= NOISE_FLOOR_MS
  const fsComparable =
    small.best.completed && reference.best.completed && reference.best.fsCalls >= FS_FLOOR
  return {
    id: c.id,
    small,
    reference,
    fsGrowth: fsComparable ? reference.best.fsCalls / Math.max(small.best.fsCalls, 1) : null,
    growth: comparable ? reference.best.costMs / Math.max(small.best.costMs, 0.5) : null,
    linear: REFERENCE_FACTOR / SMALL_FACTOR
  }
}

/** The reasons a result violates the contract; empty means it passes. */
export function violations(r: CaseResult): string[] {
  const out: string[] = []
  for (const s of [r.small, r.reference]) {
    if (s.best.busyRunMs > STALL_THRESHOLD_MS) {
      out.push(
        `a task of ${Math.round(s.best.busyRunMs)} ms at ${s.factor}x scale (hard limit ${STALL_THRESHOLD_MS} ms)`
      )
    }
    if (s.best.costMs > CPU_BUDGET_MS) {
      out.push(
        `burned ${Math.round(s.best.costMs)} ms of CPU in one run at ${s.factor}x scale (budget ${CPU_BUDGET_MS} ms)`
      )
    }
    if (!s.best.completed) out.push(`did not finish within the deadline at ${s.factor}x scale`)
  }
  if (r.growth !== null && r.growth > r.linear * GROWTH_TOLERANCE) {
    out.push(
      `cost grew ${r.growth.toFixed(1)}x for a ${r.linear}x larger fixture (super-linear; limit ${(r.linear * GROWTH_TOLERANCE).toFixed(1)}x)`
    )
  }
  if (r.fsGrowth !== null && r.fsGrowth > r.linear * GROWTH_TOLERANCE) {
    out.push(
      `filesystem calls grew ${r.fsGrowth.toFixed(1)}x (${r.small.best.fsCalls} → ${r.reference.best.fsCalls}) for a ${r.linear}x larger fixture (limit ${(r.linear * GROWTH_TOLERANCE).toFixed(1)}x)`
    )
  }
  return out
}

export function describeResult(r: CaseResult): string {
  const f = (s: SizeResult): string =>
    `${s.factor}x: run ${Math.round(s.best.busyRunMs)} ms · cost ${Math.round(s.best.costMs)} ms · wall ${Math.round(s.best.wallMs)} ms · fs ${s.best.fsCalls} calls${s.best.completed ? '' : ' (cut off)'}`
  return `${r.id}\n  ${f(r.small)}\n  ${f(r.reference)}\n  growth ${r.growth === null ? 'n/a' : r.growth.toFixed(1) + 'x'} (linear ${r.linear}x)`
}
