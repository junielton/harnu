# Your move: the operator always knows when the ball is theirs

Status: draft for approval. Spike data and the frozen gate live in `.harnu/out/your-move/gate/`.

## Intent

An operator runs dozens of sessions across a dozen projects and cannot watch them. Harnu already chimes when the CLI shows a real prompt, but a session that stops on prose ("should I continue?"), buries a question under later tickets, or hands the matter to a blocker that eventually goes quiet looks the same as an idle row. The operator ends up opening sessions one by one to find out who is waiting on them.

The rule is a chess clock: when nothing moves without the operator, they know at once, on any screen, and the clock runs until they answer.

## Goals

1. Anything that only the operator can unblock becomes a **card** in a global queue, without relying on the session to remember.
2. A card explains itself: kind, what is needed, what it blocks, options, a recommendation when the session gave one, and how long it has been waiting.
3. The operator can answer from the card without opening the session, when the answer is a choice.
4. A card leaves only when the operator has dealt with it.

## Non-goals

- Blocking a session's stop. See "Decisions".
- Adapters for other CLIs (Codex, Copilot). The judge takes a tagged segment, so it can be reused, but only Claude Code transcripts are in scope.
- Replacing the Approval Inbox. Tool approvals stay there.
- Replacing Fleet rail states.

## Anti-goals (a failure even if it works)

- A session going quiet on something the operator owes. Operator's rule: being bothered for nothing is better than a session dying unnoticed. When recall and noise conflict, recall wins; a false alarm is one click on Not for me.
- A card that says "D-9 is unanswered" and forces a trip into the session to learn what D-9 is.
- A card that disappears because the operator merely looked at the session.

## Vocabulary

- **Card**: one pending item owed by the operator. A session can have several.
- **Kind**: `decide`, `go_no_go`, `provide`, `do`, `check`.
- **Segment**: every transcript entry since the session's last inspection.
- **Gate / judge**: one isolated Haiku call that reads a segment plus the session's open cards and returns `{new, update, close}`. Frozen prompt: `.harnu/out/your-move/gate/gate-v1.md`.

## How a card gets created

Three sources feed the same store. Only the second depends on a model.

| Source             | Trigger                                                                                                                                                              | Card                                                |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Structured signals | Operator-owned `mission_set_blocker`, each `youItems` entry of a mission, a parked `AskUserQuestion` or `ExitPlanMode` (tool permissions stay in the Approval Inbox) | Built directly from the record                      |
| The judge          | Every `Stop` of a main session, read from the existing observer hook                                                                                                 | From the judge's `new` array                        |
| Death              | `StopFailure`, or a process that ended mid-turn with no later turn                                                                                                   | "Session stopped: <reason>", with only Open session |

A session may also file a card itself mid-turn through a new verb, `your_move` (see "Skill and verb"). The judge receives open cards, so it updates that card instead of duplicating it.

### Judge mechanics

- Runs **after** the `Stop` hook has been answered. The bridge keeps answering 200 with no decision field, so the observer contract in `hook-installer.ts` stays true and a session is never delayed.
- Input is the transcript since a per-session cursor, not `last_assistant_message`. The cursor persists across restarts and advances only after a verdict is stored, so a crash re-inspects rather than skips.
- Tagging comes from each entry's `origin`: `{kind:"human"}` is `[OPERATOR]`, except entries starting `[Harnu ·` (dispatch prompts carry `human` but are not the operator). `peer`, `task-notification` and `external` are `[AGENT_MESSAGE]`. Tool calls are summarized.
- Invocation as in the spike: `claude -p --model haiku --effort low --no-session-persistence --setting-sources '' --strict-mcp-config --disable-slash-commands --tools ''`, run from an empty directory, with `CLAUDE_CODE_DISABLE_CLAUDE_MDS` and `CLAUDE_CODE_DISABLE_AUTO_MEMORY` set. Observed cost about US$ 0.0004 and 3.5 s per call. Concurrency is capped and at low priority.
- Long-running sessions that never reach `Stop`: also inspect when a session has accumulated new assistant text and no inspection for 5 minutes. **Untested in the spike.**
- Subagent stops are not inspected on their own. Their text reaches the parent as a message.
- A judge failure (timeout, bad JSON, auth) retries, then leaves the cursor in place and opens one card per session and failure streak, "Could not check this session", with Open session. A session Harnu cannot inspect is treated as possibly waiting. The cursor never silently advances.
- Blocked folders (`FOLDER_NOT_ALLOWED`) are never read. Archived sessions are not inspected.
- The judge's output is untrusted model text: rendered as text, never as markup.

