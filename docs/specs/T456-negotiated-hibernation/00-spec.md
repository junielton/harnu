# T456 — Hibernation that negotiates with the session

**Status:** specified (not implemented) · **Date:** 2026-10-09 · **Card:** T456 · **ADR:**
[`ADR-draft.md`](ADR-draft.md) (proposed; numbered on merge)

Files: this spec; [`01-prototype.md`](01-prototype.md), the mod half's hooks module and its test
with the real `claude plugin validate`, `claude plugin test` and `tsc` output, the run of the
host-side bounds core, and the policy-level reproduction of §3.6; [`ADR-draft.md`](ADR-draft.md),
the one architectural decision (§5.1).

## 0. Summary

Before Harnu parks a session, it asks the session's Harnu mod (`harnu-companion`) one question
over the T389 command channel: `park.query`. The mod answers from what it knows inside the
`claude` process: `{ busy: reasons[], retryAfterMs? }`. The reasons can be a main turn in flight,
an unanswered permission ask, background tasks, background subagents, scheduled wakeups
(`CronCreate`, `ScheduleWakeup`, `/loop`), or a remote surface attached. An empty `busy` list
means the park goes ahead. A non-empty list delays the park. Harnu, not the mod, decides how long.

Six facts shape the design:

1. **The failure is real, and the policy cannot see it.** Today a session is "cold" when its PTY
   has been silent and unfocused (`fleet-policy.ts:81-83`). A session idle at its prompt while a
   background `git push`, an e2e suite or a `/loop` wakeup is pending looks exactly like a dead one.
   §3.6 reproduces the park against the shipped policy.
2. **Most of the facts already exist in the mod.** The shipped fleet sensor (P1W5) hooks
   `classic.Stop` and counts its `background_tasks` (`register.ts:1296-1297`,
   `fleet-sensor.ts:354-367`). `session_crons` sits in the same payload, unread
   (TYPES 12117-12132). The remote surfaces are one `$` read (TYPES 2806-2816).
3. **The answer can delay a park, so it needs `channel: active`.** `park.query` writes nothing in
   the session, but its answer can delay an actuation. Its feature `act.park` follows the actuator
   rule: its own key on, plus `channel: active`, as `act.plan` does (`01-contract.md:929, 1037`).
   It is not display-only, so it stays out of the observe-only set that `shadow` allows, and a CLI
   above the tested ceiling caps its key at the observe level (ARB-7b, `00-master.md:514`). Every other session, the default `shadow` install included, gets the legacy
   Stop facts: the same background-task and wakeup counts, read by the hook bridge (§5.5).
4. **The mod can never hold RAM for good.** Per cold episode there is a cap on the number of
   declines and a cap on total delay. Only a person ends an episode (focus, or a prompt the legacy
   hook marks `source: 'user'`), so a session's own crons cannot renew it. Memory pressure overrides
   any answer, and so does the operator's "Park now". The bounds core's test suite (28 tests, and
   every guard removed in turn fails one) asserts this (§6.6).
5. **A missing answer means today's behaviour.** A timeout, no binding, channel `off` or
   `shadow`, an old CLI, or a session on legacy hooks all fall back to the legacy Stop facts, then
   to today's park. The question opens an async gap, so the park is revalidated right before the
   kill (§5.6). The design adds a reason not to park. It never adds a way for parking to break.
6. **Nothing new to approve in Settings → Mods.** The mod half adds one `$` read
   (`$.session.surfaces`) and one field to an event it already hooks. A run of the real
   `mods-audit-core.ts` on the prototype gives two chips, both already on the companion (§9.3).

Pre-park preparation (U-4) adds nothing new. The P4W4 resume plan is the preparation, and it runs
only after the session answers "not busy". A pre-compaction is rejected, because a mod cannot ask
for a `precompute` (§7).

## 1. Origin and scope

**Origin.** Idea 112 of the operator's ideation report (`.harnu/out/claude-code-mods-ideas.md` in
the main checkout, gitignored): "Before System Monitor parks a cold session, Harnu asks the mod;
the mod answers from in-process facts — a tool call in flight, a `clock.every` timer, an attached
phone — and can pre-compact (`trigger: 'precompute'`) so the resume is cheap". The report lists it
in its "Ten I would build first": "the mod knows about a `git push` in flight. RAM reclaim becomes
safe by default."

**Goals.**

- G1. Never park a session that is doing work Harnu cannot see from its PTY: background tasks,
  scheduled wakeups, a pending permission ask, an attached remote client.
- G2. Bounded: no answer can keep a session's RAM past a fixed, operator-set limit. Memory pressure
  and the operator always win (U-3).
- G3. Safe default: on when the mod is live, today's behaviour when it is not. No new failure mode
  is added to parking.
- G4. Legible: the System Monitor shows "Harnu wanted to park this; the session said busy (why)".

**Non-goals.**

- No change to **who** becomes a candidate: `isEligible` and the three policy fields are
  untouched (`fleet-policy.ts:85-117`). Negotiation only runs once the policy has chosen a victim.
- No fix for BUG-72 (`hasPendingApproval` is hard-coded `false`), BUG-71 (kill without
  escalation) or BUG-100 (no notice to a dispatcher on park). Each interaction is stated where it
  matters (§3.4, §6.4, §7.3).
- No new MCP verb and no new field in `get_fleet` in v1 (Q3).
- No pre-compaction (§7.2), and no mod-to-mod "about to park" broadcast (§7.3).
- No negotiation for sessions Harnu does not own: Harnu only parks its own PTYs (§8.2).

## 2. Conventions

