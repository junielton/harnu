# ADR-0024: Project memory architecture: markdown is the truth, capture is involuntary, consolidation is a worker

**Status:** Proposed (the open decisions D-1 to D-4 in the PRD are the operator's; this ADR records the shape the campaign builds to, with their defaults)
**Date:** 2026-11-04
**Author:** agent (T618 campaign, chapter 1)
**Technical context:** [`docs/prds/T618-project-memory-upgrade.md`](../prds/T618-project-memory-upgrade.md), [`docs/studies/2026-11-04-memory-audit.md`](../studies/2026-11-04-memory-audit.md), ADR-0008 (the handoff is derived boot state), `src/main/memory-digest.ts`, `src/main/mcp/digest-core.ts`, `src/main/mcp/memory-store.ts`, `src/main/hook-installer.ts`, `src/main/hook-bridge.ts`

---

## 1. Context

Harnu keeps a project memory under `.harnu/memory/`: `hot.md`, an append-only `decisions.md` with entry ids and a supersede chain, `sessions/` digests, `roadmap/` cards, `index.md`. The audit (study §2) measured what it does and does not do on this repo:

- A session is digested only if it committed (`minCommits: 1`); a non-git folder gets nothing; 1,298 of 1,299 digests are auto-digests of evidence (commits, files, last prompt), never consolidated.
- Decisions exist only when an agent chooses to call `memory_append`.
- Nothing is injected at session start, and `memory_read` returns 235 KB.
- Transcripts of removed worktrees are trashed without being summarized.

The campaign's four units (PRD §3) change this. They need one set of architectural rules fixed up front, or each chapter will re-decide them: where the truth lives, what triggers capture, who writes the consolidated pages, how far memory reaches across repos, and how we know a chapter helped.

## 2. Decision

**(a) Markdown under `.harnu/memory/` stays the source of truth. Any index is derived and rebuildable.**
Pages are files a person can read, diff, commit and open in Obsidian. A wiki-link index, a text index or a graph is a cache built from those files by the main process; deleting it loses nothing and the next scan recreates it. No chapter may store a fact only in a database. This extends ADR-0008's rule (derived state is regenerable) to every index the campaign adds.

**(b) Capture is involuntary.** Hook events POST to Harnu's loopback server, the agent never waits, and no verb call is required for a session to leave a trace.
The seam is the one that exists: `hook-installer.ts` installs handlers that POST `http://127.0.0.1:<port>/hook/<token>/<event>/<tag>`, and `hook-bridge.ts` folds them. The campaign widens what that seam captures (add `PreCompact`; stop gating the digest on a commit) and changes nothing about its shape. The digest is made by Harnu from `{session_id, transcript_path, event}`. Consequence for other CLIs: a Codex or Copilot adapter (T545) only adds a hook installer that posts the same payload; it never gets its own memory pipeline.

**(c) Consolidation is a Harnu-owned Scheduler worker that proposes writes, with supersede-never-delete and an audit trail. It is never a step on the hook's latency path.**
The worker runs per repo on a cadence, one session per tick, idle-aware and cancellable. It reads digests and transcript segments past a watermark and proposes typed pages (`decision`, `gotcha`, `rule`, `concept`) that supersede older entries by id; nothing is hard-deleted. Every proposal is recorded in an audit trail. Whether proposals apply at once or wait in the Approval Inbox is open decision D-2, default **auto-apply with a shadow log and a per-repo switch for approval**, which is the choice BUG-26 already made for `hot.md`. Model and effort come from the repo's routing table; default Haiku (D-1). The hook path stays a fast POST and a cheap deterministic digest; model calls happen only in the worker.

**(d) Two layers: repo memory, and a global `~/.harnu/memory/` layer that holds only promoted cross-cutting pages.**
Repo memory is the record of one project and stays in the repo. The global layer holds typed `rule` and `gotcha` pages that a worker proposed to promote and the operator accepted; it never holds project facts, cards, digests or decisions (D-3, default `rule`/`gotcha` only). Every repo's boot handoff may read the global layer; no repo can write to another repo's memory.

**(e) The benchmark is the acceptance instrument for every later chapter.**
PRD §4 defines seven metrics with formulas and data sources. The next unit implements them and records a baseline on this repo before any behaviour changes. A chapter is accepted when it moves the metric it targets and regresses none, measured through the real transports (the MCP verb, the hook bridge), not by calling internals. A chapter spec that cannot name the metric it moves is not ready.

## 3. Consequences

**Positive**

- Sessions leave a trace without anyone remembering to ask; the non-git folder and the no-commit session are covered by construction.
- Rebuildable indexes make every chapter cheap to revert and every bug in an index a non-event for the data.
- Model cost and latency are confined to one worker with a cap; a hook never waits on a model.
- Supersede-never-delete plus the audit trail keeps a wrong consolidation correctable and visible, which is what lets D-2 default to auto-apply.
- The benchmark turns "memory feels better" into a diff, and a later adapter has a fixed seam to target.

**Negative and accepted costs**

- Model-authored text enters a system prompt at session start (the boot handoff) and the repo's pages (the worker). The fence and the "context, not instructions" label from ADR-0008 apply to every injected page; anything that lets a page carry directives is a security regression.
- Auto-apply means a wrong page can be read before anyone reviews it. Mitigation: supersede chain, shadow log, the per-repo approval switch, and authority tiers that rank maintained pages above episodic ones without hiding either.
- Involuntary capture records more, including sessions the operator considers throwaway. The three-user-turn threshold and the weekly rollup bound it; a per-folder opt-out is a likely follow-up and not in this campaign.
- The global layer is a new place a lesson can be wrong for a repo it was not learned in. Promotion is explicit and limited to typed `rule`/`gotcha` pages for this reason.
- A derived index must be kept in step with the files; a stale index returns a worse answer, not a wrong fact, and the benchmark (M3) is the guard.

## 4. Alternatives considered

| Option                                                              | One line                                                                                                                                                                                                         | Verdict                                                                                       |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **Build in Harnu** (this ADR)                                       | Reuse the structured record, the Scheduler, the Approval Inbox and the audit log Harnu already has                                                                                                               | **Chosen** (D-4 default)                                                                      |
| [ai-memory](https://github.com/akitaonrails/ai-memory) as a sidecar | The reference design (hooks → local server, session-end compile, hourly scheduler, markdown + derived SQLite); embedding it would give the pipeline for free but a second store and scheduler beside Harnu's own | Rejected as the product; kept as the design reference and as D-4 option (b)                   |
| claude-mem                                                          | Hooks on every tool call and an observer model compressing output, injected at `SessionStart`; no periodic consolidation and no structured record to anchor to                                                   | Rejected: heavy per-tool-call capture, and it never consolidates                              |
| OpenClaw memory-core                                                | Daily notes folded into a `MEMORY.md` by a cron "dreaming" sweep with score gates; supports the worker idea, but flat and agent-centred                                                                          | Rejected as a base; the cron-consolidation idea is adopted in (c)                             |
| Basic Memory                                                        | Obsidian-style markdown with wikilinks and a SQLite index, written only when the agent chooses to; AGPL                                                                                                          | Rejected: agent-voluntary capture is the defect being fixed, and the licence blocks embedding |
| Letta (sleep-time agent)                                            | A second agent rewrites memory blocks after N steps or on compaction; the mechanism behind (c), but it keeps memory in its own blocks rather than in files a person owns                                         | Rejected as a store; its sleep-time idea informs the idle-aware worker                        |

Not adopted, and not alternatives to this decision: Mem0 (hosted vector facts, needs an API key), Hermes (a hard character budget, adopted as the bounded payload in M5), Graphiti (bi-temporal graph; the supersede chain already gives "invalidate, never delete").

## 5. Revisit when

- M3 stays under target after the graph chapter: add a derived text index, then consider embeddings (a new ADR).
- A second agent CLI is wired in (T545): confirm the hook-plus-POST seam carried it without a second pipeline.
- The operator rejects the auto-apply default (D-2) or the model default (D-1): amend (c) rather than work around it.
