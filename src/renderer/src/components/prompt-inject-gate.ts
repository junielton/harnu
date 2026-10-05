/**
 * Readiness gate for an agent's injected pre-prompt (T75 / BUG-17).
 *
 * The old code pasted the agent's pre-prompt the instant `pty:sessionReady`
 * fired — an event emitted right after `spawn()`, BEFORE the `claude` TUI has
 * printed a single byte of its banner. So the bracketed paste landed WHILE the
 * banner was still rendering: the `^[[200~` / `^[[201~` escape markers leaked
 * interleaved into the banner text, and the T62 submit-quiescence could be
 * satisfied by a mid-banner lull and press Enter before the paste settled — the
 * observed 1/3 fan-out failures (a prompt stuck in the composer, un-submitted).
 *
 * "Session ready" (the process exists) is NOT "composer ready" (the TUI is up
 * and idle at its prompt). This gate holds the paste until a REAL composer-ready
 * signal, deciding WHEN to inject from three inputs:
 *
 *  1. {@link InjectGate.signalReady} — a Claude Code composer-ready HOOK fired
 *     for this session (`SessionStart`, or a folded `idle` task-state; see
 *     {@link isComposerReadyHook}). This is the strongest signal — Claude itself
 *     says the composer is up — so it injects immediately. Available when the
 *     global hooks are installed (the opt-out default) AND the hook's real uuid
 *     already matches the session being watched (post-migration, or a resume).
 *  2. {@link InjectGate.onData} + `quietMs` — output QUIESCENCE: the banner
 *     stopped printing. Order-independent and always available (it reads the
 *     PTY we already hold, with no session-id keying), so it carries the common
 *     case a fresh session's early `SessionStart` hook can't (it arrives keyed
 *     to the real uuid while the row is still `synthetic-<uuid>`). This is the
 *     "settle the paste before writing it" fallback.
 *  3. `capMs` — a hard cap from construction: inject anyway if neither a hook
 *     nor quiescence ever arrives, so a pathological banner can never hang a
 *     hands-off launch forever (hooks off + endless output).
 *
 * Whichever fires first injects EXACTLY once; the rest are inert. `cancel`
 * aborts with no injection (the PTY died before the composer was ever ready).
 *
 * BUG-64: quiescence and the cap are a BLIND-PASTE risk for an agent session —
 * they only prove "the PTY stopped printing", not "the composer, specifically,
 * is up." T174's live validation caught a session sitting on a READY, EMPTY
 * composer whose queued prompt was simply never delivered — plausibly because
 * an earlier run pasted into an unrelated idling prompt (a trust dialog, a
 * login screen) that also happens to go quiet. When
 * {@link InjectGateDeps.requireComposerReadyHook} is set, inputs 2/3 above stop
 * injecting on their own: they settle WITHOUT pasting and record
 * `gate-escalated` instead, letting the existing injection watchdog (BUG-61)
 * escalate to `prompt_undelivered` once its retry budget is spent. Content-
 * sniffing the PTY output to detect a trust dialog specifically was considered
 * and rejected — brittle across Claude Code releases; requiring a REAL
 * composer-ready signal generalizes to any unknown future first-run prompt.
 *
 * Framework-free + side-effect-free per ADR-0001 (mirrors `prompt-submit.ts`):
 * the inject action and the timers are INJECTED, so the state machine is
 * deterministic and unit-testable without mounting xterm or a live PTY
 * (`tests/prompt-inject-gate.test.ts`). `TerminalPane` wires `inject` to the
 * bracketed-paste-then-submit sequence, `onData` to `onPtyData`, `signalReady`
 * to a filtered `onHook` subscription, and the timers to `setTimeout`.
 */

import type { InjectGateTrigger, InjectionLedgerEventInput } from '../stores/injection-ledger'

/** An opaque timer handle — whatever the injected `setTimer` returns. */
export type TimerHandle = ReturnType<typeof setTimeout>

/**
 * True when a Claude Code hook event means the composer is up and idle at its
 * prompt — safe to paste into. `SessionStart` fires at REPL init; a folded
 * `idle` task-state is what `reduceTaskState` returns for `SessionStart` and for
 * a `Stop`/`idle_prompt` Notification (`hook-state.ts`). `working` /
 * `needs-input` / `completed` / `failed` / `stopped` are NOT ready signals — the
 * composer is busy, gone, or mid-turn. Pure + total.
 */