| Tag       | Source                                                                                                                                                                                                                                                                                         |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TYPES`   | `claude-code.d.ts` written by Claude Code **2.1.295** (line 1: "Written by Claude Code 2.1.295."), laid by the `plugin-authoring` skill for this session.                                                                                                                                      |
| `REF`     | The same build's `plugin-authoring/reference.md`.                                                                                                                                                                                                                                              |
| code path | This repository at base `cb7fb58`, the branch's parent.                                                                                                                                                                                                                                        |
| `T389/x`  | `docs/specs/T389-companion-mod/<x>.md`. `contract` = `01-contract.md`.                                                                                                                                                                                                                         |
| `PROBE`   | A run made for this spec on 2026-10-09 with the 2.1.295 binary (`~/.local/share/claude/versions/2.1.295`): `claude plugin validate`, `claude plugin test`, `tsc`, or a Node run of a repo module. Output is in `01-prototype.md`. A kit run settles the API and the logic, not a live session. |
| `MEASURE` | A reading taken on this machine on 2026-10-09, with the method stated where it is used.                                                                                                                                                                                                        |

**Verified** means read in the cited file or observed in a probe. **Assumption** marks anything
inferred and not observed. Each one is listed in §12 with the spike that settles it.

## 3. Today's policy (U-1)

### 3.1 The pieces

| Piece                      | Where                                                                                                         | What it does                                                                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The policy (pure)          | `src/main/fleet-policy.ts` (T119, T127)                                                                       | `explainFleet` (`:172-202`) gives a reason per session; `evaluateFleet` (`:204-237`) picks the victims per trigger                                                                                             |
| Defaults                   | `fleet-policy.ts:58-62`                                                                                       | `maxLive: 5`, `lruIdleMs: 15 min`, `hardIdleMs: 60 min`                                                                                                                                                        |
| Persisted policy (T127 S4) | `src/main/monitor/policy-store.ts:20-22, 63-72`                                                               | `<userData>/monitor-policy.json`, clamped (`:27-39`), re-read on every check (`pty.ts:646-655`)                                                                                                                |
| Editor (T127 S4, T135)     | `src/renderer/src/components/HibernationPolicyPane.vue`; i18n `hibernationPolicy.*` (`en.json:2097-2112`)     | The three fields. No other control                                                                                                                                                                             |
| Policy input               | `pty.ts:583-610` `fleetSnapshot()`                                                                            | One `LiveSession` per PTY that has a `sessionKey`                                                                                                                                                              |
| Triggers                   | `pty.ts:669` (`cap`, on `pty:create`); `pty.ts:1246-1248` (`sweep`, every `SWEEP_INTERVAL_MS` = 60 s, `:529`) | `cap` frees just enough slots for the newcomer; `sweep` parks every hard-idle session                                                                                                                          |
| Manual                     | `pty.ts:1094-1096` `pty:park` (System Monitor "Park now", BUG-69)                                             | Calls `hibernateSession` directly, bypassing every immunity; BUG-72 notes this is deliberate. The only `kind` gate is in the renderer: the button shows only for a parkable row (`SystemMonitorRow.vue:96-97`) |
| The kill                   | `pty.ts:619-644` `hibernateSession`                                                                           | Flush, `markParking`, bare `rec.pty.kill()` (`:631`), forget the record, `markHibernated`, `recordPark`, send `pty:hibernated`                                                                                 |
| Park state and ledger      | `src/main/hibernation.ts:19-39, 80-119`                                                                       | The parked set; the bounded park ledger (`PARK_HISTORY_CAP` 200) with wake gestures                                                                                                                            |
| Explain in the UI          | `sampler.ts:139` → `SystemMonitorRow.vue`; `system-monitor-format.ts:96-97`                                   | The per-row reason; only `lru` and `hard-idle` get a visible chip ("next to be swept")                                                                                                                         |

### 3.2 How it decides "cold"

`idleMs = min(now - lastFocusedAt, now - lastActivityAt)` (`fleet-policy.ts:81-83`): the warmer of
two clocks.

- `lastActivityAt` is stamped **only** when PTY bytes are flushed to the renderer
  (`pty.ts:569-571`) and at spawn. The `LiveSession` doc comment says "a PTY byte flush OR a
  hook-bridge event" (`fleet-policy.ts:24`). No other writer exists in `src/main`, so the
  hook-bridge half of that comment is stale. The signal rests on a spike: "an IDLE `claude` emits
  ZERO bytes: measured over 130 s of a parked prompt, 0 reads" (`pty.ts:359-366`).
- `lastFocusedAt` is pushed by the renderer on selection (`pty.ts:520-524`). The selected session
  is never a victim (`fleet-policy.ts:87`).

A session is a `cap` candidate past `lruIdleMs` and a `sweep` candidate past `hardIdleMs`, coldest
first (`fleet-policy.ts:124-133`). Only `kind === 'claude-resume'` can be parked: synthetics and
shells have nothing to resume (`fleet-policy.ts:72-74`).

### 3.3 The immunities, as built

| Rule                                          | Where                                                                            | Status                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Selected session                              | `fleet-policy.ts:87`; `pty.ts:594`                                               | Live.                                                                                                                                                                                                                                                                                                                                                              |
| Pending approval                              | `fleet-policy.ts:89`                                                             | **Inert.** Both producers hard-code `false` (`pty.ts:599`, `sampler.ts:136`). BUG-72, backlog.                                                                                                                                                                                                                                                                     |
| Mission owner with a live child (T363)        | `fleet-policy.ts:94`; `hibernation.ts:145-161, 201-217`; set at `pty.ts:603-608` | Live. An owner of an `active` mission is exempt while a `session` step link names a live PTY other than itself. Missions are read from disk; an unreadable directory fails open.                                                                                                                                                                                   |
| Mission owner, as the System Monitor shows it | `sampler.ts:127-137`                                                             | **Can mislabel.** The sampler builds its own `LiveSession` list for `explainFleet` without `ownsLiveMission`, so an exempt owner can read `lru` or `hard-idle` ("next to be swept") in the System Monitor although the policy will not park it. W1 must wire the sampler for the new `declined` reason (§6.5) and fixes this on the way.                           |
| "A session actively working is never parked"  | `docs/harnu-features.md:674`                                                     | **Not what the code does.** A `working` claim gets the strict threshold, not immunity: `effectiveThreshold = taskState === 'working' ? hardIdleMs : thresholdMs` (`fleet-policy.ts:115`). T119 chose this on purpose, because the hook FSM can latch `working` forever (`fleet-policy.ts:96-114`; T119 spec §3, `docs/specs/T119-session-hibernation.md:330-349`). |

### 3.4 What a park costs the session

The process is killed with no signal argument and no escalation (`pty.ts:631`; BUG-71). Whatever
the session was running dies with it, or is orphaned, which BUG-71 calls latent. That includes any
background shell or Monitor, and its session-scoped crons (TYPES 12129: "Session-scoped cron tasks
… that will wake this session later"). The conversation survives on disk, and selecting the row
resumes it (`hibernation.ts:6-18`). So a park loses **in-flight work**, never the transcript.

### 3.5 The rule T119 rests on

T119 parks a `working` session after an hour because "real work is never SILENT for a full hour
(any turn, tool call, or spinner tick writes bytes)" (`T119-session-hibernation.md:342-344`). That
holds for work **inside a turn**. Background work runs **outside** a turn by design. TYPES 12125
describes the case exactly: "session is paused waiting for background work to wake it". A
`ScheduleWakeup` or `/loop` session has no turn at all until its wakeup fires. `ScheduleWakeup` is
"Clamped to [60, 3600] by the runtime" (TYPES 16588), so the strict `sweep` (idle **over** 60 min)
never reaches a dynamic `/loop` session: its exposure is `cap`, at 15 min. A `CronCreate` job
whose interval is over 60 min is exposed to both.

### 3.6 The known failure, reproduced

No board card records a session parked mid-background-work. Every card that mentions parking was
read: T119, T127/T133/T135, T363, BUG-65, BUG-69, BUG-70, BUG-71, BUG-72, BUG-100, T167. The
nearest are BUG-71 (orphans on kill) and BUG-100 (dispatched sessions do not exit, and are "eventually
reaped by the hibernation policy"). The reproduction is therefore built from the shipped code.

**PROBE (policy level).** The shipped `fleet-policy.ts` was fed, through Node's type stripping,
the snapshot `fleetSnapshot()` builds for these sessions (script and output in `01-prototype.md`
§P3):

| #   | Session                                                                                                    | Hub state (P1W5)                                                                                           | Result                                      | Rests on |
| --- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------- | -------- |
| 1   | Fleet at `maxLive` (5). One session cold for 16 min, with a background e2e run it started in its last turn | `idle`: a background **shell** does not hold the state (T389/P4W4 row E4, `P4W4-resume-micro-plan.md:119`) | `cap` victims `['bg-e2e']`, reason `lru`    | A1       |
| 2   | Fleet at `maxLive`. A dynamic `/loop` session cold for 16 min, waiting on a `ScheduleWakeup`               | `idle`                                                                                                     | `cap` victims `['loop-wakeup']`             | A1b      |
| 2′  | The same session alone, 60 min after its last turn (the longest a `ScheduleWakeup` can wait)               | `idle`                                                                                                     | `sweep` victims `[]`: the clamp protects it | —        |
| 3   | A `CronCreate` job every 90 min, 61 min after its last fire                                                | `idle`                                                                                                     | `sweep` victims `['cron-every-90m']`        | A1b      |
| 4   | A background subagent, PTY silent for 61 min                                                               | `working` (a background subagent holds it, `companion/ingest/task-state-map-core.ts:105-118`)              | `sweep` victims `['bg-agent']`              | A1       |

The background state is invisible to the policy for a structural reason. `fleetSnapshot()` reads
only the task state, focus and PTY bytes (`pty.ts:583-610`). The hub's background-task count, which
P1W5 already ships (`turn.completed.backgroundTasks`, `contract.ts:295`), is never read.

**What each row rests on.** The runs prove what the policy does with these snapshots, not that a
live session produces them. Rows 1 and 4 rest on **A1**: while a background task or subagent runs,
an interactive `claude` idle at its prompt emits no PTY bytes. If it redrew a status line,
`lastActivityAt` would stay fresh and those sessions would never reach the policy. Rows 2 and 3 rest
on **A1b**, the same claim for a pending wakeup with nothing running. A1b is close to the measured
case ("an IDLE `claude` emits ZERO bytes … 130 s of a parked prompt", `pty.ts:359-366`), but that
spike had no wakeup scheduled. Neither is measured: the spawn that would measure them was refused in
this session (§12).

## 4. What the session knows that Harnu does not (C-1)

Every fact below is read by the mod half of §5. "Already in the mod" means the shipped companion
hooks that event today (`validate` of the staged companion, §9.3).

| Fact                                                        | Engine source (2.1.295)                                                                                                                                                                                                                                                                                                                   | Already in the mod                                                                                                                                       | Shown by a run                                                              |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| A main turn in flight                                       | `turn.start` (TYPES 4446; `TurnStartInput` 13374-13385; "a subagent's run raises no `turn.start`", 13295-13296), cleared by `turn.complete` with no `agentId` (TYPES 4464, 13299-13307)                                                                                                                                                   | yes: `activeTurnId` (`fleet-sensor.ts:253`, cleared `:405`)                                                                                              | test "a turn in flight is busy, and its end clears it"                      |
| A permission dialog shown to a person                       | `classic.PermissionRequest` (`PermissionRequestHookInput`: `tool_name`, `tool_input`, no call id; TYPES 7507-7513), settled by `classic.PostToolUse` / `PostToolUseFailure` for that tool (7865-7876, 7852) or the turn's end. A `tool.check` verdict of `ask` is **not** used: in auto mode the classifier settles it, not a person (A7) | yes: `open` items raised with `source: 'request'` (`fleet-sensor.ts:286-317`, hooked at `register.ts:1264-1270`) and cleared by `post-tool` (`:338-352`) | test "a permission dialog shown to a person is busy until its tool settles" |
| Background tasks (shell, monitor, workflow, MCP task)       | `classic.Stop` (classic events TYPES 1230-1252) carries `background_tasks: BackgroundTaskSummary[]`, "In-flight background work (running/pending + backgrounded) … Empty array when nothing is in flight" (12117-12132; summary type 793-823, `type`, `status`, `command`)                                                                | counted only: `lastStop.all` (`fleet-sensor.ts:354-367`), emitted at turn end (`:397`) and then cleared (`:408`)                                         | test "background shell, monitor and a wakeup from the last Stop"            |
| Background subagents                                        | the same list, `type === 'subagent'`; the CLI keeps a finished agent listed as `running` in the next Stop, so stopped ids from `classic.SubagentStop` (TYPES 12244-12260) are subtracted (observed on 2.1.291, `fleet-sensor.ts:44-47`)                                                                                                   | yes: `runningSubagents`, `stopped` (`fleet-sensor.ts:398, 418, 440`)                                                                                     | test "a subagent that already stopped is not counted"                       |
| Scheduled wakeups (`CronCreate`, `ScheduleWakeup`, `/loop`) | `classic.Stop.session_crons: SessionCronSummary[]`, "Session-scoped cron tasks … that will wake this session later. Empty array when none are scheduled" (TYPES 12128-12131; type 10987-11000, `recurring`)                                                                                                                               | **no**: in the payload the mod already receives, unread                                                                                                  | test "background shell, monitor and a wakeup …"                             |
| A remote surface attached (phone, desktop)                  | `$.session.surfaces()`: "every surface the session draws on … `terminal` under the REPL first, then the remote ones in the order they attached" (TYPES 2806-2816; join/leave events `session.attach` 4386-4395, `session.detach` 4403)                                                                                                    | **no**: one new `$` read, made at question time                                                                                                          | test "an attached phone is busy, read at ask time"                          |

The ideation report's other two sources are dropped on purpose:

- **"A tool call in flight"** is covered by "a main turn in flight". A foreground tool call only
  runs inside a turn, and its spinner writes bytes. A per-call set would need a `tool.call` hook.
  That adds the `tool-calls` chip, and MOD-3 caps the companion's `tool.call` matchers
  (`00-master.md:524`; R8, `:605`, a Bash matcher breaks worktree-isolated agents).
- **"A `clock.every` timer"** of the mod's own says nothing about the session's work. The
  session's real timers are its `session_crons`.

`classic.Stop` is the right moment for the snapshot. Every main turn ends with one, and background
work that finishes wakes the session, which runs a turn and ends in a fresh Stop (TYPES 12125,
assumption A2 for the edge cases).

## 5. The protocol (U-2)

### 5.1 Where the question sits

P4W4 planned the park coordinator `requestPark` and said that "every park goes through" it
(`P4W4-resume-micro-plan.md:21-24, 90-110`). P4W4 is not implemented: `plan.capture` is absent
from `IMPLEMENTED_COMMANDS` (`command-core.ts:97-104`) and no `park-coordinator.ts` exists. T456
ships that coordinator first, with negotiation as its first stage. P4W4 later adds its capture as
the second stage. `hibernateSession` stays the only killer (P4W4 risk table, `:496`; BUG-69).

```
runPolicy(trigger) / pty:park ─► requestPark(sessionKey, cause: 'cap' | 'sweep' | 'manual')
   decide(...)                                                    (§6.1, pure)
   ├─ park (operator · disabled · memory-pressure · limit) ─────► [P4W4 capture stage] ─► hibernateSession
   ├─ defer (inside a granted delay) ───────────────────────────► nothing; asked again after `until`
   └─ ask
        canAsk ? enqueue park.query (wait ≤ NEG_QUERY_WAIT_MS) : answer = silent
        applyAnswer(...)                                          (§6.1, pure)
        ├─ episode returned (busy) ─► record the decline; System Monitor shows it (§6.5)
        └─ null (free, or silent with no legacy facts)
             revalidate(...)                                     (§5.6, pure)
             ├─ ok ─► [P4W4 capture stage] ─► hibernateSession
             └─ not ok ─► cancel; no decline counted; the next sweep decides again
