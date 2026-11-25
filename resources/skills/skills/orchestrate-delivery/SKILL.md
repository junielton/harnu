---
name: orchestrate-delivery
description: Plan an objective as a Harnu mission of milestones and steps, dispatch one session per step, have a second session settle every criterion, and hand the operator a report, for an objective too large for one session ("orchestrate this", "break this down and dispatch it", "deliver this epic") and never to implement one unit yourself, review a PR or merge
---

# Orchestrate delivery

Deliver an objective as a Harnu mission: plan it, dispatch one session per step, monitor until each step opens a
PR, have a second session settle every criterion from evidence, and give the operator a report they can act on
without reading a transcript. Load `../mission/references/writing-contract.md` before you write any title,
criterion, ask or blocker reason: the verbs refuse text over a cap and never rewrite it. If the `mission` skill is
not staged, the file is missing: write the shortest honest line.

## The rules

- 1 unit of work = 1 step = 1 branch = 1 session = 1 PR. Never mix units.
- Delivery is not "the PRs are open". It is every criterion settled, by a session that did not build the step, from
  evidence. Phase 4 is not optional.
- You lead the mission (the `mission` skill has the verbs and the tick). There is no steward: you, the leader,
  dispatch the verifiers, nudge a stalled worker and call `rebase_stack` after a parent lands.
- Never merge, never move a card to done, never write product code in this session. Never use, copy or link the
  operator's Claude credentials; a session that needs a login is a blocker for the operator.
- Every output stays short. Silence about healthy work is the feature.

## Phase 0 — Hydrate and triage

`memory_read` for this repo, then check the board for cards that overlap the objective: extend them, never
duplicate. Confirm a `WORKTREE.md` exists at the repo root; if not, that is a blocker before any worktree dispatch.

Name the door you came in by and take its first step; most doors never reach a spec. A vague idea starts with
`brainstorming`, a task or ticket with `scope-task` and the `mission` skill's intake rules, a bug with
`systematic-debugging` (a `bug` card with the repro as its criterion), a PR comment or red CI with `address-review`
or `debug-gh-action` (a commit on the existing branch, no spec), a design with `create-mockup` or `implement-design`,
a question with an answer in chat, "where did we leave off" with `harnu:status`.

**Size decides depth.** Small (one area, no new interface, a reviewer judges the PR at a glance) is one step and the
card's own criteria: no spec, no scout. Medium gets a one-page spec, large adds goals and open decisions, complex
adds a PRD and an ADR (`docs/specs/TEMPLATE.md` is the shape). A one-line bug and a PR comment never enter the funnel.

**The contract must be readable from a fresh worktree.** Every unit above small needs its criteria, spec, design
links and tracker link committed on the base branch. With no criteria, the first unit is a scout that writes them.
If the card's `spec`, `mockup`, `prd` or `adr` is a path under `.harnu/out/`, stop: that directory is gitignored and
no child worktree can read it. Landing the bundle is **commit 0**, a unit with its own card, worktree, session and
owner; nothing else dispatches until it is on the base branch. Already committed: say so in one line and skip it.

A resolved open decision is one line in memory: `memory_append` (`decisions`) `D-n · <question> · chosen: <option> ·
<date>`, and a row in the spec's Amendments table. The rationale stays in the spec.

## Phase 1 — Plan

