### Live-binary smoke test required before claiming a security-posture change works

**Category:** QA
**Severity:** Critical

**Rule:** For any change to the MCP permission/gate/actuation chain, a green `vitest run` is necessary but not sufficient — drive the actual packaged binary (or `build:unpack`) against the real MCP HTTP endpoint in an isolated `--user-data-dir` before reporting the change works end to end.

**Bad:**

```
$ npx vitest run
 Test Files  203 passed (203)
      Tests  3254 passed (3254)
// Reported: "the free-by-default flip works, PR is ready to merge."
```

**Good:**

```
Build (npm run build:unpack), launch an isolated instance
(--user-data-dir=/tmp/capy-verify, a free --remote-debugging-port),
then call create_session on the live MCP HTTP endpoint against a
folder that was never pinned. Confirm a REAL session id comes back,
not just an "allow" verdict in an audit log.
```

**Why:** Two real, high-severity bugs in the PR #113 episode were invisible to the 3254-test vitest suite and only surfaced by driving the packaged binary: (1) `agentControllable`/`controllable` in `get_fleet`/`list_worktrees` were still derived from the dead allowlist, so a well-behaved agent would read `false` and stand down even though the gate had opened — silent self-blocking with zero test failures; (2) the `command-router.ts` `folderExists` existence gate rejected the exact calls the permission gate allowed. The MCP test suite exhaustively covers `permission-core`/`policy-assemble`/`plan-tool-call` but never drives the renderer actuation path end-to-end, so a change can be 100% green there and still not work for a real agent.
