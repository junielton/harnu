# Mark a file as viewed, synced with GitHub's own viewed state

**Date:** 2026-08-27 · **revised the same day after adversarial review**
**Card:** `T243-t164-v1-1-mark-a-file-as-viewed-synced-with-github-s-own-viewed`
**Status:** design **ready to dispatch**. Four holes were found in adversarial
review on 2026-08-27; the two that were open decisions were settled by the
operator on 2026-08-28 and are written up below.
**Depends on:** the T164 review pane, **merged into `main` on 2026-08-28** as `#251` — the code this card extends is on `main`.

## Problem

Working down a nine-file diff, nothing records which files have been read. The
operator loses their place on every interruption, and a review that spans Capy
and the browser loses it twice.

## What GitHub gives us

**Verified by live schema introspection on 2026-08-27, and re-verified
independently:**

- `markFileAsViewed` / `unmarkFileAsViewed` — GraphQL mutations. **GraphQL only;
  no REST equivalent** (the REST `/pulls/{n}/files` payload has no viewed-state
  field at all).
- `PullRequestChangedFile.viewerViewedState` — `VIEWED` / `UNVIEWED` /
  `DISMISSED`. The type exposes only `path`, `additions`, `deletions`,
  `changeType`, `viewerViewedState`; **the diff text is not on it**, so this
  never replaces the local `git diff` — it only carries the mark.

### Hole 1 — the node id is not in the pipeline

`markFileAsViewed` takes `pullRequestId`, which is the **GraphQL node ID**, not
the PR `number`. `GH_FIELDS` (`review-ipc.ts:60-73`) does not fetch `id`, and
`PrEntry` (`pr-stack-core.ts`) has no node id either.

The first draft framed the risk as authentication. Auth was never the problem —
`gh` inherits the operator's own. **The gap is that the id this mutation
requires was never fetched.** Add `id` to `GH_FIELDS` (it rides the same cached
`gh pr list` call, so it costs nothing) or resolve it per-PR on demand.

## Design

### `DISMISSED` is a signal, not noise

GitHub clears the viewed mark itself when a file changes after you read it —
_"you read this, and then it moved"_. Rendering that as merely unviewed would be
a small version of the "all clear" mistake **R2** exists to prevent. It renders
as its own state, distinct from never-read.

### Hole 2 — which side wins when they disagree (**SETTLED**)

"Local-first, sync when a PR exists" describes two one-directional syncs as if
they can never conflict. They can:

- local says viewed, GitHub says `DISMISSED` (the file moved after a browser read);
- local untouched, GitHub says `VIEWED` (it was read in the browser).

**Settled 2026-08-28: GitHub wins whenever a PR is known, and `DISMISSED` always
wins over a local `VIEWED`.**

The reframing that makes this obvious: **it is not a conflict, it is a sync
direction.** A local mark is a _write waiting to be pushed_; GitHub's state is the
_truth to read_. Local `VIEWED` + GitHub `UNVIEWED` is not a disagreement at all —
it is an unsynced write, and it pushes up.

The only real conflict is local `VIEWED` + GitHub `DISMISSED`, and there GitHub is
carrying information the local side **cannot have**: that the file moved after it
was read. Local can never be more correct than that.

Which means "local-first" was the wrong frame in the first draft of this spec. The
accurate rule is **local-only where GitHub has no opinion** — that is, on a branch
with no PR.

### Hole 3 — the no-PR path has no invalidation (**SETTLED**)

On a branch with no PR — _"precisely the case where Capy is most useful"_, per
this spec's own argument — a local mark has no mechanism to notice that the file
changed since it was read. That is the exact problem the spec praises
`DISMISSED` for solving on the GitHub path, left unsolved on the path it claims
to care about more.

**Settled 2026-08-28: key the local mark on the file's blob SHA — and it is
already free.**

Not the head SHA: that is far too coarse. Any commit anywhere in the branch would
invalidate **every** mark, so one commit costs the operator the whole review. The
blob SHA invalidates exactly the files that actually changed — which is precisely
`DISMISSED`'s semantics, reproduced locally, which is the point.

And it costs nothing, because the data is already flowing through and being
discarded. The `git diff` the pane already runs emits, for every file:

```
index 72e4c0d..09c0600 100644
```

`parseUnifiedDiff` (`review-core.ts:210`) ignores that line entirely — verified,
there is no reference to it anywhere in the parser. Capturing it is a parser
addition, not new git work and not a second subprocess.

