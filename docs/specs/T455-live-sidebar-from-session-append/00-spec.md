# T455 — The sidebar fed by `session.append`, identity pushed at `session.start`

**Status:** specified (not implemented) · **Date:** 2026-10-09 · **Card:** T455 · **Decision
record:** [`ADR-draft.md`](ADR-draft.md) (proposed; gets a number when merged)

Files: this spec; [`01-inventory.md`](01-inventory.md) (today's path, field by field, §3);
[`02-cost.md`](02-cost.md) (the measured cost, §8); [`03-prototype.md`](03-prototype.md) (the
prototype mod, its test, the real-engine runs, §10).

## 0. Summary

For a session it is running, Harnu learns the title, the prompts, the activity and the tool calls
the sidebar and `SessionPreview` show by tailing and re-parsing that session's JSONL transcript
through a chokidar watcher, a reader fold and a per-slug rescan. This spec moves those facts to a
**push from inside the session**: the Harnu mod (`resources/companion/`, T389) folds every row the
conversation keeps (`session.append`) into a small "compact row" and sends it to Harnu on the
existing events channel, coalesced, and at every turn boundary. Identity and lineage ride the same
channel at session start.

Six facts shape the design:

1. **`session.append` is exactly the stream the sidebar needs, and nothing more.** It fires once
   per kept row, in store order, with the row's transcript uuid (types 10566-10594; reference.md
   :137, :143). On Claude Code 2.1.296, 25 of 26 appended uuids were rows of the JSONL, in the same
   order (03-prototype.md §P.4).
2. **Loads are not appends.** A `--resume` or a fork loads its history without raising a single
   `session.append` (reference.md :137; probed). The mod seeds its fold once at `session.start`
   from `$.session.messages()`, and only when `classic.SessionStart.source` is `resume` or `fork`.
3. **The engine names no parent for a fork.** `source: "fork"` and a new id, and nothing else:
   the fork's JSONL even restamps every copied line with the new id (probed). Lineage
   (`forkedFrom`, `resumedFrom`) is therefore a **host** fact, joined from Harnu's own spawn
   record, never a mod claim.
4. **Title and "last prompt" are not conversation rows.** `custom-title`, `ai-title` and
   `last-prompt` are metadata lines no append raises. The title arrives instead as `session_title`
   on `classic.SessionStart` and on every `classic.UserPromptSubmit` (types 11648, 14668; probed
   with `--name`); the last prompt is the last `door: 'prompt'` row.
5. **A row is never re-keyed before its transcript exists** (lesson
   `synthetic-sessions/004`). Idea 110's "flip the instant the process boots" is kept as far as that
   lesson allows: the synthetic row shows the pushed facts at once and binds to the right session
   by claim; the re-key still waits for the transcript, now proven by a `stat` of the exact
   `transcript_path` the session reported instead of a slug guess.
6. **The legacy path never goes away** (T389 ARB-8, P5W1 §7.6). For a session whose new `row`
   fact family is **owned** by the mod, Harnu stops the per-append work (the watcher's offset
   read, the reader fold, the slug rescan); for every other session — mod `off` or `shadow`, lease
   lost, CLI outside the gate, started outside Harnu, cold — nothing changes.

The measured prize (02-cost.md): each append to a live transcript is read 2.6–3.1 times, and one
append in a 9,387-file project dir comes with ~2,800 opens of _other_ transcripts in that dir per
minute; append-to-reread latency is p90 215–1,484 ms. The prototype's hook costs 0.3–1.8 ms per
row in-session and sent 4 POSTs for a 26-row turn.

## 1. Origin and scope

Ideas **109** ("Sidebar preview from `session.append`, not from tailing JSONL") and **110**
("Synthetic → real session migration as a push") of the ideation report
(`.harnu/out/claude-code-mods-ideas.md`, main checkout, 2026-10-09).

**In scope:** the facts in 01-inventory.md §3.1 that a push can carry for a running, Harnu-spawned
session (title, first and last prompt, last assistant text, tool calls, user-row count, last
activity, away summary); identity, lineage and the transcript path at start and on in-session
`/clear` / `/resume`; the synthetic → real sequence; arbitration, parity and the flip; the demotion
of the per-append JSONL work for owned sessions; the Mods audit disclosure.

**Out of scope:** `transcriptState` and task state (T389 P1W5 owns them, `taskState` family);
`ctxPct` and usage (P1W6, `telemetry`); subagent rows and done-state (P1W5 `subagent.*`, T202);
cold and parked sessions (the reader stays their only source); the whole-corpus sweeps 02-cost.md
§8.4 (3) could not attribute; any change to the engine.

## 2. Conventions

- **Shipped** = code on this branch (`cb7fb58`); **specified** = only in a spec. T389's own spec
  headers still say "Specified (not implemented)" although P1W1–P1W6, P2W1, P4W1 and P4W3 landed in
  `7446534`; this spec says which, per item.
- Engine citations: "types N" is a line of `types/claude-code.d.ts` as written by Claude Code
  **2.1.295** (the `plugin-authoring` skill); "reference.md :N" is a line of that skill's
  `reference.md`. Every run used the installed CLI, **2.1.296**.
- **A-n** marks an assumption; §11 lists them with how the W0 spike checks each.
- "Owned" means the T389 sense: the family's mode is `active` for the folder, every required
  feature is proven, and the lease is live (ARB-3). T389 has three modes, `off | shadow | active`
  (`src/main/companion/mode.ts:24-32`, `arbitration-core.ts:72-81`); "legacy" is a fact _source_,
  not a mode. A session "on legacy" is any session the mod does not own.

## 3. Today

01-inventory.md is the inventory (U-1): every field, its consumers, the function and line that
derives it, the watcher's options and read windows, the migration sequence, and the board cards
(BUG-146, BUG-156, BUG-88, T123 and their neighbours). The findings that drive this spec:

- **F1** `get_fleet` reports every disk session `idle` (`claude-reader.ts:1164`).
- **F3** "what's happening", `messageCount` and branch go stale in the renderer while a session
  runs, because `fleet:changed` fires only on membership changes (`fleet-model-core.ts:257-263`).
