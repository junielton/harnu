---
status: approved
tier: large
---

# Your move: the operator always knows when the ball is theirs

## Problem

An operator runs dozens of sessions across a dozen projects and cannot watch them. Harnu chimes when the CLI shows a real prompt, but a session that stops on prose, buries a question under later tickets, or leaves a blocker that goes quiet looks like any idle row. Measured on this repo on 2026-11-09: of 200 real turns, 62 left something only the operator could unblock. The operator opens sessions one by one to find them.

Mechanics, evidence and decisions: `docs/specs/2026-11-09-your-move/design.md`. Task-level plan: `docs/specs/2026-11-09-your-move/plan.md`.

- R-1 When a session needs the operator, it must read as an action to take, never as vague text.
- R-2 The operator learns of it immediately, without opening sessions one by one.
- R-3 It must be global, whatever project the sidebar is drilled into, by extending Return here.
- R-4 The operator can answer from buttons on the card.
- R-5 A session that ends with the ball on the operator must not die silently, whether or not the session cooperates.
- R-6 A question raised by an orchestrator must survive later tickets and worker messages.
- R-7 Being bothered for nothing is better than a session dying unnoticed.
- R-8 It must work with Floating panels.

## Goals

- G-1 Anything only the operator can unblock becomes a card in a global queue with a running clock.
- G-2 A card explains itself and leaves only when the operator has dealt with it.

**Non-goals:**

- NG-1 Blocking a session's stop (R-5).
- NG-2 Adapters for other CLIs (R-1).
- NG-3 Answering from the card, sound, reminders and Live by default. They are U5, after a week of Observe mode (R-2, R-4).

**Anti-goals:** a session going quiet on something the operator owes; a card that forces a trip into the session to learn what it asks; a card that disappears because the operator merely looked at the session.

## Slices

### S-1 · Core in Observe mode

- depends-on: —
- substrate: worktree
- files-may-touch: `src/main/your-move/**`, `resources/your-move/**`, `electron-builder.yml`, `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/src/components/SettingsDialog.vue`, `src/renderer/src/components/YourMovePane.vue`, `src/renderer/src/i18n/en.json`, `src/renderer/src/i18n/pt-BR.json`, `design.md`, `CLAUDE.md`, `docs/user/settings.md`, `CHANGELOG.md`, `tests/your-move/**`
- produces: your-move-store
- consumes: existing:hook-bridge
- acs: AC-1, AC-2, AC-3, AC-4, AC-5, AC-6, AC-7, AC-8, AC-9, AC-10, AC-11

### S-2 · Card sources

- depends-on: S-1
- substrate: worktree
- files-may-touch: `src/main/your-move/**`, `src/main/hook-bridge.ts`, `src/main/detect/task-state-hub.ts`, `src/main/hook-settings-blob.ts`, `src/main/pty.ts`, `src/main/mission-ipc.ts`, `src/main/mcp/tool-handlers.ts`, `src/main/user-projects.ts`, `docs/user/settings.md`, `CHANGELOG.md`, `tests/your-move/**`, `tests/hook-settings-blob.test.ts`, `tests/pty-terminal-close.test.ts`
- produces: card-sources
- consumes: your-move-store
- acs: AC-12, AC-13, AC-14, AC-15, AC-16, AC-17, AC-18, AC-19, AC-20, AC-21

### S-3 · Agent surface

- depends-on: S-2
- substrate: worktree
- files-may-touch: `src/main/mcp/tool-catalog.ts`, `src/main/mcp/validate.ts`, `src/main/mcp/plan-input.ts`, `src/main/mcp/tool-handlers.ts`, `src/main/your-move/core.ts`, `resources/skills/skills/your-move/**`, `resources/skills/CATALOG.md`, `docs/harnu-features.md`, `docs/user/agent-control.md`, `docs/user/bundled-skills.md`, `CHANGELOG.md`, `tests/your-move/**`, `tests/mcp-tool-catalog.test.ts`
- produces: your-move-verb
- consumes: your-move-store
- acs: AC-22, AC-23, AC-24, AC-25, AC-26

### S-4 · Queue UI in Return here

- depends-on: S-3
- substrate: worktree
- files-may-touch: `src/renderer/src/lib/your-move-view.ts`, `src/renderer/src/stores/your-move.ts`, `src/renderer/src/components/YourMoveCard.vue`, `src/renderer/src/components/SidebarReturnZone.vue`, `src/renderer/src/i18n/en.json`, `src/renderer/src/i18n/pt-BR.json`, `src/main/your-move/ipc.ts`, `src/preload/index.ts`, `design.md`, `CLAUDE.md`, `docs/user/sessions.md`, `CHANGELOG.md`, `tests/your-move/**`, `tests/floating-panels.test.ts`
- produces: your-move-queue
- consumes: your-move-store, card-sources
- acs: AC-27, AC-28, AC-29, AC-30, AC-31, AC-32, AC-33, AC-34

