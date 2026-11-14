---
status: approved
tier: complex
prd: docs/prds/T703-missions-v4.md
adr: docs/adr/0025-missions-v4-one-model-supersedes-campaigns-and-stewards.md
mockup: docs/design/missions-v4/
---

# Missions v4: one Mission → Milestone → Step model, shown in a Mission pane beside the session

## Problem

Missions and Campaigns grew in layers (goal files, Mission v1 to v3, Campaign chapters 1 to 6, the steward, the merge batch). Each layer added states, lists and surfaces and retired none. The operator opens the popover to find calm and leaves stressed. Measured on `main` at `fa5feba6` (2026-11-14):

| What                      | Today                                                                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| State vocabularies        | 6: stored status (5 values, 3 written), proof plus verdict, 7 step states, 5 gates times 5 states, 5 chapter states, 7 pill states                                                    |
| "What waits on you" lists | 3 that disagree: the server list (10 kinds), the popover (adds decide and merge-batch rows), the Activity cue and the sidebar chip (ignore both)                                      |
| The pill                  | Mixes two missions: the campaign's current chapter next to the owned mission's step ("Ch. 9/12 · Step 2/4"); up to 4 numbers and 12 ticks in 18 px                                    |
| Where the domain lives    | About 3,900 of the 7,884 lines of `src/main/mcp/tool-handlers.ts`; the IPC, the companion, Your move and the steward import it from there                                             |
| Reads                     | Have side effects: a derive appends ledger rows and can wake the steward, so the 20-second UI poll starts steward ticks                                                               |
| Ledger                    | Split between the mission file and a machine-local `userData` cache; the close-out consolidator sees half of it                                                                       |
| Surfaces                  | 14 (pill, 3 popovers, map takeover, chip, end dialog, steward dialog, merge dialog, review dialog, bulk close, Activity entry, Your move button, Stewards block); 5 are dead ends     |
| Agent side                | 22 verbs (46,000 characters of catalog), 14 skills of which 11 name a mission verb, 30 percent of the awareness doc (about 6,900 words) and 35 percent of the agent-control user page |
| Sessions                  | A session Harnu spawned holds no Harnu verbs (BUG-253), so a step's own session cannot attach, link or settle; any session may write to any mission in the repo                       |
| Hand-off                  | Forbidden in three places (orchestrate-delivery, the mission skill, the awareness doc)                                                                                                |
| Step and card             | Two trackers: the mission's steps and the board's cards; `roadmap-core.ts` knows nothing of missions and criteria are free Markdown in a card body                                    |

The operator's decisions of 2026-11-13 and 2026-11-14, one atom per decision, plus the three constraints the delivery adds:

- R-1 Rethink from the concept, borrowing from project management: one hierarchy, tasks unified with the board, one state flow, one queue of what waits on the operator.
- R-2 The hierarchy is Mission → Milestone → Step; a step is the board card (one pull request); Campaign and Chapter go away.
- R-3 Acceptance criteria live on the step, each settled by an automatic fact, a second session or the operator; the mission keeps its own "Done when"; a milestone has none.
- R-4 The merge batch is removed entirely.
- R-5 No popover: the Topbar pill stays and toggles a Mission pane in the helper stack.
- R-6 The pane follows the selected session and shows only that session's mission; the folder's open missions are listed only in the "no mission" state, as an attach picker.
- R-7 Glance first: the pane reads as "I did this, so this, there is this, and this is the next step"; no long "Done when" paragraph; the task count sits inside the progress bar.
- R-8 A tree with chevrons, milestone then step then criteria; only the current milestone opens by itself.
- R-9 The mission is durable and the session is disposable: the mission keeps its plan, brief, history and the list of sessions that worked on it (role, from and to, where each stopped); a fresh session continues from the brief.
- R-10 Attaching a session to a mission needs confirmation; a session only sees and touches the mission it is attached to.
- R-11 The operator always decides a hand-off; Harnu may notice and offer and never switches sessions by itself.
- R-12 The pane is the only surface: no kanban full view of a mission and no cross-mission "My work" queue.
- R-13 A vertical line joins the milestone glyphs (green past a done milestone) and runs through an open milestone's steps.
- R-14 Mission text follows a writing contract: a tired reader, several sessions, no context from the session that wrote it.
- R-15 The Campaign map is removed; the pane replaces its tiles, "You are here", You ledger and focus panel.
- R-16 Scope for now is one orchestrator at a time; parallel work is steps in parallel inside the current milestone, each with its own worktree and session; milestones are planned in order.
- R-17 Parallel work shows in the milestone summary ("4 running · 9 waiting for review · 1 blocked"); inside a milestone the order is what needs the operator, then what runs now, then the rest collapsed.
- R-18 A step receives links from its session: the pull request, and the address of the finished page.
- R-19 A small task is a mission with no milestones; its steps sit directly on the timeline.
- R-20 `scope-task` pulls a task's acceptance criteria and links into the mission.
- R-21 A fourth way to settle a criterion is another person (a QA analyst, a designer); the operator marks it when the person approves and Harnu does not watch the tracker.
- R-22 The mission pane is proactive: when a session shows intent or work that will clearly take several steps, the mission, its steps and the next step appear without being asked for.
- R-23 Missions and campaigns written by the current version stay readable, are never rewritten in place without keeping the original, and a campaign that is mid-flight keeps going.
- R-24 The agent side (verbs, skills, awareness doc, user docs) speaks the same model.
- R-25 The domain leaves the MCP handlers: one module, a read with no side effects, one server-owned waiting list.

