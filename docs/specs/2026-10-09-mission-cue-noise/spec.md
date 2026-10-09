# Mission cue noise — one entry, real rows, quiet re-nudges, bulk close

- **Date:** 2026-10-09 · **Revision:** 1
- **Status:** draft for review. Spec only: no product code changes with this document. Implementation is the follow-up card (slices in §7).
- **Card:** BUG-173 (unit U0).
- **Amends:** Mission v3 §3.12 ("The `you` list" — the cue paragraph). A dated note there points here.
- **Parents:** Mission v3 (`docs/specs/2026-10-01-mission-v3/spec.md`, §3.5 End door, §3.12 cue) · Mission v2 (T373 S3, the cue itself).
- **Evidence:**
  - the operator's screenshot (2026-10-09): the Activity bell shows "24 missions need you" as one run-on paragraph of titles joined by " · ". Titles repeat, nothing is clickable. Mission titles in it are client work and are not reproduced here.
  - code read on `main` at `d527123` (every `file:line` below is at that commit).
  - the on-disk measurement in §2, row (b), run 2026-10-09 on the author's machine.
- **Operator decisions already taken (2026-10-09):** the end of this unit is a reviewed spec PR; bulk close IS part of this spec.

## 1. Problem

The Mission v3 cue (chime + OS attention + one Activity entry) was designed for "a mission newly owes you something". On a machine with a backlog it became the loudest thing in the app:

1. The multi-mission entry is a paragraph of text. You cannot click a mission, so you cannot act on it.
2. The same mission is listed twice (and counted twice).
3. It re-fires every 30 minutes, for every mission, whatever it owes — including "delivered, close it when you like", which nobody is waiting on.
4. It re-fires on every app start, for the whole backlog.
5. Every cue appends a new Activity row, so the bell fills with near-identical "N missions need you" rows.
6. The fuel is real and unaddressable: of the 24, about 13 are `delivered` awaiting Close and about 8 are `active` with every step done (some from 2026-09-29). Closing them is one dialog per mission today.

## 2. Root causes (AC-1)

