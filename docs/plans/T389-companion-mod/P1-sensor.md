# T389 P1 — Sensor: implementation plan

**Waves:** P1W1, P1W2, P1W3, P1W4, P1W5, P1W6 (three slices) · **Master plan:** [`00-master-plan.md`](00-master-plan.md) · **Specs:** `docs/specs/T389-companion-mod/P1W*.md`

Everything in P1 ships dark or in `shadow`: no wave here changes what an operator sees until a family flips (master plan §7). Each section lists the branch and base, the ordered commit groups (tests first where the AC method is unit, contract or mod-test), the files, the live-verify recipes, the docs step, the pipeline invocation and a boot packet. Common definition of done and executor hygiene: master plan §9.

Test-file shorthand in the specs is expanded here: SC, SI, VG, AS, SR, VN in P1W2 are `tests/companion/{staging-core,spawn-inject,version-gate,api-surface,sideload-retry,validate-notes}.test.ts`; W, T, S, R, H, L, C in P1W1 are `tests/companion/{wire-core,session-table,server,rendezvous,host-static,host-lifecycle,contract}.test.ts`. `tests/companion/contract.test.ts` (C) is created by P1W1 and is the one home of the cross-side fixture replays: P3W2 (AC-P3W2-29) and P4W2 (AC-P4W2-18) append cases to it and never create it.

---

## P1W1 — Host server

| Field  | Value                                                                          |
| ------ | ------------------------------------------------------------------------------ |
| Branch | `feat/t389-p1w1-host-server`                                                   |
| Base   | P0 docs tip (`docs/t389-harnu-mod-specs`, or `main` once it merges)            |
| Spec   | `docs/specs/T389-companion-mod/P1W1-host-server.md` · contract §2 to §8, §11.3 |
| Size   | L: 36 ACs (2 live-verify), ten new modules, `contract.ts`                      |
| Labels | `no-changelog` (no behaviour change: mode `off`, nothing listens)              |

**Files.** Create `resources/companion/hooks/contract.ts` (types and constants of protocol 1, zero imports), the first golden fixtures under `resources/companion/tests/fixtures/` and `tests/companion/contract.test.ts` (the host-side fixture replay that later waves extend); under `src/main/companion/`: `contract.ts` (re-export), `mode.ts`, `wire-core.ts`, `rendezvous.ts`, `session-table.ts`, `server.ts`, `host.ts`, `companion-ipc.ts`, `audit-core.ts`, `audit-log.ts`. Change `src/main/index.ts` (register and close the host), `src/preload/index.ts` (`companionDiagnostics`; a dev-only mint helper served only when `!app.isPackaged`), `tsconfig.node.json` (`include` the contract and fixtures), `vitest.config.mts` (`exclude` `host.ts` and `companion-ipc.ts` with a justification), `docs/dev/live-verify-second-instance.md` (one paragraph).

**Steps**

| #   | Commit group                | Tests first (file → ACs)                                                                                                                                                                                    | Then                                                                                                                                     |
| --- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | contract and fixtures       | none (typecheck only)                                                                                                                                                                                       | `contract.ts`, golden fixtures (`events-seq.ts` and the hello, resume, error shapes), tsconfig include                                   |
| 2   | wire core (pure)            | `wire-core.test.ts` → AC-P1W1-11, -12, -13, -18, -35; `contract.test.ts` → AC-P1W1-1 (contract half: the hello fixtures validate as `HelloResponse` through the `src/main/companion/contract.ts` re-export) | `wire-core.ts`: routes, envelope validation, negotiation, seq and dedupe, rate bucket                                                    |
| 3   | session table (pure)        | `session-table.test.ts` → AC-P1W1-7, -8, -9, -10, -14, -21, -26, -30                                                                                                                                        | `session-table.ts`: spawn-token ledger, `conn` rotation, lease clock with injected clock, sweep                                          |
| 4   | mode seam and audit log     | `mode.test.ts` → AC-P1W1-25; `audit-core.test.ts` → AC-P1W1-33                                                                                                                                              | `mode.ts` (default `off`, signatures of master §12.1), `audit-core.ts`, `audit-log.ts` (`binding` record)                                |
| 5   | rendezvous                  | `rendezvous.test.ts` → AC-P1W1-3                                                                                                                                                                            | `rendezvous.ts`: `chooseTransport`, `EndpointFile`, stale-socket probe                                                                   |
| 6   | server on a real socket     | `server.test.ts` → AC-P1W1-1, -2, -4, -5, -6, -15, -16, -17, -19, -20, -22, -27, -31, -32, -36                                                                                                              | `server.ts` (`startCompanionServer`): listener modes `0600`/`0700`, body read, dispatch, `poll` and `ask` answer `FEATURE_DISABLED`      |
| 7   | facade, bus, lifecycle, IPC | `host-static.test.ts` → AC-P1W1-23, -24; `host-lifecycle.test.ts` → AC-P1W1-34                                                                                                                              | `host.ts` (`companionHost` facade and the extension points of master §12.1), `companion-ipc.ts`, preload, `index.ts`, coverage `exclude` |
| 8   | live-verify and docs        | LV-P1W1-a → AC-P1W1-28; LV-P1W1-b → AC-P1W1-29                                                                                                                                                              | `docs/dev` paragraph; attach host log excerpts and `claude --version`                                                                    |