```

`park` from `decide` is revalidated too, before the kill. It opened no gap unless the coordinator
awaited something, but the check is cheap and keeps one path to the killer.

`requestPark` returns at once, as in P4W4 (`:108-110`). A `cap` spawn never waits: the new PTY is
spawned first, and the fleet stays over `maxLive` until the coordinator settles. When the coldest
candidate declines, `cap` moves to the next candidate. If every candidate declines, the fleet stays
over the ceiling. T119 §3.5 already accepts that: "a ceiling that blocks the operator's work is
worse than the problem it solves" (`fleet-policy.ts:221-224`).

### 5.2 Wire: one command added to the closed set

The direction rule is unchanged. "The mod is the only client … the host never connects to the mod"
(`contract:26`). Commands flow host → mod, at least once (`contract:375`), over the long-poll
(`P2W1-command-channel.md:35-38`). Each command is answered by exactly one `command.result`
(`contract:552-558`; mod side `register.ts:901-916`). Adding a command is an additive change that
does not bump `v` (`contract:1112-1113`). The contract file and `contract.ts` change in the same
change (`contract:14-19`).

```ts
// 01-contract.md §9 and resources/companion/hooks/contract.ts — additions
type CommandName = /* … */ 'park.query'

interface CommandArgs {
  // …
  'park.query': { cause: 'cap' | 'sweep' | 'manual' } // no text, no path (SEC-5a)
}

type ParkBusyReason =
  | { kind: 'turn' }
  | { kind: 'permission'; count: number }
  | { kind: 'background-task'; count: number; types: string[] } // ≤ 4 BackgroundTaskSummary.type labels
  | { kind: 'background-subagent'; count: number }
  | { kind: 'scheduled-wakeup'; count: number; recurring: number }
  | { kind: 'remote-surface'; surfaces: RenderSurface[] } // never 'terminal'

interface CommandResultData {
  // …
  'park.query': { busy: ParkBusyReason[]; retryAfterMs?: number }
}
```

| Row (contract §9 table, `contract:750-765`) | Value                                                                                                                                                                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$` effect                                  | the handler makes none: one read, `$.session.surfaces()`, and the mod's kept facts. The executor around it writes the channel state as for every command (`register.ts:919-956`)                                                            |
| Result                                      | `ok: true` with `data` always. `busy: []` means "park me"                                                                                                                                                                                   |
| Refusals                                    | the standard executor set (`CMD_EXPIRED`, `CMD_UNSUPPORTED`, `FEATURE_DISABLED`, and `CMD_FAILED` or `CMD_PRECONDITION` from `mapEngineRejection`, `command-core.ts:216-221`; `contract:1068-1083`). The host reads any of them as `silent` |
| Profile                                     | interactive. Headless is never parked (`fleet-policy.ts:72-74`)                                                                                                                                                                             |
| Feature                                     | **`act.park`**, class `actuator`: the command changes nothing, but its answer can delay an actuation. Enabled when key `park` = `ask` and key `channel` = `active`, like `act.plan` (`contract:907-930`)                                    |
| Wave                                        | T456                                                                                                                                                                                                                                        |

**Not observe-only.** `park.query` stays out of the observe-only set (`contract:785-787`) and out of
`shadowRefusal` (`command-gate-core.ts:127-144`), so in `shadow` it is refused `MODE_SHADOW`.
`act.park` has no fact family, so it has "no legacy rival to arbitrate against" (`contract:932`),
and ARB-6b's family rule does not decide its mode. The actuator rule does. An actuator with no fact
family "has its own key in `companion-prefs.json`" (ARB-6b, `00-master.md:513`), and every
non-observe command needs `channel: active` (`contract:1037`). That is exactly how `act.plan` is
gated (`contract:929`). `park.query` changes nothing in the session, but its answer can delay an
actuation, the park, so it is classed with the actuators. The observe-only set holds display-only
commands. A default install (`channel: shadow`) is therefore **facts-only**, which already covers
background tasks, subagents and wakeups. `ask` adds the turn, the permission dialog, the remote
surface and the retry hint once the operator sets the channel to `active`. Recording `park.query`
answers in `shadow` for parity, never applied, is possible under ARB-6b (Q9) but is not in v1.

