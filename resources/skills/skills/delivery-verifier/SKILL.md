---
name: delivery-verifier
description: Verify that a finished unit satisfies its acceptance criteria one at a time, from evidence rather than the executor's own report, with a rubric per deliverable kind (code, UI, research, decision), record the verdict on the Mission step with mission_verify_step, then produce the Delivery Report. Use at the end of a dispatched unit or a whole fan-out wave — "check whether it really delivered", "go through the acceptance criteria", "which ACs do I still have to test by hand", "write the delivery report" — or whenever an orchestration reaches the point where PRs exist and someone has to prove the feature is done. Do NOT use to review code quality (that is a code review) or to decide whether to merge.
---

# Delivery verifier

Two jobs, in this order:

1. **Grade** every acceptance criterion of a unit against real evidence — blind to
   what the executor said about itself.
2. **Report** the result as a human handoff: what is proven, what a person must open
   the app and check, what is unmet, what is blocked.

## The one rule everything else serves

**Done is a property of the environment, not of the transcript.** An agent's "done"
is wrong most of the time when the only check is its own claim, and almost never
wrong when an independent control compares the claim against the environment. So:
never read the executor's summary before grading. Read the diff, the test output,
the CI conclusion, the screenshots. If the only evidence you can find is somebody
saying "done", the verdict is `unmet`, not `met`.

## Pick the rubric — by what the unit delivers

A merged PR, a rendered screen, a research memo and a decision record are proven
by different evidence, so each kind has its own rubric below — its own packet, its
own deterministic checks, its own reasons for `unmet`. Pick it from the kind the
work declared: the mission's `declaredEnd.kind` for the fixed end (`mission_get`),
the unit's card (`kind`, its ACs' `verify:` modes) for a middle step. A unit that
mixes kinds — code that also renders a screen — is graded under each rubric that
applies, AC by AC.

| kind       | rubric            | proven by                                                              |
| ---------- | ----------------- | ---------------------------------------------------------------------- |
| `code`     | Rubric — code     | commits, a PR on the right base, green gates, tests that ran           |
| `ui`       | Rubric — UI       | a capture of the rendered state, compared against the design           |
| `research` | Rubric — research | an artifact that answers each declared question, with sources          |
| `decision` | Rubric — decision | a decision record: the question, the options, the choice, the why, who |

`other` has no rubric of its own: name the rubric whose evidence the artifact
actually is and use it; when none fits, the verdict is `needs-human`, never a
`met` argued from prose.

## Inputs — the blind packet

Assemble these BEFORE grading, and grade from these only (each rubric below says
which of them it needs, and what it adds):

- the unit's **AC list** (from the board card, the spec, or the tracker ticket);
- the **diff** against the unit's base branch (`git diff <base>...<head>`), plus the
  file list;
- **test/gate output** — the actual run, fresh, not a claim of a run;
- **CI conclusion** for the PR, if one exists
  (`gh pr view <n> --json statusCheckRollup,mergeable,reviewDecision`);
- **screenshots / visual artifacts** for anything design-shaped, plus the design
  node when one is linked.

Explicitly NOT in the packet: the executor's report, its commit messages' prose, its
PR description, its self-assessment. They bias the verdict — judges flip on
presentation cues, and confident closing language is exactly what fools them. Read
them afterwards, if at all, only to write the summary.

## Step 1 — Deterministic checks first

Free, and they catch the dumb failures. Run these before any judgement; each is
pass/fail with no interpretation. The table is the **code** rubric's; the other
three rubrics below carry their own.

