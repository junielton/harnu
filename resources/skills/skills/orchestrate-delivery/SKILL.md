---
name: orchestrate-delivery
description: Decompose an objective into board cards, dispatch one Harnu session per unit, monitor until each opens a PR, verify every acceptance criterion independently, and hand back a Delivery Report. Use when the operator hands over an objective too large for one session and wants it delivered rather than discussed — "orchestrate this", "break this down and dispatch it", "fan this out across worktrees", "deliver this epic" — or when a Harnu board already holds several ready cards that need to be planned, dispatched and graded as one delivery. Do NOT use to implement a single unit of work yourself, to review a PR, or to merge anything.
---

# Orchestrate delivery

Deliver an objective by decomposing it into board cards, dispatching one Harnu
session per unit, monitoring until each unit opens a PR, verifying every
acceptance criterion against real evidence, and handing the operator a Delivery
Report they can act on without re-reading a single transcript.

## Why this shape

Large deliveries must become small, reviewable PRs with no file conflicts between
sessions. The topology is what avoids rework: parallelize what is independent,
stack what depends on earlier code. In Harnu the board **is** the delivery plan —
cards are the units, the dispatch manifest is the gate, the columns are the
report.

## Invariant

1 unit of work = 1 board card = 1 branch/worktree = 1 session = 1 PR — and, on
the mission, 1 unit = 1 PR = 1 step. Never mix units. And delivery is not "the PRs are open" — it is "every acceptance criterion
is accounted for, with evidence or with a named human check". Phase 5 is not
optional.

## Phase 0 — Hydrate

Call `memory_read` (hot + index) for this repo first. Check the board for existing
cards that overlap the objective — extend or re-scope them instead of duplicating.
Confirm a `WORKTREE.md` manifest exists at the repo root (worktrees are born usable
through it); if it is missing, flag it as a blocker before dispatching anything to
a worktree.

**Require a spec bundle readable from a fresh worktree.** Every unit needs its
acceptance criteria, spec, design links and tracker link available on the BASE
BRANCH — committed, not sitting untracked in `.harnu/`, which a fresh worktree
cannot see. If the objective arrives without acceptance criteria, the first
delegation is a scout that writes them, not an implementation.

## Phase 1 — Topology

Break the objective into deliverable units and build the dependency graph:

- **Single unit** if the work fits one reviewable PR (~500 lines) or the parts
  touch the same files.
- **Parallel** if units share no files and no code dependency. Confirm with real
  analysis (grep/glob over each unit's paths), not intuition.
- **Stacked (sequential)** if unit N+1 consumes code from unit N.

Declare the topology in one line per unit and proceed. Ask only on genuine scope
ambiguity — one binary question. A question costs the operator a full round-trip
of wall-clock; a dispatch that turns out slightly wrong costs a rebase. When both
are available, dispatch. The one question you always ask is the end, below.

**Declare the mission now — after the topology line, before any dispatch.** Call
`mission_create` in this phase, not after the first unit is out: the mission is
how the operator sees the delivery, and an end they never agreed to is a finish
line they will dispute at the close. Propose the declared end from the spec
(kind, target, evidence) and confirm it with the operator in ONE AskUserQuestion —
the proposal is the recommended option. Pass the spec / PRD / ADR paths as
`scope` (an attachment, never a step), and declare the whole plan in the same
call — `mission_create { steps }` — so the mission shows every unit before the
first executor starts. Shape the steps by these rules:

- **1 unit = 1 PR = 1 step.** One step per deliverable that moves where the work
  is, so the operator's pill ("Step N of M") moves when a unit moves. Sub-phases
  go to the Log (`mission_log`): spec, implement, review and ship are one step,
  not four.
- **Sign-offs become checks, not steps.** A human confirmation of a unit's
  deliverable — the designer signs off, DSQA, "validated visually" — is a check
  on that unit's step: `mission_add_check({ folder, missionId, stepId, label })`.
  Only the operator ticks it. A `human` step is only for a stage of its own that
  gates what comes next (an operator decision before the next wave).

**The answer comes before the first dispatch.** Ask, then stop: write no packet,
create no session and link no child until the operator has answered the end
question. The end question in chat is the agreement: the mission is born
`active`, and nothing else waits on the operator. If they correct the end, stage
the correction with `mission_set_end`. Once they have answered, dispatch at
once.

**Integration branch — whenever the delivery needs more than one PR.** Cut
`feat/<epic>` from the default branch before dispatching anything, and make it the
base of every unit's branch (parallel units fork from it; stacked units fork from
their predecessor). It exists so the feature can be tested as ONE thing before it
touches the default branch: all unit PRs merge into `feat/<epic>`, that branch goes
to staging, and `feat/<epic> → main` is a single final PR whose body is the
Delivery Report. One PR total → no integration branch, target the default branch
directly.

