# PRD: `create_session` — an honest ACK

> **Status:** Draft
> **Author:** Claude (investigation & drafting)
> **Created:** 2026-07-19
> **Cards:** `create-session-returns-ok-true-without-launching-a-session` (primary),
> BUG-47 (absorbed — same root cause), BUG-50 (sibling symptom, specced separately)
> **Specs:** [`docs/specs/2026-07-19-create-session-materialization.md`](../specs/2026-07-19-create-session-materialization.md)
> **ADR:** [`docs/adr/0003-create-session-ack-means-materialized.md`](../adr/0003-create-session-ack-means-materialized.md)

---

## 1. Problem

`create_session` returns `ok: true` for sessions that never started. Five field
occurrences (2026-07-10, 07-13, 07-17, and twice on 07-18), across three distinct
failure shapes:

1. **Phantom.** Nothing ever spawns. No process, no project dir under
   `~/.claude/projects/`, no transcript — yet the ACK read `ok:true` and
   `grantBudgetRemaining` had already decremented. The operator's approval was
   spent on nothing.
2. **Delayed batch.** Five calls ACKed, all appeared dead for ~14 minutes, then
   **four materialized simultaneously** as independent `claude` processes with the
   identical `cwd`. Caught only because `git status` was still clean; four were
   `SIGTERM`'d. This was a near-miss corruption incident, not a nuisance.
