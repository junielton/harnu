# T389 P2W1 — Command channel

## 1. Status

**Status:** specified (not implemented) · **Date:** 2026-10-02 · **Epic:** T389 · **Wave:** P2W1
**Master:** [`00-master.md`](00-master.md) · **Contract:** [`01-contract.md`](01-contract.md) ·
**ADR:** [ADR-0018](../../adr/0018-harnu-mod-as-integration-substrate.md)
**Verified against:** Claude Code CLI 2.1.287 (mods API types, cited as "types L<n>"); repo `main` @ `46d70c7d` (line references re-checked after the Harnu rename; the earlier base `b35a2c06` is not in this repository).

## 2. Depends on / Unblocks

- **Depends on:** P1W3 (binding, `conn`, re-hello, `boundSid()`), P1W4 (`companion-prefs.json`
  and its `registerPrefsKey` extension point, the parity ledger, the arbiter, the Harnu mod cell in
  the System Monitor row). Through them, P1W1 (the host facade, `wire-core.ts`, the lease clock)
  and P1W2 (`register.ts` layout, `api-surface.json`, the `mod` local-ci step).
- **Base branch:** the P1W4 tip. The wave is rebased onto P1W5 before P2W2 starts.
- **Unblocks:** P2W2, P2W3, P2W4, P3W2, P4W2, P4W4, P4W5. Each adds one command to the queue this
  wave builds and registers its own row in the origin gate (`registerGateRow`).

Interfaces this wave consumes, with the owner's signatures (master §12):

| Owner | Interface                                                                                                                                                                  |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1W1  | `companionHost.setPollHandler(fn)`: this wave's poll handler. P1W1 validates the envelope, resolves the binding and touches the lease before the handler runs              |
| P1W1  | `companionHost.setCommandSource(fn)`: plugged with this wave's `pendingFor`, it fills `commands` of hello and events responses                                             |
| P1W1  | `companionHost.hold(b)`: the lease counts a parked poll until the returned function is called                                                                              |
| P1W1  | `companionHost.bindingForSession(sessionKey)`, `bindingForSid(sid)`, `onBindingChange(fn)`, `bus.on('lease', …)`; `BindingView.profile`, `.enabled`, `.lease`              |
| P1W3  | mod helpers `ensureHello($)`, `emit($, event)`, `enabled(feature)`, `boundSid()`, `reportModError(where, err, cmd?)`                                                       |
| P1W4  | `registerPrefsKey('channel', …)` and `prefsKey('channel')`; `recordFact('channel', …)`; `isStickyLegacy(sessionKeyOrSid)`; `reportFailedProof(sessionKeyOrSid, feature)`   |
| P1W4  | `registerFeaturePolicy(feature, rule)`: this wave registers the rows of `act.channel`, `act.turn`, `act.compact`, `act.ui`                                                 |
| P1W5  | the shared `turn.start` registration (contract §11.4). If P1W5 is not in the base when this wave lands, this wave creates the registration; otherwise it adds step 1 to it |

## 3. Summary

Harnu main gains a way to tell a live session to do something. The mod keeps one long-poll open
to the host; the host answers it the moment a command is queued. Commands are a closed enum,
each is gated by who caused it, each is written to a Harnu-side audit log before it is queued, and
each is answered exactly once by a `command.result` event.

This wave ships the plumbing and six commands: `flush`, `config.update`, `turn.abort`,
`session.compact`, `ui.toast`, `ui.status`. It ships **no** operator button for abort or compact
(master §1). The only new surface is one diagnostics action, "Test Harnu mod channel".

## 4. Evidence

| Smoke / source  | What it shows                                                                                                                                       | Verdict          |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| C2              | An un-awaited `for(;;) await $.http.fetch` loop started in `session.start` runs for minutes; enqueue → mod in 0–2 ms on a held poll                 | CONFIRMED        |
| C2, B1.1        | `$.http.fetch` hard-aborts at 30 000 ms (`no complete answer within 30000ms`); 25 s holds never failed                                              | CONFIRMED        |
| C2              | The loop survives turns and `/clear` (`$.session.id()` returns the new id); a hot reload closes the old poll and re-fires `session.start`           | CONFIRMED        |
| C2, C6          | A pending poll adds about 24–46 s to `-p` wall time                                                                                                 | REFUTED for `-p` |
| C2              | `turn.abort` idle rejects `no turn is running (asked for <id>)`; mid-turn ends the turn `reason:"aborted"` in 14–30 ms; it used the `turn.start` id | CONFIRMED        |
| C2              | `session.compact` idle resolves `{messages, tokensBefore, tokensAfter, usage}` in 14–37 s; mid-turn rejects `a turn is running (<id>)`              | CONFIRMED        |
| D5              | `$.session.compact` rejects from a `command.run` hook and skips the caller's own compact hook; an instruction can make the summarizer refuse        | CONFIRMED        |
| C2              | `ui.toast` → notification-bar line `<plugin>: <text>`; `ui.status` → pinned `⚠ <plugin>: <text>` under the prompt; both idle and mid-turn, 2 ms     | CONFIRMED        |
| B2              | Status and toast are hidden while the engine's permission dialog is open                                                                            | CONFIRMED        |
| A5, C2          | Module variables are wiped on reload; `$.state` survives (types L3159)                                                                              | CONFIRMED        |
| D6              | A same-tier sibling mod can read and forge the poll request and its response                                                                        | CONFIRMED        |
| §9 "not tested" | Holds between 25 s and 30 s; several sessions polling at once; the poll loop over a Unix socket                                                     | NOT TESTED → AC  |

API used, with the line in the 2.1.287 types file: `$.http.fetch` L3265, `$.session.id` L2575,
`$.turn.abort` L2710, `$.session.compact` L2654 (`SessionCompactArgs.instructions` L10028),
`$.ui.toast` L2258 (`ToastOptions.timeoutMs` L11897), `$.ui.status` L2270, `$.state` L3159,
`$.clock.sleep` L3222, event `turn.start` L4152
(`TurnStartInput` L12539).

