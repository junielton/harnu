### Permission verdict is not an actuation result

**Category:** QA
**Severity:** Critical

**Rule:** When verifying that a gated action "worked," check that the effect actually exists (the session was created, the file was written, the record persisted) — never infer success from the gate's verdict alone (`allow`, `AGENT_ALLOWED`, an audit-log entry).

**Bad:**

```
// mcp-audit.json shows: {"tool":"create_session","verdict":"allow","result":"AGENT_ALLOWED"}
// Conclusion: "the session was created, the cycle works end to end."
```

**Good:**

```
// mcp-audit.json shows: {"tool":"create_session","verdict":"allow","result":"AGENT_ALLOWED"}
// Then separately call get_session / get_fleet on the returned id and confirm
// a real session exists before reporting success.
```

**Why:** A permission gate and an actuation path are independent layers that can both exist for the same verb. In PR #113 the MCP permission gate correctly allowed `create_session` in an unpinned folder (`verdict=allow`), but a THIRD gate — an existence check in the renderer's `command-router.ts` (`folderExists`) — silently rejected the same call with `FOLDER_NOT_FOUND`. Reading the audit log and reporting the cycle as working, without confirming a session actually existed, was a false-positive review that would have shipped a half-fixed bug to the operator.
