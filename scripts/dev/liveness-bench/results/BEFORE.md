# AC-30 BEFORE baseline — `feat/sidebar-liveness` @ `a45b8030`

Taken 2026-10-02 with this harness (the pattern-located logpoints and `getAppMetrics()`
labels) on the synthetic fixture, an isolated instance (own `userData`, fake `HOME`,
ports 9447/9448). The `feat/sidebar-liveness` head carries no source change over the
spec's `e06b84a7` baseline (docs only), so these numbers are directly comparable with
spec §1.2 — and they reproduce it. The AFTER run uses the same steps (README, "AC-30
checklist") on the finished integration branch, on the same machine.

Dev-mode (`--remote-debugging-port`) runs are GPU-off; the GPU-on row is a separate launch
without it. Animations were **on** in every run below (the spec's 38.8% / 6.3% row was
animations off), so the Tab (renderer) column is higher than the spec's.

## Liveness — time to row (`ttr.mjs`, 20 s timeout)

| Scenario                                 | Trials | Row in store within 20 s | p50 / p95 | Raw                             |
| ---------------------------------------- | ------ | ------------------------ | --------- | ------------------------------- |
| `existing-slug` (new session, known dir) | 10     | **0 / 10**               | n/a       | `before-ttr.jsonl` (rows 1–10)  |
| `new-slug` (new dir + first JSONL)       | 10     | **0 / 10**               | n/a       | `before-ttr.jsonl` (rows 11–20) |
| `worktree` (`git worktree add`)          | 5      | **0 / 5**                | n/a       | `before-ttr.jsonl` (rows 21–25) |

Spec baseline: 0/3, 0/3, 0/1. Each trial appended to its JSONL every 2 s (9 appends).

## CPU (`measure.mjs`, `gpu.mjs`) — % of one core, per `getAppMetrics()` type

| Run                                             | Browser (main) | Tab (renderer) | GPU | Raw                 |
| ----------------------------------------------- | -------------- | -------------- | --- | ------------------- |
| Idle, no load, 20 s, GPU off                    | 1.6            | 2.4            | 0.0 | `before-idle.json`  |
| 8 appends/s, 60 s, GPU off (dev)                | **38.8**       | 33.0           | 6.9 | `before-instr.json` |
| 8 appends/s, GPU on, animations on (30 s)       | 30.5           | 26.1           | 7.6 | `before-gpu.txt`    |
| 8 appends/s, GPU on, animations off (30 s)      | 31.1           | 9.5            | 1.2 | `before-gpu.txt`    |
| 8 appends/s, GPU on, animations on again (30 s) | 29.6           | 24.9           | 7.7 | `before-gpu.txt`    |

The GPU process is now labelled `GPU` (the baseline files label it `zygote`, spec §1.1).

## Main-process counters under load (`measure.mjs instr 60`)

| Measure                        | Value                                     |
| ------------------------------ | ----------------------------------------- |
| Slug passes                    | 120 in 60 s = 2.0 /s                      |
| Pass duration                  | p50 81.7 ms · p90 119.8 ms · max 148.8 ms |
| Pass time total                | 10.1 s per 60 s                           |
| `notifySlug` calls             | 480                                       |
| Subagent header reads          | **48,000** (400 per pass)                 |
| JSONL header cache misses      | 240                                       |
| `git rev-parse` spawns         | 1                                         |
| `session:updated` events       | 242 in 60 s = 4.03 /s, 1,648 B/event      |
| `subagent:updated` events      | 242 in 60 s = 4.03 /s, 1,374 B/event      |
| `newLines` bytes in main sends | 328,502 (238 sends)                       |

## Rescan (`rescan.mjs`, under load)

`rescan()` resolved in 282 ms; two concurrent full scans were started (two `{}` calls to
`scanFoldersUncached`), the counted full-scan region took 66 ms. The synthetic fixture is
far smaller than the real dataset behind spec §1.2's 2,762 ms. The raw run logged full
slug names, so `before-rescan.json` keeps only the counts.