**Live-verify.** Run after step 7 on a build from `out/` (an unpackaged run; a `build:unpack` build refuses the dev mint). LV-P1W1-a: real CLI over the real socket, interactive and `-p`, both 200 in under 50 ms. LV-P1W1-b: whether a sibling mod sees a `socketPath` fetch (either outcome passes; record it in the smoke evidence addendum).

**Docs.** None for users. The PR states why `no-changelog` applies.

**Pipeline.** `scripts/ci/local-pipeline.sh --base docs/t389-harnu-mod-specs --labels no-changelog --json /tmp/p1w1.json`. No `--with-cli` (no CLI-dependent suite).

**Boot packet**

```text
Objective: build the T389 host server in Harnu main (spec P1W1): Unix-socket HTTP server, rendezvous file, wire validation, binding table with lease, audit log, contract.ts and golden fixtures. Nothing listens in a default install (mode off).
Setup: new worktree from docs/t389-harnu-mod-specs, branch feat/t389-p1w1-host-server; npm ci; npm run typecheck.
Read first: docs/specs/T389-companion-mod/P1W1-host-server.md, then 01-contract.md sections 2 to 8 and 11.3; docs/plans/T389-companion-mod/P1-sensor.md (P1W1) and 00-master-plan.md section 9.
May touch: src/main/companion/**, resources/companion/hooks/contract.ts, resources/companion/tests/fixtures/**, tests/companion/*.test.ts (including contract.test.ts, which this wave creates), src/main/index.ts, src/preload/index.ts, tsconfig.node.json, vitest.config.mts, docs/dev/live-verify-second-instance.md.
Satisfy: AC-P1W1-1 to -36; recipes LV-P1W1-a and -b.
Skills: /local-ci, superpowers:test-driven-development (if available; otherwise follow test-first as listed).
Out of scope: any consumer, adapter, staging, --plugin-dir, pty.ts changes, enable policy beyond enable: [].
Return: pipeline JSON path and log, an AC to test-title table, recipe logs with claude --version, git rev-list --count of the branch, a "Spec defects" list.
Autonomy: decide within the spec, do not ask, commit each plan step before reporting.
```

---

## P1W2 — Mod skeleton, staging, version gate, harness

| Field  | Value                                                                                                                                    |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Branch | `feat/t389-p1w2-mod-skeleton`                                                                                                            |
| Base   | P0 docs tip; **join:** rebase onto `feat/t389-p1w1-host-server` before P1W3 starts, replacing the local stub                             |
| Spec   | `docs/specs/T389-companion-mod/P1W2-mod-skeleton-and-harness.md` · contract §23; `docs/specs/T200-cli-version-detection.md` §3.1 to §3.3 |
| Size   | L: 31 ACs (3 live-verify), staging, gate, injection, harness, packaging                                                                  |
| Labels | `no-changelog,no-user-docs` (`claude-cli-version.ts` is a new top-level main file with no user surface yet)                              |

**Files.** Create `resources/companion/` (`.claude-plugin/plugin.json`, `types/index.d.ts` with an empty `PluginState`, `hooks/hooks.json`, `hooks/register.ts` (one `session.start` pass-through), `hooks/lib/`, `api-surface.json`, `tsconfig.json`, `.gitignore`, `tests/`); generated `hooks/coords.gen.ts` (gitignored); `src/main/companion/{staging-core,staging,version-gate,spawn-inject,sideload-retry-core}.ts`; `src/main/claude-cli-version.ts`; `scripts/ci/mod-step.mjs`, `scripts/ci/render-coords.mjs`; `tests/cli/support/{fake-host,run-claude}.ts` and `tests/cli/fixtures/probe-mod`. Change `src/main/claude-cli.ts` (version probe), `src/main/pty.ts` (second unconditional `--plugin-dir`, spawn-token mint, sideload retry), `src/main/scheduler-core.ts` and `scheduler-shell.ts` (`companionPluginDir` in `tickArgv`), `src/main/index.ts`, `electron-builder.yml` (`extraResources`), `tsconfig.node.json`, `vitest.config.mts` (`exclude` `staging.ts`, `spawn-inject.ts`), `scripts/ci/local-pipeline.sh` (the `mod` step after `lint`, `--with-cli`, `--skip` help), `.claude/skills/local-ci/SKILL.md`, `docs/dev/companion-mod.md` (new), the T200 spec status line.

**Steps**

