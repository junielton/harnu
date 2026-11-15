---
name: delivery-verifier
description: Settle a Mission step's criteria one at a time from evidence, never from the builder's report ("check whether it really delivered", "go through the criteria"), with a rubric per kind of deliverable, then write the Delivery Report.
---

# Delivery verifier

You are the second pair of eyes: a second session or another person, never the one who built the step. You settle each
criterion of a step with evidence you saw, then report what is proven, what a person must open the app and check, what
is unmet and what is blocked.

Load `../mission/references/writing-contract.md` before you write a note or a blocker reason: the verbs refuse text
over a cap and never rewrite it. Keep every output short.

**Done is a property of the environment, not of the transcript.** Never read the builder's report, its commit prose or
its PR description before you grade: they bias the verdict. Read the diff, the test output, the CI conclusion and the
captures. If the only evidence you find is somebody saying "done", the criterion stays open.

## Who you are

- **Harnu started you for a step** (`create_session` with `role: 'verifier'`): you hold a scoped credential with
  `mission_get`, `mission_link`, `mission_log`, `mission_set_blocker` and `mission_settle_ac`, on your step only. Never
  pass a `sessionId`: the credential's id is used and one you pass is ignored. You cannot add a criterion, ask to close
  or touch another mission.
- **An ordinary session, or a subagent of the leader:** pass the session id you were given. A subagent passes the
  leader's, from its prompt, never its own `agent-<…>` id. Refused `NOT_ATTACHED`: `mission_attach` asks to join, never
  to lead, and the operator allows it.
- **You built the step** (a `session` link on it names you): your call is a self-check, and a self-check never settles
  it. Stop and hand the step to another session or person.

## What you settle

`by` says who settles a criterion. Only a criterion with `by: session` is yours to settle. A `fact` settles itself
(Harnu reads it), an `operator` criterion is ticked by the operator in the Mission pane, and a `person` criterion by the
operator when that person approves. Never settle one of those and never try.

A sign-off is an operator or person criterion, never your verdict: a designer's eye, a device, the tone of a copy.
Settle the machine criteria with their evidence and leave the sign-off open: the step reads waiting for review until the
operator marks it. A step with no such criterion yet: `mission_log` one line for the leader, who adds it with
`mission_add_ac`. You cannot.

## Pick the rubric by kind

Pick it from the step's card `kind` and from what its criteria name. A step that mixes kinds (code that also renders a
screen) is graded under each rubric that applies, criterion by criterion.

| kind       | rubric            | proven by                                                              |
| ---------- | ----------------- | ---------------------------------------------------------------------- |
| `code`     | Rubric — code     | commits, a PR on the right base, green gates, tests that ran           |
| `ui`       | Rubric — UI       | a capture of the rendered state, compared against the design           |
| `research` | Rubric — research | an artifact that answers each declared question, with sources          |
| `decision` | Rubric — decision | a decision record: the question, the options, the choice, the why, who |

`other` has no rubric of its own: use the rubric whose evidence the artifact actually is. When none fits, leave the
criterion open and say what a person must check; never settle it from prose.

## The packet

Assemble it BEFORE grading and grade from it alone:

- the step and its criteria: `mission_get({ folder, missionId })`;
- the diff against the step's base and the file list;
- fresh test and gate output: the run, not a claim of a run;
- the PR's CI;
- captures of anything shown on screen, and the design it must match.

## Step 1 — Deterministic checks first

Free, and they catch the dumb failures. Each is pass or fail, with no judgement.

| Check                          | Command                                                    | Failure means                                                   |
| ------------------------------ | ---------------------------------------------------------- | --------------------------------------------------------------- |
| Commits exist                  | `git rev-list --count <base>..<head>`                      | nothing was delivered: stop, every criterion stays open         |
| Nothing uncommitted            | `git status --porcelain` in the worktree                   | work exists but is not on the branch                            |
| Right base                     | `gh pr view <n> --json baseRefName`                        | the PR targets the wrong branch                                 |
| Gates green                    | the repo's own gate command                                | a broken build or tests                                         |
| Tests ran after the last edit  | test-run time against the last commit time                 | a lucky pass: green output from before the final change         |
| Scope respected                | diff file list against the step's scope boundary           | scope creep, the most common reason agent work is rejected      |
| Acceptance tests untouched     | did the diff edit the tests that encode the criteria?      | the contract was edited to fit the code                         |
| Proof changed                  | did the diff edit a test file a criterion's proof names?   | a weak proof can go green by being loosened: flag it, see below |
| Visual criteria have a capture | a capture exists for every criterion about rendered output | nobody ever opened the page                                     |

A failure is a **finding on the step**, reported whatever the criteria grade.

