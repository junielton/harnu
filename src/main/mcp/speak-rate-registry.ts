/**
 * T238 — the per-session rate window behind `speak`.
 *
 * The state a rate limit needs is, by definition, not pure: it is "what has this
 * caller done lately". So the DECISION stays pure (`checkSpeakRate` in
 * `speech-gate-core.ts`) and this module is only the map that remembers, mirroring
 * `agent-inflight-registry.ts` — a module-level `Map`, a reset for tests, and no
 * logic of its own.
 *
 * Keyed by the caller's own `sessionId` when it passed one, and by the folder
 * otherwise. That is the honest granularity available: the MCP transport is a
 * shared loopback with no per-session identity (the same reason `create_card`
 * stamps provenance without a session), so a session that declines to identify
 * itself shares a bucket with the rest of its folder rather than getting a free
 * one of its own.
 */

import { checkSpeakRate, SPEAK_RATE_LIMIT, SPEAK_RATE_WINDOW_MS } from '../speech-gate-core'

/** Timestamps of the utterances each key has STARTED, newest last. */
const windows = new Map<string, number[]>()

/**
 * Above this many keys, a call sweeps out every window that has fully aged out.
 * Without it the map keeps one entry per session that EVER spoke, for the life of
 * the app — small, but a leak all the same, and a fleet that churns worktrees
 * mints session ids indefinitely. The threshold keeps the sweep off the hot path
 * for any realistic fleet.
 */
const SWEEP_ABOVE = 256

function sweep(now: number, windowMs: number): void {
  if (windows.size <= SWEEP_ABOVE) return
  const cutoff = now - windowMs
  for (const [key, hits] of windows) {
    if (hits.every((t) => t <= cutoff)) windows.delete(key)
  }
}

/** The outcome of one attempt against the shared window. */
export interface SpeakRateResult {
  allowed: boolean
  /** Milliseconds until the caller may try again. `0` when allowed. */
  retryAfterMs: number
  /** How many more utterances this key may start in the current window. */
  remaining: number
}

/**
 * Record an attempt and say whether it may proceed.
 *
 * A REFUSED attempt is not stored, so a looping agent cannot push its own
 * recovery further away by hammering the verb — the window drains on wall-clock
 * time regardless of how often it is asked.
 */
export function recordSpeakAttempt(
  key: string,
  now: number,
  limit: number = SPEAK_RATE_LIMIT,
  windowMs: number = SPEAK_RATE_WINDOW_MS
): SpeakRateResult {
  sweep(now, windowMs)
  const verdict = checkSpeakRate(windows.get(key) ?? [], now, limit, windowMs)
  if (verdict.hits.length === 0) windows.delete(key)
  else windows.set(key, verdict.hits)
  return {
    allowed: verdict.allowed,
    retryAfterMs: verdict.retryAfterMs,
    remaining: Math.max(0, limit - verdict.hits.length)
  }
}

/** Drop every window. Test-only — the registry has no production reset. */
export function __resetSpeakRateForTests(): void {
  windows.clear()
}

/** How many keys the registry currently holds. Test-only — pins the sweep. */
export function __speakRateKeyCountForTests(): number {
  return windows.size
}