Break the objective into units and say the topology in one line each: **single** if it fits one reviewable PR (about
500 lines) or the parts touch the same files, **parallel** if units share no files and no code (check with grep over
each unit's paths, not intuition), **stacked** if unit N+1 consumes code from unit N. Ask only on genuine scope
ambiguity, one binary question: a question costs a round-trip of wall-clock, a slightly wrong dispatch costs a rebase.

**Create the mission now, without asking.** `mission_list { folder }` first: when one already holds this work,
join it, never open a second. Then `mission_create`, with the whole plan in one call:

```json
{
  "folder": "<absolute path of the repo>",
  "title": "Serve the catalog from the new storefront",
  "doneWhen": "Catalog pages render from the new stack on main",
  "milestones": [
    { "title": "Images load from the CDN" },
    { "title": "Pages render from templates" }
  ],
  "steps": [
    {
      "title": "Upload every image to the CDN",
      "milestone": "Images load from the CDN",
      "criteria": [
        { "text": "Every catalog image resolves on the CDN", "by": "session" },
        { "text": "The upload ran from a clean checkout", "by": "session" }
      ]
    },
    {
      "title": "Render a page from its template",
      "milestone": "Pages render from templates",
      "criteria": ["The product page renders with no console errors"]
    }
  ],
  "sessionId": "<your session id>"
}
```

- **A stage of the objective is a milestone**, named for what becomes true. A mission of a handful of steps needs
  none. `mission_create` takes the milestone's title; `mission_add_step` takes its id (`mls-<n>`), so add the
  milestone first with `mission_add_milestone`, then its steps. Plan the next milestone to steps when the one before
  is settled, with what you learned in it: a plan for stage 9 written on day one is a guess the operator reads as a
  promise. The plan only grows; you never remove or rewrite a step.
- **1 unit = 1 PR = 1 step.** Sub-phases (spec, implement, review, ship) go to the Log, not into steps. A step added
  after work started needs a `reason`. Something found on the way is an optional step.
- **Every step carries at least one criterion**: a fact that is true when it is done, at most 70 characters. `by`
  says who settles it: `fact` (Harnu reads it: `pr-opened`, `ci-green`, `pr-merged`, `main-green`), `session` (a
  second session, the default), `operator` or `person`. **A sign-off is an operator criterion (`by: 'operator'`),
  never a step.** Add one later with `mission_add_ac`. A stage that gates the next on the operator's own act (a merge
  and a build, a credential) is a blocker raised when you reach it (`mission_set_blocker`, `owner: 'operator'`), and
  the plan says so now, in one line.
- **The last step is "Check the whole mission against Done when"**, with a second session criterion. It lives in the
  last milestone and stays last: create it with the plan, and insert every step added later before it (`afterStepId`
  names the step it follows). It is a convention, not an engine rule: the operator confirms Done when at the close.
- **Criteria are frozen at dispatch.** A criterion is never edited after dispatch: a change is a new criterion with
  the reason in `mission_log`. A criterion the spec lacks is a spec gap: amend the spec, never the card alone.
- **The Done when is the operator's words.** Propose it in the same call. When they change it, call
  `mission_set_done_when` in the same turn with their words as the `reason`; the operator confirms the new text in the Mission dropdown.
- Put the plan in one chat message (units, topology, Done when) and dispatch. Authorization to orchestrate is
  authorization to dispatch: there is no second approval to collect.

**Integration branch, whenever the delivery needs more than one PR.** Cut `feat/<epic>` from the default branch
before the first dispatch, with the spec bundle committed on it, and make it the base of every unit (parallel units
fork from it, stacked units from their predecessor). Unit PRs merge into it, it goes to staging, and `feat/<epic>` to
main is one final PR whose body is the report. Freeze the base SHA per wave, serialize merges into it and run the
suite after each. A hub file several units need (types, routes, i18n bundles) is its own unit, first in the wave.
About one agent PR in four conflicts: rebasing is a planned step. One PR total: no integration branch.

### The spec-born mission

`harnu:spec` opens a mission the moment an entry leaves small: an "Approve spec" step with an operator criterion and
the spec linked to the mission as a `doc` link. One mission per body of work: you adopt that one and never open a
second.

1. **Find it.** `mission_list { folder }`, then `mission_get` on each open row until one's `links` name the spec. Two
   name it: ask the operator which, in one question. This session leads it: go on. Another session leads it: ask to
   join with `mission_attach`, then ask the operator for the hand-off in one line plus one `mission_log`; until they
   allow it every other verb is refused `NOT_ATTACHED`.
2. **Add one step per slice** with `mission_add_step`, in the spec's slice order: the title is the slice's title as a
   verb phrase of at most 50 characters (an id like `S-2` is refused at either edge of a title), the `milestone` is
   the id the slice belongs to, a `reason` names the spec, and the criteria are short facts, one per spec AC. The card
   keeps the spec's AC lines verbatim. Keep every `stepId`: the slice to step map is what Phase 2 dispatches with.

```json
{
  "folder": "<absolute path of the repo>",
  "missionId": "<mnt-… of the spec-born mission>",
  "title": "<the slice's title as a verb phrase>",
  "milestone": "<mls-… of the slice's stage>",
  "criteria": ["<one short fact per spec AC, true when the slice is done>"],
  "reason": "Slice S-n of <spec path>, added at dispatch",
  "sessionId": "<your session id>"
}
```

