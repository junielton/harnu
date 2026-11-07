# Bake-off report — `harnu:spec` vs Superpowers vs `tlc-spec-driven`

Run on 2026-11-07 by the rubric of S-10 in `../spec.md`, as `protocol.md` fixes it. One input:
sqlite-utils issue #489 ("load JSON records held under a single top-level key") at
`9c66bafa52ae23d40499c74b0db3b635bcddb876` (`input/feature-request.md`).

## Verdict

**Superpowers won the headline number; `harnu:spec` came last on it.** The build from the
Superpowers spec passed 53 of 53 hidden tests, the `tlc-spec-driven` build 52, the `harnu:spec`
build 51. `harnu:spec` lost on four measures. It had the lowest hidden-test pass rate and the
lowest coverage: all three judges marked one operator atom (O-9) _contradicted_. It was the only
spec any judge found a contradiction in. And it cost the most by a wide margin: 2.3× the tokens of
Superpowers and 3.7× those of `tlc-spec-driven`, the longest wall time, and 6 sub-agents. It came
second on the zero-decision count and on operator turns. It tied first only on executable proofs,
with `tlc-spec-driven` (every acceptance criterion names a runnable proof).

**Why it lost.** The two hidden tests it failed come from a decision the author made by itself.
Its D-3 question asked the operator about non-JSON input for the CLI commands only. The spec then
wrote `NG-5`: `rows_from_file()` _ignores_ `key=`/`auto_key=` for an explicit CSV/TSV/NL `format=`.
The operator's answer sheet says that raises `ValueError` (O-9). The spec settled that open
question with a non-goal instead of asking it, though the skill forbids resolving a decision on a
guess. Its six Goldfish reviewers (73 findings, all disposed) could not catch it: a reviewer sees
the spec, not the operator's intent. The readiness review also let through an acceptance criterion
that cannot hold as written. The executor found that "output starts with `Error:`" is false for
file inputs, because the progress bar prints a blank line first (`build/harnu-spec/assumptions.md.txt`).
Superpowers listed its guesses for the Python side for correction (operator turn 5), got the
`ValueError` rule back, and carried it into a planned test.

**How much the numbers weigh.** One input, one run per tool. A gap of one or two hidden tests is
inside run-to-run noise, and two of the six misses or near-misses are artifacts of the hidden suite
itself (see _Hidden-test pass rate_). The cost gap (2–4×) and the `NG-5` miss are robust; the order
of the three on pass rate is not.

## 1. Coverage — request and operator atoms (judges)

Score per judge: `covered` = 1, `partial` = 0.5, `contradicted` / `missing` = 0, over 24 atoms
(R-1–R-8 from the request, O-1–O-16 from the answer sheet; `hidden/atoms.md`).

| tool              | judge 1 | judge 2 | judge 3 | mean     | R (of 8) | atoms contradicted     |
| ----------------- | ------- | ------- | ------- | -------- | -------- | ---------------------- |
| `harnu:spec`      | 21.5    | 22      | 22      | **21.8** | 8 / 8    | O-9 (all three judges) |
| Superpowers       | 23.5    | 24      | 23.5    | **23.7** | 8 / 8    | —                      |
| `tlc-spec-driven` | 22.5    | 23      | 23      | **22.8** | 8 / 8    | —                      |

All three covered every request atom. Every point lost is an operator atom; the one all three lost
is O-13 (memory table names stay the file stem: implied by examples, never stated).

## 2. Zero-decision count — decisions left to the implementer (judges, lower is better)

| tool              | judge 1 | judge 2 | judge 3 | mean    |
| ----------------- | ------- | ------- | ------- | ------- |
| `harnu:spec`      | 5       | 4       | 4       | **4.3** |
| Superpowers       | 2       | 2       | 3       | **2.3** |
| `tlc-spec-driven` | 8       | 8       | 5       | **7.0** |

