# Bake-off harness — CLI reference

Mechanical, multi-problem evaluation of spec skills: one command runs a round (contestant
sessions, a simulated operator, blind judges, a build of each artifact against hidden tests) and
writes a report with the run-to-run spread beside every number. This file is the reference; how
to run a round, author a problem, read the report and the rules the process follows are in the
dev guide, [`docs/dev/bakeoff.md`](../../../docs/dev/bakeoff.md). The contract is the spec,
[`docs/specs/2026-11-07-bakeoff-harness/spec.md`](../../../docs/specs/2026-11-07-bakeoff-harness/spec.md)
(section "Formats the slices build to").

```bash
npm run eval:bakeoff -- <command> [flags]     # = vite-node scripts/eval/bakeoff/run.mjs -- …
```

A round spends real tokens (tens to hundreds of millions). CI never runs one; the unit tests use a
fake `claude` (`tests/fixtures/eval-bakeoff/fake-claude.mjs`).

## Commands

| command                                                                                | does                                                                                                                                                         |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `run [flags]`                                                                          | validate the round's problems, run every unit (contestant runs, judges, builds) under `--jobs` and the token cap, then write the report                      |
| `resume <round-id> [--budget <tokens>]`                                                | rerun the units of a round that have no result file, then write the report; `--budget` can only raise the recorded cap                                       |
| `report <round-id>`                                                                    | rewrite `report.md` and `report.json` from the unit files (byte-identical when nothing changed)                                                              |
| `compare <baseline-round-id> <candidate-round-id>`                                     | the acceptance verdict for `harnu-spec` between two rounds of one split; writes `compare.json` in the candidate's round directory                            |
| `validate [--split dev\|holdout] [--problems <ids>]`                                   | validation only: each hidden suite fails on the pristine target and passes, three times, on `hidden/reference.patch`                                         |
| `list [--split dev\|holdout]`                                                          | dev: one line per problem, `<id>\t<kind>\t<language>`; holdout: the problem count only                                                                       |
| `author-sandbox <id> --split <dev\|holdout> --repo <url> --commit <sha> --pick <file>` | build the isolated authoring directory for a new problem and print the headless `claude -p` command that authors it                                          |
| `author-import <id> --split <dev\|holdout> --reference <file>`                         | copy a finished sandbox problem into its corpus root, write `--reference` as `hidden/reference.patch`, stamp `provenance.sandbox: true`, validate it         |
| `review <id> --split <dev\|holdout>`                                                   | print the request, the answer sheet and the atoms; on `y`, stamp `provenance.reviewedAt` and `reviewedBy` (`git config user.name`). Needs a terminal (below) |

`<ids>` is comma-separated (`--problems a,b`). A round id is the UTC start time,
`YYYYMMDD-HHMMSS`.

`review` reads its `y` from an interactive terminal. On a piped stdin (`printf 'y\n' | …`) it
exits 0 without stamping and without saying so (BUG-268); run it in a terminal, or under a pty
(`script -qec '<command>' /dev/null`). It also rewrites `problem.json` with expanded arrays, so run
`npx prettier --write <problem>/problem.json` afterwards to keep the diff to the two provenance
fields.

## `run` flags

