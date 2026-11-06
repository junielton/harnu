# ADR-0023 — A Campaign is a separate record above the Mission; a chapter IS a mission

**Status:** Accepted (shape approved by the operator with the campaign spec and mockup v6, 2026-10-30; the gates amendment decided 2026-10-31)
**Date:** 2026-10-31
**Author:** agent (T595, campaign chapter 3a)
**Technical context:** `docs/specs/2026-10-30-campaign/spec.md` (§3.1, §3.3, §3.5, Amendments (a)), ADR-0015 (Mission as structured data), `docs/lessons/testing/006-eval-harness-grades-state-through-the-real-transport.md`

---

## 1. Context

A Mission is one quest: one declared end and a flat, roughly sequential list of steps (1 step = 1 PR). A real delivery needed five missions opened by hand, grew to a 110-row plan and spawned 26 worktrees, and the pill still read "Step 1 of 4". The operator needs "Chapter 9 of 12 · Step 2 of 4": a layer above the mission that knows its order, its detours and what each part needs from the others. Chapters 4 (UI) and 5 (steward) need something real to read, so the record and its verbs land first.

## 2. Options

| Option                                                                    | What it is                                                                                                      | Verdict                                                                                                   |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **A. A separate Campaign record; each chapter is a mission, bound by id** | `.harnu/campaigns/<id>-<slug>.md` beside `.harnu/missions/`; a chapter holds the `missionId` of its own mission | **Chosen**                                                                                                |
| B. Nest chapters inside one mission file                                  | One file, steps grouped by chapter                                                                              | Rejected: breaks Mission v3's one rule, one pill, one door, and a 110-row file is rewritten on every verb |
| C. Reuse the roadmap board (an epic card with child cards)                | The board already has cards and a WIP ceiling                                                                   | Rejected: cards are intentions, not progress; nothing there derives state from PRs, gates or verifier     |
| D. Tag steps with a chapter and compute chapters from the tags            | No new record; a view over steps                                                                                | Rejected: no place for `consumes`/`produces`, side quests or locked chapters before any step exists       |

## 3. Decision

**A.** `src/main/campaign-core.ts` mirrors `mission-core.ts`: YAML frontmatter plus an append-only Log, a zod schema with `.passthrough()` (a key chapter 6 adds survives a read → write), an exclusive create and a per-id lock, stored in the repo's **main checkout** so every worktree shares it. A chapter's state is **rolled up** from its bound mission in `campaign-progress.ts` and never stored, so there is no second door: a chapter whose mission is `delivered`, or closed as delivered, reads done.

The rules chosen while building it (the spec left them open):

- **States:** `done` (mission delivered or closed as delivered), `inReview` (every step done, not delivered yet), `running` (a step runs), `locked`, else `todo`. A mission closed as _discarded_ is not done.
- **Locked** = the chapter consumes a token whose earlier producers are not all done, or its `unlocks: { kind: 'chapter' }` target is not done. A chapter already started is never re-locked. `unlocks` of kind `decision` and `pr` are recorded but not resolved in 3a: their facts live on the mission (chapters 4 and 5).
- **Prerequisite pass (§3.5):** refuses `PREREQ_MISSING` naming every gap and the way out; `force: true` accepts it and writes a `surprise` entry to the campaign Log. `campaign_add_chapter` judges only the chapter it adds.
- **Append-only chapters:** the only chapter write is an append. A chapter takes one mission (`CHAPTER_ALREADY_BOUND`); `mission_create { campaignId, chapterId }` validates, writes the mission, then binds, all under the campaign lock.
- **`campaign_request_close` only signals** (`delivered` + `pendingClose`), refused `CHAPTERS_OPEN` until every _required_ chapter is done. No verb merges, chooses a decision, ticks a check or closes.
- **Radiant:** `done` is the chapter mission's done steps, capped at `total` (a radiant chapter's mission is planned one step per unit).
- **Gates govern `verified` (Amendment (a)):** a stored-`verified` step reads `done` while any applicable gate is red or running. Decided alongside, because the campaign's "done" is only as honest as the step's.

## 4. Consequences

- Chapters 4 and 5 read `campaign_get.derived` instead of recounting; chapter 6 adds `outcome` without a schema migration.
- A discarded chapter mission cannot be rebound: the orchestrator appends a replacement chapter, and the discarded one stays visible in the record. If that proves painful, allow a rebind of a chapter whose mission was discarded.
- A forced prerequisite gap locks nothing (it can never be satisfied) and is visible only in the Log until chapter 4 surfaces surprises.
- `campaign_get` derives each bound mission fresh (the same derive as `mission_get`, so it can be slow with `gh`); `campaign_list` and the close check read the last-known progress and say so.
- Radiant progress is an interpretation of the spec, flagged for the orchestrator to confirm.
- A pill that counts verified steps now reads lower while a PR is open or CI is red: that is the intent.

## 5. Revisit when

A chapter needs more than one mission, or the operator wants to restructure chapters after the fact (reorder, remove): both break the append-only, one-mission rule above and need a new ADR.
