# Review companion session — a stranger reading the diff beside you

**Status:** PRD v1 (2026-08-27, decisions settled 2026-08-28) — **Tier 1 ready to dispatch** · visual contract `docs/specs/2026-08-25-t164-review-pane/spec.html` root `review-pane--with-session` — **APPROVED 2026-08-25, frozen** · **Card:** `T245-t164-v1-1-a-claude-session-beside-the-review-talking-about-the` · **Deps:** the T164 review pane, **merged into `main` on 2026-08-28** as `#251`. Its ~1000px collapse breakpoint (card `T235` AC-8) is in `ReviewPane.vue:153` / `stores/review.ts:40`. Also: T80 (`showHelperStack` precedent), T212 (`showFolder` added to the same condition)
**Base:** `docs/prds/T164-review-pane.md` §9 Q4 (the question this PRD answers) · `docs/research/2026-08-25-code-review-in-the-agent-era.md` §5

---

## 0. Premise — what this protects

The review pane made the evidence legible. It did not make the code
**understandable**, and those are different problems. An operator reading a
2,900-line diff written by an agent at 3am does not primarily need better
syntax colours; they need to ask "what breaks if this ships" and get an answer
without leaving the diff, without rebuilding the context in a second window,
and without asking the entity that wrote the code to grade itself.

This is the second half of the review loop. The pane answers _what changed_.
This answers _what it means_.

## 1. The decision that shapes everything: the interlocutor is a stranger

**Always a fresh session. Never the session that wrote the branch.** Settled by
the operator on 2026-08-27, for two reasons of very different weight:

1. **Empirical.** A session reviewing code it wrote finds fewer bugs. It has a
   position to defend and a narrative to preserve. This is the model-shaped
   version of the same reason humans do not review their own PRs.
2. **Structural, and this one removes the choice entirely.** Reviewing another
   developer's PR is a first-class case. There, an author session **does not
   exist**. Supporting both interlocutors would mean maintaining two paths, one
   of which is unavailable exactly when the feature matters most.

So there is no "resume the author session" affordance, no picker, no fallback.
**Do not build the choice.** A fresh session is not the default — it is the only
behaviour.

Design consequence: the session receives the diff and the card's intent as
**material to read**, never as "here is what the author says it does, confirm
it". Framing the prompt as verification of someone's claim recreates exactly
the bias the fresh session exists to avoid.

## 2. What this must never become

The review pane's premise is **R1 — agents report, humans conclude** (PRD §3.2).
A conversational session is compatible with R1 for a reason worth stating
precisely, because it is a narrow line:

- **D4 excluded the agent-findings lane** because it _pushes_ unrequested model
  claims into the evidence surface. A push turns a model's guess into something
  that looks like a receipt.
- **A conversation is pulled.** The operator asks, reads, and decides. Nothing
  appears that they did not request.

Therefore the binding rule: **nothing the session says may render as evidence.**
Not a badge, not a status dot, not a line in the evidence header, not a summary
above the diff. It stays visibly a conversation. If a model's opinion can be
mistaken at a glance for a receipt, this feature has failed regardless of how
useful the answers are.

Corollary: **no auto-summary on open.** A session that greets the operator with
"I reviewed this, it looks fine" is the findings lane wearing a costume.

## 2.1 Two holes in the R1 argument that the rules above do not close

Adversarial review (2026-08-27) found the "pulled, not pushed" reasoning sound
**only for the pane's own surfaces**. Two paths get around it, and both must be
decided rather than left implicit.

### The operator is a copy-paste bridge

Nothing stops the operator asking the companion session "does this look right?"
and pasting the answer into T164's Bounce note (AC7) or, far more
consequentially, into T244's review body — which is submitted under their own
GitHub identity and is by design indistinguishable from words they typed
themselves. That is the model's opinion acquiring a human's signature, which is
precisely the outcome R1 exists to prevent, laundered through a keystroke instead
of a badge.

**Position: accepted as inherent, and named rather than fought.** Friction on
copy-paste is unenforceable and treats the operator as the threat. But T244's
confirm step must name it in one line, because the moment of submission is the
only place where saying it changes anything. Once text crosses into a Bounce note
or a review body it carries **no different status from the operator's own
words** — they own it. Say so out loud rather than letting the architecture imply
a separation that does not exist.