## Acceptance criteria

| id    | statement                                                                                                                            | proof                                                                                                                                                 | refines/inherits | covers        |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------- |
| AC-1  | Refreshing a card changes its ask and updatedAt but never its openedAt, so the clock keeps running.                                  | test:tests/your-move/core.test.ts::update refreshes ask and updatedAt, never openedAt                                                                 | —                | R-2           |
| AC-2  | The judge cannot close a card unless an operator entry exists in the segment.                                                        | test:tests/your-move/core.test.ts::close is ignored without an [OPERATOR] entry                                                                       | —                | R-5           |
| AC-3  | A dispatch prompt carrying origin human is tagged as an agent message, not the operator.                                             | test:tests/your-move/segment.test.ts::origin human starting "[Harnu ·" is AGENT_MESSAGE from human                                                    | —                | R-6           |
| AC-4  | Assistant text reaches the judge whole, never truncated.                                                                             | test:tests/your-move/segment.test.ts::assistant text of 50_000 chars is carried whole                                                                 | —                | R-6           |
| AC-5  | A verdict and the cursor advance in one atomic write.                                                                                | test:tests/your-move/inspector.test.ts::a verdict and the cursor land in one transact                                                                 | —                | R-5           |
| AC-6  | A judge failure leaves the cursor in place.                                                                                          | test:tests/your-move/inspector.test.ts::judge failure leaves the cursor where it was and calls onFailure                                              | —                | R-5           |
| AC-7  | A session first seen at its Stop has its recent tail judged rather than skipped.                                                     | test:tests/your-move/inspector.test.ts::stop and manual with no cursor start at most 256 KiB back, aligned after a newline, and judge that tail       | —                | R-5, R-7      |
| AC-8  | The judge runs isolated, with the exact argument list.                                                                               | test:tests/your-move/gate.test.ts::buildJudgeArgs is exact                                                                                            | —                | R-5           |
| AC-9  | Judge concurrency is never above half the cores.                                                                                     | test:tests/your-move/gate.test.ts::judgeConcurrency: 20→4, 8→4, 4→2, 3→1, 1→1, never above half the cores                                             | —                | R-5           |
| AC-10 | Gate v2 keeps recall: at most 2 of 486 synthetic misses and at least 59 of 62 real turns caught, recorded with the false-alarm rate. | record:eval-numbers-in-pr-body                                                                                                                        | —                | R-5, R-6, R-7 |
| AC-11 | The setting offers Off, Observe and Live, and U1 ships with the default Off.                                                         | test:tests/your-move/pane.test.ts::renders Off, Observe and Live and calls yourMoveSetPrefs on change                                                 | —                | R-2           |
| AC-12 | The hook bridge still answers with no decision field.                                                                                | test:tests/your-move/hook-payload.test.ts::the response body is still {} with no decision field                                                       | —                | R-5           |
| AC-13 | Stop triggers one inspection after the hook handler has returned.                                                                    | test:tests/your-move/triggers.test.ts::Stop requests one inspection after STOP_SETTLE_MS, after the handler returned                                  | AC-12            | R-5           |
| AC-14 | Harnu's own headless runs are never judged.                                                                                          | test:tests/your-move/triggers.test.ts::an event for a programmatic transcript files nothing                                                           | —                | R-5           |
| AC-15 | Mid-turn inspection never consumes text the Stop inspection must still judge.                                                        | test:tests/your-move/mid-turn.test.ts::a later Stop still judges the same text on the live cursor                                                     | —                | R-6           |
| AC-16 | A StopFailure files one death card per session.                                                                                      | test:tests/your-move/death.test.ts::StopFailure files one death card per session                                                                      | —                | R-5           |
| AC-17 | A judge failure opens one card per streak.                                                                                           | test:tests/your-move/death.test.ts::judge failure opens one card per streak, not one per attempt                                                      | —                | R-5, R-7      |
| AC-18 | Each owed mission item maps to a card kind, and child approvals and needs-input file none.                                           | test:tests/your-move/source-mission.test.ts::maps each owed kind to the table above, and approvals and needs-input to nothing                         | —                | R-1, R-5      |
| AC-19 | A cleared blocker closes its card.                                                                                                   | test:tests/your-move/source-mission.test.ts::a cleared blocker closes its card as source-resolved                                                     | —                | R-5           |
| AC-20 | A parked AskUserQuestion files a card.                                                                                               | test:tests/your-move/source-gate.test.ts::a last assistant entry with an AskUserQuestion tool_use and no result is pending, stop_reason null included | —                | R-5           |
| AC-21 | Archiving a session closes its cards.                                                                                                | test:tests/your-move/source-gate.test.ts::archiving a session closes its cards as archived                                                            | —                | R-2           |
| AC-22 | The your_move verb files a card and returns its id.                                                                                  | test:tests/your-move/verb.test.ts::files a card and returns its id                                                                                    | —                | R-1           |
| AC-23 | No agent-facing surface can close a card.                                                                                            | test:tests/your-move/verb.test.ts::the schema has no close field and the catalog has no close verb                                                    | —                | R-5           |
| AC-24 | The verb is rate-capped per session and hour.                                                                                        | test:tests/your-move/verb.test.ts::the 31st call within an hour for one session is YOUR_MOVE_RATE_LIMIT and appends an audit row                      | —                | R-7           |
| AC-25 | The skill states the end-of-turn test and all five kinds.                                                                            | test:tests/your-move/skill.test.ts::mentions all five kinds, your_move, and the end-of-turn test                                                      | —                | R-1           |
| AC-26 | The agent-facing doc is updated for the verb.                                                                                        | script:node scripts/ci/awareness-gate.mjs                                                                                                             | —                | R-1           |
| AC-27 | A decide card has one button per option, recommended first and marked, then Open session.                                            | test:tests/your-move/view.test.ts::decide: one button per option, recommended first and marked, then Open session                                     | —                | R-4           |
| AC-28 | A provide card offers Open session only.                                                                                             | test:tests/your-move/view.test.ts::provide: Open session only                                                                                         | —                | R-4           |
| AC-29 | Not for me and Already handled close the card and log separate labels.                                                               | test:tests/your-move/exit.test.ts::exit not-for-me and already-handled close the card and log separate labels                                         | —                | R-7           |
| AC-30 | A card has no × or other dismiss control.                                                                                            | test:tests/your-move/card.test.ts::renders no × and no dismiss control                                                                                | —                | R-5           |
| AC-31 | Opening the session leaves the card in the queue.                                                                                    | test:tests/your-move/card.test.ts::opening the session leaves the card in the queue                                                                   | —                | R-5           |
| AC-32 | Model-written text renders literally, never as markup.                                                                               | test:tests/your-move/card.test.ts::markup in ask, context and options renders as literal text                                                         | —                | R-1           |
| AC-33 | Cards from another project show while the sidebar is drilled into a different one, default layout.                                   | capture:/sidebar@return-here-cards-drilled                                                                                                            | —                | R-2, R-3      |
| AC-34 | The queue renders correctly with Floating panels on.                                                                                 | capture:/sidebar@return-here-cards-floating                                                                                                           | —                | R-8           |

