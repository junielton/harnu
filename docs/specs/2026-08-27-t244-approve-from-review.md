# Submitting a PR review from the pane — the mechanism

**Date:** 2026-08-27
**Card:** `T244-t164-v1-1-approve-or-request-changes-on-a-pr-from-the-review`
**PRD:** `docs/prds/T244-approve-from-review.md` — read it first; it holds the
product decisions and the non-negotiables. **This document is only the
mechanism**, and deliberately does not restate them.
**Status:** design approved, not implemented
**Depends on:** the T164 review pane, **merged into `main` on 2026-08-28** as `#251`

## The seam

`gh pr review <n> --approve|--request-changes|--comment --body-file -`, spawned
with `execFile` from `src/main/review-ipc.ts`, `cwd` = the repo folder.

Why the CLI and not the API:

- It **inherits the operator's existing auth**. Capy never handles, stores,
  scopes or refreshes a token of its own — which also means Capy can never hold
  a credential with more reach than the person sitting in front of it.
- `runGit`/`runFile` already exist in this file (`review-ipc.ts:46,76`) with the
  timeout / `windowsHide` / `maxBuffer` conventions the rest of the module uses.
- The body goes over **stdin** (`--body-file -`), never as an argv string. A
  review body is arbitrary operator prose; putting it in argv makes quoting a
  correctness problem and leaks it into process listings.

## The guard that has to exist before the button (PRD AC-6)

You may only approve what you read. The submit path therefore verifies, at
submit time and not at render time, that the diff on screen is
`<base>...<head>` where `base` is **the PR's own `baseRefName`** — already
available in the cached `gh pr list` JSON (`GH_FIELDS`, `review-ipc.ts:60`).

If the rendered snapshot was computed against a different base — a configurable
base, or T246's resolved base for a foreign head — **refuse and say why**. Do not
silently recompute and submit: the operator would be approving a diff they never
saw, which is the one failure this feature can produce that is worse than not
existing.

`ReviewSnapshot` carries `base`, `branch` and `fetchedAt`
(`review-ipc.ts:261-275`) — but **no commit SHA**, and neither does
`ReviewEvidence` (`review-core.ts:904-920`). So the base half of this check needs
no new plumbing; **the head half does.**

Add a head SHA captured at fetch time (`git rev-parse HEAD`, which the module
already runs inside `currentBranch` for the detached case) and compare it at
submit. Without it the guard is string equality on branch names, which passes
happily while the branch moves underneath — an amend, a push, or another session
sharing this worktree's index and HEAD. Refuse and say why, same as for the base.

## Keeping it out of the agent surface (PRD AC-4)

The IPC handler is registered like any other, but it must **not** appear in
`src/main/mcp/tool-catalog.ts`. A test asserts its absence and fails if it is
ever added.

Write that test so it fails loudly with a message explaining _why_, not just
that a string was found. The next person to add a verb should hit a sentence
about accept-doors, not a bare assertion diff. A guard nobody understands gets
deleted by whoever it inconveniences.

## Failure handling (PRD AC-8)

`gh pr review` fails for ordinary reasons: not authenticated, no PR for the
branch, approving your own PR (GitHub refuses this), network down, insufficient
permission.

Every one of them surfaces verbatim to the operator. The pane must never render
a submitted state it did not confirm from a zero exit code — an approval the
operator believes happened and did not is strictly worse than a visible error.

## Not in scope here

Inline review threads. `addPullRequestReviewThread` belongs to T245 Tier 2 and
inherits this card's confirm gate rather than growing a second one.