## 5. Deviations from the study

None of the study's rows is contradicted by this wave. Two points narrow "new 1":

| Point                         | Study                                | This spec                                                                           | Basis                |
| ----------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------- | -------------------- |
| Hold length                   | "a long call"                        | ≤25 s per poll, re-issued; a 30 s abort is a reconnect                              | D3; smoke C2, B1.1   |
| Headless sessions             | not distinguished                    | no poll at all; only `flush` and `config.update`, piggybacked on `events` responses | D3, C6; contract §16 |
| Operator abort/compact button | implied by "abort the turn, compact" | not built; internal API only                                                        | master §1 (product)  |

## 6. Scope / Non-goals

**In scope.** The `poll` endpoint; the per-binding command queue (pure core) and poll parking
(shell); cursor, dedupe, `command.result`, TTL and result grace; the origin gate; the companion
`command` record of the companion audit log (P1W1 creates the log and its `binding` record); the mod's poll loop and command executor; the six commands;
one diagnostics action; the rollout key `channel`.

**Non-goals.**

- `prompt.submit` (P2W2), `message.deliver` (P2W3), `context.append` and `guard.set` (P2W4),
  `sentinel.set` (P3W2), `ui.band.set` (P4W2), `plan.capture` (P4W4), `context.drop` (P4W5). The
  matrix of §7.4 has no row for them: each later wave registers its own with `registerGateRow`.
- Any MCP verb that enqueues a command. No verb changes here, so the wave is not agent-facing.
- Operator-facing "abort turn" and "compact" controls, and any renderer IPC route that can reach
  them in a normal run.
- Free-text toasts or status lines chosen by an agent.
- Persisting the queue. It is in memory and dropped on host restart (contract §6).

## 7. Design

### 7.1 Host modules

| File (under `src/main/companion/`) | Kind  | Owns                                                                                                       |
| ---------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------- |
| `command-queue-core.ts`            | pure  | queue state per binding: enqueue, take, ack, result, cancel, sweep, drop, coalescing                       |
| `command-gate-core.ts`             | pure  | the origin matrix (§7.4), `registerGateRow`, argument validation                                           |
| `command-channel.ts`               | shell | the `poll` handler, parking, timers, the `enqueue()` API, `command.result` intake, lease and rebound hooks |
| `audit-core.ts` (extended)         | pure  | the `command` record shape, added to P1W1's audit log (§7.5)                                               |
| `companion-ipc.ts` (extended)      | shell | `companion:diagnostics:ping`; the debug-only enqueue route (§7.6)                                          |

`src/main/mcp/tool-handlers.ts`: `resolveArmTarget` (line 2181) moves unchanged to a new
`src/main/mcp/target-scope.ts` as `resolveAgentTarget` and is re-imported by the two
`orchestrator_*` handlers. The command gate calls the same function for `verb` causes, so there
is one implementation of "a session Harnu spawned for an agent" (`sessionOwnedByHarnu`,
`pty.ts:1176`; `isMessageableOwner`, `messaging-socket.ts:152`).

### 7.2 Queue core

```ts
type CmdState = 'queued' | 'delivered' | 'resulted' | 'expired' | 'lost' | 'dropped'

interface QueuedCommand {
  command: Command // contract §5.3
  cause: CommandCause
  sidAtEnqueue: Sid
  state: CmdState
  resultDeadline: number // expiresAt + CMD_RESULT_GRACE_MS[name]
  outcome?: CommandOutcome
}

interface BindingQueue {
  bootId: BootId
  nextN: number // starts at 1 per binding and boot
  ackedCursor: number
  items: QueuedCommand[] // at most CMD_QUEUE_MAX live (queued or delivered) entries
}

type CommandOutcome =
  | { state: 'resulted'; ok: boolean; code?: ErrorCode; message?: string; data?: unknown }
  | { state: 'expired' } // never delivered by expiresAt
  | { state: 'lost' } // delivered, no result by resultDeadline
  | {
      state: 'dropped'
      why: 'lease-lost' | 'rebound' | 'host-shutdown' | 'cancelled' | 'session-end' | 'revoked'
      delivered: boolean // whether the mod's cursor ever covered it
    }
```

Operations (all pure, clock injected):

| Operation              | Rule                                                                                                                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `enqueue(q, …, now)`   | assigns `cmd` and `n = nextN++`, `expiresAt = now + ttl`. Refuses with `QUEUE_FULL` at `CMD_QUEUE_MAX`. Coalesces **undelivered** items only: a new `ui.status` replaces an older one, `config.update` merges, `flush` dedupes |
| `ack(q, cursor)`       | every `queued` item with `n ≤ cursor` becomes `delivered`; `ackedCursor = max(ackedCursor, cursor)`. A cursor above `nextN - 1` is ignored and counted (untrusted input, SEC-3c)                                               |
| `take(q, cursor, now)` | items with `n > cursor`, no outcome, `now < expiresAt`, in `n` order (contract §6 commands 3)                                                                                                                                  |
| `result(q, cmd, r)`    | first result wins and settles the item; a duplicate, or a result for an unknown `cmd`, is ignored and counted                                                                                                                  |
| `cancel(q, cmd)`       | succeeds only while the item is `queued` (never delivered); returns whether it cancelled. P2W3 uses it to avoid a double delivery                                                                                              |
| `sweep(q, now)`        | `queued` past `expiresAt` → `expired`; `delivered` past `resultDeadline` → `lost`                                                                                                                                              |
| `drop(q, why, keep?)`  | settles every live item as `dropped`; `rebound` keeps `flush` and `config.update`                                                                                                                                              |

