# Design — Mission progress

Promotes the free-markdown goal file (`.capy/goals/<session8>-<slug>.md`, read by no app
code today) into structured Capy data — a **Mission** — with `mission_*` MCP verbs, live
derived signals, and a Topbar/sidebar UI.

**Related documents:**

- **PRD:** [`docs/prds/T358-mission-progress.md`](../../prds/T358-mission-progress.md)
- **ADR:** [`docs/adr/0015-mission-as-structured-capy-data.md`](../../adr/0015-mission-as-structured-capy-data.md)
- **Plan:** [`docs/plans/2026-09-26-mission-progress.md`](../../plans/2026-09-26-mission-progress.md)
- **Smoke test:** `.capy/out/t358/smoke-report.md` (T360, local; not committed)
- **Mockup:** `docs/specs/2026-09-26-mission-progress/spec.html` + `review.html` (T359, PR #377,
  `card/T359-mission-progress-mockup-of-the-topbar-step-n-of-m-pill-progress` @ `ebcf16aa`; see §10)
- **Decisions:** project memory, page `decisions`, entry "2026-09-26 — Mission progress" (19 decisions)

## 0. Traceability — every decision maps to a section

| #   | Decision (one line)                                                                                               | Section                          |
| --- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| 1   | Promote the goal file into structured Capy data; one source of truth                                              | §1, §5                           |
| 2   | Name **Mission**, verbs `mission_*`; `plan_mission` collision documented                                          | §2, §13 Resolved C               |
| 3   | Owner = any session; ownership transferable; epic link optional                                                   | §1.1                             |
| 4   | Fixed frame: first step "scope confirmed", last "delivered and verified"                                          | §3                               |
| 5   | Declared end (kind + target + evidence) required at creation                                                      | §1.2, §4                         |
| 6   | Changing the declared end = re-scope, needs operator approval                                                     | §3, §4 (`mission_set_end`)       |
| 7   | Adding middle steps allowed, logged with reason, total shown                                                      | §3, §4 (`mission_add_step`)      |
| 8   | Per-step verification level: existence \| verifier \| human                                                       | §1.3, §6, §13 Resolved A         |
| 9   | `delivery-verifier` gains rubrics per deliverable kind                                                            | §6, plan slice (cross-doc)       |
| 10  | Owner writes structure; Capy derives live signals                                                                 | §7                               |
| 11  | Children report via native SendMessage; no new verb to children (only true for `agentControlled` children, §13 E) | §4, §7.1, §13 Still open E       |
| 12  | Blocker = reason + what unblocks + who; modeled as a flag                                                         | §1.4, §4                         |
| 13  | One nesting level; a linked child owns no mission of its own                                                      | §1.1, §13 Resolved D             |
| 14  | Human doors: operator approves at start, closes at end                                                            | §3, §4 (`mission_request_close`) |
| 15  | Stall detection deterministic, no model                                                                           | §8                               |
| 16  | UI v1: Topbar pill + popover + sidebar flag                                                                       | §10                              |
| 17  | Storage: local, one place per repo, shared across worktrees                                                       | §9                               |
| 18  | Bundled skills migrate; personal `mission`/`status` retire; `report-back`/`draft-to-prompt` become bundled        | §11                              |
| 19  | Eval: contract + migration + behavior + shadow gate the merge                                                     | §12                              |

> **Amended 2026-10-01 by Mission v3 (T381).** Decisions 4, 8, 14 and 19 changed. Each has a dated
> note where its section lives: decision 4 at §1.2, decision 8 at §1.3, decision 14 at §3, and the
> shadow phase of decision 19 at §12; §8 (decision 15) carries a note too. The rest of this table
> stands. What shipped is in `docs/specs/2026-10-01-mission-v3/spec.md`, including its "Deviations
> from this spec" list. Wherever the text below still says "draft", "Approve", "fixed start" or
> "Scope confirmed", read the note, not the original wording.

## 1. Data model

### 1.1 Mission

```ts
interface Mission {
  id: string // mnt-<8 hex>, minted like card ids
  slug: string // kebab, from title, unique per repo
  folder: string // absolute path of the repo/worktree that owns the file
  owner: { sessionId: string; folder: string } // decision 3 — ANY session, not only orchestrators
  linkedCard?: string // optional epic card slug (e.g. "T358-…")
  status: 'draft' | 'active' | 'stale' | 'delivered' | 'closed'
  declaredEnd: DeclaredEnd
  declaredEndApproval?: { at: string; bodyHash: string } // set once the operator approves
  pendingRescope?: DeclaredEnd // decision 6 — staged until approved or replaced by a later mission_set_end
  steps: MissionStep[] // steps[0] and steps[last] are the fixed frame (decision 4)
  blockers: Blocker[] // decision 12 — MISSION-level blockers (§1.4); step-level ones live on each step
  openQuestions: string[]
  pendingClose?: { at: string; requestedBy: string } // decision 14 — agent requests, operator closes
  createdAt: string
  updatedAt: string
  provenance: { author: 'agent' | 'human'; at: string; branch?: string } // same shape as RoadmapCard
  legacy?: LegacyImport // §9 — set only on a mission mission_import_legacy created
  legacyRaw?: string // §9 — that legacy file's full content, byte-for-byte
}

interface LegacyImport {
  source: string // absolute path of the imported .capy/goals/*.md — never modified or deleted
  sha256: string // `sha256:<hex>` of the source bytes at import time
  needsReview: 'declaredEnd'[] // fields filled best-effort instead of read from the file
}

interface DeclaredEnd {
  kind: 'code' | 'ui' | 'research' | 'decision' | 'other' // mirrors delivery-verifier's rubric kinds (decision 9)
  target: string // concrete deliverable, e.g. "PR merging T358's 4 slices into main"
  evidence: string // what proves it, e.g. "green CI + delivery-verifier report, all ACs met"
}
```

`legacy`/`legacyRaw` were added in S7 (T368, closing S1's finding F2: §9 named a `legacyRaw`
field that §1 lacked, and the zod schema strips any key it does not name, so an undeclared
`legacyRaw` would have been dropped on the next read → write). Approving a re-scope (§3) removes
`declaredEnd` from `legacy.needsReview` — the operator has now approved a declared end.

**`pendingRescope` survives unrelated edits (resolved in S9, T370, 2026-09-28).** A staged
re-scope is consumed only by the operator approving it (`applyApprovedRescope`) or replaced by a
later `mission_set_end`; `mission_add_step`, `mission_update_step`, `mission_set_blocker` and the
rest leave it alone. The earlier "void on mission edit" wording was never implemented and is
dropped: a re-scope is a question to the operator about the END, and adding a middle step does
not answer it. The popover shows "re-scope pending approval" until one of those two things
happens.

`mission_create` refuses without a complete `declaredEnd` (decision 5) — there is no
"draft with no target" state; `status: 'draft'` means "created, awaiting the operator's
initial approval" (decision 14), not "target undecided".

### 1.2 MissionStep

```ts
interface MissionStep {
  id: string // stp-<n>, ordinal-stable once assigned
  ordinal: number
  kind: 'fixed-start' | 'fixed-end' | 'custom'
  title: string // fixed-start: "Scope confirmed"; fixed-end: "Delivered and verified"
  verification: 'existence' | 'verifier' | 'human' // decision 8, declared at plan time, immutable after
  proof: 'unproven' | 'claimed' | 'verified' | 'self-verified' // 'self-verified' resolved 2026-09-26 §13
  verifiedBy?: {
    sessionId: string // self-declared — Capy has no per-session identity to check it against (§1.3)
    at: string
    verdict?: 'met' | 'unmet' | 'blocked' | 'needs-human'
  }
  links: StepLink[] // decision 10/11 — what Capy derives signals FROM
  blockers: Blocker[] // decision 12
  addedReason?: string // required when added after mission creation (decision 7)
}

interface StepLink {
  kind: 'session' | 'worktree' | 'card' | 'pr'
  ref: string // sessionId, worktree path, card slug, or "owner/repo#123"
}
```

`fixed-start` always uses `verification: 'existence'` (does the spec/PRD/ADR/resolved-questions
link exist and resolve). `fixed-end` always uses `verification: 'verifier'` (decision 4, 8 —
"the end always uses the verifier").

