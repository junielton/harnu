# 001-age-filter-anti-pattern: never gate synth survival on age

**Category:** synthetic-sessions
**Discovered in:** `9fc1a4a` (B-6 v2), `85824e4` (B-7 v2) — May 2026
**Status:** active

## The bug class

A synthetic session represents a running PTY the user can see and type
into. It is **transient state**: it exists from the moment
`createNewSession()` or `createForkedSession()` runs until the watcher
reconciles it with the real JSONL Claude writes on first event.

Two bugs in May 2026 (B-6 and B-7) both shipped with the same anti-pattern:

```ts
// In reloadModel's snapshot loop:
if (s.synthetic !== true) continue
if (Date.now() - new Date(s.created).getTime() > SYNTHETIC_RECONCILE_MS) continue
// ^^^ DROPS THE SYNTH FROM THE SNAPSHOT IF >60s OLD

// In reconcileSessionAdded:
const ageMs = Date.now() - new Date(bestSynthetic.created).getTime()
if (ageMs > SYNTHETIC_RECONCILE_MS) {
  await reloadModel()
  return
}
// ^^^ BAILS WITHOUT MIGRATING IF SYNTH IS OLD
```

**Symptom:** user opens a "+ New session", waits 90 seconds (no rush),
types `/rename my-session`, the rename **vanishes from the sidebar**.
Worse, the synth itself can disappear on the next `reloadModel()` call.

The reasoning behind the age filter was reasonable on paper: _"if a synth
is old, something probably went wrong; fall back to a full reload."_
But the assumption is wrong — Claude Code 2.1.152+ doesn't write
`sessions-index.json` on session creation, so reconciliation often
arrives **minutes** after the synth was created. A 60-second filter
guaranteed the bug for every realistic user workflow.

## Root cause

A synth's lifetime is **gated by reconciliation**, not by wall-clock age.
The watcher event `claude:session:added` is the only legitimate signal
to swap synth → real. Until that signal fires, the synth represents the
user's live work and must survive.

## The fix (and why)

Remove every age-based gate. Keep only:

- **One synth per worktree** (dedupe at creation time in `createNewSession`)
- **Match by worktree path** at reconciliation (the watcher event payload
  has `slug` + `sessionId`; we look up the worktree, find the one
  unmatched synth, migrate it)
- **Fork synths bypass dedupe** because they're meant to stack

That's all the disambiguation we need.

## How to detect in reviews

Search for any age comparison involving `synthetic`:

```bash
git grep -nE "synthetic.*age|age.*synthetic|synthetic.*Date\.now|Date\.now.*synthetic" \
  src/renderer/src/
```

If you find any code that drops, skips, or bails based on
`Date.now() - synth.created`, it's the bug.

Also check:

- **`reloadModel`'s snapshot loop** — does it iterate **every** synthetic
  unconditionally? It must.
- **`reconcileSessionAdded`** — does it have any `if (age > X)` branch?
  It must not.

## Related

- `memories/task/003/run-2026-05-27.md` — B-6 and B-7 timelines (the
  smoking-gun debug logs)
- `src/renderer/src/stores/sessions.ts#reloadModel` — current correct
  snapshot loop
- `src/renderer/src/stores/sessions.ts#reconcileSessionAdded` — current
  correct reconciliation path
- `superpowers:systematic-debugging` skill — both fixes were caught by
  adding diagnostic logs in every handler that mutates `folders.value`
  and then running the user's actual workflow
