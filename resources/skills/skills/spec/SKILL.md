---
name: spec
description: "Called at every entry, before any work starts, and most calls end Small: it names the door the operator came in by and the tier, in one message, and a Small entry (a one-line bug, a PR comment, a red CI, a question) gets its first step with no file, no mission and no tool call. Only Medium, Large and Complex work goes on to a spec at `docs/specs/YYYY-MM-DD-<slug>/spec.md`. Two verbs: `/harnu:spec <entry>` (triage, then authoring above Small) and `/harnu:spec check [--cards]` (runs the checker staged with this skill: the spec gate's rules, capability order, request-atom coverage and, with `--cards`, card-versus-spec drift; works in any repo). Use at the start of any task, ticket, bug, question, PR comment, red CI, design or vague idea — 'spec this', 'how big is this?', 'triage this', 'check the spec', 'lint the cards against the spec'. Do NOT use to dispatch cards (orchestrate-delivery), to grade acceptance criteria (delivery-verifier) or to drain open decisions (one-by-one)."
effort: medium
---

# Spec

## Triage

Run this first, at every entry. Answer in one message: the door, the tier with a one-line
reason, the next step.

| You arrive with           | First step                                       | Becomes                                |
| ------------------------- | ------------------------------------------------ | -------------------------------------- |
| A vague idea              | `brainstorming` (one question per turn)          | objective + request atoms R-n          |
| A task / ticket           | `scope-task` (ACs one by one, what exists, gaps) | report on the card                     |
| A bug                     | `systematic-debugging` until root cause          | `bug` card with the repro as an AC     |
| A question                | answer in chat; `memory_query` and lessons first | nothing, or one decisions line         |
| A PR comment / red CI     | `address-review` / `debug-gh-action`             | commit on the existing branch; no spec |
| A design / mockup         | `create-mockup` or `implement-design`            | screens approved one by one            |
| A recurring pain          | `learn-from-review` or a card                    | a lesson, or a `chore` card            |
| "Where did we leave off?" | `harnu:status` / `resume-task`                   | a read of the mission, nothing written |

**Small ends here.** These entries are Small:

- a one-line bug → `A bug`
- a PR comment, a red CI → `A PR comment / red CI`
- a question → `A question`
- a question that grows into an architectural decision → `A question`, then an ADR (`docs/adr/NNNN-<slug>.md`), never a spec
- "where did we leave off?" → `"Where did we leave off?"`

Answer `Door: <door> · Tier: Small — <reason>. Next: <first step> → <becomes>.` and stop.
No spec file, no mission, no sub-agent, no lint run, no tool call: the first step runs after
this answer, outside this skill.

**Above Small, the card's `complexity` picks the tier** (no card yet: judge from the entry, or
from the objective its first step produced):

- `trivial`, `simple` → **Small** — the card's own ACs are the whole contract.
- `standard` → **Medium** — a `standard` card with nothing to record beyond its ACs.
- `standard` with a D-n or a non-goal to record → **Large** — the spec must hold a decision or a non-goal.
- `complex` → **Complex** — a `complex` card: the spec carries a PRD, and an ADR or a mockup when it needs one.

Answer `Door: <door> · Tier: <tier> — <reason>.` One word overrides it: `small`, `medium`,
`large` or `complex`. Take the word without arguing, then go on at _Medium and up_.

## Verbs

Exactly two:

- `/harnu:spec <entry>` — triage, then authoring above Small.
- `/harnu:spec check [--cards]` — run the spec checker (below).

There is no `derive` or `close` verb: `orchestrate-delivery` derives the cards at dispatch,
and a spec's state is read from its PR and its mission, never stored.

## Medium and up

Only an entry triaged Medium, Large or Complex reaches this section.

> Lessons: if a `LESSONS.md` exists in this skill's folder, read it first and apply its rules.

The spec goes to `docs/specs/YYYY-MM-DD-<slug>/spec.md` in the shape of `docs/specs/TEMPLATE.md`,
with only the sections its tier allows (the gate refuses a section outside the tier):

