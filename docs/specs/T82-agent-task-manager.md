# T82 — Agent-owned task manager (EPIC): consolidation of T96 · T97 · T98 · T100 (+ new T102/T103)

**Status:** Spec v1 (2026-07-09) · **Total effort:** L–XL (sliced) · **Base:** T80 (board + dispatch, in review) · T79 (memory, in review)
**Replaces/absorbs:** the current body of card `T82-agent-owned-task-manager` (becomes an epic pointing here).
**Sources:** PRD T80 (`prd/T80-roadmap-kanban-dispatch.md`) · cards T96/T97/T98/T100 · operator conversation 2026-07-09 (vision: "each AC becomes a card; the orchestrator decides model and substrate").

---

## 0. ⚠️ Inherited invariants (nothing here weakens them)

Everything in this epic runs ON TOP OF T80 §0. Repeating the ones this epic touches:

1. **The agent NEVER moves a card to Done.** Closing is approving; approval is human. The
   agent has no `status` write channel — and continues not to have one: the new verbs are
   **proposal-gated** (Inbox), never live writes.
2. **Provenance is server-side + fail-closed.** Stamped by the authenticated caller;
   missing/malformed ⇒ `agent` ⇒ confirm. Never read from content the agent controls.
3. **Grant bounded + disclosed + audited + revocable** (T44 §0). A board grant only
   removes the _click_, never the _disclosure_.
4. **Card body = prompt-injection surface** (becomes boot prompt). Anti-injection framing,
   size cap, secret-lint — already implemented in `roadmap-core.ts`/`roadmap-ipc.ts`.
5. **WIP In-Progress = 5** (Cummings ceiling). The orchestrator's fan-out respects the same
   ceiling — it's the natural governor of "dispatch everything."

---

## 1. Ground truth — what ALREADY exists (verified in code, 2026-07-09)

| Piece                                                                            | State                                                                              | Where                                                                   |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 5-column kanban board, drag-and-drop, per repo                                   | ✅ built                                                                           | `RoadmapBoard.vue`                                                      |
| Card = 1 `.md` with `status` frontmatter; watcher; serialized write              | ✅ built                                                                           | `roadmap-core.ts` · `roadmap-watcher.ts` · `roadmap-ipc.ts`             |
| Manual dispatch: card → Ready ⇒ confirm with verbatim boot prompt ⇒ spawn + bind | ✅ built                                                                           | `RoadmapBoard.vue offerDispatch` · `roadmap:planDispatch`               |
| Auto-dispatch under mission grant (S2), atomic budget, refund on fail            | ✅ built                                                                           | `decideDispatchGate` (`roadmap-core.ts:653`) · `roadmap-ipc.ts:313`     |
| Golden rule (completion ⇒ Review suggestion with evidence; Done human-only)      | ✅ built                                                                           | `suggestReviewTransition` (`roadmap-core.ts:519`)                       |
| Per-repo scope: worktrees share the main checkout's board                        | ✅ built                                                                           | `resolveMemoryLocation` (`mcp/memory-store.ts:64`) + T89 (central root) |
| `create_session` MCP accepts `bootOverride {model, effort}`                      | ✅ exists in the verb                                                              | `tool-catalog.ts:185`                                                   |
| Board dispatch chooses model/effort                                              | ❌ does NOT pass `bootOverride`                                                    | `sessions.ts dispatchCardSession` (only `folder + prePrompt`)           |
| Worktree-per-card (`worktree: {ref?}` in dispatch)                               | ❌ spec'd in PRD T80 §3.4, not built                                               | —                                                                       |
| MCP verb to CREATE a card                                                        | ❌ doesn't exist (refusal experienced in a real session, a client project session) | catalog only has `memory_append` (body-only)                            |
| MCP verb to move/propose status                                                  | ❌ doesn't exist                                                                   | same                                                                    |
| "Orchestrator" role visible/managed by Capy                                      | ❌ today it's a manual flag file in `~/.claude/`                                   | T98 describes                                                           |
| Model/effort routing table per card type                                         | ❌ doesn't exist                                                                   | T97 describes                                                           |
| Model+effort visibility per session in the fleet                                 | ❌ doesn't exist                                                                   | T100 describes                                                          |

**Direct answer to the operator's questions:** yes, each card is a markdown file; yes, the
board is per repo (worktrees converge to the main checkout — the "wrapper folder" works);
yes, drag-and-drop already exists; yes, there's a dispatch PRD (T80); no, dispatch doesn't
yet choose the model — the knob exists in the MCP verb but the board doesn't use it (S3
below closes this).

