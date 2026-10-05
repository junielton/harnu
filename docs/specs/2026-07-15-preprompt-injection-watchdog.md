# Spec — Agent pre-prompt injection watchdog

> Status: **Draft / proposed** · Author: pairing session · Date: 2026-07-15
> Follows: the pre-prompt drop-fix (`acquireInjectionTarget`, branch
> `fix/preprompt-inject-drop`). This spec covers the **sibling gap** that fix
> leaves open: a session whose PTY came up but whose queued prompt is never
> delivered.
>
> Naming note: this is the **agent boot / pre-prompt** concern. It is unrelated to
> the git worktree/branch **Reaper** cleanup engine
> (`docs/plans/2026-07-15-reaper-cleanup.md`); do not conflate the two.

## 1. Context

An agent-created or card-dispatched session queues an initial prompt
(`pendingAgentPrompts`) and delivers it once — from `armInjectGate`, triggered by
the single `pty:sessionReady` event that fires per PTY spawn. The drop-fix made
delivery **resolve the PTY before consuming** the one-shot prompt
(`acquireInjectionTarget`), so a delivery attempt that finds no reachable PTY now
leaves the prompt **queued** instead of dropping it.

That fix removes the data-loss failure. It does **not** add any mechanism that
re-attempts the delivery or surfaces a stuck prompt. This spec closes that gap.

## 2. The gap (levantamento)

**The boot reaper is blind to injection.** The dead-synthetic reaper's verdict
(`src/renderer/src/stores/synthetic-reaper.ts`) short-circuits to `booted` the
moment a live PTY is registered:

```ts
// synthetic-reaper.ts:58
export function bootVerdict(p: BootProbe): BootVerdict {
  if (!p.present || p.isLive) return 'booted' // ← PTY exists ⇒ satisfied
  if (p.elapsedMs >= p.timeoutMs) return 'failed'
  return 'pending'
}
```

`isLive` is set by `registerLiveSession` at PTY wire time
(`TerminalPane.vue:633`). So the only thing the reaper guarantees is _a process
came up_ — it never checks whether the queued prompt was delivered. A session that
boots a live REPL but never receives its prompt passes every existing guard and
lingers as a blank, "working" session.

**Injection arms exactly once, with no natural retry.**

- `pty:sessionReady` is emitted only at spawn (`pty.ts:786`), once per PTY. It is
  **not** re-emitted on re-adopt/re-attach (renderer reload attaches to the
  existing PTY without a new spawn).
- `armInjectGate` is driven by a single subscription
  (`TerminalPane.vue:1096`): `mcp.onSessionReady(({ sessionKey }) =>
armInjectGate(sessionKey))`. If that subscription is absent, or the one event is
  missed, nothing ever retries.
- `acquireInjectionTarget` consumes the prompt at `sessionReady` time (the gate
  then holds the string and waits for composer-readiness before pasting). So
  "prompt still queued a beat after the PTY is live" is a precise, observable
  signal that **the delivery never even got acquired**.

## 3. Failure modes (validation)

Each validated against the code on branch `fix/preprompt-inject-drop`.

| #   | "PTY up, injection never happened" cause                                                                                                                                      | Evidence                                                                                          | After drop-fix                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| A   | `sessionReady` arrives before `liveTerminals` is populated **and** the main-side `ptyIdForSession` lookup is momentarily unavailable (MCP reconnect) → `resolvePtyId` → null. | `TerminalPane.vue:1041` gate resolve; `command-dispatch.ts:88`. This is the user's real incident. | Prompt **stays queued**, no retry → silently stuck.     |
| B   | `mcp.onSessionReady` is not a function (control-server layer down at mount) → `offSessionReady` null → `armInjectGate` never subscribed.                                      | `TerminalPane.vue:1096-1098` guard.                                                               | Prompt queued, never attempted.                         |
| C   | The one `sessionReady` event is missed/dropped in transit.                                                                                                                    | Single-shot IPC; no ack.                                                                          | Same as B.                                              |
| D   | Gate `cancel` (PTY exited before composer-ready).                                                                                                                             | `prompt-inject-gate.ts` cancel path.                                                              | Session is dead — covered by other paths; out of scope. |
| E   | Paste landed but the submit never fired (T62).                                                                                                                                | `prompt-submit.ts` quiescence + retry.                                                            | Already handled; out of scope (prompt _was_ delivered). |

