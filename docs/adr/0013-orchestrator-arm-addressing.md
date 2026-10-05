# ADR-0013 — `orchestrator_arm` addresses an explicit session id, restricted to a session Capy spawned for an agent

**Status:** Accepted
**Date:** 2026-09-08
**Author:** agent (T309)
**Technical context:** `docs/specs/2026-09-08-agent-substrate-verbs.md` § Unit 2, `src/main/orchestrator-guard.ts`, `src/main/mcp/tool-handlers.ts` (`message_session`), `src/main/messaging-socket.ts`

---

## 1. Context

Capy's MCP server is a single shared process reached over a loopback transport
that carries **no per-session identity** — `tool-handlers.ts` and
`messaging-socket.ts` both state this as an established fact, and it is why
`message_session` (T215) cannot refuse a session messaging itself. A tool call
arrives with whatever arguments the agent supplied; nothing in the transport
says which live `claude` process made the call.

`orchestrator_arm` needs to flip a live per-session flag — `armed.json`'s entry
for a `sessionId`, read by the `PreToolUse` guard hook on every `Edit`/`Write`/
`NotebookEdit` in that session (`orchestrator-guard.ts`). A naive
`orchestrator_arm()` with no target has nothing to act on; a naive
`orchestrator_arm({ sessionId })` with no further restriction can arm **any**
session by id, including one the operator opened by hand — mild in isolation
(same machine, same user, and the guard fails open by design), but a
genuinely surprising blast radius for a verb that changes what tools another
running session is allowed to use.

The spec named three shapes for the target argument:

- **(a) Explicit `sessionId`, unrestricted.** Any caller can arm/disarm any
  session Capy knows about.
- **(b) Explicit `sessionId`, restricted** to a session Capy spawned for an
  agent (or to the caller's own folder).
- **(c) Stamp the caller's own identity at spawn** (mirroring
  `spawnOriginForSession`, which already stamps _who caused a spawn_ for
  `message_session`) and derive "self" from that stamp — the only shape that
  would let a session omit `sessionId` entirely and mean "arm me."

## 2. Decision

**Option (b).** `orchestrator_arm` and its counterpart `orchestrator_disarm`
take one argument, `sessionId` — no separate `folder` field. The gate anchor
is resolved server-side from the **target** session, the exact mechanism
`message_session` already uses for its recipient (`resolveSessionGateFolder`
in `server.ts`): scan the known folders first, then both in-flight
registries, so a live born-synthetic target is reachable and a blocked
folder is refused with `FOLDER_NOT_ALLOWED` before the handler ever runs.

The handler additionally requires, in order:

1. The `sessionId` resolves to a session Capy knows about at all (on disk or
   in-flight) — else `SESSION_NOT_FOUND`.
2. `sessionOwnedByCapy(sessionId)` — Capy currently holds (or parked) the
   process behind that id — else `TARGET_NOT_CAPY_SPAWNED`.
3. `isMessageableOwner(spawnOriginForSession(sessionId))` — the process was
   spawned **for an agent**, not opened by the operator — else
   `TARGET_OPERATOR_OWNED`.

Checks 2 and 3 are the exact predicates `message_session` already applies to
its recipient, imported unchanged from `pty.ts` / `messaging-socket.ts`. This
is not a new trust boundary invented for this verb; it is the one boundary
this codebase has already drawn — and had the operator sign off on — for
"which sessions may an agent verb reach into," applied a second time.

A session that wants to arm **itself** must know its own id and pass it
explicitly — the same convention `speak`/`notify` already use for their
optional self-`sessionId` (a session's dispatch prompt or a `get_fleet` call
tells it its own id; the verb never infers "self" from the connection).

## 3. Alternatives considered

**(a) Explicit `sessionId`, unrestricted.** Rejected as the spec itself
flags: the addressing would let any session arm or disarm the guard on _any_
other session Capy tracks, including the operator's own hand-opened one. The
consequence is mild (fails open, same machine, same user) but the blast
radius is unrestricted for no reason — restricting it to option (b) costs
nothing extra, since `message_session`'s ownership check already exists and
is a straight import.

**(c) Stamp the caller's identity at spawn.** Rejected for this card, not on
principle. It is the only shape that supports true self-arming with no
`sessionId` argument, but it is also, in the spec's own words, "the largest
change": it would require identifying _which live process_ issued _this_
MCP call — something no other verb in this codebase does today, including
`message_session`, which solves an equivalent problem (who is the
appropriate recipient?) by scoping the **target**, never by identifying the
**caller**. `speak`/`notify` solve the same shape of problem the same way:
an optional, self-reported `sessionId`, not caller identification. Adopting
(c) here would mean this verb is the first in the catalog to need caller
identity, solving a problem the rest of the surface has consistently solved
without it — a larger, precedent-setting change that the spec asks to avoid
unless nothing sound exists at the smaller scope. Something sound does
exist: (b).

**(b) restricted to "the same folder" (the other half of the spec's option
b), instead of / in addition to ownership.** Considered and dropped. Every
verb's `folder` argument (including a hypothetical one here) is a
caller-supplied string, checked only against the _target's_ resolved folder
for the deny list — it is not independently verified against where the
caller process actually runs (the transport cannot do that, per the whole
premise of this ADR). Requiring "same folder" would add a check that is only
as strong as the caller's own honesty, i.e. no stronger than passing
`sessionId` alone. The ownership check (Capy-spawned, agent-owned) is real:
it is server-observed state (`PtySessionIndex`, the spawn-origin marker on
the live PTY record), not caller-supplied, and it is the check that actually
narrows the blast radius. Folder scoping was dropped as redundant weight,
not as unsound.

## 4. Consequences

**Good**

- Narrows (a)'s blast radius to exactly the sessions this verb has any
  business touching: ones Capy itself spawned for an agent. The operator's
  own hand-opened session — armed/disarmed today only through the trusted,
  same-process `orchestratorGuard:arm`/`disarm` IPC channel a renderer
  gesture drives — stays out of an agent verb's reach entirely.
- Reuses code and a trust boundary that already shipped and was already
  reviewed (`message_session`, 2026-08-23), rather than inventing a new one:
  `sessionOwnedByCapy`, `spawnOriginForSession`, `isMessageableOwner`,
  `resolveSessionGateFolder` are imported, not reimplemented.
- Keeps the door open for (c) later without backward-incompatibility: adding
  true self-targeting (an omitted `sessionId` meaning "me") would be an
  additive change to this same verb, not a redesign.

**Bad / accepted**

- A session cannot arm itself with a bare no-argument call — it must already
  know its own `sessionId`. This is the same limitation `speak`/`notify`
  already accept and is not a regression against anything that exists today.
- The restriction to Capy-spawned agent sessions means an orchestrating
  session cannot use this verb to arm a session the operator opened by hand,
  even if that is genuinely what an operator wants in some future workflow.
  That gap is deliberate: the existing renderer-driven promote/demote gesture
  remains the only path for that case, and widening it is a decision for a
  future card, not a side effect of this one.
