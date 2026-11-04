# Memory benchmark baseline (2026-11-04)

The "before" every chapter of the project memory campaign (`cmp-021a1d43`) is measured against. Spec: [`docs/specs/2026-11-04-memory-benchmark/spec.md`](../specs/2026-11-04-memory-benchmark/spec.md). PRD: [`docs/prds/T618-project-memory-upgrade.md`](../prds/T618-project-memory-upgrade.md) §4.

- **Repo commit:** `3a4d73a173e7ae8479453adb4b1e5afea9023ef9` (chapter 1 base, before any memory change). The memory and transcripts are read from disk; they are not in git.
- **Script commit:** `f6efc3f0b215e5adbb08aa33b7f2a61f80c98c6f` (`scripts/memory-bench.mjs`).
- **Measured:** 2026-11-04, on the maintainer's machine.
- **Window:** 2026-10-05 to 2026-11-04 inclusive. The oldest transcript still on disk starts on 2026-10-04 (Claude Code keeps 30 days by default), so the window starts at the first full day for which both transcripts and memory exist. An all-time window would compare decision entries from July against sessions from October.
- **Determinism:** the same JSON run twice was byte-identical (`cmp`).

## This repo (git)

```
npm run memory:bench -- --repo . --since 2026-10-05 --until 2026-11-05 \
  --questions tests/fixtures/memory-bench/questions.harnu.json
```

### Output

- Kind: git · memory: present · sessions in window: 568
- Window: 2026-10-05 → 2026-11-05
- Question set: questions.harnu.json · boot capture: no

| Metric                      | PRD | Value   | Basis                                                                                         | Target                 |
| --------------------------- | --- | ------- | --------------------------------------------------------------------------------------------- | ---------------------- |
| `capture_coverage`          | M1  | 0.7013  | 54 of 77 sessions with ≥ 3 operator turns                                                     | ≥ 0.95                 |
| `decision_yield`            | M2  | 0.1905  | 8 entries over 42 session-days (agent 0.1905, human 0, worker 0; 119 stamped blocks, 0 human) | ≥ 0.5                  |
| `recall_hit_at_5`           | M3  | 0.7826  | 46 questions, gold page in the top five                                                       | ≥ 0.8                  |
| `recall_hit_at_5_strict`    | M3  | 0.7826  | a returned match lies inside the gold entry or section; the verbatim question text scores 0   | ≥ 0.8                  |
| `boot_handoff_chars`        | M4  | 0       | not captured: nothing injects memory at start today                                           | ≤ 8,000 (2,000 tokens) |
| `memory_read_default_bytes` | M5  | 239688  | bytes of the page-less memory_read payload                                                    | ≤ 16,384               |
| `hot_freshness_hours`       | M6  | 0       | median over the last 30 session ends (0 min)                                                  | ≤ 0.167                |
| `index_bytes`               | —   | 140081  | bytes of index.md                                                                             | —                      |
| `digest_count`              | —   | 392     | digests in the window                                                                         | —                      |
| `digests_per_day`           | —   | 12.6452 | digests per calendar day in the window                                                        | —                      |
| `orphan_loss`               | M7  | 0.2963  | 297 transcripts of missing folders; byte ratio 0.1475                                         | 0                      |

Capture series: git 0.7013, non-git 0 (this folder is git).

### Capture by folder

| Folder                                                                                                 | Sessions | Captured |
| ------------------------------------------------------------------------------------------------------ | -------- | -------- |
| `.`                                                                                                    | 62       | 41       |
| `.claude/worktrees/card-BUG-197-wip-ceiling-counts-dead-in-progress-cards-stale-cards-silently (gone)` | 1        | 1        |
| `.claude/worktrees/card-BUG-235-campaign-ch-1-follow-ups-ledger-event-time-verifier-gate-on (gone)`    | 1        | 0        |
| `.claude/worktrees/card-T483-scheduler-pin-workers-pinned-group-on-top-collapsible-off-group (gone)`   | 1        | 1        |
| `.claude/worktrees/card-T537-t536-u1-canvas-tool-modes-toolbar-select-default-hand-rectangle (gone)`   | 4        | 4        |
| `.claude/worktrees/card-T540-t536-u4-canvas-layers-bring-to-front-send-to-back-saved-and (gone)`       | 3        | 3        |
| `.claude/worktrees/card-T565-t564-docs-spec-prd-and-adrs-for-the-browser-pane-no-code (gone)`          | 1        | 1        |
| `.claude/worktrees/card-T580-topbar-use-lucide-s-github-icon-on-the-pull-requests-on-github (gone)`    | 1        | 0        |
| `.claude/worktrees/docs-t447-harnu-sdk-noun-spec (gone)`                                               | 3        | 3        |