**Gate row** (`registerGateRow`, the pattern of `command-gate-core.ts:62-73`):
`registerGateRow('park.query', { feature: 'act.park', internal: ['park'] })`, and `'park.query'`
is appended to the host's `COMMAND_NAMES` (`command-gate-core.ts:23-38`). Only the cause
`internal` with tag `park` passes, and only the coordinator holds it (SEC-5c, as `plan.capture`
does in `P4W4-resume-micro-plan.md:104-106`). No verb, operator gesture or debug path queues it.
Each enqueue is audited like any other (SEC-6, `00-master.md:499`).

**Mod side.** `case 'park.query': return runParkQuery($, c)` in the closed switch
(`register.ts:1012-1029`). `'park.query'` is added to `IMPLEMENTED_COMMANDS`
(`command-core.ts:97-104`) and to `COMMAND_FEATURE` as `'act.park'` (`command-core.ts:76-91`). The
mod's own feature check then answers `FEATURE_DISABLED` whenever the host did not enable `act.park`
(`command-core.ts:150-151`). The handler is the
pure `answerParkQuery(facts, await $.session.surfaces())` of `01-prototype.md` §P1. It is awaited
inside `runCommand` like the other short handlers (`register.ts:919-956`): it never calls a `$`
that MOD-6 forbids awaiting (`00-master.md:527`).

