---
name: mission
description: Run one coordination tick over dispatched work: read the Mission with mission_get, act on what is unblocked, record it with the mission_* verbs, report one line. Use "mission set <objective>" to declare or re-scope your mission (a structured Harnu Mission), a bare invocation to run a single tick, and "mission done" to ask the operator to close it. Trigger when an orchestration session needs a recurring heartbeat over workers, worktrees and approvals — "run a tick", "how is the mission going", "keep an eye on what we dispatched", "coordinate this" — typically driven on an interval by a loop. Do NOT use to implement work, to review code, or to grade acceptance criteria (that is delivery-verifier).
---

# Mission — the orchestration heartbeat

**Mandatory header.** The one-line `tick —` report expands into the `status`
skill's six-line glance card whenever anything in `Needs you` or `Open` changed
since the previous tick, and `mission done`'s closing summary always opens with
the card. Build it from `mission_get` (plus `gh` for what the mission does not
link) — see that skill for the card's exact shape and rules; this skill does not
restate them.

One mission at a time, **per owner session**, written down. The point: an
orchestrator juggling executors, gates and evidence loses the thread between
interruptions — the Mission is the thread. Any session (this one after
compaction, or a future orchestrator) can read it with one `mission_get` and
resume coordinating in seconds.

## The state is a Mission, not a file

Your mission is a structured Harnu record, stored in the repo's main checkout
under `.harnu/missions/` and reached ONLY through the `mission_*` verbs:

| You want to…                                  | Call                                                   |
| --------------------------------------------- | ------------------------------------------------------ |
| declare the mission and its plan              | `mission_create { steps }`                             |
| read it, with everything Harnu derives live   | `mission_get`                                          |
| see every mission in the repo                 | `mission_list`                                         |
| add a unit of work found mid-mission          | `mission_add_step`                                     |
| tie a step to a child session, worktree, card | `mission_link_child`                                   |
| owe a human sign-off on a step's deliverable  | `mission_add_check`                                    |
| say "I believe this step is done"             | `mission_update_step` with `set: { proof: 'claimed' }` |
| record a verification                         | `mission_verify_step` (never on work you authored)     |
| flag / clear a blocker                        | `mission_set_blocker` / `mission_clear_blocker`        |
| change what "done" means                      | `mission_set_end` (staged; the operator approves)      |
| write the tick's Log line, a child's report   | `mission_log`                                          |
| ask the operator to close                     | `mission_request_close`                                |
| adopt a legacy `.harnu/goals/*.md` file       | `mission_import_legacy`                                |

Never read or edit a `.harnu/missions/*.md` file by hand, and never keep state
the verbs do not hold in your head or in prose — the verbs are the only writers,
and the operator's Topbar pill reads the same record.

**Harnu derives; you do not.** `mission_get`'s `derived` block, its `youItems`
list and its `you` line are computed fresh on every read: the progress, each
linked child's live state, each linked worktree/card/PR resolved, `existence`
proofs, and the deterministic stall flag (`derived.stale`). Read them.
Do not re-derive a stall from Log timestamps, do not poll `get_fleet` for
children the mission already links, and do not recompute a verdict glyph the
projection already gives you.

**`derived.progress` is where the mission is — never recount it.** It carries
`total`, `current` (`{ from, to }`, a range when steps run in parallel, `null`
when all are done), `allDone`, `done`, `verified`, `leftBehind` and
`unprovable`. It counts position, not proof. Say it the way the operator's
Topbar pill does: "Step N of M" with N = `current.from`, "Steps a–b of M" for a
parallel range, "Step M of M ✓" only when `allDone`. Never say "N of M done" or
count proven steps yourself — that number disagrees with the pill.

**The operator's doors are not yours.** A mission is born `active`: the end
question you ask in chat is the agreement, and there is no approval step after
it. Only the operator ends a mission — close as delivered, or discard — and they
can do it at any time; you only ask for the close (`mission done`). After they
end it, every `mission_*` write refuses `MISSION_CLOSED`. On `MISSION_CLOSED`,
stop the loop and report — never retry, never create a replacement mission to
keep ticking.

### Your session id — pass it, and pass your real one

Every verb that takes a session id takes it **on your word**: Harnu's transport
has no per-session identity, so a wrong id is silently believed. Your own id is
already in your context — the scratchpad directory you were given ends in it:
`…/<project-slug>/<SESSION-ID>/scratchpad`. That full UUID is what you pass as
`sessionId` (`mission_create`, `mission_verify_step`, `mission_import_legacy`)
and as `ownerSessionId` (`mission_get`). `<session8>` is its first 8 characters.

