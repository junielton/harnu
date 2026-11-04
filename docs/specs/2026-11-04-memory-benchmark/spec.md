---
status: draft
tier: large
---

# Memory efficiency benchmark

Campaign `cmp-021a1d43` (project memory upgrade), chapter 1, mission `mnt-090374cf` step `stp-2`, card T620. Parent PRD: `docs/prds/T618-project-memory-upgrade.md` (§4 Metrics). Architecture: `docs/adr/0024-project-memory-architecture.md` (decision (e): every chapter moves at least one metric and regresses none). Evidence: `docs/studies/2026-11-04-memory-audit.md` §2.

## Problem

The PRD names seven metrics (M1 to M7) and says every later chapter is accepted by moving them, but nothing measures them. The audit's numbers (1,299 digests, a 235 KB `memory_read`, 7 addressable decision entries, 0 bytes of memory for a non-git folder) were taken by hand once. Without an instrument, "the memory got better" is a vibe, a chapter can regress capture while improving recall and nobody sees it, and the baseline the ADR asks for does not exist.

Two things have to be measured, and they need different instruments:

- **What the memory holds and costs**, which is a pure function of files on disk (`.harnu/memory/` and `~/.claude/projects/`). This can be deterministic and cheap, and run on every chapter.
- **Whether a new session actually knows what earlier sessions learned**, which only a real session can show, with a real model, through the real transports (the `SessionStart` hook bridge, the `memory_read` and `memory_query` verbs). This costs model calls and is noisy, so it runs before and after each chapter, not on every commit.

Request atoms:

- R-1 The operator asked for "a way to test the efficiency" of the project memory.
- R-2 Every later chapter is accepted by moving these numbers; a baseline must exist before any chapter changes the memory (PRD §4, ADR-0024 (e)).
- R-3 A static scorecard computes the PRD §4 metrics from `.harnu/memory/` and `~/.claude/projects/`: deterministic, read-only, JSON and markdown output, with `--repo`, `--home`, `--since` and `--json`.
- R-4 A live resume-eval protocol is specified now and built as the first unit of chapter 2: planted facts, fresh sessions asked a question set, answers scored, a regression threshold.
- R-5 An A/B protocol says how each chapter reports before and after, with a committed report under `docs/reports/`.
- R-6 The benchmark never writes into project memory and never takes more than half the machine's CPUs.

## Goals

- G-1 One command, `npm run memory:bench -- --repo <path>`, prints the scorecard for a repo or a plain folder, as markdown or JSON, in seconds, the same way on any machine.
- G-2 A committed baseline report for this repo at the chapter 1 base commit, so chapter 2 has a "before".
- G-3 A live eval that chapter 2 can build without guessing: fixture layout, question format, scoring rubric, how a trial runs, what counts as a regression.
- G-4 One A/B report format every chapter uses, so "moved one metric, regressed none" is a table, not an argument.

**Non-goals:** changing anything under `src/` (the scorecard reads; S-2 adds one file write described in its slice); tuning the PRD targets beyond confirming or revising them against the baseline (table in S-1); embeddings or any model in the static scorecard; measuring other CLIs (Codex, Copilot).

**Anti-goals:** a scorecard whose numbers change between two runs on the same files; a metric that silently differs from the verb it mirrors (a `memory_read` byte count that is not what a session receives); a benchmark that writes into `.harnu/memory/` or trashes a transcript; a live eval graded by a model's opinion instead of string checks; a question set tuned to the current grep so recall looks good.

## Slices

### S-1 · Static scorecard and baseline (this unit, chapter 1)

- depends-on: —
- substrate: worktree
- files-may-touch: `docs/specs/2026-11-04-memory-benchmark/`, `scripts/memory-bench.mjs`, `scripts/memory-bench-core.mjs`, `tests/memory-bench-core.test.ts`, `tests/fixtures/memory-bench/`, `docs/reports/2026-11-04-memory-bench-baseline.md`, `package.json` (one script line), `CHANGELOG.md`, `docs/user/project-memory.md`
- produces: memory-bench-scorecard
- consumes: —
- acs: AC-1, AC-2, AC-3, AC-4, AC-5, AC-6, AC-7, AC-8