export function isComposerReadyHook(event: string, taskState: string): boolean {
  return event === 'SessionStart' || taskState === 'idle'
}

/** Injected collaborators for {@link acquireInjectionTarget}. */
export interface InjectionTargetDeps {
  /**
   * Non-consuming peek: is a pre-prompt queued for this session? Keeps the common
   * case (a normal, promptless session) from paying an async PTY resolve.
   */
  hasPrompt: () => boolean
  /**
   * Resolve the live PTY id to paste into, or `null` when none is reachable yet
   * (the live terminal isn't attached AND the main-side lookup is unavailable —
   * e.g. mid-MCP-reconnect). May be sync (live-terminal cache hit) or async; a
   * rejection is treated exactly like a `null` resolution.
   */
  resolvePtyId: () => Promise<string | null> | string | null
  /** Consume (and remove) the queued pre-prompt. Called at most once, only on success. */
  takePrompt: () => string | undefined
  /**
   * Observe the injection trail (T172) — target-resolved/failed and
   * prompt-dequeued. Optional so existing tests that don't care stay unchanged;
   * omitted entirely by a promptless session, since `hasPrompt() === false`
   * returns before any call site that would invoke it — zero overhead by
   * construction, not by a guard here.
   */
  record?: (event: InjectionLedgerEventInput) => void
}

/** A resolved paste target: the PTY to write into and the prompt to write. */
export interface InjectionTarget {
  ptyId: string
  prompt: string
}

/**
 * Resolve the paste target for an agent's queued pre-prompt in the correct order:
 * peek → resolve the PTY → **only then** consume the prompt.
 *
 * The pre-prompt is a ONE-SHOT: `takePrompt` deletes it from the queue. The old
 * `armInjectGate` consumed it FIRST and then bailed when it couldn't resolve a
 * PTY, dropping the prompt forever — the session booted blank (seen when a live
 * terminal wasn't attached and the main-side PTY lookup was momentarily down,
 * e.g. during an MCP reconnect). By resolving the target before consuming, a
 * failed resolve leaves the prompt QUEUED and recoverable by a later
 * ready/retry, and only a real, reachable PTY ever consumes it.
 *
 * Framework-free + side-effect-free per ADR-0001 (mirrors the rest of this file):
 * the peek/resolve/consume steps are INJECTED, so the ordering is deterministic
 * and unit-testable without xterm or a live PTY (`tests/prompt-inject-gate.test.ts`).
 *
 * @returns the `{ ptyId, prompt }` to inject, or `null` when there is nothing to
 * inject (no prompt queued) or nowhere to inject it (no PTY) — in which case the
 * prompt is left untouched in the queue.
 */
export async function acquireInjectionTarget(
  deps: InjectionTargetDeps,
  attempt = 1
): Promise<InjectionTarget | null> {
  // Normal (non-agent) sessions queue nothing — never resolve a PTY or consume
  // for them, and never touch the queue. Also why they never call `record`: this
  // is the one gate every other decision point sits behind.
  if (!deps.hasPrompt()) return null

  let ptyId: string | null
  try {
    ptyId = (await deps.resolvePtyId()) ?? null
  } catch {
    ptyId = null
  }
  // No reachable PTY → leave the prompt queued (do NOT consume), recoverable later.
  if (!ptyId) {
    deps.record?.({ type: 'target-resolve-failed', attempt })
    return null
  }
  deps.record?.({ type: 'target-resolved', attempt })

  const prompt = deps.takePrompt()
  // A racing consumer took it first — nothing to inject, but no PTY-less drop.
  if (!prompt) return null
  deps.record?.({ type: 'prompt-dequeued', attempt })
  return { ptyId, prompt }
}

/** Injected collaborators for {@link acquireInjectionTargetWithRetry}. */
export interface RetryInjectionTargetDeps extends InjectionTargetDeps {
  /** Arm a one-shot timer; returns a handle (unused here, mirrors {@link InjectGateDeps}). */
  setTimer: (callback: () => void, ms: number) => TimerHandle
}