| #   | Commit group         | Tests first (file → ACs)                                                                                                                                | Then                                                                                                                                     |
| --- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | CLI version and gate | `claude-cli-version.test.ts`, `claude-cli-probe.test.ts` (T200 §6); `version-gate.test.ts` → AC-P1W2-9                                                  | `claude-cli-version.ts`, probe in `claude-cli.ts`, `version-gate.ts` (`cliGate`, `gateAllowsInjection`)                                  |
| 2   | skeleton and harness | `tests/mod-step.test.ts` → AC-P1W2-23; `resources/companion/tests/skeleton.test.ts` → AC-P1W2-15                                                        | skeleton plugin, `render-coords.mjs`, `mod-step.mjs`, the `mod` step and `--with-cli` in `local-pipeline.sh`, `tests/cli/support/*`      |
| 3   | staging              | `staging-core.test.ts` → AC-P1W2-2, -3, -6, -7, -8, -27, -29, -30                                                                                       | `staging-core.ts`, `staging.ts` (immutable `<stageKey>`, hash, single-owner dev lock, `pinStagedDir`), `electron-builder.yml`            |
| 4   | spawn injection      | `spawn-inject.test.ts` → AC-P1W2-1, -4, -5, -10; `scheduler-argv.test.ts` → AC-P1W2-20; `usage-poller.test.ts` and `haiku-service.test.ts` → AC-P1W2-28 | `spawn-inject.ts`, `setCompanionSpawnProvider` in `pty.ts` (first `--plugin-dir`, before the `--` separator), token env, scheduler ticks |
| 5   | sideload retry       | `sideload-retry.test.ts` → AC-P1W2-21, -22                                                                                                              | `sideload-retry-core.ts`, the retry hook in `pty.ts`                                                                                     |
| 6   | drift contract       | `api-surface.test.ts` → AC-P1W2-11, -12, -13; `validate-notes.test.ts` → AC-P1W2-14, -31                                                                | `api-surface.json`, the static scraper, `parseValidateNotes` (with the marketplace trap)                                                 |
| 7   | L4 suites            | `tests/cli/load.cli.test.ts` → AC-P1W2-16, -17; `types.cli.test.ts` → AC-P1W2-18; `tick.cli.test.ts` → AC-P1W2-19                                       | (no new code; hermetic launcher, zero-model `/harnu-probe`)                                                                              |
| 8   | live-verify and docs | LV-P1W2-a → AC-P1W2-25; LV-P1W2-b → AC-P1W2-24 (Q1); LV-P1W2-c → AC-P1W2-26                                                                             | `docs/dev/companion-mod.md`, `local-ci` skill, T200 status line, smoke addendum                                                          |

**Notes.** AC-P1W2-16 settles Q5 (`blocked-by-auth` is a failure under `--with-cli`, never a skip). `--with-cli` is mandatory here for the first time. Moving the tested ceiling is not part of this wave.

**Pipeline.** `scripts/ci/local-pipeline.sh --base feat/t389-p1w1-host-server --with-cli --labels no-changelog,no-user-docs --json /tmp/p1w2.json`, including the new `mod` step. Run it after the join rebase; before the rebase use `--base docs/t389-harnu-mod-specs`.

**Boot packet**

```text
Objective: build the mod skeleton and everything around it (spec P1W2): resources/companion/, immutable versioned staging, the second unconditional --plugin-dir, spawn-token minting, the CLI version gate, the sideload-block retry, and the test harness (the mod step, --with-cli, api-surface drift checks). The skeleton registers one pass-through session.start and makes no network call.
Setup: new worktree from the P0 docs tip, branch feat/t389-p1w2-mod-skeleton; npm ci. Compile against a local stub of P1W1's contract.ts, mode.ts and mintSpawnToken until the join rebase onto feat/t389-p1w1-host-server.
Read first: docs/specs/T389-companion-mod/P1W2-mod-skeleton-and-harness.md; docs/specs/T200-cli-version-detection.md 3.1 to 3.3; plan P1-sensor.md (P1W2); master plan section 9.
May touch: resources/companion/**, src/main/companion/{staging-core,staging,version-gate,spawn-inject,sideload-retry-core}.ts, src/main/claude-cli-version.ts, claude-cli.ts, pty.ts, scheduler-core.ts, scheduler-shell.ts, index.ts, electron-builder.yml, tsconfig.node.json, vitest.config.mts, scripts/ci/**, tests/cli/**, tests/companion/**, docs/dev/companion-mod.md, .claude/skills/local-ci/SKILL.md.
Satisfy: AC-P1W2-1 to -31; recipes LV-P1W2-a, -b, -c.
Skills: /local-ci, plugin-authoring, superpowers:test-driven-development (if available; otherwise follow test-first as listed).
Out of scope: handshake or any $.http call, mode UI, disclosure, Mods tab, install outside --plugin-dir, T200 UI row.
Return: pipeline JSON (mod step included), --with-cli log with claude --version, AC to test table, recipe logs, rev-list count, Spec defects.
Autonomy: decide within the spec, do not ask, commit each plan step before reporting.
```

---

## P1W3 — Handshake and identity

