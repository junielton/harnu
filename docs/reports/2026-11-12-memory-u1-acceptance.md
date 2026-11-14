# Memory U1 acceptance (2026-11-12)

S-9 of [`docs/specs/2026-11-04-memory-u1-capture/spec.md`](../specs/2026-11-04-memory-u1-capture/spec.md) (card T640, mission `mnt-adbff17e`, campaign `cmp-021a1d43`, chapter 2): the numbers seven days after S-8 merged, against the baseline in [`2026-11-04-memory-bench-baseline.md`](2026-11-04-memory-bench-baseline.md). Benchmark spec: [`docs/specs/2026-11-04-memory-benchmark/spec.md`](../specs/2026-11-04-memory-benchmark/spec.md) (A/B form).

## Verdict

| AC    | Statement (short)                                                                   | Number                                                                                       | Verdict |
| ----- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------- |
| AC-29 | git `capture_coverage` ≥ 0.95 over the 7 days after S-8                             | **1.0** (21 of 21 sessions with ≥ 3 operator turns)                                          | met     |
| AC-30 | the audit's non-git folder's `capture_coverage` > 0, stated against 0.95            | **1.0** (2 of 2), against the ≥ 0.95 target; baseline 0 (0 of 5)                             | met     |
| AC-31 | `orphan_loss` 0 for orphans with an owning repo; no-owner orphans on their own line | **0** (0 of 11 in this repo, 0 of 5 in the one other owning repo); **no owning repo: 2**     | met     |
| AC-32 | every metric's delta, each regression named with its acceptance                     | 11 of 11 baseline metrics below; 2 regressions (M5, `index_bytes`), both accepted by D-7 (a) | met     |

No AC is unmet, so no number forced an Amendments row and the U1 spec is untouched.

Caveats a reader should not miss, detailed below: the non-git sample is two sessions; the after window is 7 UTC days, shorter than the baseline's 31; the re-run baseline reads today's memory, so it already contains digests written after 2026-11-04; the live-eval metrics were not run.

## How it was measured