The research behind this spec (a diagnosis, four maps of the current code, UI, history and agent side, and the operator's decision record) is kept outside the repository. Everything a slice needs from it is restated here, with `file:line` pointers kept only where they are stable.

## Goals

- G-1 The operator reads one pane beside the session and knows where the mission is, what is done, what is left and what waits on them, in one glance.
- G-2 One model: Mission, optional Milestone, Step, with acceptance criteria on the step and one state vocabulary.
- G-3 What a fact can settle is settled by the fact; nobody ticks what Harnu can see.
- G-4 A mission outlives its sessions: a fresh session continues from the summary, and the operator decides when.
- G-5 Agents write short, plain mission text because the verbs refuse anything else.
- G-6 The agent side is smaller: 16 verbs instead of 22, an awareness section under 2,000 words instead of about 6,900, skills that say the same thing the pane shows.
- G-7 Every record written by the current version still opens, with the original kept.

**Non-goals:**

- NG-1 No kanban view of a mission and no cross-mission "My work" queue (R-12).
- NG-2 No several orchestrators at once and no view across missions or sessions (R-6, R-16).
- NG-3 No sidebar tag as the cross-session "needs you" signal (R-6).
- NG-4 No limit on the review queue, no ready-to-start rule before dispatch, no ordering of what waits by age (R-1).
- NG-5 Harnu does not watch the tracker to tick another person's sign-off (R-21).
- NG-6 No merge batch, merge engine or any surface that merges (R-4).
- NG-7 No automatic timeline for a session that has no mission (R-22); the substitute is D-2.
- NG-8 No bulk conversion of stored files at upgrade (R-23).

**Anti-goals:** a plan an agent can silently shrink; a mission the operator cannot find because its leader session is gone; a hand-off Harnu makes by itself; a record from the current version that the new build cannot open; a pane that grows into another overloaded popover (more than the glance plus one open step on screen at rest).

### Design · The model

**Entities.** A **Mission** is the objective. A **Milestone** is an optional stop on the way. A **Step** is one unit of work, one pull request, and is a board card. An **acceptance criterion** (AC) is a fact that is true when its step is done. A mission with no milestones is valid and is the small-task shape (R-19). The old Campaign is a Mission, its Chapter is a Milestone, its Step is a Step. The fixed step "Delivered and verified" is gone; the mission's **Done when** (one sentence) is confirmed by the operator at close.

**The v4 record** (one Markdown file with YAML frontmatter and an append-only Log, in `.harnu/missions/`, as today; every schema stays `.passthrough()`):

```yaml
schemaVersion: 4
id: mnt-1a2b3c4d
title: Measure harnu:spec, then fix what the numbers show # 60 characters at most
doneWhen: A test set we trust scores harnu:spec, and two fixes are each proven by the score.
status: open # open or closed; closedAs and closeReason once closed
closeRequested: { at: 2026-11-14T10:00:00Z } # the agent says "ready"; one fact, no second status
milestones:
  - { id: mls-1, title: A test set we can trust, optional: false, waitsFor: null }
steps:
  - id: stp-1
    milestone: mls-1 # absent when the mission has no milestones
    title: Load the test files # 50 characters at most
    card: T685-load-test-files # the board card this step is
    acs:
      - { id: ac-1, text: The pull request is merged, by: fact, fact: pr-merged }
      - { id: ac-2, text: Every reviewer question has an answer, by: session }
      - { id: ac-3, text: The designer signed off, by: person, person: the designer }
    links: [{ kind: pr, ref: '256' }, { kind: url, ref: 'http://localhost:5173/score-report' }]
    blockers:
      [{ id: blk-1, reason: …, ask: …, unblocks: …, owner: operator, clearsWhen: pr-merged }]
    waitsFor: null
sessions: # the history of who worked on it
  - { id: <session uuid>, role: leads, from: 2026-11-13T09:00:00Z, to: null, stoppedAt: null }
links: [{ kind: doc, ref: docs/specs/example/spec.md }]
blockers: []
legacyV3: … # present only on a record converted from v3; the whole original frontmatter
```

A criterion is settled when `fact` holds now (derived, never stored) or when its `settled` stamp exists (`{ at, by, evidence }`; stored for the three human-shaped ways). Caps are enforced by the verbs on write (see the writing contract) and never on read.

**One state vocabulary.** A step is **to do**, **running**, **waiting for review** or **done**. **Blocked** is a mark on a step, never a fifth state. First match wins:

1. `done`: every criterion settled, or the operator closed the step's card.
2. `waiting for review`: not done, and the work exists (a pull request is open or merged) while some criterion is open.
3. `running`: a session other than the leader is working on it, or its card is in progress.
4. `to do`: otherwise (the board's Backlog and Ready both read as to do, D-6).

A milestone is **not started**, **in progress**, **waiting for review** (every unfinished step waits for review) or **done**, derived from its steps. More than one milestone can be open at once (D-9). The mission is **open**, **ready to close** (every required step is done; derived) or **closed**. "Delivered" stops meaning three things: closed as delivered is the operator's door, ready to close is derived, and the agent's close request is the single `closeRequested` fact.

**What settles a criterion.** Four ways and no other:

| Who or what      | How                                                                                                                                          | What is stored                         | Shown as             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | -------------------- |
| A fact           | Harnu reads it: `pr-opened`, `ci-green`, `pr-merged`, `main-green`, `link-exists`. Sticky when GitHub is unreachable, never a downgrade      | nothing (derived)                      | settled, "automatic" |
| A second session | A session that did not build the step calls `mission_settle_ac` with evidence. A session that built it only self-checks, which never settles | `settled { at, by, evidence }`         | "second session"     |
| The operator     | The "Mark done" door in the pane                                                                                                             | `settled { at, by: operator }`         | "you"                |
| Another person   | The operator marks it when the person approves (decision 21); it shows as "waiting for the designer" and is not the operator's next step     | `settled { at, by: operator, person }` | "the designer"       |

A blocker may declare the fact it waits for (`clearsWhen`); when the fact holds it stops showing and needs no manual clear (D-12). A criterion tied to a fact is never ticked by hand.

**Progress, next step and the waiting list** are derived once, server-side, from one pure function with no side effects, and read by the pane, the pill, the sidebar chip, Your move, the companion and MCP. Progress counts milestones when the mission has them ("1 of 10 milestones done", D-10) and steps when it has none; optional milestones and steps are outside the count and collapsed (D-13). The **waiting list** has one item type and a fixed rank: `main-failing` (a merged step whose `main` fact is red), `unblock` (an operator-owned blocker, a decision included), `settle` (an operator criterion to mark), `review` (pull requests that wait for the operator, grouped as "Look over N pull requests"), `close` (ready to close), `attach` (a session asks to lead or join). The first item is **Your next step**; the others are "N more waiting on you", one click away (D-14). A person's sign-off is not in the list; it is a line "waiting for other people". Each item carries `ask` (what to do, at most 90 characters) and `why` (what it unlocks, at most 60); no consumer writes its own wording.

**The durable mission.** The mission lives in the folder with its plan, Log and `sessions` history. A **session** is attached with a role: `leads` (at most one, decision 16) or `worked` (it built or checked a step). Each entry keeps `from`, `to` and `stoppedAt` (the step it was on and what it was waiting for). A session only sees and touches the mission it is attached to; a session that is not attached is refused `NOT_ATTACHED` with the way out (ask to join). Attaching needs the operator's confirmation: from the pane's picker it is a confirm dialog, from the agent it is a request the operator allows or denies. A session the leader dispatches for a step is attached as `worked` without a prompt, because the operator already approved the dispatch (D-19).

**The summary and the hand-off.** One deterministic function builds the **mission summary** from the record alone, at most 8,000 characters (about 2,000 tokens), with five parts: **Goal**, **Where it is** (milestone position and the four counts), **Decided** (the last five Log entries of kind decision), **Stopped at** (per session), **Next step** (the first waiting item), plus the open criteria of the open steps and the links. It replaces the post-compaction Mission Brief (D-5) and is served to the leader after a compaction and to a fresh session at the start of a hand-off. Harnu may notice that the leading session's context is high and offers "Continue in a new session…"; the operator confirms; only then does Harnu start the session, attach it as `leads`, set the old one to `worked` with `to` and `stoppedAt`, and release it. Nothing else ever starts a session or changes who leads (R-11).

**A step is a board card.** `mission_add_step` creates the card (in `backlog`) and stamps `mission`, `milestone` and `step` on it; `roadmap-core.ts` gains those three system fields, which `update_card` refuses. The criteria live on the step in the mission file (the single source); the card body carries them as one marked block `<!-- mission:begin stp-n -->` … `<!-- mission:end -->` that only Harnu rewrites, so an executor reading the card sees them. The card's column is an input to the step's state (D-6); Harnu never moves a card to `done` (D-16). The operator closing a card reads as the step done.

**Facts, and who is trusted.** The principles that survive from v3 are unchanged: N is position and never proof; the server counts once; the operator holds every door (close, discard, mark, approve a new Done when); close is never refused, open matters are warnings; the agent can add to a plan and never shrink it; a self-check is labelled and never proof; stall is deterministic and never stored; gates are derived and never stored; memory is written only from drafts the operator ticks; a false alarm beats a miss. One improvement: for a session Harnu spawned, the session id comes from the session's own credential (S-21), so "a second session" is checkable; for any other session it stays self-declared, convention plus audit.

### Design · The surfaces

**The Mission pane** (`MissionPane.vue`) is a pane in the helper stack. The Topbar **pill** (`4/21 · 3 for you`, the server's numbers for this session's mission) toggles it. The pane follows the selected session and shows only that session's mission (R-6). Top to bottom, as in the draft mockup:

1. The mission title; the progress bar with the count inside it ("4 of 21 steps done", or "1 of 10 milestones done"); no Done when paragraph.
2. **Your next step**: one box with the ask, the why, and one button; "N more waiting on you" expands in place.
3. The tree: milestone (chevron, glyph, title, count) ▸ step (title, state, `#256` dimmed at the right) ▸ criteria. A vertical line joins the milestone glyphs and runs through an open milestone. Only the current milestone opens by itself. A milestone line carries its summary ("4 running · 9 waiting for review · 1 blocked"); inside, steps run needs-the-operator, then running, then the rest behind "N more". Optional milestones sit under one collapsed line. A milestone that waits on one that is not the previous says "waits for X".
4. An open step lists its criteria with who settles each; verified ones collapse into one line ("19 criteria verified"); a blocked step shows the exact thing needed and "Done, continue"; "Links from the session" lists the pull request and the finished page.
5. **Sessions** (count, who leads) opens the history and "Continue in a new session…". **Ask** on a milestone sends a question to the leading session (D-1).

The other states, all in the mockup: no mission (attach picker of the folder's open missions and "Start a new mission"), attach request (Allow, Deny), hand-off suggestion and confirmation (with the summary the new session starts from), clear, done (Close mission…), closed, another session's mission, a small task and its sign-offs, a real 10-milestone mission waiting on five things. A **sample mission** renders the pane from a built-in fixture with no file, so every state can be seen without a live delivery.

**Removed:** the mission popover, the campaign popover, the step rail and glyph, the campaign map (Ch. 1), the merge batch (Ch. 1), the steward dialog and Stewards block, the review and bulk-close dialogs (D-18), and `campaign-view`, `campaign-map`, `steward-view`, the campaigns store and `campaign-ipc`. **Kept, reading the v4 view:** the sidebar chip (not clickable, as today), the Activity cue (a notification, not a surface), Your move cards, the companion mod, the hibernation exemption. **Not built:** a kanban view, a cross-mission queue, a campaign map.

### Design · The agent side

**Verb fate table.** Every `mission_*`, `campaign_*` and `rebase_stack` verb in `src/main/mcp/tool-catalog.ts`: 22 found by `grep -E "name: '(mission_|campaign_|rebase_stack)"`, 22 rows below; 16 remain.

| Verb today                | Fate             | v4 verb and shape                                                                                                                                                                                                                                      | Reason                                                                                              |
| ------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `mission_create`          | keep, reshape    | `mission_create`: `title` (60), `doneWhen`, optional `milestones`, `steps` each with at least one criterion, `links`; the caller becomes the leader; no `campaignId`, `chapterId`, `steward`, `declaredEnd.kind`; ACK carries the summary and `recall` | one entry point for a mission of any size                                                           |
| `mission_get`             | keep, reshape    | `mission_get`: progress, next step, waiting list, summary, each step's criteria; resolves the caller's attached mission                                                                                                                                | the single read; the lookup is the attachment, not a self-declared owner                            |
| `mission_list`            | keep, narrow     | `mission_list`: the folder's open missions (the attach picker and observe workers); no deprecated counts                                                                                                                                               | decision 6                                                                                          |
| `mission_add_step`        | keep, reshape    | `mission_add_step`: `milestone`, `title` (50), at least one criterion, `afterStepId`, `reason` once started, `waitsFor`; creates the card; no `decision`, `required`, `discoveredFrom`, `edges`                                                        | a step is a card (D-16, D-17, D-26)                                                                 |
| `mission_update_step`     | keep, shrink     | `mission_update_step`: `title`, `milestone`, `waitsFor`, `optional`                                                                                                                                                                                    | `proof: claimed` goes with the single state flow                                                    |
| `mission_link_child`      | rename           | `mission_link`: kinds `session`, `pr`, `worktree`, `url`, `doc`, on a step or the mission                                                                                                                                                              | decision 18; the card link is redundant; `scope` becomes mission links                              |
| `mission_log`             | keep             | `mission_log`: kinds `note`, `decision`, `surprise` (`steward` goes)                                                                                                                                                                                   | it is the history and feeds the summary's Decided part                                              |
| `mission_set_blocker`     | keep, reshape    | `mission_set_blocker`: `reason` (the exact thing needed), `ask` (90), `unblocks` (60), `owner`, optional `clearsWhen`; every blocker gets an id                                                                                                        | writing contract; D-12; replaces decision nodes (D-17)                                              |
| `mission_clear_blocker`   | keep             | `mission_clear_blocker` by id (agent-owned blockers); the operator has the same door in the pane                                                                                                                                                       | the missing operator door is added                                                                  |
| `mission_set_end`         | rename           | `mission_set_done_when`: stages a new Done when for the operator's approval                                                                                                                                                                            | the mission keeps its "Done when" (decision 3)                                                      |
| `mission_verify_step`     | rename and merge | `mission_settle_ac`: a second session settles one criterion with evidence; a builder's call is a self-check                                                                                                                                            | criteria are settled one by one (decision 3)                                                        |
| `mission_add_check`       | rename and merge | `mission_add_ac`: add a criterion with `by` (`fact`, `session`, `operator`, `person`); add-only                                                                                                                                                        | a check is an operator-settled criterion                                                            |
| `mission_request_close`   | keep, reshape    | `mission_request_close`: refused `STEPS_OPEN` while a step is not done; sets `closeRequested`; never closes                                                                                                                                            | close stays the operator's door                                                                     |
| `mission_import_legacy`   | remove           | none                                                                                                                                                                                                                                                   | goal-file importer (418 lines) for files no longer written; a v3 to v4 upgrade is not an agent verb |
| `mission_transfer_owner`  | replace          | `mission_attach` (a request the operator allows) plus the hand-off door                                                                                                                                                                                | decisions 9, 10, 11                                                                                 |
| `campaign_create`         | merge            | into `mission_create` with milestones                                                                                                                                                                                                                  | decision 2                                                                                          |
| `campaign_add_chapter`    | rename           | `mission_add_milestone`: append-only; `title` (45), `optional`, `waitsFor`; no `consumes`, `produces`, `radiant`                                                                                                                                       | milestones are planned in order                                                                     |
| `campaign_get`            | merge            | into `mission_get`                                                                                                                                                                                                                                     | one read                                                                                            |
| `campaign_list`           | merge            | into `mission_list`                                                                                                                                                                                                                                    | one list                                                                                            |
| `campaign_request_close`  | merge            | into `mission_request_close` (the campaign never had an operator door)                                                                                                                                                                                 | one close                                                                                           |
| `campaign_transfer_owner` | merge            | into `mission_attach` and the hand-off door                                                                                                                                                                                                            | one way to change who leads                                                                         |
| `rebase_stack`            | keep             | `rebase_stack`: the leader rebases a step's own worktree; never pushes; no steward needed                                                                                                                                                              | T701 does not cover it (D-24)                                                                       |

Counts: 10 keep, 5 rename or rename-and-merge, 1 replace, 5 merge, 1 remove (22). The 16 that remain: `mission_create`, `mission_get`, `mission_list`, `mission_add_milestone`, `mission_add_step`, `mission_update_step`, `mission_add_ac`, `mission_link`, `mission_log`, `mission_set_blocker`, `mission_clear_blocker`, `mission_set_done_when`, `mission_settle_ac`, `mission_request_close`, `mission_attach`, `rebase_stack`.

**Sessions Harnu spawns (BUG-253, prerequisite of S-21).** A session spawned for a step gets a per-session scoped credential (the mechanism the steward already uses, generalized and moved out of `steward-core.ts`). Role `worker`: `mission_get`, `mission_link`, `mission_log`, `mission_set_blocker` on its own step. Role `verifier`: the same plus `mission_settle_ac`. No role can lead, attach itself or touch another mission. This makes "a second session" real for the sessions Harnu spawns.

**Skills.** `orchestrate-delivery` (1,225 lines, to under 700): drop the campaign gate and the multi-campaign delivery map, plan stages as milestones, put criteria on steps, hand over by attach and the operator's hand-off. `mission` (537, to about 300): new verb table, the tick keeps its first line `/harnu:mission tick · mnt-<8 hex>` (parsed by the companion mod and used by `land-prs` and `dispatch-pr-review`), intake rules (decision 20), no legacy import. `delivery-verifier` (384, to about 260): settles criteria one by one on the step with `mission_settle_ac`, "another person" beside "second session". `delivery-watchdog` (231, to about 120): the steward half goes, the observe sweep stays. `status` (382) and `report-back` (196): drop the `Ch. N/M · Step a/b` headline and the campaign link; fix the reference to a `get_board` verb that does not exist. `spec`: the mission at triage gets one step "Approve spec" with an operator criterion. `step-by-step`: each manual action is an operator criterion. `one-by-one` and `grill-me`: a decision is an operator blocker. `your-move` and `draft-to-prompt`: wording. Untouched: `conductor`, `read-aloud`. The tick first line and the child report header (`Report for session … · mission … · step …`) stay, because code parses them. `resources/skills/CATALOG.md` goes to v23.

**Hand-off rules reversed.** Today three places forbid a hand-off (`orchestrate-delivery` lines 997 to 1001, the `mission` skill lines 489 to 499, the awareness doc lines 1227 to 1230). The new rule in all three: the operator decides a hand-off; the leader never switches itself; a fresh session starts from the summary, and no resume prompt is ever pasted.

**Awareness doc.** The mission, campaign and steward text (lines 1113 to 1181, about 42,000 characters) and the mission part of the bundled-skills text (lines 1201 to 1278) become one section of at most 2,000 words: the 16 verbs, the model in ten lines, the doors, the waiting list, the summary and hand-off, the writing contract in a table, the proactive rule. The campaign section, the steward section, the merge-batch bullet, the legacy-import paragraph and the lineage tags go. The verb index and the marker follow. `docs/user/agent-control.md` (lines 243 to 360) is rewritten the same way, `docs/user/missions.md` is the one user page, `docs/user/roadmap-board.md` gains "a card can be a step".

**The writing contract** (modelled on the `action-brief` skill; it ships inside Harnu as a reference the mission-writing skills load, never pointing at a personal skill). The reader is tired, works across several sessions and was not in the session that wrote the text; a line that looks like noise gets skipped.

| Rule                                                     | Instead of                           | Write                                                                                                                  | Enforced by                                     |
| -------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Zero context: no word the reader must look up            | "Build the bake-off harness"         | "A tool that scores a spec"                                                                                            | skill and eval                                  |
| A milestone is named for what becomes true               | "Measuring stick and holdout corpus" | "A test set we can trust"                                                                                              | skill and eval                                  |
| A step starts with a verb                                | "Runner CLI"                         | "One command to run a round"                                                                                           | skill and eval                                  |
| The next step says what to do and what it unlocks        | "Approve spec"                       | "Approve the plan for the scoring tool" and "9 finished steps wait for it."                                            | `ask` (90) and `why` (60) caps, skill           |
| A blocker shows the exact thing needed, never a label    | "Blocked on env"                     | "This machine doesn't know where the private test files are. Set HARNU_CORPUS_DIR to their folder and the run starts." | refused when it names no exact thing; skill     |
| A criterion is a fact that is true when it is done       | "Verifier gate"                      | "Every reviewer question has an answer"                                                                                | empty or one-word criterion refused; skill      |
| States in words people say                               | "in review", "driver"                | "waiting for review", "leads the mission"                                                                              | banned-word list in the verbs                   |
| Ids and numbers go to the side, dimmed                   | "T685 E2E round"                     | the name, with `#256` at the right                                                                                     | an id at the start or end of a title is refused |
| One line each; numbers only where they answer a question | counts everywhere                    | the count lives in the progress bar                                                                                    | caps below                                      |

Caps, enforced on every write by refusal (the error names the cap and the length; the text is never cut or rewritten, D-3): mission title 60, milestone 45, step 50, next-step `ask` 90, `why` 60, criterion 70, button label 16. Caps are not applied when reading or converting old records; the pane clips by width and shows the full text on hover.

**Proactive missions (decision 22).** Three parts, none of which needs a model call in Harnu. (1) The agent rule, in the awareness doc and the `mission` skill: at the first sign of multi-step work (more than one pull request, three or more steps, an objective you would keep in a todo list) call `mission_create` before the first step, without asking; the mission and its next step appear in the pane at once. (2) A hint in the ACK of `create_session`, `create_worktree` and `submit_manifest` when the calling session leads no mission and has dispatched two sessions or made a worktree: "You are orchestrating with no mission. Create one." (3) In the pane, a session with no mission shows "Start a new mission". Harnu does not read an agent's own step list from the transcript (D-4) and does not build an automatic timeline for sessions with no mission (D-2).

### Design · Compatibility with records written by v3

Missions are in `.harnu/missions/` and campaigns in `.harnu/campaigns/` of every repo that used v3 (77 mission files and 7 campaign files in this repo alone), and some are in progress, including the mission and campaign that deliver this spec. All of them stay readable. Three rules:

1. **A read is a view, never a write.** One function, `readMissionRecord`, parses a file; a file without `schemaVersion: 4` is parsed with the v3 schema and converted in memory to the v4 shape by the same pure function that conversion uses. Reading changes no byte and no `updatedAt`.
2. **A write keeps the original.** Before the first write to a v3 file, Harnu copies it byte for byte to `<dir>/.archive-v3/<same name>` (never overwritten if it exists), then writes the v4 file in place with the same id and file name. The whole v3 frontmatter object is kept under `legacyV3`, so nothing is lost. A mission id that lives in a running session's prompt keeps working. Readers skip dot-directories, so the archive and the sidecars are never read as records.
3. **A campaign converts by copy, and its originals are never touched.** A campaign and its chapter missions become one new mission (id `mnt-` plus the first 8 hex of the sha256 of the sorted source ids, so the conversion is deterministic and idempotent), written on the first v4 write to any of them. The originals are not rewritten at all; a tiny sidecar `.harnu/missions/.migrated/<old id>.json` says "superseded by `mnt-…`" and makes the old id resolve to the new mission, so prompts that mention the campaign id still work. Until that first write, the campaign reads as one mission through rule 1.

**How v3 concepts map to v4:**

| v3                                                          | v4                                                                                                                                                                                                  |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mission title (the Log's first heading) or campaign `title` | `title`                                                                                                                                                                                             |
| `declaredEnd` (`target`, `evidence`)                        | `doneWhen` (`target`, then "Proof: evidence")                                                                                                                                                       |
| Fixed end step "Delivered and verified"                     | removed from steps; if it was verified, `doneWhenVerified` records who and when                                                                                                                     |
| Fixed start step, `scope`                                   | mission `links` of kind `doc`                                                                                                                                                                       |
| `status` draft, active, stale                               | `open`                                                                                                                                                                                              |
| `status: delivered` with `pendingClose`                     | `open` plus `closeRequested`                                                                                                                                                                        |
| `status: closed`, `closedAs`, `closeReason`                 | the same                                                                                                                                                                                            |
| Custom step                                                 | step, in order; its card link becomes `card`                                                                                                                                                        |
| `required: false` (side step)                               | `optional: true`                                                                                                                                                                                    |
| `verification: existence`                                   | criterion by fact `link-exists`                                                                                                                                                                     |
| A `pr` link or a worktree whose branch has a pull request   | criterion by fact `pr-merged`                                                                                                                                                                       |
| `verification: verifier`, proof verified                    | criterion by `session`, settled by `verifiedBy` at its time                                                                                                                                         |
| proof `self-verified` or `claimed`                          | the criterion stays open; the self-check is noted                                                                                                                                                   |
| `verification: human`, proof verified                       | criterion by `operator`, settled                                                                                                                                                                    |
| `checks`                                                    | criteria by `operator` (text is the label; ticked means settled)                                                                                                                                    |
| Decision node, undecided                                    | an operator blocker "Choose: title, options"                                                                                                                                                        |
| Decision node, decided                                      | nothing to show; the Log already holds the entry                                                                                                                                                    |
| `edges` of kind `blocks`, undecided decision `blocks`       | `waitsFor` on the step; `validates` and `related` (never read) are dropped                                                                                                                          |
| `blockers` (no id)                                          | blockers with ids `blk-1` and up, in order                                                                                                                                                          |
| `owner.sessionId`                                           | `sessions[0]` with role `leads`                                                                                                                                                                     |
| Step `session` links                                        | `sessions` entries with role `worked`                                                                                                                                                               |
| `ledger`, `outcome`, `memoryDrafts`                         | kept as they are                                                                                                                                                                                    |
| `stewardPause`, `legacy`, `legacyRaw`, `openQuestions`      | kept under `legacyV3`, not shown                                                                                                                                                                    |
| Campaign                                                    | mission; chapter becomes milestone (`required: false` becomes `optional`; `unlocks` of a chapter becomes `waitsFor`); `consumes`, `produces`, `radiant`, `discoveredFrom` are kept under `legacyV3` |
| Chapter with no mission yet                                 | milestone with no steps (the real-world case: later milestones are planned when they start)                                                                                                         |

**A campaign that is mid-flight.** It keeps going: the leader (the campaign owner) sees one mission in the pane with milestones, open chapters first; the first v4 write converts it by copy; chapter missions that were still running keep their steps, states and links; a chapter mission closed as delivered is a done milestone. Ending the converted mission is the operator's door and closes only the new record.

**Proof.** `tests/mission-v4-compat.test.ts` runs against frozen fixtures written by the v3 builders before any change (S-1): reading leaves bytes and hashes equal (AC-20), the first write archives the original (AC-21), the mapping table holds (AC-22), a campaign reads as one mission (AC-23), converts by copy (AC-24) and idempotently (AC-25), and the v4 verbs work on a v3 record after the flip (AC-68). Chapter 6 repeats it on records copied into a throwaway repo and opened in a build of main (AC-82).

### Delivery order · waves and hub files

The delivery map's chapters 2 to 6 contain the slices below; chapter 1 (this spec, the removal of the merge batch and of the Campaign map, the draft pull request label fix) is already on main, and its tokens are written `existing:`. Slices are ordered so main works after every one: chapters 2 and 3 add modules, tests and an unregistered verb layer behind the unchanged catalog; chapter 4 adds the pane and removes the old surfaces; chapter 5 registers the v4 verbs in one flip (S-23) and rewrites the agent text; chapter 6 proves old records open. A pull request of about 500 lines is the target; S-20, S-22 and S-23 are mostly deletions and say so.

A **wave** is a set of slices with no `depends-on` path between them, which may run at the same time. A **hub file** is one that many slices want to edit. No two slices in one wave own the same hub file, and slices that share a hub form a dependency chain, so a hub has at most one owner per wave:

| Wave | Slices           | Chapter |
| ---- | ---------------- | ------- |
| W1   | S-1, S-2         | Ch. 2   |
| W2   | S-3              | Ch. 2   |
| W3   | S-4              | Ch. 2   |
| W4   | S-5              | Ch. 2   |
| W5   | S-6              | Ch. 3   |
| W6   | S-7, S-8, S-9    | Ch. 3   |
| W7   | S-10, S-11, S-12 | Ch. 3   |
| W8   | S-13             | Ch. 3   |
| W9   | S-14             | Ch. 4   |
| W10  | S-15             | Ch. 4   |
| W11  | S-16             | Ch. 4   |
| W12  | S-17             | Ch. 4   |
| W13  | S-18             | Ch. 4   |
| W14  | S-19             | Ch. 4   |
| W15  | S-20             | Ch. 4   |
| W16  | S-21             | Ch. 5   |
| W17  | S-22             | Ch. 5   |
| W18  | S-23             | Ch. 5   |
| W19  | S-24, S-25, S-26 | Ch. 5   |
| W20  | S-27             | Ch. 5   |
| W21  | S-28, S-29       | Ch. 5   |
| W22  | S-30, S-31       | Ch. 6   |

| Hub file                                      | Owner slice (wave) per wave                                                                                                                   |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| tool-handlers.ts                              | S-2 (W1), S-3 (W2), S-4 (W3), S-5 (W4), S-21 (W16), S-22 (W17), S-23 (W18), S-29 (W21)                                                        |
| tool-catalog.ts                               | S-21 (W16), S-23 (W18), S-29 (W21)                                                                                                            |
| awareness doc                                 | S-21 (W16), S-22 (W17), S-23 (W18), S-24 (W19), S-29 (W21)                                                                                    |
| i18n en.json and pt-BR.json (always together) | S-5 (W4), S-14 (W9), S-15 (W10), S-16 (W11), S-17 (W12), S-18 (W13), S-19 (W14), S-20 (W15)                                                   |
| design.md                                     | S-14 (W9), S-15 (W10), S-16 (W11), S-17 (W12), S-18 (W13), S-20 (W15)                                                                         |
| CHANGELOG.md                                  | S-14 (W9), S-15 (W10), S-16 (W11), S-17 (W12), S-18 (W13), S-19 (W14), S-20 (W15), S-21 (W16), S-22 (W17), S-23 (W18), S-24 (W19), S-29 (W21) |
| CLAUDE.md (design-entity map)                 | S-14 (W9), S-20 (W15)                                                                                                                         |
| preload index                                 | S-13 (W8), S-20 (W15)                                                                                                                         |
| main index                                    | S-3 (W2), S-13 (W8), S-21 (W16), S-22 (W17)                                                                                                   |
| mission-ipc.ts                                | S-2 (W1), S-3 (W2), S-5 (W4), S-13 (W8), S-20 (W15)                                                                                           |
| stores/missions.ts                            | S-5 (W4), S-14 (W9), S-16 (W11), S-17 (W12), S-18 (W13), S-19 (W14), S-20 (W15)                                                               |
| agent-control user page                       | S-23 (W18), S-24 (W19)                                                                                                                        |
| missions user page                            | S-14 (W9), S-15 (W10), S-16 (W11), S-17 (W12), S-18 (W13), S-24 (W19)                                                                         |
| skills CATALOG.md                             | S-27 (W20)                                                                                                                                    |

Slices that change user-visible behavior write their own `CHANGELOG.md` entry and docs; slices S-1 to S-13 and the test-only ones carry the `no-changelog` label. S-21, S-23 and S-29 change the catalog and so carry the awareness doc and the user-docs update in the same pull request (the CI gates).

### Decision → where it lands

| #   | The operator's decision                                                                          | Where it lands                                                                        |
| --- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| 1   | Rethink from the concept; one hierarchy, tasks unified with the board, one state flow, one queue | The model; AC-6, AC-11, AC-27, AC-58                                                  |
| 2   | Mission → Milestone → Step; Campaign and Chapter go away                                         | The model; AC-8, AC-23; verb fate table                                               |
| 3   | Criteria on the step; the mission keeps "Done when"; a milestone has none                        | The model (entities, what settles a criterion); AC-9, AC-12, AC-26                    |
| 4   | Merge batch removed entirely                                                                     | Ch. 1 (T701); NG-6; the surfaces (Removed); `rebase_stack` kept (D-24)                |
| 5   | No popover; the pill toggles a pane in the helper stack                                          | The surfaces; AC-39, AC-40, AC-60                                                     |
| 6   | The pane follows the selected session; the folder's missions only as an attach picker            | The surfaces; AC-39, AC-52, AC-61                                                     |
| 7   | Glance first; count inside the bar; no Done when paragraph                                       | The surfaces (1 and 2); AC-41, AC-45                                                  |
| 8   | Tree with chevrons; only the current milestone opens                                             | The surfaces (3); AC-42                                                               |
| 9   | Durable mission, disposable session; summary for a fresh session                                 | The model (durable mission, summary); AC-18, AC-36, AC-38, AC-49, AC-78               |
| 10  | Attach needs confirmation; a session touches only its mission                                    | The model; AC-28, AC-32, AC-35, AC-52, AC-53, AC-63                                   |
| 11  | The operator always decides a hand-off                                                           | The model (hand-off); AC-33, AC-34, AC-37, AC-50, AC-51, AC-74                        |
| 12  | The pane is the only surface; no kanban, no cross-mission queue                                  | The surfaces; NG-1; AC-61                                                             |
| 13  | A timeline line with the chevrons                                                                | The surfaces (3); AC-43                                                               |
| 14  | Mission text follows a writing contract                                                          | The writing contract; AC-9, AC-10, AC-75                                              |
| 15  | The Campaign map is removed; the pane replaces it                                                | The surfaces (Removed); AC-60                                                         |
| 16  | One orchestrator; parallel work is steps in the current milestone                                | NG-2; AC-16; D-9                                                                      |
| 17  | Parallel work in the milestone summary; the order inside a milestone                             | The surfaces (3); AC-16, AC-44                                                        |
| 18  | A step receives links from its session                                                           | The model (a step is a card); D-15; AC-31, AC-48                                      |
| 19  | A small task is a mission with no milestones                                                     | The model (entities); AC-8, AC-15, AC-55                                              |
| 20  | `scope-task` pulls the task's criteria and links                                                 | The agent side (skills, intake); AC-76; the report names the personal-skill follow-up |
| 21  | Another person settles a criterion; the operator marks it                                        | The model (what settles a criterion); NG-5; AC-12, AC-13, AC-47                       |
| 22  | The pane is proactive                                                                            | The agent side (proactive missions); D-2, D-4, D-22; AC-29, AC-80, AC-81              |

## Slices

One `###` block per slice: one branch, one session, one pull request. Chapter headings are plain text in this section because the gate reads every `###` here as a slice. `acs:` lists ids from the table below, nothing else. Every slice also keeps the repository's rules: English only, no client identifiers, `npm run typecheck` and the `local-ci` gates before the last push, and the CPU cap (at most half the cores, `--maxWorkers=4`).

**Chapter 2 · Mission core out of the MCP handlers**

### S-1 · Freeze the v3 fixtures

- depends-on: —
- substrate: worktree
- files-may-touch: `tests/fixtures/missions-v4-compat/**`, `tests/mission-v4-fixtures.test.ts`
- produces: v3-fixtures
- consumes: existing:spec-on-main
- acs: AC-1

### S-2 · One mission store

- depends-on: —
- substrate: worktree
- files-may-touch: `src/main/missions/store.ts`, `src/main/mission-ipc.ts`, `src/main/campaign-ipc.ts`, `src/main/hibernation.ts`, `src/main/mcp/tool-handlers.ts`, `tests/mission-store.test.ts`, `tests/mission-ipc.test.ts`, `tests/campaign-ipc.test.ts`
- produces: mission-store
- consumes: existing:spec-on-main
- acs: AC-2

### S-3 · A read with no side effects

- depends-on: S-2
- substrate: worktree
- files-may-touch: `src/main/missions/derive.ts`, `src/main/missions/observer.ts`, `src/main/mission-ipc.ts`, `src/main/index.ts`, `src/main/mcp/tool-handlers.ts`, `tests/mission-derive-pure.test.ts`, `tests/mission-derived-signals.test.ts`
- produces: mission-derive-pure
- consumes: mission-store
- acs: AC-3

### S-4 · One ledger store

- depends-on: S-3
- substrate: worktree
- files-may-touch: `src/main/missions/ledger-store.ts`, `src/main/mission-link-cache.ts`, `src/main/mission-ledger.ts`, `src/main/consolidator-core.ts`, `src/main/mcp/tool-handlers.ts`, `tests/mission-ledger-store.test.ts`, `tests/mission-link-cache.test.ts`
- produces: mission-ledger-store
- consumes: mission-derive-pure
- acs: AC-4, AC-5

### S-5 · One server-owned waiting list

- depends-on: S-4
- substrate: worktree
- files-may-touch: `src/main/missions/waiting.ts`, `src/main/mission-ipc.ts`, `src/main/mcp/tool-handlers.ts`, `src/main/companion/mission-state-core.ts`, `src/main/companion/mission-state.ts`, `src/main/your-move/source-mission.ts`, `src/renderer/src/lib/mission-view.ts`, `src/renderer/src/stores/missions.ts`, `src/renderer/src/components/MissionPopover.vue`, `src/renderer/src/components/MissionsReviewDialog.vue`, `src/renderer/src/i18n/en.json`, `src/renderer/src/i18n/pt-BR.json`, `tests/mission-waiting.test.ts`, `tests/mission-view.test.ts`, `tests/missions-store.test.ts`
- produces: waiting-list, mission-core
- consumes: mission-ledger-store
- acs: AC-6, AC-7

The list is typed with the v4 kinds from the start; the v3 sources feed it through an adapter that S-13 replaces.

**Chapter 3 · The new model**

### S-6 · The v4 record and the writing contract

- depends-on: S-5
- substrate: worktree
- files-may-touch: `src/main/missions/model.ts`, `src/main/missions/contract.ts`, `tests/mission-model.test.ts`, `tests/mission-contract.test.ts`
- produces: model-schema, writing-contract-module
- consumes: mission-core
- acs: AC-8, AC-9, AC-10

### S-7 · State, progress, next step and summary (pure)

- depends-on: S-6
- substrate: worktree
- files-may-touch: `src/main/missions/state.ts`, `src/main/missions/progress.ts`, `src/main/missions/summary.ts`, `src/main/missions/waiting.ts`, `tests/mission-state.test.ts`, `tests/mission-progress-v4.test.ts`, `tests/mission-waiting-v4.test.ts`, `tests/mission-summary.test.ts`, `tests/mission-list-benchmark.test.ts`
- produces: state-derive-v4
- consumes: model-schema, waiting-list
- acs: AC-11, AC-12, AC-13, AC-14, AC-15, AC-16, AC-17, AC-18, AC-19

### S-8 · Compatibility reader and converter

- depends-on: S-1, S-6
- substrate: worktree
- files-may-touch: `src/main/missions/compat.ts`, `src/main/missions/archive.ts`, `tests/mission-v4-compat.test.ts`
- produces: compat-reader
- consumes: model-schema, v3-fixtures
- acs: AC-20, AC-21, AC-22, AC-23, AC-24, AC-25

### S-9 · A step is a board card

- depends-on: S-6
- substrate: worktree
- files-may-touch: `src/main/roadmap-core.ts`, `src/main/missions/cards.ts`, `tests/mission-cards.test.ts`, `tests/roadmap-core-mission-fields.test.ts`
- produces: step-cards
- consumes: model-schema
- acs: AC-26, AC-27

### S-10 · Read verbs: create, get, list

- depends-on: S-7, S-8, S-9
- substrate: worktree
- files-may-touch: `src/main/missions/verbs-read.ts`, `tests/mission-verbs-read.test.ts`
- produces: verbs-read
- consumes: state-derive-v4, compat-reader, step-cards, writing-contract-module
- acs: AC-28, AC-29

Handlers are written and tested through their module API; they are registered in the catalog by S-23, so main behaves as before.

### S-11 · Plan verbs: milestone, step, criterion, link, log

- depends-on: S-7, S-8, S-9
- substrate: worktree
- files-may-touch: `src/main/missions/verbs-plan.ts`, `tests/mission-verbs-plan.test.ts`, `tests/mission-step-links.test.ts`
- produces: verbs-plan
- consumes: state-derive-v4, compat-reader, step-cards, writing-contract-module
- acs: AC-30, AC-31

### S-12 · State verbs: blocker, Done when, settle, close request, attach request

- depends-on: S-7, S-8
- substrate: worktree
- files-may-touch: `src/main/missions/verbs-state.ts`, `tests/mission-verbs-state.test.ts`
- produces: verbs-state
- consumes: state-derive-v4, compat-reader, writing-contract-module
- acs: AC-32, AC-33

### S-13 · Operator doors, sessions, summary route, view channel

- depends-on: S-10, S-11, S-12
- substrate: worktree
- files-may-touch: `src/main/missions/doors.ts`, `src/main/missions/sessions.ts`, `src/main/missions/summary-route.ts`, `src/main/mission-ipc.ts`, `src/preload/index.ts`, `src/main/index.ts`, `tests/mission-doors-v4.test.ts`, `tests/mission-attach.test.ts`, `tests/mission-handoff.test.ts`, `tests/mission-summary-route.test.ts`
- produces: operator-doors, mission-view-ipc, model-v4
- consumes: verbs-read, verbs-plan, verbs-state
- acs: AC-34, AC-35, AC-36, AC-37, AC-38

**Chapter 4 · The Mission pane**

### S-14 · Pane shell and the simpler pill

- depends-on: S-13
- substrate: worktree
- files-may-touch: `src/renderer/src/components/MissionPane.vue`, `src/renderer/src/components/MissionPill.vue`, `src/renderer/src/components/HelperPane.vue`, `src/renderer/src/components/HelperStack.vue`, `src/renderer/src/stores/helpers.ts`, `src/renderer/src/stores/missions.ts`, `src/renderer/src/lib/mission-pane-view.ts`, `src/renderer/src/lib/mission-view.ts`, `src/renderer/src/i18n/en.json`, `src/renderer/src/i18n/pt-BR.json`, `design.md`, `CHANGELOG.md`, `CLAUDE.md`, `docs/user/missions.md`, `tests/mission-pane-follow.test.ts`, `tests/mission-pill-v4.test.ts`
- produces: pane-shell
- consumes: model-v4, existing:ground-cleared
- acs: AC-39, AC-40

### S-15 · The glance: progress, next step, tree, timeline

- depends-on: S-14
- substrate: worktree
- files-may-touch: `src/renderer/src/components/MissionPane.vue`, `src/renderer/src/components/MissionPaneNext.vue`, `src/renderer/src/components/MissionPaneTree.vue`, `src/renderer/src/lib/mission-pane-view.ts`, `src/renderer/src/i18n/en.json`, `src/renderer/src/i18n/pt-BR.json`, `design.md`, `CHANGELOG.md`, `docs/user/missions.md`, `tests/mission-pane-tree.test.ts`, `tests/mission-pane-order.test.ts`
- produces: pane-glance
- consumes: pane-shell
- acs: AC-41, AC-42, AC-43, AC-44, AC-45

### S-16 · An open step: criteria, blocker, links, doors

- depends-on: S-15
- substrate: worktree
- files-may-touch: `src/renderer/src/components/MissionPane.vue`, `src/renderer/src/components/MissionPaneStep.vue`, `src/renderer/src/lib/mission-pane-view.ts`, `src/renderer/src/stores/missions.ts`, `src/renderer/src/i18n/en.json`, `src/renderer/src/i18n/pt-BR.json`, `design.md`, `CHANGELOG.md`, `docs/user/missions.md`, `tests/mission-pane-links.test.ts`
- produces: pane-step
- consumes: pane-glance
- acs: AC-46, AC-47, AC-48

### S-17 · Sessions row and the hand-off

- depends-on: S-16
- substrate: worktree
- files-may-touch: `src/renderer/src/components/MissionPane.vue`, `src/renderer/src/components/MissionPaneSessions.vue`, `src/renderer/src/components/MissionHandoffDialog.vue`, `src/renderer/src/lib/mission-pane-view.ts`, `src/renderer/src/stores/missions.ts`, `src/renderer/src/i18n/en.json`, `src/renderer/src/i18n/pt-BR.json`, `design.md`, `CHANGELOG.md`, `docs/user/missions.md`, `tests/mission-pane-sessions.test.ts`
- produces: pane-sessions
- consumes: pane-step
- acs: AC-49, AC-50, AC-51

### S-18 · Attach, ask, close and the sample mission

- depends-on: S-17
- substrate: worktree
- files-may-touch: `src/renderer/src/components/MissionPane.vue`, `src/renderer/src/components/MissionPaneAttach.vue`, `src/renderer/src/components/MissionPaneAsk.vue`, `src/renderer/src/components/MissionCloseConfirmDialog.vue`, `src/renderer/src/lib/mission-sample.ts`, `src/renderer/src/lib/mission-pane-view.ts`, `src/renderer/src/stores/missions.ts`, `src/renderer/src/i18n/en.json`, `src/renderer/src/i18n/pt-BR.json`, `design.md`, `CHANGELOG.md`, `docs/user/missions.md`, `tests/mission-pane-ask.test.ts`, `tests/mission-pane-sample.test.ts`, `tests/mission-close-confirm.test.ts`
- produces: pane-attach
- consumes: pane-sessions
- acs: AC-52, AC-53, AC-54, AC-55, AC-56, AC-57

### S-19 · Every other reader uses the v4 view

- depends-on: S-18
- substrate: worktree
- files-may-touch: `src/renderer/src/components/SidebarFolder.vue`, `src/renderer/src/components/ActivityBell.vue`, `src/renderer/src/components/YourMoveCard.vue`, `src/renderer/src/lib/mission-cue.ts`, `src/renderer/src/lib/your-move-view.ts`, `src/renderer/src/stores/missions.ts`, `src/main/companion/mission-state-core.ts`, `src/main/companion/mission-state.ts`, `resources/companion/hooks/lib/mission-state.ts`, `src/main/your-move/source-mission.ts`, `src/main/hibernation.ts`, `src/renderer/src/i18n/en.json`, `src/renderer/src/i18n/pt-BR.json`, `CHANGELOG.md`, `tests/mission-readers-v4.test.ts`, `tests/mission-cue.test.ts`, `tests/mission-activity.test.ts`
- produces: readers-v4
- consumes: pane-attach
- acs: AC-58, AC-59

### S-20 · Remove the old surfaces

- depends-on: S-19
- substrate: worktree
- files-may-touch: `src/renderer/src/components/MissionPopover.vue`, `src/renderer/src/components/MissionStepRail.vue`, `src/renderer/src/components/MissionStepGlyph.vue`, `src/renderer/src/components/CampaignPopover.vue`, `src/renderer/src/components/CampaignGateDots.vue`, `src/renderer/src/components/MissionsReviewDialog.vue`, `src/renderer/src/components/MissionBulkCloseConfirmDialog.vue`, `src/renderer/src/components/StewardPauseDialog.vue`, `src/renderer/src/components/SchedulerStewards.vue`, `src/renderer/src/components/SchedulerView.vue`, `src/renderer/src/components/Topbar.vue`, `src/renderer/src/App.vue`, `src/renderer/src/stores/ui.ts`, `src/renderer/src/stores/campaigns.ts`, `src/renderer/src/lib/campaign-view.ts`, `src/renderer/src/lib/campaign-map.ts`, `src/renderer/src/lib/steward-view.ts`, `src/renderer/src/lib/mission-view.ts`, `src/renderer/src/stores/missions.ts`, `src/main/campaign-ipc.ts`, `src/main/mission-ipc.ts`, `src/preload/index.ts`, `src/renderer/src/i18n/en.json`, `src/renderer/src/i18n/pt-BR.json`, `design.md`, `CLAUDE.md`, `CHANGELOG.md`, `tests/mission-old-surfaces-removed.test.ts`, `tests/campaign-*.test.ts`, `tests/steward-doors-ui.test.ts`, `tests/scheduler-stewards*.test.ts`, `tests/missions-review-dialog.test.ts`
- produces: pane
- consumes: readers-v4
- acs: AC-60, AC-61, AC-62

Mostly deletions; the added lines are the guard test.

**Chapter 5 · The agent side**

### S-21 · Scoped verbs for sessions Harnu spawns (BUG-253)

- depends-on: S-20
- substrate: worktree
- files-may-touch: `src/main/mcp/server.ts`, `src/main/mcp/scope.ts`, `src/main/pty.ts`, `src/main/steward-core.ts`, `src/main/index.ts`, `src/main/mcp/tool-handlers.ts`, `src/main/mcp/tool-catalog.ts`, `docs/harnu-features.md`, `CHANGELOG.md`, `tests/mission-scoped-sessions.test.ts`, `tests/steward-core.test.ts`
- produces: scoped-sessions
- consumes: model-v4, pane
- acs: AC-63, AC-64

### S-22 · Retire the steward

- depends-on: S-21
- substrate: worktree
- files-may-touch: `src/main/steward-*.ts`, `src/main/missions/rebase.ts`, `src/main/scheduler-core.ts`, `src/main/scheduler-shell.ts`, `src/main/index.ts`, `src/main/mcp/tool-handlers.ts`, `docs/harnu-features.md`, `docs/user/scheduler.md`, `CHANGELOG.md`, `tests/steward-retired.test.ts`, `tests/steward-*.test.ts`, `tests/rebase-stack-leader.test.ts`
- produces: steward-retired
- consumes: scoped-sessions
- acs: AC-65, AC-66

Mostly deletions; the steward bearer was moved out by S-21.

### S-23 · Flip: register the v4 verbs, shrink the catalog

- depends-on: S-22
- substrate: worktree
- files-may-touch: `src/main/mcp/tool-catalog.ts`, `src/main/mcp/tool-handlers.ts`, `src/main/missions/verbs.ts`, `src/main/mission-core.ts`, `src/main/mission-migration.ts`, `src/main/mission-gates.ts`, `src/main/mission-progress.ts`, `src/main/campaign-core.ts`, `src/main/campaign-progress.ts`, `docs/harnu-features.md`, `docs/user/agent-control.md`, `CHANGELOG.md`, `tests/mission-verbs-contract.test.ts`, `tests/harnu-features-verb-roster.test.ts`, `tests/mission-handlers.test.ts`, `tests/campaign-verbs-transport.test.ts`, `tests/mission-v4-compat.test.ts`, `tests/mission-v2-skills.test.ts`, `tests/mission-v3-skills.test.ts`, `tests/mission-skills-migration.test.ts`, `tests/campaign-skills-contract.test.ts`
- produces: verbs-v4
- consumes: verbs-read, verbs-plan, verbs-state, steward-retired, scoped-sessions, pane
- acs: AC-67, AC-68

Deletion-heavy: the v3 handlers and their tests go; the added lines are the registry, the catalog rows and the contract test. It also deletes the v3 skill-text tests, which pin text the verbs no longer support; each skill slice (S-25 to S-27) adds its own v4 test, so no skill is untested for long.

### S-24 · Awareness doc and user docs

- depends-on: S-23
- substrate: worktree
- files-may-touch: `docs/harnu-features.md`, `src/main/harnu-features.ts`, `docs/user/agent-control.md`, `docs/user/missions.md`, `docs/user/roadmap-board.md`, `docs/user/settings.md`, `docs/user/mods.md`, `docs/user/sessions.md`, `docs/user/approval-inbox.md`, `CHANGELOG.md`, `tests/harnu-features-mission-size.test.ts`, `tests/bundled-spec-skill.test.ts`, `tests/your-move/skill.test.ts`
- produces: awareness-v4
- consumes: verbs-v4
- acs: AC-69, AC-70

### S-25 · Rewrite orchestrate-delivery

- depends-on: S-23
- substrate: worktree
- files-may-touch: `resources/skills/skills/orchestrate-delivery/**`, `tests/skill-orchestrate-delivery-v4.test.ts`, `tests/orchestrate-spec-integration.test.ts`
- produces: orchestrate-v4
- consumes: verbs-v4
- acs: AC-71

### S-26 · Rework delivery-verifier and delivery-watchdog

- depends-on: S-23
- substrate: worktree
- files-may-touch: `resources/skills/skills/delivery-verifier/**`, `resources/skills/skills/delivery-watchdog/**`, `tests/skill-delivery-verifier-v4.test.ts`, `tests/delivery-verifier-evidence.test.ts`, `tests/delivery-verifier-rubrics.test.ts`, `tests/scheduler-observe-no-shell.test.ts`, `tests/observe-skill-hooks.test.ts`
- produces: verifier-v4
- consumes: verbs-v4
- acs: AC-72

### S-27 · Remaining skills, the writing contract reference, catalog v23

- depends-on: S-24, S-25, S-26
- substrate: worktree
- files-may-touch: `resources/skills/skills/mission/**`, `resources/skills/skills/status/**`, `resources/skills/skills/report-back/**`, `resources/skills/skills/spec/**`, `resources/skills/skills/one-by-one/**`, `resources/skills/skills/step-by-step/**`, `resources/skills/skills/grill-me/**`, `resources/skills/skills/your-move/**`, `resources/skills/skills/draft-to-prompt/**`, `resources/skills/CATALOG.md`, `docs/user/bundled-skills.md`, `tests/mission-v4-skills.test.ts`, `tests/bundled-sdd-skills.test.ts`, `tests/bundled-report-skills.test.ts`, `tests/spec-skill-review.test.ts`, `tests/spec-skill-authoring.test.ts`
- produces: skills-v4, writing-contract-bundled
- consumes: orchestrate-v4, verifier-v4, awareness-v4
- acs: AC-73, AC-74, AC-75, AC-76, AC-77

### S-28 · Behaviour evals for v4

- depends-on: S-27
- substrate: worktree
- files-may-touch: `scripts/eval/mission-behavior/**`, `tests/mission-v4-eval-scenarios.test.ts`, `tests/eval-mission-procs.test.ts`
- produces: evals-v4
- consumes: skills-v4
- acs: AC-78, AC-79

### S-29 · Proactive missions

- depends-on: S-24, S-27
- substrate: worktree
- files-may-touch: `src/main/missions/proactive.ts`, `src/main/mcp/tool-handlers.ts`, `src/main/mcp/tool-catalog.ts`, `docs/harnu-features.md`, `CHANGELOG.md`, `tests/mission-proactive-ack.test.ts`
- produces: proactive-missions, agent-side
- consumes: skills-v4, awareness-v4, verbs-v4
- acs: AC-80, AC-81

**Chapter 6 · Landing check**

### S-30 · Landing check: old records open in a build of main

- depends-on: S-28, S-29
- substrate: worktree
- files-may-touch: `scripts/verify/missions-v4-landing.mjs`, `tests/e2e/**`, `docs/dev/missions-v4-landing.md`
- produces: landing-checked
- consumes: pane, agent-side, evals-v4
- acs: AC-82, AC-83

### S-31 · Record what the new model supersedes

- depends-on: S-29
- substrate: worktree
- files-may-touch: `docs/adr/0015-mission-as-structured-capy-data.md`, `docs/adr/0023-campaign-as-a-separate-record-chapters-are-missions.md`, `docs/specs/2026-09-26-mission-progress/design.md`, `docs/specs/2026-10-01-mission-v3/spec.md`, `docs/specs/2026-10-09-mission-cue-noise/spec.md`, `docs/specs/2026-10-30-campaign/spec.md`, `tests/mission-v4-stale-words.test.ts`
- produces: supersede-recorded
- consumes: agent-side
- acs: AC-84, AC-85

## Acceptance criteria

`proof` is typed (`test:<file>::<name>`, `script:<cmd>`, `capture:<route>@<state>`, `record:<kind>`). A `capture:mission-pane@<state>` names a state of the draft mockup's screen. Test names are the names the slice's session writes; a verifier reads the test, not the name. `covers` lists request atoms; `—` means the AC closes a decision row instead (see Open decisions).

| id    | statement                                                                                                                                                                                                                                        | proof                                                                                                                                                 | refines/inherits | covers           |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ---------------- |
| AC-1  | The compatibility fixtures are real v3 files: each parses with the v3 parser on main and its sha256 is pinned, so a later change shows.                                                                                                          | test:tests/mission-v4-fixtures.test.ts::fixtures are frozen v3                                                                                        | —                | R-23             |
| AC-2  | Every caller reads missions through one store: the verbs, the IPC, the campaign reader and hibernation give the same answer for the same repo, including shadow-copy dedupe and the leader of a delivered mission.                               | test:tests/mission-store.test.ts::one reader for every caller                                                                                         | —                | R-25             |
| AC-3  | Deriving a mission view writes nothing: the file bytes and updatedAt stay the same, no steward is woken and no sidecar row is appended; only the observer writes.                                                                                | test:tests/mission-derive-pure.test.ts::a read has no side effects                                                                                    | —                | R-25             |
| AC-4  | Rows Harnu observes (pull request opened or merged, CI, session ended) are stored beside the mission in the repo, and the close-out consolidator sees them.                                                                                      | test:tests/mission-ledger-store.test.ts::consolidator sees observed rows                                                                              | —                | R-25             |
| AC-5  | Rows already in the userData cache are copied into the new store and the cache is left in place.                                                                                                                                                 | test:tests/mission-ledger-store.test.ts::import copies and keeps the cache                                                                            | AC-4             | R-23             |
| AC-6  | One server-owned waiting list feeds the MCP read, the companion, Your move and the renderer; a pending decision is in it; no consumer builds its own list or its own wording of an item.                                                         | test:tests/mission-waiting.test.ts::one list feeds every reader                                                                                       | —                | R-1, R-25        |
| AC-7  | Chapter 2 changes nothing the operator sees: the existing mission suites pass unchanged.                                                                                                                                                         | script:npx vitest run tests/mission-handlers.test.ts tests/mission-ipc.test.ts tests/missions-store.test.ts tests/mission-view.test.ts --maxWorkers=4 | —                | R-25             |
| AC-8  | The v4 record parses and serializes without loss: Mission, optional Milestone, Step, acceptance criterion, session entry, blocker with an id. A mission with no milestones is valid.                                                             | test:tests/mission-model.test.ts::a mission with no milestones is valid                                                                               | —                | R-2, R-19        |
| AC-9  | Every write refuses text over its cap, names the cap and the length, and never cuts the text: mission 60, milestone 45, step 50, next-step ask 90, its why 60, criterion 70.                                                                     | test:tests/mission-contract.test.ts::over-cap text is refused and never cut                                                                           | AC-8             | R-14             |
| AC-10 | The checkable writing rules refuse: an id at the start or end of a title, an empty or one-word criterion, a blocker that names no exact thing, and the banned state words.                                                                       | test:tests/mission-contract.test.ts::ids and state jargon are refused                                                                                 | AC-9             | R-14             |
| AC-11 | One state vocabulary: a step is to do, running, waiting for review or done; blocked is a mark on it; a milestone's state is derived from its steps.                                                                                              | test:tests/mission-state.test.ts::step and milestone states                                                                                           | —                | R-1              |
| AC-12 | A criterion is settled four ways and no other: by a fact, by a second session, by the operator, or by another person that the operator marks. A self-check never settles it.                                                                     | test:tests/mission-state.test.ts::four ways to settle and a self-check does not                                                                       | AC-11            | R-3, R-21        |
| AC-13 | A criterion that waits for another person shows as waiting for that person and is not the operator's next step.                                                                                                                                  | test:tests/mission-waiting-v4.test.ts::a person's sign-off is not the operator's next step                                                            | AC-12            | R-21             |
| AC-14 | A fact replaces stale state: a blocker that names the fact it waits for stops showing when the fact holds, and a criterion tied to a fact is never ticked by hand.                                                                               | test:tests/mission-state.test.ts::a merged pull request clears the blocker that waited for it                                                         | AC-12            | R-3              |
| AC-15 | Progress counts milestones when the mission has them and steps when it has none; optional milestones and steps stay outside the count.                                                                                                           | test:tests/mission-progress-v4.test.ts::the unit follows the plan                                                                                     | AC-11            | R-2, R-19        |
| AC-16 | More than one milestone can be open at once, and the milestone summary counts running, waiting for review, blocked and to do steps.                                                                                                              | test:tests/mission-progress-v4.test.ts::three milestones can wait for review at once                                                                  | AC-15            | R-16, R-17       |
| AC-17 | The waiting list has one next step and the rest in a fixed order (main failing, unblock, settle, review, close, attach); five waiting items with nothing running give one next step.                                                             | test:tests/mission-waiting-v4.test.ts::five waiting items give one next step                                                                          | AC-13            | R-7              |
| AC-18 | The summary has five parts (Goal, Where it is, Decided, Stopped at, Next step) plus the open criteria and the links, is built from the record alone and stays under 8,000 characters.                                                            | test:tests/mission-summary.test.ts::the summary has five parts and a cap                                                                              | —                | R-9              |
| AC-19 | Deriving the view of a 10-milestone, 21-step mission stays inside the existing git and gh spawn budget: reads use the sticky caches.                                                                                                             | test:tests/mission-list-benchmark.test.ts::v4 view stays inside the spawn budget                                                                      | AC-3             | R-25             |
| AC-20 | Reading a v3 mission or campaign as v4 writes nothing: the file bytes are identical before and after.                                                                                                                                            | test:tests/mission-v4-compat.test.ts::reading leaves the file untouched                                                                               | AC-1             | R-23             |
| AC-21 | The first write to a v3 mission copies the original byte for byte to an archive file beside it before the v4 file is written, and keeps the whole v3 frontmatter under legacyV3.                                                                 | test:tests/mission-v4-compat.test.ts::the first write keeps the original                                                                              | AC-20            | R-23             |
| AC-22 | v3 concepts map to v4 as the compatibility table says: checks become operator criteria, a verified step becomes a settled second-session criterion, the fixed end becomes Done when, decision nodes become blockers, side steps become optional. | test:tests/mission-v4-compat.test.ts::v3 concepts map to v4                                                                                           | AC-21            | R-23             |
| AC-23 | A campaign reads as one mission: chapters are milestones in order, an optional chapter is an optional milestone, a chapter with no mission is a milestone with no steps, and the chapter missions' steps are its steps.                          | test:tests/mission-v4-compat.test.ts::a campaign reads as one mission                                                                                 | AC-20            | R-23, R-2        |
| AC-24 | A campaign that is mid-flight converts by copy on its first v4 write into one new mission; the campaign and chapter files are never modified (hashes equal) and their old ids still resolve to the new mission.                                  | test:tests/mission-v4-compat.test.ts::a mid-flight campaign converts by copy                                                                          | AC-23            | R-23             |
| AC-25 | Conversion is deterministic and idempotent: converting twice, or two sessions converting at once, leaves one mission.                                                                                                                            | test:tests/mission-v4-compat.test.ts::conversion is idempotent                                                                                        | AC-24            | R-23             |
| AC-26 | Creating a step creates its board card in backlog with mission, milestone and step fields, and the criteria appear in the card body as one marked block that only Harnu rewrites.                                                                | test:tests/mission-cards.test.ts::a step is a card with a marked block                                                                                | —                | R-2, R-3         |
| AC-27 | A step's state follows its card: backlog and ready read as to do, in progress as running, review as waiting for review, and the operator closing the card reads as done. Harnu never moves a card to done.                                       | test:tests/mission-cards.test.ts::the card column is an input and Harnu never closes a card                                                           | AC-26            | R-1, R-2         |
| AC-28 | mission_get returns progress, next step, the waiting list, the summary and each step's criteria in one call for the mission the calling session is attached to, and refuses an unattached session with NOT_ATTACHED and the way out.             | test:tests/mission-verbs-read.test.ts::get answers for the attached mission only                                                                      | —                | R-10             |
| AC-29 | mission_create takes a title, a Done when, optional milestones, steps with criteria and links; it needs no approval and the mission is active at once.                                                                                           | test:tests/mission-verbs-read.test.ts::create needs no approval                                                                                       | —                | R-19, R-22       |
| AC-30 | The plan verbs add a milestone, a step, a criterion and a link; they only add (an agent never removes a step or a criterion); a step added after work started needs a reason.                                                                    | test:tests/mission-verbs-plan.test.ts::agents add and never shrink                                                                                    | AC-9             | R-2, R-3         |
| AC-31 | A pull request on a step's branch attaches to the step by itself, and a page or report link must be an http(s) address or a repo path.                                                                                                           | test:tests/mission-step-links.test.ts::the pull request attaches by itself                                                                            | AC-30            | R-18             |
| AC-32 | The state verbs set and clear blockers (each with an id), stage a change to Done when for the operator, settle a second-session criterion with evidence, ask to close and ask to attach; each refuses a session that is not attached.            | test:tests/mission-verbs-state.test.ts::state verbs need an attachment                                                                                | AC-28            | R-10             |
| AC-33 | Asking to close is refused with STEPS_OPEN while a step is not done; the operator's close is never refused.                                                                                                                                      | test:tests/mission-verbs-state.test.ts::the agent's close request and the operator's close differ                                                     | —                | R-11             |
| AC-34 | The operator doors exist and never refuse: mark a criterion, clear a blocker, approve a new Done when, close as delivered or discarded (open matters are warnings), allow or deny an attach request, and hand off.                               | test:tests/mission-doors-v4.test.ts::doors never refuse                                                                                               | —                | R-11             |
| AC-35 | Attaching a session needs the operator's confirmation, from the pane or an Allow on a request; a session the leader dispatched for a step is attached as a worker without a prompt.                                                              | test:tests/mission-attach.test.ts::attach needs confirmation                                                                                          | —                | R-10             |
| AC-36 | The mission keeps its history of sessions with role, from, to and where each stopped; a hand-off sets the old session's role to worked and stamps where it stopped.                                                                              | test:tests/mission-attach.test.ts::the mission remembers its sessions                                                                                 | AC-35            | R-9              |
| AC-37 | A hand-off is always the operator's: nothing but the hand-off door starts a session or changes who leads, and high context only produces a suggestion.                                                                                           | test:tests/mission-handoff.test.ts::harnu offers and never switches                                                                                   | AC-34            | R-11             |
| AC-38 | The leader of a mission gets the summary after a compaction and at the start of a hand-off session, without a steward.                                                                                                                           | test:tests/mission-summary-route.test.ts::the leader gets the summary after compaction                                                                | AC-18            | R-9              |
| AC-39 | The Mission pane is a pane in the helper stack that the Topbar pill opens and closes; it follows the selected session and shows only that session's mission.                                                                                     | test:tests/mission-pane-follow.test.ts::the pane follows the selected session                                                                         | —                | R-5, R-6         |
| AC-40 | The pill reads like "4/21 · 3 for you" from the server's numbers (milestones when the mission has them), with no campaign or chapter wording.                                                                                                    | test:tests/mission-pill-v4.test.ts::the pill reads the derived numbers                                                                                | AC-39            | R-5, R-7         |
| AC-41 | At a glance the pane shows the mission title, a progress bar with the count inside it, one next step and "N more waiting on you", and no Done when paragraph.                                                                                    | capture:mission-pane@default                                                                                                                          | AC-39            | R-7              |
| AC-42 | The tree opens with chevrons, milestone then step then criteria, and only the current milestone opens by itself.                                                                                                                                 | test:tests/mission-pane-tree.test.ts::only the current milestone opens                                                                                | AC-41            | R-8              |
| AC-43 | A vertical line joins the milestone glyphs, green behind a done milestone, and runs through an open milestone's steps.                                                                                                                           | capture:mission-pane@big                                                                                                                              | AC-42            | R-13             |
| AC-44 | A milestone's summary line counts running, waiting for review and blocked; inside a milestone the steps run needs-the-operator first, then running, then the rest collapsed behind "N more".                                                     | test:tests/mission-pane-order.test.ts::the order inside a milestone                                                                                   | AC-16            | R-17             |
| AC-45 | A 10-milestone mission where nothing runs and five things wait shows the next step first and the other four one click away.                                                                                                                      | capture:mission-pane@big-waiting                                                                                                                      | AC-17            | R-7, R-8         |
| AC-46 | An open step lists its criteria with who settles each (automatic, second session, you, another person), collapses the verified ones into one line such as "19 criteria verified" and lists only the open ones.                                   | capture:mission-pane@step-open                                                                                                                        | AC-42            | R-3              |
| AC-47 | A blocked step shows the exact thing needed and the unblock action; the operator can mark an operator criterion done and mark another person's sign-off when they approve.                                                                       | capture:mission-pane@step-blocked                                                                                                                     | AC-46            | R-3, R-21        |
| AC-48 | The pull request number on a step is a link, and an open step lists the links its session produced, including the address of the finished page.                                                                                                  | test:tests/mission-pane-links.test.ts::step links open                                                                                                | AC-31            | R-18             |
| AC-49 | The sessions row lists every session that worked on the mission with role, from, to and where it stopped, and says which one leads.                                                                                                              | capture:mission-pane@sessions                                                                                                                         | AC-36            | R-9              |
| AC-50 | "Continue in a new session…" shows the summary the new session starts with and asks for confirmation; on confirm Harnu starts the session, attaches it as leader and releases the old one.                                                       | capture:mission-pane@handoff-confirm                                                                                                                  | AC-37            | R-9, R-11        |
| AC-51 | When the leading session's context is high the pane offers the hand-off, "Not now" keeps it quiet, and nothing else happens.                                                                                                                     | capture:mission-pane@handoff-suggest                                                                                                                  | AC-37            | R-11             |
| AC-52 | A session with no mission sees the folder's open missions with Attach and "Start a new mission"; attaching asks for confirmation.                                                                                                                | capture:mission-pane@no-mission                                                                                                                       | AC-35            | R-6, R-10        |
| AC-53 | A session that asks to lead or join shows Allow and Deny in the pane and chimes.                                                                                                                                                                 | capture:mission-pane@attach-request                                                                                                                   | AC-35            | R-10             |
| AC-54 | Ask on a milestone sends the question to the leading session the way "Reference in session" does, and the answer appears in that session.                                                                                                        | test:tests/mission-pane-ask.test.ts::ask goes to the session                                                                                          | —                | —                |
| AC-55 | A small task is a mission with no milestones: steps sit directly on the timeline, the criteria pulled from the task show, and another person's sign-offs show as marks the operator ticks.                                                       | capture:mission-pane@simple-signoff                                                                                                                   | AC-15            | R-19, R-20, R-21 |
| AC-56 | Closing a mission from the pane offers Close as delivered and Discard, lists open matters as warnings and never refuses.                                                                                                                         | test:tests/mission-close-confirm.test.ts::close never refuses                                                                                         | AC-34            | R-11             |
| AC-57 | A sample mission can be shown in the pane with no record on disk, so every state is visible without a live delivery.                                                                                                                             | test:tests/mission-pane-sample.test.ts::the sample needs no file                                                                                      | —                | R-5              |
| AC-58 | The sidebar chip, the Activity cue, Your move cards, the companion mod and the hibernation exemption read the v4 view; the leader of an open mission, ready to close included, is never parked.                                                  | test:tests/mission-readers-v4.test.ts::readers use the v4 view                                                                                        | AC-6             | R-1, R-9         |
| AC-59 | A false alarm beats a miss: an operator-owned blocker, an attach request and a mission ready to close still chime and re-nudge, and a decrease never chimes.                                                                                     | test:tests/mission-cue.test.ts::cues keep recall over quiet                                                                                           | AC-58            | R-10             |
| AC-60 | The old surfaces are gone: the mission and campaign popovers, the step rail, the review and bulk-close dialogs, the steward dialog and block, and the campaign libraries and store have no file, no import and no i18n key.                      | test:tests/mission-old-surfaces-removed.test.ts::nothing of the old surfaces is left                                                                  | —                | R-5, R-12, R-15  |
| AC-61 | The pane is the only mission surface: there is no kanban view of a mission and no list of missions across the repo outside the attach picker.                                                                                                    | test:tests/mission-old-surfaces-removed.test.ts::no second mission surface                                                                            | AC-60            | R-12, R-6        |
| AC-62 | design.md describes the Mission pane, the pill and the glyphs, and the design-entity map in CLAUDE.md lists the new components and none of the removed ones.                                                                                     | record:design-md                                                                                                                                      | —                | R-5              |
| AC-63 | A session Harnu spawned for a step can read its mission, add links, log, and set a blocker on its own step; a verifier can settle a second-session criterion; none can lead, attach itself or touch another mission.                             | test:tests/mission-scoped-sessions.test.ts::spawned sessions hold scoped verbs                                                                        | —                | R-3, R-10        |
| AC-64 | For a session Harnu spawned, the session id comes from its own credential, so a verifier that built the step is recognised and its check reads as a self-check.                                                                                  | test:tests/mission-scoped-sessions.test.ts::spawned identity is not self-declared                                                                     | AC-63            | R-3              |
| AC-65 | No steward is created; on the first boot of v4 each existing steward's worker and hooks are removed and the mission Log says so; no steward code remains.                                                                                        | test:tests/steward-retired.test.ts::stewards are retired at boot                                                                                      | —                | —                |
| AC-66 | rebase_stack works for a mission's leader without a steward and still never pushes.                                                                                                                                                              | test:tests/rebase-stack-leader.test.ts::the leader can rebase a step                                                                                  | —                | R-24             |
| AC-67 | The catalog's mission verbs are exactly the v4 set (16 including rebase_stack, from 22): every removed verb is absent and the awareness verb index matches.                                                                                      | test:tests/mission-verbs-contract.test.ts::the catalog matches the fate table                                                                         | —                | R-24             |
| AC-68 | A v3 record keeps working through the flip: the v4 verbs read it and the first write converts it, and no verb of the old set remains.                                                                                                            | test:tests/mission-v4-compat.test.ts::verbs on a v3 record                                                                                            | AC-21            | R-23             |
| AC-69 | The awareness doc's mission text is one section of at most 2,000 words (v134: about 6,900) with no campaign, steward, merge-batch, popover or lineage-tag wording, and the marker is bumped.                                                     | test:tests/harnu-features-mission-size.test.ts::mission text stays short                                                                              | —                | R-24             |
| AC-70 | The user guide describes missions on one page, the agent-control page points to it, and the roadmap page says a card can be a step.                                                                                                              | script:node scripts/ci/user-docs-gate.mjs                                                                                                             | —                | R-24             |
| AC-71 | orchestrate-delivery plans milestones and steps with criteria and never a campaign or a chapter, hands over by attach and the operator's hand-off, and is under 700 lines (from 1,225).                                                          | test:tests/skill-orchestrate-delivery-v4.test.ts::the skill speaks v4                                                                                 | —                | R-24, R-9        |
| AC-72 | delivery-verifier settles criteria one by one on the step through the scoped verb, and delivery-watchdog has no steward half.                                                                                                                    | test:tests/skill-delivery-verifier-v4.test.ts::the verifier settles criteria                                                                          | —                | R-3, R-24        |
| AC-73 | No bundled skill names a removed verb or says campaign, chapter, popover, fixed end or merge batch; the tick first line and the child report header are unchanged.                                                                               | test:tests/mission-v4-skills.test.ts::skills speak v4                                                                                                 | —                | R-24             |
| AC-74 | The three places that forbid a hand-off no longer do; the rule is that the operator decides it.                                                                                                                                                  | test:tests/mission-v4-skills.test.ts::hand-off is the operator's decision                                                                             | AC-73            | R-9, R-11        |
| AC-75 | The writing contract ships as a reference the mission-writing skills load, and the verbs enforce its checkable part.                                                                                                                             | test:tests/mission-v4-skills.test.ts::the writing contract is bundled                                                                                 | AC-10            | R-14             |
| AC-76 | The mission skill describes task intake: the QA criteria become the build step's criteria, a line that says what is not expected becomes a note, empty groups pull nothing and are flagged, and the task's links become mission links.           | test:tests/mission-v4-skills.test.ts::intake rules                                                                                                    | —                | R-20             |
| AC-77 | CATALOG.md is bumped to v23 and Settings → Skills text matches the changed skills.                                                                                                                                                               | test:tests/mission-v4-skills.test.ts::catalog marker is bumped                                                                                        | —                | R-24             |
| AC-78 | A fresh session started from the summary alone answers five questions: the goal, the next step, what is blocked and on what, what waits for review, and what was decided.                                                                        | script:npm run eval:mission -- cold-start                                                                                                             | AC-18            | R-9              |
| AC-79 | The behaviour evals run against v4 with scenarios for create with milestones, attach, settle and hand-off, and none for a campaign or a steward.                                                                                                 | test:tests/mission-v4-eval-scenarios.test.ts::scenarios are v4                                                                                        | —                | R-24             |
| AC-80 | A session with no mission that dispatches two sessions or makes a worktree gets a hint in the ACK to create a mission, and a mission it creates is active at once.                                                                               | test:tests/mission-proactive-ack.test.ts::the ack tells a session to start a mission                                                                  | —                | R-22             |
| AC-81 | The agent rule is in the awareness doc and the mission skill: at the first sign of multi-step work, create the mission before the first step, without asking.                                                                                    | test:tests/mission-proactive-ack.test.ts::the rule is stated                                                                                          | AC-80            | R-22             |
| AC-82 | A v3 mission file and a v3 campaign file with its chapter missions, copied from a real-shaped repo into a throwaway one, open in the pane in a build of main with nothing rewritten and the originals intact.                                    | script:node scripts/verify/missions-v4-landing.mjs                                                                                                    | AC-20            | R-23             |
| AC-83 | The compatibility suite passes on main after the last merge, and a screenshot of the migrated mission in the pane exists.                                                                                                                        | capture:mission-pane@big                                                                                                                              | AC-82            | R-23             |
| AC-84 | ADR-0015 and ADR-0023 say they are superseded by the new ADR, and the earlier mission, campaign and cue-noise specs carry a dated superseded note.                                                                                               | record:adr                                                                                                                                            | —                | R-24             |
| AC-85 | No tracked source, doc or skill uses the retired words (campaign map, popover, merge batch, steward tick) outside the history files.                                                                                                             | test:tests/mission-v4-stale-words.test.ts::retired words are gone                                                                                     | AC-73            | R-24             |

## Open decisions

The operator is offline and said not to depend on them, so none is left `open`. Each row below is resolved with its choice and reason, and each is a call made for the operator, to review. Rows D-1 to D-15 cover every item under "Proposed, not yet confirmed", "Open for the spec" and the calls made on the findings from the real campaign; D-16 to D-27 are calls the spec itself needed. Each resolved row is also recorded as one line in project memory.

| id   | question                                                                                                                      | options                                                           | choice and reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | status   |
| ---- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| D-1  | What does Ask on a milestone do in the first version?                                                                         | answer in the session; answer in the pane                         | Answer in the session. The text goes to the leading session the way "Reference in session" does, and the answer appears there. Reason: an answer rendered in the pane would need a second place that shows conversation, which the pane must not become. Call made for the operator, to review.                                                                                                                                                                                                         | resolved |
| D-2  | Is there an automatic timeline (plan, outputs, waiting on you) for a session that has no mission?                             | build it; do not build it                                         | Not built. The substitutes are the agent rule, the ACK hint and "Start a new mission" (proactive missions). Reason: without a transcript source for a step list (D-4) it would be a guess, and a guess drawn as a plan is worse than none. Call made for the operator, to review.                                                                                                                                                                                                                       | resolved |
| D-3  | How is the writing contract enforced: length caps in the verbs, rules in the skills, or does Harnu rewrite a text that fails? | caps only; caps plus rules plus evals; Harnu rewrites             | Three layers, and Harnu never rewrites. The verbs refuse over-cap and rule-breaking text and say why; the bundled reference and the skills teach the rest; behaviour evals grade it. Caps: 60, 45, 50, 90 plus 60, 70, 16. Reason: a rewritten sentence changes meaning behind the agent's back, and a refusal teaches the agent in one round trip. Call made for the operator, to review.                                                                                                              | resolved |
| D-4  | Can Harnu read an agent's own step list from the transcript?                                                                  | yes; no                                                           | No. In every transcript under the local Claude Code project store (checked 2026-11-14) no tool call carries a step list: the only task tool seen is TaskStop. The source of a plan is the agent calling mission_create. Reason: do not build on a signal that is not there. Call made for the operator, to review.                                                                                                                                                                                      | resolved |
| D-5  | Is today's post-compaction Mission Brief good enough to cold-start a fresh session?                                           | keep; replace                                                     | Replace it with the mission summary. The Brief has no next step, no waiting items, no milestone position, no session history and no links; it is capped at 6,000 characters, printed only after a compaction and only to the owner of a stewarded mission. The summary adds all of those, is served on demand and at hand-off, and is proven by a cold-start eval (AC-78). Call made for the operator, to review.                                                                                       | resolved |
| D-6  | What does "To do" cover on the board?                                                                                         | Backlog only; Backlog and Ready                                   | Backlog and Ready. Both mean not started; Ready only means the operator allows dispatch, which is a board concern. In progress reads as running, Review as waiting for review, Done as done. Call made for the operator, to review.                                                                                                                                                                                                                                                                     | resolved |
| D-7  | What happens to the steward?                                                                                                  | keep; fix; retire                                                 | Retire it. A mission is led by one session that attaches, and a hand-off replaces its resume role; the verifier dispatch and nudges move to the leader's own loop and the observe-mode watchdog. The steward has three open defects (BUG-241, BUG-253, BUG-258), was never wired in the map, and the delivery map already runs without one. Existing stewards are removed at the first boot of v4 and the mission Log says so (S-22). rebase_stack stays (D-24). Call made for the operator, to review. | resolved |
| D-8  | How are missions and campaigns written by v3 migrated?                                                                        | convert all at upgrade; read as a view and convert on first write | Read as a view, convert on first write, always keeping the original: in-place upgrade with a byte-exact archive copy for a mission, conversion by copy with sidecars for a campaign (section Compatibility). Reason: other repos hold files this build cannot see, and a bulk rewrite at upgrade is exactly the destructive step the operator ruled out. Call made for the operator, to review.                                                                                                         | resolved |
| D-9  | Can more than one milestone be open at once?                                                                                  | no, strictly one; yes, for display                                | Yes. A milestone is not started, in progress, waiting for review or done, and several can be open: in the real campaign studied, milestones 2, 3 and 4 were built on stacked pull requests while milestone 1 waited for review. Decision 16 still holds for planning: agents take milestones in order. Call made for the operator, to review.                                                                                                                                                           | resolved |
| D-10 | What does the progress bar count?                                                                                             | steps always; milestones when the mission has them                | Milestones when the mission has them ("1 of 10 milestones done"), steps otherwise. Reason: later milestones have no steps yet, because only the next ones are planned in detail. Call made for the operator, to review.                                                                                                                                                                                                                                                                                 | resolved |
| D-11 | How does a step with 20 or more criteria show?                                                                                | list all; collapse the verified                                   | Collapse the verified ones into one line ("19 criteria verified") and list only the open ones. Call made for the operator, to review.                                                                                                                                                                                                                                                                                                                                                                   | resolved |
| D-12 | Who clears state that a fact already settled?                                                                                 | a person; the fact                                                | The fact. A blocker may declare clearsWhen (pr-merged, ci-green, main-green) and stops showing when it holds; a criterion tied to a fact is never ticked by hand. Reason: the real mission still showed a blocker for a pull request that had merged, and a human check for "CI is green once the fix lands". Call made for the operator, to review.                                                                                                                                                    | resolved |
| D-13 | What about optional milestones?                                                                                               | drop them; keep them                                              | Keep them, labelled optional, outside the count and collapsed under one line. Two of the real plan's milestones were optional. A v3 side step reads as an optional step. Call made for the operator, to review.                                                                                                                                                                                                                                                                                         | resolved |
| D-14 | What does the pane show when nothing runs and five things wait for the operator?                                              | all five; one and the rest on demand                              | The next step first and the other four one click away ("4 more waiting on you"), ordered by rank (main failing, unblock, settle, review, close, attach), plan order inside a rank. Ordering by age is deferred (NG-4). Call made for the operator, to review.                                                                                                                                                                                                                                           | resolved |
| D-15 | Where do a step's links come from?                                                                                            | the agent only; Harnu collects them                               | Both. The pull request on the step's branch attaches by itself (Harnu already resolves it); pages and reports come from the links the step's session wrote, which the footer Links shelf already collects, and the agent can add one with mission_link. Only http(s) addresses and repo paths are accepted. Call made for the operator, to review.                                                                                                                                                      | resolved |
| D-16 | Does a done step move its board card to Done?                                                                                 | yes; no                                                           | No. Moving a card to Done stays the operator's door; Harnu never does it. The step reads done from its criteria (or from the operator closing the card). Cost: a done step can sit in Review on the board until the operator closes it; a board chip for that is left out of this delivery. Call made for the operator, to review.                                                                                                                                                                      | resolved |
| D-17 | What happens to decision nodes?                                                                                               | keep; an operator blocker                                         | An operator blocker whose reason is the question and its options; the operator answers with "Done, continue" and the agent records the choice with mission_log kind decision. Reason: the concept has no decision entity, and a blocker already has an owner, an exact reason and a door. v3 nodes convert this way. Call made for the operator, to review.                                                                                                                                             | resolved |
| D-18 | What happens to the review dialog and bulk close, which are cross-mission surfaces?                                           | keep; remove                                                      | Remove them. A mission whose leader is gone is reached from any session's attach picker and closed in the pane; the Activity cue stays and points at the session. Cost: closing many finished missions takes one click each. Call made for the operator, to review.                                                                                                                                                                                                                                     | resolved |
| D-19 | Who may attach a session without a confirmation prompt?                                                                       | nobody; sessions the leader dispatches                            | A session the leader dispatches for a step is attached as worked without a prompt, because the operator already approved the dispatch. Any session that asks to lead or join on its own needs the operator's Allow, and the pane's picker confirms. Call made for the operator, to review.                                                                                                                                                                                                              | resolved |
| D-20 | Where do the observed ledger rows live?                                                                                       | userData cache; beside the mission in the repo                    | Beside the mission, in the repo, append-only, so the consolidator sees them and they survive a machine change. Rows in the userData cache are copied in and the cache is left alone (AC-4, AC-5). Call made for the operator, to review.                                                                                                                                                                                                                                                                | resolved |
| D-21 | How does the mission close without the fixed step "Delivered and verified"?                                                   | keep the step; Done when confirmed at close                       | Done when is a sentence the operator confirms in "Close mission…". The agent's request is refused STEPS_OPEN while a step is not done; the operator's close is never refused. The orchestrate-delivery skill plans a last step, "Check the whole mission against Done when", with a second-session criterion, as a convention rather than an engine rule. Call made for the operator, to review.                                                                                                        | resolved |
| D-22 | Does Harnu create a mission by itself when a session shows intent?                                                            | automatic; the agent creates it; Harnu proposes with one click    | The agent creates it (rule plus ACK hint), and the pane offers "Start a new mission". Harnu does not create a file on its own. Reason: a mission file per chat is noise in the repo. To make it fully automatic later, move the ACK hint into a create. Call made for the operator, to review.                                                                                                                                                                                                          | resolved |
| D-23 | Is a session id still self-declared?                                                                                          | yes; authenticated where possible                                 | Authenticated for sessions Harnu spawned, from their scoped credential (S-21); self-declared (convention plus audit) for every other session. Call made for the operator, to review.                                                                                                                                                                                                                                                                                                                    | resolved |
| D-24 | What happens to rebase_stack without the steward and the merge batch?                                                         | remove; keep                                                      | Keep it, called by the leader. It never pushes and was not part of the merge-batch removal. Call made for the operator, to review.                                                                                                                                                                                                                                                                                                                                                                      | resolved |
| D-25 | Do the tick first line and the child report header change?                                                                    | change; keep                                                      | Keep both. The companion mod parses them and land-prs and dispatch-pr-review depend on the first line. Call made for the operator, to review.                                                                                                                                                                                                                                                                                                                                                           | resolved |
| D-26 | What happens to side steps, side quests, radiant and the prerequisite pass (consumes, produces)?                              | keep; drop                                                        | Dropped from the model; v3 values are kept under legacyV3. Side steps read as optional steps; side quests as optional milestones. Milestones are planned in order, so the prerequisite pass has nothing left to check. Call made for the operator, to review.                                                                                                                                                                                                                                           | resolved |
| D-27 | Does the evidence-bundle directory remain a rule?                                                                             | required; optional                                                | Optional. mission_settle_ac takes the evidence text; a verifier may still write a bundle under the evidence directory and link it. v3 records that required a bundle read as settled. Call made for the operator, to review.                                                                                                                                                                                                                                                                            | resolved |

## Amendments · Deviations

Append-only after approval. Never edit the sections above once the first card is dispatched; record the change here and send the affected executor a delta.

| date       | kind      | what changed                                                                                                                                                                                                                | by                    |
| ---------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| 2026-11-14 | amendment | Status approved: the approval is the operator's standing mandate of 2026-11-14 (given before going offline, with the instruction not to depend on them). The calls in the Open decisions table await the operator's review. | T703 session 1cad4914 |
| 2026-11-14 | deviation | The draft mockup's other-session state says "2 done · 1 in progress · 2 to do"; the build says "running", one vocabulary (AC-11). The mockup stays as drafted.                                                              | T703 session 1cad4914 |
| 2026-11-14 | amendment | The mockup stays at status draft; the operator steered it screen by screen but never formally approved it. The spec's UI ACs name its states as capture targets.                                                            | T703 session 1cad4914 |
