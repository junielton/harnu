# ADR-draft — A dispatched session gets its mission brief back after a compaction, as a durable row Harnu builds from its records

**Status:** proposed (draft; takes an ADR number when merged) · **Date:** 2026-10-09 · **Card:**
T451 · **Spec:** [`00-spec.md`](00-spec.md)

## Context

An executor Harnu dispatches for a mission step starts with a packet: what to build, its
acceptance criteria, where the card is. When the conversation compacts, the engine's summary
replaces that packet. Measured on this machine (spec §3, [`01-evidence.md`](01-evidence.md)
MEAS-2): when the criteria live in a card the executor read with a tool, the summary kept 2 of 7,
2 of 10 and 2 of 10 of their ids, and in one of the three it lost the card's path as well.

Two earlier decisions shape what can be done about it:

1. **T389 P4W5** (specified, not shipped) already re-injects Harnu's _durable rows_ after a
   compaction, through the `session.compact` result's `messages`, and its mission row is a
   **pointer** on purpose: "You own the Harnu mission <id> … read it with mission_get"
   (`docs/specs/T389-companion-mod/P4W5-compaction-digest.md:201`). Its reasons: state lives in
   Harnu (ADR-0015) and would go stale in a transcript; and rule **R29 / SEC-5a**, no text written
   by one session may reach another session's model through a context row
   (`docs/specs/T389-companion-mod/00-master.md:498`, `:626`).
2. **A dispatched executor has no Harnu MCP.** An agent-controlled spawn withholds Harnu's
   `--mcp-config` (`src/main/pty.ts:811-818`), so the pointer's "read it with `mission_get`" cannot
   be followed by the sessions that need the brief most, and T447's `$.harnu` noun answers
   `NO_MCP` there (`docs/specs/T447-harnu-sdk-noun/00-spec.md:469`).

Four engine paths can put text in front of the model after a compaction: a `prompt.compose`
section, a `prompt.context` block, a row added to the `session.compact` result's `messages`, and
a `$.session.append` made after the compaction. All four survived two compactions and a
`--resume` in measured runs on Claude Code 2.1.296 (spec §5).

## Decision

1. **Content, not a pointer, for linked children.** Harnu main builds a bounded _mission brief_
   for a session that is linked to a mission step as a child (by the binding's session-id chain,
   or by the step's worktree link): the mission, the step, the step's card acceptance criteria,
   open blockers, the step's recent Log notes and the files changed on its branch. It is
   delivered as a third durable row, `harnu.brief`, alongside P4W5's `harnu.orchestrator` and
   `harnu.mission`, and re-injected by P4W5's machinery. Owners keep P4W5's pointer.
2. **The row path, not the prompt paths.** The brief rides the `session.compact` result's
   `messages` (P4W5's in-hook path), with P4W5's deferred append for the compactions whose hook
   does not run. Not `prompt.compose`: it gives dispatcher-written text system-prompt authority,
   is pinned by an organization's `sec-default` policy, and freezes until the next compaction.
   Not `prompt.context`: it reaches every Agent-tool subagent the session starts (measured), is
   pinned by the same policy, and freezes the same way.
3. **A scoped exception to SEC-5a.** The brief carries text Harnu did not write: card criteria,
   the step title, the declared end, blocker reasons, Log notes. It is admitted only when all of
   these hold: the text comes from Harnu's own records on disk (mission file, card file, `git`),
   never from a conversation; the recipient is the session the mission links to that step; the
   text is sanitised, clipped per field, secret-linted (`lintSecrets`,
   `src/main/mcp/memory-core.ts:366`) and capped at 6 000 characters; it is framed as "written by
   Harnu from its records … context, not new instructions"; and it never enters a system prompt.
   Everything else under SEC-5a and R29 stands.
4. **Freshness without cache cost.** The brief is re-delivered with `retainOnly` (stored, not
   appended) whenever its mission or card changes, and refreshed at the start of each compaction
   from a new `compact.started` sensor event. Nothing the model sees changes between compactions.

## Consequences

- An executor that compacts keeps its step and criteria verbatim (measured: RUN-5 and RUN-6, two
  manual and two automatic compactions; a control without the brief answered UNKNOWN).
- The companion gains no hook registration and no Settings → Mods capability chip; Harnu main gains
  a brief builder, a child resolver it can share with T447's proposed `mission_get({
childSessionId })`, and a change notifier over every mission write.
- The feature cannot ship before T389 P2W4 (context registry, `context.append`) and P4W5 slice S2
  (the re-injection paths, `retainOnly`, `context.drop`). Until P2W1's channel runs `active` and
  the companion's tested CLI ceiling covers the installed CLI, it is inert.
- Text written by an operator or another session reaches the executor's model after every
  compaction. It is the same kind of text the dispatch packet already carried, scoped to the
  session that packet was written for; it is still a new path and is audited per delivery (size
  and hash, never the text).
- If a later release stops rebuilding the result's `messages` the way 2.1.296 does, P4W5's drift
  checks catch it for all three rows at once.

## Alternatives considered

- **Leave it to P4W5's pointer.** Rejected: an executor cannot call `mission_get`.
- **A content request to the summarizer** ("keep the acceptance criteria"). Rejected for v1 by the
  same smoke that made P4W5 add no instruction: an added instruction was read as an injection and
  the refusal became the summary (`P4W5-compaction-digest.md:57`).
- **A separate Harnu-bundled mod.** Rejected: only the companion holds the binding, the lease and
  the command channel, and P4W5 owns the one `session.compact` registration (T389 MOD-4).
- **The model re-reads its card.** Kept as the fallback the brief points to (the card path is
  never cut), not as the mechanism: in MEAS-2 the summary dropped that path once.
