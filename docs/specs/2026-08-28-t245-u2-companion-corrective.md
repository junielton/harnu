# The review companion must know that it is blind

**Date:** 2026-08-28
**Card:** T245 — a Claude session beside the review (U2, follow-up to the merged U1)
**Status:** design proposed, not implemented. **Blocked on an operator signature** — see §6.
**Supersedes:** `2026-08-28-t245-u2-companion-briefing.md`, rejected by three adversarial
reviews on the day it was written. That document proposed a _briefing_; this one proposes a
_corrective_. The difference is the whole design.
**Depends on:** T245 U1 (`#254`), T246 (`#253`), T243 (`#256`) — all merged.

## 1. The defect, as observed

The operator opened a review of `#246` (`fix/topbar-drag-region`, **38 commits behind
`origin/main`**) from the repo's main checkout, pressed **Ask a fresh session**, and asked it:
_"do you know the context of the PR I'm reviewing?"_ (translated)

It answered **"No, this session just started, on a clean `main`"**, then ran `git status`,
`git worktree list` and `gh pr list`, trying to reverse-engineer which review it sat beside.

## 2. What the defect actually is — and what it is not

The session was not harmed by _lacking_ context. It was harmed by **guessing from `git
status`**, and being right about the folder while being wrong about the review.

U1 shipped deliberate blindness and the PRD defends it well: the interlocutor is a stranger,
and a stranger who must ask _"what am I looking at?"_ forces the operator to articulate the
question — the most valuable act in a review. **That decision is not the bug and is not being
reversed here.**

Blindness only works if the session _knows_ it is blind. T246 removed that: reviewing a PR no
longer costs a working tree, so the folder's `HEAD` and the diff on screen became unrelated,
and the session's cheapest instinct now returns a confident, correct, irrelevant answer. It
does not know to ask, because nothing looks unknown.

**So the repair is a negative fact, not a body of knowledge.** Tell the session what it cannot
learn from where it stands, and how to read what is actually on screen. Nothing else.

## 3. Why a briefing is the wrong shape — the three findings that killed it

**It is a push, into the one seam that was justified as pull.** The PRD admitted the companion
past D4 on exactly one sentence: _"a conversation is pulled — the operator asks, reads, and
decides. Nothing appears that they did not request"_, with the corollary _"no auto-summary on
open. A session that greets the operator with 'I reviewed this, it looks fine' is the findings
lane wearing a costume."_ Boot-time evaluation content is definitionally unrequested.

**`prePrompt` is a first USER turn, not passive context.** The companion would boot and
generate an unrequested response before the operator says a word — the auto-summary the PRD
names — and that reply becomes the second item in the context window, so every later question
is answered against the model's own unprompted first impression. It also makes Capy a
ventriloquist: a positional lands as a user turn, so the model cannot distinguish Capy's words
from the operator's. The fresh-session decision exists because _"a session with a position
defends it"_; `prePrompt` manufactures a position before the review begins.

**Evaluation content is triage substrate.** CI state, PR state, commit counts and a ranked,
truncated file list are precisely the inputs of a "which files matter" verdict — a feature
nobody has approved (§7). Shipping them as a side effect of a context fix decides that
question by accident, and costs the roadmap its evidence: Tier 1's rationale was to live with
an unprimed companion for a few real reviews and let that shape Tier 2.

## 4. The corrective

### 4.1 Content — orientation, never evaluation

Two facts and one pointer. This is the complete payload:

1. The cwd's own `HEAD` is **unrelated** to the diff under review; `git status`, `git branch`
   and `git log` in this directory describe something else.
2. What the operator is looking at is exactly `git diff <baseSha>...<headSha>`.
3. This session is **read-only** (`Edit`, `Write`, `NotebookEdit` are denied; `Bash` is not).

Plus, only when there is one, the PR number — an identifier, not a judgement.

**Explicitly excluded, and this list is normative:** CI state, PR/review state, commit counts,
file counts, the changed-file list in any order, `+`/`−` counts, the diff body, the card's
intent, anything derived from `evidence`. If a future change wants any of them, it supersedes
this document rather than extending it.

### 4.2 Identity — SHAs, never a ref name

`refs/capy/pr/<n>` is **mutable**: refresh force-overwrites the same ref name
(`review-head.ts:150`). A corrective naming the ref keeps _succeeding_ against different
content after any refresh — a stale command that errors makes a session ask; a stale command
that works makes it guess, which is the defect one layer up.