- **F4** `modified` has two clocks (file mtime in main, receipt time in the renderer).
- **F5** a fork synthetic has no 120 s boot reaper (`stores/sessions.ts:3378-3417`).
- **F6** the hook bridge drops `last_assistant_message` and `session_title`
  (`hook-bridge.ts:162-171`).
- **F7** one append in a big project dir → ~2,800 cold opens a minute (02-cost.md §8.4).
- **F8** the `task-summary` arm of "what's happening" is dead on this CLI (0 of 400 recent
  transcripts); the subtitle is `lastPrompt` in practice.

## 4. Grounded in the engine (C-1)

Every mechanism the design relies on, with its declaration and whether a run showed it.

| Mechanism                                                                                                                          | Declared at                                                              | Shown by a run                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `session.append` fires once per kept row, before it is stored                                                                      | types 4348-4359; `SessionAppendInput` 10566-10594; reference.md :137     | yes: 26 rows for a one-tool turn (§P.4 run 1)                                                                          |
| the row's `uuid` is its transcript uuid; appends are in store order                                                                | types 10584-10588; reference.md :143                                     | yes: 25/26 uuids in the JSONL, same order; the 26th (`hook_success`, before `session.start`) is not in the file        |
| `door` names the route; `prompt` / `response` / `tool-result` / `notice`                                                           | `SessionAppendDoor` types 10556                                          | yes: one `response` row per block (`thinking`, `tool_use`, `text`)                                                     |
| `message.role`, `isMeta`, `name`, `content` blocks                                                                                 | `SessionAppendMessage` types 10603-10638                                 | yes                                                                                                                    |
| `next(e)` resolves to the row **as stored** (after any rewriting plugin)                                                           | `SessionAppendResult` types 10673-10693; reference.md :141               | yes: the prototype folds `stored.message`                                                                              |
| `agentId` marks a subagent's row                                                                                                   | types 10589-10594                                                        | kit test only (A-E5)                                                                                                   |
| loads are not appends                                                                                                              | reference.md :137                                                        | yes: a resume loaded 4 messages and appended none of them                                                              |
| `$.session.messages({ as: 'api' })` reads the loaded conversation                                                                  | types 2771, `SessionMessagesArgs` 11205-11220                            | yes (`loadedMessages` 4 on resume, 6 on fork)                                                                          |
| `classic.SessionStart`: `source` `startup \| resume \| clear \| compact \| fork`, `session_id`, `transcript_path`, `session_title` | `SessionStartHookInput` types 11643-11648; `BaseHookInput` 826-829       | yes, for `startup`, `resume`, `fork`; it dispatches **before** `session.start`                                         |
| `classic.UserPromptSubmit.session_title`                                                                                           | types 14661-14669                                                        | yes, with `--name`, fresh and resumed                                                                                  |
| `$.session.id()` is the transcript file's name                                                                                     | types 2794-2796                                                          | yes, new / resume / fork                                                                                               |
| `/clear` ends the conversation and fires **no** `session.start`                                                                    | `SessionEndInput` types 11049-11067 (11053-11056); reference.md :27      | kit test only (A-E4); the shipped mod handles it with `classic.SessionStart{source:'clear'}` (`register.ts:1154-1170`) |
| `turn.complete` carries `answer`, `agentId` absent on main                                                                         | `TurnCompleteFields` types 13276 (`answer` 13285)                        | yes                                                                                                                    |
| `Stop.last_assistant_message`                                                                                                      | `StopHookInput` types 12117-12123                                        | not run (used only as the parity twin, §7.3)                                                                           |
| coalescing timer: `$.clock.after(ms, fn)` → `Timer.cancel()`                                                                       | types 3448-3454, `TimerCall` 12626, `Timer` 12615; reference.md :158-161 | yes (kit `mock.clock` and the real run)                                                                                |
| transport: `$.http.fetch` over a Unix socket                                                                                       | types 3490; shipped in `register.ts:250-290`                             | shipped (T389 P1W3); the prototype POSTed over TCP to a local sink                                                     |
| per-session state that survives a module reload                                                                                    | `$.state`, contract `PluginState`; reference.md "`$.state` contracts"    | kit test ("a reload keeps the fold")                                                                                   |
| guarded hook that fails open                                                                                                       | `.catch(($, e, next) => next(e))`; reference.md :79                      | `claude plugin validate` lists it as a "gating hook with .catch"                                                       |
| test kit: `mock.clock`, `mock.env`, `mock.session`, raising an engine row                                                          | types 15453, 15468, 15470-15480, `MockSession` 15553                     | 7 tests pass, 2 mutations caught (§P.2)                                                                                |

Run artefacts: 03-prototype.md §P.2 (`claude plugin validate`, `claude plugin test`, `tsc -p`),
§P.3 (the prototype in a real session against a local sink), §P.4 (four probe sessions).

## 5. Delta against T389 (U-2, C-2)

### 5.1 What T389 already pushes, and what it does not