With no mission naming the spec (`harnu:spec` is off, or the spec was written by hand), create it as above and link
the spec with `mission_link { link: { kind: 'doc', ref: '<spec path>' } }`.

## Phase 2 — Cards and dispatch

Per unit, write a complete delegation packet and dispatch it by ONE of two paths, never both. **`create_session`**
creates the step's card itself, so the packet is its `prePrompt` and you create no card first: `create_card` cannot
stamp a step, so a card you made would become a second card for the step. **`submit_manifest` binds a card you made**:
`create_card` (kind, complexity, `substrate: "worktree"`) with the packet as its body, `move_card` to `ready`, and the
step on its manifest entry. Cards from a spec (below) always take the second path. A packet an executor can misread
is your defect, not theirs.

- **Objective** and the done criterion for the unit.
- **Acceptance criteria with ids and a verification mode**, one line each:
  `- [ ] AC-1 #a1b2 — <observable behavior> — verify: test|visual|manual|review — source: <spec §, design node, ticket id>`.
  Write them from the spec or the tracker, never from imagination, and keep the ids stable: evidence and the report
  key on them. **With a spec, the block is derived, not retyped:** the spec's id verbatim, its statement and `proof` as
  written, plus a content hash, `#` and the first four hex characters of the sha256 of `<statement> | <proof>` with
  runs of whitespace collapsed
  (`printf '%s' "$text" | sha256sum | cut -c1-4`), so the line reads `AC-3 #a1b2`. Inventing an AC id the spec lacks
  is forbidden: the verifier reads it as a criterion nobody agreed to. Card-only criteria stay unhashed.
- **Provisional criteria.** Ones you wrote yourself, because the objective arrived with none, are tagged
  `provisional`, the block opens with what you derived them from, and you `notify` the operator once at dispatch:
  you are proposing a definition of done and it is theirs to correct. A `met` on one reads "met the bar I proposed".
  Never promote one to non-provisional because it passed.
- **Honest exit clause**, verbatim: "If an AC cannot be satisfied — the spec is contradictory, the data does not
  exist, an answer is missing — report it as `AC-n: unmet` with the reason, or `blocked` with the question. Never
  quietly drop an AC, never weaken a test to make one pass, never edit an acceptance criterion to match what you
  built."
- **Scope boundary.** With a spec, paste the slice's `files-may-touch` line verbatim; a slice without one goes back to
  the spec. Out of scope means no refactors, no abstractions, no dependency changes beyond the unit.
- **Context pointers**: files to read first, memory pages, prior decisions. **Git conventions**: point at the repo's
  own conventions doc, never restate it.
- **The repo's method, as steps.** Read `CLAUDE.md`, the conventions doc and the lessons, and write the method as
  things to do: "the first commit is the failing test for AC-n and your report states the red to green transition".
  A repo that states no method gets none invented. **A proof must fail against the code it replaces:** the
  executor plants a fault first, shows the test red, then makes it green, and never rewrites a committed red test
  after it is green: it adds to it.
- **Visual proof.** A unit that changes rendered UI is looked at before it reports done: start the app, open every
  affected route named in the packet with the Chrome tools, attach the capture to the card (`update_card { images }`).
  A diff reads correctly line by line and the page can still be broken. A UI unit's packet names its skills:
  `/dtk:implement-design` and `/dtk:dsqa` for a Figma contract, `/dtk:implement-mockup` and `/dtk:mockup-qa` for a
  mockup. Name them, never restate their steps.
- **Exit sequence.** The executor ends at commit, push, a clean tree and `.harnu/REPORT.md`. It never invokes
  `ship`: the session that wrote the code is the worst reviewer of it. **You dispatch the shipper**, in the same
  worktree, only once the executor reported a clean tree (two sessions in one worktree share the index). A
  dispatched session holds only its step's scoped verbs (`mission_get`, `mission_link`, `mission_log`,
  `mission_set_blocker`), never `create_session`: a packet that says "then spawn the shipper" is an instruction it can
  only fail. The shipper merges `origin/main` into its branch before it opens the PR, and never rebase a pushed branch.
