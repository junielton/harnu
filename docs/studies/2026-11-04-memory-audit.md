# Harnu project memory: audit and improvement proposal

_2026-11-04 · orchestrator session · evidence: code map, the live `.harnu/memory/` of this repo, and a survey of agent-memory projects._

Companion documents: the PRD [`docs/prds/T618-project-memory-upgrade.md`](../prds/T618-project-memory-upgrade.md) and the ADR [`docs/adr/0024-project-memory-architecture.md`](../adr/0024-project-memory-architecture.md). This study is the evidence; the PRD says what the operator sees and how it is measured; the ADR fixes the architecture.

## 1. Verdict in three lines

- **The operator's suspicion is half right.** Harnu does capture something automatically from every session (an auto-digest), but only when the session **committed at least once**. Everything else (research, planning, review, debugging, and any folder that is not a git repo) leaves **nothing**. Decisions are recorded only when an agent voluntarily calls `memory_append`.
- **What is captured is evidence, not knowledge.** A digest is a list of commits and files plus the last assistant message and the last prompt. There is no step that extracts decisions, gotchas, or rules from the transcript, and nothing ever consolidates the 1,299 digests into anything smaller.
- **Nothing reads memory back automatically.** A new session gets an instruction to call `memory_read`, not the content. And in this repo `memory_read` now returns 235 KB, which exceeds what a session can even load.

## 2. What exists today (with file pointers)

| Layer                                                                      | Status                                                                                                         | Where                                                     |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `hot.md` (where we left off)                                               | Overwritten by every auto-digest, last session wins; "Next" is the raw last prompt                             | `src/main/memory-digest.ts:334-417`, `digest-core.ts:411` |
| `decisions.md` (append-only, entry ids, supersede chain, `watches` recall) | Works, but **agent-voluntary only**; 232 agent entries vs 4 human in this repo                                 | `src/main/mcp/memory-entries.ts`                          |
| `sessions/` auto-digest                                                    | Automatic on hook `SessionEnd` / `completed` / 5 min idle, **gated on ≥1 commit**                              | `digest-core.ts:72-96` (`minCommits: 1`)                  |
| `roadmap/` cards                                                           | Full board, 802 cards                                                                                          | `src/main/roadmap-ipc.ts`                                 |
| `index.md`                                                                 | Regenerated on every write; 138 KB because it lists all 652 review/backlog cards by title                      | `memory-store.ts:167-194`                                 |
| Mission / campaign close-out                                               | Deterministic consolidator drafts decision/lesson/hot from the structured record; operator ticks what to write | `src/main/consolidator-core.ts`                           |
| Recall at `mission_create`                                                 | Only decisions carrying `watches`                                                                              | `tool-handlers.ts:3549-3567`                              |
| Auto-injection at session start                                            | **None.** Only the instruction "call `memory_read` first"                                                      | `docs/harnu-features.md`, `src/main/mcp/instructions.ts`  |
| Cross-repo memory                                                          | **None.** Central mode is still one folder per repo                                                            | `memory-core.ts:140-174`                                  |
| Transcripts of removed worktrees                                           | Orphaned, surfaced in Cleanup after 24 h, trashed manually, **never summarized first**                         | `src/main/gc/gc-orphan-transcripts.ts`                    |
| Other CLIs (Codex/Copilot)                                                 | Backlog only: T543 spike, T545 adapter layer, T582 drift watcher                                               | board                                                     |

Measured on this repo on 2026-11-04:

| Metric                        | Value                                                                    |
| ----------------------------- | ------------------------------------------------------------------------ |
| Session digests               | 1,299 (83 days, ~16/day, 60 on the busiest day)                          |
| Digests that are auto-digest  | 1,298                                                                    |
| `decisions.md`                | 405 KB, 168 dated headings, 7 addressable entries, 10 supersede mentions |
| `memory_read` (no page)       | 235 KB: 61 % card catalog, 43 % bare page-id list, 0.2 % hot             |
| A non-git folder (8 sessions) | 0 bytes of memory                                                        |

The `memory_read` shares are reported as measured and sum to slightly over 100 %.

Known defects found on the way:

1. Commits are attributed to **every** session open on the same checkout since it started ("30 commits on main" in hot that day came from many sessions). `memory-digest.ts:139-142`.
2. Digest dedup state is in memory only, lost on restart. `memory-digest.ts:74-80`.
3. `docs/user/project-memory.md` still says writes are approval-gated; BUG-26 removed that gate. Comments in `digest-core.ts:20-21,384-390` are stale the same way.
4. `hot.md` is being written in Portuguese by the digest (it copies the prompt), breaking the English contract for `.harnu/memory/`.

Everything the backlog already planned and never shipped: **T192** hybrid retrieval, **T193** lifecycle (decay, rollups, pinning), **T194** authority-tiered ranking, **T195** PreCompact consolidation + typed handoff injected at boot, **T196** bootstrap from git log, **T101** memory graph canvas, **T521** transcripts of gone folders join autopilot, **T413** compaction digest re-injection. Specs for T192/T193/T195/T196 exist under `docs/specs/2026-08-02-*` as drafts.

## 3. What the reference system is

The system the operator heard described is almost certainly its author's own **`ai-memory`** (github.com/akitaonrails/ai-memory, MIT, Rust, ~15k stars, v3.3.3 on 2026-11-03). The exact podcast episode was not found; the two YouTube videos "O Claude Code esquece tudo" ("Claude Code forgets everything") and "AI Memory 2.6" are the likeliest sources. The design matches what was described:

