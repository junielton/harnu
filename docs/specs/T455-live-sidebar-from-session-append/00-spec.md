# T455 — The sidebar fed by `session.append`, identity pushed at `session.start`

**Status:** specified (not implemented) · **Date:** 2026-10-09 (revised after verification round

1. · **Card:** T455 · **Decision record:** [`ADR-draft.md`](ADR-draft.md) (proposed; gets a number
   when merged)

Files: this spec; [`01-inventory.md`](01-inventory.md) (today's path, field by field, §3);
[`02-cost.md`](02-cost.md) (the measured cost, §8); [`03-prototype.md`](03-prototype.md) (the
prototype mod, its test, the real-engine runs, §10).

## 0. Summary

For a session it is running, Harnu learns what the sidebar row, `SessionPreview` and `get_fleet`
show by re-reading that session's JSONL: the chokidar watcher reads each append (the "tail"), and
the fleet model then rescans the session's project dir at most every 2 s (the "slug pass"). This
spec has the Harnu mod (`resources/companion/`, T389) push the facts the slug pass exists to
refresh — first and last prompt, user-row count, last activity — plus one fact nobody derives
today, the last assistant line. It folds every row the conversation keeps (`session.append`) and
sends a coalesced snapshot on the existing events channel. The transcript path and the start
source ride the shipped `session.snapshot` event.

Six facts shape the design:

1. **`session.append` is the stream these facts come from.** One event per kept row, in store
   order, carrying the row's transcript uuid (types 10566-10594; reference.md :137, :143). On Claude
   Code 2.1.296, 25 of 26 appended uuids were rows of the JSONL, in the same order (03-prototype.md
   §P.4).
2. **The push is process-local; history is the host's.** A resume or a fork loads its history and
   raises no append for it (reference.md :137; probed). `$.session.messages()` cannot replace the
   missing appends: its rows carry no door and no `isMeta` (types 11134-11160), and in a new session
   it already holds a hook-context row (probed). So the mod never seeds. The host combines the push
   with the cold baseline its own reader already folded for that history (§6.2).
3. **The engine names no parent for a fork.** `source: "fork"` and a new id, nothing else; the
   fork's JSONL even restamps every copied line with the new id (probed). `forkedFrom` and
   `resumedFrom` are host facts, from new state on Harnu's PTY record (§6.3).
4. **A row is never re-keyed before its transcript exists** (lesson `synthetic-sessions/004`).
   A claimed synthetic row shows the pushed facts at once. The re-key waits for proof that the file
   exists, delivered by main's fleet model only after the model holds the session. A reload therefore
   never drops the migrated row (§6.1, §6.6).
5. **The tail stays, for every session.** The watcher's tail is the legacy writer of
   `transcriptState`, `ctxPct`, the stagnation verdict, the title and the away summary. It is also
   the sign of life of the "stuck" timer (ARB-2(b), R11). T455 removes only the slug-pass reread and
   the post-migration full reload for a session whose `row` family is owned, and patches main's
   model from the tail's delta and the push instead, so no reader of the model goes stale (§6.6,
   §7.5).
6. **The legacy path never goes away** (ARB-8, P5W1 §7.6). Mod `off` or `shadow`, a lease lost, a
   CLI outside the gate, a session started outside Harnu, a cold row: each behaves exactly as today.

The measured prize (02-cost.md, 543 appends attributed reader by reader):

- The slug pass and other non-immediate readers reopen a live transcript 0.78–1.32 times per append
  (596 opens). In sweep-free windows that is 45 % of the live-transcript opens (445 of 995). T455
  removes the slug-pass part of it for owned sessions; the on-demand readers in the same class
  (a digest's `readSessionTail`, membership passes) remain, and W6 measures that residue.
- The tail's 0.72–1.55 opens per append (713 opens, within 2 ms of the write) stay.
- The first slug-pass-class reopen comes 258–565 ms (p50) and 4.7–8.2 s (p90) after a live
  session's last append (a verifier's p50 reached 822 ms). Inferred, not measured: `get_fleet`'s
  view of that session is at least that stale. The push bounds it at ≤ 500 ms, ≤ 2 s worst.
- The whole-corpus and home-dir sweeps seen in some windows are **not** caused by appends and are
  not T455's gain. They are a separate reader bug (§8).

## 1. Origin and scope

Ideas **109** ("Sidebar preview from `session.append`, not from tailing JSONL") and **110**
("Synthetic → real session migration as a push") of the ideation report
(`.harnu/out/claude-code-mods-ideas.md`, main checkout, 2026-10-09).

**In scope:**

- For a running, Harnu-spawned session: the first and last prompt, the user-row count, the last
  activity time and the last assistant text.
- Identity, the transcript path and the start source, at start and on an in-session `/clear` or
  `/resume`.
- Fork and resume lineage, from the host.
- The synthetic → real sequence and its reload safety.
- Arbitration, parity and the flip.
- The demotion of the slug pass for owned sessions.
- Privacy of the pushed text.
- The Mods audit disclosure.

**Out of scope, deliberately left to their owners:**

- `transcriptState`, task state and the stagnation verdict: T389 P1W5, `taskState` family.
- `ctxPct` and usage: P1W6, `telemetry` family.
- The title and the away summary: they stay on the tail. The title's push is recorded for parity
  only (§7.1).
- Subagent rows (P1W5, T202).
- Cold and parked sessions.
- The sweeps of 02-cost.md §8.4. The orchestrator cards that bug separately.
- Any engine change.

**Idea 110 as written ("flip the instant the process boots") is narrowed**, not dropped. The row
shows live facts from the first prompt, but the re-key keeps waiting for the transcript (fact 4).

## 2. Conventions

- **Shipped** = code on this branch (`cb7fb58`); **specified** = only in a spec. T389's spec
  headers still say "Specified (not implemented)", although P1W1–P1W6, P2W1, P4W1 and P4W3 landed
  in `7446534`. T447 (`$.harnu`) is merged as a spec (`9142876`, `docs/specs/T447-harnu-sdk-noun/`)
  and is not implemented.
- **Engine citations.** "types N" is a line of `types/claude-code.d.ts` as Claude Code **2.1.295**
  writes it (the `plugin-authoring` skill). "reference.md :N" is a line of that skill's
  `reference.md`. Every run used the installed CLI, **2.1.296**.
- **A-n** marks an assumption; §11 lists them with how the W0 spike checks each.
- **"Owned"** has the T389 meaning (ARB-3): the family's mode is `active` for the folder, every
  required feature is proven, and the lease is live. T389 has three modes, `off | shadow | active`
  (`src/main/companion/mode.ts:24-32`, `arbitration-core.ts:72-81`). "Legacy" is a fact _source_,
  not a mode; a session "on legacy" is one the mod does not own. The card's "`off`/`legacy`"
  reads as that.

## 3. Today

01-inventory.md is the inventory (U-1). It gives every field with its consumers and the function
and line that derive it, the watcher's options and read windows, the migration sequence, and the
board cards (BUG-146, BUG-156, BUG-88, T123 and their neighbours). The findings that drive this
spec:

- **F1** `get_fleet` reports every disk session `idle` (`claude-reader.ts:1164`).
- **F3** "what's happening" and `messageCount` go stale in the renderer while a session runs.
  They are not in the watcher's delta, and `fleet:changed` fires only on membership changes
  (`fleet-model-core.ts:257-263`).
- **F4** `modified` has two clocks: file mtime in main, receipt time in the renderer.
- **F5** a fork synthetic has no 120 s boot reaper (`stores/sessions.ts:3378-3417`).
- **F6** the hook bridge drops `last_assistant_message` and `session_title`
  (`hook-bridge.ts:162-171`).
- **F7** the slug pass and the post-migration full reload reread files the tail already read
  (02-cost.md §8.4).
- **F8** the `task-summary` arm of "what's happening" is dead on this CLI (0 of 400 recent
  transcripts); the subtitle is `lastPrompt` in practice.

## 4. Grounded in the engine (C-1)

| Mechanism                                                                                                                            | Declared at                                                              | Shown by a run                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `session.append` fires once per kept row, before it is stored                                                                        | types 4348-4359; `SessionAppendInput` 10566-10594; reference.md :137     | yes: 26 rows for a one-tool turn (§P.4 run 1)                                                                     |
| the row's `uuid` is its transcript uuid; appends are in store order                                                                  | types 10584-10588; reference.md :143                                     | yes: 25/26 uuids in the JSONL, same order; the 26th (`hook_success`, before `session.start`) is not in the file   |
| `door` names the route: `prompt`, `response`, `tool-result`, `notice`, …                                                             | `SessionAppendDoor` types 10556                                          | yes: one `response` row per block (`thinking`, `tool_use`, `text`)                                                |
| `message.role`, `isMeta`, `name`, `content` blocks                                                                                   | `SessionAppendMessage` types 10603-10638                                 | yes                                                                                                               |
| `next(e)` resolves to the row **as stored**, after any rewriting plugin                                                              | `SessionAppendResult` types 10673-10693; reference.md :141               | yes: the prototype folds `stored.message`                                                                         |
| `agentId` marks a subagent's row                                                                                                     | types 10589-10594                                                        | kit test only (A-E5)                                                                                              |
| loads are not appends                                                                                                                | reference.md :137                                                        | yes: a resume loaded 4 messages and appended none of them                                                         |
| `$.session.messages()` rows carry no door and no `isMeta`, so they **cannot** stand in for appends                                   | `SessionMessage` types 11134-11160                                       | yes: a new session's `session.start` saw 1 loaded message, a `hook_success` attachment                            |
| `classic.SessionStart`: `source` (`startup`, `resume`, `clear`, `compact`, `fork`), `session_id`, `transcript_path`, `session_title` | `SessionStartHookInput` types 11643-11648; `BaseHookInput` 826-829       | yes, for `startup`, `resume` and `fork`; it dispatches **before** `session.start`                                 |
| `classic.UserPromptSubmit.session_title`                                                                                             | types 14661-14669                                                        | yes, with `--name`, fresh and resumed                                                                             |
| `$.session.id()` is the transcript file's name                                                                                       | types 2794-2796                                                          | yes: new, resume, fork                                                                                            |
| `/clear` ends the conversation and fires **no** `session.start`                                                                      | `SessionEndInput` types 11049-11067 (11053-11056); reference.md :27      | kit test only (A-E4); the shipped mod rebinds on `classic.SessionStart{source:'clear'}` (`register.ts:1154-1170`) |
| `turn.complete` carries `answer`; `agentId` is absent on the main loop                                                               | `TurnCompleteFields` types 13276 (`answer` 13285)                        | yes                                                                                                               |
| `Stop.last_assistant_message`                                                                                                        | `StopHookInput` types 12117-12123                                        | not run; used only as the parity twin (§7.3)                                                                      |
| coalescing timer: `$.clock.after(ms, fn)` → `Timer.cancel()`                                                                         | types 3448-3454, `TimerCall` 12626, `Timer` 12615; reference.md :158-161 | yes (kit `mock.clock` and the real run)                                                                           |
| transport: `$.http.fetch` over a Unix socket                                                                                         | types 3490; shipped in `register.ts:250-290`                             | shipped (T389 P1W3); the prototype POSTed over TCP to a local sink                                                |
| `$.state`: any plugin reads any value; only the owner writes it                                                                      | types 3376-3383 (as quoted by T447 §3.7)                                 | the prototype keeps counts only (§5.5); the kit test asserts no text is stored                                    |
| a guarded hook fails open                                                                                                            | `.catch(($, e, next) => next(e))`; reference.md :79                      | `claude plugin validate` lists it as a "gating hook with .catch"                                                  |
| test kit: `mock.clock`, `mock.env`, `mock.session`, raising an engine row                                                            | types 15453, 15468, 15470-15480; `MockSession` 15553                     | 7 tests pass; 3 mutations each caught (§P.2)                                                                      |

## 5. Delta against T389 and its neighbours (U-2, C-2)

### 5.1 What exists, and where T455 touches it

| Wave / spec                  | Status                                                           | What it gives T455, or where they overlap                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1W1 host server, rendezvous | shipped                                                          | the channel: HTTP over `<userData>/companion/c.sock`, `POST /v1/{hello,events,poll,ask,bye}` (`rendezvous.ts:22-30`, `contract.ts:136-152`)                                                                                                                                                                                                                                                                                                                                                                |
| P1W2 skeleton, test harness  | shipped                                                          | the rig the W1 tests extend (`resources/companion/tests/support/rig.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| P1W3 handshake and identity  | shipped; `identity` family in `shadow`                           | `hello { sid, spawn, cwd, … }` (`contract.ts:164-177`); `session.snapshot` with `reason: 'hello' \| 'resync' \| 'flush' \| 'probe'` (`contract.ts:274-280`); `session.rebound` (`:281`); claims (`identity-core.ts`); `bindByClaim` (`stores/sessions.ts:5134`). **No transcript path, no source, no title, no lineage on the wire.** The lineage shape is inferred on the host from the PTY's spawn kind only (`identity-adapter.ts:101-110`).                                                            |
| P1W4 arbitration and rollout | shipped                                                          | families, modes, ramp, lease, the parity ledger and gate (`arbitration-core.ts`, `parity-core.ts:196-242`). Closed `FactFamily` union, with no row family.                                                                                                                                                                                                                                                                                                                                                 |
| P1W5 fleet state             | shipped; `taskState` in `shadow`                                 | turns, attention, subagents. No text, no counts, no activity time (`fleet-sensor.ts:9-10`). **T455 leaves its legacy inputs (tail, stagnation) untouched** (§7.2).                                                                                                                                                                                                                                                                                                                                         |
| P1W6 telemetry               | shipped; `telemetry` in `shadow`                                 | `usage.measured`. The tail's `ctxPct` stays its legacy input.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| P2W2 start prompt            | specified                                                        | a plugin-origin row is never a first prompt, a last prompt or a title (`P2W2-start-prompt.md:336-351`). The fold applies it: it reads `door: 'prompt'` rows only, and a plugin's rows come in by door `note`.                                                                                                                                                                                                                                                                                              |
| P2W4 live contract and guard | specified                                                        | `plugin-meta` rows are never a first prompt, a title or a turn (`P2W4-live-contract-and-guard.md:20-22`). Same rule.                                                                                                                                                                                                                                                                                                                                                                                       |
| P4W1 Mods audit              | shipped                                                          | the chips (`mods-audit-core.ts:370-393`); T455 needs one more (§10.3).                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| P4W3 outside Harnu           | shipped; `external` off                                          | "the companion never creates a sidebar row" (`01-contract.md:1310-1311`); T455 keeps that.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| P5W1 legacy retirement       | specified                                                        | keeps the transcript watcher forever (§7.6, `P5W1-legacy-retirement.md:269`). T455 is **new scope**: it demotes one redundant reread and deletes nothing.                                                                                                                                                                                                                                                                                                                                                  |
| reserved `turn.progress`     | reserved, no owner                                               | coalesced `turn.step` liveness (`01-contract.md:1194`). T455 does not hook `turn.step`.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **T447 `$.harnu`**           | spec merged (`9142876`); not implemented                         | Two overlaps. (1) Its `fleetGet` re-exports `get_fleet`'s `status` (`T447-harnu-sdk-noun/01-contract.md:97-105`), so W3's change to `status` for owned sessions (from always `idle` to `active` while rows arrive, F1) reaches every `$.harnu` caller. W3 updates T447's contract note with it. (2) Its §3.7 rests on "any plugin reads any `$.state` value" (types 3376-3383): whatever the companion keeps in `$.state` is readable by every co-loaded mod. That is why T455 keeps no text there (§5.5). |
| **T450 secret scrubber**     | spec on `docs/t450-secret-scrubber-spec` (`f61faf7`), not merged | Both hook `session.append`. T455 folds the row **as stored** (`next(e)`'s result), which is the scrubbed row wherever the scrubber sits in the chain. So T455 never pushes what T450 redacted (T450's L5 is about a hook reading `e` above the scrubber; T455 reads the result). T450 also proposes a `transcript` chip, "Rewrites what the conversation keeps" (T450 `00-spec.md:360-361`); T455 needs the same chip for reading (§10.3).                                                                 |

### 5.2 What T455 adds, fact by fact

| Fact                                                | Produced by (mod step)                                                                                  | Wire                                          | Rate                                  | Applied when `row` is owned?                                       | Legacy twin for parity (§7.3)                                |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------ |
| first prompt                                        | `session.append`, `door: 'prompt'`, main loop, not `isMeta`; the first one this process saw             | `session.row.firstPrompt`                     | coalesced (§5.4)                      | yes, when the host has no baseline (a new session)                 | head fold `firstRealPrompt` (`claude-reader.ts:601-612`)     |
| last prompt (the "what's happening" line)           | same rule, latest                                                                                       | `session.row.lastPrompt`                      | coalesced                             | yes                                                                | the CLI's `last-prompt` line (`transcript-truth.ts:238-241`) |
| user rows (→ `messageCount`)                        | main-loop rows with `message.type === 'user'`, tool results included, counted from this process's start | `session.row.userRows`                        | coalesced                             | yes: `messageCount` = baseline + `userRows`                        | `userMessageCount` (`claude-reader.ts:601-602`)              |
| last activity (→ `modified`, `status`)              | the time of the last folded row                                                                         | `session.row.lastRowAt` (mod clock, epoch ms) | coalesced                             | yes, in main's model (`get_fleet`) and the renderer                | file mtime (`claude-reader.ts:1160`)                         |
| last assistant text (new preview line)              | `door: 'response'`, `role: 'assistant'`, main loop, the latest non-empty text                           | `session.row.lastAssistant`                   | coalesced; flushed at `turn.complete` | yes                                                                | `Stop.last_assistant_message` (hook bridge, F6)              |
| title                                               | `classic.SessionStart` / `classic.UserPromptSubmit` `session_title`                                     | `session.row.title`                           | per prompt                            | **no, recorded only**: the title stays on the tail (§7.1)          | `customTitle \|\| aiTitle` (`claude-reader.ts:1157`)         |
| tool calls                                          | `tool_use` blocks of main-loop `response` rows; subagents' counted apart                                | `session.row.toolCalls`, `subagentToolCalls`  | coalesced                             | **no, recorded only**: stagnation stays with `stall-detect` (§7.1) | `stall-detect.ts` 5-min window (`:21`, `:76-103`)            |
| start source, transcript path                       | `classic.SessionStart.source` and `transcript_path`                                                     | `session.snapshot.start` (extended, §5.3)     | once per conversation                 | `identity` family (claim facts)                                    | the PTY spawn kind; the watcher's `add` path                 |
| new conversation's path after `/clear` or `/resume` | the same classic payload                                                                                | `session.rebound.transcriptPath`              | once                                  | `identity` family                                                  | the watcher's `add` path                                     |
| `forkedFrom`, `resumedFrom`                         | **not the mod**: Harnu's PTY record, persisted to `lineage.json` (§6.3)                                 | a host-side field of the identity claim       | —                                     | `identity` family                                                  | `forkSourceId` (`stores/sessions.ts:3406`)                   |

The away summary is **not** pushed: the tail keeps delivering it (`claude-watcher.ts:510-511`),
and a push would gain nothing.

### 5.3 Wire shape (additive; protocol stays `v: 1`)

These are additions to `resources/companion/hooks/contract.ts` and to contract §8, §11 and §22. An
additive event type, optional field or feature id does not bump `v` (`01-contract.md:1112-1115`).
Contract §8 forbids prompt text "unless the payload type above names the field"
(`01-contract.md:678-681`). The text fields below are named, and §5.5 states what they may carry.

```ts
interface EventPayloads {
  // ...shipped events...
  /**
   * Shipped (contract.ts:274-280), extended with `start`. It is already sent at hello and on
   * resync, and with reason `probe` when the first classic hook arrives after the hello
   * (`noteClassic`, register.ts:410-415). So the classic facts reach the host whichever comes
   * first, with no new event.
   */
  'session.snapshot': {
    reason: 'hello' | 'resync' | 'flush' | 'probe'
    activeTurnId: string | null
    openAttention: { kind: AttentionKind; toolUseId?: string }[]
    runningSubagents: number
    probes: { classic: boolean; toolCheck: boolean }
    /**
     * Absent until a classic hook has run. The mod holds it in module memory only, so a hot reload
     * loses it and the re-hello's snapshot omits it: the host keeps the last `start` it received
     * for the binding and never clears it on an absent field.
     */
    start?: {
      source: 'startup' | 'resume' | 'clear' | 'compact' | 'fork'
      /** classic hooks' transcript_path; ≤ 4,096 chars; validated by the host (§6.1). */
      transcriptPath: string
    }
  }
  /** Shipped (contract.ts:281), gains the new conversation's file. */
  'session.rebound': {
    prevSid: Sid
    sid: Sid
    cause: 'clear' | 'resume' | 'unknown'
    transcriptPath?: string
  }
  /**
   * Feature `sense.row`. A snapshot of process-local facts: the newest replaces the last, so a
   * lost or coalesced one costs nothing.
   *
   * Text fields: `null` = none seen by this process; ABSENT = unknown to the mod (it reloaded, and
   * texts are never persisted, §5.5); the host keeps what it had. Text has passed the redaction
   * of §5.5.
   */
  'session.row': {
    /** The fold's rule version, so parity compares like with like. */
    fold: 1
    firstPrompt?: string | null // ≤ 240 chars, whitespace collapsed
    lastPrompt?: string | null // ≤ 240
    lastAssistant?: string | null // ≤ 240
    title?: string | null // ≤ 240, the latest session_title; recorded for parity only
    /** Since this process started; recorded for parity only. */
    toolCalls: number
    subagentToolCalls: number
    /** Main-loop user rows since this process started. */
    userRows: number
    /** Epoch ms of the last folded row, the mod's clock; null before the first. */
    lastRowAt: number | null
    /** The uuid of the last folded row: aligns the push with the transcript for parity. */
    lastUuid: string | null
  }
}
```

**Mod-side registry:**

- `EVENT_FEATURE['session.row'] = 'sense.row'` (`register.ts:84-101`).
- `COALESCABLE` gains `'session.row'` (`ring.ts:13`). It is safe because every field is a full
  value: no field is sent only when it changed.
- `declared` gains `sense.row` when the `session.append` step registered (`register.ts:1350-1391`).
- `$.state` gains key `row`, holding counts only (§5.5).
- `api-surface.json` gains the `session.append` and `classic.UserPromptSubmit` hooks.

**Host-side:**

- `wire-core.ts` gets field caps (above) on top of the 1 MiB body cap.
- `registerEventTypes('session.row')` in a new `src/main/companion/ingest/row-adapter.ts`.
- The identity adapter reads `session.snapshot.start` and `session.rebound.transcriptPath`.
- `registerFeaturePolicy('sense.row', …)` is enabled while the `row` family is not `off`.
- Unknown fields stay ignored (`01-contract.md:682`).

### 5.4 Rate limits and coalescing

The shipped pump has no flush timer. Every `emit` pumps at once and batches only while a POST is in
flight (`register.ts:655-675`); `flushMs` is declared and never read. `session.row` brings its own:

| Rule                                                                                           | Value                                                                                                  |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| trailing debounce after a row changed a field (`$.clock.after`)                                | 500 ms (`ROW_DEBOUNCE_MS`)                                                                             |
| maximum wait during a long stream of rows                                                      | 2,000 ms (`ROW_MAX_WAIT_MS`)                                                                           |
| immediate flush                                                                                | main-loop `turn.complete`; `session.start`; after a hello and on `resync`                              |
| rows that change nothing send nothing (attachments, hook context, tool results past the count) | probed: 26 rows → 4 events                                                                             |
| ring overflow                                                                                  | coalescable: the newest wins; nothing is lost, since every field is a full value                       |
| ceiling per binding                                                                            | ≤ 2 events/s steady; the host's 200 requests / 10 s bucket (`wire-core.ts:246-279`) is never the limit |
| payload                                                                                        | ≤ ~1.5 KB (four texts of ≤ 240 chars)                                                                  |

The fold is O(blocks of the row) and runs after `next(e)`, on the stored row. Its measured settle
time is 0.3–1.8 ms per row, worker hop included (03-prototype.md §P.3).

### 5.5 Privacy: what the text may carry, and where it never rests

Prompts can hold pasted secrets. Four rules, which also amend SEC-8 ("no secrets at rest or on the
wire", `00-master.md:501`) for these named fields:

1. **No text at rest in the session.** `$.state` key `row` holds `{ sid, counts: { toolCalls,
subagentToolCalls, userRows, lastRowAt, lastUuid } }` only. Any co-loaded mod can read
   `$.state` (§5.1, T447). Texts live in module memory and die with a reload (fact: the
   kit test "a reload keeps the counts, never stores text").
2. **Redacted on the wire, with a stated limit.** The fold reads the row as stored. With T450
   loaded, that is already the scrubbed row (§5.1). Without it, the mod runs each text field
   through a fixed, pure `redactForWire` before the push:
   - **The rules:** the 17 deterministic rules of T450's table (`T450-secret-scrubber/01-detection.md` at `f61faf7`,
     §2: every row but `high-entropy`, so `private-key`, the provider token formats, `jwt`,
     `url-credentials`, `auth-header` and `secret-assignment`). **No entropy rule**: it is the one
     rule that guesses, and its false positives (T450 §5.3) would blank ordinary prompts.
   - **The placeholder:** the bare rule id, `[REDACTED:<rule>]`. The companion does not reproduce
     T450's `[REDACTED:<rule>#<tag>]`: the tag needs T450's per-install salt in `$.store`, and a
     preview has no use for telling two secrets apart.
   - **What still goes out raw:** any secret no deterministic rule matches — a password typed in
     prose, a credential in a format not in the table, a high-entropy key with no known prefix.
     Fail-closed (the field sent as `null`) fires only when the pass itself throws, never because a
     text "looks secret". This is the residual risk Q1 asks the operator to accept.
   - **Drift:** while T450 is unmerged, W1 ships a copy of its table, and two copies drift. To avoid
     that, the table lives once, in a plain-data module both mods stage (`hooks/lib/secret-rules.ts`
     generated at staging from one source, as `hooks/coords.gen.ts` already is, MOD-1 allowing
     imports inside the plugin dir only), and a repo test asserts the two staged copies are
     byte-identical. Until T450 lands, the source lives with the companion and T450 adopts it.
3. **No text at rest on the host.** The row adapter keeps the latest values in memory, in main's
   fleet model, the same process memory the reader's folds already use. The parity ledger stores
   only an equality verdict and lengths. Its detail keys avoid `DENIED_KEY`
   (`parity-core.ts:66-67`): it uses `group`, `verdict`, `cls`, `lenPush` and `lenLegacy`, and never
   `prompt…`, `text…`, `message…` or `session…`.
4. **Same exposure as today's renderer.** The renderer already shows the same prompt text, read
   from the same user's JSONL. The push adds the local socket (mode 0600, bearer token) as a second
   carrier. Q1 asks the operator to accept that.

## 6. Synthetic → real (U-4)

The rule of lesson 004 stays: **nothing re-keys a row but proof that its transcript exists on
disk**. T455 changes three things:

- **Who binds:** the claim, for every Harnu-spawned session with an acting `identity` family,
  instead of folder guesses.
- **Who delivers the proof:** main's fleet model, after it holds the session. The proof comes from
  the watcher's `add` or from a `stat` of the reported `transcriptPath`, whichever is first.
- **What the row shows before the proof:** the pushed facts, keyed by the synthetic id.

### 6.1 New session (`claude-new`)

| Step | Today (01-inventory.md §3.4)                                                                                                 | With T455 (`identity` and `row` owned)                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | `createNewSession` mints `synthetic-<uuid>` and arms the 120 s reaper                                                        | unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 2    | the PTY spawns with `HARNU_SPAWN_TOKEN`                                                                                      | unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 3    | (mod) hello `{sid, spawn}` → claim, recorded only                                                                            | the `classic.SessionStart` step stores `{source:'startup', transcriptPath}`; `session.snapshot.start` carries it. The claim gains `transcriptPath` (kept only if its realpath is under `~/.claude/projects/` and its basename is `<sid>.jsonl`) and `lineage: { kind: 'new' }`                                                                                                                                                                                                                                     |
| 4    | —                                                                                                                            | `session.row` snapshots reach the row adapter. It writes them into main's fleet model, patched in place (§6.6), and into the renderer through the existing `claude:session:updated` shape, keyed by the claim's `key`: **the synthetic row**. Label fallback, subtitle and preview move from the first prompt on. No re-key.                                                                                                                                                                                       |
| 5    | the first prompt makes the CLI write the transcript; the watcher's `add` reads the whole file → `session:added`              | the watcher's `add` is unchanged: the tail still needs its baseline. **In addition**, main `stat`s the claimed `transcriptPath` on each `session.row` (at most every 2 s) until it exists.                                                                                                                                                                                                                                                                                                                         |
| 6    | `session:added` goes to the renderer at once (`claude-watcher.ts:825-827`) and can outrun the 250 ms model refresh (BUG-147) | for a **claimed** sid, main does not let the proof race the model. On the first of (`add`, `stat` hit), the fleet model inserts that one file (a header read of one transcript, the existing `scrapeJsonlHeaderCached`), commits membership, and only then marks the claim `proven: true` in the claim list it already pushes over `companion:identity` (`identity-adapter.ts:210-237`, sent at `host.ts:289-296`; an additive field of `IdentityClaim`, `identity-core.ts`). An unclaimed sid keeps today's path. |
| 7    | `reconcileSessionAdded`: claim, slug guess, re-home, 10 s correlation, newest-synthetic recency, 5-min `pendingCollapse`     | the renderer migrates a claimed row **only when its claim arrives `proven`** (in `applyIdentityClaims`, `stores/sessions.ts:5179-5196`, which already receives every claim-list push); its `session:added` for that sid is a no-op. That calls `bindByClaim` (`stores/sessions.ts:5134-5169`): `migrateSyntheticInPlace`, `fireMigrate`, the PTY re-key. A reload after the proof reads a model that already holds the session, so it cannot drop the row (§6.6).                                                  |
| 8    | `backfillMigratedSessionMeta`: a full `foldersLoad` (`stores/sessions.ts:4967-4989`)                                         | **skipped** for a claimed row: the model already has it, patched (§6.6).                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 9    | Haiku auto-name from the delta's `firstPromptCandidate`                                                                      | from the pushed `firstPrompt`, at the first `session.row` that carries one                                                                                                                                                                                                                                                                                                                                                                                                                                         |

A session that never gets a prompt never writes a transcript. Its row stays synthetic with live
facts and is never parked: hibernation parks `claude-resume` PTYs only, and only the re-key
promotes a PTY to that kind (lesson 004). The 120 s boot reaper applies exactly as it does today.

### 6.2 Resume (`claude --resume <id>`)

A real row from the start. Probed: the same id, the same file, `source: 'resume'`. The claim is
`confirmed` (`key === sid`, `identity-core.ts:33`); `lineage: { kind: 'resume', from: <id> }` comes
from the PTY record (§6.3).

The **cold baseline** is the row as the reader last folded it: `firstPrompt`, `messageCount`,
title, and the `last-prompt` line. The host freezes it at claim time.

The mod's process-local push composes over it:

- `firstPrompt` = baseline ?? push;
- `lastPrompt` = push ?? baseline;
- `messageCount` = baseline + `userRows`;
- `lastAssistant` = push only;
- `modified` = `max(baseline, lastRowAt)`.

No history is re-read and nothing is seeded (§0, fact 2). The kit test "a resume starts empty"
pins it.

### 6.3 Fork (`--resume <src> --fork-session`)

| Step | Today                                                                                                                                               | With T455                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `createForkedSession`: no dedupe, **no boot reaper** (F5)                                                                                           | arms `armAgentBootDeadline` like every other synthetic (fixes F5)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 2    | `pty.ts:743-752` builds argv `['--resume', opts.claudeSessionId, '--fork-session']`; the PTY record keeps only `kind` (`pty.ts:349`, set at `:939`) | **new state, two pieces:** (1) `PtyRecord.spawnSourceSid?: string`, set at `:939` from `opts.claudeSessionId` for the `claude-resume` and `claude-fork` kinds, read by a new `setCompanionSpawnSourceResolver(owner => ptys.get(owner.ptyId)?.spawnSourceSid ?? null)` beside the shipped spawn-kind resolver (`pty.ts:546-548`). It lives only as long as the PTY: the record is deleted on every exit, a park included (`pty.ts:1045-1055`, `:1109`), and a claim is dropped once its binding unbinds (`identity-adapter.ts:211-215`). (2) So lineage is **persisted** the first time a claim binds with a lineage that names another session (a fork; an in-session `/resume` or `/clear` rebound with its `prevSid`): the identity adapter appends `{ sid, kind, from, at }` to `<userData>/companion/lineage.json` (written atomically, mode 0600, like `endpoint.json`; at most 10,000 entries, oldest dropped; session ids only, no text). The fleet model reads it to set `forkedFrom` on the session entry, live or cold, and `get_session` reports it from there. |
| 3    | the new id's JSONL lands in the cwd's slug; route 1 resolves it through the source's `fullPath`, then the newest-synthetic pick                     | the snapshot gives `{ source: 'fork', transcriptPath }`. The identity adapter joins `lineage: { kind: 'fork', from: spawnSourceSid }`, never from the mod. Binding is by claim, with **no cwd → slug guess**; the proof follows §6.1 steps 5–7.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 4    | `forkSourceId` lives in the renderer and is cleared on migration (`stores/sessions.ts:5058`)                                                        | `lineage.json` keeps it past the PTY, a park and a restart; the model's entry carries `forkedFrom`; `get_session` reports it for live and cold rows (W3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 5    | the `add` reads the whole fork transcript (it holds the copied history)                                                                             | unchanged: the tail needs its baseline. The cold baseline is the **source** row's (§6.2), and the push composes over it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

### 6.4 In-session `/clear` and `/resume`

Shipped: `classic.SessionStart{source:'clear'|'resume'}` with a new `session_id` →
`session.rebound` → claim (`register.ts:1154-1170`, `identity-adapter.ts:260-269`). T455 adds
`transcriptPath` to the rebound and resets the fold (a new conversation has no row yet; the kit
test "a /clear starts a fresh fold under the new id"). The live PTY moves when the new transcript's
proof arrives through the §6.1 step 6 ordering, through `bindByClaim`'s non-synthetic branch
(`stores/sessions.ts:5157-5168`).

### 6.5 What can be deleted, and what must stay

| Item                                                                                                                                                         | Verdict                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the slug pass an owned session's append schedules (`notifySlug(c.slug, 'append')`, `claude-watcher.ts:1238` → `notifySlugChanged`, `fleet-model.ts:173-192`) | **skipped** while `row` is owned for that session (W4). Membership passes (`add`, `unlink`) and every un-owned append keep it.                                                |
| the post-migration full `foldersLoad` for a claimed row (`stores/sessions.ts:4967-4989`)                                                                     | **skipped** for claimed rows (W4); kept for every other migration                                                                                                             |
| `forkSourceId` in the renderer                                                                                                                               | replaced by the claim's `lineage.from`; deletable after W6                                                                                                                    |
| the `taskSummary` arm of `pickWhatsHappening`                                                                                                                | dead on this CLI (F8); a separate cleanup, not T455's                                                                                                                         |
| **the watcher's tail** (`add` baseline read and `change` offset read, `claude-watcher.ts:418-432`, `:1109-1264`)                                             | **must stay for every session**. It is the legacy input of `transcriptState`, `ctxPct`, stagnation, title and away summary, and the sign of life for "stuck" (ARB-2(b), R11). |
| cwd → slug route 2, cross-slug re-home, 10 s correlation, newest-synthetic recency, `pendingCollapse`, the creation-time window, rename-delta promotion      | **must stay**: they serve `off`, `shadow`, a lost lease, a CLI outside the gate, Harnu-less sessions and the external profile (lesson 004, "How to apply")                    |
| the reader, `transcript-truth.ts`, `stall-detect.ts`                                                                                                         | **must stay** (ARB-8)                                                                                                                                                         |
| BUG-77's filter of Harnu's own `claude -p` probes                                                                                                            | must stay                                                                                                                                                                     |

### 6.6 Reloads: the model is patched in place, never left stale

**Why a skipped slug pass would be visible.** A renderer reload replaces almost every field of a
live row with the model's value:

- `reloadModelOnce` (`stores/sessions.ts:4645`) awaits `foldersLoad`, the model (`index.ts:819` →
  `scanFolders` → `getFleetFolders`, `claude-reader.ts:1533-1538`).
- `mergeFolders` spreads `...entry` (`merge-folders.ts:211-214`).
- `reconcileSessions` copies every differing key (`stores/sessions.ts:4317-4351`).
- Only the task-state, `aiSummary` and failure overlays (`:4690-4697`, `:4735-4750`) and
  `RENDERER_ONLY_SESSION_KEYS` (`:4310-4315`) survive.

So `transcriptState`, `ctxPct`, `stagnation`, `awaySummary`, `summary`, `modified`, `fileMtime`,
`whatsHappening`, `messageCount`, `resumable`, `bridged` and `agents` all come back from the model.
The watcher's delta handler had written several of them into the live row
(`stores/sessions.ts:5501-5522`). With the slug pass skipped for an owned session, the model would
freeze them at the last membership pass. Any reload, which a membership change in any folder
triggers (`:4505-4519`), would then restore a stale dot or stuck verdict, and nothing would correct
it once the session went idle. Main-side readers would go stale the same way (§7.5).

**The rule: for an owned session, the model is patched from in-memory sources instead of rescanned.**
The slug pass existed to refresh one session entry from the file. Every fact it would refresh is
already computed in main, from bytes the tail has just read or from the push. So the model applies
them to the entry directly, through a new `patchSession(sid, fields)` in `fleet-model-core.ts`, and
reads no file:

| Model field                                                    | Patched from                                                                                                                                                                                                                                   |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transcriptState`, `ctxPct`, `awaySummary`, `stagnation`       | the tail's `SessionUpdatePayload`, the same object the watcher sends the renderer (`claude-watcher.ts:506-513`)                                                                                                                                |
| `summary`                                                      | the tail's `renameTitle` (always wins) / `aiTitle` (fills an empty one), the renderer's own rule (`stores/sessions.ts:5506-5507`)                                                                                                              |
| `bridged`                                                      | a new optional `bridged` on the tail's delta, set when the tail reads a `bridge-session` line (the reader's rule, `claude-reader.ts:597`)                                                                                                      |
| `fileMtime`, `modified`                                        | `max(the tail's stat of the file, the push's lastRowAt)`; the tail already stats the file before each read (`claude-watcher.ts:418-432`)                                                                                                       |
| `firstPrompt`, `whatsHappening`, `messageCount`, `status`      | the push, composed as in §6.2 (`status: 'active'` while rows arrive, `'idle'` 5 s after the last one, the renderer's own window, `:501`)                                                                                                       |
| `resumable`                                                    | `true` once the push has folded an assistant row in this process, or the baseline was already `true` (the reader's `turnCount > 0`, `:598-600`)                                                                                                |
| `agents`                                                       | the subagent delta the watcher already builds (`claude-watcher.ts:1239-1245`): the agent's `fileMtime`, `modified` and `status: 'running'`, with the renderer's 15 s done rule (`stores/sessions.ts:4847-4858`)                                |
| `projectPath`, `gitBranch`, `teamName`, `agentName` (set once) | the one-file header read at the proof (§6.1 step 6). If a set-once field is still empty there (the insert saw the file before its `cwd` line), the first patch that finds it empty runs one single-file header re-read for that session, once. |

What follows from patching:

- Every reader of the model sees current values, with no new overlay to forget: the renderer's
  reload, `get_fleet`, `get_session`, `mission_get`, the Cleanup dossier and the Containers clock
  (§7.5).
- The renderer needs nothing of its own. A reload now returns what the deltas just set.
- The patch is idempotent and applied in arrival order. Fields not in a delta are left alone.
- On leaving ownership, the catch-up pass of §7.4 rescans the file and supersedes every patched
  value.

**The migration race** is closed by the ordering of §6.1 step 6. The proof that migrates a claimed
row is emitted only after the model has committed membership for that sid, so the reload that
follows a migration finds the row on "disk". This is the BUG-88 / BUG-147 shape that lesson 004
warns about. BUG-88's resurrection guard (`:4656-4667`) stays as it is: a migrated row the model
does not confirm is still dropped, and for a claimed row that can no longer happen in the window
that mattered.

## 7. Arbitration and parity (U-3)

### 7.1 A new fact family, `row`, partitioned at design time

`FactFamily` (`mode.ts:24-32`) gains `row`, with:

- `FAMILY_FEATURES.row = ['sense.identity', 'sense.row']`: the facts are keyed by the binding that
  identity proves.
- `DEFAULT_FAMILY_MODE.row = 'shadow'` (`arbitration-core.ts:60-81`).

**The family flips as one** (ARB-3, ARB-6(c)).

Its fields are partitioned **once, at design time**, exactly as ARB-2(c) partitions `telemetry`.
The companion owns some groups; the legacy writer keeps the others. No per-group flip exists, and
no ARB amendment is needed.

| Group       | Fields                             | Owner when `row` is owned                                                                                                                                                          |
| ----------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt`    | `firstPrompt`, `lastPrompt`        | **companion**                                                                                                                                                                      |
| `count`     | `userRows` → `messageCount`        | **companion**                                                                                                                                                                      |
| `activity`  | `lastRowAt` → `modified`, `status` | **companion**                                                                                                                                                                      |
| `assistant` | `lastAssistant`                    | **companion** (no legacy writer)                                                                                                                                                   |
| `title`     | `title`                            | **legacy** (the tail's `custom-title` / `ai-title`). Pushed and recorded only: an `ai-title` is not a conversation row, and whether it reaches `session_title` is unproven (A-T2). |
| `tools`     | `toolCalls`, `subagentToolCalls`   | **legacy** (`stall-detect`). Recorded only: stagnation is an input of the `taskState` family's stuck verdict, which T455 does not touch.                                           |

Moving `title` or `tools` to the companion later is a spec amendment, made in the same way
ARB-2(c)'s S3 slice added the model id to `telemetry`.

**ARB-5 ("every other consumer is fed through an adapter in its existing input shape").** The row
adapter feeds the two existing shapes and opens no new renderer channel:

- **The renderer:** the watcher's `claude:session:updated` payload, `SessionUpdatePayload`
  (`claude-watcher.ts:528-541`), gains the optional fields `lastPrompt`, `messageCount`,
  `lastAssistant` and `lastActivityMs`. The adapter emits it with `source: 'companion'`. It is an
  additive change to an existing shape; the watcher may fill `lastPrompt` and `messageCount` too,
  which would also fix F3 for un-owned sessions (Q4).
- **Main:** the fleet model's per-session record, patched in place (§6.6).

`session.row` is not a task-state event, so the task-state hub is not its entry point. A parked
session has no process and sends nothing, so the `isHibernated` guard is not bypassed.

### 7.2 What each state does, and which legacy inputs keep flowing

| State of the session                                                                                        | What Harnu shows                                                                      | Tail                                                                                              | Slug pass on its appends          | Post-migration full reload |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------- | -------------------------- |
| no mod (kill switch, CLI below 2.1.287 or untested, disclosure not shown, `claude` outside Harnu, P4W3 off) | exactly today's                                                                       | as today                                                                                          | as today                          | as today                   |
| `row` = `off`                                                                                               | exactly today's; `sense.row` is not enabled, so the mod emits nothing                 | as today                                                                                          | as today                          | as today                   |
| `row` = `shadow` (the shipped default)                                                                      | exactly today's; the host records each push against the legacy value                  | as today                                                                                          | as today                          | as today                   |
| `row` = `active` and owned                                                                                  | `prompt`, `count`, `activity`, `assistant` from the push; everything else from legacy | **as today**; the owned delta fields are dropped at the main-side adapter and recorded (ARB-2(b)) | **skipped**                       | **skipped** (claimed row)  |
| lease lost, proof failed, or the session ended                                                              | legacy wins, sticky for the session (ARB-4(b), (c))                                   | as today                                                                                          | resumes after the catch-up (§7.4) | as today                   |

**Why this keeps every other family whole.** The tail runs for every session in every state. So:

- `transcriptState`, `ctxPct`, stagnation, the title and the away summary keep reaching the
  renderer;
- the `taskState` and `telemetry` families keep their legacy inputs, and their parity streams
  continue whether those families are `shadow` or `active`;
- every delta still counts as a sign of life for the stuck timer (ARB-2(b), R11).

Skipping the slug pass would starve the model, not the tail: a renderer reload copies the model's
`transcriptState`, `ctxPct`, `stagnation`, `agents` and the rest over the live row (§6.6). T455
therefore never skips a pass without patching the model from the same tail delta and push (§6.6).
Every reader of the model (§7.5) then gets the values the slug pass would have produced, and the
families that read the tail get them through the model too.

### 7.3 Parity: what is measured to decide the flip

In `shadow` the host keeps computing every legacy value. At each main-loop `turn.completed`
(P1W5), it writes one record per group into a new ledger stream `row`
(`<userData>/companion/parity/row.ndjson`). The format is that of `parity-core.ts`: a salted sid
hash, detail keys `group`, `verdict`, `cls`, `lenPush` and `lenLegacy`, and no text (§5.5).

- Texts are compared after the one normalizer the renderer uses (`firstRealPrompt`,
  `claude-reader-derive.ts:47-55`), so the 120 vs 240 cap is not a divergence.
- Counts and the 5-minute window are computed from the pushed samples.
- The match window is the −10 s / +2 s of `parity-taskstate-rule.ts`.

| Group (owner)           | Compared at turn end                                                                            | Explained divergence classes                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `prompt` (companion)    | composed `lastPrompt` vs the newest `last-prompt` line; composed `firstPrompt` vs the head fold | E-HEAD: legacy frozen at the 2 MB head cap; E-ORIGIN: a machine-origin prompt row (A-P1)  |
| `count` (companion)     | baseline + `userRows` vs `userMessageCount`                                                     | E-HEAD                                                                                    |
| `activity` (companion)  | `lastRowAt` vs file mtime                                                                       | \|Δ\| ≤ 2,500 ms is a match                                                               |
| `assistant` (companion) | `lastAssistant` vs the Stop hook's `last_assistant_message` (bridge body, F6)                   | E-STOPLESS: a turn with no Stop (interrupt, error)                                        |
| `title` (legacy)        | pushed `title` vs `customTitle \|\| aiTitle`                                                    | E-AITITLE (A-T2). Recorded to inform a later partition change; it does not gate the flip. |
| `tools` (legacy)        | 5-min calls from push samples vs `stall-detect`                                                 | E-TAIL, E-SUBAGENT. Recorded; it does not gate the flip.                                  |

**The flip** is one PR that sets `DEFAULT_FAMILY_MODE.row = 'active'` once the operator confirms
(ARB-6(c), (d); `P1W4-arbitration-and-rollout.md:694-695`). It requires all of:

- `gateStatus` (`parity-core.ts:229-242`) passes on the four companion-owned groups with the
  `TASK_STATE_GATE` thresholds (`parity-taskstate-rule.ts:34`: ≥ 200 sessions, ≥ 5,000 facts, zero
  unexplained divergences).
- The corpus covers ≥ 20 resumes, ≥ 10 forks, ≥ 5 `/clear`, ≥ 20 sessions with subagents, and
  ≥ 10 transcripts past the 2 MB head cap.
- The `identity` family has flipped first, on its own P1W3 gate
  (`P1W3-handshake-identity.md:744-767`).
- The **performance gate**: the attribution script of 02-cost.md §8.6, run at comparable load,
  shows **zero slug-pass opens** of owned transcripts (confirmed by a debug counter on skipped passes), the residual pass-class opens (on-demand readers) reported as a number, a tail-class rate unchanged (±20 %), and
  the main process's read syscalls/s and CPU before and after, reported.

### 7.4 Leaving ownership

On lease loss, a failed proof or a sticky reversion, the host runs **one** slug pass for that
session's file: the incremental fold, or a head + tail scrape if the fold was evicted
(`claude-reader.ts:954`), which supersedes every patched value. The entry is exact the moment legacy
takes over. A session end does the same, which is what keeps a cold row identical to today's.

### 7.5 Every reader of the slug pass's per-session data (A-D1, verified)

Round 2 left this as assumption A-D1. It is now verified against every caller of `getFleetFolders` /
`scanFolders` in `src/main` and the renderer reload. Each field a slug pass refreshes on an append,
and who reads it from the model:

| Field                                                    | Main readers (file:line)                                                                                                                                                                                                                                                                                                                                                                                                                   | Renderer (via reload, §6.6)                                        | Patched from (§6.6) |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------- |
| `modified`                                               | Cleanup dossier `gc/opinion-shell.ts:57-61` (picks the latest session, LLM-facing); Containers clock `containers/containers-shell.ts:174-178` (`unusedForMs`, "session working · ago"); `toFleetInputs` `mcp/tool-handlers.ts:325` → `get_fleet` row, sort, `sinceMinutes` and `limit` (`mcp/fleet-snapshot.ts:465-474`), `get_session`, `mission_get` children (`fleet-snapshot.ts:412`); model folder sort `fleet-model-core.ts:266-274` | times and sorting, stuck anchor (`fleet-state.ts:175`)             | tail stat, push     |
| `fileMtime`                                              | Containers clock `containers-shell.ts:176`; model folder sort `fleet-model-core.ts:270`; Cleanup gather `gc/gc-sessions.ts:34` (masked: it re-stats every JSONL, `gc-transcripts.ts:117-131`)                                                                                                                                                                                                                                              | folder-sort fallback `components/folder-sort.ts:37`                | tail stat           |
| `summary`, `firstPrompt`                                 | Cleanup dossier `opinion-shell.ts:61`; `get_session` preview `tool-handlers.ts:568-570`; memory digest fallback `memory-digest.ts:292-295` (it prefers fresh transcript titles, `:288-291`)                                                                                                                                                                                                                                                | label (`session-label.ts:49-51`)                                   | tail delta, push    |
| `whatsHappening`                                         | memory digest fallback `memory-digest.ts:293`                                                                                                                                                                                                                                                                                                                                                                                              | `SessionPreview.vue:68`                                            | push                |
| `messageCount`, `resumable`, `bridged`                   | none                                                                                                                                                                                                                                                                                                                                                                                                                                       | footer count, not-resumable badge and resume guard, cloud panel    | push, tail delta    |
| `transcriptState`, `ctxPct`, `awaySummary`, `stagnation` | none (the comment at `fleet-model.ts:39-42` says otherwise; it is wrong)                                                                                                                                                                                                                                                                                                                                                                   | status dot, stuck verdict, previews: rolled back by any reload     | tail delta          |
| `agents`                                                 | none                                                                                                                                                                                                                                                                                                                                                                                                                                       | running-subagent count → activity (`stores/sessions.ts:1892-1898`) | subagent delta      |

Readers that use folder paths or membership only, unaffected:

- `gc-scan-shell.ts:159`;
- `reaper/scanner-shell.ts:160`, `:186-196` (`sessionId` joined to live task states);
- `user-projects.ts:1196`;
- `markdown-read.ts:116`, `memory-location-ipc.ts:80`, `memory-ipc.ts:37`;
- `mcp/server.ts:959` gates (`sessionId` → `projectPath`);
- `message_session` and the folder-scoped verbs;
- `plan_mission` (`tool-handlers.ts:1019`);
- the membership signature `fleet-model-core.ts:257-263`.

The full rescan `claude:rescan` (`index.ts:852`) is unaffected.

**Consequence for the design:** with the patch of §6.6, every row of this table stays as fresh as
today's slug pass makes it, or fresher, since the patch runs on every delta rather than at most
every 2 s.

## 8. Cost (U-5)

02-cost.md has the method, the scripts, every window's raw numbers, and what they do and do not
show. It is corrected after verification round 1:

- The 9,387-file project dir is the **home-directory** dir (sessions started in `~`), not Harnu's
  main checkout, whose project dir holds 21 transcripts.
- A verifier saw that dir swept in full with **no** append in it. The cold opens are periodic
  sweeps, not caused by appends; T455 claims no gain from them.

| Measured today (§8.3, run 5: 5 × 60 s, 543 appends, 2026-10-09)                                                                                                | Value                                                                                     | After T455, for an owned session                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| tail-class opens of a live transcript (≤ 50 ms after its append; p90 2 ms)                                                                                     | 713 opens; 0.72–1.55 per append                                                           | unchanged: the tail stays (§7.2)                                                                                       |
| pass-class opens (neither immediate nor in a sweep; median gap between them 1.7–2.1 s in sweep-free windows, the 2 s slug-pass cadence of `fleet-model.ts:66`) | 596 opens; 0.78–1.32 per append (45 % of the live-transcript opens in sweep-free windows) | ≈ 0 slug-pass opens; residual on-demand reads (a digest's `readSessionTail`, membership passes) remain, measured at W6 |
| sweep-class opens (≥ 50 other transcripts opened within ±1 s)                                                                                                  | 243 opens, in 2 of 5 windows                                                              | not T455's: a separate reader bug                                                                                      |
| how long after its last append the model rereads a live transcript (first pass-class open; `get_fleet`'s staleness is inferred from it, not measured)          | p50 258–565 ms, p90 4.7–8.2 s (a verifier's p50: 822 ms)                                  | `get_fleet` / `modified` from the push: ≤ 500 ms, ≤ 2 s worst                                                          |
| one full `foldersLoad` per migrated new session                                                                                                                | by construction (`stores/sessions.ts:4967-4989`)                                          | 0 for a claimed row                                                                                                    |
| in-session cost added (prototype)                                                                                                                              | —                                                                                         | 0.3–1.8 ms per row; 4 POSTs for a 26-row turn                                                                          |

The round-1 latency row ("append → next reread, p90 215–1,484 ms") is withdrawn. It mixed the
tail and the slug pass, so it moved with the share of each, and a verifier got 12 ms and 100 ms.
The split above replaces it.

## 9. Packaging (C-3)

**Decision: inside the existing Harnu mod (`resources/companion/`), plus host code in
`src/main/companion/`, the fleet model and the renderer store.** Recorded in ADR-draft.md.

- The facts exist only inside the `claude` process; main-process code alone cannot produce them.
- They need what the companion already has and a new mod would duplicate: the spawn token that ties
  a session to Harnu's row, the rendezvous and socket, the lease, feature negotiation, the parity
  ledger, the external profile.
- MOD-4 (`00-master.md:525`) allows at most one `on()` per event and matcher, so the steps T455
  adds to `session.start`, `classic.SessionStart` and `turn.complete` must live in the companion's
  existing bodies.
- **T450's scrubber is a separate mod** because it fails closed and needs a Bash `tool.call`
  (T450 §0). T455 fails open and needs neither, so it belongs in the companion. The two compose
  through the stored row (§5.1).
- **Widening the hook bridge alone** (`session_title`, the prompt and `last_assistant_message`,
  F6) covers the title, last prompt and last assistant text at turn granularity with no mod, but
  not the count, activity time, transcript path or binding. It is kept as an improvement for
  un-owned sessions (Q4), not as the design.
- **A session started outside Harnu** gets the mod only through P4W3's opt-in install, under the
  `external` profile (`feature-policy.ts:50-59`). v1 leaves `sense.row` out of `EXTERNAL_ALLOWED`,
  so such a session keeps today's path (Q3). With no Harnu running, the mod's hello fails and it
  backs off (0.5 s → 15 s). `emit` drops everything while there is no connection
  (`register.ts:201`), and the fold costs only its in-process time.

## 10. Control and failure (C-4)

### 10.1 Turning it on and off

| Control                                       | Where                                                           | Default                   |
| --------------------------------------------- | --------------------------------------------------------------- | ------------------------- |
| the Harnu mod as a whole (kill switch)        | `companion-prefs.json` `enabled`, Settings → Mods               | on (after the disclosure) |
| the `row` family: `off` / `shadow` / `active` | `companion-prefs.json` `families.row`                           | `shadow`                  |
| per-folder ramp                               | `projects.json` `companionActive` (`companion:setFolderActive`) | off (`allFolders: false`) |

There is no per-family switch in the UI today (`companion-ipc.ts:170-229` exposes only the kill
switch, the ramp and the external key). T455 does not add one (Q2).

### 10.2 When it fails

- **In the session: fail open, always.** The `session.append` step calls `next(e)` first and folds
  the stored row afterwards. Its registration carries `.catch(($, e, next) => next(e))`, so a throw
  replays what `next` settled and never refuses or delays the row beyond the step itself
  (reference.md :79). Every other step sits inside the existing `sense()` wrapper, which reports
  `mod.error` and drops the feature (contract §11.2). The redaction pass fails closed for its field
  only (§5.5).
- **On the wire:** a lost or coalesced `session.row` is harmless, because every field is a full
  value. A `resync` re-sends the snapshot.
- **On the host: fail to legacy.**
  - A malformed `session.row` (a field over its cap, a wrong type) is counted and dropped.
  - Three malformed rows in one binding revoke `sense.row` for it (`revoked`,
    `arbitration-core.ts:113-135`), and legacy wins for the session.
  - An invalid `transcriptPath` is dropped, and the watcher's `add` remains the only proof.

### 10.3 What Settings → Mods shows

Today, hooking `session.append` adds no chip: `deriveCapabilities` has no rule for any `session.*`
event (`mods-audit-core.ts:370-393`). That under-discloses. The hook reads every row of the
conversation, responses and tool results included, which "can read every prompt" does not say.

T455 and T450 need the same chip:

- T450 asks for a `transcript` chip, "Rewrites what the conversation keeps".
- T455 needs one for reading.
- A static analysis cannot tell a reading hook from a rewriting one; both are `on('session.append')`.

So there is **one** chip:

- id `transcript`;
- label "can read or rewrite the conversation";
- shown for a hook on `session.append` or `session.compact`, or a call to `session.messages`.

Whichever of T450 and T455 lands first adds it, and the other reuses it.

With it, the Harnu mod's row shows (inferred from `api-surface.json`, to be checked against the
real audit in W5): prompts, **transcript**, permissions, network, files, env, gate.

## 11. Assumptions the W0 spike checks first

| Id   | Assumption                                                                                                                  | How W0 checks it                                                                                      |
| ---- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| A-E1 | An interactive session raises the same doors, order and uuids as the `-p` runs                                              | the probe, loaded with `--plugin-dir` in an interactive scratch session                               |
| A-E2 | `classic.SessionStart` precedes `session.start` interactively too (the companion's own comment says so)                     | same run                                                                                              |
| A-E3 | a mid-session `/rename` reaches the next `classic.UserPromptSubmit.session_title`                                           | same run, `/rename` then a prompt (it only informs the recorded `title` group)                        |
| A-T2 | an `ai-title` reaches `session_title`                                                                                       | same run, after the CLI writes `ai-title` (it only informs a later partition change)                  |
| A-E4 | a live `/clear` is `classic.SessionStart{source:'clear'}` with the new id and its `transcript_path`                         | same run                                                                                              |
| A-E5 | a subagent's rows carry `agentId`, and its `tool_use` blocks are the subagent's                                             | same run with one Agent call                                                                          |
| A-P1 | `door: 'prompt'` rows not typed by the person (task notifications, auto-continuation) are `isMeta` or need an origin filter | parity `E-ORIGIN` counts; W0 lists the `origin.kind` of every prompt row (`PromptOrigin`, types 8865) |
| A-M1 | a `claude` process never reads its own transcript after boot                                                                | `fdattr.py` on the spike's own sessions                                                               |
| A-H1 | the model's one-file insert after a `stat` hit sees the same header the watcher's `add` would                               | log both for 50 new sessions                                                                          |

## 12. Implementation outline (C-6)

| Wave | Size | Depends on   | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Contracts owed                                                                                                                                                                                                                                         |
| ---- | ---- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| W0   | S    | —            | Spike: §11; a baseline re-run of 02-cost.md §8.6                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | none (scratch only)                                                                                                                                                                                                                                    |
| W1   | M    | W0           | **Mod half** in `resources/companion/`:<br>• `hooks/lib/row-fold.ts` (pure: the prototype's `row.ts` plus `title`, `userRows`, `lastRowAt`);<br>• `hooks/lib/redact-wire.ts`;<br>• the `session.append` hook;<br>• steps in `classic.SessionStart`, `classic.UserPromptSubmit` (new), `session.start` and `turn.complete`;<br>• the coalescer;<br>• `session.snapshot.start` and `session.rebound.transcriptPath`;<br>• `$.state` key `row` (counts only);<br>• `api-surface.json`;<br>• golden traces in `tests/` | `docs/dev/companion-mod.md`; T389 `01-contract.md` §8 (named text fields), §11.1, §22; SEC-8's amendment (§5.5)                                                                                                                                        |
| W2   | M    | W1           | **Host ingest in shadow:**<br>• `wire-core.ts` caps;<br>• `ingest/row-adapter.ts`;<br>• the feature policy;<br>• `FactFamily` `row` with its design-time partition;<br>• the `row` parity stream and its rules (§7.3);<br>• claim `transcriptPath` + `lineage`;<br>• `PtyRecord.spawnSourceSid`, its resolver and `lineage.json` (§6.3)                                                                                                                                                                            | none visible (shadow)                                                                                                                                                                                                                                  |
| W3   | M    | W2           | **Active consumers:**<br>• `patchSession` and the model patch from the tail delta, the subagent delta and the push (§6.6), plus the delta's new `bridged` field;<br>• the `SessionUpdatePayload` fields;<br>• the preview's last-assistant line;<br>• `get_fleet` `status` / `modified` for owned sessions (fixes F1, F4 for them);<br>• `get_session` `forkedFrom` / `resumedFrom`                                                                                                                                | CHANGELOG;<br>`design.md` §6 (the preview's new line) + `en.json` / `pt-BR.json`;<br>`docs/harnu-features.md` (`get_fleet` / `get_session` semantics) + marker bump;<br>T447's `01-contract.md` note on `status` (§5.1);<br>`docs/user/` (the preview) |
| W4   | M    | W3           | **Demotion for owned sessions:**<br>• no slug pass on their appends, never without W3's model patch;<br>• the proof ordering (§6.1 step 6);<br>• no full backfill for claimed rows;<br>• the catch-up on leaving ownership (§7.4);<br>• the fork boot reaper (F5)                                                                                                                                                                                                                                                  | CHANGELOG (fix F5; fresher sidebar)                                                                                                                                                                                                                    |
| W5   | S    | — (any time) | The Mods audit chip `transcript` (§10.3), shared with T450                                                                                                                                                                                                                                                                                                                                                                                                                                                         | CHANGELOG;<br>`en.json` / `pt-BR.json` `modsAudit.cap.transcript`;<br>`docs/user/` (the Mods page)                                                                                                                                                     |
| W6   | S    | W4 + gates   | The flip PRs: `identity` (its P1W3 gate), then `row` (§7.3), then the performance gate                                                                                                                                                                                                                                                                                                                                                                                                                             | CHANGELOG per flip; `docs/user/` if what the user sees changes                                                                                                                                                                                         |

Every wave keeps the T389 authoring rules (`00-master.md:519-529`, MOD-1 … MOD-9):

- steps go inside existing `on()` bodies (MOD-4);
- `$` is passed only to top-level functions (MOD-1);
- no `turn.step`, no `'*'` (MOD-3).

## 13. Open questions

| #   | Question                                                                                                                                                                                                                                                        | Who decides                      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Q1  | Is pushing prompt and assistant text (240 chars each, after the wire redaction of §5.5) over the local socket acceptable, as a named exception to contract §8 and an amendment to SEC-8? Should W1 wait for T450's rule table rather than ship a copied subset? | operator                         |
| Q2  | Does `row` need a per-family switch in Settings → Mods, or are the prefs file and the flip PR enough?                                                                                                                                                           | operator                         |
| Q3  | Should P4W3's external profile get `sense.row` (sessions the operator started in their own terminal, after corroboration)?                                                                                                                                      | operator                         |
| Q4  | Should the watcher (and the hook bridge, F6) also fill `lastPrompt`, `messageCount` and `lastAssistant` in the delta, fixing F3 for un-owned sessions too?                                                                                                      | orchestrator, at W3 review       |
| Q5  | Retiring the tail itself for an owned session would need every family that reads it (`row`, `taskState`, `telemetry`) to be owned **and** an ARB-2(b) amendment (sampled legacy recording, with a different sign of life for R11). Is that worth a later spec?  | orchestrator                     |
| Q6  | Prompt rows of machine origin (task notifications, `/loop` wake-ups, peer messages): shown as "last prompt" or skipped? Today's `last-prompt` line decides for legacy; the push must match it or the gate never passes.                                         | W0 data, then operator           |
| Q7  | Should the engine name a fork's parent? Harnu does not need it (the PTY record has it), but a session forked outside Harnu has no lineage at all.                                                                                                               | engine owners (upstream request) |

## 14. Acceptance map

| AC  | Where                                                                                                                 |
| --- | --------------------------------------------------------------------------------------------------------------------- |
| U-1 | 01-inventory.md; §3                                                                                                   |
| U-2 | §5.1 (shipped vs specified), §5.2 (fact → event → rate → twin), §5.3 (wire), §5.4 (rates), §5.5 (privacy)             |
| U-3 | §7 (incl. §7.5)                                                                                                       |
| U-4 | §6                                                                                                                    |
| U-5 | 02-cost.md; §8                                                                                                        |
| C-1 | §4; 03-prototype.md §P.2–§P.4                                                                                         |
| C-2 | §5.1 (T389 waves, T447, T450)                                                                                         |
| C-3 | §9; ADR-draft.md                                                                                                      |
| C-4 | §10                                                                                                                   |
| C-5 | 03-prototype.md §P.1–§P.3                                                                                             |
| C-6 | §12                                                                                                                   |
| C-7 | §13                                                                                                                   |
| C-8 | English only; neutral vocabulary; `npx prettier --check` and `tests/no-client-identifiers.test.ts` run on these files |
