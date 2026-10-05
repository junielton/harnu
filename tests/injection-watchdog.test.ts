import { describe, it, expect } from 'vitest'
import {
  injectionVerdict,
  type InjectionProbe
} from '../src/renderer/src/stores/injection-watchdog'

/**
 * The sibling gap the drop-fix (`acquireInjectionTarget`) left open: it stops the
 * prompt being DROPPED when a PTY can't be resolved, but nothing yet re-attempts
 * delivery or surfaces a session stuck forever with a live PTY and an undelivered
 * prompt. This is the pure decision core for that watchdog — see
 * `docs/specs/2026-07-15-preprompt-injection-watchdog.md` §5.2.
 *
 * The reaper (`synthetic-reaper.ts`) is blind to this: its `bootVerdict` already
 * returns `booted` the instant a PTY is live, regardless of whether the prompt was
 * ever delivered. This core fills exactly that blind spot.
 *
 * BUG-61: the verdict originally inferred delivery from queue membership
 * (`!promptQueued → 'delivered'`, `!ptyLive → 'delivered'`), which is exactly what
 * let two 2026-07-20 orphaned sessions report `delivered` while their pre-prompt
 * was consumed from the queue but never pasted. `injectionVerdict` now reads
 * T172's `injectionLedger.wasInjected(id)` — the `injected` probe field below —
 * as the only signal that means true delivery.
 */

const BASE = { retryEveryMs: 750, maxAttempts: 4 }

function probe(overrides: Partial<InjectionProbe>): InjectionProbe {
  return {
    promptQueued: true,
    injected: false,
    ptyLive: true,
    elapsedMs: 0,
    attempts: 0,
    ...BASE,
    ...overrides
  }
}

