# PRD — T358 Mission progress

**Status:** planning — decisions settled 2026-09-26 (operator pre-approved the design and asked
for mockups + plans); this PRD, the ADR and the implementation plan await operator review.

**Related documents:**

- **Design (data model, verbs, state machine):** [`docs/specs/2026-09-26-mission-progress/design.md`](../specs/2026-09-26-mission-progress/design.md)
- **Architecture decision:** [ADR-0015](../adr/0015-mission-as-structured-capy-data.md)
- **Implementation plan (stacked slices):** [`docs/plans/2026-09-26-mission-progress.md`](../plans/2026-09-26-mission-progress.md)
- **Visual contract:** `docs/specs/2026-09-26-mission-progress/spec.html` + `review.html` (T359,
  PR #377); design.md §10 has the full UI-wiring writeup
- **Feasibility evidence:** `.capy/out/t358/smoke-report.md` (T360, local)

Anything marked **(provisional)** was decided while planning the delivery, not by the operator.
It stands until the operator corrects it.

## 1. Problem

An operator returning to an orchestrator session after being away has to ask it "where are we" —
there is nothing structured for Capy itself to render. The vocabulary already exists: the
`mission`/`status` skills produce a "Step 3 of 5"-shaped status card, the goal file has North
star / Done criteria / Executors / Log sections — but only as **prose regenerated on demand** by
a skill re-reading and re-summarizing markdown every time. Nothing in the app reads it.

Measured on this machine, 2026-09-26: 55 goal files across 7 repos (main checkouts + worktrees),
sizes 971–43,988 characters. Only ~31 of 55 follow even the informal "standard" section set;
the rest use divergent vocabulary (`Units`, `Objective`, `Topology`, some headings in
Portuguese). There is no single format today, because there is no schema — every session free-
hands its own goal file.

Reference: Claude Desktop's "Step 3 of 5" Topbar pill + Progress popover, which is the shape the
operator asked to be mirrored.

## 2. Journeys

- **Operator.** Opens a session that owns an active mission; sees "Step 4 of 10" in the Topbar
  without asking. Clicks it: sees the fixed frame, the current free step, which child sessions
  are working on it, what's blocked and why, and a `you` line that's either concrete ("approve
  the re-scope for step 6") or explicitly says there's nothing to do. Approves the mission at
  the start; closes it at the end once the verifier has proven the declared end.
- **Agent (owner).** Declares the mission's end before starting (kind + target + evidence).
  Adds steps as the work reveals itself, each with a reason once the mission is active. Links
  child sessions/worktrees/cards to steps as it dispatches them. Logs narrative notes. Reports
  a re-scope request when the original end proves wrong, and waits for approval rather than
  silently changing it.
- **Agent (child), when spawned via `create_session`.** Reports to its owner via Claude Code's
  native `SendMessage` — this specific spawn shape (`agentControlled`, and likewise a T245
  read-only review companion) never gets Capy MCP verbs at all (`src/main/pty.ts`). The owner is
  the one that persists what a child reports.
- **Agent (child), when manifest/board-dispatched (`spawnedBy: 'agent'`).** Keeps full Capy MCP
  access — the same access its owner has — and could call `mission_*` verbs on its own step
  directly. Whether it should is Open question E (design.md §13); this PRD does not assume either
  answer.
- **Agent (child), addressing its owner.** New requirement from live incidents (T360's last
  three appends, BUG-144): a child addresses its owner by the owner's **stable session id**,
  resolved to whatever native `SendMessage` name is current **at send time** — a name can change
  across a park/resume cycle. When no name resolves at all, the child must never broadcast its
  report to unrelated peers; the actual fallback (queue, drop, retry) is undecided (design.md §13,
  Still open E).
- **Agent (verifier).** Calls `mission_verify_step` on the fixed-end step (and any `verifier`-
  level middle step) with a declared verdict. The call never fails: **resolved 2026-09-26** —
  Capy's MCP transport has no per-session identity (one shared config/token for every session —
  `docs/capy-features.md`), so the operator chose convention + audit over a hard refusal. The
  step reaches `proof: 'verified'` only when it already has at least one linked `session` and the
  verifier's declared id differs from all of them; otherwise it lands on `proof: 'self-verified'`,
  which the UI never shows as "proven" (design §1.3, §13 Resolved A).

## 3. Concepts

### 3.1 Mission

The structured replacement for a goal file: one id, one owner session, a declared end, an
ordered list of steps. Full schema in design.md §1.

### 3.2 Fixed frame, free middle (decision 4)

Every mission's first step is always "Scope confirmed" and its last is always "Delivered and
verified" — these never move and never get renamed. Everything between them is free: the owner
adds, never removes, steps as the work is actually scoped out.

### 3.3 Verification levels (decision 8)

Each step declares, at plan time, how its proof is reached: `existence` (Capy checks a linked
artifact exists, no model call), `verifier` (an independent session grades it — resolving to
`verified` or, absent a genuinely independent linked session, `self-verified`, never silently
"proven"), or `human` (only the operator can mark it proven, via the UI, never an MCP verb). See
design.md §1.3, §6, §13 Resolved A.

### 3.4 Derived vs. declared (decision 10)

The owner declares **structure** (steps, links, the end). Capy computes everything that would
otherwise drift out of sync on its own: child-session liveness, linked commits/PRs, existence
proofs, and staleness. The UI never trusts a stale narrative note over a live signal.

## 4. Delivery units

See the plan (`docs/plans/2026-09-26-mission-progress.md`) for the full stacked-slice breakdown,
files, ACs and eval gates per slice. Summary:

| Slice                                  | Scope                                                                                                                                 | Branch (stacks on the row above)                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| S1 — Data model + storage              | `mission-core.ts`, frontmatter schema, id-minting, concurrency lock                                                                   | `T358-s1-mission-data-model` (bases on `main`)                    |
| S2 — Hibernation exemption             | small T127 policy hook — **moved up, ships in the base plumbing** (§13 Resolved B), needs only S1                                     | `T358-s2-mission-hibernation-exemption`                           |
| S3 — Core verb catalog                 | `mission_create/get/list/add_step/update_step/link_child/log` + handlers                                                              | `T358-s3-mission-verb-catalog`                                    |
| S4 — Blockers, re-scope, close, verify | `mission_set_blocker/clear_blocker/set_end/request_close/verify_step` (never refuses; resolves to `verified`/`self-verified`)         | `T358-s4-mission-blockers-rescope`                                |
| S5 — Behavior-eval harness             | headless `claude -p` harness + state-assertion grading (built early so S6+ can use it)                                                | `T358-s5-mission-eval-harness`                                    |
| S6 — Derived signals + stall           | scoped fleet projection, PR-stack join, existence checks, §8 stall rule                                                               | `T358-s6-mission-derived-signals`                                 |
| S7 — Migration                         | `mission_import_legacy`, corpus fixture, migration eval                                                                               | `T358-s7-mission-migration`                                       |
| S8 — Skill migration + shadow phase    | 5 skills rewired to `mission_*`; `report-back`/`draft-to-prompt` bundled; dual-write divergence checker; stable-session-id addressing | `T358-s8-mission-skill-migration`                                 |
| S9 — UI wiring                         | Topbar pill, popover, sidebar flag, per the approved T359 mockup (design.md §10)                                                      | `T358-s9-mission-ui`                                              |
| S10 — Retirement                       | drop shadow dual-write once divergence-free; archive legacy goal files                                                                | `T358-s10-mission-retirement` (time-gated, not just review-gated) |

Every slice stacks on the branch immediately above it and opens its own PR against that branch
(never "after X is merged") — see CLAUDE.md's stacking convention and the plan for full detail.

> **Superseded 2026-10-01 (Mission v3, T381; T371 closed):** the shadow phase in S8 and the
> retirement slice S10 above were not carried out as written. The dual-write and the divergence
> checker were removed, so S10's "once divergence-free" condition has nothing left to wait on. The
> same applies to the risk below that ties the shadow phase to the eval harness slice.

## 5. Data contract

Full `Mission`/`MissionStep`/`Blocker`/`DeclaredEnd` TypeScript shapes and the complete
`mission_*` verb-to-ACK table are in `design.md` §1 and §4 — this PRD does not repeat them to
avoid the two documents drifting apart; treat design.md as the single normative source for the
contract, this PRD as the product framing around it.

## 6. Deferred / settings

- Folder View mission list (decision 16 explicitly defers this past v1 — Topbar/sidebar only).
- Per-repo mission retention/archival policy — missions are never deleted today (design.md §9,
  same "never delete, archive" convention as cards); a cleanup policy is not specified here.
- Cross-repo mission rollups (an operator with 5 active missions across 5 repos seeing one
  combined view) — out of scope, `capy:status` already aggregates per-repo goal files today and
  will keep doing so per-mission.

## 7. Safety invariants

- `mission_create` never succeeds without a complete `declaredEnd` (decision 5).
- No MCP verb ever writes `Mission.status: 'closed'` or moves `draft → active` — both are UI-only
  actions, mirroring `move_card`'s refusal to write `status: 'done'`.
- `mission_verify_step` **never refuses** (resolved 2026-09-26, §13 Resolved A) — it takes a
  self-declared, unauthenticated `sessionId` and always succeeds. It reaches
  `proof: 'verified'` only when the step already has at least one linked `session` and the
  verifying id differs from all of them; otherwise it lands on `proof: 'self-verified'`, which
  the UI never shows as "proven" (design.md §1.3, §13 Resolved A).
- A re-scope (`mission_set_end`) never overwrites `declaredEnd` in place; it stages
  `pendingRescope` until the operator approves it (decision 6).
- Migration (`mission_import_legacy`) never deletes the source goal file (design.md §9).
- A child session spawned via `create_session` (`agentControlled`) or as a T245 review companion
  (`readOnly`) never receives any `mission_*` verb — it has no Capy MCP server at all
  (`src/main/pty.ts`); it can only reach its owner through Claude Code's native SendMessage. A
  **manifest/board-dispatched** child (`spawnedBy: 'agent'`) is not withheld and keeps full
  `mission_*` access — see Open question E on whether it should use it directly.

## 8. Non-goals

- Rewriting `plan_mission` (the capability-grant verb) — unrelated feature, name collision
  documented not resolved by renaming (ADR-0015, design.md §2).
- Enforcing mission nesting structurally — resolved 2026-09-26 (§13 Resolved D): v1 stays
  convention-only, with `mission_get`'s projection flagging a linked child that also owns a
  mission for the operator to notice, not blocking it.
- A generic, model-graded "is this deliverable done" verifier for every possible `DeclaredEnd`
  kind — v1 ships four concrete rubrics (`code`, `ui`, `research`, `decision`) plus a generic
  fallback (`other`), not an open-ended grader.
- Retiring the personal `mission`/`status` skill copies from wherever they live outside this
  repo — that deletion is an operator action once the bundled skills fully cover them (design.md
  §11), not something a PR in this repo can do.

## 9. Risks

- **Migration is lossy by construction for ~44% of the existing corpus** (24/55 files don't
  follow the standard section set). Mitigated by always preserving the raw markdown verbatim
  alongside whatever structure is recognized (design.md §9) — the risk is degraded _structure_,
  never lost _content_.
- **SendMessage latency is bounded by the owner's longest blocking tool call** (measured ~135s
  once). The UI's derived signals (§7 in design.md) do not depend on the note arriving promptly,
  but the Log narrative can lag. No code mitigation proposed beyond documenting the operational
  guidance (owners should prefer `run_in_background` while a mission is active).
- **`claude plugin eval` cannot serve as the sole eval harness** (no A/B, no custom graders, no
  ad-hoc MCP) — the plan budgets a dedicated slice (S5) to build the missing behavior-eval
  harness; if that slice slips, the shadow phase and the retirement of the legacy markdown path
  both slip with it, since decision 19 gates retirement on the shadow phase.
- **Hibernation exemption (S2) ships earlier than the rest of the mission plumbing** (§13
  Resolved B — no longer a deferred option). It only needs S1's `Mission` storage plus existing
  fleet primitives, so this is safe, but it does mean the policy module gains a mission-shaped
  dependency before the verb catalog (S3) or derived signals (S6) exist — reviewers should not
  expect `mission_get` to be callable yet when this slice lands.
