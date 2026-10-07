# T389 P2 — Actuator: implementation plan

**Waves:** P2W1, P2W2, P2W3, P2W4, P2W5 (core plus two per-verb slices) · **Master plan:** [`00-master-plan.md`](00-master-plan.md) · **Specs:** `docs/specs/T389-companion-mod/P2W*.md`

**Gate K applies** (master plan §10): P2W1 may be built and its PR opened in batch B3 (decision OD-K), but no P2 wave merges, and P2W2 onward does not start, until the end-of-P1 kill-criteria review passes. Every command goes through the origin gate of P2W1 (SEC-5); no wave here adds an operator-facing "abort" or "compact" control.

Spec defects found while planning that affect these waves are listed at the end of the section they touch, and again in the hand-back. Common definition of done and executor hygiene: master plan §9.

---

## P2W1 — Command channel

| Field  | Value                                                                                                       |
| ------ | ----------------------------------------------------------------------------------------------------------- |
| Branch | `feat/t389-p2w1-command-channel`                                                                            |
| Base   | `feat/t389-p1w4-arbitration-rollout`; **join:** rebase onto `feat/t389-p1w5-fleet-state` before P2W2 starts |
| Spec   | `docs/specs/T389-companion-mod/P2W1-command-channel.md` · contract §5.3, §9, §11.5                          |
| Size   | L: 40 ACs (8 mod-test, 6 live-verify, 1 human)                                                              |
| Labels | none (CHANGELOG `Added`)                                                                                    |

**Files.** Host under `src/main/companion/`: `command-queue-core.ts`, `command-gate-core.ts`, `command-channel.ts`; extend `audit-core.ts` (`command` record) and `companion-ipc.ts` (`companion:diagnostics:ping`, a debug-only enqueue route off unless `HARNU_COMPANION_DEBUG`). Move `resolveArmTarget` (`src/main/mcp/tool-handlers.ts:2208`) unchanged to new `src/main/mcp/target-scope.ts` as `resolveAgentTarget`; the gate and both `orchestrator_*` handlers import it. Mod: `hooks/register.ts` (poll loop, `runCommand`, `registerCommandHandler`), `hooks/lib/command-core.ts`, `types/index.d.ts` (`channel` state key), `api-surface.json` (adds `$.turn.abort`, `$.session.compact`, `$.ui.toast`, `$.ui.status`, `$.clock.sleep` and the `turn.start` hook). Renderer: `SystemMonitorRow.vue` (the "Test Harnu mod channel" action), `design.md` §6, four keys in both locales.

**Steps**

| #   | Commit group          | Tests first (file → ACs)                                                                                                                                  | Then                                                                                                                                                                                                          |
| --- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | target-scope refactor | existing `tests/mcp-orchestrator-arm-handler.test.ts` passes unmodified                                                                                   | extract `resolveAgentTarget` (behaviour-neutral commit)                                                                                                                                                       |
| 2   | queue and gate (pure) | `tests/companion/command-queue-core.test.ts` → AC-P2W1-1, -2, -3, -4, -5, -35; `command-gate-core.test.ts` → AC-P2W1-6, -7, -33, -40                      | `command-queue-core.ts`, `command-gate-core.ts` (matrix, `registerGateRow`, argument validation)                                                                                                              |
| 3   | audit rows            | `tests/companion/audit-core.test.ts` → AC-P2W1-14; `command-channel.test.ts` → AC-P2W1-13 (no audit, no command)                                          | `command` record, audit before queue write                                                                                                                                                                    |
| 4   | channel shell         | `command-channel.contract.test.ts` → AC-P2W1-8, -9, -10, -11, -12, -36; `command-channel.test.ts` → AC-P2W1-29, -30, -32, -34                             | `command-channel.ts`: `setPollHandler`, `setCommandSource`, `hold`, lease and rebound hooks; `registerFeaturePolicy` rows (`act.channel`, `act.turn`, `act.compact`, `act.ui`); `registerPrefsKey('channel')` |
| 5   | mod loop and commands | `resources/companion/tests/channel.test.ts` → AC-P2W1-15, -16, -17, -18, -19, -20, -21, -37                                                               | poll loop (generation counter), executor, six commands, `api-surface.json`                                                                                                                                    |
| 6   | debug route and ping  | `tests/companion/companion-ipc.test.ts` → AC-P2W1-28                                                                                                      | IPC additions                                                                                                                                                                                                 |
| 7   | L4                    | `tests/cli/channel.cli.test.ts` → AC-P2W1-22, -23                                                                                                         | none                                                                                                                                                                                                          |
| 8   | UI (design first)     | human AC-P2W1-31: screenshot `docs/specs/T389-companion-mod/evidence/P2W1-ping.png`                                                                       | `design.md` §6 System Monitor, keys, the action in the Harnu mod cell                                                                                                                                         |
| 9   | live-verify and docs  | LV-P2W1-a (AC-27, survival over `/clear`), -b (AC-24, five sessions polling 30 min, CQ7), -c (AC-25, -26, -38, -39, abort and compact), -d (host restart) | CHANGELOG, `docs/user/{system-monitor,troubleshooting}.md`                                                                                                                                                    |