| Field  | Value                                                                               |
| ------ | ----------------------------------------------------------------------------------- |
| Branch | `feat/t389-p1w3-handshake-identity`                                                 |
| Base   | `feat/t389-p1w2-mod-skeleton` (with P1W1 below it)                                  |
| Spec   | `docs/specs/T389-companion-mod/P1W3-handshake-identity.md` · contract §3, §5.1, §15 |
| Size   | L: 49 ACs (20 mod-test, 8 live-verify, 1 human): the critical path of the epic      |
| Labels | `no-changelog` (the CHANGELOG `Fixed` entry lands with the `identity` flip)         |

**Files.** Mod: `hooks/register.ts` (`ensureHello`, `emit`, `enabled`, `boundSid`, `reportModError`; events `session.snapshot`, `session.rebound`, `session.end`, `mod.error`), `hooks/lib/{ring,rendezvous-parse}.ts`, `types/index.d.ts` (`$.state` keys `conn`, `bootId`, `sid`, `boot`, `probes`), `api-surface.json`. Host: `src/main/companion/{identity-core,identity-adapter,identity-parity-core,enable-policy}.ts`, one field on the spawn ledger, IPC `companion:identity` and `companion:identityClaims`. Renderer: new `src/renderer/src/lib/identity-claims.ts`; edits to `src/renderer/src/stores/sessions.ts` per spec §7.6 and §7.7 (the existing migration path at `:3251`, `:3261`; the heuristics at `:4917`, `:5051-5115` narrowed only when a claim acts) and `src/main/pty.ts` (`pty:rekey` fires `onBindingChange`). Fixtures: `tests/fixtures/companion-parity/identity/*.ndjson`. Docs: `docs/lessons/synthetic-sessions/004-claim-not-rekey-before-transcript.md`.

**Steps**

| #   | Commit group     | Tests first (file → ACs)                                                                                                                                                                            | Then                                                                                                                                                  |
| --- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | mod runtime (L3) | `resources/companion/tests/ring.test.ts` → AC-P1W3-10, -12; `hello.test.ts` → AC-P1W3-1, -2, -3, -4, -5, -6, -11, -13, -43, -44, -46, -47, -48, -49; `rekey.test.ts` → AC-P1W3-7, -8, -9, -45       | `register.ts`, `lib/ring.ts`, `lib/rendezvous-parse.ts`, `types/index.d.ts`, `api-surface.json`                                                       |
| 2   | host identity    | `identity-core.test.ts` → AC-P1W3-14, -15; `identity-adapter.test.ts` → AC-P1W3-16, -18; `companion-session-table.test.ts` → AC-P1W3-17 (redeem window)                                             | `identity-core.ts` (`classifyIdentity`, `mayAct`), `enable-policy.ts` (first policy: `sense.identity` only), `identity-adapter.ts`, `markProven`, IPC |
| 3   | parity record    | `identity-parity.test.ts` → AC-P1W3-27, -28                                                                                                                                                         | `identity-parity-core.ts`, scrubbed fixtures                                                                                                          |
| 4   | renderer claims  | `tests/identity-claims.test.ts`; `tests/sessions-store.test.ts` (new cases) → AC-P1W3-19, -20, -21, -22, -23, -24, -25, -26                                                                         | `identity-claims.ts`, the `sessions.ts` edits, `pty:rekey` firing `onBindingChange`                                                                   |
| 5   | L4               | `tests/cli/handshake.cli.test.ts` → AC-P1W3-29, -30, -31, -32, -33                                                                                                                                  | (CQ1, CQ2 and the fork id answers go to the smoke evidence addendum)                                                                                  |
| 6   | live-verify      | LV-P1W3-c step 0 with mode `off` first (AC-P1W3-42, finding F3), then LV-P1W3-a (AC-34), -c (AC-35), -d (AC-36), -e (AC-37), -f (AC-38), -g (AC-39), -h (AC-40); LV-P1W3-b is the crossed-agent run | recipe logs with `claude --version`                                                                                                                   |
| 7   | docs             | none                                                                                                                                                                                                | lesson 004, smoke addendum (CQ1 to CQ4, fork id); `contract.ts` and fixtures already in step 1 (DOC-7)                                                |

**Human.** AC-P1W3-41 (a day of ordinary use in `active`, no lingering "New session" row) is signed at the `identity` flip, not at merge. The flip PR (not this one) carries the CHANGELOG `Fixed` entry and the one sentence on `/clear` in `docs/user/sessions.md` (spec §12).

**Pipeline.** `scripts/ci/local-pipeline.sh --base feat/t389-p1w2-mod-skeleton --with-cli --with-e2e --labels no-changelog --json /tmp/p1w3.json` (`--with-e2e` because the wave edits `stores/sessions.ts` and the sidebar row migration is what the existing e2e specs exercise).

**Boot packet**

