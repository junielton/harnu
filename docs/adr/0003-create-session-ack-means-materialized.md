# ADR-0003 — `create_session`'s `ok:true` means the session materialized

**Status:** Accepted
**Date:** 2026-07-19
**Author:** Claude (drafting), on the standing product rules
**Deciders:** the shipped self-awareness contract (`docs/capy-features.md:47`)
**Technical context:** Capy's MCP agent API (`src/main/mcp/`), grant budget accounting

> Related: [`docs/prds/create-session-honest-ack.md`](../prds/create-session-honest-ack.md),
> [`docs/specs/2026-07-19-create-session-materialization.md`](../specs/2026-07-19-create-session-materialization.md)

---

## 1. Context

`create_session` ACKs on the renderer's `session.create` dispatch return — a
`syntheticId`, a receipt for **intent** (`src/main/mcp/tool-handlers.ts:544-580`,
`ok: dispatchSucceeded(result)`). Five field occurrences show sessions that never
materialized, materialized ~14 minutes late in a simultaneous batch of four
processes sharing one working tree, or booted as a live process that Capy never
wired into its own session model.

The ACK is shaped exactly like a receipt for **outcome**, so every caller reads it
as one. An orchestrator that believes it marks the card in-progress, moves to the
next unit, and stacks work on output that will never arrive — the board lies
upward, at the very first instant.

The question this ADR settles: **what should `ok: true` mean?**

It is tempting to treat this as an open product question. It is not. Capy already
prepends `docs/capy-features.md` to every session's system prompt, and line 47 of
that doc states:

> `ok:true` means the session was actually created

That is a shipped promise, made to every agent Capy has ever booted. The code does
not honor it. So the decision space is narrower than it looks: we either make the
code true, or we retract a contract that agents have already been reasoning against.

## 2. Decision

**Option A — `ok: true` means materialized.** `create_session` awaits the synth→real
migration (PTY spawned, project dir created under `~/.claude/projects/<slug>/`)
before ACKing, bounded by a deadline. On timeout or failure it returns `ok: false`
with a steerable error **and refunds the reserved grant budget unit**.

Three constraints ride along, because Option A is unsafe without them:

1. **Single occupancy per folder.** A second `create_session` into a folder with an
   un-materialized spawn in flight is refused. Without this, a bounded timeout still
   permits the observed shape — caller gives up, retries, and both spawns land.
2. **Late spawns cannot attach.** A spawn that resolves after its call already
   returned `ok:false` is cancelled, or refuses a folder that has since acquired a
   session.
3. **In-flight is observable.** `get_session(syntheticId)` reports `spawning` rather
   than `SESSION_NOT_FOUND`, so a caller can distinguish "never happened" from
   "still coming" without a filesystem poll.

The grant refund is not optional bookkeeping: a phantom session that burns an
operator's approval unit is a second, independent breach of trust on top of the
false ACK.

## 3. Alternatives considered

### Option B — make the ACK honest about being async

Return `{ ok: true, status: "spawning", syntheticId }` and require the caller to
confirm via `get_session`. Rejected, on three grounds:

- **It contradicts the shipped contract.** `docs/capy-features.md:47` promises the
  opposite. Choosing B means editing that promise out and re-teaching every agent —
  a migration whose cost lands on users, to avoid work that lands on us.
- **It pushes a polling loop onto every orchestrator, forever.** Option A makes
  every existing caller correct for free; Option B makes every existing caller wrong
  until individually rewritten.
- **It does not fix the dangerous shape.** The 2026-07-18 incident was a _collision_,
  not a _misread_. `status:"spawning"` still permits five concurrent spawns in one
  working tree — only the single-occupancy guarantee prevents that, and that
  guarantee is orthogonal to which option we pick. B pays the migration cost and
  still needs A's hardest piece.

Option B is honest, and under a different history it would be defensible — it is the
cheaper implementation and it never blocks a caller. It loses here specifically
because we already promised A.

### Option C — leave it, document the workaround

Rejected. The workaround ("never trust the ACK; poll `~/.claude/projects/` before
proceeding") has been the standing advice since the 2026-07-10 post-mortem, and the
bug has recurred five times under it. Worse, the card's own documented mitigation —
retry into the same worktree — is what produced the five-process collision. A
workaround that causes the incident it is meant to prevent is not a mitigation.

## 4. Consequences

**Positive**

- The agent API tells the truth; `docs/capy-features.md` becomes accurate rather
  than aspirational.
- Every existing caller becomes correct with no changes.
- Concurrent collision in one working tree becomes structurally impossible, not
  merely unlikely.
- Grant budget reflects actions that happened.

**Negative / accepted costs**

- `create_session` becomes a **slow verb** — it blocks for up to the materialization
  deadline. Agents dispatching a fan-out will feel it. Accepted: a slow truthful
  verb beats a fast lying one, and the deadline bounds the worst case.
- The deadline is a tuning parameter with no obviously right value. The field
  observed a ~14-minute materialization; a deadline that generous makes the verb
  unusable, and one that tight will occasionally report failure for a spawn that
  later succeeds. Constraint 2 (late spawns cannot attach) is what makes the tight
  choice safe, so the deadline is set for caller ergonomics, not for worst-case
  coverage. Start at 60 s; revisit with field data.
- Requires a renderer→main materialization signal that does not exist today —
  new surface in `command-bridge` and `stores/sessions.ts`.
- BUG-33 (`TOOL_TIMEOUT` late completion) becomes strictly harder to ignore, since
  `create_session` now has a long tail that can trip the 120 s tool deadline. That
  card stacks directly on this one.

**Neutral**

- Does not change the permission/grant model, only the accounting of failures.