**Pipeline.** `scripts/ci/local-pipeline.sh --base feat/t389-p1w4-arbitration-rollout --with-cli --with-e2e --json /tmp/p2w1.json`; re-run with `--base feat/t389-p1w5-fleet-state` after the join rebase.

**Rollout.** `channel` key default `shadow`: the poll loop runs and only the observe-only set (`flush`, `config.update`, `guard.set {enforce:false}`, `sentinel.set`, `ui.band.set`) is admitted. Ledger records poll hold outcomes and `flush` latencies for the flip gate (master plan §7).

**Boot packet**

```text
Objective: build the command channel (spec P2W1): the poll endpoint, a per-binding command queue with TTL and results, the server-side origin gate, the Harnu-side command audit record, the mod's poll loop and executor, and six commands (flush, config.update, turn.abort, session.compact, ui.toast, ui.status). Interactive sessions only. No MCP verb enqueues a command in this wave.
Setup: new worktree from feat/t389-p1w4-arbitration-rollout, branch feat/t389-p2w1-command-channel; npm ci. Rebase onto feat/t389-p1w5-fleet-state when it exists. This PR may open before the kill-criteria review but is not merged until it passes.
Read first: docs/specs/T389-companion-mod/P2W1-command-channel.md; 01-contract.md 5.3, 9, 11.5; design.md section 6 (System Monitor); plan P2-actuator.md (P2W1); master plan section 9.
May touch: src/main/companion/{command-*,audit-core,companion-ipc}.ts, src/main/mcp/{tool-handlers,target-scope}.ts (extraction only), resources/companion/hooks/**, resources/companion/tests/**, SystemMonitorRow.vue, design.md, en.json, pt-BR.json, docs/user/{system-monitor,troubleshooting}.md, CHANGELOG.md, tests/**, docs/specs/T389-companion-mod/evidence/**.
Satisfy: AC-P2W1-1 to -40 (-31 is human); recipes LV-P2W1-a to -d.
Skills: /local-ci, plugin-authoring, superpowers:test-driven-development (if available; otherwise follow test-first as listed).
Out of scope: prompt.submit, message.deliver, context.append, guard.set, sentinel.set, ui.band.set, plan.capture, context.drop, any MCP verb, operator abort or compact buttons.
Return: pipeline JSON (cli and e2e), AC table, recipe logs, screenshot, rev-list count, Spec defects.
Autonomy: decide within the spec, do not ask, commit each plan step before reporting.
```

---

## P2W2 — Start-prompt delivery

| Field  | Value                                                                                       |
| ------ | ------------------------------------------------------------------------------------------- |
| Branch | `feat/t389-p2w2-start-prompt`                                                               |
| Base   | `feat/t389-p2w1-command-channel` (with P1W5 below it)                                       |
| Spec   | `docs/specs/T389-companion-mod/P2W2-start-prompt.md` · contract §9 (`prompt.submit`), §11.4 |
| Size   | L: 32 ACs (5 mod-test, 7 live-verify)                                                       |
| Labels | `no-changelog` until the flip (the `Fixed` entry lands with it); user docs still land here  |

**Files.** Host: `src/main/companion/start-prompt-claim-core.ts`, `start-prompt-claims.ts`; `src/main/pty.ts` (`CreateOpts.startPrompt`, `startPromptClaims.register(owner, plan)` beside `plan.mintToken(owner)`); `src/main/claude-reader-derive.ts` (`classifyUserRow`, `stripPluginFrame`); readers `transcript-truth.ts`, `claude-reader.ts` (queue-operation rows are not turns). Preload `startPromptClaimLegacy`, `onStartPromptState`. Renderer: `TerminalPane.vue` (the gate asks main before pasting), `stores/injection-ledger.ts` (events `companion-claimed`, `companion-delivered`, `companion-released`). Mod: `register.ts` (`prompt.submit` handler, `noteOwnSubmit`), `hooks/lib/prompt-core.ts`, `api-surface.json` (adds `$.prompt.submit`, `$.command.run`, `$.command.list`).

**Steps**

