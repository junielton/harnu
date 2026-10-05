# BUG-85 — Generate on a long card spawns a session with no prompt

**Status:** fixed — the `(BUG-85)` commits on this branch.
**Reported:** 2026-09-06 — "when I try to generate a spec for a card, in the second
round of answering questions, clicking Generate creates the worktree and spawns the
session but does not add the prompt; a `Prompt not delivered` badge appears. Same in
the existing checkout (no new worktree)."

## 1. Summary

Three defects compound. A `complex` card accumulates operator answers in its body
across interview rounds; once the body is long enough, the assembled Generate prompt
overflows the argv budget by exactly its own framing and falls onto the legacy
paste-after-boot path — which, in the default hook-required mode, destroys the prompt
at the first 500 ms lull in the boot banner.

The worktree is not a variable. Prompt length is.

## 2. Evidence

Measured against the real reported card, `T1-customizable-keybindings` (`complexity:
complex`, Round 1 answered, Round 2 answered). It lives in the reporter's local
`.capy/memory/roadmap/`, which `.gitignore` excludes, so the numbers are reproduced
here rather than by a path you can open:

| Quantity                                | Value        |
| --------------------------------------- | ------------ |
| Card body                               | 16,596 ch    |
| Body after `BOOT_PROMPT_BODY_MAX_CHARS` | 8,000 ch     |
| Assembled Generate prompt               | **8,864 ch** |
| `AGENT_PREPROMPT_ARGV_MAX_CHARS`        | 8,000 ch     |
| Resulting delivery path                 | **PASTE**    |

`hook-prefs.json` is absent from the reporter's `userData`, so `injectPerSession`
takes its default (`hook-bridge.ts:345`, `!== false`) and `requireComposerReadyHook`
is `true`.

## 3. Defect 1 — the body cap and the argv budget are the same number

`buildGeneratorPrompt` (`src/main/roadmap-core.ts:1528`) and `buildBootPrompt`
(`:1451`) cap the **card body** at `BOOT_PROMPT_BODY_MAX_CHARS = 8_000`, then wrap it
in ~860 characters of framing (heading, anti-injection sentence, fences, tier
instruction, output/field/scope instructions, closure).

`dispatchCardSession` (`src/renderer/src/stores/sessions.ts:2707`) selects the
reliable argv path only when the **whole assembled prompt** is
`<= AGENT_PREPROMPT_ARGV_MAX_CHARS = 8_000`.

Because the two constants are equal, any card whose body reaches the cap overflows
argv by exactly the framing. The argv path is unreachable for such a card — not
occasionally, but by construction.

`prePrompt` is passed as a plain argv positional after `--`
(`src/main/claude-args.ts:578`). `ARG_MAX` is 1,048,576 on the reporter's machine and
Linux's per-argument `MAX_ARG_STRLEN` is 131,072, so the 8,000 ceiling is roughly two
orders of magnitude more conservative than the OS requires.

## 4. Defect 2 — the paste path discards the prompt at the first lull

This is what surfaces as `Prompt not delivered`.

1. `armInjectGate` (`TerminalPane.vue:1148`) resolves a PTY and **consumes** the
   prompt from `pendingAgentPrompts` via `acquireInjectionTarget`.
2. It builds a gate with `quietMs = 500`, `capMs = 2500`, and
   `requireComposerReadyHook = true`.
3. In that mode `fire()` (`prompt-inject-gate.ts:290`) refuses to paste for any
   trigger except `'hook'`. Quiescence and the cap call `settleWithoutInjecting`.
4. The first 500 ms gap in the boot banner therefore **settles the gate** and tears
   down the `onHook` subscription. `tests/prompt-inject-gate.test.ts:296` already
   asserts the consequence: _"once escalated, a late hook is inert."_
5. The prompt is gone — consumed in step 1, never requeued.
6. The watchdog's retries (`INJECTION_WATCHDOG_MAX_ATTEMPTS = 4` ×
   `INJECTION_WATCHDOG_RETRY_MS = 750`) re-call `armInjectGate`, but `hasAgentPrompt`
   is now `false`, so each retry returns immediately. At ~3 s the budget is spent and
   `injectionVerdict` returns `'undelivered'` → `markPromptUndelivered`.

A cold `claude` boot does not reach `SessionStart` inside 500 ms. In hook-required
mode, quiescence is evidence of _nothing_ — it cannot distinguish "the banner
settled" from "still loading" — yet it is currently a terminal trigger.

The same lost-prompt fact also breaks the manual recovery: `retryPromptInjection`
(`sessions.ts:1541`) documents "the prompt itself needs no requeue — this failure is
only reached when it was never acquired," which has been untrue since BUG-61
established that the gate consumes before it pastes. The **Retry** item in
`SessionMenu` therefore clears the badge and delivers nothing.

## 5. Defect 3 — truncation removes exactly the operator's answers

`body.slice(0, 8000)` cuts mid-sentence inside Round 2's Q4. Everything past that
offset is dropped, including `## Definition of done` (offset 9,110) and **all five
`> answers:` appends**, which `appendBody` writes at the tail of the file.

So even with delivery repaired, the agent would receive Round 2's _questions_ with
none of the operator's _answers_ and would simply re-interview. The reported
"second round" symptom is where this becomes unavoidable, because that is the round
whose answers push the body past the cap.

## 6. Fix

| #   | Defect                             | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | equal constants                    | One budget, `PROMPT_ARGV_BUDGET_CHARS = 24_000` (revised down from an initial `32_000` in review — Windows' `CreateProcess` caps `lpCommandLine` at 32,767 chars total, and `npm run build:win` is a shipped target), mirrored by the renderer constant and locked by a cross-process test. The body cap becomes **derived**: `budget − framing`, so an assembled prompt can never overflow.                                                                                                                          |
| 3   | truncated answers                  | Falls out of #1 — a 16.6 KB body now fits whole.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 2   | prompt destroyed on the paste path | (a) In hook-required mode quiescence stops being a terminal trigger — only the cap settles. (b) The cap becomes `INJECT_HOOK_WAIT_MS = 30_000` in that mode, a realistic cold-boot window; best-effort mode keeps 2,500 ms unchanged. (c) `settleWithoutInjecting` **requeues** the prompt, so a retry can re-arm and `retryPromptInjection`'s contract becomes true. (d) The watchdog learns `gateArmed` and stays `'pending'` while a gate is legitimately waiting, instead of burning its budget on no-op retries. |

BUG-64's posture is preserved throughout: **no trigger other than a composer-ready
hook ever pastes.** The change is how long Capy is willing to wait for that hook, and
that losing the race no longer destroys the prompt.

## 7. Non-goals

- Content-sniffing the PTY to detect a trust dialog — rejected by BUG-64, still rejected.
- Removing the paste path. It remains the fallback above the argv budget; this bug is
  that it was silently lossy, not that it exists.
- Changing where `appendBody` writes answers (tail vs. under the question). Real, but
  a separate concern once the body is no longer truncated.