### Recall misses (strict)

- What is the public product name and what did it replace?
- Why are orphan Docker volumes never removed automatically?
- Which kind does the Workspace GC opinion run as?
- How were the canvas test flakes fixed?
- In which language must a mockup promoted into the repo be authored?
- Are mission gates derived from facts or reported by agents?
- Which icon does the Topbar pull requests button use?
- What must a quitting Harnu instance restore?
- How was the vitest suite split up in CI?
- Where did the last session leave off?

## A folder that is not a git repo

The non-git folder the audit cites (8 sessions; its name is withheld, the output's name line is replaced).

```
npm run memory:bench -- --repo <non-git folder> --since 2026-10-05 --until 2026-11-05
```

- Kind: non-git · memory: absent · sessions in window: 8
- Window: 2026-10-05 → 2026-11-05
- Question set: none · boot capture: no

| Metric                      | PRD | Value | Basis                                                                                       | Target                 |
| --------------------------- | --- | ----- | ------------------------------------------------------------------------------------------- | ---------------------- |
| `capture_coverage`          | M1  | 0     | 0 of 5 sessions with ≥ 3 operator turns                                                     | ≥ 0.95                 |
| `decision_yield`            | M2  | 0     | 0 entries over 5 session-days (agent 0, human 0, worker 0; 0 stamped blocks, 0 human)       | ≥ 0.5                  |
| `recall_hit_at_5`           | M3  | 0     | 0 questions, gold page in the top five                                                      | ≥ 0.8                  |
| `recall_hit_at_5_strict`    | M3  | 0     | a returned match lies inside the gold entry or section; the verbatim question text scores 0 | ≥ 0.8                  |
| `boot_handoff_chars`        | M4  | 0     | not captured: nothing injects memory at start today                                         | ≤ 8,000 (2,000 tokens) |
| `memory_read_default_bytes` | M5  | 160   | bytes of the page-less memory_read payload                                                  | ≤ 16,384               |
| `hot_freshness_hours`       | M6  | -1    | no hot.md                                                                                   | ≤ 0.167                |
| `index_bytes`               | —   | 0     | bytes of index.md                                                                           | —                      |
| `digest_count`              | —   | 0     | digests in the window                                                                       | —                      |
| `digests_per_day`           | —   | 0     | digests per calendar day in the window                                                      | —                      |
| `orphan_loss`               | M7  | 0     | 0 transcripts of missing folders; byte ratio 0                                              | 0                      |

Capture series: git 0, non-git 0 (this folder is non-git).

## Reading the numbers

Capture is better than the audit suggested and still well short of the target: 70 % of the sessions with three or more operator turns have a digest, and 0 % in the non-git folder. The denominator is small (77 of 568 sessions) because most sessions here are dispatched executors that receive one prompt and never another, which the PRD's three-turn rule excludes. Decision yield is 0.19 per session-day, and every one of the 8 addressable entries was written by an agent: humans and workers write none. Recall looks close to its target (0.78 against 0.8) only because `decisions.md` is one page that comes first in grep order. The strict score equals the page score here because the ten misses are complete misses, not near misses: the search word an agent would type ("product name", "orphan Docker volumes", "last session") is not the word the memory used. Asked verbatim, every question scores 0, because `memory_query` is one substring. The page-less `memory_read` returns 239,688 bytes, nearly 15 times the 16 KB target, and 140 KB of that is `index.md`. Nothing about memory reaches a session at start (`boot_handoff_chars` 0). Hot freshness reads 0 hours because `hot.md` is rewritten by the newest digest; as defined, M6 is a snapshot, and it is the metric chapter 3 should sharpen first. 30 % of the 297 transcripts whose folder is gone have no digest (15 % of their bytes); the PRD expected 1.0 because nothing digests an orphan, but many of those worktrees committed and were digested before they were removed.
