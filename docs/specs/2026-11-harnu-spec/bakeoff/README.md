# Bake-off bundle (S-10, AC-40, AC-41)

The bake-off of `harnu:spec` against Superpowers `brainstorming` → `writing-plans` and
`tlc-spec-driven`, by the rubric of S-10 in `../spec.md`. Start with `report.md`.

| path                                     | what                                                                            | written          |
| ---------------------------------------- | ------------------------------------------------------------------------------- | ---------------- |
| `input/feature-request.md`               | the pinned input: repo, commit, why it was chosen, the request text             | before the runs  |
| `input/answer-sheet.md`                  | the simulated operator's answers                                                | before the runs  |
| `protocol.md`                            | how each rubric step was run, and the hidden suite's validation                 | before the runs  |
| `judges/score-sheet.md`                  | the judges' fixed sheet                                                         | before the runs  |
| `hidden/atoms.md`                        | the request and operator atoms                                                  | before the runs  |
| `hidden/test_hidden_bakeoff.py`          | the hidden acceptance tests (53)                                                | before the runs  |
| `hidden/reference.patch`                 | the orchestrator's own build, proving the suite passable                        | before the runs  |
| `runs/<tool>/artifact/`                  | each tool's artifact, byte-for-byte (`.txt` so the formatter leaves it raw)     | by the runs      |
| `runs/<tool>/operator-log.md`            | every operator exchange, with the answer-sheet entries used                     | by the runs      |
| `runs/usage.jsonl`                       | per-sub-agent token usage and timestamps, from the transcripts                  | after the runs   |
| `judges/raw/judge-<n>-spec-<label>.json` | the judges' raw outputs, one per spec                                           | by the judges    |
| `judges/bundles/`, `judges/mapping.json` | what the judges read (anonymised), the label → tool map and the per-judge order | by the judges    |
| `build/<tool>/assumptions.md.txt`        | each executor's assumption log                                                  | by the builds    |
| `build/<tool>/implementation.patch`      | each build's code, against the pinned commit plus the spec bundle               | by the builds    |
| `build/<tool>/*-run.txt`                 | the hidden suite and the pinned existing suite, run on each build               | after the builds |
| `report.md`                              | one table per measure and the verdict                                           | last             |

The hidden truth, the answer sheet and the protocol were committed in `20bbbdd`
(2026-11-07 15:09:11 −03:00), before the first contestant started (15:12:45).
