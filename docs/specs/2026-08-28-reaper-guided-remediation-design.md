# Reaper — guided remediation

**Date:** 2026-08-28 · rewritten the same day after two independent reviews
**Status:** design. Phase 1 (T251) scheduled; **phase 2 (T252) recommended for icebox**.
**Extends:** `docs/specs/2026-07-15-reaper-cleanup-design.md`
**Depends on:** BUG-95, T254, BUG-74, BUG-75, BUG-93 — the classifier must stop lying and
the sweep must be recoverable before a dossier is worth reading.

## Problem

The Cleanup view says a worktree is `blocked` and, at best, names a one-word blocker.
That word is not enough to act on. Measured on `proj/www`, 2026-08-28 (a live corpus —
counts moved between runs minutes apart):

- After the three detection fixes, **6 become harvestable and ~22 stay blocked**:
  9 `pr-closed-unmerged`+`unpushed`, 7 `dirty`, 3 `unpushed`, 1 `dirty`+`unpushed`,
  1 `pr-open`, 1 `unknown`. Hygiene-only scope covers 21 of the 22.
- Determining what `dirty` _meant_ for those rows took a manual, per-worktree
  investigation.

### The finding that justifies this feature — and the retraction that sharpened it

An earlier draft of this spec asserted that all the dirty worktrees held work
`origin/main` had already absorbed, and that they were therefore safe to discard.
**That was wrong, and it was the second wrong answer to the same question.** The
independent audit found:

|                      | count |
| -------------------- | ----- |
| genuinely superseded | 2     |
| holding unique work  | 3     |
| partially unique     | 3     |

One of the unique ones carries 15 tracked-dirty files, +451/−404, zero commits behind
the default branch, no PR, never pushed — the only live in-flight work in the corpus,
and it was invisible to the original analysis because the census filtered on
`blockers.join('+') === 'dirty'` exactly, dropping anything that also carried `unpushed`.

Both spot-checks that produced the wrong conclusion reasoned from _correct line numbers_:
`terraform/cloudfront.tf` really does contain `allowed_methods = ["GET","HEAD"]`, but in
`ordered_cache_behavior` blocks that have nothing to do with S3 bucket CORS; and
`preloadRelatedData` really is in the default branch, with a different body, while the
feature flag it depends on is not there at all.

**This makes the feature's case stronger, not weaker.** Telling "already in main" from
"looks like it is in main" is exactly the judgement a human got wrong twice by eye, from
correct evidence. That is what a deterministic dossier is for. The business case is
_discrimination_, not summarisation — and it belongs to phase 1.

## Non-goals

- Finishing unfinished work. `ci-failing`, `pr-open` and `changes-requested` mean the
  work is not done, not that it is unclean.
- Deciding, for the operator, that content is disposable. The dossier reports measured
  facts; it never renders a verdict of "safe to delete". The two retractions above are
  why.
- Replacing the sweep.

## Phase 1 — the dossier (T251)

### Architecture

Core/shell per ADR-0001, mirroring `scanner-shell.ts`.

**`dossier-shell.ts`** — env-bound probes for one item: tracked vs untracked status;
`diff --stat` and `--name-only` for the tracked set; ahead/behind against the resolved
default branch (not a hardcoded `origin/main`); PR state by local **and** upstream name
with the SHA corroboration BUG-93 mandates; the per-file supersession probe; disk split
into dependency directories and the rest. Every probe degrades to `null`, never throws.

**`dossier-core.ts`** — pure: facts → markdown. One text feeds the pane, the phase-2
pre-prompt and the row summary, so the three cannot disagree. Every claim carries its
source. Unknown renders as unknown; a failed probe never renders as a negative fact. No
imperative sentences: "this file's added lines are already in the default branch" is
admissible, "safe to delete" is not.

**Where the file goes.** `app.getPath('userData')/reaper/dossiers/<repoId>-<slug>.md`,
beside `reaper-log.jsonl` and `reaper-gh-cache.json`. **Not** into the worktree: `.capy/`
is gitignored only where a repo's own `.gitignore` says so, and Capy never writes such a
rule into a foreign repo — so writing there would create an untracked file inside the
candidate worktree, which the next scan reports as untracked content on the row it was
meant to explain, and which pre-BUG-75 flips that row to `dirty`. A diagnostic must not
perturb the signal it measures. `MarkdownPane` takes an absolute path either way.

**No new component.** The dossier renders in the existing `MarkdownPane`. An earlier
draft required a design-entity map row for "the new component" while its own architecture
reused the pane; there is no new component and no map row. The `design.md` obligation is
the row affordance only.

