# T601 — `harnu:spec`: triage first, a spec only when the tier asks for one

**Status:** PRD v1 (2026-10-31) · **Card:** T601 (spec-first unit: T605) · **Spec:** `docs/specs/2026-11-harnu-spec/spec.md`
**Evidence:** `docs/specs/2026-11-harnu-spec/exploration.md` (§1 leaks, §3 what the critics required, §4.0 reframe, §4 Wave B, §6 decisions). **Depends on:** the wave-A template and gate (T600), the T602 skills `one-by-one` and `grill-me`.

This PRD says what the operator and the sessions see. The spec says what is built, in which slices, and how each criterion is proven.

## 1. Who is this for

The operator (solo maintainer, several Harnu sessions open, little patience for ceremony) and the sessions that work for them: the orchestrator that dispatches a delivery, the executors that build a slice, the verifier that grades it.

## 2. The problem in one paragraph

Campaign wave 1 measured eleven leaks between an idea and a verified PR. Every one is a retyping (the orchestrator copies the spec into card packets and the ids drift), a missing handoff (a spec nobody approved on record), or a contradiction nothing catches (a capability consumed in a chapter before the chapter that builds it). Wave A made the spec's shape lintable. What is still missing is the habit: deciding, at every entry, how much of the funnel the work deserves, and carrying the answer through to the cards without retyping.

## 3. What the operator sees

### 3.1 One command at any entry

`/harnu:spec <what I arrived with>` — a sentence, a ticket id, a pasted PR comment, a link. The skill answers in one message with three things: **the door** (which row of the funnel table this is), **the tier** (Small, Medium, Large or Complex, with the one-line reason), and **what happens next**.

- **Small** ends there. "This is a one-line bug: door `A bug`, tier Small. First step: `systematic-debugging` until the root cause, then a `bug` card with the repro as an AC. No spec." No mission is created, no file is written, no sub-agent is started, no lint runs. A PR comment, a red CI and a plain question end the same way, each at its own first step.
- **Medium and up** continues into authoring, below.

The skill's name and trigger text say "called at every entry; most calls end Small", so the operator is never surprised that it does little.

### 3.2 Authoring (Medium and up)

1. **Triage names the tier**: the card's `complexity` decides (`standard` is Medium, `complex` is Complex); Large is the smallest tier that fits when a decision or a non-goal must be recorded. The skill states the reason in one line; one word from the operator overrides it.
2. **The mission is created first.** Before any question, `mission_create` declares the mission with the `human` step "Approve spec" and the spec, PRD and ADR paths as scope. From this moment the work has a pill, blockers, the operator's `you` list and the stall detector, which today only start at dispatch.
3. **Facts are looked up, decisions are asked.** `memory_query`, the lessons index and the code answer what they can, and the skill shows the result instead of asking. What remains goes through `harnu:one-by-one`: one decision per message, a recommendation, and the answer written into the D-n row and a memory line before the next question. `harnu:grill-me` is offered for a spec the operator wants stress-tested.
4. **The objective is atomized** into numbered request atoms (R-1…R-n) in the Problem section, one per sentence the operator said. The operator sees the list before approving.
5. **The spec is written** to `docs/specs/YYYY-MM-DD-<slug>/spec.md` in the template's shape. For Complex, the skill also writes the PRD (`docs/prds/<card>-<slug>.md`), an ADR only when an architectural decision is recorded (`docs/adr/NNNN-<slug>.md`), and references the mockup folder if there is UI — all tracked paths.
6. **The skill checks itself**: `spec check` (below), then one **blind builder-check** — a fresh sub-agent given only the spec, asked "could you build slice S-1 from this alone? List every guess you had to make". For Complex, two **lens critics** run in parallel beside it: overhead (what would a solo maintainer skip or resent) and traceability (does every sentence land on an AC, a non-goal or a D-n). Every finding is fixed in the spec or recorded as a D-n or a non-goal; the summary is written to `critics.md` next to the spec.
7. **Hand-over and one question.** The skill opens the spec with `open_file` and asks exactly one thing: "Approve this spec?"
8. **The operator says yes.** The skill flips `status: draft` to `status: approved` in the spec and tells the operator the one click that is theirs: pill → "Approve spec" step → Mark verified. The skill never ticks the step. Dispatch is not the skill's job: it names `orchestrate-delivery` as the next step and ends.
9. **The operator is not there.** The skill does not wait inside the turn. It calls `mission_set_blocker` with `owner: 'operator'` naming the approval, so Harnu chimes and re-nudges, and stops. An unanswered D-n stays `open` with its default shown; it is never written as declined, and it blocks only the slices it gates.

### 3.3 `/harnu:spec check [--cards]`

