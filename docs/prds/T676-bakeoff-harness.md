# T676 — Bake-off harness: measure spec skills on many problems, with a holdout nobody can tune against

**Status:** PRD v1 (2026-11-07) · **Card:** T676 (child of T601) · **Spec:** `docs/specs/2026-11-07-bakeoff-harness/spec.md` · **ADR:** `docs/adr/0025-bakeoff-harness.md`
**Evidence:** the T601 S-10 bake-off (`docs/specs/2026-11-harnu-spec/bakeoff/protocol.md`, `report.md`), the mission behavior eval (`scripts/eval/mission-behavior/`), lesson `docs/lessons/testing/006-eval-harness-grades-state-through-the-real-transport.md`.

This PRD says who the harness is for and what they see. The spec says what is built, in which slices, and how each criterion is proven.

## 1. Who is this for

Contributors who change a spec-authoring skill — today the maintainer and the sessions that work for him on `harnu:spec` (the next two are BUG-259 and T674). They want one answer before they keep a change: did it make specs better on problems the change was not written against, by more than the noise of running the same thing twice? The harness is a developer tool. End users of Harnu never see it.

## 2. The problem in one paragraph

The S-10 bake-off answered "how does `harnu:spec` compare with Superpowers and `tlc-spec-driven`?" once, on one problem, with one run each, and with a session in the middle relaying every question. It was honest about its limits: a one- or two-test gap is inside run-to-run noise, and the order on the headline number is not robust. The operator's fear (2026-11-07) is what happens next: the skill gets tuned until it wins on that problem, and then gets worse on real ones. A measuring stick that resists that needs many problems, repeats, a part of the corpus that nobody tuning the skill can read, and a rule for accepting a change that is fixed before the numbers come in.

## 3. What the contributor sees

### 3.1 One command per round

```bash
npm run eval:bakeoff -- run                          # dev corpus, harnu:spec vs Superpowers, 2 repeats
npm run eval:bakeoff -- run --split holdout --after 20261115-101200   # only after compare accepted on dev
npm run eval:bakeoff -- run --with-tlc --problems sqlite-utils-json-key
npm run eval:bakeoff -- run --dry-run                # the harness's own smoke test on haiku
npm run eval:bakeoff -- resume 20261108-091500 --budget 400000000
npm run eval:bakeoff -- compare 20261108-091500 20261115-101200
```

A round runs unattended. For each problem, contestant and repeat it starts a fresh contestant session in a clone of the pinned target, outside this repo. A simulated operator answers the contestant's questions from the problem's answer sheet, and the harness sends each answer back by resuming the contestant's session. Three judges on a different model then score the anonymized artifact. Last, a fresh builder implements the spec, and the hidden tests run on what it built. The terminal shows progress per unit and, at the end, the path of the report. On a holdout round it shows counters only, no problem id or test name.

### 3.2 The report

`report.md` (and `report.json` beside it) under the round's directory. A round is one split, so **dev** and **holdout** are reported apart, never pooled into one number. A dev report has one table per measure, with problems and contestants as rows. Every run's value is shown, then the mean, then the **spread** (max − min across repeats), so the noise sits next to every number:

| measure               | from          |
| --------------------- | ------------- |
| hidden-test pass rate | the build     |
| atom coverage         | the judges    |
| decisions left        | the judges    |
| contradictions        | the judges    |
| executable proofs     | the judges    |
| builder guesses       | judges, build |
| cost                  | the sessions  |

Then the runs table (done, incomplete, failed, judges not run, flaky hidden tests), the budget (cap, spent, remaining, by phase and by contestant, retries and discarded attempts included) and a confounds section naming what the design cannot hold constant, such as a spec that stays recognizable by its structure once its name is removed.

Dev rows name the problem and list the hidden tests that failed and what the judges noted. That is the material a contributor uses to find a failure class. **A holdout report carries aggregates only**: per contestant, the mean, the spread and how many problems. There is no per-problem row, no label, no failed test name and no judge note (decision D-12). A holdout failure can never be read in enough detail to fix the skill against it. The holdout's privacy from a session on the same machine is by convention: no session tuning the skill is handed its path, and there is no OS sandbox.