| #   | Commit group               | Tests first (file → ACs)                                                                                                                                | Then                                                                                                                                   |
| --- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | row classifier and readers | `tests/claude-reader-derive.test.ts` → AC-P2W2-15; `tests/transcript-truth.test.ts` → AC-P2W2-16; `tests/claude-reader.test.ts` → AC-P2W2-17            | `classifyUserRow`, `stripPluginFrame`, reader changes (`plugin-meta` never starts a turn)                                              |
| 2   | claim core                 | `start-prompt-claim-core.test.ts` → AC-P2W2-1, -2, -3, -4, -5, -6, -7, -27, -29, -30, -31, -32                                                          | `start-prompt-claim-core.ts` (state machine, eligibility, `asUser` from trust class; `unknown` and `lost` results are never a release) |
| 3   | claim table and gate       | `start-prompt-claims.test.ts` → AC-P2W2-8, -9, -28                                                                                                      | `start-prompt-claims.ts`, `pty.ts` registration, `beforeHello` enqueue, audit                                                          |
| 4   | mod handler                | `resources/companion/tests/prompt.test.ts` → AC-P2W2-10, -11, -12, -13, -14                                                                             | `prompt-core.ts`, handler, shared `prompt.submit` registration step 3, `noteOwnSubmit`                                                 |
| 5   | renderer and preload       | covered by steps 3 and 6                                                                                                                                | `TerminalPane.vue`, `injection-ledger.ts`, preload                                                                                     |
| 6   | L4                         | `tests/cli/start-prompt.cli.test.ts` → AC-P2W2-18, -19                                                                                                  | CQ15 answer to the smoke addendum                                                                                                      |
| 7   | live-verify and docs       | LV-P2W2-a (AC-20, -21: operator card dispatch and an agent spawn with a 26 000-character prompt), -b (AC-22, -23), -c (AC-24, Q1), -d (AC-25, -26, Q15) | `docs/user/{sessions,troubleshooting}.md`, smoke addendum                                                                              |

**Pipeline.** `scripts/ci/local-pipeline.sh --base feat/t389-p2w1-command-channel --with-cli --with-e2e --labels no-changelog --json /tmp/p2w2.json`.

**Rollout.** `startPrompt` `shadow`: no claim registered; the ledger records one row per paste-path spawn.

**Boot packet**

```text
Objective: deliver long start prompts through the Harnu mod (spec P2W2): a one-shot claim in main keyed by the spawn owner, delivered as a prompt.submit command in the hello response, with the legacy paste gate asking main first. Idempotent across hot reload. Only prompts over 24 000 characters take the paste path today; argv stays the default and @file prompts stay legacy (D9).
Setup: new worktree from feat/t389-p2w1-command-channel, branch feat/t389-p2w2-start-prompt; npm ci. P1W5 must be below P2W1.
Read first: docs/specs/T389-companion-mod/P2W2-start-prompt.md; 01-contract.md 9 and 11.4; plan P2-actuator.md (P2W2); master plan section 9.
May touch: src/main/companion/start-prompt-claim*.ts, src/main/pty.ts, src/main/claude-reader-derive.ts, claude-reader.ts, transcript-truth.ts, src/preload/index.ts, TerminalPane.vue, stores/injection-ledger.ts, resources/companion/hooks/**, resources/companion/tests/**, tests/**, docs/user/{sessions,troubleshooting}.md.
Satisfy: AC-P2W2-1 to -32; recipes LV-P2W2-a to -d.
Skills: /local-ci, plugin-authoring, superpowers:test-driven-development (if available; otherwise follow test-first as listed).
Out of scope: the argv path or its budget, @file inlining, prompts into a running session, deleting the gate, submitter or watchdog, any create_session ACK change.
Return: pipeline JSON (cli and e2e), AC table, recipe logs with claude --version, rev-list count, Spec defects.
Autonomy: decide within the spec, do not ask, commit each plan step before reporting.
```

---

## P2W5 — MCP caller attribution (core plus two per-verb slices)

| Slice   | Branch                                   | Base                                                                                                           | Scope                                                                                                                         | ACs                                                     |
| ------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| core    | `feat/t389-p2w5-mcp-attribution`         | start `feat/t389-p1w5-fleet-state`; **join:** rebase onto `feat/t389-p2w2-start-prompt` once P2W2's PR is open | stamp hook, border strip, resolution, `observe`/`prefer`, verbs `notify`, `speak`, `mission_*`; Control server audit fragment | AC-P2W5-1 to -12, -14 to -21, -23 to -25; LV-P2W5-a, -b |
| arm     | `feat/t389-p2w5-mcp-attribution-arm`     | `feat/t389-p2w4-live-context-guard`                                                                            | `orchestrator_arm` and `orchestrator_disarm` accept an omitted `sessionId`; ACK `caller`                                      | AC-P2W5-13                                              |
| message | `feat/t389-p2w5-mcp-attribution-message` | `feat/t389-p2w3-messaging`                                                                                     | `message_session` sender attribution, `SELF_MESSAGE`; run LV-P2W5-c **first**                                                 | AC-P2W5-22                                              |