## Amendments · Deviations

| date       | kind      | what changed                                                                                                                                                                                                                                                                                                                                                        | by           |
| ---------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| 2026-11-09 | amendment | Spec bundle lands on the integration branch feat/your-move; U1 no longer copies the design                                                                                                                                                                                                                                                                          | orchestrator |
| 2026-11-09 | amendment | AC-10 is replaced by AC-35: the judge is two gate v1 detector runs plus a separate enrichment call. Mean over 3 full runs on the frozen 200 real turns at least 57 of 62 caught, and at most 4 of 485 synthetic misses on one run; false-alarm rate recorded, not gated. Proof: record:eval-numbers-in-pr-body. The earlier bar of 59 included that run's own hits. | orchestrator |
| 2026-11-09 | amendment | S-1 files-may-touch also covers src/renderer/src/stores/ui.ts, src/main/keybindings-core.ts, tests/keybindings-core.test.ts, tests/keybindings-pane-view.test.ts, tests/keybindings-t486-table.test.ts, and this spec's Amendments table                                                                                                                            | orchestrator |
| 2026-11-09 | amendment | AC-36 added to S-1: when both detector runs report the same item, the enrichment call merges them into one card, and any candidate it does not cover is still filed. Proof: test:tests/your-move/inspector.test.ts::enrichment merging two candidates files one card                                                                                                | orchestrator |
| 2026-11-09 | amendment | AC-37 added to S-1: A store file that cannot be read is never overwritten: only a missing file opens empty, a corrupt or unknown-version file is kept aside first, and any other read error leaves it untouched. Proof: test:tests/your-move/store.test.ts::corrupt JSON is kept aside before the store opens empty                                                 | orchestrator |
| 2026-11-09 | deviation | S-3 touched six test files outside its files-may-touch: five exact-marker pins (tests/capacity-watcher-docs.test.ts, tests/containers-autopilot-actor.test.ts, tests/gc-shelve-docs.test.ts, tests/harnu-features-prefs.test.ts, tests/park-docs.test.ts) and the your_move fixture in tests/mcp-plan-input-seam.test.ts, all needed for a green suite              | executor U3  |
| 2026-11-09 | amendment | AC-23 means no agent-facing verb closes a card, and archive_session refuses a session with open cards (OPEN_CARDS); a card closing because its source resolved is the design's close rule (c), not an agent closing it. Proof added: test:tests/your-move/verb.test.ts::archive_session refuses a session with an open card                                         | owner        |
| 2026-11-09 | deviation | The archive_session refusal edits src/main/mcp/archive-session-core.ts, which S-3 files-may-touch does not list                                                                                                                                                                                                                                                     | executor U3  |
