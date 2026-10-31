# A Harnu-native spec skill — exploration, critics and a grounded plan

_2026-10-31 · orchestrator session harnu-2d/harnu-cc · inputs: 4 research agents (tlc-spec-driven, superpowers 7.0.0, a 12-tool SDD survey, an inventory of our own skill chain) and 3 adversarial critics (ceremony, multi-session realism, traceability). Research notes live in the session scratchpad `sdd/01…08`. Status: proposal for discussion, nothing decided._

## 1. Where the flow leaks today (measured on Campaign wave 1)

The chain is: idea → brainstorm / scope-task / grill-me → dtk `prd` / `adr` → hand-written `spec.md` → `orchestrate-delivery` **retypes** the spec into card packets → executor → shipper → `delivery-verifier` grades the **card's** ACs → report. Every leak below is a retyping or a missing handoff:

| #   | Leak                                                                     | Evidence                                                                                                                                          |
| --- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Card AC ids do not match the spec's                                      | T593 AC-3a cites "spec §8 AC-3", which is the compaction eval; AC-1b/AC-R/AC-UI/AC-C exist only on the card (AC-R comes from the mission v3 spec) |
| 2   | Spec contradicts itself and nothing catches it before verification       | §3.2 lists `compaction` as a ch.1 ledger event; §7 puts the PreCompact hook in ch.5 → AC-3a `blocked`                                             |
| 3   | Three verification vocabularies                                          | card `verify: test\|visual\|manual\|review`, verifier rubric `code\|ui\|research\|decision`, PRD Given/When/Then with none                        |
| 4   | Scope boundary (files a slice may touch) is invented by the orchestrator | verifier found 6 files outside T593's list                                                                                                        |
| 5   | Design nodes point at gitignored `.harnu/out/`                           | contradicts orchestrate-delivery Phase 0 "spec bundle committed on base"                                                                          |
| 6   | Weak proofs pass green                                                   | `mission-list-benchmark` loosened; AC-1 fixtures seeded, not scrubbed; both noticed only because the verifier read the diff                       |
| 7   | dtk `prd`/`adr` write to a different layout than the repo's              | `docs/prds/PRD-*.md` vs `docs/prds/T164-*.md`; `docs/adrs/ADR-NNN` vs `docs/adr/0015-*`                                                           |
| 8   | `create-pr` task-id regex misses `card/T593-…` branches                  | tracker links lost                                                                                                                                |
| 9   | Nothing happens to the spec after merge                                  | campaign spec still reads `_Draft spec_`; deviations only on cards; decisions.md is 371 KB of prose                                               |
| 10  | Nobody records who approved the spec, or when                            | true of every tool surveyed, too                                                                                                                  |
| 11  | Silent rescoping                                                         | spec §7 slice 1d (coalescing) moved to T599 with no record in the spec                                                                            |

## 2. What the field offers (and what to take)

| Source                          | Take                                                                                                                                                                                                                                                       | Leave                                                                                                              |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **tlc-spec-driven**             | "Every criterion has a check, and every check a proof"; "Facts you look up; decisions you ask"; sizing table decides depth; requirement-closure re-read; approval authorizes local commits only; artifact validators as scripts                            | 4 phases + 11 reference files + Python scripts; `.specs/STATE.md` as a second decision log; no multi-session story |
| **superpowers**                 | Goals / non-goals / anti-goals; builder-check by a fresh blind subagent; "hand artifacts over as files"; task sizing = "a reviewer could reject one and approve its neighbor"; `Ruling:` lines; "NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE" | one controller, one branch, serial implementers, human live at three points, git-ignored ledger                    |
| **GitHub spec-kit**             | the "constitution" idea → for us that is already CLAUDE.md + the CI gates; `[P]` parallel markers → our slice dependency graph                                                                                                                             | the heaviest artifact chain in the survey                                                                          |
| **AWS Kiro**                    | EARS-shaped criteria (one trigger, one SHALL, concrete values) as a _warning-level_ style guide                                                                                                                                                            | IDE lock-in                                                                                                        |
| **OpenSpec**                    | spec-after-merge is a defined step (delta → fold into current-state docs)                                                                                                                                                                                  | its `specs/<domain>/` tree: our current-state docs are `docs/harnu-features.md` and `docs/user/`                   |
| **Task Master**                 | "next unblocked task" as a query over a dependency graph (fits the Steward)                                                                                                                                                                                | PRD-only                                                                                                           |
| **anton-haskevych/spec-driven** | parallel reviewer panel whose claims the main thread checks against code — the habit the operator asked for                                                                                                                                                | unverified maturity                                                                                                |