Spec: `docs/specs/T389-companion-mod/P2W5-mcp-attribution.md` · contract §16.1, §24. Size: M (25 ACs, three PRs). The per-verb split above is this plan's reading of spec §7.4 (the spec names the two stacked slices but assigns no AC ids). Agent-facing: **yes**; the awareness and user-docs gates fire on `tool-catalog.ts`.

**Files (core).** Mod: `register.ts` (`tool.call` with the single RegExp matcher `/^mcp__(harnu|capy)__/`), `hooks/stamp-core.ts`, `types/index.d.ts`, `api-surface.json`. Host: `src/main/companion/stamp-resolver.ts`, `src/main/mcp/caller-stamp-core.ts` (`liftCallerStamp`, forged-meta drop), `src/main/mcp/server.ts` (border), `src/main/mcp/tool-handlers.ts` (`HandlerCtx.caller`, `resolveCaller`), `src/main/mcp/audit-log.ts`, `src/main/mcp/tool-catalog.ts` (`sessionId` optional on `mission_create`, `mission_verify_step`; description text), `McpServerPane.vue` (three `mcpServer.audit.*` keys), `docs/harnu-features.md` + marker, `docs/user/agent-control.md`, `design.md` §6, ADR-0013 addendum line.

**Steps (core)**

| #   | Commit group          | Tests first (file → ACs)                                                                                                                   | Then                                                                                                                                        |
| --- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | mod stamp             | `resources/companion/tests/stamp.test.ts` → AC-P2W5-1, -2, -3, -4, -5, -6                                                                  | `stamp-core.ts`, the hook; no stamp in `auto` mode; suspend after a refused rewrite                                                         |
| 2   | border and resolution | `tests/mcp-caller-stamp-core.test.ts` → AC-P2W5-8, -16; `tests/companion/stamp-resolver.test.ts` → AC-P2W5-9, -10, -11, -17, -20, -23, -24 | `caller-stamp-core.ts`, `stamp-resolver.ts` (`verifyStamp`, nonce ring), `registerPrefsKey('stamp', {default:'off', observeCap:'observe'})` |
| 3   | per-verb use          | `tests/mcp-mission-verify-attribution.test.ts` → AC-P2W5-12; `tests/mcp-caller-never-widens.test.ts` → AC-P2W5-14                          | handlers for `notify`, `speak`, `mission_*`; ACK `caller`; catalog text                                                                     |
| 4   | static and L4         | `tests/companion/api-surface.test.ts` → AC-P2W5-19; `tests/cli/stamp.cli.test.ts` → AC-P2W5-15, -18, -21                                   | none                                                                                                                                        |
| 5   | live and docs         | LV-P2W5-a (AC-25, CQ16, OQ4), LV-P2W5-b (AC-7, `auto` mode)                                                                                | `harnu-features.md` (run `/harnu-awareness`, bump the marker), user docs, `design.md`, keys, CHANGELOG                                      |

**Slices.** `arm`: test `tests/mcp-orchestrator-arm-handler.test.ts` → AC-P2W5-13 ("self-targeting keeps the target checks"), then the handler and catalog edit; both edit "Arming the guard live" in `harnu-features.md`, so P2W4 lands first. `message`: run LV-P2W5-c with the Harnu mod off before touching the sender (AC-P2W5-22, finding F4), then attribute the sender, add `SELF_MESSAGE`, and extend P2W3's `message_session` ACK text.

**Rollout.** `stamp` key ships `off`; flips to `observe` after LV-P2W5-b and AC-P2W5-21 pass on the tested CLI; `prefer` after the ledger gate (master plan §7).

**Pipeline.** core: `--base feat/t389-p2w2-start-prompt --with-cli --with-e2e`; arm: `--base feat/t389-p2w4-live-context-guard --with-cli`; message: `--base feat/t389-p2w3-messaging --with-cli`.

**Boot packet (core)**

