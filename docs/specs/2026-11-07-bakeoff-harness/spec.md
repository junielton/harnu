---
status: approved
tier: complex
prd: docs/prds/T676-bakeoff-harness.md
adr: docs/adr/0025-bakeoff-harness.md
---

# Bake-off harness: mechanical, multi-problem evaluation of spec skills with a private holdout

_Card T676 (child of T601). Product requirements: `docs/prds/T676-bakeoff-harness.md`. The two
architectural decisions (where the harness lives and how it drives Claude; where the holdout lives
and how it is kept out of the repo) are recorded in `docs/adr/0025-bakeoff-harness.md`. The
one-off run this harness mechanizes is T601 S-10, `docs/specs/2026-11-harnu-spec/bakeoff/`
(`protocol.md`, `report.md`). Prior art it builds on: `scripts/eval/mission-behavior/`
(`npm run eval:mission`, `claude -p` with stream-json evidence) and the lesson
`docs/lessons/testing/006-eval-harness-grades-state-through-the-real-transport.md`._

## Problem

The T601 S-10 bake-off compared `harnu:spec`, Superpowers and `tlc-spec-driven` on one hand-picked
input (sqlite-utils issue #489), one run per tool, driven by one session that also wrote the
hidden truth and relayed every operator question and answer. Its own report says the order of
the three on the headline number "is not" robust: one input, no repeats, so no variance estimate.
The next skill changes (BUG-259, T674) would be tuned against that single problem, which is how a
benchmark gets gamed (Goodhart's law). Cost is real: S-10's per-tool figures are under Budget.

What exists to build on, read before this spec was written:

- `scripts/eval/mission-behavior/agent.mjs` already drives headless `claude -p` with
  `--model`, `--max-turns`, `--allowedTools`, `--output-format stream-json --verbose` and a deadline
  that escalates SIGTERM → SIGKILL. `harnu.mjs` beside it exports `cleanEnv()` (scrubs `CLAUDECODE`,
  `CLAUDE_CODE_*`, `CLAUDE_PID`, `CLAUDE_EFFORT`, lesson testing/006) and `procs.mjs` exports
  `escalate`.
  `npm run eval:mission` runs it through `vite-node`. Its run artifacts go to a gitignored
  `.harnu/eval/<harness>/<timestamp>/` directory (`.harnu/` is gitignored).
- That harness uses `--no-session-persistence`; a session that is resumed with `--resume` must
  persist, so its transcript lands in `~/.claude/projects/` and has to be moved out and cleaned,
  as the mission-behavior README already does for spawned sessions.
- The S-10 files are a complete worked problem: pinned input, answer sheet with general entries
  (G-1 open-ended, G-2 not on the sheet, G-4 approval "Yes, approved."), hidden atoms as an `id`
  table, a 53-test hidden pytest suite validated on the pristine commit (3 pass) and on a
  reference patch (53 pass), a 5-measure judge score sheet with a fixed JSON output, and
  per-sub-agent usage summed from transcripts (input + cache write + cache read + output).
- The S-10 numbers the reproduction is checked against (AC-30): hidden tests 51/53 (`harnu:spec`), 53/53
  (Superpowers), 52/53 (`tlc-spec-driven`); judge coverage means 21.8, 23.7 and 22.8 of 24 atoms.
- The installed Superpowers 7.0.0 records `gitCommitSha` `bb92a77741419a4ab5f06e711a283343f1ada0c3`
  (repository `https://github.com/obra/superpowers`); S-10 fetched `tlc-spec-driven` from
  `https://github.com/tech-leads-club/agent-skills` at `8658b6658c762b9e5efd3956ed35a51c41bdf6c3`.
  The skill S-10 ran is `resources/skills/skills/spec/` at `6bab507f` (the T601 S-8 head its
  worktree was cut from, an ancestor of `main` through the merge commits). `main` has moved past
  it, because the S-9 fix `c92340e5`, from a parallel branch `6bab507f` does not contain, changed
  `SKILL.md` and `spec-check-core.mjs`.

The request, atomized. The operator's words (2026-11-07, translated), one atom per sentence; then
one per card acceptance criterion; then the card's seven anti-overfitting rules, its cost note
and its real-world-signal section:

- R-1 "One of my fears is that we start tuning `harnu:spec` biased to pass and score well on benchmarks and then it gets bad on real problems."
- R-2 "Is this process reproducible mechanically, with a variety of possible problems, so the models don't get addicted to writing specs for one particular problem?"
- R-3 "What would this harness be — a Python lib outside Harnu or something like that?" Answered: a dev tool inside this repo under `scripts/eval/`, extractable later.
- R-4 "Will it be documented as a dev tool?" Answered: yes, `docs/dev/bakeoff.md` and a README beside the harness.
- R-5 One command runs a corpus end to end (contestants, judges, builds, report) with no human relay (card:AC-1).
- R-6 The report shows dev and holdout separately, with variance across repeats (card:AC-2).
- R-7 The holdout corpus is read from a path outside the repo and never written into it (card:AC-3).
- R-8 Re-running the S-10 input through the harness reproduces the S-10 numbers within variance (card:AC-4).
- R-9 `docs/dev/bakeoff.md` explains how to run a round, how to author a corpus problem, where the private holdout lives and how to point the harness at it, how to read the report, and states the seven rules as process rules (card:AC-5).
- R-10 The harness README is the CLI reference (commands, flags, outputs) and links to the dev guide (card:AC-6).
- R-11 Rule 1: a varied corpus (target 8–12): bug, feature, refactor, UI, greenfield, several languages and repos.
- R-12 Rule 2: a dev / holdout split; skill changes look only at dev results; holdout only confirms a version, nobody reads holdout failures to fix the skill; a dev gain without a holdout one means overfitting.
- R-13 Rule 3: the holdout corpus lives outside this public repo, in a private repo the harness reads.
- R-14 Rule 4: fresh problems each round, authored after the last skill change.
- R-15 Rule 5: 2–3 repeats per problem; a change is accepted only when its effect exceeds run-to-run variance.
- R-16 Rule 6: every skill change names its failure class, never a problem-specific detail.
- R-17 Rule 7: whoever writes an answer sheet or hidden tests never reads `SKILL.md`.
- R-18 Cost: the cadence is 6 problems × 2 repeats × `harnu:spec` vs one baseline, once per skill version, and a round's token cost must be bounded (the arithmetic is under Budget).
- R-19 Real-world signal: measure, in real deliveries, the deltas sent back to executors, `unmet` ACs and builder guesses per spec-born mission; it outranks the benchmark.

### Formats the slices build to

These are the contracts between slices; a slice does not invent them.

**Glossary.**

- **split**: `dev` or `holdout`, the two parts of the corpus; a round runs exactly one split.
- **atoms**: the rows of a problem's `hidden/atoms.md`, the requirements a judge scores coverage against (not the request atoms of this spec).
- **tells**: the strings that name a contestant, listed in the Contestants table and replaced in the bundle.
- **unit**: the smallest thing the harness schedules and resumes: one contestant run, one judge of that run, or its build.

**Roots and environment.** The harness is ES modules under `scripts/eval/bakeoff/`, run by
`vite-node` (D-1). Every module imports only `node:` built-ins, its sibling modules, and
`cleanEnv` / `escalate` from `scripts/eval/mission-behavior/harnu.mjs` and `procs.mjs`; no new
package dependency. Environment variables, all optional except where a split needs one:

| variable                        | meaning                                                                      | default                                           |
| ------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------- |
| `HARNU_BAKEOFF_HOLDOUT`         | absolute path of the private holdout clone                                   | none; required by `--split holdout`               |
| `HARNU_BAKEOFF_CACHE`           | mirrors, fetched tools, dev unit work, dev validation results, dev authoring | `${XDG_CACHE_HOME:-~/.cache}/harnu-bakeoff/cache` |
| `HARNU_BAKEOFF_WORK`            | holdout unit work and holdout validation results only                        | `${XDG_CACHE_HOME:-~/.cache}/harnu-bakeoff/work`  |
| `HARNU_BAKEOFF_CLAUDE_BIN`      | the `claude` executable (tests point it at a fake)                           | `claude`                                          |
| `HARNU_BAKEOFF_CLAUDE_PROJECTS` | where `claude` writes session transcripts                                    | `~/.claude/projects`                              |
| `HARNU_BAKEOFF_TIMEOUT_SCALE`   | test-only: a float that multiplies every time limit of the Limits table      | `1`                                               |

The **repo** is both `git rev-parse --show-toplevel` and the main checkout (the parent of
`git rev-parse --path-format=absolute --git-common-dir`). **Containment** (D-2): `resolveRoots` in
`paths.mjs` takes the realpaths of `HARNU_BAKEOFF_HOLDOUT`, `HARNU_BAKEOFF_CACHE` and
`HARNU_BAKEOFF_WORK`. Each must be outside both repo roots (neither equal to nor under either), and
`HARNU_BAKEOFF_WORK` must also be outside the cache root and the holdout clone. Otherwise
`resolveRoots` returns a coded error, `HOLDOUT_INSIDE_REPO`, `CACHE_INSIDE_REPO` or
`WORK_NOT_CONTAINED`; a holdout split with the variable unset returns `HOLDOUT_UNSET`. The CLI exits
2 with that code before any work (AC-38).

Where things are written:

| what                                                  | dev problems                                                                                        | holdout problems                                          |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| corpus (read only)                                    | `scripts/eval/bakeoff/corpus/dev/<id>/`                                                             | `$HARNU_BAKEOFF_HOLDOUT/<id>/`                            |
| unit work (clones, transcripts, artifacts, judgments) | `$HARNU_BAKEOFF_CACHE/rounds/<round-id>/units/`                                                     | `$HARNU_BAKEOFF_WORK/rounds/<round-id>/units/`            |
| validation results                                    | `$HARNU_BAKEOFF_CACHE/validation/<key>.json`                                                        | `$HARNU_BAKEOFF_WORK/validation/<key>.json`               |
| authoring sandbox                                     | `$HARNU_BAKEOFF_CACHE/authoring/<id>/`                                                              | `$HARNU_BAKEOFF_HOLDOUT/.rounds/authoring/<id>/`          |
| `round.json`, `report.md`, `report.json`              | `<main checkout>/.harnu/eval/bakeoff/<round-id>/` (gitignored), so `compare` works across worktrees | the same path, aggregates only (see The report)           |
| per-problem state, scores and content hashes          | in `round.json` and `report.json`                                                                   | `$HARNU_BAKEOFF_HOLDOUT/.rounds/<round-id>/problems.json` |

No contestant, operator, judge or builder ever runs inside the repo: a cwd under the repo would
load its `CLAUDE.md` and could reach `corpus/dev/*/hidden/`. A holdout round's repo-side
`round.json`, its report and `compare` name no holdout problem at all. Per-problem data stays in
the private round directory: `problems.json` above (keyed by real id) and
`$HARNU_BAKEOFF_HOLDOUT/.rounds/<round-id>/labels.json`, the map of opaque labels `H-1…H-n` (sorted
by id), used only to read that directory. A holdout round's `round.json` writes `args` as the string
`redacted`; the full args are in `problems.json`, where `resume` reads them.

**Holdout on the terminal.** `--problems` is refused with `--split holdout`, on `run` and on
`validate`, with exit 2 `PROBLEMS_ON_HOLDOUT`. On a holdout split, `run`, `resume`, `report`,
`compare`, `validate` and `list` carry only counters on stdout and stderr (`unit 3/24 done`,
`2 of 3 holdout problems failed validation`), never a problem id, a label or a test name; the
details of a failed holdout validation are written to
`$HARNU_BAKEOFF_WORK/validation/<key>.json`. `author-sandbox`, `author-import` and `review` take an id
the operator supplies and are exempt.

**Holdout privacy is by convention** (D-2). No session tuning the skill is handed
`HARNU_BAKEOFF_HOLDOUT` or `HARNU_BAKEOFF_WORK`, and there is no OS sandbox: a session given either
path could read the files. Containment only keeps holdout files out of the repo.

**A corpus problem** is one directory named by its id (`[a-z0-9-]+`):

```text
<id>/
  problem.json        metadata, below
  pick.md             the pick log: candidates considered, the rule applied, the date, the one chosen
  request.md          the request text a contestant receives, verbatim, nothing else
  answer-sheet.md     the simulated operator's answers
  hidden/atoms.md     a markdown table whose first column is `id`; each id matches ^[A-Z]+-\d+$
  hidden/<files>      the hidden test files listed in problem.json
  hidden/reference.patch   a build that passes every hidden test (proves the suite passable)
  source/             only when target.inline: the target repo's files
```

```jsonc
{
  "id": "sqlite-utils-json-key", // = the directory name
  "split": "dev", // dev | holdout; must match the root it sits in
  "kind": "feature", // bug | feature | refactor | ui | greenfield
  "language": "python", // python | typescript | go | …, lowercase
  "target": { "repo": "https://github.com/simonw/sqlite-utils", "commit": "<40 hex>" },
  // or { "inline": "source" }
  "setup": ["python3 -m venv .venv", ".venv/bin/pip install -e '.[test]'"],
  "versions": "python3 --version", // prints the interpreter `setup` uses (python3, node or go); part of the validation key
  "test": ".venv/bin/python -m pytest -q", // the target's own suite; exit 0 = green
  "hidden": {
    "files": ["test_hidden_bakeoff.py"], // paths under hidden/
    "dest": "tests/", // where they are copied in the build clone
    "cmd": ".venv/bin/python -m pytest -q tests/test_hidden_bakeoff.py --junitxml=\"$BAKEOFF_JUNIT\"",
    "compileErrorPattern": "(ImportError|ModuleNotFoundError|SyntaxError)" // required: a regex over the hidden run's output
  },
  "provenance": {
    "authoredAt": "<ISO-8601>",
    "authoredBy": "<text>",
    "sandbox": true, // authored in the author sandbox (D-7)
    "reviewedAt": "<ISO-8601>",
    "reviewedBy": "<git user.name>" // null until `review`
  }
}
```

The hidden command must write JUnit XML to `$BAKEOFF_JUNIT`, with the reporter of the table below; a
`testcase` with no `failure`, `error` or `skipped` child is a pass. Every command runs with
`sh -c` under `nice -n 19` in the clone, bounded by the Limits row **command timeout**.

**JUnit per language.** Installing a reporter is a line of the problem's `setup`, so it is pinned with
the problem and runs in every checkout that runs `setup`. A problem uses the test runner its target
repository already uses and the matching reporter line from this table; a target whose runner is not
in the table is skipped by the pick rule and the next candidate is taken.

| language and runner       | line added to `setup`                                         | reporter part of `hidden.cmd`                                                    |
| ------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Python, pytest            | none                                                          | `pytest --junitxml="$BAKEOFF_JUNIT"`                                             |
| Go                        | `GOBIN="$PWD/.bin" go install gotest.tools/gotestsum@v1.12.0` | `.bin/gotestsum --junitfile "$BAKEOFF_JUNIT"`                                    |
| TypeScript or JS, jest    | `npm i --no-save jest-junit`                                  | `JEST_JUNIT_OUTPUT_FILE="$BAKEOFF_JUNIT" npx jest --reporters=jest-junit`        |
| TypeScript or JS, vitest  | none                                                          | `npx vitest run --reporter=junit --outputFile="$BAKEOFF_JUNIT"`                  |
| TypeScript or JS, mocha   | `npm i --no-save mocha-junit-reporter`                        | `MOCHA_FILE="$BAKEOFF_JUNIT" npx mocha --reporter mocha-junit-reporter`          |
| JavaScript, `node --test` | none                                                          | `node --test --test-reporter=junit --test-reporter-destination="$BAKEOFF_JUNIT"` |

**CPU.** Every process the harness spawns, each `setup`, `test`, `hidden.cmd` and `versions` command
and each `claude -p` (so what a role's `Bash` starts inherits it), runs under `nice -n 19` with
`GOMAXPROCS=1`, `PYTEST_ADDOPTS=-p no:xdist` and `npm_config_jobs=1` in its environment. `--jobs`
defaults to and is capped at `floor(os.availableParallelism() / 2)`, at least 1. Parallelism inside a third-party suite
that ignores these variables is accepted.

**A target checkout** is a clone of the pinned commit from a bare mirror at
`$HARNU_BAKEOFF_CACHE/mirrors/<sha256 of the URL>.git` (fetched on first use), with its remote
removed; or, for `inline`, a fresh repository whose one commit holds `source/`. `checkoutTarget` runs
`setup` once when its `setup` option is true, the default. The contestant's `clone/` is created with
`setup: false`, because a contestant writes a spec and runs none of the target's tooling; only
`build-clone/` and validation checkouts run `setup`.

**Contestants** (D-4) are declared in `contestants.mjs`. Each one's method is copied into a `tool/`
directory beside the clone; the contestant reads it from files (no `Skill` tool), so all of them
load the same way.

| id                | source of `tool/`                                                                                                                                                                                                        | entry                                                   | stop point                                                     | tells (anonymized)                              | spec file (glob)              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------- | ----------------------------- |
| `harnu-spec`      | `git archive <--skill-ref>:resources/skills/skills/spec` extracted into `tool/spec/`, plus `docs/specs/TEMPLATE.md` at the same ref as `tool/spec/TEMPLATE.md`                                                           | `spec/SKILL.md`                                         | the operator's yes to `Approve this spec?` and the header flip | `harnu:spec`, `harnu`, `Goldfish`, `Elephant`   | `**/spec.md`                  |
| `superpowers`     | `skills/` of `https://github.com/obra/superpowers` at `bb92a77741419a4ab5f06e711a283343f1ada0c3`                                                                                                                         | `brainstorming/SKILL.md`, then `writing-plans/SKILL.md` | the plan is written; no execution                              | `superpowers`, `brainstorming`, `writing-plans` | `docs/superpowers/plans/*.md` |
| `tlc-spec-driven` | the one directory of `https://github.com/tech-leads-club/agent-skills` at `8658b6658c762b9e5efd3956ed35a51c41bdf6c3` whose `SKILL.md` frontmatter `name` is `tlc-spec-driven` (zero or several matches: the fetch fails) | `SKILL.md`                                              | before its Execute phase                                       | `tlc-spec-driven`, `tlc`                        | `**/spec.md`                  |

`specLines` and `specWords` count the first artifact path (sorted) that matches the contestant's
`spec file` glob: the plan for `superpowers`, the file the other two declare as their artifact. No
match gives 0.

Default set `harnu-spec,superpowers`; `--with-tlc` adds `tlc-spec-driven`. Fetched tools are cached
at `$HARNU_BAKEOFF_CACHE/tools/<id>@<sha>/`; the resolved sha of every contestant (the skill ref
included) is recorded in `round.json`.

**Sessions.** Every role is a `claude -p` run with `cleanEnv()`, `--output-format stream-json
--verbose`, `--setting-sources project`, a `--session-id` on its first turn and `--resume <id>` on
the next ones, and no `--no-session-persistence` (resume needs the transcript). Every prompt, first
turn and resume alike, goes to the child over stdin and never in argv; `claude.mjs` diverges from
`agent.mjs` here, which passes its prompt as the last argument, because a judge's bundle can exceed
the argument-length limit. After a unit ends,
each of its session transcripts (`<id>.jsonl` and its `<id>/subagents/` directory, found by name
under `HARNU_BAKEOFF_CLAUDE_PROJECTS`) is moved to `transcripts/<role>/<session>.jsonl` and
`transcripts/<role>/<session>/subagents/` in the unit directory, `<role>` being `contestant`,
`operator`, `judge-<n>` or `builder`. Each caller of `moveTranscripts(sessionIds, destDir)` passes its
own role directory as `destDir`, and `sumUsage(dir)` is called once per role directory. A discarded
attempt's transcripts and streams go to `discarded/<attempt>/` in the unit directory (`<attempt>`
counts from 1, with the same `<role>/` layout), so no role's sum and no sub-agent count includes them.
The now-empty project directory is removed only when it holds nothing else.

| role       | model (default)               | tools                                                    |
| ---------- | ----------------------------- | -------------------------------------------------------- |
| contestant | `--model` (`opus`)            | `Read,Write,Edit,Glob,Grep,Bash,Task`                    |
| operator   | `--operator-model` (`sonnet`) | none (`--tools ""`)                                      |
| judge      | `--judge-model` (`sonnet`)    | none                                                     |
| builder    | `--model` (`opus`)            | `Read,Write,Edit,Glob,Grep,Bash` (no `Task`, no `tool/`) |

A role with tools gets its comma-joined list twice, as `--tools <list>` and `--allowedTools <list>`,
as `agent.mjs` does, so the contestant's list includes `Task` and the builder's does not. A role with
none gets `--tools ""` and no `--allowedTools`.

**Limits.** Every bound the loop applies, in one table; the prose and the ACs cite its rows by name.
Every row is read through the one `limits` object of `limits.mjs` (see Module signatures); no other
module holds one of these numbers. `HARNU_BAKEOFF_TIMEOUT_SCALE` (a float, default 1, test-only)
multiplies the time limits (invocation deadline, run deadline, command timeout, validation limit)
and no count.

| limit               | value                                                                                                                                                      | on reaching it                                                                                                                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| operator exchanges  | 12 per contestant run                                                                                                                                      | the 13th question gets the fixed text "The operator is unavailable. Answer from your best judgement, finish the artifact and reply ARTIFACT DONE: <paths>."; a 14th ends the run `incomplete` |
| stray replies       | 3 per contestant run                                                                                                                                       | the 3rd ends the run `incomplete`                                                                                                                                                             |
| invocation deadline | per `claude -p` invocation: contestant 45 min, operator 5 min, judge 15 min, builder 90 min                                                                | killed through `escalate`; no `result` event, so an `error`                                                                                                                                   |
| run deadline        | 150 min per contestant run, operator turns included                                                                                                        | `incomplete`, no retry                                                                                                                                                                        |
| retries             | a run whose turn ends with no `result` event: 1, from scratch (the run deadline restarts); a judge reply with no valid `json` block: 1, in a fresh session | a second `error` makes the run `failed`; a second invalid reply makes the judge `not-run` with `reason: invalid-reply`                                                                        |
| turn cap            | `--max-turns` per `claude -p` invocation: contestant 200, operator 2, judge 2, builder 300                                                                 | that invocation ends; the cap never bounds a whole run                                                                                                                                        |
| command timeout     | 15 min per `setup`, `test`, `hidden.cmd` or `versions` command                                                                                             | killed through `escalate`; it counts as a non-zero exit                                                                                                                                       |
| validation limit    | 5 min per `setup` or `test` during validation                                                                                                              | validation fails                                                                                                                                                                              |

No `effort` override is passed (S-10 protocol). Model flags take an alias (`opus`, `sonnet`,
`haiku`) or a full id. Before any unit, `run.mjs` calls `resolveModel` in `claude.mjs`, which turns each distinct alias into
its full id with one probe `claude -p` (prompt `ok`, `--max-turns 1`, `--output-format stream-json
--verbose`), reading `model` from the `system` `init` event; the probe's usage is appended to
`units/_round/discarded.json` with `phase: model-probe`, `unit: null` and `contestant: null`, and an unresolved alias exits 2 with
`MODEL_UNRESOLVED`. Every `--model` argument, `round.json` and `compare` use the full ids. Outside
`--dry-run`, a judge model whose full id equals the contestant's exits 2 with `JUDGE_MODEL_SAME`,
raised by `assertJudgeModel` in `run.mjs` (S-10 rubric step 4). That is the only model rule enforced: the operator and the judge may share a
model (both default to `sonnet`), accepted because the operator scores nothing.

**Containment per role** (`<unit>` is the unit directory `units/<problem>/<contestant>/r<k>/`):

| role       | cwd                                                                                                                      | `--add-dir`    | what it receives from the problem directory                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------ |
| contestant | `<unit>/clone/`, a checkout of the pinned target                                                                         | `<unit>/tool/` | only the text of `request.md`, pasted by the harness into its first prompt                             |
| operator   | `<unit>/operator/`, its own directory, holding a copy of `answer-sheet.md` alone                                         | none           | that copy of `answer-sheet.md` alone, read by the harness into its prompt                              |
| judge      | `<unit>/judge-<n>/`, holding `bundle.md` alone (and its `discarded.json` after a retry; a judge has no tools to read it) | none           | no file: the harness pastes `hidden/atoms.md` into its prompt; the bundle is the only artifact it sees |
| builder    | `<unit>/build-clone/`, a fresh checkout of the pinned target                                                             | none           | nothing while it runs; the harness copies the hidden files in only after the builder session has ended |

Every run directory lies under the round's unit-work root, so a contestant or builder cwd is
outside the problem directory, outside `$HARNU_BAKEOFF_HOLDOUT` and outside both repo roots. Only the harness process reads the problem directory; the operator and the judge get what
the table lists and no more. `--add-dir` scopes the file tools and `Bash` is not an OS sandbox, so
an absolute path remains reachable from a shell: no prompt names one, and this residual is accepted.

**The contestant loop.** The first turn's prompt is `prompts/contestant.md` with its four placeholders
filled: `{{TOOL_DIR}}`, `{{ENTRY}}`, `{{STOP_POINT}}` and `{{REQUEST}}` (`request.md` verbatim); it tells
the session not to
implement, not to look anything up online, to end a turn that needs the operator with a line
starting `QUESTION TO OPERATOR:`, and to end the run with a line `ARTIFACT DONE: <paths>`. After
each contestant turn the harness reads the final `result` text:

1. a `QUESTION TO OPERATOR:` line → the question, which is the text after that marker through the end
   of the reply (several lines included), goes to the operator session (first time `--session-id`,
   then `--resume`). The first turn's prompt is `prompts/operator.md` with its two placeholders
   filled; each later turn's prompt is the question alone. The reply has the form `ENTRIES: <ids>` /
   `ANSWER: <text>`, the `ANSWER` text running to the end of the reply; only that text is sent back
   with `claude -p --resume <contestant session id>`. Each exchange is appended to `operator-log.md`.
   One exchange is one operator turn.
2. an `ARTIFACT DONE:` line → the run is `done`.
3. neither → a stray reply: the harness resumes with this fixed nudge, held in
   `prompts/contestant.md`, up to the Limits row **stray replies**: "Your last reply had neither a
   line starting `QUESTION TO OPERATOR:` nor a line starting `ARTIFACT DONE:`. If you need the
   operator, end your reply with a line starting `QUESTION TO OPERATOR:`. If the artifact is
   finished, end your reply with a line `ARTIFACT DONE: <paths>`."

`operator-log.md` holds one section per exchange, in order, each exactly:

```text
## Exchange <k>

Question:
<the question text>

Entries: <the ENTRIES ids>

Answer:
<the ANSWER text>
```

The wording of `prompts/contestant.md` around its placeholders is the executor's, apart from the two
markers and the fixed nudge above; AC-5 checks only that the placeholders are filled. The whole text of
`prompts/operator.md`:

```text
You are the operator who asked for this change. The answer sheet below is everything you know about it.

Answer the question at the end from the sheet and from nothing else. You have no tools.

Reply in exactly this form, with nothing before it:
ENTRIES: <the ids of the sheet entries you used, comma-separated, or none>
ANSWER: <your answer>

When no entry of the sheet answers the question, write none after ENTRIES, start the ANSWER with "the sheet does not say", then give the default the sheet states for that case.

Answer sheet:

{{ANSWER_SHEET}}

Question:

{{QUESTION}}
```

**Turns.** An operator turn is one QUESTION→ANSWER exchange, and the Limits table bounds everything
around it. Worked example: a run of 12 exchanges gets its 13th question answered by that table's
fixed text and its 14th ends the run `incomplete`. A turn whose process exits with no `result` event
is an `error`, a kill at its **invocation deadline** included, and goes to the **retries** row; the
discarded attempt's usage goes to its unit's `discarded.json` (see Usage). The **artifact** is every file added or modified in the clone
relative to the pinned commit (`git status --porcelain --untracked-files=all`), copied to the
unit's `artifact/` at its path.

**Usage.** Tokens are summed per assistant message over a session transcript and its sub-agent
transcripts, deduplicated by `message.id`: `input_tokens + cache_creation_input_tokens +
cache_read_input_tokens + output_tokens` (the S-10 `report.md` §6 method). The usage of every retried or
interrupted attempt is appended, as `{ unit, phase, contestant, usage }` in a JSON array, to that
unit's own file, `units/<problem>/<contestant>/r<k>/<step>/discarded.json`, `<step>` being `contestant`,
`judge-<n>` or `build` and `unit` being the unit id of `round.json`, and counts in `spent`. Only the
task running that unit writes its file (on Ctrl-C too, once `killAll()` has ended its session), so no
file has two writers. The model probes belong to no unit and go to `units/_round/discarded.json`,
written only by `run.mjs` before any unit starts (`_` is outside a problem id's alphabet). `budget.mjs`
and `usage-rollup.mjs` sum every `discarded.json` under the units root. Sub-agents spawned = the
`Task` / `Agent` `tool_use` blocks in the contestant's stream-json. Wall time = first contestant
turn start to last contestant turn end, operator turns included.

**A unit** is one of: the contestant run of (problem, contestant, repeat `r<k>`), each judge
`judge-<n>` of that run, its build. Its directory is `units/<problem>/<contestant>/r<k>/`:

```text
contestant.json   { status: done|incomplete|failed, sessionId, operatorSessionId, contestantTurns,
                    operatorTurns, strayReplies, subAgents, wallMs, usage: { contestant, operator },
                    artifact: [paths], specLines, specWords }
artifact/  transcripts/<role>/  operator-log.md  stream-<n>.jsonl
clone/  tool/  operator/  judge-<n>/  build-clone/   role working directories (Containment per role)
judge-<n>/bundle.md   the anonymized bundle (S-3)
contestant/discarded.json  judge-<n>/discarded.json  build/discarded.json   one per unit, when it has any (see Usage)
discarded/<attempt>/   a discarded attempt's <role>/ transcripts and its streams
judge-<n>.json    { status: done|not-run, reason: invalid-reply|empty-artifact|null, label, raw,
                    parsed, scores: { coverage, coverageMax,
                    decisionsLeft, contradictions, acTotal, acExecutable, builderGuesses }, usage }
build.json        { status: done|failed|not-run, reason: empty-artifact|null,
                    hidden: { passed, total, flaky: [names], failed: [names] },
                    existing: { exitCode }, assumptions, diffstat, usage, wallMs }
build/            implementation.patch, ASSUMPTIONS.md, hidden-1.xml, hidden-2.xml, existing-suite.txt
```

Usage values are `{ input, cacheWrite, cacheRead, output, total }`. A unit is done when its JSON
file exists; a resume reruns every unit whose file is missing. `stream-<n>.jsonl` is one file per
`claude -p` invocation of the contestant run, contestant and operator turns alike, `<n>` counting from
1 in invocation order; `countSubAgents` reads them all (an operator turn has no tools, so it adds none).
Each judge's stream is `judge-<n>.stream.jsonl` (a retry overwrites it) and the builder's is
`build/stream.jsonl`.

**Judging.** The bundle is the artifact's files in sorted path order, each under a
`=== file: <path> ===` header, with a leading YAML front matter block (a first line `---` through
the next `---`) stripped from every file and then every tell of the round's selected contestants (a
tell of a contestant not in the round stays) replaced by `[tool]`, case-insensitively and anchored at word boundaries
(`(?<![A-Za-z0-9_])<tell>(?![A-Za-z0-9_])`, so the `tlc` inside `atlc-lib` stays), in the path headers
too. Blinding stops there: a bundle
may still be identifiable by its structure (an AC table, a plan's checklist), which is accepted and
named in the report's confounds section. Labels `P`, `Q`, `R` name bundles in the judge's output
(`label` in `judge-<n>.json`) and in the private mapping `units/<problem>/labels-r<k>.json`. They are
assigned per (problem, repeat): the contestant ids, sorted, are shuffled by Fisher-Yates (from the
last index down, `j = floor(rand() * (i + 1))`) with mulberry32 as `rand`, whose 32-bit seed is the
first four bytes (big-endian) of the sha256 of `<seed>/<problem>/r<k>`, `<seed>` being `--seed`
(default: the sha256 of the round id); the contestant at index 0 gets `P`, index 1 `Q`, index 2 `R`.
Each judge is a fresh session per (judge, bundle). `judge-<n>/bundle.md` is the bundle text, opened by
a line `Bundle label: <label>`. The prompt, over stdin, is in this order `prompts/score-sheet.md`, then
`hidden/atoms.md`, then that bundle, joined by one blank line. `prompts/score-sheet.md` is a copy of
`docs/specs/2026-11-harnu-spec/bakeoff/judges/score-sheet.md` (it holds the schema below) with one
edit: its text "For every atom in `atoms.md` (R-1 to R-8, O-1 to O-16), say" becomes "For every id in
`atoms.md`, say". The reply must hold exactly one fenced `json` block of this schema and nothing after
it:

```json
{
  "spec": "<the label you were given>",
  "atoms": { "R-1": "covered", "R-2": "partial", "...": "..." },
  "decisions_left": ["<decision>", "..."],
  "contradictions": ["<statement A> vs <statement B>", "..."],
  "acceptance_criteria": { "total": 0, "executable": 0 },
  "builder_guesses": ["<question>", "..."],
  "notes": "<at most three sentences>"
}
```

A reply is valid when `spec` equals the bundle's label, every value of `atoms` is `covered`, `partial`,
`contradicted` or `missing`, `decisions_left`, `contradictions` and `builder_guesses` are arrays of
strings, `acceptance_criteria.total` and `.executable` are integers with
`0 <= executable <= total`, and `notes` is a string; an id in `atoms` that is not in `atoms.md` is
ignored. Anything else goes to the Limits row **retries**. Scores: `coverage` = Σ (`covered` 1,
`partial` 0.5, else 0) over the ids of `atoms.md` (an id the judge omits counts `missing`),
`coverageMax` = the id count, `decisionsLeft` / `contradictions` / `builderGuesses` = the lengths of
`decisions_left` / `contradictions` / `builder_guesses`, `acTotal` / `acExecutable` =
`acceptance_criteria.total` / `.executable`; `notes` is the judge note the report lists.

**The build.** A fresh target checkout; the artifact copied in and committed as `spec bundle`; one
builder session with `prompts/builder.md`, whose source is the instruction under _The build test_ in
`docs/specs/2026-11-harnu-spec/bakeoff/protocol.md`. Its whole text, with `{{ARTIFACT_PATHS}}` filled
with the artifact's paths, one per line, and `{{TEST_COMMAND}}` with the problem's `test`:

```text
The spec for this change is committed in this repository at:
{{ARTIFACT_PATHS}}

Implement it from the spec yourself. Use no skills and no sub-agents.
Log every assumption the spec did not settle in ASSUMPTIONS.md at the repository root, one numbered item per assumption (1. , 2. , and so on).
Run the existing suite with: {{TEST_COMMAND}}
Commit locally.
```

After the builder session has ended, the hidden files are copied to
`hidden.dest` and `hidden.cmd` runs twice. The tests counted are the `testcase`s (`<classname>::<name>`)
that validation recorded on the reference patch; `hidden.total` is that count, and a test counts as
passed only when it passes in both runs. A test that passes in one of the two runs and fails in the
other counts as failed and is listed in `flaky`. A run whose JUnit XML is missing or corrupt counts
every test in that run as failed (so both runs in that state give a pass rate of 0), and those
failures are not `flaky`. A builder session that errors or hits its **invocation deadline** does not
stop the build: `hidden.cmd` still runs on whatever the builder left in the clone, and `build.json`
gets `status: failed`. Then `test` runs once. `assumptions` = the lines of `ASSUMPTIONS.md` matching `^\d+\. `, 0 when it is missing. A run with an empty artifact runs no judge or builder
session: the harness writes every `judge-<n>.json` and `build.json` with `status: not-run` and
`reason: empty-artifact`, and `resume` treats them as done. Its hidden pass rate is 0, its coverage 0
and its other judge measures `n/a`.

**Validation** of a problem runs only when its cache key is stale. A problem's **content hash** is
the sha256 over the sorted relative paths and bytes of every file of its directory, except that
`problem.json` contributes `JSON.stringify` of its parsed object with the `provenance` key deleted, so
`review`, which writes only `provenance`, invalidates neither the validation key nor `compare`'s
shared-problem check; the key is the
sha256 of that hash plus the stdout of the problem's `versions` command, run before `setup`; the result
is cached at `<validation root>/<key>.json`, the root being the split's (see Where things are
written). On a pristine checkout `hidden.cmd` must fail, one of two ways. A non-zero exit whose
stdout or stderr matches the regex `hidden.compileErrorPattern` is a compile or import failure and
counts as failing on pristine even with zero testcases and no JUnit XML. Otherwise it must produce
JUnit XML with at least one `testcase` and at least one `testcase` with a `failure` child, by JUnit
count: missing or corrupt XML, zero testcases, or an `error` child whose message matches `/collect/i`
(a collection failure) fails validation. With `hidden/reference.patch` applied by `git apply` and the hidden files copied in after it, it runs
3 times, every test passes every time, its `testcase` set is recorded as `testSet`, a sorted `string[]`
of `<classname>::<name>`, and `test` exits 0. A `setup`
or `test` that reaches the Limits row **validation limit** fails validation.

**The report** (`report.md` and `report.json`) covers its round's one split; dev and holdout are
reported by separate rounds, never pooled. It opens with a header: round id, split, status,
`dryRun`, the models and the resolved pins, and neither file carries a generation timestamp, so
regenerating them with `report` is byte-identical. `report.md` shows every number to 2 decimals;
`report.json` and `problems.json` keep the unrounded values, which are what `compare` reads. A **dev** report has, per measure, one table with rows =
problem × contestant, columns = every run's value, the mean and the **spread** (max − min across
repeats, the variance measure), then a summary row per contestant (mean of the problem means, mean
of the problem spreads). A **holdout** report has, per measure, only the per-contestant row: mean,
spread and `n` (the number of holdout problems), as D-12 resolved. The measures:

1. hidden-test pass rate (headline, % of hidden tests)
2. coverage (% of atoms, judge mean per run)
3. decisions left to the implementer (judge mean)
4. contradictions (judge mean)
5. executable-proof share (judge mean of `acExecutable / acTotal`; a judge with `acTotal` 0 gives
   `n/a` and is left out of the mean)
6. builder guesses (judge mean) and assumptions logged (builder)
7. cost per run: tokens total and output, wall time, operator turns, sub-agents, spec lines and words
8. runs: done, incomplete, failed, judges `not-run` with `reason: invalid-reply`, flaky hidden tests

Then **budget**: cap, spent (the same number as `round.json`'s), remaining, status, tokens by phase (contestant, operator, judge, build,
discarded) and by contestant; `scripts/eval/bakeoff/usage-rollup.mjs` computes them from each unit's
`contestant.json`, `judge-<n>.json` and `build.json` and from every `discarded.json` under the units root. Then
**confounds**: a fixed section naming what the design does not blind or hold constant, starting with
the structural identifiability a bundle keeps (see Judging). Dev rows name problems and list failed
hidden test names and judge notes. **A holdout report and `compare` expose aggregates only** (D-12): no
per-problem row, problem id, `H-n` label, kind, language, request, atom, judge note, assumption or
test name; those stay in the private round directory.

**Round files.** Exact keys; a module writes no other.

```jsonc
// round.json, at <main checkout>/.harnu/eval/bakeoff/<round-id>/
{
  "roundId": "20261108-091500",
  "split": "dev", // dev | holdout
  "status": "running", // running | done | aborted-budget | interrupted
  "dryRun": false,
  "args": {
    "problems": null,
    "withTlc": false,
    "skillRef": "HEAD",
    "repeats": 2,
    "judges": 3,
    "model": "opus",
    "operatorModel": "sonnet",
    "judgeModel": "sonnet",
    "budget": 400000000,
    "jobs": 4,
    "seed": null,
    "dryRun": false,
    "after": null
  }, // the string "redacted" on a holdout round
  "seed": "<--seed, or the sha256 of the round id>",
  "repeats": 2,
  "judges": 3,
  "models": { "contestant": "<full id>", "operator": "<full id>", "judge": "<full id>" },
  "pins": { "harnu-spec": "<40 hex>", "superpowers": "<40 hex>" }, // contestant id -> resolved sha
  "budget": { "cap": 400000000, "spent": 0 },
  "problems": [{ "id": "<id>", "contentHash": "<sha256>" }], // [] on a holdout round
  "units": [{ "unit": "<problem>/<contestant>/r<k>/contestant", "state": "pending" }],
  // unit ends in /contestant, /judge-<n> or /build; state pending | running | done; [] on a holdout round
  "startedAt": "<ISO-8601>",
  "finishedAt": null // <ISO-8601> when the round ends
}
```

```jsonc
// problems.json, at $HARNU_BAKEOFF_HOLDOUT/.rounds/<round-id>/ (holdout rounds only)
{
  "roundId": "20261115-101200",
  "args": { "...": "round.json's args object, in full" },
  "problems": [
    {
      "id": "<id>",
      "label": "H-1",
      "contentHash": "<sha256>",
      "contestants": {
        "harnu-spec": {
          "measures": {
            "hiddenPassRate": { "values": [94.3, 96.2], "mean": 95.25, "spread": 1.9 }
            // one key per report.json measure
          }
        }
      }
    }
  ],
  "units": [{ "unit": "<problem>/<contestant>/r<k>/contestant", "state": "done" }]
}
```

`problems.json` has two writers, each with its own keys. S-5's `round.mjs` writes every key except
`measures`: `roundId`, `args`, `units` and each problem's `id`, `label`, `contentHash` and
`contestants: { "<contestant id>": {} }`. S-6's `writeReport` reads the file, sets each
`contestants[<id>].measures`, and leaves every other key as it found it.

```jsonc
// labels.json, beside problems.json: keys exactly H-1 to H-n, sorted by id
{ "H-1": "<id>", "H-2": "<id>", "H-3": "<id>" }
```

```jsonc
// report.json, beside report.md
{
  "roundId": "20261108-091500",
  "split": "dev",
  "status": "done",
  "dryRun": false,
  "models": { "contestant": "<full id>", "operator": "<full id>", "judge": "<full id>" },
  "pins": { "harnu-spec": "<40 hex>", "superpowers": "<40 hex>" },
  "repeats": 2,
  "judges": 3,
  "measures": {
    // keys: hiddenPassRate (percent, 0-100), coverage, decisionsLeft, contradictions, executableShare,
    // builderGuesses, assumptions, tokensTotal, tokensOutput, wallMs, operatorTurns, subAgents,
    // specLines, specWords
    "hiddenPassRate": {
      "rows": [
        {
          "problem": "<id>",
          "contestant": "harnu-spec",
          "values": [96.2, 100],
          "mean": 98.1,
          "spread": 3.8
        }
      ],
      // rows: dev only, absent on a holdout report
      "summary": [{ "contestant": "harnu-spec", "mean": 98.1, "spread": 3.8, "n": 6 }]
    }
  },
  "runs": [
    {
      "contestant": "harnu-spec",
      "done": 12,
      "incomplete": 0,
      "failed": 0,
      "judgesInvalidReply": 0,
      "flakyHiddenTests": 1
    }
  ],
  "details": [
    {
      "problem": "<id>",
      "contestant": "harnu-spec",
      "repeat": 1,
      "failedHiddenTests": ["<name>"],
      "judgeNotes": ["<note>"]
    }
  ],
  // details: dev only, absent on a holdout report
  "budget": {
    "cap": 400000000,
    "spent": 0,
    "remaining": 400000000,
    "status": "done",
    "byPhase": { "contestant": 0, "operator": 0, "judge": 0, "build": 0, "discarded": 0 },
    "byContestant": { "harnu-spec": 0, "superpowers": 0, "unattributed": 0 } // model probes are unattributed
  },
  "confounds": ["<text>"]
}
```

`compare` reads `split`, `status`, `dryRun`, `models`, `judges`, `repeats` and `pins` from each
`round.json`. On dev it reads the content hashes from `round.json`'s `problems` and the per-problem
means and spreads from `report.json`'s `measures.hiddenPassRate.rows`; on holdout it reads both from
each round's `problems.json` (`problems[].contentHash`,
`problems[].contestants["harnu-spec"].measures.hiddenPassRate`), and a holdout `report.json` carries
only the aggregates. `baselineSkillSha` and `candidateSkillSha` in `compare.json` are the two rounds'
`pins["harnu-spec"]`; a baseline contestant's pin is every other `pins` entry.