```text
Objective: implement the handshake and identity (spec P1W3): the mod's ensureHello, emit ring, heartbeat, re-hello after reload, bye; the host's identity claim and first enable policy; the renderer honouring a claim at the existing session:added migration instead of the correlation heuristics. Hello gives a claim, never an early re-key (C19).
Setup: new worktree from feat/t389-p1w2-mod-skeleton (P1W1 below it), branch feat/t389-p1w3-handshake-identity; npm ci.
Read first: docs/specs/T389-companion-mod/P1W3-handshake-identity.md; 01-contract.md sections 3, 5.1, 15; plan P1-sensor.md (P1W3); master plan section 9.
May touch: resources/companion/hooks/**, resources/companion/tests/**, src/main/companion/{identity-*,enable-policy}.ts and session-table.ts, src/main/pty.ts, src/preload/index.ts, src/renderer/src/lib/identity-claims.ts, src/renderer/src/stores/sessions.ts, tests/**, tests/fixtures/companion-parity/identity/**, docs/lessons/synthetic-sessions/004-*.md, the smoke evidence addendum.
Satisfy: AC-P1W3-1 to -49 (AC-P1W3-41 is human); recipes LV-P1W3-a to -h.
Skills: /local-ci, plugin-authoring, superpowers:test-driven-development (if available; otherwise follow test-first as listed).
Out of scope: poll, ask, commands, task-state or usage events, per-folder ramp, UI, external binding, hello.proof, deleting any legacy binder.
Return: pipeline JSON (cli and e2e), --with-cli log with claude --version, AC to test table, LV logs (LV-P1W3-c with mode off first), rev-list count, Spec defects.
Autonomy: decide within the spec, do not ask, commit each plan step before reporting.
```

---

## P1W4 — Arbitration, rollout, parity, status UI

| Field  | Value                                                                                            |
| ------ | ------------------------------------------------------------------------------------------------ |
| Branch | `feat/t389-p1w4-arbitration-rollout`                                                             |
| Base   | `feat/t389-p1w3-handshake-identity`                                                              |
| Spec   | `docs/specs/T389-companion-mod/P1W4-arbitration-and-rollout.md` · master §7.2, §12.1, §13 (OD-1) |
| Size   | L: 31 ACs (3 human, 4 live-verify); pure core, hub extraction, ledger, UI                        |
| Labels | none (CHANGELOG `Added`, user docs and design all land here)                                     |

**Files.** `src/main/companion/{arbitration-core,session-arbiter,companion-prefs,companion-prefs-core,feature-policy,parity-core,parity-ledger,companion-state-core}.ts`; `src/main/detect/task-state-hub.ts` (extracted from `hook-bridge.ts`: `handleBridgeEvent` at `:409-448`, the registry at `:214`, `getTaskStates` `:222`, `pruneTaskState` `:231`, `HookTaskEvent` `:242-254`, the observers `:256-271`); `src/main/claude-policy-probe-core.ts` and `claude-policy-probe.ts` (two new top-level files; first-lander for P4W1 and P4W3); bodies of `mode.ts`; `scripts/dev/companion-parity-export.mjs`. Change `hook-bridge.ts` (re-exports, `source` on `BridgeEvent`), `spawn-inject.ts` (`companionInjectDecision`), `companion-ipc.ts` (`companionStatus()`, kill switch, disclosure), `src/preload/index.ts`. Renderer: `stores/companion.ts` (new), `SettingsDialog.vue` (block `id="set-companion"` after `set-statusline`, region `id="set-companion-keys"`), `SessionPreview.vue` (one line), `SystemMonitorRow.vue` and `SystemMonitor.vue` (`companion` prop). `design.md` first, then `en.json` and `pt-BR.json` (27 `harnuMod.*` keys), `docs/user/{settings,system-monitor,troubleshooting}.md`, `CHANGELOG.md`.

**Steps**

| #   | Commit group                     | Tests first (file → ACs)                                                                                                                                | Then                                                                                                                        |
| --- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1   | arbiter                          | `tests/companion/arbitration-core.test.ts` → AC-P1W4-1, -4, -5; `session-arbiter.test.ts` → AC-P1W4-2, -22, -25                                         | `arbitration-core.ts` (`effectiveMode`, `ownerOf`, `admit`), `session-arbiter.ts`                                           |
| 2   | prefs, ramp, enable, kill switch | `companion-prefs-core.test.ts` → AC-P1W4-3, -13, -23, -24, -29, -31; `feature-policy.test.ts` → AC-P1W4-30; `kill-switch.contract.test.ts` → AC-P1W4-14 | `companion-prefs(-core).ts`, `mode.ts` bodies, `computeEnable`, `companionInjectDecision`, revoke on off                    |
| 3   | hub extraction (refactor commit) | existing `tests/hook-bridge.test.ts` runs **unmodified** → AC-P1W4-6, before and after the move                                                         | move the fold and fan-out into `detect/task-state-hub.ts`; re-export from `hook-bridge.ts`                                  |
| 4   | hub gating                       | `task-state-hub.test.ts` → AC-P1W4-7, -8, -9, -21                                                                                                       | `source` on `BridgeEvent`, drop-at-the-adapter, terminal-edge first-writer-wins (ARB-2d)                                    |
| 5   | parity ledger                    | `parity-core.test.ts` → AC-P1W4-10, -11 (fixture `identity/dup-row.ndjson`)                                                                             | `parity-core.ts`, `parity-ledger.ts` (`recordFact`, rotation, retention, scrub), `identity` rule, export script             |
| 6   | state and probe                  | `companion-state-core.test.ts` → AC-P1W4-12                                                                                                             | `companion-state-core.ts`, `claude-policy-probe(-core).ts`, `companionStatus()` IPC                                         |
| 7   | integration                      | `tests/cli/companion-state.cli.test.ts` → AC-P1W4-15                                                                                                    | none                                                                                                                        |
| 8   | UI (design first)                | i18n parity step → AC-P1W4-20                                                                                                                           | `design.md` §6 and §8, then both locales, store, settings block, preview line, monitor cell, disclosure and unloaded toasts |
| 9   | live-verify and docs             | LV-P1W4-a (AC-16), -b (AC-17), -c (AC-18, Q8 classifier half), -d (AC-19, Q9), -e (AC-28, managed machine, one run)                                     | CHANGELOG, user docs; `human` AC-26, -27 screenshots from LV-P1W4-a, -b                                                     |