```text
Objective: attribute Harnu MCP calls to the calling session (spec P2W5 core). A tool.call hook with a single RegExp matcher /^mcp__(harnu|capy)__/ (capy = legacy server-name alias) stamps a digest-based proof; the MCP border strips it; the host resolves it to the session and records it. Attribution, not authentication: target-side checks stay (SEC-9g, ADR-0013) and nothing a verb refuses today becomes allowed. No stamp in auto permission mode.
Setup: new worktree from feat/t389-p1w5-fleet-state, branch feat/t389-p2w5-mcp-attribution; npm ci; rebase onto feat/t389-p2w2-start-prompt when its PR is open. Do not merge: the operator merges after the kill-criteria review.
Read first: docs/specs/T389-companion-mod/P2W5-mcp-attribution.md; 01-contract.md 16.1 and 24; ADR-0013; plan P2-actuator.md (P2W5); master plan section 9.
May touch: resources/companion/hooks/**, resources/companion/tests/**, src/main/companion/stamp-resolver.ts, src/main/mcp/{caller-stamp-core,server,tool-handlers,audit-log,tool-catalog}.ts, McpServerPane.vue, design.md, en.json, pt-BR.json, docs/harnu-features.md, docs/user/agent-control.md, docs/adr/0013-*.md (one addendum line), CHANGELOG.md, tests/**.
Satisfy: AC-P2W5-1 to -12, -14 to -21, -23 to -25; recipes LV-P2W5-a and -b. (-13 and -22 are the stacked slices.)
Skills: /local-ci, /harnu-awareness, plugin-authoring, superpowers:test-driven-development (if available; otherwise follow test-first as listed).
Out of scope: authentication, Harnu MCP for agent-controlled spawns, headless or external stamping, any caller-based refusal except SELF_MESSAGE in the message slice.
Return: pipeline JSON (cli and e2e), AC table, recipe logs, rev-list count, Spec defects.
Autonomy: decide within the spec, do not ask, commit each plan step before reporting.
```

**Boot packet (arm slice)**

```text
Objective: P2W5 arm slice (spec P2W5 7.4): orchestrator_arm and orchestrator_disarm accept an omitted sessionId meaning the attributed caller; the ACK gains caller; resolveArmTarget (now target-scope.ts) still runs on the result, so an operator-owned caller is still TARGET_OPERATOR_OWNED. Attribution is not authority.
Setup: new worktree from feat/t389-p2w4-live-context-guard (P2W5 core below it), branch feat/t389-p2w5-mcp-attribution-arm; npm ci.
Read first: docs/specs/T389-companion-mod/P2W5-mcp-attribution.md 7.4; P2W4 spec 7.1 (the ACK); plan P2-actuator.md (P2W5); master plan section 9; run /harnu-awareness (both slices edit "Arming the guard live" in docs/harnu-features.md; bump the marker).
May touch: src/main/mcp/{tool-handlers,tool-catalog}.ts, tests/mcp-orchestrator-arm-handler.test.ts, docs/harnu-features.md, docs/user/agent-control.md, CHANGELOG.md.
Satisfy: AC-P2W5-13.
Skills: /local-ci, /harnu-awareness, superpowers:test-driven-development (if available; otherwise follow test-first as listed).
Out of scope: any other verb, any caller-based refusal.
Return: pipeline JSON, AC table, rev-list count, Spec defects.
Autonomy: decide within the spec, do not ask, commit before reporting.
```

**Boot packet (message slice)**

```text
Objective: P2W5 message slice (spec P2W5 7.4): attribute the sender of message_session when a verified stamp exists, hand it to P2W3's broker as from, and refuse a self-message with SELF_MESSAGE when Harnu can tell. Recipient predicates are unchanged. First run LV-P2W5-c with the Harnu mod off to record finding F4 (the legacy envelope names the recipient as from-session) before changing the sender.
Setup: new worktree from feat/t389-p2w3-messaging (P2W5 core below it), branch feat/t389-p2w5-mcp-attribution-message; npm ci.
Read first: docs/specs/T389-companion-mod/P2W5-mcp-attribution.md 7.4 and OQ6; P2W3 spec 7.2; plan P2-actuator.md (P2W5); master plan section 9; run /harnu-awareness.
May touch: src/main/mcp/{tool-handlers,tool-catalog}.ts, src/main/companion/message-broker.ts, messaging.ts (only the F4 value on the companion transport), docs/harnu-features.md, docs/user/agent-control.md, CHANGELOG.md, tests/**.
Satisfy: AC-P2W5-22 (recipe LV-P2W5-c); the SELF_MESSAGE behaviour with tests first.
Skills: /local-ci, /harnu-awareness, superpowers:test-driven-development (if available; otherwise follow test-first as listed).
Out of scope: widening who can be messaged, any other verb.
Return: pipeline JSON, AC table, LV-P2W5-c log, rev-list count, Spec defects.
Autonomy: decide within the spec, do not ask, commit before reporting.
```

---

## P2W3 — Messaging broker and native SendMessage audit

