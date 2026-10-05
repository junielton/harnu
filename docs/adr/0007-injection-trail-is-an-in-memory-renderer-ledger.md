# ADR-0007 — The pre-prompt injection trail is an in-memory renderer ledger, not persisted, not logged

**Status:** Accepted
**Date:** 2026-07-20
**Author:** agent
**Deciders:** junielton
**Technical context:** Injection-trail instrumentation (T172), sibling of the injection watchdog (`docs/specs/2026-07-15-preprompt-injection-watchdog.md`) and BUG-61

---

## 1. Context

The 2026-07-20 orphaned-spawn post-mortem
(`docs/reports/2026-07-20-orphan-spawn-postmortem.md`) proved five defects (D1–D5)
from disk state and the MCP audit log, but explicitly could **not** prove what lost
the injection for the two orphaned sessions — because the entire pre-prompt
injection path (`prompt-inject-gate.ts`, `prompt-inject.ts`, the `armInjectGate`
shell in `TerminalPane.vue`, `injection-watchdog.ts`) had **zero instrumentation**.

That same blind spot is D2: `injectionVerdict` treats "not queued" as `delivered`,
but `acquireInjectionTarget` consumes the prompt from the queue **before**
`createInjectGate` actually pastes it. In that window the prompt is neither queued
nor delivered, and nothing records which one actually happened.

T172's job is to close the blind spot: emit a signal at every decision point
(target resolved/failed, prompt dequeued, gate fired + via which input, paste
written, submit written, gate cancelled on `pty:exit`), shaped so the D2 fix
(BUG-61, a separate card) can consume a real "was it injected?" state instead of
guessing from "is it still queued?". The design note on the T172 card is explicit
that **where this signal lands is architectural** and likely needs an ADR.

## 2. Decision

**The trail is a renderer-only, in-memory ledger, keyed by session id, with no
disk persistence and no `console.*` calls.**

`src/renderer/src/stores/injection-ledger.ts` exports `createInjectionLedger()` —
a `Map<sessionId, InjectionLedgerEvent[]>` behind a small typed API
(`record`, `getTrail`, `statusFor`, `wasInjected`, `rekey`, `clear`) — and a
singleton instance wired into the live code:

- `prompt-inject-gate.ts`'s `acquireInjectionTarget` and `createInjectGate` accept
  an **optional** `record` dependency (mirroring their existing injected-timer /
  injected-action style, per ADR-0001's pure-core convention) and call it at each
  decision point.
- `prompt-inject.ts`'s `pasteAndSubmit` accepts the same optional `record` and
  calls it after each successful `ptyWrite` (the bracketed paste, and every
  submitting `\r`, including the one safe retry).
- `TerminalPane.vue`'s `armInjectGate` is the only production wiring: it passes
  `(event) => injectionLedger.record(id, event)` at both call sites.
- `sessions.ts`'s `fireMigrate` calls `injectionLedger.rekey(fromId, toId)` inline,
  next to the existing `carryAgentPrompt(fromId, toId)` — the same synth→real
  migration edge the pending-prompt queue already crosses.

`statusFor(sessionId)` returns `'none' | 'dequeued' | 'injected' | 'cancelled'` —
the literal injected/dequeued distinction the card's acceptance criteria call out,
derived from the trail rather than stored as a separate flag, so it can never
drift out of sync with the events that produced it.

## 3. Alternatives considered

### A. `console.*` / a debug-only logger — rejected

Explicitly ruled out by the card's design note: "this is not throwaway debug
logging." A `console.log` is not queryable state — BUG-61 needs to ask "was id X
injected?" and get a real answer, not grep a log stream. Also fails the "survives
the synth→real migration" acceptance criterion outright: a log line stamped with
the synthetic id has no mechanism to follow the session to its real uuid.

### B. A persisted ledger (mirroring ADR-0006's terminal ledger) — rejected

ADR-0006 persists `errored`/`done` fleet states because they must survive an app
**restart** — the whole point is that a badge the operator needs to see at 09:05
must not evaporate at 09:00's relaunch. The injection trail has no equivalent
requirement: it is only ever meaningful while the PTY it describes is still
running in the **same** renderer process. Once the app restarts, the PTY is gone,
`armInjectGate` never reran for that dead process, and there is nothing left to
diagnose live — forensics on a past incident is what `docs/reports/` is for
(written by hand from the audit log + on-disk transcripts, as the 2026-07-20
post-mortem already demonstrates), not a job for this ledger. Persisting it would
add a `userData` file, a retention/pruning rule, and a restore-on-boot path for a
requirement that does not exist — over-scoped relative to what BUG-61 actually
needs to consume.

### C. Push it into the `~/.config/capy/mcp-audit.json` shadow log — rejected

That log is MCP **gate verdicts** (`session.create` allow/deny), rotated at 200
records — a different domain (server-side authorization decisions) with a
different owner (`src/main/mcp/`) and a different retention model that would
rotate this trail away within a day, exactly the failure mode the T172 card opens
with. Mixing the two would also require a renderer→main IPC round trip on every
injection event for a signal that a same-process watchdog (BUG-61, itself
renderer-side in `TerminalPane.vue`) needs to read back synchronously.

### D. Fold it into `injectionWatchdogs` (the `Map` already local to `TerminalPane.vue`) — rejected

`injectionWatchdogs` tracks _retry budget_ (`armedAt`, `attempts`) for the watchdog
loop, disposed the moment a verdict resolves (`disarmInjectionWatchdog`). The trail
needs to **outlive** that disposal — BUG-61's `markPromptUndelivered` escalation,
and any future "why did this fail?" inspection, both want to read the trail
_after_ the watchdog has already given up. Folding the two together would force a
choice between losing the trail early (matching the watchdog's lifecycle) or
never cleaning up the watchdog map (defeating its own purpose). A dedicated
module keeps the two concerns' lifecycles independent.

## 4. Consequences

**Positive**

- Zero-cost for the common case **by construction**, not by a guard: every
  `record` call sits behind `hasPrompt()` / a resolved target, so a promptless
  session never reaches a call site that would touch the ledger at all — no
  Pinia state, no reactive overhead, nothing to opt out of.
- Testable without Electron/xterm/Pinia — `injection-ledger.ts` has no
  `electron`/`node-pty`/`vue` import, consistent with ADR-0001's pure-core
  convention.
- `statusFor` gives BUG-61 exactly the distinction D2 is missing, as one function
  call, no new IPC surface.
- The rekey lands on the exact same edge (`fireMigrate`) the pending-prompt queue
  already crosses, so there is no second migration path to keep in sync.

**Negative / accepted costs**

- No cross-restart forensics — a crash mid-injection loses the trail with the
  process. Accepted per Alternative B: the trail's only consumer (BUG-61) is
  itself renderer-side and same-process; a hard crash losing renderer state is
  already true of every other in-memory session structure this codebase carries
  (`liveTerminals`, `pendingAgentPrompts`, `injectionWatchdogs`).
- No explicit cleanup on session close — trails for closed sessions sit in the
  `Map` until the renderer process ends. Accepted as consistent with
  `pendingAgentPrompts`' existing lifecycle (also uncapped, also renderer-process
  scoped); revisit only if this measurably matters, since agent-created sessions
  with a queued prompt are a small subset of all sessions.

## 5. Relationship to BUG-61

This ADR does not fix D2. It makes D2 fixable: BUG-61's job is to replace
`injectionVerdict`'s `!p.promptQueued → 'delivered'` shortcut with a read against
`injectionLedger.statusFor(id)`, so a session sitting in the `'dequeued'` window
(consumed but not yet — or never — pasted) stops being misreported as delivered.