A `resulted` outcome with `ok: true` is the **proof** of the command's feature when contract §11.2
makes that feature attempt-proven (`act.*`, `ui.band`) or proven by that result (`gate.guard`):
`command-channel.ts` calls `companionHost.markProven(b, row.feature)` with the feature of the
command's gate row, once per feature. Without this call no family that needs an actuator
(`startPrompt`, `message`, `guard`) could ever be owned (ARB-3). A result that is not ok is
neither a proof nor a failed proof: the engine refused the call, not the channel (for example
`CMD_PRECONDITION` for a compaction mid-turn). A feature the contract proves another way
(`gate.sentinel` and `ui.command` by their asks) is not marked here.
A `lost` outcome is a **failed proof** of the command's feature for that session (contract
§11.2). `command-channel.ts` calls P1W4's `reportFailedProof(sessionKey, feature)`, which makes the
families that need that feature sticky-legacy for the session (ARB-4c).

### 7.3 Poll handler and parking

1. P1W1 has already validated the envelope, resolved the binding and touched the lease. The
   handler answers `FEATURE_DISABLED` when the binding's profile is not `interactive` or
   `act.channel` is not enabled.
2. `request.bootId` ≠ the host's `bootId`: answer `{ ok: true, commands: [], resync: true }`.
   The mod resets its cursor to 0 and sends a `session.snapshot` (contract §6).
3. Envelope `sid` ≠ the bound `sid`: answer `{ ok: true, commands: [], resync: true }` and wait
   for `session.rebound` (contract §15, last row). No command is released to an unsettled id.
4. `ack(cursor)`, `sweep(now)`, then `take(cursor, now)`. Non-empty → answer at once.
5. Empty → **park**: keep `{ reply, timer, release }` on the binding, where `release =
companionHost.hold(b)`, arm a
   timer for `config.pollHoldMs` (never above `POLL_HOLD_MS`), and answer `commands: []` when it
   fires.
6. One parked poll per binding. A second poll for the same binding supersedes the first, which is
   answered `commands: []` at once. This is what keeps a hot reload, or a duplicated loop, from
   leaving two holds.
7. A closed request unparks without answering. Unparking always calls `release()`.
8. `enqueue()` on a binding with a parked poll answers it synchronously with `take()`.
9. Host shutdown answers every parked poll `HOST_SHUTTING_DOWN` and drops every queue.

Commands MAY also ride on a `hello` or `events` response (contract §6). `pendingFor(b, cursor?)`
is plugged into the host with `setCommandSource`. A profile that does not poll (`headless`,
`external`) sends its `bootId` and `cursor` in `events` (contract §5.2); `pendingFor` acks and
takes with that cursor, and a stale `bootId` there answers `resync: true` as in step 2. A
`headless` binding only ever gets `flush` and `config.update`; an `external` one those two and
`ui.band.set` (contract §16, §21).

Hooks into earlier waves: `bus.on('lease', …)` with a lost lease → `drop('lease-lost')`;
`onBindingChange` with a new `sid` → `drop('rebound')` for items whose `sidAtEnqueue` differs;
a revoked binding (the kill switch, contract §3 item 9) → `drop('revoked')`; `bye` →
`drop('session-end')`.

### 7.4 The internal API and the origin gate

```ts
type CommandCause =
  | { kind: 'operator'; gesture: string } // constructed only inside an ipcMain handler
  | { kind: 'verb'; verb: string; callId?: string } // constructed only inside an MCP handler, after its predicates
  | { kind: 'internal'; subsystem: string } // main-process code with no external trigger

interface EnqueueRequest<N extends CommandName> {
  sessionKey: string | null // null only for an external binding
  sid?: Sid // names an external binding
  name: N
  args: CommandArgs[N]
  cause: CommandCause
  ttlMs?: number // default CMD_TTL_MS
}

type EnqueueRefusal =
  | 'NO_BINDING'
  | 'NO_LEASE'
  | 'STICKY_LEGACY'
  | 'HEADLESS'
  | 'EXTERNAL'
  | 'FEATURE_OFF'
  | 'MODE_SHADOW'
  | 'ORIGIN_DENIED'
  | 'TARGET_DENIED'
  | 'FOLDER_BLOCKED'
  | 'BAD_ARGS'
  | 'QUEUE_FULL'
  | 'SID_UNSETTLED'

type EnqueueResult =
  | { ok: true; cmd: CmdId; n: number; settled: Promise<CommandOutcome> }
  | { ok: false; reason: EnqueueRefusal }

export function enqueue<N extends CommandName>(req: EnqueueRequest<N>): EnqueueResult
export function cancelIfUndelivered(cmd: CmdId): boolean
export function pendingFor(b: BindingView, cursor?: number): Command[]
export function registerGateRow(name: CommandName, row: GateRow): void

interface GateRow {
  feature: FeatureId
  operator?: string[] // gesture ids
  verb?: string[] // verb names
  internal?: string[] // subsystem ids
  debug?: boolean // also admitted under gesture 'debug' (§7.6)
}
```

`enqueue` is the **only** way a command enters a queue. It runs these checks in order and stops
at the first failure. `settled` never rejects.

1. **Binding and lease.** A binding exists for `sessionKey` (or, external, for `sid`), its lease
   is live, it is not sticky-legacy, and its `sid` is settled.
2. **Profile and feature.** The profile admits the command (contract §9, column "Profiles"):
   `headless` admits `flush` and `config.update` (else `HEADLESS`); `external` admits those two
   and `ui.band.set` (else `EXTERNAL`, contract §21 item 5). The command's feature is in the
   binding's `enabled` set (else `FEATURE_OFF`).
3. **Key.** `prefsKey('channel')` is `off` → `FEATURE_OFF`. It is `shadow` → only the
   observe-only set of contract §9 is admitted (`flush`, `config.update`,
   `guard.set {enforce: false}`, `sentinel.set`, `ui.band.set`); anything else is `MODE_SHADOW` (§13).
4. **Origin** (`command-gate-core.ts`). The matrix below is a constant table; a `(name, cause.kind)`
   pair that is not in it is `ORIGIN_DENIED`. A `gesture`, `verb` or `subsystem` string not listed
   for that command is `ORIGIN_DENIED` too.
