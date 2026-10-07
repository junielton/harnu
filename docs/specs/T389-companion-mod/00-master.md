# T389 — Harnu companion mod: master spec

**Status:** specified (not implemented) · **Date:** 2026-10-02 · **Epic:** T389
**Reconciled:** 2026-10-02, against the nineteen wave specs. Where a wave spec disagrees with
this document or with the contract, this document and the contract win.
**ADR:** [ADR-0018](../../adr/0018-harnu-mod-as-integration-substrate.md) ·
**Contract:** [`01-contract.md`](01-contract.md) ·
**Study:** `docs/studies/T389-claude-mods-x-harnu.md` ·
**Evidence:** `docs/studies/T389-smoke-evidence.md` (cited as "smoke A2", "smoke B1.7", …)
**Verified against:** Claude Code CLI 2.1.287 (minimum CLI) and 2.1.289 (tested ceiling, smoke §11); repo `main` @ `46d70c7d` (line references re-checked after the Harnu rename; the earlier base `b35a2c06` is not in this repository).

This document is the index and the rulebook for the epic. Wave specs **cite** the requirement ids
defined in §7 instead of restating them, and extend the wire contract only through
`01-contract.md`. Precedence when sources disagree: live smoke evidence > the binding decisions
(D1–D14 and corrections C1–C28, recorded in ADR-0018) > the study > panel opinion.

## 1. Goal and non-goals

**Goal.** Replace Harnu's guessed integration seams with typed signals from inside the `claude`
process. Harnu ships a small, readable mod, `harnu-companion`, that reports identity, turn state and
usage to Harnu main and carries a closed set of commands back. Every legacy seam stays as a
permanent fallback, and Harnu main decides per session and per fact which source counts.

**Non-goals.**

- **Not a security boundary.** The companion is a sensor and a convenience actuator. Mods of the
  same tier are not isolated from each other (smoke D6), so nothing here is a guarantee (SEC-7).
- No remote "approve" command, no generic "run this" command, no policy evasion on managed
  machines (SEC-2, SEC-5, SEC-9).
- No operator-facing "abort turn" or "compact" buttons in this epic: the commands ship as
  plumbing; each destructive affordance needs its own design.
- No redraw of the engine's permission dialog. Answering it from Harnu is in scope (smoke B1.7,
  C12); redrawing it is not possible.
- No deletion of the fallback machinery listed in ARB-8. P5W1 demotes; it deletes nothing.
- No enable/disable of third-party mods from the Mods tab, and no user-tier allowlist gate: both
  would mean deciding which of the user's mods load.
- No editor for Sentinel rules, and no instruction injected into the compaction summarizer.
- Scope is not cut: everything the study lists is specified. Value ordering decides the phase.

## 2. Glossary

| Term                    | Meaning                                                                                                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **companion** (the mod) | The plugin `harnu-companion`, source `resources/companion/`, a hooks module loaded into `claude` through `--plugin-dir`. Runs at the `user` tier. In the UI it is the **Harnu mod** (§15).                         |
| **host**                | The companion server in Harnu main (`src/main/companion/`): socket listener, binding table, command queue, ask broker, adapters.                                                                                   |
| **legacy seam**         | An integration path that exists today (hook bridge, statusLine, `/usage` poll, PTY paste, `guard.mjs`, messaging socket, …). Listed in §4 per wave.                                                                |
| **rendezvous file**     | `<userData>/companion/endpoint.json`: where the host listens right now. Re-read by the mod on every connect failure.                                                                                               |
| **spawn token**         | One-time nonce in `HARNU_SPAWN_TOKEN`, minted per PTY spawn, redeemed at the first `hello`. Correlation, not authentication (C4). It never leaves the host's ledger.                                               |
| **conn**                | The per-connection token the host issues at `hello`. Every later request carries it.                                                                                                                               |
| **binding**             | The host's record for one `claude` process: spawn owner, `conn`, current session id, Harnu `sessionKey`, profile, enabled features, lease.                                                                         |
| **identity claim**      | What a hello gives Harnu: "this PTY is session `sid`". The row migrates later, when the transcript exists, resolved by the claim instead of the heuristics.                                                        |
| **fact family**         | A fact two sources can report or act on: `identity`, `taskState`, `telemetry`, `planUsage`, `approval`, `guard`, `startPrompt`, `message`.                                                                         |
| **feature id**          | A capability of the mod on the wire (`sense.turn`, `gate.approval`, …). Goes **declared → enabled → proven** (contract §11).                                                                                       |
| **feature key**         | The switch of a feature with no fact family, in `companion-prefs.json` (`channel`, `stamp`, `context`, `sentinel`, `surface`, `external`, `plan`, `recap`, `modsLive`).                                            |
| **lease**               | Liveness of a binding: a parked `poll`/`ask`, or a request within the last 20 s.                                                                                                                                   |
| **owned**               | The companion is the single writer for a (session, family): its features are proven, the lease is live, the family's mode is `active`.                                                                             |
| **mode**                | `off` (mod not loaded), `shadow` (mod loaded and reporting, legacy authoritative), `active` (companion may own). Per family, with a per-folder ramp.                                                               |
| **companion mode**      | The global switch: "not `off`" means the kill switch is on and the CLI gate is `ok` or `above`.                                                                                                                    |
| **observe-only**        | A command or level that records and never acts: `flush`, `config.update`, `guard.set {enforce: false}`, `sentinel.set`, `ui.band.set` (display-only, no legacy rival), stamp level `observe`. Allowed in `shadow`. |
| **parity ledger**       | Persisted, scrubbed NDJSON record of what both sources said about the same fact; the evidence a family needs to flip to `active`.                                                                                  |
| **Harnu mod state**     | What the operator sees per session: `live` (handshake done), `legacy` (with the reason), `off`. Internally `CompanionState`.                                                                                       |
| **coverage state**      | What the Approval Inbox says about a session: `gated`, `contested` (another mod can decide), `not gated`.                                                                                                          |
| **task-state hub**      | `src/main/detect/task-state-hub.ts`, extracted from `hook-bridge.ts`: the one fold and fan-out every source feeds.                                                                                                 |
| **adapter**             | Host code that translates wire events into the shape an existing consumer already takes. No consumer is forked.                                                                                                    |
| **tranche**             | One ≤20 s request of an `ask` hold; the mod re-issues it until decided or released.                                                                                                                                |
| **profile**             | `interactive`, `headless` (`isInteractive === false`: sensor-only, no long-poll) or `external` (a session Harnu did not spawn, opt-in).                                                                            |
| **dormant**             | The mod after an unrecoverable hello failure: every hook returns `next(e)`, no requests.                                                                                                                           |
| **inert**               | The mod after a hello answered `enable: []` (the kill switch, or a host with no enable policy): nothing is sent, `conn` is kept; the state reads `off`, never a lease loss.                                        |
| **stand-down**          | The legacy bridge answering a hook POST at once, without parking it for a human. Synchronous resolvers (a Sentinel deny) still run.                                                                                |
| **tested ceiling**      | The highest CLI version on which the drift contract (QA-6) last passed. It starts at 2.1.289 (smoke §11); the minimum CLI stays 2.1.287.                                                                           |
| **first-lander**        | An interface two waves need and neither strictly precedes: the first to land creates it with the signature of §12; the other reuses it.                                                                            |

## 3. Architecture overview

```
Harnu main                                           claude (one process per session)
─────────                                           ──────────────────────────────────
pty.ts spawn
  argv:  --plugin-dir <userData>/companion/<stageKey>/harnu-companion     (first --plugin-dir)
         --plugin-dir <userData>/skills/<folder-hash>/harnu               (T217, unchanged)
         --settings <hook blob>   --append-system-prompt …               (legacy, always injected)
  env:   HARNU_SPAWN_TOKEN=sp_…                                    ┌───────────────────────────────┐
        │                                                         │ harnu-companion (user tier)     │
        ▼                                                         │  hooks/register.ts             │
<userData>/companion/                                             │   ensureHello → sensors        │
  endpoint.json  ◄───────── re-read on every failure ─────────────│   poll loop  → actuators       │
  c.sock ◄══ POST /v1/hello │ events │ poll │ ask │ bye ══════════│   gates: guard, stamp, approval│
        │       ($.http.fetch + socketPath; holds ≤25 s / ≤20 s)  │  hooks/surface.tsx (band)      │
        ▼                                                         │  hooks/contract.ts (shared)    │
src/main/companion/                                               └───────────────────────────────┘
  server.ts ── session-table.ts (binding, lease, spawn ledger)
     │            │
     │            └── arbitration-core.ts ◄── companion-prefs (families, feature keys, folder ramp)
     │                   │                     CLI version gate · parity ledger
     ▼                   ▼
  ingest adapters (one per consumer; legacy input for an owned family is dropped here)
     ├─ identity   → claim → renderer migrates the row at `session:added` → pty:rekey
     ├─ taskState  → detect/task-state-hub.ts → claude:hook, getTaskStates, 4 in-main observers
     ├─ telemetry  → telemetry-store (field groups; the statusLine keeps what the mod cannot see)
     ├─ planUsage  → usage snapshot (the /usage poll runs only when no lease reported in 90 s)
     ├─ approval   → ask-broker → responderRegistry (Sentinel, Approval Inbox) → renderer IPC
     └─ commands   ← command-channel ← MCP verbs / operator gestures (origin-gated, audited)

Legacy seams (hook bridge, statusLine, /usage, PTY paste, guard.mjs, messaging socket, watchers)
keep running beside all of this and win whenever the companion does not own a family.
```

## 4. Phases and waves

Phases and wave boundaries are exactly D14. Study rows are the numbered rows of the study's
cross-reference table; "new N" is item N of its "what can be built new" list. "User-visible" and
"Agent-facing" decide which docs contracts apply (DOC-2, DOC-3).

**P0 — Foundations.** The study and the smoke evidence in `docs/studies/`, ADR-0018, this master
spec and the contract. No code.

### P1 — Sensor

#### P1W1 — Host server · `P1W1-host-server.md`

The HTTP server in main on the Unix socket (TCP variant for Windows and long paths), the
rendezvous file, envelope validation, sequence and dedupe (`wire-core.ts`, pure), the binding
table, the lease clock, the companion audit log with its `binding` record (SEC-6), the
`resources/companion/hooks/contract.ts` file (types and constants of protocol 1, zero imports)
with the first golden fixtures, and the extension points later waves register on (§12). No consumer is
wired yet; the server is exercised by contract tests against a real socket.

- **Study rows:** infrastructure for all; fixes the stale-port half of row 2.
- **Depends on:** P0. **Unblocks:** P1W2 (after the rebase), P1W3, P1W4.
- **Demotes:** nothing.
- **Features:** none (endpoints `hello`, `events`, `bye` exist; `poll` and `ask` answer `FEATURE_DISABLED` until a wave registers a handler).
- **User-visible:** no. **Agent-facing:** no.

#### P1W2 — Mod skeleton, staging, version gate, harness · `P1W2-mod-skeleton-and-harness.md`

`resources/companion/` (manifest, `hooks/register.ts`, the generated `coords.gen.ts`; `hooks/contract.ts`
is created by P1W1 and only imported here), immutable versioned staging under `<userData>/companion/<stageKey>/`, the
second unconditional `--plugin-dir` (D1), spawn-token minting, the CLI version gate (new code;
it implements the core of `docs/specs/T200-cli-version-detection.md`), and the test harness:
`claude plugin test`, `api-surface.json` drift checks and the local-ci `mod` step. The mod is
injected only when the companion mode is not `off`, and the mode stays `off` by default until
P1W4 (ARB-6). Pointing the plugin dir at the repo folder is an opt-in developer flag with a
single-owner lock, never the default of an unpackaged build (C23).

