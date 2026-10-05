# The review companion has to know which review it is sitting in

**Date:** 2026-08-28
**Card:** T245 — a Claude session beside the review (U2, follow-up to the merged U1)
**Status:** design proposed, not implemented
**Depends on:** T245 U1 (`#254`, merged 2026-08-28), T246 (`#253`, merged 2026-08-28)

## The defect, as observed

The operator opened a review of `#246` (`fix/topbar-drag-region`, a branch **38 commits
behind `origin/main`**) from the repo's main checkout, pressed **Ask a fresh session**, and
asked it: _"do you know the context of the PR I'm reviewing?"_ (translated)

It answered: **"No, this session just started, on a clean `main`."** Then it started groping:
`git status`, `git worktree list`, `gh pr list --limit 20`, trying to reverse-engineer which
review it had been opened beside.

It never had a chance. It is spawned with the base argv, the merged boot config forced
read-only, and the Capy preamble — and **nothing about the review**. The only link is the cwd.

## Why this is worse than "no context"

`openCompanion()` passes `folderPath` as both the stack key and the cwd
(`ReviewPane.vue:386` — `helpers.addReviewCompanionHelper(path, path)`), and the doc comment
above it states the intent plainly: _"reading a diff while standing somewhere else is not a
thing anyone wants."_

That intent is right and the cwd is right. But **T246 decoupled the folder's HEAD from the
diff on screen.** Reviewing a PR no longer costs a working tree: the head is read from
`refs/pull/<n>/head` into `refs/capy/pr/<n>` and diffed in place, so for a foreign or
simply-not-checked-out PR the review runs in the repo's **main worktree** while that worktree
sits on whatever branch the operator last had.

So the companion does not merely lack context. Its first instinct — read `git status` —
returns a confident, correct, **irrelevant** answer that contradicts the screen. A session
with no information asks. A session with wrong-looking information guesses, which is the
failure mode this pane exists to fight.

## This was a known open question, left open

The T245 card lists under _Open questions to settle before building_:

> What exactly is in the context the session receives — the selection, the file, the whole
> diff, the card's intent? **Sending everything is easy and makes the answers vaguer.**

The only decision recorded on 2026-08-27 was that the interlocutor is a FRESH session, always.
That settles **who**. U1 shipped on it. **What context** was never settled and never became an
acceptance criterion, which is why nothing caught its absence.

## The mechanism

### The seam already exists and is safe

`prePrompt` is emitted as a positional after `OPTIONS_END` (`claude-args.ts:565`), and
`forceReadOnlyPermission` (`claude-args.ts:282`) does **not** touch it — it rewrites
`permissionMode`, `disallowedTools`, `dangerouslySkipPermissions` and scrubs `extraArgs`, and
nothing else. A briefing injected as `prePrompt` therefore survives the read-only forcing
intact, with no new spawn path and no new flag.

Two constraints come with that seam:

- **`prePrompt` is in `ACCUMULATE_TEXT_KEYS` (`claude-args.ts:327`)** — global and folder
  scopes accumulate rather than overwrite. The briefing must accumulate too. An operator with
  a folder pre-prompt must not lose it because they opened a companion.
- Prompts at or under ~8000 characters launch as argv with the session; above that they fall
  back to a paste after boot. The briefing must stay comfortably under that, which is an
  argument for the shape proposed below and against the obvious alternative.

### What the briefing says

Everything needed is already on the `ReviewSnapshot` the pane is rendering. Nothing new has to
be computed, and no new IPC call is needed — only `addReviewCompanionHelper` growing a
parameter beyond the two paths it takes today.

The load-bearing field is **`head.ref`**: _"the git ref actually diffed — `refs/capy/pr/12`,
or the branch name"_ (`review-head.ts:70`). With `base` and `head.ref`, the session can
reproduce exactly what is on screen with `git diff <base>...<head.ref>` — in the cwd it was
given, with no checkout and no fetch, because the ref is already local.

The briefing should carry, in prose the session reads once:

| From the snapshot                  | Why it earns its place                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------------------- |
| `head.name`, `base`, PR number     | Names the review. Without it the session cannot say what it is looking at.                |
| **`head.ref`**                     | The exact ref. This is what makes the session able to read the diff itself.               |
| `folder` + an explicit warning     | That the cwd's own `HEAD` is unrelated to the diff, and `git status` will mislead.        |
| `files` paths + `+`/`−` counts     | Cheap orientation — a list of names is a few hundred bytes and answers "what is this PR". |
| `evidence` (commits, CI, PR state) | Already computed, already on screen; keeps the session from re-running `gh`.              |
| `truncated` / `totalRows`          | So it never claims completeness the pane itself does not have.                            |
| `head.freshness` / `fetchedAt`     | So it knows how stale its ref is, per T246.                                               |

### What the briefing does NOT carry

**Not the diff body.** The card's own warning is the reason: _sending everything is easy and
makes the answers vaguer_. A large diff also burns the session's context before the first
question and can push the prompt past the argv threshold. The session is given the ref and
told it may read what it needs — `git diff`, `git show`, `git log` are all still available to
a read-only session, since the read-only forcing denies **writes**, not reads.

**Not an instruction to form an opinion.** The briefing orients; it does not prompt a verdict.
A companion that opens with "here is what I think of this PR" is the review theatre T244's
non-negotiables exist to prevent, arriving through a side door.

## Open decisions — settle before dispatching

1. **Does the briefing appear in the transcript, or only in the model's context?**
   As `prePrompt` it renders as a visible first user turn: honest and inspectable, but it puts
   a wall of text at the top of every companion. `appendSystemPrompt` hides it, at the cost of
   the operator not being able to see what their session was told. **Recommendation: visible.**
   A reviewer who cannot audit what its reader was primed with is back to trusting a black box.

2. **Does the briefing refresh?** The snapshot changes under the companion — the operator hits
   refresh, T243 marks files viewed, the head moves. The briefing is a boot-time snapshot and
   will silently age. Options: leave it (state the `fetchedAt` in the text and let the session
   re-read the ref), or re-inject on refresh. **Recommendation: leave it, state the staleness.**
   Re-injecting means writing into a running session's stdin, which is a much larger door.

3. **What happens when the head is unreadable?** T246 has real states — not fetched, fetch
   failed. The companion can still be opened over them. The briefing must describe that state
   rather than name a ref that will not resolve, or the session's first command fails and it
   goes back to guessing.

## Acceptance criteria

- **AC-1** — A companion opened from a review is told, before its first turn: the PR number
  (when there is one), `head.name`, `base`, and `head.ref`. — verify: test
- **AC-2** — The briefing explicitly warns that the cwd's `HEAD` is not the diff under review,
  and names `git diff <base>...<head.ref>` as the way to read it. — verify: test
- **AC-3** — The briefing contains the changed-file list, but **no diff body**. — verify: test
- **AC-4** — The briefing never instructs the session toward a verdict, and no phrasing
  recommends approval. — verify: test (structural, in the spirit of T243 AC-8)
- **AC-5** — An operator-configured `prePrompt` (global or folder) survives: the briefing
  accumulates, never replaces. — verify: test
- **AC-6** — The briefing stays under the argv threshold for a review of at least 200 files;
  the file list truncates before the prompt does, and says it truncated. — verify: test
- **AC-7** — With an unreadable head (not fetched / fetch failed), the briefing states that
  and names no unresolvable ref. — verify: test
- **AC-8** — The read-only contract is unchanged: the companion still spawns with
  `permissionMode: plan` and the denied-tool set, and the briefing adds no flag. — verify: test
- **AC-9** — `review-pane-contract.test.ts` extended and **re-pinned**, never loosened.
- **AC-10** — Every new string through `$t()`, in both locale files. If the briefing is prose
  sent to a model rather than UI copy, state explicitly which it is and why. — verify: test
- **AC-11** — `CHANGELOG.md` and `docs/user/review-pane.md` updated.
- **AC-12** — `typecheck`, `lint`, `test:coverage`, `build`, `prettier --check` all green.

## Not in scope

Re-injecting on refresh (open decision 2). Carrying the operator's text selection into the
prompt — that is the T245 Tier 2 / T244 thread work and inherits their gates.