3. **Orphaned PTY.** A process booted, held the correct `cwd` and live TCP
   connections (Anthropic API + Capy's own MCP loopback) for 2.5+ hours, and was
   **never wired into Capy's session model at all** — the folder showed no session
   entry the entire window. Consistent with a PTY whose write side was never
   attached, so the boot prompt never arrived. BUG-47's two sibling sessions show
   the identical signature; that card is absorbed here.

The failure is self-amplifying: an ACK that lies causes the caller to retry, and
retries in shape 2 land concurrently in one working tree.

## 2. Root cause

`createSessionHandler` (`src/main/mcp/tool-handlers.ts:544-580`) ACKs on
`dispatchSucceeded(result)`, where `result` is the renderer's `session.create`
dispatch return — a `syntheticId`, i.e. a receipt for **intent**. Nothing waits for
the synth→real migration (PTY spawned, project dir created, transcript on disk).

A partial precedent already exists in the same file: `ensureFolderThenRetryCreate`
(`tool-handlers.ts:524-543`) polls the bridge for up to `FOLDER_ADOPT_BUDGET_MS`
(4 s, 150 ms interval) when the folder is unknown. So the handler already knows how
to await a renderer-side condition — it simply never applies that to the thing the
ACK actually claims.

Budget accounting compounds it. `server.ts:766` reserves one grant unit
synchronously; `release(grantId)` runs **only** in the `catch` at `server.ts:782`.
A handler that resolves with a falsy outcome (or with `TOOL_TIMEOUT`, see BUG-33)
never throws, so the unit is spent regardless of outcome.

## 3. Decisions

Recorded in full in ADR-0003. Summary:

- **`ok: true` means materialized.** Not "dispatched", not "queued". This is not a
  new promise — `docs/capy-features.md:47` already tells every session
  _"`ok:true` means the session was actually created"_. The code does not honor a
  contract we already ship, so the fix is to honor it, not to renegotiate it.
- **Bounded, not unbounded.** A materialization wait needs a deadline; on expiry the
  ACK is `ok:false` with a steerable error, and the grant unit is refunded.
- **Single occupancy per folder.** A second `create_session` for a folder with an
  un-materialized spawn in flight is refused, not queued. This is the structural fix
  for shape 2 — it makes the concurrent collision impossible rather than asking the
  caller to notice it via `ps`.
- **In-flight is observable.** `get_session(syntheticId)` returns a `spawning` state
  while a spawn is genuinely pending. `SESSION_NOT_FOUND` today is ambiguous between
  "never happened" and "still coming", and that ambiguity is what triggers retry storms.
- **An agent-created worktree is observable by its creator.** After
  `create_worktree` + `create_session` in one folder, `get_session` must work with no
  separate allowlist gesture (today: `FOLDER_NOT_ALLOWED`).

## 4. Scope boundary

**In scope (files):**

| File                                                  | Change                                                                |
| ----------------------------------------------------- | --------------------------------------------------------------------- |
| `src/main/mcp/tool-handlers.ts`                       | `createSessionHandler` awaits materialization; single-occupancy guard |
| `src/main/mcp/server.ts`                              | Grant release on non-throwing failure (`~766-786`)                    |
| `src/main/mcp/grant-core.ts`, `grant-registry.ts`     | Refund path for a failed spawn                                        |
| `src/main/command-bridge.ts`, `command-bridge-ipc.ts` | Materialization signal from renderer                                  |
| `src/renderer/src/stores/sessions.ts`                 | Emit synth→real migration event                                       |
| `src/main/pty-session-index.ts`                       | Per-folder in-flight registry (single occupancy)                      |
| `src/main/mcp/tool-catalog.ts`                        | ACK shape + `get_session` `spawning` state                            |
| `docs/capy-features.md`                               | Marker bump (agent-facing ACK semantics)                              |
| `docs/user/agent-control.md`                          | Human prose for the same                                              |
| `CHANGELOG.md`                                        | Mandatory entry                                                       |

**Out of scope:** the `TOOL_TIMEOUT` late-completion problem (BUG-33 — stacks on this
unit, shares `server.ts`'s grant block); the renderer board-dispatch race (BUG-40 —
sequenced behind this); worktree collision warnings (BUG-50, folded into BUG-40).

## 5. Acceptance criteria

- [ ] AC1 — `create_session` never returns `ok: true` for a session that did not start.
      "Started" = a process whose `cwd` is the folder **and** a transcript under
      `~/.claude/projects/<slug>/`.
- [ ] AC2 — A failed or timed-out spawn returns `ok: false` with a steerable error
      naming the likely cause, and **refunds the reserved grant budget unit**.
- [ ] AC3 — A second `create_session` for a folder with an un-materialized spawn in
      flight is refused. Live agent-dispatched sessions per folder is always ≤ 1.
- [ ] AC4 — A spawn that lands _after_ its call already resolved as failed is
      cancelled, or refuses to attach to a folder that has since acquired a session.
- [ ] AC5 — `get_session(syntheticId)` returns `spawning` while a spawn is genuinely
      pending, never a bare `SESSION_NOT_FOUND`.
- [ ] AC6 — After `create_worktree` + `create_session` in one folder, `get_session`
      on the resulting session succeeds without a separate allowlist gesture.
- [ ] AC7 — The 2026-07-10 post-mortem workaround (poll the filesystem for a
      transcript) is no longer required for correctness.

## 6. TDD plan

**Write this test first, and watch it fail:**

`tests/mcp-create-session-ack.test.ts` →
`'create_session returns ok:false and refunds the grant when the spawn never materializes'`

Stub the `CommandBridge` so `session.create` resolves a `syntheticId` but the
migration signal never fires. Assert: the ACK is `ok:false`; the error names the
cause; `remainingFor(grantId)` is unchanged from its pre-call value. Today the first
assertion fails immediately — `dispatchSucceeded` is true the moment a syntheticId
comes back.

Then, in order:

1. `'a second create_session for a folder with a spawn in flight is refused'` (AC3).
2. `'a spawn landing after its call resolved failed does not attach'` (AC4).
3. `'get_session reports spawning while the spawn is pending'` (AC5) — extend
   `tests/mcp-fleet-snapshot.test.ts` if the state lives in the snapshot.
4. `'an agent-created worktree is observable by its creator'` (AC6).
5. Grant accounting regressions in `tests/mcp-grant-core.test.ts` /
   `tests/mcp-grant-registry.test.ts`: reserve→failed-actuation→release.

All are pure-core testable per ADR-0001 — the bridge and the clock are injected, so
no Electron or fake-timer gymnastics are required.
