---
status: approved
tier: large
---

# Session evidence reaches the mission

## Problem

A session that finished or checked a step holds the evidence (a merged pull request, a green suite, a
page it looked at) but the mission has no door that takes it. Measured over the 21 days before
2026-11-24, on 3,194 transcripts (744 that call a mission verb, 7,228 calls):

- Hard refusals are rare: 173 (2.4%), almost all recovered on retry. The loss is elsewhere.
- **Operator-only criteria wait for a click the session already argued for.** 107 `operator` or `person`
  criteria are open in the records; sessions wrote "Mark done" in 87 messages and "Done, continue" in 32
  messages, telling the operator to click what they had already checked. 9 `mission_request_close`
  calls were refused `STEPS_OPEN` on steps that waited only on a sign-off.
- **The session that holds the evidence cannot write it.** 65 verifier sessions ran without the mission
  verbs, and 15 dispatched workers were refused `NOT_ATTACHED` (14 of them were drained from a
  `submit_manifest`, BUG-296). Their verdicts ended in `REPORT.md` files, never in the mission.
- **The builder rule catches the leader.** A step with no session link counts the leader as its builder
  (`src/main/missions/verbs.ts:145-155`), and 263 of 351 recorded steps have none. A blind verifier's
  verdict relayed by the leader lands as a `selfCheck` (24 seen) and stays open; 46 `session` criteria
  are open on steps with no session link.

Guided walks had the same problem and solved it with two signals (T787): the agent's evidence plus the
operator's Done settle a criterion at the close, written by the app as the operator
(`src/main/walk/walk-settle.ts`, `src/main/missions/doors.ts:56`).

Request atoms (the operator, 2026-11-24):

- R-1 The session knows the mission exists and that steps are done, but cannot update the mission.
- R-2 The evidence the session has should reach the mission, as it does at the close of a walk.
- R-3 A session proposes the evidence for a criterion, and the operator accepts it with one click.
- R-4 Every session dispatched for a mission is born attached to it, with its mission verbs.

## Goals

- G-1 A session holding evidence for an open `operator` or `session` criterion records it with one call,
  and the Mission dropdown shows it as a claim the operator accepts in one click, one at a time or all
  at once (R-1, R-2, R-3).
- G-2 Every session Harnu starts for a mission step, worker or verifier, by any of the three dispatch
  paths, can read and write its scoped mission verbs from its first turn (R-4).
- G-3 A session never again has to ask in chat for "Mark done" on a criterion it checked: the claim is
  the ask, and it shows in the operator's waiting list (R-1).

**Non-goals:**

- NG-1 A session never settles an `operator` or `person` criterion alone; the operator's Accept is the
  second signal (R-3).
- NG-2 Evidence never stamps a `fact` criterion; only Harnu's own read of the fact settles it (R-2).
- NG-3 No direct edit of a step's state; `mission_update_step` stays unbuilt (R-1).
- NG-4 Telling the leader that the operator accepted a claim (a door click reaching the session) is
  T803's study, not this spec (R-1).

**Anti-goals:** the operator clicks as much as before (one click per criterion with no batch); a
builder's own claim reads as verified before the operator accepts it; a claim with no evidence text.

## Slices

### S-1 · Claims on the record and the Accept door

- depends-on: —
- substrate: worktree
- files-may-touch: `src/main/missions/model.ts`, `src/main/missions/verbs-state.ts`,
  `src/main/missions/doors.ts`, `src/main/missions/waiting.ts`, `src/main/missions/state.ts`,
  `src/main/missions/summary.ts`, `src/main/mission-ipc.ts`, `src/main/mcp/tool-catalog.ts`,
  `src/main/mcp/tool-handlers.ts`, `docs/harnu-features.md`, `docs/user/agent-control.md`,
  `docs/user/missions.md`, `CHANGELOG.md`, `tests/mission-*.test.ts`
- produces: criterion-claims
- consumes: existing:missions-v4
- gated-by: D-1, D-2, D-5
- acs: AC-1, AC-2, AC-3, AC-4, AC-5, AC-6, AC-7, AC-12

### S-2 · Claims in the Mission dropdown

- depends-on: S-1
- substrate: worktree
- files-may-touch: `design.md`, `docs/design/mission-dropdown/**`,
  `src/renderer/src/components/MissionDropdownStep.vue`,
  `src/renderer/src/components/MissionDropdownNext.vue`, `src/renderer/src/lib/mission-pane-view.ts`,
  `src/renderer/src/lib/mission-dropdown-tree.ts`, `src/renderer/src/stores/missions.ts`,
  `src/preload/index.ts`, `src/renderer/src/i18n/en.json`, `src/renderer/src/i18n/pt-BR.json`,
  `CHANGELOG.md`, `tests/mission-dropdown-*.test.ts`
- produces: —
- consumes: criterion-claims, existing:mission-dropdown-layout
- gated-by: D-3, D-4
- acs: AC-8, AC-9, AC-10

### S-3 · Dispatched sessions are born attached

- depends-on: —
- substrate: worktree
- files-may-touch: `src/main/missions/dispatch.ts`, `src/main/missions/sessions.ts`,
  `src/main/missions/guard.ts`, `src/main/mcp/**`, `src/main/roadmap/**`, `src/main/pty.ts`,
  `docs/harnu-features.md`, `CHANGELOG.md`, `tests/mission-*.test.ts`, `tests/*manifest*.test.ts`,
  `tests/*dispatch*.test.ts`
- produces: —
- consumes: existing:scoped-credentials
- acs: AC-11, AC-13, AC-14

## Acceptance criteria

