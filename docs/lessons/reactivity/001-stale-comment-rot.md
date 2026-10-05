# 001-stale-comment-rot: never use absolute line numbers in cross-file comments

**Category:** reactivity (file structure, not Vue reactivity proper —
goes here because it relates to how the codebase stays maintainable as
reactive systems grow)
**Discovered in:** `1677063` (post-review fix on `feat/fork-session`, May 2026)
**Status:** active

## The bug class

A comment in `sessions.ts:1235` referenced "Path B (line ~1185)" to
point at a sibling code branch in the same function. Within the same
PR, the **new code added 70+ lines above** the reference, shifting
Path B from line 1185 to line 1267. The reference was wrong **at commit
time** and would only get worse.

This is a class. Any of these patterns rots quickly:

- `// see line 1185`
- `// the branch above (line 100)`
- `// HACK at line 42`
- `// matches the if at line 234`

## Why it happens

- The author is grepping for the line they want to reference, sees
  "1185", types it in
- Code reviews don't catch line numbers because the reviewer doesn't
  run `wc -l` on every reference
- Any subsequent edit invalidates the number — usually silently

## The fix (and why)

Use **semantic markers** instead:

```ts
// BAD — rots
// Path B (line ~1185) drops the synth row outright via splice.

// GOOD — survives reformatting and additions
// The sibling synth-swap path (further down in the same function,
// where `realIdx !== -1`) drops the synth row outright via
// `splice(synthIdx, 1)`, so no leak there.
```

The good version:

1. **Anchors on a unique code pattern** (`realIdx !== -1`) that grep
   finds
2. **Mentions the actual operation** (`splice(synthIdx, 1)`) so the
   reader knows what they're looking for
3. **Doesn't promise a precise location** — "further down in the same
   function" is true regardless of how many lines were added

## How to detect in reviews

```bash
git grep -nE "line\s*~?[0-9]{2,}|line\s+[0-9]+|lines?\s+[0-9]+-[0-9]+" src/
```

Any match in a comment is suspect. The pattern is okay when referring
to **external** files (e.g. `pty.ts:53` from inside `sessions.ts`)
because external refs rot less often — but even then, prefer
function-anchored references (`pty.ts#registerPtyHandlers`).

## A related anti-pattern

Embedded TODOs with a number:

```ts
// TODO(T-3.x): wire this up later
```

The `T-3.x` was a planning artifact that no longer maps to anything
trackable. Either the TODO is real (file an issue, reference the issue
number) or it's just a confession of incompleteness (remove the TODO,
ship the stub honestly).

## How to detect

```bash
git grep -nE "TODO\([A-Z]-[0-9]" src/
```

Triage results: keep if there's a real follow-up tracked elsewhere,
remove otherwise.

## Related

- `1677063` commit message — caught by the comment-analyzer subagent
  during the post-review pass on `feat/fork-session`
- `pr-review-toolkit:comment-analyzer` — runs this exact grep class
- This file is itself a lesson the comment-analyzer flagged on the PR
