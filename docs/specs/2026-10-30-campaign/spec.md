# Campaign — a quest line above the Mission

_Draft spec, 2026-10-30. Written by the orchestrator from the exploration (`.harnu/out/mission-campaign-exploration.md`), four research reports, one 93-hour real orchestration transcript (scrubbed) and the approved mockup v6 (`.harnu/out/mockups/2026-10-30-mission-campaign/`, screens `v6--*`). An executor lands this file in `docs/specs/2026-10-30-campaign/spec.md` and the mockup in `docs/design/2026-10-30-mission-campaign/` as the first unit of chapter 4._

## 1. Problem

A Mission is one quest: one declared end, a flat list of required, roughly sequential steps (1 step = 1 PR). A real delivery needed five missions opened by hand, grew to a 110-row plan, spawned 26 worktrees and 73 sessions, and produced at least eight unplanned detours that had nowhere to live. The pill read "Step 1 of 4" while the operator asked the orchestrator to hand-draw a twelve-box campaign on a canvas to know where he was. Nothing a mission learns reaches project memory; "done" is asserted by executors, not proven by facts; the human is the only merge gate and the only relay between sessions.

Measured on the transcript, ranked by human time: single merge gate (~25 PRs one by one); wrong step order doubling work; stacked PRs breaking; red CI and red `main` invisible to the heartbeat; an artifact-quality miss (54 MB of images) costing a new mission; 22 model turns spent on duplicate notices; state re-derived after compaction (`gh pr view` ×120); the human pasting transcripts between sessions.

## 2. Goals

- G1 The operator sees the whole delivery at a glance: "Chapter 9 of 12 · Step 2 of 4", what is done, what is locked, what is a side quest, what waits on them, in one pill, one popover and one map (the approved mockup v6).
- G2 A step is proven done by **facts** Harnu derives (PR merged, CI green on PR, `main` green after merge, verifier verdict, checks ticked), never by a report.
- G3 Detours become first-class **side quests** with a known origin; they never read as "left behind" and never count in the headline.
- G4 The orchestrator never re-derives dispatch state: Harnu writes the **ledger** and re-injects a **Mission Brief** after compaction.
- G5 A finished mission **feeds project memory** through an approved consolidation pass, and a new mission **recalls** the memory that matches its scope.
- G6 The human's lane is one ranked list, aged by risk, with the **batch merge** door as its most common action.
- G7 A headless, mission-bound **Steward** does the between-events work (rebase after merge, dispatch the verifier, nudge a stall, dedupe notices) inside a closed allowlist and never crosses the three doors.
- G8 Every delivery skill (`orchestrate-delivery`, `mission`, `delivery-verifier`, `delivery-watchdog`, `status`, `report-back`) produces and consumes this structure, so the UI is never cosmetic.

**Non-goals:** nesting chapters inside one mission file (Mission v3 stays one rule, one pill, one door); per-session MCP identity; any verb that merges or closes on its own; model-routing changes.

**Anti-goals:** a plan the agent can silently shrink (append-only structure for agents); memory written from transcripts; a steward with `act`-level power.

## 3. Data model

### 3.1 Campaign (`src/main/campaign-core.ts`, mirrors `mission-core.ts`)

```ts
interface Campaign {
  id: string; slug: string; folder: string
  owner: { sessionId: string; folder: string }
  title: string
  declaredEnd: DeclaredEnd                   // same shape as Mission
  chapters: Chapter[]                        // ordered; a chapter IS a mission
  status: 'active' | 'delivered' | 'closed'
  closedAs?: 'delivered' | 'discarded'; closeReason?: string
  outcome?: Outcome                          // §3.6, written at close
  scope?: StepLink[]
  createdAt: string; updatedAt: string; provenance: {...}
}
interface Chapter {
  id: string; ordinal: number; title: string
  missionId?: string                         // bound when the chapter's mission is created
  required: boolean                          // false = side-quest chapter
  discoveredFrom?: { chapterId: string; stepId?: string }
  unlocks?: { kind: 'decision' | 'chapter' | 'pr'; ref: string }  // locked-until-ready
  produces?: string[]; consumes?: string[]   // §3.5 prerequisite pass
  radiant?: { template: string; total: number }  // "migrate page {slug}" × 88
}
```

Stored as `.harnu/campaigns/<id>-<slug>.md` in the main checkout, shared by every worktree. `derived.progress` for a campaign counts **chapters**: `{ total, current, done, inReview, running, locked, side: { total, done, open }, radiant?: { done, total } }`. The headline is "Chapter N of M"; the pill adds the current chapter's mission headline ("· Step 2/4").