**The acceptance rule** (D-5), `compare <baseline> <candidate>`, compares two rounds of one split,
for contestant `harnu-spec` only; the baseline contestants are in a round as a control and are not
scored by `compare`. Only hidden-test pass rate (measure 1) feeds `compare`; every other measure is
reported only. The rule is deliberately coarse: it is not a statistical test, and its floor of 2
percentage points on `S` and `SH` is D-13's resolution. `compare` matches
problems by real id internally (labels are not part of the comparison), and a problem counts as
shared only when its content hash matches in both rounds. Before any verdict, in this order:

- rounds of different splits exit 2 naming `split`;
- a dry-run round, or a round whose status is not `done`, is **incomplete**;
- rounds that differ on contestant model, operator model, judge model, judge count, repeats or a
  baseline contestant's pin exit 2 naming the first field that differs (seeds may differ);
- an empty shared set exits 2 with `NO_SHARED_PROBLEMS`; a holdout comparison without the holdout
  variable exits 2 with `HOLDOUT_UNSET`.

Then, over the shared problems, in percentage points of hidden pass rate, on unrounded values:

- dev gain `G` = mean of (candidate mean − baseline mean); dev spread `S` = max(the larger of the
  two rounds' mean per-problem spread, 2); a dev comparison is **accepted** when `G > S`;
- holdout delta `H` and holdout spread `SH` = max(the larger of the two rounds' mean per-problem
  spread, 2), likewise; a holdout comparison is **accepted** when `H ≥ −SH` (D-9: a holdout drop
  larger than its own repeat spread is a regression);
- otherwise **rejected**. Exit 0 accepted, 1 rejected or incomplete, 2 refused.

A skill change is accepted only when its dev comparison and then its holdout comparison are both
accepted. Each comparison writes `compare.json` in the candidate round's directory:
`{ split, verdict, baseline, candidate, baselineSkillSha, candidateSkillSha }`. **The holdout round
runs only when `compare` accepted on dev:** `run --split holdout --after <candidate dev round id>`
exits 2 with `DEV_NOT_ACCEPTED` unless that round's `compare.json` has `split: dev`,
`verdict: accepted` and `--skill-ref` resolves to its `baselineSkillSha` or `candidateSkillSha` (so
one dev acceptance authorizes both the baseline's and the candidate's holdout round).

**Freshness** (D-10) applies to the holdout only. `$HARNU_BAKEOFF_HOLDOUT/.rounds/usage.json` is exactly
`{ "counts": { "<contentHash>": <n> }, "pairs": ["<baselineRoundId>:<candidateRoundId>"] }`, and starts
as `{ "counts": {}, "pairs": [] }` when absent. An accepted holdout `compare` whose pair is not in
`pairs` adds one to `counts` for each shared problem's content hash and appends the pair; a pair
already in `pairs` changes nothing, so a pair is counted once. Either way it prints a warning line
when any shared holdout problem's count exceeds 3, giving how many problems and no id, prompting a
fresh problem. The dev corpus is fixed per corpus version: S-7's
six problems are v1, and changing one makes a new version. Rule 4 (R-14) asks for problems authored
after the last skill change; D-10 resolved it to the usage warning above, in place of a mechanical
check of `authoredAt` against the skill's last commit.

**The CLI.** `npm run eval:bakeoff -- <command>` (`vite-node scripts/eval/bakeoff/run.mjs --`).
`run.mjs` (S-5) holds this table as a constant and never changes after S-5: each command names the
module and handler that implement it. Dispatch imports the module dynamically; a module that does
not exist yet or lacks the handler makes the command exit 2 with `NOT_YET`. S-6 and S-7 add their
commands by creating the listed module and exporting the listed handler, never by editing `run.mjs`.
`run` and `resume` write their report by calling the table's `report` row; while that module is absent
(S-5 alone) no report is written and the exit code is unaffected.

| command                                                                                | slice | module · handler                      | does                                                                                                                                 |
| -------------------------------------------------------------------------------------- | ----- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `run [flags]`                                                                          | S-5   | `round.mjs` · `runCommand`            | validate, then run every unit, then write the report through the `report` row                                                        |
| `resume <round-id> [--budget <tokens>]`                                                | S-5   | `round.mjs` · `resumeCommand`         | rerun the units without a result file, then write the report through the `report` row                                                |
| `report <round-id>`                                                                    | S-6   | `report.mjs` · `reportCommand`        | rewrite `report.md` / `report.json` from the unit files                                                                              |
| `compare <baseline-round-id> <candidate-round-id>`                                     | S-6   | `compare.mjs` · `compareCommand`      | the acceptance verdict above, for two rounds of one split                                                                            |
| `validate [--split] [--problems]`                                                      | S-4   | `validate.mjs` · `validateCommand`    | validation only                                                                                                                      |
| `list [--split]`                                                                       | S-6   | `list.mjs` · `listCommand`            | dev problems with kind and language; for the holdout, the problem count only                                                         |
| `author-sandbox <id> --split <dev\|holdout> --repo <url> --commit <sha> --pick <file>` | S-7   | `author.mjs` · `authorSandboxCommand` | prepare the D-7 author sandbox (S-7)                                                                                                 |
| `author-import <id> --split <dev\|holdout> --reference <file>`                         | S-7   | `author.mjs` · `authorImportCommand`  | copy a finished sandbox problem into its corpus root, add `--reference` as `hidden/reference.patch`, stamp `sandbox: true`, validate |
| `review <id> --split <dev\|holdout>`                                                   | S-7   | `author.mjs` · `reviewCommand`        | print request, answer sheet and atoms from that split's corpus root; on `y`, stamp `reviewedAt/By`                                   |

`run` flags and defaults: `--split dev` (`dev` or `holdout`; a round is one split, and the dev round
runs first), `--after <round-id>` (required by `--split holdout`), `--problems <ids>` (all; refused
with `--split holdout`, see Holdout on the terminal), `--with-tlc`, `--skill-ref HEAD`, `--repeats 2`,
`--judges 3`, `--model opus`, `--operator-model sonnet`, `--judge-model sonnet`,
`--budget 400000000` (D-11), `--jobs` (default and ceiling `floor(os.availableParallelism() / 2)`, at least 1; a higher
value is clamped with a warning line), `--seed`, `--dry-run`. A round id is the UTC start time
`YYYYMMDD-HHMMSS`. `author-sandbox`, `author-import` and `review` require `--split`, exactly `dev` or
`holdout`; a missing or other value exits 2 with `SPLIT_REQUIRED`. On `run`, `validate` and `list`,
`--split` is optional and defaults to `dev`; a value other than `dev` or `holdout` exits 2 with
`SPLIT_REQUIRED`. `main` makes both checks before dispatch, so they hold while a command's module is
still absent.
Exit codes: 0 finished, 2 usage or configuration error (including validation failure, an
unreviewed problem, containment, `JUDGE_MODEL_SAME`, `MODEL_UNRESOLVED`, `DEV_NOT_ACCEPTED`,
`PROBLEMS_ON_HOLDOUT`, `PICK_MISSING`, `REFERENCE_MISSING`, `SPLIT_REQUIRED`, `NOT_YET`), 3 aborted on budget, 130 interrupted.

**Budget** (D-6, D-11). A round is one split, and the cap applies per round. Its default is 400M
(D-11, which supersedes D-6's 300M). S-10 (`report.md` §6) measured about 16.6M tokens per problem-run
for `harnu-spec` (11.69M spec plus 4.94M build) and 8.8M for Superpowers (5.04M plus 3.79M), so about
25M per problem per repeat for the two default contestants, before judges: 6 dev problems × 2 repeats
≈ 300M and 3 holdout problems × 2 repeats ≈ 150M. A default dev round fits the 400M cap with room for
its judges; `resume --budget` raises the cap when a round needs more, and the holdout round runs only
after `compare` accepts on dev. `round.json` keeps `budget: { cap, spent }`. Before a unit starts, the round's spent tokens (every
finished unit's usage plus every entry of every `discarded.json` under the units root, retries and interrupted attempts
included) are compared with the cap: at or above it, no new unit
starts, units in flight finish, `round.json` gets `status: aborted-budget`, the report is written
with what exists, and the exit code is 3. The cap can be overrun by the units in flight at most.
`resume` keeps the cap unless `--budget` raises it. Ctrl-C (SIGINT) kills every session the harness
started (`killAll()` in `claude.mjs`, through `escalate`), moves their transcripts out of `HARNU_BAKEOFF_CLAUDE_PROJECTS` into each unit's
`discarded/<attempt>/<role>/`, adds their usage to each unit's own `discarded.json` and exits 130; `resume` reruns the
interrupted units.

**Dry run.** `--dry-run` swaps the corpus for `scripts/eval/bakeoff/fixtures/dry-run/` (one
`inline` JavaScript problem whose suites run with `node --test`), runs one contestant (`harnu-spec`),
sets every model to `haiku`, `--repeats 1`, `--judges 1`, `--budget 10000000`, runs split `dev`,
waives `JUDGE_MODEL_SAME`, and stamps `dryRun: true` on the round; `compare` treats a dry round as
incomplete. AC-44 proves these overrides.

The fixture is one small problem, `scripts/eval/bakeoff/fixtures/dry-run/slugify-basic/`, written in
full by S-5 and already reviewed, so a dry run needs no `review`:

- `problem.json`: `id` `slugify-basic`, `split` `dev`, `kind` `feature`, `language` `javascript`,
  `target` `{ "inline": "source" }`, `setup` `[]`, `versions` `node --version`, `test`
  `node --test test/index.test.js`, `hidden.files` `["slugify.hidden.test.js"]`, `hidden.dest` `test/`,
  `hidden.cmd` `node --test --test-reporter=junit --test-reporter-destination="$BAKEOFF_JUNIT" test/slugify.hidden.test.js`,
  `hidden.compileErrorPattern` `(SyntaxError|Cannot find module)`, and `provenance` with `authoredAt`
  and `reviewedAt` `2026-11-09T00:00:00Z`, `authoredBy` and `reviewedBy` `bakeoff dry-run fixture`,
  `sandbox` `false`;
- `pick.md`: one line saying the problem is a hand-written fixture with no candidates;
- `request.md`: add and export `slugify(text)` from `index.js`, which lowercases the text, replaces every
  run of characters other than letters and digits with one hyphen, and trims hyphens from both ends;
- `answer-sheet.md`: the S-10 entries G-1, G-2 and G-4 verbatim;
- `hidden/atoms.md`: three rows, `A-1` lowercases, `A-2` collapses each run into one hyphen, `A-3` trims
  both ends;
- `hidden/slugify.hidden.test.js`: three `node:test` tests, one per atom, importing `slugify` from
  `../index.js`;
- `hidden/reference.patch`: adds `slugify` to `index.js` and nothing else;
- `source/`: `package.json` (`{ "type": "module" }`), `index.js` exporting only `identity(x)`, and
  `test/index.test.js` with one passing test of `identity`.

**The author sandbox** (D-7). `author-sandbox` builds the split's authoring directory (see Where
things are written) with `harnu/` (`git archive HEAD` extracted, minus the exclusion list below),
`target/` (the checkout of the given pin), `out/<id>/` (a problem skeleton with `problem.json`
prefilled: id, split, target, `provenance.reviewedAt: null`, plus `pick.md`, copied from `--pick`) and
`AUTHORING.md` (`prompts/author.md`). A missing or empty `--pick` file exits 2 with `PICK_MISSING`.
The authoring session never picks: the pick is made outside the sandbox (S-7's pick rule) and arrives
as `pick.md`. Authoring is headless. `author-sandbox` prints the command, which runs from the sandbox
directory: `claude -p --model opus --tools Read,Write,Edit,Bash,Glob,Grep --allowedTools Read,Write,Edit,Bash,Glob,Grep --setting-sources project --max-turns 200`,
with exactly this prompt on stdin: `Read AUTHORING.md and do what it says. Stop when every file it lists exists.`
The S-7 executor runs it (for a holdout problem, the operator). The session has handed back when the
command exits 0 and `author-import` then passes; anything else is a failed authoring session.
`author-import` refuses a
problem whose sandbox still contains any path of the exclusion list and writes a holdout problem
only under `$HARNU_BAKEOFF_HOLDOUT`. It writes the `--reference` file to the problem's
`hidden/reference.patch`, replacing any file of that name, and exits 2 with `REFERENCE_MISSING` on a
missing or empty `--reference` file. The reference patch never enters the sandbox directory.

The **exclusion list**: `resources/skills/**`, `docs/specs/**` (so `docs/specs/2026-11-harnu-spec/**`
and `docs/specs/2026-11-07-bakeoff-harness/**`), `docs/prds/T601*`, `docs/prds/T676*`,
`docs/adr/0025-bakeoff-harness.md`, `docs/harnu-features.md`, `docs/user/bundled-skills.md`,
`docs/dev/bakeoff.md`, `docs/lessons/**`, `.harnu/**`, `CHANGELOG.md`, `scripts/eval/bakeoff/**`,
`tests/eval-bakeoff-*`, `tests/fixtures/eval-bakeoff/**`, `tests/fixtures/spec-check/**`,
`tests/fixtures/spec-skill/**`, `tests/spec-*.test.ts`, `tests/bundled-spec-skill.test.ts` and
`tests/orchestrate-spec-integration.test.ts`. The list is a rule, not a snapshot: a test greps the
built sandbox (everything but `target/`) for the deny-list `harnu:spec`, `Goldfish`, `Elephant` and
`spec-check` and fails on a hit, naming the file; a new hit is fixed by extending the list. When `main` moves, a PR
that adds a doc naming the skill extends this list in the same PR, and the test's failure message says
so. Measured
on 2026-11-08 at `7218b48d`: the deny-list grep over tracked files hits 48 files at that commit (`CHANGELOG.md`, 13 under `docs/`, 12 under `resources/`, 22 under
`tests/`), every one under a path already on this list, so the list above is the pre-seed and needs
nothing added.

**Module signatures.** The exported functions of the modules in the slices' `produces:`. A **coded
error** is the object `{ code, message }`, returned and never thrown. `Usage` is the object of Usage
above; `Problem` is a parsed `problem.json` plus `dir`. A **command handler** takes `(args, ctx)`,
`args` being the parsed flags plus `positional` and `ctx` being
`{ roots, models, stdout, stderr, stdin, env }`, and returns an exit code or a coded error, which
`run.mjs` prints before exiting 2.

| module               | export                                                         | arguments                                                                                                                                                                                                                                                                                                                                                                                                                                                  | returns                                                                                                                                                                                                                                                                                                         |
| -------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `paths.mjs`          | `resolveRoots`                                                 | `{ split, env }` (`env` defaults to `process.env`)                                                                                                                                                                                                                                                                                                                                                                                                         | `{ repo, mainCheckout, cache, work, holdout }` (`holdout` null on dev when unset), or a coded error                                                                                                                                                                                                             |
| `paths.mjs`          | `unitsRoot`, `validationRoot`, `authoringRoot`                 | `(roots, split)` (`unitsRoot` also `roundId`)                                                                                                                                                                                                                                                                                                                                                                                                              | absolute path from Where things are written                                                                                                                                                                                                                                                                     |
| `paths.mjs`          | `repoRoundDir`, `privateRoundDir`                              | `(roots, roundId)`                                                                                                                                                                                                                                                                                                                                                                                                                                         | absolute path of the round's repo-side or `.rounds/` directory                                                                                                                                                                                                                                                  |
| `corpus.mjs`         | `loadCorpus`                                                   | `(root, { split, forRun })`; `forRun` (default false): true also refuses `reviewedAt` null                                                                                                                                                                                                                                                                                                                                                                 | `{ problems: Problem[], errors: { code, message, file, field }[] }`                                                                                                                                                                                                                                             |
| `corpus.mjs`         | `contentHash`                                                  | `(problemDir)`                                                                                                                                                                                                                                                                                                                                                                                                                                             | hex sha256 as Validation defines it                                                                                                                                                                                                                                                                             |
| `checkout.mjs`       | `checkoutTarget`                                               | `(problem, dest, { cacheRoot, setup })`; `setup` default true runs `problem.setup`                                                                                                                                                                                                                                                                                                                                                                         | `{ dir, commit }`, or a coded error `CHECKOUT_FAILED` or `SETUP_FAILED`                                                                                                                                                                                                                                         |
| `checkout.mjs`       | `runProblemCommand`                                            | `(cmd, cwd, { timeoutMs, env })`                                                                                                                                                                                                                                                                                                                                                                                                                           | `{ exitCode, stdout, stderr, timedOut, ms }`                                                                                                                                                                                                                                                                    |
| `limits.mjs`         | `limits`                                                       | an object, not a function                                                                                                                                                                                                                                                                                                                                                                                                                                  | `{ operatorExchanges, strayReplies, retries: { noResult, invalidJudgeReply }, maxTurns: { contestant, operator, judge, builder }, invocationMs: { contestant, operator, judge, builder }, runMs, commandMs, validationMs }`; the `*Ms` fields are getters that apply `HARNU_BAKEOFF_TIMEOUT_SCALE` at each read |
| `claude.mjs`         | `runClaude`                                                    | `{ role, prompt, cwd, model, tools, addDirs, sessionId, resume, deadlineMs, maxTurns, streamPath }`                                                                                                                                                                                                                                                                                                                                                        | `{ status, resultText, sessionId, killed, exitCode, ms }`, `status` being `result` or `error`                                                                                                                                                                                                                   |
| `claude.mjs`         | `resolveModel`                                                 | `(names, opts)`: `names` a list; `opus`, `sonnet`, `haiku` are aliases, anything else a full id                                                                                                                                                                                                                                                                                                                                                            | `{ ids: { <name>: <full id> }, probes: Usage[] }`, or a coded error `MODEL_UNRESOLVED`                                                                                                                                                                                                                          |
| `claude.mjs`         | `moveTranscripts`                                              | `(sessionIds, destDir)`: `destDir` is the caller's role directory                                                                                                                                                                                                                                                                                                                                                                                          | `{ moved: string[] }`                                                                                                                                                                                                                                                                                           |
| `claude.mjs`         | `killAll`                                                      | `()`: kills every running child through `escalate`, for Ctrl-C                                                                                                                                                                                                                                                                                                                                                                                             | promise of the killed session ids, `string[]`                                                                                                                                                                                                                                                                   |
| `usage.mjs`          | `sumUsage`                                                     | `(dir)`: one role directory `transcripts/<role>/`, sub-agent transcripts included                                                                                                                                                                                                                                                                                                                                                                          | `Usage`, deduplicated by `message.id`                                                                                                                                                                                                                                                                           |
| `usage.mjs`          | `countSubAgents`                                               | `(streamPaths)`                                                                                                                                                                                                                                                                                                                                                                                                                                            | number                                                                                                                                                                                                                                                                                                          |
| `contestants.mjs`    | `contestants`                                                  | a constant                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `{ id, source, entry, stopPoint, tells, specFile }[]`                                                                                                                                                                                                                                                           |
| `contestants.mjs`    | `selectContestants`                                            | `({ withTlc })`                                                                                                                                                                                                                                                                                                                                                                                                                                            | the round's contestants                                                                                                                                                                                                                                                                                         |
| `contestants.mjs`    | `resolveTool`                                                  | `(contestant, { skillRef, repo, cacheRoot, dest, sources })`; `sources`, optional, maps a contestant id to a local git repository path that replaces its remote (`repo` for `harnu-spec`), whose `HEAD` replaces the pin of `superpowers` and `tlc-spec-driven` (AC-7)                                                                                                                                                                                     | `{ sha }`, or a coded error `TOOL_FETCH_FAILED`                                                                                                                                                                                                                                                                 |
| `contestant-run.mjs` | `runContestant`                                                | `{ problem, contestant, repeat, unitDir, roots, skillRef, answerSheetPath, model, operatorModel }`; reads `problem.id`, `problem.dir` (for `request.md`) and `problem.target`; `contestant` is one `contestants` entry; `roots` gives `repo` and `cache` to `resolveTool` and `checkoutTarget`; `answerSheetPath` is `<problem.dir>/answer-sheet.md`                                                                                                       | the `contestant.json` object                                                                                                                                                                                                                                                                                    |
| `anonymize.mjs`      | `buildBundle`                                                  | `(artifactDir, tells)`                                                                                                                                                                                                                                                                                                                                                                                                                                     | the bundle text                                                                                                                                                                                                                                                                                                 |
| `anonymize.mjs`      | `assignLabels`                                                 | `(seed, problemId, repeat, contestantIds)`                                                                                                                                                                                                                                                                                                                                                                                                                 | `{ P: <contestant id>, Q: …, R: … }`                                                                                                                                                                                                                                                                            |
| `judge.mjs`          | `runJudge`                                                     | `{ problem, contestant, repeat, n, unitDir, artifactDir, tells, seed, contestantIds, model }`; reads `problem.id` and `problem.dir` (for `hidden/atoms.md`); `tells` is the union over the round's selected contestants and `contestantIds` their ids; builds the bundle with `buildBundle`, takes the label from `assignLabels`, writes `judge-<n>/bundle.md` and `units/<problem>/labels-r<k>.json` (the same bytes from every judge, written by rename) | the `judge-<n>.json` object                                                                                                                                                                                                                                                                                     |
| `judge.mjs`          | `scoreReply`                                                   | `(parsed, atomIds)`                                                                                                                                                                                                                                                                                                                                                                                                                                        | the `scores` object                                                                                                                                                                                                                                                                                             |
| `build.mjs`          | `runBuild`                                                     | `{ problem, unitDir, artifactDir, roots, model, testSet }`; reads `problem.id`, `problem.dir` (for `hidden/`), `problem.target`, `problem.setup`, `problem.test` and `problem.hidden`; `roots.cache` goes to `checkoutTarget`; `testSet` is the `string[]` from `validateProblem`                                                                                                                                                                          | the `build.json` object                                                                                                                                                                                                                                                                                         |
| `junit.mjs`          | `parseJunit`                                                   | `(xml)`                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `{ testcases: { name, status }[] }`, `name` being `<classname>::<name>` and `status` `passed`, `failed`, `error` or `skipped`; or a coded error `JUNIT_CORRUPT`                                                                                                                                                 |
| `validate.mjs`       | `validateProblem`                                              | `(problem, roots)`                                                                                                                                                                                                                                                                                                                                                                                                                                         | `{ ok, key, testSet, defects }`; `testSet` is the sorted `string[]` of Validation                                                                                                                                                                                                                               |
| `validate.mjs`       | `validateCommand`                                              | command handler                                                                                                                                                                                                                                                                                                                                                                                                                                            | exit code or coded error                                                                                                                                                                                                                                                                                        |
| `run.mjs`            | `assertJudgeModel`                                             | `(contestantId, judgeId, { dryRun })`, full ids                                                                                                                                                                                                                                                                                                                                                                                                            | `null`, or a coded error `JUDGE_MODEL_SAME`                                                                                                                                                                                                                                                                     |
| `run.mjs`            | `main`                                                         | `(argv)`: for `run`, calls `resolveModel` and `assertJudgeModel` before the handler                                                                                                                                                                                                                                                                                                                                                                        | the exit code                                                                                                                                                                                                                                                                                                   |
| `round.mjs`          | `runCommand`, `resumeCommand`                                  | command handler                                                                                                                                                                                                                                                                                                                                                                                                                                            | exit code or coded error                                                                                                                                                                                                                                                                                        |
| `budget.mjs`         | `spentTokens`                                                  | `(unitsRoot)`                                                                                                                                                                                                                                                                                                                                                                                                                                              | number: every unit's usage plus every entry of every `discarded.json` under the root                                                                                                                                                                                                                            |
| `budget.mjs`         | `canStart`                                                     | `(spent, cap)`                                                                                                                                                                                                                                                                                                                                                                                                                                             | boolean                                                                                                                                                                                                                                                                                                         |
| `report.mjs`         | `reportCommand`                                                | command handler                                                                                                                                                                                                                                                                                                                                                                                                                                            | exit code or coded error                                                                                                                                                                                                                                                                                        |
| `report.mjs`         | `writeReport`                                                  | `(roundId, ctx)`                                                                                                                                                                                                                                                                                                                                                                                                                                           | `{ mdPath, jsonPath }`                                                                                                                                                                                                                                                                                          |
| `compare.mjs`        | `compareCommand`                                               | command handler                                                                                                                                                                                                                                                                                                                                                                                                                                            | exit code or coded error                                                                                                                                                                                                                                                                                        |
| `compare.mjs`        | `compareRounds`                                                | `(baselineRoundId, candidateRoundId, ctx)`                                                                                                                                                                                                                                                                                                                                                                                                                 | `{ verdict, gain, spread, shared }`, or a coded error                                                                                                                                                                                                                                                           |
| `usage-rollup.mjs`   | `rollup`                                                       | `(unitsRoot)`                                                                                                                                                                                                                                                                                                                                                                                                                                              | `{ byPhase, byContestant }` of `report.json`'s `budget`                                                                                                                                                                                                                                                         |
| `list.mjs`           | `listCommand`                                                  | command handler                                                                                                                                                                                                                                                                                                                                                                                                                                            | exit code or coded error                                                                                                                                                                                                                                                                                        |
| `author.mjs`         | `authorSandboxCommand`, `authorImportCommand`, `reviewCommand` | command handler                                                                                                                                                                                                                                                                                                                                                                                                                                            | exit code or coded error                                                                                                                                                                                                                                                                                        |

**Loader error codes.** Each `loadCorpus` error's `code` is one of `JSON_INVALID`, `ID_MISMATCH`,
`SPLIT_MISMATCH`, `KIND_INVALID`, `COMMIT_INVALID`, `FIELD_MISSING` (`field` names it, for `versions` or
`hidden.compileErrorPattern`), `FILE_MISSING` (`file` names it, for `pick.md`, `request.md`,
`answer-sheet.md`, `hidden/atoms.md`, a hidden file or `hidden/reference.patch`), `ATOMS_EMPTY`,
`NOT_SANDBOXED` (a holdout problem whose `provenance.sandbox` is not true) and `NOT_REVIEWED`
(`provenance.reviewedAt` null with `forRun`).

## Goals

- G-1 One command runs a whole round, contestants to report, with nobody relaying anything, and a contributor reads per measure where `harnu:spec` stands against a baseline, per problem, with the noise beside every number.
- G-2 A skill change is accepted by a rule fixed in advance (dev gain above run-to-run spread, holdout not regressed), not by a reading of one problem.
- G-3 The holdout truth never enters the public repo, and no session tuning the skill is handed its path (privacy by convention: there is no OS sandbox).
- G-4 The S-10 result is reproduced mechanically, so the harness is trusted before BUG-259 and T674 are measured with it.

**Non-goals:**

- NG-1 The real-world signal from spec-born missions (deltas sent to executors, `unmet` ACs, builder guesses per mission) is not measured here; it is its own follow-up card, T678 (D-8). (R-19)
- NG-2 No standalone package, Python library or Agent SDK port: the harness stays `.mjs` under `scripts/eval/bakeoff/`, written so it can be extracted later. (R-3)
- NG-3 CI does not run the bake-off: a round costs real tokens and is started by hand. CI runs only the harness's unit tests, which use a fake `claude`. (R-18, R-5)
- NG-4 Corpus v1 has no UI and no greenfield problem: 6 dev + 3 holdout covers bug, feature and refactor in three languages; UI and greenfield problems come in a later corpus round. (R-11)
- NG-5 No entry in `docs/user/`, `docs/harnu-features.md` or `CHANGELOG.md`: an internal developer tool with no user- or agent-facing surface. (R-4)
- NG-6 The holdout problems themselves are not written by any slice: creating the private repo, authoring its three problems and cloning it outside the repo are operator actions. (R-13)
- NG-7 The harness never edits a skill and never proposes a skill change; it measures. (R-1)

**Anti-goals:**

- A report in which a holdout failure can be read in enough detail to fix the skill against it.
- A harness that is green because its scorer cannot fail: an artifact-less run scoring above 0, a missing judge counted as a perfect one, a flaky hidden test counted as a pass.
- A round that spends past its cap without stopping, or that needs a human in the loop to finish.

## Slices

Eight slices, one PR each. S-1 → S-2 are stacked; S-3 and S-4 both branch from S-2 and do not depend
on each other; S-5 branches from S-4 and merges S-3's branch as its first commit; then S-6 → S-7 → S-8
are stacked. S-7 ends with an operator action (reviewing the answer sheets, AC-26); the holdout repo
(NG-6) is the operator's after S-7.

### S-1 · Corpus format, loader and holdout containment

- depends-on: —
- substrate: worktree
- files-may-touch: `scripts/eval/bakeoff/corpus.mjs`, `scripts/eval/bakeoff/paths.mjs`, `scripts/eval/bakeoff/checkout.mjs`, `scripts/eval/bakeoff/limits.mjs`, `tests/eval-bakeoff-corpus.test.ts`, `tests/fixtures/eval-bakeoff/s1/**`
- produces: corpus-loader, holdout-containment, target-checkout, bakeoff-limits
- consumes: —
- acs: AC-1, AC-2, AC-3, AC-43

### S-2 · Runner: contestant sessions, simulated operator, usage capture

- depends-on: S-1
- substrate: worktree
- files-may-touch: `scripts/eval/bakeoff/claude.mjs`, `scripts/eval/bakeoff/usage.mjs`, `scripts/eval/bakeoff/contestants.mjs`, `scripts/eval/bakeoff/contestant-run.mjs`, `scripts/eval/bakeoff/prompts/contestant.md`, `scripts/eval/bakeoff/prompts/operator.md`, `tests/eval-bakeoff-runner.test.ts`, `tests/fixtures/eval-bakeoff/fake-claude.mjs`, `tests/fixtures/eval-bakeoff/s2/**`
- produces: claude-driver, contestant-run, usage-capture, contestant-registry
- consumes: corpus-loader, target-checkout, bakeoff-limits, existing:mission-behavior-eval
- acs: AC-4, AC-5, AC-6, AC-7, AC-40, AC-41, AC-42

### S-3 · Judges: blind bundles, a different model, the score sheet

- depends-on: S-2
- substrate: worktree
- files-may-touch: `scripts/eval/bakeoff/anonymize.mjs`, `scripts/eval/bakeoff/judge.mjs`, `scripts/eval/bakeoff/prompts/score-sheet.md`, `tests/eval-bakeoff-judge.test.ts`, `tests/fixtures/eval-bakeoff/s3/**`
- produces: judge-scores
- consumes: contestant-run, claude-driver, usage-capture, corpus-loader, contestant-registry, bakeoff-limits
- acs: AC-8, AC-9

### S-4 · Builder and hidden-test runner

- depends-on: S-1, S-2
- substrate: worktree
- files-may-touch: `scripts/eval/bakeoff/build.mjs`, `scripts/eval/bakeoff/junit.mjs`, `scripts/eval/bakeoff/validate.mjs`, `scripts/eval/bakeoff/prompts/builder.md`, `tests/eval-bakeoff-build.test.ts`, `tests/fixtures/eval-bakeoff/s4/**`
- produces: build-result, hidden-validation
- consumes: contestant-run, claude-driver, usage-capture, target-checkout, corpus-loader, bakeoff-limits
- acs: AC-10, AC-11

### S-5 · Round: scheduling, budget, resume, dry run and the `eval:bakeoff` entry

- depends-on: S-3, S-4
- substrate: worktree
- files-may-touch: `scripts/eval/bakeoff/run.mjs`, `scripts/eval/bakeoff/round.mjs`, `scripts/eval/bakeoff/budget.mjs`, `scripts/eval/bakeoff/fixtures/dry-run/**`, `package.json`, `tests/eval-bakeoff-round.test.ts`, `tests/fixtures/eval-bakeoff/s5/**`
- produces: round-state, bakeoff-cli
- consumes: contestant-run, judge-scores, build-result, hidden-validation, holdout-containment, claude-driver, bakeoff-limits, corpus-loader, contestant-registry, target-checkout
- acs: AC-12, AC-13, AC-15, AC-32, AC-33, AC-37, AC-38, AC-44

### S-6 · Reporter and the acceptance rule

- depends-on: S-5
- substrate: worktree
- files-may-touch: `scripts/eval/bakeoff/report.mjs`, `scripts/eval/bakeoff/compare.mjs`, `scripts/eval/bakeoff/usage-rollup.mjs`, `scripts/eval/bakeoff/list.mjs`, `tests/eval-bakeoff-report.test.ts`, `tests/fixtures/eval-bakeoff/s6/**`, `docs/specs/2026-11-07-bakeoff-harness/dry-run/**`
- produces: bakeoff-report, acceptance-compare
- consumes: round-state, bakeoff-cli, judge-scores, build-result, usage-capture, holdout-containment, corpus-loader, contestant-registry
- acs: AC-14, AC-16, AC-17, AC-18, AC-19, AC-20, AC-21, AC-31, AC-36, AC-39

### S-7 · Corpus v1, the author sandbox and the holdout scaffold

- depends-on: S-6
- substrate: worktree
- files-may-touch: `scripts/eval/bakeoff/corpus/dev/**`, `scripts/eval/bakeoff/author.mjs`, `scripts/eval/bakeoff/prompts/author.md`, `scripts/eval/bakeoff/HOLDOUT.md`, `tests/eval-bakeoff-corpus-v1.test.ts`, `tests/eval-bakeoff-author.test.ts`, `tests/fixtures/eval-bakeoff/s7/**`
- produces: corpus-v1, author-sandbox
- consumes: corpus-loader, hidden-validation, bakeoff-cli, holdout-containment, target-checkout
- acs: AC-22, AC-23, AC-24, AC-25, AC-26, AC-27, AC-34, AC-35

Dev corpus v1, fixed here. P1 is the S-10 input, migrated; P2–P6 are authored in the author sandbox.

| slot | id                      | language   | kind     | target                                                              |
| ---- | ----------------------- | ---------- | -------- | ------------------------------------------------------------------- |
| P1   | `sqlite-utils-json-key` | python     | feature  | `simonw/sqlite-utils` at `9c66bafa52ae23d40499c74b0db3b635bcddb876` |
| P2   | chosen by the pick rule | python     | bug      | by the pick rule                                                    |
| P3   | chosen by the pick rule | typescript | feature  | by the pick rule                                                    |
| P4   | chosen by the pick rule | typescript | refactor | by the pick rule                                                    |
| P5   | chosen by the pick rule | go         | bug      | by the pick rule                                                    |
| P6   | chosen by the pick rule | go         | refactor | by the pick rule                                                    |

P1's files are copied from `docs/specs/2026-11-harnu-spec/bakeoff/` (`input/answer-sheet.md`,
`hidden/atoms.md`, `hidden/test_hidden_bakeoff.py`, `hidden/reference.patch` byte for byte;
`request.md` = the quoted text under _The request_ of `input/feature-request.md`, unquoted); its
provenance is `authoredAt: 2026-11-07T15:09:11-03:00`, `authoredBy: T601 S-10 orchestrator`,
`sandbox: false` (it predates rule 7, which only holdout problems must satisfy), and its
`reviewedAt` and `reviewedBy` are null when S-7 merges (AC-26 fills them); its
`hidden.compileErrorPattern` is the regex in the Formats example; its `pick.md` records S-10's
hand-pick of issue #489 (one input, no candidates compared). The S-10 folder stays as it is.