Base and head **commit SHAs** make the corrective self-verifying and immutable. Neither is on
the snapshot today: `HeadInfo` carries `ref`/`freshness`/`fetchedAt` and no SHA, and
`resolvePrHead` derives `localOid` purely for `freshness` and drops it. **T244 AC-6 already
requires pinning a head SHA into the snapshot** — this unit either lands that plumbing or
depends on it, and must say which. It must not duplicate it.

### 4.3 Channel — `appendSystemPrompt`, with the disclosure in the UI

`appendSystemPrompt` delivers no user turn, and `composeAppendSystemPrompt` already composes
after the Capy preamble without discarding the user's value.

The auditability the rejected spec traded away is recovered **in the pane header** — a
collapsible _"what this session was told"_ disclosure rendering the exact composed string. The
channel and the disclosure surface do not have to be the same surface; treating them as one
was the false binary in the rejected document.

### 4.4 The states the corrective must survive

Each is a real branch, each currently unhandled, each verified in-tree:

| State               | Why it breaks a naive implementation                                                                                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `snapshot === null` | The button has no `:disabled`; `load` nulls the snapshot on every non-silent load and on any IPC throw. Nothing to build from — **this reships the original defect verbatim**.      |
| `error !== null`    | Same shape, same gap.                                                                                                                                                               |
| `isRepo: false`     | `emptySnapshot` reports `head.state: 'ready'` with `ref: ''`. A guard on `state !== 'ready'` walks past it and emits `git diff main...` — a well-formed command with an empty head. |
| `not-fetched`       | **The DEFAULT on open** — fetch runs only on the refresh gesture. The rejected spec's premise that "the ref is already local" is false exactly when the feature is most used.       |
| `fetch-failed`      | Distinct from the above and correctly modelled upstream.                                                                                                                            |
| `base-unresolved`   | Base branch deleted; `base` is the unresolved name, deliberately. Head resolves, base does not — the session cannot tell which half failed.                                         |
| detached `HEAD`     | `head.name` is a short SHA. Do not present it as a branch name.                                                                                                                     |
| truncated snapshot  | `omittedFiles` drops whole files; `totalRows` is a _row_ count. Since §4.1 excludes the file list, the corrective must not imply completeness either.                               |

**The rule for every unreadable state: say the state, name no ref.** A corrective that names an
unresolvable ref sends the session back to guessing, which is the thing being fixed.

### 4.5 Where the session is standing

The companion spawns in `ui.review.folderPath` (the folder the operator _requested_), while a
PR review re-resolves to the repo's **main worktree** — the two differ. The refs resolve from
either (shared common dir), so nothing errors; only a _sentence_ about location can be wrong.
**Therefore the corrective states no location at all.** It says what the cwd's HEAD is _not_.

Related: `reviewFolderPath` is read by **zero logic** in `src/` (grep-confirmed) and its doc
claim that it distinguishes companions is false — the state is unreachable, `ui.review` being a
single object. Delete the field or make it load-bearing; do not let the spec repeat its claim.

### 4.6 Argv exposure

`appendSystemPrompt` is argv, and **BUG-84 (open, backlog)** establishes `/proc/<pid>/cmdline`
is world-readable to every local process. T244's spec chose stdin over argv for exactly this.
The corrective is short and carries no diff content, which bounds the exposure to a branch
name, two SHAs and a PR number — state the exposure and its bound explicitly rather than
leaving it undiscovered, and do not let the payload grow without revisiting it.

There is **no paste fallback on the helper-pane path** (`AGENT_PREPROMPT_ARGV_MAX_CHARS` is a
main-pane concern). Over the threshold there is no graceful degrade, there is `ARG_MAX` — which
§4.1's fixed-size payload makes unreachable by construction. That is a reason to keep it fixed.

## 5. Acceptance criteria

Numbering starts at **AC-20** deliberately: U1's `AC-4` is a live, merged, test-pinned
criterion and reusing low numbers is how a guard gets deleted by someone who thinks they
satisfied it.

- **AC-20** — A companion opened on a folder whose `HEAD` differs from the reviewed head is
  told, before its first turn, that the cwd's `HEAD` is unrelated to the diff, and is given
  `git diff <baseSha>...<headSha>`. — verify: test