---

## 2. The vision (north-star scenario — what the epic delivers in the end)

> An **Orchestrator** session (visible role, T98) receives a large task (a ticket,
> an idea, a PRD). It decomposes: **each AC becomes a card** in the repo's Roadmap Kanban —
> created by the session itself via MCP, materialized by **one** human accept (batch
> proposal, T96+grant). For each card, dispatch consults the repo's **routing table**
> (T97): scout ⇒ Haiku·low, implementation ⇒ Sonnet·high, review/design ⇒ Opus. And it decides
> the **substrate** (T102): a session in the same folder, a session in a new worktree
> (isolated branch), a teammate grouped under the orchestrator — or the orchestrator holds
> the card and resolves it with internal subagents. Each worker finishes ⇒ card goes to
> **Review with evidence** (commits/gates/PR — already built). The human reviews and closes;
> **closing triggers** (T103) the memory write + finalize of the originating session. The
> board replaces the old `memories/tasks/<ID>/` — manual note-taking dies; the kanban IS
> the task manager.

What this is, in one sentence: **T80 already built the board and the rules; this epic gives
the agent the right to PROPOSE moves — and gives dispatch cost and substrate intelligence.**

---

## 3. Collision analysis — card by card, with verdict

### 3.1 T82 × T96 — **REAL COLLISION (merge)**

T96 is literally step 1 and step 4 of the T82 flow (creating cards + advancing the board),
already with the security design thought through (proposal-gated, Inbox, batch under
grant). Keeping both as sibling cards would duplicate the refinement.
**Verdict:** T82 becomes an **epic** (body points to this spec + lists the slices); **T96
becomes Slice 1 of the epic** (keeps the card, gains `parent: T82`). T82's "open questions"
about verbs collapse into the directions already written in T96.

### 3.2 T82 step 4 ("model advances the board") × T80 golden rule — **APPARENT COLLISION (already resolved by architecture)**

T82 asks for "the agent moves the card through the columns"; T80 forbids the agent from
writing `status`. The reconciliation already exists for 2/3 of the lifecycle: **dispatch ⇒
in-progress** (server-side bind) and **completion ⇒ Review suggestion**
(`suggestReviewTransition`) are movements that Capy mediates without any verb. The only
orphaned movement is **backlog → ready** (naming "this is ready to dispatch").
**Verdict:** don't create a status-write verb. Create **`propose_move`** (T96 direction 2):
the agent NAMES, the human accepts in the Inbox — and the `backlog→ready` accept already
merges into the dispatch disclosure (1 click = move + disclosed spawn). The board still has
a single status writer: the human IPC.

### 3.3 T98 × T97 × T80-S2 — **OVERLAP in "governed fan-out" (carve-out)**

T98 explicitly deferred "governed fan-out" (executors are born Sonnet, nested under the
orchestrator, plan_mission on promote). This is exactly the intersection of T97 (routing)

- T102 (substrate) + T80-S2 (grant).
  **Verdict:** T98 stays **as is** (thin wedge: toggle + badge + boot injection, effort S,
  independent — can run in parallel). Governed fan-out does NOT go back to T98: it's born
  distributed between S3 (routing) and S4 (substrate) of this epic. T98 gains `parent: T82`.

### 3.4 T97 × T100 — **NO collision (two halves of the same loop)**