AC-26 is a post-merge operator hand-off and is excluded from S-7's merge gate: the verifier records
it `needs-human` and S-7 merges with the answer sheets still to be reviewed. AC-24 runs once at the
end of S-7 and is cached by the validation key, not re-run per verifier pass.

**The pick rule** the S-7 executor applies for P2–P6, outside the author sandbox. Each language has
a fixed candidate list, in this order:

| language   | candidates, in order                                          |
| ---------- | ------------------------------------------------------------- |
| python     | `pallets/click`, `python-attrs/attrs`, `pallets/itsdangerous` |
| typescript | `tj/commander.js`, `yargs/yargs`, `unjs/ofetch`               |
| go         | `spf13/cobra`, `urfave/cli`, `gorilla/mux`                    |

Slots are walked in order, P2 to P6. For a slot, walk its language's list in order, skipping any
repository an earlier slot took: no repository is used twice. In each repository take the pull
request with the latest `mergedAt` before 2026-10-01 (ties go to the higher number) that matches the
slot's kind and changes at most 20 non-test files; that one pull request is the repository's
candidate. A **test file** is a path with a directory named `test`, `tests` or `__tests__`, or a
name matching `test_*`, `*_test.*`, `*.test.*` or `*.spec.*`. A **bug or feature** pull request
closes an issue (`closingIssuesReferences` is non-empty) and changes at least one test file; the
closed issue decides the kind: a label containing `bug`, or for a feature `enhancement` or
`feature`, case-insensitive, or, on an issue with none of those labels, the word `bug` or the word
`feature` in its title or body. A **refactor** pull request has `refactor` in its title or in a
label, case-insensitive; it needs no issue and need not change or add tests. The **pin** is the
first parent of the pull request's merge commit; a pull request for which `git diff --name-only <pin>
<merge commit>` differs from its changed files (a rebase merge of several commits) does not match.
The candidate is accepted when, at the pin, the repository's `setup` and its own suite each finish
under the Limits row **validation limit** on one core (the CPU paragraph's environment); otherwise
the repository yields nothing and the walk moves to the next one. The first accepted candidate wins
the slot. A slot with no accepted candidate in its list: S-7 reports `blocked` naming the slot, and
it never widens the rule (no other repository, date or file limit is tried).

`request.md` is the closed issue's title and body, or for a refactor with no closing issue the pull
request's title and body. The hidden suite has 15–60 tests written from the request and the answer
sheet. The id is `<repo name>-<two or three words of the request>`, lowercase. The answer sheet
carries the S-10 general entries G-1 (open-ended), G-2 (not on the sheet) and G-4 (approval)
verbatim. A refactor's hidden tests (P4, P6) assert the new structure or API, because a suite that
only checks behaviour passes on the pristine checkout and fails validation. `prompts/author.md`
states this requirement, that `hidden.compileErrorPattern` is required (the regex for the target's
compile or import failure) and that the reference patch is not available to the author.

Before any authoring session runs, the executor extracts `hidden/reference.patch` from the merged
change (the diff of the non-test files between the pin and the merge commit) and writes it to
`$HARNU_BAKEOFF_CACHE/authoring/<id>.reference.patch`, outside the sandbox directory. It writes the
pick to `$HARNU_BAKEOFF_CACHE/authoring/<id>.pick.md` (candidates considered, the rule, the date, the
one chosen, the issue URL, none for a refactor with no closing issue, and the pull request number),
also outside the sandbox directory, then runs
`author-sandbox <id> --split dev --repo <url> --commit <pin> --pick <that file>`; the authoring session
never picks and never reads the reference patch. Before the authoring session, the executor writes
`setup`, `test`, `versions` and `hidden.cmd` into `out/<id>/problem.json`, taking the reporter from
JUnit per language; `prompts/author.md` tells the session those four fields are set and not to change
them, and to name its hidden test file as `hidden.cmd` does. The executor then runs the headless
authoring command that The author sandbox gives. When the session has finished, the executor runs
`author-import <id> --split dev --reference <that patch>`, which adds it. No prompt names the patch's
path; as with Containment per role, a shell could still reach it, and this residual is accepted. For
a holdout problem the operator does the same, with the files at
`$HARNU_BAKEOFF_HOLDOUT/.rounds/authoring/<id>.pick.md` and `<id>.reference.patch` beside it. The
holdout's three slots are python bug, typescript feature and go refactor.
Validation enforces the Limits row **validation limit** and fails a problem that exceeds it. The
machine prerequisites (python3, node, go, and the reporters of JUnit per language) are listed in the
dev guide.

### S-8 · Docs and the reproduction of S-10

- depends-on: S-7
- substrate: worktree
- files-may-touch: `docs/dev/bakeoff.md`, `scripts/eval/bakeoff/README.md`, `docs/specs/2026-11-07-bakeoff-harness/reproduction/**`
- produces: bakeoff-docs, reproduction-report
- consumes: bakeoff-report, acceptance-compare, corpus-v1, author-sandbox, bakeoff-cli
- acs: AC-28, AC-29, AC-30

Precondition: S-8 is blocked until AC-26 holds for P1 (`sqlite-utils-json-key`): `run` refuses a
problem whose `provenance.reviewedAt` is null, and P1's is null when S-7 merges.

The reproduction run: `npm run eval:bakeoff -- run --problems sqlite-utils-json-key --with-tlc
--skill-ref 6bab507f` with every other flag at its default. Its `report.md` and `report.json` are
committed under `docs/specs/2026-11-07-bakeoff-harness/reproduction/`, beside a `confounds.md`
that names how this run differs from S-10: contestants load Superpowers from files instead of the
`Skill` tool, each judge sees one bundle in a fresh session instead of three in a row, and nobody
relays. The pass band is AC-30's; a result outside it is reported as a failed reproduction and the
band is not widened after the run. The proof checks that the harness reproduces a prior measurement,
not which tool is best.

## Acceptance criteria

`proof` is one typed value: `test:<file>::<name>`, `script:<cmd>`, `record:<kind>` or `review` (AC-25 alone lists two `test:` values, separated by `; `).
There is no UI, so no `capture:` row. The unit tests never call a model: they point
`HARNU_BAKEOFF_CLAUDE_BIN` at `tests/fixtures/eval-bakeoff/fake-claude.mjs`, and they
use `inline` fixture targets whose suites run with `node --test`, so they need only git and Node. They
set `HARNU_BAKEOFF_TIMEOUT_SCALE` to a small value so a deadline elapses in milliseconds. `refines/inherits` points to a provisional AC of card T676 (`card:AC-n`) or to another AC here.

**The fake `claude`** is executable, with `#!/usr/bin/env node` as its first line, and only S-2 touches
it; each slice keeps its scenarios in its own `tests/fixtures/eval-bakeoff/s<n>/`.
`FAKE_CLAUDE_SCENARIO` is the path of a JSON array with one entry per invocation, consumed in order:
`{ "reply": string, "writes": [{ "path", "content" }], "noResult": bool, "hangMs": number, "messageId": string }`.
An invocation reads its prompt from stdin, writes each `writes` file at `path` relative to its cwd,
waits `hangMs` (default 0), and emits a `system` `init` event whose `model` is `fake-` plus its `--model`
value, one assistant message and a `result` event whose text is `reply`. It writes the session's
transcript under `HARNU_BAKEOFF_CLAUDE_PROJECTS`, in a directory named by its cwd with every
non-alphanumeric character replaced by `-`, as one assistant line with `message.id` set to `messageId`
(default: a fresh id per invocation) and the fixed usage input 100, cache write 0, cache read 0,
output 10. An entry with `noResult: true` emits no `result` event and no `model` on the `init` event,
and exits 0. The array's cursor is the file `.fake-claude-cursor` at the root of
`HARNU_BAKEOFF_CLAUDE_PROJECTS`, advanced under an exclusive lock, so parallel invocations take
distinct entries (a test running more than one job scripts interchangeable entries). Past the end of
the array the fake prints to stderr and exits 3 with no `result` event. It also honours
`FAKE_CLAUDE_LOG` and `FAKE_CLAUDE_DELAY_MS`.

| id    | statement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | proof                                                                                                                                                                                                                       | refines/inherits | covers                                             |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | -------------------------------------------------- |
| AC-1  | `loadCorpus` reads every problem directory of a root and returns the problems, or one error per defect naming the file and the field: an id that differs from its directory, a split that differs from its root, a kind outside the enum, a commit that is not 40 hex, a missing `versions`, `hidden.compileErrorPattern`, `pick.md`, `request.md`, `answer-sheet.md`, `hidden/atoms.md` (or one with no atom id), hidden file or `hidden/reference.patch`. A holdout problem whose `provenance.sandbox` is not true is refused, and so is any problem with `provenance.reviewedAt` null when it is loaded for a run. Each error carries its code from Loader error codes.                                                                                                                                                                                                                                                                                                                                                                                                                                                 | test:tests/eval-bakeoff-corpus.test.ts::loader validates a problem and names every defect                                                                                                                                   | —                | R-2, R-17                                          |
| AC-2  | Containment: `resolveRoots` returns the coded error `HOLDOUT_INSIDE_REPO` when `HARNU_BAKEOFF_HOLDOUT` equals the repo, lies under the worktree or the main checkout, or is a symlink outside the repo that resolves inside it; `CACHE_INSIDE_REPO` for the same cases of `HARNU_BAKEOFF_CACHE`; `WORK_NOT_CONTAINED` when `HARNU_BAKEOFF_WORK` lies under a repo root, the cache root or the holdout clone; `HOLDOUT_UNSET` for a holdout split with the variable unset; a holdout path outside both roots is accepted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | test:tests/eval-bakeoff-corpus.test.ts::holdout and cache paths inside the repo are refused after realpath                                                                                                                  | card:AC-3        | R-7, R-13                                          |
| AC-3  | `checkoutTarget` yields a clone at the pinned commit with no remote, fetched once into the mirror cache and reused on a second call, or for an `inline` target a fresh repository whose one commit holds `source/`; `setup` runs under `nice -n 19` with its timeout and with `GOMAXPROCS=1`, `PYTEST_ADDOPTS=-p no:xdist` and `npm_config_jobs=1` in its environment.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | test:tests/eval-bakeoff-corpus.test.ts::checkout pins the commit, drops the remote and reuses the mirror                                                                                                                    | —                | R-2                                                |
| AC-4  | With the fake `claude`, a contestant run passes `--model`, the contestant's **turn cap** from the Limits table as `--max-turns`, `--tools` and `--allowedTools` each set to the contestant's list `Read,Write,Edit,Glob,Grep,Bash,Task`, `--output-format stream-json`, `--verbose`, `--setting-sources project` and `--add-dir` for `tool/`; starts with `--session-id`; sends each operator `ANSWER` text, and only that text, with `--resume <contestant session id>`; resumes the same operator session for every question; passes a several-line question to the operator whole; writes `operator-log.md` in the format of The contestant loop; creates `clone/` through `checkoutTarget` with `setup: false`, so a fixture's `setup` marker file is absent from `clone/`; ends `done` on `ARTIFACT DONE:`; collects as the artifact exactly the files added or modified in the clone; and writes `specLines` and `specWords` for the file the contestant's `spec file` glob selects, the plan for `superpowers`.                                                                                                     | test:tests/eval-bakeoff-runner.test.ts::the simulated operator answers by resuming the contestant session                                                                                                                   | card:AC-1        | R-5                                                |
| AC-5  | With the fake `claude`, a contestant run obeys the Limits table: **operator exchanges** (12 exchanges, the fixed text at its 13th question, `incomplete` at its 14th), **stray replies** (the first two get exactly the fixed nudge text of The contestant loop; the third ends the run `incomplete`), **invocation deadline** and **retries** (a turn with no `result` event, a deadline kill included, retries the run once and a second one makes it `failed`) and **run deadline** (the total ends the run `incomplete` with no retry). The first turn's prompt has `{{TOOL_DIR}}`, `{{ENTRY}}`, `{{STOP_POINT}}` and `{{REQUEST}}` filled and no `{{` left; the rest of its wording is not asserted.                                                                                                                                                                                                                                                                                                                                                                                                                  | test:tests/eval-bakeoff-runner.test.ts::a contestant that never stops asking ends incomplete                                                                                                                                | AC-4             | R-5                                                |
| AC-6  | Token usage is summed from the moved transcripts of the session and its sub-agents, per assistant message deduplicated by `message.id`, as input + cache write + cache read + output, matching the hand-computed totals of the transcript fixtures; sub-agents are the `Task` and `Agent` tool calls; the transcripts end in the unit's `transcripts/<role>/` directories, `sumUsage` called once per role directory, and nothing of the session is left in the projects directory.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | test:tests/eval-bakeoff-runner.test.ts::usage is summed from transcripts and deduplicated by message id                                                                                                                     | —                | R-18                                               |
| AC-7  | The default contestants are `harnu-spec` and `superpowers`; `--with-tlc` adds `tlc-spec-driven`; `harnu-spec`'s `tool/` is the skill directory and `TEMPLATE.md` at `--skill-ref`; a `tlc-spec-driven` fetch with zero or two matching `SKILL.md` files fails; the resolved sha of every contestant is recorded. The test passes `resolveTool` a `sources` map of local fixture repositories and uses no network.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | test:tests/eval-bakeoff-runner.test.ts::contestants resolve their pinned tool directories                                                                                                                                   | —                | R-2, R-8                                           |
| AC-8  | The anonymized bundle concatenates the artifact in sorted path order under `=== file: <path> ===` headers, strips each file's leading YAML front matter block and contains no tell of any selected contestant in any case, in the text or the headers, while a tell of a contestant not in the round stays and a target file containing `tlc` inside another word (`atlc-lib`) keeps it, the replacement being word-boundary anchored; the `P`, `Q`, `R` labels name the bundles in the judge's output and the private mapping, follow the Fisher-Yates and mulberry32 shuffle of Judging, are the same for the same seed and differ between the fixture's two seeds `seed-a` and `seed-b` on problem id `fixture-problem`, repeat 1, three contestants (`seed-a` gives `P` to `tlc-spec-driven`, `seed-b` to `harnu-spec`). A bundle that remains identifiable by its structure is not a defect: it is accepted and named in the report's confounds section (AC-17).                                                                                                                                                      | test:tests/eval-bakeoff-judge.test.ts::bundles carry no tell of any contestant and labels follow the seed                                                                                                                   | —                | R-1                                                |
| AC-9  | Each judge is a fresh session per bundle with no tools on the judge model; its `judge-<n>/` holds `bundle.md` and its stdin prompt is the score sheet, then the atoms, then the bundle, in that order; an atom id the judge omits counts `missing`; a reply with no valid `json` block, by the schema of Judging, goes to the Limits **retries** row, then is recorded `not-run` with `reason: invalid-reply`, excluded from every mean and counted in the runs table; a run with an empty artifact gets every `judge-<n>.json` with `status: not-run` and `reason: empty-artifact`, runs no judge session and counts coverage 0.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | test:tests/eval-bakeoff-judge.test.ts::judges score blind and a broken reply is not-run                                                                                                                                     | —                | R-1, R-5                                           |
| AC-10 | A build copies the artifact into a fresh checkout and commits it, runs the builder with `--tools` and `--allowedTools` each set to `Read,Write,Edit,Glob,Grep,Bash` (no `Task`, no `tool/`), copies the hidden files in after the builder session has ended, runs the hidden command twice and counts from the JUnit XML against the reference patch's validated test set; a fixture test that passes in one run and fails in the other counts as failed and is listed in `flaky`; a run whose JUnit XML is missing or corrupt counts every test in it as failed; `build-clone/` runs `setup` (a fixture's marker file is present); the existing suite's exit code and the count of `ASSUMPTIONS.md` lines matching `^\d+\. ` are recorded; a builder session that errors or hits its **invocation deadline** still runs the hidden command on what it wrote, with `status: failed`; an empty artifact runs no builder session, writes `build.json` with `status: not-run` and a pass rate of 0, and `resume` treats it as done.                                                                                           | test:tests/eval-bakeoff-build.test.ts::a flaky hidden test counts as failed and is listed                                                                                                                                   | card:AC-1        | R-5, R-2                                           |
| AC-11 | Validation fails a problem whose hidden suite passes entirely on the pristine checkout, whose pristine run has missing or corrupt JUnit XML, a collection failure, zero testcases or no `failure` testcase, whose reference patch fails or flips a test across its 3 runs, whose existing suite fails on the reference, or whose `setup` or `test` exceeds 5 minutes; a pristine run that exits non-zero with output matching `hidden.compileErrorPattern` and zero testcases (a Go-style compile failure fixture) passes that check, and the same output with a non-matching pattern fails it. On a dev problem it names the problem and the tests; on a holdout problem the terminal shows only a count and the details go to `$HARNU_BAKEOFF_WORK/validation/<key>.json`. With an unchanged cache key it runs no command; changing a problem file or the `versions` output reruns it; changing only `problem.json`'s `provenance`, as `review` does, changes neither the content hash nor the key and reruns nothing.                                                                                                   | test:tests/eval-bakeoff-build.test.ts::validation rejects a passable-by-default or flaky suite                                                                                                                              | AC-10            | R-2                                                |
| AC-12 | `run` schedules, per problem, contestant and repeat, the contestant run, then its judges, then its build, at most `--jobs` units at once (default and ceiling `floor(os.availableParallelism() / 2)`, at least 1; a higher value is clamped with a warning line); a round runs exactly one split; every spawned command and `claude -p` runs under `nice -n 19` with `GOMAXPROCS=1`, `PYTEST_ADDOPTS=-p no:xdist` and `npm_config_jobs=1`; dev unit work lands under the cache root and holdout unit work under `$HARNU_BAKEOFF_WORK/rounds/<round-id>/`; `round.json` is written under the main checkout's `.harnu/eval/bakeoff/<round-id>/`, records the args, the pins, the resolved model ids, the seed, `budget` and, for a dev round, each unit's state; a holdout round's repo-side `round.json` holds no per-problem field, its `args` is `redacted`, and its per-problem state is in `<holdout>/.rounds/<round-id>/problems.json`, beside `labels.json`, whose keys are exactly `H-1` to `H-n` with `n` the holdout problem count, sorted by id; S-5 writes every `problems.json` key except `measures`.          | test:tests/eval-bakeoff-round.test.ts::a round schedules every unit and writes outside the repo                                                                                                                             | card:AC-1        | R-5, R-7                                           |
| AC-13 | With a fixture cap, no unit starts once spent reaches the cap, units in flight finish, `round.json` says `aborted-budget` and the exit code is 3; `resume` with a raised `--budget` runs only the units without a result file, and the final spent equals the sum of every unit's usage plus every entry of every `discarded.json` under the units root, an attempt discarded by the Limits row **retries** included.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | test:tests/eval-bakeoff-round.test.ts::a round stops at its token cap and resumes the rest                                                                                                                                  | —                | R-18                                               |
| AC-14 | A real `run --dry-run`, whose overrides AC-44 proves, completed with status `done` on `haiku`. Minimum evidence, produced by S-6's executor: `docs/specs/2026-11-07-bakeoff-harness/dry-run/report.md` committed, its header showing `dryRun: true`, the `haiku` models and status `done`, and its measure tables, budget and confounds sections present.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | record:dry-run-report                                                                                                                                                                                                       | AC-44            | R-18, R-5                                          |
| AC-15 | `package.json` has `eval:bakeoff` as `vite-node scripts/eval/bakeoff/run.mjs --` and no new dependency; every module matched by globbing `scripts/eval/bakeoff/**/*.mjs` at test run time, excluding `scripts/eval/bakeoff/fixtures/**` and `scripts/eval/bakeoff/corpus/**`, imports only `node:` built-ins, sibling modules and `../mission-behavior/harnu.mjs` or `../mission-behavior/procs.mjs`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | test:tests/eval-bakeoff-round.test.ts::the harness is a dependency-free script under scripts/eval                                                                                                                           | —                | R-3                                                |
| AC-16 | One command, `run` over the dev fixture corpus with the fake `claude` and stdin closed, finishes with exit 0 and writes `report.md` and `report.json` holding every contestant run, judgment and build of the round.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | test:tests/eval-bakeoff-report.test.ts::one command runs a corpus end to end with no human input                                                                                                                            | card:AC-1        | R-5, R-2                                           |
| AC-17 | A round's report covers its one split, never one pooled number across splits; a dev report's measure tables show each run's value, the mean and the spread per problem and contestant, and a summary row per contestant; a holdout report shows, per measure and contestant, only the mean, spread and `n`, with no per-problem row; both have the budget section and a confounds section naming the structural identifiability a bundle keeps; a judge with `acTotal` 0 shows the executable-proof share as `n/a` and is left out of its mean.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | test:tests/eval-bakeoff-report.test.ts::dev and holdout are reported apart with spread per measure                                                                                                                          | card:AC-2        | R-6                                                |
| AC-18 | A fixture holdout problem carries a sentinel string in its request, answer sheet, atoms, hidden tests and every scripted reply; after a fake dev round and a fake holdout round (authorized by a fixture `compare.json`), no file under the worktree and the main checkout (tracked, untracked or ignored) contains the sentinel, and the holdout report and the `compare` output contain no `H-n` label, no problem id, no failed test name and no judge note, only per-contestant mean, spread and `n`. The holdout round's stdout and stderr carry only counters, with no problem id or test name; `--problems` with `--split holdout` exits 2 with `PROBLEMS_ON_HOLDOUT`; the repo-side `round.json` has `args: redacted`.                                                                                                                                                                                                                                                                                                                                                                                             | test:tests/eval-bakeoff-report.test.ts::no holdout text reaches the repo or the report                                                                                                                                      | card:AC-3        | R-7, R-12, R-13                                    |
| AC-19 | `compare` on fixture report pairs of one split returns accepted for a dev gain above the larger spread and rejected for a dev gain equal to it; accepted for a holdout drop within its spread and rejected for a larger one; and incomplete for a dry round or an `aborted-budget` round; with every spread 0, the floors apply (D-13): a dev gain of 1 or exactly 2 points is rejected, 2.5 points accepted, a holdout drop of exactly 2 points accepted, 2.5 points rejected; exit 0 only when accepted. `compare` uses unrounded values: a gain of 2.004 points with every spread 0, shown as 2.00 in `report.md`, is accepted. After an accepted dev compare, `compare.json` exists in the candidate round's directory with exactly the fields of The acceptance rule, and `run --split holdout --after <candidate>` accepts it.                                                                                                                                                                                                                                                                                       | test:tests/eval-bakeoff-report.test.ts::compare accepts only a dev gain above noise without a holdout regression                                                                                                            | —                | R-15, R-12, R-1                                    |
| AC-20 | `<holdout>/.rounds/usage.json` has exactly the keys `counts` (content hash to count) and `pairs` (`<baselineRoundId>:<candidateRoundId>` strings). An accepted holdout `compare` adds one to each shared problem's count once per pair (a second `compare` of the same pair changes nothing), and prints a warning line giving how many problems and no id only when a shared holdout problem's count exceeds 3; a dev `compare` keeps no such count and prints no such warning.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | test:tests/eval-bakeoff-report.test.ts::a holdout problem used in more than 3 accepted comparisons warns                                                                                                                    | —                | R-14, D-10                                         |
| AC-21 | The budget section, computed by `scripts/eval/bakeoff/usage-rollup.mjs` from `contestant.json`, the `judge-<n>.json` files, `build.json` and every `discarded.json` under the units root, shows cap, spent, remaining, status, and tokens by phase (contestant, operator, judge, build, discarded) and by contestant, and they add up to spent; the report's spent equals `round.json`'s `budget.spent`; a retried attempt's usage is under `discarded`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | test:tests/eval-bakeoff-report.test.ts::budget accounting adds up by phase and contestant                                                                                                                                   | AC-13            | R-18                                               |
| AC-22 | The dev corpus loads with exactly the six slots of the S-7 table: languages python, typescript and go, kinds feature, bug and refactor as listed, six different target repositories.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | test:tests/eval-bakeoff-corpus-v1.test.ts::dev corpus v1 matches the slot table                                                                                                                                             | —                | R-11, R-2                                          |
| AC-23 | `sqlite-utils-json-key` pins `9c66bafa52ae23d40499c74b0db3b635bcddb876`; its answer sheet, atoms, hidden test file and reference patch have the sha256 of the S-10 files; its `request.md` is the S-10 request text; its provenance matches S-7's text on `authoredAt`, `authoredBy` and `sandbox` only, with `reviewedAt` and `reviewedBy` null until AC-26.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | test:tests/eval-bakeoff-corpus-v1.test.ts::the S-10 input is migrated byte for byte                                                                                                                                         | card:AC-4        | R-8                                                |
| AC-24 | Every dev problem validates on a machine with python3, node and go. Run once at the end of S-7 and cached by the validation key: a verifier pass with an unchanged key runs no command.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | script:npm run eval:bakeoff -- validate --split dev                                                                                                                                                                         | AC-11            | R-2                                                |
| AC-25 | `author-sandbox` builds its directory under the split's authoring root, with none of the exclusion list's paths in `harnu/`, the target checkout in `target/` and a prefilled `out/<id>/`; it copies `--pick` into `out/<id>/pick.md` and exits 2 with `PICK_MISSING` on a missing or empty file; `author-import`, which requires `--split dev` or `--split holdout` (without it, exit 2 with `SPLIT_REQUIRED`), refuses a sandbox that contains any of them, stamps `sandbox: true`, writes its `--reference` file as `hidden/reference.patch` (exit 2 with `REFERENCE_MISSING` on a missing or empty one), and writes a holdout problem only under `HARNU_BAKEOFF_HOLDOUT`; P2–P6 carry `sandbox: true` and a `pick.md` with the candidates considered, the rule, the date and the one chosen. `author-sandbox` prints exactly the headless authoring command of The author sandbox. The second test checks the six committed `pick.md` files and `sandbox: true` on P2–P6.                                                                                                                                              | test:tests/eval-bakeoff-author.test.ts::the author sandbox has no skill files and import stamps it; test:tests/eval-bakeoff-corpus-v1.test.ts::the six dev problems carry a pick log and P2-P6 were authored in the sandbox | —                | R-17                                               |
| AC-26 | Every dev problem's `provenance.reviewedAt` and `reviewedBy` were stamped by the operator through `review` after reading its answer sheet. Minimum evidence, produced by the operator: the six committed `scripts/eval/bakeoff/corpus/dev/<id>/problem.json` files showing non-null `provenance.reviewedAt` and `provenance.reviewedBy`. A post-merge operator hand-off: excluded from S-7's merge gate (`needs-human` at verification), and S-8 is blocked until it holds for P1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | record:operator-review                                                                                                                                                                                                      | AC-1             | R-17                                               |
| AC-27 | `scripts/eval/bakeoff/HOLDOUT.md` is the README for the private holdout repo: its layout (one problem directory per id, `.rounds/` gitignored), its three slots (python bug, typescript feature, go refactor), authoring through `author-sandbox` and `author-import`, cloning it outside this repo and setting `HARNU_BAKEOFF_HOLDOUT`. Verifier: S-7's `harnu:delivery-verifier`. Checklist: the layout; the three slots as listed; the two authoring commands; the clone outside the repo; the variable named.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | review                                                                                                                                                                                                                      | —                | R-13                                               |
| AC-28 | `docs/dev/bakeoff.md` explains how to run a round and resume it (the dev round first, the holdout round after a dev acceptance), the machine prerequisites (python3, node, go, and the reporters of JUnit per language, with `gotestsum` at `v1.12.0`, `jest-junit` and `mocha-junit-reporter` installed by a problem's `setup`), how to author a problem (sandbox, answer sheet, atoms, hidden tests and their JUnit command, the pick rule and `pick.md`, `review`), where the private holdout lives and how to point the harness at it, how to read the report (dev vs holdout aggregates, spread, budget, confounds) and `compare` (the rule's coarseness and floors, the per-round cost), and states the seven anti-overfitting rules as process rules, rule 4 as this spec scopes it (freshness on the holdout only, D-10) and rule 6 included: every skill change names its failure class, never a problem-specific detail. Verifier: S-8's `harnu:delivery-verifier`. Checklist: run and resume; prerequisites; authoring; the holdout's location and variable; reading the report and `compare`; the seven rules. | review                                                                                                                                                                                                                      | card:AC-5        | R-4, R-9, R-11, R-12, R-13, R-14, R-15, R-16, R-17 |
| AC-29 | `scripts/eval/bakeoff/README.md` is the CLI reference: every command, flag, default, environment variable, exit code and output file of the Formats section, the files table of the harness, and a link to `docs/dev/bakeoff.md`. Verifier: S-8's `harnu:delivery-verifier`. Checklist: every command of The CLI; every `run` flag and default; every environment variable; every exit code; every output file; the link.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | review                                                                                                                                                                                                                      | card:AC-6        | R-4, R-10                                          |
| AC-30 | Minimum evidence, produced by S-8's executor: `report.md`, `report.json` and `confounds.md` committed under `docs/specs/2026-11-07-bakeoff-harness/reproduction/`, showing, for each of the three tools, an absolute difference between the reproduction's mean hidden passes and S-10's (51, 53, 52 of 53) of at most max(that tool's spread in tests, 2 tests), where passes = `hiddenPassRate` × 53 / 100 and the spread in tests = the tool's `hiddenPassRate` spread across its two runs × 53 / 100, both read from `report.json`'s `measures.hiddenPassRate.summary`. Token ranking and tool order are reported, not gated (S-10 `report.md` §6: `harnu:spec` 16.6M, Superpowers 8.8M, `tlc-spec-driven` 6.7M, that is 3.13M spec plus 3.60M build); the judge coverage means (S-10: 21.8, 23.7, 22.8 of 24) are reported beside them. Expected cost about 65M tokens (2 repeats of 3 tools plus judges). A result outside the band is reported as a failed reproduction and the band is not widened. This proof checks that the harness reproduces a prior measurement, not which tool is best.                     | record:reproduction-report                                                                                                                                                                                                  | card:AC-4        | R-8, R-2                                           |
| AC-31 | `compare` exits 2 naming the field when the two rounds differ on `split`, contestant model, operator model, judge model, judge count, repeats or a baseline contestant's pin, and accepts different seeds; it matches problems by real id, counts one as shared only when its content hash matches in both rounds (a problem whose only difference between the rounds is `problem.json`'s `provenance` is shared), reads the scores of `harnu-spec` only, and exits 2 with `NO_SHARED_PROBLEMS` on an empty shared set.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | test:tests/eval-bakeoff-report.test.ts::compare refuses rounds that differ in what it compares                                                                                                                              | AC-19            | R-15, R-12                                         |
| AC-32 | With the fake `claude`'s `FAKE_CLAUDE_LOG` recording every invocation's cwd and argv over a dev and a holdout round, each role's cwd and `--add-dir` are exactly those of the Containment per role table; no cwd or `--add-dir` lies under a repo root, a corpus root or `$HARNU_BAKEOFF_HOLDOUT`; the operator's directory holds `answer-sheet.md` alone and the judge's `bundle.md` alone, apart from its own `discarded.json` after a retried attempt; the hidden files appear in the build clone only after the builder session has ended.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | test:tests/eval-bakeoff-round.test.ts::every role runs in its contained directory                                                                                                                                           | —                | R-7, R-13, R-5                                     |
| AC-33 | `run --split holdout` without `--after`, or with an `--after` round whose `compare.json` lacks `split: dev` and `verdict: accepted`, or with a `--skill-ref` that resolves to neither of its skill shas, exits 2 with `DEV_NOT_ACCEPTED` before any work; an invalid `--split` on `run`, `validate` or `list` exits 2 with `SPLIT_REQUIRED` before dispatch, whether or not the command's module exists yet.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | test:tests/eval-bakeoff-round.test.ts::a holdout round requires an accepted dev compare                                                                                                                                     | —                | R-12, R-18                                         |
| AC-34 | Beyond AC-25's paths, this catches content leakage from files not on the exclusion list: a sandbox built from the repository's `HEAD` by `author-sandbox` contains none of `harnu:spec`, `Goldfish`, `Elephant` or `spec-check` anywhere but under `target/`; a hit fails the test, names the file, and its failure message says that a PR adding a doc that names the skill extends the exclusion list in the same PR.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | test:tests/eval-bakeoff-author.test.ts::the built author sandbox holds no deny-list term                                                                                                                                    | AC-25            | R-17                                               |
| AC-35 | `review <id>`, which requires `--split dev` or `--split holdout` (without it, exit 2 with `SPLIT_REQUIRED`), prints the request, answer sheet and atoms and, with `y` on fake stdin, stamps `provenance.reviewedAt` and `provenance.reviewedBy` (`git config user.name`); with `n` it stamps nothing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | test:tests/eval-bakeoff-author.test.ts::review stamps provenance only on yes                                                                                                                                                | AC-26            | R-17                                               |
| AC-36 | `list` prints each dev problem with its kind and language, and for a holdout split prints the problem count only, with no id, kind or language.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | test:tests/eval-bakeoff-report.test.ts::list prints a count for the holdout                                                                                                                                                 | —                | R-2, R-13                                          |
| AC-37 | With the fake `claude`, `FAKE_CLAUDE_DELAY_MS` holding a session open and a SIGINT sent mid-round, `run` exits 130, the interrupted sessions' usage is appended to each unit's own `discarded.json`, no transcript of those sessions is left under `HARNU_BAKEOFF_CLAUDE_PROJECTS`, and `resume` runs only the units without a result file and finishes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | test:tests/eval-bakeoff-round.test.ts::a ctrl-c discards the attempt and resume continues                                                                                                                                   | AC-13            | R-5, R-18                                          |
| AC-38 | The command table in `run.mjs` lists the nine commands of The CLI with the module and handler it states; a command whose module is absent exits 2 with `NOT_YET`; `validate` dispatches to `validate.mjs`'s `validateCommand` through the table; `HOLDOUT_INSIDE_REPO`, `CACHE_INSIDE_REPO`, `WORK_NOT_CONTAINED` and `HOLDOUT_UNSET` from `resolveRoots` make the CLI exit 2 with that code before any work; `assertJudgeModel` in `run.mjs` makes `run` exit 2 with `JUDGE_MODEL_SAME` when the judge model's full id equals the contestant's, an alias against the full id it resolves to included, is waived by `--dry-run` and accepts an operator model equal to the judge model; `MODEL_UNRESOLVED` from `resolveModel` makes the CLI exit 2 with that code; each probe's usage lands in `units/_round/discarded.json` with `phase: model-probe`.                                                                                                                                                                                                                                                                   | test:tests/eval-bakeoff-round.test.ts::the CLI dispatches its table and exits 2 on a bad configuration                                                                                                                      | AC-2             | R-5, R-7, R-13                                     |
| AC-39 | `report <round-id>` rewrites `report.md` and `report.json` from the unit files, byte-identical to the files the round wrote, for a fixture dev round and a fixture holdout round; neither file carries a generation timestamp; `report.md` shows 2 decimals and `report.json` the unrounded values; on the holdout round `writeReport` sets `measures` in `problems.json` and every other key is deep-equal before and after.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | test:tests/eval-bakeoff-report.test.ts::report rewrites from the unit files                                                                                                                                                 | AC-16            | R-6                                                |
| AC-40 | A prompt over 200 KiB reaches the fake `claude` intact over stdin, on a first turn and on a resume; no prompt appears in argv.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | test:tests/eval-bakeoff-runner.test.ts::a prompt over 200 KiB travels over stdin                                                                                                                                            | —                | R-5                                                |
| AC-41 | With the fake `claude`, `resolveModel` given `opus`, `opus`, `sonnet` and a full id runs exactly two probes, each a `claude -p` with prompt `ok`, `--max-turns 1` and `--output-format stream-json --verbose`; it returns each alias's full id from the `model` of the `system` `init` event, the full id unchanged, and the two probes' usage; an alias whose probe emits no `model` returns the coded error `{ code: 'MODEL_UNRESOLVED', message }`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | test:tests/eval-bakeoff-runner.test.ts::resolveModel probes each distinct alias once                                                                                                                                        | —                | R-5                                                |
| AC-42 | `tests/fixtures/eval-bakeoff/fake-claude.mjs` is executable with `#!/usr/bin/env node`, replays the `FAKE_CLAUDE_SCENARIO` array entry by entry as The fake `claude` states (`reply`, `writes`, `noResult`, `hangMs`, `messageId`, exit 3 past the end), appends one JSON line `{ cwd, argv }` per invocation to the file named by `FAKE_CLAUDE_LOG`, and waits `FAKE_CLAUDE_DELAY_MS` milliseconds before its first output; S-5's tests use both without changing the fake.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | test:tests/eval-bakeoff-runner.test.ts::the fake claude replays its scenario, records each invocation and honours its delay                                                                                                 | —                | R-5                                                |
| AC-43 | `limits` in `limits.mjs` holds every row of the Limits table; with `HARNU_BAKEOFF_TIMEOUT_SCALE` at `0.01`, `invocationMs`, `runMs`, `commandMs` and `validationMs` read one hundredth of their table values and the counts (`operatorExchanges`, `strayReplies`, `retries`, `maxTurns`) are unchanged; unset, the values are the table's.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | test:tests/eval-bakeoff-corpus.test.ts::limits scale the time limits and leave the counts alone                                                                                                                             | —                | R-5, R-18                                          |
| AC-44 | `run --dry-run` over the fake `claude` swaps the corpus for `scripts/eval/bakeoff/fixtures/dry-run/`, runs only `harnu-spec`, resolves every role from `haiku` (every `--model` in `FAKE_CLAUDE_LOG` is `fake-haiku`), uses one repeat, one judge and a `budget.cap` of `10000000`, writes `dryRun: true` on the round and finishes with exit 0, `JUDGE_MODEL_SAME` being waived although the judge and contestant models are equal. The fixture loads with `forRun: true`, its `provenance.reviewedAt` stamped, and validates.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | test:tests/eval-bakeoff-round.test.ts::a dry run applies its fixed overrides                                                                                                                                                | —                | R-18, R-5                                          |

## Open decisions

All thirteen decisions are resolved by the operator, and none gates a slice: D-1 to D-9 on 2026-11-07,
before the first dispatch, each one line in project memory (`decisions`), and D-10 to D-13 on
2026-11-09.

| id   | question                                                                                                                                   | options                                                                                                                                                                                                                                                                                   | default                                                            | status                                                                                                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1  | Where does the harness live and how does it drive Claude, so a round runs with no relay (R-3, R-5)?                                        | `scripts/eval/bakeoff/` `.mjs` run by `vite-node` (`npm run eval:bakeoff`), `claude -p` with stream-json, the operator's answer sent by resuming the contestant with `--resume`; `tools/bakeoff/` in TypeScript with the Claude Agent SDK (a new dependency and a second eval convention) | `scripts/eval/bakeoff/` with `claude -p`                           | resolved · `scripts/eval/bakeoff/` `.mjs` under `vite-node`, `claude -p` stream-json, the operator answers through `--resume` · 2026-11-07                                      |
| D-2  | Where does the holdout live, and how is it kept out of the repo (R-7, R-13)?                                                               | a private GitHub repo cloned outside this repo, path from `HARNU_BAKEOFF_HOLDOUT`, realpath containment, reports carry holdout aggregates and never holdout text; a local untracked directory; encrypted files in the repo                                                                | a private repo outside the repo                                    | resolved · a private GitHub repo cloned outside the repo, path from `HARNU_BAKEOFF_HOLDOUT`, an in-repo path refused · 2026-11-07 (how much a holdout report shows is D-12)     |
| D-3  | How large is corpus v1, and what must it cover (R-11, R-2)?                                                                                | 6 dev (the S-10 input as dev problem 1) + 3 holdout, at least 3 languages, kinds bug, feature and refactor; 3 + 1; 10 + 5                                                                                                                                                                 | 6 + 3                                                              | resolved · 6 dev + 3 holdout, 3 languages, bug, feature and refactor · 2026-11-07                                                                                               |
| D-4  | Which contestants run by default (R-18)?                                                                                                   | `harnu:spec` vs Superpowers, `tlc-spec-driven` opt-in by flag; all three always; `harnu:spec` alone vs its previous version                                                                                                                                                               | `harnu:spec` vs Superpowers                                        | resolved · `harnu:spec` vs Superpowers, `tlc-spec-driven` by `--with-tlc` · 2026-11-07                                                                                          |
| D-5  | How many repeats, and when is a skill change accepted (R-15, R-12)?                                                                        | 2 runs per problem per contestant, accepted when the mean dev gain exceeds the larger repeat spread and holdout does not regress; 3 runs; a single run                                                                                                                                    | 2 runs and the spread rule                                         | resolved · 2 runs; accepted when the mean dev gain exceeds the larger repeat spread and the holdout does not regress · 2026-11-07 (the minimum tolerance is D-13)               |
| D-6  | How is the token cost bounded (R-18)?                                                                                                      | a per-round cap (default 300M) with abort and resume of a partial round, plus a `--dry-run` on `haiku` for the harness's own tests; no cap; a per-problem cap only                                                                                                                        | a per-round cap                                                    | resolved · a per-round token cap of 300M with abort and resume, `--dry-run` on `haiku` for the harness's own tests · 2026-11-07 (the 300M default is superseded by D-11)        |
| D-7  | Who authors answer sheets, atoms and hidden tests (R-17)?                                                                                  | an isolated session in a clean copy without `resources/skills/**`, the operator reviewing the answer sheets; the operator writes them; any session                                                                                                                                        | the isolated session                                               | resolved · an isolated session in a copy without the skill files and the documents that describe them (the exclusion list); the operator reviews the answer sheets · 2026-11-07 |
| D-8  | Is the real-world signal from spec-born missions in scope (R-19)?                                                                          | out of scope, a non-goal and a follow-up card; in scope as a slice                                                                                                                                                                                                                        | out of scope                                                       | resolved · out of scope (NG-1), a follow-up card, T678 · 2026-11-07                                                                                                             |
| D-9  | What does "the holdout does not regress" mean in the acceptance rule (R-15, R-12)?                                                         | a drop no larger than the holdout's own repeat spread still passes; any drop rejects the change                                                                                                                                                                                           | a drop no larger than the holdout's own repeat spread still passes | resolved · a drop no larger than the holdout's own repeat spread still passes · 2026-11-07 (the minimum tolerance is D-13)                                                      |
| D-10 | R-14 asks for fresh problems each round authored after the last skill change; does a holdout usage warning replace it?                     | `compare` warns when a holdout problem has been used in more than 3 accepted comparisons; mechanical check that every holdout problem's authoredAt is later than the last commit touching the skill                                                                                       | the usage warning                                                  | resolved · the usage warning: `compare` warns when a holdout problem has been used in more than 3 accepted comparisons · 2026-11-09                                             |
| D-11 | The budget correction splits a round per split and gates the holdout on an accepted dev compare; what is the default cap per round (R-18)? | per-split rounds, holdout gated, default cap 400M; per-split rounds, holdout gated, default cap 300M (dev rounds will routinely stop at the cap); one combined round, cap 500M                                                                                                            | per-split rounds, holdout gated, default cap 400M                  | resolved · per-split rounds, the holdout gated on an accepted dev compare, default cap 400M · 2026-11-09                                                                        |
| D-12 | How much of the holdout does a report show (R-6, R-12)?                                                                                    | aggregates per contestant only; per-problem numbers under opaque labels                                                                                                                                                                                                                   | aggregates per contestant only                                     | resolved · aggregates per contestant only · 2026-11-09                                                                                                                          |
| D-13 | What is the minimum tolerance in the acceptance rule (R-15)?                                                                               | floor of 2 percentage points on S and SH; no floor                                                                                                                                                                                                                                        | floor of 2 percentage points on S and SH                           | resolved · floor of 2 percentage points on S and SH · 2026-11-09                                                                                                                |

## Amendments · Deviations

Append-only after approval. Never edit the sections above once the first card is dispatched;
record the change here and send the affected executor a delta.

| date       | kind      | what changed                                                                                                                                                                                                                                                                                                                                                                | by               |
| ---------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 2026-11-07 | amendment | D-1 to D-9 resolved by the operator while the spec was drafted, D-1 replacing the card's `tools/bakeoff/` shape with `scripts/eval/bakeoff/`.                                                                                                                                                                                                                               | T676             |
| 2026-11-08 | amendment | D-6's cost assumption is wrong (see Budget); the correction, per-split rounds with the holdout gated on an accepted dev compare and its default cap, is proposed as open decision D-11, and D-12 and D-13 are escalated with it.                                                                                                                                            | T676             |
| 2026-11-09 | amendment | D-10 to D-13 answered by the operator (the usage warning; per-split rounds, the holdout gated on an accepted dev compare, default cap 400M; aggregates per contestant only; a floor of 2 percentage points on S and SH). D-11 supersedes the 300M default of D-6.                                                                                                           | T676             |
| 2026-11-09 | amendment | AC-44: the "every `--model` is `fake-haiku`" check excludes the model probe invocations, which must pass `--model haiku` to resolve the id. Slice S-5.                                                                                                                                                                                                                      | T676 bookkeeping |
| 2026-11-09 | amendment | Formats (Containment table, judge row) and AC-32: each judge session runs in a neutral `<work root>/judge-cwd/<uuid>/` holding `bundle.md` alone, removed afterwards, because Claude Code puts the working directory in the system prompt and `<unit>/judge-<n>/` named the contestant; results, transcripts and `discarded.json` stay under `judge-<n>/`. Slices S-3, S-5. | T676 bookkeeping |
| 2026-11-09 | amendment | Formats (Sessions): every `claude -p` also passes `--strict-mcp-config` with no `--mcp-config`, so user-scope MCP servers cannot load. Slice S-2.                                                                                                                                                                                                                           | T676 bookkeeping |
| 2026-11-09 | amendment | Formats (The build): the copied hidden files are removed from the build clone before `test` runs (a file a hidden file had replaced is restored from the index), so `existing.exitCode` covers the existing suite only. Slice S-4.                                                                                                                                          | T676 bookkeeping |
| 2026-11-09 | amendment | Formats (Containment): `HARNU_BAKEOFF_HOLDOUT`, `HARNU_BAKEOFF_WORK` and `HARNU_BAKEOFF_CACHE` are stripped from every child process and every session. Slices S-1, S-2.                                                                                                                                                                                                    | T676 bookkeeping |
| 2026-11-09 | amendment | Formats (Corpus): `hidden.dest` is held to the same containment as `hidden.files` (relative, no `..` escape), refused with `FILE_MISSING`. Slice S-1.                                                                                                                                                                                                                       | T676 bookkeeping |
| 2026-11-09 | amendment | Formats (Usage): after moving a session's transcripts, its project directory under the Claude projects root is removed when only an empty `memory/` remains. Slice S-6 (edit in `claude.mjs`).                                                                                                                                                                              | T676 bookkeeping |
| 2026-11-09 | amendment | Formats (Validation) and AC-11: the corpus authoring rule that Python hidden tests import a new symbol inside each test function, because a pytest collection failure stays a validation failure. Slices S-4, S-7.                                                                                                                                                          | T676 bookkeeping |
