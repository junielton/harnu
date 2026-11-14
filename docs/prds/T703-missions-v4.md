# T703 — Missions v4: one model, one pane, a mission that outlives its sessions

**Status:** PRD v1 (2026-11-14) · **Card:** T703 · **Spec:** `docs/specs/2026-11-14-missions-v4/spec.md` · **ADR:** `docs/adr/0025-missions-v4-one-model-supersedes-campaigns-and-stewards.md` · **Mockup:** `docs/design/missions-v4/` (draft, 19 states of one screen)
**Supersedes:** the product contracts of Mission v3 (`docs/specs/2026-10-01-mission-v3/`), the cue-noise amendment, and the Campaign spec with its approved mockup v6 (`docs/specs/2026-10-30-campaign/`). **Depends on:** the removal of the merge batch (T701).

This PRD says what the operator and the sessions see. The spec says what is built, in which slices, and how each criterion is proven.

## 1. Who is this for

The operator: a solo maintainer with several Harnu sessions open, who comes back to a delivery after hours and needs to know in a glance where it stands and what is theirs to do. And the sessions that work for them: the one that leads a mission, the ones it dispatches for a step, and the ones that check the work.

## 2. The problem in one paragraph

Missions and Campaigns were built in layers and none was retired. The operator reads six state vocabularies and three lists of "what waits on you" that disagree, a pill that mixes two missions' numbers, and 14 surfaces, five of them dead ends. Agents read 6,900 words of awareness text about it. A session Harnu spawned cannot write to the mission it works for. A mission dies with its leader session, and three places in the agent text forbid handing it to a fresh one. The operator's own words: they open the popover to find calm and leave stressed.

## 3. What the operator sees

### 3.1 One model

**Mission → Milestone → Step.** A step is one unit of work, one pull request. A step that is dispatched to its own session or worktree is a board card; a step the leading session does itself has no card, so small work never floods the board. A milestone is an optional stop on the way ("A test set we can trust"). A small task is a mission with no milestones: its steps sit directly on the timeline. Every step carries its acceptance criteria, each one a fact that is true when it is done.

### 3.2 One pane

The Topbar pill (`4/21 · 3 for you`) opens and closes a **Mission pane** in the helper stack. The pane follows the selected session and shows only that session's mission, so two orchestrators never mix. From top to bottom:

1. The title, and a progress bar with the count inside it ("4 of 21 steps done", or "1 of 10 milestones done" when the mission has milestones).
2. **Your next step**: one box that says what to do and what it unlocks, with one button. "N more waiting on you" opens in place.
3. The tree: milestone, step, criteria, with chevrons and a vertical timeline. Only the current milestone opens by itself. A milestone's line says "4 running · 9 waiting for review · 1 blocked".
4. Sessions: who worked on the mission and where each stopped, and "Continue in a new session…", offered when the leading session's context reaches 80 percent.

Everything else is one click inside the tree: an open step shows its criteria (verified ones collapse into one line), a blocked step shows the exact thing needed and a "Done, continue" button, and the links its session produced (the pull request, the finished page).

When the selected session has no mission, the pane lists the folder's open missions with Attach, and "Start a new mission". Nothing else lists missions: there is no kanban view and no cross-mission queue.

### 3.3 Four ways a criterion is settled

An automatic fact (the pull request is merged, CI is green); a second session that checked it; you; or another person, such as a designer or a QA analyst, whom you mark when they approve. A criterion waiting on another person reads "waiting for the designer" and is not your next step. Harnu does not watch the tracker.

### 3.4 A mission that outlives its sessions

The mission lives in the folder with its plan, history and the list of sessions that worked on it. When the leading session is getting long, the pane says so and offers to continue in a new one. You decide: you see the summary the new session starts from (goal, where it is, what was decided, where each session stopped, the next step), you confirm, and Harnu starts it and releases the old one. Harnu never switches by itself. A session only touches the mission it is attached to, and attaching needs your confirmation, except for the session that creates the mission (it leads it) and for sessions dispatched for a step, which can only touch their own step.

### 3.5 What you do not have to do any more

Tick what a fact can settle; clear a blocker whose pull request has merged; open three popovers to find out what is yours; read a "Done when" paragraph at every glance.

## 4. What sessions see

