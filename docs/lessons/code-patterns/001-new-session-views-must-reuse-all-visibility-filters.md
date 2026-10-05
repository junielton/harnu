# 001-new-session-views-must-reuse-all-visibility-filters: a new projection over sessions must apply EVERY existing visibility filter

**Category:** code-patterns (session model / projections)
**Discovered in:** Fleet status board adversarial review, `dda51f7` (Jun 2026)
**Status:** active

## The bug

The new Fleet status board (`boardBuckets`) projected `folders → sessions` into
by-state buckets, filtering out **sidechains** but not **archived** sessions. The
rest of the sidebar treats archived sessions as invisible — the folder tree hides
them behind a reveal, and `attentionCount` excludes them. So a session the user
explicitly archived ("put away") reappeared in the board, even incrementing a
bucket count. Caught by an adversarial review pass, not by tests.

## Root cause

A new view over a shared collection re-derived its own filtering and silently
diverged from the established invariants. The sessions model has **two**
independent "don't show this" axes — `isSidechain` (subagent, never a top-level
row) and `archivedIds` (user hid it) — plus an age window. The new projection
copied one and forgot the other, so "hidden" leaked back through the new surface.

## The fix (and why)

Apply the same exclusions every other session view applies:

```ts
// src/renderer/src/stores/sessions.ts — boardBuckets
for (const s of f.sessions) {
  if (s.isSidechain) continue
  if (archivedIds.value.has(s.sessionId)) continue // ← was missing; archived must stay hidden
  // ...
}
```

## How to detect in reviews

1. Any **new computed/view that iterates `folders`/`allSessions`** — check it
   against the canonical filters the existing views use: `isSidechain`,
   `archivedIds`, and (if relevant) the age window. Grep the established view
   (`visibleFolders`/`sessionsForDisplay`) for the full filter set and diff.
2. Fault line: re-implementing visibility rules per-view instead of routing
   through one shared predicate. Prefer a single `isVisibleSession(s)` helper so a
   new surface can't forget an axis.
3. Tests written from the happy path won't catch a _leak_ — add an explicit
   negative test ("an archived session does NOT appear") for each new view.

## Related

- `src/renderer/src/stores/sessions.ts` (`boardBuckets`, `archivedIds`, `visibleFolders`)
- `tests/fleet-board-store.test.ts` ("excludes archived sessions from every bucket")
- `synthetic-sessions/001-age-filter-anti-pattern` — the age-window axis
