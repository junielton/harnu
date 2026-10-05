# Approving from the review pane — the first time Capy writes to GitHub as you

**Status:** PRD v1 (2026-08-27) · **Card:** `T244-t164-v1-1-approve-or-request-changes-on-a-pr-from-the-review` · **Deps:** the T164 review pane, **merged into `main` on 2026-08-28** as `#251`. `T246` (foreign-PR review) strongly recommended first
**Base:** `docs/prds/T164-review-pane.md` §3.2 (R1/R2/R3) · `docs/research/2026-08-25-code-review-in-the-agent-era.md`

---

## 0. Premise — why this one gets a PRD and the others get a spec

Every other path in the review pane is **read-only**: three IPC calls, `git`
reads, one cached `gh pr list`. Nothing it does is visible to another human, and
nothing it does can be wrong in a way that costs someone else.

This card breaks that. An approval is:

- **written under the operator's own identity**, indistinguishable from one they
  typed on github.com;
- **visible to other people**, and often the thing that unblocks a merge;
- **the exact artifact** the persona research flagged as what an agent-adjacent
  surface must never be able to produce casually.

The engineering here is small — `gh pr review --approve` is one process spawn.
**The design is the hard part, and it is entirely about what must not happen.**

## 1. Non-negotiables

These are the point of the card, not ceremony around it.

### 1.1 No agent may reach this, ever

No MCP verb, no session, no skill, no automation may cause an approval. The only
trigger is a human gesture in the UI.

This is not a permissions detail — it is the whole reason Capy can be trusted to
dispatch work unattended. Capy's zero-friction principle puts human gates at
exactly three doors: **execute, accept, route**. Approving someone's code is an
_accept_ door. It stays shut to everything but a person.

Concretely: the IPC handler must not be reachable from the MCP tool catalog, and
adding it there later must require deleting a test that says so.

### 1.2 A confirm before submit

Showing what is about to be submitted, and to which PR — same posture as Capy's
own destructive-verb gate. An approval typed into the wrong PR is not recoverable
by undo; it is recoverable only by explanation.

The confirm also carries **one line naming the copy-paste boundary** (T245 §2.1).
Once text from a companion session is pasted into this body it is submitted under
the operator's identity and carries no different status from words they typed
themselves. This is not a restriction — pasting is allowed and unenforceable
anyway — it is the single moment where saying it out loud changes what someone
does next.

### 1.3 `REQUEST_CHANGES` is as reachable as `APPROVE`

**A surface where approving is one click and objecting is three teaches people to
approve.** That is review theatre, and it is the specific disease this entire
epic was built to treat: the research found 31% more PRs merging with no review
at all, and agentic PRs waiting 5.3x longer for a reviewer. A one-click Approve
button on top of that is not a feature, it is an accelerant.

The three events — `APPROVE`, `REQUEST_CHANGES`, `COMMENT` — get equal
prominence, equal click cost, and no default selection.

### 1.4 Never infer the verdict

No "CI is green — approve?" affordance. No pre-filled recommendation. No
enabling Approve only when checks pass (which reads as endorsement) and no
disabling it when they fail (which reads as the tool having an opinion).

**R1 — agents report, humans conclude** — applies here with more force than
anywhere else in the pane. The evidence header states facts; the human draws the
conclusion; the tool carries it. Those are three different jobs and this card
must not blur two of them.

### 1.5 You may only approve what you read

The diff the pane renders is `<base>...<head>` — three-dot, merge-base — which is
the same recorte GitHub shows in its PR view. That equivalence is what makes
approving from Capy honest.

**If the base ever becomes configurable, or a foreign head is reviewed against a
resolved base (T246), the pane must not offer to approve a diff that differs from
what GitHub would show.** Approving against a diff nobody else can see is worse
than not shipping this at all — it produces a defensible-looking approval of
something that was never reviewed.