5. **Target.** `verb` causes need `resolveAgentTarget(sessionKey) === 'ok'` (else `TARGET_DENIED`)
   and a folder that is not blocked (`FOLDER_BLOCKED`), on top of whatever the verb's own handler
   already checked. `operator` causes need a Harnu-spawned binding (never the external class of
   P4W3).
6. **Arguments.** Schema and bounds; text fields are size-capped here as well as in the mod.
7. **Audit**, then queue (§7.5).

| Command           | `operator` gestures | `verb` | `internal` subsystems   | Feature       |
| ----------------- | ------------------- | ------ | ----------------------- | ------------- |
| `flush`           | `diagnostics.ping`  | —      | `arbitration`, `parity` | `act.channel` |
| `config.update`   | —                   | —      | `prefs`                 | `act.channel` |
| `turn.abort`      | none registered     | —      | —                       | `act.turn`    |
| `session.compact` | none registered     | —      | —                       | `act.compact` |
| `ui.toast`        | `diagnostics.ping`  | —      | —                       | `act.ui`      |
| `ui.status`       | —                   | —      | `arbitration`           | `act.ui`      |

The matrix above holds this wave's six commands only. Every other command gets its row from the
wave that owns it, through `registerGateRow`, in that wave's change (P2W2 `prompt.submit`, P2W3
`message.deliver`, P2W4 `context.append` and `guard.set`, P3W2 `sentinel.set`, P4W2
`ui.band.set`, P4W4 `plan.capture`, P4W5 `context.drop`). A command with no registered row is
`ORIGIN_DENIED`. Refusals are audited (§7.5).

"None registered" means the gate accepts the `operator` kind for that command but no gesture id
exists yet, so no IPC route can produce one. A later wave that adds the button adds the gesture
id, the IPC handler and its design. `ui.toast` and `ui.status` take their text from a constant
table in main (`UI_TEXTS`, keyed by id); no caller passes free text in this wave.

### 7.5 Audit (SEC-6)

P1W1 creates the companion audit log (`<userData>/companion/audit.ndjson`, its one writer
`appendAudit`, and the `binding` record; P1W1 §7.8a). This wave adds the `command` record kind:

```ts
type AuditMeta = Record<string, string | number | boolean> // closed, short values; never text

interface CommandAuditRecord {
  kind: 'command'
  phase: 'decision' | 'outcome' // two rows share `cmd`
  ts: number
  cmd?: CmdId // absent on a refusal
  n?: number
  sessionKey: string | null
  sid?: Sid
  folder: string
  name: CommandName
  cause: CommandCause
  args: { keys: string[]; chars?: number; sha256?: string } // 12 hex chars; never the text
  meta?: AuditMeta // what the enqueuing wave records beside args (P2W2: via, asUser, claim cause)
  decision?: 'queued' | EnqueueRefusal // phase 'decision'
  outcome?: CommandOutcome // phase 'outcome'
}
```

The `decision` row is appended **before** the command is queued (contract §9); if the append
throws, the command is not queued. Refusals are audited too. No record carries `conn`, the spawn
token, the endpoint token or message text (SEC-8).

### 7.6 Diagnostics action and the debug route

`companion:diagnostics:ping(sessionKey)` is the only renderer IPC of this wave. It enqueues
`flush` and `ui.toast` (text id `channel-ok`) with cause `{ kind: 'operator', gesture: 'diagnostics.ping' }`,
awaits both outcomes for at most 5 s and returns
`{ ok, roundTripMs, refusal?, outcomes: CommandOutcome[] }`.

`companion:debug:enqueue` is registered only when Harnu main was started with
`HARNU_COMPANION_DEBUG=1`. It enqueues with cause `{ kind: 'operator', gesture: 'debug' }`. The
gesture `debug` is in the gate only while the route is registered, and it admits exactly:
`config.update`, `turn.abort`, `session.compact`, `ui.status` (this wave), plus any command whose
registered row sets `debug: true` (`prompt.submit` for LV-P2W2-d, `sentinel.set` for LV-P3W2-a).
Arguments go through the same validation as any other cause, and `ui.status` still takes a text id
from `UI_TEXTS`. A unit test asserts the route and the gesture are absent without the variable.
The variable is read by Harnu main, never by the mod (SEC-4 is about the mod).

### 7.7 Mod

`$`-taking functions are top-level declarations in `hooks/register.ts` (MOD-1): `startPollLoop`,
`pollLoop`, `runCommand`. Later waves add their command with
`registerCommandHandler(name, fn)` (master §12.2) instead of editing the executor. Everything without `$` lives in `hooks/lib/command-core.ts` (cursor and
dedupe arithmetic, argument bounds, mapping an engine rejection to an `ErrorCode`).

`$.state` key `channel` is owned by this wave; its shape is in contract §22.

**Loop.**

1. `ensureHello` starts the loop once per load, only when `isInteractive` and `act.channel` is
   enabled. A module-level generation counter makes a second start a no-op and lets a re-hello
   retire the old loop. The loop is never awaited by a hook.
2. Each iteration: read `boundSid()` (P1W3), read `channel` from `$.state`, POST `poll` with
   `{ bootId, cursor }`.
3. A `FETCH_HARD_CAP_MS` abort re-issues at once. Any other transport failure re-reads the
   rendezvous file and waits with `$.clock.sleep` from `BACKOFF_MIN_MS` to `BACKOFF_MAX_MS`.
4. `STALE_CONN` → re-hello with `resume`, then continue. `FEATURE_DISABLED` → the loop ends until
   the next hello. `HOST_SHUTTING_DOWN` → back off. `resync: true` → cursor 0, new `bootId`,
   `session.snapshot`.
5. For each command in `n` order: write `cursor = max(cursor, n)` to `$.state` **first**
   (delivery), then `void runCommand($, c)`. Nothing is awaited in the loop (MOD-6).

**Executor (`runCommand`).** Exactly one `command.result` per `cmd`:

| Situation                                                        | Result                                                                                                                                                                               |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cmd` in `resulted`                                              | nothing (already answered)                                                                                                                                                           |
| `cmd` in `started`, in flight in this load                       | nothing (the running call will answer)                                                                                                                                               |
| `cmd` in `started`, not in flight (the load that ran it is gone) | `CMD_FAILED`, message `interrupted by reload`; never run again. For `prompt.submit` and `message.deliver` it carries `data: { submitted: 'unknown' }` (contract §6, commands rule 5) |
| `now ≥ expiresAt`                                                | `CMD_EXPIRED`                                                                                                                                                                        |
| unknown `name`                                                   | `CMD_UNSUPPORTED`                                                                                                                                                                    |
| feature not enabled                                              | `FEATURE_DISABLED`                                                                                                                                                                   |
| otherwise                                                        | add to `started`, run, add to `resulted`, send the result                                                                                                                            |

`command.result` is an edge event (contract §6): it flushes immediately and stays in the ring
until acknowledged.

**Per command, idle and mid-turn.**

| Command           | Mod action                                                             | Idle                                                             | Mid-turn                                          |
| ----------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------- |
| `flush`           | flush the ring, send `session.snapshot {reason: 'flush'}`              | ok                                                               | ok                                                |
| `config.update`   | check every field against `CONFIG_BOUNDS`; apply all or none           | ok, or `CMD_PRECONDITION`                                        | same; a new `pollHoldMs` applies to the next poll |
| `turn.abort`      | `$.turn.abort({ turnId })` with `args.turnId ?? channel.turnId`        | `CMD_PRECONDITION` (no id, or the engine's "no turn is running") | the turn ends `aborted`; result `ok`              |
| `session.compact` | `$.session.compact()`, not awaited by the loop; result when it settles | `ok`, `data: { tokensBefore?, tokensAfter? }` after 14–37 s      | `CMD_PRECONDITION` ("a turn is running")          |
| `ui.toast`        | `$.ui.toast(text)`; text ≤ 200 chars                                   | ok                                                               | ok; hidden while an engine dialog is open (MOD-8) |
| `ui.status`       | `$.ui.status(text ?? undefined)`                                       | ok                                                               | same                                              |

`act.turn` is step 1 of the shared `turn.start` registration (contract §11.4): it stores
`e.turnId` in `channel.turnId`, and the body returns `next(e)`. Nothing clears it: P1W5's
`turn.complete` step does not write P2W1's key, and a stale id is answered by the engine's own
rejection, which stays the source of truth for "no turn": `command-core.ts` maps the two known rejection texts to `CMD_PRECONDITION` and anything
else to `CMD_FAILED` with the engine's text. `session.compact` is never called from a
`command.run` hook (the poll loop is the only caller). A skipped compaction is `ok: true` with
`data: { skipped: true }`; the token counts are optional (types L10050–10059). Protocol 1 narrows
`session.compact`'s args to `{}`: the gate refuses any field (`instructions` included) as `BAD_ARGS`.

### 7.8 Contract additions

None — merged into `01-contract.md`: §5.2 and §6 (cursor in `events`, the supersede and
"interrupted by reload" rules), §7.2 (`CMD_QUEUE_MAX`, `CMD_DONE_MAX`, `CMD_RESULT_GRACE_MS`,
`CONFIG_BOUNDS`), §9 (`CommandResultData['session.compact']`, the observe-only set), §11.5 (the
`channel` key) and §22 (the `channel` state key).

## 8. Arbitration & fallback

The channel has no legacy rival, so nothing is arbitrated here; every command's caller owns its
own fallback and learns the need for one from `EnqueueResult` or `CommandOutcome`.

| Condition                                                                 | Behaviour                                                                                                                                                                                  |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Mod absent (CLI too old, mode `off`, org policy, `--safe-mode`, `--bare`) | no binding → `NO_BINDING`; the caller takes its legacy path                                                                                                                                |
| CLI above the tested ceiling                                              | the `channel` key is capped at `shadow` (contract §11.5) → `MODE_SHADOW` for everything outside the observe-only set                                                                       |
| Kill switch turned off mid-session                                        | the `conn` is revoked, the re-hello is answered `enable: []`, the mod is inert; the parked poll is released, the queue settles `dropped: revoked`, callers fall back at once (no TTL wait) |
| Headless (`-p`, scheduler ticks)                                          | no poll; `HEADLESS` for every command but the two housekeeping ones                                                                                                                        |
| `sec-default`                                                             | `http.fetch`, `session.*` and `ui.*` pass; the channel works. `act.turn` needs `turn.start`, which is not in the pinned set (evidence pack)                                                |
| Lease lost mid-operation                                                  | undelivered and unanswered commands settle `dropped: lease-lost`; the session is sticky-legacy (ARB-4c)                                                                                    |
| Delivered, no result (crash, wedge, forged response)                      | `lost` after the grace; failed proof; sticky-legacy for the families that need the feature                                                                                                 |
| Host restart                                                              | queue gone, never replayed (contract §6); the mod's next poll gets `resync: true` after its re-hello                                                                                       |
| Hot reload                                                                | the old poll closes; the new load re-hellos and restarts the loop; an executed command is not run again; an interrupted one answers `CMD_FAILED`                                           |
| `/clear`                                                                  | the loop continues under the new id; commands queued for the old `sid` are dropped (`rebound`)                                                                                             |
| In-session `/resume`                                                      | polls answer `resync` until `session.rebound` arrives; then as `/clear`                                                                                                                    |
| A sibling mod wedges the worker                                           | the poll loop is not a hook dispatch; the next iteration proceeds. A wedge blamed on the companion unloads it → lease loss                                                                 |
| Managed org pin                                                           | nothing is installed around it; the Harnu mod state says "Blocked by your organization's policy" (DOC-8)                                                                                   |

## 9. Security requirements

Inherited: SEC-1, SEC-3, SEC-4, SEC-5, SEC-6, SEC-8, SEC-9. Wave-specific:

1. `enqueue()` is the single entry point. No HTTP route, MCP verb or companion endpoint may add a
   command; a static test greps for writes to the queue outside `command-channel.ts`.
2. A `CommandCause` is constructed where the trigger is observed, never forwarded from a caller's
   payload. `kind: 'operator'` appears only in files that register `ipcMain` handlers.
3. A valid `conn`, a well-formed `poll` or a `command.result` grants nothing (SEC-3b). A result
   only settles a command the host itself queued for that binding.
4. The mod executes only what its own closed switch knows. Nothing in a response is evaluated or
   used as a path. A forged response can at most trigger the six actions of this wave, each of
   which the engine would allow that mod anyway (SEC-3d).
5. No command resolves an approval (SEC-2). `turn.abort` ends a turn; it never answers a dialog.
6. Toast and status text come from `UI_TEXTS`. An agent cannot put words in the terminal chrome.
7. `turn.abort` and `session.compact` are destructive. In this wave no cause other than the
   debug gesture can enqueue them.

## 10. UX & copy

One action, in the Harnu mod cell P1W4 adds to `SystemMonitorRow.vue`, shown only for a session
whose Harnu mod state is `live`. User-visible strings say "Harnu mod" (master §15).

| Key (both `en.json` and `pt-BR.json`) | English                                      |
| ------------------------------------- | -------------------------------------------- |
| `harnuMod.channel.test`               | Test Harnu mod channel                       |
| `harnuMod.channel.ok`                 | Harnu mod channel answered in {ms} ms        |
| `harnuMod.channel.noAnswer`           | Harnu mod channel did not answer             |
| `harnuMod.channel.refused`            | Harnu mod channel is not available: {reason} |

The result is an `info` or `warning` toast in Harnu. In the terminal the session shows the line
`harnu-companion: Harnu mod channel check` for the default 4 s (text id `channel-ok`; the prefix is
drawn by the engine from the plugin name and cannot be changed). Refusal reasons are rendered
from a fixed map (`legacy`, `shadow`, `headless`). `design.md` §6 "System Monitor" gains the
action in the row description; no new token, size or motion.

## 11. Acceptance criteria

```
AC-P2W1-1 [unit] Given an empty queue, When two commands are enqueued, Then they get n = 1 and 2
  and take(cursor 0) returns both in order.
  Evidence: tests/companion/command-queue-core.test.ts › "assigns ordinals per binding and boot"

