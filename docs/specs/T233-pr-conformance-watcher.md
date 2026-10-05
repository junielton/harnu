# T233 — PR Conformance Watcher: the repo's own rules, checked and reported per PR

**Status:** Design (no code)
**Date:** 2026-08-25
**Card:** none yet — mint with `create_card` (the board's highest is T232; `mintNextCardId`
is `max + 1`, so this spec's number is a _prediction_ and must be reconciled with the
minted id before implementation. Never hand-write the card file.)
**Supersedes:** an earlier "autonomous PR watcher" design that reviewed, fixed, pushed,
approved and merged. That design was killed by four independent adversarial and market
reviews; §2 records why, because the reasons must not be rediscovered.
**Related:** T164 Review pane (backlog, high — this is a headless sibling, see §10),
T198 PR Stack Canvas (shipped — this consumes its engine), T166 code-review research
(`memories/research/2026-07-18-code-review-deep-research.md`)

---

## 1. Problem

Capy has a review-shaped hole with a very specific shape.

The repo carries an unusually large machine-readable rule corpus: **33 lessons** across 12
categories (`docs/lessons/index.md` is the index, not a checkpoint), **11 ADRs**, **42 dated decisions** in `.capy/memory/decisions.md`, and **4
contract gates** in `CLAUDE.md` (CHANGELOG, `capy-features.md` marker bump, `docs/user/`,
English lingua franca) — three of which have deterministic CI scripts (the fourth, English, is deliberately gate-less).

Nothing reads that corpus as a _checklist_. CI enforces four gates and nothing else
(`changelog-gate`, `awareness-gate`, `user-docs-gate`, `i18n-parity`; the English
lingua-franca rule is deliberately gate-less, `CLAUDE.md:102`).
A human reviewer holds maybe a third of it in their head. Every market tool treats
repo-specific rules as advisory prompt context: Greptile's custom rules are prompt
material, CodeRabbit's are style preferences. **No shipping product emits a structured,
auditable "this PR was checked against each of the repo's N mandatory rules; X pass, Y
fail."**

That is the gap. It is not "review PRs" — Anthropic, CodeRabbit, Greptile, Cursor and
Copilot all review PRs, several of them better than we would. It is _"prove this change
obeys the rules this repo already wrote down."_

### 1.1 What is NOT the problem

Merge throughput. Measured on this repo: median time-to-merge **2.6h**; one batch landed
**5 PRs in 61 seconds**; #226 (+3971 lines) merged 0.1h after creation. Merging here is a
hand gesture that takes seconds. Automating it would save nothing and cost the last
checkpoint where a human sees the work.

---

## 2. What was killed, and why (do not rediscover this)

The predecessor design had the watcher review, auto-fix, push, approve and merge in
cascade. Four reviews killed it. The reasons, each with its source:

**2.1 The three irreversible actions are in a shipped block-list.** `push --force-with-lease`,
PR approval and merge appear verbatim in the always-block set of Anthropic's Claude Code
auto mode classifier — "force-pushes" under _destroy or exfiltrate_, "direct main pushes"
under _bypass review / affect others_
([auto mode](https://www.anthropic.com/engineering/claude-code-auto-mode)).

**2.2 Nobody in the market merges autonomously.** Of ten tools surveyed, several fix and
push (CodeRabbit Autofix, Cursor BugBot, Copilot review→coding-agent, Devin); **zero**
merge. Copilot is hard-blocked by design and "cannot approve or merge a pull request".
Anthropic's own Code Review: _"It won't approve PRs — that's still a human call."_

**2.3 Self-report cannot authorize a merge — this is now quantified.** Judges mark their
own _failing_ rubric items as satisfied up to **50% more often** even under fully objective
criteria ([arXiv 2604.06996](https://arxiv.org/abs/2604.06996)); capability does not
correlate with less self-preference bias ([arXiv 2604.22891](https://arxiv.org/abs/2604.22891));
monitors go easy on their own model family ([arXiv 2603.04582](https://arxiv.org/pdf/2603.04582)).
A reviewer inside the generator's preference distribution provably degenerates to no
filtering at all ([arXiv 2606.28438](https://arxiv.org/html/2606.28438v1), Thm 2.3).
Frontier agents saturate validation tests while scoring **0% on held-out** ones; one wrote
a 2,900-line input→output lookup table for 97%/0% ([SpecBench](https://arxiv.org/html/2605.21384v1)).
More iterations make this **worse**, not better.

**2.4 This repo's own research already answered it.** T166 (43 agents, 3-vote adversarial
verification) states: _"Not an auto-approver. No agent verdict ever advances a card past
Review."_ It names Capy's never-delegate paths — `roadmap-ipc.ts` status writers, MCP
grant/confirm semantics, PTY lifecycle, dispatch stamping. **Four of the eleven currently
open PRs touch exactly those files.**

**2.5 The mechanics did not survive contact with the repo either.** `PrStackSnapshot`
carries no commit SHA, so the dedup the design depended on was unimplementable (§4.1).
The round cap was self-defeating: the review session's own fix push moves the head, so
every non-trivial PR terminates in manual escalation. And `safe_rebase_onto.sh`'s
stale-topic guard — the one that exists because a force-push once cost 22 files — is
**empirically inert in Capy worktrees**, which have no upstream configured, so it prints
`[skip]` and proceeds.

**2.6 What survived.** Reusing `pr-stack-core.ts` instead of rebuilding the DAG (both
adversaries called this the best part); one worktree+session per PR; reviewing once per
head SHA; and the rule-corpus verdict, which the market report independently identified as
the one genuinely uncovered idea.

---

## 3. Non-goals

Stated as hard boundaries, not as "later":

- **Never merges.** No `gh pr merge`, under any policy, on any repo.
- **Never approves.** No `gh pr review --approve`.
- **Never pushes to any branch.** No fixes, no rebases, no force-pushes. The watcher is
  read-only against git and write-only against PR comments.
- **Never posts to a third party's PR without the operator reading it first** (§7.3).
- **Never checks out fork code into a privileged worktree** (§7.4).
- Not a merge queue. Not a stack lander. Not a replacement for T164's Review pane.

---

## 4. Architecture

Three pieces: a data door, a per-repo config, a tick.

### 4.1 `get_pr_stack` — the data door (new MCP verb)

`src/main/pr-stack-core.ts` already computes everything the watcher needs about topology:
`parent`/`children`/`chain`/`depth`, `baseKind` (`'merged'` = the silent-retarget hazard),
`isStagingTip`, `carries`, `behind`, and per-PR CI rollup. `loadPrStack` is an
`ipcMain.handle` — renderer only. The watcher needs a read door.

**This is not a thin wrapper. It is a data-model change**, and pricing it as a thin verb is
the mistake the predecessor design made:

1. **`GH_FIELDS` must gain `headRefOid`.** `PrEntry` carries `branch`, never a SHA. Without
   it "review once per head" is unimplementable, and `updatedAt` is not a substitute — it
   bumps on label edits, comments and title changes, so the watcher would re-trigger itself
   by writing its own label.
2. **The `--limit 100` window truncates `mergedBranches` — a latent bug, and NOT the one
   this spec first claimed.** `buildGraph` (`pr-stack-core.ts:223`) builds `mergedBranches`
   from the **`headRefName`** of merged PRs. Verified at `--limit 200`:
   `feat/t218-canvas-pane` is never any PR's head — only ever a `baseRefName` — so #227 is
   `'missing'` because its base genuinely has no PR yet (an integration branch mid-pattern),
   and the canvas's **"0 needs retarget"** is _correct_. Widening the window would change
   nothing here.

   The truncation is still real (window covers #140–#239 while HEAD is #239) and will
   misclassify a PR based on a branch merged before #140 as `'missing'` rather than
   `'merged'`. Fix it because it is a bug, not because it explains T218.

**ACK shape:** the existing `PrStackSnapshot` plus `headRefOid` per entry. Agent-facing →
`docs/capy-features.md` + marker bump + `docs/user/agent-control.md` in the same change.

### 4.2 `.capy/pr-watcher.json` — per-repo config, set up interactively once

First invocation in a repo (or `--reconfigure`) asks one question at a time, proposing what
it can detect. Nothing is inferred silently, because the skill must never guess the voice it
speaks in on the operator's behalf.

| Key                  | Detected                                                                                           | Fallback when absent                                               |
| -------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `reviewEngine`       | `dtk:review-peer`/`dtk:review`, else `/code-review`                                                | `/code-review`, and the report says "no adversarial verifier pass" |
| `voice`              | `juni-vox` or any skill describing a writing voice                                                 | a one-sentence tone description the operator types                 |
| `knowledgePaths`     | `CLAUDE.md`, `docs/lessons/**`, `docs/adr*/**`, `docs/conventions.md`, `.capy/memory/decisions.md` | the defaults                                                       |
| `deterministicGates` | `scripts/ci/*.mjs` and the `CLAUDE.md` contract list                                               | none                                                               |
| `selfLogin`          | `gh api user`                                                                                      | asked                                                              |
| `limits`             | —                                                                                                  | 3 concurrent sessions, budget ceiling per tick                     |

**Detect the dependency, not just the skill.** `dtk:review-peer` needs GitHub MCP calls
(`SKILL.md:40,55,57`); a skill present but unable to reach its MCP server degrades at review
time, inside a dispatched session, where the operator never sees it. Setup probes the
capability the engine actually needs and records the result; a degraded engine is reported in
the artifact, not discovered silently.

Overridable by flag for operators who do not want the dialogue.

### 4.3 The tick

Runs from an Orchestrator session on `/loop`. Cheap by construction: `gh` + Capy verbs
only, **never reads a diff** — reading diffs is what the dispatched sessions are for.

1. **Read** the snapshot via `get_pr_stack`.
2. **Derive** per-PR state by crossing the snapshot with the ledger (§5). State is
   _computed_, never persisted — this removes the entire class of "ledger disagrees with
   reality" bugs.
3. **Dispatch** review sessions for PRs whose `headRefOid` differs from `reviewedHead`,
   up to the concurrency limit, subject to the budget guard (§7.5).
4. **Collect** finished sessions by reading their **artifact**, not their liveness (§5.2).
5. **Publish** the conformance verdict + verified findings (§6), per the posting policy (§7.3).
6. **Report** one line. Silence when nothing changed.

Deliberately absent: any merge step, any rebase step, any push step.

---

## 5. State

### 5.1 The ledger is an append-only event log, outside the orchestrator

Not a mutable `state.json`. Append-only, so a crashed orchestrator recovers by replaying
rather than by trusting a snapshot it may have half-written
([Scaling Managed Agents](https://www.anthropic.com/engineering/managed-agents)).

Events: `dispatched(pr, headOid, sessionId)`, `verdict(pr, headOid, artifactPath, summary)`,
`published(pr, headOid, commentIds)`, `quarantined(pr, reason)`.
Derived per PR: `reviewedHead` = the newest `verdict` event's `headOid`.

**Location.** The ledger lives at `<orchestrator repo root>/.capy/pr-watcher/ledger.jsonl`,
resolved to an absolute path once at tick start. `.capy/` is gitignored (`.gitignore:44`),
so the ledger and the config are local to the operator's machine and never travel with a
bundled skill — state that in the setup dialogue.

**Idempotency key — `(pr, headOid, baseRefOid, corpusFingerprint, action)`.** The naive
`(pr, headOid, action)` is wrong in both directions and each case is real here:

- **`baseRefOid`** — GitHub silently retargets a PR when its base branch is deleted (§4.1's
  own `baseKind: 'merged'` hazard). `pr` and `headOid` are unchanged while the reviewed diff
  becomes a completely different thing. Without the base in the key, the stale verdict stands.
- **`corpusFingerprint`** — Add lesson N+1 and every previously-reviewed PR would otherwise
  keep a verdict that silently means _"checked against the rules as they were on some past
  date"_ — the one claim a conformance artifact must never make. This is the product's core
  promise; it belongs in the key.

  **Scope it to rule-bearing, git-tracked content, or it re-creates the self-triggering bug
  round 1 killed.** A naive hash over all of `knowledgePaths` fails three ways:
  `.capy/memory/decisions.md` is untracked (`.gitignore:44`), so it cannot be diffed against
  a base, never travels with the bundled skill, and hashes differently on a second machine;
  **the watcher is itself an orchestrator session, so a single `memory_append` would bump the
  fingerprint and force a full re-review sweep** — the system's own side effect re-triggering
  the system; and churn is high in the wrong place (last 60 days: `CLAUDE.md` **25 commits**,
  `docs/adr/` 12, `docs/lessons/` 7), so a union hash invalidates every verdict every 2–3 days,
  driven mostly by `CLAUDE.md` edits unrelated to any rule.

  **Definition:** hash the tracked lesson and ADR files plus the _contract section_ of
  `CLAUDE.md`. Exclude untracked memory.

**And a cost bound the key alone cannot give.** Rebasing the bottom of a stack moves
`headOid` for every descendant, so a 7-deep stack would re-review 7 PRs whose own diffs did
not change. §2.5 correctly killed the predecessor's round cap; something must replace the
bound it provided. Use a **content key over the PR's own diff** (`git diff base..head`
hashed) as an additional skip condition: same diff content + same corpus ⇒ reuse the prior
verdict, re-stamped with the new SHAs, without re-running the review.

**One live workflow per branch**, enforced by using the branch as the uniqueness key. Capy's
own `SESSION_ALREADY_IN_FLIGHT` already blocks a second process in one worktree; the ledger
makes the orchestrator agree.

### 5.2 A finished session is not a delivered result

`capy-session-commit-gap` records this and it happened **twice during this design session**:
two of four dispatched research agents ended their turn holding the deliverable and
delivered nothing. `get_session` reports liveness, not outcome.

So the contract is an **artifact on disk**, not a report in a transcript.

**The path is absolute and belongs to the orchestrator, not the session.** The session runs
in the PR's worktree; the orchestrator runs in the main checkout; `.capy/` is gitignored, so
worktrees do not have one (verified: three sampled Capy worktrees have no `.capy/out`). A
relative `.capy/out/...` would be written in the worktree and read in the main checkout —
the file would never arrive, every session would be recorded `quarantined`, and the design
would produce **zero verdicts on day one**.

The orchestrator resolves `<orchestrator repo root>/.capy/out/pr-<n>-<headOid>.json`, creates
the directory, and passes the **absolute path** into the boot prompt as the required output
location. The session writes there or the run does not count.

**Write atomically** (temp sibling + rename) so a session that dies mid-write leaves no
partial artifact, and **stamp the artifact with the `headOid` it reviewed**; the orchestrator
refuses an artifact whose stamp disagrees with the SHA it dispatched. No artifact, a partial
artifact, or a mismatched stamp = no verdict, regardless of what the session said. The
orchestrator never infers success from a session having ended.

**Quarantine needs a backoff.** On a PR under active development the author can push while
the review runs, so the session reviews a SHA the orchestrator did not dispatch and the
artifact is refused. That recovers — `reviewedHead` is untouched, the next tick re-dispatches
— but nothing bounds the loop, and a hot PR could consume the whole tick budget. Apply a
per-PR backoff after each quarantine, and surface a PR that quarantines repeatedly as
`needs-you` rather than retrying forever.

---

## 6. The output — a conformance verdict

The deliverable, and the reason this is not another PR review bot.

### 6.1 Two lanes, deliberately separated by trust

**Lane A — deterministic gates.** Ran, not judged: `scripts/ci/*.mjs` — `changelog-gate`,
`awareness-gate`, `user-docs-gate`, `i18n-parity`. A script does not share a preference
distribution with the model that wrote the code, so the **predicate** is outside the
self-confirmation failure mode (§2.3).

**But the predicate is not the whole gate — the inputs are judgment, and the default
produces a FALSE PASS on this repo's stacked PRs.** This is the dangerous direction: a
false failure is noise, a false pass is a conformance product certifying something it
never checked.

The gates diff against `<GATE>_BASE || 'origin/main'`. On a stacked PR the cumulative diff
contains **both** an ancestor's violation-shaped change **and** that ancestor's compliance
artifact, so the gate credits the descendant with work it did not do. Measured directly:

```
GATE_CHANGED_FILES="src/main/mcp/tool-catalog.ts"                        → ✗ FAIL
GATE_CHANGED_FILES="src/main/mcp/tool-catalog.ts,docs/capy-features.md"  → ✓ PASS
GATE_CHANGED_FILES="src/main/foo.ts"                                     → ✗ FAIL
GATE_CHANGED_FILES="src/main/foo.ts,CHANGELOG.md"                        → ✓ PASS
```

On #237 (T218 U7) against `origin/main`, the cumulative diff carries `tool-catalog.ts` _and_
`docs/capy-features.md` — both from U5. U7 itself touched neither. The gate reports **PASS**,
and a stacked PR that omits its own CHANGELOG entry passes on an ancestor's.
**Seven of the eleven currently open PRs are stacked.**

Three binding consequences:

1. **Pass the file list, not a base.** All three contract gates accept `GATE_CHANGED_FILES`,
   which bypasses git entirely and is more deterministic than juggling three different base
   variables (`AWARENESS_GATE_BASE`, `CHANGELOG_GATE_BASE`, `USER_DOCS_GATE_BASE` — the spec
   must not say "and the equivalent for the other gates", they are not uniform). The file
   list comes from `git diff --name-only <baseRefName>...<headRefOid>` — **three-dot**, which
   is what the gates themselves use. (Two-dot on #237 is 96 files; three-dot is 64. A spec
   quoting the two-dot number quotes a number the gate never sees.)
2. **`i18n-parity.mjs` takes no base and has no concept of a PR.** It compares key sets in
   the **working tree**. It is only meaningful if the worktree is checked out at the PR head —
   state that, and never render it under a base header as if it were diff-scoped.
3. **Shell out to `local-ci`.** `scripts/ci/local-pipeline.sh` accepts `--base`, `--labels`
   and `--json` — the last documented verbatim as _"write a machine-readable summary for an
   orchestrator to read"_. It exports all three base vars itself. It also warns that a stale
   `origin/main` gives wrong answers, so **the watcher fetches before every run**.

**The gates also have an operator escape hatch the watcher must model.** `awareness-gate.mjs:50`
and `user-docs-gate.mjs:65` read `GATE_PR_LABELS`; `CLAUDE.md:73,90` document `no-awareness`
and `no-user-docs` as legitimate escapes. The verdict is a function of `(changedFiles, labels)`,
not of the diff alone. The watcher **reports both** — the raw predicate result and whether a
label waived it — and **never applies a label itself**; a self-clearable gate is not a gate.

**Lane B — judged rules.** The 33 lessons, 11 ADRs and 42 decisions, each a checkpoint:
applies / applies-and-violated / not applicable, citing the rule's path. Model-judged,
therefore explicitly marked as such.

### 6.2 Shape

```
Conformance — PR #234 @ 4a91c2b

Deterministic (4 pass · 1 N/A · 0 fail)   base: feat/t218-canvas-pane-u6-assets-origin
  ✅ CHANGELOG entry present
  ✅ docs/user/ touched (new top-level component)
  ✅ i18n parity — 1558/1558, zero drift
  ➖ awareness gate N/A — tool-catalog.ts untouched (base: feat/…-u6)
  ✅ format:check

Judged (12 applicable · 11 pass · 1 fail)
  ❌ docs/lessons/i18n/002-vue-i18n-schema-parity.md — <why, citing the diff>
  ✅ … (11 more)

Findings (2 verified · 1 refuted · 1 unverified)
  🔴 <finding> — verified by <lens>
  💬 <finding> — UNVERIFIED, no adversarial pass available
```

Every finding carries its verification status. An unverified finding is published as
unverified — never silently promoted.

### 6.3 Verification

2–3 verifiers with **different lenses** (correctness / security / does-it-reproduce), not
N identical ones: marginal gain per verifier is +14.9 / +13.5 / +11.2 points and the binding
constraint is **error correlation, not count**
([arXiv 2511.16708](https://arxiv.org/pdf/2511.16708)). Where the runtime allows it,
verifiers should be a **different model family** than the author's, because monitors favour
their own family ([arXiv 2603.04582](https://arxiv.org/pdf/2603.04582)). Verifiers get a
**clean context** — the active ingredient behind Cognition's ~2 bugs/PR at 58% severe.

---

## 7. Guardrails

### 7.1 The gate cannot be argued with

**Scope note:** in v1 the only outward action is posting a PR comment, so the full two-stage
classifier below is **forward-looking design, not v1 build**. What v1 ships is the structural
half — §7.1.1 — because that is what makes the non-goals real rather than prose. The
classifier is specified here so that the shape is fixed before anything heavier is added.

#### 7.1.1 What v1 actually enforces (structural)

The non-goals in §3 are enforced on the **dispatched session**, not on the watcher's own
text, because the session is what holds a Bash tool. A boot prompt saying "do not push" is
the exact thing this spec's own research calls insufficient: _"a guardrail is a property of
the system — never a sentence in the prompt asking the agent to be careful."_

**And the enforcement this needs does not exist yet — this is a hard dependency, not a
detail.** `create_session`'s `bootOverride` is restricted to **model / effort only**:
_"Any other field is refused with `INVALID_BOOT_OVERRIDE`"_ (`tool-catalog.ts:356-360`).
There is no field for permissions, settings, or a deny-list. And Capy's hook injection
cannot supply one either — `hook-settings-blob.ts:21-22` states that _"the decision-carrying
PreToolUse/PermissionRequest are OMITTED on purpose"_; only observational events are injected.

So a dispatched session **cannot today be asked to refuse `gh pr merge`, `gh pr review
--approve` or `git push`.** Until that changes, the non-goals in §3 are prose, which is
exactly what round 1 found and what a rewrite of the wording did not change.

**T233 therefore depends on one of two agent-facing changes, and owes it in the DoD:**

- **(a)** extend `bootOverride` to carry a permission deny-list, or
- **(b)** inject a decision-carrying `PreToolUse` hook for sessions the watcher spawns.

Either is a `tool-catalog.ts` change and pulls the awareness + user-docs contracts with it.
**Neither is optional**: without one, AC-4 cannot pass and the watcher must not ship.

Separately and regardless: the boot prompt names no skill that performs a forbidden action.
`dispatch-pr-review`'s template instructs `--approve`; `/code-review --fix` writes to the
tree; `dtk:ship` pushes; `git-rebase-onto` force-pushes. None may be invoked from this path.
That is necessary but **not** sufficient — it is prompt discipline, and prompt discipline is
what §7.1 exists to replace.

#### 7.1.2 The classifier (forward-looking)

Any action that leaves the machine passes a classifier that sees **only the mandate and the
executable payload** — never the agent's reasoning, never tool output. An over-eager or
prompt-injected session cannot talk its way through, and the gate is immune to injection
carried in a diff it is reviewing. Shape: fast single-token "err toward blocking", then
chain-of-thought only on flagged actions (8.5% → 0.4% FPR in the shipped version).

The gate judges **scope, not relatedness**: "review this PR" does not authorize "push a fix",
however related.

### 7.2 Read-after-write before anything irreversible

Re-read remote state and confirm it matches what the action assumed, immediately before
acting. The incident catalog's sharpest finding is that agents run dozens of operations per
minute with **no read-after-write check**; the errors are shell quoting and wrong targets,
not hallucinations, and smarter models do not fix them.

In v1 the only outward action is posting a comment, so this is cheap. It exists now so that
it exists _before_ anything heavier is ever added.

### 7.3 Posting policy — both cases, stated

**Own PRs** (`author.login == selfLogin`): the conformance verdict and verified findings are
posted autonomously as **unresolved review comments**. Never an approval, never a
`--request-changes` (which would block the operator's own merge), never a push. This is the
only autonomous outward action in v1.

**Third-party PRs: draft and hold.**

`@dberri` has two PRs open on this repo today. Posting machine-generated review comments
under the operator's identity, unread, to a colleague is not a default anyone should ship.
`dispatch-pr-review` was built around a posting gate for exactly this reason.

**v1: third-party PRs produce a drafted comment held for the operator.** Autonomous posting
to a third party requires an explicit per-repo opt-in that names the risk. Context: GitHub is
weighing PR caps and a kill switch for AI-generated PR noise; tolerance is falling, not rising.

### 7.4 Fork code is untrusted input

Never check out a fork's head into a privileged worktree and never execute it. An autonomous
bot achieved RCE on GitHub-hosted runners in Feb 2026 through exactly this pattern; GitHub
hardened `actions/checkout` defaults in June 2026. For fork PRs, review the **diff**, do not
materialize and run the branch.

### 7.5 Cost enforcement in the request path

A dashboard is not a control — one team took a **$47,000 eleven-day** runaway invoice. The
budget guard **refuses the next dispatch** at per-tick and per-PR ceilings. Hard caps on
concurrency (3) and on total sessions per tick. A sweep of N PRs is a priced decision the
operator sees before it runs.

Cheap wins: stagger sibling session starts so they share a cached prompt prefix; match the
tick interval to the subagent prompt-cache TTL; keep the orchestrator on the strong model
and the reviewers on the cheap one.

### 7.6 Worktree hygiene

Four filed Claude Code bugs, matching two hazards already in this repo's memory:

- **Serialize `git worktree add`** behind one lock, 3–5 retries at 200/400/800ms —
  `.git/config.lock` races when 3+ agents provision concurrently.
- **Never auto-delete a worktree on session failure.** Quarantine it. A commit that failed on
  a transient lock, followed by cleanup, destroys the work permanently.
- **Forbid `git stash`** in dispatched sessions and assert the branch before any write —
  worktree agents have been observed committing to each other's branches.
- Reuse an existing worktree when one exists for the head branch; create through Capy, never
  `git worktree add` by hand.

---

## 8. What this does NOT solve, stated plainly

**8.1 Every finding is still produced by reading, never by running.** All nine defects found
during the 90-tick pilot came from code reading. `.capy/memory/decisions.md` records the same
lesson twice — BUG-86 (_"defect found only by a live probe on the rebuilt app"_) and T215
(_"proven by CODE READING, not by executed tests"_). This design adds a second reader. **It
does not add a live probe, and that remains the largest gap in the loop.** Named here so it
is not mistaken for solved.

**8.2 The Review-queue backlog is untouched.** 62 roadmap cards sit in `review`. A staleness
nudge into the Approval Inbox is a separate, cheaper intervention with published effect
(Meta's nudgebot: −7% time-in-review, −12% >3-day waits) and would plausibly outperform this
whole design. Separate card.

**8.3 `isMergeNext` is broken and is not fixed here.** `pr-stack-core.ts:317` requires
`reviewDecision === 'APPROVED'` unconditionally. On a solo repo where self-approval is
impossible, this is unreachable — verified: all 11 open PRs have it empty, so the canvas
reads **"0 ready to merge"** permanently and the KPI is dead. The fix is policy-aware, but it
changes a shipped UI predicate every Capy user sees, and its correctness depends on
distinguishing _403 "Upgrade to Pro"_ (rules impossible) from _403 insufficient scope_ (rules
unreadable) from _200 empty_ (no rules) — a problem unrelated to this watcher. **Separate card.**

---

## 8bis. Where the logic lives — the decision this spec owes

Every bundled skill on disk today (`delivery-verifier`, `status`, `orchestrate-delivery`,
`mission`, `conductor`) is **pure markdown** — a single `SKILL.md`. `mission/SKILL.md:65`
shows the pattern: logic is prose telling the agent which verb to call.

That is incompatible with §8quater's "pure core in the coverage surface". **Decided: split.**

- **The state machine is TypeScript** — a new in-coverage `src/main/pr-watcher-core.ts`
  (ledger fold, `reviewedHead` derivation, the 5-part idempotency key, the diff-content skip,
  conformance folding, the budget predicate) plus a thin shell. Exposed to the skill through
  verbs. This is what makes AC-1/2/6/8 unit-testable at all, and it is what §7.1's own
  principle demands: a ledger enforced by prose is prompt discipline, not a mechanism.
- **The review prose is markdown** — boot-prompt authoring, the knowledge-path checklist, the
  operator dialogue. That is genuinely prompt work and belongs in `SKILL.md`.

**`vitest.config.mts` makes this mandatory, not stylistic.** It excludes both
`src/main/pr-stack.ts` (`:52`) and `src/main/mcp/tool-handlers.ts` (`:40`) from coverage. Every
file the first DoD draft listed for new logic is outside the coverage surface — putting the
ledger fold in `tool-handlers.ts` would make it untestable _and_ invisible to the gate, which
is precisely what ADR-0001 exists to prevent.

## 8bis-b. Delivery — how this ships

A **bundled Capy skill**, per [ADR-0009](../adr/0009-bundled-skill-delivery-channel.md) and
[T217](T217-bundled-skills.md). Concretely:

- Lands at `resources/skills/skills/pr-watcher/SKILL.md`, staged into userData and passed at
  spawn via `--plugin-dir`.
- Invoked as **`capy:pr-watcher`** (namespaced; never shadows a personal skill of the same name).
- Needs a `resources/skills/CATALOG.md` entry **and** a bump of its marker
  (`<!-- capy-skills v4 (2026-08-24) -->` → v5).
- Ships **off by default**, behind Settings → Skills, per-project or global.
- **Takes effect on the NEXT session, not the running one** — the setup dialogue must say so.

## 8ter. Repo contracts this implementation owes

_This spec is docs-only and owes none of them. The implementation owes all of these._

| Contract              | Trigger                                          | Owed                                  |
| --------------------- | ------------------------------------------------ | ------------------------------------- |
| CHANGELOG             | any `src/` change (`changelog-gate-core.mjs:22`) | dated entry, user-facing wording      |
| Self-awareness        | `src/main/mcp/tool-catalog.ts` in the diff       | `docs/capy-features.md` + marker bump |
| User docs             | `tool-catalog.ts` changed at all (rule 3)        | `docs/user/agent-control.md`          |
| i18n parity           | only if a UI string appears — v1 has none        | both locales or nothing               |
| English lingua franca | all prose, comments, commits                     | no CI gate; review-time only          |

## 8quater. Test plan

Split by ADR-0001 (`vitest.config.mts:27` excludes env-bound shells from coverage):

**Pure (in the coverage surface):** state derivation from `snapshot × ledger`; ledger fold
and replay; idempotency-key computation including `corpusFingerprint` and the diff-content
key; conformance folding (gate results + judged rules → artifact); artifact stamp validation;
the budget predicate.

**Shell (coverage-excluded):** `gh` invocation, session dispatch, worktree provisioning,
file I/O.

**Live verification (no unit test can replace it):** the base-selection fix (§6.1) must be
verified against a real stacked PR — the false-failure case is invisible to a mocked diff.
This is the same gap §8.1 names: read-only proof is what has failed twice in this repo
(BUG-86, T215).

## 8quinquies. Definition of done — files the implementation touches

**Verb wiring — two of these break the build if missed.** Both are exhaustive
`{ [K in McpOp]: … }` maps, so adding an op fails typecheck until each has an entry:

- `src/main/mcp/tool-catalog.ts` — the verb definition (`MCP_OPS`)
- `src/main/mcp/tool-handlers.ts` — the handler (shell, coverage-excluded)
- **`src/main/mcp/validate.ts`** — `PARSERS` (`:708`) ← compile-breaking
- **`src/main/mcp/plan-input.ts`** — `TRANSLATORS` (`:238`) ← compile-breaking
- `src/main/mcp/instructions.ts` — decide whether the verb appears in the server preamble

**Data model:**

- `src/main/pr-stack-core.ts` — `PrEntry.headRefOid`
- `src/main/pr-stack.ts` — `GH_FIELDS` gains `headRefOid`; window widened

**New logic (in coverage, per §8bis):**

- `src/main/pr-watcher-core.ts` — the pure state machine
- its thin shell

**Tests that enumerate verbs and will fail until extended:**

- `tests/mcp-tool-catalog.test.ts` — note `:270` asserts _everything but `get_session` and
  `get_fleet` has `discloses` undefined_; a read verb exposing paths fails this
- `tests/mcp-validate.test.ts`, `tests/mcp-plan-input-seam.test.ts`,
  `tests/mcp-plan-tool-call.test.ts`, `tests/mcp-settings-local.test.ts` (`:36`),
  `tests/mcp-instructions.test.ts` (`:19`)
- `tests/pr-stack-core.test.ts` — the `pr()` factory (`:22`) has explicit defaults: **one edit**

**The enforcement dependency (§7.1.1):** whichever of (a) `bootOverride` extension or
(b) `PreToolUse` deny hook is chosen — another `tool-catalog.ts` change.

**Docs:** `docs/capy-features.md` (+ marker bump), `docs/user/agent-control.md`, `CHANGELOG.md`,
`resources/skills/skills/pr-watcher/SKILL.md`, `resources/skills/CATALOG.md` (+ marker bump).

**Verified NOT needed:** renderer ripple is nil — `stores/pr-stack.ts:15` imports only
`PrStackPrefs` and the components consume structurally, so an additive `PrEntry` field needs
zero renderer edits. `plan-tool-call.ts` derives redaction from `def.discloses`; `grant-core.ts`
uses the `McpOp` type only.

**Coverage thresholds are real:** lines/statements 63, functions 73, **branches 87**
(`vitest.config.mts:65-71`, `autoUpdate: false`). Each slice ships its own tests or the gate trips.

## 8quinquies-b. Phasing

The spec previously had none. Recent merged PRs run 144–3971 lines, so 250–800-line slices fit.

| #     | Slice                                                                                                                    | Size            | ACs              |
| ----- | ------------------------------------------------------------------------------------------------------------------------ | --------------- | ---------------- |
| **1** | **Lane A conformance** — shell out to `local-pipeline.sh --base --labels --json`, fold its JSON into the artifact schema | ~250            | AC-3, AC-9       |
| 2     | `headRefOid` + `get_pr_stack` (12 files, incl. the two compile-breaking maps)                                            | ~350            | AC-1             |
| 3     | Ledger + idempotency in `pr-watcher-core.ts` (pure, fully unit-testable)                                                 | ~400            | AC-1, AC-2, AC-6 |
| 4     | Enforcement dependency (§7.1.1 a-or-b) + dispatch + artifact validation                                                  | ~300            | AC-2, AC-4, AC-5 |
| 5     | Lane B                                                                                                                   | **unestimated** | —                |
| 6     | Budget guard + concurrency lock/retry                                                                                    | ~200            | AC-7, AC-8       |

**Slice 1 first, not the verb.** Lane A needs a base and labels, not a SHA — and
`local-pipeline.sh --json` already exists explicitly for an orchestrator to read. It is the
cheapest slice and the first one that produces the product's actual output.

**Slice 5 is deliberately unestimated.** Its cost profile is undecided (§11 Q2), its retrieval
strategy is unspecified, and it is the only slice whose output quality no unit test can assert.

## 8sexies. Out of scope (work, not behaviour)

Deliberately not in this card: the `isMergeNext` policy fix (§8.3); the Review-queue staleness
nudge (§8.2); any live-probe / built-app verification lane (§8.1); T164's Review pane UI (§10);
the ADR `0002` numbering collision in `docs/adr/`.

## 9. Acceptance criteria

Each is stated so it can fail. Where a criterion needs a fixture or a harness, it is named.

| AC       | Criterion                                                                                                                                                                                                                                                 | How it fails                                                                                                                                                                                |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AC-1** | `get_pr_stack` returns `headRefOid`; a PR whose head, base and corpus fingerprint are unchanged is not re-reviewed across ≥3 consecutive ticks                                                                                                            | fixture: 3 identical snapshots → any dispatch call is a failure                                                                                                                             |
| **AC-2** | A session that ends without a valid artifact — absent, partial, or stamped with a different `headOid` — is recorded `quarantined`; `reviewedHead` is unchanged                                                                                            | fixture ledger + each of the three bad-artifact cases → a `verdict` event is a failure                                                                                                      |
| **AC-3** | For fixture PR X, the report lists exactly the four gates (`changelog`, `awareness`, `user-docs`, `i18n-parity`) plus any non-gate steps `local-ci` runs (e.g. `format:check`, an npm script — not a gate), verdicts matching a hand-computed expectation | any gate missing, or an N/A rendered as a pass, is a failure                                                                                                                                |
| **AC-4** | A dispatched session attempting `gh pr merge`, `gh pr review --approve` or `git push` is **refused at runtime**. Blocked on §7.1.1's dependency — untestable, and the watcher must not ship, until (a) or (b) lands                                       | run the forbidden command in a dispatched session; it succeeding is a failure. Grep is _additionally_ run over the shipped skill, but is not the assertion                                  |
| **AC-5** | A PR whose `author.login != selfLogin` produces a held draft and zero `gh` post calls                                                                                                                                                                     | any outbound post on a third-party PR is a failure                                                                                                                                          |
| **AC-6** | Killing the orchestrator mid-tick and restarting produces no duplicate comment                                                                                                                                                                            | replay the same tick twice against a mock; two comments is a failure                                                                                                                        |
| **AC-7** | Three concurrent dispatches on a cold repo all provision                                                                                                                                                                                                  | unit-test the lock/retry wrapper (3–5 retries, 200/400/800ms) — the full case is e2e and this spec proposes no e2e harness, so the unit test is the shipped assertion and the gap is stated |
| **AC-8** | Exceeding the per-tick budget **refuses the next dispatch**                                                                                                                                                                                               | a logged warning with the dispatch proceeding is a failure                                                                                                                                  |
| **AC-9** | A stacked PR's gates run against a file list computed from its OWN base (three-dot), not the cumulative diff                                                                                                                                              | fixture: a stacked PR that omits its own CHANGELOG entry while an ancestor added one → **a PASS is the failure**. This is a false-PASS test, not a false-failure one                        |

---

## 10. Relationship to T164

T164 (Review pane, backlog, priority high, named by 8/8 personas) is the **operator-facing**
review surface: diff + evidence header + the card body beside the diff. Its own v1 list puts
agent-assisted review at **item 7, explicitly "later (v1.x→v2)"**.

This spec is the **headless** half — it produces the conformance artifact that T164 would
render. It should not become a substitute for items 1–6. If T164 lands first, this becomes
its data source; if this lands first, it must not grow a UI.

---

## 11. Open questions

- ~~**Q1** Where does the conformance artifact live?~~ **Answered in §5.2:** an absolute
  path under the orchestrator's repo root. It was filed as a preference question and was in
  fact a correctness blocker.
- **Q2** Is Lane B (judged rules) worth running on every PR, or only when Lane A passes?
  Lane A is nearly free; Lane B is the expensive half.
- ~~**Q3** Direct scripts or `local-ci`?~~ **Answered:** `local-ci` already sequences them
  and is replicated into every worktree — shell out to it, passing the PR's own base.
- ~~**Q4** Contents or paths for the corpus fingerprint?~~ **Answered in §5.1:** neither as
  originally framed — hash tracked rule-bearing content only, excluding untracked memory.
- **Q5** Which enforcement path for §7.1.1 — extend `bootOverride`, or inject a
  decision-carrying `PreToolUse` hook? This is the one open decision that gates shipping.
- **Q6** Lane B's retrieval strategy: which lessons apply to which changed paths, or full
  corpus and accept the cost? Unanswered, and it is why slice 5 is unestimated.
- **Q7** What does the budget guard read? Capy has `usage-cost-core.ts`, `usage-bi.ts`,
  `usage-history-core.ts` — none is named, and per-session spend attribution is unverified.
- **Q8** What is the artifact JSON schema? §6.2 shows a rendered report; two components must
  agree on the JSON and §10 promises T164 will render it.
