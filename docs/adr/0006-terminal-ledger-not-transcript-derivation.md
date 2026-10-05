# ADR-0006 — Terminal fleet states come from a persisted ledger, not from transcript derivation

**Status:** Accepted
**Date:** 2026-07-19
**Author:** agent
**Deciders:** junielton
**Technical context:** Fleet classifier / restart durability (BUG-54, sibling of BUG-53)
**Spec:** [`docs/specs/2026-07-19-terminal-ledger.md`](../specs/2026-07-19-terminal-ledger.md)

---

## 1. Context

The `errored` and `done` fleet states exist only in process memory. `hook-bridge.ts`
folds them and emits `failureReason` / `resetsAt` on the `claude:hook` wire
(`src/main/hook-bridge.ts:464-465`) but persists nothing — its only `writeFile` is
`prefsPath()` (`:298`, `:326`) — and `pruneTaskState` (`:260`) drops a session's
folded state on every PTY teardown. `before-quit` (`src/main/index.ts:768`,
`killAllPtys()` at `:773`) records nothing either.

So a restart loses the entire terminal axis. The approved fleet-rail spec
(`docs/specs/2026-07-17-fleet-rail/`) promises _"Done/return-here stays visible so
finished work can be collected"_, and that promise is broken on every relaunch.

Making it durable requires choosing a **source of truth after the process dies**.
Two candidates were available, and only one survives contact with the data measured
during the 2026-07-18 investigation.

## 2. Decision

**Terminal states are restored from a persisted ledger of the _events_ that produced
them — never re-derived from transcript tails on disk.**

The ledger records `sessionId → { state: 'failed' | 'completed', failureReason?,
resetsAt?, at }`, written on the same edges that set those states today, restored on
boot, and re-broadcast on the existing `claude:hook` channel. Design details are in
the spec; this ADR records only the source-of-truth choice.

## 3. Alternatives considered

### A. Derive `done` / `errored` from the transcript tail after restart — **rejected**

`deriveTurnState` (`src/main/transcript-truth.ts:145`) answers _"how did this
transcript's last turn END?"_. Deriving terminal states from it fails in both
directions:

- **Clean tails over-produce.** A clean `end_turn` tail cannot distinguish "finished
  a task worth collecting" from "any idle chat that happened to end". The operator's
  disk holds 4637 idle transcripts in a 72h window alone — promoting every clean tail
  to `done` replaces an empty rail with a flooded one, which is the same failure the
  sibling card (BUG-53) exists to fix, only wearing a different label.
- **Dirty tails under-produce, then actively mislead.** A session that failed or was
  killed mid-tool leaves a `working` tail. With the terminal edge forgotten, it
  re-enters the activity cascade and lands in the phantom-`stuck` flood — 229 such
  cards measured on the operator's disk. This is the operator's literal complaint
  ("it takes the tasks I have as finished and gives them as stuck afterwards"), so
  the derivation approach does not merely fail to fix the bug, it _is_ the bug.

The transcript is an honest record of the past tense. The classifier needs a
present-tense fact ("this session ended in failure, and nobody has touched it
since"), which the transcript structurally cannot supply.

### B. Keep it in memory and accept the loss — **rejected**

This is today's behavior. It silently empties the operator's "act on this" queue on
every relaunch and drops rate-limit `resetsAt` countdowns that are still ticking. The
cost of the loss is highest exactly when it hurts most: a usage-limit failure at
09:00 is the thing you most need to see at 09:05.

### C. Persist the whole hook FSM — **rejected as over-scoped**

Durably storing every folded `taskState` (including `working` / `needs-input`) would
resurrect live-state claims about dead processes — precisely what BUG-53 is removing.
Only _terminal_ edges are durable facts; everything else must re-derive from present
evidence.

## 4. Consequences

**Positive**

- `errored` / `done` survive a restart with correct badges and absolute `resetsAt`
  countdowns (absolute epochs survive by construction).
- The finished-with-dirty-tail subset stops resurrecting as phantom `stuck`.
- The ledger is also the only component present at `before-quit`, so it is the natural
  (and only) place to record the interrupted-by-shutdown set that T167 needs — a
  fact a transcript tail provably cannot carry, since it cannot distinguish an
  interruption from the last shutdown from one 71 hours ago.

**Negative / accepted costs**

- A new persisted file in `userData` — bounded by an explicit retention rule (72h /
  200 entries) so it cannot grow across months.
- A staleness hazard: a stale entry could pin a resumed session to `failed`. Mitigated
  by the supersede rule (any new sign of life, or a newer clean end-of-turn, drops the
  entry) and guarded by a test that must be written before the implementation.
- The `before-quit` write is best-effort; a hard crash records nothing. Accepted: the
  fallback is BUG-53's `idle`, which is safe and flood-free.

## 5. Relationship to BUG-53

BUG-53 (liveness axis) and this decision are the two halves of one category error:
_disk signals were treated as the present, memory signals as durable_. BUG-53 stops
disk signals from claiming the present; this ADR makes the memory signals that
genuinely are durable actually durable. BUG-53 lands first and independently — it is
what kills the 229 phantoms — and this work must not modify the `isLive` guards it
introduces.