- **No scratchpad path in your context** → you cannot own a mission honestly.
  Say so, and ask the operator which session should own it; never invent an id
  or pass a `synthetic-…` one (refused `BAD_SESSION_ID`).
- **That directory reads `agent-<something>`** → you are a subagent, not a
  session. Do NOT create or own a mission. Report back to the session that
  dispatched you.

## `mission set <objective>`

1. **Look for yours first:** `mission_get({ folder, ownerSessionId: <your id> })`.
   One exists for this objective → you are updating it (steps 4–5), not creating
   a second. One exists for an unrelated objective → it must be finished or
   handed back first; say so, do not stack two missions on one owner.
2. **Agree the end — before the first dispatch.** `declaredEnd` is required and
   complete — `kind` (`code`/`ui`/`research`/`decision`/`other`), a concrete
   `target` ("PR merging the 4 slices into main"), and the `evidence` that proves
   it ("green CI + delivery-verifier report, every AC met"). Propose your best
   concrete reading of the objective and confirm it with the operator in ONE
   AskUserQuestion — the proposal is the recommended option. The end question in
   chat is the agreement: the mission is born `active`, and nothing waits on a
   click afterwards.
3. **Create it with the plan in one call — `mission_create { steps }`:**
   `mission_create({ folder, title, declaredEnd, sessionId: <your id>, steps,
scope?, linkedCard? })`. Shape the plan by these rules:
   - **1 unit = 1 PR = 1 step.** One step per deliverable that moves where the
     work is. Sub-phases of a unit (spec, implement, review, ship) are not steps.
     Sub-phases go to the Log (`mission_log`). One executor split across five
     steps makes the pill crawl while nothing moved.
   - **Declare each step's `verification`:** `verifier` for work a child
     delivers, `existence` for an artifact that simply has to exist (a spec, a
     merged PR), `human` only for a stage of its own that gates what comes next
     (an operator decision before the next wave).
   - **Sign-offs become checks, not steps.** "The designer signs off", "DSQA
     done", "validated visually" is a human confirmation of a step's
     deliverable: add it to that step with `mission_add_check({ folder,
missionId, stepId, label })`. Only the operator ticks it. Never add a step
     for it.
   - `scope` takes the repo-relative paths of the spec / PRD / ADR. It is an
     attachment shown next to the progress, never a step. `linkedCard` is the
     epic card slug when there is one.
4. **Link what builds each step:** `mission_link_child` with `{ kind: 'session' |
'worktree' | 'card' | 'pr', ref }` — every child session you dispatch for a
   step, its worktree, its card, its PR once opened. Links are what Harnu derives
   from; an unlinked child is invisible to the mission, and a linked child keeps
   you from being parked while it runs. **Never link a session to a step only to
   change its proof label; link the sessions that built it.** A link is a claim
   about who built the step, and the operator reads it as one.
5. **New work found later** → `mission_add_step` (pass `links` when you already
   know what will prove it). Once the mission has started — any step has a link
   or a proof — `reason` is required: a grown total is always explained.

**Changing an active mission's objective is a re-scope, not a new mission:**
`mission_set_end({ folder, missionId, declaredEnd, reason })` stages the new end
and asks the operator on the `you` line. When they approve, the fixed end's proof
resets to `unproven` — re-verify it.

**A changed rule is a re-scope too, in the same turn.** When the operator changes
how the delivery ends (merge policy, target branch, what counts as done), call
`mission_set_end` in the same turn with the new end; the operator approves the
re-scope in the Topbar. Do not wait for the next tick, and do not leave the old
end standing because the units themselves did not change.

### Adopting a legacy goal file

Missions declared before the `mission_*` verbs live as free markdown in
`<repo>/.harnu/goals/*.md` (or a single `<repo>/.harnu/GOAL.md`). Adopt one ONLY
when it is actually yours:

- Its `session:` frontmatter, or failing that its `<session8>-` filename prefix,
  names YOUR session → yours.
- It names a DIFFERENT session → check that session with `get_session`. Alive or
  merely parked (`hibernated: true`) means the mission is another orchestrator's
  and is not yours to take. Only a session that genuinely no longer exists frees
  it.
- It names no session at all → it is yours only if nothing live is coordinating
  it; when in doubt, ask the operator.

