# doc-reader A/B (agent-only): 2026-11-02

Main model `sonnet`, 3 run(s) per case per arm, gate threshold 350 lines. "without" is plugin eval's no-plugin baseline; "with" offers the Haiku doc-reader agent with no read gate (nothing enforces it). Cost is the whole run (main model and Haiku), excluding grader cost. Main-in counts every input token the main model read, cache reads included.

| case                         | score without → with | cost without → with (Δ) | main-in without → with (Δ) | haiku-in (with) | secs without → with |
| ---------------------------- | -------------------- | ----------------------- | -------------------------- | --------------- | ------------------- |
| browser-partitions           | 1.00 → 1.00          | $0.123 → $0.051 (-58%)  | 46.1k → 29.1k (-37%)       | 0.0k            | 9 → 8               |
| budget-constraints           | 1.00 → 1.00          | $0.133 → $0.036 (-73%)  | 53.9k → 37.0k (-31%)       | 0.0k            | 5 → 5               |
| cross-doc-caps               | 1.00 → 1.00          | $0.274 → $0.334 (+22%)  | 189.5k → 223.8k (+18%)     | 0.0k            | 26 → 27             |
| edit-threshold               | 1.00 → 1.00          | $0.032 → $0.037 (+16%)  | 40.2k → 50.0k (+24%)       | 0.0k            | 7 → 7               |
| list-message-errors          | 1.00 → 1.00          | $0.225 → $0.118 (-48%)  | 143.3k → 97.0k (-32%)      | 26.7k           | 17 → 29             |
| message-cap                  | 1.00 → 1.00          | $0.132 → $0.047 (-65%)  | 114.1k → 40.5k (-64%)      | 0.0k            | 9 → 8               |
| path-jail                    | 1.00 → 1.00          | $0.122 → $0.051 (-59%)  | 89.5k → 43.7k (-51%)       | 28.1k           | 9 → 8               |
| plan-overview                | 1.00 → 1.00          | $0.143 → $0.144 (+1%)   | 49.8k → 50.2k (+1%)        | 0.0k            | 15 → 15             |
| small-doc-control            | 1.00 → 1.00          | $0.026 → $0.027 (+2%)   | 23.6k → 23.9k (+1%)        | 0.0k            | 4 → 3               |
| summarize-browser-spec       | 1.00 → 1.00          | $0.218 → $0.195 (-11%)  | 140.3k → 114.0k (-19%)     | 0.0k            | 28 → 28             |
| terminal-limit               | 1.00 → 1.00          | $0.040 → $0.034 (-16%)  | 40.0k → 29.2k (-27%)       | 0.0k            | 5 → 5               |
| **all cases (sum of means)** | 1.00 → 1.00          | $1.467 → $1.073 (-27%)  | 930.2k → 738.5k (-21%)     | 54.8k           |                     |

Runs: 66. Without a trace (no per-model split): 0. Errored: 0.
