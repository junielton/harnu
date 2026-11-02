# doc-reader A/B: 2026-11-02

Main model `sonnet`, 3 run(s) per case per arm, gate threshold 350 lines. "without" is plugin eval's no-plugin baseline; "with" loads the read gate and the Haiku doc-reader. Cost is the whole run (main model and Haiku), excluding grader cost. Main-in counts every input token the main model read, cache reads included.

| case                         | score without → with | cost without → with (Δ) | main-in without → with (Δ) | haiku-in (with) | secs without → with |
| ---------------------------- | -------------------- | ----------------------- | -------------------------- | --------------- | ------------------- |
| browser-partitions           | 1.00 → 1.00          | $0.121 → $0.052 (-57%)  | 56.6k → 29.1k (-49%)       | 0.0k            | 10 → 8              |
| budget-constraints           | 1.00 → 1.00          | $0.132 → $0.037 (-72%)  | 49.9k → 37.0k (-26%)       | 11.5k           | 4 → 7               |
| cross-doc-caps               | 1.00 → 1.00          | $0.378 → $0.107 (-72%)  | 201.8k → 72.4k (-64%)      | 186.6k          | 25 → 58             |
| edit-threshold               | 1.00 → 1.00          | $0.034 → $0.038 (+10%)  | 44.7k → 50.6k (+13%)       | 0.0k            | 7 → 7               |
| list-message-errors          | 1.00 → 1.00          | $0.234 → $0.066 (-72%)  | 161.6k → 51.2k (-68%)      | 132.2k          | 19 → 43             |
| message-cap                  | 1.00 → 1.00          | $0.102 → $0.046 (-54%)  | 88.3k → 39.9k (-55%)       | 0.0k            | 10 → 8              |
| path-jail                    | 1.00 → 1.00          | $0.119 → $0.047 (-61%)  | 78.0k → 38.5k (-51%)       | 0.0k            | 8 → 6               |
| plan-overview                | 1.00 → 1.00          | $0.145 → $0.046 (-68%)  | 49.9k → 41.2k (-17%)       | 34.8k           | 15 → 18             |
| small-doc-control            | 1.00 → 1.00          | $0.027 → $0.028 (+3%)   | 23.6k → 23.9k (+1%)        | 0.0k            | 4 → 4               |
| summarize-browser-spec       | 1.00 → 1.00          | $0.229 → $0.078 (-66%)  | 171.4k → 48.6k (-72%)      | 80.2k           | 29 → 49             |
| terminal-limit               | 1.00 → 1.00          | $0.039 → $0.036 (-8%)   | 40.1k → 30.5k (-24%)       | 0.0k            | 7 → 5               |
| **all cases (sum of means)** | 1.00 → 1.00          | $1.559 → $0.580 (-63%)  | 966.0k → 462.9k (-52%)     | 445.4k          |                     |

Runs: 66. Without a trace (no per-model split): 0. Errored: 0.