### 3.3 The verdict

`compare <baseline> <candidate>` compares two rounds of one split and prints one of three words for `harnu:spec`. On dev, the mean gain in hidden-test pass rate must beat the larger of the two rounds' repeat spread. On holdout, the mean must not drop by more than its own spread. Each spread is floored at 2 percentage points, so two lucky identical runs cannot accept any gain (decision D-13). The rule is deliberately coarse: it is not a statistical test.

- **accepted**: the condition for that split holds;
- **rejected**: it does not;
- **incomplete**: a round is a dry run or did not finish.

The dev round runs first. The holdout round runs only after `compare` accepted on dev, and a skill change is accepted only when both comparisons are. `compare` refuses, naming the field, when the rounds differ on models, judge count, repeats or the baseline contestants' pins, and a problem counts as shared only when its content hash matches in both rounds. It warns when a holdout problem has been used in more than 3 accepted comparisons, so a fresh one gets written (decision D-10, in place of a mechanical check that a holdout problem was authored after the skill last changed).

### 3.4 Writing a new problem

`author-sandbox` prepares a directory outside the repo: a copy of this repo without the skill files and the documents that describe them (removed by a fixed exclusion list, and a test greps the sandbox for telltale terms), a clone of the target at its pin, and a problem skeleton. The pick is made outside the sandbox, by the executor (the operator, for a holdout problem), and logged in `pick.md`, which `author-sandbox` copies in; the authoring session never picks. The reference patch is extracted from the merged change before the session starts and stays outside the sandbox, and `author-import` adds it; the authoring session never reads it. The contributor runs the headless `claude -p` command that `author-sandbox` prints, from that directory, and the session writes the request, the answer sheet, the hidden atoms and the hidden tests, so whoever writes the truth never read `SKILL.md`. `author-import` brings the problem into the dev corpus, or into the private holdout clone, and validates it. `review` shows the answer sheet to the operator, and only an operator-reviewed problem can run.

## 4. Edge cases

- **The budget is hit.** The harness stops starting units once the round's tokens reach the cap (default 400M, per round, a round being one split; decision D-11, which supersedes D-6's 300M). Retries and discarded attempts count against it. S-10's numbers put a default dev round at about 300M before judges, inside the cap; `resume --budget` raises it when a round needs more. Units already running finish. The round is marked `aborted-budget`, the report is written with what exists, and the exit code is 3. `resume <round-id>` runs only what is missing, and `--budget` can raise the cap. The cap can be overrun by the units in flight, never more.
- **A contestant that never stops asking.** An operator turn is one question and its answer. After 12 of them, the 13th question gets "The operator is unavailable. Answer from your best judgement". A 14th question ends the run `incomplete`. So do three replies that neither ask nor finish, or 150 minutes in total. An incomplete run is still judged and built from whatever it wrote. A run that wrote nothing scores 0, never "not counted".
- **A flaky hidden test.** Validation runs the hidden suite three times on the reference patch and refuses a problem in which any test flips, before any token is spent. In a build, the suite runs twice. A test that passes only once counts as failed, and the report lists it as flaky. A run with missing or corrupt JUnit output counts every test in it as failed.
- **A holdout path inside the repo.** The harness resolves `HARNU_BAKEOFF_HOLDOUT` to its realpath. If that is inside this worktree or the main checkout, even through a symlink, it exits 2 with `HOLDOUT_INSIDE_REPO` before doing anything. The cache directory (`CACHE_INSIDE_REPO`) and the directory for holdout unit work, `HARNU_BAKEOFF_WORK` (`WORK_NOT_CONTAINED`, also refused inside the cache or the holdout clone), get the same check, because clones and transcripts live there.
- **No holdout configured.** `--split holdout` without the variable exits 2 with `HOLDOUT_UNSET`. A dev round needs nothing.
- **A crashed session.** A turn with no result event is retried once from scratch. A second crash marks the run `failed`, scored 0.
- **A judge that answers in prose.** It is retried once, then recorded `not-run`. It is left out of the means and counted in the runs table.
- **The judge model equals the contestant model.** Refused with `JUDGE_MODEL_SAME`, except in a dry run. The operator and the judge may share a model, since the operator scores nothing.
- **Ctrl-C.** Every session the harness started is killed, its transcripts are moved out of the projects directory, its tokens are added to the round's spend, and `resume` picks up the rest.
- **An unreviewed or invalid problem.** The round refuses to start and names the problem and the defect; for a holdout problem the terminal shows only a count and the details are written under `HARNU_BAKEOFF_WORK`.

