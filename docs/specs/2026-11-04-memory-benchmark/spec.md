---
status: approved
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

| Name                              | PRD | Formula                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capture_coverage`                | M1  | captured counted sessions ÷ counted sessions, in the window. Also `capture_coverage_git` and `capture_coverage_nongit` (the series this folder is not in is 0), `capture_sessions`, `captured_sessions`, and per-folder rows in `detail.capture_by_folder`.                                                                                                                                                                |
| `decision_yield`                  | M2  | addressable decision entries (a `> entry:` line in `decisions.md`, PRD §4) in the window ÷ `session_days`. Split `decision_yield_agent`, `decision_yield_human`, `decision_yield_worker` by the `author=` of the entry's provenance stamp. Also `decision_entries`, `session_days`, and, as context only, `decision_blocks` / `decision_blocks_human` (provenance-stamped blocks of any shape).                            |
| `recall_hit_at_5`                 | M3  | `(1 ÷ Q) × Σ 1[gold(q) ∩ top5(q) ≠ ∅]` over the `--questions` set, searching each question's `query`, at page level (a gold entry or section counts as the page that holds it). Also `recall_hit_at_5_strict` (an entry or section gold hits only when a returned match on a top-five page lies inside it), `recall_hit_at_5_verbatim` (the whole `question` as the search string, page level) and `recall_questions` (Q). |
| `boot_handoff_chars`              | M4  | the largest character count (code points) among the `--boot` files. Also `boot_handoff_tokens` = ⌈chars ÷ 4⌉ and `boot_handoff_measured` (1 when `--boot` was given). Per-source counts in `detail.boot`.                                                                                                                                                                                                                  |
| `memory_read_default_bytes`       | M5  | UTF-8 byte length of the text `memory_read({ folder })` with no `page` returns: `JSON.stringify({ ok: true, memory: { hot, index, pages } })`, or the "no project memory yet" payload when the memory dir is empty or absent.                                                                                                                                                                                              |
| `hot_freshness_hours`             | M6  | take the last 30 sessions in the window by end time; for each, lag = max(0, session end − `hot.md` modification time); report the median in hours. Also `hot_freshness_minutes`. 0 with no sessions; −1 when there are sessions but no `hot.md`.                                                                                                                                                                           |
| `index_bytes`                     | —   | byte size of `index.md`, 0 when absent.                                                                                                                                                                                                                                                                                                                                                                                    |
| `digest_count`, `digests_per_day` | —   | digests in the window; ÷ the inclusive day count from (`--since`, else the first digest date) to (`--until` − 1 day, else the last digest date).                                                                                                                                                                                                                                                                           |
| `orphan_loss`                     | M7  | orphans with no digest ÷ orphans, in the window. Also `orphan_loss_bytes` (the same ratio in transcript bytes) and `orphan_transcripts`.                                                                                                                                                                                                                                                                                   |

The JSON also carries `sessions_total` (sessions in the window, any turn count).

**The two mirrors.** `memory_read_default_bytes` and `recall_hit_at_5` re-implement, in the core, what `memoryReadHandler` + `readMemoryOverview` (`src/main/mcp/tool-handlers.ts`, `src/main/mcp/memory-store.ts`) and `queryMemory` + `grepMemory` (`src/main/mcp/memory-core.ts`) do today: the page list is root pages, then `roadmap/`, `sessions/`, `archive/`, `learning/`, each sorted; the matcher is a case-insensitive substring over every line of every page in that order, capped at 50 matches. `top5(q)` is the first five distinct page ids in match order. A gold id resolves to a place: a page id is the whole page; a decision entry id (`e-` + 8 hex) is the entry's lines (the block from the line after the previous `> provenance:` stamp, chrome skipped, to the entry's own stamp, the rule of `parseEntries` in `src/main/mcp/memory-entries.ts`); a section anchor `<page>#<text>` is the first `## ` heading of that page containing `<text>` (case-insensitive) through the line before the next `## ` heading. A gold id that resolves nowhere never hits and is listed in `detail.recall_unresolved_gold`. A parity test runs the real `readMemoryOverview` and `queryMemory` on the fixture memory and asserts the mirrors agree byte for byte and line for line. **A chapter that changes either verb updates the mirror in the same PR**, and the parity test fails until it does.

