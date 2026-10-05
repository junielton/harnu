# Reaper — detection honesty (BUG-74, BUG-75, BUG-93)

**Date:** 2026-08-28 · rewritten the same day after two independent reviews
**Status:** spec — shared by three backlog cards
**Extends:** `docs/specs/2026-07-15-reaper-cleanup-design.md`
**Cards:** BUG-74 (`simple`), BUG-75 (`standard`), BUG-93 (`standard`)
**Sequenced after:** BUG-95 (detached worktrees) and T254 (preserve before sweeping)

One spec for three cards because they share one body of measured evidence and one
failure story; splitting it would triplicate the evidence and let the three drift.

## How to read the numbers in this document

Every figure was measured on `/home/u/Workspace/org/proj/www` on 2026-08-28,
and **the corpus is live** — two `git worktree list` runs minutes apart returned 47 and
then 48 entries. So no count here is a constant. Quote them as "measured on date X",
never as a property of the system, and freeze a snapshot for fixtures rather than
counting at test time.

Disk figures are **`du -sk` (allocated blocks), reported in GiB**, one mode throughout.
This matters: on this tree `du -sb` (apparent size) and `du -sk` diverge by 30–40%
because dependency directories are hundreds of thousands of tiny files that each round
up to a block. An earlier draft of this spec mixed a `-sb` numerator with a `-sh`
denominator and produced four wrong figures.

## Measured evidence

169 PRs (3 open, 153 merged, 13 closed) · 141 local branches excluding `main` ·
48 worktree entries, of which 15 are detached-HEAD and invisible to the classifier
(BUG-95) and 32 are branch-attached and non-main.

Scenarios run through the **production** `classify()` (imported from `reaper-core.ts`,
not reimplemented), over facts probed from the real repo, and independently reproduced
by a second agent gathering its own facts:

| scenario                                            | harvestable |
| --------------------------------------------------- | ----------- |
| A — today                                           | **0**       |
| B — + BUG-74 (full PR set) + BUG-93 (squash signal) | **2**       |
| C — + BUG-75 (untracked not counted as dirty)       | **6**       |

**C is 6, not 7.** An earlier draft said 7. Seven is only reachable with the _naive_
upstream-name fallback that this same document forbids; under the required guard
(below) the seventh drops out, correctly. See "Renamed upstreams" for why that also
demolishes fix #3's own motivating example.

The decisive finding: `reaper-core.ts:155` requires `signal !== null` **and**
`localClean.state !== 'red'`. Rows therefore render as `blocked via gh-merged` with the
entire PR chain green. **Detection was never the last gate; dirtiness is.** BUG-75 alone
is worth more than BUG-74 and BUG-93 combined — 5 additional harvestable rows against 2.

Disk, same date, `du -sk`:

```
.git (141 branches, full history)          78 MiB   (69 MiB of objects)
worktree checkouts                      19.71 GiB
  ├─ Reaper-visible (32)                12.69 GiB
  └─ detached, invisible (15)            7.02 GiB   (36%) — see BUG-95
  of the total, vendor/ + node_modules/ 17.48 GiB   (93%)
reclaimable by these three cards          ~2.7 GiB  (14%)
```

Deleting branches reclaims essentially nothing; the disk is installed dependencies. See
`2026-08-28-reaper-dehydrate-worktrees.md`.

Also measured and **rejected**: `git merge-tree --write-tree` as a containment test. It
matches 2 of 141 branches — exactly the two that `merge-base --is-ancestor` already
catches — while 135 of 141 conflict outright. It adds no signal over ancestry. (An
earlier draft cited "1 of 117", which was not reproducible from any scoping.)

## BUG-74 — the PR window truncates

`fetchPrFacts` (`scanner-shell.ts:196-209`) asks for `gh pr list --state all --limit 100`
against a repo with 169 PRs. `PROJ-240-build-footer` → PR #7 MERGED, invisible; a direct
`--head` query finds it immediately.

`prCheckpoints` (`reaper-core.ts:80-83`) then marks all four PR checkpoints `'na'`
because `ghAvailable` is true — "gh present and silent → there never was a PR". **That
inference is the actual bug.** gh was not silent; it was truncated.

