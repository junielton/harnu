# 002-cc-strips-settings-hook-keys: don't key identity on custom keys in `settings.json` hooks

**Category:** framework (Claude Code / `~/.claude/settings.json`)
**Discovered in:** Hook Bridge ECONNREFUSED fix, `801ba8a` (Jun 2026)
**Status:** active

## The bug

Claude Code sessions intermittently surfaced `UserPromptSubmit hook error /
ECONNREFUSED`. A dead Hook Bridge entry (a crashed/killed prior instance's
ephemeral port) lingered in `~/.claude/settings.json`; CC POSTs every hook to
**all** registered entries, so the dead port refused the connection. The earlier
boot-time self-heal (`5d897f6`) was supposed to prune exactly these orphans but
silently never did.

## Root cause

The Hook Bridge identified its own and peer entries by an `_om2tab: "v1"`
sentinel key it wrote into each handler object. Claude Code re-serializes
`~/.claude/settings.json` through a **strict Zod schema** on every settings write
(`/model`, `/theme`, a permission change). The hook-handler schema is a plain
`.object()` with no `.passthrough()`/`.catchall()`, so it **drops unknown keys
from handler objects** (unknown _top-level_ keys survive; handler-level ones do
not). Once CC stripped the sentinel, `isOurs` → `om2tabPorts` →
`reconcileHooks`/`removeOwnHooksSync` matched nothing: dead-port orphans were
never pruned and the bridge couldn't even remove its own entry on exit. The
defect class is **keying identity on data a co-owner of the file silently
mutates.** Verified live on Claude Code 2.1.178 (CC strips the key on `/theme`).

## The fix (and why)

Identify our handlers by their bridge-URL shape — a field CC round-trips intact —
instead of the strippable key. The sentinel is still written, but only as a
redundant fallback signal; identity must not depend on it.

```ts
// src/main/hook-installer.ts
const BRIDGE_URL = /\/\/127\.0\.0\.1:\d+\/hook\/[^/]+\/[^/]+\/[^/]+/
function isOurs(h: Handler): boolean {
  const url = candidateUrl(h) // h.url, or the curl URL inside h.command
  if (url && BRIDGE_URL.test(url)) return true
  return SENTINEL in h // fallback only
}
```

## How to detect in reviews

1. Any code that writes a custom/marker key into a `hooks[].hooks[]` handler in
   `~/.claude/settings.json` and later _depends_ on it surviving — CC strips it.
   ```bash
   git grep -n "SENTINEL\|_om2tab" src/main
   ```
2. More general fault line: reconciliation/identity over an **externally
   co-owned** file or record that keys on data the external owner can normalize
   away. Identity must come from fields the co-owner preserves (a URL, or a
   namespaced id embedded in a kept field) — not a side-channel key.
3. "Self-heal only at boot" smell: a peer that dies _mid-session_ under a
   long-lived instance still isn't pruned until the next boot (open follow-up —
   a lazy/periodic re-prune would close it).

## Related

- `src/main/hook-installer.ts` (`isOurs`/`candidateUrl`/`BRIDGE_URL`), `src/main/hook-bridge.ts`
- `tests/hook-reconcile.test.ts` — "self-heal survives Claude Code stripping our \_om2tab sentinel"
- `801ba8a` (fix) supersedes the insufficient self-heal in `5d897f6`
- `testing/001-blind-assertion-false-green` — false-green caught while TDD-ing this fix