- **Capture is involuntary.** Hooks on every lifecycle event (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PreCompact`, `Stop`, `SessionEnd`) POST fire-and-forget to a local server. Raw transcript segments are kept immutable under `raw/`. "Nothing is hard-deleted"; supersede marks `is_latest=false`.
- **Session end compiles knowledge.** A cheap model (Haiku 4.5 by default, ~$0.02/run, or a local Ollama model) turns the session into 1-5 typed wiki pages (concept / decision / gotcha / rule) plus a typed handoff (`open_questions`, `next_steps`) that is injected into the next session's context.
- **The "periodic agent" is a background scheduler.** Hourly tick, one session per tick, never in the hook's hot path, proposals go to a pending-writes audit trail with optional `require_approval`. Plus a forget-sweep (TTL → episodic decay → tombstones after 180 days) and an opt-in idle "dream pass" that merges cold clusters and cancels when the operator comes back.
- **Markdown is the source of truth, SQLite is a rebuildable index** (FTS5 + entity index + local embeddings). Obsidian opens the wiki directly; wiki-links are graph edges; `/web/graph` draws it.
- **Works with ~30 harnesses** (Claude Code, Codex, Copilot CLI, Gemini CLI, OpenCode, Cursor) because the capture layer is hooks + HTTP, not a Claude feature.

Reference documents in that repository: `docs/ARCHITECTURE.md`, `docs/auto-improvement-loop.md`, `docs/design-memory-aging.md`.

Others surveyed, one line each: **claude-mem** (112k stars; hooks on every tool call, observer model compresses output, SessionStart injection, no periodic consolidation); **OpenClaw memory-core** (daily notes → `MEMORY.md` via a cron "dreaming" sweep with score gates); **Letta** (sleep-time agent that rewrites memory blocks after N steps or on compaction, arXiv 2504.13171); **Basic Memory** (Obsidian-style markdown + wikilinks + SQLite, agent-voluntary, AGPL); **Mem0** (hosted vector facts, needs an API key); **Hermes** (`MEMORY.md` with a hard char budget, idle self-review); **Graphiti** (bi-temporal graph, facts invalidated never deleted).

Patterns every serious system shares and Harnu lacks: involuntary capture via hooks; a compile step from episodic to semantic; a scheduler that runs when idle and is cancellable; supersede-never-delete; a small always-injected index with overflow to pages; wiki-links as the graph; markdown as truth with a derived index.

## 4. Where Harnu is strong already

Do not throw these away; they are what most of the surveyed projects do **not** have:

- A structured, provenance-stamped record per repo (cards, missions, ledger, decisions with ids and supersede chains).
- A deterministic close-out consolidator that drafts memory from facts, not from a transcript.
- An Approval Inbox and audit log that are a natural home for "pending memory writes".
- A Scheduler with an `observe` mode, a steward pattern, and hibernation awareness: the idle-time consolidation worker already has a runtime to live in.
- Worktrees collapse onto one memory per repo through git common-dir.

## 5. Proposal: four units, in order

Each unit is one PR-sized card. Units 1 and 2 remove the two defects the operator noticed (sessions vanish; memory is unreadable). Units 3 and 4 are the reference-system-style upgrade.

### U1: Capture every session, not only the ones that commit

- Drop the `minCommits: 1` gate as the **only** gate. Keep it as the "evidence" signal, add a second path: any session with ≥N user turns gets a digest whose evidence section says "no commits" and whose recap comes from the transcript.
- Make the digest work for folders that are not git repos: skip the git probe, keep the transcript recap.
- Persist dedup state (fixes the restart hole), attribute commits per session (author email + time window, or the transcript's own tool calls) instead of "everything on HEAD since start".
- Write hot/digest in the app language (fixes the Portuguese leak).
- Hook the transcript of a worktree **before** Cleanup trashes it: an orphan transcript gets a digest in the owning repo's memory first (ships T521's intent).

### U2: Make memory readable: tiered `memory_read` and a boot handoff

- `memory_read` with no page returns hot + ready/in-progress cards + counts; the card catalog and the page list become paginated sub-calls. Cap the index.
- Replace the hot overwrite with a **typed handoff** (branch, open PR, files touched, next action, open questions), derived like T195/ADR-0008 describe, and inject it at `SessionStart` through the hook bridge as `additionalContext` instead of relying on the agent calling `memory_read`. This is the single change that makes "where we left off" actually arrive.

### U3: The consolidation worker ("dreaming")

- A Harnu-owned Scheduler worker per repo, `observe`-style allowlist plus `memory_append`, hourly, one session per tick, idle-aware (skip while the operator is working in that repo), cancellable.
- Input: new session digests + raw transcript since the watermark. Output: typed pages (`decision` / `gotcha` / `rule` / `concept`) with `[[wiki-links]]` and a `page_evidence` pointer to the digest, superseding older entries by id (the chain already exists).
- Proposals land as pending writes in the Approval Inbox with a per-repo `require_approval` switch (default off, like ai-memory), and a weekly rollup that folds digests older than 30 days into one page per week (T193's rollups).
- Cost control: model and effort come from the routing table; default Haiku; a cap per tick.

### U4: Graph and cross-repo

- Wiki-link index: every `[[page]]` in `.harnu/memory/**` becomes an edge; `memory_query` expands by link neighbours (T192's cheapest half, no embeddings needed). The Memory pane gets a graph tab (T101) and the files stay Obsidian-openable.
- A **global** layer under `~/.harnu/memory/` holding only typed `rule` / `gotcha` pages promoted from repo memories ("Vite + Electron HMR breaks X", "never Y in Tailwind v4"), read by every repo's boot handoff. Project facts stay in the repo; only cross-cutting lessons are promoted, and promotion is a worker proposal the operator ticks.

### Explicitly deferred

Embeddings / vector search (T192 full), decay formulas (T193 full), and the Codex/Copilot adapter (T545). U1-U3 are designed so the capture point is "a hook POSTs `{session_id, transcript_path, event}` to loopback", which is exactly what Codex and Copilot CLI hooks also provide today, so the adapter work later only adds hook installers, not a second memory pipeline.

## 6. Open decisions

The study numbered these D1-D4; the PRD carries them as D-1 to D-4 with the same meaning.

- **D1: Consolidation model.** Haiku through the operator's plan vs a local Ollama model. Cost vs privacy; ai-memory defaults to Haiku at ~$0.02 per session.
- **D2: Approval default.** Auto-approve memory proposals (ai-memory, OpenClaw) vs route them through the Approval Inbox by default. The audit's pick: auto-approve with the shadow log, the same choice BUG-26 already made for hot.
- **D3: Cross-repo scope.** Promote only `rule` / `gotcha` pages globally (the audit's pick) vs a full shared graph across repos.
- **D4: Build vs adopt.** Build U1-U4 inside Harnu (the audit's pick: the structured record and the Scheduler are the moat, and the audit/approval story is better) vs embed `ai-memory` as a sidecar and feed it Harnu's digests.