| Field  | Value                                                                                      |
| ------ | ------------------------------------------------------------------------------------------ |
| Branch | `feat/t389-p2w3-messaging`                                                                 |
| Base   | `feat/t389-p2w2-start-prompt` (then P2W5 core rebased under it)                            |
| Spec   | `docs/specs/T389-companion-mod/P2W3-messaging.md` · contract §9 (`message.deliver`), §11.6 |
| Size   | L: 36 ACs (5 mod-test, 8 live-verify)                                                      |
| Labels | none (CHANGELOG `Changed` and `Added`; agent-facing)                                       |

**Files.** Host: `src/main/companion/{message-broker-core,message-broker,bridge-standdown-core}.ts`, `ingest/message-audit-adapter.ts`; edit `src/main/mcp/tool-handlers.ts` (step 6 of the message handler calls the broker; ACK gains `transport`, `woke`, `DELIVERY_UNCONFIRMED`), `src/main/messaging-socket.ts` (`messageAuditSummary` takes `transport` and `pid`), `src/main/pty.ts` (`sessionKeyForPid`), `src/main/hook-bridge.ts` and `responder-dispatch.ts` (`standDown` option, `Resolver.parks`), `src/main/approval-resolver.ts` (`parks = true`), `src/main/claude-reader-derive.ts` (`<harnu-peer-message>` frame; implements the `harnu-peer` branch). Mod: `register.ts` (`message.deliver` handler; hooks `session.send`, `session.receive`), `contract.ts` (`framePeerMessage()`), `api-surface.json`. Agent-facing text: `src/main/mcp/tool-catalog.ts` description, `docs/harnu-features.md` (paragraphs near lines 288 to 308; bump the marker), `docs/user/{agent-control,approval-inbox}.md`, the T215 spec status line.

**Steps**

| #   | Commit group                | Tests first (file → ACs)                                                                                                                                                                             | Then                                                                                                                                |
| --- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 1   | broker core and shell       | `tests/companion/message-broker-core.test.ts` → AC-P2W3-1, -2; `message-broker.test.ts` → AC-P2W3-3, -4, -6, -7, -31, -32                                                                            | pure `chooseTransport` and `afterCompanionOutcome`; `brokerMessage()`; `sessionKeyForPid`                                           |
| 2   | stand-down                  | `tests/companion/bridge-standdown-core.test.ts` → AC-P2W3-36; `tests/hook-bridge.test.ts` → AC-P2W3-18, -19, -35                                                                                     | `shouldStandDown`, the `standDown` option, `Resolver.parks`, `approval-resolver.ts`                                                 |
| 3   | handler, ACK, audit summary | message-handler cases in the new `tests/mcp-message-session.test.ts` → AC-P2W3-5, -8, -30, -33 (no existing test covers the `message_session` handler); `tests/messaging-socket.test.ts` → AC-P2W3-9 | handler step 6, ACK fields, `messageAuditSummary`                                                                                   |
| 4   | mod                         | `resources/companion/tests/message.test.ts` → AC-P2W3-10, -11, -13, -14, -15; fixture `message-frame.ts` → AC-P2W3-12 (contract, replayed by both sides)                                             | `message.deliver` handler (never `asUser`, bypass-parity refusal), `session.send` and `session.receive` hooks, `framePeerMessage()` |
| 5   | audit adapter and reader    | `message-audit-adapter.test.ts` → AC-P2W3-16, -17, -34; `tests/claude-reader-derive.test.ts` → AC-P2W3-20                                                                                            | `message-audit-adapter.ts`, `harnu-peer` branch                                                                                     |
| 6   | L4                          | `tests/cli/messaging.cli.test.ts` → AC-P2W3-21                                                                                                                                                       | none                                                                                                                                |
| 7   | live-verify and docs        | LV-P2W3-a (AC-22, -23), -b (AC-24), -c (AC-25, -26, Q16), -d (AC-27, -28), -e (AC-29, bridge tax)                                                                                                    | `harnu-features.md` + marker (`/harnu-awareness`), catalog text, user docs, T215 status line, CHANGELOG                             |

**Rollout.** `message` `shadow`: the socket delivers every message; `sense.message` reports in any family mode that is not `off`. Flip waits for AC-P2W3-25 and -26 and the operator's signature on the bypass concession.

**Pipeline.** `scripts/ci/local-pipeline.sh --base feat/t389-p2w2-start-prompt --with-cli --json /tmp/p2w3.json` (awareness and user-docs gates fire on `tool-catalog.ts`). After P2W5 core is rebased under the branch, use `--base feat/t389-p2w5-mcp-attribution` and open the PR against it.

**Boot packet**