> **Amended 2026-10-01 by Mission v3 (T381) — decision 4: the fixed frame is the end only; scope is
> an attachment.** "Scope confirmed" was the step left undone in 12 of 13 real missions (its spec
> lives on a feature branch, not on the main checkout's disk), and it held the counter back. What
> shipped (Mission v3 spec §3.3):
>
> - **A new mission has no `fixed-start` step.** `mission_create` writes its plan numbered from
>   `stp-1`, then the `fixed-end` step ("Delivered and verified", `verifier`-level, always last).
>   The end is found by `kind: 'fixed-end'`, never by id or position. `mission_create` also takes an
>   optional `steps: { title, verification }[]`, so the plan is declared in one call.
> - **Scope is `Mission.scope: StepLink[]`** — the spec / PRD / ADR paths (kind `worktree`, one
>   file or directory in the repo), under the same containment rules as before (`BAD_SCOPE_PATH`).
>   It is set by `mission_create { scope }`, or added later with
>   `mission_link_child { scope: true, link }` (no `stepId`). Scope never enters progress; the
>   popover header lists it, and a path that does not resolve reads "on a branch".
> - **A legacy file keeps its `fixed-start` step on disk** — nothing is rewritten. `missionScope()`
>   reads that step's links as the scope, and the progress computation leaves the step out of the
>   count and out of the rail. The first scope link added to a legacy mission copies the fixed
>   start's links into `scope` first.
> - The `fixed-end` step, its `verifier` level and the author-set rule (the Mission v2 note under
>   §1.3) are unchanged. `mission_import_legacy` now writes the v3 shape too: the imported units
>   numbered from `stp-1`, then the end, and no scope (a goal file names no scope documents).

### 1.3 Verification levels and proof (decision 8)

| Level       | Who proves it          | How `proof` reaches `verified`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `existence` | Capy itself, no model  | Computed at read time (`mission_get`): the linked artifact (file, PR, card state) exists. Never stored as a claim — recomputed every read.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `verifier`  | An independent session | **Resolved 2026-09-26 (§13 A).** `mission_verify_step` (§4) always succeeds — it never refuses — and sets `proof` to one of two outcomes: `'verified'` when the step already carries **at least one `session` link** and the caller's declared id **differs from every one of them**; otherwise `'self-verified'`. Either way `verifiedBy` (with the declared, unauthenticated `sessionId`) is recorded, so the operator can audit it. Capy's MCP transport has no per-session identity (one shared config + bearer token for every session, confirmed in `src/main/mcp/server.ts`'s `configPath()` and stated plainly in `docs/capy-features.md`: "Capy's transport has no per-session identity, so it cannot tell who is calling") — the declared id can be misreported, so this is enforcement by convention-plus-audit, not a security boundary. Per-session MCP identity (a distinct token per spawn, which would make this checkable for real) was considered and rejected for now (ADR-0015, Alternatives rejected). |
| `human`     | The operator           | UI-only action (no MCP verb — mirrors `move_card` refusing `status: 'done'`). The Topbar popover's step row carries a checkbox the operator ticks; this writes through the same internal path `submit_manifest` uses to stamp controlled fields, never a path the agent can call.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

**Verdict (S4, T365).** The label above applies to a `met` verdict. `mission_verify_step` with
any other verdict (`unmet`/`blocked`/`needs-human`) still always succeeds and records
`verifiedBy` (with that verdict), but sets `proof` back to `unproven` — a verification that did
not find the step done is not proof, and otherwise `mission_request_close` (which checks
`proof === 'verified'`) could close on an `unmet` verdict. Its ACK therefore reports
`proof: 'verified' | 'self-verified' | 'unproven'` plus `verdict`. The verb refuses only a step
that is not `verifier`-level (`WRONG_VERIFICATION_LEVEL`): `existence` is computed at read time
and `human` is the operator's (AC-S4-2).

`claimed` is an interim, owner-set state (`mission_update_step` may move `unproven → claimed`
for `verifier`/`human` steps only — "I believe this is done, unverified"); the popover shows
`claimed`, `self-verified` and `verified` all differently, and **a `self-verified` step never
renders as "proven"** (operator decision, 2026-09-26) — it is visually distinct from `verified`
everywhere the UI shows proof state, not merely a caveat in a tooltip.

> **Amended 2026-09-29 by Mission v2 (T373) — the fixed end's authors.** The rule above reads
> "the step's own `session` links". That is right for a custom step and unreachable for the fixed
> end: nobody links a session to "Delivered and verified", and only the owner holds the `mission_*`
> verbs, so the owner always landed `self-verified` and no ordinary orchestration could close.
> For the **fixed end only**, `verificationLabel` (`tool-handlers.ts`) now takes as its author set
> the end's own `session` links **plus every custom step's**. The owner built none of those
> sessions, so its `mission_verify_step` on the end lands `verified`, exactly as it does for a
> custom step; a session that built a step and verifies the end still lands `self-verified`. With
> no `session` link on the end or on any custom step, the end stays `self-verified` and the close
> stays refused — the honest outcome. The decision-8 level (the end always uses the verifier), the
> `met`-only rule and the close door are unchanged, and the id is still self-declared, so this is
> the same convention-plus-audit trust as before (ADR-0015 carries the rationale). A delivered
> mission therefore reaches the done-final dot and "✓ Proven" (§10.2) in a normal orchestration.
> The Mission v2 spec wrote only "every custom step's" links; the shipped set also counts the
> end's own (Deviations, `docs/specs/2026-09-29-mission-v2/spec.md`).

> **Amended 2026-10-01 by Mission v3 (T381) — decision 8: proof is a detail, not the counter.** The
> three levels and who proves each are unchanged. What changed is what the headline counts: not
> proof (v2's "{done} of {total} done", and before it the first open step), but **position — where
> the work is now**. A step's proof is shown beside the headline ("N done · V verified"), never as
> it. The rule is one pure function in main (`computeProgress`, `src/main/mission-progress.ts`),
> exposed as `derived.progress` on `mission_get` and in the `mission:list` view, and rendered by the
> pill, the sidebar chip, the popover, `mission_list` and the skills; none of them recounts.
>
> - **Step state, first match wins:** a `needs-human` verdict reads `done` (checked before
>   everything else, so it wins over a `verified` label); `verified` (proof `verified`, or an
>   `existence` step proven by its links); `done` (proof `claimed`, or `self-verified` with verdict
>   `met`); `running` (a linked session other than the owner has `taskState: 'working'`); `blocked`
>   (an open blocker on the step); `waiting` (a builder session is linked but is not working);
>   `todo`.
> - **Current step:** the running steps (a range when several run in parallel); otherwise the first
>   not-done step after the last done one; when every step after the last done one is done but an
>   earlier one is open, the last step, without the ✓. A blocked step never advances it. A mission
>   with no countable steps has no current step and no headline (`progressHeadline` returns
>   `kind: 'empty'`, never "Step 0 of 0").
> - **Headline:** "Step N of M", "Steps a–b of M", or "Step M of M ✓" only when every step is done.
> - **Left behind** = `todo` steps before the last done step, except a step added after that step
>   was reached (`MissionStep.addedAt`; a step without it counts as original). `unprovable` lists
>   reached or current `existence` steps with no `worktree`, `card` or `pr` link.
> - **`self-verified` still never renders as "proven"** (the badge reads Claimed). It does count as
>   `done` when its verdict is `met`, so the hollow ✓ stands for "done, not verified".
> - **The `needs-human` verdict is no longer "unproven" (replaces the Verdict paragraph above for
>   that one value).** `mission_verify_step` with `needs-human` keeps the proof label the `met` rule
>   would give, records the verdict, and creates a **human check** on the step (deduped by label;
>   optional `checkLabel`, else the first line of the evidence). `unmet` and `blocked` still set
>   `proof` back to `unproven`. Because the label is kept, a `needs-human` verdict on the end can
>   still satisfy `mission_request_close`.
> - **Human checks (`Step.checks`)** are the new way to record "I checked it by hand" (DSQA,
>   validated visually, a designer sign-off). The agent (`mission_add_check`), a verifier
>   (`needs-human`) or the operator (the popover's "+ check") creates one; **only the operator ticks
>   or deletes** one, through the `tickCheck` / `deleteCheck` doors — no `mission_*` verb writes
>   `ticked`. Checks never change a step's state or the headline. An unticked check on a reached
>   step is **due**: it joins the `you` list and the close warnings. A `human`-level step stays a
>   stage of its own that the operator ticks (`applyOperatorVerifyStep`); skills default to checks.
> - **Proof flapping:** the last-known resolution of a `pr` or `worktree` link is kept in a userData
>   sidecar (`mission-link-cache.json`), not in the mission file, so an unreachable GitHub no longer
>   un-proves a step. Reads never write the mission file, which keeps `updatedAt` a pure evidence
>   signal (§8).
>
> The mockup's step vocabulary (§10.3) is now seven visuals: verified, done, running, waiting,
> blocked, to do, left behind. The Mission v3 spec §3.2 and `design.md` §6 "Mission progress" hold
> the current look.

### 1.4 Blocker (decision 12)

```ts
interface Blocker {
  reason: string
  unblocks: string // what would clear it
  owner: 'agent' | 'operator'
  raisedAt: string
}
```

A blocker is a **flag** on a mission or a step, not a status — `Mission.blockers` holds the
mission-level ones and `MissionStep.blockers` the step-level ones (`mission_set_blocker` writes the
first when called without `stepId`, the second with it). `Mission.blockers` was added in S4 (T365,
closing S1's finding F1: §1.4 described mission-level blockers but §1.1 had no field for them); a
file written before it existed reads as `blockers: []`. It stays a flag — same shape as `RoadmapCard.blocked`
(`roadmap-core.ts`), which is a boolean flag independent of `column`. A blocked mission's
`status` stays whatever it was (`active`/`stale`); `blockers.length > 0` is what the UI reads.

## 2. Naming — the `plan_mission` collision (decision 2)

`plan_mission` already exists (`tool-catalog.ts`) and mints a capability grant — unrelated to
this feature. **Resolution: document the difference, do not rename.** `plan_mission` is shipped,
audited, and referenced throughout `docs/capy-features.md`, `docs/user/agent-control.md`, and
every session's boot preamble; renaming it churns every one of those for zero functional gain
and breaks any operator muscle memory. Instead:

- The new feature's verbs are prefixed `mission_*` (no existing op uses that prefix — confirmed
  against `tool-catalog.ts`'s `MCP_OPS` union).
- `docs/capy-features.md` gets an explicit disambiguation line the first time `mission_*` is
  introduced: _"A **Mission** (`mission_*`) is progress tracking for a body of work; a **mission
  grant** (`plan_mission`) is a capability grant for a fan-out. They are unrelated features that
  happen to share a word."_
- The ADR records this as the decided alternative (see ADR §"Alternatives rejected").

Revisit only if operators report real confusion in practice (see ADR "Revisit When").

## 3. State machine

```
                 mission_create (declaredEnd required)
                          │
                          ▼
                     ┌─────────┐   operator approves (UI)   ┌─────────┐
                     │  draft  │ ───────────────────────────▶│ active  │
                     └─────────┘                             └────┬────┘
                                                                   │ no new evidence, linked
                                                                   │ sessions idle > 1h (§8)
                                                                   ▼
                                                              ┌─────────┐
                                                              │  stale  │──┐ new evidence
                                                              └─────────┘  │ arrives
                                                                   ▲───────┘
                                                                   │
                        fixed-end step proof → 'verified'         │
                                          │                       │
                                          ▼                       │
                                  mission_request_close (agent) ──┘
                                          │
                                          ▼
                                   ┌───────────┐   operator closes (UI)   ┌────────┐
                                   │ delivered │ ─────────────────────────▶│ closed │
                                   └───────────┘                          └────────┘
```

Steps move independently of the mission-level status: each `MissionStep.proof` progresses
`unproven → claimed → verified` on its own (§1.3). `active ↔ stale` is purely a derived,
deterministic signal (§8) — no verb transitions it; `mission_get` recomputes it every read.

**Operator doors (S9, T370).** `draft → active` is `applyOperatorApprove` (stamps
`declaredEndApproval` with the current declared end's hash); `delivered → closed` is
`applyOperatorClose`, which **re-validates** before closing — it refuses when the fixed end's
`proof` is no longer `verified` (a later `unmet` verdict sets it back to `unproven`), when any
mission- or step-level blocker is open, or when a re-scope is staged — because `pendingClose` is
not cleared by those later events. A `human`-level step is proven only by
`applyOperatorVerifyStep`. All four doors (with `applyApprovedRescope`) live in `mission-core.ts`
and are reached only through the renderer's `mission:*` IPC, never through a `mission_*` verb.

> **Amended 2026-09-29 by Mission v2 (T373) — the request and the door now agree.** Before, a
> staged re-scope blocked only the operator's close door: `mission_request_close` could succeed,
> land `delivered` + `pendingClose`, and the close then be refused. `requestCloseRefusal`
> (`mission-core.ts`) now runs these checks in order and stops at the first that fails:
> `MISSION_DRAFT` → `MISSION_CLOSED` → `END_NOT_VERIFIED` → `OPEN_BLOCKERS` → **`RESCOPE_PENDING`**
> (new). `mission_request_close` returns exactly that refusal as `<code>: <reason>`. The door's own
> `closeRefusal` is unchanged — it additionally needs `pendingClose` and `status === 'delivered'`,
> and re-checks the last three at close time — so a request now passes only checks the door also
> applies, and the door can refuse afterwards only if something changed after the request.
>
> `mission_get` gains **`closeReadiness`**: the same `requestCloseRefusal(mission)` evaluated at
> read time — `null` when a request would succeed now, otherwise `{ code, reason }` for the first
> refusal. It is the owner's way to know ahead of time whether a close will land; the renderer's
> `closeRefusal` (which needs a request to exist) is not a substitute. Because it is the same
> function, the two cannot drift apart.

> **Amended 2026-10-01 by Mission v3 (T381) — decision 14: no start approval; the operator ends the
> mission with close or discard.** The state machine above lost its first box and its last door
> (Mission v3 spec §3.4, §3.5). What shipped:
>
> - **There is no `draft`.** `mission_create` writes `status: 'active'` and stamps
>   `declaredEndApproval: { at, bodyHash, via: 'chat' }`: the end agreed in chat before dispatch is
>   the agreement. `via` is `'chat' | 'operator'` (a re-scope the operator approved); absent means
>   the file predates v3. Removed: `applyOperatorApprove`, the Approve door and callout,
>   `MISSION_DRAFT`, and `draft` in the pill state, the cue key and the sidebar's amber `flagged`
>   chip (the chip now wears the pill's tone). **`draft` stays in the zod enum** so old files parse;
>   `parseMissionFile` reads a legacy `draft` as `active` for every reader (the stall rule, the
>   hibernation exemption, the renderer), and the next write persists it.
> - **The close door is now one end door.** `applyOperatorEnd` (the IPC door `end`) works on **any
>   mission that is not already closed**, with a choice — `closedAs: 'delivered' | 'discarded'` —
>   and an optional reason. It sets `status: 'closed'`, `closedAs` and `closeReason`, consumes a
>   pending close, appends `operator ended (<choice>)` to the Log, and leaves the file on disk as the
>   record. It **never refuses on open matters**; the server returns `closeWarnings[]` for the
>   dialog instead (`end-unverified`, `left-behind`, `checks-open`, `blockers-open`,
>   `rescope-staged`). This replaces the re-validating `applyOperatorClose` / `closeRefusal`
>   described above, and it makes an abandoned mission discardable. A second end on a closed mission
>   is `MISSION_CLOSED`.
> - **The agent's side is unchanged except for the draft.** `mission_request_close` still lands
>   `delivered` + `pendingClose` and refuses `MISSION_CLOSED`, `END_NOT_VERIFIED`, `OPEN_BLOCKERS`
>   and `RESCOPE_PENDING` (it lost only `MISSION_DRAFT`); `closeReadiness` stays. A closed or
>   discarded mission refuses every agent verb with `MISSION_CLOSED`, which the skills treat as
>   "stop the loop and report".
> - **Kept:** the re-scope approval (`mission_set_end` → `pendingRescope` → the operator's
>   `approveRescope`, now stamping `via: 'operator'`) and the operator's tick of a `human` step.
> - **`mission_add_step` needs a reason only once the mission has started** (a step has a link or a
>   proof, `isStarted`), instead of whenever the status is not `draft`. Planning steps added before
>   that carry no `addedReason`, so "steps added" appears only for real growth.
> - **Doors answer with the view they changed.** Every operator door returns that one mission's
>   re-derived view (`view: null` after an end), so the store patches or removes it at once.
>
> §10.2 below still describes the neutral `draft` look and the Approve callout; both are gone.

Re-scope (decision 6): `mission_set_end` never overwrites `declaredEnd` directly. It writes
`pendingRescope` and surfaces it as a `you`-line item (Approval Inbox-style) until the operator
approves it through the UI, which then moves `pendingRescope → declaredEnd`, stamps a fresh
`declaredEndApproval.bodyHash`, and clears the fixed-end step's proof back to `unproven` (the
old proof no longer applies to a changed target — same void-on-edit mechanism `submit_manifest`
uses for card approval stamps).

## 4. `mission_*` verb catalog

All entries follow `McpToolDef` (`tool-catalog.ts`) — `mutates`, `op`, gate fields fail closed
(an omitted field is the strictest behavior), same as every existing verb family.

| Verb                    | mutates | Gate posture                                                                                                                                                                                         | Args (key fields)                                                                                                   | ACK                                                                                                                                                                                                  |
| ----------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mission_create`        | yes     | `silentAllowInAgentFolder: true` (same class as `create_card`)                                                                                                                                       | `folder`, `title`, `declaredEnd`, `linkedCard?`                                                                     | `{ ok, missionId, slug, steps: [fixed-start, fixed-end] }`                                                                                                                                           |
| `mission_get`           | no      | read, no gate                                                                                                                                                                                        | `missionId` or `{ folder, ownerSessionId }`                                                                         | full `Mission` projection **plus** derived fields: per-step live child state (§7), computed `existence` proofs, stall flag (§8), `you` line (always present, `"— nothing, you're clear"` when empty) |
| `mission_list`          | no      | read, no gate                                                                                                                                                                                        | `folder?`                                                                                                           | `Mission[]` (id, slug, status, step counts) — for `capy:status`/Scheduler use                                                                                                                        |
| `mission_add_step`      | yes     | `silentAllowInAgentFolder: true`                                                                                                                                                                     | `missionId`, `title`, `verification`, `afterStepId?`, `reason` (**required** once `status !== 'draft'`, decision 7) | `{ ok, stepId, totalSteps }`                                                                                                                                                                         |
| `mission_update_step`   | yes     | `silentAllowInAgentFolder: true`; refuses `proof`/`verifiedBy` (controlled fields, same posture as `update_card` refusing `status`/`approved`)                                                       | `missionId`, `stepId`, `set: { title?, proof?: 'claimed' }`                                                         | `{ ok, stepId }`                                                                                                                                                                                     |
| `mission_verify_step`   | yes     | `silentAllowInAgentFolder: true`; **never refuses on self-verification** (resolved 2026-09-26, §13 A) — always succeeds; the self-declared caller id decides `verified` vs `self-verified`, see §1.3 | `missionId`, `stepId`, `sessionId` (the verifier's own, self-declared), `verdict`, `evidence`                       | `{ ok, stepId, proof: 'verified' \| 'self-verified' \| 'unproven', verdict }` (§1.3)                                                                                                                 |
| `mission_link_child`    | yes     | `silentAllowInAgentFolder: true`                                                                                                                                                                     | `missionId`, `stepId`, `link: StepLink`                                                                             | `{ ok, stepId, links }`                                                                                                                                                                              |
| `mission_log`           | yes     | `silentAllowInAgentFolder: true`                                                                                                                                                                     | `missionId`, `stepId?`, `note`                                                                                      | `{ ok }` — appended to the mission's free-text Log section (§9), the owner's narrative (decision 10)                                                                                                 |
| `mission_set_blocker`   | yes     | `silentAllowInAgentFolder: true`                                                                                                                                                                     | `missionId`, `stepId?`, `reason`, `unblocks`, `owner`                                                               | `{ ok, blockers }`                                                                                                                                                                                   |
| `mission_clear_blocker` | yes     | `silentAllowInAgentFolder: true`                                                                                                                                                                     | `missionId`, `stepId?`, and `reason` (exact match) **or** `index`                                                   | `{ ok, blockers }`                                                                                                                                                                                   |
| `mission_set_end`       | yes     | `silentAllowInAgentFolder: true`; writes `pendingRescope`, never `declaredEnd` directly                                                                                                              | `missionId`, `declaredEnd`, `reason`                                                                                | `{ ok, pendingRescope: true }`                                                                                                                                                                       |
| `mission_request_close` | yes     | `silentAllowInAgentFolder: true`; refused unless fixed-end step `proof === 'verified'` and no open blockers                                                                                          | `missionId`                                                                                                         | `{ ok, pendingClose: true }` or refusal `END_NOT_VERIFIED` / `OPEN_BLOCKERS`                                                                                                                         |
| `mission_import_legacy` | yes     | `silentAllowInAgentFolder: true`                                                                                                                                                                     | `folder`, `legacyPath` (a `.capy/goals/*.md` file)                                                                  | `{ ok, missionId, extractedFields: string[], legacyPreserved: true }` — see §9 migration                                                                                                             |

> **Amended 2026-09-29 by Mission v2 (T373) — verb surface.** Three rows above changed:
> `mission_create` also takes `scope?: string[]` (≤20 repo-relative paths, linked to the fixed
> start — see §7 for the containment rules); `mission_get` also returns `closeReadiness` (§3) and
> a `baseRefName` on every `pr` link signal and PR summary; `mission_request_close` also refuses
> `RESCOPE_PENDING` (§3), so its refusal list is `MISSION_DRAFT` / `MISSION_CLOSED` /
> `END_NOT_VERIFIED` / `OPEN_BLOCKERS` / `RESCOPE_PENDING`, not the two codes in the row. The
> `mission_get` description also says which child field means "working": read `taskState`;
> `status` is the sidebar row's state and was kept on the child projection.

No verb closes a mission (`status: 'closed'`) or approves it into `active` from `draft` — those
are UI-only, the same shape as `move_card` refusing `done` (decision 14). S9 (T370) wires them:
`applyOperatorApprove`, `applyApprovedRescope`, `applyOperatorVerifyStep` and `applyOperatorClose`
in `mission-core.ts`, reached only from the renderer through `src/main/mission-ipc.ts` (§3). `mission_import_legacy`
and `mission_verify_step` are the two most novel entries; everything else mirrors an existing
board-verb shape closely enough that a reviewer already knows the pattern.

Shared types live in a new `src/main/mission-core.ts` (mirrors `roadmap-core.ts`): the `Mission`/
`MissionStep`/`Blocker` interfaces above, id-minting, frontmatter (de)serialization, and the
controlled-field allowlist for `mission_update_step`. The catalog entries stay separate literal
objects in `tool-catalog.ts` (confirmed precedent: the board-verb family shares no explicit
TypeScript "family" type there either — sharing is by convention plus the common domain type).

## 5. One source of truth (decision 1)

Today, `.capy/goals/*.md` is read by **no app code** — only by the `mission`/`status`/
`orchestrate-delivery`/`delivery-watchdog` skills, each re-parsing prose by convention. After
this change, `mission-core.ts` is the only reader/writer; every skill and every UI surface goes
through `mission_*` verbs or the IPC equivalent. There is no parallel tool that also understands
the goal file's shape — the legacy format is read exactly once, by `mission_import_legacy`, and
never again.

## 6. Verification rubrics (decision 9)

`delivery-verifier` gains one rubric per `DeclaredEnd.kind` (`code`, `ui`, `research`, `decision`,
`other`) instead of the single generic rubric it has today (confirmed — fork research found no
kind-branching in the current skill). Each rubric answers, deterministically, whether a step's
`links` satisfy its declared kind:

- **code** — existing rubric (PR + green CI + AC-by-AC grading).
- **ui** — existing capture-based rubric; **must detect** missing browser MCP tools and degrade
  to `needs-human`, never silently `met` (smoke report §6 finding — the tools come from the
  user's global MCP config, not Capy, so another operator may have none).
- **research / decision** — new: "does the artifact answer each declared question, with sources",
  one question per call (same one-question-per-call rule the AC grading already follows).

This rubric work ships as its own plan slice (see plan, Slice "Verifier rubrics"); this design
doc only fixes the contract `mission_verify_step` expects (`verdict` ∈
`met | unmet | blocked | needs-human`, matching the skill's existing enum exactly — decision 8's
three verification levels map onto this enum without inventing a new vocabulary).

## 7. Derived live signals (decision 10)

The owner (agent or human) writes **structure** — steps, links, blockers, the declared end.
Capy derives everything that changes on its own:

- **Per-step child state.** For every `StepLink` of kind `session`, read `taskState`/
  `hibernated`/`peer` from a **new scoped projection**, `buildMissionFleetProjection(missionId,
linkedSessionIds)` in `fleet-snapshot.ts`. Confirmed: no such per-caller scoping exists today
  (`FleetFilter` only supports `activeOnly`/`sinceMinutes`/`limit`) — this is new code, not a
  reuse of unscoped `get_fleet` (hundreds of rows across every folder; the smoke report flagged
  this explicitly).
- **Commits/PRs in linked worktrees.** For every `StepLink` of kind `worktree`/`card`, join
  against `pr-stack.ts` (T198, already does `gh pr list` ↔ worktree-node joining) the same way
  the Folder View's PR Stack does.
- **`existence` proof.** Computed at `mission_get` time from the link's own existence (file at
  path, PR open/merged, card in `review`/`done`) — never a stored claim (§1.3).

  > **Amended 2026-09-29 by Mission v2 (T373) — what may prove "Scope confirmed".** A `worktree`
  > link proves any path that exists, which made the fixed start provable by the repo root or by
  > `.git`. Every path that reaches the fixed start — a `mission_create` `scope` entry, or a
  > `worktree` link that `mission_link_child` puts on it (BUG-145) — now goes through
  > `checkScopePath` and is refused `BAD_SCOPE_PATH` when it:
  >
  > - resolves outside the repo (`..`, an absolute path elsewhere, or a symlink whose target lies
  >   outside — existing or dangling);
  > - is the repo root;
  > - has a `.git` or `.capy` component at any depth (compared case-insensitively);
  > - is, or sits inside, a git checkout: a directory holding a `.git` entry (file or directory — a
  >   linked worktree, a submodule, a nested clone) at or between the root and the path, or anything
  >   under `.claude/worktrees`. The probe **fails closed**: only "no such entry" counts as "no
  >   `.git` here"; an unreadable directory counts as a checkout.
  >
  > The path is resolved **physically** (each symlink followed with `readlink`, `..` taken from
  > where a link lands) and the stored `ref` is the repo-relative path that was checked, so what is
  > stored is what is proven. A path that does not exist yet is accepted and leaves the step
  > unproven until it does. Containment is **re-checked on every read** (`scopeLinkProblems`), so a
  > path swapped for an out-of-repo symlink later, or that later becomes a checkout (`git init`
  > inside it), reads unproven with the reason, and so does a link written before this rule. Links
  > on every other step are stored and proven as before, absolute paths included. This only probes
  > paths; it is not the legacy import's `O_NOFOLLOW` reader (§9). The rule is stricter than the
  > Mission v2 spec's "lexical + `realpath`" (Deviations there).
  >
  > **Amended 2026-09-29 by Mission v2 (T373)** — `pr` link signals and `MissionPrSummary` also
  > carry `baseRefName`, the branch the PR merges into (from `PrEntry.base`). It is informative
  > only: there is deliberately no derived "merged off the default branch" flag, because a PR
  > merged into a stack base can later reach `main` through that base and would stay flagged.

- **Stall.** See §8.

### 7.1 Child reporting (decision 11)

**Whether a child holds Capy MCP access depends on how it was spawned — not on one blanket
"dispatched sessions get no MCP" rule** (corrected 2026-09-26; the smoke report's own framing of
this had the same error). Three distinct spawn paths exist (`src/main/pty.ts`,
`src/main/orchestrator-guard.ts`):

- **`agentControlled` (an agent's own `create_session` MCP call).** Capy's app-managed
  `--mcp-config` is withheld entirely — "prevents a recursive Conductor". This child has **no**
  Capy MCP server and cannot call any `mission_*` verb.
- **`readOnly` (a T245 review companion).** Withheld the same way as `agentControlled`, for a
  different reason (a reviewer must not be able to write to the worktree it's reviewing).
- **Manifest/board dispatch (`spawnedBy: 'agent'`).** **Not** withheld — this spawn path keeps
  full Capy MCP access. This very card, T361, is a manifest-dispatched session and used
  `mcp__capy__*` verbs (`memory_read`, `memory_query`, `memory_append`) throughout its own work —
  live proof this path is not withheld.

Decision 11 ("children report via native SendMessage, no new verb to children") describes the
`agentControlled` case, which is what most agent-initiated fan-out actually uses (`create_session`
is how a session dispatches its own children) — for that case, a child **cannot** call
`mission_log`/`mission_link_child`/`mission_verify_step` itself and must report to its owner via
Claude Code's native `SendMessage` (orthogonal to Capy MCP, unaffected by the withholding); the
**owner** then calls the `mission_*` verbs to persist what the child reported. This is exactly
today's pattern (T360 smoke test Q1, itself run from an `agentControlled` probe session) —
nothing new is granted to `agentControlled` children, and nothing needs to be.

A **manifest-dispatched** child, however, already holds the exact same Capy MCP access its owner
does — nothing structurally stops it from calling `mission_link_child`/`mission_log` on its own
step directly, without going through SendMessage at all. Decision 11 does not say whether that
should actually happen; see Open question E.

**Consequence, not a mitigation, for the `agentControlled` case specifically:** an owner with an
active mission and live `agentControlled` children should avoid long blocking calls (prefer
`run_in_background`) — the UI never depends on the note itself (the derived signals in §7 carry
state regardless of whether a report ever arrives), but a slow owner delays how promptly a
child's news reaches the Log. The T360 smoke test measured this once (SendMessage delivery bound
by the owner's longest blocking tool call, ~135 s while the owner sat in a 120 s Bash call).

**New requirement from live incidents (T360's last three appends, BUG-144).** A child addresses
its owner by the owner's **stable session id**, resolved to whatever the owner's _current_ native
`SendMessage` name is **at send time** — a session's native name can change across a park/resume
cycle, so a child that cached the name from an earlier turn can address a name that no longer
resolves to anyone. This is a requirement on the `mission`/`orchestrate-delivery` skill's
reporting instructions (plan slice, skill migration), not a new `mission_*` verb. **Undecided
fallback:** what a child should do when its owner's stable id no longer resolves to any live
session at all (parked with no resume in sight, or genuinely gone) — it must **never broadcast
its report to unrelated peers** just because the intended recipient is unreachable, but what it
should do instead (queue, drop with a local note, retry on a timer) is not decided. Carried as
part of Open question E, not resolved here.

## 8. Stall detection (decision 15)

Deterministic, computed at `mission_get` time, no model call:

```
stale := (mission.status == 'active')
      && (now - lastEvidenceAt > 1h)
      && every linked session's taskState != 'working'
```

`lastEvidenceAt` = max of: mission/step `updatedAt`, any `mission_log` timestamp, any linked
session's last `taskState` transition. `delivery-watchdog` reads `mission.status == 'stale'`
directly instead of re-deriving its own version (today it computes "case D" by hand — comparing
the newest Log line's timestamp against 3× a cadence it has to guess). One notification per
stale transition (edge-triggered, not repeated every tick), matching the skill's existing
dedup-by-append convention but backed by a real field instead of a `## Watchdog` card block.

> **Amended 2026-09-29 by Mission v2 (T373) — the formula is unchanged; operator waits now cue.**
> A mission that waits on the operator (say, a merge) could sit neutral and silent for 25 minutes,
> and one might expect the stall formula to change to cover that. It does not: `missionState`
> already ranks needs-you above stale, raising the blocker refreshes `lastEvidenceAt`, and
> `delivery-watchdog`'s finding C depends on `stale` — loosening the formula would silence it.
> Instead the renderer (`lib/mission-cue.ts`, driven by the 20 s poll in `stores/missions.ts`)
> cues the operator when a mission **starts owing** one of four things: an operator-owned blocker,
> a staged re-scope, a pending close, or a draft waiting for Approve. A cue is the chime
> (`playNotificationSound`), OS attention (`requestAttention`) and one Activity entry. The same
> unchanged item is re-cued once every **30 minutes** (`RENUDGE_MS`); a different item on the same
> mission (new blocker reason, new re-scope target) is a new cue; an item that stops being owed is
> forgotten. Approvals and `needs-input` are excluded — the Approval Inbox and the task-state
> pipeline already chime for them. On the first poll after a restart every already-owed mission
> lands in **one** combined cue, then only transitions. The cue only sees what a poll sees: a
> blocker raised and cleared between two polls never reaches the operator.

> **Amended 2026-10-01 by Mission v3 (T381) — the formula is unchanged; legacy drafts now read
> active.** `stale := status == 'active' && now − lastEvidenceAt > 1h && no linked session
working` is exactly as above, and `delivery-watchdog` still reads it. Three things around it
> moved:
>
> - **A legacy `draft` file reads `active`** (`parseMissionFile`), so the stall rule and the
>   hibernation exemption now see it. A dead legacy draft therefore reads `active` and, past an
>   hour, `stale`. It produces **no cue**, because `stale` is not an owed kind; the operator
>   discards it from the end dialog.
> - **Reads never touch `updatedAt`.** The sticky link resolutions live in a userData sidecar, so
>   `lastEvidenceAt` stays a pure evidence signal.
> - **The cue follows the ordered `you` list** instead of four fixed kinds (`mission-cue.ts`). The
>   "draft waiting for Approve" kind is gone. The kinds that cue are a staged re-scope, a pending
>   close, an operator-owned blocker, due checks, unticked `human` steps and an imported end to
>   review. A cue fires only when a key **appears or its count grows**; a tick, a resolution or a
>   decrease never chimes. The 30-minute re-nudge applies to a mission's list as a whole, the
>   restart rule (one combined cue) and the exclusion of approvals and `needs-input` are unchanged.

**Mitigation for smoke report Q2 (parked owner, "no") — resolved 2026-09-26 (§13 B).** A
session that owns an `active` mission with `linkedCard`-or-step links to live children is added
to the hibernation policy's existing never-park exemption list (`HibernationPolicyPane`/T127
already never parks a "working" session — this extends the same exemption to "owns an active
mission", regardless of that session's own idle state). **The operator decided this ships early,
as part of the base plumbing (plan Slice S2, right after S1), not as a fast-follow** — it was the
only hard "no" in the T360 smoke test and was then observed live (T356's orchestrator parked
mid-mission and its report went astray). Only S1's `Mission` storage is a real dependency (the
exemption predicate reads a `Mission` file directly and cross-references it against existing,
unmodified fleet primitives — it needs neither the verb catalog nor the derived-signals
projection built in later slices), which is what makes shipping it this early possible. Until it
lands, a parked owner still loses nothing structural: the mission's derived signals (§7) render
from the `Mission` record and linked sessions' own fleet state regardless of the owner's
liveness; only the owner's own narrative Log entries stop arriving while it's parked.

## 9. Storage, concurrency, migration (decisions 1, 17)

**Storage.** `.capy/missions/<mission-id>-<slug>.md`, one file per mission — sibling to
`.capy/memory/` and today's `.capy/goals/`, i.e. **local, gitignored, shared across every
worktree of the repo** (decision 17), not per-worktree. Frontmatter carries the full `Mission`
struct (§1) as YAML (mirrors `RoadmapCard`'s frontmatter exactly — `id`, `slug`, `status`,
`owner`, `declaredEnd`, `steps`, etc.); the markdown body is a free-text, append-only **Log**
section — the owner's narrative, exactly what `.capy/goals/*.md` calls "Log" today, kept for
humans and for `capy:status`, never authoritative for state (decision 10).

**Concurrency.** Same shape as `roadmap-ipc.ts`: an in-process, promise-chain lock keyed by
**mission id** (not just repo — a mission's steps can be written concurrently by its owner
handling two children's reports in quick succession, so scoping the lock to the repo the way
`withCardIdMintLock` does would over-serialize unrelated missions and under-serialize concurrent
writes to the _same_ mission from two tool calls in flight). `mission_create` uses the same
exclusive `{ flag: 'wx' }` write `createCardFile` uses — fails loudly (`EEXIST`) on a genuine
id collision rather than silently overwriting. This protects one Capy process; it does not
protect two Capy processes writing the same mission file (out of scope, same limitation
`roadmap-ipc.ts` already accepts).

**Migration (decision 1, smoke report Q7 — "partial").** The existing corpus (55 files across 7
repos measured 2026-09-26) is heterogeneous: only ~31 of 55 follow the "standard" section set
(North star / Done criteria / Executors / Pending gates / Tick checklist / Log); the rest use
different vocabulary (`Units`, `Objective`, `Topology`, `Ticks`, some headings in Portuguese).
A fully structured, lossless import is impossible. `mission_import_legacy` therefore:

1. Extracts recognized fields where the shape matches: `North star`/`Objective` → `declaredEnd`
   narrative (best-effort — flagged `needs-review` if no explicit kind/target/evidence can be
   inferred, since decision 5 requires `declaredEnd` to be complete); `Executors` table rows →
   `StepLink`s of kind `session`/`card`; `Pending gates` → `Blocker`s; `Log` → the new mission's
   Log section, appended verbatim (never re-summarized).
2. **Always** attaches the entire original file's raw markdown, byte-for-byte, as the
   `legacyRaw` frontmatter field — this is the "no loss" guarantee: the migration eval's pass
   condition is _raw body preserved byte-for-byte_ **and** _every recognized field extracted_,
   not "everything mapped cleanly". **Resolved in S7 (T368): always `legacyRaw`, never the
   sibling `.legacy.md` file.** One approach for every file, as the plan requires: the corpus
   tops out at ~44 KB, which a frontmatter string carries fine; one exclusive write keeps the
   mission and its raw source atomic; and a sibling `*.md` in `.capy/missions/` would be read as
   a mission by every reader that lists that directory (the hibernation exemption, the
   behavior-eval grader). A file that is not valid UTF-8 is refused (`LEGACY_NOT_UTF8`) rather
   than imported lossily. `mission_get` omits `legacyRaw` from its projection (it would repeat up
   to 44 KB on every tick) and reports its size and the mission file's path instead.
3. Never deletes the source `.capy/goals/*.md` file — same "never delete, archive" convention
   the board already follows for cards. The legacy file is left in place until the shadow phase
   (§12, decision 19) proves the new record and it is safe to archive.

**Known, accepted limitation of `mission_import_legacy` (operator decision 2026-09-28).** After
the `lstat` check that `.capy` and `.capy/goals` of the chosen base are real directories, the
realpath of that goals dir is computed by a fresh path lookup. A concurrent process of the same
user that swaps `.capy/goals` for a symlink inside that millisecond window could therefore make
the import read a file outside it. Everything around that window is refused and tested:
pre-existing and cross-base symlinks, `..` and absolute paths, a symlinked goal file, and any swap
after validation (the file is opened once with `O_NOFOLLOW` and its inode re-checked). Closing
the last window would need a directory-handle-relative open (`openat`), which Node does not
expose; the attacker it would stop already runs as the operator's user.

## 10. UI wiring (decision 16)

**Filled in 2026-09-26** from the approved T359 mockup: `docs/specs/2026-09-26-mission-progress/
spec.html` (machine-consumable contract, PR #377, `card/T359-mission-progress-mockup-of-the-
topbar-step-n-of-m-pill-progress` @ `ebcf16aa`) and its companion `review.html`. **Caveat:** both
files' own embedded status metadata still literally reads `"status": "draft"` — the orchestrator
relayed that the operator approved it, but the approval itself isn't recorded inside either file.
This design proceeds on the mockup's content as given; if any of review.html's five
"check-before-approving" items below were actually answered differently, treat this section as
needing a follow-up correction, not as wrong on its face.

**Implemented in S9 (T370, 2026-09-28).** The root `design.md` §6 "Mission progress (pill,
popover, sidebar indicator)" is now the visual contract and §5 carries the `list-checks` icon row;
the notes below stay as the design rationale. Two deltas from the mockup, both forced by data the
mockup did not have: the stale callout reads "no evidence in {duration}" (the stall rule records
the last evidence time, not a "last check" command), and the `you` line is rendered from a
structured item `mission_get`'s derivation now also returns, so it is translated instead of
printing the verb's English sentence.

### 10.1 Three surfaces, mapped to existing precedents

| Surface               | Component precedent it extends                                                                                                                                                                                                                                                                                                                                                                 | Data it needs from `mission_get`                                  |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **Topbar pill**       | Byte-identical anatomy to the existing orchestrator/provider pill in `Topbar.vue` (18px height, `1px 7px` padding, `--radius-sm`, tabular-nums) — the one difference is this pill is **clickable** (opens the popover), the orchestrator pill is inert.                                                                                                                                        | `doneCount`, `stepTotal`, a derived `pillTone` (§10.2)            |
| **Popover**           | Reuses the Activity Bell popover shell verbatim (`bg-surface`, `border-2`, `--radius`, `--shadow-pop`, `anim-fade-in-scale`). **400px wide** (Activity Bell is 340px — flagged by the mockup itself as a check-before-approving item, not yet reconciled; ship at 400px, revisit if the operator objects).                                                                                     | Full step array, `declaredEnd`, the `you` line, `openQuestions[]` |
| **Sidebar indicator** | Appended as the last (rightmost) entry in `SidebarFolder.vue`'s existing trailing-chip cluster order: `StopFailure → subagent count → orchestrator crown → teammate count → mission chip`. Two variants: calm (`text-4`, hover-reveal like its neighbors) and flagged (`text-warning` + leading icon, **stays pinned always-visible**, like the StopFailure badge — never hides behind hover). | `doneCount`, `stepTotal`, `needsYou: boolean`                     |

A session with no mission renders **nothing** on any of the three surfaces — `no-mission` is
itself one of the mockup's named states, not an unhandled gap.

### 10.2 State → surface mapping

The pill collapses to **5 looks**, deliberately coarser than the popover's 8 in-mission states
(flagged by the mockup as a simplification the operator should bless, not a settled contract —
Open question F, below):

| Pill tone | Popover states it covers                                                                                           |
| --------- | ------------------------------------------------------------------------------------------------------------------ |
| _(none)_  | `no-mission`                                                                                                       |
| neutral   | `draft`                                                                                                            |
| accent    | `active`, `total-changed` (its `you` line is clear — nothing needs the operator, so it does not read as a warning) |
| warning   | `blocked`, `needs-you`, `stale`, `rescope-pending`                                                                 |
| success   | `delivered`                                                                                                        |

> **Amended 2026-09-29 by Mission v2 (T373) — the counter is done steps, not position.** The pill
> used to read "Step N of M" with N = `stepIndex`, the first open step, so one unproven step hid
> everything after it (a delivery showed "Step 1 of 10" with 8 of 10 verified; `Step 0 of 5` in
> draft with a merged unit). The pill, the popover header and the sidebar chip now all show
> **`{done} of {total} done`** (`mission.pill`, from `doneCount`; the sidebar chip's inline text is
> `{done}/{total}`), and a delivered mission reads "N of N done" with the ✓. `doneCount` counts a
> step as done when its proof is `verified`, or when an `existence` step's derived proof holds;
> `claimed` and `self-verified` are not done. `stepIndex` still exists and still marks the first
> open step — the rail's current dot — but it is no longer the counter, so an unproven fixed start
> keeps the marker while the count moves on. (The spec proposed a new key `mission.pillDone`; the
> shipped code reuses `mission.pill` with new wording — Deviations in the Mission v2 spec.) Tone,
> states and the `you` line are unchanged.

> **Amended 2026-10-01 by Mission v3 (T381) — the counter is position again, and draft is gone.**
> The v2 note above is itself superseded: the pill, the popover header and the sidebar chip read
> the server's headline — "Step N of M", "Steps a–b of M", "Step M of M ✓" — and the header adds
> "N done · V verified" and "· L left behind" (see the decision 8 note at §1.3). The `neutral` tone
> is kept in the anatomy, but no state maps to it (it belonged to `draft`). `needs-you` now covers
> any owed item on the ordered `you` list except the two that have their own look: a staged
> re-scope reads `rescope-pending`, and a requested close reads green **delivered** (not
> needs-you), which is also the `you` block's success look while the server has no close warnings.
> The sidebar chip uses the pill's tone, pinned visible while the operator owes the mission
> something; the amber `flagged` variant is removed.

`pillTone` is therefore a derived signal independent of the `you` line: it means "something on
this step is worth a glance", not "the operator must act" — those are two separate reads on the
same mission, and the popover is where the difference actually shows.

Per-state popover content (verbatim from the mockup, one row of detail per state):

- **`draft`** — header sub-line "Draft — nothing runs until you approve it"; a warning callout
  ("Approving starts the mission — it dispatches nothing by itself"); every step renders as an
  outline/future dot; the declared-end caption on the last step is already visible; `you` line
  clear.

  > **Amended 2026-09-29 by Mission v2 (T373) — the draft copy was false.** Nothing gates
  > dispatch on mission status, and a real delivery ran three worktrees, three sessions and a merge
  > while the popover said "nothing runs until you approve it". The shipped draft is honest about
  > that: the header sub-line reads "Not approved yet — progress is tracked; the end is not agreed"
  > (`mission.sub.draft`); the warning callout reads "Awaiting your approval." + "Approve the
  > declared end below. Work may already be running — approving agrees the end, it does not start
  > anything." and now **shows the declared end** — a "Declared end" label, `kind · target`, then
  > the evidence — above the Approve button, so the operator sees what they are agreeing to. The "current" ring
  > and the pill's neutral tone are unchanged, and the `you` line stays clear (the draft is cued
  > by §8's Amended note, not by the `you` line). **Draft keeps its progress:** `buildMissionModel`
  > no longer zeroes the done steps in draft, so a draft whose first units are already merged and
  > verified shows their real count instead of jumping when the operator approves. The rail still
  > shows no current-step marker in draft (`stepIndex` stays 0 there).

- **`active`** — no sub-line; done steps dim, current step gets an accent dot with a soft ring,
  its `.m-step-label-row` carries verification/proof badges plus a nested child-session row
  (connector icon, live-state dot, monospace branch/session label, "working", an open-link icon);
  `you` line clear.
- **`blocked`** — current step's dot turns warning-colored; an inline warning callout renders
  directly under that step, one line combining decision 12's three fields: `**Blocked** —
{reason}. Unblocks when {unblocks} · {owner}`.
- **`needs-you`** — current step's verification badge reads "Human"; its nested child row shows
  an amber `needs-input` dot (blinking); the `you` line switches to its warning variant: "Approve
  `{session}`'s pending permission request."
- **`stale`** — current step's dot turns warning-colored; an inline warning callout with a clock
  icon: "**Stale** — no evidence in {duration}. Last check: `{command}` showed no new commits."
- **`total-changed`** — header sub-line "Total: {new} steps (was {old}) — {n} added"; the newly
  added step gets an extra "Added" badge plus a caption quoting `addedReason`; `you` line clear.
- **`rescope-pending`** — the last step gets a "Re-scope pending" badge and an inline warning
  callout showing `was:` / `now:` on two lines; the `you` line switches to warning: "Approve the
  new declared end ({summary})."
- **`delivered`** — header sub-line "Delivered — awaiting your close"; the last step's dot is a
  distinct solid-green "done-final" look (never used elsewhere), its badge reads "✓ Proven", its
  caption names the verifying party and evidence; the `you` line switches to its **success**
  variant (green, not warning): "Move the card Review → Done when you're satisfied." This is the
  one example that also populates `openQuestions[]`.

### 10.3 Popover internals

- **Fixed frame.** The mockup does not give "Scope confirmed" any distinct visual treatment from
  a custom step — it renders as a plain step like any other. The **last** step always carries a
  caption with the declared end: `End: {kind} · {target} · evidence: {evidence}` — visible even
  in `draft`, before any work starts, matching decision 5 (the end is declared upfront).
- **Step rail dot vocabulary** (verbatim from the mockup): done = filled dim dot; current = accent
  dot with a soft ring (`box-shadow: 0 0 0 3px var(--color-accent-soft)`); future = outline dot at
  reduced opacity; blocked/stale = warning dot with a soft ring; delivered's last step = solid
  green, no ring. Connecting line: 2px, `--color-border-2`.
- **Verification/proof badges reuse the existing Badge component as-is (design.md §6) — no new
  badge variant proposed by the mockup.** Verification levels shown: "Existence check", "Human"
  (no "Verifier" example appears). Proof states shown: "Claimed" (default/gray) and "Proven"
  (success/green, checkmark). **Gap: the mockup predates `self-verified`** (§1.3's
  `unproven | claimed | verified | self-verified`) and only knows a binary Claimed/Proven look.
  **Interim decision for this delivery:** render `self-verified` with the same badge as
  `claimed` (default/gray, unstyled) — this is actually consistent with decision 8's "never
  renders as proven", since a `self-verified` step is exactly as unproven-to-the-operator as a
  merely claimed one. It does lose the distinction between "the owner said so" and "went through
  `mission_verify_step` but came back unauthenticated-self" — flagged as Open question F for the
  operator to decide whether that distinction is worth a third badge look.
- **Child sessions under a step** reuse the existing session-status dot vocabulary verbatim
  (design.md §6 "Session status") — `working` (green, pulsing), `needs-input` (amber, blinking),
  `idle` (static gray) — no new state, no new color. Rendered as a nested pill: connector icon +
  status dot + monospace session/branch label (truncated) + short meta text + an external-open
  link icon.
- **The `you` line never hides** — it is always rendered, in one of three looks: clear (quiet,
  "Nothing — you're clear."), warning (soft warning background + icon, for something the operator
  must approve or unblock), or success (soft green background + checkmark, for "go close this").
- **Open questions** render only when non-empty: an eyebrow label plus a plain bullet list.

### 10.4 New design.md (root) additions this slice must make

Per CLAUDE.md's UI contract ("if your task needs a token/size/component not in `design.md`, edit
`design.md` first, in the same change"), the mockup flags two additions **not yet in the design
system** — both explicit, neither a surprise:

1. **A new icon.** The pill's leading glyph ("three dots on a rail", meant to read as step
   progress) has no entry in `design.md` §5's icon table — it was hand-drawn for the mockup, not
   a real Lucide name. Candidates the mockup suggests: `list-checks` or `route`. Whichever is
   picked becomes a new §5 row.
2. **A new component family.** The step-rail itself has no existing vertical-progress precedent
   in `design.md` — it needs a new §6 subsection, `### Mission progress (pill, popover, sidebar
indicator)`, documenting the pill/popover/rail/badges/`you`-line/open-questions vocabulary
   above once implemented. Everything else the mockup uses (the popover shell, the Badge
   component, the session-status dots, the sidebar chip cluster) is already documented — no
   further additions.

This design doc does not make these root `design.md` edits itself (out of scope for T361 —
product code and `design.md` edits belong to the implementation slice); §10.4 exists so Slice S9
has a checklist instead of having to re-derive it from the mockup. A new Open question (F, §13)
covers the two simplifications the mockup itself flags as not yet operator-confirmed.

## 11. Skill migration (decision 18)

- **`mission`** — `/mission set` becomes `mission_create`/`mission_set_end`; the per-tick manual
  `get_fleet` + `get_approval` + board read (today's step 2) is replaced by one `mission_get`
  call, since that IS the derived-signal projection (§7). `/mission done` becomes
  `mission_request_close`.
- **`status`** — the four-source hand-assembly (goal file + board + `gh` + `get_fleet`) collapses
  to `mission_list` + `mission_get` per active mission; the verdict/bar-glyph logic moves from
  "re-derived every call" to reading `Mission`'s already-computed fields.
- **`orchestrate-delivery`** — its informal "no new evidence across 3 consecutive ticks" stall
  rule is retired in favor of §8's deterministic field; its 3-layer heartbeat workaround
  (SendMessage subscription + loop + Scheduler watchdog) stays, since that solves a different
  problem (getting woken up at all), not state tracking.
- **`delivery-watchdog`** — reads `mission.status == 'stale'` and `Blocker`s directly instead of
  its 4 hand-coded "parked shape" checks; its `## Watchdog` card-block dedup convention retires
  in favor of the mission's own state.
- **`delivery-verifier`** — gains the per-kind rubrics (§6); otherwise unchanged in spirit, now
  fed by `mission_verify_step`.
- **Bundled roster.** Confirmed today's bundled set: `conductor`, `delivery-verifier`,
  `delivery-watchdog`, `mission`, `orchestrate-delivery`, `read-aloud`, `status` (via
  `resources/skills/skills/`). `report-back` and `draft-to-prompt` are **not** currently bundled
  (they live as personal skills today, confirmed absent from both `resources/skills/skills/` and
  the checked personal skill locations) — decision 18 promotes both to bundled Capy skills as
  part of this delivery. `docs/user/bundled-skills.md` gets one new table row per newly-bundled
  or newly-`mission`-aware skill (its existing convention: skill name, one-line description
  pulled from the skill's own frontmatter, optional prose subsection for skills needing more
  explanation) — no structural change to that doc's format.
- **Personal `mission`/`status` retirement** — once the bundled `capy:mission`/`capy:status`
  fully cover the personal copies' behavior (confirmed both are already loaded side-by-side in
  the same session today per the smoke report — "live evidence for decision 18"), the personal
  copies are deleted from wherever they're defined outside this repo; that deletion is an
  operator action, not something this delivery's PRs can do (out of repo).

## 12. Eval harness (decision 19)

No existing precedent for this vocabulary anywhere in the repo (`docs/plans/**`, `docs/lessons/
**`, ADRs — confirmed zero hits for "eval harness"/"shadow phase"/"contract eval" before this
document). Four layers, each gating a different part of the merge:

1. **Contract eval.** Every `mission_*` verb's `inputSchema` + ACK shape, checked the same way
   `claude plugin eval`'s `file_exists`/tool-use graders check any verb today — confirms the
   catalog entry matches this design doc's table (§4), nothing more. Cheapest layer, runs on
   every PR.
2. **Migration eval.** Runs `mission_import_legacy` against the real 55-file corpus snapshot
   (copied into a fixture, not read live from `.capy/goals/` — that corpus is real operator
   data). Pass condition: raw body preserved byte-for-byte **and** every field the smoke report
   already confirmed as "standard-shaped" (31/55 files) extracts cleanly. This is the layer that
   directly closes smoke report Q7.
3. **Behavior eval.** `claude plugin eval` alone cannot do this (smoke report Q5 — no ad-hoc MCP
   config, no custom-script graders, no old-vs-new A/B). Build a thin custom harness: `claude -p`
   headless against a throwaway repo with a real Capy instance, scripted through a handful of
   `mission_*` calls, graded by reading the resulting `.capy/missions/*.md` file directly (state
   assertions), not by an LLM grader. This is new infrastructure this delivery must build, not
   reuse.
4. **Shadow phase.** For one release cycle, the `mission` skill writes **both** the legacy
   markdown goal file and the new structured `Mission` record in parallel; a divergence checker
   (part of the behavior-eval harness) flags any tick where the two disagree on state a human
   would notice (declared end, current step, blockers). Retiring the legacy markdown path (and
   the personal `mission`/`status` skills, §11) is gated on zero divergences over that window —
   this is the "shadow…gates retiring the markdown" half of decision 19.

> **Amended 2026-10-01 by Mission v3 (T381) — the shadow phase is retired (T371 closed).** The
> dual-write is gone: Mission v3 (spec §3.11) removed the `mission` skill's mirror into the legacy
> goal file, the `shadow-dual-write` eval scenario, `divergence-checker.mjs` and its test, the
> `{ shadow }` assertion and `npm run eval:shadow`, and dropped the "Scope confirmed first" rule
> the checker enforced. The `mission` skill writes the structured Mission only; a legacy
> `.capy/goals/*.md` file is read once, by `mission_import_legacy`, which still never modifies or
> deletes it. Layers 1–3 stay: the contract eval, the migration eval and
> the behavior eval, whose scenarios were rewritten for v3 (a mission is born `active`, scope is an
> attachment, and a new `signoff-as-check` scenario). The §9 sentence that leaves the legacy file in
> place "until the shadow phase proves the new record" no longer waits on anything.

## 13. Open questions

### Resolved 2026-09-26 (project memory, decisions page, "Mission progress: enforcement posture + T361 open questions A–D resolved")

- **A — self-verification enforcement = convention + audit, not a security check.** Capy's MCP
  transport has no per-session identity at all — one shared config and bearer token serve every
  session (`src/main/mcp/server.ts`'s `configPath()`; `docs/capy-features.md` states this
  plainly: "Capy's transport has no per-session identity, so it cannot tell who is calling"). The
  operator's resolution: `mission_verify_step` never refuses. A `verifier`-level step requires at
  least one linked `session` and a verifying id that differs from every one of them to reach
  `proof: 'verified'`; otherwise it lands on `proof: 'self-verified'`, which the UI never renders
  as "proven" (§1.3, §4). Per-session MCP identity (a real token per spawn, which would make this
  checkable rather than merely auditable) was considered and **rejected for v1** — recorded as a
  rejected alternative in ADR-0015.
- **B — hibernation exemption ships early, in the base plumbing.** Not a fast-follow. It was the
  only hard "no" in the T360 smoke test, then observed live (T356's orchestrator parked
  mid-mission and its report went astray). The plan reorders the stack so this is Slice S2,
  directly after S1 — see the plan's Slice S2.
- **C — `plan_mission` naming: documented, not renamed.** Confirms §2's original resolution; no
  change.
- **D — nesting stays a convention in v1, with one addition: the UI flags a linked child that
  also owns a mission.** Decision 13 ("one nesting level; a linked child owns no mission of its
  own") is not structurally enforced — any enforcement would hit the same self-declared-id limit
  as A, since "is this session already linked as someone else's child" is itself a check against
  an unauthenticated id. Instead, `mission_get`'s projection (§7) surfaces when a linked `session`
  StepLink is itself the owner of another `Mission`, and the popover renders that as a flag for
  the operator to notice — detection, not prevention.

### Still open

- **E — should a manifest-dispatched child call `mission_*` verbs directly, and what does it do
  when its owner is unreachable?** Decision 11 (children report via native SendMessage) stands
  — the operator did not reopen it — but it was written assuming the `agentControlled` spawn
  shape. §7.1's correction: a manifest/board-dispatched child (`spawnedBy: 'agent'`) keeps full
  Capy MCP access, including every `mission_*` verb, and could call `mission_link_child`/
  `mission_log` on its own step directly instead of relying on SendMessage plus its owner. Two
  questions remain bundled here, both undecided:
  1. Keep decision 11's SendMessage-only pattern uniform across both spawn shapes for simplicity,
     or let a manifest-dispatched child report directly since it already has the access?
  2. **New from live incidents (T360's last three appends, BUG-144).** A child must address its
     owner by the owner's stable session id, resolved to the owner's _current_ native
     `SendMessage` name at send time (names change across park/resume) — that part is settled and
     belongs in the skill-migration slice's instructions, not here. What is **not** decided: what
     a child does when no name resolves at all (owner parked with no resume in sight, or gone). It
     must never broadcast its report to unrelated peers just because the intended recipient is
     unreachable — but the actual fallback (queue, drop with a local note, retry on a timer) is
     left to the operator to decide.
- **F — added 2026-09-26 from the T359 mockup's own flagged simplifications (§10.2, §10.3).**
  **F.1 resolved 2026-09-28: the operator accepted the 5-tone pill; S9 ships it.** F.2 (a third
  badge look for `self-verified`) is still open — S9 ships the interim "same as Claimed" look.
  Neither is answered by the operator as far as either `spec.html`/`review.html` records (both
  still carry `status: draft` internally, despite being relayed as approved):
  1. Is the Topbar pill's 5-look collapse (vs. the popover's 8 in-mission states) the right
     simplification, or should more states get their own pill color?
  2. Is folding `self-verified` into the same badge look as `claimed` (§1.3's interim decision,
     since the mockup predates `self-verified` and only has a Claimed/Proven binary) acceptable,
     or does "went through `mission_verify_step` but came back unauthenticated-self" deserve a
     third, visually distinct badge?
     Both are small, localized changes either way (one more pill-tone case, one more badge look) —
     Slice S9 ships the mockup's defaults and this question can be answered after the fact without
     reopening the rest of the UI contract.