Nobody in the field has solved: parallel multi-session execution, verification of code against the spec beyond tests, drift after merge, or recording who approved. Those are exactly the places where Harnu's mission/board/ledger give us something others lack.

## 3. Proposal v0 and what the critics did to it

v0 proposed one skill with four verbs (`spec`, `spec check`, `spec derive`, `spec close`), a 9-section artifact with a machine header (status, approval hash, links), three new ledger rows and nine Harnu bindings. The three critics (full text in `06/07/08-critic-*.md`) agreed on the shape of the cut:

**Kill or defer**

- `spec close` as a verb: a docs-only PR per feature; `status` should be _derived_ from PR/mission state, deviations folded once by one dispatched unit.
- "Contracts touched" section, English and client-identifier checks in `spec check`: CLAUDE.md and the CI gates already own them.
- Approval stamp in the spec header: the card's `approvedBodyHash` via `submit_manifest` is the only dispatch gate; a whole-spec hash cited from cards voids every card on any typo. Hash **per slice**, header excluded, if at all.
- `verify` + `rubric` + `proof` as three columns: they never differ in practice; keep one typed `proof` and derive the rubric from it.
- Ledger rows `spec-*`, `draw_canvas`, Sources, Review log: decoration or duplication.
- Parallel critics on every spec: Complex only; Medium gets one builder-check.

**Fix before it can work**