- **Study rows:** 7 (deviation D1: a dedicated plugin dir, not the skills dir).
- **Depends on:** P0. **Unblocks:** P1W3. Runs in parallel with P1W1, rebased onto it.
- **Demotes:** nothing.
- **Features:** none.
- **User-visible:** no. **Agent-facing:** no.

#### P1W3 — Handshake and identity · `P1W3-handshake-identity.md`

`ensureHello`, spawn-token redemption, `conn`, re-hello on reload and listener restart, the
re-key rules for `/clear` and in-session `/resume` (contract §15), `bye`, the mod runtime every
later hook calls (`emit`, the ring, the heartbeat), and the identity adapter. **Hello gives a
claim, not a re-key (C19):** the row migrates at the existing `session:added` event, when the
transcript is on disk, resolved by the claim instead of by the correlation heuristics, through
the existing migration path (`sessions.ts:3251`, `:3261`) and `pty:rekey` (`pty.ts:1003`).

- **Study rows:** 11.
- **Depends on:** P1W1, P1W2. **Unblocks:** P1W4, and through it every later wave.
- **Demotes:** the synthetic-id correlation (FIFO plus the collapse window) to sessions with no claim.
- **Features:** `sense.identity`.
- **User-visible:** no new surface (fewer duplicate rows; CHANGELOG `Fixed` when the family goes active). **Agent-facing:** no.

#### P1W4 — Arbitration, rollout, parity, status UI · `P1W4-arbitration-and-rollout.md`

`arbitration-core.ts` (pure), the lease-to-family ownership rule, `BridgeEvent.source` and the
extraction of the fold and fan-out from `hook-bridge.ts:409-448` into
`src/main/detect/task-state-hub.ts`, `companion-prefs.json` (family modes, the feature-key
extension point, the per-folder ramp), the persisted parity ledger, the Harnu mod state in the
session hover preview and the System Monitor row, the one-time disclosure and the global kill
switch. This wave turns the default from `off` to `shadow` (OD-1). The kill switch takes effect
at once for every session when turned off, and for new sessions only when turned back on (C25).

- **Study rows:** none directly; it is what makes rows 1–11 safe to migrate.
- **Depends on:** P1W1, P1W2, P1W3 (stacked on P1W3). **Unblocks:** P1W5, P1W6, P2W1, P2W5, P4W3, P4W1 part B, every flip to `active`.
- **Demotes:** nothing (it adds the arbiter).
- **Features:** none.
- **User-visible:** **yes** (switch, Harnu mod state, disclosure, the "Harnu mod unloaded" toast). **Agent-facing:** no.

#### P1W5 — Fleet state · `P1W5-fleet-state.md`

Turn, attention and subagent sensors, mapped per D12 onto the existing task-state reducer through
the hub. Exits from `waiting-permission` are `classic.PostToolUse`, the companion's own ask
resolution and `turn.complete`; never `tool.call.end` (C11) and never `PostToolUseFailure` (C3).
Only running subagents hold a completed main turn as working; other background tasks are
informational. `turn.step` is not hooked. This wave creates the shared hook registrations of
contract §11.4 and the `permissionMode` state key.

- **Study rows:** 2, 5.
- **Depends on:** P1W3, P1W4. **Unblocks:** P1W6 (slice S3), P2W2, P2W3, P3W1, P4W4.
- **Demotes:** the per-session `--settings` hook blob and the global hook install, for observation, to fallback. The transcript and PID-registry tiers stay.
- **Features:** `sense.turn`, `sense.attention`, `sense.subagent`.
- **User-visible:** behaviour only (fewer false "stuck"; `docs/user/troubleshooting.md`, `sessions.md`). **Agent-facing:** no.

#### P1W6 — Telemetry, plan usage, per-turn cost · `P1W6-telemetry-usage-cost.md`

`usage.measured` into `SessionTelemetry` and the plan-usage snapshot; per-turn tokens from
`turn.completed.usage`; USD from `costUsd` deltas; fork, complete and compaction spend accounted
separately (D11). The statusLine is demoted, not removed: lines ±, thinking, output style, PR,
the model display name, duration and effort have no mod source.

- **Study rows:** 3, 4, new 7 (deviation D11: "replaced" becomes "demoted").
- **Depends on:** P1W3, P1W4 for slices S1–S2 (telemetry store, plan-usage gate); **P1W5** for slice S3 (turn ledger, cost calibration, the model id). **Unblocks:** P4W4, P4W5, P5W1.
- **Demotes:** statusLine ingest for context, cost and limits; the `/usage` poll to "no lease in 90 s"; the JSONL cost scan to history.
- **Features:** `sense.usage`.
- **User-visible:** behaviour only (`docs/user/usage.md`, `settings.md`; a new top-level main file, so the user-docs gate fires). **Agent-facing:** no.

### P2 — Actuator

#### P2W1 — Command channel · `P2W1-command-channel.md`

The `poll` endpoint, the per-binding command queue with TTL, `command.result`, server-side origin
gating and the Harnu-side audit log, and the first commands: `flush`, `config.update`,
`turn.abort`, `session.compact`, `ui.toast`, `ui.status`. Interactive sessions only. Feature key
`channel`: `shadow` runs the poll loop with observe-only commands.

- **Study rows:** new 1.
- **Depends on:** P1W3, P1W4. **Unblocks:** P2W2, P2W3, P2W4, P3W2, P4W2, P4W4, P4W5.
- **Demotes:** nothing.
- **Features:** `act.channel`, `act.turn`, `act.compact`, `act.ui`.
- **User-visible:** **yes**, one diagnostics action ("Test Harnu mod channel" in the System Monitor row; `docs/user/system-monitor.md`). **Agent-facing:** no (no verb changes; a wave that exposes a command through a verb is agent-facing).

#### P2W2 — Start-prompt delivery · `P2W2-start-prompt.md`

One-shot claim in main keyed by the spawn (its owner, never a copy of the token), delivered as a
`prompt.submit` command in the hello response; idempotent across hot reload; `/`-prefixed prompts
through `via: 'command'`; `@file` prompts stay legacy (D9). JSONL readers learn
`origin.kind: "plugin"` through one classifier. **Honest scope:** only prompts over 24 000
characters take the paste path today, and a resume carries no starting prompt, so this wave
replaces the paste gate for long prompts and nothing else.

- **Study rows:** 8.
- **Depends on:** P2W1, P1W2 (the spawn provider), P1W5 (`turn.started {cmd}`). **Unblocks:** P2W3, P2W4, P5W1.
- **Demotes:** the PTY paste gate and its watchdog to the no-lease path. The argv positional stays the default.
- **Features:** `act.prompt`.
- **User-visible:** behaviour only (`Fixed`; `docs/user/sessions.md`, `troubleshooting.md`). **Agent-facing:** no (no ACK change; re-check if `create_session` gains a field).

#### P2W3 — Messaging broker and native SendMessage audit · `P2W3-messaging.md`

A single broker in main picks one transport per message: `message.deliver` for a leased
recipient, the legacy socket otherwise; parked sessions are woken first. The recipient's companion
submits a framed, non-`asUser` prompt with an explicit peer envelope (D10). The mod refuses the
companion transport when the recipient is in bypass mode or its mode is unseen, so the engine's
own hold keeps deciding on the socket (C17). `session.send` / `session.receive` are sensed for
audit. This wave introduces the bridge stand-down option and uses it for `SendMessage` when the
`message` family is `active` (C18).

- **Study rows:** 9.
- **Depends on:** P2W1, P2W2 (`SubmitResultData`, the row classifier, the own-submit queue), P1W5 (`permissionMode`). **Unblocks:** P3W1, P5W1.
- **Demotes:** `messaging-socket.ts` to sessions without an owned `message` family.
- **Features:** `act.message`, `sense.message`.
- **User-visible:** behaviour only (`SendMessage` leaves the Inbox window for those sessions; `docs/user/agent-control.md`, `approval-inbox.md`). **Agent-facing:** **yes** (`message_session` ACK and semantics).

#### P2W4 — Live orchestrator contract and in-process guard · `P2W4-live-contract-and-guard.md`

`context.append` (a hidden user-role row, cache intact) for mid-session contract injection, with
`--append-system-prompt` unchanged as the spawn-time carrier (D7). The guard: `tool.call` deny on
`Edit|Write|NotebookEdit`, exempting subagents and the three surfaces the legacy script exempts,
by `realPath`, armed by `guard.set` (D6, C1). `armed.json` stays the role record and gains
`enforcer: 'script' | 'companion'` (C16).

- **Study rows:** 6, 6b (deviation D7: not `prompt.compose`).
- **Depends on:** P2W1, P2W2 (the row classifier), P1W2 (baked coordinates). **Unblocks:** P4W5, P5W1.
- **Demotes:** `guard.mjs` enforcement, for sessions where the companion owns `guard`.
- **Features:** `act.context`, `gate.guard`.
- **User-visible:** **yes** (promotion and demotion no longer restart a session whose Harnu mod is live: two strings, a `design.md` edit, OD-6). **Agent-facing:** **yes** (live orchestrator contract, new ACK fields).

#### P2W5 — MCP caller attribution · `P2W5-mcp-attribution.md`

`tool.call` on `mcp__harnu__*` (and the legacy alias `mcp__capy__*`) stamps a digest-based proof over `conn` and the `agentId`; the
server resolves it to the session and records it. Attribution, not authentication: target-side
checks stay and agent-controlled spawns still get no Harnu MCP (D8). Not stamped in `auto` mode
until CQ10 is settled (C24).

- **Study rows:** 10 (deviation D8: not "solves" ADR-0013; it raises the cost of a wrong id).
- **Depends on:** P1W3, P1W4 (the `stamp` key, the ledger), P1W5 (`permissionMode`). Its `orchestrator_arm` slice stacks on P2W4 and its `message_session` sender slice on P2W3. **Unblocks:** nothing.
- **Demotes:** nothing (self-declared `sessionId` arguments stay accepted).
- **Features:** `stamp.mcp`.
- **User-visible:** a caller fragment in the Control server audit row (three strings). **Agent-facing:** **yes** (verbs gain an attributed caller; `tool-catalog.ts` changes).

### P3 — Approval

#### P3W1 — Approval hold · `P3W1-approval-hold.md`

The `permission` ask and its broker; the hold in `classic.PermissionRequest` with `tool.check` as
a pass-through recorder (D5); ticket retirement; the stand-down for owned sessions, as an
extension of P2W3's predicate; the per-session coverage state in the Inbox. A hold happens only
when the engine would ask: sessions in `acceptEdits` or `bypassPermissions` lose today's 3.5 s
window on every call (C22, OD-2). The dialog-suppressing `tool.check` hold plus band is specified
only as a deferred option.

- **Study rows:** 1 (deviation D5: `classic.PermissionRequest`, not `tool.check`).
- **Depends on:** P1W4, P1W5, P2W3 (the stand-down option). **Unblocks:** P3W2, P5W1.
- **Demotes:** the 3.5 s HTTP park (`RESPONDER_DEADLINE_MS`, `hook-bridge.ts:51`) for owned sessions.
- **Features:** `gate.approval`.
- **User-visible:** **yes** (coverage line, row fragments; held tickets now chime and raise attention, a `design.md` change). **Agent-facing:** **yes** (the Approval Inbox paragraph).

#### P3W2 — Structured Sentinel rules · `P3W2-structured-sentinel.md`

Sentinel rules over the typed `tool`/`input` instead of regex over a Bash string, evaluated on
the ask payload, on the legacy hook and through a `tool.check` query for watched tools. The nine
built-in patterns are migrated; there is no rule editor and no rules file.