**A–C are the target.** They share one observable post-condition: **the PTY is
live and `hasAgentPrompt(id)` is still true** after a short settling window.

## 4. Non-goals

- Guaranteeing the paste was _rendered_ or the Enter _submitted_ — that is the
  T62 submit-quiescence concern (`prompt-submit.ts`), already covered.
- Reworking the boot reaper's dropped-boot detection (failure mode where no PTY
  ever comes up) — unchanged.
- Any change to `pty:sessionReady` emission semantics or a new MCP verb (this stays
  renderer-internal; `docs/capy-features.md` is **not** touched).

## 5. Design — an injection watchdog

Same pure-core / thin-shell split as the boot reaper (ADR-0001).

### 5.1 Signal: "delivered" vs "queued"

Delivery, at the store level, means the prompt was **acquired** by
`acquireInjectionTarget` (consumed → `hasAgentPrompt` flips false). That is the
watchdog's success signal. `hasAgentPrompt` (added in the drop-fix) is the peek.

### 5.2 Pure verdict core

Add a pure decision function (new `injection-watchdog.ts`, or extend
`synthetic-reaper.ts`) mirroring `bootVerdict`:

```ts
export type InjectionVerdict = 'delivered' | 'pending' | 'retry' | 'undelivered'

export interface InjectionProbe {
  promptQueued: boolean // sessions.hasAgentPrompt(id)
  ptyLive: boolean // a live PTY exists to inject into
  elapsedMs: number // since the watchdog armed (PTY went live)
  attempts: number // re-arm attempts spent so far
  retryEveryMs: number // backoff between attempts (~750ms)
  maxAttempts: number // bounded budget (~4)
}

export function injectionVerdict(p: InjectionProbe): InjectionVerdict {
  if (!p.promptQueued) return 'delivered' // acquired → done
  if (!p.ptyLive) return 'delivered' // PTY gone → not our failure
  if (p.attempts >= p.maxAttempts) return 'undelivered'
  if (p.elapsedMs >= (p.attempts + 1) * p.retryEveryMs) return 'retry'
  return 'pending'
}
```

**BUG-61 (corrected post-implementation):** the two `'delivered'` shortcuts above are
wrong and shipped a real incident (2026-07-20 orphan-spawn post-mortem, defect D2).
`acquireInjectionTarget` consumes the prompt from the queue _before_
`createInjectGate` actually pastes it, so `!promptQueued` does not mean delivered —
it means the gate is still holding the paste (up to `capMs`) or about to drop it on
a `pty:exit` cancel. And `!ptyLive` conflates a session that exited normally _after_
delivering with one that died _before_ ever injecting. T172 closed the blind spot
with a real injection ledger (`injection-ledger.ts`); the corrected core reads its
`wasInjected(id)` signal via a new `injected?: boolean` probe field instead:

```ts
export function injectionVerdict(p: InjectionProbe): InjectionVerdict {
  if (p.injected) return 'delivered' // the ledger confirms the paste actually landed
  if (!p.ptyLive) return 'undelivered' // gone without a confirmed injection → not delivered
  if (p.attempts >= p.maxAttempts) return 'undelivered'
  if (p.elapsedMs >= (p.attempts + 1) * p.retryEveryMs) return 'retry'
  return 'pending'
}
```

See `src/renderer/src/stores/injection-watchdog.ts` for the shipped version and
`tests/injection-watchdog.test.ts` for the repro tests pinning both false negatives.

Unit-tested in the `node` env exactly like `synthetic-reaper.ts` (no Pinia/DOM).

### 5.3 Thin shell (TerminalPane)