| Check                         | Command                                                | Failure means                                                    |
| ----------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------- |
| Commits exist                 | `git rev-list --count <base>..<head>`                  | the unit delivered nothing — stop here, everything is `unmet`    |
| Nothing uncommitted           | `git status --porcelain` in the worktree               | work exists but is not on the branch                             |
| Right base                    | `gh pr view <n> --json baseRefName`                    | the PR targets the wrong branch                                  |
| Gates green                   | the repo's own gate command                            | broken build or tests                                            |
| Tests ran after the last edit | test-run timestamp vs. last commit time                | a "lucky pass": passing output from before the final change      |
| Scope respected               | diff file list vs. the unit's scope boundary           | scope creep — the most common reason a grader rejects agent work |
| Acceptance tests untouched    | did the diff edit the tests encoding the ACs?          | the contract was edited to fit the code                          |
| Visual ACs have a capture     | a screenshot exists for every AC about rendered output | nobody ever opened the page                                      |

A failure here is a **finding on the unit**, reported regardless of how the ACs
grade.

## Step 2 — Grade one AC per call

Spawn one verifier subagent per AC, or handle them one at a time — never batch
several ACs into a single judgement, which measurably costs accuracy. Each gets the
minimal prompt below. Do not add "explain your reasoning and propose a fix";
elaborate grader prompts increase misclassification.

```
Acceptance criterion: <verbatim text>
Source: <spec §, design node, ticket id>

Evidence available:
- diff: <path or inline hunks>
- test output: <path or inline>
- CI: <conclusion>
- screenshots: <paths>

Decide ONE verdict:
  met         — the evidence proves it. Cite the exact evidence (file:line, test name, sha, screenshot).
  unmet       — the evidence contradicts it, or nothing in the evidence supports it. Say what is missing.
  blocked     — it cannot be decided until a question is answered. State the question.
  needs-human — it is real but not machine-verifiable (visual fidelity, copy, a third-party
                account, a device, a subjective flow). Say exactly what a person must do.

Do not guess. "needs-human" and "unmet" are correct answers; a fabricated "met" is not.
```

**`needs-human` is a feature, not a cop-out.** It is what becomes the manual-test
checklist — the thing a person actually opens the app to confirm. Forcing a binary
here is how a delivery report starts lying.

**A visual AC with no capture is never `met`.** If an AC describes something a
person would see — a page renders, a component matches its design, copy appears, a
state is visible — and the packet holds no screenshot of it, the verdict is `unmet`
("nobody looked"), never `met` on a code-reading argument. It is not `needs-human`
either: that verdict is for what a machine genuinely cannot judge, not for what
nobody bothered to capture. Get the capture yourself first if you can — open the
route with the browser tools and look. The one exception is a session with no
browser tools at all: that is `needs-human`, per the UI rubric below.

## The rubrics

Each rubric is the packet, the checks and the verdict rules for one kind. Grade
every AC under the rubric of the kind it proves — one AC per call, whatever the
rubric.

### Rubric — code

- **Packet:** the diff against the unit's base (`git diff <base>...<head>`), the
  file list, fresh gate/test output, the PR's CI
  (`gh pr view <n> --json statusCheckRollup,mergeable,reviewDecision`).
- **Checks:** the Step 1 table, all of it — commits exist, nothing uncommitted,
  right base, gates green, tests ran after the last edit, scope respected,
  acceptance tests untouched.
- **`met`** cites a test name, a `file:line`, a sha or a CI run that proves the
  behavior. **`unmet`** when the only support is code that looks right: a claim
  about behavior with no test or run behind it is not evidence.

### Rubric — UI