**Question set format** (`tests/fixtures/memory-bench/questions.harnu.json`, frozen): a JSON array of `{ "question": string, "query": string, "expect": string[] }`. `question` is how a person would ask; `query` is the search string an agent would pass to `memory_query`, and **must be a contiguous span of the question's own words** (the validator refuses anything else), so the set cannot be tuned to the wording of the gold page; `expect` holds page ids (`hot`, `roadmap/<stem>`, `sessions/<stem>`), decision entry ids (`e-1a2b3c4d`) or section anchors (`decisions#<heading text>`). A question set is never edited after its first committed report; a new version is a new file, and the report names the file it used.

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
               "recall_misses": ["<question>", ...], "recall_unresolved_gold": ["<gold id>", ...], "boot": { "startup": n, "resume": n, "compact": n } }
}
```

Without `--json` it prints the same data as a markdown report: a header (repo name, kind, window, inputs), one table row per metric (name, PRD id, value, basis such as "3 of 5 sessions", target), then the details. Keys and rows are in a fixed order.

#### Determinism and safety

- Read-only: the shell opens files for reading, runs only `git rev-parse` and `git worktree list`, and never creates, renames or deletes anything. A test runs it on a memory dir whose files and folders are read-only and checks that nothing changed.
- At most `min(8, max(1, ⌊cpus ÷ 2⌋))` transcripts are read at once (CLAUDE.md CPU budget). Lines are streamed, never loaded whole.
- Same inputs, same bytes: no clock, no absolute path, no host name in the output; sorting is by stable keys (session id, page id).

#### Targets against the baseline

The PRD asks this unit to confirm or revise its targets against the baseline (`docs/reports/2026-11-04-memory-bench-baseline.md`). All targets are confirmed as written in PRD §4; none is revised. `index_bytes`, `digest_count` and `digests_per_day` have no target: they are context for reading the PRD metrics.

| Metric                       | Baseline (2026-10-05 to 2026-11-04) | PRD target           | Verdict   |
| ---------------------------- | ----------------------------------- | -------------------- | --------- |
| `capture_coverage` (git)     | 0.7013 (54 of 77)                   | ≥ 0.95               | confirmed |
| `capture_coverage` (non-git) | 0 (0 of 5)                          | ≥ 0.95               | confirmed |
| `decision_yield`             | 0.1905                              | ≥ 0.5 / session-day  | confirmed |
| `recall_hit_at_5`            | 0.7826 (strict 0.7826)              | ≥ 0.8                | confirmed |
| `boot_handoff_chars`         | 0                                   | ≤ 8,000 (2,000 tok.) | confirmed |
| `memory_read_default_bytes`  | 239,688                             | ≤ 16,384             | confirmed |
| `hot_freshness_hours`        | 0                                   | median ≤ 0.167 h     | confirmed |
| `orphan_loss`                | 0.2963                              | 0                    | confirmed |

### S-2 · Live resume-eval (chapter 2, first unit)

- depends-on: S-1
- substrate: worktree
- files-may-touch: `scripts/memory-eval.mjs`, `scripts/memory-eval-core.mjs`, `tests/memory-eval-core.test.ts`, `tests/fixtures/memory-eval/`, `src/main/hook-bridge.ts` (the one write below), `docs/reports/memory-eval-baseline.md`, `docs/reports/memory-eval/`, `package.json` (one script line), `CHANGELOG.md`
- produces: memory-resume-eval
- consumes: memory-bench-scorecard
- acs: AC-9, AC-10, AC-11, AC-12, AC-13

The scorecard measures what is on disk. This eval measures what a **new session knows**: plant facts in earlier sessions, let the build under test capture them however it does, then ask fresh sessions questions whose answers only those earlier sessions held. It reuses the isolated-instance harness of the mission behavior eval: `scripts/eval/mission-behavior/harnu.mjs` exports `buildApp(repoRoot, logFile)`, `startHarnu({ repoRoot, runDir, log })` (it never builds; it launches `<repoRoot>/out/main` with `<repoRoot>/node_modules`, isolated by `--user-data-dir`, under `xvfb-run` on Linux), `cleanEnv(extra)` and `killAllLaunched()`; `agent.mjs` exports `killAgents()` and shows how a scripted `claude -p` is pointed at the instance's `harnu.mcp.json`. Read `scripts/eval/mission-behavior/README.md` before building it.

#### Command line

```
npm run memory:eval -- --condition none|oracle|harnu [--label <name>] [--trials <odd n>] [--model <m>]
                       [--app-root <dir>] [--no-build] [--capture-boot <dir>] [--keep]
