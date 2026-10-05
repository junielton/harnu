/**
 * The pre-prompt injection trail (T172) — a real, queryable record of what
 * actually happened to an agent's queued pre-prompt, not throwaway logging.
 *
 * Before this module, the entire injection path (`prompt-inject-gate.ts`,
 * `prompt-inject.ts`, the `armInjectGate` shell in `TerminalPane.vue`) had zero
 * instrumentation. During the 2026-07-20 orphaned-spawn incident
 * (`docs/reports/2026-07-20-orphan-spawn-postmortem.md`), the five downstream
 * defects were all provable from disk state — but WHAT specifically lost the
 * injection for the two orphaned sessions was not, because nothing recorded
 * whether a paste ever happened. `injectionVerdict` (`injection-watchdog.ts`)
 * can only ask "is it still queued?", which is why D2 reports a lost prompt as
 * `delivered`: `acquireInjectionTarget` consumes the prompt from the queue
 * BEFORE `createInjectGate` actually pastes it, so in that window the prompt is
 * neither queued nor delivered, and the watchdog is blind.
 *
 * This ledger is the fix for the blindness, not the fix for D2 itself (that is
 * BUG-61's job — it consumes {@link InjectionLedger.statusFor} to distinguish a
 * merely DEQUEUED prompt from one that was actually INJECTED). Keyed by session
 * id, in-memory only (renderer-process lifetime, no `userData` persistence —
 * unlike ADR-0006's terminal ledger, this trail is only ever consulted while the
 * process it describes is still alive; once the app restarts the PTY is gone and
 * there is nothing left to diagnose live). Re-keyed across the synth→real id
 * migration by `sessions.ts`'s `fireMigrate`, the same edge `pendingAgentPrompts`
 * already follows via `carryAgentPrompt`.
 *
 * Zero-cost for a promptless (normal) session BY CONSTRUCTION: every call site
 * that records an event sits behind the existing `hasPrompt()` / target-resolved
 * gates in `prompt-inject-gate.ts`, so a session with nothing queued never
 * reaches a `record` call at all — see
 * `docs/adr/0007-injection-trail-is-an-in-memory-renderer-ledger.md`.
 */

/** The three inputs `createInjectGate` can fire on (`prompt-inject-gate.ts`). */
export type InjectGateTrigger = 'hook' | 'quiescence' | 'cap'

export type InjectionLedgerEventInput =
  | { type: 'target-resolved'; attempt: number }
  | { type: 'target-resolve-failed'; attempt: number }
  | { type: 'prompt-dequeued'; attempt: number }
  | { type: 'gate-fired'; via: InjectGateTrigger }
  | { type: 'paste-written' }
  | { type: 'submit-written' }
  | { type: 'gate-cancelled' }
  /**
   * BUG-85: the gate settled without pasting and put the prompt BACK on
   * `pendingAgentPrompts`. Recorded just before the `gate-escalated` /
   * `gate-cancelled` event that explains why, so a trail reads
   * "…requeued, then escalated" rather than implying the prompt was destroyed.
   */
  | { type: 'prompt-requeued' }
  /**
   * BUG-64: the gate reached quiescence or its hard cap, but `requireComposerReadyHook`
   * withheld the paste because no composer-ready HOOK ever arrived — the exact
   * shape of a session sitting on an unresolved first-run prompt (a trust
   * dialog, a login screen, …). Recorded INSTEAD of `gate-fired`; never pasted.
   */
  | { type: 'gate-escalated'; via: InjectGateTrigger }

/** A recorded event, stamped with the wall-clock time it was observed. */
export type InjectionLedgerEvent = InjectionLedgerEventInput & { at: number }

