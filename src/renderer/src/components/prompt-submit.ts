/**
 * Quiescence-driven submit for an agent's injected pre-prompt (T62 / BUG-9).
 *
 * When an MCP agent boots a session with a `prePrompt`, `TerminalPane` writes it
 * as a bracketed paste and then must press Enter for the agent. The old code sent
 * the submitting `\r` on a FIXED `setTimeout(…, 50)` — a timing guess, not a
 * signal. For a large multi-line prompt on a loaded machine the TUI is still
 * consuming the paste 50 ms later, so the `\r` lands INSIDE the paste (a newline
 * in the input box) and never submits: the prompt just sits there waiting for a
 * human Enter, killing the hands-off fan-out the feature exists for.
 *
 * This is the pure decision core: it does not know about PTYs or xterm. Fed a
 * stream of data-arrival pings (`onData()` — one per PTY output chunk) plus
 * injected timers, it decides WHEN to submit:
 *
 *  1. Wait for the paste echo to START (first `onData`) and then SETTLE — no
 *     output for `quietMs`. Quiescence means the TUI finished rendering the
 *     pasted input, so a `\r` now is a real submit.
 *  2. A hard `capMs` cap submits anyway if output never settles (or never
 *     starts), so a pathological render can never hang the launch forever.
 *  3. One safe retry `retryMs` after the first submit. A second Enter on an
 *     already-emptied TUI input is a no-op, so the retry is free insurance
 *     against a first `\r` that still raced the tail of the paste.
 *
 * Framework-free + side-effect-free per ADR-0001: the submit action and the
 * timers are INJECTED, so the state machine is deterministic and unit-testable
 * without mounting xterm (`tests/prompt-submit.test.ts`). The env-bound shell
 * (`TerminalPane`) wires `submit` to `ptyWrite('\r')` and the timers to
 * `setTimeout`/`clearTimeout`, and drives `onData` from `onPtyData`.
 */

/** An opaque timer handle — whatever the injected `setTimer` returns. */
export type TimerHandle = ReturnType<typeof setTimeout>

/** Injected collaborators for {@link createPromptSubmitter}. */
export interface PromptSubmitDeps {
  /** Write the submitting carriage return. Called up to twice (submit + one retry). */
  submit: () => void
  /**
   * Fired ONCE when the submitter reaches its terminal state — after the retry
   * fires, or on {@link PromptSubmitter.cancel}. The shell disposes its `onPtyData`
   * / `onPtyExit` subscriptions here.
   */
  onSettled?: () => void
  /** No-output window that counts as "the paste has settled" (~150–200 ms). */
  quietMs: number
  /** Hard cap from construction to the first submit, even if output never settles (~2 s). */
  capMs: number
  /** Delay after the first submit before the single safe retry (~500 ms). */
  retryMs: number
  /** Arm a one-shot timer; returns a handle for {@link clearTimer}. */
  setTimer: (callback: () => void, ms: number) => TimerHandle
  /** Cancel a timer previously armed by {@link setTimer}. */
  clearTimer: (handle: TimerHandle) => void
}

/** The live submitter {@link createPromptSubmitter} returns. */
export interface PromptSubmitter {
  /** Call on every PTY output chunk while waiting — re-arms the quiescence timer. */
  onData: () => void
  /** Abort: clear timers and settle without any further submit (e.g. the PTY died). */
  cancel: () => void
}

/**
 * Build a quiescence-driven prompt submitter over injected timers + submit fn.
 * Starts waiting immediately: the cap timer is armed on construction; the
 * quiescence timer is armed by the FIRST {@link PromptSubmitter.onData} (so it
 * genuinely waits for the paste echo to begin before it can consider it settled).
 */
export function createPromptSubmitter(deps: PromptSubmitDeps): PromptSubmitter {
  let quietTimer: TimerHandle | null = null
  let capTimer: TimerHandle | null = null
  let retryTimer: TimerHandle | null = null
  let submitted = false
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
  function clearRetry(): void {
    if (retryTimer !== null) {
      deps.clearTimer(retryTimer)
      retryTimer = null
    }
  }

  function finish(): void {
    if (settled) return
    settled = true
    clearQuiet()
    clearCap()
    clearRetry()
    deps.onSettled?.()
  }

  function fireSubmit(): void {
    if (submitted || settled) return
    submitted = true
    clearQuiet()
    clearCap()
    deps.submit()
    // Single safe retry — a second Enter on an already-emptied TUI input is a
    // no-op, so this only ever helps (covers a first \r that raced the paste tail).
    retryTimer = deps.setTimer(() => {
      retryTimer = null
      if (settled) return
      deps.submit()
      finish()
    }, deps.retryMs)
  }

  // Hard cap from construction: submit even if output never settles (or never
  // starts) — the launch can never hang waiting for a quiescence that won't come.
  capTimer = deps.setTimer(fireSubmit, deps.capMs)

  function onData(): void {
    if (submitted || settled) return // post-submit output must not delay the retry
    clearQuiet()
    quietTimer = deps.setTimer(fireSubmit, deps.quietMs)
  }

  function cancel(): void {
    finish()
  }

  return { onData, cancel }
}