/**
 * {@link acquireInjectionTarget}, retried on a fixed backoff while the prompt
 * stays queued. A single failed resolve (no live terminal attached AND the
 * main-side PTY lookup momentarily down, e.g. mid-MCP-reconnect) used to strand
 * the prompt forever — nothing ever re-tried the resolve once `sessionReady` had
 * already fired once. This re-attempts up to `maxAttempts` times, `retryMs`
 * apart, stopping as soon as a target resolves, the prompt is gone (a racing
 * consumer took it — nothing left to inject), or the attempts are exhausted.
 */
export async function acquireInjectionTargetWithRetry(
  deps: RetryInjectionTargetDeps,
  opts: { retryMs: number; maxAttempts: number }
): Promise<InjectionTarget | null> {
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    const target = await acquireInjectionTarget(deps, attempt)
    if (target) return target
    if (!deps.hasPrompt() || attempt === opts.maxAttempts) return null
    await new Promise<void>((resolve) => deps.setTimer(() => resolve(), opts.retryMs))
  }
  return null
}

/** Injected collaborators for {@link createInjectGate}. */
export interface InjectGateDeps {
  /** Perform the injection (bracketed paste + wire the submitter). Called at most once. */
  inject: () => void
  /**
   * BUG-85: put the prompt BACK on the queue. Called exactly once, immediately
   * before {@link onSettled}, on any settle that did NOT inject — the cap
   * escalation or a `cancel`. Never called after a successful injection.
   *
   * `acquireInjectionTarget` CONSUMES the one-shot prompt before this gate is
   * ever constructed (BUG-61), so a gate that gives up used to destroy it: the
   * watchdog's retries then re-armed against an empty queue and no-op'd, and the
   * SessionMenu "Retry" item cleared the badge while delivering nothing. Putting
   * it back is what makes both of those recoveries real.
   *
   * Optional so existing tests that don't exercise recovery stay unchanged.
   */
  requeue?: () => void
  /**
   * Fired ONCE when the gate reaches its terminal state — after `inject`, or on
   * {@link InjectGate.cancel}. The shell disposes its `onHook` / `onPtyData` /
   * `onPtyExit` / migrate subscriptions here.
   */
  onSettled?: () => void
  /** No-output window that counts as "the banner has settled" (~400–500 ms). */
  quietMs: number
  /** Hard cap from construction to the injection, even if nothing settles (~2.5 s). */
  capMs: number
  /**
   * BUG-64: when true, ONLY {@link InjectGate.signalReady} (the composer-ready
   * HOOK) may inject — quiescence and the hard cap settle WITHOUT pasting
   * instead, recording `gate-escalated` (T172 ledger) so the existing
   * injection watchdog (BUG-61) escalates to `prompt_undelivered` once its own
   * retry budget is spent, rather than blind-pasting into whatever state the
   * PTY happens to be idling in (a trust dialog, a login prompt, …).
   *
   * Live evidence (docs/reports/2026-07-20-orphan-spawn-postmortem.md's T174
   * validation) showed a session sitting on a READY, EMPTY composer with its
   * prompt never delivered — output quiescence alone cannot tell "the banner
   * settled" from "an unknown prompt is idling waiting for a keypress", and
   * content-sniffing that prompt is deliberately out of scope (fragile across
   * Claude Code releases). The hook is the one signal that means "the
   * COMPOSER, specifically, is up."
   *
   * Default `false`/absent preserves the pre-BUG-64 best-effort behavior
   * (quiescence/cap may inject) — the only safe choice for a session whose
   * hooks are not wired at all (the T92 per-session `--settings` injection
   * opted out), since such a session's hook can never arrive and requiring it
   * would hang the launch forever. The caller (`TerminalPane.vue`) resolves
   * this from `window.api.hooksStatus()`'s `injectPerSession`.
   */
  requireComposerReadyHook?: boolean
  /** Arm a one-shot timer; returns a handle for {@link clearTimer}. */
  setTimer: (callback: () => void, ms: number) => TimerHandle
  /** Cancel a timer previously armed by {@link setTimer}. */
  clearTimer: (handle: TimerHandle) => void
  /**
   * Observe the injection trail (T172) — which of the three inputs fired the
   * gate, and a cancel with no injection. Optional; a promptless session never
   * reaches `createInjectGate` at all (the shell only constructs one after
   * {@link acquireInjectionTarget} resolves a target), so this costs nothing for
   * the common case regardless.
   */
  record?: (event: InjectionLedgerEventInput) => void
}

