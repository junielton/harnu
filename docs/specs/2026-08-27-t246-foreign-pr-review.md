# Review another developer's PR without checking it out

**Date:** 2026-08-27 · **revised the same day after adversarial review**
**Card:** `T246-t164-v1-1-review-another-developer-s-pr-fetch-the-head-and-diff`
**Status:** design **ready to dispatch**. Six holes were found in adversarial
review on 2026-08-27; the three that were open decisions were settled by the
operator on 2026-08-28 and are written up below.
**Depends on:** the T164 review pane, **merged into `main` on 2026-08-28** as `#251` — the code this card extends is on `main`.

## Problem

The operator named reviewing other developers' PRs as a first-class case
(2026-08-27). It does not work today, and not because of a bug: the pane's diff
is **100% local git** —

```
review-ipc.ts:337   git diff --find-renames --no-color <base>...<branch>
```

— never the GitHub API. A branch that is not on disk has nothing to diff.

## What already works, and what that is worth

`stores/review.ts:97` — `load(folder, { base?, head?, session?, silent? })` —
already takes an optional `head`, and `loadReview` passes it into the
`${base}...${branch}` range unvalidated. So the _plumbing_ accepts a foreign
head.

**That is a much smaller win than the first draft of this spec claimed**, because
four things downstream assume the head is the checked-out branch of a local
worktree. Each is a hole to close, not a detail.

### Hole 1 — there is no folder to review from (**SETTLED**)

`review:load`'s only anchor is `folder`, a cwd. The PR Stack button is gated
`v-if="worktree"` (`PrStackCard.vue:365`) and calls `openReview(worktree.path)`;
`worktreeByBranch` (`PrStackCanvas.vue:117`) only holds branches Capy already
checked out. For a PR with no local worktree — the entire point of this card —
**nothing in the codebase exposes an "any folder for this repo" concept.**

**Settled: the repo's main worktree is the cwd.** It always exists — there is no
PR card without a known repo — and, crucially, `git fetch` and
`git diff <a>...<b>` **never touch the working tree, the index, or HEAD**. They
are pure reads plus additive ref writes, so this is safe even when that checkout
has uncommitted work sitting in it, which is the normal state of a main checkout.

**The constraint this buys must be a test, not a convention:** the review path may
run only read-only git plus `fetch`. **Never `checkout`, `reset`, or `stash`.**
Write it as a test, because the next person will reach for `checkout` to
"simplify" the fetch — and a review that silently switches the branch under an
operator is a far worse bug than the one it would be simplifying.

`PrStackCard.vue`'s gate therefore changes from _has worktree_ to _can resolve a
folder for this repo_.

### Hole 2 — fork PRs, which are the common case (**SETTLED**)

The first draft assumed the head exists as `origin/<headRefName>`. **That is only
true when the author pushed to this repo.** A real "someone else's PR" on an open
source project — which Capy is itself preparing to be — is usually from a
**fork**, where the branch does not exist under `origin` at all and
`git fetch origin <branch>` simply fails.

GitHub exposes `refs/pull/<number>/head` for exactly this, and `number` is
already in `GH_FIELDS`.

**Settled: use `refs/pull/<number>/head` for every PR, fork or not.** It exists
for all of them, so there is no branch in the logic to get wrong and no class of
PR that silently takes a different path. Special-casing forks would mean the rare
case is the tested one and the common case is the accident.

### Hole 3 — the head's format breaks PR matching

`assembleEvidence` matches PRs with `prs.find(p => p.branch === input.branch)`
against the **bare** `headRefName` (`pr-stack-core.ts:189`), and `loadReview`
reuses the same `branch` string for both the diff range and that match. Pass
`origin/<branch>` or a `refs/pull/...` ref as the head and the match silently
fails — **no PR found**, which breaks this card's own base resolution _and_ the
PR/CI chips that work today.

The head therefore needs two representations: the **ref to diff** and the
**branch name to match on**. They are not the same string, and today's code has
only one slot.

### Hole 4 — base resolution runs before the PR data arrives

In `loadReview`, `resolveBase` runs at ~line 325; `prListJson` is fetched at
~line 340. Deriving the base from `baseRefName` requires either resequencing
`loadReview` or having the caller supply it (PR Stack already holds it).

And `baseRefName` is a bare name like `main`, which `resolveBase` verifies
against the **local** branch — which for a foreign repo may be absent or stale.
Fixing _wrong base_ does not fix _missing or stale base_, and those produce the
same confident-looking wrong diff.

### Hole 5 — staleness was diagnosed, not designed (**SETTLED**)

The first draft demanded the pane state the ref's age without saying how it is
obtained, and offered two candidates that mean very different things: "Capy last
looked N minutes ago" versus "this code was written N days ago".

**Settled 2026-08-28: neither. An age is the wrong answer to the question.**

"The head commit is 3 days old" describes the _code_, not the operator's _copy_ —
a three-day-old PR head can be perfectly current, and an age would make someone
worry for nothing. What the operator actually needs is a boolean: **is what I am
reading the current head?**

