# Spec: Roadmap dispatch race + pre-dispatch collision warning

> **Status:** Ready for implementation — **§3.4 is BLOCKED**, see the sequencing gate
> **Created:** 2026-07-19
> **Cards:** BUG-40 (primary), BUG-50 (absorbed — the "warn before colliding" half)
> **Investigation:** [`docs/plans/2026-07-15-t146-dispatch-worktree-race-debug.md`](../plans/2026-07-15-t146-dispatch-worktree-race-debug.md)
> **Depends on:** [`2026-07-19-create-session-materialization.md`](./2026-07-19-create-session-materialization.md)

---

## 1. Problem

Dispatching a Roadmap card with substrate "Worktree (new branch)" fails on the first
attempt with _"Couldn't spawn the session."_, then fails **every** retry with
_"Couldn't create the worktree for this card."_ Reproduced live on card T146.
Separately (BUG-50), nothing warns that a card already has a worktree, branch, or
open PR before a second dispatch — one duplicate dispatch shipped against a card
that already had a commit and PR #159.

## 2. Root cause (verified)

1. `src/renderer/src/components/RoadmapBoard.vue:550` — `spawnAndBind` creates the
   worktree, then at `:581` immediately calls `sessions.dispatchCardSession(...)`.
2. `src/renderer/src/stores/sessions.ts:2227` — `dispatchCardSession` does a
   synchronous `findFolderByPath` against the renderer's local `folders` array.
3. That array is refreshed only via `onFolderAdopted` → `reloadModelDebounced()`, a
   **250 ms trailing-edge debounce** (`sessions.ts` ~`:3403`) documented as being for
   fire-and-forget watcher triggers. The lookup runs at ~0 ms. This is a guaranteed
   miss, not a rare race.
4. `dispatchCardSession` returns `null` with zero diagnostic → generic toast. The
   worktree (seeded, `npm ci` already run) is orphaned on disk, never adopted.
5. `deriveWorktreePath` (`src/main/worktree-core.ts:102-109`) is a pure function of
   the branch name, so every retry resolves the identical path and collides with the
   orphan: `fatal: '<branch>' is already used by worktree at '<path>'`.

**This is renderer-local.** Field evidence: 3 worktree creations + 7 spawns through
the MCP verbs (`create_worktree` + `create_session`) never reproduced it, because
that path never consults the renderer's `folders` array. A main-process fix would
not address this bug, and the MCP path is a working reference implementation.

Contributing: bare `catch {}` at `RoadmapBoard.vue:575`; bare `return null` in
`dispatchCardSession`; no logging in the `worktree:create` ipcMain handler; the adopt
stage (`src/main/worktree-ipc.ts:1004-1019`) has no try/catch/rollback while only
seed/setup is guarded (`rollbackWorktree`, `:376-403`).

## 3. Design

### 3.1 Register the folder from the creation payload

`worktreeCreate` already returns `created.adopted` and emits `folders:adopted`
(`src/main/worktree-ipc.ts:189`; renderer subscribes via `window.api.onFoldersAdopted`,
`src/preload/index.ts:1697`). `spawnAndBind` registers the folder into the store
**from that payload** before calling `dispatchCardSession`. The 250 ms debounce stops
being on the critical path entirely — no `await reloadModel()`, no sleep, no retry
loop.

### 3.2 Surface errors

- `RoadmapBoard.vue:575` — the bare `catch {}` captures and reports the real error.
- `dispatchCardSession` returns a discriminated failure (`{ ok:false, reason }`)
  instead of bare `null`, so the toast can name the cause.
- The `worktree:create` ipcMain handler logs before forwarding a rejection.

### 3.3 Adopt-stage rollback

Wrap the adopt stage (`worktree-ipc.ts:1004-1019`) so a failure after a successful
`git worktree add` + seed + setup rolls the worktree back via the existing
`rollbackWorktree` (`:376-403`), rather than leaving an orphan that poisons retries.
Note `probeGitMeta` never throws (it catches internally); the real throw point is
`addUserProject` → `writeUserProjects`'s unguarded fs calls
(`src/main/user-projects.ts:259-271`) — that race is fixed separately by BUG-41.