```text
Objective: a messaging broker (spec P2W3): one transport per message_session send, message.deliver for a leased recipient and the legacy socket otherwise, wake-then-send for parked sessions, the recipient's mod submitting a framed non-asUser prompt, bypass-parity refusal, native SendMessage audit (session.send, session.receive), and the bridge stand-down option used for SendMessage when the message family is active.
Setup: new worktree from feat/t389-p2w2-start-prompt, branch feat/t389-p2w3-messaging; npm ci; rebase P2W5 core under it when ready.
Read first: docs/specs/T389-companion-mod/P2W3-messaging.md; 01-contract.md 9 and 11.6; plan P2-actuator.md (P2W3); master plan section 9; run /harnu-awareness before editing docs/harnu-features.md.
May touch: src/main/companion/{message-broker*,bridge-standdown-core}.ts, ingest/message-audit-adapter.ts, src/main/mcp/{tool-handlers,tool-catalog}.ts, messaging-socket.ts, pty.ts, hook-bridge.ts, responder-dispatch.ts, approval-resolver.ts, claude-reader-derive.ts, resources/companion/**, tests/**, docs/harnu-features.md, docs/user/{agent-control,approval-inbox}.md, the T215 spec status line, CHANGELOG.md.
Satisfy: AC-P2W3-1 to -36; recipes LV-P2W3-a to -e.
Skills: /local-ci, /harnu-awareness, plugin-authoring, superpowers:test-driven-development (if available; otherwise follow test-first as listed).
Out of scope: widening who can be messaged, receipts, $.session.send from the mod, remote or cloud recipients, blocking native SendMessage, deleting messaging-socket.ts.
Return: pipeline JSON, AC table, recipe logs with claude --version, rev-list count, Spec defects.
Autonomy: decide within the spec, do not ask, commit each plan step before reporting.
```

---

## P2W4 — Live orchestrator contract and in-process guard

| Field  | Value                                                                                                                  |
| ------ | ---------------------------------------------------------------------------------------------------------------------- |
| Branch | `feat/t389-p2w4-live-context-guard`                                                                                    |
| Base   | `feat/t389-p2w2-start-prompt` (then P2W5 core rebased under it)                                                        |
| Spec   | `docs/specs/T389-companion-mod/P2W4-live-contract-and-guard.md` · contract §4, §9 (`context.append`, `guard.set`), §23 |
| Size   | L: 32 ACs (13 mod-test, 3 live-verify, 1 human)                                                                        |
| Labels | none (CHANGELOG `Changed` and `Fixed`; agent-facing)                                                                   |

**Files.** Host under `src/main/companion/`: `context-registry.ts` (`ContextDoc`, `frameContext`; the closed set, text never caller-supplied), `context-injector.ts` (`deliver`; the only issuer of `context.append` and `context.drop`), `guard-adapter.ts` (`setOrchestratorRole`, `ArmResult`), `guard-parity-core.ts`. Edit `src/main/orchestrator-guard.ts` (`ArmedEntry.enforcer`), `resources/orchestrator-guard/guard.mjs` (ignore entries enforced by the companion), `src/main/mcp/tool-handlers.ts` and `tool-catalog.ts` (`orchestrator_arm` ACK gains `enforcer` and `contract`), `src/renderer/src/stores/sessions.ts` (`:1841-1858`: promote and demote restart only when the row cannot carry the change), `src/main/claude-reader-derive.ts`. Mod: `register.ts` (`context.append`, `guard.set`, the `tool.call` guard on `Edit|Write|NotebookEdit`, the deferred re-injection on `classic.SessionStart {source: compact}`), `hooks/lib/guard-core.ts`, `types/index.d.ts` (`guard`, `durableRows`, `reinject`), `coords.gen.ts` exports (exempt roots baked, SEC-4). Docs: `harnu-features.md` ("Arming the guard live") + marker, `docs/user/{agent-control,sessions}.md`, `design.md` §6, `orchestrator.promotedLive` and `orchestrator.demotedLive` in both locales.

**Steps**