| flag                       | default                                     | meaning                                                                                                                                                                                   |
| -------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--split <dev\|holdout>`   | `dev`                                       | the one split a round runs; the dev round runs first                                                                                                                                      |
| `--after <round-id>`       | none                                        | required by `--split holdout`: the candidate dev round whose `compare.json` accepted                                                                                                      |
| `--problems <ids>`         | every problem of the split                  | a subset, comma-separated; refused with `--split holdout` (`PROBLEMS_ON_HOLDOUT`)                                                                                                         |
| `--with-tlc`               | off                                         | add `tlc-spec-driven` to the default contestants `harnu-spec` and `superpowers`                                                                                                           |
| `--skill-ref <ref>`        | `HEAD`                                      | the git ref `harnu-spec`'s `tool/` is archived from (`resources/skills/skills/spec` plus `docs/specs/TEMPLATE.md`)                                                                        |
| `--repeats <n>`            | `2`                                         | runs per (problem, contestant)                                                                                                                                                            |
| `--judges <n>`             | `3`                                         | judges per run                                                                                                                                                                            |
| `--model <alias\|id>`      | `opus`                                      | contestant and builder model                                                                                                                                                              |
| `--operator-model <a\|id>` | `sonnet`                                    | simulated operator model                                                                                                                                                                  |
| `--judge-model <a\|id>`    | `sonnet`                                    | judge model; must resolve to a different full id than `--model` (`JUDGE_MODEL_SAME`)                                                                                                      |
| `--budget <tokens>`        | `400000000`                                 | the round's token cap; at or above it no new unit starts and the round exits 3                                                                                                            |
| `--jobs <n>`               | `floor(os.availableParallelism() / 2)`, ≥ 1 | units in flight; a higher value is clamped to that ceiling with a warning line                                                                                                            |
| `--seed <text>`            | the sha256 of the round id                  | seeds the blind labels `P`, `Q`, `R` per (problem, repeat)                                                                                                                                |
| `--dry-run`                | off                                         | the fixture corpus `fixtures/dry-run/`, `harnu-spec` alone, every model `haiku`, `--repeats 1`, `--judges 1`, `--budget 10000000`, split `dev`, `JUDGE_MODEL_SAME` waived, `dryRun: true` |

Aliases `opus`, `sonnet` and `haiku` are resolved to full ids by one probe `claude -p` each before
any unit; every later use, `round.json` and `compare` carry the full id. An unresolved alias exits
2 with `MODEL_UNRESOLVED`. No `effort` override is passed.

## Environment variables

| variable                        | meaning                                                                      | default                                           |
| ------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------- |
| `HARNU_BAKEOFF_HOLDOUT`         | absolute path of the private holdout clone                                   | none; required by `--split holdout`               |
| `HARNU_BAKEOFF_CACHE`           | mirrors, fetched tools, dev unit work, dev validation results, dev authoring | `${XDG_CACHE_HOME:-~/.cache}/harnu-bakeoff/cache` |
| `HARNU_BAKEOFF_WORK`            | holdout unit work and holdout validation results only                        | `${XDG_CACHE_HOME:-~/.cache}/harnu-bakeoff/work`  |
| `HARNU_BAKEOFF_CLAUDE_BIN`      | the `claude` executable (tests point it at a fake)                           | `claude`                                          |
| `HARNU_BAKEOFF_CLAUDE_PROJECTS` | where `claude` writes session transcripts                                    | `~/.claude/projects`                              |
| `HARNU_BAKEOFF_TIMEOUT_SCALE`   | test-only: a float that multiplies every time limit (never a count)          | `1`                                               |

The holdout, cache and work paths must resolve (realpath) outside the repository and the main
checkout, and the work root also outside the cache and the holdout clone; otherwise the command
exits 2 with `HOLDOUT_INSIDE_REPO`, `CACHE_INSIDE_REPO` or `WORK_NOT_CONTAINED` before any work.
`HARNU_BAKEOFF_HOLDOUT`, `HARNU_BAKEOFF_WORK` and `HARNU_BAKEOFF_CACHE` are stripped from every
child process and session. The problem's commands also see `BAKEOFF_JUNIT`, the path the hidden
command writes its JUnit XML to.

## Exit codes

| code  | meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0`   | finished; for `compare`, the verdict is `accepted`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `1`   | `compare` only: the verdict is `rejected` or `incomplete` (a dry-run round, or a round whose status is not `done`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `2`   | usage or configuration error, printed as `<CODE>: <message>` on stderr; nothing is spent after it. Codes: `USAGE`, `BAD_FLAG`, `NOT_YET`, `SPLIT_REQUIRED`, `HOLDOUT_UNSET`, `HOLDOUT_INSIDE_REPO`, `CACHE_INSIDE_REPO`, `WORK_NOT_CONTAINED`, `REPO_UNRESOLVED`, `PROBLEMS_ON_HOLDOUT`, `PROBLEM_UNKNOWN`, `CORPUS_EMPTY`, a validation failure or an unreviewed problem (`NOT_REVIEWED` and the other loader codes, then `<n> of <m> <split> problems failed validation`), `MODEL_UNRESOLVED`, `JUDGE_MODEL_SAME`, `DEV_NOT_ACCEPTED`, `TOOL_FETCH_FAILED`, `ROUND_NOT_FOUND`, `CORPUS_CHANGED`, `REPORT_MISSING`, `ROUNDS_DIFFER`, `NO_SHARED_PROBLEMS`, `ID_INVALID`, `PICK_MISSING`, `SANDBOX_EXISTS`, `ARCHIVE_FAILED`, `CHECKOUT_FAILED`, `SANDBOX_MISSING`, `SANDBOX_NOT_CLEAN`, `REFERENCE_MISSING`, `IMPORT_INVALID`, `VALIDATION_FAILED`, `GIT_USER_MISSING`; also `UNIT_FAILED` when a unit crashes mid-round (the round is left `interrupted` for `resume`) |
| `3`   | `run` / `resume`: aborted on the budget (`status: aborted-budget`); the report is written with what exists, and `resume <round-id> --budget <higher cap>` continues it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `130` | interrupted (Ctrl-C): every session is killed, its transcripts and usage go to the unit's `discarded/` and `discarded.json`, `status: interrupted`; `resume` reruns those units                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

Loader codes, from `corpus.mjs`, name the file or field at fault: `JSON_INVALID`, `ID_MISMATCH`,
`SPLIT_MISMATCH`, `KIND_INVALID`, `COMMIT_INVALID`, `FIELD_MISSING`, `FILE_MISSING`, `ATOMS_EMPTY`,
`NOT_SANDBOXED` (a holdout problem not authored in the sandbox) and `NOT_REVIEWED`
(`provenance.reviewedAt` null, refused by `run` and `resume`).

On a holdout split every command prints counters only (`unit 3/24 done`, `2 of 3 holdout problems
failed validation`), never a problem id, label or test name.

## Output files

| file                                                                     | written by                    | holds                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------ | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<main checkout>/.harnu/eval/bakeoff/<round-id>/round.json`              | `run`, `resume`               | `roundId`, `split`, `status` (`running` · `done` · `aborted-budget` · `interrupted`), `dryRun`, `args` (`"redacted"` on holdout), `seed`, `repeats`, `judges`, full model ids, `pins` (every contestant's resolved sha), `budget: { cap, spent }`, `problems` (id, content hash), `units` (id, state), `startedAt`, `finishedAt` |
| `<main checkout>/.harnu/eval/bakeoff/<round-id>/report.md`               | `run`, `resume`, `report`     | the human report: header, the eight measures, budget, confounds, (dev) per-run details; every number to 2 decimals                                                                                                                                                                                                               |
| `<main checkout>/.harnu/eval/bakeoff/<round-id>/report.json`             | `run`, `resume`, `report`     | the same, unrounded: `measures.<key>.rows` (dev only) and `.summary`, `runs`, `details` (dev only), `budget`, `confounds`                                                                                                                                                                                                        |
| `<main checkout>/.harnu/eval/bakeoff/<round-id>/compare.json`            | `compare`                     | `{ split, verdict, baseline, candidate, baselineSkillSha, candidateSkillSha }`                                                                                                                                                                                                                                                   |
| `<units root>/<problem>/<contestant>/r<k>/contestant.json`               | the contestant unit           | status, session ids, turns, stray replies, sub-agents, wall time, usage, the artifact's paths, spec lines and words                                                                                                                                                                                                              |
| `<units root>/<problem>/<contestant>/r<k>/judge-<n>.json`                | a judge unit                  | status, reason, blind label, raw and parsed reply, scores (coverage, decisions left, contradictions, AC totals, builder guesses), usage                                                                                                                                                                                          |
| `<units root>/<problem>/<contestant>/r<k>/build.json`                    | the build unit                | status, hidden `{ passed, total, flaky, failed }`, existing suite exit code, assumptions logged, diffstat, usage, wall time                                                                                                                                                                                                      |
| `<units root>/<problem>/<contestant>/r<k>/`                              | the units                     | `artifact/`, `operator-log.md`, `stream-<n>.jsonl`, `transcripts/<role>/`, `judge-<n>/bundle.md`, `judge-<n>.stream.jsonl`, `build/` (`implementation.patch`, `ASSUMPTIONS.md`, `hidden-1.xml`, `hidden-2.xml`, `existing-suite.txt`, `stream.jsonl`), `<step>/discarded.json`, `discarded/<attempt>/`                           |
| `<units root>/<problem>/labels-r<k>.json`                                | the judges                    | the private map from blind label to contestant for one repeat                                                                                                                                                                                                                                                                    |
| `<units root>/_round/discarded.json`                                     | `run`                         | the model probes' usage (`phase: model-probe`)                                                                                                                                                                                                                                                                                   |
| `<validation root>/<key>.json`                                           | `validate`, `run`, `resume`   | one problem's cached validation result and its `testSet`; reused while the key (content hash + `versions` output) is unchanged                                                                                                                                                                                                   |
| `$HARNU_BAKEOFF_HOLDOUT/.rounds/<round-id>/problems.json`, `labels.json` | holdout `run`, `report`       | the per-problem state, scores and full args a holdout round keeps private, and the `H-1…H-n` labels                                                                                                                                                                                                                              |
| `$HARNU_BAKEOFF_HOLDOUT/.rounds/usage.json`                              | an accepted holdout `compare` | `{ counts: { <contentHash>: n }, pairs: [...] }`, the freshness counter behind the "used in more than 3 accepted comparisons" warning                                                                                                                                                                                            |
| `<authoring root>/<id>/`                                                 | `author-sandbox`              | `harnu/` (this repository minus the exclusion list), `target/`, `out/<id>/` (the problem skeleton and `pick.md`), `AUTHORING.md`                                                                                                                                                                                                 |

The units root is `$HARNU_BAKEOFF_CACHE/rounds/<round-id>/units/` on dev and
`$HARNU_BAKEOFF_WORK/rounds/<round-id>/units/` on holdout. The validation root is
`$HARNU_BAKEOFF_CACHE/validation/` on dev and `$HARNU_BAKEOFF_WORK/validation/` on holdout. The
authoring root is `$HARNU_BAKEOFF_CACHE/authoring/` on dev and
`$HARNU_BAKEOFF_HOLDOUT/.rounds/authoring/` on holdout. `.harnu/` is gitignored, so round files
never enter a commit by accident; they sit in the main checkout so `compare` works across
worktrees.

## Files of the harness

| path                 | role                                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `run.mjs`            | the entry point: flag parsing, the split and containment checks, model probes, the command table and dispatch        |
| `round.mjs`          | `run` and `resume`: loading and validating the round's problems, scheduling units under `--jobs` and the cap, Ctrl-C |
| `contestant-run.mjs` | one contestant run: the session, the simulated operator, the stray-reply nudge, the artifact                         |
| `judge.mjs`          | one judge: bundle, blind label, score-sheet reply, its validation and scores                                         |
| `build.mjs`          | the build: a builder session on a fresh checkout, then the hidden suite twice and the existing suite once            |
| `report.mjs`         | `report`: `report.md` / `report.json` from the unit files, the confounds list                                        |
| `compare.mjs`        | `compare`: the acceptance rule and the holdout freshness counter                                                     |
| `validate.mjs`       | `validate` and the validation every round runs first                                                                 |
| `list.mjs`           | `list`                                                                                                               |
| `author.mjs`         | `author-sandbox`, `author-import`, `review`, and the exclusion list                                                  |
| `corpus.mjs`         | the corpus loader, its error codes, and the content hash                                                             |
| `checkout.mjs`       | target checkouts from bare mirrors and every problem command, under `nice -n 19` with the single-thread variables    |
| `claude.mjs`         | the one way to run `claude -p`: stdin prompts, resume, deadlines, model resolution, transcript moves, `killAll`      |
| `contestants.mjs`    | the contestant table and how each method is fetched into `tool/`                                                     |
| `anonymize.mjs`      | the judge bundle (front matter stripped, tells replaced by `[tool]`) and the seeded label shuffle                    |
| `junit.mjs`          | the strict JUnit XML parser (`JUNIT_CORRUPT`)                                                                        |
| `usage.mjs`          | token sums per role (deduplicated by `message.id`) and sub-agent counts                                              |
| `budget.mjs`         | spent tokens of a round and the cap check                                                                            |
| `usage-rollup.mjs`   | tokens by phase and by contestant for the report                                                                     |
| `limits.mjs`         | every bound of the loop (turns, exchanges, deadlines, timeouts); the only place those numbers live                   |
| `paths.mjs`          | the roots, containment, and where each split writes                                                                  |
| `prompts/`           | `contestant.md`, `operator.md`, `score-sheet.md`, `builder.md`, `author.md` (the sandbox's `AUTHORING.md`)           |
| `corpus/dev/<id>/`   | the dev corpus, v1: six problems (python, typescript, go; bug, feature, refactor)                                    |
| `fixtures/dry-run/`  | the one-problem corpus of `--dry-run` (`slugify-basic`, inline JavaScript, `node --test`)                            |
| `HOLDOUT.md`         | the README to copy into the private holdout repository                                                               |

Tests: `tests/eval-bakeoff-*.test.ts`, with fixtures under `tests/fixtures/eval-bakeoff/`.