### The companion session can rewrite what is being reviewed

This is the sharper one, and it was missing from every earlier draft. A
`claude-new` session is an **ordinary Claude Code agent with Edit and Bash access
to the live worktree whose diff the operator is reading** — the same working tree,
the same index and HEAD that other sessions in that worktree share (a hazard this
repo has already been burned by). "Fix that for me" mid-review mutates the code
under the diff, silently invalidating the snapshot, and — one hop removed — puts
an agent's hands on what is about to be approved.

**DECIDED 2026-08-28 by the operator: the companion session is read-only (plan
mode), with an explicit "promote to a working session" escape hatch.**

The reasoning, because an executor will be tempted to relax this: the session's
role is **reviewer**. A reviewer that edits _is the author_, which collapses the
exact separation the fresh-session decision was made to build. Spending that
decision and then letting the session become the author through a "fix that for
me" would be self-defeating.

Never-edit would be wrong too — you will find bugs and want them fixed. So the
transition exists, but as a **visible gesture that ends the review context**,
never as a silent capability. Promoting is allowed; drifting into it is not.

Note what read-only is and is not protecting. The _approval_ risk is already
covered by T244's head-SHA pin, which refuses a submit when the tree has moved.
What this protects is the operator's **reading**: never being unsure whether the
diff on screen still matches what is on disk.

A detached copy was considered and rejected — it would break the reasons the
session is useful at all (running the tests, grepping how a symbol is used
elsewhere) and would confuse anyone whose fix silently failed to appear.

## 3. Two tiers, priced separately

The card was originally scoped as one build. Reading the code says otherwise.

### Tier 1 — a session beside the review

**Revised 2026-08-27 after adversarial review. An earlier draft of this PRD
called Tier 1 "nearly free". That was wrong, and the correction matters because
it was about to set the roadmap order.**

One part of the claim survives. `App.vue:320` gates the helper stack on
`showHelper && (showRoadmap || showTerminal || showFolder)`, and the review
takeover is genuinely absent from that OR list. Adding `showReview` is one term,
with two precedents — `showRoadmap` (T80) and `showFolder` (T212).

The part that does not survive is "a fresh session". **There is no way to express
one in the helper-pane model today:**

- `pane-registry.ts:17` — `HelperPtyKind = 'shell' | 'claude-resume' |
'claude-fork' | 'teammate'`. There is **no `'claude-new'`**. Main's own
  `PtyKind` has one, and `spawn-spec.ts:11` uses it for main-pane sessions, but
  it was never threaded through to helper panes.
- `stores/helpers.ts` offers `addShellHelper`, `addResumeHelper` (needs an
  existing `sessionId`), `addForkHelper` (needs a `sourceSessionId`),
  `addTeammateHelper`, and the non-PTY ones. **There is no factory for a bare
  fresh session.**
- The obvious shortcut — copy the `claude-fork-pending` → `claude` resolution
  pattern — is a trap. That resolved type is `persistable: true`, so a review
  companion built that way would be written into `helpers.json` and **reopen on
  every future app boot**: a permanent tab, which is the exact opposite of a
  session scoped to one review.

The right precedent is **`teammate`** (`pane-registry.ts:67`), which is
`persistable: false`. Model the new pane type on that.

Real Tier 1 scope: a new pane type + registry entry (non-persistable), extending
`HelperPtyKind` with `'claude-new'`, threading it through `HelperPane.vue`'s
`paneKindToPtyKind`, a new store factory, and the UI that suppresses the
resume/fork affordances (AC-2). A small multi-file feature — not one term, and
not an afternoon.

It is still the right thing to build first, and still much smaller than Tier 2.
The reordering argument stands; only the price was wrong.

### Tier 2 — the selection is the subject

Selecting lines in the diff and asking about _those lines_. This is the real
build: a selection model over the rendered diff, carrying the selection into the
session's prompt, and deciding how much surrounding context travels with it.

`addPullRequestReviewThread`'s input shape — `path`, `line`, `side`,
`startLine`, `startSide` — is a good model for what a selection must capture,
**even before anything is ever posted anywhere**. Adopting it early costs
nothing and makes T244 cheap later.

**Tier 1 does not block on Tier 2, and shipping Tier 1 first is deliberate:**
using a session beside the diff for a few days is what tells us how selection
should feel. Designing Tier 2 before anyone has held a conversation next to a
diff is guessing with extra steps.