**Kept facts.** The sensor's `lastStop` is cleared at every main turn's end
(`fleet-sensor.ts:408`), but the query needs the last Stop **after** that turn. One field is added
to the persisted `fleet` state key (contract §22, `contract:1334`):
`idle: { tasks: { id, type }[]; crons: { recurring }[] } | null`, written at `classic.Stop` from
`background_tasks` (with the sensor's FINISHED filter, `fleet-sensor.ts:94`) and `session_crons`.
It is replaced at the next Stop and never cleared at turn end. It lives in `$.state`, not module
memory, so a hot reload keeps it (REF 72-73: a reload drops module variables). The prototype keeps
it in a module variable only for brevity.

### 5.3 Privacy

The answer carries counts and type labels only. A background shell's `command` and a cron's
`prompt` are both in the Stop payload (TYPES 805-807, 10997-11000) and may hold secrets. Neither is
read into `idle`, and neither ever leaves the mod. The prototype test asserts that `git push`
never appears in the answer. This follows SEC-8 (`00-master.md:501`) and the P4W4 rule that model
or user text never reaches an audit row (`P4W4-resume-micro-plan.md:268-271`).

### 5.4 Timeout, silence and modes

`NEG_QUERY_WAIT_MS` = **5 000**. This is the wait the shipped "Test Harnu mod channel" uses for the
same round trip (`PING_WAIT_MS`, `companion-ipc.ts:50, 81`). The mod holds its poll open, so a
command is delivered on the held request, not on the next poll (`P2W1-command-channel.md:35-37`).
The command's own TTL is set to the same 5 s, not the default `CMD_TTL_MS` 30 000 (`contract:440`).
A late answer is then refused `CMD_EXPIRED` by the mod and never acted on.

| Situation                                                                                                                                        | Host sees                                                        | Behaviour                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- | --------------------------------------------------------------- |
| Mod live, channel `active`, key `park` = `ask`                                                                                                   | `result`                                                         | negotiated                                                      |
| Mod live, channel `shadow` (the default)                                                                                                         | `MODE_SHADOW` (`command-gate-core.ts:127-144`); not sent         | legacy facts (§5.5), else today's park                          |
| No answer within 5 s                                                                                                                             | `silent`                                                         | legacy facts (§5.5), else today's park                          |
| Mod absent: CLI too old, companion mode `off`, org policy, `--safe-mode`, `--bare`                                                               | `NO_BINDING` (`P2W1:413`, `command-channel.ts:428-432, 668-671`) | legacy facts, else today's park                                 |
| Channel key `off`                                                                                                                                | `FEATURE_OFF` (`command-gate-core.ts:132`)                       | legacy facts, else today's park                                 |
| CLI above the tested ceiling (`channel` capped at `shadow`, `P2W1:414`; key `park` capped at its `observeCap`, `facts`, ARB-7b)                  | not sent                                                         | legacy facts, else today's park                                 |
| Kill switch turned off mid-question                                                                                                              | `dropped: revoked` (`P2W1:415`)                                  | `silent`                                                        |
| Headless (`-p`, scheduler ticks)                                                                                                                 | never asked                                                      | never parked (`fleet-policy.ts:72-74`)                          |
| Session on **legacy** hooks (the Harnu mod state `legacy`, `00-master.md:723`; System Monitor's `legacy` chip, `docs/user/system-monitor.md:22`) | no binding                                                       | legacy facts, else today's park                                 |
| Key `park` = `off`                                                                                                                               | not asked                                                        | today's behaviour exactly; the legacy facts are not read either |

The key `park` is registered with `observeCap: 'facts'` (`registerPrefsKey`, `00-master.md:720`),
so ARB-7b's "every feature key capped at its observe level" (`contract:1047-1049`) caps it without a
special case. Companion modes are `off | shadow | active` (`src/main/companion/mode.ts:22`). "Legacy" is not a
mode. It is a per-session state that runs on hooks and polling, and it is handled by the legacy
facts.

### 5.5 Legacy facts: the same Stop, read by the hook bridge

A session with no live mod still runs Harnu's settings hooks. `Stop` is one of them
(`hook-installer.ts:44`). The bridge parses the whole JSON body (`hook-bridge.ts:131-137`), then
keeps only `session_id`, the matcher, a failure class and `agent_id` (`:139-171`).
`background_tasks` and `session_crons` arrive on every main `Stop`
(TYPES 12117-12132; a classic event's `e` is "the hook's whole stdin input", TYPES 1240-1242) and are dropped.

T456 keeps two counts per session from that body: background tasks (subagents included) and
crons. It keeps no text. With them a legacy session gets the same busy reasons except `turn`,
`permission` and `remote-surface`. The hook FSM already marks those first two as `working` or
`needs-input`. The legacy path has no `retryAfterMs`: the host default applies. These counts are
also the fallback when a mod-backed session is `silent`.

**Where they are read.** The hub's `ingest` drops every event of a parked session
(`src/main/detect/task-state-hub.ts:182`). It also drops a legacy event for a family the companion
owns (`:196-201`; ARB-2b, "Legacy input for an owned family is dropped at the adapter boundary",
`00-master.md:509`). So for a companion-owned session the hub never sees these facts. T456 reads
`background_tasks`, `session_crons` and `UserPromptSubmit.source` in `hook-bridge.ts`'s request
handler (`:131-171`), before the event is handed to `ingest` (`:354`). That is not a second writer
under ARB-2a ("One writer per (session, family) … Two sources are never merged", `:509`). The park
coordinator is a separate host consumer of the hook body. It folds nothing into the `taskState`
family, and the hub's state for that session is untouched.

### 5.6 Revalidation right before the kill

Today the decision and the kill run in the same tick (`pty.ts:651-655`). With T456 there is a gap
of up to `NEG_QUERY_WAIT_MS` between the decision and the answer. In that gap the operator may
select the session, or a turn may start. A `free` or `silent` answer must not then kill a session
that would no longer have been a victim. P4W4 specified this check (`revalidatePark`,
`P4W4-resume-micro-plan.md:130-135`) but it is unbuilt, and T456 builds the coordinator first, so
T456 owns it.

`revalidate(cause, requestedAt, before, now)` is pure and tested (`01-prototype.md` §P2). It runs
on every path into `hibernateSession`, after the answer and before the P4W4 capture stage:

| Check, in order                                                          | Fails as    | Applies to     |
| ------------------------------------------------------------------------ | ----------- | -------------- |
| the session still has a PTY                                              | `gone`      | all            |
| it is the same `ptyId` as at the decision                                | `respawned` | all            |
| no legacy `UserPromptSubmit` edge (any `source`) since `requestedAt`     | `prompted`  | `cap`, `sweep` |
| not the selected session                                                 | `selected`  | `cap`, `sweep` |
| `lastFocusedAt` not advanced since `requestedAt`                         | `focused`   | `cap`, `sweep` |
| `lastActivityAt` not advanced since `requestedAt` (PTY bytes in the gap) | `active`    | `cap`, `sweep` |

A failed check cancels the park and counts no decline. The next sweep decides again from scratch.
`manual` checks only the first two: the operator pointed at that process. The PTY-bytes check is
safe here because `park.query`'s handler draws nothing. P4W4's capture may print (its OQ5,
`P4W4:485`), which is why P4W4's own revalidation, after the capture, ignores bytes; the two checks
cover two different gaps. `lastPromptAt` comes from the hook bridge's `UserPromptSubmit` edge
(`hook-installer.ts`, always installed per ARB-1, `00-master.md:508`), not from the mod's
`turn.started`.

**What revalidation does not check.** It does not re-check that the park is still **needed**. If
the operator raises `maxLive`, `lruIdleMs` or `hardIdleMs` during the gap, or the session becomes
an exempt mission owner (a child linked and live), the park still goes ahead. So does a `cap` park
after another session has exited. The gap is at most `NEG_QUERY_WAIT_MS`, and the cost of such a
park is a resume, never work: the session was idle, unfocused and unprompted for the whole gap.
v1 states the gap rather than re-running `explainFleet` before the kill. W1 may close it by
re-running the policy for that one session and cancelling unless its reason is still `lru` or
`hard-idle`.

**When P4W4 plugs in.** P4W4's `revalidatePark` checks that "no `turn.started` arrived since
`requestedAt`" (`P4W4-resume-micro-plan.md:132-133`). That is the mod's sensor edge, the one §6.1
refuses to use as authority. If P4W4 lands as written, the two stages disagree on what a new turn
is. Q8 covers aligning them.

## 6. Bounded (U-3)

### 6.1 The core

The host half is four pure functions with a vitest suite (`01-prototype.md` §P2):

- `decide({ now, cause, episode, settings, memAvailableMb })` returns `park` (operator, disabled,
  memory-pressure, limit), `defer`, or `ask`, checked in that order.
- `applyAnswer(episode, answer, legacyBusy, now, settings)` returns the next **episode**, or `null`
  to park now.
- `resetEpisode(episode, edge)` closes an episode on a reset edge.
- `revalidate(...)`, §5.6.

An **episode** is one cold stretch of one session: `{ firstDeclineAt, declines, until, reasons }`.
It opens with the first decline and closes only on an edge from **Harnu's own side** that means a
person is back:

- the operator selects the session (the renderer's focus push, `pty.ts:520-524`);
- a legacy `UserPromptSubmit` edge with `source: 'user'`, "submitted from the interactive composer"
  (TYPES 14661-14667). The legacy hook is always installed (ARB-1, `00-master.md:508`).

The mod's `turn.started` is not used. It is sensor traffic, which "no consumer trusts … as
authority" (`P1W1-host-server.md:577-579`), and a reset is authority: it renews the hold. A prompt
whose `source` is `schedule_wakeup`, `loop_wakeup`, `system`, `sdk` or absent (the field is still
rolling out) does not reset. So a session whose own cron keeps waking it cannot renew its budget,
and the test "a recurring cron every N min cannot renew the hold under cap pressure" checks this for
60, 90 and 150 min. An absent `source` errs toward parking, and a person typing in Harnu has
usually selected the session, which resets it anyway.

**A pin this design does not close.** A session that keeps writing PTY bytes is never cold, so the
policy never chooses it, it is never asked, and the memory floor never reaches it either: the floor
only overrides answers. A mod that redraws a clock in a status line or a pane does exactly that.
This channel exists today, without T456, and T456 neither opens nor closes it. Closing it would mean
the floor parking warm sessions, which is a change to who becomes a candidate (non-goal, §1). It is
recorded as Q10.

### 6.2 Constants

| Constant                    | Default   | Basis                                                                                                                                                                                                         |
| --------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NEG_QUERY_WAIT_MS`         | 5 000     | `PING_WAIT_MS`, the shipped wait for the same round trip (`companion-ipc.ts:50`)                                                                                                                              |
| `NEG_RETRY_MIN_MS`          | 60 000    | `SWEEP_INTERVAL_MS` (`pty.ts:529`): asking more often than the sweep runs buys nothing                                                                                                                        |
| `NEG_RETRY_MAX_MS`          | 1 800 000 | The longest a `Monitor` may run before it is re-armed: "Deadlines above 1800000ms are capped to 1800000ms" (TYPES 16390)                                                                                      |
| `NEG_RETRY_DEFAULT_MS`      | 600 000   | Design value. Used when the answer has no `retryAfterMs`, and on the legacy path                                                                                                                              |
| `maxDeclines` (setting)     | 8         | Design value: at the default retry, 8 declines give a background job about 70 min of grace (§6.6), inside `maxDeferMs`                                                                                        |
| `maxDeferMs` (setting)      | 7 200 000 | Design value: twice `hardIdleMs` (`fleet-policy.ts:61`). The hold past the policy's park point is never longer: `until` is capped at `firstDeclineAt + maxDeferMs`                                            |
| `pressureFloorMb` (setting) | 1 536     | Design value, scaled by a measurement: 3 × the median RSS of a live `claude` on this machine (504 MB, §6.3), rounded. The factor 3 is a choice, not a measurement: at the floor, three parks restore headroom |

The mod's hints in the prototype are `turn` 120 000 and `permission` 300 000. Background and wakeup
reasons give no hint, so the host default applies. The host clamps every hint to
[`NEG_RETRY_MIN_MS`, `NEG_RETRY_MAX_MS`].

### 6.3 Memory pressure overrides any answer

**MEASURE (2026-10-09, 16:33 -03:00).** `ps -eo pid,rss,args` on this machine shows 15
interactive `claude` processes (`/usr/local/bin/claude`) at **466–571 MB RSS each, median 504 MB**,
7 665 MB in total. `/proc/meminfo` gives `MemTotal` 65 645 908 kB and `MemAvailable` 23 941 484 kB.
One deferred session therefore holds about half a gigabyte. On this machine's 62.6 GiB that is not
pressure, which is why the floor is relative to session size, not a share of RAM.

The host reads `MemAvailable` (Linux `/proc/meminfo`). Below `pressureFloorMb`, `decide` returns
`park` before it looks at any episode, and the session is not asked. On macOS and Windows the
reading is `os.freemem()`. Whether that is comparable to `MemAvailable` is assumption A5. Until it
is settled, those platforms use `memAvailableMb: null`: the override is off and the two caps still
bound everything. The sampler that already measures per-session RSS for the System Monitor
(`src/main/monitor/sampler.ts`) is the natural home for the reading. No memory-pressure signal
exists in `src/main` today; a search for `freemem`, `MemAvailable` and `pressure` finds only PTY
backpressure.

### 6.4 The operator overrides

- **Park now** (System Monitor) is `cause: 'manual'`. `decide` parks at once and does not ask
  (test "Park now parks without a question", `01-prototype.md` §P2). This keeps BUG-72's stance that an explicit gesture
  parks what it points at. The ledger records `override: true` when the row was declining at that
  moment.
- **Settings → Hibernation policy** gets a switch, "Ask the session before parking" (key `park`,
  §9.1), and the three settings of §6.2.
- Selecting the session ends the episode (§6.1). It also makes the session immune, as today.

### 6.5 What the operator sees

- **System Monitor row.** `explainFleet` gains the reason `'declined'`, placed after
  `'mission-owner'` and before `'hard-idle'`. `isNoteworthyLiveReason`
  (`system-monitor-format.ts:96-97`) shows it as a chip: "Asked to stay · 2 background tasks". The
  tooltip lists every reason, the count `3 of 8`, and "asks again in 9 min". The pure policy gets
  the episode as one more optional field on `LiveSession` (`ownsLiveMission` set the pattern,
  `fleet-policy.ts:28-33`), so `evaluateFleet` skips a session inside `until` and every existing
  caller keeps its behaviour. Both producers of `LiveSession` must set it: `fleetSnapshot()`
  (`pty.ts:583-610`) and the sampler (`sampler.ts:127-137`). The sampler today omits even
  `ownsLiveMission` (§3.3), so W1 wires both fields there, or the System Monitor would never show
  `declined`.
- **After the park.** The park ledger entry (`hibernation.ts:82-87`) gains
  `negotiation?: { declines, reasons, why }`. `why` is `free`, `silent`, `limit`,
  `memory-pressure` or `operator`. The parked row's explanation line
  (`docs/user/system-monitor.md:20`) then reads, for example, "Parked after 8 declines (background
  task)" or "Parked under memory pressure; the session said busy".
- **No notification and no sound.** A decline is the system working. The T178 rule followed by
  P4W4 holds: no toast, no sound for parking (`P4W4-resume-micro-plan.md:306-307`). Q4 asks whether
  a park that overrode a "busy" answer should notify.

### 6.6 The bounds, tested

`01-prototype.md` §P2 holds `park-negotiation-core.test.ts`: 28 vitest tests, all passing. What
they assert, among others:

| Test                                                                              | Asserts                                                           |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| after maxDeclines questions when it asks to be asked again soon                   | parked by `limit` after exactly `maxDeclines` questions, at 8 min |
| after maxDeferMs when declines alone would never run out                          | parked by `limit` at exactly `maxDeferMs` (120 min)               |
| the hold past the first decline never exceeds maxDeferMs, whatever the hint       | for hints from 1 ms to 10 h                                       |
| memory under the floor parks at once and asks nothing                             | 0 questions; also inside a granted delay                          |
| a recurring cron every 60 / 90 / 150 min cannot renew the hold under cap pressure | parked by `limit` within `maxDeferMs` of the first decline        |
| a person typing every hour keeps the same session live                            | the reset works for `source: 'user'`                              |
| revalidate: prompted / selected / focused / active / respawned in the gap         | each cancels a sweep park; `manual` checks only the process       |

**Mutation check.** Each guard was removed in turn from a copy of the core, and the same suite was
run against the copy. Every mutant fails at least one test: no `maxDeclines` check (1 failure), no
`maxDeferMs` check (2), no memory floor (2), no `until` cap (1), reset on any prompt (2), no
`prompted` revalidation (1). Output in `01-prototype.md` §P2.

So the most a session can be held past the policy's own park point is `maxDeferMs`, and the most a
mod can be asked per episode is `maxDeclines`. Both are operator settings.

## 7. Pre-park preparation (U-4)

### 7.1 The options

| Preparation                                             | Status                                                                                                                                                                                                                          | Cost                                                                                                                                                                                            | Verdict for T456                                                          |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **Resume digest** (P4W4 `plan.capture`, `$.model.fork`) | specified, not implemented (`plan.capture` is in the contract, `contract:765`, not in `IMPLEMENTED_COMMANDS`)                                                                                                                   | warm fork 1 881 ms, `input 33, output 179, cache_read 50 989` (smoke D4, `P4W4:41`); a cold fork re-bills the whole context (TYPES 2625-2626: "the prefix billed afresh once the entry lapsed") | **kept as is**; runs as the coordinator's second stage, only after `free` |
| **Pre-compaction**                                      | not possible as asked. A plugin's `$.session.compact(args)` takes only `instructions` and runs as trigger `plugin` (TYPES 4745, 10744-10750). `precompute` is the engine's own dispatch, which "installs nothing" (10850-10856) | a full summarizer pass over the context, and the conversation is rewritten before the operator chose it                                                                                         | **rejected** (§7.2)                                                       |
| **Flush state to `$.store`** by the session's mods      | no Harnu mechanism needed. Each mod already gets `session.end` when the process ends by a signal (TYPES 4416-4418, "exit, /clear, resume, logout, signal"), with a 1.5 s bound (TYPES 11045-11047)                              | the mod's own                                                                                                                                                                                   | **no new mechanism**; A3 checks that a park's kill reaches `session.end`  |

### 7.2 Delta against P4W4 and P4W5

**P4W4 (resume micro-plan).** Three changes, nothing more:

1. The coordinator P4W4 owns (`P4W4:21-24`) is built by T456 first (§5.1), with the revalidation
   of §5.6. P4W4's capture becomes its second stage, reached on `free`, `silent` and `limit`, never
   on `memory-pressure` (§7.3).
2. Row E4 ("busy → `park-now`, no capture", `P4W4:119`) stays as written. Under T456 it is reached
   less often, because a busy session is now deferred instead of parked. When `limit` forces the
   park of a busy session, E4 still means no fork.
3. When both answer, `park.query` (5 s) and `plan.capture` (8 s, `contract:473`) run in sequence,
   not in parallel. A fork while the session says busy would race the busy work for the turn.
   The longest wait before a park is therefore 13 s. A `cap` spawn waits for neither (§5.1).

**P4W5 (compaction digest).** No overlap in v1. P4W5 reacts to compactions that happen
(`P4W5-compaction-digest.md` §3), and T456 triggers none. A compaction before a park would cost one
summarizer pass now to save some resume cost later, and only if the session is ever resumed. It
would also rewrite the conversation without the operator's gesture, which P4W5 only does on the
engine's or the operator's trigger. Rejected for v1. Q5 asks whether a session with a known-large
context should be compacted before a park.

### 7.3 When preparation is skipped

Always under `memory-pressure` (the point is to free memory now). Always when the switch of P4W4 is
off (its default, `P4W4:470`). On `cause: 'manual'`, P4W4 already parks after the capture
(`P4W4:256`). There is no new skip rule. BUG-100 (a parked session tells its dispatcher nothing) is
the natural consumer of the ledger's `negotiation` field, but it is not built here.

## 8. Packaging (C-3)

### 8.1 Decision: a mix, inside what exists

| Half                                | Lives in                                                                                                                                                                                                                               | Why                                                                                                                                                                                                                                                          |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Decision, bounds, timer, ledger, UI | Harnu main process: new `src/main/park-negotiation-core.ts` (pure) and `src/main/park-coordinator.ts` (the one P4W4 named under `companion/`); changes in `fleet-policy.ts`, `pty.ts`, `hibernation.ts`, `hook-bridge.ts`, the sampler | The decision to kill a process Harnu owns is Harnu's. A mod only states facts                                                                                                                                                                                |
| The answer                          | the existing Harnu mod, `resources/companion/`                                                                                                                                                                                         | The command channel exists only between Harnu and `harnu-companion`, through its lease, and its enum is closed (SEC-5). The facts come from hooks the companion already holds. A second mod would need a second channel, its own lease and its own audit row |
| Legacy facts                        | `hook-bridge.ts`                                                                                                                                                                                                                       | Sessions without a live mod are the majority until rollout ends                                                                                                                                                                                              |

A third-party mod gets no say in v1. The obstacle is the direction of the wires, not SEC-9b.
ADR-0019 puts the `$.harnu` noun in a separate `harnu` mod that does call MCP
(`docs/adr/0019-harnu-sdk-noun-transport.md:61-75`), so a third-party mod can already reach Harnu.
What is missing is the other direction: a way for Harnu to **ask** a third-party mod something and
wait for the answer. The command channel ends at the companion (`01-contract.md:26`), and
ADR-0019's only host → mod traffic is a payload-free `sdk.invalidate` notice (`:70-72`). A park vote
would need a new ask path through the companion or the noun. Q6 records it.

### 8.2 A session started outside Harnu

It is never parked: Harnu parks only PTYs it spawned (`pty.ts:583-610` reads its own `ptys` table).
There is nothing to negotiate. A tokenless companion (P4W3, `external-binding.ts`) answers only
`flush`, `config.update` and `ui.band.set` (`TOKENLESS_OK`, `command-core.ts:107`). `park.query` is
not added to that set: no host would send it.

## 9. Control and failure (C-4)

### 9.1 The switch

A new key in `companion-prefs.json` (P1W4, registered with `registerPrefsKey`, as P4W4 does for
`plan`): `park: 'off' | 'facts' | 'ask'`.

- `ask` (**default**): negotiate through the mod where `channel` is `active`, with the legacy facts
  as fallback; legacy facts everywhere else. On a default install (`channel: shadow`) `ask`
  therefore behaves as `facts`.
- `facts`: legacy facts only, for every session. No command is sent.
- `off`: today's behaviour exactly.

`registerPrefsKey('park', { default: 'ask', parse, observeCap: 'facts' })`: above the tested
ceiling the key is capped at `facts` (ARB-7b).

The three bounds of §6.2 live beside the three existing policy fields in
`monitor-policy.json` (`policy-store.ts:20-22`) and are clamped the same way (`:27-39`). They are
drawn in Settings → Hibernation policy under a group "Ask before parking".

Default `ask` is justified on three grounds. Its authority only arrives with the operator's own
`channel: active`, and until then it is `facts`. It spends no tokens, unlike P4W4, which is off for
that reason (`P4W4:33-35`). Every outcome is bounded (§6). The facts half is on by default because
the objective is safety by default and the facts are Harnu's own hook data. Q1 asks the operator to
confirm.

### 9.2 Failure: fail open to today's park

Every failure ends at today's behaviour, which is parking:

| Failure                                                               | Where it is caught                                                                                                                            | Result                                                                                              |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| A sensor hook throws (`classic.PermissionRequest`, `classic.Stop`, …) | each hook's `.catch(($, e, next) => next(e))` (REF 79). The prototype's validate lists all five as "gating hook with .catch"                  | the event passes untouched. The fact is missed, so the session reads less busy                      |
| `runParkQuery` throws                                                 | `runCommand`'s `try`, mapped by `mapEngineRejection` to `CMD_FAILED` or `CMD_PRECONDITION` (`register.ts:944-949`, `command-core.ts:216-221`) | host reads `silent`                                                                                 |
| No answer in 5 s, `NO_BINDING`, `MODE_SHADOW`, revoked                | the coordinator's `Promise.race` on `settled` (the pattern of `companion-ipc.ts:81`; `settled` never rejects, `P2W1:235, 253`)                | `silent` → legacy facts → park                                                                      |
| The coordinator itself throws                                         | a `try` around the whole stage in `requestPark`                                                                                               | revalidate (§5.6), then park; ledger `why: 'silent'`, `mod.error`-style log line                    |
| Host restart during a deferral                                        | episodes are in memory, like the parked set (`hibernation.ts:19`)                                                                             | the next sweep asks again. An in-memory budget restarts: at most one extra `maxDeferMs` per restart |

The prototype's sensor hooks fail toward "less busy". That is the right direction for G3: a bug in
the mod can make Harnu park as it does today, but it can never pin a session.

### 9.3 Settings → Mods chips

`deriveCapabilities` (`mods-audit-core.ts:370-393`) turns a `claude plugin validate --json` report
into chips. **PROBE.** Two reports were fed through the real `parseValidateReport` and
`deriveCapabilities`, run with Node's type stripping (`01-prototype.md` §P1.5):

| Report                                                                   | Chips                                                                 |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| The staged companion (`~/.config/harnu/companion/0.1.0/harnu-companion`) | `network`, `files`, `prompts`, `permissions`, `gate`, `env`           |
| The T456 prototype                                                       | `prompts` (`turn.start`), `permissions` (`classic.PermissionRequest`) |

The staged copy was diffed against `resources/companion/` at this branch's HEAD
(`diff -rq`): `hooks/`, `.claude-plugin/` and `types/index.d.ts` are identical; the copy adds only
the generated `hooks/coords.gen.ts`, a `.stamp` and a `tsconfig.json`, and lacks `tests/`,
`api-surface.json` and `.gitignore`. So the staged report is the source's report. The prototype's
chips are a subset of the companion's. The real change adds one call,
`$.session.surfaces`, which no chip covers. It also reads one more field in an event the companion
already hooks. Settings → Mods therefore shows **no new chip**. The prototype's slash-command seam
(`command.register`, a `command.run` hook that answers its own command) is test scaffolding and is
not part of the change. It lights no chip either: `submit` is for _calling_ `command.run`
(`mods-audit-core.ts:383`). The companion's checked-in `api-surface.json` gains `session.surfaces`
under MOD-3 (`00-master.md:524`).

## 10. Overlap with T389 and T447 (C-2)

Shipped/planned is checked against the code, not against the wave docs. Every wave doc still reads
"Specified, not implemented" on its line 5, which is stale for the shipped ones.

| Wave                             | Status (evidence)                                                                                                                      | Relation to T456           | What T456 adds, and nothing else                                                                                      |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| P1W1 host server, P1W3 handshake | shipped (`src/main/companion/`, `identity-adapter.ts`)                                                                                 | builds on                  | nothing                                                                                                               |
| P1W4 arbitration, prefs          | shipped (`arbitration-core.ts`, `companion-prefs*.ts`)                                                                                 | builds on                  | the prefs key `park` (§9.1)                                                                                           |
| P1W5 fleet state                 | shipped (`lib/fleet-sensor.ts`, `task-state-map-core.ts`)                                                                              | extends                    | the field `idle` in the `fleet` state key; `session_crons` read at `classic.Stop` (§5.2)                              |
| P2W1 command channel             | shipped (`command-channel.ts`, `command-gate-core.ts`; the closed switch `register.ts:1012-1029`)                                      | extends                    | one command (also in the host's `COMMAND_NAMES`), one gate row, the feature `act.park`; `channel: active` only (§5.2) |
| P3W1 approval hold               | planned (insertion-point comments only, `register.ts:1221, 1273, 1290`)                                                                | overlaps                   | none. When P3W1 lands, a held ask is one more `permission` count; BUG-72 is the host-side half                        |
| P4W1 Settings → Mods             | shipped (`mods-audit-core.ts`)                                                                                                         | constrains                 | none: no new chip (§9.3)                                                                                              |
| P4W3 companion outside Harnu     | shipped (`external-binding.ts`)                                                                                                        | bounds                     | none: outside sessions are never parked (§8.2)                                                                        |
| P4W4 resume micro-plan           | planned (`plan.capture` in the contract only)                                                                                          | overlaps: same coordinator | builds `requestPark` first; P4W4 plugs in as stage 2 (§7.2)                                                           |
| P4W5 compaction digest           | planned (`compactSummary` field only, `contract.ts:198`)                                                                               | none in v1                 | none (§7.2)                                                                                                           |
| T447 `$.harnu` noun              | spec merged (PR #41, `docs/specs/T447-harnu-sdk-noun/`, ADR-0019); noun not implemented (no `engine.create` in `resources/` or `src/`) | adjacent                   | none in v1; Q6                                                                                                        |
| ADR-0018 (mod as substrate)      | accepted                                                                                                                               | follows                    | the substrate's rules apply as written: closed enum, host decides, mod states facts                                   |

## 11. Implementation outline (C-6)

Each slice is one PR, in dependency order.

| #   | Slice                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Size | Depends on |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- | ---------- |
| W0  | **Spike** (§12): A1 PTY bytes while a background task runs; A2 a finished background task always ends in a fresh main Stop; A3 a park's kill fires `session.end`; A4 `$.session.surfaces()` inside Harnu's PTY with and without a Remote Control client; A5 `os.freemem` on macOS. Record the answers in this spec                                                                                                                                                                                                                                                                                                                                                                                                                         | S    | —          |
| W1  | **Coordinator and core, legacy facts only.** `park-negotiation-core.ts` and its suite (ported from `01-prototype.md` §P2); `park-coordinator.ts` with `requestPark` and the §5.6 revalidation; `runPolicy` and `pty:park` route through it; `hook-bridge.ts` keeps the two Stop counts and the `UserPromptSubmit` edge with its `source`, read in the request handler **before** `ingest`, because the hub drops them for companion-owned and parked sessions (§5.5); `LiveSession` gains the episode; `explainFleet` gains `'declined'`; **both** producers set it, and the sampler also gains `ownsLiveMission` (§3.3); ledger field; prefs key `park` with `observeCap` (`ask` acts as `facts` until W2); memory reading in the sampler | M    | W0         |
| W2  | **`park.query`.** Contract and `contract.ts`; host `COMMAND_NAMES`, gate row, feature `act.park` (`channel: active` only, not in the observe-only set); mod `COMMAND_FEATURE` and `IMPLEMENTED_COMMANDS`; `fleet.idle` in the sensor; `runParkQuery` in the closed switch; `api-surface.json`; mod tests ported from `01-prototype.md` §P1; contract fixtures                                                                                                                                                                                                                                                                                                                                                                              | M    | W1         |
| W3  | **Operator UI.** System Monitor chip and tooltip; parked-row explanation; Settings → Hibernation policy group (switch and three bounds); `design.md` §6 entries; i18n in both locales                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | S    | W1         |
| W4  | **Live verify** (second isolated instance, `docs/dev/live-verify-second-instance.md`): a background `sleep` session survives a forced sweep with a 1-min `lruIdleMs`; parks at the limit; parks under a lowered floor; "Park now" overrides                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | S    | W2, W3     |

P4W4, when built, plugs in as the coordinator's second stage with no change to W1.

**Contracts the implementation owes.**

| Contract                                       | Slice  | What                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHANGELOG.md`                                 | W1, W3 | `Changed`: "Harnu no longer parks a session that is waiting on background work or a scheduled wakeup; it asks again later, within limits you set." W3: `Added` for the settings and the "Asked to stay" chip                                                                          |
| `docs/harnu-features.md` + marker bump         | W1     | Fix `:674` ("a session that is actively working is never parked" is not true today, §3.3). State the new rule: a session waiting on background work or a wakeup is deferred, bounded, never pinned. No new verb, no new ACK field in v1                                               |
| `docs/user/`                                   | W1, W3 | `system-monitor.md` (the chip, the parked-row line, "Park now" overrides); `settings.md` (the "Ask before parking" group); `sessions.md` (why a cold session may stay live). No new top-level component or main-process file is user-facing on its own, but W3 changes what users see |
| `design.md` + `en.json` + `pt-BR.json`         | W3     | §6 System Monitor row chip variant and Hibernation policy group; §8 copy; keys under `monitor.*` and `hibernationPolicy.ask.*` in both locales in the same change (`docs/lessons/i18n/002-vue-i18n-schema-parity.md`)                                                                 |
| `docs/specs/T389-companion-mod/01-contract.md` | W2     | the additions of §5.2 and the `fleet.idle` field (contract §22), same change as `contract.ts`                                                                                                                                                                                         |
| CI gates                                       | all    | `awareness-gate` (W1 touches `harnu-features.md`); `user-docs-gate` (W1, W3); English and client-identifier gates                                                                                                                                                                     |

**Acceptance criteria for the implementation** (owned by W1 to W4, written as P4W4 writes them):

- AC-T456-1 [unit] Given a session whose mod answers busy, When the sweep picks it, Then it is not
  parked and is not asked again before `until`.
- AC-T456-2 [unit] Given a mod that always answers busy, When the sweep runs every 60 s, Then the
  session is parked by `maxDeclines` questions or `maxDeferMs`, whichever comes first (the §6.6
  table as a test).
- AC-T456-3 [unit] Given `MemAvailable` under the floor, When a busy session is picked, Then it is
  parked and not asked.
- AC-T456-4 [unit] Given `cause: 'manual'`, When "Park now" runs, Then the session is parked
  without a question.
- AC-T456-5 [unit] Given no binding and a legacy Stop with one cron, When the sweep picks the
  session, Then it is deferred.
- AC-T456-6 [unit] Given a `cap` spawn and a declining coldest session, When `pty:create` runs,
  Then the spawn is not delayed and the next candidate is tried.
- AC-T456-7 [mod-test] The seven tests of `01-prototype.md` §P1.1 (run in §P1.3), ported to `resources/companion/tests/`.
- AC-T456-8 [contract] Given channel `shadow`, When the coordinator enqueues `park.query`, Then it is
  refused `MODE_SHADOW` and the session is decided on legacy facts.
- AC-T456-9 [live-verify] W4's four scenarios.
- AC-T456-10 [unit] Given a `free` answer, When the operator selected the session or a prompt
  arrived during the wait, Then `hibernateSession` is not called and no decline is counted.
- AC-T456-11 [unit] Given an open episode, When a `UserPromptSubmit` with `source` other than `user`
  arrives, Then the episode is unchanged; with `source: 'user'` or a focus, it is closed.
- AC-T456-12 [unit] Given a CLI above the tested ceiling, When the prefs are read, Then `park` reads
  `facts`.

## 12. Assumptions (the W0 spike)

| #   | Assumption                                                                                                                | Why it matters                                                                                                                                                                          | How W0 settles it                                                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | An interactive `claude` idle at its prompt with a background task or subagent running emits no PTY bytes                  | §3.6 rows 1 and 4 reach the policy only if it holds. If it fails, the background-task case was already safe and T456's value narrows to wakeups, remote surfaces and the `working` hour | Spawn `claude --model haiku` under a PTY in a scratch folder, prompt it to `sleep 300` with `run_in_background`, and count bytes per 10 s for 4 min. **Tried for this spec: the session's permission classifier refused to spawn a live agent.** The script is in `01-prototype.md` §P4 |
| A1b | The same, for a session with only a pending wakeup (`ScheduleWakeup`, `CronCreate`)                                       | §3.6 rows 2 and 3                                                                                                                                                                       | Same harness, with `ScheduleWakeup` 300 s and nothing else                                                                                                                                                                                                                              |
| A2  | A finished background task always produces a main turn, and so a fresh `classic.Stop`                                     | If not, `idle` over-reports busy until the next turn. The bound still holds                                                                                                             | Same harness: let the `sleep` finish and check for a Stop with an empty list                                                                                                                                                                                                            |
| A3  | Harnu's bare `pty.kill()` (SIGHUP) reaches each mod's `session.end` (reason `other`; `ExitReason`, TYPES 4809)            | §7.1 relies on it for `$.store` flushes                                                                                                                                                 | A test mod writes a marker from `session.end`; park it in the isolated instance                                                                                                                                                                                                         |
| A4  | `$.session.surfaces()` is `['terminal']` in a Harnu PTY, and gains `mobile` while a Remote Control client is attached     | A false `remote-surface` would defer every session                                                                                                                                      | Read it from the isolated instance, before and after attaching a client                                                                                                                                                                                                                 |
| A5  | `os.freemem()` on macOS and Windows is comparable to Linux `MemAvailable`                                                 | The pressure override is off there until it is settled                                                                                                                                  | Compare `os.freemem()` with `vm_stat` / the Windows "Available" counter                                                                                                                                                                                                                 |
| A7  | `classic.PermissionRequest` fires only when a dialog is put to a person, not when auto mode's classifier settles the call | A false `permission` reason would defer a session nobody is answering                                                                                                                   | Run a tool that asks under auto mode and under default mode in the harness; count `PermissionRequest`                                                                                                                                                                                   |
| A8  | This CLI fills `UserPromptSubmit.source` ("may omit it while the field rolls out", TYPES 14665)                           | An absent `source` never resets an episode; only focus does                                                                                                                             | Log the hook bridge's `UserPromptSubmit` bodies in the isolated instance for a typed prompt and a `/loop` wakeup                                                                                                                                                                        |
| A6  | The poll-delivered round trip fits in 5 s under load                                                                      | A slower answer reads as `silent` and today's park                                                                                                                                      | Count `silent` outcomes in the W4 live run. P2W1's LV run held 355 polls over 5 sessions in 30 min (commit `eb92cdf`)                                                                                                                                                                   |

## 13. Open questions (C-7)

| #   | Question                                                                                                                                                                                                                                                      | Default until settled          | Who decides                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------- |
| Q1  | Is `park: 'ask'` the right default? On a default install it acts as `facts` until the operator sets `channel: active`                                                                                                                                         | `ask`                          | operator                              |
| Q2  | Are the bound defaults right (8 declines, 2 h, floor 1 536 MB)?                                                                                                                                                                                               | as §6.2                        | operator, after a week of W1's ledger |
| Q3  | Should `get_fleet` / `get_session` expose a declining session (`parkDeferred: { reasons, until }`) so an orchestrator can read it? It would be agent-facing (`harnu-features.md` + marker)                                                                    | no                             | operator                              |
| Q4  | Should a park that overrode a "busy" answer (`limit`, `memory-pressure`) post a notice to the Activity history?                                                                                                                                               | no                             | operator                              |
| Q5  | Should a session with a known-large context be compacted before a park?                                                                                                                                                                                       | no (§7.2)                      | operator, with P4W5's evidence        |
| Q6  | Should third-party mods get a say, through a `$.harnu` method or a `park` vote on `$.state`?                                                                                                                                                                  | no; only the companion answers | T447 owner                            |
| Q7  | Should `remote-surface` alone be a decline, or only together with another reason? An attached phone may simply have been forgotten                                                                                                                            | alone                          | operator, after A4                    |
| Q8  | Should P4W4's coordinator ownership note ("this wave owns `requestPark`", `P4W4:21`) be edited when W1 lands? And should P4W4's `revalidatePark` swap its "no `turn.started`" check (`P4W4:132-133`) for the legacy `UserPromptSubmit` edge T456 uses (§5.6)? | yes, in W1's change            | T389 owner                            |
| Q9  | Should `park.query` run in `shadow` with its answers recorded for parity and never applied (ARB-6b allows sensor recording), to gather evidence before `active`?                                                                                              | no                             | T389 owner                            |
| Q10 | Should the memory floor also park sessions that stay warm only because something keeps writing PTY bytes (§6.1)? That changes who becomes a candidate                                                                                                         | no                             | operator                              |

## 14. Risks

| Risk                                                                                        | Sev    | Mitigation                                                                                |
| ------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------- |
| A recurring cron keeps a session asking to stay and RAM climbs                              | Medium | a wakeup never resets the episode, so `maxDeferMs` holds (§6.1, tested); the memory floor |
| `idle` stale after a background task ends without a turn (A2)                               | Low    | the bounds; W0 measures it                                                                |
| The cap stays over `maxLive` while every candidate declines                                 | Medium | the same stance as T119 §3.5; the floor reclaims under real pressure                      |
| A future mod change makes `park.query`'s handler write something                            | Medium | a contract test that `runParkQuery` makes no `$` call but `session.surfaces`              |
| A session that keeps writing PTY bytes is never cold, so never asked and never floored      | Medium | pre-existing; not opened by T456; Q10                                                     |
| The doc line `harnu-features.md:674` keeps telling agents a working session is never parked | Low    | W1 owes the fix (§11)                                                                     |
