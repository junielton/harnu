# Bake-off protocol — fixed before any run

The rubric is the spec's S-10 section (`../spec.md`). This file fixes how each rubric step is run
here, so the runs can be checked against it. It is committed with the hidden truth, before the
first contestant starts.

## Who runs what

| role               | how                                                                      | model  |
| ------------------ | ------------------------------------------------------------------------ | ------ |
| orchestrator       | this session: pins, hidden truth, relays, scoring, report                | opus   |
| contestant × 3     | one fresh `general-purpose` sub-agent per tool, never a fork             | opus   |
| simulated operator | one fresh `general-purpose` sub-agent per contestant, sheet only         | sonnet |
| judge × 3          | fresh `general-purpose` sub-agents, one spec at a time, shuffled order   | sonnet |
| executor × 3       | one fresh `general-purpose` sub-agent per spec, in its own scratch clone | opus   |

Every sub-agent runs with the same default effort: no `effort` override is passed to any of them.
Judges run on a different model from the contestants (rubric step 4). Executors run on the
contestants' model (rubric step 5).

## Isolation

- Every contestant works in its own clone of the pinned commit, under the session scratchpad,
  outside this repository, with no git remote. It reads only that clone and its tool's own files,
  copied beside the clone; it is told not to look the issue up online.
- The hidden truth (`hidden/`) is committed first, then removed from the working tree for the
  duration of the runs and restored from git afterwards, so no sub-agent can stumble on it.
- Sub-agents inherit the orchestrator's working directory and its `CLAUDE.md`, a Harnu file. All
  three contestants and all three executors get the same one; it is a shared confound, named in
  the report.

## The operator relay

A contestant that needs the operator ends its turn with a message starting
`QUESTION TO OPERATOR:`. The orchestrator forwards the text verbatim to that contestant's
operator, which answers from `input/answer-sheet.md` alone in the form
`ENTRIES: <ids>` / `ANSWER: <text>`. Only the `ANSWER` text goes back to the contestant. Every
exchange is logged in `runs/<tool>/operator-log.md`. One relay is one operator turn.

## Tools

| tool                                          | how it is loaded                                                   | stop point                                 |
| --------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------ |
| `harnu:spec`                                  | the skill folder copied from this branch, read from its `SKILL.md` | the operator's yes to `Approve this spec?` |
| Superpowers `brainstorming` → `writing-plans` | the installed plugin skills, through the `Skill` tool              | the plan is written; no execution          |
| `tlc-spec-driven`                             | fetched read-only at a pinned commit, read from its `SKILL.md`     | before its Execute phase                   |

`harnu:spec` runs outside Harnu: its `mission_*`, `memory_query` and `open_file` verbs are not
available, and the skill's own outside-Harnu fallbacks apply. `docs/specs/TEMPLATE.md` is not in
the target repo, so a copy is placed in the tool folder and its path is given.

## Judging

Each judge gets `judges/score-sheet.md`, `hidden/atoms.md` and one anonymised spec bundle at a
time (tool names, skill names and tool-specific banners replaced by `[tool]`), three bundles in a
shuffled order that differs per judge. The judge's raw output is committed as-is in `judges/`.

## The build test

Each executor gets a fresh clone of the pinned commit with only its spec bundle copied in, its
own virtualenv, and this instruction: implement the feature from the spec yourself (no skills,
no sub-agents), log every assumption the spec did not settle in `ASSUMPTIONS.md`, run the
existing suite, commit locally. After it finishes, the orchestrator copies
`hidden/test_hidden_bakeoff.py` into the clone's `tests/` and runs it, then runs the existing
suite. The hidden pass rate is the headline number.

## Cost

Per tool: total tokens and wall time of the contestant sub-agent as the harness reports them,
operator turns (relays), sub-agents the contestant spawned (its own report), and spec length
(lines and words of every artifact file).

## Validation of the hidden suite (before any run)

| code under test                                     | hidden tests                            | existing suite          |
| --------------------------------------------------- | --------------------------------------- | ----------------------- |
| pristine `9c66baf`                                  | 3 / 53 pass (the O-1 guards, by design) | 1497 passed, 16 skipped |
| `hidden/reference.patch` (orchestrator's own build) | 53 / 53 pass                            | 1497 passed, 16 skipped |

The reference patch exists only to prove the suite is passable and that its errors are the
feature's own (an unknown option does not count as the feature's error). No contestant or
executor sees it.
