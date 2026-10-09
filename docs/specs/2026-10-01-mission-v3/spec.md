# Mission v3 — know where it is

- **Date:** 2026-10-01 · **Revision:** 2 (after adversarial review — §10)
- **Status:** implemented (2026-10-01) — S1 #396, S2 #397, S3 #401, S4 #402, S5 #403 (this change; stacked S5 → #402 → #401 → #397 → #396 → `main`). Deviations from this spec: §11. Client identifiers are scrubbed to the neutral vocabulary (CLAUDE.md "Client confidentiality"); every number and shape is kept.
- **Amends:** the T358 design (decisions 4, 8, 14, §8 and the shadow phase), the Mission v2 spec (superseded in part: §3.1, §3.2, §3.4's draft cue, §3.5) and ADR-0015 (approval model, checks trust model) carry dated notes pointing here.
- **Parents:** T373 (Mission v2, merged #390–#394) · T358 (Mission progress).
- **Evidence:**
  - `.capy/out/mission-monitor/findings.md` ("notes for Mission v3", V3-1…V3-18)
  - `.capy/out/t373-mission-v2/reavaliacao-mission.md`
  - the smoke tests in §8, run against the 13 real missions on this machine
  - the canvas `.capy/out/canvas/mission-v3.capycanvas.json`
- **Operator decisions (2026-09-30 / 10-01):**
  1. The counter shows position.
  2. Remove draft/approve.
  3. Scope becomes an attachment.
  4. Close is always available to the operator.
  5. Archive or discard dead missions.
  6. HITL checkboxes per step.

## 1. Problem

The feature exists so the operator can look at the Topbar and know four things without asking: **where it is, what is done, what is left, and what is waiting on me**. Today it answers none of them reliably.

- **The counter counts proof, not position.** "Done" means `verified`, and verification lands at the end of each slice, so the pill always trails the work. In the proj FAQ section mission the PR was being opened (step 8 of 10) while the pill read "2 of 10 done" with the "current" marker on step 1 (V3-1).
- **The fixed start "Scope confirmed" is the step left undone in 12 of 13 real missions** (smoke S-1). Its spec lives on a feature branch, not on the main checkout's disk. Every delivered mission reads "5 of 6 done" next to "Delivered" and a green ✓ (V3-2, V3-9, V3-15).
- **Draft/approve gates nothing.** Work runs regardless. It still blocks the close of finished work (V3-10), nags forever about dead missions (V3-3), and duplicates the end agreement the skill already makes in chat.
- **Dead missions cannot be removed** (V3-4).
- **Proof flaps with GitHub reachability.** The same mission (tools listing) read "waiting" in one run and "verified" in the next, minutes apart, because one read could not reach GitHub (V3-11, smoke S-1 runs 2 and 3).
- **Progress is recounted in three places,** so the pill and the status card disagreed at the same moment (V3-12, V3-17).
- **Close takes up to ~90 s to dismiss its own dialog.** Each mission derive costs 3.5–11 s and `mission:list` derives open missions one after another (V3-16, smoke S-4).
- **There is no place for "I checked it by hand"** (DSQA done, validated visually). Verifier `needs-human` items exist only in report prose, and the step stays `unproven` forever (V3-8).
- **The owner optimizes the proof label instead of the evidence** (V3-5).
- **Smaller defects:**
  - unprovable existence steps get no warning (V3-6);
  - one executor is split across 5 steps (V3-7);
  - the status card repeats its lines (V3-13);
  - skill wording lags the UI (V3-14);
  - the sidebar chip shows amber while the pill shows green (V3-15);
  - the child "open session" icon fails silently (V3-18).

## 2. Goals

- **G1.** One headline, "Step N of M", that says **where the work is now**. The same N drives the pill and the "current" marker.
- **G2.** The popover answers done / running / waiting / left / blocked / owed-by-you at a glance. Proof is a visible detail, never the headline.
- **G3.** One server-side computation of progress, read by the pill, the sidebar chip, MCP `mission_get` and `mission_list`, and every skill.
- **G4.** No ceremony between finished work and closing it. The operator can close or discard any mission at any time, with the facts shown, and the UI reflects the change immediately.
- **G5.** Human checks are first-class. They are created by the agent, the operator or a verifier, ticked only by the operator, and they surface when due.
- **G6.** Reads are fast and stable. A mission never changes state because GitHub was unreachable, and the popover and doors respond in under 2 s.

**Non-goals:** gating dispatch; per-session MCP identity; changing the stall formula.

## 3. Design

### 3.1 Progress model — one rule, server-side (V3-1, V3-12, V3-17; review M1, M2)

`mission_get` and the IPC `mission:list` return `derived.progress`, computed once in the main process.

```ts
interface MissionProgress {
  total: number // steps, excluding a legacy fixed start (§3.3)
  current: { from: number; to: number } | null // 1-based; from === to unless several steps run in parallel; null = all done
  allDone: boolean
  done: number // verified + done
  verified: number
  states: Record<string, StepState>
  leftBehind: string[] // step ids (see rule)
  unprovable: string[] // §3.10
  computedAt: string
}
type StepState = 'verified' | 'done' | 'running' | 'waiting' | 'blocked' | 'todo'
```

**Step state**, first match wins:

| State      | When                                                                                                                                                                        |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verified` | Proof `verified`; or an existence step proven (with sticky resolution, §3.8); or a `human` step the operator ticked.                                                        |
| `done`     | Proof `claimed`; or `self-verified` with verdict `met`; or a verification with verdict `needs-human`, whose machine part is met and whose human part became a check (§3.7). |
| `running`  | A linked child session other than the owner has `taskState === 'working'`.                                                                                                  |
| `blocked`  | The step has an open blocker.                                                                                                                                               |
| `waiting`  | A builder session is linked but is not working, and the step is not graded yet. This is "finished, awaiting verification" or "parked".                                      |
| `todo`     | Anything else.                                                                                                                                                              |

**Current step:**

- The running steps, if any. Several running steps give a range: "Steps 4–7 of 9".
- Otherwise, the first step after the last `done`/`verified` step that is not itself done.
- If every step after the last done one is done but earlier ones are open, the current step is the last step, with no ✓.
- Blocked steps never advance the current step.

**Headline:**

- "Step N of M" with N = `current.from`.
- "Steps a–b of M" when several steps run in parallel.
- "Step M of M ✓" only when `allDone`.

**Left behind** = `todo` steps before the last done step. Two kinds of step are excluded:

- a step with a linked builder session (it is `waiting`, not abandoned);
- a step added after the later step was reached. This needs a new `addedAt` field; legacy steps without it count as original.

**Consumers:** the renderer (`mission-view.ts`), the sidebar chip, the `status`, `mission` and `delivery-watchdog` skills, and MCP `mission_list` (§3.11) render this object. None of them recounts.

### 3.2 What the operator sees (V3-1, V3-9, V3-15, V3-18; review M5, M7)

**The pill** reads "Step N of M", per §3.1. Its tone comes from the existing state table, plus `needs-you` whenever the `you` list (§3.12) is non-empty. The **sidebar chip uses the same tone** as the pill; the separate amber `flagged` variant is removed.

**The popover header** reads "N done · V verified", then "· L left behind" when L > 0, then the scope links (§3.3).

**Each step** shows one of seven visuals:

| Visual    | Meaning     |
| --------- | ----------- |
| ✓ filled  | verified    |
| ✓ hollow  | done        |
| ● pulsing | running     |
| ◐         | waiting     |
| ⚠         | blocked     |
| ○         | todo        |
| ↩         | left behind |

Proof badges and checks render on the step (§3.7).

**Children:**

- A session row appears once, on the step where it is running or, if none, on its last linked step.
- Other steps it links show "+1 session".
- The row action becomes an in-app "go to session" icon, replacing `ExternalLink`.
- When the renderer cannot resolve the session, the action shows a toast ("session not loaded yet") instead of doing nothing.

**Doors return the new view.** Every operator door IPC (close, discard, tick, re-scope, add check) returns that one mission's re-derived view. The store patches or removes it immediately:

- close and discard remove the mission from `views` at once;
- ticks update in place.

The background full refresh still runs, but nothing waits on it.

### 3.3 Scope is an attachment, not a step (V3-2)

- `mission_create { scope }` stores the paths as `mission.scope: StepLink[]`, under the BUG-145 containment rules, and creates **no fixed-start step**.
- `mission_link_child { scope: true, link }` adds scope after creation; `stepId` is omitted for scope links.
- Scope never enters progress. The popover header lists it, and an unresolved path reads "on a branch".
- **Legacy files** keep their fixed-start step on disk. `parseMissionFile` exposes its links as `scope` and drops the step from progress and from the UI rail. No file rewrite is needed.
- **The end step** is always found by `kind: 'fixed-end'`, never by id. New missions number their steps from `stp-1`.

### 3.4 No draft (V3-3, V3-10; review M3, M8, minor)

**Creation:**

- `mission_create` writes `status: 'active'` and stamps `declaredEndApproval: { at, bodyHash, via: 'chat' }`. The schema gains `via`.
- `mission_create` takes an optional `steps: { title, verification }[]`, so the plan is declared in one call.

**Legacy drafts:**

- `parseMissionFile` normalizes a legacy `draft` to `active`, so the hibernation exemption (`hibernation.ts`), the stall rule and every reader see it as active. The next write persists `active`.
- `draft` stays in the zod enum so old files still parse.
- A dead legacy draft therefore reads `active` and immediately `stale`. It produces **no cue**: stale is not an owed kind. The watchdog's two-hour recency rule keeps it quiet. The operator discards it (§3.6).

**`REASON_REQUIRED`** keys on **started** instead of on `status !== 'draft'`. A mission is started once any step has a child link or a proof. Planning steps added before that need no reason and carry no `addedReason`, so the "total changed" state appears only for real growth.

**Removed:**

- the Approve door and the approval callout;
- draft in `missionState`, in `owedKey` (`mission-cue.ts`) and in the `flagged` chip;
- `MISSION_DRAFT`;
- the draft i18n copy.

**Kept:** the re-scope approval.

**`mission_import_legacy` (S7)** writes the v3 shape: `active`, no fixed frame, and the legacy scope as `scope`. Its placeholder end, which carries `legacy.needsReview: ['declaredEnd']`, adds an item to the `you` list ("review the imported end") until the operator approves a re-scope.

### 3.5 Close and discard — one operator door (V3-4, V3-9, V3-16; review M7, minor)

**The door:** the operator can end **any non-closed mission** from the popover through a single dialog with a choice: **Close as delivered** or **Discard**, plus an optional reason.

- The mission becomes `status: 'closed'`, with `closedAs: 'delivered' | 'discarded'`.
- A log entry records the choice.
- The mission leaves the Topbar and the sidebar. The file stays on disk as the record.

**What the dialog shows:** the server returns `closeWarnings[]`, replacing `closeRefusal` in the IPC view and computed in one place:

- end not verified;
- left-behind steps;
- unticked checks;
- open blockers;
- a staged re-scope.

These are warnings, never refusals.

**Dismissal:** the dialog closes when the door IPC returns, and the store removes the mission (§3.2). An IPC error shows a toast and closes the dialog. The missing `catch` in `MissionPopover.vue`'s `confirmClose` and in `missions.ts` `runDoor` is fixed.

**The agent's side:**

- `mission_request_close` stays as the agent's "it's done" signal: `delivered` + `pendingClose` + the cue. It loses only the `MISSION_DRAFT` refusal.
- `closeReadiness` stays.
- The agent still cannot close or discard.

**The owner learns of operator doors (F8).** Every door appends a log entry. A closed or discarded mission refuses agent verbs with `MISSION_CLOSED`, and the `mission` / `orchestrate-delivery` skills treat that refusal as "stop the loop and report".

### 3.6 Human checks (V3-8; review B1, M5)

**Storage:** a per-step field `checks: Check[]`. The step schema declares it, with `.passthrough()` on the nested schemas (§6).

```ts
interface Check {
  id: string // chk-<n>
  label: string // ≤ 200 chars; unique per step (case-insensitive)
  source: 'agent' | 'operator' | 'verifier'
  createdAt: string
  ticked?: { at: string } // only the operator door writes this
}
```

**Creation:**

- The agent uses the new verb `mission_add_check { missionId, stepId, label }`.
- The operator uses "+ check" on a step in the popover.
- A verifier creates one implicitly: `mission_verify_step` with verdict `needs-human` (a new optional arg, `checkLabel`, defaults to the first line of `evidence`) records the step as `done` (§3.1) **and** creates the check, deduped by label. A later verification of the same step with verdict `met` leaves human checks open: the human part is still owed.

**Ticking and deleting:**

- Only the operator ticks or unticks, through the door `tickCheck`. No MCP verb writes `ticked`.
- Only the operator deletes a check (door `deleteCheck`). The agent can add checks but never remove them.
- **The trust model is convention plus audit**, the same as `verificationLabel`. An agent with filesystem access could edit the YAML, and the log records every door.

**Effects:**

- Checks never change step states or the headline.
- **Due checks** are unticked checks on any reached step (`done`, `verified`, `running`, `waiting`). They enter the `you` list (§3.12) and set the `needs-you` tone.
- Close lists them as warnings.

**When to use what:**

- A **check** is a human confirmation of a deliverable that a step produced: DSQA, "validated visually", designer sign-off.
- A **`human` step** is a stage of its own that gates what comes next, for example an operator decision before the next wave. Skills default to checks.

### 3.7 Sticky proof (V3-11; review M6)

**Storage:** last-known link resolutions live **outside the mission file**:

- in memory;
- in a userData sidecar, `mission-link-cache.json`, keyed by `repoRoot + linkKind + ref`, as `{ state, prNumber?, mergedAt?, at }`.

Reads never write the mission file. `updatedAt` therefore stays a pure evidence signal for the stall rule and for ordering.

**Resolution rules:**

- A read that cannot reach GitHub uses the last-known state and marks the link `stale: true`.
- "PR not found" is treated as **unknown**, not as a downgrade. Known causes are an ageing PR beyond `--limit 100` (`pr-stack-core.ts`) and a transient error.
- A missing worktree path whose branch is known to have a **merged** PR stays proven, so Reaper/dehydrate cleanup does not undo proof.
- A link downgrades only on a contrary observation: a PR closed unmerged, a card moved back, or a path missing with no merged PR known.

### 3.8 Read performance (V3-16, smoke S-4; review minor)

- `mission:list` derives missions **in parallel** with a bounded concurrency of 4, replacing the sequential loop in `mission-ipc.ts`.
- The PR fetch (`fetchPrs` per repo root) is a **single-flight** promise cached for 60 s. Failures are not cached. The cache is shared by the MCP and IPC paths, which both run in the main process.
- `scanFolders()` per list call is cached for 10 s.
- **Target:** `mission:list` over 9 open missions ≤ 3 s warm, ≤ 10 s cold. Today's figure, ≈ 46 s, is a sum of per-mission `mission_get` timings, not a measured pass; the benchmark AC measures the real pass.

### 3.9 Warnings to the owner (V3-6; review minor)

`derived.progress.unprovable` lists existence steps that are reached or current and have no link that can resolve (no path, card or PR; session links do not count). The `mission` skill tick surfaces them ("step X can never be proven — link its PR or path"). `mission_add_step` gains an optional `links` argument, so a step can be born provable. There is no hint on `add_step` itself, because links usually come later.

### 3.10 MCP surface for skills (review M4)

`mission_list` rows gain `progress` from the **last cached derive** (`computedAt` included; possibly up to one poll old). The call stays cheap, so skills that need exact numbers call `mission_get`. The legacy `steps: { total, verified, claimed }` stays for one release, marked deprecated, and excludes the fixed start.

### 3.11 Skills and agent wording (V3-5, V3-7, V3-13, V3-14; review minor)

**`status`** renders `derived.progress` and the `you` list as-is ("Step N of M · V verified · L left behind"). It never recounts. The duplicated Progress / Now / Done lines are fixed.

**`orchestrate-delivery` and `mission`:**

- One step per deliverable that moves "where it is" (1 unit = 1 PR = 1 step). Sub-phases go to the Log; sign-offs become checks.
- Declare the plan with `mission_create { steps }`. There is no approval wording: the end question in chat is the agreement.
- "Never link a session to a step only to change its proof label; link the sessions that built it."
- On `MISSION_CLOSED`, stop the loop.
- All "Step N of M" wording matches the pill.

**`delivery-verifier`:** `needs-human` creates a check, and it passes `checkLabel`.

**`delivery-watchdog`:** drops the "draft has not started" skip (T379) and reads `progress`.

**Evals:** the 12 behavior scenarios are reviewed; the ones that reference draft, Approve or the fixed start (most of them) are rewritten. A new scenario covers "a sign-off becomes a check, not a step". The shadow divergence checker and its "Scope confirmed first" rule are **retired** (closes T371 / S10).

**Docs:** `docs/capy-features.md` and `docs/user/agent-control.md` describe the progress object, checks and `mission_add_check`, no draft, the close/discard door, sticky proof, `mission_create.steps`, and scope links.

### 3.12 The `you` list (review M5)

`you` becomes an ordered list, `you: YouItem[]`. The first item stays the one-line summary, and the UI shows "+N more" below it. Items:

- re-scope to approve;
- close pending;
- operator-owned blockers;
- **due checks** (count);
- **reached or left-behind `human` steps not ticked**;
- an imported end to review;
- child approvals;
- child needs-input.

**The cue** keeps one key per kind per mission and fires only when **a key appears or a count grows**. A tick, a resolution or a decrease never chimes. Approvals and needs-input stay excluded (they already chime). The 30-minute re-nudge applies to the list as a whole.

> **Amended 2026-10-09 by [Mission cue noise](../2026-10-09-mission-cue-noise/spec.md) (BUG-173).** The sentence "The 30-minute re-nudge applies to the list as a whole" is superseded. Re-nudging is now per owed kind: `close`, `checks` and `review-import` never re-nudge; `rescope`, `blocker` and `human-steps` re-nudge with back-off (30 min, 1 h, 2 h, 4 h) and then stop. The cue memory is persisted across restarts, and the cue posts one grouped Activity entry with a clickable row per mission instead of a new row each time. Everything else in this section stands.

## 4. Contracts touched

| Area                     | Changes                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core (`mission-core.ts`) | schema: `scope`, `checks`, `closedAs`, `addedAt`, `declaredEndApproval.via`, `.passthrough()` on mission / step / link schemas; `draft` → `active` in `parseMissionFile`; progress function; doors `close` (with `closedAs`), `tickCheck`, `deleteCheck`, `addCheck`; `closeWarnings`; started-based reason rule                                              |
| MCP                      | `mission_create` (+`steps`, active, no fixed start), `mission_add_step` (+`links`), `mission_link_child` (+`scope`), `mission_get` / `mission_list` (+`progress`, `you` list), new `mission_add_check`, `mission_verify_step` (`needs-human` → done + check, +`checkLabel`), `mission_request_close` (no `MISSION_DRAFT`), `mission_import_legacy` (v3 shape) |
| Main perf                | `mission-ipc.ts` parallel derive + doors return the view; `pr-stack` single-flight PR cache; scan cache; link-resolution sidecar                                                                                                                                                                                                                              |
| Renderer                 | pill / chip / popover / step rail per §3.2; checks UI; one close/discard dialog; store patch-on-door; cue per §3.12                                                                                                                                                                                                                                           |
| Skills / evals           | `status`, `mission`, `orchestrate-delivery`, `delivery-verifier`, `delivery-watchdog`; eval rewrite; shadow checker retired                                                                                                                                                                                                                                   |
| Contracts                | `design.md` first; i18n en + pt-BR; CHANGELOG; capy-features + marker; user docs; T358 + v2 spec amendments; ADR-0015 note (approval model, checks)                                                                                                                                                                                                           |

## 5. Acceptance criteria

| AC    | Criterion                                                                                                                                                                                                                                                                                                              | Verify                   |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| AC-1  | `derived.progress` matches **operator-reviewed** expected fixtures, built from scrubbed copies of the real missions (§8 S-1 table, rev 2 column), including parallel running, a blocked future step, a waiting step, a step added mid-flight, a `needs-human` step, a legacy fixed start and all-done-but-earlier-open | test                     |
| AC-2  | Pill, chip, popover header, `mission_get` and `mission_list` show the same N / M / done / verified for the same mission (`mission_list` within one poll); chip tone equals pill tone; pill N equals the current marker                                                                                                 | test                     |
| AC-3  | A legacy mission with an unproven fixed start reaches "Step M of M ✓" when every other step is done; its fixed-start links show as scope                                                                                                                                                                               | test + visual            |
| AC-4  | `mission_create` writes `active` and accepts `steps`; a legacy `draft` file reads `active` everywhere (hibernation included) and produces no cue; no Approve UI or draft cue; no `MISSION_DRAFT`; planning steps before start need no reason and do not trigger "total changed"                                        | test + grep              |
| AC-5  | Close/discard: any non-closed mission; the dialog lists the server's `closeWarnings`; on success the mission leaves the Topbar and sidebar **without waiting for the list refresh**; IPC failure → toast + dismiss; `closedAs` and the reason are logged; agent verbs then return `MISSION_CLOSED`                     | test (fake IPC) + visual |
| AC-6  | Checks: created by the agent verb, by the operator UI and by `needs-human` (deduped); only operator doors tick or delete; a `needs-human` step reads `done`; checks never change progress; due checks enter `you`, set the needs-you tone, cue on growth only, and appear in close warnings                            | test                     |
| AC-7  | Sticky proof: an unreachable GitHub or a not-found PR never downgrades a resolved link (`stale: true`); a merged-PR worktree removed from disk stays proven; reads never write the mission file (`updatedAt` unchanged after N reads)                                                                                  | test (stubbed gh, fs)    |
| AC-8  | Perf: parallel derive (≤ 4) with a single-flight 60 s PR cache; a benchmark over 9 fixture missions with a 5 s stubbed `gh` completes ≤ 12 s cold and ≤ 1 s warm; doors return within 2 s                                                                                                                              | test                     |
| AC-9  | `unprovable` lists reached or current existence steps without resolvable links; `add_step` accepts `links`; the `mission` tick surfaces it                                                                                                                                                                             | test + eval              |
| AC-10 | `you` is a list with the eight item kinds of §3.12; the cue fires on appear or grow only                                                                                                                                                                                                                               | test                     |
| AC-11 | Skills carry the rules of §3.11; the status card renders `progress` once with no duplicated lines; eval scenarios rewritten and pass (sonnet bar), incl. "sign-off becomes a check"; shadow checker removed                                                                                                            | eval + grep              |
| AC-12 | Contracts: design.md, i18n parity, CHANGELOG, capy-features + marker, user docs, amendments; local pipeline green                                                                                                                                                                                                      | gates                    |

## 6. Risks

- **Version skew strips data.** An older Capy (≤ 0.3.43) that writes a v3 file drops the new fields, because zod objects strip unknown keys. Mitigation: ship `.passthrough()` on every mission schema (mission, step, link, check) in S1, so this is the last release with the problem; note it in the CHANGELOG.
- **"Done, not verified" leans on the agent's claim in the headline.** Mitigation:
  - the hollow ✓ and "V verified" stay visible;
  - close warns about unverified work;
  - checks catch the human parts;
  - the proof-label rule goes into the skills.
- **"Waiting" can hide a dead executor.** Mitigation: the stall rule and the watchdog still flag a mission with nobody working past one hour.

## 7. Slices (for the plan)

| Slice | Contents                                                                                                                                                                                                       |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1    | **Core + MCP:** schema (+passthrough), progress, scope attachment, no draft + started reason rule, checks + verbs, the close/discard door + `closeWarnings`, the `you` list, the import v3 shape, `unprovable` |
| S2    | **Perf + sticky proof:** parallel `mission:list`, doors return the view, single-flight PR cache, scan cache, link sidecar                                                                                      |
| S3    | **Renderer:** pill / chip / popover / rail, checks UI, one close/discard dialog with immediate removal, go-to-session, cue per §3.12                                                                           |
| S4    | **Skills + evals + agent / user docs,** shadow checker retired                                                                                                                                                 |
| S5    | **Spec / ADR amendments**                                                                                                                                                                                      |

## 8. Smoke tests (2026-10-01, live Capy 0.3.43, 13 real missions)

Script: `.capy/out/t381-mission-v3/smoke/v3-position.mjs` (read-only; `mission_list` + `mission_get` over MCP). Rev 1 output is in `v3-position.out.json`, rev 2 in `v3-position.rev2.out.json`.

### S-1 — the v3 rule (rev 2) against every real mission

| Mission                          | v2 pill · marker               | v3 pill (rev 2)        | detail                                                                                                             |
| -------------------------------- | ------------------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| proj FAQ section                 | 6 of 10 · on "Scope confirmed" | **Step 8 of 9**        | 6 verified · current: designer sign-off · left behind: "Implementation plan" (unprovable)                          |
| proj page hero                   | 4 of 10 · on "Scope confirmed" | **Step 8 of 9**        | 4 verified + 1 done · hero specs `waiting` (not left behind) · left behind: the operator's approval step (→ `you`) |
| proj tools listing               | 4 of 6 · on "Scope confirmed"  | **Step 5 of 5** (no ✓) | end verified but the designer sign-off is open → left behind, no ✓                                                 |
| proj data table                  | 4 of 8 · on "Scope confirmed"  | **Step 5 of 7**        | 1 blocked (does not advance)                                                                                       |
| proj sections A / B / C (closed) | 5 of 6 each                    | **Step 5 of 5 ✓**      | all verified                                                                                                       |
| side-app wt2                     | 8 of 10                        | **Step 9 of 9 ✓**      | 8 verified + end done                                                                                              |
| side-app Android (dead draft)    | 0 of 11                        | **Step 10 of 10 ✓**    | 0 verified: all hollow ✓, honestly "done, unproven"                                                                |
| Mission v2 (T373)                | 6 of 8                         | **Step 7 of 7 ✓**      | end self-verified under the pre-v2 rule                                                                            |
| CMS navigation (other repo)      | 0 of 7                         | **Step 1 of 6**        | nothing reached                                                                                                    |
| doctor command (other repo)      | 2 of 4                         | **Step 3 of 3**        | the only mission whose fixed start was proven                                                                      |

**Findings:**

- **The fixed start blocked the count in 12 of 13 missions.**
- **Every left-behind item is real:** an unprovable step, an operator approval never ticked, a designer sign-off.
- **Rev 1 → rev 2 fixed three things:**
  - the pill/marker off-by-one (M1);
  - specs with builder sessions falsely listed as left behind (now `waiting`);
  - tools listing falsely showing ✓ while a sign-off was open.
- **Flapping caught live:** tools listing read `waiting` in run 2 (`gh=unavailable`, 11 s) and `verified` in run 3 (`gh=available`), minutes apart. Each run had one `gh=unavailable` read (V3-11).
- **No child was `working` at sample time,** so running/parallel is covered by AC-1 fixtures, not live data.

### S-2 — blast radius of removing draft

- **30 tracked files reference the mission draft state:** 10 source, skill or doc files, and 14 test files.
- **Missed by rev 1, caught in review:**
  - `REASON_REQUIRED` keyed on draft (`tool-handlers.ts`, pinned by `mission-handlers.test.ts`);
  - `mission_import_legacy` writing draft and the fixed frame;
  - draft in `missionState`, `owedKey` and `flagged` (there is no draft `you` item).

### S-3 — schema compatibility

Every mission zod object strips unknown keys, so new fields must be declared. An older build writing a v3 file drops them, which is why `.passthrough()` goes in S1. `draft` stays in the enum for old files. `declaredEndApproval` must gain `via`.

### S-4 — read latency (the close-modal hang)

- **`mission_get` per mission:** 3.5–11 s for the proj missions (17–35 ms with no GitHub links, ~1 s for wt2).
- **`mission:list`** derives open missions sequentially; summing today's 9 open missions gives ≈ 46 s per pass, against a 20 s poll.
- **The close door** awaits the in-flight pass plus a fresh one: up to ~90 s before its dialog dismisses (V3-16).
- **GitHub (`findPrsForWorktrees`) dominates the cost.**

## 9. Open questions

None blocking. The defaults are stated in the spec:

- `mission_list.progress` may be up to one poll old;
- skills default to checks over `human` steps.

## 10. Review log

Revision 2 applies an adversarial review against `origin/main` (8361b2b0).

| Finding | Change                                                                                                                                                                                                                                                                                     |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B1      | `needs-human` → step `done` + check; due checks on any reached step; dedupe, re-verify and delete rules                                                                                                                                                                                    |
| M1      | One definition: N = the current step                                                                                                                                                                                                                                                       |
| M2      | Blocked does not advance; owner excluded from running; `waiting` state; mid-flight additions via `addedAt`; parallel range                                                                                                                                                                 |
| M3      | Reason rule keys on "started"; `mission_create.steps`                                                                                                                                                                                                                                      |
| M4      | `mission_list.progress` from the cached derive                                                                                                                                                                                                                                             |
| M5      | `you` as a list incl. due checks and unticked human steps; cue on appear or grow only; needs-you tone                                                                                                                                                                                      |
| M6      | Sticky proof in a userData sidecar, never the mission file; not-found / missing path = unknown when a merged PR is known                                                                                                                                                                   |
| M7      | Doors return the view; the store removes or patches immediately                                                                                                                                                                                                                            |
| M8      | Import writes the v3 shape; `needsReview` → `you`                                                                                                                                                                                                                                          |
| Minors  | `via` + passthrough; draft normalization in `parseMissionFile`; one close/discard dialog with server-side `closeWarnings`; checks vs human steps; trust model stated; eval rewrite and shadow retirement; owner learns of doors via `MISSION_CLOSED`; AC-1 uses operator-reviewed fixtures |

## 11. Deviations from this spec

What shipped differs from the text above in these places. The T358 design, the Mission v2 spec and
ADR-0015 carry dated notes that describe what shipped. Each item below was read off the code on
`feat/t381-s4-mission-skills` (S1–S4), not off the plan.

**Progress and the headline (§3.1, §3.2)**

- **A `needs-human` verdict is checked first.** `stepState` tests it before the `verified` clause, so
  such a step reads `done` even when its proof label is `verified`. The §3.1 table, read as "first
  match wins" from the top, would have said `verified`. The step's stored `proof` keeps the label the
  `met` rule gives (it is not set back to `unproven`); only the progress state is `done`. A
  `needs-human` verdict on the end can therefore still satisfy `mission_request_close`.
- **A mission with nothing to count has no headline.** The spec did not cover `total === 0` (an empty
  plan, or only a legacy fixed start). `computeProgress` returns `current: null` and
  `progressHeadline` returns `kind: 'empty'`, and the pill and chip print nothing instead of
  "Step 0 of 0".
- **A requested close renders green "delivered", not needs-you (§3.2).** The spec set the `needs-you`
  tone whenever the `you` list is non-empty. `missionState` leaves out two items: a staged re-scope
  reads `rescope-pending`, and a `close` item reads `delivered` (green). The `you` block's own look is
  `success` only while `closeWarnings` is empty, and `warning` otherwise. The sidebar chip still pins
  itself visible whenever the `you` list is non-empty, and wears the pill's tone.
- **The seven step visuals have text labels under `mission.visual.*`** ("Verified", "Done, not
  verified", "Running", "Waiting", "Blocked", "To do", "Left behind"), used as the accessible name.
  The glyphs live in `design.md` §6. The `neutral` pill tone stays in the anatomy, but no state maps
  to it.
- **Go to session** is an in-app icon with a toast ("Session not loaded yet") as specified. The
  spec's "+1 session" is the plural-aware `mission.child.elsewhere`.

**The `you` list (§3.12)**

- **`mission_get` returns `you` and `youItems`.** `you` is one English sentence: the first item plus
  "(+N more)". `youItems` is the ordered list of the eight kinds. The IPC `MissionView.you` is the
  list itself. The spec's single `you: YouItem[]` exists only on the renderer side.
- **A current `human` step is due too.** The spec listed reached or left-behind `human` steps not
  ticked. The code also includes the **current** one, and a step the owner only claimed stays owed
  until the operator ticks it.

**Close and discard (§3.5)**

- **One `end` door, not two.** The IPC door is `end` with `closedAs: 'delivered' | 'discarded'`, so
  there is no separate discard door. A door that ends a mission answers `view: null`. The operator's
  reason is stored as `closeReason` on the mission, as well as in the Log entry, which reads
  `operator ended (delivered)` or `operator ended (discarded)`.
- **A door's re-derive waits at most 1.5 s for GitHub** (`DOOR_PR_WAIT_MS`). On a cold PR cache the
  links then read their sticky last-known state (`stale: true`), the fetch lands in the cache for
  the next poll, and the door still returns inside the 2 s target.

**Scope, checks and import (§3.3, §3.4, §3.6)**

- **Scope links are paths only.** `mission_create { scope }` and `mission_link_child { scope: true }`
  take a `worktree`-kind path. Another kind is `BAD_ARGS`. The first scope link added to a legacy
  mission copies its fixed start's links into `scope` first.
- **`mission_create.steps` takes only `{ title, verification }`**, at most 50, title 1–200 chars.
  Links go on later through `mission_link_child`, or at birth only for a step added with
  `mission_add_step { links }`. Planning steps carry no `addedAt` and count as original.
- **`mission_import_legacy` writes no scope.** The spec said the legacy scope becomes `scope`; a goal
  file names no scope documents, so the import writes the units from `stp-1`, then the end, and the
  `review-import` item on the `you` list.
- **A deduped check writes nothing.** `mission_add_check` and the `addCheck` door leave the file,
  `updatedAt` and the Log untouched when the label is already on the step (any case), and say
  `deduped: true`. The spec only named the dedupe.

**Sticky proof and performance (§3.7, §3.8)**

- **Only `pr` and `worktree` links are sticky.** A `card` link reads the local board, not GitHub, so
  it is never cached. A `pr` link absent from the recent list with no last-known state reads
  `exists: false, stale: true` (unproven), not a downgrade of anything.
- **The list derive takes missions round-robin across repos** at a concurrency of 4, so every
  repo's first `gh` fetch starts in the first wave and the repo's other missions join that
  single-flight fetch. The PR cache lives in `pr-stack.ts` (60 s, kept only when `gh` was reachable);
  the fleet-scan memo (10 s) lives in `mission-ipc.ts`.
- **`mission_list.progress` is `null` until a derive has run** in this Capy process. It is the last
  derive's object, held in memory per mission id; it is not persisted across a restart.

**Skills, evals and proof of the UI (§3.11, §8)**

- **The end-before-dispatch eval needs a sonnet-class model.** Carried over from v2: on haiku the
  owner links sessions in the turn it creates the mission and does not stop to ask the end question.
  The Mission v3 run on 2026-10-01 used `--model sonnet` and passed 12/12 scenarios (one rerun after
  the eval agent's allowlist lacked `mission_add_check`, which `tests/mission-v3-eval-scenarios.test.ts`
  now pins to the catalog). The grader was not loosened; S4 then tightened two graders:
  `end-before-dispatch` asserts one step per dispatched unit (exactly two), a plan declared by
  `mission_create` (no `addedAt` stamp, no `mission_add_step` in turn 1), and `signoff-as-check`
  asserts a check whose label names the sign-off and treats any truthy `ticked` as a violation.
  Regraded offline, every recorded pass still passes. See `scripts/eval/mission-behavior/README.md`.
- **The `parallel` capture is injected over CDP.** No isolated instance has a child whose live
  `taskState` is `working`, so the "Steps 4–7 of 9" view was built with `computeProgress` from the
  fixture and injected into the missions store, with its `refresh` stubbed. The other captures in
  `captures/` are real files read through the real `mission:list` IPC (`captures/README.md`).
- **The §8 S-1 table is not a measurement of the shipped code.** A read-only script computed it
  against the live 0.3.43 missions, applying the rev 2 rule outside Capy. What shipped is graded
  against the scrubbed fixtures in `tests/fixtures/mission-v3/`, and the UI proof is the S3 capture
  set.
