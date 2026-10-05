# T82 — Design workshop (2026-07-09): 30 questions · 20 ideas · skills → board pipeline

Companion to the `T82-agent-task-manager.md` spec. Nothing here is code — it's the refinement that comes before.

---

## 1. Why the routing table can NEVER be agent-writable

The principle that organizes all of T80/T82: **the agent owns the CONTENT (bodies, specs,
proposals); the human owns the POLICY (status, Done, grants, routing, WIP)**. The routing
table is policy that multiplies money and privilege. Three attacks if the agent writes to it:

1. **Cost self-escalation** — routing itself/its workers to `opus·max`. Whoever spends
   the budget doesn't set their own allowance.
2. **Review evasion** — routing `kind: review` to `haiku·low` = choosing a weak reviewer
   for one's own work. Same class as "the agent never moves to Done".
3. **Prompt-injection laundering** — memory is agent-writable by design; a malicious card/text
   that convinces a session to "note down" a routing change would turn into policy
   with no human in the loop. That's why the table lives in folder settings/userData (human UI),
   never in `.capy/memory/`.

## 2. OQs

"OQ" = **Open Question** — question left open, numbered in the spec (§7, OQ-1…OQ-5): an operator's
decision that locks the corresponding slice until answered. The 30 questions below are the
expanded version of that — answer by number (e.g., "Q7: accept all").

---

## 3. The 30 questions

### A. Card lifecycle / schema

- **Q1.** Does a card created by proposal ALWAYS get born in `backlog`, or can the orchestrator propose
  "create + ready" merged into a single accept (1 click = card + dispatch queue)?
  res: backlog
- **Q2.** Does the v1 `kind` enum: `scout|bug|feature|review` suffice? Missing `chore`, `spike`,
  `design`, `docs`? (each new kind = one line in the routing table and one evidence rule)
  res: not sure
- **Q3.** Does `parent:` accept only 1 level (epic → card) or N (epic → story → subtask)? How does the
  board group/filter (swimlane? filter? indent)?
  res: no
- **Q4.** Do cards have an estimate (`effort`)? Who estimates: the orchestrator at creation, an automatic
  scout (scope pass, see I9), or nobody in v1?
  res: I don't think it's worth it, this is going to be done by agents, doesn't make much sense to estimate how long the agent will take
- **Q5.** Closing an epic with open children: blocks, warns, or cascades closed
  (proposal: blocks — Done of an epic is the sum of its children)?
  res: blocks
- **Q6.** Proposal REJECTED in the Inbox: evaporates, or stays visible to the orchestrator (with
  optional reason) so it learns and doesn't re-propose the same thing?
  res: not sure, but it can't accumulate clutter

### B. Proposals / Inbox

- **Q7.** Batch of 9 cards: 1 Inbox item with all 9 (all-or-nothing accept), 9 individual
  items, or 9 items + an "Accept all" button? (T96 assumes batch under grant; the exact UX
  is open)
  res: not sure
- **Q8.** Can the operator EDIT the proposal before accept (title/body/kind)? If edited,
  does `approved` still hold (authorship became mixed — who signs)?
  res: can edit, yes, marked as edited
- **Q9.** Anti-flood cap on pending proposals per session: 20? What happens on overflow —
  refuse with steering ("resolve the pending ones"), or group?
  res: not sure
- **Q10.** Which transitions does `propose_move` cover? Only `backlog→ready` and naming
  "this is finished" — or also regressions (`ready→backlog` "deprioritize",
  `in-progress→backlog` "gave up")? Never `→done`, that's fixed.
  res: whatever is most flexible, shouldn't create friction.

- **Q11.** Does a proposal have a validity period? (proposed on Tuesday, context changed,
  accept on Friday dispatches an obsolete spec — TTL? re-confirm if the repo advanced N commits?)
  res: not sure, I'd say it has no validity, if the user wants to touch the task and knows the context changed, it's their responsibility to warn the model

### C. Dispatch / routing