Rules that keep the cost bounded:

- **Freeze the base SHA per wave.** Every unit in a wave forks from the same
  `feat/<epic>` commit. Rebase `feat/<epic>` onto the default branch only BETWEEN
  waves.
- **Serialize merges into `feat/<epic>`** and run the full suite after each one.
- **Single-own hub files** (shared types, routes, i18n bundles). If several units
  need the same hub file, that file gets its own unit, first in the wave.
- Expect roughly one in four agent PRs to conflict — rebasing is a planned step of
  delivery, not an incident.

Commit the spec bundle on `feat/<epic>` so every child worktree inherits it.

## Phase 2 — Cards and dispatch

For each unit, create a card (`create_card`, with kind + complexity +
`substrate: "worktree"`) whose body is a complete delegation packet:

- **Objective** and the done criterion for the unit.
- **Acceptance criteria, with ids and a verification mode** — the contract this
  unit will be graded against in Phase 5. One line each:
  `- [ ] AC-1 — <observable behavior> — verify: test|visual|manual|review — source: <spec §, design node, ticket id>`
  Write them from the spec or the tracker, never from imagination, and keep the ids
  stable: evidence, the report and the tracker tick-back all key on them.
  `verify: manual` up front is honest and useful — it pre-declares what will land
  on the human's checklist.
- **Provisional ACs — mark what you invented.** ACs traceable to a committed
  spec, a design node or the tracker are the contract. ACs you wrote yourself,
  because the objective arrived without any, are **provisional** — and they carry
  a real hazard, because Phase 5 will grade the delivery against a bar you set.
  Dispatch anyway; a round-trip costs the operator more than a rebase costs you.
  But make the self-authorship visible instead of silent:

  - tag each one `provisional` in the card, and open the AC block with one line
    naming what you derived them from (screenshots, a design node, the code as it
    stands today);
  - `notify` the operator once, at dispatch, listing them — you are proposing a
    definition of done, and that is theirs to correct, not yours to assume;
  - carry the tag into the Phase 5 report, so a `met` on a provisional AC reads as
    "met the bar I proposed" rather than "met the spec".

  A provisional AC the operator corrects mid-flight is a delta back to the SAME
  executor, exactly like an `unmet`. Never quietly promote one to non-provisional
  just because it passed — passing your own bar is not evidence the bar was right.

- **Honest exit clause** (paste it verbatim): "If an AC cannot be satisfied — the
  spec is contradictory, the data does not exist, an answer is missing — report it
  as `AC-n: unmet` with the reason, or `blocked` with the question. Never quietly
  drop an AC, never weaken a test to make one pass, never edit an acceptance
  criterion to match what you built." Agents given an explicit way out cheat far
  less than agents told to keep trying.
- **Scope boundary**: exactly which files and directories it may touch. Out of
  scope means no refactors, no abstractions, no dependency changes beyond the unit.
- **Context pointers**: files to read first, relevant memory pages, prior
  decisions.
- **Visual proof — a unit that changes rendered UI must be looked at before it
  reports done.** A code review cannot see a rendered page. A template that escapes
  an HTML string, a component that lays out wrong, an image slot that prints its own
  `<img>` tag as a paragraph of text: the diff reads correctly line by line, the
  build is green, the tests are green, and the page is visibly broken. Put it in the
  packet as a step, not a suggestion: start the app or dev server, open every
  affected route with the Chrome tools (`navigate` + `read_page` / screenshot), and
  attach the capture to the card (`update_card { images }`). **Name the routes in
  the packet** — the executor should not have to infer which page it changed. An AC
  about something visible is never satisfied by an argument that the code is right.
- **Git conventions**: point the executor at the repo's own conventions doc for
  branch naming and PR title/description rules — reference it, do not restate the
  rules in the packet, because restated copies drift.