**Notes.** This PR turns the default from `off` to `shadow` (OD-1, recorded). LV-P1W4-e needs a managed machine: if unavailable, report it `blocked` and do not mark AC-P1W4-28 met. A macOS run of LV-P1W1-a (P1W1 OQ-2) is owed before the first family flip; schedule it here.

**Pipeline.** `scripts/ci/local-pipeline.sh --base feat/t389-p1w3-handshake-identity --with-cli --with-e2e --json /tmp/p1w4.json`.

**Boot packet**

```text
Objective: add the arbiter and rollout machinery (spec P1W4): pure arbitration core, companion-prefs.json with family modes and the per-folder ramp, computeEnable, the task-state hub extracted from hook-bridge.ts, the persisted parity ledger, the Harnu mod state in the hover preview and System Monitor, the one-time disclosure and the global kill switch. The default becomes shadow (OD-1).
Setup: new worktree from feat/t389-p1w3-handshake-identity, branch feat/t389-p1w4-arbitration-rollout; npm ci.
Read first: docs/specs/T389-companion-mod/P1W4-arbitration-and-rollout.md; master spec 7.2 and 12.1; design.md sections 6 and 8; plan P1-sensor.md (P1W4); master plan section 9.
May touch: src/main/companion/**, src/main/detect/task-state-hub.ts, src/main/hook-bridge.ts (extraction only), src/main/claude-policy-probe*.ts, src/preload/index.ts, scripts/dev/companion-parity-export.mjs, the five renderer files named in the plan, design.md, en.json, pt-BR.json, docs/user/{settings,system-monitor,troubleshooting}.md, CHANGELOG.md, tests/**.
Satisfy: AC-P1W4-1 to -31 (-26, -27, -28 human); recipes LV-P1W4-a to -e.
Skills: /local-ci, superpowers:test-driven-development (if available; otherwise follow test-first as listed).
Out of scope: any sensor or adapter, commands, per-family UI, Mods tab, deleting a legacy seam.
Return: pipeline JSON (with e2e and cli), AC table, recipe logs and screenshots, whether the managed run happened, rev-list count, Spec defects.
Autonomy: decide within the spec, do not ask, commit each plan step before reporting.
```

---

## P1W5 — Fleet state

| Field  | Value                                                                    |
| ------ | ------------------------------------------------------------------------ |
| Branch | `feat/t389-p1w5-fleet-state`                                             |
| Base   | `feat/t389-p1w4-arbitration-rollout`                                     |
| Spec   | `docs/specs/T389-companion-mod/P1W5-fleet-state.md` · contract §8, §11.4 |
| Size   | M: 27 ACs (7 mod-test, 4 integration, 4 live-verify)                     |
| Labels | `no-changelog` until the `taskState` flip                                |

**Files.** Mod: `hooks/lib/fleet-sensor.ts` (pure), `hooks/register.ts` (creates the shared registrations of contract §11.4 and the `permissionMode` and `fleet` state keys), `types/index.d.ts`, `api-surface.json`, fixtures `resources/companion/tests/fixtures/fleet/` (the six smoke A4 traces plus idle). Host: `src/main/companion/ingest/{task-state-map-core,task-state-adapter}.ts`, `parity-taskstate-rule.ts`, committed traces under `tests/fixtures/companion-parity/taskState/`. Do not touch `fleet-state.ts`, `stall-detect.ts`, `transcript-truth.ts`.

**Steps**