### 3.2 Mission additions (`mission-core.ts`)

- `MissionStep.required?: boolean` (default `true`). A `required: false` step is excluded from `progress.total`, from `current`, from `leftBehind`, and rendered in the Side bucket.
- `MissionStep.discoveredFrom?: { stepId: string }`.
- `MissionStep.edges?: { kind: 'blocks' | 'validates' | 'related'; to: string }[]` (typed edges; `blocks` is the only one progress reads: a step with an open `blocks` edge into it is `locked`).
- `MissionStep.decision?: { title: string; options: string[]; chosen?: string; chosenAt?: string; blocks: string[] }` — a decision node; choosing is an operator door and writes a `decision` log entry (§3.6).
- `MissionStep.gates` is **derived, never stored**: `{ pr: GateState; ci: GateState; main: GateState; verifier: GateState; checks: GateState }`, `GateState = 'green' | 'red' | 'running' | 'off' | 'na'`. Sticky like proof (a resolved green never downgrades on an unreachable GitHub; `stale: true` instead). A step reads `verified` only when every applicable gate is green.
- `Mission.campaignId?: string`, `Mission.chapterId?: string`.
- `Mission.ledger: LedgerRow[]` — **written by Harnu**, never by a verb: `{ at, unit?: stepId, sessionId?, worktree?, branch?, pr?, event: 'dispatched' | 'worktree' | 'pr-opened' | 'pr-merged' | 'ci' | 'verified' | 'session-died' | 'compaction', detail? }`. Sources: `create_session`, `create_worktree`, `submit_manifest`, PR resolution, the session projection, the PreCompact hook.
- `Mission.log` entries gain `kind: 'note' | 'decision' | 'surprise' | 'steward'`.
- `Mission.outcome?: Outcome` (§3.6).

### 3.3 Verbs

New: `campaign_create { folder, title, declaredEnd, sessionId, chapters: [{ title, required?, consumes?, produces?, radiant? }], scope? }`, `campaign_add_chapter`, `campaign_get`, `campaign_list`, `campaign_request_close`. `mission_create` gains `campaignId`/`chapterId`; `mission_add_step` gains `required`, `discoveredFrom`, `edges`, `decision`; `mission_log` gains `kind`. **No verb merges, chooses a decision, ticks a check or closes**: those stay operator doors (§4).

### 3.4 Steward (Scheduler)

A third worker mode, `steward`, between `observe` and `act`: allowlist = `Read`, `Grep`, `Glob`, `Skill`, `mission_*`, `campaign_get`, `message_session`, `notify`, `create_session` (verifier sessions only, enforced by a `role: 'verifier'` argument), and one new verb `rebase_stack { folder, missionId, onto }` that runs `git rebase --onto` in the step's worktree and refuses on conflicts (`REBASE_CONFLICT`, the step gets a blocker). Created by Harnu when a mission is created (`steward: true` on `mission_create`, default on), one per mission, deleted at close. Wakes on events (ledger row appended, CI state change, child idle, blocker cleared) with a 20-minute fallback. Every action is a `steward` log entry.

**A steward is a system worker, not a user worker (operator decision, 2026-10-30).** It is a separate category in the Scheduler: listed under its own "Stewards" section, read-only (no enable/disable toggle, no delete, no prompt edit), its lifecycle bound to the mission. `list_workers` returns it with `category: 'steward'` and `agentControllable: false`; `update_worker` / `delete_worker` refuse it (`WORKER_IS_STEWARD`). Pausing is a **mission door**, not a worker switch: "Pause steward…" in the mission popover takes a mandatory reason, writes a `steward` log entry, turns the pill warning and puts "Steward paused {age}: {reason}" on the `you` list until resumed. The global kill-switches still apply exactly as to every agent: "Allow agents to act", a blocked folder and `SERVER_DISABLED` stop the steward too; what the category prevents is a mission's guarantees vanishing through one unnoticed toggle.

### 3.5 Prerequisite pass

At `campaign_create` and `campaign_add_chapter`, Harnu checks `consumes` against `produces` of earlier chapters; a chapter that consumes something no earlier chapter produces is refused `PREREQ_MISSING` (naming the token) unless `force: true`, which logs a `surprise`. Tokens are free strings agreed by the skill ("images-on-cdn", "page-templates", "aws-credentials").