- **Study rows:** new 6.
- **Depends on:** P3W1, P2W1 (`sentinel.set`). **Unblocks:** nothing.
- **Demotes:** nothing; the regex engine stays on the legacy transport.
- **Features:** `gate.sentinel`.
- **User-visible:** behaviour only (deny wording; CHANGELOG when the engine flips; `docs/user/approval-inbox.md`). **Agent-facing:** no.

### P4 — Surface and governance

#### P4W1 — Mods audit tab · `P4W1-mods-audit-tab.md`

Settings → Mods: what each installed mod hooks and calls, from `claude plugin validate --json`,
worded as facts ("can"), with the companion as row 1. Read-only plus "Reveal folder". **Part A
(static) is independent of the companion and may start first.** Part B (live `plugin.register`
observation) is a stacked increment, off by default. The user-tier allowlist gate is out of
scope. The pane's settings region later hosts the Harnu mod switches.

- **Study rows:** new 2.
- **Depends on:** nothing for part A; P1W3 and P1W4 for part B. **Unblocks:** P4W3 (`docs/user/mods.md`, the settings region).
- **Demotes:** nothing.
- **Features:** none in part A; `sense.mods` in part B.
- **User-visible:** **yes** (a new top-level component and `docs/user/mods.md`). **Agent-facing:** no.

#### P4W2 — Terminal band and `/harnu-link` commands · `P4W2-terminal-band-and-commands.md`

`/harnu-link status` (no model turn, closed-vocabulary text) and `/harnu-link open`; an
`AbovePrompt` band that is absent inside Harnu in protocol 1 and shows one mission line outside
it; a loopback open link. Always wraps `next(e)`.

- **Study rows:** new 3.
- **Depends on:** P2W1; P4W3 for anything the band shows (its live-verify ACs need an outside session). Soft: P3W1 (held count, coverage). **Unblocks:** nothing.
- **Demotes:** nothing.
- **Features:** `ui.band`, `ui.command`.
- **User-visible:** **yes**. **Agent-facing:** **yes** (commands the agent can point to).

#### P4W3 — Harnu mod outside Harnu · `P4W3-companion-outside-harnu.md`

Opt-in install for sessions Harnu did not spawn, through a **new** switch (not the bundled-skills
"Also outside Harnu" switch, which copies skill files and cannot carry a hooks module): the
external profile, sensor-only, shown only once Harnu's own watchers corroborate the session, never
held by default.

- **Study rows:** new 3 (the "Active elsewhere" half); "the channel already exists" section.
- **Depends on:** P1W3, P1W4 (and its policy probe), P4W1 part A (`docs/user/mods.md`, the settings region). Uses P2W1's origin gate when present. **Unblocks:** P4W2's band.
- **Demotes:** nothing.
- **Features:** none new; the external profile (contract §21).
- **User-visible:** **yes**. **Agent-facing:** no.

#### P4W4 — Resume micro-plan · `P4W4-resume-micro-plan.md`

`plan.capture` through `$.model.fork`, behind a switch that is **off by default**. Default mode
`idle`: the plan is captured about three minutes after a turn ends, while the prompt cache is
warm, and reused at park time. Capturing at park time is the mode `park`, under a context
ceiling, because a parked session's cache has usually lapsed and a cold fork re-bills the whole
context (C21).

- **Study rows:** new 4 (deviation: not "before parking" by default).
- **Depends on:** P2W1, P1W4, P1W5, P1W6. **Unblocks:** nothing.
- **Demotes:** nothing.
- **Features:** `act.plan`.
- **User-visible:** **yes**. **Agent-facing:** no (only if a verb returns the plan).

#### P4W5 — Compaction digest and durable context · `P4W5-compaction-digest.md`

`compact.done` into spend accounting and, behind a switch that is off by default, a recap in
project memory; durable context rows re-injected through the compaction result `messages`, with
a deferred append as the fallback, never a synchronous append inside the hook (D7, smoke D5). No
instruction is added to the summarizer. The mission row is a pointer, not a state snapshot.

- **Study rows:** new 5.
- **Depends on:** P2W4, P2W1, P1W6, P1W3, P1W4. **Unblocks:** nothing.
- **Demotes:** nothing.
- **Features:** `sense.compact`; it extends `act.context`.
- **User-visible:** **yes**. **Agent-facing:** **yes** (memory and mission context).

### P5 — Retirement

#### P5W1 — Legacy seam demotion · `P5W1-legacy-retirement.md`

Nine steps, each in its own release, on parity-ledger evidence and a four-clause retirement gate:
the global hook install loses its observation events, then its decision events move into the
per-session blob; the statusLine install becomes automatic; the collapse heuristics and the
paste gate shrink to the no-claim path; the guard registration becomes on-demand and gets the
uninstall it never had. **Nothing is deleted in this wave.** The per-session blob gains
`StopFailure` one release before the global install loses it.

- **Study rows:** the "what falls into disuse" section.
- **Depends on:** every family's flip gate; P1W4's ledger. **Unblocks:** nothing.
- **Features:** none.
- **User-visible:** **yes**. **Agent-facing:** no.

## 5. Dependency graph and parallel work

```
P0 ─┬─ P1W1 ─┐
    ├─ P1W2 ─┴─ P1W3 ── P1W4 ─┬─ P1W5 ─┬─ P1W6 S3
    │                         │        ├─ P2W5 core       (its slices stack on P2W4 and P2W3)
    │                         │        └─ P2W1* ── P2W2 ─┬─ P2W3 ── P3W1 ── P3W2
    │                         │                          ├─ P2W4 ── P4W5
    │                         │                          └─ P4W4          (also needs P1W6)
    │                         ├─ P1W6 S1–S2
    │                         └─ P4W3 ── P4W2             (P4W2 also needs P2W1)
    └─ P4W1 part A  (from `main`; P4W3 needs it; part B needs P1W4)

P5W1's steps follow each family's flip gate.
* P2W1 may start from P1W4; it is rebased onto P1W5 before P2W2 starts.
```

| Wave | Hard dependencies             | Soft (works without, says less)  | Base branch               |
| ---- | ----------------------------- | -------------------------------- | ------------------------- |
| P1W1 | P0                            | —                                | P0 docs                   |
| P1W2 | P0, then P1W1 (rebase)        | —                                | P0 docs, then P1W1        |
| P1W3 | P1W1, P1W2                    | —                                | P1W2                      |
| P1W4 | P1W1, P1W2, P1W3              | —                                | P1W3                      |
| P1W5 | P1W3, P1W4                    | —                                | P1W4                      |
| P1W6 | P1W4; P1W5 for S3             | —                                | P1W4 (S1–S2), P1W5 (S3)   |
| P2W1 | P1W3, P1W4                    | P1W5 (shared `turn.start`)       | P1W4, rebased onto P1W5   |
| P2W2 | P2W1, P1W2, P1W5              | —                                | P2W1                      |
| P2W3 | P2W1, P2W2, P1W5              | P2W5 (attributed sender)         | P2W2                      |
| P2W4 | P2W1, P2W2, P1W2              | —                                | P2W2                      |
| P2W5 | P1W3, P1W4, P1W5              | P2W3, P2W4 (per-verb slices)     | P1W5                      |
| P3W1 | P1W4, P1W5, P2W3              | P4W1 (static `other-mod` signal) | P2W3                      |
| P3W2 | P3W1, P2W1                    | —                                | P3W1                      |
| P4W1 | none (part A); P1W4 (part B)  | P1W2 (row 1)                     | `main`; part B on P1W4    |
| P4W2 | P2W1, P4W3                    | P3W1                             | P4W3 with P2W1 in base    |
| P4W3 | P1W3, P1W4, P4W1 part A       | P2W1, P1W5, P1W6, P3W1           | P1W4 with P4W1 in base    |
| P4W4 | P2W1, P1W4, P1W5, P1W6        | —                                | P2W2 or P2W1              |
| P4W5 | P2W4, P2W1, P1W6, P1W3, P1W4  | —                                | P2W4                      |
| P5W1 | each family's flip gate, P1W4 | P4W3                             | one stacked branch a step |

Sets that may run in parallel as stacked branches (base = the branch below, PR against it; never
"after X is merged"):

| Set                                  | Common base        | Note                                                        |
| ------------------------------------ | ------------------ | ----------------------------------------------------------- |
| {P1W1, P1W2, P4W1 part A}            | P0 docs / `main`   | P1W2 is rebased onto P1W1 before P1W3 starts                |
| {P1W5, P1W6 S1–S2}                   | P1W4               | disjoint adapters; P1W6 S3 stacks on P1W5                   |
| {P2W1, P2W5 core, P4W3, P4W1 part B} | P1 tip             | P4W3 needs P4W1 part A in its base                          |
| {P2W3, P2W4, P4W4}                   | P2W2               | each touches one command and one legacy seam                |
| {P3W1, P4W5, P4W2}                   | P2W3 / P2W4 / P4W3 | three different bases; no shared file besides `register.ts` |
| P3W2                                 | P3W1               | —                                                           |

## 6. Uniform spec template and AC format

Every wave spec has these sections, in this order:

1. **Status**
2. **Depends on / Unblocks**
3. **Summary**
4. **Evidence** — smoke ids with their verdicts
5. **Deviations from the study** — each with its D-number and smoke id (DOC-6)
6. **Scope / Non-goals**
7. **Design** — host, mod, contract additions
8. **Arbitration & fallback** — negative paths are mandatory
9. **Security requirements** — cite SEC ids; add only what is wave-specific
10. **UX & copy**
11. **Acceptance criteria**
12. **Docs deliverables** — CHANGELOG / harnu-features + marker / docs/user / design.md / i18n
13. **Rollout & parity gate**
14. **Open questions**
15. **Risks**

**Acceptance criteria.** Id `AC-P<phase>W<wave>-<n>`; live-verify recipes `LV-P<phase>W<wave>-<letter>`.

```
AC-P1W3-4 [integration] Given a session spawned by Harnu in mode active, When its transcript
  appears on disk, Then the synthetic row migrates to the id the hello claimed, with no second row.
  Evidence: tests/cli/handshake.cli.test.ts › "migrates by the claim"; local-ci JSON step=mod
  Guards: BUG-65
```

- Exactly one method: `unit`, `mod-test`, `contract`, `integration`, `live-verify` or `human`.
- Exactly one observable.
- `Evidence:` names a test title, a recipe id or a screenshot. An AC without a named artifact is
  rejected at spec review.
- `Guards:` lists the historical bug ids the AC pins, when there are any. A conformance row is
  cited in the AC text as "conformance row N", never in `Guards:`.
- `human` ACs are listed in their own subsection so the Delivery Report shows what the operator
  must test.

## 7. Cross-cutting requirements

Every wave inherits all of these. Ids are stable; cite them (`SEC-3`, `ARB-4b`) instead of
repeating the text. Each set stops at 9 on purpose (DOC-9); sub-clauses are lettered.

### 7.1 Security floor (SEC)