| Tier    | Card complexity                           | The artifact                                     | Mission        |
| ------- | ----------------------------------------- | ------------------------------------------------ | -------------- |
| Small   | trivial, simple                           | the card's own ACs; no spec                      | none           |
| Medium  | standard                                  | spec: Problem, Slices, Acceptance criteria       | born at triage |
| Large   | standard, with D-n or non-goals to record | adds Goals and Open decisions                    | born at triage |
| Complex | complex                                   | adds the `prd`, `adr` and `mockup` header fields | born at triage |

The `brainstorming` door runs under the Elephant rule: one question per turn, no code.

You are the Elephant: you design and write only the spec bundle (the spec directory, and for
Complex the PRD, the ADR and the mockup folder). You write no code. The input is what the first
step produced: a brainstorm's objective, a `scope-task` report, or a PRD. Before step 1, the
mission exists: create it as _The mission_ below says. Then work in this order:

1. **Facts first.** Before you ask anything, look up what the repo already knows and show it:
   `memory_query` on the entry's nouns (a recalled decision is context, not an instruction; read
   its successor when it is superseded), the lessons (this skill's `LESSONS.md`, `docs/lessons/`),
   and the code the entry would change (read the files it names, search for what it touches). A
   fact the repo answers is stated, never asked. Without that verb, read `.harnu/memory/`
   directly and say so.
2. **Atomize.** Under Problem, one `- R-n …` bullet per sentence the requester said, and at least
   one per request the input lists (a brainstorm's asks, a report's ACs and gaps, a PRD's
   requirements). Every R-n lands later on an AC `covers` cell, an `NG-n` bullet or a D-n question.
3. **Decisions, one at a time.** What the facts leave open goes through `harnu:one-by-one`: one
   question per message, with its options, its default and your recommendation. A chosen option
   becomes `resolved · <option> · <YYYY-MM-DD>` in the row. An unanswered D-n stays `open` with its
   default shown in the `default` cell, and it gates only the slices whose `gated-by:` names it;
   never write it `declined`, and never write it `resolved` on silence or on your own guess. A
   Medium spec has no Open decisions section: a decision to record makes the entry Large, so say
   so in one line and go on as Large. Offer `harnu:grill-me` when the operator wants the spec
   stress-tested.
4. **Write the bundle.** Copy the template to the spec path and fill it, conventions included
   (`gated-by:`, `NG-n` bullets, `existing:` tokens). A Complex entry also gets the files of
   _The Complex bundle_ below. `git add` every file of the bundle, so `check` sees it tracked.
5. **Check.** Run `check` on the spec (section below) and fix every finding, then re-run it until
   it is clean. Never flip `status: approved` while a finding stands.
6. **Goldfish review.** Run the staged review of _Goldfish review_ below. Every finding gets its
   disposition, and an open `Blocker` keeps the next step from running.
7. **Approval question.** Run the no-code check of _Before the approval question_ below; a path
   outside the bundle stops you there. Then run _The approval question_ below: the mission,
   `open_file`, then the one question `Approve this spec?` The approval is the operator's yes.

An unanswered decision in the Open decisions table:

```md
| D-n | <question, citing the R-n it settles> | <option>; <option> | <what a slice uses until it is chosen> | open |
```

The skill never dispatches, creates cards, merges or ticks anything: once the operator approves,
the next step is `harnu:orchestrate-delivery`.

## The mission

The mission is born the moment the entry leaves Small: as soon as triage names Medium, Large or
Complex, call `mission_create` (a Small entry gets no mission). It gives the work a heartbeat while
the spec is written and read, and a step the operator marks when they approve.

- **The end is the delivery's end (D-5):** what ships the objective, never the spec approval. One
  mission per body of work, so `orchestrate-delivery` adopts this one at dispatch instead of
  creating a second. When the spec changes the end, stage the new one with `mission_set_end` and a reason.
- **One step, "Approve spec"**, verification `human`: only the operator marks it. Keep its `stepId`
  from the ACK; the dispositions, the approval and the blocker all go on it.
- **The scope** lists the spec path and the PRD and ADR paths the tier will carry, written or not:
  a path not written yet reads unresolved until it is. Drop the PRD and ADR paths a tier does not
  carry: Medium and Large list the spec alone, Complex adds the PRD and, when it records an
  architectural decision, the ADR. Pass `linkedCard` when the entry has a card.

```json
{
  "folder": "<absolute path of the repo>",
  "title": "<the objective, one line>",
  "sessionId": "<your own Claude session UUID>",
  "declaredEnd": {
    "kind": "code",
    "target": "<what ships the objective: its PRs merged>",
    "evidence": "<green gates and a delivery-verifier report, every AC met>"
  },
  "scope": [
    "docs/specs/YYYY-MM-DD-<slug>/spec.md",
    "docs/prds/<card>-<slug>.md",
    "docs/adr/NNNN-<slug>.md"
  ],
  "steps": [{ "title": "Approve spec", "verification": "human" }]
}
```

Without the `mission_*` verbs (outside Harnu), say so in one line and go on without a mission.

## The Complex bundle

A Complex spec travels with up to three more files, each named in the spec header:

- **The PRD** at `docs/prds/<card>-<slug>.md` (`<card>` is the entry's card id): who it is for,
  what the operator sees, the edge cases, and "Alternatives considered", which lives in the PRD
  only. An input that is already a PRD is moved there, not rewritten.
- **An ADR** at `docs/adr/NNNN-<slug>.md` (`NNNN` the next free number in `docs/adr/`), only when
  the spec records an architectural decision. With none, drop the `adr:` line.
- **A mockup folder**, only when the work has UI: the screens approved through `create-mockup`,
  committed in a tracked folder such as `docs/design/<slug>/`. Without UI, drop the `mockup:` line.

Every path is a tracked, repo-relative path committed with the spec, and never under the
gitignored scratch directory `.harnu/out/`, not even in prose: a fresh worktree cannot see it and
the gate fails on it. The header, before approval:

```yaml
---
status: draft
tier: complex
prd: docs/prds/<card>-<slug>.md
adr: docs/adr/NNNN-<slug>.md
mockup: docs/design/<slug>/
---
```

An `untracked-path` finding from `check` means a bundle file is not added yet: `git add` it.

## Goldfish review

Every reviewer is a Goldfish: a fresh sub-agent that reads only the files it is handed (the spec,
its persona from `agents/` beside this file, and an optional reading list), never this
conversation. Stages run in order; the reviewers within a stage run in parallel:

| Tier    | Stage 1 (alone) | Stage 2 (parallel)                               | Stage 3 (alone)          | Sub-agents |
| ------- | --------------- | ------------------------------------------------ | ------------------------ | ---------- |
| Medium  | comprehension   | —                                                | implementation readiness | 2          |
| Large   | comprehension   | hostile critic                                   | implementation readiness | 3          |
| Complex | comprehension   | hostile critic, overhead lens, traceability lens | implementation readiness | 5          |

One re-review per stage after fixes, so the worst case is twice the column. A round spawns
at most five sub-agents, and a Small entry spawns none: it never reaches this section.

**Spawning.** Each reviewer is one `Agent` call with `subagent_type: "general-purpose"` (never
`fork`, which inherits this conversation) and, under D-14, a `model` other than yours whenever one
is available. The prompt carries absolute paths and nothing else: no summary, no excerpt, no line
of this conversation.

| Reviewer                 | Persona                   | Reading list                                    |
| ------------------------ | ------------------------- | ----------------------------------------------- |
| comprehension            | `agents/comprehension.md` | none: the spec alone                            |
| hostile critic           | `agents/critic.md`        | optional: the PRD, the ADR, files a slice names |
| overhead lens            | `agents/overhead.md`      | optional: the PRD, the ADR, files a slice names |
| traceability lens        | `agents/traceability.md`  | optional: the PRD, the ADR, files a slice names |
| implementation readiness | `agents/readiness.md`     | optional: the PRD, the ADR, files a slice names |

```text
Persona: <absolute path of the persona file>
Spec: <absolute path of spec.md>
Reading list: <absolute path>, <absolute path>
```

Leave the `Reading list:` line out when there is none, and always for comprehension.

**Reading the comprehension report.** It opens with "What this proposes" and "How the system works,
per this spec". Before its gaps, compare the paraphrase with your intent: where it differs, the
spec says what you did not mean, and a wrong paraphrase is a finding (reviewer `comprehension`,
at least `Major`). Fix the spec; a comprehension gap is never contested.

**Dispositions.** Write each finding's one disposition in `critics.md` beside the spec: fix it,
contest it with checkable evidence, escalate it to a D-n, or decline it to an `NG-n`. A reviewer
that failed is `not run`, never "no findings"; a re-review is a new row with the next round.

```md
# Goldfish review

Author model: <model> · reviewer model: <a different model, when one is available (D-14)>
Persona files are read by a general-purpose sub-agent, so `CLAUDE.md` may reach the reviewer (D-9).

## Reviewers

| reviewer      | round | model   | status          |
| ------------- | ----- | ------- | --------------- |
| comprehension | 1     | <model> | ran             |
| critic        | 1     | <model> | not run — <why> |
| critic        | 2     | <model> | ran             |

## Findings

| id  | reviewer      | severity | finding          | disposition | evidence                  |
| --- | ------------- | -------- | ---------------- | ----------- | ------------------------- |
| F-1 | comprehension | Major    | <what it raised> | fix         | <what changed, and where> |
```

`disposition` is `fix`, `contest`, `escalate D-n` or `decline NG-n`. `check` lints this file:
`undisposed-finding` (no disposition, or a D-n or NG-n the spec lacks), `weak-contest` (evidence
that is only "intentional", or a contested comprehension gap) and `reviewer-not-run` (a reviewer
whose last round failed).

**Recording.** Each disposition is one `mission_log` on the mission's "Approve spec" step (its
`stepId` from `mission_get`): `kind: 'decision'`, or `'surprise'` for a finding that changed the design.

```json
{
  "folder": "<absolute path of the repo>",
  "missionId": "<mnt-…>",
  "stepId": "<stp-n of the Approve spec step>",
  "kind": "decision",
  "note": "F-1 (comprehension, Major): fix — <what changed, and where>"
}
```

Each resolved D-n, answered in step 3 or escalated here and answered, is one `memory_append` to
`decisions`. Its `watches` lists
the literal directory prefix of each `files-may-touch` glob of the slices whose `gated-by:` names it,
plus single-word topics from the question. Recall matches only a literal path or a directory prefix,
never a glob, so a literal file path stays as it is and a glob gives its prefix:
`resources/skills/skills/spec/agents/*.md` → `resources/skills/skills/spec/agents/`. When
`harnu:one-by-one` drained the decision, its memory line is this one: hand it the `watches`.

```json
{
  "folder": "<absolute path of the repo>",
  "page": "decisions",
  "entry": "D-n · <question> · chosen: <option> · <YYYY-MM-DD>",
  "watches": ["src/badge/", "badge"],
  "mission": "<mnt-…>"
}
```

**An open `Blocker` holds the question.** A `Blocker` stays open until its disposition is written
and, for a fix, the stage's re-review no longer raises it. While a `Blocker` is open,
the approval question is not asked.

## Before the approval question

Nothing outside the spec bundle changes while you author. The bundle is the spec directory, and
for Complex the PRD, the ADR and the mockup folder; Harnu's own `.harnu/` is not code. When
authoring begins, note `git rev-parse HEAD` as `<base>`. Before the approval question, print every
path changed since then that lies outside the bundle:

```sh
{ git diff --no-renames --name-only <base>; git ls-files --others --exclude-standard; } | sort -u | grep -v -e '^<spec directory>/' -e '^<prd>$' -e '^<adr>$' -e '^<mockup folder>' -e '^\.harnu/'
```

Drop the `-e` of a file the tier does not carry. Nothing printed: go on. Any line is a stop: name
every path it printed, ask no approval, and leave the code to a card of its own. This check always
runs (D-10). In a session Harnu spawned for an agent, also call `orchestrator_arm` with your own
`sessionId`, so nothing outside `.harnu/` is written while the operator reads; `TARGET_OPERATOR_OWNED`
means the operator's own session, so go on without the guard. `orchestrator_disarm` lifts it to
apply a change they ask for or to flip the header after the yes; then run this check again.

## The approval question

Once the no-code check prints nothing, in this order:

1. **The mission first.** The mission of _The mission_ exists with its "Approve spec" step; if
   triage did not create it, create it now, before anything is handed over.
2. **Hand it over.** Call `open_file` on the spec, so the operator reads it in a pane beside the
   session; for Complex, name the PRD and the ADR in the same message.
3. **One question.** Ask exactly one question, `Approve this spec?`, and nothing else.

On a yes: `orchestrator_disarm` if you armed the guard, flip the header from
`status: draft` to `status: approved`, re-run `check` and the no-code check, and log the approval on the "Approve
spec" step with `mission_log`. Then point the operator at the step's own control: click the
mission pill, then **Mark verified** on the "Approve spec" step. The approval is theirs: the skill
never ticks the step, and no verb can. The next step is `harnu:orchestrate-delivery`.

On a no or a change: apply it inside the bundle, re-run the stage of _Goldfish review_ it touches,
and ask the question again.

With no operator to answer (the turn ends with the question unanswered): call
`mission_set_blocker` on the "Approve spec" step as the operator's, so Harnu chimes and
re-nudges with back-off, and stop. Clear it with `mission_clear_blocker` the turn they answer.

```json
{
  "folder": "<absolute path of the repo>",
  "missionId": "<mnt-…>",
  "stepId": "<stp-n of the Approve spec step>",
  "reason": "The spec waits for its approval: <spec path>",
  "unblocks": "The operator answers `Approve this spec?`",
  "owner": "operator"
}
```

## Once a slice has a card

A spec is frozen at its first dispatch. A slice has a card when either holds:

- the Amendments table has a row of kind `card` (`S-n → <card slug>`);
- a card whose `spec:` names this spec carries `spec-slice: S-n` (`check --cards` counts the cards
  that name the spec).

From then on, change the spec only by appending a row to Amendments · Deviations, and never edit
the body above it, not even to fix a typo:

```md
| YYYY-MM-DD | amendment | <what changed, naming the slices and ACs it touches> | <who> |
```

Then send the affected executor the change as a delta: the new row verbatim and the AC lines it
changes, to the session building that slice's card (`SendMessage` to a live peer,
`message_session` to a parked Harnu-spawned one). No session is building it yet: the next derive
at dispatch carries the change onto the backlog card. Before any slice has a card, edit the body
in place and still add the row, saying it was applied before the first dispatch.