## Card lifecycle

- Identity: judge `update` refreshes the card's `ask` and `updatedAt`, never its `openedAt`; the clock keeps running.
- Closes only when: (a) the operator clicks a card action, (b) the judge returns the id in `close` based on an `[OPERATOR]` entry, (c) the structured source is resolved (blocker cleared, approval answered), or (d) the session is archived or its folder removed.
- Agents can never close a card. Opening the session does not close it. `your_move` has no close operation.
- Cards are global, keyed by session, persisted in the main process so they survive restarts.

## The queue: extended Return here

`SidebarReturnZone.vue` is already global and outside the drill view, so it stays the home. Position and islands are unchanged, in both the default and the Floating panels layouts.

|        | Today                       | New                                                                                 |
| ------ | --------------------------- | ----------------------------------------------------------------------------------- |
| Entry  | `needs-input` only          | Any open card                                                                       |
| Timing | After 10 unviewed minutes   | Immediately                                                                         |
| Exit   | Open the session or click × | See lifecycle                                                                       |
| Row    | Name and folder alias       | Card                                                                                |
| Height | 168 px                      | Taller cap, scrolls inside (builder picks the value; it must leave the list usable) |

Card anatomy follows `.harnu/out/your-move/sidebar-options.html`: kind badge, `folder · session`, running clock, one-line ask; expanded, the context and the buttons. Oldest first. The eyebrow shows the count and the oldest clock. The selected session's cards are shown but do not chime.

All confidence levels render and sound the same. The judge's `confidence` is stored for measurement only.

Buttons per kind (`Open session` is always present):

| Kind       | Buttons                                                 |
| ---------- | ------------------------------------------------------- |
| `decide`   | One per option, recommended first and marked            |
| `go_no_go` | Go, No-go                                               |
| `do`       | Open the link when there is one, Done                   |
| `check`    | Looks right, Something's wrong                          |
| `provide`  | Open session only. A secret never passes through a card |

Every card also has two exits, neither of which tells the session anything:

- **Not for me**: a false alarm (about 3 to 5% of inspections). Logged as a labeled example.
- **Already handled**: the item was real but went moot (someone else merged the PR, the work was dropped). Logged separately, so it never pollutes the false-alarm labels.

**Answering.** An answer is typed into the session's PTY, so it is a real operator message with `origin.kind: human` (`message_session` would be tagged as a peer and is refused on operator-owned sessions). Option, Go and No-go send their visible text. Done sends a fixed "Done: <ask>", Looks right sends a fixed "Looks right: <ask>", so the session resumes. Something's wrong opens the session, because it needs detail. A parked session is woken first; a session busy mid-turn gets the answer when the turn ends. **A card closes only after the matching `UserPromptSubmit` is observed.** If delivery fails (wake timeout, process gone) the card stays open and says so. A session with no Harnu-owned process offers only Open session. Nothing is ever answered automatically.

A parked `AskUserQuestion` gets a card with Open session only, since a TUI selector cannot be answered by typing text. Tool permissions get no card: they stay in the Approval Inbox.

## Sound and reach

A new card uses the existing needs-input chime and attention path, and is pushed to remote channels the operator configured. Reminders follow the operator-blocker back-off (30 min, 1 h, 2 h, 4 h) and then repeat every 4 h: the clock must not go silent. The card itself stays until dealt with. No duplicate cue when the same item is already cued by the Approval Inbox.

## Skill and verb

- **`your_move({ folder, sessionId, kind, ask, blocks?, options?, recommended? })`**, a new MCP verb: files or refreshes a card. Runs free. ACK returns `cardId`.
- **`harnu:your-move`**, a new bundled skill: the end-of-turn test ("if the operator never comes back, does this still get done?"), the kinds, how to write a self-contained card, and when to use the verb. It improves card quality. It is not the guarantee, since bundled skills are off by default.

## Rollout