`scripts/memory-bench-core.mjs` holds pure functions (no I/O): transcript folding, digest name parsing, decision entry parsing, the `memory_read` and `memory_query` mirrors, every metric, the markdown renderer. `scripts/memory-bench.mjs` is the shell: arguments, file reads, `git` read-only probes, output, exit code. Same pure-core and thin-shell split as `scripts/ci/*-core.mjs`.

#### Command line

```
npm run memory:bench -- [--repo <path>] [--home <dir>] [--memory <dir>] [--kind git|non-git]
                        [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--questions <file>]
                        [--boot <dir>] [--path-map <from>=<to>]... [--json]
```

| Flag          | Default                                         | Meaning                                                                                                                                                                                                                         |
| ------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--repo`      | the current directory                           | The folder to score. A git checkout or worktree is resolved to its repo's main checkout; a plain folder is scored as itself.                                                                                                    |
| `--home`      | `$CLAUDE_CONFIG_DIR`, else `~/.claude`          | The Claude config dir that holds `projects/<slug>/*.jsonl`. Tests point it at `tests/fixtures/memory-bench/home`.                                                                                                               |
| `--memory`    | `<main checkout>/.harnu/memory`                 | The memory dir to read. Needed for central-mode memory (T89) and for fixtures, because `.harnu/` is gitignored.                                                                                                                 |
| `--kind`      | `git` when `<repo>/.git` exists, else `non-git` | Which capture series the folder belongs to. Fixtures set it because a committed fixture cannot hold a `.git`.                                                                                                                   |
| `--since`     | none                                            | Window start, inclusive, at 00:00 UTC.                                                                                                                                                                                          |
| `--until`     | none                                            | Window end, exclusive, at 00:00 UTC.                                                                                                                                                                                            |
| `--questions` | none                                            | A question set (format below). Without it the recall metrics are 0 with `recall_questions: 0`.                                                                                                                                  |
| `--boot`      | none                                            | A directory holding what a new session received about memory at start, captured at the hook bridge: `startup.txt`, `resume.txt`, `compact.txt` (any subset). Without it the boot metrics are 0 with `boot_handoff_measured: 0`. |
| `--path-map`  | none                                            | Rewrite a transcript `cwd` prefix before scoping and existence checks (`/fixture=<dir>`). Repeatable. For transcripts recorded under another path and for fixtures.                                                             |
| `--json`      | off                                             | Print JSON instead of markdown.                                                                                                                                                                                                 |

Exit codes: `0` scored (including a folder with no memory and no sessions), `2` bad arguments (message on stderr), `1` an unexpected error.

#### Terms

- **Scope roots.** For `--kind git`: the main checkout (`dirname(git rev-parse --path-format=absolute --git-common-dir)`) plus every path `git worktree list --porcelain` prints. For `non-git`: the folder itself. Git is only ever run read-only, and only when `<repo>/.git` exists, so a folder nested in another repo is never mistaken for it.
- **Session.** A top-level transcript `<home>/projects/<slug>/<session-id>.jsonl` (subagent transcripts in sub-directories are not sessions) whose folder, after `--path-map`, is a scope root or lies under one. Its folder is the first `cwd` field in the file. Its start and end are the first and last `timestamp` fields. Slugs are only a pre-filter: a slug equal to the scope root's slug or starting with it plus `-` is opened; the `cwd` decides.
- **Operator turn.** A line with `type: "user"` that is not `isSidechain`, not `isMeta`, not `isCompactSummary`, holds no `tool_result` block, and whose text, after removing the wrappers Claude Code injects (`<system-reminder>`, `<command-message>`, `<command-args>`, `<local-command-stdout>`, `<local-command-caveat>`, `<task-notification>`, `<cross-session-message>`), is non-empty or names a slash command (`<command-name>`). A line starting `[Request interrupted` is not a turn.
- **Counted session.** A session with three or more operator turns.
- **Window.** A session is in the window when its start is; a digest when its file-name date is; a decision entry when its `valid_from` (else its provenance `at`) is. No `--since`/`--until` means everything.
- **Session-day.** A distinct pair (session folder, UTC date of start) among counted sessions in the window.
- **Digest.** A file `sessions/<YYYY-MM-DD>-<id>.md` in the memory dir. A session is **captured** when some digest's `<id>` equals the first 8 characters of its session id, case-insensitively, whatever the digest's date.
- **Orphan.** A session whose folder does not exist on disk.

All ratios are rounded to 4 decimals and hours to 3. A ratio whose denominator is 0 is reported as `0`, and its denominator is always reported next to it, so 0-of-0 is never read as a failure. No output carries an absolute path, the clock or the host name, which is what makes two runs byte-identical.

#### Metrics

Names are the contract; chapter specs cite them.

| Name                              | PRD | Formula                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------- | --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capture_coverage`                | M1  | captured counted sessions ÷ counted sessions, in the window. Also `capture_coverage_git` and `capture_coverage_nongit` (the series this folder is not in is 0), `capture_sessions`, `captured_sessions`, and per-folder rows in `detail.capture_by_folder`.                                                                                                                                     |
| `decision_yield`                  | M2  | addressable decision entries (a `> entry:` line in `decisions.md`, PRD §4) in the window ÷ `session_days`. Split `decision_yield_agent`, `decision_yield_human`, `decision_yield_worker` by the `author=` of the entry's provenance stamp. Also `decision_entries`, `session_days`, and, as context only, `decision_blocks` / `decision_blocks_human` (provenance-stamped blocks of any shape). |
| `recall_hit_at_5`                 | M3  | `(1 ÷ Q) × Σ 1[gold(q) ∩ top5(q) ≠ ∅]` over the `--questions` set, searching each question's `query`. Also `recall_hit_at_5_verbatim` (the whole `question` text as the search string) and `recall_questions` (Q).                                                                                                                                                                              |
| `boot_handoff_chars`              | M4  | the largest character count (code points) among the `--boot` files. Also `boot_handoff_tokens` = ⌈chars ÷ 4⌉ and `boot_handoff_measured` (1 when `--boot` was given). Per-source counts in `detail.boot`.                                                                                                                                                                                       |
| `memory_read_default_bytes`       | M5  | UTF-8 byte length of the text `memory_read({ folder })` with no `page` returns: `JSON.stringify({ ok: true, memory: { hot, index, pages } })`, or the "no project memory yet" payload when the memory dir is empty or absent.                                                                                                                                                                   |
| `hot_freshness_hours`             | M6  | take the last 30 sessions in the window by end time; for each, lag = max(0, session end − `hot.md` modification time); report the median in hours. Also `hot_freshness_minutes`. 0 with no sessions; −1 when there are sessions but no `hot.md`.                                                                                                                                                |
| `index_bytes`                     | —   | byte size of `index.md`, 0 when absent.                                                                                                                                                                                                                                                                                                                                                         |
| `digest_count`, `digests_per_day` | —   | digests in the window; ÷ the inclusive day count from (`--since`, else the first digest date) to (`--until` − 1 day, else the last digest date).                                                                                                                                                                                                                                                |
| `orphan_loss`                     | M7  | orphans with no digest ÷ orphans, in the window. Also `orphan_loss_bytes` (the same ratio in transcript bytes) and `orphan_transcripts`.                                                                                                                                                                                                                                                        |

The JSON also carries `sessions_total` (sessions in the window, any turn count).

**The two mirrors.** `memory_read_default_bytes` and `recall_hit_at_5` re-implement, in the core, what `memoryReadHandler` + `readMemoryOverview` (`src/main/mcp/tool-handlers.ts`, `src/main/mcp/memory-store.ts`) and `queryMemory` + `grepMemory` (`src/main/mcp/memory-core.ts`) do today: the page list is root pages, then `roadmap/`, `sessions/`, `archive/`, `learning/`, each sorted; the matcher is a case-insensitive substring over every line of every page in that order, capped at 50 matches. `top5(q)` is the first five distinct page ids in match order. A gold id that is a page id hits when that page is in `top5`; a gold id that is a decision entry id (`e-` + 8 hex) hits when one of the returned matches on a `top5` page lies inside that entry's lines (the block from the line after the previous `> provenance:` stamp, chrome skipped, to the entry's own stamp, the same rule as `parseEntries` in `src/main/mcp/memory-entries.ts`). A parity test runs the real `readMemoryOverview` and `queryMemory` on the fixture memory and asserts the mirrors agree byte for byte and page for page. **A chapter that changes either verb updates the mirror in the same PR**, and the parity test fails until it does.

**Question set format** (`tests/fixtures/memory-bench/questions.harnu.json`, frozen): a JSON array of `{ "question": string, "query": string, "expect": string[] }`. `question` is how a person would ask; `query` is the search string an agent would pass to `memory_query`; `expect` holds page ids (`decisions`, `hot`, `roadmap/<stem>`, `sessions/<stem>`) or decision entry ids (`e-1a2b3c4d`). A question set is never edited after its first committed report; a new version is a new file, and the report names the file it used.

#### Output

`--json` prints:

```
{
  "schema": 1,
  "repo":   { "name": "<basename>", "kind": "git" | "non-git", "memory": "present" | "absent" },
  "window": { "since": "YYYY-MM-DD" | null, "until": "YYYY-MM-DD" | null },
  "inputs": { "questions": "<basename>" | null, "boot": true | false },
  "metrics": { "<name>": <number>, ... },            // every name above, all finite numbers
  "detail":  { "capture_by_folder": [{ "folder": "<path relative to its scope root>", "sessions": n, "captured": n }],
               "recall_misses": ["<question>", ...], "boot": { "startup": n, "resume": n, "compact": n } }
}
```

Without `--json` it prints the same data as a markdown report: a header (repo name, kind, window, inputs), one table row per metric (name, PRD id, value, basis such as "3 of 5 sessions", target), then the details. Keys and rows are in a fixed order.

#### Determinism and safety

- Read-only: the shell opens files for reading, runs only `git rev-parse` and `git worktree list`, and never creates, renames or deletes anything. A test runs it on a memory dir whose files and folders are read-only and checks that nothing changed.
- At most `min(8, max(1, ⌊cpus ÷ 2⌋))` transcripts are read at once (CLAUDE.md CPU budget). Lines are streamed, never loaded whole.
- Same inputs, same bytes: no clock, no absolute path, no host name in the output; sorting is by stable keys (session id, page id).

#### Targets against the baseline

The PRD asks this unit to confirm or revise its targets against the baseline (`docs/reports/2026-11-04-memory-bench-baseline.md`). All targets are confirmed as written in PRD §4; none is revised. `index_bytes`, `digest_count` and `digests_per_day` have no target: they are context for reading the PRD metrics.

| Metric                       | Baseline (this repo, all time) | PRD target           | Verdict   |
| ---------------------------- | ------------------------------ | -------------------- | --------- |
| `capture_coverage` (git)     | see baseline report            | ≥ 0.95               | confirmed |
| `capture_coverage` (non-git) | 0 (PRD, a non-git folder)      | ≥ 0.95               | confirmed |
| `decision_yield`             | see baseline report            | ≥ 0.5 / session-day  | confirmed |
| `recall_hit_at_5`            | see baseline report            | ≥ 0.8                | confirmed |
| `boot_handoff_chars`         | 0                              | ≤ 8,000 (2,000 tok.) | confirmed |
| `memory_read_default_bytes`  | see baseline report            | ≤ 16,384             | confirmed |
| `hot_freshness_hours`        | see baseline report            | median ≤ 0.167 h     | confirmed |
| `orphan_loss`                | see baseline report            | 0                    | confirmed |

### S-2 · Live resume-eval (chapter 2, first unit)

- depends-on: S-1
- substrate: worktree
- files-may-touch: `scripts/memory-eval.mjs`, `scripts/memory-eval-core.mjs`, `tests/memory-eval-core.test.ts`, `tests/fixtures/memory-eval/`, `src/main/hook-bridge.ts` (the one write below), `docs/reports/<date>-memory-eval-baseline.md`, `package.json` (one script line), `CHANGELOG.md`
- produces: memory-resume-eval
- consumes: memory-bench-scorecard
- acs: AC-9, AC-10, AC-11, AC-12, AC-13

The scorecard measures what is on disk. This eval measures what a **new session knows**: plant facts in earlier sessions, let the build under test capture them however it does, then ask fresh sessions questions whose answers only those earlier sessions held. It reuses the isolated-instance harness of the mission behavior eval (`scripts/eval/mission-behavior/harnu.mjs`: `buildApp`, `startHarnu`, `cleanEnv`, `killAllLaunched`; `agent.mjs` shows how a scripted `claude -p` is pointed at the instance's `harnu.mcp.json`). Read `scripts/eval/mission-behavior/README.md` before building it.

#### Fixture layout

```
tests/fixtures/memory-eval/
  README.md               what the fixture is and how to change it (a change means a new report baseline)
  repo/                   the project skeleton, copied into a fresh temp dir per run
    README.md             "memory-eval demo service" and nothing a question asks about
    package.json          { "name": "memory-eval-demo", "private": true } — no dependencies
    src/server.ts         a 10-line HTTP server stub
  sessions.json           the planted-session manifest (below)
  sessions/s01.jsonl … s06.jsonl   transcript templates, one per planted session
  facts.json              the K = 12 planted facts (below)
  questions.json          the frozen question set (below)
  oracle/hot.md           a hand-written ideal memory holding all 12 facts: the ceiling condition
  oracle/decisions.md
```

**Transcript templates** use the line shapes of `tests/fixtures/memory-bench/home/projects/*/*.jsonl` (`type`, `sessionId`, `cwd`, `timestamp`, `isSidechain`, `message`), with two placeholders: `{{CWD}}` (replaced by the temp repo path) and nothing else; session ids and timestamps are literal. Sessions s01 to s06 start on 2026-01-05 to 2026-01-10 at 09:00 UTC, one per day, each with 4 to 6 operator turns and an assistant reply after each. Each session states its two facts in an operator turn and has the assistant restate them in its reply, in plain sentences, never in a list headed "facts".

**`sessions.json`**: `[{ "file": "s01.jsonl", "sessionId": "<uuid>", "commits": [{ "path": "src/server.ts", "content": "<full file text>", "message": "<conventional commit>" }] }]`. s01, s02 and s03 carry one commit each; s04, s05 and s06 carry none (a research, a planning and a debugging session: the shape that leaves no digest today). The runner makes each commit in the temp repo with `GIT_AUTHOR_DATE` and `GIT_COMMITTER_DATE` set to the session's last timestamp minus one minute, author `Eval <eval@example.invalid>`.

**`facts.json`**: `[{ "id": "F01", "session": "s01", "kind": "decision" | "gotcha" | "rule" | "state", "statement": "<sentence>", "answer": "<token>" }]`, 12 facts, 2 per session, 3 of each kind. Every `answer` token is at least 4 characters, appears in exactly one session template (except the superseded pair), never appears in `repo/` or in any question, and cannot be guessed from the question (a port number, a flag name, an invented codename). One pair tests staleness: F06 (s02, kind `state`) says the release branch is `release/1`; F12 (s06, kind `state`) says it moved to `release/2`.

**`questions.json`**: `[{ "id": "Q01", "fact": "F01" | null, "kind": "direct" | "paraphrase" | "control", "question": "<text>", "mustInclude": ["<token>"], "mustNotInclude": ["<token>"] }]`. 24 answerable questions (one `direct` and one `paraphrase` per fact) and 6 `control` questions about plausible project facts that no session stated, each with `mustInclude: ["not in memory"]`. The F12 questions carry `mustNotInclude: ["release/1"]`.

#### Conditions

- `none` — the planted transcripts exist, the memory dir is deleted before probing. The floor.
- `oracle` — `oracle/hot.md` and `oracle/decisions.md` are copied into `<temp repo>/.harnu/memory/` and nothing is captured. The ceiling of what memory content alone can do.
- `harnu` — the build under test captures the planted sessions (procedure below). The system under test.

`none` and `oracle` are run when the fixture or the probe model changes and their report is committed; `harnu` runs on every A/B.

#### One run

1. **Workspace.** Make a run dir under `os.tmpdir()` (`memory-eval-<random>`). Copy `repo/` to `<run>/repo`, `git init -b main`, commit everything with author and committer date `2026-01-04T09:00:00Z`.
2. **Instance.** `startHarnu({ repoRoot, runDir, log })` from the mission eval harness (it builds unless `--no-build`, isolates `--user-data-dir`, runs under `xvfb-run` on Linux). Adopt `<run>/repo` with the `adopt_folder` verb.
3. **Plant.** For each manifest row in order: write the template, with `{{CWD}}` replaced, to `~/.claude/projects/<slugOfPath(<run>/repo)>/<sessionId>.jsonl` (`slugOfPath` from `src/main/gc/gc-transcripts.ts`: every non-alphanumeric character becomes `-`). The slug is unique to the run dir, so nothing else in the operator's projects folder is touched. Then make the row's commits.
4. **Capture** (`harnu` only). The hook bridge writes `<userData>/harnu.hooks.json` = `{ "url": "http://127.0.0.1:<port>/hook/<token>" }` when it starts (the one `src/` change this slice makes, next to `harnu.mcp.json`). For each planted session in order, `POST <url>/SessionEnd/_` with body `{ "hook_event_name": "SessionEnd", "session_id": "<id>", "transcript_path": "<absolute path>", "cwd": "<run>/repo", "reason": "other" }`. Then wait until `<run>/repo/.harnu/memory/` has not changed for 10 seconds, or 120 seconds have passed. On today's build this produces digests only for s01 to s03, which is exactly the gap chapter 2 closes.
5. **Probe.** For each question and each trial (`--trials`, default 3), run one fresh `claude -p` in `<run>/repo` with: `--model haiku` (`--model` overrides), `--max-turns 6`, `--mcp-config <userData>/harnu.mcp.json --strict-mcp-config`, `--tools ""`, `--allowedTools mcp__harnu__memory_read,mcp__harnu__memory_query`, `--settings <run>/probe-settings.json` where that file is `{ "hooks": { "SessionStart": [{ "hooks": [{ "type": "http", "url": "<url>/SessionStart/_" }] }] } }`, `--setting-sources ""`, `--output-format stream-json --verbose`, and `cleanEnv()` as its environment. The prompt is exactly: `You are working in the project at <run>/repo. Answer from the project memory only. Answer in one sentence. If the project memory does not say, answer exactly: NOT IN MEMORY.\n\nQuestion: <question>`. A probe that has not finished in 120 seconds is killed and its answer is the empty string. At most 2 probes run at once.
6. **Teardown.** Kill the instance and every probe (`killAllLaunched`, `killAgents`), delete `~/.claude/projects/<the run slug>/` and the run dir. Teardown runs on success, on failure and on SIGINT.

The answer is the `result` field of the stream's final `result` event. The stream of every probe is kept in the run dir as evidence and named in the report; it is never graded by a model.

#### Scoring rubric

Normalize an answer: lowercase, remove `` ` `` and `*`, collapse whitespace. For one trial of an answerable question: **2** when every `mustInclude` token is a substring and no `mustNotInclude` token is; **1** when at least one but not all `mustInclude` tokens are and no `mustNotInclude` token is; **0** otherwise (including `not in memory`). For a control question: **2** when the answer contains `not in memory` and no fact's `answer` token; otherwise **0**, and the trial is a **hallucination** when the answer does not contain `not in memory`. A question's score is the median of its trial scores; a control is hallucinated when the majority of its trials are.