/** The live gate {@link createInjectGate} returns. */
export interface InjectGate {
  /** A composer-ready CC hook fired for this session — inject now. */
  signalReady: () => void
  /** Call on every PTY output chunk while waiting — (re)arms the banner-settle timer. */
  onData: () => void
  /** Abort: clear timers and settle without injecting (e.g. the PTY died). */
  cancel: () => void
}

/**
 * Build a composer-readiness gate over injected timers + an inject fn. Starts
 * waiting immediately: the cap timer is armed on construction; the quiescence
 * timer is armed by the FIRST {@link InjectGate.onData} (so it genuinely waits
 * for the banner to begin before it can consider it settled). A
 * {@link InjectGate.signalReady} at any point injects at once.
 */
export function createInjectGate(deps: InjectGateDeps): InjectGate {
  let quietTimer: TimerHandle | null = null
  let capTimer: TimerHandle | null = null
  let injected = false
  let settled = false

  function clearQuiet(): void {
    if (quietTimer !== null) {
      deps.clearTimer(quietTimer)
      quietTimer = null
    }
  }
  function clearCap(): void {
    if (capTimer !== null) {
      deps.clearTimer(capTimer)
      capTimer = null
    }
  }

  /**
   * Settle WITHOUT injecting — shared by `cancel()` (PTY died) and, when
   * `requireComposerReadyHook` withholds a non-hook trigger, by `fire()`
   * itself (BUG-64). The prompt was dequeued by `acquireInjectionTarget` before
   * this gate ever existed; BUG-85 hands it back here via
   * {@link InjectGateDeps.requeue} so the watchdog's next retry has something to
   * re-arm against, instead of no-op'ing on an empty queue until its budget
   * runs out.
   */
  function settleWithoutInjecting(event: InjectionLedgerEventInput): void {
    settled = true
    clearQuiet()
    clearCap()
    // BUG-85: hand the prompt back BEFORE recording why we gave up, so the trail
    // reads "requeued, then escalated" and a reader never sees an escalation that
    // looks like a destroyed prompt.
    if (deps.requeue) {
      deps.requeue()
      deps.record?.({ type: 'prompt-requeued' })
    }
    deps.record?.(event)
    deps.onSettled?.()
  }

  function fire(via: InjectGateTrigger): void {
    if (injected || settled) return
    if (via !== 'hook' && deps.requireComposerReadyHook) {
      // BUG-64: never blind-paste on a non-hook trigger. BUG-85: and never let
      // QUIESCENCE end the wait either — in hook-required mode a lull in the
      // output proves nothing at all (it cannot tell "the banner settled" from
      // "still booting"), and a cold `claude` reliably goes quiet long before it
      // reaches SessionStart. Settling there tore down the `onHook` subscription
      // ~500 ms in and destroyed the prompt. Only the hard cap ends the wait now.
      if (via === 'quiescence') return
      settleWithoutInjecting({ type: 'gate-escalated', via })
      return
    }
    injected = true
    settled = true
    clearQuiet()
    clearCap()
    deps.record?.({ type: 'gate-fired', via })
    deps.inject()
    deps.onSettled?.()
  }

  // Hard cap from construction: inject even if neither a hook nor quiescence ever
  // arrives — the launch can never hang waiting for a readiness that won't come.
  // (Unless `requireComposerReadyHook` withholds it — see `fire` above.)
  capTimer = deps.setTimer(() => fire('cap'), deps.capMs)

  function signalReady(): void {
    fire('hook')
  }

  function onData(): void {
    if (injected || settled) return
    clearQuiet()
    quietTimer = deps.setTimer(() => fire('quiescence'), deps.quietMs)
  }

  function cancel(): void {
    if (settled) return
    settleWithoutInjecting({ type: 'gate-cancelled' })
  }

  return { signalReady, onData, cancel }
}