## `check [--cards]`

A script run, not a conversation. The skill directory is the base directory the session is told
when this skill loads (the "Base directory for this skill" line); the checker is staged inside
it, beside this file, so `check` works in any repo:

```sh
node <skill directory>/scripts/spec-check.mjs <spec-path>
node <skill directory>/scripts/spec-check.mjs <spec-path> --cards
```

`--cards` reads the board cards from `.harnu/memory/roadmap` of the repo's main checkout; add
`--cards-dir <dir>` to read another directory.

**Resolving `<spec-path>`**, first match wins:

1. the path the operator named;
2. the spec attached to the mission as scope;
3. the one spec directory changed on the branch (its `spec.md`);
4. otherwise ask for the path. Never pick between two candidates yourself.

**Reading the result.** One line per finding, `path:line [rule] message`, every finding collected:
the gate's own rules, then `missing-producer`, `producer-not-before`, `no-atoms`,
`uncovered-atom`, the `critics.md` rules when one sits beside the spec (`undisposed-finding`,
`weak-contest`, `reviewer-not-run`), and with `--cards` `hash-diverged`, `unknown-ac`, `missing-ac`. A card-only
AC line with no hash prints as `info:` and is not a finding. Exit 0 clean, 1 on any finding, 2
on a usage error or an unreadable file.

Report the findings as printed and fix the spec, then re-run. `--cards` lints and never grades:
met or unmet stays the verifier's word. If the script or Node is missing, say so and stop; the
checks run only through this script.