| Id        | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **SEC-1** | **Fail to the engine or to legacy, never to allow.** Any companion failure (host unreachable, error, malformed reply, abort, timeout) yields the engine's own verdict or the legacy seam. The companion may only tighten or defer.                                                                                                                                                                                                                                                                           |
| **SEC-2** | **Only the operator resolves an approval.** Only renderer IPC resolves a held approval. No HTTP route, MCP verb or companion command may; there is no remote "approve". A Sentinel decision can only be a deny.                                                                                                                                                                                                                                                                                              |
| **SEC-3** | **Tokens are correlation, not authentication.** (a) One-time spawn token → `conn` per binding. (b) The host never grants a capability because a request carries a token; the endpoint token and the MCP bearer never authorize a command. (c) The host validates every request as untrusted input. (d) The mod trusts a response for nothing the engine would not allow anyway.                                                                                                                              |
| **SEC-4** | **Coordinates are baked at staging.** Nothing security-relevant is read from env, cwd or project files; the single exception is the literal `HARNU_SPAWN_TOKEN` nonce. The guard's exempt roots are baked too (contract §23).                                                                                                                                                                                                                                                                                |
| **SEC-5** | **Closed, origin-gated command enum.** (a) No command takes a path, shell string, code or file; text a command carries comes from a closed registry or constant table in main unless the command's row says otherwise. (b) No generic "run" command. (c) Every command's origin is gated server-side: an operator gesture, or a verb that already passes the existing predicates (`sessionOwnedByHarnu`, `isMessageableOwner`) and the blocked-folder check. (d) A peer message is never submitted `asUser`. |
| **SEC-6** | **Audit on the Harnu side.** One record per command (cause, target, command, text hash, ordinal, outcome), per ask decision and per binding change, in `<userData>/companion/audit.ndjson`. The mod's own log is not an audit.                                                                                                                                                                                                                                                                               |
| **SEC-7** | **Honest coverage.** The Inbox and session rows carry a coverage state and never claim a guarantee. The audit pane says "can", never "safe", "verified" or "trusted". Never "nothing runs without approval", never "approve from anywhere".                                                                                                                                                                                                                                                                  |
| **SEC-8** | **No secrets at rest or on the wire.** No token in a log, `$.store`, an event payload, a parity trace, a fixture, a diagnostics view or a record handed to another module: the spawn token stays inside the host's ledger and later waves key their own state by the spawn owner. `conn` lives only in module memory and `$.state`.                                                                                                                                                                          |
| **SEC-9** | **Forbidden constructions.** (a) `$.process.run` / `$.process.spawn` or fetch-and-run in the companion. (b) `$.mcp.call`. (c) Auto-allow rules inside the mod. (d) Any `tool.call` matcher on Bash. (e) Hooks on `ui.render{AskUserQuestion}`. (f) Installing around a managed policy. (g) Widening authority because a stamp is present: ADR-0013's target-side checks stay and agent-controlled spawns get no Harnu MCP.                                                                                   |

### 7.2 Arbitration and fallback (ARB)