`TerminalPane` already owns `armInjectGate`, `liveTerminals`, and `mcp`, so it
arms and services the watchdog:

1. **Arm** when a synthetic with a queued prompt goes live — hook the existing
   `registerLiveSession(id)` wire point (`TerminalPane.vue:633`, and the migrate
   re-key at `:1000`). Only arm when `sessions.hasAgentPrompt(id)` is true.
2. **Tick** on `retryEveryMs`: read the probe, then
   - `retry` → call `armInjectGate(id)` again (a fresh resolve+consume attempt;
     `acquireInjectionTarget` is idempotent-safe — it no-ops once consumed),
     increment `attempts`, keep ticking.
   - `delivered` → clear the watchdog. Done.
   - `undelivered` → clear the watchdog and escalate (5.4).
3. **Dispose** the watchdog on session close / PTY exit / component unload,
   alongside the existing `offSessionReady` teardown (`TerminalPane.vue:1371`).

This also rescues failure modes **B/C** (the `sessionReady` event never triggered
`armInjectGate`): the watchdog is armed off `registerLiveSession`, an independent
signal, so a missed `sessionReady` still gets serviced.

### 5.4 Visible failure — `prompt_undelivered`

On `undelivered`, escalate through the existing failure surface rather than
inventing a parallel one:

- New store method `markPromptUndelivered(id)` (sibling of
  `markSyntheticBootFailed`) sets `taskState: 'failed'` + `failureReason:
'prompt_undelivered'` via the shared `applyTaskState` helper.
- The session renders as a **visible FAILED** row (not a silent blank "working"
  session) — see 5.5 for how retry actually reaches the running PTY.
- A new i18n key for the failure-reason label in **both** `en.json` and
  `pt-BR.json` (schema parity), plus a `failure-badge.ts` branch (mirroring the
  existing `boot_timeout` branch) and a `tests/failure-badge.test.ts` case.

### 5.5 Retry — **not** `retrySyntheticBoot` (corrected during implementation)

**`retrySyntheticBoot(id)` is the wrong retry path for this failure and must not
be reused.** It re-enqueues the id into `bgBootQueue`, but `drainBgBoot`
(`TerminalPane.vue:1202-1215`) skips any id whose `liveTerminals` entry already
exists and isn't `dead` — `continue`, no-op. In the `prompt_undelivered` case the
PTY is genuinely alive (that is the whole premise of this failure mode); the
retry would silently clear the FAILED badge and do nothing else. This was caught
by re-reading `drainBgBoot` before writing the retry wiring, not by an update
after a bug report — recorded here so the mistake isn't repeated in review.

Retry instead needs a distinct path that reaches the _injection_ logic living in
`TerminalPane` (the store cannot call `armInjectGate` directly — it is
PTY/xterm-bound thin-shell code). Mirror the existing
`registerCloseHandler`/`registerMigrateHandler`/`registerReloadHandler` pattern
(`sessions.ts:1067-1106`, a `Set<(id) => void>` + register fn + dispatch loop):

- Store: `promptRetryHandlers` registry + `registerPromptRetryHandler(fn)` +
  `retryPromptInjection(id)` — clears `taskState`/`failureReason` **only when
  `failureReason === 'prompt_undelivered'`** (never step on an unrelated failure),
  then dispatches to every registered handler. The queued prompt itself needs no
  action: `undelivered` is reached only when the prompt was never acquired, so
  `hasAgentPrompt(id)` is still `true`.
- `TerminalPane`: registers a handler that re-arms the watchdog (attempt counter
  reset) and calls `armInjectGate(id)` immediately — a fresh
  peek→resolve→consume attempt, most useful once whatever blocked resolution
  (e.g. the MCP reconnect) has cleared.
- `SessionMenu.vue`'s retry item branches on `failureReason`:
  `boot_timeout` → `retrySyntheticBoot` (unchanged); `prompt_undelivered` →
  `retryPromptInjection`.

## 6. Files touched

