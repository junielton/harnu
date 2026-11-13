# The spec bake-off: how to run it, extend it and read it

The bake-off harness measures spec skills mechanically. One command gives each contestant
(`harnu-spec` and a baseline) the same feature request on a pinned repository, lets it question a
simulated operator, scores its artifact with blind judges, has a fresh session build from the
artifact, and runs hidden tests nobody in the loop saw. It repeats every run, so each number comes
with its run-to-run spread, and it decides whether a skill change is an improvement by a rule fixed
in advance.

It exists because tuning `harnu:spec` against one hand-picked problem (the T601 S-10 bake-off)
teaches the skill that problem. The harness spreads the signal over a varied corpus and keeps a
private holdout the skill is never tuned against.

- CLI reference (every command, flag, variable, exit code and file):
  [`scripts/eval/bakeoff/README.md`](../../scripts/eval/bakeoff/README.md)
- The contract: [`docs/specs/2026-11-07-bakeoff-harness/spec.md`](../specs/2026-11-07-bakeoff-harness/spec.md)
- The decision record: [`docs/adr/0025-bakeoff-harness.md`](../adr/0025-bakeoff-harness.md)
- The reproduction of S-10 the harness was checked against:
  [`docs/specs/2026-11-07-bakeoff-harness/reproduction/`](../specs/2026-11-07-bakeoff-harness/reproduction/)

## The rules (process, not code)

These seven rules are how the harness is used. Most are not enforced by code; they hold because
the people and sessions changing the skill follow them. Breaking one does not make a round fail;
it makes its result worthless.

1. **A varied corpus.** Problems cover bug, feature and refactor (UI and greenfield come in a
   later corpus version), several languages and several repositories. The target is 8–12; corpus
   v1 is 6 dev problems in Python, TypeScript and Go, plus 3 holdout problems. Never add a problem
   because the skill does well or badly on it: new problems come from the pick rule (below).
2. **A dev / holdout split.** Skill changes look only at dev results. The holdout only confirms a
   version: nobody reads a holdout failure to fix the skill, and the harness makes that hard by
   reporting the holdout as aggregates only. A dev gain with no holdout gain means the change
   overfit the dev problems; it is rejected.
3. **The holdout lives outside this public repository**, in a private repository cloned outside
   it, reached only through `HARNU_BAKEOFF_HOLDOUT`. No session that tunes the skill is given
   that variable or `HARNU_BAKEOFF_WORK`. The harness refuses an in-repo path, but there is no OS
   sandbox: privacy is by convention.
4. **Fresh holdout problems** (as this harness scopes it, D-10). Freshness applies to the holdout
   only; the dev corpus is fixed per corpus version (changing a dev problem makes a new version).
   `compare` counts every accepted holdout comparison per problem and prints a warning when a
   holdout problem has been used in more than 3 of them. When you see that warning, author a fresh
   holdout problem before the next skill version is confirmed.
5. **2–3 repeats per problem; a change is accepted only when its effect exceeds the run-to-run
   spread.** The default is 2 repeats, and `compare` applies the acceptance rule below. Never
   accept a change by reading one run or one problem.