AC-P2W1-2 [unit] Given a delivered command without a result, When take runs with a cursor below
  its n and before expiresAt, Then it is returned again.
  Evidence: command-queue-core.test.ts › "re-sends an unanswered command above the cursor"

AC-P2W1-3 [unit] Given a command past expiresAt that was never delivered, When sweep runs, Then
  its outcome is expired and take no longer returns it.
  Evidence: command-queue-core.test.ts › "expires an undelivered command"

AC-P2W1-4 [unit] Given a delivered session.compact, When 30 s pass without a result, Then it is
  not lost.
  Evidence: command-queue-core.test.ts › "result grace is per command: not lost yet"

AC-P2W1-5 [unit] Given a queue at CMD_QUEUE_MAX, When one more is enqueued, Then it is refused
  QUEUE_FULL and nothing is evicted.
  Evidence: command-queue-core.test.ts › "refuses over the cap"

AC-P2W1-6 [unit] Given every (command, cause kind, gesture/verb/subsystem) combination, When the
  gate runs, Then only the cells of the matrix in §7.4 are admitted.
  Evidence: tests/companion/command-gate-core.test.ts › "origin matrix is exhaustive"

AC-P2W1-7 [unit] Given the channel key at shadow, When any command outside the observe-only set
  of contract §9 is enqueued, Then the result is MODE_SHADOW and a refusal row is audited.
  Evidence: command-gate-core.test.ts › "shadow admits the observe-only set"

AC-P2W1-8 [contract] Given a parked poll, When a command is enqueued, Then the poll is answered
  with it before any timer fires.
  Evidence: tests/companion/command-channel.contract.test.ts › "enqueue answers a parked poll"

AC-P2W1-9 [contract] Given no command, When a poll is held, Then it is answered commands: []
  at pollHoldMs and never later than POLL_HOLD_MS.
  Evidence: command-channel.contract.test.ts › "hold is bounded" (conformance row 9)

AC-P2W1-10 [contract] Given a parked poll on a binding, When a second poll arrives for it, Then
  the first is answered empty at once and exactly one stays parked.
  Evidence: command-channel.contract.test.ts › "a second poll supersedes the first"

AC-P2W1-11 [contract] Given a poll whose bootId is not the host's, Then the answer is
  commands: [] with resync: true and no command is released.
  Evidence: command-channel.contract.test.ts › "stale boot resyncs"

AC-P2W1-12 [contract] Given a headless binding, When it polls, Then the answer is
  FEATURE_DISABLED.
  Evidence: command-channel.contract.test.ts › "headless has no poll"

AC-P2W1-13 [unit] Given the audit append throws, When a command is enqueued, Then it is not
  queued.
  Evidence: tests/companion/command-channel.test.ts › "no audit, no command"

AC-P2W1-14 [unit] Given any enqueue, Then the audit rows contain no conn, no token and no
  argument text, only keys, length and a 12-hex hash.
  Evidence: tests/companion/audit-core.test.ts › "command rows carry digests only"

AC-P2W1-15 [mod-test] Given the same cmd delivered twice, Then the $ call runs once and one
  command.result is sent.
  Evidence: resources/companion/tests/channel.test.ts › "dedupes on cmd" (conformance row 10)

AC-P2W1-16 [mod-test] Given a cmd recorded as started by a previous load, When it is delivered
  again, Then no $ call runs and the result is CMD_FAILED "interrupted by reload".
  Evidence: channel.test.ts › "never re-runs an interrupted command"