- **AC-21** — The corrective is delivered via `appendSystemPrompt`. **No `prePrompt`, no
  `ptyWrite`, no synthesized user turn** — the session still never speaks first. — verify: test
- **AC-22** — **Content neutrality, tested to T243 AC-8's standard**: across every combination
  of snapshot data, the composed string contains no CI state, PR/review state, commit count,
  file count, file list, `±` counts, or diff body. A structural test over a fixture matrix, not
  a grep over a template. — verify: test
- **AC-23** — Identity is base and head **SHAs**. A test asserts no bare `refs/capy/pr/<n>`
  reaches the corrective. — verify: test
- **AC-24** — Every state in §4.4 produces a corrective that names its state and names **no
  unresolvable ref**; `snapshot === null` and `error !== null` produce **no companion at all**
  (see AC-27). — verify: test
- **AC-25** — The operator's own `prePrompt`/`appendSystemPrompt` is neither imported into nor
  merged with the corrective. **Accumulation is a hazard here, not a feature**: a folder prompt
  ("always run the tests and fix what fails") must not become a read-only stranger's opening
  instruction. State the precedence and delimit the authors. — verify: test
- **AC-26** — The pane header renders a collapsible _"what this session was told"_ disclosure
  containing the exact composed string. — verify: test + visual
- **AC-27** — The companion button is `:disabled` while `snapshot === null` or `error !== null`,
  with a reason on hover. — verify: test
- **AC-28** — A second activation **reveals the running companion** instead of silently doing
  nothing, and there is a specified way to obtain a _fresh_ corrective without destroying the
  conversation. — verify: test + visual
- **AC-29** — On **promotion**, the corrective does not survive into the promoted session
  describing a read-only posture it no longer has and a review that was just closed. — verify: test
- **AC-30** — The persisted transcript is not labelled with the corrective's first line in the
  sidebar. — verify: test
- **AC-31** — The corrective is **model-facing prose, not UI copy**: it does **not** go through
  `$t()` and does not vary by locale. The header disclosure's _label_ is UI copy and does. —
  verify: test
- **AC-32** — **Outcome criterion.** Open a companion on a folder whose `HEAD` differs from the
  reviewed head; ask _"what am I reviewing?"_; the answer names the PR/head and does not cite
  `git status`. — verify: **manual, recorded**. Without this, every gate is green and the
  feature still does not work.
- **AC-33** — `review-pane-contract.test.ts` extended and re-pinned, never loosened.
- **AC-34** — `CHANGELOG.md` + `docs/user/review-pane.md`. `typecheck`, `lint`,
  `test:coverage`, `build`, `prettier --check` green.

## 6. The operator signature this unit is blocked on

U1 merged **PRD AC-4 — "Capy never sends an initial message"**, pinned by two tests:

- `tests/review-companion.test.ts:370` — the pane carries exactly six keys; the factory body
  contains no `prePrompt`/`ptyWrite`/`pendingAgentPrompts`/`bootOverride`; and `openCompanion`
  matches no `/prePrompt|ptyWrite|snapshot|evidence/`.
- `tests/review-companion-lifecycle.test.ts:158` — `spawn.bootOverride` undefined, `ptyWrite`
  never called.

**This unit cannot land without amending both.** The amendment is narrow and must be written as
such: _Capy may deliver a fixed, evaluation-free orientation string via `appendSystemPrompt`;
it still never sends a user turn, never calls `ptyWrite`, and never composes from `evidence`._
The `openCompanion` guard against `snapshot` softens to permit `base`/`head` SHAs and must
**keep** forbidding `evidence`.

Amending a merged AC is the operator's call, not an executor's and not mine. **Do not dispatch
this unit until that amendment is signed.**

## 7. Explicitly out of scope, and why it is named here

**Claude-authored triage of "which files matter" is not specified by this document and must not
arrive through it.** Both product reviews independently found it to be the pushed form of the
thing this epic fights: it is a verdict, the highest-leverage one in a review, because it
decides what gets read at all. It is a separate card and a separate operator decision.

**Guided review** (a per-file, operator-initiated "ask me about this file") is endorsed by both
reviews as the strongest anti-theatre mechanism raised so far — _recognition is fakeable,
production is not_ — and is Tier 2 work. It is pulled and scoped, which is why it survives the
same test triage fails. It does not need this unit's corrective and must not be folded into it.