npm run memory:eval -- --compare <before.json> <after.json>
```

| Flag             | Default       | Meaning                                                                                                                                           |
| ---------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--condition`    | required      | Which memory the probes see (below).                                                                                                              |
| `--label`        | the condition | Names the result files.                                                                                                                           |
| `--trials`       | `3`           | Probes per question. Must be odd (medians and majorities need one); an even value exits 2.                                                        |
| `--model`        | `haiku`       | The probe model (D-2).                                                                                                                            |
| `--app-root`     | this checkout | The checkout whose build is launched. The runner calls `buildApp(appRoot, log)` unless `--no-build`, then `startHarnu({ repoRoot: appRoot, … })`. |
| `--no-build`     | off           | Reuse `<app-root>/out/` as it is.                                                                                                                 |
| `--capture-boot` | none          | After capture, also save what the bridge answers at session start (below) into this directory, for the scorecard's `--boot`.                      |
| `--keep`         | off           | Keep the run dir for inspection; teardown still kills every process and deletes the run slug.                                                     |
| `--compare`      | —             | Read two result files, print the verdict, exit 1 on a regression and 2 when they are not comparable (different model, trials or `fixtureSha`).    |

To run the **before** build of an A/B: `git worktree add <tmp>/base <base sha>`, `npm ci` in it, then `npm run memory:eval -- --condition harnu --label before --app-root <tmp>/base` from the head checkout. The runner and fixture always come from the head checkout; only the launched app comes from `--app-root`.

#### Fixture layout