- **Report format**: branch, head sha, one-line summary, each AC met, unmet or blocked with its evidence, the files
  touched outside the scope boundary (or none), unresolved findings. The executor never reports a PR URL.
- **Return address.** The packet carries your stable session id (`owner session <uuid>`), your current name (call
  `ListAgents` once before writing; its first line states it; a UUID is not a SendMessage address) and the `mission`
  skill's child-reporting rules, verbatim: resolve the leader's name with `ListAgents` right before every send; open
  every report with `Report for session <owner uuid> · mission <missionId> · step <stepId>`; never broadcast, and if
  the send fails the report stays in the file. **Write `.harnu/REPORT.md` first, always, then send:** the file is what
  your next tick reads, the message only makes the tick happen sooner. When your name changes, tell each live child.
- **A change of instructions goes to a dispatched session as a delta file the message names** (`S-n-delta-k.md`),
  never only in a message: a relayed message is not an instruction the child can check.

### Cards from a spec — the derive planner

When the units are a spec's slices, the cards come from the planner `harnu:spec` stages beside this skill, not from
your hand. It is the sibling `../spec/scripts/spec-derive.mjs` of this skill's base directory: a dependency-free Node
script that reads the spec and the board, prints a plan and writes nothing.

1. **Write the board file**: one entry per card file in the main checkout's `.harnu/memory/roadmap/` with `slug`,
   `status`, `title`, `spec` (when its frontmatter has one) and `body`, as a JSON array in
   `.harnu/out/<delivery>/board.json`.
2. **Run the planner** from the repo root. It prints `{ create, update, skip, refuse }` and exits 1 when `refuse` is
   not empty:

   ```sh
   node <this skill's base directory>/../spec/scripts/spec-derive.mjs <spec-path> --board .harnu/out/<delivery>/board.json
   ```

3. **Execute the plan**, entry by entry:
   - `create`: one `create_card` per entry, its `title`, the spec path as `spec`, and a body that opens with the
     `spec-slice: S-n` marker line, then the entry's `block` verbatim, then your envelope (objective, return address,
     exit sequence, method, honest exit clause). Every card carries the marker.
   - `update`: `update_card` has no splice. Take the card's body, replace only the span between the markers
     `<!-- spec:begin S-n -->` and `<!-- spec:end S-n -->`, both included, with the entry's `block`, keep every other
     byte, send the whole result as `replaceBody`. A ticked box survives. Send the executor the delta (a file).
   - `skip`: nothing to write. A card past `ready` belongs to its executor; an `orphan` is a card whose slice the spec
     dropped: tell the operator, never delete it.
   - `refuse`: that slice goes back to the spec with the reason; the others go on. Never hand-write its card.

   The envelope is yours and the planner never touches it; the block is the planner's, never retype it. A second run
   over the board you just wrote prints an empty plan; anything else is a defect to report.

4. **Hand the card map to the wave's bookkeeping unit (D-3).** The marker alone lets the next run match every card.
   The spec records the map as `card` rows of its Amendments table (`S-n → <card slug>`), but a promoted orchestrator
   cannot edit the spec: its guard stops writes outside `.harnu/` and the scratchpad. List the `card` rows, and the
   wave's D-n resolutions, in the packet of one docs-only card per wave scoped to the spec file.

```json
{
  "folder": "<absolute path of the repo>",
  "title": "<the create entry's title: S-n · slice title>",
  "kind": "feature",
  "complexity": "standard",
  "substrate": "worktree",
  "spec": "<spec-path>",
  "body": "spec-slice: S-n\n\n<block>\n\n<envelope: objective, return address, exit sequence, method, honest exit clause>"
}
```

```json
{
  "folder": "<absolute path of the repo>",
  "slug": "<the update entry's slug>",
  "replaceBody": "<the card body with only the marked span swapped for the entry's block>"
}
```

With `harnu:spec` switched off the sibling is not staged: keep the hand derivation above, say in one line that
the derive planner was unavailable, and still write the `spec-slice: S-n` marker on each card.

### Open decisions become operator blockers

A spec can reach dispatch with open rows in its Open decisions table. Each open D-n that gates a slice is an operator
blocker on exactly the steps of the slices whose `gated-by:` names it:

- For each gated step, one `mission_set_blocker` (the `reason` names the spec path, the question and the options, the
  row's options cell split at `;`):

  ```json
  {
    "folder": "<absolute path of the repo>",
    "missionId": "<mnt-… of the mission>",
    "stepId": "<stp-… of a gated slice>",
    "reason": "<spec path> leaves open <D-n>: <question> Options: <option 1> or <option 2>",
    "ask": "Choose <D-n>, then say done",
    "unblocks": "<the gated slice's title>",
    "owner": "operator",
    "sessionId": "<your session id>"
  }
  ```

- A D-n that gates no slice gets no blocker: it is a question for `harnu:one-by-one`. A resolved row gates nothing.
- The slices no open D-n gates are dispatched now. A gated slice's card is created all the same and waits in the
  backlog.
- The choice is the operator's, and so is clearing an operator-owned blocker (they say "Done, continue" in the Mission
  dropdown). When they have, record the choice with `mission_log { kind: 'decision', stepId }`, run the planner again if
  it changed an AC, and send the held slices out with `submit_manifest`.

### Dispatching

**One unit, no card of yours.** `create_session` with `missionId` and `stepId` (the packet as `prePrompt`, a model
hint in `bootOverride`): Harnu creates the step's card, attaches the new session as its worker with a credential
scoped to that step, and links it. The ACK carries `card` and `worker`; a `bindError` means the session still runs and the binding
failed, so fix it with `mission_link`. A step you do yourself is never dispatched, so it never gets a card.

**Parallel units, or any card you made.** Move the cards to `ready` (`move_card`), then submit ONE batch with
`submit_manifest`, each card entry carrying `missionId` and `stepId`, in drain order (a batch of one is fine). The drain cuts one worktree per card, respects the
board's WIP ceiling and bases on the default branch: with an integration branch, dispatch manually
(`create_worktree { base: "feat/<epic>" }`, then `create_session`) or retarget each PR with
`gh pr edit <n> --base feat/<epic>`, and say which.

**Stacked units.** Stack each unit on the previous branch: `create_worktree` with `base` set to the previous unit's
branch (verify with `git merge-base`), then `create_session` into it. Do not wait for a merge unless a runtime
dependency needs one: a unit that needs the earlier code to run in Harnu waits, one that only reads it does not.
Before the merge handoff, retarget every stacked PR whose base landed: `gh pr edit <n> --base <default branch>`, then
`gh pr view <n> --json baseRefName`.

Model and effort per card are hints: the operator's routing table decides what launches (`dispatched-with:` on the
card says what ran). A mutating verb that comes back as a confirm ("Ask before agent actions") is covered once by
`plan_mission` for the whole fan-out.

### Done conditions — checkable by the worker alone

Every done condition in a packet or a boot template is something the worker verifies from its own worktree:

- **Executor:** commits pushed (`git rev-list --count <base>..HEAD` > 0), tree clean (`git status --porcelain`
  empty), `.harnu/REPORT.md` written.
- **Shipper:** PR open, CI green, `.harnu/REPORT-ship.md` written. **Lander:** every PR handed back `ready`,
  `awaiting-reviewer` or `blocked-<why>`, branches pushed, tree clean, `.harnu/REPORT-land.md` written.
  **Reviewer:** the review in `.harnu/REPORT-review.md`.

**Never make "a message was delivered to another session" a done condition**, in a packet or a Stop hook: the worker
cannot make it true when the recipient is parked, renamed or gone, and the Stop hook then re-prompts it forever. The
message is a courtesy, the file is the deliverable.

### Boot templates by role

**Paste a template; never paraphrase it**, and fill only the `<…>` slots: a re-worded boot prompt can drop an
override, a done condition or the return address. Cite a skill by name, never restate its steps. Every template ends
with the return address and this exit line: write the report file, then send; owner unreachable, the file only.

- **Executor:** the delegation packet above, in full. It never invokes `ship`.
- **Shipper**, dispatched into the executor's worktree once the tree is clean and pushed:

  ```
  Invoke `/dtk:ship` with these overrides:
  - base branch: <base per the topology>
  - merge `origin/main` into the branch before opening the PR; never rebase a pushed branch
  - open the PR only, never merge
  - skip the notify step, the orchestrator reports centrally
  Done = PR open + CI green + `.harnu/REPORT-ship.md` written.
  After you report, touch this worktree no further.
  <return address> <exit line>
  ```

