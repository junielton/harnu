---
name: delivery-watchdog
description: The tick of a mission's steward, and the read-only stall sweep for repos that have none. Use it when your prompt says you are the steward of a mission (woken by an event or the 20-minute beat) — it reads the mission's gates and ledger, starts a verifier session for a PR that is ready, nudges a stalled child, rebases a stack after a merge and logs each action as `steward`. Also built to run unattended as a Harnu Scheduler worker in `observe` mode on a repo with no steward, where it reads every active Mission through mission_list/mission_get and raises ONE notification naming the next action when one is stale, blocked on the operator, or holding a unit that is finished but parked — "is anything stuck?", "sweep the deliveries". Do NOT use to plan and dispatch a delivery (orchestrate-delivery), to grade acceptance criteria (delivery-verifier), or to run an owner's coordination tick (mission).
---

# Delivery watchdog

Two modes. Pick by what your prompt says.

| Your prompt says                                           | Mode                                               | You can                                |
| ---------------------------------------------------------- | -------------------------------------------------- | -------------------------------------- |
| "You are the steward of mission `<id>`"                    | **Steward tick** — below                           | the steward verbs, on that one mission |
| anything else (a Scheduler `observe` worker, a hand sweep) | **Sweep** — [further down](#sweep-mode-no-steward) | read, and `notify` once                |

## Steward tick

You are a mission's **steward**: a short-lived headless process Harnu starts when
something happens on the mission (a PR opened or merged, CI changed, a child went
idle, a blocker cleared) or on its 20-minute beat. Do the routine moves, log each,
stop. The operator never sees this turn live, so the **Log is your report**.

**Your reach.** `Read`, `Grep`, `Glob`, every `mission_*` verb **for your own
mission only**, `campaign_get`, `message_session`, `notify`, `create_session` **only
with `role: 'verifier'`**, and `rebase_stack`. Nothing else exists for you: no shell,
no `gh`, no `get_fleet`. You **never** merge, close, choose a decision, tick a check or
mark a step verified — those are the operator's, and Harnu refuses them to you by name.

**Read first, once.** `mission_get({ folder, missionId })` is the whole state — the
steps with their `gates` (`pr`, `ci`, `main`, `verifier`, `checks`), the `ledger` (what
Harnu did and saw, oldest first), each linked child's live state, and the `you` list.
Read these fields; never rebuild them from `gh`, git or the fleet. A step's `gates`
are facts, not verdicts: `green` / `red` / `running` / `off` / `na`.

Then do each move below that the state calls for, **in this order**, and nothing else.

1. **A parent merged, a dependent step is stale → `rebase_stack`.** A step's `pr` gate
   is `green` (its PR merged) and a later step whose branch was cut from it has a linked
   worktree: `rebase_stack({ folder, missionId, stepId: <the later step>, onto: <the base
its PR now targets, usually the default branch>, from: <the merged parent's old branch
tip> })`. Pass `from` so a squash-merged parent's commits drop out. It rewrites a
   local branch and **never pushes** — say so in the log; publishing it is the owner's.
   On `REBASE_CONFLICT` the verb already put a blocker on the step and left the tree
   untouched: **do not retry**, `notify` the operator once, move on.
2. **A step is PR-ready and has no verifier yet → dispatch one.** PR-ready is
   `gates.pr: running` (open) **and** `gates.ci: green`, with the step's `verifier` gate
   not `green`. Skip it if a verifier was already sent for this PR state: the step
   carries a `session` link whose id is on a `dispatched` ledger row newer than the
   step's newest `ci` row. Otherwise:
   `create_session({ folder, role: 'verifier', prePrompt })` — `role: 'verifier'` is
   mandatory, the server refuses any other session — with a `prePrompt` that names the
   mission, the step and the PR and says "use the delivery-verifier skill and record the
   verdict with `mission_verify_step`, passing your own session id". Then
   `mission_link_child({ folder, missionId, stepId, link: { kind: 'session', ref:
<the new session id> } })`. Link it the same turn: the link is what lets Harnu tell a
   verifier from a stranger, and what keeps its owner from being parked. Never verify
   the step yourself: the verdict is the verifier's alone.
3. **A linked child is stalled → one nudge.** A child on a step reads `idle` or
   `needs-input` with no new commit or ledger row for longer than a beat: `message_session`
   it with the single next thing it should do, in one sentence. One message per child per
   tick; a `needs-input` child is waiting on the _operator_ — leave it, the `you` list
   already says so. `hibernated: true` is parked, not stalled.
4. **A duplicate is not news.** If the situation is the one the last `steward` Log entry
   already described and nothing in the ledger moved since, do nothing.

**Log every action.** After each move, `mission_log({ folder, missionId, kind: 'steward',
note })` — one or two lines: what you did **and why** ("dispatched verifier for #7 —
`pr: running`, `ci: green`, no verifier session linked"). Harnu also writes a bare
`steward` line for each write you make; yours carries the reasoning. Nothing to do?
Say so in one line in your reply and write nothing.

**Stop on refusal.** Any `STEWARD_*` refusal, `MISSION_CLOSED` or `SERVER_DISABLED` means
the operator closed, paused or switched you off: stop, do not work around it.

**Reply** with one line per move taken (or "nothing to do").

## Sweep mode (no steward)

Find delivery work that is **stalled or finished-but-parked** and tell the
operator, once, in a sentence they can act on. Nothing else.

## Why this exists, and what it honestly is

An orchestration's heartbeat is a loop inside a session, and that session is
mortal: Harnu parks it under memory pressure, the app closes, a compaction lands,
or the operator asks a question and the turn ends without re-arming. The loop
stopping is the normal failure, not the exotic one — and it is the one failure the
loop cannot report, because it is the thing that died.

You are the second layer. You run as a fresh unattended process on a timer, so you
outlive the session you are watching. That is your only structural advantage, and
you should spend it on exactly one thing: **making a silent stall loud.**

Be clear about your ceiling. Running in `observe` mode you are read-only by
allowlist — you cannot dispatch the shipper, move a card, write to a mission, or
wake the orchestrator (`message_session` and every mission write verb are denied
to you by name). You are a smoke alarm. The value is entirely in latency: a stall
the operator meets in thirty minutes instead of the next morning. Do not
editorialize about what you would fix if you could.

## What you can reach

`mission_list`, `mission_get`, `memory_read`, `memory_query`, `get_fleet`,
`get_session`, `list_worktrees`, `notify`, plus `Read`/`Grep`/`Glob`. You have
**no shell**: `Bash` is denied in `observe` mode, so there is no `git` and no
`gh`. Every git and PR fact you need is already in `mission_get`'s links (a
worktree's `exists`/`branch`/`head`, the PRs on its branch, a PR's `state`) and in
`list_worktrees` (each worktree's branch, head and a `dirty` flag for uncommitted changes).

You have **no subagents** (`Task` is denied) and **no memory of your last run**
beyond the one line the Scheduler can carry for you (see step 3). Keep the whole
tick cheap: the default worker timeout is 5 minutes, and a killed tick reports
nothing at all.

## The tick

### 1. Find the deliveries

`mission_list({ folder })`. Keep the missions whose `status` is `active`. Skip a
`delivered` one (its `you` line already asks the operator to close it) and a
`closed` one (the operator ended it). A mission written before v3 reads `active`
like any other — a dead one simply reads stale, and the recency rule in step 3
keeps it quiet. No active mission → **stop, say "nothing in flight",
notify nothing.** A quiet tick is the correct outcome
most of the time and costs the operator nothing; a chatty watchdog gets muted,
and a muted watchdog is worse than none.

For each active mission, `mission_get({ folder, missionId })`. That one read is
the whole state: the stored steps, links and blockers, plus what Harnu derives
live — `derived.progress` (where it is: "Step N of M", `done`, `verified`,
`leftBehind`, and each step's state in `states`), the stall flag, each linked
child's state, each linked worktree, card and PR resolved, and the `you` line.
**Read these fields; never re-derive them.** Name a unit in a notification by its
step title and say where the mission is the way the operator's pill does
("Step 3 of 5"); never count proven steps yourself. A `mission_list` row's
`progress` may be one poll old — use `mission_get`'s.
Do not rebuild a stall from Log timestamps and a guessed cadence, and do not
re-poll the fleet for children the projection already reports.

A goal file under `.harnu/goals/` whose frontmatter has no `mission:` line is a
delivery that has not become a Mission yet. Mention it as `not yet a Mission` in
the run result; do not grade it.

### 2. Read the findings off the projection

**A. The mission is stale.** `derived.stale` is `true`: an active mission with no
evidence for over an hour while none of its linked sessions is working. This is
the heartbeat-lapsed case, computed for you — deterministic, so it is a finding
on its own. Name the unit it points at: the current step
(`derived.progress.current`) whose state in `derived.progress.states` is
`waiting` or `todo` — no child working, no new commit or PR on its links.

**B. Pushed, clean, no PR.** A step's worktree link `exists` and
resolves a `head` commit on its branch, `list_worktrees` shows that worktree not
`dirty`, the link lists no PR, and no child on the step is
`working`. The unit is waiting on the orchestrator to dispatch the
shipper — an agent-dispatched session holds no Harnu verbs and never could have
opened that PR itself. This is the one that actually happens.

**C. The operator is the blocker.** An open blocker whose `owner` is `operator`,
or a child with `pendingApprovals` — the `you` line already says what is owed.
Raise it only together with A: a fresh approval request is the operator's to
notice in the Topbar, a stale mission waiting on one is worth a notification.

**D. The record disagrees with the world.** A step's card link reads `backlog` or
`ready` while its worktree has commits, or `in-progress` with no known child; a
child reported `known: false` whose worktree holds nothing. Report it as a
correction, not an emergency — manual dispatches never bind to their card, so
this drifts legitimately. `hibernated: true` is a parked session, not a vanished
one, and `status: "spawning"` from `get_session` means a dispatch is still
landing; neither is a finding.

### 3. Decide whether to speak

Silence is the default and it is not laziness — it is what keeps the alarm
credible. Speak only when a unit is stalled or parked in a way a human action
would resolve.

**Deduplicate on the mission's own state.** Every finding has a key that stays
the same for as long as the situation does and changes the moment it moves:

- stale → `<missionId>:stale@<derived.stall.lastEvidenceAt>`;
- pushed, no PR → `<missionId>/<stepId>:no-pr@<head sha>`;
- blocker → `<missionId>/<stepId or mission>:blocked@<the blocker's raisedAt>`;
- correction → `<missionId>/<stepId>:drift@<card status>`.

End your run result with one line, `seen: <key>, <key>, …`, listing every current
finding. When the worker carries its last result (the Scheduler prepends `Last
run: …` to your prompt), a finding whose key is already on the previous `seen:`
line is not news — stay quiet about it. New evidence moves `lastEvidenceAt` or the
head sha, so a stall that clears and comes back is a new key and speaks again.

No `Last run:` line (the worker does not carry its result) → you cannot know what
you said before. Then notify a stale mission only while its stall is young —
`derived.stall.lastEvidenceAt` less than two hours old — and say in the run result that
turning on "carry last result" would make the watchdog quieter.

You write to nothing. The old convention of appending a `## Watchdog` block to
the card is retired: the mission's state is the record, and editing a card in
`ready` would void its dispatch manifest stamp.

### 4. Notify — once, batched, actionable

At most **one** `notify` per tick, covering every new finding. Name the unit, the
state, and the specific next action. The reader is looking at a desktop
notification, not a report.

Good: `PROJ-231 parked — 4 commits pushed on PROJ-231-filters-modal, tree clean,
no PR, no live session. Needs the shipper dispatched.`

Good: `Mission t164-review-pane stale for 3h at Step 2 of 4 — step "U2 render"
has no working session and no new commit. Open the orchestrator to re-arm it.`

Bad: `A unit may require attention. Please review the delivery status.`

Where two or more units are parked, lead with the count and name the oldest:
`3 units parked — oldest is BUG-86 (pushed, no PR, 14h).`

Then print the same content as your run result, followed by the `seen:` line, so
the Scheduler's run record carries it too.

## Boundaries

- **Read-only about the work.** Never edit product code, never move a card, never
  write a mission, never dispatch anything. If a fix is obvious, the notification
  says what it is; you do not perform it.
- **Never re-notify a finding whose key is unchanged** since your last run.
- **Never raise a finding about a healthy unit** — in flight and progressing is
  not a stall, and neither is a hibernated session.
- **Never re-derive what `mission_get` computes** — the stall flag, the proofs,
  the child states. If the projection and the worktree listing disagree, the disagreement is the
  finding (D); do not pick a side.