```
tests/fixtures/memory-eval/
  README.md               what the fixture is and how to change it (a change means a new baseline report)
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

**Transcript templates** use the line shapes of `tests/fixtures/memory-bench/home/projects/*/*.jsonl` (`type`, `sessionId`, `cwd`, `timestamp`, `isSidechain`, `message`), with one placeholder, `{{CWD}}`, replaced by the temp repo path; session ids and timestamps are literal. Sessions s01 to s06 start on 2026-01-05 to 2026-01-10 at 09:00 UTC, one per day, each with 4 to 6 operator turns and an assistant reply after each. Each session states its two facts in an operator turn and has the assistant restate them in its reply, in plain sentences, never in a list headed "facts".

**`sessions.json`**: `[{ "file": "s01.jsonl", "sessionId": "<uuid>", "commits": [{ "path": "src/server.ts", "content": "<full file text>", "message": "<conventional commit>" }] }]`. s01, s02 and s03 carry one commit each; s04, s05 and s06 carry none (a research, a planning and a debugging session: the shape that leaves no digest today). Each commit is made with author and committer `Eval <eval@example.invalid>` and `GIT_AUTHOR_DATE` = `GIT_COMMITTER_DATE` = the session's last timestamp minus one minute.

**`facts.json`**: `[{ "id": "F01", "session": "s01", "kind": "decision" | "gotcha" | "rule" | "state", "statement": "<sentence>", "answer": "<token>" }]`, 12 facts, 2 per session, 3 of each kind. Every `answer` token is at least 4 characters, appears in exactly one session template, never appears in `repo/` or in any question, and cannot be guessed from the question (a port number, a flag name, an invented codename). One pair tests staleness and is the only exception to "exactly one template": F06 (s02, kind `state`) says the release branch is `release/1`; F12 (s06, kind `state`) says it moved from `release/1` to `release/2`.

**`questions.json`**: `[{ "id": "Q01", "fact": "F01" | null, "kind": "direct" | "paraphrase" | "control", "question": "<text>", "mustInclude": ["<token>"], "mustNotInclude": ["<token>"] }]`. 24 answerable questions (one `direct` and one `paraphrase` per fact) and 6 `control` questions about plausible project facts that no session stated, each with `mustInclude: ["not in memory"]`. The F06 questions are explicitly historical ("which release branch was used before the move?", `mustInclude: ["release/1"]`); the F12 questions ask for the current branch with `mustInclude: ["release/2"]` and `mustNotInclude: ["release/1"]`.

#### Conditions

- `none` — nothing is captured and `<run>/repo/.harnu/` is deleted before probing. The floor.
- `oracle` — nothing is captured; `<run>/repo/.harnu/` is deleted, then `oracle/hot.md` and `oracle/decisions.md` are copied into `<run>/repo/.harnu/memory/`. The ceiling of what memory content alone can do.
- `harnu` — the build under test captures the planted sessions (step 5). The system under test.

`none` and `oracle` are run when the fixture or the probe model changes and their result is committed; `harnu` runs on every A/B.

#### One run

1. **Workspace.** Make a run dir under `os.tmpdir()` (`memory-eval-<random>`). Copy `repo/` to `<run>/repo`, `git init -b main`, commit everything as `Eval <eval@example.invalid>` with author and committer date `2026-01-04T09:00:00Z`.
2. **Plant**, before any instance runs. For each manifest row in order: write the template, with `{{CWD}}` replaced, to `~/.claude/projects/<slugOfPath(<run>/repo)>/<sessionId>.jsonl` (`slugOfPath` in `src/main/gc/gc-transcripts.ts`: trailing slashes dropped, every non-alphanumeric character becomes `-`), then make the row's commits. The slug is unique to the run dir, so nothing else in the operator's projects folder is touched.
3. **Hook isolation.** Write `<run>/userData/hook-prefs.json` = `{ "enabled": false }`. The instance then starts its bridge server but does not add its hooks to the operator's `~/.claude/settings.json` (`readEnabled` in `src/main/hook-bridge.ts`).
4. **Instance.** `buildApp(appRoot, log)` unless `--no-build`; `startHarnu({ repoRoot: appRoot, runDir, log })`; call the verb `adopt_folder` with `{ "folder": "<run>/repo" }`. The bridge writes `<userData>/harnu.hooks.json` = `{ "url": "http://127.0.0.1:<port>/hook/<token>" }` right after `startHookServer` resolves (the one `src/` change this slice makes; `harnu.mcp.json` is its model). The runner waits up to 30 s for that file.
5. **Capture** (`harnu` only). Today's capture is the `DigestEngine` in `src/main/memory-digest.ts`: it observes the bridge's task events, digests on `SessionEnd` (or 5 minutes of idle), resolves the session id through `scanFolders()` (which reads `~/.claude/projects/`), and writes only when the session's checkout has a commit since the session started. The bridge reads `session_id`, `reason` and `source` from the body; anything else is ignored today and is sent for the builds that will read it. For each planted session in order, `POST <url>/SessionEnd/_` with `{ "hook_event_name": "SessionEnd", "session_id": "<id>", "transcript_path": "<absolute path>", "cwd": "<run>/repo", "reason": "other" }`. Then poll `<run>/repo/.harnu/memory/` every second (a recursive list of path, size and mtime) until it is unchanged for 10 consecutive polls, or 120 s pass. On today's build this yields digests for s01 to s03 only, which is the gap chapter 2 closes. Nothing is POSTed in `none` and `oracle`, so nothing is captured there; the probes below write no transcript, so they cannot be captured either.
6. **Boot capture** (with `--capture-boot <dir>`). For each source `startup`, `resume`, `compact`: `POST <url>/SessionStart/_` with `{ "hook_event_name": "SessionStart", "session_id": "<fresh uuid>", "cwd": "<run>/repo", "source": "<source>" }` and write the response's `hookSpecificOutput.additionalContext` (or the empty string when absent, as today, where the bridge answers `{}`) to `<dir>/<source>.txt`.
7. **Probe.** For each question and each trial, run one fresh `claude -p` with cwd `<run>/repo` and these arguments: `--model <model>`, `--max-turns 6`, `--no-session-persistence`, `--mcp-config <userData>/harnu.mcp.json`, `--strict-mcp-config`, `--tools ""`, `--allowedTools mcp__harnu__memory_read,mcp__harnu__memory_query`, `--settings <run>/probe-settings.json`, `--setting-sources project`, `--output-format stream-json`, `--verbose`, environment `cleanEnv({ ENABLE_TOOL_SEARCH: "false" })` (as `agent.mjs` does, so the verbs load up front). `probe-settings.json` is `{ "hooks": { "SessionStart": [{ "hooks": [{ "type": "http", "url": "<url>/SessionStart/_" }] }] } }`; `--settings` is its own settings source and loads whatever `--setting-sources` says, and the temp repo has no `.claude/`, so this is the only hook the probe has. The prompt is exactly: `You are working in the project at <run>/repo. Answer from the project memory only. Answer in one sentence. If the project memory does not say, answer exactly: NOT IN MEMORY.\n\nQuestion: <question>`. A probe that has not finished in 120 s is killed and its answer is the empty string. At most 2 probes run at once.
8. **Teardown**, on success, on failure and on SIGINT: `killAgents()`, `killAllLaunched()`, delete `~/.claude/projects/<the run slug>/`, and delete the run dir unless `--keep`. The teardown plan (the slug path, the run dir, the pids launched) is computed by a pure function in the core so it can be tested.

The answer is the `result` field of the stream's final `result` event. Every probe's stream is kept in the run dir as evidence; nothing is graded by a model.

#### Scoring rubric

Normalize answers and tokens the same way: lowercase, remove `` ` `` and `*`, collapse whitespace. For one trial of an answerable question: **2** when every `mustInclude` token is a substring and no `mustNotInclude` token is; **1** when at least one but not all `mustInclude` tokens are and no `mustNotInclude` token is; **0** otherwise (including `not in memory`). For a control question: **2** when the answer contains `not in memory` and no fact's `answer` token; otherwise **0**, and the trial is a **hallucination** when the answer does not contain `not in memory`. A question's score is the median of its trial scores; a control is hallucinated when a majority of its trials are.

| Metric               | Formula                                                                                                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resume_score`       | Σ question scores over the 24 answerable questions ÷ 48                                                                                                                           |
| `resume_exact`       | answerable questions scoring 2 ÷ 24                                                                                                                                               |
| `hallucination_rate` | hallucinated controls ÷ 6                                                                                                                                                         |
| `stale_answer`       | 1 when either F12 question has median score 0 and a majority of its trials contain `release/1`, else 0                                                                            |
| `retrieval_hit`      | answerable questions where a majority of trial streams contain the fact's `answer` token in any event before the final `result` ÷ 24. Diagnostic only, never part of a regression |

#### Result file and report

Each run writes `<run>/result.json` and copies it to `docs/reports/memory-eval/<YYYY-MM-DD>-<label>-<condition>.json` (the date the run is made):

```
{ "schema": 1, "condition": "harnu", "label": "before", "model": "haiku", "trials": 3,
  "appSha": "<git rev-parse HEAD of --app-root>", "fixtureSha": "<git hash-object questions.json>",
  "metrics": { "resume_score": n, "resume_exact": n, "hallucination_rate": n, "stale_answer": n, "retrieval_hit": n },
  "questions": [{ "id": "Q01", "kind": "direct", "trials": [2, 2, 1], "score": 2, "hallucinated": false }] }
```

A report (`docs/reports/<YYYY-MM-DD>-memory-eval-<label>.md`) names the command, the `appSha` of each build it covers (one for a single run, two for an A/B), the model, trials, `fixtureSha`, a table of the five metrics per condition, a per-question table (id, kind, trial scores, median) and, for an A/B, the `--compare` verdict.

#### Regression rule (live)

Comparing the `harnu` result of the chapter's base build (before) with its head build (after), same fixture, model and trials: the chapter **regresses** when `resume_score` drops by more than 0.05, or `hallucination_rate` rises at all, or `stale_answer` goes from 0 to 1. It **improves** when `resume_score` rises by at least 0.10 or `hallucination_rate` falls. A difference inside these bands is "no change".

### A/B protocol (every chapter from 2 on)

Each chapter's spec has an AC "A/B report committed, no regression", proven by `record:docs/reports/<date>-memory-ab-<chapter>.md`. The report has three parts.

1. **Snapshot metrics** (`recall_hit_at_5`, `recall_hit_at_5_strict`, `memory_read_default_bytes`, `index_bytes`, `boot_handoff_chars`): copy this repo's `.harnu/memory/` once into a temp dir; run the scorecard of the chapter's base commit and of its head commit on that same copy (`--memory <copy> --questions tests/fixtures/memory-bench/questions.harnu.json`, plus `--boot <dir>` filled by `memory:eval --capture-boot` against each build). Same memory, same question set, so only the code moved. Run the base scorecard from a worktree at the base commit.
2. **Flow metrics** (`capture_coverage`, `decision_yield`, `hot_freshness_hours`, `orphan_loss`): run the head scorecard twice on the live memory, over two windows of the same length: before = the 14 days ending the day the chapter's first commit landed; after = the 14 days starting the day the operator installed the build carrying the chapter. The after window may be read early after 3 days if it holds at least 20 counted sessions; the report then says "provisional" and is updated at 14 days.
3. **Live eval**: the `harnu` condition before and after (S-2), with the `--compare` verdict.

A metric **regresses** when it moves past its tolerance in the wrong direction and **improves** when it moves past the same tolerance in the right direction:

| Metric                                               | Better | Tolerance                                                                                  |
| ---------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------ |
| `capture_coverage`                                   | higher | 0.02                                                                                       |
| `decision_yield`                                     | higher | 0.05                                                                                       |
| `recall_hit_at_5`, `recall_hit_at_5_strict`          | higher | 0 (deterministic on the same snapshot: any move counts)                                    |
| `memory_read_default_bytes`                          | lower  | 2 %                                                                                        |
| `hot_freshness_hours`                                | lower  | 0.5 h; a −1 sentinel on either side is reported "n/a" and not compared                     |
| `index_bytes`                                        | lower  | 5 %                                                                                        |
| `orphan_loss`                                        | lower  | 0.02                                                                                       |
| `boot_handoff_chars`                                 | a cap  | never improves; regresses when after > 8,000, or when before > 0 and after > before × 1.25 |
| `digest_count`, `digests_per_day`                    | —      | context only: never compared (chapter 4 folds digests on purpose)                          |
| `resume_score`, `hallucination_rate`, `stale_answer` | —      | the live rule above                                                                        |

A chapter **passes** when at least one metric in this table improves and none regresses.

## Acceptance criteria

| id    | statement                                                                                                                                                                                                                                                         | proof                                                                                                                        | refines/inherits | covers   |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------- | -------- |
| AC-1  | `npm run memory:bench -- --repo . --json` exits 0 on this repo and prints every metric named in S-1 as a finite number, and the core computes each metric correctly on the fixtures (one named test per metric).                                                  | test:tests/memory-bench-core.test.ts::AC-1: exits 0 on this repo and prints every metric as a finite number                  | —                | R-2, R-3 |
| AC-2  | Two runs with `--home tests/fixtures/memory-bench/home` produce byte-identical JSON, and the JSON holds no absolute path.                                                                                                                                         | test:tests/memory-bench-core.test.ts::AC-2: two fixture runs print byte-identical JSON with no absolute path                 | —                | R-3      |
| AC-3  | The non-git fixture folder (sessions, no memory) scores `capture_coverage` 0 and `orphan_loss` ≥ 0 without throwing.                                                                                                                                              | test:tests/memory-bench-core.test.ts::AC-3: the non-git folder with sessions and no memory scores capture 0 without throwing | —                | R-3      |
| AC-4  | `recall_hit_at_5` uses the same matcher and page order as `memory_query`, and `memory_read_default_bytes` the same payload as `memory_read`: a parity test against the real cores passes; the frozen set has ≥ 40 questions, each `query` a span of its question. | test:tests/memory-bench-core.test.ts::AC-4: the mirrors agree with the real memory_read and memory_query                     | —                | R-3      |
| AC-5  | The shell never writes under the memory dir (a read-only fixture copy is unchanged after a run) and never reads more than ⌊cpus ÷ 2⌋ transcripts at once.                                                                                                         | test:tests/memory-bench-core.test.ts::AC-5: never writes into a read-only memory dir and caps concurrency at half the CPUs   | —                | R-6      |
| AC-6  | This spec defines the live resume-eval (fixture layout, question format, rubric, regression threshold) and the A/B protocol well enough that a blind builder-check lists no guess it had to make for S-2.                                                         | record:docs/specs/2026-11-04-memory-benchmark/critics.md                                                                     | —                | R-4, R-5 |
| AC-7  | The baseline report is committed with the command, the commit sha and every metric; the CHANGELOG has an Added entry; `docs/user/project-memory.md` has a "Measuring memory" section.                                                                             | record:docs/reports/2026-11-04-memory-bench-baseline.md                                                                      | —                | R-1, R-2 |
| AC-8  | The local CI mirror is green on the branch.                                                                                                                                                                                                                       | script:bash scripts/ci/local-pipeline.sh --base card/T619-memory-ch-1-stp-1-prd-adr-audit-study-for-the-project-memory       | —                | R-6      |
| AC-9  | The S-2 fixture exists exactly as laid out: 6 transcript templates, 12 facts (3 per kind, the F06/F12 superseded pair), 24 answerable and 6 control questions, answer tokens unique (bar the pair) and absent from `repo/` and the questions.                     | test:tests/memory-eval-core.test.ts::the fixture matches the layout and the token rules                                      | —                | R-4      |
| AC-10 | The rubric scores trials and questions exactly as specified, including controls, hallucination, the stale-answer rule, and the refusal of an even `--trials`.                                                                                                     | test:tests/memory-eval-core.test.ts::the rubric scores answers, controls and stale answers as specified                      | —                | R-4      |
| AC-11 | `--compare` applies the live regression rule, exits 1 on a regression and 2 on results that are not comparable.                                                                                                                                                   | test:tests/memory-eval-core.test.ts::compare flags a regression past each threshold                                          | —                | R-4, R-5 |
| AC-12 | A run of all three conditions on the chapter 2 base build is committed (result files and report), with `oracle` scoring above `none`.                                                                                                                             | record:docs/reports/memory-eval-baseline.md                                                                                  | —                | R-2, R-4 |
| AC-13 | A run leaves nothing behind: the teardown plan names the run slug under `~/.claude/projects/`, the run dir and every launched pid, and the instance never writes the operator's `~/.claude/settings.json`.                                                        | test:tests/memory-eval-core.test.ts::teardown plans the run slug, the run dir and every launched pid                         | —                | R-6      |

## Open decisions

| id  | question                                                                                                                     | options                                                                                                               | default                                                      | status  |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------- |
| D-1 | `memory_query` is one substring, so a natural-language question never matches. Which form is the headline `recall_hit_at_5`? | (a) the `query` form (a span of the question), with strict and verbatim reported beside it; (b) the verbatim question | (a), because it is what an agent actually passes             | decided |
| D-2 | Probe model of the live eval                                                                                                 | (a) `haiku`; (b) `sonnet`                                                                                             | (a): cheapest, and the weakest reader shows memory gaps best | decided |
| D-3 | Length of the A/B flow windows                                                                                               | (a) 14 days, readable early at 3 days with ≥ 20 sessions; (b) 7 days                                                  | (a)                                                          | decided |
| D-4 | `hot_freshness_hours` when sessions exist but `hot.md` does not                                                              | (a) the sentinel −1; (b) the lag from the first session                                                               | (a): visibly not a measurement                               | decided |

Decided by the operator on 2026-11-04 (every default accepted):

- D-1 · Which form is the headline `recall_hit_at_5`? · chosen: (a) the `query` form (a span of the question), with strict and verbatim reported beside it · 2026-11-04
- D-2 · Probe model of the live eval · chosen: (a) `haiku` · 2026-11-04
- D-3 · Length of the A/B flow windows · chosen: (a) 14 days, readable early at 3 days with ≥ 20 sessions · 2026-11-04
- D-4 · `hot_freshness_hours` when sessions exist but `hot.md` does not · chosen: (a) the sentinel −1 · 2026-11-04

## Amendments · Deviations

| date       | kind      | what changed                                                                                                                                                                                                                                                                                                                                                                 | by           |
| ---------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| 2026-11-04 | deviation | PRD §4 says the benchmark reads the real transports. The static scorecard mirrors `memory_read` (M5) and `memory_query` (M3) in its core instead; the AC-4 parity test pins each mirror to the real core functions, and S-2 is the instrument that goes through the transports.                                                                                              | executor     |
| 2026-11-04 | deviation | M4 in the static scorecard reads text captured at the bridge (`--boot`), not the bridge itself. Today nothing injects memory at start, so the baseline is 0, as the PRD states. S-2 adds the bridge-side capture point (`harnu.hooks.json`).                                                                                                                                 | executor     |
| 2026-11-04 | deviation | M1 and M6 are defined per folder in the PRD. All folders of one repo share one memory and one `hot.md`, so the scorecard reports one value per repo (a worktree's sessions count toward its repo) and lists per-folder capture in `detail.capture_by_folder`.                                                                                                                | executor     |
| 2026-11-04 | deviation | M6 is reported in hours (`hot_freshness_hours`, the card's contract name) and in minutes (`hot_freshness_minutes`, the PRD's unit).                                                                                                                                                                                                                                          | executor     |
| 2026-11-04 | deviation | M7 counts a transcript as an orphan when its folder is missing on disk. The PRD uses Cleanup's "proven gone", which needs Harnu's runtime knowledge (removed-worktree records, mounts); the read-only script has none. Missing-on-disk is the superset, so the ratio is an upper bound of the PRD's.                                                                         | executor     |
| 2026-11-04 | deviation | PRD M3 asks for ≥ 40 questions, the card for ≥ 20. The set has 46. Each entry carries a `query` field next to `question` and `expect` (D-1).                                                                                                                                                                                                                                 | executor     |
| 2026-11-04 | deviation | The card's A/B wording says "same `--since`". Identical windows cannot show a change in capture behavior, so snapshot metrics compare two builds on the same memory copy and flow metrics compare two windows of equal length.                                                                                                                                               | executor     |
| 2026-11-04 | deviation | M2's addressable entries number 8 against 234 provenance-stamped blocks, so the scorecard also reports `decision_blocks` as context. The PRD formula is unchanged.                                                                                                                                                                                                           | executor     |
| 2026-11-04 | deviation | PRD M3 defines gold as page ids. `decisions.md` is one 400 KB page that comes first in grep order, so page-level recall is close to free for any decision. The question set can therefore name an entry id or a `## ` section as gold, and `recall_hit_at_5_strict` requires a returned match inside it. The headline stays the PRD's page-level number.                     | executor     |
| 2026-11-04 | amendment | Blind builder-check (`critics.md`): S-2 now lists every `memory:eval` flag, `--app-root` for the before build, the result-file schema, the capture engine and its trigger, `--no-session-persistence`, boot capture, hook isolation, odd trials, the historical F06 questions, the boot cap rule and the n/a sentinel rule.                                                  | executor     |
| 2026-11-05 | deviation | M7 (`orphan_loss`, `orphan_loss_bytes`, `orphan_transcripts`) counts only orphans with at least `MIN_OPERATOR_TURNS` operator turns, the same rule as M1, because a session below the digest gate is not a loss. Requested by the memory U1 chapter (its AC-19). The baseline's `orphan_loss` (0.2963) is re-measured with the fixed benchmark before any delta is computed. | S-5 executor |