A script run, not a conversation: `node scripts/ci/spec-check.mjs <spec-path> [--cards]`. The skill resolves the path (the spec attached to the mission scope, else the one spec directory changed on the branch, else it asks). Output is one line per finding, `path:line [rule] message`; every finding is collected; exit 0 clean, 1 on any finding, 2 on a usage error. The script lives in the Harnu repo; outside it the skill applies the same three checks by hand from the rules in its text and says so (decision D-8).

- **The gate's rules** (unique AC ids, every slice AC exists, a proof on each, tracked header paths, no gitignored-scratch path, the tier's section whitelist) — applied even to a draft, so a spec is clean before it is flipped to approved.
- **Capability order.** Slices declare `produces:` and `consumes:` capabilities. A slice that consumes something no slice produces fails (`missing-producer`), unless the token is written `existing:<name>`. A slice that consumes something produced only by a slice that is not an ancestor through `depends-on` fails (`producer-not-before`), naming both slices. This is the check that would have caught the campaign spec's contradiction (a ledger event consumed in chapter 1, built in chapter 5).
- **Request-atom coverage.** Every R-n must be cited by an AC's `covers` cell, by an `NG-n` non-goal bullet, or by a row of Open decisions; otherwise `uncovered-atom` names it. The model atomizes the objective; the script only checks the set cover.
- **`--cards`** lints the board against the spec. For each card whose `spec:` points at the spec it reads the AC lines (`- [ ] AC-3 #a1b2 — …`) and reports `hash-diverged` (the card says something other than the spec now says), `unknown-ac` (an id the spec does not have — invented on the card) and `missing-ac` (a slice AC the slice's card dropped). A card-only AC with no hash (the unit's own changelog line) is information. The lint never says met or unmet: the verifier grades the card, as it does today.

### 3.4 Dispatch (in `orchestrate-delivery`, not in this skill)

- **Phase 1 adopts the mission** whose scope names the spec instead of creating a second one, and adds the slice steps with `mission_add_step` and a reason.
- **Phase 2 derives, it does not retype.** A planner script reads the spec and the board and returns a plan: `create` a card for a slice without one, `update` the marked block of a backlog card whose spec text changed, `skip` a card already in progress, in review or done, `refuse` with a reason. The orchestrator executes the plan with `create_card` / `update_card`. The planner never writes the board.
- **The marked block** is the span between `<!-- spec:begin S-n -->` and `<!-- spec:end S-n -->` in the card body: the slice's AC lines (spec id verbatim, plus the four-hex content hash), its `files-may-touch` as the scope boundary, and its links. The envelope — return address, exit sequence, method, honest exit clause — stays the orchestrator's, outside the markers, and an update never touches it.
- **Idempotent.** The card carries `spec-slice: S-n`; the spec's Amendments table gets a `card` row (`S-n → <card slug>`, last row per slice wins). Running the plan twice is a no-op the second time. D-3 decides who commits the spec rows.
- **Open decisions become decision nodes.** Each open D-n that a slice lists in `gated-by:` becomes a step with a `decision` (`title`, `options`, `blocks` = the gated slices' steps) via `mission_add_step`. The operator chooses at the pill's **Choose…** door; the skill never writes `chosen`. A slice no open D-n gates dispatches at once.
- **Refusals.** A slice without `files-may-touch` is sent back to the spec; two slices with no `depends-on` path between them whose `files-may-touch` overlap are refused as parallel — they are stacked or one owns the hub file.

### 3.5 After approval

The spec is frozen at the first dispatch. A change of mind is a row in the spec's Amendments table and a delta to the affected executor, never an edit of the body above it. The verifier appends its Deviations rows to the same table. A spec's state is derived from the PR and the mission, not stored: the header only ever says `draft` or `approved`.

## 4. Edge cases

- **The entry is already a spec or a PRD.** Triage reads it, picks the tier, and authoring starts from it instead of a blank file.
- **A question grows into an architectural decision.** It leaves chat for an ADR, not a spec.
- **The entry is a Small door but the work turns out larger.** The operator re-runs `/harnu:spec` with the new facts; triage is cheap and the tier changes.
- **No card exists yet** (a vague idea): triage proposes the tier from what the brainstorm produces, and the card is created at dispatch, not by this skill.
- **The spec already has `card` rows** and the operator wants a change: Amendments only (AC-14).
- **A gate or check fails when the skill runs it**: the skill fixes the spec and re-runs; it does not flip to approved while a finding stands.

## 5. Success

- A one-line bug, a PR comment and a question end in one message with no artifact (measured by the fixtures of AC-8).
- A recorded authoring run passes the gate and both checks on its first run (AC-11).
- The campaign spec's compaction contradiction fails `check` with both slices named (AC-4).
- A second Phase 2 pass over an unchanged spec creates and updates nothing (AC-18).

## 6. Not in this PRD

Anything in exploration §4 Wave C: the approval door as a real Harnu control, proof-file hashing and red-first receipts, the mutation round for critical ACs, folding shipped specs into the current-state docs, the Steward watching specs in authoring. They need one more wave of evidence.