6. **Every skill change names its failure class, never a problem-specific detail.** A commit or
   PR that changes the skill states the general way specs fail that it addresses ("decisions the
   request leaves open are not asked", "acceptance criteria with no executable proof"), never a
   corpus detail ("handle the `key` argument of `rows_from_file`"). If you can only describe the
   change in terms of one problem, it is overfitting; drop it.
7. **Whoever writes an answer sheet or hidden tests never reads `SKILL.md`.** Problems are
   authored by a headless session in the author sandbox, a copy of this repository with every
   file that names or describes the skill removed (D-7). Holdout problems must be authored there
   (`provenance.sandbox: true` is enforced); P1 of the dev corpus predates the rule.

## Before the first round: machine prerequisites

| tool             | needed for                                                 | notes                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude`         | every session                                              | logged in; `HARNU_BAKEOFF_CLAUDE_BIN` points at another binary                                                                                                                                                                                                                                                                                                                    |
| `git`            | mirrors, checkouts, `git apply` of reference patches       | see the warning on wrapped `git` below                                                                                                                                                                                                                                                                                                                                            |
| `python3`        | Python problems (`python3 -m venv`, pytest's JUnit output) | the venv's `pip` must support `--group` (pip ≥ 25.1): P1's `setup` is `.venv/bin/pip install -e . --group dev`                                                                                                                                                                                                                                                                    |
| `node` and `npm` | the harness itself (`vite-node`) and TypeScript problems   | Node 22; one problem installs `pnpm@10.19.0` through `npx -y`                                                                                                                                                                                                                                                                                                                     |
| Go **1.24**      | Go problems                                                | `gotest.tools/gotestsum@v1.12.0` does not build on Go 1.25. Put a 1.24 `bin` first on `PATH` in the shell that runs the round. On a mise install that is `export PATH="$HOME/.local/share/mise/installs/go/1.24/bin:$PATH"`: a mise shim with no Go version set fails, so the problem's `versions` command (`go version`) exits non-zero and validation reports `VERSIONS_FAILED` |

The JUnit reporters are not installed by hand: each is a line of its problem's `setup`, pinned with
the problem, and runs in every checkout that runs `setup`:

| runner                | reporter, installed by `setup`                                |
| --------------------- | ------------------------------------------------------------- |
| pytest                | built in (`--junitxml`)                                       |
| Go                    | `GOBIN="$PWD/.bin" go install gotest.tools/gotestsum@v1.12.0` |
| jest                  | `npm i --no-save jest-junit`                                  |
| mocha                 | `npm i --no-save mocha-junit-reporter`                        |
| vitest, `node --test` | built in                                                      |

**Wrapped `git`.** If `git` on your `PATH` is a proxy that rewrites its output (for example a
token-saving wrapper that compacts `git diff`), use `/usr/bin/git` for any patch meant to be
applied: `/usr/bin/git diff <pin> <merge> -- <non-test files> > <id>.reference.patch`. The S-10
reference patch was compacted `rtk git diff` output that `git apply` refuses, which is why P1's
`hidden/reference.patch` had to be reconstructed. The harness itself calls `git` through
`execFile`, but a patch you make by hand goes through your shell.

**CPU.** The harness runs every command and session under `nice -n 19` with `GOMAXPROCS=1`,
`PYTEST_ADDOPTS=-p no:xdist` and `npm_config_jobs=1`, and caps `--jobs` at half the machine's
cores. Start the round itself under `nice -n 19` too, and run nothing else heavy beside it.

## Running a round

A round runs one split. The dev round always comes first; the holdout round runs only after
`compare` accepted the dev round.

```bash
export PATH="$HOME/.local/share/mise/installs/go/1.24/bin:$PATH"   # Go 1.24, see above

npm run eval:bakeoff -- list                           # the dev problems
npm run eval:bakeoff -- validate                       # every dev problem proves its hidden suite (cached)
npm run eval:bakeoff -- run --dry-run                  # the harness end to end on haiku, ~10M cap
nice -n 19 npm run eval:bakeoff -- run                 # a real dev round: harnu-spec vs superpowers
```

`run` prints a line per finished unit (`unit 6/30 done (<unit id>)`). The round id is the UTC
start time, `YYYYMMDD-HHMMSS`, and names the round's directory: the newest one under
`<main checkout>/.harnu/eval/bakeoff/` is the round in flight. It validates every problem before spending anything: a problem whose hidden suite does not
fail on the pristine checkout and pass on its reference patch, or that nobody reviewed
(`NOT_REVIEWED`), stops the round with exit 2. Everything it writes for the round is under
`<main checkout>/.harnu/eval/bakeoff/<round-id>/` (`round.json`, `report.md`, `report.json`), and
the units' work under `$HARNU_BAKEOFF_CACHE/rounds/<round-id>/units/`.

To measure a skill change, run the baseline and the candidate on the same problems with the same
models, judges and repeats, then compare:

```bash
nice -n 19 npm run eval:bakeoff -- run --skill-ref <baseline sha>     # → round A
nice -n 19 npm run eval:bakeoff -- run --skill-ref <candidate sha>    # → round B
npm run eval:bakeoff -- compare <A> <B>                               # dev verdict, exit 0 = accepted
```

Only after a dev `accepted`, confirm on the holdout, once for each side:

```bash
export HARNU_BAKEOFF_HOLDOUT="$HOME/holdout/bakeoff-holdout"    # this shell only
nice -n 19 npm run eval:bakeoff -- run --split holdout --after <B> --skill-ref <baseline sha>   # → C
nice -n 19 npm run eval:bakeoff -- run --split holdout --after <B> --skill-ref <candidate sha>  # → D
npm run eval:bakeoff -- compare <C> <D>
```

`--after` names the candidate dev round; it is refused (`DEV_NOT_ACCEPTED`) unless that round's
`compare.json` accepted on dev and `--skill-ref` is its baseline or candidate sha. A skill change is
accepted only when the dev comparison and then the holdout comparison are both accepted.

### Resuming a round

A round stops early in three ways, and `resume` continues each one, rerunning only the units with
no result file:

- **Budget** (exit 3, `status: aborted-budget`): no unit starts once spent tokens reach the cap;
  units in flight finish, and the report is written with what exists. Continue with a higher cap:
  `npm run eval:bakeoff -- resume <round-id> --budget 500000000`. Never start a second fresh round
  instead: it pays again for every unit already done.
- **Ctrl-C** (exit 130, `status: interrupted`): every session is killed, and its tokens are kept in
  the unit's `discarded.json`, so they still count toward the cap.
- **A crashed unit** (exit 2, `UNIT_FAILED`, `status: interrupted`).

`resume` refuses a round whose problem files changed since it started (`CORPUS_CHANGED`).

## Authoring a problem

A problem is a directory under `scripts/eval/bakeoff/corpus/dev/<id>/` (dev) or
`$HARNU_BAKEOFF_HOLDOUT/<id>/` (holdout):

```text
<id>/
  problem.json            target pin, setup, test command, hidden command, provenance
  pick.md                 how the problem was picked
  request.md              what a contestant receives, verbatim
  answer-sheet.md         what the simulated operator answers from
  hidden/atoms.md         the requirements judges score coverage against (an `id` column, R-1, O-1 …)
  hidden/<test files>     the hidden suite, 15–60 tests
  hidden/reference.patch  the real upstream change; proves the suite passable
```

The steps, for a dev problem:

1. **Pick it by the pick rule** (spec, S-7). Each language has a fixed list of candidate
   repositories; in each, take the latest pull request merged before the cutoff that matches the
   slot's kind and changes at most 20 non-test files; the pin is the first parent of its merge
   commit; the first candidate whose `setup` and suite finish within the validation limit on one
   core wins. Write what you considered, the rule, the date and the one chosen (repository, pull
   request, closing issue, pin) to `$HARNU_BAKEOFF_CACHE/authoring/<id>.pick.md`. The id is
   `<repo name>-<two or three words of the request>`. Never widen the rule to fill a slot.
2. **Extract the reference patch** outside the sandbox, with `/usr/bin/git` if `git` is wrapped:
   the diff of the non-test files between the pin and the merge commit, to
   `$HARNU_BAKEOFF_CACHE/authoring/<id>.reference.patch`.
3. **Build the sandbox:**
   `npm run eval:bakeoff -- author-sandbox <id> --split dev --repo <url> --commit <pin> --pick $HARNU_BAKEOFF_CACHE/authoring/<id>.pick.md`.
   It holds `harnu/` (this repository minus the exclusion list, so the author cannot read the
   skill), `target/` (the pinned checkout), `out/<id>/` (the problem skeleton) and `AUTHORING.md`.
4. **Fill in what the author must not choose**, in `out/<id>/problem.json`: `kind`, `language`,
   `setup` (with the JUnit reporter line), `test` (the target's own suite), `versions` (prints the
   interpreter `setup` uses) and `hidden.cmd` (writes JUnit XML to `$BAKEOFF_JUNIT`, with the
   matching reporter). Put the closing issue's title and body in `out/<id>/request.md` (for a
   refactor with no issue, the pull request's).
5. **Run the authoring session** with the command `author-sandbox` printed, from the sandbox
   directory, prompt on stdin. It writes the answer sheet, the atoms, the hidden tests and the
   remaining `hidden` fields (`files`, `dest`, `compileErrorPattern`). `AUTHORING.md` carries the
   authoring rules: the answer sheet opens with the S-10 general entries G-1, G-2 and G-4 verbatim
   and settles every behavior a test asserts that the request does not state; Python hidden tests
   import a new symbol inside each test function (a collection failure fails validation); a
   refactor's tests assert the new structure or API, since a behavior-only suite passes on the
   pristine checkout.
6. **Import it:** `npm run eval:bakeoff -- author-import <id> --split dev --reference $HARNU_BAKEOFF_CACHE/authoring/<id>.reference.patch`.
   It refuses a sandbox that still holds an excluded path, writes the reference patch, stamps
   `provenance.sandbox: true` and validates. A failed validation names each defect and the file
   with the details.
7. **Review it** in a terminal: `npm run eval:bakeoff -- review <id> --split dev`. Read the
   request, the answer sheet and the atoms, and answer `y` to stamp `reviewedAt` / `reviewedBy`.
   `review` needs an interactive terminal: on a piped stdin it exits 0 without stamping and says
   nothing (BUG-268). Then `npx prettier --write` the `problem.json` and commit the directory.
   `run` refuses any problem that is not reviewed.

**Validation**, which `run`, `author-import` and `validate` all perform, is the guarantee that a
problem can grade anything: `hidden.cmd` must fail on the pristine checkout (a failing testcase,
or a compile/import error matched by `hidden.compileErrorPattern`), and with the reference patch
applied it must pass every test three times in a row while the target's own `test` exits 0. The
result is cached by content hash and toolchain version, so it reruns only when either changes.

## The private holdout

The holdout is a private GitHub repository holding three problems in the same format (slots:
python bug, typescript feature, go refactor). Its README is
[`scripts/eval/bakeoff/HOLDOUT.md`](../../scripts/eval/bakeoff/HOLDOUT.md); copy it to the
repository's root. Clone it **outside this repository** and point the harness at it, in the shell
that runs a holdout round or authors a holdout problem only:

```bash
git clone <private url> ~/holdout/bakeoff-holdout
export HARNU_BAKEOFF_HOLDOUT="$HOME/holdout/bakeoff-holdout"
```

An in-repo path is refused (`HOLDOUT_INSIDE_REPO`). Holdout unit work goes to
`HARNU_BAKEOFF_WORK` (default `~/.cache/harnu-bakeoff/work`), never into this repository, and the
per-problem results stay in `$HARNU_BAKEOFF_HOLDOUT/.rounds/` (gitignored there). On a holdout
split the terminal shows only counters. The operator authors holdout problems, through the same
sandbox steps with `--split holdout` and the pick and patch files under
`$HARNU_BAKEOFF_HOLDOUT/.rounds/authoring/`.

## Reading the report

`report.md` opens with the round id, split, status, models and the resolved pin of every
contestant. Then one table per measure:

1. **hidden-test pass rate** (the headline): the share of hidden tests that pass on the build from
   the artifact, in both of two runs (a test that passes once is listed as flaky and counted as
   failed);
2. **coverage**: the share of `hidden/atoms.md` the judges call covered (partial counts half),
   averaged over the judges;
3. **decisions left** to the implementer (judge mean);
4. **contradictions** inside the artifact (judge mean);
5. **executable-proof share** of the acceptance criteria (judge mean);
6. **builder guesses** (judge mean) and **assumptions logged** (by the builder);
7. **cost per run**: tokens (total and output), wall time, operator turns, sub-agents, spec lines
   and words;
8. **runs**: done, incomplete, failed, judges with an invalid reply, flaky hidden tests.

**Dev vs holdout.** A dev report has, per measure, a row per problem × contestant with every run's
value, the mean and the **spread** (max − min across repeats), then a summary row per contestant
(mean of the problem means, mean of the problem spreads). A holdout report has the summary row
only, with `n`, the number of holdout problems: no problem, test name or judge note, so a holdout
failure cannot be read closely enough to tune against.

**Spread** is the noise. A difference between two contestants, or two skill versions, smaller than
the spread is not a difference.

**Budget**: the cap, spent (the same as `round.json`'s), remaining, status, and tokens by phase
(contestant, operator, judge, build, discarded) and by contestant. The model probes count as
`unattributed`.

**Confounds**: a fixed list of what the design does not blind or hold constant. The main one: a
judge sees an anonymized bundle (names replaced with `[tool]`, front matter stripped), but an
artifact's structure (an acceptance-criteria table, a plan checklist) can still betray its method.

Dev reports end with per-run details: the failed hidden tests and the judges' notes.

### `compare` and the acceptance rule

`compare <baseline> <candidate>` decides on the hidden-test pass rate of `harnu-spec` alone, over
the problems both rounds share with identical content. The other contestants are a control and are
not scored; the other measures are for reading, not deciding.

- **Dev:** gain `G` = mean over shared problems of (candidate mean − baseline mean), in percentage
  points; tolerance `S` = the larger of the two rounds' mean per-problem spread, **but at least 2
  points**. Accepted when `G > S`.
- **Holdout:** delta `H` and tolerance `SH`, the same way with the same floor of 2. Accepted when
  `H ≥ −SH`: a holdout drop no larger than its own spread is not a regression.

It refuses (exit 2) rounds of different splits or that differ on a model, the judge count, the
repeats or a baseline contestant's pin, and rounds with no shared problem; a dry-run round or one
that did not finish is `incomplete` (exit 1).

The rule is **deliberately coarse**: it is not a statistical test. With 2 repeats a spread is
two points of data, and the 2-point floor keeps a lucky pair of runs from passing as a gain. A
small real improvement can be rejected; that is the intended trade.

### What a round costs

The harness sums every session's tokens (input + cache write + cache read + output, per message,
sub-agents included). From S-10's figures a `harnu-spec` problem-run costs about 16.6M (spec plus
build) and a Superpowers one about 8.8M, so a default dev round (6 problems × 2 repeats × 2
contestants, plus judges) is about 300M and a holdout round about 150M. The default cap is 400M
per round. A skill change costs four rounds (two dev, two holdout); `--with-tlc` adds a third
contestant to each. The reproduction of S-10 measured one problem with all three contestants; its
`report.md` has the actual cost.