| File                                                          | Change                                                                                                                  |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `src/renderer/src/stores/injection-watchdog.ts` _(new, pure)_ | `injectionVerdict` + types                                                                                              |
| `src/renderer/src/components/TerminalPane.vue`                | arm/tick/dispose the watchdog around `registerLiveSession` + `armInjectGate`                                            |
| `src/main/hook-state.ts`                                      | `FailureReason` union += `'prompt_undelivered'`                                                                         |
| `src/renderer/src/stores/sessions.ts`                         | `markPromptUndelivered`, `promptRetryHandlers` + `registerPromptRetryHandler`, `retryPromptInjection`; expose all three |
| `src/renderer/src/components/failure-badge.ts`                | branch for `'prompt_undelivered'` (mirrors `'boot_timeout'`)                                                            |
| `src/renderer/src/components/SessionMenu.vue`                 | retry item branches `boot_timeout` → `retrySyntheticBoot`, `prompt_undelivered` → `retryPromptInjection`                |
| `src/renderer/src/i18n/{en,pt-BR}.json`                       | failure-reason label (both, same change)                                                                                |
| `CHANGELOG.md`                                                | `### Fixed` entry                                                                                                       |
| `tests/injection-watchdog.test.ts` _(new)_                    | verdict-core cases                                                                                                      |
| `tests/agent-preprompt-queue.test.ts` or a sibling            | `markPromptUndelivered` + `retryPromptInjection` store behavior                                                         |
| `tests/failure-badge.test.ts`                                 | `'prompt_undelivered'` badge case                                                                                       |

**Gates:** no `tool-catalog.ts` / `capy-features.ts` change → awareness gate n/a.
No new top-level component or `src/main/` file, no verb change → user-docs gate n/a
(carry `no-user-docs` if the pure-core `.ts` under `stores/` trips it — it should
not, `stores/` is not a gate trigger dir). CHANGELOG required.

## 7. Test plan

- **Verdict core** (`injection-watchdog.test.ts`): delivered only when the T172
  ledger confirms an actual injection (BUG-61 — NOT on `!promptQueued`/`!ptyLive`
  alone, see the correction in §5.2); undelivered when the PTY is gone without a
  confirmed injection; `retry` at each backoff boundary; `pending` between;
  `undelivered` at the attempt ceiling; monotonic in `elapsedMs`/`attempts`.
- **Store** (`markPromptUndelivered`): sets `failed` + `prompt_undelivered`.
  (`retrySyntheticBoot` is NOT exercised against this reason — 5.5 — a test
  asserting that would codify the wrong behavior.)
- **Store** (`retryPromptInjection`): clears `failed`/`prompt_undelivered` and
  dispatches to registered handlers; a no-op (does not clear) when the
  session's `failureReason` is something else (e.g. `boot_timeout`).
- **`failureBadge`**: `'prompt_undelivered'` → red badge, distinct label key.
- **Shell wiring** (TerminalPane) stays e2e/manual — env-bound, same boundary the
  boot-queue tests already draw.

## 8. Rollout

Land on top of the drop-fix (same branch or a stacked follow-up). The drop-fix is
the safe prerequisite: it guarantees the prompt is still in the queue for the
watchdog to find and re-deliver. Shipping the watchdog without the drop-fix would
have nothing to retry (the prompt would already be gone).

## 9. Decisions

1. **Watchdog home:** new `injection-watchdog.ts` (single responsibility), not an
   extension of `synthetic-reaper.ts` — decided.
2. **Budget/backoff numbers:** `retryEveryMs = 750`, `maxAttempts = 4` (~3s total,
   comfortably past the gate's 2.5s composer-ready cap) — decided.
3. **Escalation vs. silent retry-forever:** escalate to visible
   `prompt_undelivered` after the budget — a stuck session the user can see and
   retry beats an invisible spin — decided.
4. **Retry mechanism (corrected during implementation, see §5.5):** NOT
   `retrySyntheticBoot` — a dedicated `retryPromptInjection` +
   `registerPromptRetryHandler` pair, mirroring the existing close/migrate/reload
   handler-registry pattern — decided.