### Fix — paginate. The hybrid was costed wrong.

An earlier draft recommended keeping the bulk `--limit 100` prefetch "which covers
recent branches (the common case)" and filling only the gaps, "~20 extra lookups".
Measured:

- the window spans PRs #70–#169 and matches **11 of 143** local branches — **8%**, not
  the common case;
- gap branches needing an extra `--head` lookup: **132**, of which 124 have no PR at all;
- the "~20" was a worktree-scoped numerator (16) against an all-branches denominator
  (143), and `buildRepoItems` classifies every local branch, not only those with worktrees.

At 132 lookups the hybrid is more expensive than exhausting the list. **Paginate.**

Whatever the strategy, truncation must stop being silent. Add a `prSetComplete: boolean`
to the branch facts: when the bulk query returns exactly `--limit` items the set is
known-incomplete, and an unmatched branch must resolve to `unknown`, never `'na'`. The
classifier has nowhere to read that condition from today.

Cache design is part of this card, not an afterthought. The entry is
`{ fetchedAt, prs }`; a gap-fill needs its own slot **and** must remember "this branch
genuinely has no PR", or every scan re-runs the same negative lookups forever. Version
the entry and default a versionless one to incomplete, so the first scan after upgrade
does not re-assert this bug from cache with no network call to correct it.

**Open question, deliberately not decided here:** should the classifier be scoped to
branches that have worktrees (32) instead of all local branches (143)? That would cut
the gap to ~16 and change what Cleanup is _for_. It is a larger decision than this card
and belongs to its own.

**Acceptance.** Given a bulk PR result containing exactly the limit number of items and
a branch absent from it, the PR checkpoints resolve to `unknown` rather than `na` — a
unit test over the parser and classifier, no live repo required. A negative gap-fill
result is cached and not re-fetched on the next scan. A versionless cache entry is
treated as incomplete.

## BUG-75 — untracked files count as dirty

`isWorktreeDirty` (`worktree-ipc.ts:1511-1518`) uses bare `git status --porcelain`, whose
output includes `??` entries. Any untracked file sets `dirty === true`, which
`reaper-core.ts:133-134` turns into a red `local-clean` and a `dirty` blocker.

Untracked content can be real unsaved work — the motivating case remains an 87-line ADR
that existed nowhere else. This is not "ignore untracked"; it is "stop conflating the
two".

### The fix must reach the executor, or it delivers nothing

`reaper-ipc.ts:55` wires `isDirty: isWorktreeDirty`, and `executor-core.ts:78` refuses
an item outright on any dirty re-probe. **Splitting the probe in the classifier alone
means every row this card newly flips to `harvestable` then fails at sweep time with
"dirty on re-probe"** — all 5 of them. The card that this spec's own evidence calls the
highest-value one would ship as a visual change with zero sweepable outcome.

Add a **new** export `probeWorktreeStatus(path) → { trackedDirty: boolean; untracked: string[] }`.
Leave `isWorktreeDirty` untouched: it is also consumed by the manual **Remove worktree**
path in `worktree-ipc.ts`, and changing it in place would silently loosen an unrelated
destructive gate. Have the executor re-probe `trackedDirty`.

Red `local-clean` on tracked modifications only. Untracked files become a distinct,
softer signal — listed on the row, never by itself forcing `blocked`.

**Disclosure is a requirement, not existing behaviour.** An earlier draft said the
executor "still shows exactly what would be discarded before the trash step". It does
not: `grep -c untracked` returns 0 in `executor-core.ts`, `reaper-ipc.ts`,
`SweepConfirmDialog.vue` and `CleanupView.vue`. Nothing enumerates what would be lost.
`SweepConfirmDialog.vue` must gain an untracked-disclosure block naming the paths that
go to the trash with the folder — and saying plainly that the folder goes to OS trash,
which is their actual recovery net. T254 covers preserving them properly.

**Acceptance.** A merged worktree whose only diff is untracked files is not `blocked` on
that basis, **and a sweep of it succeeds** — the executor path is part of this card's
acceptance, not a downstream assumption. The confirm dialog names every untracked path
before acting. No path where tracked uncommitted modifications stop blocking.
`isWorktreeDirty` retains its current behaviour for `worktree:remove`.