- **Q12.** Does the routing table get born with a sensible hardcoded default (scout=haiku·low,
  bug/feature=sonnet·high, review=opus·high) or empty until the human fills it in (no table =
  today's behavior)?
  res: that seems right to me
- **Q13.** Does the model/effort override at dispatch confirm get RECORDED on the card
  (audit of "who decided to run this on opus"), or is it ephemeral?
  res: it stays recorded so we have history of what happened
- **Q14.** Card with no `kind` at dispatch: global default, or does confirm ask for the kind on the spot?
  res: what is kind, what do you recommend
- **Q15.** Under grant, does the Ready column DRAIN itself (top-down by priority) or does each
  dispatch still require the gesture/propose? (T80 OQ-5 said "explicit gesture only" — does the
  orchestrator with a grant change the answer?)
  res: I think it can attack on its own? as long as nothing conflicts, nothing edits the same file, there's separation by wt for whatever needs it, subagent or teammate for whatever needs it, and it got the go after informing what would be executed
- **Q16.** Re-dispatch of a card whose worker died (BUG-23 class): where does the old
  `session:` go (history in the body? array?), and does partial evidence survive?
  res: you decide
- **Q17.** Does WIP=5 count `substrate: internal` cards? (subagents are the orchestrator's
  supervision, not the human's — counting or not changes the real fan-out ceiling)
  res: I didn't understand the implication of this

### D. Substrate

- **Q18.** `substrate: worktree`: does the worktree die at Close (T103) or live until merge?
  Who merges — does `reconcile-branches` become the post-Done stage?
  res: I think it has to live until it's considered done, otherwise for tweaks we'll need to redo the whole setup, which in some cases can be expensive with migrations etc
- **Q19.** `teammate` vs `session`: besides visual grouping (T99), does teammate inherit
  anything (grant? reports to the orchestrator via SendMessage? default routing model)?
  res: no idea what could be best here
- **Q20.** Is substrate immutable post-accept, or can the orchestrator propose a change (a
  card planned as `internal` that grew and deserves a worktree)?
  res: good question, couldn't this be seen beforehand?

### E. Orchestrator role / skills

- **Q21.** Does promote to orchestrator (T98) already embed a board mission grant
  (`create_card`/`propose_move` + budget), or do promote and grant stay two separate
  gestures? (1 gesture = less friction; 2 gestures = finer scope)
  res: not sure, but the idea is to have less friction managing the board
- **Q22.** Does the promote boot inject the ENTIRE `/orchestrator` skill into the system
  prompt, a summary of it, or just arm the hook + `/orchestrator` nudge? (the skill already
  exists and works — duplicating text = drift)
  res: this needs care, are there other ways to do this? We're building a harness, this skill is going to be Capy's, injected, it can't be the user's, since it's Capy's, how can we do this, can we do better?

- **Q23.** How many orchestrators per repo? 1 owner of the board, or N (one per epic)? If N,
  do proposals collide — need a lease/lock per epic?
  res: I believe 1 per repo, but remembering I can open multiple folders inside a folder, and each of those folders can be a repo, is each wt a repo? because I'll work in multiple folders, multiple wt, usually one wt is meant to solve just one problem

- **Q24.** Does the skill's **delegation packet** (objective · scope boundary · spec/ACs ·
  context pointers · skills to invoke · verification+evidence · out-of-scope · report
  format) become the canonical card body TEMPLATE? Mandatory fields or just suggested
  in `create_card`?
  res: what do you think here?

### F. Review / evidence / Close

- **Q25.** Minimum evidence PER KIND at Close: bug = test-that-was-failing-now-green; feature =
  gates+screenshot; review = written verdict? Or does v1 keep the current ("commits OR
  completed") for everything and the matrix waits for v2?
  res: I think this varies task by task? We'll have tasks that won't have a boolean of finished-or-not evidence and there only the user can say, but it has to be explicitly asked of them

- **Q26.** Card rejected in Review (human sends back): goes back to In-Progress with the deltas
  for the SAME worker (SendMessage), or clean re-dispatch? Visible bounce counter?
  res: yes, but why was it rejected? this can generate a loop of repeating the same mistakes if the session doesn't have what went wrong, the reason etc

- **Q27.** Does the Done trigger (T103) write to memory ALWAYS, or only cards with `parent`/epic
  (so `decisions.md` doesn't become micro-card noise)?
  res: avoid noise, but can't lose traceability either

### G. Boundaries / failures / migration

- **Q28.** Orphan card (linked session vanished, eternally in-progress): who detects (watcher?
  fleet-state?) and what's proposed — back to Ready? `blocked` flag?
  res: how will detection be done, once a session is opened does it pass the id to the task? can't have too many cards at boot checking if the session exists, right? but if the session vanishes the card should still have the context links like specs, plans, PRD, ADR, bootstrap, task description, ACs etc, is that enough to boot a new session, right?

- **Q29.** Can a repo's orchestrator create cards in ANOTHER repo (cross-folder proposal under
  the right grant), or is the board strictly scoped and cross-repo = N orchestrators?
  res: I think so, because imagine a scenario where a feature or fix belongs to another repo or branch, the orc can propose something and leave it there, and when the user enters the repo they'll see the card there

- **Q30.** Migration of existing `memories/tasks/<ID>/` (client project tasks etc.): an importer
  that turns them into cards, or does the board only apply to new work and the legacy dies by
  natural attrition?
  res: legacy dies, I hope the harness has enough force to steer all new memories and tasks to Capy

---

## 4. The 20 ideas (model with its own board)

- **I1. Card templates by kind** — a `bug`'s `create_card` is born with the skeleton of the
  delegation packet (objective/scope/ACs/verification) pre-structured. 👍
- **I2. Board standup** — every in-progress card gets 1 periodic line from its own
  worker ("did X, stuck on Y") via append — the board becomes the daily. 👍 (doesn't this cost more?)
- **I3. Cost per card** — the usage engine (T47) attributes tokens/cost to the linked session;
  burn chip on the card; epic sums its children. Closes with T97/T100. 👍 (is this before or after starting, is it possible to estimate spend?)
- **I4. Ready dependency-aware** — a card with open `deps` gets a badge; Close of a dep
  auto-proposes naming the unblocked ones. 👍 (who controls this?)
- **I5. Swimlanes by epic** — group the board by `parent` (the visual answer to Q3).👍
- **I6. Board replay** — auditable timeline of transitions (who moved what when; the
  provenance already exists per write). 👍
- **I7. Auto-blocked** — fleet-state `stuck` on the linked session ⇒ `blocked` flag on the card
  with a reason; needs-you visible on the board, not just the sidebar. 👍
- **I8. Card chat** — thread on the card = SendMessage bridge with the worker; talk with whoever is
  executing without switching panes. 👍 seems complicated to build but it's a really good idea, how would it work? click the card and go to the session? append the session's terminal inside the card? can the card get a maximize and have the append in there like the config modal? is that it?
- **I9. Automatic scope pass** — moving a card to Ready without a spec triggers an offer of a cheap
  scout (scope-task-like) that fills in an estimate + touched files BEFORE the expensive
  dispatch. (Solves OQ-1 in practice.) 👍 Explain it to me better, but moving a card to ready without a spec isn't necessarily a problem, the task can be simple, like super simple, that a one-shot prompt solves, so I think this needs a bigger granularity level, like what complexity level does the task have, and from there we trace what criteria it needs to meet before proceeding, if it's simple a well-made prompt solves it, if it's more complicated maybe the prompt and a spec, and so it scales, and depending needs examples, screenshots, links, documentation, ADR, PRD, browser test, video transcription, frames, infra setup, database, migrations, logins, passwords, etc etc etc

- **I10. Definition-of-Done matrix** — evidence required per kind at Close (Q25 turned into
  structure). ❓ explain it to me, tell me more
- **I11. Bounce-learning** — a card rejected 2× in Review auto-proposes a lesson
  (learn-from-review) in the repo.👍
- **I12. Queue forecast** — routing table + historical durations ⇒ ETA for Ready drain
  ("with WIP 5, this queue takes ~2 days"). 👍 didn't understand but sounds good
- **I13. Importers** — the client task tracker/GitHub issues → cards (new-task's fetch already knows how;
  becomes the bridge from the client company → board). 👍 perfect, the importer can handle any MCP that lists tasks from other places
- **I14. Card → live PR** — evidence with PR URL + rendered CI status on the card (ship
  deposits this here).👍 this is nice, seems valid
- **I15. Interview mode** — before materializing cards, the orchestrator asks N directed
  questions (bug-to-issue discipline) and the answers go into the body. 👍 please, and this pairs with what I said in **I9
- **I16. Cross-repo read-only meta-board** — the "manager's desk": all boards, no dispatch
  (dispatch stays per-repo). ❓ tell me more
- **I17. Board digest** — "what moved today" enters the session/hot digest (T79-S2). 👍 who's going to build this
- **I18. Column notifications** — card arrives in Review ⇒ sound + push + item in the
  notification center (T83); arrival in Review IS a needs-you. 👍
- **I19. Board policy as code** — generalize the routing table: a per-repo human policy
  (WIP, minimum evidence, auto-dispatch on/off, routing, caps) in one place — always
  human-owned. ❓ tell me more, I have a feeling this generates the "need to approve everything" kind of friction
- **I20. Dispatch dry-run** — preview of the boot prompt + substrate + estimated cost without
  spawning (the budget of the gesture before the gesture).👍 love it, but how is this done? Anthropic's API? is it reliable? does it cost anything?

---

## 5. The 4 skills = the board pipeline (today scattered)

The central finding: **the four skills are ALREADY the pipeline stages — they just live in
`~/.claude`, invoked by hand, each with its own folder convention.** The board is the
substrate that chains them:

```
scope-task          new-task              (implement)         ship                 T103
   │                    │                      │                │                    │
   ▼                    ▼                      ▼                ▼                    ▼
[pre-Ready analysis] [substrate/worktree]  [worker executes] [evidence: PR+gates] [Close→memory]
   Q4/I9               T102                  dispatch          Review               Done
```

### `/orchestrator` ↔ T98 + T96 (the brain the board gives a body to)

- The skill's **operating loop maps 1:1 onto the board**: CONTEXT (memory_read) → PLAN
  (**create_card proposals**) → GATE (**the Inbox accept IS "go ahead"**) → DELEGATE
  (**dispatch**) → VERIFY (**Review column + evidence**) → REPORT (**the board itself is
  the report**).
- The **delegation packet is the card body template** the spec asked for (Q24) — the skill
  already solved the design; the board just makes it structural.
- The **hard enforcement** (PreToolUse hook + flag file) is exactly what T98 arms/shows.
  The skill keeps being the source of behavioral truth; Capy just makes it visible and
  governed — zero duplication.
- **Suggested skill change when S1 ships:** in DELEGATE, prefer `create_card`/
  `propose_move` over TaskCreate when the repo has a board — the orchestrator's plan becomes
  READABLE on the board instead of trapped in the session.

### `/scope-task` ↔ the pre-Ready stage (I9, practical answer to OQ-1)

- The fan-out "1 agent per AC, read-only, report with done/partial/risk/estimate" is
  EXACTLY the decomposition the orchestrator needs before creating child cards.
- Generalize the input: today it's the client task tracker; on the board the input is an
  epic card. The output stops being `memories/tasks/<ID>/scope.md` and becomes: **N child
  card proposals, each with an estimate and touched files in the body**.
- Natural kind: `scout` — cheaply routed (haiku/sonnet·low) by the routing table.

### `/new-task` ↔ T102 (`substrate: worktree`)

- Its scaffold (worktree + branch `<ID>-<slug>` + copy deps/env + ports) is what dispatch
  does with `substrate: worktree` — but via `WORKTREE.md`/T87, generic, not the
  client-project-specific script.
- The `memories/tasks/<ID>/` it creates is **what the board replaces** (its stated goal):
  the card IS the notes folder. What remains of the skill: the client task tracker fetch —
  which becomes the I13 importer.

### `/ship` ↔ Review's exit rail

- Worker finishes a `feature` ⇒ ship produces the real evidence: review-local →
  smart-commit → PR → reviewers → monitor → replies. The card enters Review with
  `evidence: [PR#, gates]` (I14) — "done-by-evidence" stops being loose commits and
  becomes a reviewed PR.
- Human Close (T103) pairs with post-merge; merging N branches from N cards is
  `reconcile-branches` (Q18).
- **The instruction "invoke ship when done" goes into the dispatch boot prompt** ("skills to
  invoke" field of the delegation packet) — T80 already planned embedding done-evidence
  gates into the prompt; ship is the executable form of that.

### What this changes in the epic

Candidate new card (**T104 — skill-stage integration**): (a) card template = delegation
packet; (b) scope pass as an optional pre-Ready stage; (c) dispatch boot prompt names the
stage's skills (implement → ship); (d) client task tracker importer. Not created yet —
decide after the 30 answers.
