/**
 * Pure decision core for the agent pre-prompt injection watchdog.
 *
 * The drop-fix (`acquireInjectionTarget` in `components/prompt-inject-gate.ts`)
 * stops a queued pre-prompt from being DISCARDED when the delivery attempt can't
 * resolve a reachable PTY (e.g. mid-MCP-reconnect) — it leaves the prompt queued
 * instead. But nothing re-attempts delivery, and the existing dead-synthetic
 * reaper (`synthetic-reaper.ts`) is blind to this exact failure: its `bootVerdict`
 * already returns `booted` the instant a PTY is live, with no notion of whether
 * the queued prompt was ever acquired. A session can boot a perfectly live REPL
 * and sit there blank forever, invisible to every existing guard.
 *
 * This module is that missing verdict: given a live probe plus a retry budget,
 * decide whether to keep waiting, re-attempt, or give up and surface a visible
 * failure. Framework-free, no Pinia/DOM dependency — unit-tests in the `node`
 * vitest env exactly like `synthetic-reaper.ts` (`tests/injection-watchdog.test.ts`).
 * The store/shell inject the live signals and own the timer that drives repeated
 * calls into this pure function; this file owns only the verdict arithmetic.
 *
 * BUG-61: the original verdict (`docs/specs/2026-07-15-preprompt-injection-watchdog.md`
 * §5.2) inferred delivery from queue membership — `!promptQueued → 'delivered'`,
 * `!ptyLive → 'delivered'` — but `acquireInjectionTarget` **consumes** the prompt
 * from the queue before `createInjectGate` actually pastes it, and the gate can
 * still hold it for up to `capMs` or drop it on a `pty:exit` cancel. Two orphaned
 * sessions in the 2026-07-20 incident sat blank forever while this watchdog
 * reported them `delivered`. The fix (T172) instruments the injection path with a
 * real ledger (`injection-ledger.ts`) recording whether the paste actually landed
 * — `injectionVerdict` now reads that signal (`InjectionProbe.injected`) instead
 * of guessing from queue/PTY membership.
 *
 * See `docs/specs/2026-07-15-preprompt-injection-watchdog.md` for the full
 * design (failure modes, retry wiring, why `retrySyntheticBoot` is NOT reused) and
 * `docs/reports/2026-07-20-orphan-spawn-postmortem.md` (defect D2) for the incident.
 */

/** The watchdog's four-way verdict for a tracked injection at a given instant. */
export type InjectionVerdict = 'delivered' | 'pending' | 'retry' | 'undelivered'

/** The live signals + retry budget the shell resolves at each tick. */
export interface InjectionProbe {
  /** Is the pre-prompt still queued (`sessions.hasAgentPrompt(id)`)? `false` once
   * acquired — kept for context, but no longer the delivery signal itself: see
   * `injected` below. (BUG-61: `acquireInjectionTarget` consumes the prompt from
   * the queue well before `createInjectGate` actually pastes it, so "not queued"
   * does NOT mean "delivered" — the gate can still hold it for up to `capMs` or
   * drop it entirely on a `pty:exit` cancel.) */
  promptQueued: boolean
  /** Did the bracketed paste actually land in the PTY — T172's
   * `injectionLedger.wasInjected(id)`. This is the only signal that means true
   * delivery. Optional so a probe that hasn't wired the ledger is treated as
   * not-yet-confirmed rather than assumed delivered. */
  injected?: boolean
  /** BUG-85: is an inject gate currently armed and waiting for a composer-ready
   * hook? A retry while one is waiting is a guaranteed no-op — `armInjectGate`
   * returns immediately because the prompt is already consumed — so spending the
   * attempt budget there is what escalated a healthy cold boot to
   * `prompt_undelivered` after ~3 s. Optional: a probe that doesn't track gates
   * behaves exactly as before. */
  gateArmed?: boolean
  /** Is there still a live PTY to inject into? `false` can mean two different
   * things this verdict must not conflate: the process exited NORMALLY after
   * already receiving its prompt (see `injected`), or it died/was cancelled
   * BEFORE ever injecting — not this watchdog's success case either way. */
  ptyLive: boolean
  /** Milliseconds since the watchdog armed (the PTY went live). */
  elapsedMs: number
  /** Re-arm attempts already spent (each a fresh `armInjectGate` call). */
  attempts: number
  /** Backoff between attempts. */
  retryEveryMs: number
  /** Bounded attempt budget before escalating to a visible failure. */
  maxAttempts: number
}

/**
 * Decide a tracked injection's fate. Pure and monotonic in `elapsedMs`/`attempts`:
 *
 *  - `delivered` — the ledger confirms the bracketed paste actually landed
 *    (`injected`). Checked FIRST, and independent of `ptyLive`: a session that
 *    finishes its work normally exits with a dead PTY on its very next tick, and
 *    must read as delivered, not escalated.
 *  - `undelivered` — no confirmed injection, and either the PTY is already gone
 *    (died, or was cancelled on `pty:exit`, before ever pasting — there is
 *    nothing left to retry into) or the attempt budget is spent. Checked before
 *    the elapsed boundary so a stale `elapsedMs` that happens to land on a retry
 *    boundary can never resurrect a spent budget.
 *  - `pending` (armed) — an inject gate is still waiting for a composer-ready
 *    hook. Retrying under it is a no-op and escalating under it is wrong, so the
 *    budget is frozen until the gate settles (BUG-85).
 *  - `retry` — still live, no confirmed injection, budget remains, and
 *    `elapsedMs` has crossed the NEXT backoff boundary: `(attempts + 1) *
 *    retryEveryMs`.
 *  - `pending` — still within the current backoff window; keep waiting.
 */
export function injectionVerdict(p: InjectionProbe): InjectionVerdict {
  if (p.injected) return 'delivered'
  if (!p.ptyLive) return 'undelivered'
  // BUG-85: a gate is waiting on a real signal — checked AFTER the two terminal
  // facts above (a delivered or dead session is decided no matter what is armed)
  // and BEFORE the budget arithmetic. Bounded by construction: every gate settles
  // by its own `capMs` or on `pty:exit`, so this can never wait forever.
  if (p.gateArmed) return 'pending'
  if (p.attempts >= p.maxAttempts) return 'undelivered'
  if (p.elapsedMs >= (p.attempts + 1) * p.retryEveryMs) return 'retry'
  return 'pending'
}