## 4. Open questions

- **Q1 — how much context travels with a Tier 2 question?** The selection alone
  is too little (a hunk without its function signature is unanswerable); the
  whole diff is too much (answers get vaguer as context grows). Candidate: the
  selection, plus its enclosing hunk, plus the file path and the base/head refs.
  Needs a real trial before it is fixed.
- **Q2 — RESOLVED 2026-08-27: dispose on takeover-close.** An earlier draft said
  "disposed with the takeover, on the same non-destructive detach model
  `TerminalPane` already uses" — those are **opposite behaviours** in this
  codebase, and `HelperPane`'s detach/dispose split is load-bearing: detach keeps
  the PTY alive in the background, dispose kills it. Worse, the close path does
  not do either today: `ui.closeReview` / `closeAllTakeovers` never touch
  `helpers`/`liveHelpers`, and `showHelperStack` stays true across a
  review → terminal transition whenever `showTerminal` is also true for that
  worktree — the common case. So a companion pane left alone would simply keep
  running as an ordinary helper tab, neither disposed nor scoped to the review.
  **Decision: dispose on takeover-close, like `teammate` panes.** AC-6 is written
  against that lifecycle.

- **Q3 — does the card's intent go into the prompt automatically?** It is the
  most useful single piece of context and the most biasing. Leaning: available
  on request, not injected.

## 5. Acceptance criteria — Tier 1

- **AC-1** — With the review takeover open, the helper stack renders; the
  review pane joins the `showHelperStack` OR list. — verify: manual
- **AC-2** — Opening a Claude pane from the review takeover spawns a **fresh**
  session. It never resumes, forks, or attaches to the session that produced the
  branch, and there is no affordance offering to. — verify: test
- **AC-2b** — The companion session starts **read-only (plan mode)** and cannot
  write to the worktree. Leaving read-only requires the explicit "promote to a
  working session" gesture, which ends the review context; there is no path that
  grants write access without it. — verify: test
- **AC-3** — Nothing the session emits renders inside the review pane. The
  evidence header, the discrepancy strip and the diff are untouched by its
  existence. — verify: test + visual
- **AC-4** — **Capy never sends an initial message.** No summary, verdict or
  synthesized prompt is injected on spawn. (Scoped deliberately to what Capy
  controls: the bundled `claude` CLI's own startup banner is Anthropic's UI and
  is not in scope.) — verify: test
- **AC-5** — Below the ~1000px breakpoint (`ReviewPane.vue:153`) the layout stays usable:
  the intent rail collapses before the session pane squeezes the diff. — verify: visual
- **AC-6** — Closing the review takeover **disposes** the companion pane and its
  PTY. Verify against the real lifecycle, not the aspiration: `ui.closeReview` /
  `closeAllTakeovers` must reach `helpers`/`liveHelpers`, and the pane must not
  survive as an ordinary helper tab when `showHelperStack` stays true because
  `showTerminal` is also true for that worktree. — verify: test
- **AC-7** — Every new string through `$t()`, present in **both** `en.json` and
  `pt-BR.json` in the same change. — verify: test
- **AC-8** — `CHANGELOG.md` entry + `docs/user/review-pane.md` updated to
  describe the companion session. — verify: review
- **AC-9** — `npm run typecheck`, `lint`, `test:coverage`, `build` and
  `prettier --check .` all pass. — verify: test

## 6. Plan

| unit   | scope                                                                                                                                                                                                                         | depends on                                              |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **U1** | New non-persistable pane type + registry entry (model it on `teammate`), `'claude-new'` threaded through `HelperPtyKind` and `paneKindToPtyKind`, a fresh-session store factory, the `showHelperStack` term, dispose-on-close | `#251` (merged)                                         |
| **U2** | i18n, CHANGELOG, `docs/user/review-pane.md`                                                                                                                                                                                   | U1                                                      |
| **U3** | Tier 2 — selection model, prompt carriage, its own mockup                                                                                                                                                                     | U1 shipped **and used for at least a few real reviews** |

U3 is deliberately not specified further here. It gets its own mockup and its
own PRD once Tier 1 has been lived with; the approved `review-pane--with-session`
root covers a session beside the pane, **not** how a line selection looks or how
it becomes a question.
