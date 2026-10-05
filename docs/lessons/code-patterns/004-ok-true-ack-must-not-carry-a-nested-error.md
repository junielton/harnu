### ok:true ACK must not carry a nested error

**Category:** Code Patterns
**Severity:** High

**Rule:** An MCP/IPC response's top-level `ok` field must reflect whether the requested effect actually happened. Never return `ok:true` with a `result.error` (or any nested failure) — an agent that trusts the top-level flag will treat the call as successful and move on.

**Bad:**

```ts
// create_session handler
const created = tryCreate(folder)
return { ok: true, op: 'create_session', result: created } // created may be {"error": "FOLDER_NOT_FOUND"}
```

**Good:**

```ts
const created = tryCreate(folder)
if ('error' in created) return { ok: false, op: 'create_session', error: created.error }
return { ok: true, op: 'create_session', result: created }
```

**Why:** This exact shape (`{"ok":true,"result":{"error":"FOLDER_NOT_FOUND"}}`) recurred in the PR #113 episode at a new call site, after the operator had already documented the same "ok:true mentiroso" pattern from a prior `create_session` race in a separate post-mortem. The lesson from that post-mortem never got systematized into a shared response builder or a lint check, so the same bug shape shipped again under a different gate. A shared "build ACK" helper that refuses to set `ok:true` alongside any error field would catch this at the type level instead of per-incident.
