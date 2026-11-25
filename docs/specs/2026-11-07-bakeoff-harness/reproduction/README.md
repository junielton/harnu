# Reproduction of S-10 (AC-30)

**Result: reproduced.** On the S-10 input, every tool's mean hidden-test passes is within AC-30's
band of S-10's count. Superpowers sits exactly on the band's edge.

- Round `20261113-164650`, run on 2026-11-13 with
  `npm run eval:bakeoff -- run --problems sqlite-utils-json-key --with-tlc --skill-ref 6bab507f`,
  every other flag at its default: 2 repeats, 3 judges, contestants and builders on
  `claude-opus-5-5`, the operator and the judges on `claude-sonnet-5-5`, cap 400M, `--jobs` 10
  on a 20-core machine. It ran once, with no resume, and ended `done` (exit 0). Every run was
  `done`, with no judge left `not-run` and no flaky hidden test.
- [`report.md`](report.md) and [`report.json`](report.json) are the harness's output for that
  round, copied from `.harnu/eval/bakeoff/20261113-164650/`. The commit hook ran prettier on both,
  which changed the layout only: table padding in the `.md`, line breaks in the `.json`. No value
  changed.
- [`confounds.md`](confounds.md) names how this run differs from S-10.

## The band

AC-30 compares S-10's count with this round's per tool. Passes are `hiddenPassRate` × 53 / 100,
and the spread in tests is the `hiddenPassRate` spread across the two runs × 53 / 100, both read
from `report.json`'s `measures.hiddenPassRate.summary`. A tool reproduces when
|mean passes − S-10 passes| ≤ max(spread in tests, 2).

| tool              | r1  | r2  | mean passes | S-10 | difference | spread in tests | band | result               |
| ----------------- | --- | --- | ----------- | ---- | ---------- | --------------- | ---- | -------------------- |
| `harnu-spec`      | 53  | 51  | 52.00       | 51   | 1.00       | 2.00            | 2.00 | within               |
| `superpowers`     | 52  | 50  | 51.00       | 53   | 2.00       | 2.00            | 2.00 | within (on the edge) |
| `tlc-spec-driven` | 53  | 47  | 50.00       | 52   | 2.00       | 6.00            | 6.00 | within               |

The r1 and r2 columns are the passing hidden tests of each run's build (`build.json`'s
`hidden.passed`, out of 53). The band was fixed before the run and has not been changed since.

## Reported, not gated

The tool order on hidden tests flipped. S-10 had Superpowers (53) first, then `tlc-spec-driven`
(52), then `harnu:spec` (51). This round's means put `harnu-spec` (52) first, then Superpowers
(51), then `tlc-spec-driven` (50). Every gap is inside the spread, so neither order says which tool
is better. This proof checks only that the harness reproduces the prior measurement.

The judges' coverage means, in atoms of 24 (the `coverage` summary × 24 / 100):

| tool              | this round | spread (atoms) | S-10 |
| ----------------- | ---------- | -------------- | ---- |
| `harnu-spec`      | 22.58      | 1.83           | 21.8 |
| `superpowers`     | 22.50      | 1.33           | 23.7 |
| `tlc-spec-driven` | 20.25      | 3.83           | 22.8 |

Tokens per run, spec plus build (`tokensTotal`, mean of the two runs), against S-10's
`report.md` §6:

| tool              | this round | S-10   |
| ----------------- | ---------- | ------ |
| `harnu-spec`      | 4.56 M     | 16.6 M |
| `superpowers`     | 1.87 M     | 8.8 M  |
| `tlc-spec-driven` | 2.67 M     | 6.7 M  |

`harnu-spec` costs the most in both rounds. Superpowers and `tlc-spec-driven` swap places. Every
tool costs 2.5–4.7× less than in S-10. A likely cause, not measured, is S-10's design: its
contestants ran as sub-agents of one long orchestrator session, while here each contestant is a
fresh `claude -p` session.

The whole round spent **18.6M tokens** against the ~65M AC-30 estimated: 10.7M contestant, 0.18M
operator, 0.38M judge, 7.3M build, 0.03M discarded (the two model probes, and one judge attempt on `tlc-spec-driven` r1, `judge-2`,
that was retried and then gave a valid reply).