### 3.6 Outcome and memory

```ts
interface Outcome {
  declaredEnd: DeclaredEnd
  actualEnd: string
  deviations: string[]
  blockers: { reason; resolution }[]
  verificationGaps: string[]
  surprises: string[]
  perStep: { stepId; openedAt; mergedAt?; commits?; reverifications? }[]
  nothingNotable?: true
}
```

On `mission_request_close` (and `campaign_request_close`) Harnu spawns a **consolidator** (observe-mode worker, one tick) over the structured record + linked PRs/commits (never the transcript). It drafts: `decisions.md` entries (`mission:<id>`, `valid_from`, `supersedes?`), a refreshed `hot.md` within its cap, lesson candidates each citing a step/PR/commit, and the `outcome`. Drafts appear in the end dialog under "Also record"; the operator ticks what to write; `memory_append` gains `supersedes` and `provenance.mission`. Nothing is written without a tick.

**Recall:** at `mission_create`/`campaign_create`, Harnu matches memory entries whose `watches` paths or topics overlap `scope` and the chapter titles, and lists them in the ACK (`recall: [{ page, line, text }]`) and in the Mission Brief.

### 3.7 Hooks

Harnu installs three hooks in the folder's `.claude/settings.local.json` when a mission with a steward is created and removes them at close: `SessionStart` (`source=compact`) → prints the Mission Brief (≤1.5k tokens: declared end, step table with gates, ledger tail, open blockers, last 5 decisions, recall); `PreCompact` → appends a `compaction` ledger row and nudges the owner to `mission_log` unlogged state (never blocks); `Stop`/`SubagentStop` on child sessions → progress token that wakes the steward. The ledger itself needs no hook.

## 4. Operator doors (unchanged in kind, extended in surface)

Approve re-scope · End mission / campaign · Mark verified / Unmark · Add / tick / delete check · **Choose decision** (new) · **Merge batch** (new: the operator confirms "merge #305 → #306 → #308 in order"; Harnu merges one, lets the steward rebase and re-check gates, stops on any red, asks again) · **Record memory** (new, in the end dialog). No verb reaches any of them.

## 5. UI (the approved mockup v6)

- **Pill** (`MissionPill.vue`): "Ch. 9/12 · Step 2/4"; warning adds "· n for you"; green "Ch. 12/12 ✓". A session owning a mission with no campaign keeps today's pill.
- **Campaign popover** (`CampaignPopover.vue`, `.pop--wide` 520px): Main quest / Side quests / Locked on the left, the open chapter's objectives with gates on the right, You lane + Steward line, footer "End campaign…" / "Open map".
- **Chapter popover** (`MissionPopover.vue` extended): gates per step, decision node, Side bucket, Steward line, back to campaign.
- **Campaign map** (`CampaignMap.vue`, takeover): dependency board with arrows, side quests docked under their origin, locked tiles, "You are here", declared end + radiant counter in the header; right column You ledger, Steward feed, side quests; `chapter-focus` shows the chapter's steps.
- `design.md` §6 gains "Campaign progress" with the tokens already used (no new values; `.pop--wide` 520px is the one new width, to be declared in §4).

## 6. Skills contract (chapter 3 and 5 deliverables)

