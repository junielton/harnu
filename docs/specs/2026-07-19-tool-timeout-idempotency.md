# Spec: `TOOL_TIMEOUT` idempotency, audit correlation, and grant reconciliation

> **Status:** Ready for implementation — **stacks on**
> [`2026-07-19-create-session-materialization.md`](./2026-07-19-create-session-materialization.md)
> **Created:** 2026-07-19
> **Card:** BUG-33
> **Upstream spec:** T123 §W5 (AC12/AC13) — `docs/specs/T123-fleet-index-and-visibility-window.md`

> **Sequencing.** Both units rewrite `src/main/mcp/server.ts`'s actuate + grant block
> (`~654-790`). They must land in order, not in parallel. This spec assumes the
> create-session unit's explicit success predicate and refund path already exist.

---

## 1. Problem

The 120 s server-side deadline returns `TOOL_TIMEOUT` to the client, but Node cannot
cancel the underlying handler. A call that was merely _slow_ keeps running and may
complete its mutation **after** the client already got an error and retried — a
duplicate applied action, with nothing in the audit trail linking the two.

For mutating verbs (`create_session`, `create_worktree`, `submit_manifest`, board
writes) that is a silent double-apply. `create_session`'s new materialization wait
(60 s) makes this materially more likely, not less: the verb now has a long tail
that can approach the 120 s tool deadline.

## 2. Root cause (verified)

- `src/main/mcp/deadline.ts` — `TOOL_CALL_DEADLINE_MS = 120_000`. The module doc is
  explicit that the guarantee is narrow: _"Node cannot force-cancel a pending
  promise — the underlying work keeps running until it settles on its own"_. On a
  trip it resolves `{timedOut:true}` and discards the winner.
- `src/main/mcp/server.ts:661` — `const raced = await withDeadline(work, TOOL_CALL_DEADLINE_MS)`;
  `:676` — `return errorResult('TOOL_TIMEOUT')`. It **returns**, it does not throw.
- `src/main/mcp/server.ts:766-786` — the grant-allowed mutation path calls
  `reserve(grantId)` up front, then `release(grantId)` **only** inside the `catch`
  at `:782`. Because a timeout returns rather than throws, two things follow:
  1. `release` never runs — the budget unit is spent on a call that may or may not
     have landed, and the agent's retry spends a second unit.
  2. `pushShadowEntry({ event: 'mcp:<op>', by: 'mission-grant' })` at `:767-773`
     still fires — the operator's shadow log reads as if the mission performed the
     action, even when it may never have completed.

## 3. Design

### 3.1 Idempotency key on mutating verbs

Every mutating tool call carries a derived **call id** (`callId`), stable across a
retry of the same intent. Derivation is server-side and deterministic — verb +
normalized folder + a caller-supplied `idempotencyKey` when present, else a hash of
the normalized args. Client-supplied keys are honored but never required; an agent
should not have to opt in to correctness.

A registry (`src/main/mcp/idempotency-registry.ts`, new) maps `callId` → outcome
(`in-flight` | `applied` | `failed`) with a TTL comfortably above the tool deadline.
A mutating call whose `callId` is already `in-flight` or `applied` returns the
recorded outcome instead of actuating a second time.

This subsumes the ad-hoc per-folder guard from the create-session unit for the
retry case; the per-folder single-occupancy guard stays, since it also covers
genuinely distinct calls racing into one folder.

### 3.2 Audit correlation

`callId` is written into every audit record — the synthetic `TOOL_TIMEOUT` record
**and** the record for the handler's eventual late completion. The trail then shows
the pair as one intent rather than two unrelated actions.
Files: `src/main/mcp/audit-log.ts`, `src/main/mcp/audit-persist.ts`.

### 3.3 Refuse to actuate after the deadline fired

Where a verb's shape allows it, the handler checks a `deadlineFired` flag before its
final commit step and aborts instead of applying. This cannot be universal — some
mutations commit inside a library call we do not control — so it is a per-verb
hardening, applied to `create_session`, `create_worktree`, `submit_manifest`, and the
board writers. Verbs that cannot honor it rely on §3.1 to dedupe the retry instead.

### 3.4 Budget + shadow-log reconciliation

Both must move behind the same success predicate introduced by the create-session
unit:

- `release(grantId)` runs on `TOOL_TIMEOUT` (the unit is refunded; the intent is
  unresolved, and charging for an unresolved action is the wrong default — a late
  completion re-reserves under its own `callId`).
- `pushShadowEntry` fires only on a confirmed applied outcome. A timed-out call
  writes a distinct `mcp:<op>:timeout` shadow entry so the operator sees the
  ambiguity rather than a false success.

## 4. Scope boundary

**Touch:** `src/main/mcp/deadline.ts` (expose the fired flag),
`src/main/mcp/server.ts` (`~654-790`), `src/main/mcp/idempotency-registry.ts` (new),
`src/main/mcp/audit-log.ts`, `src/main/mcp/audit-persist.ts`,
`src/main/mcp/grant-core.ts`, `src/main/mcp/grant-registry.ts`,
`src/main/mcp/tool-handlers.ts` (per-verb pre-commit guard),
`src/main/mcp/tool-catalog.ts` (optional `idempotencyKey` arg → awareness marker bump).
**Contracts:** `docs/capy-features.md`, `docs/user/agent-control.md`, `CHANGELOG.md`.

**Do NOT touch:** the materialization signal, `pty-session-index.ts`,
`stores/sessions.ts` — owned by the create-session spec.

## 5. Acceptance criteria

- [ ] AC1 A mutating call that trips the deadline and is retried can no longer yield
      two applied actions: either the late original is suppressed, or the retry is
      deduped by `callId`.
- [ ] AC2 The synthetic timeout audit record and the late completion's record share
      a `callId`.
- [ ] AC3 `TOOL_TIMEOUT` refunds the reserved grant budget unit.
- [ ] AC4 A timed-out call writes a `timeout` shadow entry, never a success entry.
- [ ] AC5 `create_session`, `create_worktree`, `submit_manifest`, and board writers
      refuse to commit after the deadline has fired.

## 6. TDD plan

**First failing test:** `tests/mcp-deadline.test.ts` →
`'a TOOL_TIMEOUT on a grant-allowed mutation refunds the budget unit'`.
`tests/mcp-deadline.test.ts` already injects the timer (`setTimer` is a dependency,
per ADR-0001), so drive a mutating handler past a short injected deadline and assert
`remainingFor(grantId)` is restored. Fails today: the timeout returns rather than
throws, so the `catch` at `server.ts:782` never runs.

Then: (2) `'the timeout record and the late completion share a callId'`
(`tests/mcp-audit-log.test.ts`); (3) `'a retry of a timed-out mutating call is
deduped by callId'` (new `tests/mcp-idempotency-registry.test.ts`); (4) `'a timed-out
call writes a timeout shadow entry, not a success entry'`; (5) per-verb
`'refuses to commit after the deadline fired'` in `tests/mcp-tool-catalog.test.ts` /
handler tests.