**Scope:** `worktree-ipc.ts`, `reaper-core.ts`, `scan-core.ts`, `scanner-shell.ts`,
`executor-core.ts`, `reaper-ipc.ts`, `SweepConfirmDialog.vue`, i18n (both locales),
`CHANGELOG.md`, `docs/user/cleanup.md`, tests.

## BUG-93 — squash merges and shared upstreams

### Squash detection — the one measured win

`merge-base --is-ancestor` is true for **2 of 141** branches: this repo squash-merges
exclusively, so the only git-side containment probe is false by construction.
`mergedSignal` (`reaper-core.ts:69-77`) admits this in its own comment but offers gh as
the sole compensation — so a truncated, absent, unauthenticated or non-GitHub gh leaves
no fallback at all.

Add a `MergeSignal: 'squash-equivalent'`, ranked below `gh-merged` and above
`remote-gone-after-close`:

```sh
# squash: N commits collapsed into one
mb=$(git merge-base "origin/$DEFAULT" "$b")
dangling=$(git commit-tree "$(git rev-parse "$b^{tree}")" -p "$mb" -m _)
git cherry "origin/$DEFAULT" "$dangling"      # leading "-" => already applied upstream

# rebase / cherry-pick: every commit has an upstream equivalent
git cherry "origin/$DEFAULT" "$b"             # all lines "-" => contained
```

Use the resolved default branch — `resolveDefaultBranch` exists precisely because it may
be `master` or `develop`. Do not transcribe `origin/main`.

Recovers **19** branches ancestry misses, verified twice independently.
`PROJ-240-build-footer` (squash-merged) → `-`; `PROJ-0000-drop-logo-strip-size-fields`
(open PR) → `+`. The second arm found nothing on this corpus — it is not wrong, it just
earns no measured keep here.

Three rules that must be written into the implementation:

1. **Patch-id is positive-only evidence.** A `-` proves containment; a `+` proves
   nothing, because a merge that resolved conflicts alters the diff. Never derive a red
   from a `+`.
2. **Empty output is not evidence of containment.** A branch whose net diff against the
   merge-base is empty — a commit plus its revert — emits no lines at all, and the
   natural reading of `git cherry` ("nothing listed, therefore contained") would make
   that a false positive. Treat empty as `false`.
3. **The probe must not write to the object database.** `git commit-tree` creates a real
   dangling object, and the scanner is documented as inventory-only; an hourly tick
   would silently mutate every repo Capy knows. Either use `git patch-id` over
   `git diff <merge-base>..<branch>`, which yields the same evidence and writes nothing,
   or run with `GIT_OBJECT_DIRECTORY` pointed at a scratch dir. Run it only for actual
   cleanup candidates, and memoize on `(branchTip, defaultBranchTip)` — both are already
   in hand from `for-each-ref`.

### Renamed / shared upstreams — the guard, and the retraction

`prFor()` and `remoteExistsFor()` (`scan-core.ts:202-212`) key on the local branch name.
`parseForEachRef` already captures `%(upstream:short)` into `LocalBranchRef.upstream`,
and `buildRepoItems` never reads it.

**The naive fallback causes data loss.** Verified to the SHA, and it fires in the real
classifier:

```
PR #59  head = PROJ-255-fix-cms-page-500s   (MERGED, headRefOid c107c902)

PROJ-255-fix-cms-page-500s                 -> upstream origin/PROJ-255-fix-cms-page-500s   tip b24b3f16
PROJ-0000-s3-cors-for-admin-file-previews  -> upstream origin/PROJ-255-fix-cms-page-500s   tip 81723195
```