### Acceptance — reformulated to be falsifiable

- For each hygiene blocker type, one assertion naming the specific probe output that must
  appear in the rendered dossier. ("Names every blocker with its measured evidence" was
  not checkable.)
- Tracked and untracked changes render as separate sections.
- The supersession probe renders as a per-file fact; a failed probe renders `unknown`.
- Given facts where every probe is `unknown`, the dossier still renders.
- The frozen corpus fixtures reproduce their recorded scenario counts. (An earlier
  criterion — "the corpus promoted into fixtures" — was a task, not a behaviour. Anonymize
  first; see T253.)
- `CHANGELOG.md`, `docs/user/cleanup.md`, `cleanup.remediate.*` in both locales.

**Not agent-facing.** No new verb, no ACK field, no change to grant or confirm semantics.
No `docs/capy-features.md` bump. (An earlier draft had T251 and T252 answering this
question differently for two halves of one feature.)

## Phase 2 — the session (T252) — recommended for icebox

The design below is coherent; the recommendation is not to build it yet.

The dominant residual case is stale checkouts whose edits the default branch has absorbed,
plus a handful holding unique work. Once T254 preserves the tip and the working state, the
remedy for each is one deterministic action — archive, discard, re-evaluate — which is a
button on the row, not a Claude session per worktree with an agent cost per click and a
permission story that cannot be made airtight. Keep this document, set the card to icebox,
and write the revisit trigger into it: after T251 has been used on a real cleanup pass,
with a stated number of rows still unresolved.

### If it is built anyway, two things must change from the earlier draft

**The permission claim was false.** Decision 1 previously read that the session "executes,
with every destructive action passing through Capy's existing confirm". Capy's confirm is
the **MCP verb** gate; it never sees a shell command a session runs in its own terminal.
And no permission profile can bound this session: `READ_ONLY_DENIED_TOOLS` is
`['Edit','Write','NotebookEdit']`, and that file's own comment says `Bash` is deliberately
absent and the list "is honest about being a guard against the ACCIDENTAL edit, not a
sandbox". A hygiene session's whole job is git-via-shell; denying the shell forbids the
work, allowing it gates nothing.

So: **the archive is the gate.** `reaper:remediate` writes T254's tip and working-state
refs _before_ creating the session, and refuses to dispatch if that write fails.
Recoverability then does not depend on the session's behaviour or on how the operator has
configured permissions. Apply a forced config as defence in depth only — drop
`dangerouslySkipPermissions`, refuse a bypass mode, deny `Edit`/`Write` — at the same
post-merge point as the existing `forceReadOnlyPermission` (`claude-args.ts:282`, applied
in `pty.ts`), since the config merge otherwise propagates a folder-level skip-permissions
setting straight in. The honest wording: the session runs under the operator's own Claude
Code permissions, Capy's confirm does not see its shell commands, and the guarantee is the
pre-dispatch archive.

**The row disappears on dispatch.** `stores/reaper.ts:75` filters `verdict === 'active'`
out of the only list `CleanupView` renders, and `computeLiveFolders` marks a folder active
as soon as a session there is working — which dispatching one does. So "while a bound
session is alive the row shows that state and Remediate is disabled" describes an
impossible state. `stores/reaper.ts` must keep rendering a row bound to a remediation
session, with a `design.md` state for it. Neither is in the card's scope today.

**The rescan can silently be stale.** `scanAll` returns any in-flight promise without
comparing options (`scanner-shell.ts:389-394`), so a forced scoped rescan fired on
`pty:exit` can return the hourly tick's unforced, unscoped scan — and the acceptance
criterion "exactly one scoped rescan" would pass while the operator sees pre-remediation
data and concludes the session failed. Queue a follow-up when the in-flight scan does not
cover the request. This is a pre-existing latent bug that also affects the post-sweep
rescan; it only becomes load-bearing here.

The verdict is always the scan's. Restate the criterion structurally: no IPC handler
accepts a verdict or completion claim from a session, and the only writer of an item's
verdict is the classifier.

## Rejected alternatives

**A bundled skill for the procedure.** Bundled skills are off by default
(`bundled-skills-core.ts:47-50`) and a disabled skill is absent, not hidden — the feature
would degrade silently for anyone who never enabled it.

**A monolithic pre-prompt.** `AGENT_PREPROMPT_ARGV_MAX_CHARS = 8000`; above that the
launch falls back to the paste path. A dossier containing a diff exceeds it routinely,
which is why the file indirection exists.