- **16 verbs instead of 22.** Campaigns fold into missions (a chapter is a milestone), the checks and the verify verb become criteria verbs, owner transfer becomes attach plus the operator's hand-off, the goal-file importer goes.
- **A session Harnu spawned can finally write to its own step**: read the mission, add links, log, set a blocker, and (a verifier) settle a criterion. It cannot lead, attach itself or touch another mission.
- **Short, plain text by contract.** The verbs refuse text over its cap or that breaks the writing rules, naming the cap; nothing is cut or rewritten behind the agent's back.
- **Proactive missions.** At the first sign of multi-step work the session creates the mission and its steps itself, without asking and without a click, and leads it; the mission and its next step appear in the pane at once. A hint in the ACK of `create_session`, `create_worktree` and `submit_manifest` backs the rule up for a session that orchestrates with no mission. Harnu never creates a mission file on its own. This is a requirement with a behavioural proof: an eval scenario where a multi-step request creates a mission before the work starts, and one where a one-line question creates none.
- **A smaller doc.** The awareness text about missions goes from about 6,900 words to at most 2,000. Hand-off, forbidden today, becomes the operator's decision.

## 5. Records written by the current version

Every mission and campaign file written by the current version still opens, in every repo, and **a v4 build never modifies one**: the installed build of the current version runs beside any build of main and must keep reading them. Reading never writes. The first v4 write for a mission born in v3 creates its v4 record by copy in a new directory (`.harnu/missions-v4/`) and leaves the v3 file byte-identical; the installed build keeps showing the mission as it was at that moment and never fails. A campaign that is mid-flight reads as one mission with milestones and, on its first write, converts by copy into one new mission; the campaign and chapter files are never touched, and their old ids still lead to the new mission. A campaign's chapters that have no mission yet show as milestones with no steps. Until the cut-over, a v3 mission is served by the old popover unchanged.

## 6. What is not in this release

A kanban view; a view across missions or sessions; several orchestrators at once; two milestones planned in parallel; the sidebar tag as a cross-session signal; a limit on the review queue, a ready-to-start rule, ordering what waits by age; watching the tracker for a person's sign-off; an automatic timeline built by Harnu for a session with no mission (no transcript carries a step list, so the session creates the mission itself instead; see the proactive missions above); bulk close of finished missions (each is closed in the pane). The merge batch is gone and no surface merges.

## 7. How we know it worked

- Glance test: on the 10-milestone mission with nothing running and five things waiting, a reader finds the next step in the pane in one look, and the other four in one click.
- A cold-start session given only the mission summary answers five questions correctly: the goal, the next step, what is blocked and on what, what waits for review, what was decided.
- A v3 mission file and a v3 campaign file with its chapter missions, copied into a throwaway repo, open in a build of main with every original file byte-identical.
- The awareness doc's mission text is at most 2,000 words; the catalog lists 16 mission verbs; no skill names a removed verb.
- Every acceptance criterion of the spec is verified by a session that did not build it, and CI is green on main after the last merge.

## 8. Risks

| Risk                                                                                           | Answer                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The summary is too thin to cold-start a session (the main risk of the disposable-session idea) | A cold-start eval is an acceptance criterion; the summary adds the next step, waiting items, session stop points and links that today's brief lacks                                                                                                                  |
| A conversion loses something                                                                   | The v3 file is never touched, so nothing can be lost; dropped values are kept under `legacyV3`; conversion is deterministic and idempotent; a test per concept in the mapping table                                                                                  |
| Removing the review and bulk-close dialogs strands finished missions                           | Any session's attach picker lists the folder's open missions; each is closed in the pane. Flagged for the operator's review                                                                                                                                          |
| The steward's removal drops the verifier loop                                                  | The leader dispatches verifiers through the scoped credential; the observe-mode watchdog stays. The steward is retired at runtime without writing any mission file, and its code is deleted last                                                                     |
| Main breaks between slices                                                                     | The old comes out last: v4 verbs are registered beside the v3 ones, every caller moves, the pill opens the pane for every record, and only then are the old surfaces and verbs deleted; a test checks that no skill or doc names an unregistered verb at every slice |
| A new derive floods the main process with git and gh calls (BUG-240)                           | The v4 view reads the sticky caches; a spawn-budget test is an acceptance criterion                                                                                                                                                                                  |
| The pane grows into another overloaded popover                                                 | The pane shows the glance plus one open step at rest; the criteria of the spec count what is on screen                                                                                                                                                               |

## 9. Decisions made for the operator

The operator went offline and asked not to depend on them. Thirty-two questions were resolved in the spec's Open decisions table, each marked "call made for the operator, to review". The ones most likely to matter to them: the session creates a proactive mission itself, without asking, and Harnu never creates one on its own (D-22; an earlier draft of this PRD said Harnu proposes with one click, which is withdrawn); the steward is retired (D-7); the review and bulk-close dialogs are removed (D-18); only a dispatched step has a board card and Harnu never moves a card to Done (D-16); decision nodes become operator blockers (D-17); a v4 build never modifies a v3 file (D-30).
