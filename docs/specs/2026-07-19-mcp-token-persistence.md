# The control server survives a restart without breaking in-flight sessions

**Date:** 2026-07-19
**Card:** BUG-35
**ADR:** `docs/adr/0004-mcp-token-persists-across-server-restarts.md`
**Answers:** AC16 / T123 §9 OQ1
**Status:** design approved, not implemented

## Problem

Toggling the MCP control server off and on — or any restart of it — permanently
breaks every already-running Capy session's agent-control verbs. The session keeps
running, keeps its context, and every Capy tool call fails from that point on, with
no explanation to the agent and no signal to the operator.

## Root cause — two independent per-boot values

`start()` (`src/main/mcp/server.ts:1168-1185`) regenerates **both** credentials a
spawned session depends on:

```ts
token = randomUUID()                        // :1170 — new secret every start
…
server.listen(0, '127.0.0.1', …)            // :1178 — new ephemeral port every start
…
await writeConfigFile(listeningPort, token) // :1183 — config rewritten with both
```

A spawned `claude` reads `--mcp-config` **once, at spawn**, and holds both values for
its lifetime. After a restart:

- the **token** no longer matches, so `http-guard.ts` rejects with 403 (constant-time
  compare, `:146`);
- the **port** no longer exists, so the request would not even reach the guard —
  `ECONNREFUSED`.

Either alone is fatal. This is why fixing only the token is not a fix: the session
would present a valid credential to a dead endpoint and fail just as completely.

**Already fixed, do not re-solve:** the spawn-time race — a session picking up a
config the server wasn't yet serving — is closed by `shouldInjectMcpConfig`
(`config-file.ts:150`), which gates injection on `running && autoRegisterEnabled &&
configExists`. That mechanism is correct and untouched here.

## Decisions

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Persist the bearer token.** New `src/main/mcp/token-store.ts` owning `<userData>/mcp-token.json`: `readOrCreateToken()` returns the stored token, minting and writing one on first run. Written via the existing `atomicWriteFile(path, body, 0o600)` seam (`atomic-write.ts:49`) inside the already-`0o700` userData dir. `start()` calls it instead of `randomUUID()` at `server.ts:1170`. |
| D2  | **Persist and re-bind the port.** The same store holds the last bound port. `start()` attempts `listen(storedPort, '127.0.0.1')` first; on `EADDRINUSE` (or any bind error) it falls back to `listen(0, …)` and records the new port. This is what makes D1 actually deliver — see ADR-0004 §5.                                                                                                |
| D3  | **Fallback is disclosed, never silent.** When the stored port is taken and Capy binds a different one, it logs and surfaces a warning in the MCP pane: in-flight sessions spawned before the restart cannot reach the server and must be restarted. Honest errors over a quiet partial recovery.                                                                                               |
| D4  | **Explicit rotate action.** The MCP pane gains a "Rotate token" control that mints a new token, rewrites both files, and warns that running sessions will lose access. This is the correct response to a suspected leak, and it is the only path that invalidates a token — never a side effect of a toggle.                                                                                   |
| D5  | **A corrupt or unreadable store is not fatal.** Unparseable JSON, a bad mode, or a read error ⇒ log, mint fresh, overwrite. The server must always be able to start; the worst case degrades to today's behavior.                                                                                                                                                                              |
| D6  | Loopback binding and the constant-time guard compare are **unchanged**. This spec changes credential _lifetime_, never the authorization mechanism.                                                                                                                                                                                                                                            |

## Scope boundary — files

**In scope:**

- `src/main/mcp/token-store.ts` — **new.** `readOrCreateToken()`,
  `readStoredPort()`, `writeStore({token, port})`, `rotateToken()`. Pure-ish: takes
  the userData dir and an injected atomic-write seam so it is unit-testable.
- `src/main/mcp/server.ts` — `start()` (`:1168-1185`): read token from the store
  instead of `randomUUID()`; attempt the stored port before `listen(0, …)`; record
  the resolved port. `stop()` unchanged (it still deletes `capy.mcp.json`; it must
  **not** delete the token store).
- `src/renderer/src/components/McpServerPane.vue` — the D4 rotate control and the D3
  port-fallback warning.
- `src/renderer/src/i18n/en.json` **and** `pt-BR.json` — new strings in **both**
  (schema parity is a build-breaking contract).
- `CHANGELOG.md` — dated entry (`### Fixed`: restarting the control server no longer
  breaks running sessions; `### Added`: rotate token).
- `docs/user/agent-control.md` — the restart behavior and what rotate does.

**Out of scope:** encryption at rest or OS-keychain storage (ADR-0004 §4 states why
this is a separate, later decision); any change to the guard, the loopback bind, or
the verb catalog; re-broadcasting credentials to running sessions (rejected in
ADR-0004 §3); `shouldInjectMcpConfig` and the spawn-time race.

**Not agent-facing.** No MCP verb, ACK shape, or grant/confirm semantic changes — an
agent's view is strictly "my calls keep working". No `docs/capy-features.md` edit and
no version-marker bump. `docs/user/` **is** required (rotate is a new user-reachable
control in an existing pane).

## Acceptance criteria

1. Start the server, spawn a session, toggle the server off and on: the session's
   Capy verbs keep working — no 403, no `ECONNREFUSED`.
2. The token in `capy.mcp.json` is identical before and after a restart; the token
   store file exists at mode `0o600`.
3. The server re-binds the stored port when free; the config's port is unchanged
   across the restart.
4. When the stored port is occupied, the server still starts on a fresh port and the
   MCP pane shows the D3 warning naming the consequence.
5. Rotate mints a new token, rewrites both files, and warns; a session holding the
   old token then gets 403 (proving rotation still works as the leak remedy).
6. A corrupt/absent token store causes a fresh mint, not a start failure (D5).
7. First run on a clean profile mints and persists a token exactly once.
8. The server still binds `127.0.0.1` only, and the guard still compares in constant
   time (regression assertions — D6).
9. `npm run typecheck` + `npm run build` pass; i18n parity holds.

## TDD plan

Harness: **vitest**. Existing suites: `tests/mcp-approval-status.test.ts`,
`tests/mcp-approval-stash.test.ts` (module-level MCP units with injected seams).

**Write this failing test FIRST**, in a new `tests/mcp-token-store.test.ts`:

```
describe('mcp token store', () => {
  it('returns the same token across two readOrCreateToken calls', ...)
})
```

Point the store at a temp dir with an injected atomic-write/read seam, call
`readOrCreateToken()` twice, assert the two values are identical **and** that the
write seam was invoked exactly once. This fails immediately today — no
`token-store.ts` exists, and the current behavior (`randomUUID()` per `start()`,
`server.ts:1170`) returns a different value every call.

Then, in the same file:

1. Written with mode `0o600` (assert the mode argument reaching the atomic-write
   seam — AC2).
2. Corrupt JSON in the store ⇒ a fresh token is returned and the store is rewritten;
   no throw (D5, AC6).
3. `rotateToken()` returns a value different from the prior token and persists it
   (D4, AC5).
4. `readStoredPort()` round-trips the port written by `writeStore` (D2).

And in a `server.start()`-level test with injected `listen`/store seams:

5. `start()` attempts the stored port first; on a simulated `EADDRINUSE` it retries
   with `0` and records the resolved port (D2, AC4).
6. Two successive `start()`/`stop()` cycles write **the same token** into
   `capy.mcp.json` (AC1/AC2 — the actual bug, asserted end-to-end at the module
   boundary).
7. `stop()` deletes `capy.mcp.json` but leaves the token store intact — the
   regression that would silently reintroduce the bug.