- **Lander**, for the closing phase, into a fresh worktree:

  ```
  Invoke `land-prs` on: <PR numbers, in landing order>.
  Target: <the branch the Done when names>. Merge policy: <the Done when's words on merging, verbatim>.
  Done = every PR handed back ready, awaiting-reviewer or blocked-<why>, branches pushed, tree clean,
  `.harnu/REPORT-land.md` written.
  <return address> <exit line>
  ```

- **Reviewer**, for a cold code review beyond Phase 4:

  ```
  Invoke `/dtk:review-peer` on PR #<n>. Post nothing to the PR.
  Done = findings written to `.harnu/REPORT-review.md`.
  <return address> <exit line>
  ```

## Phase 3 — Monitor

**Arm the ticks yourself, before you report the dispatch**: a loop over the `mission` skill, self-paced, stopped when
the mission closes. Every tick prompt you arm starts with the one fixed first line the `mission` skill defines (see
"The tick prompt's first line" there), naming this mission, then free text. Code parses that line: never reshape it.

No dispatched step may exist without a live heartbeat over it. On `MISSION_CLOSED`, stop the loop and report: the
operator ended the mission, and you never open a replacement. The loop dies in ordinary ways (parked under memory
pressure, the app closed, a compaction, a turn that ended without re-arming), so keep three layers:

1. **A push subscription per worker, taken at dispatch:** `SendMessage { to: "<name from ListAgents>",
notify_when_idle: true }` with no message. One `[Cross-session idle notice]` arrives when it goes idle or exits;
   that is your cue to spawn a tick subagent. Never poll `ListAgents` or ask workers whether they are done. The
   notice can lapse, never lie: re-take it rather than raising the tick rate.
2. **The loop**, a backstop with slow ticks, since arrival is pushed to you.
3. **A watchdog on the Scheduler:** a worker in `observe` mode on this repo's folder with the prompt
   `/harnu:delivery-watchdog`, about 30 minutes, "carry last result" on. It is a smoke alarm, not a sprinkler: it
   reads the missions, can `notify` and nothing else, and outlives this session. Log the cadence and the worker (or
   `none`, and why) with `mission_log`.

### Every tick runs in a fresh subagent

