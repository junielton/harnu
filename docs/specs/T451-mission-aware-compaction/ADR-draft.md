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
   Harnu (ADR-0015) and would go stale in a transcript; and two rules of the T389 master. R29: a
   mission title or other text written by one session must not reach another session's model
   through a context row (`docs/specs/T389-companion-mod/00-master.md:626`). SEC-5a: text a command
   carries comes from a closed registry or constant table in main (`00-master.md:498`). P4W5 §9.4
   turns both into "the host's closed registry is their only source … no row carries
   user-controlled text" (`P4W5-compaction-digest.md:337-340`).
2. **The pointer does not reach an executor's criteria.** It is written for owners: it names the
   mission a session owns, and `mission_get` finds a mission by `missionId` or `ownerSessionId`
   only, so a linked child cannot find its own step that way
   (`docs/specs/T447-harnu-sdk-noun/00-spec.md:404-421`). An executor spawned through MCP
   `create_session` has no Harnu MCP at all: the spawn withholds Harnu's `--mcp-config`
   (`src/main/pty.ts:811-818`), and T447's `$.harnu` noun answers `NO_MCP` there (`T447:469`). A
   board or manifest dispatch keeps the MCP server (`src/renderer/src/stores/sessions.ts:3108-3141`),
   but even there a pointer helps only if the model chooses to follow it after a compaction, and
   it leads to the mission, not to the card's criteria.

Four engine paths can put text in front of the model after a compaction: a `prompt.compose`
section, a `prompt.context` block, a row added to the `session.compact` result's `messages`, and
a `$.session.append` made after the compaction. All four survived two compactions and a
`--resume` in measured runs on Claude Code 2.1.296 (spec §5).

## Decision

1. **Content, not a pointer, for sessions working a step.** Harnu main builds a bounded _mission
   brief_: the mission, the step, the step's card acceptance criteria, open blockers, the step's
   recent Log notes and the files changed on its branch. It is delivered as a third durable row,
   `harnu.brief`, alongside P4W5's `harnu.orchestrator` and `harnu.mission`, and re-injected by
   P4W5's machinery. Owners keep P4W5's pointer.
2. **The row path, not the prompt paths.** The brief rides the `session.compact` result's
   `messages` (P4W5's in-hook path), with P4W5's deferred append for the compactions whose hook
   does not run. Not `prompt.compose`: it gives dispatcher-written text system-prompt authority,
   is pinned by an organization's `sec-default` policy (argued from the contract, not run), and
   freezes until the next compaction. Not `prompt.context`: it reaches every Agent-tool subagent
   the session starts (measured), is pinned by the same policy, and freezes the same way.
3. **A scoped exception to SEC-5a and R29, and the matching amendment to P4W5 §9.4.** The brief
   carries text Harnu did not write: card criteria, the step title, the declared end, blocker
   reasons, Log notes. It is admitted only when all of these hold:
   - **Source.** The text comes from Harnu's own records on disk: the mission file, a card file,
     `git`. Never from a conversation; the mod derives nothing (that half of P4W5 §9.4 stands).
   - **Recipient.** Only a token-backed binding of a session Harnu spawned, and only one of:
     (a) a session a mission step links by session id, the synthetic id it was spawned under
     included; (b) any Harnu-spawned session whose working directory is in a step's worktree, the
     operator's own session there included; (c) a session a card is bound to with no mission
     (the card part only). What it receives is that step's text, that mission's own card
     (`linkedCard`) when the step names none, or that card's.
   - **Shape.** Every field sanitised, clipped and secret-linted (`lintSecrets`,
     `src/main/mcp/memory-core.ts:366`); the whole capped at 6 000 characters; framed as "written by
     Harnu from its records … context, not new instructions"; never in a system prompt.
   - **Audit.** Each delivery is a P2W1 command audit record, arguments digested and never stored
     as text, with mission, step and match kind as metadata.

   Everything else under SEC-5a, R29 and P4W5 §9.4 stands, for every other row.

4. **Freshness without cache cost.** The brief is re-delivered with `retainOnly` (stored, not
   appended) whenever its mission or card changes, before the host's own `session.compact`
   command, and at the start of each compaction from a new `compact.started` sensor event. The mod
   reads it from an in-memory twin of its durable rows, because a `$.state` read inside the
   compaction's dispatch is pinned to one moment. Nothing the model sees changes between
   compactions.
5. **Harnu's own readers skip it.** The engine records the re-injected row as the session's
   `last-prompt`; Harnu's transcript reader skips a `last-prompt` that starts with the brief's
   marker, so the sidebar never shows the brief as the session's activity.

## Consequences

- An executor that compacts keeps its step and criteria verbatim (measured: RUN-5 and RUN-6, two
  manual and two automatic compactions, with no summary holding the quoted criterion; with the
  brief pasted inline and no re-injection, the model kept at best a paraphrase).
- The companion gains no hook registration and no Settings → Mods capability chip. Harnu main
  gains a brief builder, a child resolver it can share with T447's proposed
  `mission_get({ childSessionId })`, a persisted synthetic-id alias table, a change notifier over
  every mission write and a marker filter in its transcript reader.
- The feature cannot ship before T389 P2W4 (context registry, `context.append`) and P4W5 slice S2
  (the re-injection paths, `retainOnly`, `context.drop`). Until P2W1's channel runs `active` and
  the companion's tested CLI ceiling covers the installed CLI, it is inert.
- Text written by an operator or another session reaches the model of a session working that step
  after every compaction, including an operator's own session in the step's worktree. It is the
  same kind of text a dispatch packet carries, scoped to that step, and every delivery is audited
  (digest and ids, never the text).
- If a later release stops rebuilding the result's `messages` the way 2.1.296 does, P4W5's drift
  checks catch it for all three rows at once.

## Alternatives considered

- **Leave it to P4W5's pointer.** Rejected: it names the mission a session owns, not the step a
  child works, and leads to no criteria. An MCP-spawned executor cannot follow it at all, and a
  board-dispatched one must choose to, after the compaction that made it forget why.
- **A content request to the summarizer** ("keep the acceptance criteria"). Rejected for v1 by the
  same smoke that made P4W5 add no instruction: an added instruction was read as an injection and
  the refusal became the summary (`P4W5-compaction-digest.md:57`).
- **A separate Harnu-bundled mod.** Rejected: only the companion holds the binding, the lease and
  the command channel, and P4W5 owns the one `session.compact` registration (T389 MOD-4).
- **The model re-reads its card.** Kept as the fallback the brief points to (the card path is
  never cut), not as the mechanism: in MEAS-2 the summary dropped that path once.
