# 005-exit-cleanup-must-be-instance-exact: a second instance's exit must never strip shared state it didn't install

**Category:** framework (multi-instance / `~/.claude/settings.json`)
**Discovered in:** statusLine telemetry outage, Jul 2026 (statusline died Jul 7 ~21:03, found Jul 8)
**Status:** active

## The bug

The production Harnu ran for ~13h with NO session telemetry: every usage number
froze (the cockpit shadowed fresh `/usage` polls) and new sessions showed only
their fallback name in the footer HUD. `~/.claude/settings.json` had no
`statusLine` key at all — while Harnu was running and convinced it had installed
one.

## Root cause

`removeOwnStatusLineSync` (exit/SIGTERM handler) identified "our" statusLine by
a **basename regex** (`statusline-writer\.(sh|cmd)`). Every Harnu instance —
production AppImage, `npm run dev`, a `--user-data-dir=/tmp/capy-verify`
instance — matches that regex, because they differ only in the userData
_directory_ of the writer path. So any secondary instance quitting stripped the
key installed by the still-running production instance. And production only
installed at boot — **install-once + no self-heal** meant the damage persisted
until the next app restart, invisibly.

Two stacked defect classes:

1. **Loose identity in a destructive cleanup.** "Looks like ours" is the right
   predicate for _install/refresh_ (adopting a stale sibling is harmless), but
   for _removal_ it must be "is EXACTLY this instance's" — the failure mode of
   over-matching a delete is destroying a peer's live state.
2. **Install-once over co-owned mutable state.** Anything living in a file that
   other processes (peer instances, Claude Code itself, the user) also rewrite
   WILL eventually be removed out from under you. Owning state there requires a
   reconcile loop, not a boot-time write.

## The fix (and why)

- `stripStatusLine(settings, exactCommand?)` gained a strict mode: the exit
  cleanup passes `ourCommand()` (the full userData-specific writer invocation)
  and only deletes an exact `command` match. The user-intent toggle-off keeps
  the loose match (the user wants Harnu telemetry gone, whichever instance's).
- A 60s self-heal tick re-installs when the key has **vanished** (never fights a
  foreign statusLine, never reclaims a present sibling writer — two live
  instances must not ping-pong writes).
- The renderer stopped trusting the cockpit unconditionally: `mergeRateWindows`
  picks the freshest source per window, so even a dead statusLine degrades
  gracefully to the 90s `/usage` poll, and an "updated X ago" line makes any
  future staleness _visible_ instead of silent.

The hooks subsystem already embodied the full pattern (token-per-instance
identity, `removeOwnHooksSync(currentToken)`, `reconcileHooks` with dead-port
liveness probing) — statusLine just hadn't adopted it.

## How to detect in reviews

1. Any exit/quit/cleanup handler that deletes from a shared file using a
   pattern/regex/prefix match instead of an instance-exact value:
   ```bash
   git grep -n "removeOwn\|stripStatusLine\|reconcileHooks" src/main
   ```
   Ask: "if two instances run, can THIS instance's exit delete the OTHER's
   entry?"
2. Any `install*` called only from a `register*` boot path with no periodic or
   event-driven re-assert — co-owned state without a self-heal is a latent
   outage.
3. Silent-degradation smell: a preferred data source with no freshness bound and
   no visible age. If source A shadows source B "forever", A going quiet is
   indistinguishable from "nothing changed".

## Related

- `src/main/statusline-install.ts` (`stripStatusLine` strict mode),
  `src/main/statusline.ts` (`selfHealTick`, strict `removeOwnStatusLineSync`)
- `src/renderer/src/components/usage-format.ts` (`mergeRateWindows`)
- `tests/statusline-install.test.ts` — "strict mode (exactCommand — the
  exit-cleanup identity)"
- `framework/002-claude-code-strips-settings-hook-keys` — the sibling lesson:
  identity must live in fields the co-owner preserves; this one adds: and
  deletion must be instance-exact, with a reconcile loop
- Open follow-up: reclaim a _present-but-dead_ sibling statusLine (instance
  SIGKILLed without cleanup) via a liveness probe, like the hooks' dead-port
  reconcile.