- **Packet:** a capture of every rendered state an AC names (screenshot, or the
  page's text via the browser tools), the design node or mockup it must match, and
  the route or component that renders it. Code evidence from the code rubric is
  supporting, never sufficient.
- **Checks:** a capture exists for every visual AC, and it was taken after the
  last commit that touched the rendering. **Detect your browser tools before
  grading:** the Chrome/Playwright tools come from the operator's own MCP
  configuration, not from Harnu, and another operator may have none. With none
  available and no capture in the packet, every visual AC is `needs-human`
  ("open `<route>` and compare against `<design>`") — never a silent `met`, and
  never `unmet` for a capture you had no way to take.
- **`met`** only when the capture shows the state and it matches the design on
  the named points. A visual AC with tools available but no capture is `unmet`
  ("nobody looked") — get the capture yourself first. Fidelity a machine cannot
  judge (copy tone, "feels right", a device you cannot reach) is `needs-human`.

### Rubric — research

- **Packet:** the research artifact (report, memo, study) at its committed path,
  and the list of questions it was asked to answer — from the card, the mission's
  declared end, or the spec. No declared questions → `blocked`: a research unit
  cannot be graded against questions nobody wrote down.
- **Checks:** the artifact exists where the step's links say; every claim that an
  answer rests on carries a source (a link, a file and line, a measured run, a
  named document); every source that is a link or a path resolves.
- **Grade one declared question per call:** `met` when the artifact answers that
  question directly and the answer rests on cited sources; `unmet` when it is not
  answered, answered only in generalities, or answered without a source;
  `needs-human` when the answer exists but judging whether it is right needs
  domain knowledge or access the verifier lacks.

### Rubric — decision

- **Packet:** the decision record (an ADR, a decisions-page entry, a spec section)
  and the question the decision had to settle.
- **Checks:** the record exists at its linked path and states, each in its own
  words: the question; the options that were actually considered (at least two,
  or an explicit reason there was only one); the choice; the rationale, tied to
  the options; the consequences or the conditions for revisiting it; and who made
  it, with the date.
- **Grade one declared question per call.** `met` when the record settles that
  question with a traceable rationale; `unmet` when a required part is missing
  or the rationale does not engage the rejected options. A decision that is the
  **operator's** to make (scope, cost, product direction) is `met` only when the
  record shows the operator made it — an agent recording its own preference as
  decided is `needs-human` ("the operator has to confirm this choice").

## Step 3 — Record on the card and on the mission step

Write the per-AC table to the board card (`update_card` with `appendBody`). Every
row carries its evidence reference, and every verdict carries who produced it:

| AC                                | Verdict     | Evidence                                             | By       |
| --------------------------------- | ----------- | ---------------------------------------------------- | -------- |
| AC-1 Post list paginates 10/page  | met         | `tests/blog/pagination.spec.ts::paginates` · ci#1234 | verifier |
| AC-4 Hero respects design spacing | needs-human | design node · screenshot `assets/AC-4.png`           | verifier |
| AC-3 Draft visibility             | blocked     | Q-2 unanswered                                       | verifier |

An executor's own tick is recorded as `by: executor` and **never counted** in the
report totals. Self-verification does not catch the failures that matter.

**When the unit is a Mission step, record the step's verdict on it:**
`mission_verify_step({ folder, missionId, stepId, verdict, evidence, sessionId:
<your own session id>, checkLabel? })`. The step's verdict follows from its ACs: any `unmet` →
`unmet`; else any `blocked` → `blocked`; else any `needs-human` → `needs-human`;
only all-`met` → `met`. `evidence` is the table's one-line summary plus the report
path.

**`needs-human` creates a check on the step — name it with `checkLabel`.** The
verdict means the machine part is met and a person still has to confirm the rest.
Pass `checkLabel` with what they must confirm, short and concrete ("Hero matches
the design spacing", "Validated visually on a phone"); without it Harnu uses the
first line of `evidence`, which is rarely a good label. Then the step reads `done`
in progress, and the check lands on the operator's `you` list until they tick it
in the app — no verb ticks a check, and you never tick one. A later `met` on the
same step leaves the check open: the human part is still owed. Several
`needs-human` ACs on one step → one `mission_verify_step` with the first one's
`checkLabel`, then `mission_add_check` for each of the others (a label already on
the step is deduped). The same checks go on the report's "Check by hand" list.

**You must not be the step's author.** The verb never refuses — it labels: a
`met` becomes `verified` only when the step already links at least one `session`
and your declared id differs from every one of them; otherwise it lands
`self-verified`, which the operator never sees as proven. So link the executor's
session to the step first (`mission_link_child`), and if your own session wrote
the work, do not record it — hand it to an independent verifier session. Pass your
real session id (the UUID your scratchpad path ends in); the id is taken on your
word, so a borrowed one is a lie the audit log keeps. Only a `verifier`-level step
takes this verb: an `existence` step is proven by Harnu itself and a `human` step
only by the operator (`WRONG_VERIFICATION_LEVEL`).

**The fixed end (`Delivered and verified`) is the orchestrator's to verify**, after
the per-unit verdicts are in: its builders are every session linked to any step,
so the orchestrator — a session that built no step — lands `verified` with its own
id once each unit's child session is linked to its step and the end's evidence
exists. Then `mission_get`'s `closeReadiness` tells whether the close will land
(`null`), or names what is in the way before anyone calls `mission_request_close`.
When you run as a verifier subagent inside the orchestrator, you hand it the
verdicts; the orchestrator records the end.

## Step 4 — The Delivery Report

One report per wave, one per feature. Generate it from the cards and the evidence —
never from memory or from what the sessions said. Write it to
`.harnu/out/delivery-<feature>-<wave>.md` (or the repo's docs dir if it is a keeper),
hand it over with `open_file`, and paste it into the integration PR's body.

**Mandatory header.** The `status` skill's six-line glance card goes above
"Where we are", built from the same evidence this report uses (the cards, the
PRs, `mission_get`). See `status` for the card's exact shape and rules; this
skill does not restate them.

```markdown
# Delivery report — <feature> · wave N of M · <date>

## Where we are

Planned: X units in M waves. Done: Y. In flight: Z. Blocked: W (naming what blocks each).
Integration branch feat/<epic> @ <sha>, rebased on main @ <sha>, full suite <green|red> (<ci ref>).
<One sentence: are we on plan, and what is the next step.>

## Units

| card | PR | CI | ACs met | needs-human | unmet | blocked |

## ✅ Verified — no action needed

<ACs proven by machine evidence. Listed so nobody re-tests them.>

## 👀 Check by hand (manual verification)

- [ ] <unit> · <AC> · <what to open and what to look for> · <design link>

## ❌ Unmet — sent back

- <unit> · <AC> · <the verifier's exact finding> · <who it went back to>

## ❓ Open questions

- <Q-n> → blocks <AC> · asked <date>, unanswered

## 🧾 Tech debt raised

- <unit>: <what> · <follow-up card, if one was created>

## Tracker

- <TICKET>: <n>/<m> ACs ticked · comment with PR <url> posted
- <TICKET>: <n>/<m> ticked; <k> left unticked (<why — unmet / manual>)
```

The chat message stays a short checklist plus the report's path. The document is the
durable handoff.

## Step 5 — Tracker projection

The card is the source of truth; a connected tracker is a projection — but a
mandatory one when it exists, because that is the surface the rest of the team
reads. Using the tracker's own tools:

- tick the ACs whose verdict is `met` **by the verifier or a human** — never
  `needs-human`, never `by: executor`;
- post one comment per ticket with the PR link and the three buckets (verified /
  check-by-hand / unmet);
- leave the ticket's own status alone unless the operator asked for it.

Then say plainly, per ticket: these N are ticked and done; these K you have to
confirm yourself; these J are not done, and here is why.

## Send-back loop

`unmet` goes back to the **same executor** with the verifier's exact finding as a
delta — not a redo from scratch, not a new session. `blocked` surfaces the question
to the operator next to the AC it blocks. Re-verify only the ACs that changed. Stop
condition: an AC that comes back `unmet` twice becomes an operator decision, not a
third attempt — retry-until-green is how agents learn to game the check.

## Boundaries

- Never move a card to `done` — Review→Done is the operator's Close. Your job is to
  make that click a decision instead of a discovery.
- Never merge, never edit product code to make an AC pass. Finding it broken IS the
  deliverable.
- Never invent evidence. "No evidence found" is a verdict; a plausible-sounding
  citation that does not exist is the worst possible output of this skill.