- **The repo's method, written as steps rather than as a slogan.** Read how this
  repo actually works — `CLAUDE.md`, its conventions doc, its lessons — and put
  the method in the packet as things to do. "We do TDD" changes nothing an
  executor can act on; "the first commit on this branch is the failing test for
  AC-n, and your report states the red→green transition" is a step it can be held
  to and a verifier can confirm from `git log`. Same shape for a spec-first repo:
  the spec commit lands before the implementation commit. If the repo states no
  method, do not invent one — say so in the packet and let the ACs carry the
  weight alone.
- **Exit sequence — the executor commits and stands down; YOU dispatch the
  shipper.** The session that wrote the code is the worst available reviewer of
  it: its context already holds every justification it made, so a `review-local`
  run inside it re-reads its own reasoning instead of reading the diff cold. The
  PR pipeline therefore runs in a FRESH session in the same worktree — dispatched
  by you, never by the executor:

  - The executor's own run ends at **commit + push + clean tree**. It verifies its
    commits exist (`git rev-list --count <base>..HEAD` > 0) and that
    `git status --porcelain` is empty. It must **not** invoke `ship` — or any
    pipeline whose first step is a self-review — in its own session.
  - **Never write "then spawn the shipper" into the packet — the executor
    cannot.** A session dispatched by an agent is spawned `agentControlled`, and
    Harnu withholds its `--mcp-config`: that session has NO `mcp__harnu__*` verbs at
    all, by design (it is what stops a recursive conductor). A packet telling it
    to call `create_session` is an instruction it can only fail — it pushes, finds
    no verb, and stands down with no PR and no way to tell you. Every unit
    dispatched that way parks at "pushed, no PR" until a human happens to look.
  - **The handoff is yours, on the tick that finds a clean pushed tree** — you
    hold the verbs, the executor does not. It is a normal step of the delivery,
    not a recovery path; see Phase 3.
  - **Serialize the two.** Two sessions in one worktree share the index and HEAD.
    Dispatch the shipper only once the executor has reported a clean tree, and
    tell it in the packet that it touches that worktree no further after
    reporting.
  - Pass the shipper three overrides: the base branch per the topology, "open the
    PR only — never merge", and "skip the notify step — the orchestrator reports
    centrally". If no such pipeline exists, plain `gh pr create` is fine.

- **Report format**: branch + head sha + one-line summary + per-AC self-assessment
  (recorded, never trusted — Phase 5 grades independently) + unresolved findings.
  The executor never reports a PR URL, because it never opens the PR — that
  arrives from the shipper you dispatch, or from your own `gh pr list` on the next
  tick.
- **A return address the executor can actually resolve, plus a file it can always
  write.** A dispatched session holds no `mcp__harnu__*` verbs, but `SendMessage` is
  a native tool, not MCP — it has that, and it can reach you even though you are a
  session the operator opened themselves. A native address is a **name**, and a
  name is not an identity: yours can change when Harnu parks and resumes you, so
  the packet carries both halves and the `mission` skill's **child-reporting hard
  rules**, verbatim:

  - **your stable session id** (`owner session <uuid>`) — who the report is for;
  - **your current name** — call `ListAgents` once before writing the packet; its
    first line states it verbatim ("This session is `<name> [<ref>]`"). A session
    UUID is not a SendMessage address, so never paste it as one. Include the
    ` [ref]` when your bare name is ambiguous in a busy fleet;
  - **resolve at send time:** the executor lists agents again right before every
    send, and sends only to your latest address it just saw listed — never to a
    name cached from an earlier turn;
  - **open every report with `Report for session <uuid> · mission <id> · step
<stepId>`**, so you confirm it by id whatever name it arrived under;
  - **never broadcast:** if no name resolves or the send fails, the report stays in
    the file (and, for an executor holding Harnu verbs, on its step via
    `mission_log`) — it is never sent to a sibling, another orchestrator, or
    anyone "who might relay it".

  Give it a fallback in the same breath, because a send can still fail and an
  executor with nowhere to put its report will improvise or lose it: **write the
  report to `.harnu/REPORT.md` in the worktree as well, always, then send.** The
  file is what your next tick reads; the message is what makes the tick happen now
  instead of later. When your own name changes mid-delivery, re-announce it to
  each live child — the `mission` skill's owner rules say how.

A packet an executor can misread is your defect, not theirs.