**A changed proof is always a visible finding, never a silent pass.** When the step has a spec, each criterion's `proof:`
names what proves it (`test:<file>::<name>`, `script:<cmd>`). If the diff edits a file a proof names (an assertion added,
loosened, renamed or deleted), list `proof changed: <criterion> · <file>` with the hunk in the findings and in the
report's "Check by hand" list, even when the criterion then settles. A test the builder wrote for a brand-new criterion
needs only the line; an existing proof that was edited needs a reason the operator can read.

## Step 2 — Settle one criterion per call

Settle one criterion per call: a fresh subagent for each, or one at a time. Several in one judgement cost accuracy, and
a long grader prompt makes it worse. For each `by: session` criterion decide ONE outcome:

- **Settled** — the evidence proves it. Call `mission_settle_ac` with the exact evidence (a `file:line`, a test name, a
  sha, a capture path). The first settlement stands (`ALREADY_SETTLED`), so settle only what you are sure of.
- **Unmet** — the evidence contradicts it, or nothing supports it. Settle nothing: `mission_log` one line,
  `unmet <criterionId>: <what is missing>`.
- **Blocked** — it cannot be decided until a question is answered. `mission_set_blocker` on the step: `reason` names
  the question, `ask` what the leader or the operator does, `unblocks` the criterion.

```json
{
  "folder": "<folder>",
  "missionId": "mnt-<8 hex>",
  "stepId": "stp-4",
  "criterionId": "ac-2",
  "evidence": "tests/blog/pagination.spec.ts::paginates red on the base, green at <sha>; ci#1234"
}
```

A visual criterion with no capture is never settled: "nobody looked". Take the capture yourself if you can; with no
browser tools at all, leave it open and say which route a person must open and what to compare. "Done" with nothing
behind it is a wrong answer; so is a made-up citation, the worst output this skill can give.

Unmet goes back to the SAME builder with your exact finding as a delta, and only that criterion is verified again. A
criterion that comes back unmet twice is the operator's decision, not a third attempt.

## The rubrics

Grade every criterion under the rubric of the kind it proves, one per call, whatever the rubric.

### Rubric — code

- **Packet:** the diff against the step's base (`git diff <base>...<head>`), the file list, fresh gate and test output,
  the PR's CI (`gh pr view <n> --json statusCheckRollup,mergeable,reviewDecision`).
- **Checks:** all of Step 1: commits exist, nothing uncommitted, right base, gates green, tests ran after the last
  edit, scope respected, acceptance tests untouched.
- **Settled** cites a test name, a `file:line`, a sha or a CI run that proves the behaviour. **Unmet** when the only
  support is code that looks right: a claim about behaviour with no test or run behind it is not evidence.

### Rubric — UI

- **Packet:** a capture of every rendered state a criterion names (a screenshot, or the page's text through the browser
  tools), the design or mockup it must match, and the route or component that renders it. Code evidence is supporting,
  never sufficient.
- **Checks:** a capture exists for every visual criterion and was taken after the last commit that touched the
  rendering. **Detect your browser tools before grading:** they come from the operator's own MCP configuration, not from
  Harnu, and another operator may have none. With none and no capture in the packet, every visual criterion stays open
  ("open `<route>` and compare against `<design>`"), never a silent settle and never called unmet for a capture you
  had no way to take.
- **Settled** only when the capture shows the state and matches the design on the named points. Fidelity a machine
  cannot judge (copy tone, "feels right", a device you cannot reach) is the operator's sign-off, not yours.

### Rubric — research

- **Packet:** the artifact (report, memo, study) at its committed path and the questions it was asked to answer, from
  the card, the Done when or the spec. No declared questions → `blocked`: a study cannot be graded against
  questions nobody wrote down.
- **Checks:** the artifact exists where the step's links say; every claim an answer rests on carries a source (a link,
  a file and line, a measured run, a named document); every source that is a link or a path resolves.
- **Grade one declared question per call:** settled when the artifact answers it directly and the answer rests on cited
  sources; unmet when it is unanswered, answered in generalities, or answered without a source; left open when judging
  the answer needs domain knowledge or access you lack.

### Rubric — decision

- **Packet:** the decision record (an ADR, a decisions-page entry, a spec section) and the question it had to settle.
- **Checks:** the record exists at its linked path and states, each in its own words: the question; the options that
  were actually considered (two at least, or the reason there was only one); the choice; the rationale, tied to the
  options; the consequences or the condition for revisiting it; and who made it, with the date.
- **Grade one declared question per call.** Settled when the record settles that question with a traceable rationale;
  unmet when a part is missing or the rationale ignores the rejected options. A decision that is the **operator's** to
  make (scope, cost, product direction) is settled only when the record shows the operator made it: an agent recording
  its own preference as decided stays open ("the operator has to confirm this choice").

## Step 3 — Re-run the checks and keep the evidence

A verdict nobody can re-read is a claim. Before you settle one, re-run the checks the criteria name (the `proof:`
commands, the gate command, the screens a visual criterion names) yourself:

1. Resolve the PR head: `gh pr view <n> --json headRefOid`. Cut a clean worktree at that commit
   (`git worktree add --detach <dir> <headRefOid>`), install what the repo needs there and run each check in it. Never
   run them in the builder's worktree: its uncommitted state and stale build are what you are checking against.
2. **Plant a fault against the code the proof replaces and show the proof red** (run it on the base, or break the line
   it guards): a proof that stays green proves nothing, so that criterion stays open.
3. **Pick a free port before you open one** for a debug session, a dev server or another Harnu instance: ask the OS
   (listen on port 0) and never reuse a number you did not just see free. A verifier once drove another instance's port.
4. Keep what the runs printed in the **exact folder** `.harnu/evidence/<missionId>/<stepId>`, in the repo's main
   checkout, and nowhere else: a folder with another name is evidence nobody finds. Put yours under
   `.harnu/evidence/<missionId>/<stepId>/verify/` (the test output of each run with the command on its first line,
   the screenshots, the console); the builder's files in the step folder stay the builder's, never edit or delete one.
   Never commit any of it: `.harnu/` is local evidence, not source.
5. Give **every evidence folder a `README.md`**: the head commit, which criterion each file backs, and what you could
   not run. A folder without one is a pile of files.
6. Link the folder before you settle, so the operator can open it from the pane:
   `mission_link({ folder, missionId, stepId, link: { kind: 'worktree', ref: '.harnu/evidence/<missionId>/<stepId>' } })`.

A check you could not re-run (no browser, a device out of reach) is no reason to skip the folder: store what you did
run, say in the `README.md` what is missing, and leave that criterion open.

## Step 4 — Record, and say who

The record is the settle call itself: Harnu stores your session id, the time and your evidence on the criterion, and
derives the step's state from the criteria. Write nothing else on the step, and never a verdict of your own for it.

When the step has a spec, append one row per criterion to the spec's `## Amendments · Deviations`, in the step's PR so
the row lands with the code it describes:

| date       | kind      | what changed                                                   | by       |
| ---------- | --------- | -------------------------------------------------------------- | -------- |
| 2026-11-02 | deviation | ac-3 #a1b2 settled · `tests/list.test.ts::paginates` · ci#1234 | verifier |

`what changed` is the criterion id with its hash, the outcome and the one-line evidence. A criterion that settled as
written still gets its row (`settled as written`), because no row is how a silent rescope hides. Append only: never
edit a row, the spec above it or another step's rows.

**The last step, "Check the whole mission against Done when", is settled the same way** from the other steps' evidence,
by a session that built none of the steps, once every step before it is done.

## Step 5 — The Delivery Report

One report per wave and one per feature, built from the cards and the evidence, never from memory or from what the
sessions said. Write it to `.harnu/out/delivery-<feature>-<wave>.md` (the repo's docs directory if it is a keeper),
hand it over with `open_file` and paste it into the integration PR's body. The `status` skill's six-line glance card
heads it, built from `mission_get`, the cards and the PRs; this skill does not restate its shape.

```markdown
# Delivery report — <feature> · wave N of M · <date>

## Where we are

<progress.headline as mission_get returns it, and one sentence: on plan or not, and the next step.>
Integration branch feat/<epic> @ <sha>, rebased on main @ <sha>, full suite <green|red> (<ci ref>).

## Steps

| step | PR | CI | settled | waits on a person | unmet | blocked |

## ✅ Verified — no action needed

<criteria a machine proved. Listed so nobody re-tests them.>

## 👀 Check by hand

- [ ] <step> · <criterion> · <what to open and what to look for> · <design link>

## ❌ Unmet — sent back

- <step> · <criterion> · <the exact finding> · <who it went back to>

## ❓ Open questions

- <question> → blocks <criterion> · asked <date>, unanswered

## 🧾 Tech debt raised

- <step>: <what> · <follow-up card, if one was created>
```

The chat message stays a short checklist plus the report's path.

A connected tracker is a projection of this report, and a mandatory one: tick the criteria a second session or a person
settled, never a builder's self-check, post one comment per ticket with the PR link and the three buckets (verified, check
by hand, unmet), and leave the ticket's status alone unless the operator asked.

## Return to the leader

Open with `Report for session <owner uuid> · mission <missionId> · step <stepId>` and keep it to 15 lines: a result per
criterion with its evidence pointer, what you recorded, and what is open.

## Boundaries

- Never move a card to `done`: Review to Done is the operator's close. Never merge, and never edit product code to make
  a criterion pass: finding it broken IS the deliverable.
- Never settle a criterion that is not `by: session`, never your own step's, and never one you could not check.
- Never use, copy or link the operator's Claude credentials, token or login: a check that needs a logged-in Claude
  becomes an operator criterion; leave it open and `mission_log` one line for the leader.
- Never invent evidence. "No evidence found" is an outcome.
