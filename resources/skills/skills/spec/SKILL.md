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

Before the spec is handed over, run `check` and fix every finding; never flip
`status: approved` while a finding stands. The skill never dispatches, creates cards, merges or
ticks anything: once the operator approves, the next step is `harnu:orchestrate-delivery`.

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
`uncovered-atom`, and with `--cards` `hash-diverged`, `unknown-ac`, `missing-ac`. A card-only
AC line with no hash prints as `info:` and is not a finding. Exit 0 clean, 1 on any finding, 2
on a usage error or an unreadable file.

Report the findings as printed and fix the spec, then re-run. `--cards` lints and never grades:
met or unmet stays the verifier's word. If the script or Node is missing, say so and stop; the
checks run only through this script.