Counted as the judges listed them (judge 2's `harnu:spec` list includes one item it marks "settled").

Guesses a builder would need (judges, lower is better), for reference:

| tool              | judge 1 | judge 2 | judge 3 | mean |
| ----------------- | ------- | ------- | ------- | ---- |
| `harnu:spec`      | 4       | 3       | 3       | 3.3  |
| Superpowers       | 2       | 3       | 3       | 2.7  |
| `tlc-spec-driven` | 6       | 7       | 4       | 5.7  |

## 3. Contradictions inside the bundle (judges, lower is better)

| tool              | judge 1 | judge 2 | judge 3 | mean     |
| ----------------- | ------- | ------- | ------- | -------- |
| `harnu:spec`      | 0       | 0       | 1       | **0.33** |
| Superpowers       | 0       | 0       | 0       | **0**    |
| `tlc-spec-driven` | 0       | 0       | 0       | **0**    |

Judge 3's one is mild by its own words: the original R-4 bullet ("a single key") against the
resolved D-1, with R-4 annotated as superseded.

## 4. Acceptance criteria with an executable proof (judges)

| tool              | judge 1 | judge 2 | judge 3 | executable share |
| ----------------- | ------- | ------- | ------- | ---------------- |
| `harnu:spec`      | 32 / 32 | 32 / 32 | 32 / 32 | **100 %**        |
| Superpowers       | 35 / 37 | 25 / 29 | 35 / 37 | **92 %**         |
| `tlc-spec-driven` | 40 / 40 | 40 / 40 | 40 / 40 | **100 %**        |

Superpowers has no acceptance-criteria list; the judges counted the plan's tests and gates, and
disagreed on the count. Its non-executable items are prose docs checks.

## 5. Hidden-test pass rate — the build test (headline)

One fresh executor per spec (opus, no skills, no sub-agents) built it in its own scratch clone; then
`hidden/test_hidden_bakeoff.py` (53 tests) and the pinned existing suite ran on each build.

| tool              | hidden tests         | existing suite (1497 at the pin) | assumptions logged | build diff          |
| ----------------- | -------------------- | -------------------------------- | ------------------ | ------------------- |
| `harnu:spec`      | **51 / 53** (96.2 %) | 1497 passed, 16 skipped          | 8                  | 10 files, +792 / −9 |
| Superpowers       | **53 / 53** (100 %)  | 1497 passed, 16 skipped          | 9                  | 10 files, +871 / −5 |
| `tlc-spec-driven` | **52 / 53** (98.1 %) | 1497 passed, 16 skipped          | 12                 | 9 files, +810 / −10 |

Failed tests:

- `harnu:spec`: `test_rows_from_file_explicit_non_json_format_raises[Format.CSV]` and `[Format.TSV]`
  — the `NG-5` decision above. The `[Format.NL]` case passed only by accident: the CSV fixture
  is not valid JSON lines, so `json.loads` raises `JSONDecodeError`, a `ValueError` subclass.
  With valid newline-delimited JSON, that build ignores `key=` (checked by hand), so the strict
  count is 50 / 53.
- `tlc-spec-driven`: `test_docs_cli_and_python_api_mention_options` looks for the literal text
  `auto_key` in `docs/python-api.rst`. That page renders `rows_from_file()` with `autofunction`, and
  the build documented both parameters in the docstring. So the rendered docs do cover them, and
  the miss is an over-strict hidden test, not a spec gap. The suite is left as committed before
  the runs; read semantically, the score is 53 / 53.

Raw runs: `build/<tool>/hidden-tests-run.txt`, `build/<tool>/existing-suite-run.txt`, the code as
`build/<tool>/implementation.patch`, the executors' logs as `build/<tool>/assumptions.md.txt`.

## 6. Cost

Tokens are the harness's own per-message usage in each sub-agent's transcript (input + cache write +
cache read + output), summed over the contestant and the sub-agents it spawned (`runs/usage.jsonl`).

| tool              | tokens, total | output tokens | uncached input | wall time | operator turns | sub-agents spawned | spec length                    |
| ----------------- | ------------- | ------------- | -------------- | --------- | -------------- | ------------------ | ------------------------------ |
| `harnu:spec`      | **11.69 M**   | 112.7 k       | 566 k          | 25 m 44 s | 4              | 6 (sonnet)         | 2 files, 367 lines, 7064 words |
| Superpowers       | **5.04 M**    | 46.7 k        | 245 k          | 15 m 54 s | 8              | 1 (opus)           | 2 files, 812 lines, 5027 words |
| `tlc-spec-driven` | **3.13 M**    | 38.0 k        | 133 k          | 10 m 26 s | 3              | 0                  | 1 file, 353 lines, 4029 words  |

`harnu:spec`'s length includes `critics.md` (93 lines, 3054 words), the review record. For
reference, the build each spec needed: 4.94 M tokens / 8 m 56 s (`harnu:spec`), 3.79 M / 5 m 59 s
(Superpowers), 3.60 M / 7 m 00 s (`tlc-spec-driven`).

## Deviations and confounds

- **One input, one run.** D-15 chose a single feature request; no repeat runs, so there is no
  variance estimate.
- **The operator answered more than some questions asked.** When a multiple-choice question had no
  option the sheet supports, the sheet's own rule ("say none fits and give the sheet's answer")
  made the operator volunteer the opt-in design (O-1, O-2). That happened in turn 1 for both
  `harnu:spec` and `tlc-spec-driven`, and in turn 4 for Superpowers. Every exchange is in
  `runs/<tool>/operator-log.md`.
- **The orchestrator relayed.** The session that wrote the hidden truth also relayed every question
  and answer. The logs show each relay verbatim, but the risk is named here.
- **Shared context.** Every sub-agent inherited this worktree's `CLAUDE.md` (a Harnu file), the same
  for all three tools.
- **`harnu:spec` ran outside Harnu.** It had no mission, `memory_query` or `open_file`, and used the
  skill's fallbacks. `docs/specs/TEMPLATE.md` is not staged with the skill, so a copy was put in its
  tool folder. That is a portability gap of the skill. Its reviewers ran on sonnet, the
  contestants' other model (D-14).
- **Superpowers version.** The `Skill` tool loaded 7.0.0 (`claude-plugins-official`); 6.1.1 is also
  installed and was not used.
- **`tlc-spec-driven` sized itself down.** It skipped Design and Tasks by its own rules: one spec
  file with 40 checks. The skill was fetched at `8658b6658c762b9e5efd3956ed35a51c41bdf6c3`.
- **Judge order.** The seeded draw gave judges 1 and 3 the same order, so judge 3's order was
  re-drawn by hand (`judges/mapping.json`). Labels: P = `harnu:spec`, Q = Superpowers,
  R = `tlc-spec-driven`. The anonymised bundles the judges read are in `judges/bundles/`.
- **The executors had no linters.** flake8, mypy, pyright, ty and codespell were not installed and
  there was no network. black and cog ran for all three builds.
- **Timeline.** Hidden truth committed in `20bbbdd` at 15:09:11 −03:00; the first contestant started
  at 15:12:45. During the runs, `hidden/` was absent from the working tree; it was restored from git
  afterwards.