| id    | statement                                                                                                                                                                                                                                                          | proof                                                                   | refines/inherits | covers   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | ---------------- | -------- |
| AC-1  | `mission_settle_ac` on an open `operator` criterion, from an attached session with non-empty evidence, records a claim `{ at, by, evidence }` and answers `outcome: 'claimed'`; it no longer refuses `SETTLE_NOT_ALLOWED`.                                         | test:tests/mission-claims.test.ts::operator criterion takes a claim     | —                | R-1, R-3 |
| AC-2  | The builder's own `mission_settle_ac` on a `session` criterion keeps storing its claim (today's `selfCheck`) and answers `outcome: 'claimed'`; it still never settles.                                                                                             | test:tests/mission-claims.test.ts::a builder claims and does not settle | —                | R-3      |
| AC-3  | A claim with empty evidence is refused `BAD_ARGS`; a claim on a `fact` criterion is refused `SETTLE_NOT_ALLOWED` and the refusal says Harnu reads that fact itself.                                                                                                | test:tests/mission-claims.test.ts::refusals                             | —                | R-2      |
| AC-4  | The operator door `acceptClaim` settles the criterion as the operator, stamping `Accepted <session8>'s claim: <evidence>` (evidence cut at 400 characters), and writes one Log line naming the step and the criterion.                                             | test:tests/mission-claims.test.ts::accept settles as the operator       | —                | R-2, R-3 |
| AC-5  | `acceptClaims` settles every open claimed criterion of one step, or of the whole mission, in ONE write; a criterion settled in between is skipped, never stamped twice.                                                                                            | test:tests/mission-claims.test.ts::accept all in one write              | AC-4             | R-3      |
| AC-6  | A newer claim on the same criterion replaces the older one on the record; the older one stays in the Log.                                                                                                                                                          | test:tests/mission-claims.test.ts::a newer claim replaces               | —                | R-3      |
| AC-7  | `mission_get`'s `waiting` gains one item kind `accept` (count and step ids), ranked right after `unblock`, and `next` names it when it is first.                                                                                                                   | test:tests/mission-waiting.test.ts::claims rank after unblock           | —                | R-1      |
| AC-8  | In the dropdown, a claimed criterion shows the evidence (two lines, expandable), who claimed it and when, and an Accept button; a step with two or more claims shows "Accept all N".                                                                               | capture:mission-dropdown@claimed                                        | AC-4             | R-3      |
| AC-9  | The Next card shows "Sessions say N criteria are done" with "Review" (opens the first claimed step) and "Accept all" when `accept` is the first waiting item.                                                                                                      | capture:mission-dropdown@claims-next                                    | AC-7             | R-3      |
| AC-10 | Every new string is in `en.json` and `pt-BR.json`, and `design.md` describes the claim row and the Next card variant before the code uses them.                                                                                                                    | script:npm run typecheck:web                                            | —                | R-3      |
| AC-11 | For each dispatch path (`create_session` with a step, `submit_manifest` with a step, the board's Dispatch on a step card) a worker and a verifier can call `mission_get` and their write verbs in their first turn; the step reads `running` and names the worker. | test:tests/mission-dispatch-attach.test.ts::three paths attach          | —                | R-4      |
| AC-12 | `docs/harnu-features.md` (marker bumped) tells sessions to record a checked criterion with `mission_settle_ac` and never to ask in chat for "Mark done"; `docs/user/` explains claims and Accept.                                                                  | script:node scripts/ci/awareness-gate.mjs                               | —                | R-1      |
| AC-13 | A dispatched session that could not be attached is never silent: the dispatch ACK carries `bindError`, an Activity notice names the card, and the mission Log records a `surprise`.                                                                                | test:tests/mission-dispatch-attach.test.ts::a failed bind is loud       | AC-11            | R-4      |
| AC-14 | The drained session's card moves from its `synthetic-…` id to the real one, and `get_session` on it answers (BUG-296 AC-3).                                                                                                                                        | test:tests/mission-dispatch-attach.test.ts::card gets the real id       | AC-11            | R-4      |

## Open decisions

| id  | question                                                                                                                            | options                                              | default                                                          | status                                               |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------- |
| D-1 | Does a session claim through `mission_settle_ac` (an existing verb returning a new outcome) or a new verb `mission_claim_ac` (R-3)? | extend settle_ac, new verb                           | extend settle_ac: sessions already call it and get refused today | resolved: extend settle_ac (2026-11-24)              |
| D-2 | May a session claim a `person` criterion (another person's approval) (R-3)?                                                         | yes, no                                              | no: only that person can approve, the operator marks it          | resolved: no (2026-11-24)                            |
| D-3 | Where does "Accept all" live (R-3)?                                                                                                 | per step only, per step and on the Next card         | per step and on the Next card                                    | resolved: per step and on the Next card (2026-11-24) |
| D-4 | Does the dropdown offer Decline on a claim, and what does it do (R-3)?                                                              | no Decline, Decline clears the claim with a Log line | no Decline: an unaccepted claim stays visible and harmless       | resolved: no Decline (2026-11-24)                    |
| D-5 | Do the `selfCheck` stamps already on records show as claims after the upgrade (R-2)?                                                | yes, no                                              | yes: they are the same thing, and 24 are waiting today           | resolved: yes (2026-11-24)                           |

## Amendments · Deviations

| date       | kind      | what changed                                                          | by           |
| ---------- | --------- | --------------------------------------------------------------------- | ------------ |
| 2026-11-24 | amendment | Approved by the operator in chat; D-1..D-5 resolved at their defaults | orchestrator |