| #   | Commit group            | Tests first (file → ACs)                                                                                                                   | Then                                                                                         |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| 1   | fixtures and mod sensor | `resources/companion/tests/fleet-sensor.test.ts` → AC-P1W5-1, -2, -3, -4, -22, -23, -24; `tests/companion/api-surface.test.ts` → AC-P1W5-5 | fixtures, `fleet-sensor.ts`, `register.ts` hooks (`turn.*`, `classic.*` pass-through bodies) |
| 2   | host map                | `tests/companion/task-state-map-core.test.ts` → AC-P1W5-6                                                                                  | `task-state-map-core.ts` (D12 table)                                                         |
| 3   | adapter                 | `task-state-adapter.test.ts` → AC-P1W5-7, -8, -9, -10, -11, -12, -13, -14, -25                                                             | `task-state-adapter.ts` over the hub's `ingest`, `noteLiveness`, `markProven`                |
| 4   | parity rule             | `tests/companion/parity-taskstate.test.ts` → AC-P1W5-15                                                                                    | `parity-taskstate-rule.ts` (classes E1 to E5), traces                                        |
| 5   | L4                      | `tests/cli/fleet-state.cli.test.ts` → AC-P1W5-16, -17, -18, -26                                                                            | answers to CQ12, CQ13, Q12, Q24 into the smoke addendum                                      |
| 6   | live-verify and docs    | LV-P1W5-a (AC-20, Esc), -b (AC-19, Q11), -c (AC-21, `classic.*` pinned), -d (AC-27, a real `StopFailure` body: F1, Q29)                    | `docs/user/troubleshooting.md`, `sessions.md`                                                |

**Pipeline.** `scripts/ci/local-pipeline.sh --base feat/t389-p1w4-arbitration-rollout --with-cli --labels no-changelog --json /tmp/p1w5.json`.

**Boot packet**

```text
Objective: sense fleet state from inside claude (spec P1W5): turn, attention and subagent sensors in the mod and the host adapter that maps them onto the existing task-state reducer through the P1W4 hub. Exits from waiting-permission are classic.PostToolUse, the companion's own ask resolution and turn.complete; never tool.call.end or PostToolUseFailure.
Setup: new worktree from feat/t389-p1w4-arbitration-rollout, branch feat/t389-p1w5-fleet-state; npm ci.
Read first: docs/specs/T389-companion-mod/P1W5-fleet-state.md; 01-contract.md sections 8 and 11.4; plan P1-sensor.md (P1W5); master plan section 9.
May touch: resources/companion/hooks/**, resources/companion/tests/**, src/main/companion/ingest/**, src/main/companion/parity-taskstate-rule.ts, tests/companion/**, tests/cli/fleet-state.cli.test.ts, tests/fixtures/companion-parity/taskState/**, docs/user/{troubleshooting,sessions}.md, the smoke addendum.
Satisfy: AC-P1W5-1 to -27; recipes LV-P1W5-a to -d.
Skills: /local-ci, plugin-authoring, superpowers:test-driven-development (if available; otherwise follow test-first as listed).
Out of scope: holding or answering an approval, turn.progress, any change to fleet-state.ts, stall-detect.ts or transcript-truth.ts, any UI, removing the blob or global install.
Return: pipeline JSON, --with-cli log with claude --version, AC table, recipe logs including the real StopFailure body, rev-list count, Spec defects.
Autonomy: decide within the spec, do not ask, commit each plan step before reporting.
```

---

## P1W6 — Telemetry, plan usage, per-turn cost (three slices)

The spec slices the wave but does not assign ACs to slices; the mapping below is this plan's (raise it as a spec gap if you disagree).

| Slice | Branch                              | Base                                             | Scope                                                                                       | ACs                                                            |
| ----- | ----------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| S1    | `feat/t389-p1w6-telemetry-usage-s1` | `feat/t389-p1w4-arbitration-rollout`             | `sense.usage`, neutral telemetry store, field partition for `cost`, `context`, `rateLimits` | AC-P1W6-1 to -11, -20, -22, -26, -28, -29; LV-P1W6-b           |
| S2    | `…-s2`                              | S1                                               | plan-usage gate in `usage.ts` (poll only when no owned reading in 90 s)                     | AC-P1W6-12, -13, -14, -31; LV-P1W6-c (CQ14)                    |
| S3    | `…-s3`                              | S2 **rebased onto `feat/t389-p1w5-fleet-state`** | turn ledger, `model` group, cost calibration, `recordAuxSpend`                              | AC-P1W6-15 to -19, -21, -24, -25, -27, -30, -32; LV-P1W6-a, -d |

Spec: `docs/specs/T389-companion-mod/P1W6-telemetry-usage-cost.md`. Size: L (32 ACs, three PRs). Labels: `no-changelog` until the flip. S1 adds a new top-level main file (`telemetry-store.ts`), so its PR must touch `docs/user/usage.md`.

**Files.** S1: mod `hooks/lib/usage-sensor.ts`, `register.ts`, `api-surface.json`; host `src/main/companion/ingest/{usage-map-core,telemetry-adapter}.ts`, `src/main/telemetry-compose-core.ts`, `src/main/telemetry-store.ts`; edit `statusline.ts` (ingest hands the blob to the store; `captureFleet` is fed by the store, R14) and `statusline-parse.ts` (`rateLimitsAtMs`, window freshness, lesson `framework/005`); parity rules `telemetry`. S2: `src/main/companion/ingest/plan-usage-gate-core.ts`, `src/main/usage.ts`, parity rule `planUsage`. S3: `ingest/turn-ledger-core.ts`, `src/main/companion/turn-ledger.ts` (per-instance path), `usage-cost-core.ts` and `usage-cost.ts` (calibration), `recordAuxSpend`.