### Hole 4 — marking must patch the snapshot, never reload it

`stores/review.ts`'s `load()` unconditionally calls `reseedExpanded()`, which
exists so a genuinely new diff does not inherit stale overrides — **not** for a
same-diff refresh.

If the GitHub round-trip is implemented by re-calling `load()` after every mark —
the only reload path that exists today — then **every "mark as read" click resets
every other file's expand/collapse state.** That reproduces, self-inflicted, the
exact "loses their place" problem this card exists to fix.

Marking is a **point patch to the existing snapshot**. It is not a reload. This
is not an optimisation; it is a correctness requirement.

### Extending the pinned API surface

`tests/review-pane-contract.test.ts:106` pins the review store's `window.api`
surface to exactly `{ reviewLoad, reviewBlastRadius, onReviewBlastRadiusChanged }`.
This card is the **first legitimate reason to widen it**. Widen and re-pin;
**never delete the pin** — it, not the keyword grep beside it, is the binding
guarantee that this path never reaches for a model or an unexpected network call.

Any **new renderer file** this card adds (a viewed-mark component, a format
helper) must also be added to that test's hard-coded `FILES` list, or it goes
unchecked by the "no agent-produced claim" assertion.

### Where it renders

The file header's left edge belongs to the blast-radius bar — an inner 2px child,
not a border (`design.md` §6). The viewed mark must not compete with it, and must
not weaken it: a sensitive file that has been read is still sensitive.

The viewed mark and the `DISMISSED` state are **new visual states**, so
`design.md` §6 is edited in the same change. The first draft omitted this; the
repo's contract does not make it optional.

## Acceptance criteria

- **AC-1** — A file can be marked read and unread from its header; the mark
  survives closing and reopening the pane. — verify: manual
- **AC-2** — With a PR known, the mark round-trips with GitHub in both
  directions, following the precedence rule chosen for Hole 2. — verify: manual
- **AC-3** — Marking a file **does not** reload the snapshot and **does not**
  change any other file's expand/collapse state. — verify: test
- **AC-4** — `DISMISSED` renders as its own state, distinct from never-viewed.
  — verify: visual
- **AC-5** — With no PR, no remote, or no `gh`, marking works locally, no error
  is surfaced, and the local mark invalidates when the file's **blob SHA** changes
  — per file, never wholesale on any new commit. — verify: test
- **AC-6** — A mutation that **fails** on a PR that does exist (auth, rate limit,
  closed PR) is surfaced, not swallowed, and the mark does not show as synced.
  — verify: test
- **AC-7** — The viewed mark never suppresses, dims past legibility, or
  auto-collapses a **blast-radius** file. Sensitivity outranks having-been-read.
  — verify: test
- **AC-8** — No aggregate "all files viewed" badge, count-with-checkmark, or
  green summary exists at any data combination (R2). — verify: **test**, not
  visual — a plain "7/9" passes a visual check while functioning as exactly the
  forbidden completion badge, and this repo already tests "never" claims
  structurally rather than by eye.
- **AC-9** — `review-pane-contract.test.ts` extended and **re-pinned** (both the
  `apiCalls` set and the `FILES` list), never deleted or loosened. — verify: test
- **AC-10** — `design.md` §6 gains the viewed and `DISMISSED` states in this same
  change. — verify: review
- **AC-11** — Every new string through `$t()`, in **both** locale files. — verify: test
- **AC-12** — `CHANGELOG.md` + `docs/user/review-pane.md` updated. — verify: review
- **AC-13** — `typecheck`, `lint`, `test:coverage`, `build`, `prettier --check .`
  all pass. — verify: test

## Cross-spec note

T246 makes "no network call on open" a hard rule for this same pane. Any GraphQL
read this card performs on open must obey it — ride the existing cached
`gh pr list`, or move the read behind the refresh gesture. **The two specs share
one pane and must not contradict each other.**

## Plan

| unit   | scope                                                                                                                                  |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| **U1** | Main: `id` in `GH_FIELDS`, `gh api graphql` mark/unmark + read-back, local store keyed for invalidation, IPC; re-pin the contract test |
| **U2** | Renderer: the mark as a **point patch**, the `DISMISSED` state, failure surfacing, `design.md` §6, i18n                                |
| **U3** | Docs + changelog                                                                                                                       |