That is answerable. `gh pr list --json headRefOid` returns the PR's head SHA —
**verified working on 2026-08-28**; it is simply not in `GH_FIELDS` yet, and adding
it costs nothing because it rides the same already-cached call. Compare it against
the local ref and the pane says **"current"** or **"the PR has moved since you
fetched"**.

"Fetched N ago" survives only as the fallback when there is no PR to compare
against — and there, saying the age plainly is exactly right, because a boolean is
not available and pretending otherwise would be the "all clear" mistake again.

### Hole 6 — first open on an unfetched ref is indistinguishable from "no commits"

This is the one that would have shipped a real defect. With "fetch only on
refresh", the first open of a never-fetched head runs `git diff` and `rev-list`
against a ref that does not exist. `runGit` swallows every failure to `null`,
which renders **identically to `commitsAhead: 0`** — the existing "no commits on
this branch" empty state.

An operator would read "no commits", conclude nothing happened, and Close. That
is precisely the R2 failure this epic exists to prevent, arrived at from a new
direction. **A distinct "not fetched yet" state is mandatory**, and it is the
reason AC-1 and AC-4 must be stated as one flow rather than two independent
rules.

## Decisions that hold

- **Fetching is not implicit on open.** The pane is offline-first by design
  (AC-6 of T235: git-only evidence is a first-class state, not an error). The
  refresh control — which already forces past the `gh` cache — is what goes to
  the network.
- **No worktree per reviewed PR.** `create_worktree`'s `ref` parameter exists and
  names "review a PR" as its use case (`tool-catalog.ts:402`), but a checkout
  plus dependencies plus disk is far heavier than a fetch and a read-only diff.
  Reading someone's PR must not cost a working tree.
- **`design.md` first.** The staleness statement and the "not fetched yet" state
  are new visual states, and this repo's contract is that `design.md` §6 is
  edited in the same change, never after. The first draft of this spec ignored
  that; it is not optional.

## Acceptance criteria

- **AC-1** — Opening the pane on a head with no local worktree renders either
  its diff (if the ref is present) or an explicit **"not fetched yet"** state —
  never an empty diff, and never anything that reads as "no commits". — verify: visual
- **AC-2** — Refresh fetches the head, including for a **fork** PR via
  `refs/pull/<number>/head`, and the diff then renders. — verify: manual
- **AC-3** — Opening performs **no** network call; fetching happens only on the
  explicit refresh gesture. AC-1 and AC-3 describe one flow, not two rules.
  — verify: test (**needs a seam**: `review-ipc.ts` calls `execFile` directly with
  no injection point, so this is not unit-testable today without adding one)
- **AC-4** — The base comes from the PR's own `baseRefName` when a PR is known,
  and the diff is refused with a stated reason when that base cannot be resolved
  locally. A wrong base rendered confidently is worse than no diff. — verify: test
- **AC-5** — PR matching still works for a foreign head: the PR/CI chips render
  for someone else's PR, and continue to render for your own branch. — verify: test
- **AC-6** — With a PR known, the pane states whether the reviewed ref **is the
  current head**, by comparing the local ref against `headRefOid`. With no PR it
  falls back to stating when the ref was last fetched. It says plainly when it
  knows neither. **"Current" is a statement about one ref, never a summary badge
  about the review** (R2). — verify: visual
- **AC-7** — With no `gh`, no remote, or no network, the pane degrades to today's
  local-only behaviour with no error surfaced. A fetch that **fails** is a
  first-class state, distinct from having nothing to fetch. — verify: test
- **AC-8** — The PR Stack affordance becomes live for cards that can resolve a
  folder for the repo, and **remains absent** for anything that still cannot
  resolve a head. A live-looking button that opens an empty or wrong diff is the
  failure mode this card exists to avoid. — verify: manual
- **AC-9** — `design.md` §6 gains the new states in this same change. — verify: review
- **AC-10** — Every new string through `$t()`, in **both** locale files. — verify: test
- **AC-11** — `CHANGELOG.md` + `docs/user/review-pane.md` updated. — verify: review
- **AC-12** — `typecheck`, `lint`, `test:coverage`, `build`, `prettier --check .`
  all pass. — verify: test

## Plan

| unit   | scope                                                                                                                                                                                                      |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **U1** | `review-ipc.ts`: the two-representation head (ref to diff vs name to match), `refs/pull/<n>/head` for forks, base from `baseRefName` with the ordering fixed, per-ref freshness, the fetch seam AC-3 needs |
| **U2** | `PrStackCard.vue` / `PrStackCanvas.vue`: the gate moves from _has worktree_ to _can resolve a folder_                                                                                                      |
| **U3** | Renderer: "not fetched yet", fetch-failed, and staleness states + `design.md` §6 + i18n                                                                                                                    |
| **U4** | Docs + changelog                                                                                                                                                                                           |

All six holes are closed. The three that were operator decisions — the cwd, the
fork-ref strategy, and what "stale" means — are settled above; the other three
were design gaps and are designed.