T97 = dispatch side (the table decides); T100 = human side (visibility + coaching).
They share T47-P5 evidence.
**Verdict:** they stay separate. T97 enters as **Slice 3** of the epic; T100 stays out of
the epic (it's fleet observability, not task manager) but with `deps: [T97]` as already
stated.
**Security addendum to T97 (new, from this spec):** the routing table **must not be
agent-writable** — if it lived in project memory, an agent could self-route to
`opus·max`. It lives in folder settings / userData (human UI), not in `.capy/memory/`.

### 3.5 T82 (agent-owned) × T82 (memory-graph-canvas) — **ID COLLISION (renumber)**

Two cards use `id: T82`.
**Verdict:** `T82-memory-graph-canvas` → **T101** (mechanical: frontmatter `id` + file
rename). The epic owns the T82 number.

---

## 4. The key design decision: provenance × orchestrator fan-out

**The problem:** `decideDispatchGate` is fail-closed — a card with `provenance.author: agent`
ALWAYS falls to confirm, even under grant (T80 §6.1). In the north-star, ALL fan-out cards
are agent-authored ⇒ "1 approval for the batch" dies: N cards = N confirms.

**The proposed way out (keeps 1 human in the loop per card, without double confirm):**
the accept of the **create_card proposal in the Inbox is already a verbatim disclosure of
the card content** — the same content that would become the boot prompt. Approving the
creation ≡ reading and approving the spec. So:

- On accept of the proposal, the main process stamps **`approved: <ISO>` server-side**
  (CONTROLLED field, same regime as `status`/`session`/`provenance` — the agent has no
  write channel).
- `decideDispatchGate` gains a `humanApproved: boolean` input and the invariant becomes:
  **auto ⇐ live grant ∧ (author=human ∨ (author=agent ∧ approved))**.
- An agent card **without** approved (e.g., hand-edited afterward, or created via the old
  path) stays fail-closed at confirm. Editing the body AFTER accept **invalidates the
  `approved`** (the watcher detects a body change and the main process removes the stamp) —
  otherwise it becomes a bypass: approve an innocent card, edit it into a payload,
  auto-dispatch.

**Rejected alternative:** re-stamping `provenance.author: human` on accept — a structural
lie (the human didn't author it; audit loses the trail).

⚠️ This is the only point in the epic that **deliberately weakens** a T80 gate
(§6.1 "agent card always confirm") by trading it for an equivalent gate earlier in the
flow (accept-with-disclosure + invalidation on edit). It needs **explicit security
sign-off from the operator** before S2 — same bar as T80-S2/T44.

---

## 5. New proposed cards

### T102 — Dispatch substrate: where the work runs (M→L) · `parent: T82` · deps: [T80, T87]

Today's dispatch only knows "full session in the same folder." The card gains an optional
**`substrate:`** field (frontmatter, agent-propose-able via create_card, default =
`session`):

- `session` — today (same folder).
- `worktree` — implements T80 §3.4, which stayed on paper: `create_worktree` (with
  `WORKTREE.md`/T87 to be born usable) + spawn inside; branch per card; the in-grant
  worktree inherits scope (`addDynamicFolder`).
- `teammate` — spawns grouped under the orchestrator session (T99 grouping) — same
  mechanism as `session`, with parent-link in the sidebar.
- `internal` — the orchestrator does NOT dispatch: it holds the card and resolves it with
  subagents inside its own session (Claude Code's Task tool — outside Capy's reach, by
  design). The card stays bound to the orchestrator session; advancement via propose_move.

The dispatch disclosure shows the resolved substrate + model/effort. The confirm UI gains
a selector (human override per card at Allow time).

### T103 — Done trigger: closing triggers finalize + memory (S→M) · `parent: T82` · deps: [T80, T79]

On human Close (Review → Done): (a) Capy appends the final outcome to the card (evidence
is already there); (b) **dated append to memory** (`decisions` or session digest — reuses
the T79-S2 pipeline); (c) offers to **finalize the linked session** (wrap-up nudge or
archive). Per-card, not per-batch; opt-out in the confirm. Closes step 6 of the T82 flow.

### T101 — graph-canvas renumbering (mechanical, zero design)

`T82-memory-graph-canvas` → `T101-memory-graph-canvas` (id + filename). Only resolves the
collision; content untouched.

**Schema addendum (passthrough → canonical when S1 ships):** `parent: <card-id>`
(sub-task linking — the board can group/filter by epic later; passthrough preserved for
now, which `updateFrontmatterFields` already guarantees) and `kind: scout|bug|feature|review`
(the key the T97 routing table consumes).

---

## 6. Epic slicing (dependency order)

| Slice    | What                                                                                                                                                                                                                                                                                                                                   | Effort | Gate                                     | Cards      |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------- | ---------- |
| **S0**   | Doc quick-win: `docs/capy-features.md` declares the current boundary ("you can append to a card, you can't create/move — ask for the drag") + marker bump. Kills the confusion experienced live (the session found out by trial-and-error).                                                                                            | XS     | —                                        | T96 item 4 |
| **S1**   | **Proposal-gated verbs:** `create_card` (born `backlog`, Inbox accept materializes + stamps `approved`) and `propose_move` (naming; accept of `→ready` merges into the dispatch disclosure). Batch under `plan_mission` (new verb in SAFE_GRANT_VERBS? — see OQ-2). `parent`/`kind` fields accepted. capy-features + i18n + CHANGELOG. | M      | confirm-per-proposal (safe)              | T96        |
| **S2**   | **`approved` gate in auto-dispatch** (§4): server-side stamp on accept, invalidation on body edit, `decideDispatchGate` with `humanApproved`.                                                                                                                                                                                          | S      | ⚠️ **security sign-off**                 | T96/T80    |
| **S3**   | **Routing table (T97):** per-repo table (folder settings, human-only) `kind → {model, effort}`; `dispatchCardSession` starts accepting and propagating `bootOverride`; confirm UI shows and allows override.                                                                                                                           | M      | safe (it's just a default)               | T97        |
| **S4**   | **Substrate (T102):** `substrate:` on the card + worktree-per-card + teammate + internal.                                                                                                                                                                                                                                              | M→L    | in-grant worktree already covered by T44 | T102       |
| **S5**   | **Done trigger (T103).**                                                                                                                                                                                                                                                                                                               | S→M    | safe                                     | T103       |
| **∥**    | **T98 (role toggle)** runs in parallel with any slice (effort S, zero code overlap with S1–S5).                                                                                                                                                                                                                                        | S      | —                                        | T98        |
| **post** | **T100 (cost coach)** when T47-P5 gives the evidence.                                                                                                                                                                                                                                                                                  | M      | —                                        | T100       |

The north-star (§2) becomes testable at the end of S4: decomposing a task into N cards with
1 accept, dispatching with model/substrate per card, collecting Review with evidence. S5
closes the memory loop.

---

## 7. Open questions

1. **OQ-1 (PRD/spec routing, inherited from T82):** how is a card marked "needs a PRD"
   before it can go to Ready? Minimal proposal: don't block anything in v1 — the
   `refino:` field (passthrough today) remains human annotation; the orchestrator can
   fill it in at creation. A mechanical gate (e.g., Ready refuses a card `refino: PRD`
   without `spec:`) comes after real usage.
2. **OQ-2 (grant verb):** does `create_card` enter `SAFE_GRANT_VERBS` (batch of proposals
   under mission) or are proposals always free (non-mutating until accept, so they don't
   even need a grant)? Leaning: proposals don't spend grant — what spends is the accept…
   which is human. Validate against the Inbox cost model (N proposals = spam?). Cap of
   pending proposals per session (e.g., 20) as anti-flood.
3. **OQ-3 (T103):** what exactly is session finalize? (PTY wrap-up nudge · sidebar
   archive · nothing, just memory). Decide with usage.
4. **OQ-4 (board scope):** sub-boards per subfolder/worktree — deliberately deferred
   (memory is per-repo; T89 already gives per-project location override). Reevaluate if
   a monorepo's board becomes unnavigable (filter by `kind`/`parent` should suffice before
   that).
5. **OQ-5 (kind):** closed enum (`scout|bug|feature|review`) or open? Closed in v1 —
   the routing table needs predictable keys.

## 8. Epic acceptance criteria

- **AC-T82.1 (S1):** a session creates N cards via MCP; they appear as proposals in the
  Inbox; an accept materializes a `backlog` card with `provenance.author: agent` +
  stamped `approved`; no verb writes live `status`.
- **AC-T82.2 (S1):** `propose_move backlog→ready` accepted = card in Ready + dispatch
  flow triggered with a single human interaction.
- **AC-T82.3 (S2):** under a live grant, an **approved** agent card auto-dispatches; the
  same card with a body edited post-accept requires confirm again (stamp invalidated).
- **AC-T82.4 (S3):** dispatch resolves model/effort from the routing table by `kind` and
  the confirm shows + allows override; the table is unwritable by the agent.
- **AC-T82.5 (S4):** a card with `substrate: worktree` dispatches by creating a worktree
  (born usable via manifest) and binding the session to it; `internal` keeps the card
  bound to the orchestrator.
- **AC-T82.6 (S5):** human Close triggers dated append to memory + finalize offer.
- **AC-T82.7:** every agent-facing slice updates `docs/capy-features.md` + marker; i18n
  en×pt-BR; CHANGELOG.

## 9. Out of scope (epic v1)

Auto-accept of proposals (even under grant) · agent moving status directly (never) ·
agent-writable routing table (never) · sub-boards per subfolder (OQ-4) · burndown/analytics ·
~~automatic prioritization of the Ready column~~ (revised in the workshop: drain under
manifest, §10.3).

---

## 10. Workshop 2026-07-09 — consolidated decisions (30 operator answers)

Source: `T82-design-workshop.md` (operator's inline answers). Three categories:
**locked** (operator's decision), **proposed defaults** (my call on the "I don't know /
you decide" ones — valid until vetoed, revisit at S1 kickoff) and **pivots** (change the
spec above).

### 10.1 Decisions LOCKED by the operator

| Q   | Decision                                                                                                                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Proposal is ALWAYS born `backlog`.                                                                                                                                                 |
| Q3  | `parent:` = 1 level only (epic → card).                                                                                                                                            |
| Q4  | **NO time estimate** (agents execute; estimating hours doesn't make sense) — replaced by `complexity` (§10.3).                                                                     |
| Q5  | Closing an epic with open children **blocks**.                                                                                                                                     |
| Q8  | Proposal is editable pre-accept; marked `edited`; `approved` still holds (human edit = even stronger).                                                                             |
| Q10 | `propose_move` = maximum flexibility: any transition EXCEPT `→done` (fixed). No friction.                                                                                          |
| Q11 | Proposal **doesn't expire**; changed context is the operator's responsibility (disclosure shows the card's age as a courtesy).                                                     |
| Q12 | Routing table is born with a sensible hardcoded default (scout=haiku·low, bug/feature=sonnet·high, review=opus·high).                                                              |
| Q13 | Model/effort override at confirm **is recorded on the card** (audit).                                                                                                              |
| Q15 | **Auto-drain of Ready YES under grant** — conditioned on the _dispatch manifest_ (§10.3): batch plan disclosed + explicit go; worktree isolation where there's file-conflict risk. |
| Q18 | Worktree **lives until Done** (post-review tweaks can't repay expensive setup: migrations etc.). Merge = `reconcile-branches` as a post-Done stage.                                |
| Q22 | **PIVOT (§10.4):** the orchestrator contract is CAPY'S (harness-owned), not the user's personal skill.                                                                             |
| Q23 | **1 orchestrator per repo** (anchored at the main checkout; each worktree is an executor for ONE problem, not an orc).                                                             |
| Q25 | Evidence **varies per card**; when there's no mechanical evidence, Review **explicitly asks the operator** (`evidence: operator-judgment`).                                        |
| Q26 | Reject in Review **requires a reason** (mandatory); the reason enters the card history and becomes the delta for the SAME worker; bounces visible.                                 |
| Q27 | Traceability without noise: full history lives ON the card (which goes to `archive/` on close); `decisions.md` only receives epic closes.                                          |
| Q29 | **Cross-repo proposals ALLOWED**: the orc can propose a card on another repo's board (under that repo's grant/confirm); the card waits there until the operator comes in.          |
| Q30 | Legacy `memories/tasks/<ID>/` **dies by attrition**; no migration importer — the harness steers all new work to the board.                                                         |

### 10.2 PROPOSED defaults (hold until vetoed at S1 kickoff)

| Q   | Proposed default                                                                                                                                                                                                  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q2  | `kind` v1: `scout \| bug \| feature \| review \| chore`. Closed; expand with usage.                                                                                                                               |
| Q6  | Rejected proposal **evaporates from board/Inbox** (zero clutter); the reason (optional) goes back to the proposing session as steering — the learning stays with whoever proposed it.                             |
| Q7  | Batch = N items visually grouped under a batch header + **Accept all** button (individual control + low friction).                                                                                                |
| Q9  | Cap of 20 pending proposals/session; overflow = refusal with steering ("resolve the pending ones").                                                                                                               |
| Q14 | Card with no `kind` at dispatch: confirm shows a picker pre-filled with `feature` (1 click fixes it).                                                                                                             |
| Q16 | Re-dispatch: current `session:` is moved to a history log in the body (`## dispatch history`), partial evidence preserved (append-only); card goes back to Ready and the gesture is the same.                     |
| Q17 | `substrate: internal` does NOT count toward human WIP (supervision is the orc's); the orc's internal ceiling = 4–5 subagents.                                                                                     |
| Q19 | `teammate` v1 = grouping (T99) + report-back channel (SendMessage to the orc); does NOT inherit grant. More than that, only with usage.                                                                           |
| Q20 | Substrate is **proposed at creation** (part of the accept disclosure — "seen beforehand," as the operator asked); mutable via proposal until dispatch; immutable afterward (the work already lives somewhere).    |
| Q21 | Promote to orchestrator **embeds** a board grant (`create_card` + `propose_move`, budget visible in the promote disclosure) — 1 gesture, less friction, scope shown.                                              |
| Q24 | Template = delegation packet with **4 mandatory sections** (objective · ACs · out-of-scope · evidence-to-return), the rest modulated by `complexity`; enforcement by lint on accept, never refusal.               |
| Q28 | Orphan detection by CROSS-REFERENCE with fleet-state (event-driven, zero polling): in-progress card with a nonexistent/exited sessionId ⇒ re-dispatch proposal or `blocked` flag. The card IS the reboot context. |

### 10.3 Schema/concept pivots (amend §3–§6)

- **`complexity: trivial | simple | standard | complex`** replaces effort estimation
  (Q4 + operator's answer at I9). Each tier declares the ARTIFACTS required before
  Ready: trivial = one-shot prompt · simple = polished prompt · standard = +spec/ACs ·
  complex = +examples/screenshots/docs/ADR/PRD + infra/db/credentials declared. Modulates:
  template's mandatory fields (Q24), default evidence (Q25/I10), scope-pass offer
  (I9, standard+ only) and routing (trivial can downgrade the model). Interview mode
  (I15) is the orchestrator filling in the tier's requirements with the operator.
- **Dispatch manifest (Q15):** under grant, the orchestrator presents the BATCH once —
  cards, order, substrate, model/effort per card, file-conflict analysis
  (worktree where needed) — and the **operator's go authorizes draining THAT manifest**
  (not anything future). New cards = new manifest. It's the safe generalization of
  "can attack alone": autonomy per disclosed batch, not open-ended autonomy.
- **Evidence declaration per card:** `evidence-expected:` is born from the
  kind×complexity template (DoD matrix I10 as an editable default); the value
  `operator-judgment` forces the explicit question in Review (Q25).
- **Reject-with-reason (Q26):** the Review→In-Progress transition via the human path
  carries a mandatory reason; attached to the card; delivered as a delta to the linked
  worker.

### 10.4 PIVOT T98 — harness-owned orchestrator (Q22)

The operator decided: **the orchestrator contract is a Capy product**, not the personal
skill in `~/.claude`. T98 rescope:

1. **`docs/capy-orchestrator.md`** — versioned contract in the repo (same regime as
   `capy-features.md`: version marker + CI gate), distilled from the operator's personal
   skill (which carries the real lessons from a client project session). Injected at
   boot by promote (T55 mechanism).
2. **Capy's guard** — the PreToolUse guard becomes installed/managed by Capy (script in
   userData; registered via `.claude/settings.local.json`, the channel Capy already
   uses for always-allow), per-session flag managed by Capy. The item "Capy owns the
   guard," deferred in card T98, RETURNS to scope.
3. The operator's personal skill keeps existing for his manual sessions; the product's
   is independent and evolves with the epic.

### 10.5 Ideas promoted by the operator (👍 from the workshop → candidates for post-S1 cards)

> ⚠️ Part of this section 10 was SUPERSEDED by §11 (pivot "the board belongs to the
> agent") — in particular Q6/Q7/Q9 (creation proposals) and the location of the
> `approved` stamp (§4). §11 prevails wherever there's conflict.

Approved as concept: I1 (templates by kind) · I2 (standup via already-computed pulse,
zero cost) · I3+I20 (cost per card: T47 telemetry + local heuristic estimate, no API) ·
I4 (deps-aware, mechanical via watcher, proposals) · I5 (swimlane per epic) · I6
(replay) · I7 (auto-blocked) · I8 (card chat — staged: v1 click→session; v2 maximize
modal with PTY feed + input, existing plumbing) · I11 (bounce-learning) · I12
(forecast) · I13 (**generic MCP importers** — any MCP that lists tasks, not just the
client task tracker) · I14 (card→live PR) · I15 (interview mode, paired with complexity) ·
I17 (board digest, mechanical) · I18 (notifications T83). Pending more discussion: I16
(meta-board) · I19 (board policy — the operator fears friction; reposition as
PRE-approval that REDUCES confirms) · I10 (absorbed into the evidence declaration §10.3).

---

## 11. PIVOT 2026-07-09 (2) — the board belongs to the AGENT; the human guards the DOORS

**Operator's course correction, accepted after analysis:** the §3.1/T96 proposal-gated
model (agent proposes creation/movement, human accepts card by card in the Inbox) made
the operator the board's typist — the opposite of the purpose ("the user's head is
cluttered, 5 projects at once; the board is the anchor that ANOTHER entity maintains for
him"). And, coldly: **creating/editing/reorganizing a card doesn't execute anything,
doesn't spend anything, doesn't approve anything** — requiring confirm for that was
conservatism, not security.

### 11.1 The model

> **The board is the model's organization surface — zero friction. Security lives in
> the three doors where the board touches reality: EXECUTE, ACCEPT, ROUTE.**

- **Free (no confirm, no Inbox):** `create_card` · `update_card` (agent-owned
  body/fields: title, kind, complexity, deps, parent, proposed substrate) ·
  `move_card` between **backlog ↔ ready ↔ review**. Provenance keeps being stamped
  server-side on every write (total audit, zero friction). A draft is cheap;
  undoing is trivial; spam is a quality problem (visible, batch-deletable),
  not a security one.
- **Door 1 — EXECUTE (dispatch):** nothing runs without a human gate. Two paths: confirm
  per card (verbatim disclosure, as today) or **dispatch manifest** (§10.3) — the
  batch disclosed once, one go releases that batch. The §4 `approved` stamp
  **changes location**: it stops being born at creation-accept (which no longer exists)
  and starts being stamped server-side **at the manifest go** over the listed cards.
  Editing the body post-manifest still invalidates the stamp (identical anti-bypass).
  The prompt-injection defense is preserved: a poisoned card NEVER becomes a boot
  prompt without passing through human eyes (manifest or confirm) — the door is
  execution, not authorship.
- **Door 2 — ACCEPT (Done):** unchanged. `move_card` **refuses `done`** always.
  Review→Done is human, with evidence (T80 §3.5 intact).
- **Door 3 — ROUTE (policy):** routing table / board policy stay human-only
  (§10.4 of the workshop, the allowance argument).
- **TRUTH columns, not WISH columns:** `in-progress` is not settable by
  `move_card` — only dispatch/bind enters it (a REAL session working; cards
  `internal` link the orchestrator session). The board never lies about what's
  running. `review` is settable by the agent ("I finished my part") — it's a claim,
  not an accept; the accept is Door 2.
- **Chain secured against "smart-ready":** the agent moves to `ready` freely, but
  ready + live grant ONLY auto-dispatches a card with a manifest stamp. Ready
  without manifest = card waiting for a human gesture/go. Organizing ≠ starting
  the machine.

### 11.2 What this pivot SUPERSEDES

| Previous item                                                                | State                                                                                                                                                  |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| §3.1 verdict "don't create a status-write verb; propose_move"                | **Superseded** — direct verbs with the §11.1 restrictions (`done` never; `in-progress` only via bind).                                                 |
| §4 `approved` stamp on accept of the creation proposal                       | **Relocated** — stamp at the dispatch manifest go (same edit-based invalidation).                                                                      |
| T96 proposal-gated verbs (`create_card` proposal + `propose_move`)           | **Redesigned** — direct `create_card`/`update_card`/`move_card`. The Inbox exits the creation flow; it remains at the doors (dispatch/manifest, Done). |
| §10.2 Q6 (proposal rejection) / Q7 (batch accept UX) / Q9 (cap 20 proposals) | **Dissolved** — there's no more creation proposal. What the human reviews is the MANIFEST (its UX inherits the spirit of Q7: list + go).               |
| §10.1 Q8 (edit proposal pre-accept)                                          | **Dissolved** — the operator edits the card directly on the board/pane whenever he wants (it's a file).                                                |
| S0 (`capy-features` v7, board paragraph)                                     | **Snapshot of today** — verbs don't exist yet; the paragraph is rewritten in S1 along with the new verbs.                                              |

### 11.3 ~~Open~~ RESOLVED — D6 (organization autonomy) → see §12

---

## 12. Round 3 (2026-07-09) — permanent principle + closing the decisions

### 12.0 PERMANENT PRINCIPLE (operator, "forever")

> **"Claude is the drift pilot; Capy is the car."** Zero friction between the
> model and Capy's tools. Governance lives
> EXCLUSIVELY in the three doors to reality (§11.1: execute · accept · route) — never
> in the model↔tool interface. Test for every future verb/flow decision: "does this
> add friction between pilot and car?" If yes, it's wrong.

### 12.1 Closed decisions

- **D1 — kinds:** v1 stays at `scout | bug | feature | review | chore`. No additions.
- **D3 — Close → session:** **auto-archive** (zero cost, UI state). NO model
  summarization on close — summarizing runs the model and costs tokens; the durable
  record already exists for free: the card (history + evidence → `archive/`) + the
  board's mechanical digest (I17, main process, deterministic). The T79-S2 auto-digest
  keeps existing on its own at session end, independent of the board.
- **D4 — meta-board:** approved as a concept. Next DESIGN activity: 2–3 HTML mockups
  (T67 Slice 0 flow — real data, design.md tokens, red-team) for the operator to
  choose a direction. No production code until the choice is made.
- **D5 — board policy:** DELIBERATELY DEFERRED. Doesn't get born as its own feature;
  EMERGES as the settings page that accumulates the answers already given (T97
  routing table, WIP, manifest defaults). Reevaluate when T97 ships.
- **D6 — organization autonomy (with the operator's nuances):**
  - **Toggle scope: per REPO/folder, never per session.** Default ON, toggle in the
    folder menu. **Worktrees INHERIT from the repo** (the board is per-repo;
    re-asking per worktree created by the pipeline would be friction — exactly the
    operator's objection). Adding a folder still asks NOTHING (zero interrogation
    on add; the toggle is discoverable, not imposed).
  - **Conservative task-smell (precision > recall).** Exploratory conversation NEVER
    becomes a card on its own — understanding an error ("Allowed memory size
    exhausted in staging"), debugging an incident, non-committal brainstorming: those
    are conversation, not task. The model cards when the conversation produces
    **deferred change intent**: commitment language ("we need to," "we'll fix it
    later," "note that down"), a concrete deliverable identified, recurring pain
    across sessions. Medium confidence → ask at a natural pause ("I saw 2 things
    that look like tasks in this conversation — card them?"). Always announced;
    undoing is 1 gesture (a draft is cheap).
  - **Nothing is lost without a card:** the full transcript of every session already
    persists on disk (it's what Capy reads for the sidebar/fleet) and the T79 digests
    exist. A card is ORGANIZATION, not storage — the bar for carding can be
    conservative without fear of losing an idea.

---

## 13. Final work breakdown (grooming 2026-07-09 — the rule applied to itself)

Audit: every decided point became a card. T98 was SPLIT (the Q22 rescope made it grow
beyond 1 unit of work) into T98 (visible role) + T108 (contract) + T109 (guard). New
cards: T104 (manifest), T105 (schema v2), T106 (autonomy D6), T107 (workshop mockups).
Epic now has 11 children.

| Card                                                        | Complexity      | Missing artifact BEFORE Ready                                                                                                | Recommended executor                                               |
| ----------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| T96 — direct verbs                                          | complex         | **focused API spec** (schemas of the 3 verbs, steering codes, §11.1 restrictions, rewrite of the v7 capy-features paragraph) | worktree · sonnet·high                                             |
| T105 — schema v2 (kind/complexity/parent/templates)         | standard        | template content per kind (copy)                                                                                             | SAME worktree as T96 (same files — never parallel, Q15 discipline) |
| T104 — dispatch manifest                                    | complex         | **own PRD** (security: stamp, invalidation, partial-go, UX, interaction with grant)                                          | PRD → then worktree · sonnet·high                                  |
| T108 — capy-orchestrator.md contract                        | standard        | nothing — 1st draft is a one-shot WRITING task (inputs: personal skill + §11/§12 + T80 §0)                                   | subagent/teammate one-shot → operator review                       |
| T109 — Capy-managed guard                                   | complex         | **own spec** (writes user settings; collision with the operator's personal hook; uninstall/idempotency)                      | spec → worktree                                                    |
| T98 — visible role + 1-gesture promote                      | simple→standard | entry in design.md §6 (badge/pill/toggle)                                                                                    | worktree · sonnet                                                  |
| T106 — autonomy (per-repo toggle + task-smell)              | standard        | nothing beyond the text (goes in T108) + folder setting plumbing                                                             | small worktree                                                     |
| T97 — routing table + bootOverride in dispatch              | standard        | design.md §6 (override in confirm UI)                                                                                        | worktree · sonnet·high                                             |
| T102 — substrate                                            | complex         | detail the worktree lifecycle (Q18: lives until Done; removal on close) in the spec                                          | worktree · sonnet·high                                             |
| T103 — done trigger (simplified by D3: archive, zero model) | simple          | nothing — card body suffices                                                                                                 | small session / ride along in T104's worktree                      |
| T107 — meta-board mockups                                   | simple          | mockup brief (one-shot prompt)                                                                                               | subagent/teammate one-shot (no worktree, no risk)                  |

**Waves (dependency + file non-conflict):**

- **Wave A (foundation):** T96+T105 (1 worktree, sequential) ∥ T108 (one-shot writing) ∥ T107 (one-shot design). Prerequisite: I draft the T96 API spec.
- **Wave B:** T104 (PRD → code) ∥ T109 (spec → code) ∥ T98 ∥ T106.
- **Wave C:** T97 ∥ T102 · T103.
- T100 (cost coach) stays outside the epic, post T47-P5.

**Artifact backlog that I produce in-session (orchestration, not code):** T96 API
spec · T104 PRD · T109 spec · T107/T108 one-shot briefs.