| T389 wave                       | Status                                 | What it gives T455                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1W1 host server, rendezvous    | shipped                                | the channel: HTTP over `<userData>/companion/c.sock`, `POST /v1/{hello,events,poll,ask,bye}` (`rendezvous.ts:22-30`, `contract.ts:136-152`)                                                                                                                                                                                                                                                             |
| P1W2 mod skeleton, test harness | shipped                                | the rig T455's tests extend (`resources/companion/tests/support/rig.ts`)                                                                                                                                                                                                                                                                                                                                |
| P1W3 handshake and identity     | shipped, family `identity` in `shadow` | `hello { sid, spawn, cwd, … }` (`contract.ts:164-177`; built at `register.ts:529-541`), `session.rebound { prevSid, sid, cause: 'clear' \| 'resume' \| 'unknown' }`, claims (`identity-core.ts`), `bindByClaim` (`stores/sessions.ts:5134`). **No lineage, no transcript path, no title on the wire.** Lineage shape is inferred on the host from the PTY's spawn kind (`identity-adapter.ts:101-110`). |
| P1W4 arbitration and rollout    | shipped                                | families, modes, ramp, lease, parity ledger and gate arithmetic (`arbitration-core.ts`, `parity-core.ts:196-242`). Closed `FactFamily` union with no row family.                                                                                                                                                                                                                                        |
| P1W5 fleet state                | shipped, `taskState` in `shadow`       | `turn.started` / `turn.completed`, `attention.*`, `subagent.*`. **No tool count, no activity time, no text** (`fleet-sensor.ts:9-10`).                                                                                                                                                                                                                                                                  |
| P1W6 telemetry                  | shipped, `telemetry` in `shadow`       | `usage.measured` (context %, tokens, cost). No text, no tool count.                                                                                                                                                                                                                                                                                                                                     |
| P2W2 start prompt               | specified                              | the rule that a plugin-origin row is never a first prompt, a last prompt or a title (`P2W2-start-prompt.md:336-351`). T455's fold applies it.                                                                                                                                                                                                                                                           |
| P2W4 live contract and guard    | specified                              | `plugin-meta` rows are never a first prompt, a title or a turn (`P2W4-live-contract-and-guard.md:20-22`).                                                                                                                                                                                                                                                                                               |
| P4W1 Mods audit                 | shipped                                | the chips (`mods-audit-core.ts:370-393`); T455 adds one (§10.3).                                                                                                                                                                                                                                                                                                                                        |
| P4W3 outside Harnu              | shipped, `external` off                | the tokenless claim and corroboration (`external-corroboration.ts`); "the companion never creates a sidebar row" (`01-contract.md:1310-1311`). T455 keeps that rule.                                                                                                                                                                                                                                    |
| P4W5 compaction digest          | specified                              | `compact.done.summary` — unrelated to the row; T455 does not use it.                                                                                                                                                                                                                                                                                                                                    |
| P5W1 legacy retirement          | specified                              | keeps the transcript watcher forever (§7.6, `P5W1-legacy-retirement.md:269`). T455 is **new scope**: it demotes per-append work for owned sessions and deletes nothing.                                                                                                                                                                                                                                 |
| reserved `turn.progress`        | reserved, no owner                     | coalesced `turn.step` liveness (`01-contract.md:1194`). T455 does not hook `turn.step`.                                                                                                                                                                                                                                                                                                                 |