| #   | Symptom                           | Cause, with evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) | Multi-mission entry not clickable | `postMissionActivity` (`src/renderer/src/stores/missions.ts:73-96`): the one-mission branch sets `sessionId: only.mission.owner.sessionId` (`:85`), the many-mission branch (`:87-93`) sets only `title` and `description: cued.map((v) => v.title).join(' · ')` (`:92`). `ActivityBell.vue:148-157` navigates only when the record has `sessionId` or `target`, and `:256` gates the pointer cursor on the same test. So the entry is dead text. `NotificationRecord` (`stores/notifications.ts:48-61`) has no way to carry several destinations.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| (b) | Same mission listed twice         | The list is built per **repo root**, and roots are de-duplicated only as strings: `listMissionViews` (`src/main/mission-ipc.ts:172`) is `[...new Set(folders.map(missionRoot))]`, where `missionRoot` is `repoRoot` (`src/main/mcp/tool-handlers.ts:2524-2526`, `src/main/data-dir.ts:101-103`) and `mainCheckoutRoot` follows `.git` layout without `realpath` (`data-dir.ts:72-98`). Each root is read in full (`:175`) and the jobs are concatenated (`:179-187`), then sorted (`:199`). **Nothing de-duplicates by `mission.id`.** Two roots whose `.harnu/missions/` hold the same `mnt-<id>-<slug>.md` files therefore yield two views for one mission. The renderer then makes it visible: `decideCue` walks `views` (`lib/mission-cue.ts:104`) and compares each against the PREVIOUS poll's memory (`:107`), so both copies get cued and `cueIds` holds the id twice; `postMissionActivity` then does `views.filter((v) => missionIds.includes(v.mission.id))` (`missions.ts:75`), which returns both copies, so the title is joined twice and `n` is inflated. (The `models` map, `missions.ts:157-161`, is keyed by id, so the pill and popover silently hide the duplicate; only the cue shows it.) |
|     | **Measured**                      | 2026-10-09, this machine: two **separate clones** of the same remote — the older `capy` clone and the current `harnu` clone — each have their own `.git` directory and each holds a `.harnu/missions/`. The older clone holds 9 mission files, the newer one 14; all 9 of the older clone's are also in the newer one and `cmp` finds them byte-identical. Both clones are known folders, so `roots` has two entries and every shared mission lists twice. (A third kind of duplicate source — one directory reached through two spellings, e.g. a symlinked parent or a case-different path — is the same code path and is closed by the same fix, §3.1. A linked worktree that carries stale copies of mission files is **not** a cause: it resolves to its main checkout via `mainCheckoutRoot`, so its own directory is never read.)                                                                                                                                                                                                                                                                                                                                                                        |
| (c) | Re-nudge every 30 min, for all    | `RENUDGE_MS = 30 * 60 * 1000` (`lib/mission-cue.ts:25`) and the single re-cue test `now - prev.lastCuedAt > RENUDGE_MS` (`:111`). It is **per mission, kind-blind**: any owed kind keeps the mission re-nudging, including `close`, which nobody is waiting on. Mission v3 §3.12 states the same ("The 30-minute re-nudge applies to the list as a whole").                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| (d) | Whole backlog re-cued on start    | The cue memory is a plain in-memory value, `let cueMemory: CueMemory = { owed: new Map(), primed: false }` (`missions.ts:107`). On the first poll after a start every owed mission has no `prev` and takes the `cueIds.push` branch (`lib/mission-cue.ts:108-110`), so the whole backlog cues at once. `CueMemory.primed` (`:41`, written at `:119`) is **never read** anywhere in `src/`, so there is no "first poll" logic either. Related latent hazard: if a poll runs before the sidebar folders have loaded, `missionList([])` returns no views (`mission-ipc.ts:173`), the rebuilt memory is empty (`:102`, `:119`), and the next real poll cues the whole backlog again **within the same run**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| (e) | Every cue appends a new row       | `useNotificationsStore().notify()` always creates a record with a fresh `crypto.randomUUID()` and prepends it (`stores/notifications.ts:107-111`); the store has no notion of "the same subject". `postMissionActivity` (`missions.ts:78`) calls it once per cue, so a 30-minute re-nudge or a restart stacks another "N missions need you" row on top of the last one. Rows live up to 7 days or 200 records (`notifications.ts:9-10`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

## 3. Design

### 3.1 Missions are unique by `mission.id` — fixed in `mission:list` (AC-2)

**Rule.** The list `mission:list` returns holds **at most one view per `mission.id`**. The fix lives in `listMissionViews` (`src/main/mission-ipc.ts`), the layer that introduces the duplicate, so every consumer (pill, popover, sidebar chip, cue, the new review dialog, and anything that reads `MissionListResult`) gets the same answer.

1. **Canonical roots first.** Each root is passed through `fs.realpath` (falling back to the resolved string when it fails) before the `Set`, so one directory reached through two spellings is one root.
2. **Then dedupe by id across roots.** After `readAllMissions` and before any derive work (so a shadowed copy costs no `gh` call), group the parsed missions by `mission.id`. The winner is the copy with the **newest `mission.updatedAt`**; a tie goes to the root that sorts first by path (deterministic, not poll-order dependent).
3. **A closed winner drops the id.** The status filter (`:181`) runs on the WINNER, not on each copy. If the newest copy is `closed`, the id is gone from the list even when an older copy elsewhere still says `active`. This is what keeps a close from being undone by a stale twin: the end door writes one root (`runOperatorDoor`, `:317-342`), stamps `updatedAt = now`, and so makes that copy the newest.
4. **Shadowed copies are reported, not hidden.** `MissionListResult` gains `shadowed: Array<{ missionId: string; root: string }>` (the losing copies), and `listMissionViews` logs ONE `console.warn` per process per shadowed `(id, root)` pair. No UI uses it in v1; it is the diagnostic that tells the operator "you have two clones carrying the same missions". Nothing is deleted or rewritten: the shadowed file stays on disk.

**Defence in depth, not the fix.** `missions.ts` `load()` also drops any later view that repeats an id before it assigns `views.value`, and `decideCue` iterates a `Set` of ids. Both are one-liners that keep a future regression in main from reaching the operator's ears; neither is relied on.

**Regression tests (named).**

- `tests/mission-ipc.test.ts` — new cases `lists a mission once when two roots hold the same id`, `newest updatedAt wins and a tie breaks on root path`, `a closed winner drops the id even if an older copy is active`, `two spellings of one directory are one root`. Fixtures: two temp dirs each with a `.git` directory and the same `mnt-<id>-<slug>.md`.
- `tests/mission-cue.test.ts` — `a repeated mission id in views cues once and counts once` (the defence-in-depth guard).

### 3.2 Cue policy: per kind, quiet by default (AC-4, AC-5)

The unit of memory becomes the **owed key**, not the mission. Each key remembers its own count, when it first appeared, when it was last cued and how many times it has been re-nudged.

Two classes of owed kind:

- **Blocking** — something an agent or a later step is waiting on: `rescope`, `blocker`, `human-steps`. The operator being away costs work, so these re-nudge, but with back-off and a stop.
- **Standing** — a to-do nobody is waiting on: `close`, `checks`, `review-import`. They cue once when they appear or grow and stay visible in the pill, the bell entry and the review dialog. They never re-nudge.

| Owed kind       | Class    | Cues on appear / grow                                             | Re-nudges?    | Schedule                                                                       |
| --------------- | -------- | ----------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------ |
| `close`         | standing | appear: yes (key `close`)                                         | **never**     | — (this is the 13-mission noise: a delivered mission is a to-do, not an alarm) |
| `rescope`       | blocking | appear: yes; a different target is a new key (`rescope:<target>`) | yes, back-off | 30 min, 1 h, 2 h, 4 h after the last cue, then silent                          |
| `blocker`       | blocking | appear: yes; a different reason is a new key (`blocker:<reason>`) | yes, back-off | same schedule: 30 min, 1 h, 2 h, 4 h, then silent                              |
| `checks`        | standing | appear: yes; **grows**: yes (1 → 2). Shrinks and ticks: never     | **never**     | —                                                                              |
| `human-steps`   | blocking | appear: yes; grows: yes (a second gate)                           | yes, back-off | same schedule: 30 min, 1 h, 2 h, 4 h, then silent                              |
| `review-import` | standing | appear: yes (key `review-import`)                                 | **never**     | —                                                                              |

Rules shared by every row:

- **Schedule is a constant array**, `BLOCKING_NUDGE_MS = [30 * 60_000, 60 * 60_000, 2 * 60 * 60_000, 4 * 60 * 60_000]`, exported from `lib/mission-cue.ts`; `RENUDGE_MS` is removed. The nth re-nudge fires when `now - lastCuedAt >= BLOCKING_NUDGE_MS[nudges]`; once `nudges` reaches the array length the key is silent. Total noise for one blocker left alone: one cue plus four reminders over about 7.5 hours, then nothing until the key changes. No Setting, as today.
- **Growth resets the schedule.** A count that grows (or a new key) is a fresh cue: `lastCuedAt = now`, `nudges = 0`.
- **A key that disappears is dropped from the mission's entry**, so if it comes back it is new and cues. A mission that merely stops owing keeps an empty entry (not deleted) for `ABSENT_TTL_MS = 24 h`, see "Stability" below.
- **Approvals and needs-input stay excluded** (unchanged from §3.12): the Approval Inbox and task-state notifications already chime for them.
- **One sound per poll, not per key.** All keys that cue in the same poll, across all missions, produce ONE chime, ONE `requestAttention` and ONE Activity update (§3.3).

**Restart (AC-5).** The memory is persisted, so a restart continues where the last run stopped instead of starting from nothing.

- **Where:** `localStorage`, key `om2tab.missionCues` (the `om2tab.*` prefix is the one CLAUDE.md says to keep), through `persistedRef` (`stores/persisted.ts`), with a `validate` that rejects any value that is not `{ v: 1, owed: object }`. A corrupt value falls back to "no memory" and is treated as a first run.
- **Shape (v1):**

  ```ts
  interface PersistedCueMemory {
    v: 1
    owed: Record<
      string, // mission.id
      {
        keys: Record<
          string,
          { count: number; firstOwedAt: number; lastCuedAt: number; nudges: number }
        >
        lastSeenAt: number // last poll that listed the mission
      }
    >
  }
  ```

  `CueMemory` in `lib/mission-cue.ts` mirrors it (Maps in memory, plain objects on disk; `decideCue` stays pure and takes/returns the in-memory shape; the store converts at the edges). `primed` is deleted; it was never read.

- **First poll after a start.** Compared against the persisted memory, so only what is **new or grown since the app last ran** cues — "something became owed while Harnu was closed" is news; "the same backlog as yesterday" is not. Backlog that is merely still there is silent, and its re-nudge clock continues from the persisted `lastCuedAt` (a blocker that was due while the app was closed fires once, at the first poll, not once per missed interval).
- **No memory at all** (first run of the version that ships this, or a corrupt value): the first poll **seeds** the memory from the current lists with `lastCuedAt = now` and `nudges = BLOCKING_NUDGE_MS.length` for every key — silent, no chime, no entry. Rationale: the operator already has the backlog on screen (the screenshot); a one-time "24 missions need you" would be the bug again. Rejected: cue the seeded backlog once ("the operator might not know") — that is exactly today's start behavior.
- **Stability within a run.** Two guards against a poll that does not reflect reality:
  1. `load()` skips the cue decision when `sessions.folders` is still empty or the call failed (the catch at `missions.ts:128` already keeps the last list; the empty-folders case is new).
  2. A mission absent from a poll keeps its memory entry for `ABSENT_TTL_MS = 24 * 60 * 60 * 1000` (an unreadable file, an unpinned folder, a shadowed copy flipping winner). Absent entries are never cued and never re-nudged; they are pruned by `lastSeenAt`. A mission that is present and owes nothing has its `keys` cleared but the entry kept for the same TTL, so a later blocker is a new key.

### 3.3 One mission entry in the Activity bell, replaced in place (AC-5)

**The Activity store learns about groups.** `NewNotification` gains an optional `group?: string`. `notify()` becomes an upsert on `group`:

- no `group`: unchanged — append (every other source keeps today's behavior);
- `group` set and no record with that group: append;
- `group` set and a record with that group exists: **replace that record's content in place** (`ts`, `kind`, `title`, `description`, `sessionId`, `target`, `items`), keep its `id`, so the bell's expand/measure state does not flicker and the badge count does not grow.

The missions store posts under the single group `'mission-cue'`. There is therefore **at most one mission entry** in the bell.

**What the entry says.** It is a snapshot of **everything currently owed**, not only what this poll cued:

- title: `mission.cue.one` when one mission is owed, `mission.cue.many` ({n} = missions currently owed, de-duplicated by id) otherwise;
- `items`: one per owed mission (§3.4), ordered: missions that cued in this poll first, then blocking kinds, then `updatedAt` newest first;
- `ts` moves to now **only when the poll cued** (new, grown or re-nudge). That is the entry's "this is news" signal and what the relative timestamp shows.

**It also shrinks quietly.** After every poll (cue or not) the store calls `syncMissionActivity(views)`: if a `'mission-cue'` record exists, its `items` and title are rewritten from the current owed set **without** touching `ts`, sound or attention; if nothing is owed any more, the record is removed. If the operator dismissed the entry (×) and nothing new cued, a sync never resurrects it. This is what stops the bell saying "24 missions" after 20 of them were closed.

### 3.4 Clickable rows (AC-3)

**Shape change.** Additive and optional, so every persisted row stays valid:

```ts
// stores/notifications.ts
export interface NotificationItem {
  /** Stable subject id — the mission id for mission rows. */
  id: string
  /** Already localized, like NotificationRecord.title. */
  title: string
  /** What is owed, already localized (the first owed item in words, as `owedWhat` renders it). */
  description?: string
  /** Owner session, when known — the row opens it. */
  sessionId?: string
  /** View-targeted twin (T163); for a mission row: { view: 'mission', missionId }. */
  target?: NotificationTarget
}

export interface NotificationRecord {
  /* …existing fields unchanged… */
  /** Upsert key: at most one record per group (§3.3). */
  group?: string
  /** Per-subject rows for a grouped entry; absent on every pre-existing record. */
  items?: NotificationItem[]
}
```

`NavigableViewId` (`stores/ui.ts:87`) gains `'mission'`, `NavTargetParams` gains `missionId?: string`, and `openNavigableView('mission', { missionId })` is one new `case` that asks the missions store to open that mission (below). That keeps `ActivityBell` free of mission-specific branches, as the existing comment at `ActivityBell.vue:135-147` requires.

**Back-compat of old persisted rows.** Records are plain JSON in `localStorage['om2tab.notifications']` (`notifications.ts:6`, `:81`). The new fields are optional and nothing reads them unless present, so:

- a row written before this change loads and renders exactly as today (title/description paragraph, the single-mission row still uses `sessionId`);
- a build older than this change that reads a row with `group`/`items` ignores the unknown keys (TypeScript-only schema, no runtime validation of records);
- legacy multi-mission rows ("N missions need you" with the joined titles) stay non-clickable. They have no discriminator that survives localization, so they are **not** migrated; they age out by the existing 7-day / 200-record caps or "Clear all". Rejected: delete every `source: 'app'` + `warning` row without `sessionId` on load — it would also delete unrelated app notices.

**The grouped entry renders its items.** In `ActivityBell.vue`, a record with `items` renders, under its title, up to **5** item rows (`MISSION_ROWS_MAX = 5`): the mission title (`text-text`, 12px/500) and what it owes (`text-text-3`, 11px) on one `activity-item` row each, separated by the existing 1px rule, with a `cursor-pointer` hover state. The 6th and later collapse to `+{n} more` (reusing the existing `mission.you.more`) which is itself a button: **"Review all {n}"** — it opens the Missions review dialog (§3.5), which is also where the bulk close lives.

**Click behavior.**

| Click                      | Does                                                                                                                                                                                                                                                                      | Dismisses the entry? |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| An item row, owner loaded  | `sessions.activateSession(item.sessionId)` (the BUG-31 path), then `ui.openNavigableView('mission', { missionId })`, which sets `missions.popoverRequest = { missionId, at }`; the pill (mounted once that session is selected) opens its popover and clears the request. | **no** — see below   |
| An item row, owner missing | Opens the review dialog focused on that mission (see below).                                                                                                                                                                                                              | no                   |
| "Review all {n}"           | Opens the review dialog.                                                                                                                                                                                                                                                  | no                   |
| The entry's body / title   | Nothing (it is a container, not a destination).                                                                                                                                                                                                                           | no                   |
| Hover × / "Clear all"      | Unchanged: dismiss.                                                                                                                                                                                                                                                       | yes                  |

An item click does **not** dismiss the entry: it is a list of several things, and the other rows are still owed. The entry stays truthful through §3.3's quiet sync as missions are handled. (The single-record click-and-dismiss rule at `ActivityBell.vue:148-157` is unchanged for every record without `items`.)

**Opening the popover.** The popover is only reachable through `MissionPill`, which renders for the SELECTED session when it owns the mission (`MissionPill.vue:24`). So "open the mission" means: select the owner, then open that pill's popover. The request in `missions.popoverRequest` expires after 5 s so a request that never finds a pill (owner not shown) cannot pop a popover open later at a surprising moment.

**When the owner session is not loaded.** `activateSession` returns silently when the id is unknown (`stores/sessions.ts:3883-3885`) — a dead click today. The owner can be missing for real reasons: its folder is not pinned in the sidebar, or the session was removed. The contract:

1. `activateSession` returns `boolean` (found / not found). Existing callers ignore it.
2. A mission row whose owner is not loaded is rendered with a muted owner hint (tooltip `mission.cue.ownerMissing`) and its click opens the **review dialog focused on that mission**. The review dialog needs no session: its actions are the operator doors, which take `root` + `missionId` only (`MissionDoor`, `mission-ipc.ts:76-97`). So the operator can still End the mission, which is usually what they want for an orphan.
3. The cue itself still plays: the operator is owed something even if the owner is gone.

### 3.5 Bulk close of finished missions (AC-6)

**What it is.** One operator-only dialog that closes several missions **as delivered** in one confirm. It is two small pieces of UI over the existing end door; no new write path.

- **Where it lives.** A new dialog, `MissionsReviewDialog.vue` ("Missions that need you"), opened from (1) the grouped Activity entry's "Review all {n}" / an orphan row, and (2) `useMissionsStore().openReview(focusMissionId?)` so a later entry point (command palette, a Topbar affordance) is one line. It is not a new Topbar control in v1: the only moment the operator is looking at a pile of missions is when the cue shows them. It is mounted once in `App.vue`, like the other global dialogs, and is a Teleport with its own backdrop so it works with no session selected.
- **What it lists.** Every open mission that owes the operator something (the same owed set the cue uses), in three groups:
  1. **Ready to close** — `status: 'delivered'` with `pendingClose` (the `close` owed kind). The owner verified the end and asked for the close. **Pre-selected.**
  2. **Finished, close never requested** — `status: 'active'` with `progress.allDone` and no `pendingClose`. **Listed, not pre-selected.**
  3. **Waiting on you for something else** — everything else owed. **No checkbox**; each row opens the mission (§3.4). They are listed so the dialog is "the whole pile", but the dialog never offers to close them in bulk.
- **Which missions qualify, and why.** Groups 1 and 2, and only those.
  - Group 1 qualifies without argument: it is exactly "delivered and the agent asked".
  - Group 2 qualifies **because the operator already can**: the end door is available on any non-closed mission (Mission v3 §3.5, decision 4), and these are ~8 of the 24. Excluding them would leave a third of the noise with no remedy. They stay un-selected because nobody verified them: the end is usually `self-verified` or `unproven`, so each row shows its `closeWarnings` inline and the confirm repeats them.
  - Rejected: **only** `delivered`+`pendingClose`. It leaves the active-all-done pile as the same noise, one dialog at a time.
  - Rejected: any `active` mission. Closing work that is not done is a discard, a different decision with a different reason; that stays on the per-mission End dialog.
  - Rejected: **bulk discard.** Discard says "dead or abandoned"; that is a judgment per mission. Out of scope.
- **The selection controls.** A header checkbox "Select all ready" (group 1 only), per-row checkboxes for groups 1 and 2, and a count ("{count} selected"). The footer button is "Close {count} as delivered…" and is disabled at zero. It opens the confirm dialog below; it never closes anything itself.
- **The confirm dialog.** A second dialog, `MissionBulkCloseConfirmDialog.vue`, in the exact anatomy of `MissionCloseConfirmDialog.vue` (Teleport, overlay fade, focus trap, Esc and backdrop cancel, initial focus on Cancel, the confirm chime and OS attention on open — irreversible decisions are never silent). It shows, per selected mission, its title and its **`closeWarnings`** rendered with the existing `mission.end.warnings.*` copy (step titles, never ids; the `endWarnings(view)` helper in `lib/mission-view.ts`). The warnings never disable the confirm. One optional reason field applies to all and goes to every Log. No `Discard` choice: the dialog's only outcome is `closedAs: 'delivered'`.
- **What it calls.** The existing end door, once per selected mission, **sequentially**: `{ door: 'end', root, missionId, closedAs: 'delivered', reason }` (`mission-ipc.ts:79-85`, `runOperatorDoor`). Reusing the door means every guarantee of §3.5 holds per mission with no new code in main: the per-id lock, the atomic write, `applyOperatorEnd` (`mission-core.ts:791-809`) consuming `pendingClose`, and the Log line.
- **One Log line per mission.** The door already appends `### <time> · operator ended (delivered)` plus the reason (`doorLogEntry`, `mission-ipc.ts:229-253`). The bulk path passes a `reason` that always starts with `bulk close` (`bulk close` alone when the operator typed nothing, `bulk close: <their text>` otherwise), so a mission owner reading its Log can tell this was a batch decision and not a per-mission review. No new door type, no changes to the `MissionDoor` union.
- **Partial failure.** Sequential, never abort-on-first-error: each door answers `{ ok }` independently. A new store action `runDoors(doors)` wraps `runDoor` for the batch and (1) raises the in-flight counter once for the whole batch, (2) applies each answer to the store as it lands (so rows vanish one by one), (3) schedules ONE background refresh at the end instead of N, and (4) returns `{ closed: n, failed: [{ missionId, error }] }`. Success: a success toast ("{count} missions closed"). Any failure: a danger toast naming how many failed, and the dialog stays open on the failed rows. `MISSION_CLOSED` on a row (closed by another window meanwhile) counts as closed, as `runDoor` already treats it (`missions.ts:210-216`).
- **Operator-only, no MCP verb (invariant).** There is no `mission_*` verb for this, now or later: `tests/mission-operator-doors.test.ts` already pins that no MCP verb reaches `mission-ipc.ts`; the bulk path adds nothing to `tool-catalog.ts`, and a test asserts the catalog has no tool that can set `closedAs`. An agent can still only stage the close (`mission_request_close`).
- **Stale selection.** Warnings are computed at list time. A mission that changes between the dialog opening and the confirm (a new step, a new blocker) is still closed — the end door never refuses on open matters, by design (§3.5 of Mission v3). The confirm dialog re-reads the views it was opened with from the store at open time, so what the operator confirms is the last poll, at most 20 s old. Accepted risk.

## 4. Contracts touched (AC-7)

| Area                     | Changes at implementation time                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mission v3 spec §3.12    | A dated amendment note (**written with this spec**, 2026-10-09) pointing here. It supersedes the "30-minute re-nudge applies to the list as a whole" sentence; the rest of §3.12 stands.                                                                                                                                                                                                                                                                                                                                                 |
| `design.md` §6           | See "design.md delta" below. Written FIRST in the implementing slice, per CLAUDE.md.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| i18n                     | See "i18n keys" below, `en.json` and `pt-BR.json` in the same change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| CHANGELOG                | One dated entry per user-facing slice: Fixed (duplicate missions, dead rows, repeated cues, restart storm), Added (review and bulk-close dialog).                                                                                                                                                                                                                                                                                                                                                                                        |
| `docs/harnu-features.md` | **Changes, with a marker bump (v80 → v81) in slice S3.** The sentence under `mission_set_blocker` says an operator-owned blocker "re-nudge[s] every 30 minutes until it is cleared". After this change it re-nudges with back-off (30 min, 1 h, 2 h, 4 h) and then stops. That is a behavior an agent plans around ("raise a blocker when your turn ends waiting on the operator"), so it is agent-facing. The bulk close needs no line: there is no verb and nothing the session can do or offer. `mission_request_close` is unchanged. |
| `docs/user/`             | **Changes.** `docs/user/agent-control.md` (the "A sound when a mission starts needing more from you" paragraph, which today promises a 30-minute repeat and a combined start-up reminder) is rewritten to the §3.2 table and the restart rule, and gains the review dialog and bulk close. `docs/user/bundled-skills.md:89` ("remind you every 30 minutes until it's handled") is corrected. The new top-level component `MissionsReviewDialog.vue` also triggers the user-docs CI gate on its own.                                      |
| `CLAUDE.md` entity map   | Two rows: `MissionsReviewDialog.vue`, `MissionBulkCloseConfirmDialog.vue`.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| MCP / `tool-catalog.ts`  | **No change.** No awareness-gate or `no-awareness` label is needed for the catalog.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

**`design.md` delta (§6).**

1. _Notifications → "Mission owes the operator — sound + attention + Activity"_ (`design.md:720-760`): replace "Re-nudge every 30 min … the list as a whole" with the §3.2 table (standing vs blocking, back-off schedule); replace "Start/restart: one combined cue" with the persisted-memory rule and the silent first-run seed; replace the "Copy" bullet's "Several → … titles as the description" with the grouped entry and its rows; add "one sound per poll".
2. _Activity bell_ (`design.md:5150-5250`): add the `group` upsert and the **grouped entry** anatomy (title, up to 5 item rows, "+n more / Review all", item click does not dismiss, quiet sync, owner-missing hint); update the Store paragraph with `group?` and `items?`; add a "Don't": ❌ stack a new row per cue for the same subject.
3. _Mission progress_ (`design.md:5252-5300`): the "Cue" paragraph ("re-nudged every 30 min") points to the new rules; add **Missions review dialog** and **Bulk close confirm** subsections (anatomy, groups, pre-selection, the sequential door calls, the toast outcomes), next to the existing End dialog subsection (`design.md:5481`).
4. No new color, radius, easing or row height: item rows reuse the Activity row spacing and the Toast semantic map; the dialogs reuse the End dialog's tokens.

**i18n keys** (every key added to `en.json` AND `pt-BR.json` in the same change; the schema is `typeof en`, so a key missing from either breaks `vue-tsc`; the pt-BR wording is written then, not here):

| Key                                  | Purpose                                                        |
| ------------------------------------ | -------------------------------------------------------------- |
| `mission.cue.reviewAll`              | "Review all {n}" button under the item rows                    |
| `mission.cue.ownerMissing`           | tooltip on a row whose owner session is not loaded             |
| `mission.cue.itemAria`               | aria-label of an item row ("Open mission {title}")             |
| `mission.review.title`               | review dialog title                                            |
| `mission.review.intro`               | one-line explanation under the title                           |
| `mission.review.groups.ready`        | group 1 heading                                                |
| `mission.review.groups.finished`     | group 2 heading                                                |
| `mission.review.groups.finishedHint` | why group 2 is not pre-selected (nobody verified the end)      |
| `mission.review.groups.other`        | group 3 heading                                                |
| `mission.review.selectAllReady`      | header checkbox                                                |
| `mission.review.selected`            | "{count} selected" (plural)                                    |
| `mission.review.closeSelected`       | footer button, "Close {count} as delivered…" (plural)          |
| `mission.review.empty`               | nothing owed                                                   |
| `mission.review.openMission`         | row action "Open"                                              |
| `mission.review.dismiss`             | close button aria-label                                        |
| `mission.bulk.title`                 | confirm title, "Close {count} missions as delivered?" (plural) |
| `mission.bulk.body`                  | what happens: leave the Topbar and sidebar, cannot be reopened |
| `mission.bulk.reason`                | reason label                                                   |
| `mission.bulk.reasonPlaceholder`     | "Goes to every mission’s Log"                                  |
| `mission.bulk.confirm`               | confirm button, "Close {count} missions" (plural)              |
| `mission.bulk.cancel`                | cancel button                                                  |
| `mission.bulk.dismiss`               | cancel aria-label                                              |
| `mission.bulk.closing`               | in-flight label, "Closing {done} of {total}…"                  |
| `mission.bulk.done`                  | success toast title (plural)                                   |
| `mission.bulk.partial`               | danger toast, "{failed} of {total} could not be closed"        |

Reused as they are: `mission.cue.one`, `mission.cue.many`, `mission.you.more`, `mission.end.warnings.*`, `mission.end.cancel`, `mission.doorFailed`.

## 5. Acceptance criteria for the implementation

| AC  | Criterion                                                                                                                                                                                                                     | Verify        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| I-1 | `listMissionViews` returns one view per `mission.id` for two roots holding the same id, two spellings of one directory, and a closed winner (§3.1); `shadowed` reports the loser                                              | test          |
| I-2 | `decideCue` applies the §3.2 table: `close`, `checks` and `review-import` never re-nudge; `rescope`, `blocker` and `human-steps` re-nudge on the 30 min / 1 h / 2 h / 4 h schedule and then stop; growth resets the schedule  | test          |
| I-3 | A persisted memory suppresses the cue for an unchanged backlog on the first poll after a start, cues once for what is new or grown, and a missing/corrupt memory seeds silently                                               | test          |
| I-4 | A poll with no folders loaded, or a mission absent for less than 24 h, never causes a backlog re-cue                                                                                                                          | test          |
| I-5 | `notify({ group })` upserts: one record per group, id kept, no badge growth; a sync with `ts` untouched never resurrects a dismissed entry and removes the entry when nothing is owed                                         | test          |
| I-6 | The grouped entry renders one clickable row per owed mission (max 5 + "Review all"); a row click activates the owner and opens its popover; an orphan owner opens the review dialog; an item click does not dismiss the entry | test + visual |
| I-7 | Pre-existing persisted records (no `group`, no `items`) load and render unchanged                                                                                                                                             | test          |
| I-8 | Bulk close closes the selected missions with `closedAs: 'delivered'`, one Log line each starting `bulk close`, reports partial failure per mission, and `tool-catalog.ts` has no tool that can set `closedAs`                 | test          |
| I-9 | Contracts: design.md, i18n parity, CHANGELOG, harnu-features + marker, user docs; local pipeline green                                                                                                                        | gates         |

## 6. Decisions and rejected alternatives

| Decision                                                | Rejected alternative                                                                                  |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Dedupe by `mission.id` in `mission:list` (main)         | Dedupe only in the renderer: the pill, popover, chip and every other reader would still see two views |
| Winner = newest `updatedAt`, closed winner drops the id | First root wins: a close written to one clone would be undone by its older twin on the next poll      |
| Standing vs blocking kinds, back-off then silence       | Raise the single interval to 2 h: still re-fires `close` forever, and still cues a blocker too slowly |
| `close` never re-nudges                                 | Re-nudge `close` daily: it is a to-do the pill and the bell already hold                              |
| Persist cue memory in `localStorage`                    | Persist in main/userData: the cue decision and its inputs are renderer-side; no second store          |
| Silent seed on a first run                              | One combined cue for the backlog: it is today's restart behavior                                      |
| One `group` upsert in the notifications store           | Delete-then-append in the missions store: races the 7-day prune and loses the id                      |
| Quiet sync after every poll                             | Only update on cues: the bell keeps claiming a count the operator already cleared                     |
| Reuse the end door per mission, sequentially            | A batch IPC door: a second write path to keep in sync with the lock, the Log and the tests            |
| `bulk close` reason prefix                              | A new `bulk` field on `MissionDoor`: changes a pinned union for a Log nicety                          |
| Groups 1 and 2 qualify; group 2 is not pre-selected     | Only group 1 (leaves a third of the pile); any `active` mission (that is a discard)                   |
| No bulk discard                                         | Include a Discard choice: per-mission judgment                                                        |
| Review dialog, no new Topbar control                    | A permanent "Missions" button: a new always-on affordance for a rare chore                            |

## 7. Implementation plan (AC-8)

One slice = one PR. S1 and S2 are independent and can be built in parallel; S4 and S5 build on S3.

| Slice | Contents                                                                                                                                                                                                                                                                                                                                                                                                          | Files                                                                                                                                                                                                                                                                                                                                          | Tests                                                                                                                                                                                                                                                                                                              | Depends on |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| S1    | **Dedupe in main** (§3.1): canonical roots, id grouping, winner rule, `shadowed`, the renderer's one-line guard in `load()`. CHANGELOG (Fixed).                                                                                                                                                                                                                                                                   | `src/main/mission-ipc.ts`, `src/renderer/src/stores/missions.ts`, `tests/mission-ipc.test.ts`, `tests/mission-cue.test.ts`, `CHANGELOG.md`                                                                                                                                                                                                     | I-1 (four named cases) + the defence-in-depth case. Fixtures are temp dirs, no real data.                                                                                                                                                                                                                          | —          |
| S2    | **Notification groups** (§3.3, first half of §3.4): `group` upsert, `items`/`NotificationItem` types, `activateSession` returns boolean, `NavigableViewId` `'mission'`. No mission wiring yet.                                                                                                                                                                                                                    | `src/renderer/src/stores/notifications.ts`, `src/renderer/src/stores/ui.ts`, `src/renderer/src/stores/sessions.ts`, `tests/notifications-store.test.ts`                                                                                                                                                                                        | I-5 (upsert, id kept, no badge growth), I-7 (old records load as before).                                                                                                                                                                                                                                          | —          |
| S3    | **Cue policy and persisted memory** (§3.2): `lib/mission-cue.ts` rewritten around per-key memory (`BLOCKING_NUDGE_MS`, class table, `ABSENT_TTL_MS`, no `primed`), the `om2tab.missionCues` persisted ref, silent seed, folders-loaded guard. `design.md` §6 Notifications rules, `docs/harnu-features.md` blocker sentence + marker v80 → v81, `docs/user/agent-control.md` + `bundled-skills.md:89`, CHANGELOG. | `src/renderer/src/lib/mission-cue.ts`, `src/renderer/src/stores/missions.ts`, `design.md`, `docs/harnu-features.md`, `docs/user/agent-control.md`, `docs/user/bundled-skills.md`, `CHANGELOG.md`, `tests/mission-cue.test.ts`                                                                                                                  | **Unit tests, `mission-cue.ts` is pure**: I-2 (one case per table row, schedule exhaustion, growth reset), I-3 (persisted memory, first poll, seed), I-4 (absent mission within TTL, empty folders), plus a serialization round-trip. Time is an injected `now`, as today.                                         | —          |
| S4    | **Grouped Activity entry and clickable rows** (§3.3 posting side, §3.4): `postMissionActivity` posts the `'mission-cue'` group with `items`, `syncMissionActivity` after each poll, `ActivityBell.vue` item rows, `popoverRequest` in the missions store and the pill's watch, owner-missing fallback. `design.md` Activity bell, i18n `mission.cue.*`, CHANGELOG.                                                | `src/renderer/src/stores/missions.ts`, `src/renderer/src/components/ActivityBell.vue`, `src/renderer/src/components/MissionPill.vue`, `src/renderer/src/i18n/en.json`, `src/renderer/src/i18n/pt-BR.json`, `design.md`, `CHANGELOG.md`, `tests/notifications.test.ts`, `tests/mission-cue.test.ts` (or a new `tests/mission-activity.test.ts`) | I-5 (sync never resurrects, removes at zero), I-6 (row click paths with a faked sessions store: loaded owner, missing owner, "Review all"), visual check of the grouped entry in the live app per `docs/dev/live-verify-second-instance.md`.                                                                       | S2, S3     |
| S5    | **Review dialog and bulk close** (§3.5): `MissionsReviewDialog.vue`, `MissionBulkCloseConfirmDialog.vue`, `runDoors` in the missions store, mount in `App.vue`, `openReview`. `design.md` dialogs, i18n `mission.review.*` / `mission.bulk.*`, `docs/user/agent-control.md` section, `CLAUDE.md` map rows, CHANGELOG.                                                                                             | `src/renderer/src/components/MissionsReviewDialog.vue`, `src/renderer/src/components/MissionBulkCloseConfirmDialog.vue`, `src/renderer/src/stores/missions.ts`, `src/renderer/src/App.vue`, `src/renderer/src/lib/mission-view.ts`, i18n files, `design.md`, `docs/user/agent-control.md`, `CLAUDE.md`, `CHANGELOG.md`                         | I-8: `runDoors` with a faked `missionOperatorDoor` (all ok, one failing, one `MISSION_CLOSED`), group/qualification selectors as pure functions in `lib/mission-view.ts`, the reason-prefix rule, and the catalog test that no tool can set `closedAs`. Visual check of both dialogs, including the warnings list. | S4         |

Cross-slice notes:

- S3 and S4 both touch `missions.ts`; if they land out of order the second rebases over `load()` only. S3 owns the cue decision, S4 owns what is posted.
- The `harnu-features` marker bump and the user-docs rewrite are in S3 (where the 30-minute behavior changes), not S4, so the docs never describe a behavior that has not shipped.
- Each slice carries its own CHANGELOG bullet under one `## YYYY-MM-DD` heading of its landing day.

## 8. Risks

- **A blocker silenced after four reminders.** An operator who ignores a blocker for 8 hours stops hearing about it. It remains in the pill, the bell entry and the review dialog, and the stale rule and the delivery watchdog still flag the mission. Mitigation: the schedule is one exported constant, easy to lengthen.
- **Shadowed twin hides a real divergence.** If two clones diverge on the same mission id (same id, different content), the newest wins and the other is invisible. `shadowed` plus the one-time warning is the trace; a divergence on a mission id is not expected because ids are minted per repo.
- **`localStorage` is per-window.** Two Harnu windows would keep separate cue memories. Today they are two in-memory memories, so this is no worse.
- **Bulk close is irreversible per mission.** Mitigation: nothing is pre-selected in group 2, the confirm lists every `closeWarnings`, initial focus is Cancel, and the Log says it was a batch.

## 9. Open questions

None blocking. Defaults chosen above, worth a look in review:

1. Is 30 min / 1 h / 2 h / 4 h the right back-off, and is "then silent" right for `rescope`? (One constant to change.)
2. Should the review dialog also get a Topbar entry point, or is the Activity entry enough for v1? (Chosen: Activity entry only.)
3. The legacy multi-mission rows already in the operator's bell stay until cleared (§3.4). If that is unacceptable, the only discriminator is to stamp future rows and ship a one-time "Clear all" prompt; not proposed here.

## 10. Trace to the card's acceptance criteria

| Card AC | Where                                                                            |
| ------- | -------------------------------------------------------------------------------- |
| AC-1    | §2 (rows a–e, with the measurement under row b)                                  |
| AC-2    | §3.1, tests named there                                                          |
| AC-3    | §3.4                                                                             |
| AC-4    | §3.2 (table)                                                                     |
| AC-5    | §3.2 ("Restart"), §3.3                                                           |
| AC-6    | §3.5                                                                             |
| AC-7    | §4 (+ the amendment note in Mission v3 §3.12)                                    |
| AC-8    | §7                                                                               |
| AC-9    | This diff: docs only, English only, neutral vocabulary, `prettier --check` clean |
