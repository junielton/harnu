/**
 * The stall monitor of the Electron main thread, plus the one aggregate and the one log both
 * threads feed (T697, performance contract P1/P9). Pure node: electron-bound wiring (the IPC
 * channels, the window) lives in `sampler.ts`.
 *
 * What runs on the main thread, all of it measured under the 1% overhead limit:
 *  - a 5 ms loop probe (`loop-probe.ts`) folding event-loop utilisation into busy runs; a run over
 *    50 ms is a stall;
 *  - `withOwner` wrappers around every IPC handler and interval callback (`stall-owner.ts`) that
 *    keep the last few hundred owned spans;
 *  - a watchdog worker (`stall-watchdog.ts`) that samples the stack of a stall nobody owns.
 *
 * `HARNU_STALL_MONITOR=off` turns all of it off.
 */

import { performance } from 'node:perf_hooks'
import {
  attribute,
  createBusyRunTracker,
  createStallAggregator,
  sanitizeRecord,
  type StallRecord,
  type StallSummary,
  type Thread
} from './stall-core'
import { PROBE_PERIOD_MS, startLoopProbe, type LoopProbe } from './loop-probe'
import { createStallLog, type StallLog } from './stall-log'
import { patchSetInterval, spans, withOwner, wrapIpcMain, type IpcMainLike } from './stall-owner'
import { startStallWatchdog, type StallWatchdog } from './stall-watchdog'

export interface StallMonitor {
  /** Both threads' stalls in the last hour. */
  summary(nowMs?: number): StallSummary
  /** Event-loop utilisation of the main thread since the last call, 0..100, `null` when unknown. */
  mainBusyPct(): number | null
  /** Milliseconds the renderer spent in reported long tasks during the last `spanMs`. */
  rendererStalledMs(spanMs: number, nowMs?: number): number
  /** Records reported by the renderer (untrusted: clamped, rate limited). */
  reportRenderer(batch: unknown): number
  /**
   * Blocks the main thread for `ms` as owner `diagnostic:injected-stall` (tests and demos).
   * `cpu: true` spins until the thread has consumed `ms` of CPU time instead of `ms` of wall time:
   * the probe measures a computing stall by CPU time, so on a loaded machine (a descheduled
   * thread) only the CPU form is guaranteed to read as at least `ms`. Wall time is still capped.
   */
  injectMainStall(ms: number, opts?: { cpu?: boolean }): void
  stop(): Promise<void>
}

export interface StallMonitorOptions {
  /** `<userData>`: where `stalls.jsonl` lives. */
  logDir: string
  /** Electron's ipcMain, wrapped so handlers name themselves; omitted in tests. */
  ipcMain?: IpcMainLike
  /** Patch `setInterval` so interval jobs name themselves. Default true. */
  patchTimers?: boolean
  /** Stack sampling of unowned stalls. Default true. */
  watchdog?: boolean
}

/** The renderer may report this many records per second; the rest are dropped. */
const RENDERER_RATE_PER_SEC = 20
const RENDERER_MAX_BATCH = 50
/** Wall-clock ceiling of a CPU-time injected stall: a thread starved this long is not a test of ours. */
const MAX_INJECT_MS = 5_000

/** Cumulative CPU time of the calling thread in ms; `null` when the runtime cannot say (node < 22.19). */
function threadCpuMs(): number | null {
  const fn = (process as { threadCpuUsage?: () => { user: number; system: number } }).threadCpuUsage
  if (typeof fn !== 'function') return null
  const u = fn.call(process)
  return (u.user + u.system) / 1000
}

export const isStallMonitorDisabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.HARNU_STALL_MONITOR === 'off'

export function startStallMonitor(opts: StallMonitorOptions): StallMonitor {
  const aggregator = createStallAggregator()
  const log: StallLog = createStallLog(opts.logDir)
  const undo: Array<() => void> = []
  if (opts.ipcMain) undo.push(wrapIpcMain(opts.ipcMain))
  if (opts.patchTimers !== false) undo.push(patchSetInterval(globalThis as never))

  const watchdog: StallWatchdog | null =
    opts.watchdog === false
      ? null
      : startStallWatchdog({ thresholdMs: Math.round(PROBE_PERIOD_MS * 1.6) })

  const record = (r: StallRecord): void => {
    aggregator.add(r)
    log.append(r)
  }

  const tracker = createBusyRunTracker({
    onRun(run) {
      const wallEnd = performance.timeOrigin + run.endMs
      const wallStart = performance.timeOrigin + run.startMs
      const named = attribute(run, spans, watchdog?.sampled(wallStart, wallEnd) ?? null)
      record({
        atMs: Math.round(wallEnd),
        thread: 'main',
        durationMs: Math.round(run.durationMs),
        ...named
      })
    }
  })
  const probe: LoopProbe = startLoopProbe({
    onSlice: (s) => tracker.push(s),
    onTick: () => watchdog?.heartbeat()
  })

  // Seed the last hour from the previous run's log, without ever blocking boot.
  void log
    .load(Date.now())
    .then((rows) => {
      for (const r of rows) aggregator.add(r)
    })
    .catch(() => undefined)

  let windowStart = 0
  let windowCount = 0

  return {
    summary: (nowMs = Date.now()) => aggregator.summary(nowMs),
    mainBusyPct() {
      const f = probe.busyFractionSinceLast()
      return f === null ? null : Math.round(f * 1000) / 10
    },
    rendererStalledMs: (spanMs, nowMs = Date.now()) =>
      aggregator.stalledMs('renderer', nowMs, spanMs),
    reportRenderer(batch) {
      if (!Array.isArray(batch)) return 0
      const now = Date.now()
      if (now - windowStart >= 1000) {
        windowStart = now
        windowCount = 0
      }
      let accepted = 0
      for (const raw of batch.slice(0, RENDERER_MAX_BATCH)) {
        if (windowCount >= RENDERER_RATE_PER_SEC) break
        const rec = sanitizeRecord(raw, now)
        if (!rec) continue
        // The renderer speaks only for itself.
        record({ ...rec, thread: 'renderer' as Thread })
        windowCount++
        accepted++
      }
      return accepted
    },
    injectMainStall(ms, opts) {
      withOwner('diagnostic:injected-stall', 'job', () => {
        const want = Math.min(Math.max(ms, 0), 5_000)
        const wallEnd = performance.now() + (opts?.cpu ? MAX_INJECT_MS : want)
        const cpu0 = opts?.cpu ? threadCpuMs() : null
        if (cpu0 === null) {
          const end = performance.now() + want
          while (performance.now() < end) {
            /* hold the thread */
          }
          return
        }
        while (performance.now() < wallEnd) {
          const now = threadCpuMs()
          if (now === null || now - cpu0 >= want) break
        }
      })
    },
    async stop() {
      probe.stop()
      tracker.flush()
      watchdog?.stop()
      for (const u of undo.reverse()) u()
      await log.dispose()
    }
  }
}