Two distinct local branches share one upstream — the ordinary result of branching off an
already-pushed branch and never re-pushing. Running the naive fallback through the
production `classify()` gives `PROJ-0000-s3-cors-for-admin-file-previews` a
`justifiedBy: 'gh-merged'` it has no claim to; it carries 5 commits not in the default
branch (same five subjects as #59's under different SHAs — rebased copies — so "an
entirely different commit set" is true only at SHA level). Today **only the dirty gate
stops it from being swept**.

**Required guard.** A PR resolved _via the upstream name_ is admissible only when the
local tip is independently corroborated: `headRefOid === local tip`, or the patch-id
probe proves containment. A PR resolved by the branch's own name is unaffected.

**Retraction — fix #3 is speculative headroom, not a measured win.** An earlier draft
justified the fallback with `PROJ-360-build-story-hero-block`, "pushed as
`origin/PROJ-373-build-stories`". That branch fails both arms of the guard above: its tip
`f6e35d90` is not PR #60's `headRefOid` `b1791f29`, the patch-id probe returns false,
and it carries 8 commits not in the default branch. The guard rejects it, correctly. The
branch that legitimately owns PR #60 is `PROJ-373-build-stories`, which resolves by its
own name and never needed the fallback.

So the motivating example is itself an instance of the hazard the guard exists to block —
the same shape as the PR #59 case, presented once as the danger and once as the win.
**On this corpus the guarded fallback recovers nothing.** Keep it as headroom for the
case where a tip does match a merged `headRefOid`, but rank it below the squash probe and
do not sell it as free value.

### Cut from this card

**Fix #4 (`in-main` red instead of `?`) is cut.** It contradicted itself — "red only when
every containment probe is negative" against "never derive a red from a `+`", and a `+`
_is_ a negative probe — and it buys nothing: `reaper-core.ts:114-117` already reds when a
PR exists and is unmerged, no blocker derives from `in-main`, and the verdict stays
`unknown` either way. The only case it changed is _no PR_, which is the least trustworthy
one. (The "wall of `?`" framing was also overstated: the actual scenario-A distribution
is 16 unknown, 8 red, 5 green.)

**The `abandoned` verdict is cut; keep only the label.** `sweep` only ever receives
`harvestable` items — guarded three times, at `CleanupView.vue:191`,
`stores/reaper.ts:141` and `executor-core.ts:53` — so closed-unmerged is already excluded
by construction. The only genuinely new capability was _permitting_ deletion of a
worktree carrying 1–11 unmerged commits, and T250 reclaims far more disk without deleting
a commit. What survives is copy: the `pr-closed-unmerged` blocker chip should say
"abandoned" rather than reading as "Capy will not let you".

The predicate proposed for it was also wrong: `remoteExists === false` admits only 7 of
the 9 rows it claimed, excluding two that still have live remote branches — precisely the
ones that stay blocked forever. Recorded here so it is not re-proposed unexamined. The
observed spread is 1–11 commits ahead and 30–65 behind, not "~56".

**Acceptance for what remains.** The squash signal enters the pure classifier as a
**fact on the branch-facts type** — a tri-state beside `ancestorOfDefault` — not as a
call made from inside the core; same for `prSetComplete` and the upstream-corroborated
boolean. Without that the probes leak into the pure module and these criteria stop being
unit-testable, which is the entire reason the split exists. A squash-merged branch with
no gh access at all classifies `harvestable`. Two local branches sharing one upstream,
only one of which is the PR's real head, classify the other as **not** merged. Empty
`git cherry` output classifies as not-contained. The scan writes no git objects.

## Ordering

BUG-95 and T254 come first — the former because it reaches more disk than all three of
these combined, the latter because it makes BUG-75's untracked deletions recoverable.
Then a `design.md` pass defining the row's action slot across every state, before any
card touches the row. Then BUG-75, BUG-74, BUG-93 in that order. Guided remediation
(`2026-08-28-reaper-guided-remediation-design.md`) comes last: a dossier over a lying
classifier reports the lie in a nicer format.

## Test corpus

The harness gathers real facts to JSON and runs the production classifier across the
three scenarios. Promote it to fixtures as a **frozen, anonymized snapshot** — the
corpus is live (the entry count moved between two runs minutes apart), and it currently
carries client ticket identifiers and source paths into a repo being prepared to go
public. See T253. The shape is what makes it valuable — squash-only merges, a shared
upstream, closed-unmerged PRs, untracked-only dirtiness — and the shape survives
anonymization intact.