AC-P2W1-17 [mod-test] Given an expired command and an unknown command name, Then the results are
  CMD_EXPIRED and CMD_UNSUPPORTED and no $ call runs.
  Evidence: channel.test.ts › "refuses expired and unknown" (conformance row 11)

AC-P2W1-18 [mod-test] Given isInteractive false, Then no poll request is ever sent.
  Evidence: channel.test.ts › "no poll when headless" (conformance row 14)

AC-P2W1-19 [mod-test] Given a session.compact that takes 20 s, When a ui.toast is delivered
  during it, Then the toast result is sent before the compact result.
  Evidence: channel.test.ts › "the loop never awaits a command"

AC-P2W1-20 [mod-test] Given $.turn.abort rejects "no turn is running", Then the result is
  CMD_PRECONDITION.
  Evidence: channel.test.ts › "maps the no-turn rejection"

AC-P2W1-21 [mod-test] Given a 30 000 ms fetch abort, Then the next poll is issued with no backoff
  and no mod.error.
  Evidence: channel.test.ts › "a hard-cap abort is a reconnect"

AC-P2W1-22 [integration] Given a real claude with the mod and a fake host, When the mod file is
  touched (hot reload), Then exactly one poll is parked afterwards and a command executed before
  the reload is not executed again.
  Evidence: tests/cli/channel.cli.test.ts › "reload keeps one loop and the dedupe set"

AC-P2W1-23 [integration] Given the host stops and starts with a new bootId, Then the mod
  re-hellos, polls with cursor 0 and receives none of the old commands.
  Evidence: channel.cli.test.ts › "host restart drops the queue"

AC-P2W1-24 [live-verify] Given five interactive sessions polling over the Unix socket for 30
  minutes, Then no poll ends in a FETCH_HARD_CAP_MS abort and every hold is within 25 s ± 500 ms.
  Evidence: LV-P2W1-b (settles CQ7 and "several sessions polling at once")

AC-P2W1-25 [live-verify] Given a running turn, When turn.abort is enqueued, Then the turn ends
  aborted and the result is ok.
  Evidence: LV-P2W1-c

AC-P2W1-26 [live-verify] Given an idle session, When session.compact is enqueued, Then the result
  is ok and the session is compacted.
  Evidence: LV-P2W1-c

AC-P2W1-27 [live-verify] Given a live session, When /clear is typed and a command is enqueued,
  Then it arrives under the new session id on the same binding.
  Evidence: LV-P2W1-a

AC-P2W1-28 [unit] Given Harnu main started without HARNU_COMPANION_DEBUG, Then the
  companion:debug:enqueue route is not registered.
  Evidence: tests/companion/companion-ipc.test.ts › "debug route is off by default"

AC-P2W1-29 [unit] Given a session with no binding (mod absent, org policy, old CLI), When any
  command is enqueued, Then the refusal is NO_BINDING and the caller's promise never hangs.
  Evidence: command-channel.test.ts › "mod absent refuses at once"

AC-P2W1-30 [unit] Given a delivered command, When the lease is lost, Then its outcome is
  dropped: lease-lost within one sweep.
  Evidence: command-channel.test.ts › "lease loss settles everything"
```

```
AC-P2W1-32 [unit] Given a binding with a parked poll and a queued command, When the kill switch
  revokes it, Then the poll is released and the command settles dropped: revoked at once.
  Evidence: command-channel.test.ts › "kill switch drops the queue"

AC-P2W1-33 [unit] Given an external binding, When ui.toast is enqueued, Then the refusal is
  EXTERNAL and it is audited.
  Evidence: command-gate-core.test.ts › "external profile"

AC-P2W1-34 [unit] Given a command.result with ok true for a command whose gate row names an
  attempt-proven feature, Then the binding's proven set gains that feature.
  Evidence: command-channel.test.ts › "a successful result proves the feature"


AC-P2W1-35 [unit] Given a delivered session.compact, When 150 s pass without a result, Then it is lost.
  Evidence: command-queue-core.test.ts › "result grace is per command: lost after the grace"

AC-P2W1-36 [contract] Given a headless binding, When turn.abort is enqueued for it, Then the refusal is HEADLESS.
  Evidence: command-channel.contract.test.ts › "headless refuses commands"

AC-P2W1-37 [mod-test] Given $.turn.abort rejects with any other text, Then the result is CMD_FAILED with the engine's text.
  Evidence: channel.test.ts › "maps other rejections"

AC-P2W1-38 [live-verify] Given an idle session, When turn.abort is enqueued, Then the result is CMD_PRECONDITION.
  Evidence: LV-P2W1-c

AC-P2W1-39 [live-verify] Given a running turn, When session.compact is enqueued, Then the result is CMD_PRECONDITION.
  Evidence: LV-P2W1-c

AC-P2W1-40 [unit] Given a command with no registered gate row, When it is enqueued, Then the refusal is ORIGIN_DENIED.
  Evidence: command-gate-core.test.ts › "unregistered rows"
```

**Human**

```
AC-P2W1-31 [human] Given a live session, When the operator clicks "Test Harnu mod channel", Then
  the terminal shows the Harnu mod toast and Harnu shows the round-trip time.
  Evidence: screenshot docs/specs/T389-companion-mod/evidence/P2W1-ping.png
