### MCP gate tests never exercised the renderer actuation path

**Category:** Testing
**Severity:** High

**Rule:** When a feature spans multiple independent gates (e.g. an MCP permission core AND a separate renderer-store existence/actuation check), write at least one test per gate that exercises the FULL chain — not just unit tests against each gate in isolation — or a change to one gate can ship green while a sibling gate still blocks the same call.

**Bad:**

```
tests/mcp-permission-core.test.ts   — exhaustively covers evaluateToolCall()
tests/mcp-policy-assemble.test.ts   — exhaustively covers assemblePolicy()
tests/mcp-plan-tool-call.test.ts    — exhaustively covers planToolCall()
// command-router.ts (the renderer store's folderExists gate) has zero coverage
// from this suite — 3254 tests pass, and create_session still fails end-to-end.
```

**Good:**

```
// Add an end-to-end test that calls the same path a live agent hits:
// permission gate -> handler -> command-router -> actual session creation,
// asserting a session id comes back for a folder absent from the store —
// not just that the permission gate says "allow".
```

**Why:** PR #113 removed the MCP permission allowlist and reached 100% green across 203 test files (3254 tests), yet `create_session` in an unpinned folder still failed with `FOLDER_NOT_FOUND` from a completely separate gate (`command-router.ts`'s `folderExists` check) that no test in the suite touched. The gap was invisible until a live QA pass drove the packaged binary against the real MCP HTTP endpoint. Any verb whose success depends on more than one layer (permission + existence + storage reconciliation) needs a test that walks the whole chain, not just each layer's unit tests.