**And the check must pin the HEAD, not only the base.** Adversarial review
(2026-08-27) caught this: `ReviewSnapshot` (`review-ipc.ts:261-275`) and
`ReviewEvidence` (`review-core.ts:904-920`) carry `branch` and `base` as **names**
plus a `fetchedAt` timestamp — **no commit SHA anywhere**. A guard built only on
those names is string equality, not a statement about content. If the branch is
pushed to, amended or rebased between reading the diff and clicking Approve — very
plausible in this repo, where concurrent sessions in one worktree share index and
HEAD — the names still match and the operator approves code they never saw.

So: **pin a head SHA into the snapshot at fetch time**, and refuse submission with
a stated reason if HEAD has moved since. Same shape of check already specified for
the base; it was simply missing for the head, which is the half that actually
moves.

## 2. What GitHub gives us

**Verified against the live API on 2026-08-27 by schema introspection:**

- `submitPullRequestReview` with `PullRequestReviewEvent` ∈
  `{ COMMENT, APPROVE, REQUEST_CHANGES, DISMISS }`; `addPullRequestReview` to
  create one.
- REST equivalent: `POST /repos/{owner}/{repo}/pulls/{n}/reviews`.
- `gh pr review --approve` / `--request-changes` / `--comment` — **the cheapest
  path, and the recommended one**: it inherits the operator's existing auth, so
  Capy never handles, stores, or scopes a token of its own.

Inline threads (`addPullRequestReviewThread`, taking `path`/`line`/`side`/
`startLine`/`startSide`) belong to T245 Tier 2 and should inherit **this** card's
gate rather than growing a second one.

## 3. Acceptance criteria

- **AC-1** — `APPROVE`, `REQUEST_CHANGES` and `COMMENT` are submittable from the
  pane, with a body. — verify: manual
- **AC-2** — All three have equal visual prominence and equal click cost, and
  none is pre-selected. — verify: visual
- **AC-3** — A confirm precedes submission, naming the PR number, the repo, the
  event, and the copy-paste boundary (§1.2). — verify: manual
- **AC-4** — **No MCP verb, session or skill can reach the submit path.** A test
  asserts the handler is absent from the tool catalog and fails if it is ever
  added. (Adversarial review confirmed this is a real architectural guard rather
  than a lexical one: MCP dispatch goes through a closed, statically enumerated
  `MCP_OPS` union wired 1:1 to handlers, with no generic IPC passthrough
  anywhere in the layer.) — verify: test
- **AC-5** — No affordance recommends, pre-fills or gates a verdict on CI state,
  review state, or anything else. Approve is neither disabled by red checks nor
  encouraged by green ones. — verify: test + visual
- **AC-6** — Submission is refused, with a stated reason, when the rendered diff
  is not `<base>...<head>` against the PR's own base, **or when the head SHA
  pinned at fetch time no longer matches the branch's current HEAD**. Name
  equality alone does not satisfy this AC. — verify: test
- **AC-7** — With no `gh`, unauthenticated, or no PR, the affordance is **absent
  or visibly disabled** — never present and inert. — verify: test
- **AC-8** — A failed submission surfaces the failure. It is never swallowed, and
  the pane never shows a submitted state it did not confirm. — verify: test
- **AC-9** — `review-pane-contract.test.ts` extended and **re-pinned**, never
  loosened. — verify: test
- **AC-10** — Every new string through `$t()`, in **both** locale files. — verify: test
- **AC-11** — `CHANGELOG.md`, `docs/user/review-pane.md` and
  `docs/capy-features.md` reviewed — the last one only if an agent-facing surface
  changed, which it must not. — verify: review
- **AC-12** — `typecheck`, `lint`, `test:coverage`, `build`,
  `prettier --check .` all pass. — verify: test

## 4. Plan

| unit   | scope                                                                                        |
| ------ | -------------------------------------------------------------------------------------------- |
| **U1** | Main: `gh pr review` seam, the base-equivalence guard (AC-6), the not-in-catalog test (AC-4) |
| **U2** | Renderer: the three-event control, the confirm, failure surfacing, i18n                      |
| **U3** | Docs + changelog                                                                             |

**Sequencing:** ship this **last** of the four v1.1 cards. It is the only one that
writes, it benefits from T246 having settled base resolution, and it is the one
where being early buys nothing and being wrong costs someone else's trust.
