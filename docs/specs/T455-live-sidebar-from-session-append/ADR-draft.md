# ADR-draft — Live sidebar facts are pushed by the Harnu mod; JSONL tailing is demoted, not deleted

**Status:** proposed (gets a number when merged) · **Date:** 2026-10-09 · **Card:** T455 ·
**Spec:** [`00-spec.md`](00-spec.md)

## Context

For a running session, the sidebar, `SessionPreview`, the fleet rail and `get_fleet` learn the
title, the prompts, the activity and the tool calls by tailing and re-parsing the session's JSONL:
a chokidar watcher reads each append, a reader fold reads it again, and the fleet model rescans the
whole project dir at most every 2 s (01-inventory.md §3.3). Measured on the operator's machine
(02-cost.md): 2.6–3.1 opens per append of a live transcript, ~2,800 opens per minute of _other_
transcripts in a 9,387-file project dir whenever one of its sessions appends, and a p90 of
215–1,484 ms from append to reread. Several facts go stale while a session runs (F3), `get_fleet`
calls every disk session `idle` (F1), and a new session binds to its row through folder and
recency guesses (01-inventory.md §3.4).

The Harnu mod (ADR-0018) already runs in every session Harnu spawns, with a typed channel to
Harnu main, a lease, per-family arbitration and a parity ledger. Claude Code 2.1.29x gives a mod
`session.append`, one event per row the conversation keeps, before it is stored, carrying the
row's transcript uuid (types 4348-4359, 10566-10594), and the classic `SessionStart` /
`UserPromptSubmit` payloads carry the start `source`, the exact `transcript_path` and the
`session_title` (types 826-829, 11643-11648, 14661-14669). Probed on 2.1.296 (03-prototype.md
§P.4): the uuids match the JSONL in order; a resume or a fork loads its history without any
append; a fork gets `source: "fork"` and a new id, and the engine names no parent anywhere.

Lesson `synthetic-sessions/004` forbids re-keying a row before its transcript exists. T389 ARB-8
and P5W1 §7.6 forbid deleting the transcript watcher.

## Decision

1. **The Harnu mod pushes the compact row.** A new feature `sense.row` folds the main
   conversation's kept rows (`session.append`, observed after `next(e)`, on the row as stored)
   into first prompt, last prompt, last assistant text, title (`session_title`), tool calls,
   user-row count, last activity and away summary, and sends a coalesced `session.row` snapshot on
   the existing events channel (≤ 500 ms after a change, ≤ 2 s worst, at once at a turn's end). A
   resume or a fork seeds the fold once from `$.session.messages()`.
2. **Identity carries the transcript path; lineage is the host's.** The hello gains optional
   `source`, `transcriptPath` and `title`; `session.rebound` gains `transcriptPath`. `forkedFrom` and
   `resumedFrom` are joined by Harnu main from the spawn record of the PTY that carried the spawn
   token, never taken from the mod.
3. **Bind by claim, re-key on proof.** A claimed synthetic row shows the pushed facts at once. It
   is re-keyed — through the existing `bindByClaim` migration — only when the transcript exists,
   proven by the watcher's `add` or by main's `stat` of the validated `transcriptPath`, whichever
   comes first. Folder and recency guesses stand aside for that row; they stay for every other.
4. **A new fact family, `row`, under T389's arbitration.** Default `shadow`; field groups
   (`prompt`, `title`, `tools`, `count`, `activity`, `recap`, `assistant`) each flip after their own
   parity gate, in their own PR, confirmed by the operator.
5. **Demote, never delete.** For a session whose refreshing groups are all owned, Harnu main skips
   the watcher's reads, the reader fold and the slug rescan on its appends, and skips the
   post-migration full reload for its row. On leaving ownership it runs one catch-up read. Every
   un-owned session — `off`, `shadow`, lease lost, CLI outside the gate, outside Harnu, cold — keeps
   today's path unchanged.
6. **Disclose it.** Settings → Mods gains a `transcript` chip ("can read the conversation") for any
   mod that hooks `session.append` or `session.compact` or calls `session.messages`.

## Alternatives considered

- **Fix only the reader** (find why the slug pass opens ~2,800 cold files per append, A-M2). Worth
  doing regardless, and possibly most of the CPU gain (spec Q5). It does not fix stale fields,
  `idle` in `get_fleet`, the binding guesses, or the latency of a 2 s cadence; T455 does.
- **Widen the hook bridge** (keep `session_title`, the prompt and `last_assistant_message` from
  legacy hook bodies the bridge drops today). No mod needed, turn granularity only; no tool count,
  row count, activity time, away summary, transcript path or load seed. Kept as an improvement to
  the un-owned path (spec Q4), not as the design.
- **A separate mod for the row.** Would duplicate the spawn token, rendezvous, lease, feature
  negotiation and parity ledger, and break MOD-4 (one `on()` per event) on the shared events.
- **Re-key the row at hello (idea 110 as written).** Rejected by lesson 004: the row would be
  dropped by the next reload and could be parked with nothing to resume.
- **Ask the engine for a fork parent or a title event.** Not needed for Harnu-spawned sessions;
  filed as an upstream question (spec Q7).

## Consequences

- Prompt and assistant text (240 characters each) cross the local socket. Contract §8's no-text
  default gains named exceptions; the parity ledger compares texts and never stores them (spec
  Q1).
- The `row` family adds a parity stream and a gate per group; the flip work is spread over several
  small PRs.
- A session started outside Harnu keeps today's path in v1 (spec Q3).
- The renderer gains one preview line (the last assistant text), which owes `design.md`, both
  locales and `docs/user/`; `get_fleet` / `get_session` semantics change for owned sessions, which
  owes `docs/harnu-features.md`.