- **Repo commit:** `136f9d1c84ede06b1c7cc886cffe98f669f777e4` (`origin/main`, branch `card/memory-u1-s9`). S-8 is `2b0c2ac1` (#216, merged 2026-11-05). Memory and transcripts are read from disk, not from git.
- **Script:** `scripts/memory-bench.mjs` + `scripts/memory-bench-core.mjs`, last changed at `48f06af8` (includes the S-2 image-only fix and the S-5 M7 ≥ 3-turn rule, see the Amendments rows of 2026-11-05).
- **Measured:** 2026-11-12 (UTC), on the maintainer's machine, every command under `nice -n 19`; the script limits itself to `min(8, cores / 2)` = 8 of 20 cores.
- **Non-git folder:** the folder the baseline measured (8 sessions in the baseline window, 5 counted). The baseline withholds its name; it is identified here by the same counts (8 and 5, reproduced exactly by the re-run). It is written `~/Workspace/org/…/<non-git folder>`.
- **Determinism:** the re-run baseline command run twice gave byte-identical JSON (`cmp`). The after window ends at "now", so it moves with the day; a second run with `--since 2026-11-06` (below) gives the same verdicts.

```
# re-run baseline window, fixed benchmark (same window and question set as the baseline report)
nice -n 19 npm run memory:bench -- --repo . --since 2026-10-05 --until 2026-11-05 \
  --questions tests/fixtures/memory-bench/questions.harnu.json --json
nice -n 19 npm run memory:bench -- --repo ~/Workspace/org/…/<non-git folder> \
  --since 2026-10-05 --until 2026-11-05 --json

# after S-8
nice -n 19 npm run memory:bench -- --repo . --since 2026-11-05 --json
nice -n 19 npm run memory:bench -- --repo . --since 2026-11-05 \
  --questions tests/fixtures/memory-bench/questions.harnu.json --json   # adds the snapshot recall metrics
nice -n 19 npm run memory:bench -- --repo ~/Workspace/org/…/<non-git folder> --since 2026-11-05 --json
nice -n 19 npm run memory:bench -- --repo ~/Workspace/org/…/<other owning repo> --since 2026-11-05 --json
```

The runs from `--repo .` execute in the S-9 worktree; the script resolves the main checkout through `git rev-parse --git-common-dir`, so it reads `<main>/.harnu/memory` and every worktree's transcripts. The `--questions` run differs from the plain one only in `recall_*` (0 without questions); every other metric is identical.

### Windows

| Window             | Range (`[since, until)`)                         | Sessions in window (repo) | Counted (≥ 3 operator turns) |
| ------------------ | ------------------------------------------------ | ------------------------- | ---------------------------- |
| committed baseline | 2026-10-05 → 2026-11-05, memory as of 2026-11-04 | 568                       | 77                           |
| re-run baseline    | 2026-10-05 → 2026-11-05, memory as of 2026-11-12 | 446                       | 63                           |
| after S-8          | 2026-11-05 → 2026-11-12 (run at 16:50 UTC)       | 269                       | 21                           |

The session count in the re-run baseline is lower than the committed one (446 against 568) because Claude Code keeps 30 days of transcripts: the first weeks of the baseline window have aged off disk. The two baselines are therefore not the same population, and the re-run corrects the counting rule only partly. The after window opens at the start of 2026-11-05, so it includes some hours before S-8 merged (19:24 local on 2026-11-05); `--since 2026-11-06` gives git 16 of 16 (1.0), non-git 2 of 2 (1.0), `orphan_loss` 0 over 11, the same verdicts.

## This repo (git)

### Baseline re-run next to the committed baseline

The re-run uses the benchmark as it is now (image-only lines are not turns, M7 counts orphans with ≥ 3 operator turns) over the baseline window, but it reads the memory as it is today, which already holds the digests U1 wrote after 2026-11-04 (including the catch-up sweep and the orphan digests). So the right-hand column is "what the fixed benchmark says about that window now", not a reconstruction of 2026-11-04.

| Metric                      | PRD | Committed baseline (2026-11-04)        | Re-run baseline (2026-11-12) | What moved                                                                                                                 |
| --------------------------- | --- | -------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `capture_coverage`          | M1  | 0.7013 (54 of 77)                      | 0.8254 (52 of 63)            | the denominator shrinks (image-only lines no longer count, and aged-off transcripts); later digests cover more of the rest |
| `decision_yield`            | M2  | 0.1905 (8 over 42 days)                | 0.4194 (13 over 31 days)     | fewer session-days (transcript retention), more entries on disk                                                            |
| `recall_hit_at_5`           | M3  | 0.7826                                 | 0.7826                       | none                                                                                                                       |
| `recall_hit_at_5_strict`    | M3  | 0.7826                                 | 0.7826                       | none                                                                                                                       |
| `boot_handoff_chars`        | M4  | 0                                      | 0                            | not captured                                                                                                               |
| `memory_read_default_bytes` | M5  | 239,688                                | 267,220                      | memory on disk grew                                                                                                        |
| `hot_freshness_hours`       | M6  | 0                                      | 0                            | snapshot, see the baseline's note                                                                                          |
| `index_bytes`               | —   | 140,081                                | 154,697                      | memory on disk grew                                                                                                        |
| `digest_count`              | —   | 392                                    | 402                          | context                                                                                                                    |
| `digests_per_day`           | —   | 12.6452                                | 12.9677                      | context                                                                                                                    |
| `orphan_loss`               | M7  | 0.2963 (297 transcripts, bytes 0.1475) | 0 (15 transcripts, bytes 0)  | the ≥ 3-turn rule and aged-off transcripts shrink the count from 297 to 15; all 15 have digests now                        |

### Post-S-8 scorecard

Window 2026-11-05 → 2026-11-12, kind git, memory present, 269 sessions, question set `questions.harnu.json`, boot capture no.

| Metric                      | PRD | Value   | Basis                                                                                              | Target                 |
| --------------------------- | --- | ------- | -------------------------------------------------------------------------------------------------- | ---------------------- |
| `capture_coverage`          | M1  | 1       | 21 of 21 sessions with ≥ 3 operator turns                                                          | ≥ 0.95                 |
| `decision_yield`            | M2  | 10.4286 | 73 entries over 7 session-days (agent 7.5714, human 2.8571, worker 0; 73 stamped blocks, 20 human) | ≥ 0.5                  |
| `recall_hit_at_5`           | M3  | 0.7826  | 46 questions, gold page in the top five                                                            | ≥ 0.8                  |
| `recall_hit_at_5_strict`    | M3  | 0.7826  | a returned match lies inside the gold entry or section                                             | ≥ 0.8                  |
| `boot_handoff_chars`        | M4  | 0       | not captured                                                                                       | ≤ 8,000 (2,000 tokens) |
| `memory_read_default_bytes` | M5  | 267,220 | bytes of the page-less `memory_read` payload                                                       | ≤ 16,384               |
| `hot_freshness_hours`       | M6  | 0       | median over the last 30 session ends (0 min)                                                       | ≤ 0.167                |
| `index_bytes`               | —   | 154,697 | bytes of `index.md`                                                                                | —                      |
| `digest_count`              | —   | 187     | digests in the window                                                                              | —                      |
| `digests_per_day`           | —   | 26.7143 | digests per calendar day in the window                                                             | —                      |
| `orphan_loss`               | M7  | 0       | 11 transcripts of missing folders; byte ratio 0                                                    | 0                      |

Capture by folder: `.` 10 of 10; two removed worktrees 1 of 1 and 10 of 10. Recall misses: the same ten questions as the baseline.

### Delta table

Tolerances and direction come from the benchmark spec's A/B form. Flow metrics (`capture_coverage`, `decision_yield`, `hot_freshness_hours`, `orphan_loss`) are compared with the **re-run baseline**, as the Amendments row of 2026-11-05 prescribes, with the committed baseline's delta alongside. Snapshot metrics (`memory_read_default_bytes`, `index_bytes`, recall, boot) read the memory on disk when run, so the re-run baseline equals the after value by construction (delta 0); their before is the **committed baseline**, the only one measured on the 2026-11-04 memory.

| Metric                                               | Tolerance | Before used         | After   | Δ                  | Δ vs committed | Verdict                                                                                                       |
| ---------------------------------------------------- | --------- | ------------------- | ------- | ------------------ | -------------- | ------------------------------------------------------------------------------------------------------------- |
| `capture_coverage`                                   | 0.02      | 0.8254 (re-run)     | 1       | +0.1746            | +0.2987        | improves                                                                                                      |
| `decision_yield`                                     | 0.05      | 0.4194 (re-run)     | 10.4286 | +10.0092           | +10.2381       | improves (see the note below)                                                                                 |
| `recall_hit_at_5`                                    | 0         | 0.7826 (committed)  | 0.7826  | 0                  | 0              | no change                                                                                                     |
| `recall_hit_at_5_strict`                             | 0         | 0.7826 (committed)  | 0.7826  | 0                  | 0              | no change                                                                                                     |
| `memory_read_default_bytes`                          | 2 %       | 239,688 (committed) | 267,220 | +27,532 (+11.49 %) | +27,532        | **regresses**, accepted by D-7 (a)                                                                            |
| `hot_freshness_hours`                                | 0.5 h     | 0 (re-run)          | 0       | 0                  | 0              | no change                                                                                                     |
| `index_bytes`                                        | 5 %       | 140,081 (committed) | 154,697 | +14,616 (+10.43 %) | +14,616        | **regresses**, accepted by D-7 (a)                                                                            |
| `orphan_loss`                                        | 0.02      | 0 (re-run)          | 0       | 0                  | −0.2963        | no change against the re-run; improves against the committed 0.2963                                           |
| `boot_handoff_chars`                                 | cap 8,000 | 0 (committed)       | 0       | 0                  | 0              | no change (not captured; no `--boot` run, U1 does not inject)                                                 |
| `digest_count`                                       | context   | 402 (re-run)        | 187     | n/a                | n/a            | context only, never compared                                                                                  |
| `digests_per_day`                                    | context   | 12.9677 (re-run)    | 26.7143 | n/a                | n/a            | context only, never compared                                                                                  |
| `resume_score`, `hallucination_rate`, `stale_answer` | live rule | none                | not run | n/a                | n/a            | the baseline report holds no live-eval numbers, so no delta exists; the `harnu` condition was not run for S-9 |

Notes on the table:

- **`decision_yield` is not an apples-to-apples win.** The after window is 7 session-days and holds 73 entries, 20 of them human (the baseline window had 0 human). The chapter's own decisions were probably made in these sessions, and a 7-day figure is noisier than a 31-day one. The direction is clear (every source above 0 except `worker`), the size is not a number to plan on.
- **`recall_hit_at_5` stays at 0.7826 against its ≥ 0.8 target** and the verbatim question still scores 0: U1 does not change `memory_query`, chapter 3 owns it (D-7 and PRD §3.2 put the slimming there; no U1 slice touches `memory_query`). Not an AC of S-9; reported, not accepted as met.
- **M5 is 16 times its 16,384 target** (267,220 bytes) and `index_bytes` is 154,697: unmet targets of the benchmark, owned by chapter 3.

### Regressions and what accepts them

| Metric                      | Regression                              | Accepted by                                                                                                                           |
| --------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `memory_read_default_bytes` | +27,532 bytes (+11.49 %, tolerance 2 %) | D-7, chosen (a), 2026-11-04: accept the delta and report it until chapter 3 caps it (ADR-0024 (e) exception recorded by the operator) |
| `index_bytes`               | +14,616 bytes (+10.43 %, tolerance 5 %) | D-7, chosen (a), 2026-11-04, the same decision (growth of the page-id list in `index.md` is what it names)                            |

No other metric regresses in this repo.

## A folder that is not a git repo

Kind non-git, memory present (the baseline had none), 3 sessions in the after window, 2 counted. Question set none.

| Metric                        | PRD | Committed baseline | Re-run baseline | After S-8                 | Δ vs re-run | Δ vs committed | Verdict                                                                                         |
| ----------------------------- | --- | ------------------ | --------------- | ------------------------- | ----------- | -------------- | ----------------------------------------------------------------------------------------------- |
| `capture_coverage`            | M1  | 0 (0 of 5)         | 0.2 (1 of 5)    | 1 (2 of 2)                | +0.8        | +1             | improves                                                                                        |
| `decision_yield`              | M2  | 0                  | 0               | 0 (0 entries over 2 days) | 0           | 0              | no change                                                                                       |
| `recall_hit_at_5` / `_strict` | M3  | 0                  | 0               | 0 (no question set)       | 0           | 0              | no change (not measured here)                                                                   |
| `boot_handoff_chars`          | M4  | 0                  | 0               | 0                         | 0           | 0              | no change (not captured)                                                                        |
| `memory_read_default_bytes`   | M5  | 160                | 1,187           | 1,187                     | 0           | +1,027         | **regresses** by the table (a memory now exists), accepted by D-7 (a); 7 % of the 16,384 target |
| `hot_freshness_hours`         | M6  | −1 (no `hot.md`)   | 0               | 0                         | n/a         | n/a            | n/a, the −1 sentinel is not compared                                                            |
| `index_bytes`                 | —   | 0                  | 501             | 501                       | 0           | +501           | **regresses** by the table (from none to 501 bytes), accepted by D-7 (a)                        |
| `digest_count`                | —   | 0                  | 0               | 3                         | n/a         | n/a            | context only                                                                                    |
| `digests_per_day`             | —   | 0                  | 0               | 0.375                     | n/a         | n/a            | context only                                                                                    |
| `orphan_loss`                 | M7  | 0                  | 0               | 0 (0 transcripts)         | 0           | 0              | no change                                                                                       |

The two regressions are the first memory this folder has ever had; `memory_read_default_bytes` stays at 7 % of its target, and D-7 (a) is the decision that accepts growth of these two numbers until chapter 3. The headline is the capture: 0 → 1.0, against the ≥ 0.95 target, **on a sample of two sessions**. The baseline's 0.2 re-run value (1 of 5) shows the same window now partly covered by later digests.

## Orphans (AC-31)

The benchmark's `orphan_loss` counts, in each repo it scores, the transcripts of folders that no longer exist and have ≥ 3 operator turns, and asks whether each has a digest in that repo's memory. By construction it only sees orphans under that repo's roots, so it cannot see an orphan with no owning repo. That line is counted separately here, with the benchmark's own transcript fold over every project directory in `~/.claude/projects`, applying the spec's `ownerRepoFor` rule (the longest existing repo containing the folder, else the `.claude/worktrees` parent, else the `<repo>-worktrees` sibling, else none). The "known repo list" is approximated by existing folders that hold a `.git`, because Harnu's folder list is not readable from a script; the count is machine-wide and not part of the benchmark's output.

| Orphans (gone folder, ≥ 3 operator turns, started 2026-11-05 or later) | Count | Undigested                                                                     | `orphan_loss` |
| ---------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------ | ------------- |
| owning repo: this repo                                                 | 11    | 0                                                                              | 0             |
| owning repo: one other repo under `~/Workspace/org/…`                  | 5     | 0                                                                              | 0             |
| **no owning repo** (two removed worktrees under `~/Workspace/org/…`)   | **2** | 2 (cannot be digested: D-6 (a), trashable only after "Trash without a digest") | n/a           |

`orphan_loss` is **0 for the 16 orphans that have an owning repo** (AC-31 first half). Orphans with no owning repo are **2** on their own line (second half); by D-6 (a) they stay undigested and are the ones Cleanup shows with an explicit "Trash without a digest" choice, not a loss the benchmark should score.

## Reading the numbers

Capture is where U1 landed: git 1.0 (21 of 21) against the baseline's 0.70 (0.83 re-run), non-git 1.0 (2 of 2) against 0, and every orphan with an owning repo is digested (0 of 16 lost, against the baseline's 30 % before the M7 rule). Decisions are written by humans and agents now (2.9 and 7.6 per session-day, against 0 human in the baseline), on a 7-day window. The cost is the one D-7 accepted: the page-less `memory_read` grew 11 % and `index.md` 10 %, both already far above their targets, with nothing in U1 to slim them. The two things U1 did not move, as designed, are the recall misses (0.7826, the same ten questions) and the start-of-session handoff (`boot_handoff_chars` 0): chapter 3 and U2.

## What this report did not do

- It did not run the live eval (`memory:eval`), so `resume_score`, `hallucination_rate` and `stale_answer` have no after value; the baseline has none either.
- It did not re-measure the committed baseline's own state: the memory of 2026-11-04 is gone, so the re-run is the fixed benchmark over today's memory (see above).
- The after window is 7 UTC days, not the A/B protocol's 14, as AC-29 to AC-31 define it; its flow numbers (`decision_yield` above all) are provisional in the A/B sense.