### 3.4 Reuse-the-existing-worktree — **BLOCKED, DO NOT IMPLEMENT YET**

> **Sequencing gate.** Treating "branch already checked out at the card's own
> `.claude/worktrees/card-<slug>` path" as reuse rather than a hard failure is the
> right end state — but it is **forbidden until `create_session`'s single-occupancy
> dedupe has landed** (see the create-session spec §3.3).
>
> Reuse means a retry silently attaches to an existing worktree. Combined with spawns
> that can materialize ~14 minutes late, that converts a duplicate dispatch from a
> _loud_ failure (`fatal: branch already used`) into a _silent_ one. The observed
> outcome of exactly that silent shape was **five independent `claude` processes
> editing one working tree simultaneously**, caught only because `git status` was
> still clean. Shipping §3.4 first would trade this card's detectable failure for the
> create-session card's destructive one.
>
> Implement §3.1–§3.3 and §3.5 now. Land §3.4 in a follow-up PR, after the dedupe.

### 3.5 Warn before colliding (BUG-50, absorbed)

Because `deriveWorktreePath` is slug-deterministic, a collision is cheap to detect
and nothing looks today. `create_worktree`'s ACK gains a non-blocking
`existingWork` field naming any branch or worktree whose name embeds the same card
slug. **Warn, never block** — an orchestrator may legitimately want a fresh attempt.

Scope the check to local git state (`git worktree list`, `git branch -a`). A
`gh pr list` probe is explicitly out of scope: it adds a network dependency and an
auth failure mode to a dispatch path, for a warning the local branch check already
approximates.

## 4. Scope boundary

**Touch:** `src/renderer/src/components/RoadmapBoard.vue` (`~550-590`),
`src/renderer/src/stores/sessions.ts` (`dispatchCardSession` `:2227`),
`src/main/worktree-ipc.ts` (handler logging; adopt rollback `~1004-1019`),
`src/main/worktree-core.ts` (slug-match helper),
`src/main/mcp/tool-handlers.ts` (`createWorktreeHandler` ACK field),
`src/main/mcp/tool-catalog.ts` (ACK shape → awareness marker bump).
**Contracts:** `docs/capy-features.md`, `docs/user/agent-control.md`, `CHANGELOG.md`.

**Do NOT touch:** `src/main/user-projects.ts` (BUG-41's mutex owns it),
`src/main/mcp/server.ts` grant block (create-session / BUG-33).

## 5. Acceptance criteria

- [ ] AC1 A card dispatch with substrate "Worktree (new branch)" succeeds on the
      first attempt, with no dependency on the 250 ms debounce.
- [ ] AC2 A dispatch failure surfaces the real cause in the toast; no bare
      `catch {}` or bare `null` remains on this path.
- [ ] AC3 A failure after `git worktree add` + seed + setup rolls the worktree back;
      no orphan is left on disk.
- [ ] AC4 `create_worktree`'s ACK carries a non-blocking `existingWork` warning when
      a branch or worktree already embeds the same card slug; the call still succeeds.
- [ ] AC5 Board-UI dispatch produces the same end state as `create_worktree` +
      `create_session` (the known-good MCP path) — parity oracle.
- [ ] AC6 (deferred with §3.4) Reuse-the-worktree, once enabled, yields exactly one
      live session in the worktree when dispatched twice.

## 6. TDD plan

**First failing test:** `tests/sessions-store.test.ts` →
`'dispatchCardSession resolves a folder registered from the worktreeCreate payload at t=0'`.
Register the folder from a simulated `created.adopted` payload and call
`dispatchCardSession` synchronously, with the debounce timer never advanced. Assert a
session id comes back. Fails today — the store only learns the folder after the
250 ms debounce fires.

Then: (2) `'dispatchCardSession returns a named reason instead of null'`; (3)
`'a failed adopt rolls the worktree back'` (`tests/worktree-adopt.test.ts`); (4)
`'create_worktree warns when a branch embeds the same card slug'` — pure helper in
`tests/worktree-branches.test.ts`, ACK shape in `tests/mcp-tool-catalog.test.ts`; (5)
AC5 parity in `tests/dispatch-substrate.test.ts`. AC6's test is written with §3.4, not
before.