| Metric               | Formula                                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resume_score`       | Σ question scores over the 24 answerable questions ÷ 48                                                                                                                         |
| `resume_exact`       | answerable questions scoring 2 ÷ 24                                                                                                                                             |
| `hallucination_rate` | hallucinated controls ÷ 6                                                                                                                                                       |
| `stale_answer`       | 1 when either F12 question scores 0 because of `release/1`, else 0                                                                                                              |
| `retrieval_hit`      | answerable questions whose majority of trial streams contain the fact's `answer` token in any event before the final `result` ÷ 24. Diagnostic only, never part of a regression |

#### Regression rule (live)

Comparing the `harnu` condition of the chapter's base build (before) with its head build (after), same fixture, same model, same trials: the chapter **regresses** when `resume_score` drops by more than 0.05, or `hallucination_rate` rises at all, or `stale_answer` goes from 0 to 1. It **improves** when `resume_score` rises by at least 0.10 or `hallucination_rate` falls. A difference inside these bands is reported as "no change".

#### Report

`docs/reports/<date>-memory-eval-<label>.md`: the command, both commit shas, the model, trials, the fixture version (the git blob sha of `questions.json`), a table of the five metrics per condition, a per-question table (id, kind, median score, trial scores), and the regression verdict. `npm run memory:eval -- --compare <before.json> <after.json>` prints the verdict and exits 1 on a regression.

### A/B protocol (every chapter from 2 on)

Each chapter's spec has an AC "A/B report committed, no regression", proven by `record:docs/reports/<date>-memory-ab-<chapter>.md`. The report has three parts.

1. **Snapshot metrics** (`recall_hit_at_5`, `memory_read_default_bytes`, `index_bytes`, `boot_handoff_chars`): copy this repo's `.harnu/memory/` once into a temp dir; run the scorecard of the chapter's base commit and of its head commit on that same copy (`--memory <copy> --questions tests/fixtures/memory-bench/questions.harnu.json`, and `--boot <dir>` captured from each build's bridge). Same memory, same question set, so only the code moved. Check out the base commit in a separate worktree to run its scorecard.
2. **Flow metrics** (`capture_coverage`, `decision_yield`, `hot_freshness_hours`, `orphan_loss`): run the head scorecard twice on the live memory, over two windows of the same length: before = the 14 days ending the day the chapter's first commit landed; after = the 14 days starting the day the operator installed the build carrying the chapter. The after-window may be read early after 3 days if it holds at least 20 counted sessions; the report then says "provisional" and is updated at 14 days.
3. **Live eval**: the `harnu` condition before and after (S-2).

A metric regresses when it moves past its tolerance in the wrong direction:

| Metric                            | Better          | Regression when the after value…                             |
| --------------------------------- | --------------- | ------------------------------------------------------------ |
| `capture_coverage`                | higher          | is more than 0.02 lower                                      |
| `decision_yield`                  | higher          | is more than 0.05 lower                                      |
| `recall_hit_at_5`                 | higher          | is lower at all (deterministic on the same snapshot)         |
| `boot_handoff_chars`              | lower           | exceeds 8,000, or exceeds the before value by more than 25 % |
| `memory_read_default_bytes`       | lower           | is more than 2 % higher                                      |
| `hot_freshness_hours`             | lower           | is more than 0.5 h higher                                    |
| `index_bytes`                     | lower           | is more than 5 % higher                                      |
| `orphan_loss`                     | higher is worse | is more than 0.02 higher                                     |
| `digest_count`, `digests_per_day` | —               | never (context: chapter 4 folds digests on purpose)          |

A chapter passes when at least one PRD metric improves past its tolerance and none regresses, in the scorecard or the live eval.

## Acceptance criteria

| id    | statement                                                                                                                                                                                                                      | proof                                                                                                                        | refines/inherits | covers   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ---------------- | -------- |
| AC-1  | `npm run memory:bench -- --repo . --json` exits 0 on this repo and prints every metric named in S-1 as a finite number, and the core computes each metric correctly on the fixtures (one named test per metric).               | test:tests/memory-bench-core.test.ts::AC-1: exits 0 on this repo and prints every metric as a finite number                  | —                | R-2, R-3 |
| AC-2  | Two runs with `--home tests/fixtures/memory-bench/home` produce byte-identical JSON, and the JSON holds no absolute path.                                                                                                      | test:tests/memory-bench-core.test.ts::AC-2: two fixture runs print byte-identical JSON with no absolute path                 | —                | R-3      |
| AC-3  | The non-git fixture folder (sessions, no memory) scores `capture_coverage` 0 and `orphan_loss` ≥ 0 without throwing.                                                                                                           | test:tests/memory-bench-core.test.ts::AC-3: the non-git folder with sessions and no memory scores capture 0 without throwing | —                | R-3      |
| AC-4  | `recall_hit_at_5` uses the same matcher and page order as `memory_query`, and `memory_read_default_bytes` the same payload as `memory_read`: a parity test against the real cores passes; the frozen set has ≥ 40 questions.   | test:tests/memory-bench-core.test.ts::AC-4: the mirrors agree with the real memory_read and memory_query                     | —                | R-3      |
| AC-5  | The shell never writes under the memory dir (a read-only fixture copy is unchanged after a run) and never reads more than ⌊cpus ÷ 2⌋ transcripts at once.                                                                      | test:tests/memory-bench-core.test.ts::AC-5: never writes into a read-only memory dir and caps concurrency at half the CPUs   | —                | R-6      |
| AC-6  | This spec defines the live resume-eval (fixture layout, question format, rubric, regression threshold) and the A/B protocol well enough that a blind builder-check lists no guess it had to make for S-2.                      | record:docs/specs/2026-11-04-memory-benchmark/critics.md                                                                     | —                | R-4, R-5 |
| AC-7  | The baseline report is committed with the command, the commit sha and every metric; the CHANGELOG has an Added entry; `docs/user/project-memory.md` has a "Measuring memory" section.                                          | record:docs/reports/2026-11-04-memory-bench-baseline.md                                                                      | —                | R-1, R-2 |
| AC-8  | The local CI mirror is green on the branch.                                                                                                                                                                                    | script:bash scripts/ci/local-pipeline.sh --base card/T619-memory-ch-1-stp-1-prd-adr-audit-study-for-the-project-memory       | —                | R-6      |
| AC-9  | The S-2 fixture exists exactly as laid out: 6 transcript templates, 12 facts (3 per kind, the F06/F12 superseded pair), 24 answerable and 6 control questions, answer tokens unique and absent from `repo/` and the questions. | test:tests/memory-eval-core.test.ts::the fixture matches the layout and the token rules                                      | —                | R-4      |
| AC-10 | The rubric scores trials and questions exactly as specified, including controls, hallucination and the stale-answer rule.                                                                                                      | test:tests/memory-eval-core.test.ts::the rubric scores answers, controls and stale answers as specified                      | —                | R-4      |
| AC-11 | `--compare` applies the live regression rule and exits 1 on a regression.                                                                                                                                                      | test:tests/memory-eval-core.test.ts::compare flags a regression past each threshold                                          | —                | R-4, R-5 |
| AC-12 | A run of all three conditions on the chapter 2 base build is committed, with `oracle` scoring above `none`.                                                                                                                    | record:docs/reports/2026-11-04-memory-eval-baseline.md                                                                       | —                | R-2, R-4 |
| AC-13 | A run leaves nothing behind: the run slug under `~/.claude/projects/`, the run dir and every process it started are gone after success, failure and SIGINT.                                                                    | test:tests/memory-eval-core.test.ts::teardown removes the run slug, the run dir and every launched process                   | —                | R-6      |

## Open decisions

| id  | question                                                                                                                     | options                                                                              | default                                                      | status |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------ | ------ |
| D-1 | `memory_query` is one substring, so a natural-language question never matches. Which form is the headline `recall_hit_at_5`? | (a) the `query` keyword form, verbatim reported beside it; (b) the verbatim question | (a), because it is what an agent actually passes             | open   |
| D-2 | Probe model of the live eval                                                                                                 | (a) `haiku`; (b) `sonnet`                                                            | (a): cheapest, and the weakest reader shows memory gaps best | open   |
| D-3 | Length of the A/B flow windows                                                                                               | (a) 14 days, readable early at 3 days with ≥ 20 sessions; (b) 7 days                 | (a)                                                          | open   |
| D-4 | `hot_freshness_hours` when sessions exist but `hot.md` does not                                                              | (a) the sentinel −1; (b) the lag from the first session                              | (a): visibly not a measurement                               | open   |

## Amendments · Deviations

| date       | kind      | what changed                                                                                                                                                                                                                                                                                         | by       |
| ---------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 2026-11-04 | deviation | PRD §4 says the benchmark reads the real transports. The static scorecard mirrors `memory_read` (M5) and `memory_query` (M3) in its core instead; the AC-4 parity test pins each mirror to the real core functions, and S-2 is the instrument that goes through the transports.                      | executor |
| 2026-11-04 | deviation | M4 in the static scorecard reads text captured at the bridge (`--boot`), not the bridge itself. Today nothing injects memory at start, so the baseline is 0, as the PRD states. S-2 adds the bridge-side capture point (`harnu.hooks.json`).                                                         | executor |
| 2026-11-04 | deviation | M1 and M6 are defined per folder in the PRD. All folders of one repo share one memory and one `hot.md`, so the scorecard reports one value per repo (a worktree's sessions count toward its repo) and lists per-folder capture in `detail.capture_by_folder`.                                        | executor |
| 2026-11-04 | deviation | M6 is reported in hours (`hot_freshness_hours`, the card's contract name) and in minutes (`hot_freshness_minutes`, the PRD's unit).                                                                                                                                                                  | executor |
| 2026-11-04 | deviation | M7 counts a transcript as an orphan when its folder is missing on disk. The PRD uses Cleanup's "proven gone", which needs Harnu's runtime knowledge (removed-worktree records, mounts); the read-only script has none. Missing-on-disk is the superset, so the ratio is an upper bound of the PRD's. | executor |
| 2026-11-04 | deviation | PRD M3 asks for ≥ 40 questions, the card for ≥ 20. The set has 46. Each entry carries a `query` field next to `question` and `expect` (D-1).                                                                                                                                                         | executor |
| 2026-11-04 | deviation | The card's A/B wording says "same `--since`". Identical windows cannot show a change in capture behavior, so snapshot metrics compare two builds on the same memory copy and flow metrics compare two windows of equal length.                                                                       | executor |
| 2026-11-04 | deviation | M2's addressable entries number 8 against 234 provenance-stamped blocks, so the scorecard also reports `decision_blocks` as context. The PRD formula is unchanged.                                                                                                                                   | executor |