- The verifier keeps grading the **card** (card is the board's source of truth); `spec check --cards` only lints card↔spec drift.
- `derive` runs **at dispatch time**, is idempotent (slice→card map stored in the spec), and owns only a marked block (ACs, scope, links); the envelope (return address, exit sequence, method) stays the orchestrator's.
- **Freeze the spec at first dispatch**; later changes go to an append-only `## Amendments` table and reach executors as deltas (the send-back rule already exists).
- The spec phase needs a **heartbeat**: create the mission first with a `human` step "Approve spec" and a blocker, so parking/compaction/absent operator are covered. An unanswered decision stays `open` and blocks only the slices it gates (ch.2 decision nodes); it never becomes "user declined".
- ACs are **two-level**: feature-level (G-n) → slice-level (S1.AC-n) with `refines:`; cross-spec invariants get an explicit `inherits:` row. That is where T593's "invented" ACs actually come from.
- `proof` is a **typed union**: `test:<file>::<name>` | `script:<cmd>` | `capture:<route>@<state>` | `record:<kind>`. "Contracts" become generated `script:` ACs instead of prose. `review` requires a named reviewer and a checklist, and is capped.
- Cross-section contradictions (§3.2 vs §7) are catchable mechanically: slices declare `produces:` / `consumes:` capabilities; `check` fails an AC whose slice precedes the producer of a capability it needs.
- Weak-proof detection: hash the proof files at approval; a diff that edits a test named by an AC proof forces a visible "proof changed" row; red-first receipt from the ledger; tlc-style mutation round only for ACs tagged `critical` (later).
- Closure ("every request sentence lands somewhere") is script-checkable only if the objective is first atomized into `R1..Rn` in the header; the model atomizes, the script checks set cover.

## 4. The grounded plan — triage first, then three waves

### 4.0 The reframe (from the flow walk-through)

Seen as a flow, the critical moment is not writing the spec; it is deciding **how much of the funnel** an entry deserves. Today that is the operator's intuition, per session. So the thing being built is a **triage rule plus entry doors**; the spec is only the artifact of the Medium-and-up tiers. Three consequences:

1. The skill is called at every entry and most of the time ends in "Small — straight to a card". Its name and trigger must say that.
2. The mission is born **at triage**, the moment something leaves Small, not inside `orchestrate-delivery`. That puts the Campaign's gates, ledger, decision nodes and Steward over the understanding phase too, the one stretch that has no heartbeat today. The Steward (ch.5) gains a duty the Campaign spec did not list: watching specs in authoring.
3. Half the entries must never see a spec. Bug of one line, PR comment, red CI, a question. If the skill makes those heavier the operator skips it and the convention dies in a week. Lint and hashes exist only for whoever **chose** a tier; the shortcuts stay ceremony-free.

**Entry doors → first step → what it becomes**

| You arrive with           | First step                                       | Becomes                                  |
| ------------------------- | ------------------------------------------------ | ---------------------------------------- |
| A vague idea              | `brainstorming` (one question per turn)          | objective + request atoms R-n            |
| A task / ticket           | `scope-task` (ACs one by one, what exists, gaps) | report on the card                       |
| A bug                     | `systematic-debugging` until root cause          | `bug` card with the repro as an AC       |
| A question                | answer in chat; `memory_query` + lessons first   | nothing persisted, or one decisions line |
| A PR comment / red CI     | `address-review` / `debug-gh-action`             | commit on the existing branch; no spec   |
| A design / mockup         | `create-mockup` or `implement-design`            | screens approved per screen              |
| A recurring pain          | `learn-from-review` or a card                    | lesson or `chore` card                   |
| "Where did we leave off?" | `harnu:status` / `resume-task`                   | a read of the mission, nothing written   |

**The funnel after triage**

1. **Size decides depth.** Small: card with ACs, no spec, dispatch. Medium: one-page spec (Problem, Slices, ACs). Large: adds Goals, Design, Decisions. Complex: adds PRD, ADR, mockup. The card's `complexity` picks it; the lint refuses sections outside the tier.
2. **Spec** (`harnu:spec`): facts looked up, decisions asked one at a time, blind builder-check, lens critics only on Complex. The mission exists from here, with the human step "Approve spec". Approval is the operator's yes in chat; absent operator → blocker + chime.
3. **Dispatch** (`orchestrate-delivery`): spec freezes, cards derived from the spec with a hash per AC, manifest, one worktree per slice. Open decisions become decision nodes that lock only the slices they gate.
4. **Execution:** executor commits and stands down; shipper opens the PR; mission ticks, watchdog, idle notices.
5. **Verification** (`delivery-verifier`): blind, per AC, against the typed proof. Deviations on the card and in the spec. `needs-human` → a check on the pill.
6. **Merge:** the operator's. Spec status derives from PR state.
7. **Close:** resolved D-n to decisions, lessons if a review taught something, Steward (ch.5) proposes the fold into `docs/harnu-features.md` and `docs/user/`.

**What happens when**

- The operator changes their mind mid-flight → append-only amendment in the spec, delta to the affected executor; never an edit of the frozen body.
- An executor finds the spec contradictory → `blocked` with the question, blocker on the pill; never a silent reinterpretation.
- A weak proof passed green → proof files hashed at approval; a diff touching a test an AC cites produces a visible row.
- The operator disappears → every phase has a heartbeat; nothing stalls silently.
- The session compacts or parks → mission and cards are the state; any session resumes with one `mission_get`.

Two shortcuts worth stating: a one-line bug and a PR comment never enter the spec funnel; a question that turns into an architectural decision leaves chat for an ADR, not a spec.

### Wave A — easy wins (edits to existing skills + one lint; one or two cards; no new skill)

1. `orchestrate-delivery` Phase 2: AC lines carry the spec's AC id verbatim plus a per-AC hash; inventing an id is refused; a `## Slices` section with `files-may-touch` is required in the spec and pasted, not inferred. (Leaks 1, 4, 11)
2. Phase 0 enforcement: a spec or mockup under `.harnu/out/` refuses dispatch; "Commit 0" becomes a named first unit with an owner, not an executor's side job. (Leak 5)
3. `scripts/ci/spec-gate.mjs` (~60 lines, runs on specs with `status: approved`, on the base-branch copy only): unique AC ids; every slice AC exists; every card AC id exists in the spec; `prd`/`mockup` paths are tracked; no `.harnu/out` paths; per-tier section whitelist. (Leaks 1, 5, 9)
4. `delivery-verifier` appends a `## Deviations` row per AC to the spec as well as the card, and flags any edited test named by a proof. (Leaks 6, 9)
5. dtk `prd`/`adr` pointed at the repo layout; `create-pr` task-id regex accepts `card/<ID>-…`. (Leaks 7, 8)
6. Resolved open decisions: one structured line per D-n to `memory_append decisions`, nothing else. (Leak 9)
7. The triage table above goes into the orchestrate-delivery Phase 0 text and into `harnu:status`'s "what now" line, so the sizing rule is stated in one place before any skill exists. (Reframe 1, 3)

### Wave B — `harnu:spec` (one skill, two verbs; triage is its first move)

- `/harnu:spec <entry>` starts with triage: names the door, picks the tier, and for Small ends there ("card ACs, no spec"). Medium and up: writes `docs/specs/YYYY-MM-DD-<slug>/spec.md` in the template below from a brainstorm, a scope-task report or a PRD; looks facts up (`memory_query`, lessons, code), asks decisions one at a time (`one-by-one`), atomizes the objective into R-n, runs one blind builder-check (Complex: plus two lens critics), creates the mission with the human step "Approve spec" (scope = spec/prd/adr), hands the file over with `open_file`, and asks the one approval question. Absent operator → blocker, stop.
- `/harnu:spec check [--cards]` is the lint above plus the capability-order check (`produces/consumes`) and the request-atom coverage check.
- Dispatch stays in `orchestrate-delivery`; its Phase 2 calls the derive logic at dispatch time (marked block only, idempotent, slice→card map in the spec). Open D-n rows become ch.2 decision nodes on the mission.

Template (per-tier whitelist enforced by the lint: Medium = 1, 3, 4; Large adds 2 and 5; Complex adds PRD, ADR, mockup):

1. Problem · request atoms R-n
2. Goals · non-goals · anti-goals
3. Slices — `S-n` · depends-on · substrate · files-may-touch · produces/consumes · ACs
4. Acceptance criteria — `id | statement | proof (typed) | refines/inherits | covers R-n`
5. Open decisions — `D-n | question | options | default | status open/resolved`
6. Amendments · Deviations (append-only, written by dispatch and by the verifier)

### Wave C — later, after one more wave of evidence

- Mission "Approve spec" as a real Harnu door (ch.2 decision nodes carry it).
- Proof-file hashing and red-first receipts in the ledger (ch.1 ledger already has the row shape).
- Mutation round for `critical` ACs.
- Fold shipped specs into current-state docs (`docs/harnu-features.md`, `docs/user/`) as a Steward (ch.5) duty.
- Steward watches specs in authoring (stale D-n, unanswered approval) and picks the next unblocked slice from the dependency graph.

## 5. Gaps that stay open even after Wave C

- Cross-feature drift: specs are per feature; the only current-state description is the awareness + user docs, and nothing diffs a shipped spec against them.
- Hub-file ownership across parallel slices is still an orchestrator judgment; `derive` can only refuse overlaps.
- An unattended spec phase is only as good as the D-n defaults; a decision the operator never answers blocks its slices forever (correct, but slow).
- Verification of behaviour beyond tests and captures (performance, UX feel) stays `needs-human`.
- Approval is still "the operator said yes in chat" until Wave C's door exists.

## 6. Decisions taken with the operator (2026-10-31)

1. Wave A now, as cards. Approved in principle; cards to be opened after this reframe.
2. Wave B as a `complex` card whose own spec is written with the Wave A template, so the skill is the first consumer of its own rules. Approved in principle.
3. The four-verb design (v0) is dropped: `derive` lives inside orchestrate-delivery Phase 2 at dispatch time; `close` is replaced by a derived status plus verifier-written Deviations; `close` as a verb may return in Wave C with the Steward.
4. Reframe accepted: triage first, mission born at triage, shortcuts stay ceremony-free.