Import it with `mission_import_legacy({ folder, legacyPath, sessionId: <your own
id> })` — **always pass your own `sessionId` explicitly**: most legacy files
carry no session UUID, and without one the call is refused `BAD_SESSION_ID`. Then
`mission_log` whose file it was ("adopted from `<file>`, orchestrated by
`<session8>` / unattributed"). If the ACK's `needsReview` lists `declaredEnd`, the
file stated no usable target: stage a real one with `mission_set_end` at once.
Until the operator approves that re-scope, "review the imported end" sits on
their `you` list.

The import never modifies the source file, and `legacyRaw` keeps it byte for byte
inside the mission. From then on the Mission is the state; leave the source file
where it is. Never write to, archive, or overwrite a goal file whose prefix is
not yours — another orchestrator may be coordinating live behind it.

## `mission` — one tick

1. **Read the mission — one call:** `mission_get({ folder, ownerSessionId: <your
id> })`. It replaces the old hand-assembly of `get_fleet` + `get_approval` +
   board reads: the linked children's live state, the linked worktrees, cards and
   PRs, the proofs, the stall flag and the `you` line all arrive together.

   - Not found → look for a goal file of yours in `.harnu/goals/` and adopt it
     (above); otherwise say "no active mission" and suggest `mission set`.
   - `delivered` → the `you` line asks the operator to close; report that and
     stop the loop.
   - `closed`, or any verb this tick refuses `MISSION_CLOSED` → the operator
     ended it (closed as delivered, or discarded; the Log's last
     `operator` line says which). Stop the loop and report; do not retry.

2. **Read what Harnu derived** — never re-derive it:

   - `derived.progress` — where the mission is: "Step N of M" (N =
     `current.from`), `done`, `verified`, `leftBehind`. Report it as-is.
   - `derived.progress.unprovable` — `existence` steps that are reached or
     current but have no path, card or PR link. Say it in the tick line: "step
     `<title>` can never be proven — link its PR or path", and link it
     (`mission_link_child`) when you know what proves it.
   - `derived.progress.leftBehind` — steps still `todo` behind the current one.
     Each is either work you forgot to dispatch (dispatch it) or a step that no
     longer applies (say so in the Log; the operator sees it at the close).
   - `derived.steps[].children[]` — per linked session: `known` (false = no
     such session: a typo or a vanished child), `taskState`, `hibernated`
     (parked, not dead), `peer`, `pendingApprovals`.
   - `derived.steps[].links[]` — a worktree's `exists`/`branch`/`head` and its
     PRs, a card's board `status`, a PR's `state`.
   - `derived.steps[].existence` — the live proof of an `existence` step.
   - `derived.stale` — `true` means an `active` mission with no evidence for over
     an hour and no linked session working. It is a flag to investigate (a stuck
     child, a lost report), never a reason to respawn.
   - `youItems` / `you` — what the operator owes right now, a list and its
     one-line summary (due checks included). It always prints.

3. **Act only on what is unblocked, respecting the doors:**

   - **Child looks VANISHED → do not re-dispatch on this tick.** Two live
     sessions in one worktree corrupt each other's edits. Prove death first:
     - `known: false` or a missing child can still be a spawn in flight:
       `get_session` reporting `status: "spawning"` or `inflight: true` means it
       is on its way — materialization can land many minutes late. Never retry
       `create_session` into the same folder while it is unresolved; it refuses
       with `SESSION_ALREADY_IN_FLIGHT`, by design.
     - A frozen parent transcript is not death while any file under
       `<transcriptDir>/<sessionId>/subagents/` is recent — a background agent
       may still be pending. Check those mtimes before the verdict.
     - `taskState` lies in both directions. Transcript + worktree +
       subagents-dir is the ground truth.
     - `hibernated: true` is a parked session, not a dead one: the conversation
       is intact and selecting it resumes. It reports no `taskState`; that
       absence is not a stall.

     Re-dispatch only after **two consecutive** checks ~10 minutes apart show
     nothing alive, and prefer a fresh worktree — re-entering the same one needs
     the old session actually STOPPED (an operator click; there is no kill verb).
     Link the replacement with `mission_link_child`. If a retry lands and BOTH
     materialize, escalate at once, naming which one to stop.

   - **A `[Cross-session idle notice]` for one of your children is a tick
     trigger, not noise.** Run this tick's checks against it immediately. If you
     never subscribed at dispatch (`SendMessage { notify_when_idle: true }`), you
     are discovering finished work by polling.

   - **Child FINISHED, pushed, but no PR → dispatch the shipper, this tick.** A
     linked worktree with commits, a clean tree, and no PR for its branch means
     the unit is waiting on YOU: a session dispatched by an agent is spawned
     `agentControlled` and holds no `mcp__harnu__*` verbs, so it never could have
     opened that PR itself. Call `create_session` into that worktree with the PR
     pipeline as `prePrompt`, link the shipper and its PR to the step, and log it.
     Never send the implementer back to review its own diff.

   - **Child FINISHED** → persist its report with `mission_log` (step-scoped),
     mark the step `claimed` with `mission_update_step`, then read the actual
     evidence (diff, gate output, files), never the self-report alone. Verify per
     acceptance criterion with the **delivery-verifier** skill — one AC per call,
     grader blind to the child's report, verdicts `met | unmet | blocked |
needs-human` — and record the result with `mission_verify_step({ folder,
missionId, stepId, verdict, evidence, sessionId })`. **The verifying session
     must not be the step's author**: link the child session to the step first,
     and have a session that is not one of its linked sessions call the verb —
     you, when a child did the work; a separately dispatched verifier, when you
     did it yourself. A self-verification lands `self-verified`, which the
     operator never sees as proven. `unmet` goes back to the SAME child as a
     delta; twice-unmet is an operator decision, not a third attempt.
     `needs-human` passes `checkLabel` naming what the human must confirm: the
     step reads `done` and carries that check for the operator to tick — it
     also goes on the Delivery Report's check-by-hand list.

   - **The operator or the packet asks for a sign-off** ("the designer must sign
     off", "DSQA before it counts") → `mission_add_check` on the step whose
     deliverable it confirms. Sign-offs become checks, not steps: no
     `mission_add_step`, no `human` step. The check lands on the operator's
     `you` list once the step is reached.

   - **Something blocks a step or the mission** → `mission_set_blocker` with the
     reason, what would unblock it, and whose move it is (`agent`/`operator`; an
     operator-owned blocker lands on the `you` line). Cleared →
     `mission_clear_blocker`. A blocker is a flag; it never changes the status.

   - **A turn that ends waiting on the operator raises a blocker.** Before you
     end a turn whose next move is the operator's — a merge, a key, a
     credential, a decision — call
     `mission_set_blocker { owner: 'operator', reason: '<what exactly>', unblocks: '<the observable event>' }`.
     Harnu then chimes, asks for their attention and reminds them every 30
     minutes. Clear it with `mission_clear_blocker` on the turn you see it done.
     Text in the transcript is not a signal: nobody reads it until they come
     back.

   - **The operator changed how the delivery ends** (merge policy, target
     branch, what counts as done) → `mission_set_end` in the same turn, with the
     new end and the operator's words as the `reason`.

   - **New work discovered mid-mission** (a split from verification, a deferred
     fix) → `mission_add_step` with its `reason`, then dispatch and link it like
     any planned unit.

   - **Wrong result** → send the specific delta back to the SAME child, not a
     redo.

4. **Never cross the doors:** no card to `done`, no product-code writes, no
   self-granted execution, no mission ended by you, no check ticked by you. Ping
   the operator only at doors (re-scope approval, a due check, UI approvals,
   Review→Done, the close) or when blocked for more than one full tick — and
   batch the pings.

   **A total stall on the operator is a LOUD event, not a quiet tick.** When the
   ONLY thing blocking all forward motion is a human gesture, raise the
   operator-owned blocker (above) naming the exact action ("merge #68 and #69 —
   both green, the whole train is waiting") — that is what makes Harnu chime and
   re-nudge — then go quiet until the state changes.

5. **Persist the tick:** one `mission_log` line (`<date time> — <state> →
<action taken>`).

6. **Report ONE line** to the user: `tick — Step N of M · <essential state> |
next: <next check>`, the headline taken from `derived.progress`. Silence about healthy in-flight work is the feature; detail lives in
   the mission. The line expands into the `status` glance card when `Needs you`
   or `Open` changed since the last tick.

### Pacing

When the loop paces itself, match the interval to what actually changes:

- Babysitting dispatched Harnu sessions the operator is watching → ~300s, and say so.
- Workers grinding on real code change state every 20–40 minutes → 1200–1800s.
- A gate about to resolve (operator active, approval pending) → 240–270s.
- Everything blocked on an absent operator → 1800–3600s.

Prefer `run_in_background` over long blocking calls while children are live: a
child's message reaches you only between your tool calls.

**A loop you cannot keep alive needs a backstop.** Your ticks live inside a
session that Harnu may park, the operator may close, or a compaction may
interrupt. When the work will outlive a single sitting, have the orchestrator
stand up a `delivery-watchdog` worker on the Scheduler alongside the loop: it is
read-only, reads the same mission through `mission_get`, and notifies the
operator when a unit is parked. See the `orchestrate-delivery` skill.

Honor your own stop condition: when the mission is `delivered` or closed — or
a verb refuses `MISSION_CLOSED` — STOP the loop. A loop that keeps firing after its stop condition burns tokens on
nothing.

## Child reporting — hard rules

Children report to their owner through Claude Code's native `SendMessage` (a
child an agent dispatched holds no `mcp__harnu__*` verbs). A native address is a
**name**, and a name is not an identity: a session's name can change when Harnu
parks and resumes it, so a name captured at dispatch can later point at nobody —
or at somebody else. These rules are not advice; put them in every dispatch
packet, verbatim where they concern the child.

**For the child — must hold, every send:**

1. **Your owner is a session id, not a name.** The packet names it: `owner
session <uuid>`. The name it also gives you is only where that session could
   be reached at dispatch time.
2. **Resolve the name at send time, every time.** Call `ListAgents` immediately
   before sending, and send only to a name you just saw listed that is your
   owner's latest address — the packet's, or a newer one your owner sent you
   since. Never reuse a name from an earlier turn without listing again. If you
   hold Harnu verbs, `get_session({ sessionId: <owner uuid> })` tells you whether
   that id is live or parked before you try.
3. **Name the owner's id in the report itself.** Open every report with `Report
for session <owner uuid> · mission <missionId> · step <stepId>`, so the
   recipient confirms by id, not by the name it arrived under.
4. **Owner unreachable → stop, do not spread.** No name resolves, the send fails,
   or the recipient answers that it is not that session: your report stays in
   `.harnu/REPORT.md` in your worktree (write that file first, always), and if you
   hold Harnu verbs you also record it on your own step with `mission_log({
folder, missionId, stepId, note })`. Then stop.
5. **Never broadcast.** Never send the report — or a summary of it, or a "can
   you relay this" — to any session other than your owner: not a sibling, not
   another orchestrator, not whoever looks nearest. An unreachable owner is a
   wait, not a reason to widen the audience. (What happens after the wait —
   queue, retry, drop with a note — is undecided; the file and the step are the
   fallback until it is.)

**For the owner — must hold:**

- **At dispatch, give the child both halves:** your session id and your current
  native name (the first line of `ListAgents`: "This session is `<name> [<ref>]`"),
  plus the rules above.
- **Re-announce when your name changes.** On every tick, read your own name from
  `ListAgents`' first line and compare it with the last address you recorded
  (`mission_log`: "owner address: `<name> [<ref>]`"). Changed → log the new one
  and send it to each live linked child with `message_session({ sessionId:
<child uuid> })`, which addresses a Harnu-spawned child by its stable id and
  wakes it if parked. A child that is still unreachable falls back to its file,
  which your ticks read anyway.
- **A report is yours when it names your session id** — even when it arrived
  under a name you no longer hold. A report naming a different session id is not
  yours: tell the sender so in one line, and do not act on it or pass it on.

## `mission done`

Verify against evidence, not memory. When every unit is verified and the end's
evidence exists, verify the fixed end (`Delivered and verified`) yourself with
`mission_verify_step({ folder, missionId, stepId: <the fixed end>, verdict: 'met',
evidence, sessionId: <your id> })`. The fixed end's builders are every session
linked to any step; you built none of the steps, so it lands `verified`. Then read
`closeReadiness` on `mission_get` — `null` means the close will land — and call
`mission_request_close({ folder, missionId, sessionId })`. The operator closes.

`closeReadiness` (and the verb) name what is in the way:

- `END_NOT_VERIFIED` → the end is `unproven`, `claimed` or only `self-verified`.
  `self-verified` means no step links a child session, or you linked your own
  session somewhere: link each unit's child session to its step, then verify
  the end again.
- `OPEN_BLOCKERS` → clear or resolve them first.
- `RESCOPE_PENDING` → a re-scope is staged; the operator approves it (which
  resets the end's proof), then verify the end again.
- `MISSION_CLOSED` → the operator already ended it; stop the loop and report.

Due checks, left-behind steps and an unverified end never block the request or
the close: the operator sees them as warnings in the end dialog and decides.
Say which ones remain in your closing summary.

On success the mission is `delivered` and the `you` line asks the operator to
close it — **the close itself is theirs.** Write the final `mission_log` line,
drop a dated summary into project memory (`memory_append`, `decisions` or a
session digest), report the closing summary (opening with the `status` card),
and stop the loop if one is driving the ticks.

## Boundaries

This skill coordinates; it never executes product work — the same contract as the
orchestrator role: delegate, read evidence, gate at the doors. If a tick discovers
work that needs a NEW mission, card it on the board and mention it; do not silently
grow the current mission beyond a logged `mission_add_step`.