| #   | Commit group             | Tests first (file → ACs)                                                                                                                                                                                                           | Then                                                                                                                       |
| --- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1   | registry and injector    | `tests/companion/context-registry.test.ts` → AC-P2W4-1; `context-injector.test.ts` → AC-P2W4-5; `tests/claude-reader-derive.test.ts` → AC-P2W4-27                                                                                  | `context-registry.ts`, `context-injector.ts`, reader classification of context rows                                        |
| 2   | mod context              | `resources/companion/tests/context.test.ts` → AC-P2W4-2, -6, -7, -30                                                                                                                                                               | `context.append` handler, hidden user-role row, deferred re-injection, `durableRows`                                       |
| 3   | mod guard                | `resources/companion/tests/guard.test.ts` → AC-P2W4-8, -9, -10, -11, -12, -13, -14, -15, -31                                                                                                                                       | `guard-core.ts` (`realPath`, exempt roots, subagent exemption, fail open on internal error), `tool.call` hook, `guard.set` |
| 4   | guard adapter and script | `tests/companion/guard-adapter.test.ts` → AC-P2W4-18, -19, -20, -25, -29, -32; `tests/orchestrator-guard-script.test.ts` → AC-P2W4-17; `guard-parity.test.ts` → AC-P2W4-21 (corpus under `tests/fixtures/companion-parity/guard/`) | `guard-adapter.ts`, `guard-parity-core.ts`, `enforcer` field, `guard.mjs` change, boot reset                               |
| 5   | verbs and static         | `tests/mcp-orchestrator-arm-handler.test.ts` → AC-P2W4-23; `tests/companion/api-surface.test.ts` → AC-P2W4-22                                                                                                                      | handler and catalog ACK fields                                                                                             |
| 6   | L4                       | `tests/cli/live-contract.cli.test.ts` → AC-P2W4-3, -24                                                                                                                                                                             | none                                                                                                                       |
| 7   | UI strings               | human AC-P2W4-26 (screenshot of the toast)                                                                                                                                                                                         | `design.md` §6 first, keys, conditional restart in `sessions.ts`                                                           |
| 8   | live-verify and docs     | LV-P2W4-a (AC-4, mid tool loop), -b (AC-16, live toggle), -c (AC-28, F2: promote by restart with the mod off, record whether it takes effect)                                                                                      | `harnu-features.md` + marker (`/harnu-awareness`), user docs, CHANGELOG                                                    |

**Rollout.** `guard` `shadow`: `guard.set {enforce:false}`, `guard.evaluated` rows in the ledger, `guard.mjs` authoritative. The `context` key is on by default and acts only with `channel` `active`; OD-6 (in-place promotion) ships once LV-P2W4-a passes.

**Pipeline.** `scripts/ci/local-pipeline.sh --base feat/t389-p2w2-start-prompt --with-cli --with-e2e --json /tmp/p2w4.json`. After P2W5 core is rebased under the branch, use `--base feat/t389-p2w5-mcp-attribution` and open the PR against it.

**Boot packet**

```text
Objective: live orchestrator contract and the in-process guard (spec P2W4): context.append from a host-owned registry so promote and demote need no restart when the Harnu mod is live; the tool.call guard on Edit, Write and NotebookEdit (subagents exempt, exempt surfaces checked by realPath, armed by guard.set); armed.json keeps the role record and gains enforcer 'script' | 'companion'.
Setup: new worktree from feat/t389-p2w2-start-prompt, branch feat/t389-p2w4-live-context-guard; npm ci.
Read first: docs/specs/T389-companion-mod/P2W4-live-contract-and-guard.md; 01-contract.md 4, 9, 23; design.md section 6 (orchestrator role); plan P2-actuator.md (P2W4); master plan section 9; run /harnu-awareness before docs/harnu-features.md.
May touch: src/main/companion/{context-*,guard-*}.ts, src/main/orchestrator-guard.ts, resources/orchestrator-guard/guard.mjs, src/main/mcp/{tool-handlers,tool-catalog}.ts, src/renderer/src/stores/sessions.ts, claude-reader-derive.ts, resources/companion/**, tests/**, tests/fixtures/companion-parity/guard/**, design.md, en.json, pt-BR.json, docs/harnu-features.md, docs/user/{agent-control,sessions}.md, CHANGELOG.md.
Satisfy: AC-P2W4-1 to -32 (-26 is human); recipes LV-P2W4-a to -c.
Skills: /local-ci, /harnu-awareness, plugin-authoring, superpowers:test-driven-development (if available; otherwise follow test-first as listed).
Out of scope: composeAppendSystemPrompt or spawn argv, free-text context.append, a guard for Bash, MultiEdit or MCP tools, uninstalling guard.mjs, the compaction digest (P4W5).
Return: pipeline JSON (cli and e2e), AC table, recipe logs, toast screenshot, rev-list count, Spec defects.
Autonomy: decide within the spec, do not ask, commit each plan step before reporting.
```

---

### Spec defects touching P2

- Fixed in the specs by the plan review (`docs/reports/T389-plan-review.md`, section "Spec fixes applied"): P2W3 now cites the new `tests/mcp-message-session.test.ts`; P2W4 and P2W5 now cite `tests/mcp-orchestrator-arm-handler.test.ts`.
- P2W5 names two stacked slices but assigns no AC ids to them; this plan maps AC-P2W5-13 to the arm slice and AC-P2W5-22 to the message slice.