## 5. Success

- A contributor runs a round with one command and nobody relays anything (AC-16).
- The S-10 input, re-run, lands on the S-10 numbers within the noise the harness itself measures (AC-30). This checks that the harness reproduces a prior measurement, not which tool is best.
- A sentinel planted in every holdout file never appears in the repo or in a report (AC-18).
- A change that wins on dev only by noise is rejected by `compare` (AC-19).

## 6. Alternatives considered

| option                                                                 | one line                                                                                                           | verdict                                                          |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `scripts/eval/bakeoff/` `.mjs` on `claude -p`, operator via `--resume` | Reuses the mission-behavior eval's conventions (vite-node, stream-json, `cleanEnv`, `escalate`); no new dependency | **Chosen** (D-1)                                                 |
| `tools/bakeoff/` in TypeScript on the Claude Agent SDK                 | The card's first shape: the SDK answers questions in-process, but adds a dependency and a second eval convention   | Rejected (D-1)                                                   |
| A Python library outside Harnu                                         | The operator's first question; it would separate the tool from the skill it measures and from the repo's CI        | Rejected; extractable later from `scripts/eval/bakeoff/` (NG-2)  |
| Holdout in a private GitHub repo cloned outside the repo               | Private by construction, versioned, shareable with a second maintainer                                             | **Chosen** (D-2)                                                 |
| Holdout in a local untracked directory                                 | No repo to create, but no history and no backup, and one `git add -f` away from the public repo                    | Rejected (D-2)                                                   |
| Holdout as encrypted files in this repo                                | One place for everything, but a key to manage, and the ciphertext invites exactly the curiosity the split forbids  | Rejected (D-2)                                                   |
| Corpus 3 + 1, or 10 + 5                                                | 3 + 1 is too thin to tell a gain from noise; 10 + 5 costs about twice a round                                      | 6 + 3 chosen (D-3)                                               |
| All three contestants always                                           | Costs about 1.5× a round for a third tool that is rarely the baseline that matters                                 | Rejected; `--with-tlc` (D-4)                                     |
| `harnu:spec` alone against its previous version                        | Cheaper, but loses the external baseline that tells "better" from "different"                                      | Rejected (D-4); `--skill-ref` still lets a round pin any version |
| 3 repeats, or a single run                                             | 3 costs 1.5×; a single run has no variance at all                                                                  | 2 chosen (D-5)                                                   |
| No token cap, or a per-problem cap only                                | No cap lets a looping contestant spend without limit; a per-problem cap cannot stop a round                        | A per-round cap with resume (D-6)                                |
| The operator writes answer sheets and tests, or any session does       | The operator's time is the scarce resource; any session may have read `SKILL.md`                                   | An isolated sandbox session, reviewed by the operator (D-7)      |
| Real-world mission signal as a slice                                   | It outranks the benchmark, but it reads mission ledgers and verifier verdicts, a different system                  | Out of scope, a follow-up card (D-8)                             |

## 7. Not in this PRD

The real-world signal from spec-born missions (NG-1). Running the bake-off in CI (NG-3). UI and greenfield problems (NG-4). The holdout problems themselves, which the operator authors into the private repo (NG-6).