**Steps**

| #   | Slice | Commit group           | Tests first (file → ACs)                                                                                                                                                     | Then                                                                                                       |
| --- | ----- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1   | S1    | mod sensor             | `resources/companion/tests/usage-sensor.test.ts` → AC-P1W6-1, -2                                                                                                             | `usage-sensor.ts`, `session.measure` hook, `usage.measured` event                                          |
| 2   | S1    | map and compose        | `tests/companion/usage-map-core.test.ts` → AC-P1W6-3; `tests/telemetry-compose-core.test.ts` → AC-P1W6-4, -5, -6, -29                                                        | `usage-map-core.ts`, `telemetry-compose-core.ts` (pure)                                                    |
| 3   | S1    | store and statusLine   | `tests/telemetry-store.test.ts` → AC-P1W6-7, -9, -10, -26, -28; `tests/statusline-parse.test.ts` → AC-P1W6-8; `tests/companion/statusline-independence.test.ts` → AC-P1W6-11 | `telemetry-store.ts`, `telemetry-adapter.ts`, the `statusline.ts` and `statusline-parse.ts` edits          |
| 4   | S1    | L4, live, docs         | `tests/cli/usage.cli.test.ts` → AC-P1W6-20; LV-P1W6-b → AC-P1W6-22 (two instances, separate `userData`)                                                                      | `docs/user/usage.md`, `settings.md` hint                                                                   |
| 5   | S2    | gate                   | `plan-usage-gate-core.test.ts` → AC-P1W6-13; `tests/usage-poller.test.ts` → AC-P1W6-12, -14, -31                                                                             | `plan-usage-gate-core.ts`, `usage.ts` gate; LV-P1W6-c → AC-P1W6-23                                         |
| 6   | S3    | ledger and calibration | `turn-ledger-core.test.ts` → AC-P1W6-15, -16, -17, -18, -27; `tests/usage-cost-core.test.ts` → AC-P1W6-19, -32; `tests/companion/turn-ledger.test.ts` → AC-P1W6-30           | `turn-ledger-core.ts`, `turn-ledger.ts`, calibration in `usage-cost*`, `recordAuxSpend`, the `model` group |
| 7   | S3    | L4, live               | `usage.cli.test.ts` → AC-P1W6-21 (Q13a); LV-P1W6-d → AC-P1W6-24 (Q14); LV-P1W6-a → AC-P1W6-25 (both families `active`, five minutes)                                         | smoke addendum for Q13a, Q14, CQ14                                                                         |

**Pipeline.** S1: `--base feat/t389-p1w4-arbitration-rollout --with-cli --labels no-changelog`. S2: `--base …-s1`. S3: `--base …-s2` (after the join rebase) with the same flags.

**Boot packet (paste with a dispatch line `Slice: S1`, `Slice: S2` or `Slice: S3` above it; do only that slice)**

```text
Objective: one slice of P1W6 (spec P1W6-telemetry-usage-cost). S1: forward session.measure as usage.measured and write context, cost and rate limits into the existing SessionTelemetry through a neutral store and a pure field-partition compose; the statusLine keeps the eight fields with no mod source and is demoted, not removed. S2: gate the /usage poll on owned leased readings. S3: the per-turn ledger, the model group, cost calibration and recordAuxSpend.
Setup: new worktree, branch and base from the plan table (S1 from feat/t389-p1w4-arbitration-rollout; S2 on S1; S3 on S2 after the S1 to S2 chain is rebased onto feat/t389-p1w5-fleet-state); npm ci.
Read first: docs/specs/T389-companion-mod/P1W6-telemetry-usage-cost.md; docs/lessons/framework/005-exit-cleanup-must-be-instance-exact.md; plan P1-sensor.md (P1W6); master plan section 9.
May touch: resources/companion/hooks/**, resources/companion/tests/**, src/main/companion/ingest/**, src/main/companion/turn-ledger.ts, src/main/telemetry-*.ts, statusline.ts, statusline-parse.ts, usage.ts, usage-cost*.ts, tests/**, tests/fixtures/companion-parity/{telemetry,planUsage}/**, docs/user/{usage,settings}.md.
Satisfy: S1: AC-P1W6-1 to -11, -20, -22, -26, -28, -29. S2: -12, -13, -14, -23, -31. S3: -15 to -19, -21, -24, -25, -27, -30, -32.
Skills: /local-ci, plugin-authoring, superpowers:test-driven-development (if available; otherwise follow test-first as listed).
Out of scope: uninstalling the statusLine, new UI or strings, spend_limit, turn.step, relabelling dashboard numbers.
Return: pipeline JSON, --with-cli log with claude --version, AC table, recipe logs, rev-list count, Spec defects.
Autonomy: decide within the spec, do not ask, commit each plan step before reporting.
```
