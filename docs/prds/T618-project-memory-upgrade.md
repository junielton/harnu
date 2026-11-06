# T618: Project memory upgrade: every session leaves a trace, and the next one starts informed

**Status:** PRD v1 (2026-11-04) · **Card:** T618 (epic) · **Campaign:** `cmp-021a1d43` · **Chapter specs:** to come, one per chapter, written by each chapter's own unit
**Evidence:** [`docs/studies/2026-11-04-memory-audit.md`](../studies/2026-11-04-memory-audit.md). **Architecture:** [`docs/adr/0024-project-memory-architecture.md`](../adr/0024-project-memory-architecture.md).

This PRD says what the operator and the sessions see and how we will know it worked. The ADR fixes the architecture; each chapter spec says what is built, in which slices, and how each criterion is proven.

## 1. Who is this for

The operator (solo maintainer, several Harnu sessions open across repos and plain folders, no patience for a curation ritual) and the sessions that work for them: the orchestrator that plans a delivery, the executors that build a slice, the verifier that grades it. A session that starts today knows only what it is told in its first prompt; the operator is the memory.

## 2. The problem

Measured on this repo on 2026-11-04 (details and file pointers in the study, §2):

- **Capture is gated on commits.** A digest is written only for a session that committed at least once (`minCommits: 1`). Research, planning, review and debugging sessions leave nothing. A folder that is not a git repo (8 sessions) holds 0 bytes of memory.
- **What is captured is evidence, not knowledge.** 1,298 of 1,299 digests are auto-digests: commits, files, the last assistant message, the last prompt. Nothing extracts a decision, a gotcha or a rule, and nothing consolidates the digests. `decisions.md` is 405 KB with 7 addressable entries; 232 entries were written by agents who chose to, 4 by a human.
- **Nothing is read back.** A new session gets the instruction "call `memory_read` first", not the content. When it does call it, `memory_read` returns 235 KB, which is more than a session can load: 61 % card catalog, 43 % bare page-id list, 0.2 % `hot`.
- **`hot.md` is overwritten by the last session** with the raw last prompt as "Next", and commits are attributed to every session open on the same checkout.
- **Transcripts of removed worktrees are trashed unsummarized** after Cleanup surfaces them.

The consequence is the one the operator named: sessions vanish, and the memory that exists is unreadable.

## 3. What the operator sees

The upgrade ships as four units. Each is one chapter of the campaign (chapters 2 to 5; chapter 1 is this document set plus the benchmark). The operator-visible result of each is below.

### 3.1 U1: Capture every session

