/**
 * T294 (T291 U4) — pure display helpers for the Scheduler takeover.
 *
 * No Vue import so this unit-tests in the plain `node` vitest environment,
 * matching `system-monitor-format.ts`. `formatCost(undefined)` follows that
 * same module's rule: an unknown reading reads as an em-dash, never a false
 * `$0.000` — a worker that has never run has no cost yet, and zero is a lie.
 */

import type { RunStatus, Worker } from '../../../preload'

/**
 * Mirrors `FAILURE_STREAK_LIMIT` in `src/main/scheduler-core.ts` (the pure
 * core is main-process-only and never bundled into the renderer, per the
 * process-boundary rule in CLAUDE.md — every other cross-boundary reference
 * here goes through the preload's re-exported TYPES only, never a runtime
 * value from main). A worker's `failureStreak` never exceeds this because
 * `nextFailureState` disables the worker the moment it's reached.
 */
const FAILURE_STREAK_LIMIT = 3

export type WorkerDisplayState = 'running' | 'failed' | 'disabled' | 'off' | 'waiting'

/** Everything `workerState` needs beyond the worker's own persisted fields. */
export interface WorkerRuntimeInfo {
  /** A tick for this worker is alive right now. */
  running: boolean
  /** Epoch-ms of the worker's next scheduled tick, when known. */
  nextAt?: number
  /** The status of the most recent finished run, when there is one. */
  lastStatus?: RunStatus
}

/**
 * The five states the mockup draws, in precedence order: running beats
 * everything (it's happening right now); a disabled worker that hit the
 * failure-streak limit reads as `disabled`, not `off`, so the operator can
 * tell "I turned this off" from "this turned itself off" at a glance; a
 * worker the operator switched off reads as `off`; a still-armed worker
 * whose last tick failed reads as `failed`; otherwise it's just `waiting`
 * for its next cadence.
 */
export function workerState(worker: Worker, info: WorkerRuntimeInfo): WorkerDisplayState {
  if (info.running) return 'running'
  if (!worker.enabled) {
    return worker.failureStreak >= FAILURE_STREAK_LIMIT ? 'disabled' : 'off'
  }
  if (info.lastStatus === 'error' || info.lastStatus === 'timeout') return 'failed'
  return 'waiting'
}

/**
 * A countdown to the next tick, at the coarsest unit that stays legible: `now`
 * for anything already due, seconds under a minute (the 30s ticker beat is
 * otherwise invisible), then minutes, then hours.
 */
export function formatCountdown(ms: number): string {
  if (ms <= 0) return 'now'
  const totalSeconds = Math.floor(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const totalMinutes = Math.floor(ms / 60_000)
  if (totalMinutes < 60) return `${totalMinutes}m`
  return `${Math.floor(ms / 3_600_000)}h`
}

/** Three decimals — the scale a single tick lives at. `undefined` ⇒ em-dash. */
export function formatCost(usd: number | undefined): string {
  if (usd === undefined) return '—'
  return `$${usd.toFixed(3)}`
}

/** Seconds under a minute, then `Nm Ss`. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}m ${seconds}s`
}
