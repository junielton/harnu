# doc-reader A/B (gate): 2026-11-04

Main model `sonnet`, 3 run(s) per case per arm, gate threshold 350 lines. "without" is plugin eval's no-plugin baseline; "with" loads the read gate and the Haiku doc-reader. Cost is the whole run (main model and Haiku), excluding grader cost. Main-in counts every input token the main model read, cache reads included.

| case                         | score without → with | cost without → with (Δ) | main-in without → with (Δ) | haiku-in (with) | gate blocks / agent calls (with, all runs) | secs without → with |
| ---------------------------- | -------------------- | ----------------------- | -------------------------- | --------------- | ------------------------------------------ | ------------------- |
| edit-threshold               | 1.00 → 1.00          | $0.034 → $0.037 (+11%)  | 44.7k → 50.3k (+12%)       | 0.0k            | 0 / 0                                      | 7 → 7               |
| **all cases (sum of means)** | 1.00 → 1.00          | $0.034 → $0.037 (+11%)  | 44.7k → 50.3k (+12%)       | 0.0k            | 0 / 0                                      |                     |

Score counts only the answer graders. A `tool_used` grader marked `arm: with-only` is reported in eval.json with `scored: false` and never lowers the score; routing shows in the gate blocks / agent calls column.

Runs: 6. Without a trace (no per-model split): 0. Errored: 0.