describe('injectionVerdict (pre-prompt delivery watchdog)', () => {
  it('delivered — the ledger confirms the paste actually landed, regardless of elapsed/attempts/ptyLive', () => {
    expect(injectionVerdict(probe({ injected: true }))).toBe('delivered')
    expect(injectionVerdict(probe({ injected: true, elapsedMs: 999_999, attempts: 99 }))).toBe(
      'delivered'
    )
    // A session that finishes its work normally exits with a dead PTY on the very
    // next tick — that must still read as delivered, not escalated.
    expect(injectionVerdict(probe({ injected: true, ptyLive: false }))).toBe('delivered')
  })

  it('undelivered — a PTY that dies before an injection is confirmed did not deliver', () => {
    expect(injectionVerdict(probe({ ptyLive: false, injected: false }))).toBe('undelivered')
  })

  it('undelivered wins regardless of promptQueued when the PTY is gone and nothing was injected', () => {
    expect(injectionVerdict(probe({ promptQueued: false, ptyLive: false, injected: false }))).toBe(
      'undelivered'
    )
    expect(injectionVerdict(probe({ promptQueued: true, ptyLive: false, injected: false }))).toBe(
      'undelivered'
    )
  })

  describe('BUG-61 repro — 2026-07-20 orphan-spawn post-mortem (defect D2)', () => {
    it('does not report "delivered" merely because the prompt left the queue', () => {
      // `acquireInjectionTarget` CONSUMES the prompt, then `createInjectGate` holds
      // the paste for up to capMs (2.5s) — and drops it entirely if the PTY exits
      // first (gate.cancel()). In that window the prompt is neither queued nor
      // delivered, but the old verdict only ever asked "is it still queued?".
      const verdict = injectionVerdict({
        promptQueued: false, // consumed by acquireInjectionTarget
        ptyLive: true, // REPL is up and idle — exactly the orphan's state
        elapsedMs: 30_000, // long past any plausible injection
        attempts: 0,
        retryEveryMs: 750,
        maxAttempts: 4
      })
      expect(verdict).not.toBe('delivered')
    })

    it('does not report "delivered" when the PTY died before injecting', () => {
      const verdict = injectionVerdict({
        promptQueued: true,
        ptyLive: false, // PTY gone; gate.cancel() dropped the paste
        elapsedMs: 5_000,
        attempts: 0,
        retryEveryMs: 750,
        maxAttempts: 4
      })
      expect(verdict).not.toBe('delivered')
    })
  })

  it('pending — still queued, PTY live, before the first retry boundary', () => {
    expect(injectionVerdict(probe({ elapsedMs: 0, attempts: 0 }))).toBe('pending')
    expect(injectionVerdict(probe({ elapsedMs: 749, attempts: 0 }))).toBe('pending')
  })

  it('retry — fires exactly at each backoff boundary: (attempts+1) * retryEveryMs', () => {
    expect(injectionVerdict(probe({ elapsedMs: 750, attempts: 0 }))).toBe('retry')
    expect(injectionVerdict(probe({ elapsedMs: 1500, attempts: 1 }))).toBe('retry')
    expect(injectionVerdict(probe({ elapsedMs: 2250, attempts: 2 }))).toBe('retry')
  })

  it('pending between boundaries for a mid-flight attempt count', () => {
    expect(injectionVerdict(probe({ elapsedMs: 1499, attempts: 1 }))).toBe('pending')
    expect(injectionVerdict(probe({ elapsedMs: 2249, attempts: 2 }))).toBe('pending')
  })

  it('undelivered — the attempt ceiling was reached, checked BEFORE the elapsed boundary', () => {
    expect(injectionVerdict(probe({ attempts: 4, elapsedMs: 0 }))).toBe('undelivered')
    expect(injectionVerdict(probe({ attempts: 5, elapsedMs: 100_000 }))).toBe('undelivered')
  })

  it('undelivered wins over retry once maxAttempts is hit, even at a fresh retry boundary', () => {
    // attempts=4 is already at the ceiling; elapsedMs coincides with what would be
    // the 5th retry boundary (3750ms) — must still report undelivered, not retry.
    expect(injectionVerdict(probe({ attempts: 4, elapsedMs: 3750 }))).toBe('undelivered')
  })

  it('is monotonic: once undelivered, no larger elapsedMs/attempts value reverts it', () => {
    const at = injectionVerdict(probe({ attempts: 4, elapsedMs: 3000 }))
    const later = injectionVerdict(probe({ attempts: 4, elapsedMs: 999_999 }))
    expect(at).toBe('undelivered')
    expect(later).toBe('undelivered')
  })

  it('a custom maxAttempts / retryEveryMs is honored (not hardcoded)', () => {
    expect(injectionVerdict(probe({ maxAttempts: 1, attempts: 1, elapsedMs: 0 }))).toBe(
      'undelivered'
    )
    expect(injectionVerdict(probe({ retryEveryMs: 1000, attempts: 0, elapsedMs: 999 }))).toBe(
      'pending'
    )
    expect(injectionVerdict(probe({ retryEveryMs: 1000, attempts: 0, elapsedMs: 1000 }))).toBe(
      'retry'
    )
  })

  it('BUG-85: while a gate is armed the verdict stays pending — no budget is burned', () => {
    // The gate is legitimately waiting for a composer-ready hook. Re-arming would
    // no-op (the prompt is consumed) and spending the budget here is exactly what
    // escalated a healthy cold boot to `prompt_undelivered` after ~3 s.
    expect(injectionVerdict(probe({ gateArmed: true, elapsedMs: 30_000 }))).toBe('pending')
    expect(injectionVerdict(probe({ gateArmed: true, attempts: 99 }))).toBe('pending')
  })

  it('BUG-85: an armed gate never masks a delivered or dead session', () => {
    expect(injectionVerdict(probe({ gateArmed: true, injected: true }))).toBe('delivered')
    expect(injectionVerdict(probe({ gateArmed: true, ptyLive: false }))).toBe('undelivered')
  })

  it('BUG-85: once the gate settles, the normal retry/escalate arithmetic resumes', () => {
    expect(injectionVerdict(probe({ gateArmed: false, elapsedMs: 750 }))).toBe('retry')
    expect(injectionVerdict(probe({ gateArmed: false, attempts: 4 }))).toBe('undelivered')
  })
})
