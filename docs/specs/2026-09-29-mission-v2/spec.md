# Mission v2 — fixes from the first real orchestration

- **Date:** 2026-09-29 · **Revision:** 2 (after adversarial review)
- **Status:** implemented (2026-09-29) — S1 incl. BUG-145 #390, S2 #391, S3 #392, S4 #393, S5 #394 (this change, stacked #394 → #393 → #392 → #391 → #390 → `main`). Deviations from this spec: §10.
- **Source:** live monitoring of one real delivery (`sandbox/wt2`, weight-tracker F1→F8, mission `mnt-347f2450`, 18 ticks over ~2h20, 10 steps, 8 PRs) plus a second organic mission in another repo. Evidence: `.capy/out/mission-monitor/findings.md` + `snapshots.jsonl`. Review: §9.
- **Parent:** T358 (Mission progress, merged in #388).

> **Superseded in part by Mission v3 (2026-10-01, T381).** `docs/specs/2026-10-01-mission-v3/spec.md`
> replaced these parts of this spec. Everything not listed here still holds.
>
> - **§3.1 (counter).** "{done} of {total} done" is replaced by the position headline "Step N of M"
>   (with "Steps a–b of M" and "Step M of M ✓"). The "current marker stays on the first open step"
>   bullet goes with it: N and the marker are now the same step. "Draft shows real progress" is moot,
>   because there is no draft. The `scope` bullet survives with one change: the paths are stored as
>   `Mission.scope`, an attachment, not as links on a fixed start (which new missions no longer have).
> - **§3.2 (draft copy and approval callout).** There is no draft, no "Not approved yet" sub-line and
>   no Approve callout. A mission is born `active` with `declaredEndApproval.via: 'chat'`. The skill
>   half of §3.2 stands: create the mission before dispatch and agree the end in one question; that
>   chat agreement is now the whole approval.
> - **§3.4, the draft cue (slice S3).** "A draft waiting for Approve" is no longer an owed kind. The
>   cue follows the ordered `you` list and fires only when a key appears or its count grows
>   (`mission-cue.ts`). The operator-blocker skill rule, the 30-minute re-nudge and the restart rule
>   stand.
> - **§3.5 (close readiness).** The close door that re-validated the end, blockers and a staged
>   re-scope is replaced by one **end door**: the operator closes any open mission as delivered or
>   discards it, and the server returns `closeWarnings[]` for the dialog instead of a refusal.
>   `closeReadiness` and `mission_request_close` remain, minus `MISSION_DRAFT`. The fixed end's
>   author set is unchanged.

## 1. Problem

The data layer worked. The owner kept the mission in sync with the plan: every unit was added, linked and verified within ~10 min of finishing, and mission verbs were 13 of 42 tool calls (≈31%) in the busiest window. The `you` line tracked real Inbox approvals. The total-changed header and the child dots were correct.

Two things went wrong: what the operator saw was misleading, and the mission could not finish.

| #   | Symptom (evidence)                                                                                                                                                | Root cause (verified in code)                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | The pill stayed at "Step 1 of N" for the whole delivery, even with 8/10 steps verified (F3, ticks 2–18).                                                          | `stepIndex` is the first open step (`mission-view.ts:143-145`), so one unproven step hides everything after it. The fixed start "Scope confirmed" is `existence`-level. A `worktree` link already proves any existing path (`tool-handlers.ts:3029-3031, 3166-3168`), but nothing told the owner to link the scope docs. The verb text says "worktree (its path)" (`tool-catalog.ts:1385`) and the error says "(worktree / card / pr)" (`tool-handlers.ts:3054`). |
| P2  | Draft showed "Step 0 of 5" while F1 was merged and verified (F2).                                                                                                 | `buildMissionModel` zeroes `done[]` in draft (`mission-view.ts:140-141`).                                                                                                                                                                                                                                                                                                                                                                                         |
| P3  | The draft copy said "Draft — nothing runs until you approve it" while 3 worktrees, 3 sessions and a merge ran (F1).                                               | Nothing gates dispatch on mission status. `orchestrate-delivery` tells the owner not to wait for approval, while the `mission` skill says "never tell the operator it is running before they approved it" (`mission/SKILL.md:53-55`). Copy and skills contradict each other.                                                                                                                                                                                      |
| P4  | The agent authored the declared end 55 s after the skill started and never asked (F10). The Approve callout does not show the end.                                | Skill Phase 3 dictates the end template and creates the mission after dispatch.                                                                                                                                                                                                                                                                                                                                                                                   |
| P5  | The operator changed the delivery rule to stacked PRs; the end still says "merged into main" (F11).                                                               | No rule tells the owner to call `mission_set_end`.                                                                                                                                                                                                                                                                                                                                                                                                                |
| P6  | The mission waited ~25 min on the operator's merges, twice. The pill stayed neutral, `you` said "you're clear", and there was no sound or notification (R1, F12). | The verb supports operator-owned blockers (`owner: 'operator'` feeds `you`, `tool-handlers.ts:2845-2848`), but no skill tells the owner to raise one. An operator blocker also has no sound or attention cue.                                                                                                                                                                                                                                                     |
| P7  | The mission could not be closed (F15).                                                                                                                            | Close requires the fixed end `verified`. `verificationLabel` (`tool-handlers.ts:3714-3717`) gives `verified` only when the step has a `session` link and the caller is not one of them. The fixed end has no session links, so the owner always lands `self-verified`. The done-final dot and "✓ Proven" never render (`mission-view.ts:96-101, 159`).                                                                                                            |
| P8  | The owner cannot see ahead of time that a close would be refused.                                                                                                 | `mission_get` has no readiness field. The renderer's `closeRefusal` only answers after a request (`mission-core.ts:509-513`). `mission_request_close` does not check `pendingRescope`, but the close door does (`mission-core.ts:521`), so a request can pass and then fail at the door.                                                                                                                                                                          |
| P9  | PRs #3–#6 merged into `stack/w2-base` instead of `main` (F14).                                                                                                    | The skill did not retarget stacked PRs before handing the merges to the operator. `pr` links carry no base branch (`tool-handlers.ts:3003-3010`).                                                                                                                                                                                                                                                                                                                 |
| P10 | A child shows `status: idle` and `taskState: working` side by side (F9 residual).                                                                                 | The verb description does not say which field means "working".                                                                                                                                                                                                                                                                                                                                                                                                    |

Out of scope, handled elsewhere:

- Native scrollbar in the popover (PR #389).
- `CLAUDE_CODE_CHILD_SESSION` inherited by a Capy launched from inside Claude Code, which silently disables transcript saving (separate bug card).

Findings considered and left alone:

- **F13, false stall while waiting on the operator.** `missionState` already ranks needs-you above stale (`mission-view.ts:113-115`). Raising the blocker refreshes the stall clock. The watchdog's finding C depends on `stale` (`delivery-watchdog/SKILL.md:79-82`). Changing the §8 formula would silence it, so the formula stays.
- **F8, approval not pushed to the owner.** Low impact once P3 and P4 land.
- **Stale flag on a freshly seeded or imported mission.** Rare, low impact.
- **~31% bookkeeping cost.** Acceptable for the visibility it buys.
- **Unlinked helper sessions.** By design.
- **F11's "auto-prompt a re-scope when the Log records a rule change".** Rejected: the skill rule in §3.3 is explicit and auditable, and a parser over free-text logs is not.

## 2. Goals

- **G1.** The pill tells the truth about progress at every moment, including a delivered 10/10.
- **G2.** Anything waiting 100% on the operator is loud outside the transcript: needs-you on the pill and sidebar chip, the chime, OS attention, an Activity entry, and a re-nudge.
- **G3.** A normal orchestration reaches `delivered` and `closed` honestly, without gaming the proof rule.
- **G4.** The declared end is agreed with the operator before dispatch, and re-scoped when the delivery rule changes.
- **G5.** No copy (UI, skills, docs) promises a guarantee the code does not enforce.

Non-goals:

- Gating dispatch on mission status.
- Per-session MCP identity.
- Changing the stall formula.
- Changing the board or manifest.

## 3. Design

### 3.1 Progress truth (P1, P2)

- **Counter = done steps.** New i18n key `mission.pillDone` = "{done} of {total} done", used in all three consumers: `MissionPill.vue:101`, `MissionPopover.vue:47-48`, `SidebarFolder.vue:424/917`. A delivered mission shows "10 of 10" with the ✓.
- **The "current" marker stays on the first open step.** An unproven fixed start therefore still carries the marker; this is accepted, because the counter no longer depends on it.
- **Draft shows real progress.** Remove the draft zeroing. Draft keeps the neutral tone and the approval callout.
- **Scope links at birth.** `mission_create` gains an optional `scope: string[]` of repo-relative paths, stored as links on the fixed start.
  - They are contained lexically (after `path.resolve`) plus `realpath`; a path outside the repo is refused. This is not the S7 O_NOFOLLOW reader, because the check only probes existence.
  - Verb text and the error message say that a path link can point at any file or directory in the repo.
  - Existing `worktree` links are unchanged, including absolute paths.
- **design.md first:**
  - Mission pill in §6.
  - The draft rows at `design.md:5143-5144`.
  - T358 design §10.2 / `:503` updated to match.

### 3.2 Honest approval (P3, P4)

- **Draft copy:** "Not approved yet — progress is tracked; the end is not agreed." Exact wording goes in design.md §8. No claim that nothing runs.
- **The approval callout shows the declared end** (kind · target · evidence) above the Approve button.
- **Skill (`orchestrate-delivery`):**
  - Create the mission in **Phase 1**, after the topology and before any dispatch.
  - Propose the end from the spec. The operator confirms it in **one AskUserQuestion**, with the proposal as the recommended option.
  - Dispatch does not wait for the Approve click.
- **Skill (`mission`):** drop "never tell the operator it is running before they approved it". Replace it with: "Dispatch may run before approval; say so, and say the end still needs the operator's Approve."

### 3.3 End re-scope on rule change (P5)

- **Skill (`orchestrate-delivery` + `mission`):** when the operator changes how the delivery ends (merge policy, target branch, what counts as done), the owner calls `mission_set_end` in the same turn. The existing re-scope door handles the approval.

### 3.4 Operator-owned waits are loud (P6)

- **Skill (`orchestrate-delivery` + `mission`), hard rule:**
  - A turn that ends waiting on the operator raises `mission_set_blocker { owner: 'operator', reason, unblocks }`. This covers merges, keys, credentials and decisions.
  - The owner clears it as soon as the operator acts.
- **Renderer cue.** The chime (`playNotificationSound()`), `requestAttention()` and one Activity entry fire when a mission starts owing one of the kinds below (new id or new reason):
  - an operator-owned blocker;
  - a staged re-scope;
  - a pending close;
  - a draft waiting for Approve.
- **Kinds that already chime** through the Inbox and the task-state pipeline (`approvals`, `needs-input`) get no second cue.
- **Initial load / restart.** One combined cue if any mission is already owed ("N missions need you"), then transitions only.
- **Re-nudge.** Every 30 min while the same item stays owed, driven off the existing 20 s store poll (`missions.ts:21`). No per-mission timer; the store keeps the `firstOwedAt` / `lastNudgedAt` pair per mission.
- **design.md:** next to "Safety confirms — sound + attention" (`design.md:618`).

### 3.5 Closable missions (P7, P8)

- **The fixed end's authors are every session that built a step.** For the fixed end only, `verificationLabel` treats the union of all custom steps' `session` links as the linked set.
  - The owner is not one of them, so its `mission_verify_step` on the end lands `verified`, exactly as it does for a custom step.
  - Decision 8 ("the end always uses the verifier") and the close door stay unchanged.
  - If no custom step has a session link, the end stays `self-verified`. This is honest, and the close is refused as today.
- **`closeReadiness` in `mission_get`:** `null` when `mission_request_close` would succeed now, otherwise its refusal code and reason (draft, end not verified, open blockers, staged re-scope).
- **`mission_request_close` also refuses `RESCOPE_PENDING`**, so the request and the door agree.
- **Skill wording:**
  - `orchestrate-delivery` Phase 4.
  - The `mission done` section (`mission/SKILL.md:386-391`).
  - `delivery-verifier:215`.
  - All three state that the owner verifies the end after every unit is verified and the end's evidence exists, then requests the close.
- **ADR-0015** gets a note on the fixed end's author set.

### 3.6 Merge target (P9)

- **Skill (`orchestrate-delivery`):** a checklist step before handing merges to the operator. For each stacked PR whose base already landed, run `gh pr edit <n> --base <default>` and confirm the base.
- **Link signal:** `baseRefName` is added to `pr` link signals and `MissionPrSummary`. It already exists on `PrEntry`, `pr-stack.ts:81`. Informative only; no derived flag, because a merged-off-default PR can later reach `main` through its base and would stay flagged forever.

### 3.7 Child state wording (P10)

- `mission_get` description: "`taskState` is what the session is doing (`working` / `idle` / `needs-input` …). `status` is the sidebar row's state. Read `taskState`."
- Drop `status` from `MissionChildState` if no consumer reads it. S1 confirms this.

## 4. Contracts touched

**MCP**

- `mission_create`: `+scope`.
- `mission_get`: `+closeReadiness`; `baseRefName` on PR signals; description text.
- `mission_request_close`: `+RESCOPE_PENDING`.
- `mission_verify_step`: the fixed-end author set.
- Also update: `docs/capy-features.md` + marker bump, `docs/user/agent-control.md`, CHANGELOG.

**UI**

- Counter key and its three consumers.
- Draft copy, and the declared end in the callout.
- The owed-to-operator cue and the re-nudge.
- Also update first: design.md; i18n `en` + `pt-BR`.

**Skills**

- `orchestrate-delivery`: Phase 1 mission, the end question, the operator-blocker rule, the retarget checklist, the Phase 4 close.
- `mission`: the approval wording, the operator-blocker rule, `set_end` on a rule change, `mission done`.
- `delivery-verifier`: the end wording.
- `delivery-watchdog`: no change; finding C stays the backstop.

**Specs and tests**

- T358 design.md §1.3, §3, §10.2 amended, plus the ADR-0015 note.
- Tests that pin the current behavior and must change: `mission-view.test.ts:191, :214`; `mission-handlers.test.ts:1317-1343, 1449-1450`; `mission-operator-doors.test.ts:158-166`; `mission-ipc.test.ts:199`.

## 5. Acceptance criteria

| AC    | Criterion                                                                                                                                                                                                                                                                                                               | Verify by                   |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| AC-1  | A mission with 8/10 steps done and an unproven fixed start shows "8 of 10 done" in the pill, the header and the sidebar chip. A delivered mission shows "10 of 10 done" with the done-final dot.                                                                                                                        | test                        |
| AC-2  | A draft mission with 1 verified step shows "1 of N done".                                                                                                                                                                                                                                                               | test                        |
| AC-3  | `mission_create { scope }` links the given paths to the fixed start. An existing repo file proves it. A missing path, a path outside the repo, or a symlink resolving outside the repo is refused or unproven.                                                                                                          | test                        |
| AC-4  | No renderer string, skill or user doc claims that nothing runs before approval. The approval callout shows the declared end.                                                                                                                                                                                            | test + grep + visual        |
| AC-5  | An operator-owned blocker, a staged re-scope, a pending close or a draft cues once with chime + attention + Activity. It re-cues after 30 min while unchanged. Approvals and needs-input are not double-cued. A restart with owed missions gives one combined cue.                                                      | test (fake timers) + manual |
| AC-6  | When every custom step has session links and the owner verifies the end, the end lands `verified`. `mission_request_close` then reaches `delivered`, and the operator's Close reaches `closed`. When no step has a session link, the end is `self-verified` and the close is refused.                                   | test                        |
| AC-7  | `mission_get.closeReadiness` equals what `mission_request_close` would return at that moment. `request_close` refuses a staged re-scope.                                                                                                                                                                                | test                        |
| AC-8  | `pr` link signals carry `baseRefName`.                                                                                                                                                                                                                                                                                  | test                        |
| AC-9  | Behavior eval: new scenarios where the owner is told to wait for a merge (raises an operator blocker), the operator changes the merge rule (the owner calls `mission_set_end`), the owner closes a delivered mission end-to-end, and the owner creates the mission and asks the end question before its first dispatch. | eval                        |
| AC-10 | capy-features, user docs, CHANGELOG, design.md and i18n parity are updated, and the local pipeline is green.                                                                                                                                                                                                            | gates                       |

## 6. Risks

- **The operator-blocker rule depends on the model following the skill.** Mitigations:
  - AC-9 evaluates it.
  - The watchdog's finding C raises it once the mission is also stale.
- **The re-nudge could be noisy.** Mitigations:
  - Only the four owed kinds re-nudge.
  - One nudge per 30 min per mission.
  - Nothing fires after close.
- **The fixed end's author union could label a lazy verify as `verified`.** This is the same convention-plus-audit trust as for custom steps (ADR-0015). The operator still closes.

## 7. Open questions for the operator

- **Q1.** Re-nudge interval: a fixed 30 min (proposed), or configurable in Settings?
- **Q2.** Keep the fixed start "Scope confirmed"? Proposed: keep it, fed by `scope`.

## 8. Slices (for the plan)

| Slice | Content                                                                                                                                                            |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S1    | Core and MCP: the fixed-end author set, `closeReadiness`, rescope refusal in `request_close`, `scope` on create, `baseRefName`, description texts.                 |
| S2    | Renderer: the counter, draft progress and copy, the end in the callout.                                                                                            |
| S3    | Renderer: the owed-to-operator cue and the re-nudge.                                                                                                               |
| S4    | Skills and evals: `orchestrate-delivery`, `mission`, `delivery-verifier` rules, the four eval scenarios.                                                           |
| S5    | Docs and specs: T358 design amendments, the ADR-0015 note, capy-features, user docs, CHANGELOG (each slice carries its own entries; S5 closes the T358 spec text). |

## 9. Review log

Revision 2 applies an adversarial review against `main` (`8ad09c05`).

| Area             | Change                                                                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1               | The root cause was narrowed: path links already work, the problem is discoverability and the counter.                                              |
| P7               | The stall change was dropped, because it would silence watchdog finding C.                                                                         |
| P8               | Weakening the proof rule was replaced by the fixed-end author set. It keeps decision 8, lets delivered visuals render, and needs no dialog change. |
| P9               | `closeReadiness` replaced `closeRefusal`, which is useless before a request. The request/door rescope mismatch is fixed.                           |
| §3.4 cue         | Scoped to kinds that do not already chime, the draft case added, the initial-load rule defined, no per-mission timers.                             |
| §3.6             | The `mergedOffDefault` flag was dropped: it gave permanent false positives and had no consumer.                                                    |
| Skills           | The `mission` skill contradictions and `delivery-verifier` were added.                                                                             |
| Pinned tests     | Listed in §4.                                                                                                                                      |
| Dropped findings | Now stated explicitly in §1.                                                                                                                       |

## 10. Deviations from this spec

What shipped differs from the text above in these places. The T358 design amendments
(`docs/specs/2026-09-26-mission-progress/design.md`) document what shipped.

- **The fixed end also counts its own links (§3.5).** The spec's author set was "the union of all
  custom steps' `session` links". `verificationLabel` uses the end's own `session` links plus every
  custom step's, so a session someone links to the end directly is an author too. With no link on
  the end or any custom step the outcome is as specced: `self-verified`, close refused.
- **`mission.pill` was reused; there is no `mission.pillDone` (§3.1).** The existing key changed
  wording to "{done} of {total} done" and still serves the pill, the popover header and the sidebar
  chip (whose inline text is `{done}/{total}`).
- **Scope-path rules are stricter than §3.1's "lexical after `path.resolve` plus `realpath`".**
  Paths are resolved physically (symlinks followed one component at a time, dangling ones to their
  would-be target) and refused `BAD_SCOPE_PATH` when they land outside the repo, on the repo root,
  under a `.git` or `.capy` component at any depth, or in a worktree checkout (a directory holding a
  `.git` entry, or anything under `.claude/worktrees`; an unreadable directory counts as one). The
  same rules apply to a `worktree` link that `mission_link_child` puts on the fixed start — §3.1
  said existing `worktree` links, absolute paths included, stay unchanged — and containment is
  re-checked on every read, so a link can go from proven back to unproven. The stored `ref` is the
  checked repo-relative path. A missing path is accepted and unproven, not refused (AC-3 allowed
  "refused or unproven").
- **`MissionChildState.status` was kept (§3.7).** The spec said to drop it if no consumer read it.
  Only the `mission_get` description changed: it says `taskState` is what the session is doing and
  `status` is the sidebar row's state.
- **The end-before-dispatch eval needs sonnet (AC-9).** On haiku the owner writes the unit packets
  and links the child sessions in the turn it creates the mission and then asks the end question, or
  does not ask, even with the skill's "ask, then stop" rule (measured twice on 2026-09-29). It passes
  on sonnet (`npm run eval:mission -- --model sonnet end-before-dispatch`). The grader was not
  loosened for haiku; the other scenarios pass on haiku (`scripts/eval/mission-behavior/README.md`).
- **The cue sees only what a poll sees (§3.4).** A blocker raised and cleared between two 20 s
  polls never cues, and an item that stops being owed is forgotten. The spec did not say either.
