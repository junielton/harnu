import { createPromptSubmitter } from './prompt-submit'
import { buildBracketedPaste } from '../lib/composer-core'
import type { InjectionLedgerEventInput } from '../stores/injection-ledger'

/**
 * Paste a prompt into a live PTY and submit it once the paste echo SETTLES
 * (output quiescence), not on a fixed timeout — the BUG-9/T62 machinery, lifted
 * out of `TerminalPane` so the lesson-result injection (T120) reuses the exact
 * same tested path instead of growing a second, subtly-different timing guess.
 *
 * The submit DECISION lives in the pure `createPromptSubmitter` core (unit-tested
 * in `tests/prompt-submit.test.ts`); this module is only its env-bound shell —
 * `window.api` + `setTimeout`.
 */

// BUG-9/T62 submit timings: wait ~200 ms of output silence to call the paste
// "settled", give up and submit anyway after ~2.5 s, and fire one safe retry
// ~600 ms after the first \r (a second Enter on an emptied input is a no-op).
export const PROMPT_SUBMIT_QUIET_MS = 200
export const PROMPT_SUBMIT_CAP_MS = 2500
export const PROMPT_SUBMIT_RETRY_MS = 600

/**
 * Bracketed-paste `text` into `ptyId`, then submit it on quiescence. Safe to call
 * against a PTY that dies mid-flight (every write is guarded; a `pty:exit` cancels
 * the submitter, so no stray `\r` lands). Fire-and-forget: the caller gets no
 * completion signal — delivery is best-effort by design.
 *
 * `record` (T172) observes the two write points that matter for the injection
 * trail — the bracketed paste actually reaching the PTY, and each submitting
 * `\r` (the safe retry in `createPromptSubmitter` can fire it twice; both are
 * genuine writes, so both are recorded). Optional — `MarkdownPane`'s lesson-
 * result reuse of this same path (T120) is outside the pre-prompt injection
 * trail's scope and passes nothing, at no extra cost.
 */
export function pasteAndSubmit(
  ptyId: string,
  text: string,
  record?: (event: InjectionLedgerEventInput) => void
): void {
  try {
    // T40: bracketed-paste-wrap so a MULTI-LINE prompt lands atomically in the
    // TUI instead of submitting line-by-line (the submitter fires the \r).
    window.api.ptyWrite(ptyId, buildBracketedPaste(text))
  } catch {
    return // PTY gone between resolve and write
  }
  record?.({ type: 'paste-written' })

  // Observe this PTY's output via a dedicated subscription and let the pure
  // submitter decide when the paste has settled. `onSettled` tears down both
  // subscriptions; a PTY exit before submit cancels cleanly.
  let disposeData: (() => void) | null = null
  let disposeExit: (() => void) | null = null
  const teardown = (): void => {
    disposeData?.()
    disposeData = null
    disposeExit?.()
    disposeExit = null
  }
  const submitter = createPromptSubmitter({
    submit: () => {
      try {
        window.api.ptyWrite(ptyId, '\r')
        record?.({ type: 'submit-written' })
      } catch {
        /* PTY gone — drop the submit */
      }
    },
    onSettled: teardown,
    quietMs: PROMPT_SUBMIT_QUIET_MS,
    capMs: PROMPT_SUBMIT_CAP_MS,
    retryMs: PROMPT_SUBMIT_RETRY_MS,
    setTimer: (cb, ms) => setTimeout(cb, ms),
    clearTimer: (h) => clearTimeout(h)
  })
  disposeData = window.api.onPtyData(ptyId, () => submitter.onData())
  disposeExit = window.api.onPtyExit(ptyId, () => submitter.cancel())
}