/**
 * The terminal verdict for a tracked injection, derived from its trail — the
 * injected/dequeued distinction the design note (T172) calls out explicitly:
 *
 *  - `none` — nothing recorded yet (no prompt was ever queued for this id, or
 *    the first decision point hasn't fired).
 *  - `dequeued` — the prompt was taken off the queue but the paste has not (yet,
 *    or ever) landed in the PTY. This is the window D2 is blind to.
 *  - `injected` — the bracketed paste actually reached the PTY. Only this state
 *    means the prompt was truly delivered.
 *  - `escalated` — (BUG-64) quiescence/cap fired but a composer-ready hook was
 *    required and never arrived, so the gate withheld the paste on purpose.
 *    Distinct from `cancelled`: the PTY is still alive, nothing died — the
 *    gate itself declined to blind-paste into an unknown state.
 *  - `cancelled` — the gate was aborted (`pty:exit`) before an injection.
 */
export type InjectionLedgerStatus = 'none' | 'dequeued' | 'injected' | 'cancelled' | 'escalated'

/** The ledger's public surface — see {@link createInjectionLedger}. */
export interface InjectionLedger {
  /** Append an event to `sessionId`'s trail, stamping `at` with the current time. */
  record: (sessionId: string, event: InjectionLedgerEventInput) => void
  /** The full ordered trail for `sessionId`, or `[]` if nothing was ever recorded. */
  getTrail: (sessionId: string) => readonly InjectionLedgerEvent[]
  /** The injected/dequeued/cancelled/none verdict, derived from the trail. */
  statusFor: (sessionId: string) => InjectionLedgerStatus
  /** True iff the bracketed paste actually landed in the PTY. */
  wasInjected: (sessionId: string) => boolean
  /**
   * Carry `fromId`'s trail onto `toId` (synth→real migration). Merges into an
   * existing `toId` trail rather than overwriting, in case `toId` already
   * recorded something (defensive — not expected in the current call graph).
   * No-op when `fromId` has no trail, or `fromId === toId`.
   */
  rekey: (fromId: string, toId: string) => void
  /** Drop `sessionId`'s trail. Not called by production wiring today — exposed
   * for tests and any future explicit-cleanup call site. */
  clear: (sessionId: string) => void
}

/** Build a fresh, isolated ledger — used by the production singleton below and
 * directly by tests that need an instance with no shared state. */
export function createInjectionLedger(): InjectionLedger {
  const trails = new Map<string, InjectionLedgerEvent[]>()

  function record(sessionId: string, event: InjectionLedgerEventInput): void {
    const stamped: InjectionLedgerEvent = { ...event, at: Date.now() }
    const trail = trails.get(sessionId)
    if (trail) trail.push(stamped)
    else trails.set(sessionId, [stamped])
  }

  function getTrail(sessionId: string): readonly InjectionLedgerEvent[] {
    return trails.get(sessionId) ?? []
  }

  function statusFor(sessionId: string): InjectionLedgerStatus {
    const trail = trails.get(sessionId)
    if (!trail || trail.length === 0) return 'none'
    if (trail.some((e) => e.type === 'paste-written')) return 'injected'
    if (trail.some((e) => e.type === 'gate-escalated')) return 'escalated'
    if (trail.some((e) => e.type === 'gate-cancelled')) return 'cancelled'
    if (trail.some((e) => e.type === 'prompt-dequeued')) return 'dequeued'
    return 'none'
  }

  function wasInjected(sessionId: string): boolean {
    return statusFor(sessionId) === 'injected'
  }

  function rekey(fromId: string, toId: string): void {
    if (fromId === toId) return
    const trail = trails.get(fromId)
    if (!trail) return
    trails.delete(fromId)
    const existing = trails.get(toId)
    if (existing) existing.push(...trail)
    else trails.set(toId, trail)
  }

  function clear(sessionId: string): void {
    trails.delete(sessionId)
  }

  return { record, getTrail, statusFor, wasInjected, rekey, clear }
}

/** The one ledger the live app wires: `TerminalPane`'s `armInjectGate`,
 * `prompt-inject-gate.ts`, `prompt-inject.ts`, and `sessions.ts`'s `fireMigrate`
 * all read/write this same instance, keyed by session id. */
export const injectionLedger = createInjectionLedger()
