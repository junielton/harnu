# T389 P1W5 — Fleet state

## 1. Status

Specified (not implemented) · 2026-10-02 · Epic T389 · Wave P1W5 · Family `taskState`.
Rulebook: [`00-master.md`](00-master.md) · Wire: [`01-contract.md`](01-contract.md) ·
Decisions: [ADR-0018](../../adr/0018-harnu-mod-as-integration-substrate.md) (D12, C3, C11, C14).
Verified against Claude Code CLI 2.1.287 and repo `main` @ `46d70c7d` (line references re-checked after the Harnu rename; the earlier base `b35a2c06` is not in this repository). "types L<n>" is a line
of that release's `claude-code.d.ts`.

## 2. Depends on / Unblocks

- **Depends on:** P1W3 (binding, `session.rebound`, `session.end`), P1W4 (hub, arbiter, ledger).
  Base branch: P1W4.
- **Unblocks:** P2W2, P2W3, P2W5 (the `permissionMode` key), P3W1 (it reuses the shared
  `tool.check` record and the attention bookkeeping) and P4W4. P2W1 reuses the `turn.start` body
  (soft: it creates the registration itself when this wave is not in its base). P1W6 S1–S2 run in
  parallel; P1W6 S3 stacks on this wave.
- **Interfaces consumed** (the owner's signatures, master §12):
  - P1W3 mod runtime: `ensureHello($)`, `emit($, event)` (ring and edge flush of contract §6),
    `enabled(feature)`, `reportModError(where, err)`; the `$.state` key `probes`.
  - P1W4: `ingest(ev, getWindow)`, `noteLiveness`, `recordFact`, `registerParityRule`,
    `registerFeaturePolicy` (this wave registers no new rule: P1W4 registered the three
    `sense.*` rows), `owns` / `ownerFor`, `markProven` through the host.

## 3. Summary

The mod senses turns, attention and subagents and reports them as seven wire events (`session.snapshot` included).
The host translates them into the hook vocabulary the existing reducer already folds
(`reduceTaskState`, `hook-state.ts:35-66`) and feeds the P1W4 hub with `source: 'companion'`.
No consumer changes: `claude:hook`, `getTaskStates` and the four in-main observers see the same
shape. What gets better is the set of edges the legacy hooks never deliver: a turn ended by Esc
or by a declined permission, and a turn that ends while a subagent still runs.

## 4. Evidence

| Id                  | Verdict         | What this wave takes from it                                                                                                                                                                                                                                                  |
| ------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| smoke A4            | PARTIAL         | Event order for answer, auto-allowed tool, approved and denied permission, background subagent, Esc, idle (60.0 s)                                                                                                                                                            |
| smoke A4            | REFUTED         | No "dialog answered" event: zero non-UI events between the approve key and `classic.PostToolUse`                                                                                                                                                                              |
| smoke A4            | observed        | User "No": `turn.complete {reason:"answer", isAborted:false}`, no `classic.Stop`, no `PostToolUse`; the in-flight fetch is aborted                                                                                                                                            |
| smoke A4            | observed        | Esc: `turn.complete {isAborted:true}`, no `classic.Stop`, no idle notification in the next 84 s                                                                                                                                                                               |
| smoke A4            | observed        | A stray `classic.SubagentStop {agent_type:""}` follows most turns; `classic.Stop` carries `background_tasks`                                                                                                                                                                  |
| smoke B1.6          | CONFIRMED       | `tool.check` fires in every mode; under `dontAsk` it sees `ask` before the mode turns it into a deny                                                                                                                                                                          |
| smoke B1.7          | CONFIRMED       | `classic.PermissionRequest` has `agent_id`, no `tool_use_id`; `tool.check` fires just before it                                                                                                                                                                               |
| smoke B1.8          | CONFIRMED       | `classic.PreToolUse` dispatches to modules on 2.1.287 (#96831 not reproduced)                                                                                                                                                                                                 |
| smoke B4            | CONFIRMED       | A Bash `tool.call` hook breaks worktree-isolated agents: `tool.call.end` is not available (C11)                                                                                                                                                                               |
| smoke A5            | CONFIRMED       | Reload wipes module state; the sensor state must be re-derivable                                                                                                                                                                                                              |
| smoke §1 confound   | n/a             | Global hooks were live: `classic.*` without any settings hook is unproven (C14, CQ13)                                                                                                                                                                                         |
| types L641          | read            | `BackgroundTaskSummary { id, type, status, description, command?, agent_type?, server? }`                                                                                                                                                                                     |
| types L11385        | read            | `StopFailureHookInput { error, error_details? }`: no `error_type`, no `resets_at`                                                                                                                                                                                             |
| smoke §11 (2.1.289) | CONFIRMED / new | Hooks and holds behave as in the original runs with the bridge isolated. New: teammates are a distinct agent kind (`isTeammate`, `teammateId`, `AgentStatus` with `idle` and `waiting`); since 2.1.288 `idle_prompt` does not fire while background agents run (§11.4, §11.5) |

## 5. Deviations from the study

| Study said                                                      | This spec                                                                            | Why               |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------- |
| Turn events give an exact state machine incl. "dialog answered" | No such edge; `waiting` ends on tool-settled, own ask resolution or turn end         | D12, smoke A4     |
| Leave `waiting-permission` on `tool.call.end`                   | Never; it needs a Bash `tool.call` hook                                              | C11, D6, smoke B4 |
| `PostToolUseFailure` retires a waiting state                    | Optional and never depended on                                                       | C3                |
| `turn.step` gives liveness                                      | Not hooked; liveness is turn and tool edges plus the legacy hooks that keep arriving | D12               |
| `classic.*` replaces the `--settings` blob                      | The blob stays injected; it is demoted to fallback for observation                   | ARB-1, D4         |

## 6. Scope / Non-goals

**In scope:** features `sense.turn`, `sense.attention`, `sense.subagent`; the pure sensor core
in the mod; the host adapter and its pure map; the `taskState` parity rule and gate; the
questions Q11, Q12, Q24, Q29, CQ12, CQ13; the `$.state` keys `fleet` and `permissionMode`.

**Non-goals:** holding or answering an approval (P3W1); `turn.progress` (contract §18); any
change to `fleet-state.ts`, `stall-detect.ts` or `transcript-truth.ts`; any UI; removing the
per-session blob or the global install (P5W1).

## 7. Design

### 7.1 Mod — `resources/companion/hooks/lib/fleet-sensor.ts` (pure) and `register.ts`

`fleet-sensor.ts` has no `$` and no imports beyond `contract.ts` (MOD-1). Hook bodies in
`register.ts` call `ensureHello($)`, call `next(e)` and return its result unchanged, then feed
the core and `emit($, …)` what it returns. Every body is wrapped (MOD-2); a sensor never alters
a verdict (MOD-8).

**Shared registrations.** This wave creates the one `on()` registration for `prompt.submit`
(event), `turn.start`, `turn.complete`, `tool.check`, `classic.PermissionRequest`,
`classic.PostToolUse` and the optional `classic.PostToolUseFailure`, and adopts the order of
steps of contract §11.4 inside each body. The steps that table names for P2W1 (storing
`channel.turnId` in `turn.start`; this wave never clears it), P2W2 (own-submit tagging), P3W1 (the hold, `ask.settled`) and P3W2 (the `sentinel` ask) are left
as marked insertion points; those waves add their step, never a second registration (MOD-4).
Every `classic.*` body starts by setting `probes.classic` and storing `e.permission_mode`.

```ts
interface FleetSensorState {
  activeTurnId: string | null
  nextOrigin: 'human' | 'plugin' | 'peer' | 'unknown'
  open: { kind: AttentionKind; toolUseId?: string; tool?: string }[]
  // the one shared record list of contract §22, capped at ASK_RECORD_MAX (64);
  // P3W1 fills inputKey and claimedBy
  checks: { toolUseId: string; tool: string; inputKey?: string; at: number; claimedBy?: string }[]
  runningSubagents: number
  lastStop: { all: number; subagents: number } | null // from classic.Stop.background_tasks
  pendingFailure: string | null // from classic.StopFailure.error
}
export function step(
  s: FleetSensorState,
  input: SensorInput
): { state: FleetSensorState; events: OutEvent[] }
```

The state is mirrored to `$.state` (key `fleet`, contract §22) after each step that changes it,
and read back at load, so a hot reload re-sends a correct `session.snapshot` (MOD-4). On a
`session.rebound` the key is reset to the neutral state: a new conversation has no turn, no open
item and no record.

Two more `$.state` keys are written by this wave's hooks:

- **`permissionMode`** (owner: this wave; `string | null`): every `classic.*` hook stores
  `e.permission_mode` when present; `null` means unseen. P2W3, P2W5 and P3W1 read it.
- **`probes`** (owner: P1W3): `probes.classic` is set by any `classic.*` dispatch;
  `probes.toolCheck` by every real `tool.check` dispatch (one with a `tool_use_id`), whatever
  the verdict (contract §11.2). A flip sends `session.snapshot {reason: 'probe'}`.

`turn.started` and `turn.completed` MUST set the envelope `turnId` (P1W6 keys its ledger on it);
`usage` is the contract's `TurnUsage`, which carries `model`.

| CLI event (hook)                        | Core action → wire event                                                                                                                                                                            |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt.submit` (event)                 | `nextOrigin` from `origin.kind`; for each open item → `attention.cleared {cause:'prompt'}`                                                                                                          |
| `turn.start`                            | `turn.started {origin}`; `activeTurnId = turnId`; `lastStop = null`                                                                                                                                 |
| `tool.check`                            | every real dispatch sets `probes.toolCheck`; only when the verdict is `ask`: push the record to `checks` and `attention.raised {kind:'permission', source:'check', toolUseId, tool}`                |
| `classic.PermissionRequest`             | pair with the oldest unclaimed `checks` entry with the same tool (FIFO, the same pairing as P3W1's correlation); `attention.raised {source:'request', toolUseId?, tool}` (with `agentId`)           |
| `classic.Notification`                  | `permission_prompt`, `worker_permission_prompt` → `raised {permission, notification}`; `elicitation_dialog` → `raised {input}`; `idle_prompt` → `raised {idle}`; other types: nothing               |
| `classic.PostToolUse`                   | only if an open permission item matches `tool_use_id` (or, uncorrelated, the tool name): `attention.cleared {cause:'tool-settled'}`                                                                 |
| `classic.PostToolUseFailure` (optional) | same as `PostToolUse`                                                                                                                                                                               |
| `classic.Stop`                          | `lastStop` = counts of `background_tasks` (all; `type === 'subagent'`)                                                                                                                              |
| `classic.StopFailure` (optional)        | `pendingFailure = e.error`                                                                                                                                                                          |
| `turn.complete`, no `agentId`           | each open item → `attention.cleared {cause:'turn-completed'}`; then `turn.completed {reason, isAborted, durationMs, usage?, backgroundTasks, backgroundSubagents, failure?}`; `activeTurnId = null` |
| `turn.complete`, with `agentId`         | `turn.completed` with `agentId` and `usage`; no state change (P1W6 consumes it)                                                                                                                     |
| `classic.SubagentStart`                 | `runningSubagents++`; `subagent.started`                                                                                                                                                            |
| `classic.SubagentStop`                  | `agent_type === ""` → dropped (MOD-7); else `runningSubagents = max(0, n-1)`; `subagent.stopped`                                                                                                    |
| any `classic.*`                         | first step: `probes.classic = true` (first time → `session.snapshot {reason:'probe'}`); store `permission_mode`                                                                                     |

`backgroundSubagents` on `turn.completed` is `max(runningSubagents, lastStop?.subagents ?? 0)`;
when no `classic.Stop` preceded the completion (Esc, "No") `lastStop` is null and the counter
alone is used. Hooks marked optional are registered separately; their failure to register is
reported as `mod.error` and does **not** remove the feature from `declared`.

**Teammates (CLI 2.1.289, smoke §11.4).** A teammate is a distinct agent kind, not a subagent (`AgentSpawnInput.isTeammate`,
`AgentInfo.teammateId` as `<name>@<team>`, `AgentStatus` with `idle` and `waiting`). The sensor keys per-agent facts on the
agent id and never infers "subagent" from an id alone: `runningSubagents` moves only on a `classic.SubagentStart` /
`classic.SubagentStop` pair with a non-empty `agent_type`; a teammate's `idle` or `waiting` never holds or ends the main
state and is not counted in `backgroundSubagents` until OQ-c is settled. This wave does not call `$.agent.list()` (it is not in
`api-surface.json`).

`api-surface.json` gains exactly: `prompt.submit`, `turn.start`, `turn.complete`, `tool.check`,
`classic.PermissionRequest`, `classic.Notification`, `classic.PostToolUse`,
`classic.PostToolUseFailure`, `classic.Stop`, `classic.StopFailure`, `classic.SubagentStart`,
`classic.SubagentStop`. No `tool.call`, no `turn.step`, no `*` (MOD-3).

### 7.2 Host — `src/main/companion/ingest/task-state-map-core.ts` (pure) + `task-state-adapter.ts`

The adapter subscribes to the wire events of a binding, runs the pure map, and calls
`hub.ingest({ sessionId: binding.sid, source: 'companion', … })`. Map state per binding:
`{ turnActive, runningSubagents, heldIdle, ended }`.

| Wire event                                                                     | `BridgeEvent.event` / `matcher`                                                                                                                                | Folded state    |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `turn.started` (main)                                                          | `UserPromptSubmit`                                                                                                                                             | `working`       |
| `attention.raised`, `source: 'check'`                                          | none (recorded; see below)                                                                                                                                     | —               |
| `attention.raised` permission, `request`                                       | `PermissionRequest`                                                                                                                                            | `needs-input`   |
| `attention.raised` permission, `notification`                                  | `Notification` / `permission_prompt`                                                                                                                           | `needs-input`   |
| `attention.raised` `input`                                                     | `Notification` / `elicitation_dialog`                                                                                                                          | `needs-input`   |
| `attention.raised` `idle`                                                      | `Notification` / `idle_prompt`                                                                                                                                 | `idle`          |
| `attention.cleared` `tool-settled`; `ask-resolved` (emitted by P3W1)           | `PostToolUse`                                                                                                                                                  | `working`       |
| `attention.cleared` `turn-completed`, `prompt`                                 | none (the turn edge that follows decides)                                                                                                                      | —               |
| `turn.completed` main, `reason: 'error'`                                       | `StopFailure` + `failureReason`                                                                                                                                | `failed`        |
| `turn.completed` main, other reasons, no subagent held                         | `Stop`                                                                                                                                                         | `idle`          |
| `turn.completed` main, `backgroundSubagents > 0`                               | none; `heldIdle = true`                                                                                                                                        | stays `working` |
| `subagent.stopped` bringing the count to 0 while `heldIdle` and no turn active | `Stop`                                                                                                                                                         | `idle`          |
| `turn.completed` with `agentId`, `subagent.started`                            | none                                                                                                                                                           | —               |
| `session.rebound {cause:'clear'}`                                              | `SessionEnd`/`clear` on `prevSid`, then `SessionStart`/`clear` on `sid`                                                                                        | `idle`          |
| `session.rebound {cause:'resume'}`                                             | `SessionStart`/`resume` on `sid`                                                                                                                               | `idle`          |
| `session.end`                                                                  | `SessionEnd` / reason                                                                                                                                          | `completed`     |
| `session.snapshot`                                                             | reconcile: set counters; if `activeTurnId` and state is not `working`/`needs-input` → `UserPromptSubmit`; if none and state is `working` and not held → `Stop` | —               |

Rules:

1. **`source: 'check'` is not folded.** Under `dontAsk` and `-p` the hook sees `ask` and no
   dialog follows (smoke B1.6); folding it would raise a false `needs-input`. It is kept for
   the `toolUseId` and for P3W1.
2. **User "No" and Esc** produce `turn.completed` with no stop hook. The map emits `Stop`, so
   the session goes `idle`. Legacy has no such edge and stays `needs-input` or `working`.
3. **Subagents hold, other background work does not.** A main turn that ends with a running
   subagent stays `working` until the last `subagent.stopped` or the next turn (D12). Background
   shells, monitors and workflows (`type !== 'subagent'`) do not hold: there is no edge that
   ends them, and a held `working` with a silent transcript would become a false `stuck` after
   `STUCK_AFTER_MS` (`fleet-state.ts:53`). Contract §8 says the same.
4. **`failed`.** `failureReason` is `classifyFailure(d.failure?.type)` (`hook-state.ts:92`), so
   `rate_limit`, `overloaded` and `billing_error` keep their badges; anything else is `unknown`.
   `resetsAt` is left undefined (Q29).
5. **Terminal edge.** ARB-2d, applied by P1W4's hub (P1W4 §7.4 step 2): the first non-`clear`
   `SessionEnd` of a session from either source is admitted, later ones are dropped. A `bye` is
   best effort (contract §5.5), so this adapter relies on it and adds nothing of its own.
6. **Observers.** No `BridgeEvent` is emitted for an edge that cannot change the state, so
   `terminal-ledger` and the mission-stall observer (`mcp/tool-handlers.ts:3248`) are not
   woken by subagent chatter.

### 7.3 Contract additions

None — merged into `01-contract.md`: §8 (`AttentionKind` with `'input'`;
`turn.completed.backgroundSubagents` and `.failure`; the derivation of `attention.raised`; the
rules "`source: 'check'` is record-only" and "only `backgroundSubagents > 0` holds a completed
main turn"), §11.1 (the optional hooks `classic.PostToolUseFailure` and `classic.StopFailure`
on `sense.attention`), §11.4 (shared registrations) and §22 (`fleet`, `permissionMode`).

### 7.4 What happens to "stuck"

The classifier is unchanged. `resolveActivity` still returns `stuck` for a `working` session
that has shown no sign of life for `STUCK_AFTER_MS`, or that `stall-detect.ts` flags as
stagnant (`fleet-state.ts:169-180`). Only its inputs change:

- The anchor `max(modifiedMs, lastEventMs)` keeps moving. Every applied companion edge sends
  `claude:hook` (which bumps `lastEventMs`, `stores/sessions.ts:5337`), and every **dropped**
  legacy hook for an owned session still calls `noteLiveness` (P1W4 §7.4). The global install's
  per-tool `PreToolUse` therefore keeps refreshing the anchor exactly as today.
- A live lease is **not** a sign of progress and never bumps the anchor: the poll loop outlives
  a hung request.
- False `stuck` shrinks only where the cause was a missing stop edge (Esc, "No", a `Stop` POST
  lost to a dead bridge port). A silent ten-minute tool call reads `stuck` as before; the
  companion has no tool-progress edge without `turn.step` (D12).
- Lease loss leaves the folded state as it is; the next legacy edge corrects it, and PTY exit
  prunes it (`pty.ts:590`). R11 is bounded by `LEASE_TTL_MS`.

## 8. Arbitration & fallback

| Situation                                  | Behaviour                                                                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Mode `shadow`                              | Sensor events are recorded, never applied (ARB-6b). Legacy drives.                                                       |
| Kill switch turned off mid-session         | The `conn` is revoked, the re-hello is answered `enable: []`, the sensors are inert, legacy drives at once (no TTL wait) |
| `session.rebound` (mod side)               | The `fleet` key is reset to the neutral state (contract §22); `permissionMode` and `probes` are kept                     |
| Mod absent, CLI too old                    | No events; legacy drives; PID-registry and transcript tiers unchanged (ARB-8)                                            |
| `sec-default` pins `classic.*`             | `probes.classic` stays false → `sense.attention`, `sense.subagent` unproven → family stays legacy                        |
| No settings hook under isolation (CQ13)    | If `classic.*` does not dispatch, same as the row above, per session                                                     |
| Proof arrives mid-turn                     | Ownership starts with the proving event; the state is continuous because both sources fold one map                       |
| Lease lost mid-turn                        | Sticky legacy within one TTL; no synthetic edge; legacy `Stop`/`Notification` resume the fold                            |
| Host restart                               | Hub state is rebuilt from the first event; `session.snapshot` after re-hello reconciles                                  |
| Hot reload                                 | `$.state` restores the sensor state; snapshot re-sent; no duplicate edge (the map is idempotent)                         |
| `/clear`                                   | `SessionEnd`/`clear` then `SessionStart`/`clear`, as the legacy hooks do (`hook-state.ts:62`)                            |
| Event lost (ring overflow, aborted fetch)  | `resync` → `session.snapshot` → reconcile row                                                                            |
| Headless `-p`                              | Sensor only; lease by heartbeat; no dialog exists, `request` never fires, `check` is not folded                          |
| Dropped legacy events for an owned session | Ledgered; liveness noted                                                                                                 |
| Parked session                             | `isHibernated` guard in the hub drops both sources                                                                       |

## 9. Security requirements

Inherits SEC-1…SEC-9. Wave-specific:

- Sensors return `next(e)` unchanged; `tool.check` is pass-through and never alters the verdict
  (SEC-1). No `ask` is issued by this wave.
- Payloads carry tool names and ids only: no tool input, no prompt text, no notification
  message, no `last_assistant_message`, no `background_tasks[].command` or `description`
  (SEC-8, contract §8).
- No `tool.call` on Bash, no `ui.render` hook, no `turn.step` (SEC-9d, MOD-3). The Q11 probe is
  a throwaway test mod and is never part of the companion.
- The host treats counters as untrusted: `runningSubagents` is clamped to `[0, 256]`.

## 10. UX & copy

No new surface, no new string. Operator-visible behaviour once the family is `active`:
a session goes `idle` after Esc and after a declined permission; a parent whose subagent still
runs stays `working`. A locally approved tool call still shows `needs-input` until the tool
settles (no "dialog answered" event); this equals today's behaviour and is stated in
`docs/user/troubleshooting.md`.

## 11. Acceptance criteria

Golden fixtures are the six smoke A4 traces (answer, auto-allowed tool, approved, denied,
background subagent, Esc) plus idle, exported from
`resources/companion/tests/fixtures/fleet/` and replayed by both sides (QA-7).

```
AC-P1W5-1 [mod-test] Given the "approved permission" fixture, When it is replayed, Then the mod
  emits turn.started, raised(check), raised(request), cleared(tool-settled), turn.completed
  in that order.
  Evidence: resources/companion/tests/fleet-sensor.test.ts › "approved permission"
AC-P1W5-2 [mod-test] Given the "denied" fixture (no classic.Stop, no PostToolUse), When it is
  replayed, Then the last two events are cleared(turn-completed) and turn.completed {answer}.
  Evidence: resources/companion/tests/fleet-sensor.test.ts › "user No ends the turn"
AC-P1W5-3 [mod-test] Given a classic.SubagentStop with agent_type "", When it fires, Then no
  event is emitted and runningSubagents is unchanged.
  Evidence: resources/companion/tests/fleet-sensor.test.ts › "stray SubagentStop is dropped"
AC-P1W5-4 [mod-test] Given any hooked event whose core step throws, When the hook runs, Then it
  returns the result of next(e) and one mod.error is emitted.
  Evidence: resources/companion/tests/fleet-sensor.test.ts › "sensor failure is pass-through"
AC-P1W5-5 [unit] Given the mod source, When the static surface test runs, Then the hooked
  events equal api-surface.json and none is tool.call, turn.step or "*".
  Evidence: tests/companion/api-surface.test.ts › "fleet sensors add no forbidden hook"
  Guards: issue 92533 (smoke B4)
AC-P1W5-6 [unit] Given each row of the map table in §7.2, When mapWire runs, Then it returns
  that row's BridgeEvent (or none).
  Evidence: tests/companion/task-state-map-core.test.ts › "wire to hook vocabulary"
AC-P1W5-7 [unit] Given turn.completed {aborted} with no preceding stop, When it is ingested by
  an owning companion, Then the folded state is idle.
  Evidence: tests/companion/task-state-adapter.test.ts › "Esc ends working"
AC-P1W5-8 [unit] Given a main turn.completed with backgroundSubagents 1, When it is ingested,
  Then the state stays working, and after subagent.stopped it is idle.
  Evidence: tests/companion/task-state-adapter.test.ts › "subagent holds the turn"
  Guards: BUG-15
AC-P1W5-9 [unit] Given a main turn.completed with backgroundTasks 2 and backgroundSubagents 0,
  When it is ingested, Then the state is idle.
  Evidence: tests/companion/task-state-adapter.test.ts › "background shells do not hold"
AC-P1W5-10 [unit] Given attention.raised with source check only, When it is ingested, Then the
  state is unchanged.
  Evidence: tests/companion/task-state-adapter.test.ts › "check alone is not needs-input"
AC-P1W5-11 [unit] Given the companion owns taskState and its session.end never arrives, When the
  legacy SessionEnd hook arrives, Then the adapter emits nothing and the state is completed.
  Evidence: tests/companion/task-state-adapter.test.ts › "relies on the hub's terminal edge";
  the rule itself is AC-P1W4-21 (ARB-2d)
AC-P1W5-12 [unit] Given session.rebound {clear}, When it is ingested, Then observers see
  SessionEnd on the old sid before SessionStart on the new one.
  Evidence: tests/companion/task-state-adapter.test.ts › "clear keeps the legacy edge order"
AC-P1W5-13 [unit] Given an owned session whose lease expires while working, When a legacy Stop
  hook arrives afterwards, Then the state is idle and source is hook.
  Evidence: tests/companion/task-state-adapter.test.ts › "lease loss falls back without a respawn"
AC-P1W5-14 [unit] Given mode shadow, When the "denied" fixture is ingested from both sources,
  Then the renderer payloads equal the legacy-only run and the ledger holds both timelines.
  Evidence: tests/companion/task-state-adapter.test.ts › "shadow changes nothing"
AC-P1W5-15 [unit] Given the recorded traces under tests/fixtures/companion-parity/taskState/,
  When the taskState rule runs, Then unexplained is empty and each E-class count matches the
  fixture's expectation file.
  Evidence: tests/companion/parity-taskstate.test.ts › "replay"
  Guards: BUG-13
AC-P1W5-16 [integration] Given a real claude -p under a temp HOME with no settings hooks at
  all, When one turn with a tool call completes, Then the fake host received a session.snapshot
  with probes.classic true.
  Evidence: tests/cli/fleet-state.cli.test.ts › "classic events without settings hooks" (CQ13)
AC-P1W5-17 [integration] Given a tool call that fails (Read of a missing file), When the turn
  completes, Then the fake host's final state for the session is idle, and the test output
  records whether a PostToolUseFailure-derived event arrived.
  Evidence: tests/cli/fleet-state.cli.test.ts › "failing tool settles the turn" (CQ12)
AC-P1W5-18 [integration] Given a turn that starts a background subagent, When classic.Stop
  fires, Then the recorded background_tasks entries have the keys of types L641 and the
  evidence file lists the observed type and status values.
  Evidence: tests/cli/fleet-state.cli.test.ts › "background_tasks shape" (Q12)
AC-P1W5-19 [live-verify] Given a throwaway probe mod counting ui.render by site around a
  permission dialog, When the dialog is approved locally, Then the evidence file states whether
  a render event distinguishes the close from the open state.
  Evidence: LV-P1W5-b (Q11)
AC-P1W5-20 [live-verify] Given an owned interactive session, When the operator presses Esc
  mid-turn, Then the sidebar dot leaves working within 2 s.
  Evidence: LV-P1W5-a
AC-P1W5-21 [live-verify] Given a managed-style run where classic.* is pinned (simulated by not
  registering the classic hooks), When turns run, Then the family stays legacy and the state
  still tracks through the hook blob.
  Evidence: LV-P1W5-c
AC-P1W5-22 [mod-test] Given a session.rebound, When the classic.SessionStart body runs, Then the
  fleet key equals the neutral state and permissionMode is unchanged.
  Evidence: resources/companion/tests/fleet-sensor.test.ts › "rebound resets fleet"
AC-P1W5-23 [mod-test] Given a tool.check dispatch with a tool_use_id and verdict allow, When it
  runs, Then probes.toolCheck is true and no record and no attention.raised exist.
  Evidence: resources/companion/tests/fleet-sensor.test.ts › "toolCheck probe is verdict-independent"
AC-P1W5-24 [mod-test] Given a classic.Stop payload with permission_mode "acceptEdits", When the
  hook runs, Then the permissionMode key holds that value.
  Evidence: resources/companion/tests/fleet-sensor.test.ts › "permission mode is recorded"
AC-P1W5-25 [unit] Given the kill switch turns off for an owned session, When a companion event
  and then a legacy Stop arrive, Then only the legacy one is applied.
  Evidence: tests/companion/task-state-adapter.test.ts › "kill switch mid-session"
AC-P1W5-26 [integration] Given a main turn that ends while a background subagent runs, When the
  subagent's completion notice starts the next turn, Then the evidence file records whether
  turn.start fired for it and its turnId, and a turn.abort with that id is accepted.
  Evidence: tests/cli/fleet-state.cli.test.ts › "notice turn has an abortable turnId" (Q24)
AC-P1W5-27 [live-verify] Given a turn that ends on a real API failure (a rate limit or an
  overloaded reply), When classic.StopFailure fires, Then the evidence file lists which of
  error, error_type and resets_at exist in the module payload and in the HTTP hook body, and
  whether the event came before or after turn.complete.
  Evidence: LV-P1W5-d (F1, Q29, OQ-b)
AC-P1W5-28 [integration] Given a session that spawns a teammate and, separately, a plain subagent,
  When both run and finish, Then the evidence file records the hook payloads each produced (ids,
  `agent_type`), `runningSubagents` counts only the subagent, and `turn.completed.backgroundSubagents`
  is not raised by the teammate (smoke §11.4).
  Evidence: tests/cli/fleet-state.cli.test.ts › "teammate is not a subagent" (OQ-c)
AC-P1W5-29 [mod-test] Given two agent ids in one session, one counted as a subagent and one unknown,
  When SubagentStop arrives for the unknown id, Then the count of the known one is unchanged and
  per-agent facts stay under their own id.
  Evidence: resources/companion/tests/fleet-sensor.test.ts › "per-agent facts keyed on agent id"
```

Cost cap for the L4 suite: haiku, three model calls, 0.05 USD, behind `HARNU_CLI_LIVE=1`
(QA-8). It runs with a temp HOME so the legacy bridge is absent and timings are clean.

**Live-verify recipes**

- **LV-P1W5-a.** (1) Second isolated instance, `taskState` set to `active` in
  `companion-prefs.json`, folder on the ramp. (2) Start a session, send a prompt that runs
  `sleep 60`. (3) Press Esc. (4) Read `hooks:stateFor` and the dot over CDP; expect `idle`.
  (5) Repeat with a permission dialog answered "No". (6) Repeat with a background subagent:
  expect `working` until the subagent's stop. (7) Export the ledger.
- **LV-P1W5-b.** (1) `--plugin-dir` a probe mod that logs `ui.render` site names and a hash of
  the element type, never content. (2) Trigger a Write that asks. (3) Wait 5 s, approve.
  (4) Diff the log before and after the keypress. (5) Record the verdict.
- **LV-P1W5-c.** (1) Instance started with `HARNU_COMPANION_DEV=1` and
  `HARNU_COMPANION_TEST_NO_CLASSIC` (dev only). (2) Run two turns with a tool call. (3) Read
  `companionStatus().sessions[…].ownership.taskState`: owner `legacy`, reason `unproven`.
  (4) The dot still moves.
- **LV-P1W5-d.** (1) Session with a `--debug-file`, the global hook install on, and a local
  capture of the bridge's raw `StopFailure` POST body (keys only). (2) Provoke an API failure
  (exhaust a rate window, or point the session at an endpoint that answers 529). (3) Record the
  keys of the module's `classic.StopFailure` payload and of the HTTP body, the order against
  `turn.complete`, and any field a `resetsAt` could come from. (4) Record the badge the sidebar
  shows today.

## 12. Docs deliverables

| Doc                            | Change                                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `CHANGELOG.md`                 | With the flip to `active`: `Fixed` — a session no longer stays "working" after Esc or a declined permission. Nothing while `shadow`. |
| `docs/harnu-features.md`       | none.                                                                                                                                |
| `docs/user/troubleshooting.md` | "Stuck" and "needs input" notes: what the Harnu mod changes, what it cannot see.                                                     |
| `docs/user/sessions.md`        | One sentence on subagents keeping the parent `working`.                                                                              |
| `design.md`, i18n              | none.                                                                                                                                |
| `01-contract.md`               | none: already merged (§7.3). `contract.ts` and the fixtures land with the code (DOC-7).                                              |

## 13. Rollout & parity gate

**Family:** `taskState`. Requires `sense.turn`, `sense.attention`, `sense.subagent` proven.

**Shadow comparison.** For every session with a binding, the adapter keeps two shadow folds of
the pure reducer, one per source, fed by the same `BridgeEvent`s the hub sees (applied, dropped
or record-only). Each state **transition** is recorded with `recordFact('taskState', source,
sid, 'state:<s>', { ev, m })`. Both folds keep running in `active`, so drift stays visible
(ADR-0018 kill criterion 5).

**Rule** (`parity-taskstate-rule.ts`, pure). Per session, collapse repeats, then match each
legacy transition to a companion transition to the same state inside
`[t − 10 000 ms, t + 2 000 ms]` (the legacy path is late: the bridge adds about 3.5 s per tool
call and `permission_prompt` arrives about 6 s after the request, smoke A4). Leftovers are
classified:

| Class | Explained divergence                                                                   |
| ----- | -------------------------------------------------------------------------------------- |
| E1    | Companion `idle` after an aborted or declined turn; legacy has no stop edge            |
| E2    | Companion `working` held for a subagent while legacy is `idle`                         |
| E3    | A companion `needs-input`/`working` pair shorter than the window that legacy never saw |
| E4    | Transitions before the family was proven for the session                               |
| E5    | Legacy `idle` from `idle_prompt` when the companion was already `idle`                 |

**Unexplained (each fails the gate):** a legacy `working` or `needs-input` with no companion
match; a legacy `Stop`-derived `idle` with no companion `idle` ("lost Stop"); a `completed`
mismatch; any order inversion outside the window.

**Gate to flip to `active`:** 200 sessions and at least 5 000 legacy transitions, zero
unexplained, and the corpus contains at least 20 approved dialogs, 10 declined, 10 Esc aborts,
20 subagent runs and 5 `/clear`. The trace is committed under
`tests/fixtures/companion-parity/taskState/` (QA-9).

**Demotes** (never deletes): the per-session `--settings` hook blob (`hook-settings-blob.ts`)
and the global hook install, for observation, to fallback for owned sessions. Both stay
injected (ARB-1). The transcript and PID-registry tiers are untouched.

## 14. Open questions

| #    | Question                                                                                                                                                                                                                            | Fallback designed                                                                                                                                                  | Owner      |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| Q11  | Does `ui.render` reveal the dialog closing?                                                                                                                                                                                         | Not used in protocol 1; AC-P1W5-19 records it for a later wave                                                                                                     | P1W5       |
| Q12  | Live values of `background_tasks[].type` and `.status`                                                                                                                                                                              | Only `type === 'subagent'` is read; AC-P1W5-18                                                                                                                     | P1W5       |
| CQ12 | Does `classic.PostToolUseFailure` fire, and for which failures?                                                                                                                                                                     | Optional hook; exits never depend on it; AC-P1W5-17                                                                                                                | P1W5, P3W1 |
| CQ13 | Do `classic.*` reach a module with no settings hook?                                                                                                                                                                                | `probes.classic` decides per session; AC-P1W5-16                                                                                                                   | P1W5       |
| OQ-a | Does `idle_prompt` fire while a subagent is held, and would it wrongly end the hold? (Since 2.1.288 it does not fire while background agents run, smoke §11.5; re-check on the ceiling.)                                            | The map ignores `idle` while `heldIdle`; covered by a unit test                                                                                                    | P1W5       |
| OQ-b | Does `classic.StopFailure` dispatch to modules, and before or after `turn.complete`?                                                                                                                                                | `failure` is optional; absent → `unknown`; AC-P1W5-27                                                                                                              | P1W5       |
| Q29  | Finding F1 (master §14): the 2.1.287 types show no `resets_at` and no `error_type` on `StopFailure` (L11385), while `hook-bridge.ts:149-155` reads both. Where does `resetsAt` of a rate-limited turn come from?                    | Left undefined on the companion path; AC-P1W5-27 records a real body                                                                                               | P1W5       |
| OQ-c | Do teammates dispatch `classic.SubagentStart` / `classic.SubagentStop` (with which `agent_id` and `agent_type`), and how do their `idle` and `waiting` states appear in `classic.Stop.background_tasks`? (CLI 2.1.289, smoke §11.4) | Only a `SubagentStart`/`SubagentStop` pair with a non-empty `agent_type` counts; teammates are not added to `backgroundSubagents`; AC-P1W5-28 records the payloads | P1W5       |
| Q24  | Does `turn.start` fire for a turn started by a subagent's completion notice, and is its `turnId` the one `$.turn.abort` accepts? (asked by P2W1)                                                                                    | The reconcile row covers a missing `turn.started`; AC-P1W5-26                                                                                                      | P1W5       |

## 15. Risks

| Risk                                                          | Mitigation                                                           |
| ------------------------------------------------------------- | -------------------------------------------------------------------- |
| R11: state stuck on `working` when the mod goes silent        | Lease expiry in 20 s → legacy; stuck timer and registry tiers stay   |
| A held subagent never reports its stop                        | `session.snapshot` reconciles the counter; next turn clears the hold |
| A lost `bye` swallows the `completed` edge                    | ARB-2d in P1W4's hub (AC-P1W4-21); AC-P1W5-11                        |
| `needs-input` lingers after a local approval of a long tool   | Same as legacy; documented; Q11 may improve it later                 |
| Dropping legacy `PreToolUse` starves the stuck anchor         | `noteLiveness` on every dropped legacy event                         |
| The CLI renames or stops dispatching a classic event          | Probes, optional hooks, QA-6 drift checks; family falls to legacy    |
| The hook-vocabulary translation drifts from `reduceTaskState` | One pure map with a table test (AC-P1W5-6) and the replay fixture    |
