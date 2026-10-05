# ADR-0015 — The goal file becomes structured Capy data; `agentControlled` children still report by native SendMessage

**Status:** accepted · **Date:** 2026-09-26 · **Card:** T358

## Context

Returning to an orchestrator session, an operator has to ask it "where are we" — the vocabulary
for an answer already exists (the `mission`/`status` skills produce a "Step N of M"-shaped card
from `.capy/goals/<session8>-<slug>.md`) but only as prose a skill regenerates on demand from
free markdown. No app code reads that file today (PRD [`T358`](../prds/T358-mission-progress.md)).
55 goal files measured across 7 repos on 2026-09-26 show why: only ~31 of 55 follow even an
informal standard section set, because there is no schema — every session free-hands its own
shape.

We considered whether progress tracking needed a **new** MCP verb granted to dispatched child
sessions, since a child is the one doing the work a step tracks.

## Decision

1. Promote the goal file into a Capy-owned data type, **Mission** (`mission-core.ts`, mirroring
   `roadmap-core.ts`'s frontmatter-file pattern), read and written exclusively through new
   `mission_*` MCP verbs. One source of truth; the legacy markdown is read exactly once, by an
   import verb, and never parsed by app code again.
2. **For a child spawned via `create_session` (`agentControlled`), reporting stays on Claude
   Code's own native `SendMessage`, not a new Capy verb.** That spawn path withholds Capy's MCP
   server entirely (`src/main/pty.ts`, the `agentControlled` branch — withholds the app-managed
   `--mcp-config` specifically "to prevent a recursive Conductor"; a T245 read-only review
   companion is withheld the same way, for a different reason). The **owner** session — which
   does have Capy MCP access — is the only one that ever calls `mission_*` to persist what such a
   child reported. This was already the working pattern before this ADR (T360 smoke test, Q1: a
   probe session spawned this way, with zero `mcp__capy__*` tools, delivered a SendMessage to its
   orchestrator successfully); this decision keeps it for that spawn shape rather than inventing a
   parallel reporting channel. **This does not describe every dispatched child** — a
   manifest/board-dispatched session (`spawnedBy: 'agent'`, distinct from `agentControlled`) keeps
   full Capy MCP access, including every `mission_*` verb, the same as its owner. Whether such a
   child should call `mission_*` directly instead of relying on SendMessage is left open (design.md
   §13, Open question E) — this ADR only fixes the `agentControlled` case, which is the shape
   decision 11 was written against.
3. The new verb family is named `mission_*` despite `plan_mission` (an unrelated, already-shipped
   capability-grant verb) already existing in the same catalog. See "Alternatives rejected".
4. **Enforcement of "never the step's author" is convention + audit, not a security boundary**
   (operator decision, 2026-09-26, resolving design.md §13 as Resolved A). `mission_verify_step`
   takes a self-declared `sessionId` argument and never refuses; it records what was declared and
   labels the outcome `verified` only when the step has at least one linked `session` and the
   declared verifier id differs from all of them, otherwise `self-verified` — a state the UI never
   renders as "proven". This is possible only because Capy's MCP transport already has no
   per-session identity to check against (one shared config/token for every session); see
   "Alternatives rejected" for the alternative that would have made a real check possible.

### Amendment 2026-09-29 — the fixed end's author set (Mission v2, T373)

Decision 4 labels a `verifier`-level step `verified` only when it has at least one linked
`session` and the declared verifier is none of them. Applied literally to the fixed end
("Delivered and verified"), that rule made a normal orchestration impossible to close: nobody links
a session to the end, and the only session that calls the `mission_*` verbs is the owner (decision 2:
the `agentControlled` children it dispatches hold none) — so the owner was always the only possible
verifier, with no link to differ from, and every end came
out `self-verified`. A live delivery (10 steps, 8 PRs) ended exactly there: everything built and
verified, and `mission_request_close` refused for good.

**For the fixed end only, the author set is the end's own `session` links plus every custom step's
`session` links** (`verificationLabel`, `tool-handlers.ts`). The end is built by the whole mission,
so the sessions that built any step are its authors. The owner built none of them, so its
`mission_verify_step` on the end lands `verified`, as it does for a custom step. With no `session`
link on the end or on any custom step there is still no author, the end stays `self-verified` and
the close stays refused. Decision 4's rest is untouched: the end still uses the verifier (decision
8), only a `met` verdict proves, the id is still self-declared and never refused, and the operator
still closes. The alternatives we did not take were weakening the proof rule so that `self-verified`
could close (it would make "verified" mean nothing) and requiring an independent verifier session
that holds the verbs (a second session per delivery, for no added check the convention-plus-audit
model can enforce). This does not add a security boundary: a lazy `verified` is possible on the
end exactly as on any custom step, and the operator's Close is the backstop.

### Amendment 2026-10-01 — the approval model and the checks trust model (Mission v3, T381)

Two things in this ADR's neighborhood changed in Mission v3 (`docs/specs/2026-10-01-mission-v3/spec.md`
§3.4, §3.5, §3.6). Decisions 1–4 above stand.

**The approval model.** Decision 14 of the T358 design gave the operator two doors, an approval at
the start and a close at the end. The start door gated nothing — work ran before and regardless of
it — yet it blocked the close of finished work and nagged forever about dead missions. Now:

- **No start approval.** A mission is born `active`, and the end the owner agreed in chat before
  dispatch is the agreement. It is stamped `declaredEndApproval.via: 'chat'`; a re-scope the operator
  approves is stamped `'operator'`. A legacy `draft` file reads as `active`.
- **The re-scope approval is kept.** `mission_set_end` still only stages `pendingRescope`; only the
  operator's door applies it, and applying it voids the end's proof. Changing what "done" means after
  it was agreed is the one decision that still needs the operator mid-flight.
- **The operator ends the mission** from one door: close as delivered, or discard, on any open
  mission, with the open matters shown as warnings and never as refusals. The agent can still only
  request a close (`mission_request_close`). It cannot close or discard, and afterwards every agent
  verb refuses with `MISSION_CLOSED`.

The human gate that remains is "the operator decides how it ends", which is the one that carries
meaning. The gate that went was a ceremony.

**The checks trust model.** A check (`Step.checks`) records a human confirmation of a deliverable,
such as a DSQA pass or a designer's sign-off. Like decision 4, it is **convention plus audit, not a
security boundary**:

- The agent (`mission_add_check`) and a verifier (`mission_verify_step` with `needs-human`) can only
  **add** a check. Only the operator's doors tick, untick or delete one, and no `mission_*` verb takes
  or writes `ticked`.
- An agent with filesystem access could edit the mission file's YAML and tick a check, exactly as it
  could edit a proof label. The mission's Log records every operator door, which is the audit.
- A check never changes a step's state or the headline, so a forged tick moves nothing the pill says.
  It can only clear an owed item and a close warning, and the operator's end door is the backstop.
- This is also why a verifier's `needs-human` verdict does not set a step back to `unproven`: the
  machine part is met, and the human part becomes a check that only the operator can clear.

**Storage.** Every mission schema is now `.passthrough()`. A field a newer Capy adds survives a read
and write by an older one instead of being stripped, so the format can grow without the data loss
that Mission v3 itself had to guard against (builds up to 0.3.43 strip the new fields).

The "generic progress blob with no fixed frame" alternative below was rejected for a frame of two
fixed steps; the frame is now one, the end. The reason it was rejected still holds: every mission
declares what done means, and the UI never has to guess.

## Alternatives rejected

- **Grant `mission_*` verbs to every dispatched child, as a blanket change.** Rejected: for an
  `agentControlled` child specifically, it would require punching a hole in the withholding built
  specifically to stop a dispatched session from spawning its own recursive Conductor — the exact
  hazard that branch exists to prevent. This alternative is moot for a manifest-dispatched child,
  which already has this access today without any grant; nothing needs to be "punched open" for
  that spawn shape. The existing SendMessage path for `agentControlled` children already works
  (T360 smoke test) and needs no new grant.
- **Rename `plan_mission` to resolve the naming collision.** Rejected: `plan_mission` is shipped,
  audited, and referenced throughout `docs/capy-features.md` and every session's boot preamble.
  Renaming it churns every reference for zero functional gain. We instead document the
  distinction the first time `mission_*` appears in `docs/capy-features.md` (design.md §2).
- **A generic "progress" JSON blob with no fixed frame.** Rejected: decision record (project
  memory, "2026-09-26 — Mission progress", #4) explicitly fixes the first and last step
  ("scope confirmed" / "delivered and verified") so every mission is comparable and the UI never
  has to guess what "done" means; a free-form blob would push that back onto every skill author.
- **Per-session MCP identity — issue a distinct token per spawned session so `mission_verify_step`
  could authenticate the caller instead of trusting a self-declared id.** Rejected for v1
  (operator decision, 2026-09-26): it is a change to Capy's whole MCP transport
  (`src/main/mcp/server.ts` currently uses one shared config/token for every session, by design,
  and every other verb's gate posture assumes that), not a Mission-scoped change — far larger
  than this feature's blast radius, for a guarantee ("never the step's author") that
  convention-plus-audit already covers well enough for v1. Revisit if self- or cross-verification
  abuse actually shows up in practice, not preemptively.

## Consequences

- Every future reader of mission state (the Topbar pill, the popover, `capy:status`, the
  Scheduler watchdog) reads `mission-core.ts` through `mission_*`/`mission_get` — never
  re-parses markdown, never re-derives a stall heuristic by hand. This retires four separate
  hand-rolled versions of the same logic across `mission`, `status`, `orchestrate-delivery` and
  `delivery-watchdog` (design.md §11).
- **Cost paid today:** a full verb family (11 verbs, design.md §4) plus a new eval-harness layer
  that has no precedent anywhere in this repo (design.md §12) — this is the most novel and
  highest-cost part of the delivery, not a small addition.
- **Migration is lossy by construction** for the ~44% of the existing goal-file corpus that
  doesn't follow the standard sections. Mitigated, not eliminated, by always preserving the raw
  markdown verbatim alongside whatever structure is recognized (design.md §9).
- The naming collision with `plan_mission` is now a permanent, documented wrinkle in the agent
  vocabulary rather than a renamed one — a new contributor reading `tool-catalog.ts` cold will
  see both and needs the disambiguation line to not conflate them.
- **Re-open this decision** if operators report real confusion between "Mission" (this feature)
  and "mission grant" (`plan_mission`) in practice, or if a future feature needs an
  `agentControlled` child to have genuine write access to its own step — at that point the
  withholding itself, not just this ADR, would need to change. (A manifest-dispatched child
  already has this access today; Open question E in design.md is whether to actually use it, not
  whether it's technically possible.)
