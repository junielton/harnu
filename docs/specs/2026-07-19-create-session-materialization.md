# Spec: `create_session` materialization + single-occupancy dedupe

> **Status:** Ready for implementation
> **Created:** 2026-07-19
> **Card:** `create-session-returns-ok-true-without-launching-a-session` (absorbs BUG-47)
> **PRD:** [`docs/prds/create-session-honest-ack.md`](../prds/create-session-honest-ack.md)
> **ADR:** [`docs/adr/0003-create-session-ack-means-materialized.md`](../adr/0003-create-session-ack-means-materialized.md)
> **Blocks:** [`2026-07-19-dispatch-race-and-collision-warn.md`](./2026-07-19-dispatch-race-and-collision-warn.md) (BUG-40's reuse fix is forbidden until this lands)

---

## 1. Problem

`create_session` ACKs `ok:true` on intent, not outcome. Three observed shapes:
phantom (nothing spawns, grant unit burned), delayed batch (~14 min, four processes
land at once in one working tree), orphaned PTY (process alive 2.5 h, never wired
into Capy's session model). Full evidence in the PRD §1.

## 2. Root cause (verified)

- `src/main/mcp/tool-handlers.ts:544-580` — `createSessionHandler` returns
  `ok: dispatchSucceeded(result)` where `result` is the renderer's `session.create`
  return (a `syntheticId`). No materialization check exists.
- `src/main/mcp/tool-handlers.ts:524-543` — `ensureFolderThenRetryCreate` already
  demonstrates the polling pattern (`FOLDER_ADOPT_BUDGET_MS = 4_000`,
  `FOLDER_ADOPT_POLL_MS = 150`), but only for folder adoption.
- `src/main/mcp/server.ts:766` — `reserve(grantId)` spends a budget unit
  synchronously; `release(grantId)` runs only in the `catch` at `:782`. A handler
  that resolves with a falsy outcome never refunds.

## 3. Design

### 3.1 Materialization signal

The renderer owns synth→real migration. Add a bridge event, not a poll:

- `src/renderer/src/stores/sessions.ts` — when a synthetic id migrates to a real
  session id, emit `session.materialized { syntheticId, sessionId, folder }`.
- `src/main/command-bridge.ts` / `command-bridge-ipc.ts` — forward it; expose
  `awaitMaterialization(syntheticId, timeoutMs): Promise<Materialization | null>`.

Materialization requires **both**: the migration event **and** a transcript under
`~/.claude/projects/<slug>/`. The orphaned-PTY shape proves a live process is not
sufficient evidence — Capy's own bookkeeping must have wired it.

### 3.2 Handler flow

```
createSessionHandler(args, ctx):
  if inFlight.has(folder) or folderHasLiveSession(folder):   # §3.3
     return steerError('SESSION_ALREADY_IN_FLIGHT', folder)
  inFlight.add(folder, syntheticId)
  result = bridge.dispatch('session.create', payload)
  mat = await awaitMaterialization(syntheticId, MATERIALIZE_DEADLINE_MS)
  inFlight.delete(folder)
  if mat: return ok:true  ACK (unchanged shape + sessionId)
  else:   return ok:false steerError('SPAWN_NOT_MATERIALIZED', cause) + refund
```

`MATERIALIZE_DEADLINE_MS = 60_000`. Rationale and its tradeoff are in ADR-0003 §4 —
it is tuned for caller ergonomics, and §3.4 is what makes that safe.

### 3.3 Single occupancy (per folder)

`src/main/pty-session-index.ts` gains an in-flight registry keyed by normalized
folder path. A `create_session` is refused when the folder has either an
un-materialized spawn or a live agent-dispatched session. Refusal is a steerable
error, never a silent queue — a queued duplicate is the collision, delayed.

**This is the guarantee BUG-40's reuse-the-worktree fix depends on.** Shipping that
fix first converts a loud `fatal: branch already used` into a silent five-process
race. The dependency is hard, not advisory.

### 3.4 Late spawns cannot attach

On `SPAWN_NOT_MATERIALIZED` the syntheticId is recorded as abandoned. If it later
materializes, the renderer refuses to attach it to a folder that has since acquired
a session, and disposes the PTY. This is what makes a 60 s deadline safe against a
14-minute tail.

### 3.5 Observability

- `get_session(syntheticId)` returns `{ status: 'spawning' }` while in flight
  (`src/main/mcp/tool-catalog.ts` + the fleet snapshot), never bare
  `SESSION_NOT_FOUND`.
- An agent-created worktree inherits observability from its creation: after
  `create_worktree` + `create_session` in one folder, `get_session` resolves without
  a separate allowlist gesture. `create_worktree` already calls
  `addDynamicFolder(grantId, path)` (`src/main/mcp/server.ts:773-776`) — extend the
  same scope to the transcript gate rather than inventing a second mechanism.

### 3.6 Grant accounting

`server.ts`'s grant block refunds on **any** non-success outcome, not only on throw.
Introduce an explicit success predicate over the actuation result; `release(grantId)`
runs whenever it is false. `pushShadowEntry` moves behind the same predicate — the
operator's shadow log must not claim an action that did not happen.

## 4. Scope boundary

**Touch:** `src/main/mcp/tool-handlers.ts`, `src/main/mcp/server.ts` (~654-790),
`src/main/mcp/grant-core.ts`, `src/main/mcp/grant-registry.ts`,
`src/main/mcp/tool-catalog.ts`, `src/main/mcp/fleet-snapshot.ts`,
`src/main/command-bridge.ts`, `src/main/command-bridge-ipc.ts`,
`src/main/pty-session-index.ts`, `src/renderer/src/stores/sessions.ts`.
**Contracts:** `docs/capy-features.md` (+ marker bump), `docs/user/agent-control.md`,
`CHANGELOG.md`.

**Do NOT touch:** `src/main/mcp/deadline.ts` (BUG-33's spec owns it),
`src/renderer/src/components/RoadmapBoard.vue` (BUG-40), `src/main/worktree-*.ts`.

## 5. Acceptance criteria

- [ ] AC1 `ok:true` ⟺ migration event **and** transcript on disk.
- [ ] AC2 Timeout/failure ⇒ `ok:false` + steerable cause + grant unit refunded.
- [ ] AC3 Second `create_session` for a folder with a spawn in flight is refused;
      live agent sessions per folder ≤ 1.
- [ ] AC4 A spawn landing after its call resolved failed does not attach.
- [ ] AC5 `get_session(syntheticId)` reports `spawning` while pending.
- [ ] AC6 Agent-created worktree observable by its creator via `get_session`.
- [ ] AC7 Shadow log records only actions that materialized.

## 6. TDD plan

**First failing test:** `tests/mcp-create-session-ack.test.ts` →
`'create_session returns ok:false and refunds the grant when the spawn never materializes'`.
Inject a bridge whose `session.create` resolves a syntheticId and whose
materialization event never fires; inject a short deadline. Assert `ok:false`, a
named cause, and `remainingFor(grantId)` unchanged. Fails today at the first
assertion — `dispatchSucceeded` is true as soon as a syntheticId returns.

Then: (2) `'a second create_session for a folder with a spawn in flight is refused'`;
(3) `'a late materialization does not attach to a folder that acquired a session'`;
(4) `'get_session reports spawning while pending'`; (5) grant-accounting regressions
in `tests/mcp-grant-core.test.ts` and `tests/mcp-grant-registry.test.ts`
(reserve → non-throwing failure → release); (6) shadow-log suppression on a
non-materialized call.

Bridge, clock, and deadline are all injected — pure-core coverage per ADR-0001, no
Electron mocks, no fake timers.