**T447 `$.harnu` (PR #41, not merged).** A different direction: third-party mods _calling_ Harnu
through MCP. T455 is a sensor pushing _to_ Harnu over the companion channel, which T447 itself
records as host → mod only for commands and mod → host for events (its §0, fact 3). No overlap in
code. A later `$.harnu` method could expose the compact row read-only from the companion's
`$.state` key `row` (§5.3), the same way T447 reads identity; not specified here.

### 5.2 What T455 adds, fact by fact

| Fact (sidebar / preview / `get_fleet`)            | Produced by (mod step)                                                          | Wire                                                      | Rate                                  | Legacy twin for parity (§7.3)                                |
| ------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------ |
| `firstPrompt`                                     | `session.append` `door: 'prompt'`, main loop, not `isMeta`; seed on resume/fork | `session.row.firstPrompt`                                 | coalesced (§5.4)                      | head fold `firstRealPrompt` (`claude-reader.ts:601-612`)     |
| `lastPrompt` (the "what's happening" subtitle)    | same rule, latest                                                               | `session.row.lastPrompt`                                  | coalesced                             | the CLI's `last-prompt` line (`transcript-truth.ts:238-241`) |
| `lastAssistant` (new in the preview)              | `door: 'response'`, `role: 'assistant'`, main loop, latest non-empty text       | `session.row.lastAssistant`                               | coalesced; flushed at `turn.complete` | `Stop.last_assistant_message` (hook bridge, F6)              |
| title                                             | `classic.SessionStart` / `classic.UserPromptSubmit` `session_title`             | `hello.title`, then `session.row.title`                   | per prompt                            | `customTitle \|\| aiTitle` (`claude-reader.ts:1157`)         |
| tool calls (preview tally, stagnation, stuck dot) | `tool_use` blocks of main-loop `response` rows; subagents' counted apart        | `session.row.toolCalls`, `subagentToolCalls` (cumulative) | coalesced                             | `stall-detect.ts` 5-min window (`:21`, `:76-103`)            |
| `messageCount`                                    | main-loop rows with `message.type === 'user'` (tool results included)           | `session.row.userRows`                                    | coalesced                             | `userMessageCount` (`claude-reader.ts:601-602`)              |
| last activity (`modified`, `status`)              | the time of the last folded row                                                 | `session.row.lastRowAt` (mod clock, ms)                   | coalesced                             | file mtime (`claude-reader.ts:1160`)                         |
| `awaySummary`                                     | `door: 'notice'`, `name: 'away_summary'`                                        | `session.row.awaySummary` (only when it changed)          | rare                                  | `extractAwaySummary` (`transcript-truth.ts:272-287`)         |
| transcript path                                   | `classic.SessionStart.transcript_path` (and on every classic hook)              | `hello.transcriptPath`; `session.rebound.transcriptPath`  | once per conversation                 | the watcher's `add` path                                     |
| start source                                      | `classic.SessionStart.source`                                                   | `hello.source`                                            | once                                  | the PTY spawn kind (`identity-adapter.ts:106-108`)           |
| `forkedFrom`, `resumedFrom`                       | **not the mod**: Harnu's spawn record for the PTY that carried the token        | host-side field of the identity claim                     | —                                     | `forkSourceId` (`stores/sessions.ts:3406`)                   |

### 5.3 Wire shape (additive; protocol stays `v: 1`)

Additions to `resources/companion/hooks/contract.ts` and contract §8 / §11 / §22. An additive event
type, optional field or feature id does not bump `v` (`01-contract.md:1112-1115`). Contract §8 says
payloads carry no prompt text "unless the payload type above names the field"
(`01-contract.md:678-681`); these are named fields, and §8's exception list gains them.

```ts
// HelloRequest (contract.ts:164-177) gains three optional fields, filled from the
// classic.SessionStart step, which dispatches before session.start (probed):
interface HelloRequest {
  // ...shipped fields...
  /** classic.SessionStart.source; absent when no classic hook ran before the hello. */
  source?: 'startup' | 'resume' | 'clear' | 'compact' | 'fork'
  /** classic hooks' transcript_path: the exact file the CLI writes; ≤ 4,096 chars. */
  transcriptPath?: string
  /** classic.SessionStart.session_title; ≤ 240 chars. */
  title?: string
}

interface EventPayloads {
  // ...shipped events...
  /** session.rebound gains the new conversation's file. */
  'session.rebound': {
    prevSid: Sid
    sid: Sid
    cause: 'clear' | 'resume' | 'unknown'
    transcriptPath?: string
  }
  /**
   * Feature `sense.identity`. Sent once after a hello that went out without the classic facts
   * (a reload, a racing hook): the same three fields, so the host never waits on them.
   */
  'session.identified': {
    source: 'startup' | 'resume' | 'clear' | 'compact' | 'fork' | null
    transcriptPath: string | null
    title: string | null
  }
  /**
   * Feature `sense.row`. A snapshot, not a delta: the newest replaces the last, so a lost or
   * coalesced one costs nothing. Main loop only, except `subagentToolCalls`.
   */
  'session.row': {
    /** The fold's rule version; parity compares like with like. */
    fold: 1
    firstPrompt: string | null // ≤ 240 chars, whitespace collapsed
    lastPrompt: string | null // ≤ 240
    lastAssistant: string | null // ≤ 240
    title: string | null // ≤ 240, latest session_title
    toolCalls: number
    subagentToolCalls: number
    userRows: number
    /** Epoch ms of the last folded row, the mod's clock. */
    lastRowAt: number | null
    /** The uuid of the last folded row: aligns the push with the transcript for parity. */
    lastUuid: string | null
    /** Present only when it changed since the last `session.row`; ≤ 8,192 chars. */
    awaySummary?: string
  }
}
```

Mod-side registry: `EVENT_FEATURE['session.row'] = 'sense.row'`,
`EVENT_FEATURE['session.identified'] = 'sense.identity'` (`register.ts:84-101`); `COALESCABLE`
gains `'session.row'` (`ring.ts:13`); `declared` gains `sense.row` when the `session.append` step
registered (`register.ts:1350-1391`); `$.state` key `row` (the fold, read back after a reload, as
`fleet` is: `types/index.d.ts:23-47`); `api-surface.json` gains the `session.append` and
`classic.UserPromptSubmit` hooks and the `session.messages` call.

Host-side: `wire-core.ts` field caps (above) on top of the 1 MiB body cap; `registerEventTypes`
for `session.row` and `session.identified` in a new `src/main/companion/ingest/row-adapter.ts` and
the identity adapter; `registerFeaturePolicy('sense.row', …)` enabled while the `row` family's
mode is not `off`. Unknown fields stay ignored (`01-contract.md:682`).

### 5.4 Rate limits and coalescing

The shipped pump has no flush timer: every `emit` pumps at once, batching only while a POST is in
flight (`register.ts:655-675`; `flushMs` is declared and unread). `session.row` brings its own:

| Rule                                                                                           | Value                                                                                                  |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| trailing debounce after a row changed a field (`$.clock.after`)                                | 500 ms (`ROW_DEBOUNCE_MS`)                                                                             |
| maximum wait during a long stream of rows                                                      | 2,000 ms (`ROW_MAX_WAIT_MS`)                                                                           |
| immediate flush                                                                                | main-loop `turn.complete`; `session.start`; after hello and on `resync` (the snapshot is re-sent)      |
| rows that change nothing (attachments, hook context, tool results past the count) send nothing | probed: 26 rows → 4 events                                                                             |
| ring overflow                                                                                  | `session.row` is coalescable: newest wins                                                              |
| ceiling per binding                                                                            | ≤ 2 events/s steady; the host's 200 requests / 10 s bucket (`wire-core.ts:246-279`) is never the limit |
| payload                                                                                        | ≤ ~1.5 KB typical (four 240-char texts), ≤ ~10 KB with an away summary                                 |

The fold is O(blocks of the row) and runs after `next(e)`, on the stored row; measured settle
0.3–1.8 ms per row including the worker hop (03-prototype.md §P.3).

## 6. Synthetic → real (U-4)

The rule of lesson 004 stays: **nothing re-keys a row but proof that its transcript exists on
disk**. What changes is (a) who binds — the claim, for every Harnu-spawned session with an acting
`identity` family, instead of folder guesses; (b) what the proof is — a `stat` of the exact
`transcript_path` the session reported, in addition to the watcher's `add`; (c) what the row shows
before the proof — the pushed facts, keyed by the synthetic id.

### 6.1 New session (`claude-new`)

| Step | Today (01-inventory.md §3.4)                                                                                             | With T455 (`identity` and `row` owned)                                                                                                                                                                                                                      |
| ---- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `createNewSession` mints `synthetic-<uuid>`, arms the 120 s reaper                                                       | unchanged                                                                                                                                                                                                                                                   |
| 2    | PTY spawns with `HARNU_SPAWN_TOKEN`                                                                                      | unchanged                                                                                                                                                                                                                                                   |
| 3    | (mod) hello `{sid, spawn}` → claim, recorded only                                                                        | `classic.SessionStart` step stores `{source:'startup', transcriptPath, title}`; hello carries them. The claim gains `transcriptPath` (validated: realpath under `~/.claude/projects/`, basename `<sid>.jsonl`, else dropped) and `lineage: { kind: 'new' }` |
| 4    | —                                                                                                                        | `session.row` snapshots arrive keyed by the binding; the renderer applies them to the claim's `key` — **the synthetic row** — so label, subtitle and tool tally move from the first prompt on. No re-key.                                                   |
| 5    | the first prompt makes the CLI write the transcript; the watcher's `add` reads the whole file → `session:added`          | **either** the watcher's `add` **or** main's `stat(transcriptPath)` (run on each `session.row` until it succeeds, at most every 2 s) emits the proof. The `add` path no longer reads the whole file for a claimed path: the facts are pushed.               |
| 6    | `reconcileSessionAdded`: claim, slug guess, re-home, 10 s correlation, newest-synthetic recency, 5-min `pendingCollapse` | `bindByClaim` (`stores/sessions.ts:5134-5169`) — the existing migration (`migrateSyntheticInPlace`, `fireMigrate`, PTY re-key) — and nothing else is consulted for that row                                                                                 |
| 7    | `backfillMigratedSessionMeta`: a full `foldersLoad` (`:4967-4989`)                                                       | **skipped** for a claimed row: its facts are already there. One header read of the one file fills `fullPath`, `created`, `gitBranch`.                                                                                                                       |
| 8    | Haiku auto-name from the delta's `firstPromptCandidate`                                                                  | from the pushed `firstPrompt`, at the first `session.row` that carries one (no wait for disk)                                                                                                                                                               |

A session that never gets a prompt never writes a transcript: its row stays synthetic with live
facts, is never parked (hibernation parks `claude-resume` only, and the PTY is promoted to that
kind only by the re-key — lesson 004), and the 120 s boot reaper applies exactly as it does today.

### 6.2 Resume (`claude --resume <id>`)

A real row from the start; probed: the same id, the same file, `source: 'resume'`. Hello sends
`source: 'resume'` and `transcriptPath`; the claim is `confirmed` (`key === sid`,
`identity-core.ts:33`). The mod seeds its fold from `$.session.messages()` (loads are not appends)
and sends one full `session.row` before the first prompt, so the row is exact on wake with no
JSONL read. `lineage: { kind: 'resume', from: <id> }` comes from the spawn record.

### 6.3 Fork (`--resume <src> --fork-session`)

| Step | Today                                                                                                                           | With T455                                                                                                                                                                                                                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `createForkedSession`: no dedupe, **no boot reaper** (F5)                                                                       | arms `armAgentBootDeadline` like every other synthetic (fixes F5)                                                                                                                                                                                             |
| 2    | spawn in the source's first-line cwd                                                                                            | unchanged                                                                                                                                                                                                                                                     |
| 3    | the new id's JSONL lands in the cwd's slug; route 1 resolves it through the source's `fullPath`, then the newest-synthetic pick | hello `{ sid: <new>, source: 'fork', transcriptPath }`. The host joins `lineage: { kind: 'fork', from: <src> }` from the PTY's spawn record (`pty.ts:743-752` holds `<src>`); the mod's word is never asked for it. Binding by claim; **no cwd → slug guess** |
| 4    | `forkSourceId` lives in the renderer and is cleared on migration (`:5058`)                                                      | `forkedFrom` is a fact of the claim, kept on the real row after migration; `get_session` can report it (§12, W3)                                                                                                                                              |
| 5    | the `add` reads the whole fork transcript (it holds the copied history)                                                         | the mod seeds from the 6 loaded messages (probed) and pushes; the `add` of a claimed path reads nothing                                                                                                                                                       |

### 6.4 In-session `/clear` and `/resume`

Shipped: `classic.SessionStart{source:'clear'|'resume'}` with a new `session_id` →
`session.rebound` → claim (`register.ts:1154-1170`, `identity-adapter.ts:260-269`). T455 adds
`transcriptPath` to the rebound, resets the fold on `clear` (the kit test "a /clear starts a fresh
fold under the new id"), seeds it on `resume`, and sends a snapshot. The PTY moves when the new
transcript's proof arrives — by `stat` or by the watcher — exactly as `bindByClaim`'s non-synthetic
branch does today (`stores/sessions.ts:5157-5168`).

### 6.5 What can be deleted, and what must stay

| Item                                                                                                                                                | Verdict                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the post-migration full `foldersLoad` for a claimed row (`stores/sessions.ts:4967-4989`)                                                            | **removed for claimed rows** (W4); kept for every other migration                                                                                          |
| whole-file read on `add` of a claimed path (`claude-watcher.ts:1115`, `:1133`)                                                                      | **skipped for claimed paths** (W4); kept otherwise (entrypoint classification of unclaimed files)                                                          |
| the slug pass triggered by an owned session's append (`fleet-model.ts:173-192`)                                                                     | **skipped** (W4); kept for every unowned append                                                                                                            |
| `forkSourceId` in the renderer                                                                                                                      | replaced by the claim's `lineage.from`; deletable after W6                                                                                                 |
| the `taskSummary` arm of `pickWhatsHappening`                                                                                                       | dead on this CLI (F8); a separate cleanup, not T455's                                                                                                      |
| cwd → slug route 2, cross-slug re-home, 10 s correlation, newest-synthetic recency, `pendingCollapse`, creation-time window, rename-delta promotion | **must stay**: they serve `off` / `shadow`, a lost lease, a CLI outside the gate, Harnu-less sessions and the external profile (lesson 004 "How to apply") |
| the transcript watcher, `transcript-truth.ts`, `stall-detect.ts`, the reader                                                                        | **must stay** (ARB-8): cold, parked and outside sessions, and the catch-up after a lease loss (§7.4)                                                       |
| BUG-77's filter of Harnu's own `claude -p` probes                                                                                                   | must stay                                                                                                                                                  |

## 7. Arbitration and parity (U-3)

### 7.1 A new fact family: `row`

`FactFamily` (`mode.ts:24-32`) gains `row`; `FAMILY_FEATURES.row = ['sense.identity',
'sense.row']` (row facts are keyed by the binding identity proves); `DEFAULT_FAMILY_MODE.row =
'shadow'` (`arbitration-core.ts:60-81`). ARB-2's "one writer per (session, family)" is applied per
**field group**, as telemetry already is:

| Group       | Fields                      | Legacy writer it replaces                                          |
| ----------- | --------------------------- | ------------------------------------------------------------------ |
| `prompt`    | `firstPrompt`, `lastPrompt` | head fold `firstPrompt`; tail `last-prompt` → "what's happening"   |
| `title`     | `title`                     | `custom-title` / `ai-title` lines                                  |
| `tools`     | `toolCalls`                 | `stagnation.calls`                                                 |
| `count`     | `userRows`                  | `userMessageCount`                                                 |
| `activity`  | `lastRowAt`                 | file mtime; the renderer's receipt clock; main's hard-coded `idle` |
| `recap`     | `awaySummary`               | `extractAwaySummary`                                               |
| `assistant` | `lastAssistant`             | none shown today (a new preview line)                              |

A group joins ownership only when it is listed in `ROW_OWNED_GROUPS`, a constant the flip PR edits
once that group's gate passes (§7.3). The per-append work of §6.5 stops for a session only when
**every** group the legacy path would otherwise refresh is owned (`prompt`, `title`, `tools`,
`count`, `activity`, `recap`); until then the watcher keeps tailing it and only the owned groups'
legacy values are dropped (ARB-2b).

### 7.2 Mode by mode

| State of the session                                                                                        | What Harnu shows                                                     | Per-append JSONL work                             |
| ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------- |
| no mod (kill switch, CLI below 2.1.287 or untested, disclosure not shown, `claude` outside Harnu, P4W3 off) | exactly today's                                                      | exactly today's                                   |
| `row` = `off`                                                                                               | exactly today's; `sense.row` not enabled, so the mod emits nothing   | exactly today's                                   |
| `row` = `shadow` (the shipped default)                                                                      | exactly today's; the host records each push against the legacy value | exactly today's                                   |
| `row` = `active`, owned groups listed, lease live                                                           | owned groups from the push; the rest legacy                          | stopped only when every refreshing group is owned |
| lease lost, proof failed, or the session ended                                                              | legacy wins, sticky for the session (ARB-4b)                         | resumes, after one catch-up (§7.4)                |

### 7.3 Parity: what is measured to decide each flip

The host keeps computing the legacy value in `shadow` (the watcher runs anyway) and, at every
`turn.completed` of the main loop (P1W5), writes one parity record per group into a new ledger
stream `row` (`<userData>/companion/parity/row.ndjson`, the scrubbed format of
`parity-core.ts:62-68`: salted sid hash, no text — texts are compared, never stored; the record
holds equal / differs plus lengths). The match window is the same −10 s / +2 s as
`parity-taskstate-rule.ts`. Both sides of a text are compared after the one normalizer the
renderer uses (`firstRealPrompt`, `claude-reader-derive.ts:47-55`), so a 120 vs 240 cap is not a
divergence.

| Group       | Compared at turn end                                                                    | Explained divergence classes (never count against the gate)                                                                                     |
| ----------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt`    | pushed `lastPrompt` vs the newest `last-prompt` line; pushed `firstPrompt` vs head fold | E-HEAD: legacy frozen at the 2 MB head cap; E-ORIGIN: a machine-origin prompt row (A-P1); E-LOAD: a resumed session before its first new prompt |
| `title`     | pushed `title` vs `customTitle \|\| aiTitle`                                            | E-AITITLE: an `ai-title` not yet in `session_title` (A-T2)                                                                                      |
| `tools`     | calls in the trailing 5 min from push samples vs `stall-detect` on the tail             | E-TAIL: legacy tail window shorter than 5 min of activity; E-SUBAGENT: rows with `agentId`                                                      |
| `count`     | `userRows` vs `userMessageCount`                                                        | E-HEAD; E-LOAD (legacy counts loaded rows; the seed counts the API form)                                                                        |
| `activity`  | `lastRowAt` vs file mtime                                                               | \|Δ\| ≤ 2,500 ms is a match (append cadence plus window)                                                                                        |
| `recap`     | `awaySummary` equality                                                                  | —                                                                                                                                               |
| `assistant` | pushed `lastAssistant` vs the Stop hook's `last_assistant_message` (bridge body, F6)    | E-STOPLESS: a turn with no Stop (interrupt, error)                                                                                              |

**The ai-title trade-off.** Once every refreshing group is owned, the watcher stops reading the
owned transcript, so an `ai-title` line the CLI writes mid-session reaches the label only through
`session_title` on the next prompt (A-T2) or, if A-T2 is false, when the session leaves ownership
(§7.4). Meanwhile the label falls back as today: Haiku `aiSummary`, then `firstPrompt`
(`session-label.ts:49-51`). A custom title (`--name`, `/rename`) is not affected (probed for
`--name`; A-E3 for `/rename`).

**The flip.** Per group, `gateStatus` (`parity-core.ts:229-242`) must pass with the
`TASK_STATE_GATE` thresholds (`parity-taskstate-rule.ts:34`: ≥ 200 sessions, ≥ 5,000 facts, zero
unexplained divergences) **and** a corpus covering ≥ 20 resumes, ≥ 10 forks, ≥ 5 `/clear`, ≥ 20
sessions with subagents and ≥ 10 transcripts past the 2 MB head cap. The identity flip keeps its own
P1W3 gate (bind rate ≥ 97 %, `helloAfterSpawnMs` p95 < 2,000, `P1W3-handshake-identity.md:744-767`)
and must pass first: `row` requires `sense.identity`. Each flip is its own PR that edits
`ROW_OWNED_GROUPS` or `DEFAULT_FAMILY_MODE`, after the operator confirms (ARB-6, P1W4:694-695).
The **performance** gate for the last flip (W6) re-runs the 02-cost.md scripts at comparable load
and must show: ≤ 1 open per append of an owned transcript, zero cold opens following an owned
session's append, and the main-process read syscalls/s and CPU before and after, reported.

### 7.4 Leaving ownership

On lease loss, a failed proof or a sticky reversion, the host runs **one** incremental read of the
owned transcript from the reader's last fold position (or a fresh head + tail scrape if the fold
was evicted, `claude-reader.ts:954`), so the row is exact the moment legacy takes over. A session
end does the same, which is what keeps a cold row identical to today's.

## 8. Cost (U-5)

02-cost.md has the method, the scripts, every window's raw numbers, and what they do and do not
show. Headline, measured 2026-10-09 on the operator's machine with 28 live sessions and a
10.8k-transcript corpus:

| Measured today                                              | Value                                                | Target after T455 (W6 re-measures)               |
| ----------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------ |
| opens per append of a live transcript                       | 2.6–3.1                                              | ≤ 1 for owned sessions                           |
| cold opens per minute following appends in a 9,387-file dir | 2,790–2,806 (3 of 3 windows with appends; 0 without) | 0 for owned sessions                             |
| append → next reread                                        | p50 ≤ 1 ms, p90 215–1,484 ms, max 6.4 s              | push ≤ 500 ms after the change, ≤ 2 s worst      |
| Harnu main CPU / context switches                           | 8.7–17.6 % / 1,977–3,887 per s                       | reported, not promised (not the live path alone) |
| in-session cost added (prototype)                           | —                                                    | 0.3–1.8 ms per row; 4 POSTs per 26-row turn      |

## 9. Packaging (C-3)

**Decision: inside the existing Harnu mod (`resources/companion/`), plus host code in
`src/main/companion/` and the renderer store.** Recorded in ADR-draft.md.

- The facts exist only inside the `claude` process; main-process code alone cannot produce them.
- They need everything the companion already has and a new mod would have to duplicate: the spawn
  token that ties a session to Harnu's row, the rendezvous and socket, the lease, the feature
  negotiation, the parity ledger, the external profile. Two mods on one channel would also break
  MOD-4 (one `on()` per event and matcher, `docs/dev/companion-mod.md:48-61`) for `session.start`,
  `classic.SessionStart` and `turn.complete`, which T455 extends as steps.
- Widening the hook bridge alone (the legacy hooks already deliver `session_title`, the prompt and
  `last_assistant_message`, F6) was considered: it covers title, last prompt and last assistant
  text at turn granularity with no mod, but not the tool count, the row count, activity time, the
  away summary, the transcript path or the load seed. It is kept as a cheap improvement to the
  legacy path (open question Q4), not as the design.
- **A session started outside Harnu** gets the mod only through P4W3's opt-in install. Its hello
  is tokenless and its profile is `external` (`feature-policy.ts:50-59`). v1 leaves `sense.row` out
  of `EXTERNAL_ALLOWED`: an outside session keeps today's watcher-created row and JSONL facts
  (Q3). With no Harnu running at all the mod's hello fails, it backs off (0.5 s → 15 s), `emit`
  drops everything (`register.ts:201`), and the fold costs only its in-process time.

## 10. Control and failure (C-4)

### 10.1 Turning it on and off

| Control                                       | Where                                                           | Default                   |
| --------------------------------------------- | --------------------------------------------------------------- | ------------------------- |
| the Harnu mod as a whole (kill switch)        | `companion-prefs.json` `enabled`, Settings → Mods               | on (after the disclosure) |
| the `row` family: `off` / `shadow` / `active` | `companion-prefs.json` `families.row`                           | `shadow`                  |
| which groups `active` owns                    | `ROW_OWNED_GROUPS` in code, moved by flip PRs                   | none                      |
| per-folder ramp                               | `projects.json` `companionActive` (`companion:setFolderActive`) | off (`allFolders: false`) |

There is no per-family UI today (`companion-ipc.ts:170-229` exposes only the kill switch, the ramp
and the external key); T455 does not add one (Q2).

### 10.2 When it fails

- **In the session: fail open, always.** The `session.append` step calls `next(e)` first and folds
  the stored row after; its registration carries `.catch(($, e, next) => next(e))`, so a throw
  replays what `next` settled and never refuses or delays the row beyond the step itself
  (reference.md :79). Every other step sits inside the existing `sense()` wrapper that reports
  `mod.error` and drops the feature (contract §11.2). A seed that fails leaves the fold empty until
  the next prompt; the host then sees `E-LOAD` divergences, never wrong data.
- **On the wire:** a lost or coalesced `session.row` is harmless (snapshots); a ring overflow keeps
  the newest (§5.4); a `resync` re-sends one.
- **On the host: fail to legacy.** A malformed `session.row` (a field over its cap, a wrong type)
  is counted and dropped; three in a binding revoke `sense.row` for it (`revoked`,
  `arbitration-core.ts:113-135`) and legacy wins for the session. An invalid `transcriptPath` is
  dropped and the watcher's `add` remains the only proof.

### 10.3 What Settings → Mods shows

Today, hooking `session.append` adds no chip: `deriveCapabilities` has no rule for any
`session.*` event (`mods-audit-core.ts:370-393`). That under-discloses: the hook reads every row of
the conversation, responses and tool results included, which "can read every prompt" does not say.
T455 adds a chip **`transcript`** — label "can read the conversation" — shown for a hook on
`session.append` or `session.compact`, or a call to `session.messages`. With it, the Harnu mod's
row shows (inferred from `api-surface.json`, to be checked against the real audit in W5): prompts,
**transcript**, permissions, network, files, env, gate. Every third-party mod that hooks those
events gets the same chip.

## 11. Assumptions the W0 spike checks first

| Id   | Assumption                                                                                                                           | How W0 checks it                                                                                            |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| A-E1 | An interactive session raises the same doors, order and uuids as the `-p` runs                                                       | the probe loaded with `--plugin-dir` in an interactive scratch session                                      |
| A-E2 | `classic.SessionStart` precedes `session.start` interactively too (the companion's own comment says so)                              | same run                                                                                                    |
| A-E3 | a mid-session `/rename` reaches the next `classic.UserPromptSubmit.session_title`                                                    | same run, `/rename` then a prompt                                                                           |
| A-T2 | an `ai-title` reaches `session_title`                                                                                                | same run, after the CLI writes `ai-title`; if not, the `title` group keeps legacy for ai-titles (E-AITITLE) |
| A-E4 | a live `/clear` is `classic.SessionStart{source:'clear'}` with the new id and its `transcript_path`                                  | same run                                                                                                    |
| A-E5 | a subagent's rows carry `agentId` and its `tool_use` blocks are the subagent's                                                       | same run with one Agent call                                                                                |
| A-P1 | `door: 'prompt'` rows that are not typed by the person (task notifications, auto-continuation) are `isMeta` or need an origin filter | parity `E-ORIGIN` counts; W0 lists `origin.kind` of every prompt row (types 8865)                           |
| A-M1 | a `claude` process never reads its own transcript after boot                                                                         | `fdattr.py` on the spike's own sessions                                                                     |
| A-M2 | the ~2,800 cold opens per append are the slug pass's header scrapes                                                                  | expose `claude-reader.ts`'s `fileOpens` / `jsonlBytesRead` counters in a debug build and re-run 02-cost.md  |
| A-H1 | main's `stat(transcriptPath)` sees the file no later than the watcher's `add`                                                        | log both times for 50 new sessions                                                                          |

## 12. Implementation outline (C-6)

| Wave | Size | Depends on   | Content                                                                                                                                                                                                                                                                                                                                                                                                            | Contracts owed                                                                                                                                                                      |
| ---- | ---- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W0   | S    | —            | Spike: §11, the 02-cost.md baseline re-run, and a decision on A-M2 (if the cold opens are a reader bug, file it as its own bug: it costs every session, owned or not)                                                                                                                                                                                                                                              | none (scratch only)                                                                                                                                                                 |
| W1   | M    | W0           | Mod half in `resources/companion/`: `hooks/lib/row-fold.ts` (pure, the prototype's `row.ts` plus `title`, `userRows`, `lastRowAt`, `awaySummary`), the `session.append` hook, steps in `classic.SessionStart`, `classic.UserPromptSubmit` (new), `session.start`, `turn.complete`, the coalescer, the seed, `$.state` key `row`, hello fields, `session.identified`, `api-surface.json`, golden traces in `tests/` | `docs/dev/companion-mod.md`; T389 `01-contract.md` §8, §11.1, §22                                                                                                                   |
| W2   | M    | W1           | Host ingest in shadow: `wire-core.ts` caps, `ingest/row-adapter.ts`, feature policy, `FactFamily` `row`, the `row` parity stream and its rules (§7.3), claim `transcriptPath` + `lineage` (spawn record join), the `stat` proof                                                                                                                                                                                    | CHANGELOG only if visible (it is not, in shadow)                                                                                                                                    |
| W3   | M    | W2           | Renderer and MCP in `active`: apply `companion:row` to the claim's key; preview shows `lastAssistant`; `get_fleet` `status` / `modified` from the push for owned sessions (fixes F1, F4 for them); `get_session` adds `forkedFrom` / `resumedFrom`                                                                                                                                                                 | CHANGELOG; `design.md` §6 (the preview's new line) + `en.json` / `pt-BR.json`; `docs/harnu-features.md` (get_fleet/get_session semantics) + marker bump; `docs/user/` (the preview) |
| W4   | M    | W3           | Demotion for owned sessions: watcher `change` and `add` reads skipped for owned paths, no slug pass on their appends, no full backfill for claimed rows, catch-up on leaving ownership (§7.4), fork boot reaper (F5)                                                                                                                                                                                               | CHANGELOG (fix F5; faster sidebar)                                                                                                                                                  |
| W5   | S    | — (any time) | Mods audit chip `transcript` (§10.3)                                                                                                                                                                                                                                                                                                                                                                               | CHANGELOG; `en.json` / `pt-BR.json` `modsAudit.cap.transcript`; `design.md` if the chip list is enumerated there; `docs/user/` (the Mods page)                                      |
| W6   | S    | W4 + gates   | Flip PRs: `identity` (its P1W3 gate) then `row` groups one by one; the performance gate (§7.3)                                                                                                                                                                                                                                                                                                                     | CHANGELOG per flip; `docs/user/` if behaviour the user sees changes                                                                                                                 |

Every wave keeps the T389 authoring rules: steps inside existing `on()` bodies, `$` passed only to
top-level functions, no `turn.step`, no `'*'` matcher (`docs/dev/companion-mod.md:48-61`).

## 13. Open questions

| #   | Question                                                                                                                                                                                                                         | Who decides                      |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Q1  | Is pushing prompt and assistant text (240 chars each) over the local socket acceptable, given contract §8's no-text default? The ledger never stores it, and the renderer already shows the same text from the JSONL.            | operator                         |
| Q2  | Does `row` need a per-family switch in Settings → Mods, or is the prefs file plus flip PRs enough?                                                                                                                               | operator                         |
| Q3  | Should P4W3's external profile get `sense.row` (sessions the operator started in their own terminal, after corroboration)?                                                                                                       | operator                         |
| Q4  | Widen the hook bridge to keep `session_title`, the prompt and `last_assistant_message` (F6) as a cheap improvement for un-owned sessions?                                                                                        | orchestrator, at W2 review       |
| Q5  | If W0 confirms the cold opens are a reader bug (A-M2), fix it first as its own card: it may deliver most of the CPU gain for every session, owned or not, and changes how T455's gain is reported.                               | orchestrator                     |
| Q6  | Prompt rows of machine origin (task notifications, `/loop` wake-ups, peer messages): shown as "last prompt" or skipped? Today's `last-prompt` line decides for the legacy path; the push must match it or the group never flips. | W0 data, then operator           |
| Q7  | Should the engine name a fork's parent (on `classic.SessionStart` or `session.start`)? Harnu does not need it — the spawn record has it — but a session forked outside Harnu has no lineage at all.                              | engine owners (upstream request) |

## 14. Acceptance map

| AC  | Where                                                                                                                 |
| --- | --------------------------------------------------------------------------------------------------------------------- |
| U-1 | 01-inventory.md; §3                                                                                                   |
| U-2 | §5.1 (T389 shipped vs specified), §5.2 (fact → event → rate → wire), §5.3, §5.4                                       |
| U-3 | §7                                                                                                                    |
| U-4 | §6                                                                                                                    |
| U-5 | 02-cost.md; §8                                                                                                        |
| C-1 | §4; 03-prototype.md §P.2–§P.4                                                                                         |
| C-2 | §5.1 (T389 waves, T447)                                                                                               |
| C-3 | §9; ADR-draft.md                                                                                                      |
| C-4 | §10                                                                                                                   |
| C-5 | 03-prototype.md §P.1–§P.3                                                                                             |
| C-6 | §12                                                                                                                   |
| C-7 | §13                                                                                                                   |
| C-8 | English only; neutral vocabulary; `npx prettier --check` and `tests/no-client-identifiers.test.ts` run on these files |