| Id        | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ARB-1** | **Both paths are always injected; Harnu main arbitrates.** Legacy hooks cannot be withdrawn from a running session, so fallback never needs a respawn and is never decided inside the session.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **ARB-2** | **One writer per (session, family).** (a) Two sources are never merged. (b) Legacy input for an owned family is dropped at the adapter boundary and recorded in the parity ledger; it still counts as a sign of life for the "stuck" timer. (c) `telemetry` is partitioned by field group, not merged: the companion owns four groups, context, cost, limits and (P1W6 slice S3) the model id, each from its first non-null reading; the statusLine keeps the eight fields with no mod source. (d) The terminal edge is first-writer-wins: the hub admits the first non-`clear` `SessionEnd` of a session from **either** source and drops later ones, because a lost `bye` must not swallow the edge the in-main observers depend on. It selects one event; it merges no value.                                                                                                                                                                                                                                            |
| **ARB-3** | **Ownership needs all three:** every feature the family requires is proven (contract §11), the lease is live, and the family's mode is `active` for that folder. A declaration alone is never trusted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **ARB-4** | **Lease.** (a) Live = a parked `poll`/`ask`, or a request in the last 20 s, on a monotonic clock, with one TTL of grace after the machine wakes. (b) On loss, legacy wins for every family of that session within one TTL. (c) The reversion is sticky until the session ends or the host restarts: no flapping. A failed proof does the same for the families that need the feature. (d) Identity already bound is kept.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **ARB-5** | **No forked consumers.** Mod events enter through the task-state hub with `source` set, so the `isHibernated` guard and the four in-main observers (`mcp/tool-handlers.ts:3248`, `memory-digest.ts:439`, `terminal-ledger.ts:234`, `orchestrator-guard.ts:522`) keep working. Every other consumer is fed through an adapter in its existing input shape.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **ARB-6** | **Rollout.** (a) `off`, `shadow` or `active` per family plus a per-folder ramp; an invalid value reads as `shadow`. (b) **`shadow` means no actuation and no authority for a family that has a legacy rival.** Allowed in `shadow`: sensor events (recorded, never applied), the poll loop, observe-only commands (`flush`, `config.update`, `guard.set {enforce: false}`, `sentinel.set`, `ui.band.set`), stamp level `observe`, parity recording and the `status` ask. A feature with no fact family is not governed by a family's `shadow`: an actuator, gate or surface of that kind has its own key in `companion-prefs.json` and needs the key on, the companion mode not `off`, and a live lease (contract §11.5). (c) A family flips to `active` only on parity-ledger evidence, with thresholds fixed in its wave spec. (d) Default-on is an operator decision point (§13). (e) No packaged build loads the mod by default before P1W4 ships the disclosure and the kill switch.                                   |
| **ARB-7** | **Version and policy gates.** (a) CLI below 2.1.287, or a version not yet probed: no mod. (b) CLI above the tested ceiling: every family forced to `shadow` and every feature key capped at its observe level, until the drift contract passes. (c) Managed policy, kill switch, `--safe-mode`, `--bare` and a mid-session unload are detected by absence (no hello, lease loss, missing proof) → legacy, stated plainly in the Harnu mod state with the neutral wording of DOC-8, with no workaround offered. (d) The kill switch turned off takes effect at once for every session: the host revokes each `conn` and answers the re-hello with `enable: []`. Turned back on, it reaches new sessions only.                                                                                                                                                                                                                                                                                                                |
| **ARB-8** | **Never delete:** the transcript watcher with `transcript-truth.ts` and `stall-detect.ts`, the PID-registry watcher, the `/usage` poll and its parser, the JSONL cost scan, the argv positional prompt, the task-state reducer (`hook-state.ts`), the resolver chain and Sentinel (regex engine included), the `isHibernated` guard, the per-session `--settings` blob, the hook-bridge server (the blob's transport), statusLine ingest and parse (eight statusLine fields have no mod source), and the settings read-modify-write helpers with the hook identity and prune functions (the opt-in installs, and cleaning a machine that upgrades from any older Harnu).                                                                                                                                                                                                                                                                                                                                                    |
| **ARB-9** | **Actuators are exclusive.** (a) Approval: while the companion owns `approval` for a session the bridge stands down for its `PreToolUse`/`PermissionRequest` POSTs (no double park); synchronous resolvers such as a Sentinel deny still run on the legacy hook; decisions dedupe on `tool_use_id`. (b) The bridge stands down for `SendMessage` `PreToolUse` when the session's lease is live **and its `message` family is `active`** (C7 as narrowed by C18). One predicate carries both rules: P2W3 introduces it, P3W1 extends it. (c) Guard: for an owned session `armed.json` holds **no entry the script enforces**: the entry stays as the role record with `enforcer: 'companion'`, and is rewritten to `'script'` on lease loss and at host boot. (d) Start prompt: a one-shot claim in main, keyed by the spawn; a prompt is never delivered by both paths. (e) Message: the broker picks one transport per message; the companion transport is refused for a recipient in bypass mode or whose mode is unseen. |

### 7.3 Mod authoring (MOD)

| Id        | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MOD-1** | **Validate-enforced shape.** `$` is passed only to functions declared at the top of the hooks file; `$.env.get` takes literal names; `$.state` keys are declared in the `types` contract by the wave that owns them (contract §22); JSX lives in `.tsx`. Plain TypeScript, no bundler, relative imports inside the plugin dir only; `contract.ts` has zero imports.                                                         |
| **MOD-2** | **Never throw, never spin, never block.** Every hook body is wrapped and returns `next(e)` on failure; no synchronous loop (a 5 s heartbeat miss unloads the mod); each `on()` registration is probed and a failed non-optional one is left out of `declared`.                                                                                                                                                              |
| **MOD-3** | **Closed hook surface.** Hooked events and `$` calls equal the checked-in `api-surface.json`. `tool.call` is hooked with exactly two matchers: the tools `Edit`, `Write`, `NotebookEdit`, and the RegExp `/^mcp__(harnu\|capy)__/` (`capy` is the legacy server-name alias). No matcher may match `Bash` (static test, #92533). No `turn.step`. No `'*'` event wildcard. No hook on `plugin.register` outside `sense.mods`. |
| **MOD-4** | **Idempotent lifecycle.** `ensureHello` is lazy and runs at the head of every hook; hello, boot claim, command registration and loop start are idempotent across hot reload; anything that must survive a reload lives in `$.state` or is re-fetched at hello. At most one `on()` registration per (event, matcher): waves share a body (contract §11.4).                                                                   |
| **MOD-5** | **Bounded holds.** Every hold is ≤25 s (poll) or ≤20 s (ask tranche) and re-issued; a 30 s abort is a normal reconnect. No `poll` and no `ask` when `isInteractive === false`.                                                                                                                                                                                                                                              |
| **MOD-6** | **Buffer and re-send.** `$` calls in flight die with a denied or aborted turn. Only `hello` and `ask` are awaited on a turn's path. Never await `prompt.submit`, `session.compact`, `$.command.run`, `$.session.append` or `$.model.fork` in the poll loop; never append synchronously inside the `session.compact` hook.                                                                                                   |
| **MOD-7** | **Harnu-owned wire vocabulary.** No raw CLI event name on the wire; known noise is dropped in the mod (the stray `classic.SubagentStop` with an empty `agent_type`).                                                                                                                                                                                                                                                        |
| **MOD-8** | **Compose, do not replace.** Sensors and gates pass through `next(e)`; UI wraps other mods' content. Do not rely on `$.ui.notice`, nor on status or toast being visible under the engine dialog. Deny reasons stand alone as sentences. Text the model will read is closed-vocabulary and declarative.                                                                                                                      |
| **MOD-9** | **Shipping hygiene.** Small and readable is part of the product. The staged directory is immutable and versioned; tests, fixtures and `.claude-plugin/types/` are never staged; the companion is the first `--plugin-dir`. A staged directory a live session or the outside install names is never garbage-collected.                                                                                                       |

### 7.4 Test and definition of done (QA)

| Id       | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **QA-1** | **AC format** as §6: one method, one observable, a named evidence artifact, `Guards:`.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **QA-2** | **Negative ACs are mandatory in every wave:** mod absent, blocked by policy, lease lost mid-session, host down, the kill switch turned off mid-session, and (for gates) a failure that must not become an allow.                                                                                                                                                                                                                                                                                                                      |
| **QA-3** | **Pyramid.** L1 host unit (pure cores, vitest) · L2 contract (golden fixtures, vitest) · L3 mod unit (`claude plugin test`, same fixtures) · L4 integration (real `claude -p --plugin-dir` against a fake host; `tests/cli/*.cli.test.ts`; opt-in `--with-cli`) · L5 live-verify (second isolated Harnu; numbered recipes).                                                                                                                                                                                                           |
| **QA-4** | **Merge bar.** `scripts/ci/local-pipeline.sh --base <branch below>` green, including the new `mod` step; coverage floors not lowered; any new shell file added to the coverage `exclude` list with a justification and a tested core; the legacy path's existing tests still pass; UI waves add `--with-e2e`; waves that touch the real CLI add `--with-cli`.                                                                                                                                                                         |
| **QA-5** | **Skip versus fail.** In `npm test`, CLI-dependent suites `describe.skipIf` and print one line. In local-ci the `mod` step fails when the CLI is absent or below 2.1.287; only an explicit `--skip mod` bypasses it, recorded as `skipped`. "Hooks modules are turned off" is reported as `blocked-by-policy`, never as a pass.                                                                                                                                                                                                       |
| **QA-6** | **Drift.** `api-surface.json` is checked three ways: statically against the source, against the `claude plugin validate --strict --json` report, and by `tsc` against the installed CLI's generated types. The tested ceiling moves only when all three and the live smoke pass.                                                                                                                                                                                                                                                      |
| **QA-7** | **Conformance.** Both sides pass the contract's conformance checklist (contract §19, cited as "conformance row N") against the same fixtures. Every mod test ends with a positive assertion on an observable effect (an unstubbed `$` call skips a hook silently).                                                                                                                                                                                                                                                                    |
| **QA-8** | **Hermetic and cheap.** No tmux below L5; no sleeps (mock clock, injected clocks, bounded polling). L4 uses a temp HOME, config dir, cwd and socket, always passes `--debug-file`, and fails on `hook skipped` or `not loaded` in it. Model calls: zero is the target; otherwise haiku, at most three per run, behind `HARNU_CLI_LIVE=1`, with a cost cap in the spec, never in `npm test`. Evidence records `claude --version`. Live measurements isolate the legacy bridge (it added about 3.5 s per tool call in runs A, B and D). |
| **QA-9** | **Parity.** Traces are scrubbed NDJSON (text hashed, paths relativised) committed under `tests/fixtures/companion-parity/<family or feature key>/` and replayed by a pure comparator; the flip gate is N sessions with zero unexplained divergences, N fixed in the wave spec; `human` ACs are listed separately.                                                                                                                                                                                                                     |

### 7.5 Docs contracts (DOC)

| Id        | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **DOC-1** | A `CHANGELOG.md` entry for every wave that changes behaviour, written for users.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **DOC-2** | Agent-facing waves (§4) update `docs/harnu-features.md` and bump its version marker in the same change. The spec says "bump the marker", never a marker number: two waves that land in a different order would both be wrong.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **DOC-3** | User-visible waves (§4) update `docs/user/` in the same change, from the code that landed, saying plainly what is half-built.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **DOC-4** | UI: `design.md` first, tokens only, a row in the design-entity file map for a new component, and every string in both `en.json` and `pt-BR.json`. Strings about the mod itself live under the i18n namespace `harnuMod.*` (§15).                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **DOC-5** | English only; no client identifiers; `~` and `<userData>` instead of home paths.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **DOC-6** | Every deviation from the study is listed with its D-number and smoke id. Evidence is cited by smoke id against `docs/studies/T389-smoke-evidence.md`; a claim with no evidence is marked as an open question with an owner wave.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **DOC-7** | A wire change lands in `01-contract.md`, `contract.ts` and the fixtures in the same change. No wave defines wire shapes elsewhere.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **DOC-8** | Copy. The state reads "Harnu mod: live", "Harnu mod: legacy — {reason}", "Harnu mod: off"; no user-visible string says "companion" (§15). A cause is named only when it was observed: "Blocked by your organization's policy" needs a positively identified managed cause (the sideload exit once its exit text has been recorded, Q6; a managed settings file); a probe that only shows mods are off says "Turned off by a setting or by your organization's policy"; anything else says the mod did not load. No workaround is offered. The disclosure says the mod is unsandboxed, runs in the CLI process and talks only to Harnu on this machine. |
| **DOC-9** | Requirement ids are cited, not restated. Sets stop at 9 and sentinel names use `_`: a token shaped like a tracker key with two or more digits fails `tests/no-client-identifiers.test.ts` (C15). Conformance rows are cited as "conformance row N". Run the test's two key patterns over every new doc.                                                                                                                                                                                                                                                                                                                                                |

## 8. Fallback matrix

**L** = legacy seam · **M** = companion · **M\*** = companion only once proven for that session ·
**R** = PID-registry and transcript tiers · **—** = not applicable.

| Condition                                                               | identity            | taskState            | telemetry / planUsage | approval                                                       | guard                        | startPrompt                    | message                | live context                       |
| ----------------------------------------------------------------------- | ------------------- | -------------------- | --------------------- | -------------------------------------------------------------- | ---------------------------- | ------------------------------ | ---------------------- | ---------------------------------- |
| CLI < 2.1.287, or version not probed yet                                | L                   | L                    | L                     | L                                                              | L                            | L                              | L socket               | L (spawn-time)                     |
| CLI above the tested ceiling (forced `shadow`)                          | L                   | L                    | L                     | L                                                              | L                            | L                              | L                      | L                                  |
| Mode `off`, Harnu or remote kill switch (at once, running sessions too) | L                   | L                    | L                     | L                                                              | L                            | L                              | L                      | L                                  |
| Mode `shadow` (mod reports, observe-only commands, ledger records)      | L                   | L                    | L                     | L                                                              | L                            | L                              | L                      | L                                  |
| Org blocks user mods, `--safe-mode`, `--bare` (no hello)                | L                   | L                    | L                     | L                                                              | L                            | L (2 s wait, then paste)       | L                      | L                                  |
| `disableSideloadFlags` (the CLI exits; respawn without the flag)        | L                   | L                    | L                     | L                                                              | L                            | L                              | L                      | L                                  |
| `sec-default` only (`classic.*` pinned)                                 | M (drift check)     | L (no classic proof) | M                     | L                                                              | M\*                          | M\*                            | L socket (mode unseen) | M\* after P4W5; L (restart) before |
| Lease lost mid-session (unload, crash, lost `conn`)                     | kept from the claim | L, sticky            | L                     | L (bridge resumes)                                             | L (entry back to `script`)   | delivered already, or L        | L                      | L                                  |
| A sibling mod wedges the worker (one call)                              | M                   | M                    | M                     | engine verdict for that call                                   | engine verdict for that call | M                              | M                      | M                                  |
| Host down or restarting                                                 | R until re-hello    | R                    | cache                 | native dialog                                                  | L (entries reset at boot)    | L paste gate                   | refused, retry         | L                                  |
| A hook missing on a new CLI (registration failed)                       | per feature         | per feature          | per feature           | L                                                              | L                            | L                              | L                      | L                                  |
| Headless `-p` (scheduler tick)                                          | M                   | M (sensor)           | M                     | as today (none)                                                | L                            | argv                           | L                      | —                                  |
| Agent-controlled spawn                                                  | M                   | M                    | M                     | L (global hook; session blob after P5W1 step H2)               | —                            | M\* framed, else paste         | L, else M\*            | no Harnu MCP, no stamp             |
| Untrusted folder (trust dialog)                                         | L until proven (C8) | L                    | L                     | L                                                              | L                            | L                              | L                      | L                                  |
| Resume picker or login pending (no `session.start` yet)                 | none until passed   | R                    | cache                 | L                                                              | L                            | L (gate cap)                   | L                      | —                                  |
| Owned session in `acceptEdits` or `bypassPermissions`                   | M                   | M                    | M                     | no hold: the engine does not ask (OD-2); Sentinel still denies | M\*                          | M\*                            | L socket (bypass)      | M\*                                |
| Recipient in bypass mode, or its mode unseen                            | —                   | —                    | —                     | —                                                              | —                            | —                              | L socket               | —                                  |
| Started outside Harnu, switch off                                       | R                   | R                    | statusLine            | L (global hook, opt-in after P5W1 step H2)                     | —                            | —                              | refused (cold)         | —                                  |
| Started outside Harnu, external profile, corroborated                   | M                   | M                    | M                     | L; M on the interceptor ramp                                   | —                            | —                              | refused                | —                                  |
| External claim not corroborated                                         | nothing shown       | nothing shown        | nothing shown         | L                                                              | —                            | —                              | refused                | —                                  |
| Session spawned with a user `--settings <file>` (after P5W1 H2)         | M                   | M, else R            | M                     | native dialog (no blob, no global hook)                        | L                            | L                              | L                      | L                                  |
| Parked (no process)                                                     | Harnu state         | hibernation flag     | cache                 | —                                                              | —                            | — (a resume carries no prompt) | wake, then M\* or L    | —                                  |

The `sec-default` row deviates from the migration panel paper, which put `taskState` on the
companion through `turn.*` alone: without `classic.*` the companion cannot see
`waiting-permission`, and ARB-2a forbids merging it with legacy, so the family stays legacy.

## 9. Risk register

| #   | Risk                                                                                                                                         | Sev      | Mitigation                                                                                                                 | Owner wave |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------- | ---------- |
| R1  | A remote `prompt.submit` is code execution with the session's permission mode                                                                | Critical | SEC-5, SEC-6; the claim is keyed to the binding                                                                            | P2W1       |
| R2  | The mods API changes between releases without notice                                                                                         | High     | QA-6, ARB-7b, MOD-7; thin mod; legacy fallback                                                                             | P1W2       |
| R3  | The Inbox is read as a gate while a sibling mod, a forged response or a wedge bypasses it                                                    | High     | SEC-1, SEC-7; coverage state; never fixable in-process (smoke B6, D6)                                                      | P3W1       |
| R4  | Two stacks forever: every seam has a companion path and a legacy path                                                                        | High     | ARB-8 budgets it; P5W1 demotes only on evidence and freezes legacy; kill criteria in ADR-0018                              | P5W1       |
| R5  | A sibling mod's wedge skips the hook chain for a call (C9)                                                                                   | High     | fail to the engine verdict; `mod.error` and lease signals; `contested` after repeats                                       | P1W4       |
| R6  | The stamp is trusted as caller identity                                                                                                      | High     | SEC-9g, D8; ADR-0013 checks stay                                                                                           | P2W5       |
| R7  | Double park: the legacy `PreToolUse` and the companion both hold                                                                             | High     | ARB-9a; parity compares asks only                                                                                          | P3W1       |
| R8  | A Bash `tool.call` hook, even pass-through, breaks worktree-isolated agents (#92533, smoke B4)                                               | High     | MOD-3 static test                                                                                                          | P1W2       |
| R9  | A hung host blocks the first prompt: `hello` is awaited and one fetch can last 30 s                                                          | Medium   | `HELLO_SLA_MS`; the mod bounds its wait at `HELLO_WAIT_MS`                                                                 | P1W1, P1W3 |
| R10 | Hot reload wipes module state mid-turn; held asks and the poll loop restart                                                                  | Medium   | MOD-4; immutable staged dir so production never reloads; `ASK_ORPHAN_MS`                                                   | P1W3       |
| R11 | Fleet state stuck on `working` when the mod goes silent                                                                                      | Medium   | lease expiry within 20 s; the silence timer and registry tiers stay (ARB-8); a lease never refreshes the timer             | P1W5       |
| R12 | A start prompt is submitted twice, or never                                                                                                  | Medium   | ARB-9d; command dedupe on `cmd`; `submitted: 'unknown'` never pastes; the existing undelivered escalation                  | P2W2       |
| R13 | A peer message laundered as user input                                                                                                       | Medium   | SEC-5d; explicit peer envelope                                                                                             | P2W3       |
| R14 | Usage history goes dark when statusLine ingest is demoted (`statusline.ts:243-247` feeds `captureFleet`)                                     | Medium   | the telemetry adapter feeds the same capture; a precondition of P5W1 step S1                                               | P1W6       |
| R15 | The staged mod is rewritten by a same-user process                                                                                           | Medium   | re-stage and hash-check on spawn; conceded per ADR-0004                                                                    | P1W2       |
| R16 | The audit pane is read as a safety verdict                                                                                                   | Medium   | SEC-7 wording; "changed since reviewed"                                                                                    | P4W1       |
| R17 | Loading the mod surprises users                                                                                                              | Medium   | ARB-6e; disclosure; kill switch; OD-1                                                                                      | P1W4       |
| R18 | A compaction instruction makes the summarizer refuse, and the refusal becomes the summary (smoke D5)                                         | Medium   | no instruction in protocol 1; the summary is classified before it is trusted                                               | P4W5       |
| R19 | `$.model.fork` spends tokens unasked; before the first response it answers `nothing-to-fork`                                                 | Low      | explicit switch, off by default, and a cost disclosure                                                                     | P4W4       |
| R20 | The band competes with Harnu's own chrome                                                                                                    | Low      | no band inside Harnu in protocol 1                                                                                         | P4W2       |
| R21 | **Cold fork cost.** A plan captured at park time finds the prompt cache lapsed and re-bills the whole context at input price                 | High     | default mode `idle` (capture while warm); mode `park` under a context ceiling; a per-session hourly cap; a `spent` counter | P4W4       |
| R22 | **Coverage change.** With the companion, a session in `acceptEdits` or `bypassPermissions` no longer shows every call in the Inbox for 3.5 s | High     | OD-2; the coverage line says so; the Sentinel deny is preserved (legacy hook, or the `tool.check` query of P3W2)           | P3W1       |
| R23 | **Outside install on a managed machine.** With `disableSideloadFlags` the env key may make every `claude` launch exit                        | High     | OD-5: refuse the install when a managed settings file exists; post-install check and rollback; a `human` AC                | P4W3       |
| R24 | **Double module instance.** A directory named by the flag and by the env key may load twice; two instances would steal each other's `conn`   | High     | CQ18: verified before the switch ships; if two, Harnu omits its own flag while the outside switch is on                    | P4W3       |
| R25 | **`plugin.register` cost.** A module hooking it makes every reload re-run every module (types L4038)                                         | Medium   | `sense.mods` is off by default (CQ21) and is the only place the hook may appear (MOD-3)                                    | P4W1       |
| R26 | The companion message transport does not run the recipient engine's peer hold, nor other mods' `session.receive` hooks                       | High     | the bypass-parity rule (ARB-9e, C17); the flip of `message` waits for Q16                                                  | P2W3       |
| R27 | A dev build pointed at the repo folder rewrites `coords.gen.ts` under another instance's live sessions                                       | Medium   | opt-in flag with a single-owner lock (C23)                                                                                 | P1W2       |
| R28 | The global install is demoted while the per-session blob still lacks an event, so legacy sessions silently lose it                           | Medium   | P5W1 step order: the blob gains `StopFailure` one release before H1, and the decision events before H2                     | P5W1       |
| R29 | A mission title or other text written by one session reaches another session's model through a context row or a status line                  | Medium   | closed-vocabulary status text; context rows built from a closed registry with ids, never free text (SEC-5a)                | P4W2, P4W5 |

## 10. Open questions carried from the smoke runs and the wave specs

Each becomes an acceptance criterion of the named wave. Contract-level questions are in
`01-contract.md` §20 (CQ1–CQ21) and are not repeated here. "Settled" rows keep their number.

| #   | Question                                                                                                                                                                                                                                                                                                                                         | Wave                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Q1  | Untrusted folder: is there a consent prompt on load, and does the trust dialog block `session.start`? (C8)                                                                                                                                                                                                                                       | P1W2; P2W2 reads the answer                                            |
| Q2  | Do scheduler ticks (`--setting-sources ''`, `scheduler-core.ts:660`) still load a `--plugin-dir` mod?                                                                                                                                                                                                                                            | P1W2                                                                   |
| Q3  | Load order of marketplace-installed and `~/.claude/skills` mods relative to `--plugin-dir`                                                                                                                                                                                                                                                       | **P4W1** (part B observes it); P1W2 only pins the `--plugin-dir` order |
| Q4  | The `claude plugin validate --json` shape is free text in `notes[]`: snapshot it; `types/` exist only after one load                                                                                                                                                                                                                             | P1W2, P4W1                                                             |
| Q5  | A zero-model L4 harness (a probe command, a fake-model mod); does `-p` need auth before `session.start` under a temp HOME?                                                                                                                                                                                                                       | P1W2                                                                   |
| Q6  | `disableSideloadFlags`: the exit is detected by behaviour and the respawn drops `--plugin-dir`; the real exit text needs a managed machine                                                                                                                                                                                                       | P1W2 (detection); P1W4 (the managed run, with Q8)                      |
| Q7  | SIGKILL (no `bye`): PTY exit closes the binding (settled, P1W1). Remainder: a process that survives with the mod unloaded                                                                                                                                                                                                                        | P1W4                                                                   |
| Q8  | One managed-machine run: `sec-default`, `allowManagedModsOnly`, the remote kill switch, gateway users served `off`; whether `sec-default` passes `$.command.register`, `session.send`/`session.receive` and `model.fork` (the source README says it does; confirm on 2.1.287); whether `disableAllHooks` drops hooks passed through `--settings` | P1W4 (run and recipe); P4W2, P2W3, P4W4, P5W1 read the answers         |
| Q9  | An unattributable worker crash; three crashes blamed on the same mod                                                                                                                                                                                                                                                                             | P1W4                                                                   |
| Q10 | Where the Harnu mod switch lives before the Mods tab exists                                                                                                                                                                                                                                                                                      | **settled**: Settings → General → Integrations (P1W4); P4W1 moves it   |
| Q11 | Does `ui.render` reveal the dialog closing? (No "dialog answered" event exists.)                                                                                                                                                                                                                                                                 | P1W5                                                                   |
| Q12 | The shape of `classic.Stop.background_tasks`                                                                                                                                                                                                                                                                                                     | P1W5                                                                   |
| Q13 | `$.session.model()` for the model display name; `effortLevel` values; API-error turns without usage (C5)                                                                                                                                                                                                                                         | P1W6                                                                   |
| Q14 | Does `turn.complete.durationMs` exclude dialog time? (one run)                                                                                                                                                                                                                                                                                   | P1W6                                                                   |
| Q15 | `$.command.run` mid-turn; a `session.append` system notice mid-turn                                                                                                                                                                                                                                                                              | P2W2, P2W4                                                             |
| Q16 | A receiver that refuses inbound messages; the held-for-approval path; mid-turn fold-in during a tool loop; remote recipients. Blocks the `message` flip and P5W1 step M1                                                                                                                                                                         | P2W3                                                                   |
| Q17 | `NotebookEdit` in the guard; `$.state` as the flag source; a symlink or `..` bypass of the exempt surfaces (C1)                                                                                                                                                                                                                                  | P2W4                                                                   |
| Q18 | `auto` permission mode: the hold, and the stamp's input rewrite (D8)                                                                                                                                                                                                                                                                             | P3W1, P2W5                                                             |
| Q19 | Could the model learn a stamped value from a server that echoes its arguments?                                                                                                                                                                                                                                                                   | P2W5                                                                   |
| Q20 | Interactive runs of the permission-mode matrix; holds beyond 15 minutes; a hold across `/clear`, `--resume`, reload                                                                                                                                                                                                                              | P3W1                                                                   |
| Q21 | Rendering inside xterm.js; clicking the OSC 8 link; the fullscreen layout                                                                                                                                                                                                                                                                        | P4W2                                                                   |
| Q22 | Desktop, VS Code, SDK and cloud surfaces; a `$.prompt.submit` turn not shown on Desktop (upstream #96336)                                                                                                                                                                                                                                        | P4W3                                                                   |
| Q23 | Auto-triggered compaction (`trigger: "auto"`) and `precompute`; whether `classic.SessionStart {source: compact}` fires for them                                                                                                                                                                                                                  | P4W5                                                                   |
| Q24 | Does `turn.start` fire for a turn started by a subagent's completion notice, and is its `turnId` the one `$.turn.abort` needs?                                                                                                                                                                                                                   | P1W5 (asked by P2W1)                                                   |
| Q25 | Should the companion audit log and the native-message audit get a pane?                                                                                                                                                                                                                                                                          | P4W1 (default: file only)                                              |
| Q26 | Is the band visible while the engine's permission dialog is open? (smoke B2 covered status and toast only)                                                                                                                                                                                                                                       | P3W1 (asked by P4W2)                                                   |
| Q27 | In `auto` mode, does a `tool.check` deny still win over the classifier?                                                                                                                                                                                                                                                                          | P3W1, recipe LV-P3W1-b (asked by P3W2)                                 |
| Q28 | A `/resume` into a session live in another tab is a conflict: should Harnu re-key anyway and close the other tab?                                                                                                                                                                                                                                | P1W4 (default: no)                                                     |
| Q29 | Where does `resetsAt` of a rate-limited turn come from, given §14 finding F1?                                                                                                                                                                                                                                                                    | P1W5                                                                   |
| Q30 | Rate bucket per binding or per connection for the external profile                                                                                                                                                                                                                                                                               | P4W3 (default: per binding)                                            |
| Q31 | Static detection of a co-loaded mod that can decide a permission (`contested / other-mod`)                                                                                                                                                                                                                                                       | P4W1 (asked by P3W1)                                                   |
| Q32 | Should agent prompts under the argv budget also move to the companion later?                                                                                                                                                                                                                                                                     | P5W1 (default: no, D9)                                                 |

## 11. Spec index

| File                                 | Wave | Title                                                   |
| ------------------------------------ | ---- | ------------------------------------------------------- |
| `00-master.md`                       | P0   | This document                                           |
| `01-contract.md`                     | P0   | Companion protocol contract                             |
| `P1W1-host-server.md`                | P1W1 | Host server                                             |
| `P1W2-mod-skeleton-and-harness.md`   | P1W2 | Mod skeleton, staging, CLI version gate, test harness   |
| `P1W3-handshake-identity.md`         | P1W3 | Handshake and identity                                  |
| `P1W4-arbitration-and-rollout.md`    | P1W4 | Arbitration, task-state hub, rollout, parity, status UI |
| `P1W5-fleet-state.md`                | P1W5 | Fleet state                                             |
| `P1W6-telemetry-usage-cost.md`       | P1W6 | Telemetry, plan usage, per-turn cost                    |
| `P2W1-command-channel.md`            | P2W1 | Command channel                                         |
| `P2W2-start-prompt.md`               | P2W2 | Start-prompt delivery                                   |
| `P2W3-messaging.md`                  | P2W3 | Messaging broker and native SendMessage audit           |
| `P2W4-live-contract-and-guard.md`    | P2W4 | Live orchestrator contract and in-process guard         |
| `P2W5-mcp-attribution.md`            | P2W5 | MCP caller attribution                                  |
| `P3W1-approval-hold.md`              | P3W1 | Approval hold                                           |
| `P3W2-structured-sentinel.md`        | P3W2 | Structured Sentinel rules                               |
| `P4W1-mods-audit-tab.md`             | P4W1 | Mods audit tab                                          |
| `P4W2-terminal-band-and-commands.md` | P4W2 | Terminal band and `/harnu-link` commands                |
| `P4W3-companion-outside-harnu.md`    | P4W3 | Harnu mod outside Harnu                                 |
| `P4W4-resume-micro-plan.md`          | P4W4 | Resume micro-plan                                       |
| `P4W5-compaction-digest.md`          | P4W5 | Compaction digest and durable context                   |
| `P5W1-legacy-retirement.md`          | P5W1 | Legacy seam demotion                                    |

Plans live under `docs/plans/T389-companion-mod/` (`00-master-plan.md`, `P1-sensor.md`, …).

## 12. Cross-wave host interfaces

**The rule.** The wave that owns a module defines its signatures; a consumer conforms and never
restates a different shape. A consumer that needs something the owner does not offer gets it
added to the owner's module, in the owner's style, with the signature below. Wire shapes, the
shared hook registrations, the `$.state` keys and the baked coordinates are in the contract
(§5–§11, §11.4, §22, §23) and are not repeated here.

### 12.1 Main process

| Interface                     | Owner                            | Exact signature                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Consumers                                                                                                                                                                                                                    |
| ----------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host facade                   | P1W1                             | `companionHost: { mintSpawnToken(meta: SpawnMeta): SpawnToken \| null; releaseSpawn(owner, reason): void; bindingForSession(sessionKey): BindingView \| null; bindingForSid(sid): BindingView \| null; getBinding(sidOrSessionKey): BindingView \| null; onBindingChange(fn): () => void; spawnRecord(owner): SpawnRecordView \| null; setEnablePolicy(fn: EnablePolicy): void; revoke(b): void; markProven(b, feature): void; revokeProof(b, feature): void; verifyStamp(handle, nonce, tool, mac): …; registerEventTypes(names): void; bus: CompanionBus; diagnostics(): CompanionDiagnostics }` (`src/main/companion/host.ts`), plus the extension points below. `interface CompanionBus { on(type: 'hello', fn: (b: BindingView, kind: 'spawn' \| 'resume' \| 'external') => void): () => void; on(type: 'event', fn: (b: BindingView, ev: WireEvent) => void): () => void; on(type: 'lease', fn: (b: BindingView, state: 'lost') => void): () => void; on(type: 'end', fn: (b: BindingView, reason: string) => void): () => void }` | every wave                                                                                                                                                                                                                   |
| Binding view                  | P1W1                             | `interface BindingView { key: number; owner: SpawnOwner \| null; trust: TrustClass; sid: Sid; sessionKey: string \| null; cwd: string; profile: 'interactive' \| 'headless' \| 'external'; cliVersion: string; modVersion: string; declared: FeatureId[]; enabled: FeatureId[]; proven: FeatureId[]; lease: 'live' \| 'lost'; state: 'bound' \| 'ended' \| 'closed'; corroborated?: boolean }`. Token-free: no `conn`, no spawn token. `owner` is `null` for an external binding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | every wave                                                                                                                                                                                                                   |
| Spawn record                  | P1W1                             | `spawnRecord(owner: SpawnOwner): SpawnRecordView \| null`, `SpawnRecordView = { cwd: string; trust: TrustClass; state: 'minted' \| 'redeemed' \| 'spent' \| 'released'; releasedReason?: string }`. **No token.** `type TrustClass = 'operator' \| 'agent' \| 'read-only' \| 'tick'`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | P1W2, P1W4, P2W2                                                                                                                                                                                                             |
| Endpoint extension points     | P1W1                             | `companionHost.setPollHandler(fn: (b: BindingView, req: PollRequest, reply: (r: PollResponse) => void) => void): void` · `registerAskKind<K extends AskKind>(kind: K, fn: (b: BindingView, req: AskRequest<K>, reply: (r: AskResponse<K>) => void) => void): void` · `setCommandSource(fn: (b: BindingView, cursor?: number) => Command[]): void` (fills `commands` of hello and events responses) · `beforeHello(fn: (b: BindingView, kind: 'spawn' \| 'resume' \| 'external') => void): () => void` (synchronous, runs after the binding exists and before `commands` is read; no awaited I/O) · `hold(b: BindingView): () => void` (the lease counts a parked request until the returned function is called)                                                                                                                                                                                                                                                                                                                          | P2W1, P3W1, P3W2, P4W2; P2W2, P2W4, P3W2, P4W5 (`beforeHello`)                                                                                                                                                               |
| Table additions               | P1W1                             | `revoke(b): void` (contract §3 item 9; P1W4, P4W3) · `markProven(b, feature: FeatureId): void` and `revokeProof(b, feature): void` (adapters) · `verifyStamp(handle: string, nonce: string, tool: string, mac: string): { binding: BindingView; verdict: 'verified' \| 'bad-mac' \| 'replayed' } \| 'unknown-binding'` (P2W5; `conn` never leaves the table; the nonce is recorded in the ring only on `verified`) · the ledger entry's `expiresAt` (P1W3) · `profile: 'external'` and `corroborated` (P4W3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | P1W3, P1W4, P2W5, P4W3                                                                                                                                                                                                       |
| Mode seam                     | P1W1 (signatures), P1W4 (bodies) | `type CompanionMode = 'off' \| 'shadow' \| 'active'` · `type FactFamily = …` (the eight families) · `getCompanionMode(): CompanionMode` · `familyMode(family: FactFamily, folder: string \| null): CompanionMode` · `hydrateCompanionMode(): Promise<void>` · `listenerWanted(): boolean` (should the socket exist: P1W1 reads `getCompanionMode() !== 'off'`; P1W4 replaces the body with "kill switch on and some family or the developer `mode` key not `off`", never the CLI gate, which is per binary and still `unknown` when the host boots) · `onModeChange(fn: () => void): () => void` (fires when a prefs write, the kill switch or the settled CLI-version probe changes either function; the host re-evaluates the listener on it and never stops a running one) (`src/main/companion/mode.ts`). There is no second `RolloutMode` type                                                                                                                                                                                      | every wave                                                                                                                                                                                                                   |
| CLI gate                      | P1W2                             | `type CliGate = 'unknown' \| 'below' \| 'ok' \| 'above'` · `cliGate(v: ClaudeVersion \| null, ceiling: string): CliGate` · `gateAllowsInjection(g: CliGate): boolean` (`src/main/companion/version-gate.ts`). `unknown` is treated as `below` everywhere                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | P1W3, P1W4, P5W1                                                                                                                                                                                                             |
| Staging and spawn             | P1W2                             | `ensureStaged(): Promise<string \| null>` (the staged directory, or `null`) · `setCompanionSpawnProvider(fn: (ctx: { cwd: string; trust: TrustClass }) => Promise<CompanionSpawnPlan \| null>): void` · `interface CompanionSpawnPlan { pluginDir: string; mintToken(owner: SpawnOwner): string \| null }` · `renderCoords(fields: Coords): string`, `Coords` being the exports of contract §23 · `pinStagedDir(fn: () => string[]): void` (directories garbage collection must keep)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | P1W4, P2W4, P4W1, P4W3                                                                                                                                                                                                       |
| Injection decision            | P1W4                             | `companionInjectDecision(ctx: { kind: string; cliGate: CliGate }): { inject: boolean; skip?: 'off' \| 'pre-disclosure' \| 'cli-too-old' \| 'cli-unknown' \| 'not-claude' }`, called from P1W2's `spawn-inject.ts`. P1W4 keeps the decision per spawn owner in its own module                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | P1W2                                                                                                                                                                                                                         |
| Enable policy                 | P1W1 (hook), P1W4 (function)     | `type EnablePolicy = (b: Readonly<BindingView>) => FeatureId[]`. P1W3 registers a first policy (`sense.identity` only); P1W4 replaces it with `computeEnable(declared, ctx)` wrapped as an `EnablePolicy`, reading one table: `registerFeaturePolicy(feature: FeatureId, rule: (b: BindingView) => boolean): void` (`feature-policy.ts`). Each later wave registers its row; none edits another wave's                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | P1W3, every feature wave                                                                                                                                                                                                     |
| Identity                      | P1W3                             | `type IdentityFact = …`, `classifyIdentity(x): IdentityFact`, `mayAct(x): boolean` (`identity-core.ts`) · `companionHost.sessionKeyForSid(sid: Sid): string \| null` · IPC `companion:identity` (push), `companion:identityClaims` (pull) · legacy binder labels `via: 'agent-correlation' \| 'collapse' \| 'resolved-window'`, and `'companion'` for a bind by claim · `interface IdentityParityRecord` (contract-free, P1W3 §7.9)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | P1W4, P1W5, P1W6, P2W2, P5W1                                                                                                                                                                                                 |
| Arbiter                       | P1W4                             | pure: `effectiveMode(f, folder, r)`, `ownerOf(f, b, r)`, `admit(f, src, b, r)` (`arbitration-core.ts`; its binding type is named `ArbiterBinding`, not `BindingView`). Stateful shell (`session-arbiter.ts`): `owns(sessionKeyOrSid: string, family: FactFamily): boolean` · `ownerFor(sessionKeyOrSid: string, family: FactFamily): { owner: FactSource; reason: OwnReason }` · `isStickyLegacy(sessionKeyOrSid: string, family?: FactFamily): boolean` · `reportFailedProof(sessionKeyOrSid: string, feature: FeatureId): void` · `onOwnershipChange(fn: (sessionKey: string \| null, sid: Sid) => void): () => void`                                                                                                                                                                                                                                                                                                                                                                                                                  | P1W5, P1W6, P2W1–P2W5, P3W1, P4W3                                                                                                                                                                                            |
| Prefs and the extension point | P1W4                             | `<userData>/companion-prefs.json`. Families: `familyMode` above. Feature keys: `registerPrefsKey<T>(key: string, spec: { default: T; parse(raw: unknown): T; observeCap?: T }): void` · `prefsKey<T>(key: string): T` · `setPrefsKey<T>(key: string, value: T): void`. The keys, values and defaults are in contract §11.5. A wave registers its key; it never edits the file's schema                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | P2W1, P2W4, P2W5, P3W2, P4W1–P4W5                                                                                                                                                                                            |
| Task-state hub                | P1W4                             | `ingest(ev: BridgeEvent, getWindow: () => BrowserWindow \| null): void`, `BridgeEvent.source: 'hook' \| 'companion'` · `noteLiveness(sessionId: string, ts: number, getWindow): void` · `configureHub(deps)`. The hub applies ARB-2d (the terminal edge)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | P1W5, P4W3, P4W4                                                                                                                                                                                                             |
| Parity ledger                 | P1W4                             | `recordFact(stream: FactFamily \| FeatureKey, source: FactSource, sid: Sid, k: string, d?: Record<string, string \| number \| boolean \| null>): void`, the only entry point · `registerParityRule(rule: ParityRule): void` · `parityReport(stream, records)` · `gateStatus(report, gate)`. Each record also carries the `OwnReason` at the time, so P5W1 can count legacy sessions by reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | every family wave, P5W1                                                                                                                                                                                                      |
| Harnu mod state               | P1W4                             | `type CompanionState = { state: 'live' } \| { state: 'off' } \| { state: 'legacy'; reason: LegacyReason }`, `type LegacyReason = 'cliTooOld' \| 'cliUnknown' \| 'policy' \| 'modsOff' \| 'remoteOff' \| 'noHello' \| 'refused' \| 'unloaded' \| 'hostRestart' \| 'notInjected'`; an inert binding is `off` · `companionStatus()` IPC, whose per-session entry also carries `ownership: Record<FactFamily, { owner; reason }>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | P2W1, P3W1, P4W2, P4W3, P5W1                                                                                                                                                                                                 |
| Policy probe (first-lander)   | P1W4                             | `classifyPolicyProbe(output: string): 'loads' \| 'off-here' \| 'off-remote' \| 'unknown'` (`src/main/claude-policy-probe-core.ts`, pure) and one shell (`claude-policy-probe.ts`) that runs `claude plugin test` at most once per boot and binary. P1W4 lands first and creates both; its PR carries the user-docs consequence of the new top-level file. `off-here` cannot tell a personal setting from a managed policy (DOC-8)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | P4W1, P4W3                                                                                                                                                                                                                   |
| Permission hookers (static)   | P4W1                             | `permissionHookers(folder: string                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | null): { name: string; root: string }[]`: the installed mods whose static report (the `permissions`and`tool-calls`chips only) says they can decide a permission; the signal behind the Inbox coverage`contested / other-mod` | P3W1 |
| Command channel               | P2W1                             | `enqueue<N extends CommandName>(req: { sessionKey: string \| null; sid?: Sid; name: N; args: CommandArgs[N]; cause: CommandCause; ttlMs?: number }): EnqueueResult` · `cancelIfUndelivered(cmd: CmdId): boolean` · `pendingFor(b: BindingView, cursor?: number): Command[]` · `registerGateRow(name: CommandName, row: GateRow): void` · `type CommandOutcome` (its `dropped` arm already carries `delivered: boolean`) · `CommandCause` (`command-channel.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | P2W2, P2W3, P2W4, P3W2, P4W2, P4W4, P4W5                                                                                                                                                                                     |
| Audit log                     | P1W1                             | `<userData>/companion/audit.ndjson`, one writer: `appendAudit(rec: AuditRecord): void`, record kinds `binding` (P1W1, so SEC-6 holds from P1), `command` (P2W1), `native-message` (P2W3), `ask` (P3W1), `focus` (P4W2). No record carries a token or message text                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | P2W1, P2W3, P3W1, P4W2, P4W3                                                                                                                                                                                                 |
| Start-prompt claims           | P2W2                             | `startPromptClaims: { register(owner: SpawnOwner, plan): void }`, keyed by the spawn **owner**; it delivers through `beforeHello` and `enqueue`, and follows a re-key through `onBindingChange` only (no `rekey` method)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | P1W2 (call site)                                                                                                                                                                                                             |
| Transcript row classifier     | P2W2                             | `type UserRowKind = 'human' \| 'plugin-as-user' \| 'plugin-framed' \| 'plugin-meta' \| 'harnu-peer' \| 'peer' \| 'tool-result'` · `classifyUserRow(row: Record<string, unknown>): UserRowKind` · `stripPluginFrame(text: string): string` (`claude-reader-derive.ts`). Precedence for a plugin-origin row: `plugin-meta`, then `harnu-peer` (text opens with the peer envelope), then `plugin-as-user`, then `plugin-framed`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | P2W3, P2W4, P4W5                                                                                                                                                                                                             |
| Bridge stand-down             | P2W3                             | `startHookServer(opts: { …; standDown?: (req: HookRequest) => boolean })` · `Resolver.parks?: boolean` · `shouldStandDown(req: HookRequest, f: StandDownFacts): boolean` (`bridge-standdown-core.ts`), the predicate of contract §11.6; P3W1 adds its clause to this function                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | P3W1, P3W2, P4W3                                                                                                                                                                                                             |
| Context registry and injector | P2W4                             | `type ContextKey` (contract §4) · `frameContext(doc: ContextDoc): string` (`context-registry.ts`) · `deliver(sid: Sid, key: ContextKey, state: 'active' \| 'revoked'): Promise<'delivered' \| 'restart-required' \| 'unavailable'>` (`context-injector.ts`), the only issuer of `context.append` and `context.drop` (`context.drop` is the only removal path of a durable row). P4W5 adds the `harnu.mission` document and the injector's handlers `beforeHello`, `onRebound`, `onCompactDone` to these two modules                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | P4W5                                                                                                                                                                                                                         |
| Guard adapter                 | P2W4                             | `setOrchestratorRole(sid: string, folder: string, on: boolean, cause, reason?): Promise<ArmResult>` · `interface ArmResult { enforcer: 'script' \| 'companion'; contract: 'delivered' \| 'restart-required' \| 'unavailable' }` · `ArmedEntry.enforcer?: 'script' \| 'companion'`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | P2W5, P5W1                                                                                                                                                                                                                   |
| Caller attribution            | P2W5                             | `resolveCaller(tool: string, meta: unknown): CallerAttribution` · `HandlerCtx.caller: CallerAttribution` · `liftCallerStamp(body: unknown): unknown`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | P2W3, P2W4                                                                                                                                                                                                                   |
| Ask broker                    | P3W1                             | `askBroker: { heldFor(sessionKeyOrSid: string): number; coverageOf(sessionKeyOrSid: string): { coverage: Coverage; reason: CoverageReason } }` · IPC `approval:coverage`. The broker handles kind `permission` only; other kinds register on the host (`registerAskKind`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | P3W2, P4W2                                                                                                                                                                                                                   |
| Spend ledger and context size | P1W6                             | `recordAuxSpend(rec: { kind: 'fork' \| 'complete' \| 'compaction'; sid: Sid; usage: AuxUsage; ts: number }): void` · `lastContextTokens(sid: Sid): number \| null`, served by the telemetry store (slice S1); `recordAuxSpend` lands with slice S3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | P4W4, P4W5                                                                                                                                                                                                                   |
| Park coordinator              | P4W4                             | `requestPark(sessionKey: string, cause: 'cap' \| 'sweep' \| 'manual'): void`. After P4W4 no other code calls `hibernateSession` directly                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | every later change to parking                                                                                                                                                                                                |
| Retirement resolver           | P5W1                             | `resolveLegacyInstall(prefs, summaries, step): { install: boolean; reason: string }` (`retirement-core.ts`), and its own `ledgerSummary(stream, windowMs)` built on P1W4's `parityReport` and the recorded `OwnReason`s                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `hook-bridge.ts`, `statusline.ts`                                                                                                                                                                                            |

### 12.2 Mod runtime (`resources/companion/hooks/register.ts`)

| Helper                    | Owner | Signature                                                                                                                                             | Consumers             |
| ------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Handshake                 | P1W3  | `ensureHello($): Promise<void>`                                                                                                                       | every hook            |
| Emit                      | P1W3  | `emit($, event: { t: EventName; d: unknown; turnId?: string; agentId?: string }): void` (queues, flushes edge events, never awaited on a turn's path) | every sensor and gate |
| Feature test              | P1W3  | `enabled(feature: FeatureId): boolean`                                                                                                                | every wave            |
| Bound id                  | P1W3  | `boundSid(): Sid` (the bound `sid` of contract §15)                                                                                                   | P2W1, P4W5            |
| Error report              | P1W3  | `reportModError(where: string, err: unknown, cmd?: CmdId): void`                                                                                      | every wave            |
| Command executor          | P2W1  | `runCommand($, c: Command): void` · `registerCommandHandler<N extends CommandName>(name: N, fn: ($, c: Command<N>) => void): void`                    | every command wave    |
| Own-submit queue          | P2W2  | `noteOwnSubmit(cmd: CmdId): void`: every `$.prompt.submit` the mod fires is noted, so the next plugin-origin `prompt.submit` event tags its turn      | P2W3                  |
| Ask client (first-lander) | P3W1  | `ask<K extends AskKind>($, req: { askId: AskId; kind: K; d?: AskPayloads[K] }): Promise<AskResponse<K> \| null>` (`null` = transport failure)         | P3W2, P4W2            |

## 13. Operator decision points

None blocks specification: each has a default the specs implement. The master plan records the
operator's answer before the wave that needs it ships.

| #    | Decision                                                     | Default the specs implement                                                                                                                                          | Alternative                                                                                            | Wave |
| ---- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---- |
| OD-1 | Does the mod load by default once P1W4 ships?                | Yes: every family `shadow` (mod loaded, legacy authoritative), behind the one-time disclosure and the kill switch                                                    | Opt-in: the mode stays `off` until the operator turns it on                                            | P1W4 |
| OD-2 | Inbox coverage for sessions that the engine does not ask     | Hold only when the engine would ask. Sessions in `acceptEdits` or `bypassPermissions` lose today's 3.5 s window on every call; the Sentinel deny is preserved (P3W2) | Also hold in `tool.check` for those modes: the deferred dialog-suppressing variant, with its band line | P3W1 |
| OD-3 | P5W1: removing Harnu's entries from the user's settings      | A notice, then automatic removal when the machine's own ledger satisfies the retirement gate                                                                         | A prompt before each removal                                                                           | P5W1 |
| OD-4 | P2W2: is a manifest drain operator-caused for `asUser`?      | Yes: card Dispatch, Generate and the manifest drain submit the bare text, as today's paste and argv paths do; agent-controlled spawns get the framed prompt          | Treat the drain as agent-caused and frame it                                                           | P2W2 |
| OD-5 | P4W3: the outside install on a machine with managed settings | Refuse the install when a managed settings file exists                                                                                                               | Install, verify with a post-install check and roll back on failure                                     | P4W3 |
| OD-6 | P2W4: promotion and demotion without a restart               | A live session is promoted or demoted in place, with a toast; a restart only when the row cannot carry the change                                                    | Keep today's restart on every promote and demote                                                       | P2W4 |

Further default-on gates that wave specs call "operator confirmation points" follow ARB-6d and
are recorded in the master plan with the same weight: the flip of each family to `active`, the
`plan` switch (P4W4), the `recap` switch (P4W5), the `message` family's bypass concession (P2W3)
and raising the minimum CLI (P5W1).

## 14. Existing-code findings

Found while reading the code for the specs. **T389 does not fix them outside a wave's own
scope.** Each is an open question owned by a wave, with a live-verify acceptance criterion that
records what the code does today.

| #   | Finding                                                                                                                                                                                                                                                     | Where                       | Owner wave and AC                                                              |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------ |
| F1  | `StopFailure` body fields: the bridge reads `error_type` and `resets_at`; the CLI 2.1.287 types define `{ error, error_details?, last_assistant_message? }` (types L11385). Either the HTTP hook body differs, or the failure badge already reads `unknown` | `hook-bridge.ts:149-155`    | P1W5: a live-verify AC that records a real `StopFailure` body (Q29)            |
| F2  | Promote-by-restart may be ineffective: a `--resume` with a changed `--append-system-prompt` may not take effect under the prompt snapshot (smoke C3)                                                                                                        | `sessions.ts:1841-1858`     | P2W4: a live-verify AC on recipe LV-P2W4-c                                     |
| F3  | `/clear` leaves a second row today: nothing re-keys the live row, the new transcript surfaces beside it and the PTY index keeps the old id                                                                                                                  | `sessions.ts:5036-5044`     | P1W3: a live-verify AC on recipe LV-P1W3-c, run with the mode `off`            |
| F4  | `messaging.ts` passes the recipient's key as `fromSession`, so the legacy envelope's `from-session` names the recipient                                                                                                                                     | `messaging.ts:195`          | P2W5: an open question and a live-verify AC that records the envelope          |
| F5  | `removeGuardHookRegistration` has no caller, and Harnu keeps no record of the folders it registered the guard in                                                                                                                                            | `orchestrator-guard.ts:356` | P5W1: an open question and a live-verify AC (step G1 is where it gets callers) |

Other stale items the authors noted, outside the epic's edits: `docs/hook-bridge-integration.md`
(product name, identity, removal on exit; P5W1 rewrites it), and
`docs/specs/T202-hook-subscription-widening.md` (it cites 13 `EVENT_SPECS` entries; the tree has 9).

## 15. User-facing naming

The T245 review companion already uses the word "companion" in the UI. To keep the two apart:

| Where                                                                                                                                                                                                                                  | Name                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every user-visible string: UI labels, toasts, hints, the text the mod prints in the terminal, `CHANGELOG.md` entries, `docs/user/**`, the copy in `design.md`, the paragraphs of `docs/harnu-features.md`                              | **Harnu mod** ("Harnu mod: live", "Harnu mod: legacy — {reason}", "Harnu mod: off", "Harnu mod unloaded"). Never "companion".                                   |
| i18n keys for strings about the mod itself (its state, switch, disclosure, reasons, channel test, surface, outside install, recap, context, warnings)                                                                                  | namespace **`harnuMod.*`**, in `en.json` and `pt-BR.json`                                                                                                       |
| i18n keys that extend an existing surface (`approvalInbox.*`, `orchestrator.*`, `modsAudit.*`, `hibernationPolicy.*`, `mcpServer.*`, `settings.hooks.*`)                                                                               | stay in that surface's namespace; the string still says "Harnu mod"                                                                                             |
| The slash command                                                                                                                                                                                                                      | **`/harnu-link`**, with the subcommands `status` and `open`. `/harnu status` is one character from the bundled skill `/harnu:status`, which spends a model turn |
| Internal identifiers: the plugin name `harnu-companion`, `resources/companion/`, `src/main/companion/`, `companion-prefs.json`, IPC channels `companion:*`, type and function names, DOM ids, test names, and the specs, plans and ADR | keep "companion"                                                                                                                                                |
| Lines the engine draws with the plugin name ("Prompt from the harnu-companion plugin", "denied by plugin harnu-companion")                                                                                                             | cannot be changed; the user docs say that `harnu-companion` is the Harnu mod                                                                                    |