**Parallel units:** move their cards to `ready` (`move_card`), then submit ONE
dispatch batch with `submit_manifest`, cards in drain order. The drain cuts one
worktree per card and respects the board's WIP ceiling — do not hardcode your own
concurrency cap. Caveat when an integration branch is in play: **the drain always
bases on the default branch**. Either dispatch parallel units manually
(`create_worktree { base: "feat/<epic>" }` + `create_session`, compensating the
missing bind as described below), or let them fork from the default branch and
retarget the PR base with `gh pr edit <n> --base feat/<epic>` before any merge. Say
which you chose.

**Stacked units:** the manifest drain branches from the default branch, so stacking
is manual. Dispatch unit 1 via the manifest. When unit N's PR is open,
`create_worktree` passing the unit-N worktree path as `folder` (so the base is
branch N — verify with `git merge-base` that the base is what you expect), then
`create_session` in it with the packet as `prePrompt`. These verbs run without
confirms by default; only if a confirm comes back ("Ask before agent actions" is
on) call `plan_mission` once to cover the remaining follow-ups.

- [ ] **Retarget before the merge handoff.** Before handing merges to the
      operator, retarget every stacked PR whose base has landed:
      `gh pr edit <n> --base <default branch>`, then
      `gh pr view <n> --json baseRefName` to confirm. A merge into a stack base
      that never reaches the default branch is a second round-trip for the
      operator. (`mission_get` shows each linked PR's `baseRefName` too.)

A manually dispatched card never binds to its session: the board will not show
`in-progress` and no `dispatched-with:` line is written. Compensate with
`update_card` — note the session and worktree path in the card body — so the board
still tells the truth.

Model and effort per card are hints only; the operator's routing table decides what
actually launches. On manifest-dispatched cards, read the `dispatched-with:` line
afterwards if you need to know what ran.

## Phase 3 — Monitor

The mission you declared in Phase 1 is the state that survives interruptions — a
structured Mission the `mission` skill owns through the `mission_*` verbs. Keep it
true as the delivery moves: `mission_link_child` for each unit's session,
worktree, card and PR as they appear, and a `mission_add_step` for any unit born
mid-delivery. **Never link a session to a step only to change its proof label;
link the sessions that built it.** A session link says who built the step — the
operator reads it that way, and the end's verification counts on it. One mission
per owner session, so parallel orchestrations in one checkout never overwrite
each other. Then **arm the ticks yourself** — a loop over `mission`, self-paced,
stopped when the mission closes. On `MISSION_CLOSED`, stop the loop: the
operator ended the mission (closed or discarded it), and every write refuses from
then on — report it, never retry or open a replacement mission. Do not wait to be asked "how is it
going": an orchestration whose heartbeat depends on the operator remembering to
poke it is an orchestration that quietly parks work.

**Arm the loop before you report the dispatch, and keep it alive until every unit
has reached `review`.** No dispatched unit may exist without a live heartbeat
over it. The operator is not a watchdog: if the way a stalled unit gets found is
that they opened the folder days later and asked, the orchestration failed even
if every executor did its job.

### The heartbeat needs three layers, because the loop dies

Your loop lives inside this session, and this session is mortal in entirely
ordinary ways: Harnu parks it under memory pressure, the operator closes the app, a
compaction lands, or they simply ask you something mid-delivery and the turn ends
without re-arming. None of that is exotic — **the loop stopping is the normal
failure**, and a delivery whose only heartbeat is that loop parks silently until a
human wanders back. Assume it will happen and make it survivable rather than
pretending it is impossible:

**Layer 1 — a push subscription per executor, taken at dispatch.** The moment a
unit's session exists, subscribe to it:
`SendMessage { to: "<executor name from ListAgents>", notify_when_idle: true }`
with **no message** — a pure subscription costs that session nothing. Exactly one
`[Cross-session idle notice]` arrives when it next goes idle or exits, which wakes
you at the moment the unit actually finishes rather than whenever your timer
happens to land. That notice is your cue to run the resume steps: read the
evidence, dispatch the shipper, verify.

This is the layer that collapses the expensive gap. An executor that finishes and
stands down is otherwise invisible until something asks git about it, and "how
long until something asks" is the entire latency of a delivery. Do not simulate it
by polling `ListAgents` or by messaging executors to ask whether they are done —
that burns their turns and yours, and the subscription exists precisely so nobody
has to.

Treat it as unreliable in one direction only: the notice can lapse (the
subscription expires, the session ended abruptly, you were not around to receive
it). It never lies about a unit being finished; it can only fail to tell you. That
is what the next two layers are for.

**Layer 2 — the loop.** It does the work: dispatches shippers, sends deltas back,
verifies, closes out. Only a session holds the verbs, so only this layer can act.
With layer 1 in place its cadence is a backstop rather than a discovery mechanism
— slow ticks are correct, because arrival is pushed to you.

**Layer 3 — a watchdog on Harnu's Scheduler.** Stand one up at the same time you
arm the loop: Scheduler → New worker, `observe` mode, this repo's folder, prompt
`/harnu:delivery-watchdog`, ~30 minutes, with "carry last result" on — that one
carried line is how the watchdog remembers what it already reported. It reads
your mission through `mission_get`/`mission_list`, both on the `observe`
allowlist. A worker is a fresh unattended process on
a timer, so it outlives this session by construction — which is the whole point,
since neither of the layers above can report its own death: a subscription nobody
is alive to receive and a loop that stopped look identical from the inside.

Be honest with the operator about what this layer is: **a smoke alarm, not a
sprinkler.** An `observe` tick is read-only by allowlist and cannot wake you —
`message_session` is denied to it by name, and a session the operator opened
themselves is not a messageable recipient in the first place. It can `notify`,
and nothing else — it writes to no card and no mission. It still turns a stall
found the next day into a stall found in half an hour, which is most of the value.

Record the arrangement on the mission so a lapse is legible: a `mission_log` line
naming the cadence and the watchdog worker (or `none`, and why). Harnu derives the
rest: a mission with no new evidence for over an hour while no linked session is
working reads `derived.stale` on `mission_get` — to the watchdog and to you on
resume, with no heartbeat claim to trust.

Each tick (the `mission` skill's tick, from one `mission_get`):

- Linked executors' state from `derived.steps[].children` — `get_session` only to
  prove a spawn still in flight. `hibernated: true` is NOT death and NOT a stall —
  the session resumes on selection; never dispatch a replacement over it. If a
  unit's idle subscription lapsed without ever firing, re-take it
  (`notify_when_idle`) rather than raising the tick rate.
- Linked worktrees' PRs from `derived.steps[].links`, plus `gh pr list` for a PR
  no step links yet (link it); on unit N's PR, trigger the next stacked unit.
- Verify by evidence, never by the executor's own account: read the diff, the gate
  output, the PR. A wrong result goes back to the SAME executor with a specific
  delta, not a redo from scratch.
- If an executor reports done but `git rev-list` shows no commit, send it back with
  that exact finding — do not commit on its behalf.
- **Ship handoff — the step you own.** A unit with pushed commits, a clean
  worktree and no open PR is not waiting on anyone: it is waiting on you.
  Dispatch the shipper (`create_session` into that worktree) on the tick that
  finds it — never send the implementer back to review and ship its own work,
  which is the exact contamination the handoff exists to prevent. The executor
  cannot do this for you (Phase 2: agent-dispatched sessions hold no Harnu verbs),
  so a unit stuck between push and PR is always your defect, and the operator
  noticing it before you did is the failure this step exists to make impossible.
- If unit N's PR takes review changes (or a squash-merge) after unit N+1 already
  branched, instruct unit N+1's executor to rebase onto the new tip — never let the
  stack drift silently.
- Per unit, answer these five each tick: is the unit's objective fully satisfied by
  evidence? is the executor looping? is there forward progress since last tick? who
  acts next? what exactly do they do?

**Dispatch bias — a unit that CAN run is dispatched on the tick that discovers
it.** Authorization to orchestrate IS authorization to dispatch; there is no
second approval to collect. Handing the operator a unit they already gave you,
dressed as a question, is not caution — it is a stalled delivery wearing a
question mark, and it costs exactly as much as forgetting the unit entirely.

A unit may sit undispatched only when it is blocked on something you cannot
resolve yourself: an unmerged dependency, a missing spec, a named unanswered
question. "It came up later", "it was a split", "it wasn't in the original plan",
"I wasn't sure it was in scope" are not blockers — they are how deliveries
actually grow.

Units born mid-delivery — a split from verification, a deferred fix, a follow-up
a reviewer raised — enter the SAME pipeline as planned units: card, ACs, packet,
manifest, dispatch. Never park one in a report as a suggestion for the operator
to approve.

Before writing any tick or report, walk the units you are NOT running and say,
per unit, either `dispatched` or `blocked on <the specific thing>`. If you cannot
name the specific thing, it is not blocked — dispatch it on this tick, then
report that you did.

Stall rule: stall is not yours to compute — it is `mission_get`'s `derived.stale`,
deterministic and fresh on every read (an `active` mission with no evidence for
over an hour while no linked session is `working`). When it is `true`, find which
unit has gone quiet from `derived.steps[]` (no working child, no new commit or PR
on its links), then stop that unit: flag it with `mission_set_blocker` (reason +
what would unblock it + whose move it is), record the finding in its card body
(`update_card`), move the card back to `backlog` (`move_card`), and report the
blockage instead of insisting. Do not keep a tick counter of your own.

## Resume — every turn re-arms

A delivery is long-lived and the session driving it is not, so treat **every turn
in this session as a possible resume**, including the innocuous ones: an operator
question, a `status` request, an interruption, the turn after a compaction.

The failure this exists to prevent is specific, and it is cheap to walk into. The
operator asks how it is going. You re-read the state, answer accurately, and the
turn ends — with the heartbeat still dead. They got an answer and lost the
delivery, and the next thing that finds the stall is them asking again.

So on any turn where you are not certain the loop is still armed:

1. **Re-derive state from the world, not from this transcript.** `mission_get`
   (children, links, proofs, `derived.stale`, the `you` line), the board cards,
   `git rev-list` / `git status` per worktree. Your own context may be hours stale
   and is the only source that cannot be checked against anything.
2. **Do the missed work before reporting it.** A unit pushed-and-clean with no PR
   needs its shipper dispatched on this turn, not described. Whatever the loop
   would have done in the ticks it missed, do now.
3. **Re-arm, and say the cadence in one clause.** If it is genuinely over — every
   unit in `review`, mission closed — say that instead, and stop the loop
   deliberately rather than by neglect.

Answering without re-arming is the defect. The operator poking you is evidence the
heartbeat failed; it is not permission to stay stopped.

**A turn that ends waiting on the operator raises a blocker.** Before you end a
turn whose next move is the operator's — a merge, a key, a credential, a
decision — call
`mission_set_blocker { owner: 'operator', reason: '<what exactly>', unblocks: '<the observable event>' }`.
Harnu then chimes, asks for their attention and reminds them every 30 minutes.
Clear it with `mission_clear_blocker` on the turn you see it done. Text in the
transcript is not a signal: nobody reads it until they come back.

**A changed rule is a re-scope, in the same turn.** When the operator changes how
the delivery ends (merge policy, target branch, what counts as done), call
`mission_set_end` in the same turn with the new end; the operator approves the
re-scope in the Topbar. An end that still names the old rule is a close the
operator will refuse, or worse, one they accept against a finish line nobody
holds anymore.

## Phase 4 — Verify each unit, per acceptance criterion

The moment a unit's PR is open, verify it — do not wait for the whole wave. Use the
**delivery-verifier** skill for that unit. Two hard rules from it: the grader never
reads the executor's report, and each AC is graded on its own call into
`met | unmet | blocked | needs-human`.

Your part as orchestrator:

- run the deterministic checks first (`git rev-list` > 0, clean worktree, PR base is
  the intended branch, gates green, tests ran AFTER the last commit, diff inside the
  scope boundary, acceptance tests not edited) — cheap, and they catch most of it;
- assemble the blind packet (AC list + diff + test output + CI + screenshots) and
  dispatch one verifier subagent per AC;
- write the per-AC verdict table onto the card (`update_card` with `appendBody`),
  each row carrying its evidence and `by: verifier`, and record the unit's verdict
  on its mission step with `mission_verify_step` — from a session that is not one
  of the step's linked (authoring) sessions, which is you when an executor built
  it;
- `unmet` → delta back to the SAME executor, re-verify only that AC; twice unmet
  becomes an operator decision, not a third attempt;
- `blocked` → surface the question to the operator, next to the AC it blocks;
- `needs-human` → record the step with verdict `needs-human` and a `checkLabel`
  naming what the person must confirm: the step reads `done` and carries that
  check, which lands on the operator's `you` list until they tick it;
- move the finished card to `review` with the PR URL — never to `done`.

When every unit is verified and the end's evidence exists, verify the fixed end
(`Delivered and verified`) yourself with `mission_verify_step` (you built none of
the steps, so it lands `verified`), read `closeReadiness` on `mission_get`, and
call `mission_request_close`. The operator closes. `closeReadiness` is `null`
when the request will land; otherwise it names the refusal (`END_NOT_VERIFIED`,
`OPEN_BLOCKERS`, `RESCOPE_PENDING`, `MISSION_CLOSED`) — fix that first instead
of calling the verb to find out. Unticked checks and left-behind steps
(`derived.progress.leftBehind`) never refuse the close; the operator sees them as
warnings when they end the mission, so name them in your report.

Nothing enters the report without verification. An executor's own tick is recorded
as `by: executor` and is never counted.

## Phase 5 — Delivery assurance (the handoff)

After each wave, and again when the feature is complete, generate the **Delivery
Report** (format in the delivery-verifier skill) from the cards and the evidence —
never narrated from memory. It must answer, per unit and for the feature: where we
are against the plan, which ACs are verified, **which ACs the human must open the
app and check** (the `needs-human` list — this is the manual-QA handoff), what is
unmet and went back, which questions are open, what tech debt was raised.

Then close the loop on both surfaces:

- `open_file` the report so the operator reads it inside Harnu, and paste it into the
  `feat/<epic> → main` PR body;
- if a tracker is connected, tick the ACs verified by the verifier or by a human —
  never `needs-human`, never an executor self-tick — and post one comment per ticket
  with the PR link and the three buckets. Then tell the operator per ticket: these N
  are ticked and done; these K you must confirm yourself; these J are not done, with
  the reason.

### Retro — what the delivery taught you about the pipeline

Every delivery says something about the machinery, and the lesson evaporates
unless it lands somewhere the next orchestration will read. Close with a short
pass over how the pipeline behaved, kept separate from how the code turned out:

- **Where did a unit wait on nothing?** The gap between "pushed and clean" and "PR
  open", and between "PR open" and "verified", is your latency — not the
  executor's. Name it in wall-clock.
- **What did a packet instruct that could not be done?** An instruction an
  executor can only fail is a defect in the delegation template, not in the
  executor, and it repeats on every future delivery until the template changes.
- **Which verbs refused, and was the refusal a rule you should have known?**

Write it with `memory_append` (`decisions`, dated) so the next orchestration in
this repo starts already knowing it. When the defect is in the delegation template
rather than in this repo, raise a card against the skill itself — that is how a
bundled skill learns from a delivery that actually happened, instead of from
whichever post-mortem someone remembers to run.

## Boundaries

- Open PRs only. Never merge. Never move a card to `done`.
- Never touch product code, run builds, or commit in this session — delegate. If
  promoted to Orchestrator, Harnu's structural guard enforces this for you.
- Do not touch branches, worktrees or cards this orchestration did not create.
- One manifest go covers exactly that batch — new cards need a new manifest.
- A `next:` or `you` line that names work you could have dispatched yourself is a
  defect in the report, not information. The operator's next action is never
  "tell the orchestrator to start something that was already unblocked".
- Never edit an acceptance criterion to match what was built. If the spec was wrong,
  that is a finding for the operator, not a silent correction.

## Final output

**Mandatory header.** The `status` skill's six-line glance card comes FIRST,
built from `mission_get`, the board and `gh pr list`/`checks` — then the ✅/⚠️
lines below it. See `status` for the card's shape; this skill does
not restate its rules. Its mission header is `derived.progress` as the pill
shows it — "Step N of M" — never a count of proven steps you made yourself.

```
✅ Topology: [single | parallel xN | stacked xN] + integration branch (or why none)
✅ Heartbeat: loop @<cadence> + watchdog worker (or why none)
✅ <card-slug> (branch): one-line summary + PR URL + `ACs n/m met, k need a human`
✅ Review findings: N found, M fixed, rest noted on the PRs
✅ Delivery report: <path> · tracker: <n> ACs ticked, <k> left for manual check
⚠️ Unmet / blocked / open questions / debt, if any
```

The board is the durable record and the Delivery Report is the human handoff — this
summary is only for the operator's glance.