```

### Live-verify recipes

All recipes use a second isolated Harnu (`docs/dev/live-verify-second-instance.md`) started with
`HARNU_COMPANION_DEBUG=1`, `channel` mode `active`, the legacy bridge left on, model `haiku`,
at most three model calls per recipe (QA-8).

**LV-P2W1-a — survival.**

1. Start a session; wait for Harnu mod state `live`.
2. Ping from the System Monitor row; record the round trip.
3. Type `/clear`; ping again; confirm the audit rows show two `sid` values and one `sessionKey`.
4. Touch `hooks/register.ts` in a dev build; wait for "reloaded"; ping again.
5. Confirm in the host log: one parked poll per binding at every step.

**LV-P2W1-b — hold reliability (CQ7).**

1. Start five sessions in three folders. Leave them idle for 30 minutes.
2. Read the parity ledger's `channel` records: hold durations, aborts, re-hellos.
3. For the 25–30 s half of CQ7, run the L4 harness (`tests/cli/channel.cli.test.ts`) with its
   fake host holding 28 000 ms and record whether any abort appears. `CONFIG_BOUNDS` caps
   `pollHoldMs` at 25 000, so the real host never holds longer; this run is informative only.

**LV-P2W1-c — abort and compact.**

1. Idle session: debug-enqueue `turn.abort` → expect `CMD_PRECONDITION`.
2. Ask for a long answer; debug-enqueue `turn.abort` → the turn ends; result `ok`.
3. Ask for a long answer; debug-enqueue `session.compact` → `CMD_PRECONDITION`.
4. Idle: debug-enqueue `session.compact` → a result within 120 s, with the token counts when the
   engine reports them.

**LV-P2W1-d — host restart.**

1. Debug-enqueue `ui.status`; quit Harnu before the session polls again; start Harnu.
2. Confirm the session returns to `live`, the status line never appears, and the audit shows
   `dropped: host-shutdown`.

## 12. Docs deliverables

| Contract                 | Deliverable                                                                                               |
| ------------------------ | --------------------------------------------------------------------------------------------------------- |
| CHANGELOG (DOC-1)        | `### Added` — "Test Harnu mod channel" in the System Monitor                                              |
| `docs/harnu-features.md` | none; no verb, ACK or agent-offered affordance changes                                                    |
| `docs/user/` (DOC-3)     | `system-monitor.md`: one paragraph on the test action; `troubleshooting.md`: what "did not answer" means  |
| `design.md` (DOC-4)      | §6 "System Monitor": the action in the Harnu mod cell                                                     |
| i18n                     | the four keys of §10 in `en.json` and `pt-BR.json`                                                        |
| Contract (DOC-7)         | already merged (§7.8); `contract.ts` and the golden fixtures land with the code                           |
| `api-surface.json`       | adds `$.turn.abort`, `$.session.compact`, `$.ui.toast`, `$.ui.status`, `$.clock.sleep`, hook `turn.start` |

## 13. Rollout & parity gate

**Fact family:** none. The wave registers the feature key `channel` through P1W4's
`registerPrefsKey('channel', { default: 'shadow', observeCap: 'shadow', … })` (contract §11.5).
A feature with no fact family is not governed by a family's `shadow`: it needs its key on, the
companion mode not `off`, and a live lease.

| `channel`          | Enabled features                                   | Host may issue                                                                                              |
| ------------------ | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `off`              | none; `poll` answers `FEATURE_DISABLED`            | nothing                                                                                                     |
| `shadow` (default) | `act.channel`                                      | the observe-only set: `flush`, `config.update`, `guard.set {enforce: false}`, `sentinel.set`, `ui.band.set` |
| `active`           | `act.channel`, `act.turn`, `act.compact`, `act.ui` | everything the gate admits; every non-observe command of any wave also needs this value                     |

`shadow` runs the poll loop so its reliability can be measured (ARB-6b, ruling 18).

**Shadow comparison.** There is no legacy counterpart, so the ledger records the channel against
its own contract: per poll, hold duration and how it ended (`timeout`, `command`, `superseded`,
`abort`, `close`); per `flush`, enqueue → delivered → result latencies; per session, re-hellos and
duplicate-loop detections.

**Gate to `active`:** 50 interactive sessions across at least three folders and 5 000 polls with
zero hard-cap aborts, zero sessions with two parked polls, and at least 99.5 % of `flush`
commands resulted within `CMD_TTL_MS`. Every miss is classified in the ledger. The flip is an
operator confirmation point recorded in the master plan (ARB-6d).

**Demotes:** nothing.

## 14. Open questions

| #    | Question                                                                                                           | Default until settled       | Owner |
| ---- | ------------------------------------------------------------------------------------------------------------------ | --------------------------- | ----- |
| OQ-1 | CQ7: do concurrent Unix-socket polls hold 25 s reliably, and is 25–30 s safe?                                      | 25 s (AC-P2W1-24)           | P2W1  |
| OQ-2 | Exact rejection texts of `$.turn.abort` and `$.session.compact` on other CLI versions; the mapping is by substring | unknown text → `CMD_FAILED` | P2W1  |
| OQ-3 | Does the `SessionCompactSkipped` form (types L10117) carry a reason worth surfacing?                               | `{ skipped: true }` only    | P4W5  |

Moved to the master: whether `turn.start` fires for a turn started by a subagent's completion
notice is Q24 (P1W5); whether the audit file gets a pane is Q25 (P4W1).

## 15. Risks

| Risk                                                                | Sev      | Mitigation                                                                                    |
| ------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------- |
| A later wave reaches `enqueue` with a cause it invented (master R1) | Critical | constant matrix, exhaustive test (AC-P2W1-6), static test on queue writes, audit before queue |
| A forged poll response drives the mod                               | High     | closed switch; six actions only; conceded at the same tier (SEC-3d, smoke D6)                 |
| Duplicate loops after reload double the holds and the CPU           | Medium   | generation counter; host supersede rule (AC-P2W1-10, AC-P2W1-22)                              |
| A command executes twice across a reload                            | Medium   | `started` written to `$.state` before the `$` call (AC-P2W1-16)                               |
| `$.state` is readable by sibling mods, so the cursor and ids leak   | Low      | they are not secrets; `conn` handling is P1W3's (CQ3)                                         |
| The poll loop keeps a `-p` process alive                            | Medium   | no loop when headless (AC-P2W1-18); host answers `FEATURE_DISABLED`                           |
| An abort or compact button is added later with no design            | Medium   | "none registered" gestures; the gate needs a named gesture and its own spec                   |
| The audit file grows without bound                                  | Low      | 1 MiB rotation, two files                                                                     |