- A session with at least three user turns leaves a digest, whether or not it committed. A digest of a no-commit session says "no commits" in its evidence section and takes its recap from the transcript.
- A folder that is not a git repo gets memory too: the git probe is skipped, the transcript recap stays.
- The digest engine remembers what it already digested across an app restart, and a commit is attributed to the session that made it (author and time window, or that session's own tool calls), not to every session open on the checkout.
- `hot.md` and digests are written in the app language, so the `.harnu/memory/` English contract holds.
- A worktree's transcript gets a digest in its owning repo's memory **before** Cleanup can trash it.
- Capture does not depend on an agent calling a verb: the hook events (including `PreCompact`) are posted to Harnu's loopback server and the digest happens there.

### 3.2 U2: A memory that arrives, and fits

- `memory_read` with no `page` returns a small, bounded answer: the handoff, the ready and in-progress cards, and counts. The card catalog and the page list become paginated sub-calls. The default payload stops being the largest thing in the session.
- `hot.md` stops being "the last session wins". A **typed handoff** (branch, open PR, files touched, next action, open questions, failed approaches) is derived from the digests and the git evidence, as ADR-0008 describes.
- That handoff is **injected at session start** through the hook bridge (`SessionStart`, including after a compaction), fenced and labelled as context, not instructions. A new session knows where the last one stopped without being asked to look.

### 3.3 U3: The consolidation worker

- A Harnu-owned Scheduler worker per repo turns episodic digests into typed pages (`decision`, `gotcha`, `rule`, `concept`) with `[[wiki-links]]` and a pointer to its evidence. It runs hourly, one session per tick, and skips while the operator is working in that repo.
- **The worker is off until the operator turns it on per repo.** Turning it on discloses that transcript excerpts are sent to the model provider (the privacy lesson in `docs/lessons/privacy/001-spawning-claude-p-is-network-egress.md`). Capture (U1) and the handoff (U2) work without it.
- Its proposals supersede older entries by id; nothing is deleted. Every proposal is in an audit trail the operator can read (approval: decision D-2, auto-apply with a shadow log, a per-repo switch turns on approval).
- Once a week it folds digests older than 30 days into one page per week, so `sessions/` stops growing without bound.
- It uses a cheap model (Haiku) and a per-tick cap, taken from the repo's routing table (decision D-1).

### 3.4 U4: A graph, and lessons that cross repos

- Every `[[page]]` in `.harnu/memory/**` is an edge. `memory_query` expands its hits by link neighbours and ranks maintained pages (`decision`, `rule`, `gotcha`) above episodic ones, without hiding any.
- The Memory pane gets a graph tab. The files stay Obsidian-openable.
- A global layer under `~/.harnu/global/` holds cross-cutting `rule` and `gotcha` pages promoted from repo memories ("Vite + Electron HMR breaks X"). Every repo's boot handoff reads it. Promotion is a worker proposal; project facts never leave the repo (decision D-3). The root is `~/.harnu/global/` and not `~/.harnu/memory/` because the latter is already the repo memory of the home folder itself, when the home folder is a Harnu folder; sharing the path would mix one folder's own memory with every repo's promoted lessons.

## 4. Metrics

These seven metrics are the **benchmark**: chapter 1's next unit implements them as a script plus a frozen question set, runs it on this repo before any change (the baseline), and every later chapter must move at least one of them and regress none (ADR-0024, decision (e)). Targets below are proposals; the benchmark unit confirms or revises them against the baseline, and says so in its spec.

Terms. A **session** is one Claude Code transcript (`~/.claude/projects/<slug>/<session-id>.jsonl`). A **user turn** is a transcript line of type `user` whose content is operator text, not a tool result. A **session-day** is a distinct pair (folder, calendar date) with at least one session that has three or more user turns. A **digest** is a file in `.harnu/memory/sessions/` named `<date>-<first 8 characters of the session id>.md`.

| #   | Metric                        | Formula                                                                                                                                                                                                                                      | Data source                                                                                                                                                                                  | Baseline (2026-11-04)                                                          | Proposed target                    |
| --- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------- |
| M1  | Capture coverage              | `sessions with a digest ÷ sessions with ≥3 user turns`, computed per folder, with git folders and non-git folders reported as separate series (never pooled)                                                                                 | Numerator: digest file names in `<repo>/.harnu/memory/sessions/` matched to the session-id prefix. Denominator: the session transcripts of that folder's slug                                | Measured by the benchmark unit. Known: 0 for the non-git folder (8 sessions)   | ≥ 95 % for git, ≥ 95 % for non-git |
| M2  | Decision yield                | `decision entries written in the window ÷ session-days in the window`, reported as a total and split by author (`agent`, `human`, `worker`)                                                                                                  | Entries: the `> entry:` lines (with `valid_from`) in `decisions.md`, plus their provenance line. Session-days: transcripts, as defined above                                                 | 7 addressable entries over 83 days, so ≪ 0.1 for the whole window              | ≥ 0.5 per session-day              |
| M3  | Recall hit@5                  | `(1 ÷ Q) × Σ over questions of 1[gold(q) ∩ top5(q) ≠ ∅]`, where `Q` is the size of a frozen question set, `gold(q)` is the set of page ids that answer question `q`, and `top5(q)` is the first five page ids `memory_query` returns for `q` | A frozen file of at least 40 questions with gold page ids, written once from real "why did we choose X" decisions in this repo and checked in with the benchmark. Run against `memory_query` | Measured by the benchmark unit (the current grep returns hits in file order)   | ≥ 0.8                              |
| M4  | Boot handoff cost             | `⌈characters of everything a new session receives about memory at start ÷ 4⌉`, reported as tokens, measured per start source (`startup`, `resume`, `compact`)                                                                                | The `SessionStart` hook response body (`additionalContext`) plus the memory text in the boot preamble (`src/main/harnu-features.ts`, `src/main/mcp/instructions.ts`), captured at the bridge | The instruction text only, no memory content: the content received is 0        | ≤ 2,000 tokens                     |
| M5  | `memory_read` default payload | `byte length of the result of memory_read({ folder }) with no page`                                                                                                                                                                          | The verb's response, measured through the real MCP transport                                                                                                                                 | ≈ 235 KB                                                                       | ≤ 16 KB                            |
| M6  | Hot freshness                 | `max(0, end time of the folder's most recent session − last-modified time of hot.md)`, in minutes; report the median over the folder's last 30 session ends                                                                                  | Session end: the last line time of the newest transcript of the folder. `hot.md`: file modification time                                                                                     | Measured by the benchmark unit                                                 | median ≤ 10 min                    |
| M7  | Orphan loss                   | `orphan transcripts with no digest ÷ orphan transcripts`, plus the same ratio in bytes. An orphan transcript is one the Cleanup sweep reports for a folder it can positively prove gone                                                      | The orphan scan in `src/main/gc/gc-orphan-transcripts.ts`, matched against the digests of the repo that owned the folder                                                                     | Measured by the benchmark unit. Known: nothing digests an orphan today, so 1.0 | 0                                  |

How the benchmark is run is the benchmark unit's decision, with two constraints from this PRD: it reads the real transports (the MCP verb, the hook bridge) rather than calling internals, and it is deterministic on a fixed corpus so a regression is a diff, not a vibe.

## 5. Non-goals

- **Embeddings and vector search.** The deterministic layers (links, tiers, a derived text index if the benchmark needs one) come first. Revisit only if M3 stays under target after U4.
- **Decay formulas and pinning.** The weekly rollup in U3 bounds growth. Time-based salience, tombstones and `memory_feedback` are a later card.
- **The Codex and Copilot adapter (T545).** Not built here. But the capture seam must stay what it is: a hook, an HTTP POST to the loopback server, and a digest made by Harnu from `{session_id, transcript_path, event}`. A later adapter then adds hook installers and nothing else; it must not need a second memory pipeline.
- Replacing markdown with a database, a hosted service, or any dependency on the network in the read path.
- Rewriting existing memory content. Old digests and decisions are read as they are.

## 6. Decisions

D-1 to D-4 are the study's D1 to D4. **Decided by the operator, 2026-11-04: the default of each is the chosen option.** (Decision D-9 of the chapter spec for U3 is separate and also decided that day: the consolidation worker ships off and is turned on per repo, §3.3.)

| Id  | Decision                                        | Options                                                                                                                                                                                     | Chosen                                                                  | Status  | Gates     |
| --- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------- | --------- |
| D-1 | Consolidation model                             | (a) Haiku through the operator's Claude plan: cheap, no setup, text leaves the machine to the provider already in use. (b) A local Ollama model: private, needs setup and a capable machine | (a) Haiku, model and effort from the routing table                      | decided | U3        |
| D-2 | Approval default for memory proposals           | (a) Auto-apply with a shadow log the operator can review and revert. (b) Every proposal waits in the Approval Inbox                                                                         | (a) Auto-apply with the shadow log; a per-repo switch turns on approval | decided | U3, U4    |
| D-3 | Cross-repo scope                                | (a) Promote only `rule` and `gotcha` pages to the global layer. (b) A full shared graph across repos                                                                                        | (a) `rule` and `gotcha` only                                            | decided | U4        |
| D-4 | Build in Harnu, or embed ai-memory as a sidecar | (a) Build U1 to U4 in Harnu. (b) Run `ai-memory` beside Harnu and feed it Harnu's digests                                                                                                   | (a) Build                                                               | decided | all units |

Reasoning for the choices is in the study (§6) and in ADR-0024 (alternatives considered).

## 7. Absorbed cards

The campaign absorbs eleven backlog cards. Each chapter spec restates its own row and moves the card; this table is the starting accounting. "Chapter" uses the campaign numbering (2 = U1, 3 = U2, 4 = U3, 5 = U4).

| Card | What it was                                                             | Disposition                                                                                                                                                                                                                                                                                                                       |
| ---- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T192 | Hybrid retrieval: FTS5 + entity + graph-neighbour ranking               | **Re-scoped to chapter 5 (U4).** U4 ships the graph-neighbour half. A derived text index and entity ranking are added only if M3 is under target after U4. Embeddings stay out (§5)                                                                                                                                               |
| T193 | Lifecycle: decay sweeps, rollups, pinning, `memory_feedback`            | **Re-scoped.** Weekly rollups close in chapter 4 (U3); the slim index closes in chapter 3 (U2). Decay formulas, pinning and `memory_feedback` stay in the backlog (§5)                                                                                                                                                            |
| T194 | Authority-tiered ranking                                                | **Closed by chapter 5 (U4):** the tier weight is a scoring step in the same `memory_query` change as neighbour expansion                                                                                                                                                                                                          |
| T195 | Consolidate on PreCompact + typed handoff at boot                       | **Closed by chapters 2 and 3.** Chapter 2 (U1) captures at `PreCompact`; chapter 3 (U2) derives the handoff and injects it at `SessionStart`. The approval-gate question it asked is D-2 and ADR-0024 (c)                                                                                                                         |
| T196 | Bootstrap project memory on folder adoption from git log and docs       | **Re-scoped, stays in the backlog.** U1 makes new sessions leave a trace but does not seed history. It can reuse the U3 proposal path once that exists                                                                                                                                                                            |
| T101 | Graph view of the project memories                                      | **Closed by chapter 5 (U4):** the graph tab in the Memory pane, built on the wiki-link index                                                                                                                                                                                                                                      |
| T413 | Compaction digest and durable context re-injection (companion mod P4W5) | **Re-scoped.** The memory half closes in chapters 2 and 3 (capture at `PreCompact`, re-injection when `SessionStart` reports `source: compact`). The companion-mod recap stays with T389                                                                                                                                          |
| T521 | Cleanup 2.4: transcripts of gone folders join the autopilot             | **Re-scoped.** Chapter 2 (U1) adds the precondition: an orphan transcript is digested into its repo's memory before it can be trashed (M7). The autopilot toggle stays in T521 and now depends on that                                                                                                                            |
| T263 | Backfill: distill the 87 problem-signal digests into lessons            | **Closed by chapter 4 (U3):** the worker's first run is a backfill over existing digests, which supersedes the manual pass over 87. Its per-signal yield feeds the calibration T263 asked for                                                                                                                                     |
| T264 | Lesson store every worktree can see, with dedup and a budget            | **Partly closed.** Repo `rule` and `gotcha` pages are visible to every worktree through the single repo memory (chapter 4); the budget is the bounded handoff and `memory_read` payload (chapter 3); cross-repo lessons are the global layer (chapter 5). Item 3, promoting a lesson into `docs/lessons/`, is built by no chapter |
| T265 | Retro signal detector from the digest task-state observer               | **Re-scoped to chapter 4 (U3).** The signals it listed (`StopFailure`, done-without-commit, unmet criteria, repeat dispatch) become inputs to the worker's choice of what to consolidate, not a separate detector                                                                                                                 |