A single setting with three values, Off, Observe and Live, plus a per-folder off switch.

1. **Observe** ships first and is reachable only from that setting: the judge runs, cards are stored and listed in a debug view, no zone, no sound. Exit criterion: the maintainer reviews a week of cards and accepts the misses and the noise they find.
2. **Live** then becomes the default for every install, by operator decision. The first run shows a notice explaining that the judge spends the user's own Claude quota, about US$ 0.0004 per inspection, with a button to turn it off.

## Evidence

Measured on 2026-11-08 and 09 with the frozen v1 prompt.

| Test                                                                           | Result                                                              |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| 1024 synthetic cases, unseen seed, 28 removed by blind audit                   | 2 of 486 missed (0.4%), false alarm 27 of 510 (5.3%)                |
| Question buried under later tickets                                            | 0 of 69 missed                                                      |
| Real D-9 tick                                                                  | Correct card; updates instead of duplicating when open              |
| 200 real turns, Haiku against blind Fable, operator ruled the 22 disagreements | 62 truly pending, 59 caught (3 missed, 4.8%); 4 false in 137 (2.9%) |
| Low-confidence cards in the real sample                                        | 14 of 17 were real                                                  |
| `Stop` can be blocked in the CLI                                               | Yes, in headless mode. Not used by this design                      |

Limits: the 178 turns where both models agreed were not checked by a person, so 4.8% is a floor. Known weak spots: third-party questions quoted from PRs (9 of 37 false alarms) and two pendings in one segment reported as one (3 of 33).

## Decisions

- **Non-blocking judge instead of blocking `Stop`.** Harnu writes the card from the judge's output, so the guarantee no longer depends on the session complying. It keeps the observer contract and adds no latency or main-model turn. The cost is that an option list comes from what the session wrote rather than from a turn dedicated to it.
- **No ×.** Replaced by Not for me, which records why.
- **All confidence levels are equal**, by operator decision after seeing the real data.
- **Recall over noise**, by operator decision. Any future tuning of the gate must not trade missed items for fewer false alarms.
- **The judge is two gate v1 detector runs plus an enrichment call**, by operator decision (replaces the gate v2 schema change). `new` and `update` are the union of the two runs and `close` is the intersection; enrichment only adds fields and never reduces the cards found. See the 2026-11-09 amendments in `spec.md`.

## Details settled during review

- **Gate v2 schema.** The judge must also return `blocks`, `recommended`, a one-sentence `context` and a `link` for `do`, and `update` becomes `[{id, ask}]`. Only the output shape changes. Before merge, re-run the synthetic set and the real sample: recall must not drop below v1 (2 of 486, and 59 of 62 on real turns).
- **Mission cards are pointers.** Harnu keeps the operator's doors as they are, so a card from a blocker or `youItems` entry never writes to the mission. Its buttons are Open session and Open mission. It closes when the record stops owing the item. Its owning session is the mission owner. A child's `approvals` and `needs-input` entries file no card: the child has its own. Each `youItems` entry maps to a kind and a stable key (`missionId` plus item kind plus step or label).
- **Death.** Counts: `StopFailure` and a process that ended mid-turn. Does not count: Harnu's own quit, the operator's Ctrl+C, hibernation. A rate-limit wave files one card per session but chimes once. A later successful turn closes the card.
- **Mid-turn inspection** ships in observation mode. It goes live only if that week shows it behaves.
- **Cursor and size.** The cursor starts at the end of the transcript on first sight, so install does not judge history. Assistant text is never truncated; tool entries stay summarized. A segment too large for one call is split in order, and each part receives the open cards so far.
- **`your_move`.** Takes an optional `cardId` (returned in the ACK) to refresh; without it, files a new card and the judge reconciles duplicates. Capped per session per hour, over which it is refused and logged. `sessionId` is self-declared, as in every other verb.

## Left to the builder

Store shape and file, the debug view's form, the exact height cap, per-kind button copy (i18n in `en.json` and `pt-BR.json`), the concurrency cap (never above half the cores), and how to make the 10-minute `selectForgotten` path retire.

## Repository contracts

`design.md` §6 Return here (including Floating panels), `CHANGELOG.md`, `docs/harnu-features.md` with a version bump (new verb and skill), `docs/user/` pages, and the English policy.