| Skill                  | Must now                                                                                                                                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orchestrate-delivery` | Phase 1 declares the campaign with chapters and `consumes`/`produces`; details only the next chapter to steps (rolling wave); a detour is `mission_add_step { required: false, discoveredFrom }`; every unit gets frozen, ID'd acceptance criteria before dispatch. |
| `mission` (tick)       | Reads gates and ledger instead of `gh`/`get_fleet`; on a red gate opens a side step; escalates to the You lane with age and risk; never claims a verdict.                                                                                                           |
| `delivery-verifier`    | Re-runs the named checks at the PR head in a clean worktree; records the verdict that closes the `verifier` gate; produces the evidence bundle linked on the step.                                                                                                  |
| `delivery-watchdog`    | Becomes the steward tick (steward mode); keeps the read-only sweep as a fallback for repos without a steward.                                                                                                                                                       |
| `status`               | Renders the campaign headline and the first You item from the same derived model as the pill.                                                                                                                                                                       |
| `report-back`          | Reads `outcome` and the ledger for the rail; links the campaign map.                                                                                                                                                                                                |

## 7. Chapters (this delivery, dogfooded as a campaign)

| #   | Chapter                                     | Consumes → produces                  | Steps (1 = 1 PR)                                                                                                                                                                                                                 |
| --- | ------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Gates from facts + Harnu-written ledger** | — → `gates`, `ledger`                | 1a derived gates in `mission-pulse.ts` + sticky cache; 1b ledger rows from `create_session`/`create_worktree`/`submit_manifest`/PR resolution/session death; 1c popover shows gates + ledger tail; 1d notice coalescing per unit |
| 2   | **Side steps, typed edges, decision nodes** | `gates` → `side-steps`               | 2a schema + progress rule (`required`, `discoveredFrom`, `edges`, `locked`); 2b decision node + Choose door; 2c Side bucket + decision UI in `MissionPopover`                                                                    |
| 3   | **Campaign record, verbs, skills**          | `side-steps` → `campaign`            | 3a `campaign-core.ts` + verbs + prerequisite pass; 3b `orchestrate-delivery` / `mission` / `status` / `report-back` rewritten to the contract; 3c eval scenarios                                                                 |
| 4   | **UI: pill, popovers, map**                 | `campaign` → `campaign-ui`           | 4a land spec + mockup in `docs/`; 4b pill + `CampaignPopover`; 4c `CampaignMap` takeover; 4d `design.md`, i18n parity, user docs                                                                                                 |
| 5   | **Steward**                                 | `ledger`, `campaign` → `steward`     | 5a `steward` mode allowlist + `rebase_stack`; 5b event wake-ups + three hooks installed/removed by Harnu; 5c `delivery-watchdog` → steward tick; 5d Merge batch door                                                             |
| 6   | **Close-out → memory, recall**              | `campaign`, `ledger` → `memory-loop` | 6a `outcome` + consolidator worker; 6b end dialog "Also record" + `memory_append supersedes`; 6c recall at create + in the Brief; 6d `delivery-verifier` evidence bundle                                                         |

Chapters 1 and 2 are detailed to steps now; 3–6 keep the step list coarse until chapter 2 verifies (rolling wave). Each chapter is one Mission owned by one executor session in its own worktree; the orchestrator owns the campaign.

## 8. Acceptance criteria (campaign level)

| AC   | Statement                                                                                                                                                                             | Proof                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| AC-1 | A step with PR merged, CI green, `main` green and a verifier verdict reads `verified` with no verb call; a red `main` after merge downgrades nothing stored but lands a `you` item    | test + fixture missions |
| AC-2 | A `required: false` step never changes the headline, never appears in `leftBehind`, and renders in the Side bucket with its origin                                                    | test                    |
| AC-3 | After a forced compaction, the owner session's first turn contains the Mission Brief and makes zero `gh pr view` / `get_fleet` calls to re-derive dispatch state                      | eval (transcript grep)  |
| AC-4 | `orchestrate-delivery` on a 3-chapter objective produces one campaign, one mission for chapter 1 with steps, chapters 2–3 coarse, and refuses a plan that consumes before it produces | eval                    |
| AC-5 | The steward rebases the stack after a merge, dispatches the verifier on PR-ready, nudges a stalled child, and is refused any verb outside its allowlist                               | test + live smoke       |
| AC-6 | Closing a mission offers memory drafts, each citing a step/PR/commit; nothing is written without a tick; `memory_query` shows a superseded decision with its successor                | test + visual           |
| AC-7 | Pill, campaign popover, chapter popover and map match mockup v6 per `mockup-qa`; design.md, i18n parity, CHANGELOG, harnu-features marker, user docs updated                          | gates                   |
| AC-8 | The whole delivery is itself tracked as a campaign and closes through its own end dialog with an `outcome`                                                                            | the record              |

## 9. Open decisions

1. Steward per mission (recommended: closed scope, dies at close) or per repo (one, like the watchdog).
2. Whether `rebase_stack` may run on an operator-created worktree or only on ones Harnu created.
3. Memory draft granularity: one decision per `decision` log entry, or the consolidator may merge several.

## Amendments

| date       | kind      | what changed                                                                                                                                                                                                                                                                                                                             | by   |
| ---------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 2026-10-31 | amendment | §6, `orchestrate-delivery` row: "every unit gets frozen, ID'd acceptance criteria before dispatch" is now carried out by `harnu:spec` (triage, authoring, `check`) and Phase 2's derive, per `docs/specs/2026-11-harnu-spec/spec.md`. The mission is born at triage and Phase 1 adopts it; this section keeps the rest of §6 as written. | T605 |