Your context grows per tick, so you never read a `mission_get` or `get_fleet` dump yourself. Every tick, verification
read and child report is handled by a **fresh general-purpose subagent** (the `Agent` tool, never `subagent_type:
"fork"`, which inherits your whole transcript), at most one per mission at a time. Pass your real session id (the UUID
that ends your scratchpad path: a subagent's own `agent-<…>` id is never a `sessionId`) and your current name. Prompt
template, slots only:

```
You are running ONE coordination tick for the Harnu mission <missionId> on behalf of its leader, session
<leaderSessionId> (native name: <leaderName>). You are a subagent, not the leader: pass sessionId =
<leaderSessionId> on every verb that takes one, never your own id.
Folder: <folder>. Trigger: <loop firing | idle notice from session <childId>>.

Read mission_get({ folder, missionId, sessionId }) and nothing else for state: no get_fleet, no gh pr view.
Run the tick the `mission` skill defines, with the leader's rules from `orchestrate-delivery`. You may link, log,
raise and clear agent blockers, add an optional step for a red gate, dispatch a shipper or a `role: 'verifier'`
session, nudge a stalled child with message_session, and call rebase_stack after a parent lands. You may not end or
close a mission, merge, write product code, move a card to done, or re-dispatch a child that is not proven dead.
Put <leaderSessionId> and <leaderName> in every packet. On MISSION_CLOSED stop and say so.

Return ONLY this, at most 15 lines:
tick · <missionId> · <time>
progress: <progress.headline>
waiting: <next, and the count behind it>
did: <one clause per action, or "nothing">
children: <step: session8 state, only those that changed>
subscribe: <child session id · native name, per child you dispatched, or none>
verify: <step awaiting a verifier, or none>
owner-must: <what only the leader can do, or none>
next: <suggested interval in seconds and why>
```

What you do with the summary: `subscribe:` take the idle subscription for each child (a subagent cannot take yours);
`verify:` dispatch the verification (Phase 4) and never read the diff yourself; `owner-must:` do exactly that, then
re-arm at `next:`. Report the `tick —` line from `progress:` and `waiting:`. A summary that is missing, malformed or
longer than 15 lines is a failed tick: spawn it again with the defect named in one line.

**What a tick covers:**

- Each worker's state from `sessions` and the step's `state`: `hibernated: true` is not death and not a stall, and a
  spawn can be in flight (`get_session` says `spawning`). Never dispatch a replacement over a session not proven dead:
  two in one worktree corrupt each other.
- A PR for a step no link names yet: link it (`mission_link`); on unit N's PR, start the next stacked unit.
- Verify by evidence, never by a worker's own account. A wrong result goes back to the SAME worker with a delta file,
  not a redo. A worker that reports done with no commit goes back with that exact finding: never commit for it.
- **Ship handoff, the step you own.** A step with pushed commits, a clean tree and no open PR waits on you: dispatch
  the shipper on the tick that finds it. A step stuck between push and PR is your defect.
- After review changes or a squash-merge of unit N, tell unit N+1's worker to merge the new tip, or call
  `rebase_stack` for the step's own worktree: it never pushes (publishing the rewrite is yours), never touches
  another branch or the main checkout, and on a conflict aborts and writes nothing, so raise the blocker yourself and
  do not retry.
- A worker idle with no commit, PR or log line since the last tick: nudge it once with `message_session`; after a
  second check about 10 minutes later, raise a blocker on the step and stop insisting.

**Dispatch bias.** A step that can run is dispatched on the tick that finds it. A step may sit undispatched only when
it is blocked on something you cannot resolve: an unmerged dependency, a missing spec, a named unanswered question.
"It came up later" and "it wasn't in the plan" are not blockers. A step born mid-delivery (a split, a deferred fix, a
reviewer's follow-up) enters the same pipeline: `mission_add_step`, card, packet, dispatch. Before each report, walk
the steps you are not running and say, per step, `dispatched` or `blocked on <the specific thing>`; if you cannot
name the thing, dispatch now.

**A wave that ends at a human pause** (a merge and a build before the next stage can branch) does not end the
session. Leave the mission, the board and the links true, `memory_append` what the next stage needs, raise
`mission_set_blocker { owner: 'operator' }` naming the exact act and the event that clears it, and keep the loop
armed slowly. **A turn that ends waiting on the operator raises that blocker first**: a line in the transcript
reaches nobody who is away. `mission_clear_blocker` clears your own the turn you see them resolved; an
operator-owned one is the operator's to clear.

**Every turn is a possible resume**, an operator question and the turn after a compaction included. When you are not
certain the loop is armed, spawn a tick subagent to re-derive state from the world (`mission_get`, the board, git
per worktree), do the missed work before reporting it, and re-arm with the same first line. Answering without
re-arming is the defect.

## Hand-off

Only the operator starts a hand-off. The leader never switches itself, whatever its context
says. A session near its context limit asks the operator for one: one line in its reply and one `mission_log` note,
nothing else. The app has no hand-off button for now, so nothing starts one on its own; if the operator decides on one, Harnu starts a fresh session whose first prompt is the mission summary, and the old one
is released, not killed. A fresh session starts from the summary: it reads `mission_get` and carries on, and no
resume prompt is ever pasted, by you or by the operator. Another session that only wants to help uses
`mission_attach` and joins as a worker, never as the leader.

## Phase 4 — Verify each unit, per criterion

The moment a unit's PR is open, verify it: do not wait for the wave. Use the `delivery-verifier` skill. Two rules from
it: the grader never reads the worker's report, and each criterion is judged on its own.

You dispatch, you do not read. For each step with an open PR, spawn a fresh general-purpose subagent (never a fork),
or `create_session` with `role: 'verifier'`, `missionId` and `stepId` when the unit needs a browser or a long run.
That session is attached with a credential that also holds `mission_settle_ac`, gets no card and is not linked to the
step as a builder. Give it the step, the PR, the spec path, and your session id and name. It reads only the blind
packet and returns at most 15 lines: a verdict per criterion with its evidence pointer, what it recorded, and the open
items. What it does:

- run the deterministic checks first: commits beyond the base, a clean tree, the PR base is the intended branch, CI
  green, tests ran after the last commit, the diff inside the scope boundary, acceptance tests not edited;
- **put its evidence in the exact folder `.harnu/evidence/<missionId>/<stepId>`, with a README that says what each
  file shows**: its commands re-run at the PR head in a clean worktree, the output, screenshots and console. A folder
  with another name is evidence nobody finds;
- **plant a fault against the code the proof replaces and show the proof red**: a test that passes before the change
  proves nothing;
- settle each `by: session` criterion with `mission_settle_ac { stepId, criterionId, evidence }`, from a session that
  did not build the step: a builder's own check is labelled a self-check and never proof;
- **a visual sign-off is its own operator criterion.** Settle the machine criteria with their evidence and
  leave the sign-off to the operator, who ticks it in the Mission dropdown, instead of leaving the whole step open.
- `unmet` goes back to the SAME worker as a delta file, re-verify only that criterion, twice unmet is the operator's
  decision, not a third attempt. `blocked` is a blocker next to the criterion it holds. Move the finished card to
  `review` with the PR URL, never to `done`.

When every step is settled, one more verification subagent gathers the evidence for "Check the whole mission against
Done when" and settles it. Read `waiting` on `mission_get`: an item of kind `settle` or `review` is still open. Then
`mission_request_close`. It is refused `STEPS_OPEN` while a required step is not done, it never closes, and adding a
step afterwards clears it. The operator closes. Open matters (an unticked operator criterion, an optional step left)
are warnings they see at the close, so name them in your report.

**Closing on main.** When the Done when says the work lands on the default branch, the last stretch is a merge
train and it is not yours: dispatch ONE session with the lander template, listing the PRs in landing order and the
Done when's merge words verbatim. Read `.harnu/REPORT-land.md` on the tick that finds it idle, raise an operator
blocker for every PR it hands back `blocked-<why>` or `awaiting-reviewer`, and verify "on main" from the merged state
of the default branch, not from the lander's report.

## Phase 5 — Delivery report

After each wave, and when the feature is complete, write the Delivery Report (the format is in `delivery-verifier`)
from the cards and the evidence, never from memory. Per unit and for the whole: where we are against the plan, which
criteria are settled, **which ones the operator must open the app and check** (the manual-QA handoff), what is unmet
and went back, open questions, tech debt raised. `open_file` it, and paste it into the `feat/<epic>` PR body. With a
tracker connected, tick only the criteria a second session or a person settled, never a worker's self-check, and post
one comment per ticket with the PR link: these N are done, these K you confirm yourself, these J are not, and why.

**Retro: what the delivery taught you about the pipeline.** Where did a unit wait on nothing (the gaps between
"pushed and clean" and "PR open", and "PR open" and "settled" are your latency, in wall-clock)? What did a packet
instruct that could not be done? Which verbs refused, and was it a rule you should have known? `memory_append`
(`decisions`, dated), and when the defect is in this skill's templates, raise a card against the skill.

## Boundaries

- Open PRs only. The merge train belongs to the lander. Never move a card to done.
- Never write product code, run builds or commit in this session: delegate. A promoted orchestrator is stopped by
  Harnu's guard.
- Do not touch branches, worktrees or cards this orchestration did not create. One manifest covers that batch: new
  cards need a new manifest.
- A `next:` or `waiting` line that names work you could have dispatched yourself is a defect, not information.
- Never edit a criterion to match what was built. A wrong spec is a finding for the operator, not a silent fix.

## Final output

End the run with a `report-back` final report: that skill owns the format, headed by the `status` skill's glance card
built from `mission_get`, the board and `gh pr list`. Never print two ledgers. The card's headline is
`progress.headline` as `mission_get` returns it, never a count you made. The rail's rows, each with a concrete outcome:

- `Topology`: single, parallel xN or stacked xN, and the integration branch (or why none)
- `Plan`: the milestones and steps, and the Done when
- `Heartbeat`: the loop at its cadence and the watchdog worker (or why none)
- one row per unit, `<card-slug> (branch)`: the one-line summary, `PR #n`, and `criteria n/m settled, k wait on you`
- `Review findings`: N found, M fixed, the rest noted on the PRs
- `Delivery report`: the path, and how many criteria are ticked and how many are left for a manual check

A unit with an unmet criterion, a blocker or open debt takes `!` or `✗` on its own row; what only the operator can do
goes on the `you` line, and an unanswered question on `open`. Full PR URLs live in the links block only.
