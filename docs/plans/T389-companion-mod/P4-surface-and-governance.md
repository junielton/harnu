# T389 P4 — Surface and governance: implementation plan

**Waves:** P4W1 (parts A and B), P4W2, P4W3, P4W4 (S1 to S3), P4W5 (S1 to S4) · **Master plan:** [`00-master-plan.md`](00-master-plan.md) · **Specs:** `docs/specs/T389-companion-mod/P4W*.md`

Every wave here is user-visible (new component, pane, dialog or switch), so each PR carries `design.md` first, both locale files, `docs/user/`, a CHANGELOG entry and `--with-e2e`. Switches ship off (`plan`, `recap`, `modsLive`, `external`, `surface`) and flip only on the evidence the spec names. Common definition of done and executor hygiene: master plan §9.

Timing: P4W1 part A starts in B0 from `main`. P4W3 and P4W1 part B run in B3. P4W2 and P4W4 start in B5 (after Gate K); P4W5 in B7 (master plan §5).

---

## P4W1 — Mods audit tab (part A static, part B live)

| Field  | Part A                                                                                                         | Part B                                                                            |
| ------ | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Branch | `feat/t389-p4w1-mods-tab-a`                                                                                    | `feat/t389-p4w1-mods-tab-b`                                                       |
| Base   | `main` (independent of the companion); **join:** rebased onto `feat/t389-p1w4-arbitration-rollout` before P4W3 | `feat/t389-p1w4-arbitration-rollout` with part A below it                         |
| ACs    | AC-P4W1-1 to -15, -19, -22, -23                                                                                | AC-P4W1-16, -17, -18, -20, -21                                                    |
| Labels | none (CHANGELOG `Added`; a top-level component and a top-level main file fire the user-docs gate)              | `no-changelog` (`modsLive` ships off; the CHANGELOG line lands with the key flip) |

Spec: `docs/specs/T389-companion-mod/P4W1-mods-audit-tab.md` · contract §8, §11.1, §11.5. Size: M (23 ACs, two PRs).

**Files (A).** New top-level `src/main/mods-audit-core.ts` (pure: note parser, source planning, `list --json` normalisation, capability chips, cache keys) and `src/main/mods-audit.ts` (shell: discovery, hashing, running the CLI, cache file, IPC); `src/renderer/src/components/ModsAuditPane.vue` (new top-level). Edit `src/main/index.ts` (register next to `registerBundledSkillsHandlers`, `:617`), `src/preload/index.ts` (`modsAuditList`, `modsAuditAnalyse`, `onModsAuditRow`; `showItemInFolder` exists), `SettingsDialog.vue` (tab after `skills`, `:211-226`; mount after `:1037`), `stores/ui.ts` (`'mods'` in `SettingsTabId`, `:104`), `design.md` (new §6 "Mods (Settings → Mods, T389)", Settings tab list, one §8 Do line), `CLAUDE.md` (design-entity row `ModsAuditPane.vue`), both locales (`modsAudit.*`), `docs/user/mods.md` (new), `docs/user/README.md` index, `settings.md` tab map, a cross-link from `bundled-skills.md`, CHANGELOG. The renderer passes row keys, never paths; main resolves keys against its own last listing.

**Steps (A)**

| #   | Commit group         | Tests first (file → ACs)                                                                                                                                                           | Then                                                                                     |
| --- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1   | core (pure)          | `tests/mods-audit-core.test.ts` → AC-P4W1-1, -2, -3, -4, -5, -13, -22, -23 (snapshots: the smoke D2 report, the 202-row list fixture); `tests/mods-audit-copy.test.ts` → AC-P4W1-6 | `mods-audit-core.ts`; chips read as facts ("can"), never a verdict (R16)                 |
| 2   | shell and cache      | `tests/mods-audit-cache.test.ts` → AC-P4W1-8; `tests/mods-audit-shell.test.ts` → AC-P4W1-10, -11, -12                                                                              | `mods-audit.ts`, IPC `modsAudit:list`, `modsAudit:analyse`, `modsAudit:row`, preload     |
| 3   | CLI shape            | `tests/cli/mods-audit-shape.cli.test.ts` → AC-P4W1-7 (`--with-cli`); AC-P4W1-9 once P1W4's policy probe is in the base                                                             | none                                                                                     |
| 4   | UI (design first)    | human AC-P4W1-19: light and dark screenshots under `docs/specs/T389-companion-mod/evidence/P4W1-{light,dark}.png`                                                                  | `design.md`, keys, pane, tab, `ui.ts`, `CLAUDE.md` row, `permissionHookers` (cache only) |
| 5   | live-verify and docs | LV-P4W1-b (no companion: no `harnu` row, no placeholder), then LV-P4W1-a (AC-14, row 1; needs P1W2 in the base) and LV-P4W1-c (AC-15, policy; needs the P1W4 probe)                | `docs/user/mods.md` and the other docs, CHANGELOG                                        |

If part A merges before P1W2 and P1W4 are in `main`, AC-P4W1-9, -14 and -15 are attached to the part B PR (or a follow-up commit on A after the join rebase), and the pane reports `policy: 'unknown'` with no banner until then. Say so in the PR body.

**Part B.** `sense.mods` (the only place a `plugin.register` hook may appear, MOD-3): `resources/companion/hooks/register.ts`, `api-surface.json`, `registerEventTypes` for `mod.admitted`, `registerPrefsKey('modsLive', {default:false, observeCap:false})`. Tests first: `resources/companion/tests/mods.test.ts` → AC-P4W1-17; `tests/companion/mods-observed.test.ts` → AC-P4W1-18, -21; `tests/cli/mods-live.cli.test.ts` → AC-P4W1-16 (reload cost, CQ21), AC-P4W1-20 (load order by provenance, Q3). The key flips on AC-P4W1-16.

**Pipeline.** A: `scripts/ci/local-pipeline.sh --base origin/main --with-cli --with-e2e --json /tmp/p4w1a.json`. B: `--base feat/t389-p4w1-mods-tab-a --with-cli --with-e2e --labels no-changelog`.

**Boot packet (part A)**

```text
Objective: Settings -> Mods (spec P4W1 part A): a read-only pane listing the mods the user's sessions can load and what each can do, from claude plugin validate --json, worded as facts. Row 1 is the Harnu mod. No enable, disable, install or uninstall of third-party mods and no allowlist gate. Part A needs no companion code.
Setup: new worktree from main, branch feat/t389-p4w1-mods-tab-a; npm ci; git fetch origin main first (the contract gates diff against origin/main).
Read first: docs/specs/T389-companion-mod/P4W1-mods-audit-tab.md; design.md sections 6 and 8; plan P4-surface-and-governance.md (P4W1); master plan section 9.
May touch: src/main/{mods-audit-core,mods-audit}.ts, src/main/index.ts, src/preload/index.ts, ModsAuditPane.vue, SettingsDialog.vue, stores/ui.ts, design.md, CLAUDE.md (one map row), en.json, pt-BR.json, docs/user/{mods,README,settings,bundled-skills}.md, CHANGELOG.md, tests/**, docs/specs/T389-companion-mod/evidence/**.
Satisfy: AC-P4W1-1 to -15, -19, -22, -23 (-19 human); recipes LV-P4W1-a, -b, -c (a and c when their base exists).
Skills: /local-ci, superpowers:test-driven-development (if available; otherwise follow test-first as listed).
Out of scope: the user-tier allowlist gate, runtime tracing, destinations or paths of what a mod does, marketplaces not installed, part B.
Return: pipeline JSON (cli and e2e), AC table, screenshots, rev-list count, Spec defects.
Autonomy: decide within the spec, do not ask, commit each plan step before reporting.
```

**Boot packet (part B)**

```text
Objective: live observation for the Mods tab (spec P4W1 part B): the Harnu mod hooks plugin.register, the only place that hook may appear (MOD-3), to record which mods were admitted in sessions with a live lease; feature sense.mods behind the boolean key modsLive (default false). It observes and never refuses.
Setup: new worktree from feat/t389-p1w4-arbitration-rollout with feat/t389-p4w1-mods-tab-a below it, branch feat/t389-p4w1-mods-tab-b; npm ci.
Read first: docs/specs/T389-companion-mod/P4W1-mods-audit-tab.md section 7.6 and the part B ACs; 01-contract.md 8, 11.1, 11.5; plan P4-surface-and-governance.md (P4W1); master plan section 9.
May touch: resources/companion/hooks/**, resources/companion/tests/mods.test.ts, api-surface.json, src/main/companion/mods-observed*.ts, the key registration, tests/**, the part A docs only where part B changes their text.
Satisfy: AC-P4W1-16, -17, -18, -20, -21 (plus AC-P4W1-9, -14, -15 if part A merged before P1W2 and the policy probe).
Skills: /local-ci, plugin-authoring, superpowers:test-driven-development (if available; otherwise follow test-first as listed).
Out of scope: turning modsLive on, any enable or disable of a third-party mod, any hook on plugin.register outside sense.mods.
Return: pipeline JSON (cli and e2e), AC table, the reload-cost measurement (CQ21), rev-list count, Spec defects.
Autonomy: decide within the spec, do not ask, commit each plan step before reporting.
```

---

## P4W3 — Harnu mod outside Harnu

| Field  | Value                                                                          |
| ------ | ------------------------------------------------------------------------------ |
| Branch | `feat/t389-p4w3-outside-harnu`                                                 |
| Base   | `feat/t389-p1w4-arbitration-rollout` with P4W1 part A rebased under it         |
| Spec   | `docs/specs/T389-companion-mod/P4W3-companion-outside-harnu.md` · contract §21 |
| Size   | M: 23 ACs (3 mod-test, 3 live-verify, 2 human)                                 |
| Labels | none (CHANGELOG `Added`)                                                       |

**Files.** New `src/main/companion/{external-install-core,external-install,external-binding}.ts`. Edit `session-table.ts` (`profile: 'external'`, `corroborated`, in this wave's own change), `companion-ipc.ts` (`companion:externalGet`, `companion:externalSet`), `resources/companion/hooks/register.ts` (the tokenless branch of `ensureHello`; the local command refusal), `registerPrefsKey('external', {default:false, observeCap:false})`, the corroboration inputs (`session-registry-watch.ts`, the transcript watcher), the Advanced block in the pane that hosts the Harnu mod region, `SessionPreview.vue` ("outside Harnu" suffix). `design.md` §6 (new "Harnu mod outside Harnu"), keys, `docs/user/{mods,folders-and-worktrees,approval-inbox,troubleshooting}.md`.

**Steps**

| #   | Commit group         | Tests first (file → ACs)                                                                                                    | Then                                                                                                                                                                           |
| --- | -------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | install core (pure)  | `tests/companion/external-install-core.test.ts` → AC-P4W3-1, -2, -3, -4, -17                                                | `planInstall`, `planUninstall` (adds one item, exact undo, removes only what it created, refuses rather than overwrites)                                                       |
| 2   | install shell        | `external-install.test.ts` → AC-P4W3-5 (no write under a managed settings file, OD-5)                                       | `external-install.ts` over `readClaudeSettings` / `writeClaudeSettings` (`claude-settings.ts`), install record, post-install check and rollback, boot re-point, `pinStagedDir` |
| 3   | external binding     | `external-binding.test.ts` → AC-P4W3-8, -9, -10, -11, -21, -23                                                              | tokenless hello, corroboration (never for a spawned session), refusal list, per-binding rate bucket, switch off revokes                                                        |
| 4   | mod                  | `resources/companion/tests/external.test.ts` → AC-P4W3-6, -7, -22                                                           | tokenless branch, silent headless, refusal of actuators, resume after a Harnu restart                                                                                          |
| 5   | UI (design first)    | human AC-P4W3-19: the confirm dialog screenshot                                                                             | `design.md`, keys, switch and confirm dialog (full disclosure and the exact path), hover suffix                                                                                |
| 6   | L4                   | `tests/cli/external.cli.test.ts` → AC-P4W3-14, -15, -16                                                                     | none                                                                                                                                                                           |
| 7   | live-verify and docs | LV-P4W3-a (AC-12; CQ18, R24: does the env key and the flag load one module or two), -b (AC-13), -c (AC-18, byte-exact undo) | user docs, CHANGELOG; human AC-P4W3-20 (managed machine) listed as open if no machine                                                                                          |

**Notes.** AC-P4W3-12 gates the wave: if the flag and the env key load two instances, Harnu omits its own `--plugin-dir` while the outside switch is on (ticks keep it). Do not ship a path that can make every `claude` launch exit on a managed machine.

**Rollout.** `external` key `false`. External bindings flip with their family, and only after 10 external sessions with zero unexplained divergences (master plan §7).

**Pipeline.** `scripts/ci/local-pipeline.sh --base feat/t389-p1w4-arbitration-rollout --with-cli --with-e2e --json /tmp/p4w3.json`.

**Boot packet**

```text
Objective: opt-in install of the Harnu mod for sessions Harnu did not spawn (spec P4W3): a new switch (not the bundled-skills one) that adds Harnu's plugin dir to the user's Claude settings with an exact undo, the tokenless external hello and sensor-only external profile, shown only once Harnu's watchers corroborate the session, never held by default, refused on a machine with managed settings.
Setup: new worktree from feat/t389-p1w4-arbitration-rollout with feat/t389-p4w1-mods-tab-a rebased under it, branch feat/t389-p4w3-outside-harnu; npm ci.
Read first: docs/specs/T389-companion-mod/P4W3-companion-outside-harnu.md; 01-contract.md 21; plan P4-surface-and-governance.md (P4W3); master plan section 9.
May touch: src/main/companion/{external-*,session-table,companion-ipc}.ts, resources/companion/hooks/register.ts and tests, SessionPreview.vue, the pane hosting the Harnu mod region, design.md, en.json, pt-BR.json, docs/user/{mods,folders-and-worktrees,approval-inbox,troubleshooting}.md, CHANGELOG.md, tests/**, docs/specs/T389-companion-mod/evidence/**.
Satisfy: AC-P4W3-1 to -23 (-19, -20 human); recipes LV-P4W3-a, -b, -c.
Skills: /local-ci, plugin-authoring, superpowers:test-driven-development (if available; otherwise follow test-first as listed).
Out of scope: any actuator for an external session, other machines or containers, Desktop, VS Code, SDK or cloud claims, a resume guard, any workaround on a managed machine.
Return: pipeline JSON (cli and e2e), AC table, recipe logs (CQ18 answer), screenshots, whether the managed run happened, rev-list count, Spec defects.
Autonomy: decide within the spec, do not ask, commit each plan step before reporting.
```

---

## P4W2 — Terminal band and `/harnu-link` commands

| Field  | Value                                                                                                                                                                          |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Branch | `feat/t389-p4w2-band-commands`                                                                                                                                                 |
| Base   | `feat/t389-p4w3-outside-harnu` with P2W1 in its base, or, if P4W3 is already in `main`, the P2W1 tip (retargeted onto `main`); never rebase a merged branch (master plan §3.3) |
| Spec   | `docs/specs/T389-companion-mod/P4W2-terminal-band-and-commands.md` · contract §9 (`ui.band.set`), §10.3, §18                                                                   |
| Size   | M: 24 ACs (11 mod-test, 2 live-verify, 1 human)                                                                                                                                |
| Labels | none (CHANGELOG `Added` and `Fixed`; agent-facing)                                                                                                                             |

**Files.** Mod: `register.ts` (`$.command.register`, the `command.run{command=harnu-link}` hook, applying `ui.band.set`, the TTL tick), the `ask($, req)` client (master §12.2: P4W2 lands before P3W1 in this plan, so **this wave creates it** with that signature and P3W1 reuses it), `hooks/surface.tsx` (pure `bandRow`), `hooks/hooks.json` (one module only), `.claude-plugin/plugin.json` (`band` state key). Host: `src/main/companion/{surface-core,surface,open-link-server}.ts`, `registerAskKind('status', …)`, `registerGateRow('ui.band.set', …)`, `registerPrefsKey('surface', {default:false, observeCap:false})`, the `focus` audit record. Renderer: `TerminalPane.vue` and `HelperPane.vue` (`linkHandler` for OSC 8), preload `companionOpenTicket` and `onCompanionFocusSession`. Docs: `harnu-features.md` + marker (one paragraph: the operator may run `/harnu-link status`; you cannot run `open`), `docs/user/{sessions,troubleshooting}.md`, `design.md` §6 (new "Terminal surface") and §8, three keys.

**Steps**

| #   | Commit group            | Tests first (file → ACs)                                                                                                                                                      | Then                                                                                             |
| --- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1   | host surface            | `tests/companion/surface-core.test.ts` → AC-P4W2-9; `surface-text.test.ts` → AC-P4W2-4; `surface.test.ts` → AC-P4W2-6, -20, -22, -24; `open-link-server.test.ts` → AC-P4W2-13 | `surface-core.ts`, `surface.ts`, `open-link-server.ts`, the `status` ask, closed-vocabulary text |
| 2   | mod commands            | `resources/companion/tests/harnu-link-command.test.ts` → AC-P4W2-1, -2, -3, -5, -23                                                                                           | `/harnu-link status` and `open` (needs the person's Enter), local fallback line                  |
| 3   | mod band                | `resources/companion/tests/band.test.tsx` → AC-P4W2-7, -8, -10, -11, -12, -19                                                                                                 | `surface.tsx`, the `ui.render` hook that wraps other mods' content, TTL, href validation         |
| 4   | contract fixture        | `resources/companion/tests/fixtures/ask-status.ts` + `tests/companion/contract.test.ts` → AC-P4W2-18 (conformance row 28; append a case: P1W1 created the file)               | contract additions and `api-surface.json`                                                        |
| 5   | renderer (design first) | none beyond e2e                                                                                                                                                               | `design.md`, keys, OSC 8 handler, preload                                                        |
| 6   | L4                      | `tests/cli/harnu-link-command.cli.test.ts` → AC-P4W2-16, -17                                                                                                                  | none                                                                                             |
| 7   | live-verify and docs    | LV-P4W2-a (AC-14; Q21: 80, 110, 144 columns in Harnu's xterm.js), LV-P4W2-b (AC-15; the OSC 8 click); human AC-P4W2-21 (recording `P4W2-band.webm`)                           | `harnu-features.md` + marker (`/harnu-awareness`), user docs, CHANGELOG                          |

**Rollout.** `surface` key `false` until AC-P4W2-14 and -15 pass; then on by default. The band needs P4W3 to be visible at all, and there is no band inside Harnu in protocol 1.

**Pipeline.** `scripts/ci/local-pipeline.sh --base feat/t389-p4w3-outside-harnu --with-cli --with-e2e --json /tmp/p4w2.json`.

**Boot packet**

```text
Objective: the terminal surface (spec P4W2): /harnu-link status (no model turn, closed-vocabulary text) and /harnu-link open, an AbovePrompt band that is absent inside Harnu and shows one mission line for a session outside it, and a loopback open link activated by OSC 8 in Harnu's xterm.js. The band always wraps next(e); it never replaces another mod's content.
Setup: new worktree from feat/t389-p4w3-outside-harnu (P2W1 must be in its ancestry; if P4W3 is already in main, from the P2W1 tip), branch feat/t389-p4w2-band-commands; npm ci. Create the mod's ask client if absent (master 12.2). Do not merge: the operator merges after the kill-criteria review.
Read first: docs/specs/T389-companion-mod/P4W2-terminal-band-and-commands.md; 01-contract.md 9, 10.3, 18; plan P4-surface-and-governance.md (P4W2); master plan section 9; run /harnu-awareness before docs/harnu-features.md.
May touch: resources/companion/**, src/main/companion/{surface*,open-link-server}.ts, TerminalPane.vue, HelperPane.vue, src/preload/index.ts, design.md, en.json, pt-BR.json, docs/harnu-features.md, docs/user/{sessions,troubleshooting}.md, CHANGELOG.md, tests/**, docs/specs/T389-companion-mod/evidence/**.
Satisfy: AC-P4W2-1 to -24 (-21 human); recipes LV-P4W2-a and -b.
Skills: /local-ci, /harnu-awareness, plugin-authoring, superpowers:test-driven-development (if available; otherwise follow test-first as listed).
Out of scope: $.ui.open panes, band buttons, bands on desktop, vscode or mobile, other /harnu-link subcommands, anything that submits a prompt, redrawing the permission dialog.
Return: pipeline JSON (cli and e2e), AC table, recipe logs and recording, rev-list count, Spec defects.
Autonomy: decide within the spec, do not ask, commit each plan step before reporting.
```

---

## P4W4 — Resume micro-plan (three slices)

| Slice | Branch                          | Base                             | Scope                                                                                                 |
| ----- | ------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------- |
| S1    | `feat/t389-p4w4-resume-plan-s1` | `feat/t389-p2w1-command-channel` | park coordinator, capture decision core, plan store, `plan.capture`, read-only plan block, the switch |
| S2    | `…-s2`                          | S1                               | an "Edit" control in the preview (`planEdit`, `planClear`, `editedLines`)                             |
| S3    | `…-s3`                          | S2                               | optional title through `$.model.complete` (`plan.title`, default off)                                 |

Spec: `docs/specs/T389-companion-mod/P4W4-resume-micro-plan.md` · contract §9 (`plan.capture`), §11.5. Size: M (27 ACs, three PRs: S1 AC-1 to -23, S2 AC-24 and -25, S3 AC-26 and -27). Default off, with a cost statement; capture mode `idle` by default (about three minutes after a turn ends, while the cache is warm), `park` under a context ceiling (R21).

**Files (S1).** New `src/main/companion/{plan-capture-core,park-coordinator,plan-store}.ts` (store: `<userData>/companion/resume-plans.json`, mode `0600`, atomic write, cap and TTL). Edit `src/main/pty.ts` (`runPolicy` `:602-606` and `pty:park` `:957-959` call `requestPark`; `hibernateSession` `:570-595` is unchanged and, after this wave, is called only by the coordinator), `registerPrefsKey('plan', …)`, mod `register.ts` (`runPlanCapture`, `registerCommandHandler('plan.capture')`, `$.model.fork`), `api-surface.json`, preload (`plansFor`, `planEdit`, `planClear`, `onPlanChanged`, `onPtyParking`), `stores/sessions.ts` (`Session.resumePlan?`, `Session.parking?`), `SessionPreview.vue`, `FolderViewSessions.vue` (second line, only if `design.md` has a two-line row variant), `HibernationPolicyPane.vue` (switch, modes, cost statement, `spent` line), keys (`hibernationPolicy.plan.*`, `preview.planLabel`, `preview.planEdited`, `session.statusParking`).

**Steps (S1)**

| #   | Commit group         | Tests first (file → ACs)                                                                                                                                                                               | Then                                                                                        |
| --- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| 1   | capture core         | `tests/companion/plan-capture-core.test.ts` → AC-P4W4-1, -5 (rows E1 to E10), -6, -10, -23                                                                                                             | `plan-capture-core.ts` (`decideCapture`, `normalizePlan`, `revalidatePark`), injected clock |
| 2   | coordinator and pty  | `tests/companion/park-coordinator.test.ts` → AC-P4W4-2, -3, -4, -7, -8, -11, -22                                                                                                                       | `park-coordinator.ts`, `pty.ts` routing (a switch off parks in the same tick)               |
| 3   | store and privacy    | `plan-store.test.ts` → AC-P4W4-9; `plan-privacy.test.ts` → AC-P4W4-12 (plan text never reaches audit or logs)                                                                                          | `plan-store.ts`                                                                             |
| 4   | mod and contract     | `resources/companion/tests/plan-capture.test.ts` → AC-P4W4-13, -14, -15; `tests/companion/contract.plan.test.ts` → AC-P4W4-16                                                                          | handler over `$.model.fork`, fixtures                                                       |
| 5   | L4 (ship gate)       | `tests/cli/plan-capture.cli.test.ts` → AC-P4W4-17 (haiku, two calls, `HARNU_CLI_LIVE=1`). If the fork cannot run from the poll loop, ship the coordinator alone, behaviour-neutral with the switch off | none                                                                                        |
| 6   | UI (design first)    | none beyond e2e                                                                                                                                                                                        | `design.md` §6, §8, keys, the read-only plan block, the pane switch                         |
| 7   | live-verify and docs | LV-P4W4-a (AC-19, -20, "Park now" with and without the mod), LV-P4W4-b (AC-18, cold fork cost, three haiku calls, cap USD 0.25); human AC-P4W4-21 (five real parked sessions, plan usefulness)         | CHANGELOG, `docs/user/{settings,sessions,usage}.md`                                         |

**S2 and S3.** Tests first, as for S1. S2: `tests/companion/plan-store.test.ts` → AC-P4W4-24 (an edit is shown, the captured lines are kept), -25 (a new turn deletes the edit with the plan); then `planEdit` and the Edit control in the preview (`design.md` §6 first). S3: `resources/companion/tests/plan-capture.test.ts` → AC-P4W4-26 (a failed title never fails the capture), -27 (no `model.complete` call while `plan.title` is off); then `$.model.complete` and the `plan.title` key (default off). Labels: S2 and S3 carry a CHANGELOG line each (the Edit control and the title are user-visible once the switch is on); S1 carries the wave's `Added` entry.

**Pipeline.** Each slice: `scripts/ci/local-pipeline.sh --base <branch below> --with-cli --with-e2e`; S1's base is `feat/t389-p2w1-command-channel`.

**Boot packet (paste with a dispatch line `Slice: S1`, `Slice: S2` or `Slice: S3` above it; do only that slice)**

```text
Objective: the resume micro-plan (spec P4W4). S1: route every park through one coordinator (requestPark); when the plan switch is on and the session is idle with a live lease, capture three lines through $.model.fork (default mode idle, while the cache is warm; mode park only under a context ceiling) and show them read-only in the hover preview. S2: an Edit control. S3: an optional title through $.model.complete. Switch off by default; nothing changes for legacy sessions.
Setup: new worktree, branch and base from the plan table (S1 from feat/t389-p2w1-command-channel; S2 on S1; S3 on S2); npm ci. For S1 check that P1W6 S3 (telemetry-store.ts, recordAuxSpend) is in the ancestry.
Read first: docs/specs/T389-companion-mod/P4W4-resume-micro-plan.md; 01-contract.md 9 and 11.5; design.md section 6 (Hibernation policy, Hover preview); plan P4-surface-and-governance.md (P4W4); master plan section 9.
May touch: src/main/companion/{plan-*,park-coordinator}.ts, src/main/pty.ts, resources/companion/**, src/preload/index.ts, stores/sessions.ts, SessionPreview.vue, FolderViewSessions.vue, HibernationPolicyPane.vue, design.md, en.json, pt-BR.json, docs/user/{settings,sessions,usage}.md, CHANGELOG.md, tests/**.
Satisfy: S1: AC-P4W4-1 to -23 (-21 human). S2: -24, -25. S3: -26, -27.
Skills: /local-ci, plugin-authoring, superpowers:test-driven-development (if available; otherwise follow test-first as listed).
Out of scope: who gets parked, the plan in any MCP verb, push, voice or digest, injecting the plan into a resumed session, capture for headless or synthetic sessions.
Return: pipeline JSON (cli and e2e), AC table, recipe logs and cost, rev-list count, Spec defects.
Autonomy: decide within the spec, do not ask, commit each plan step before reporting.
```

---

## P4W5 — Compaction digest and durable context (four slices)

The spec lists the four slices (§13) but assigns no AC ids; the mapping is this plan's.

| Slice | Branch                                | Base                                | Scope                                                                                                          | ACs                                                        |
| ----- | ------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| S1    | `feat/t389-p4w5-compaction-digest-s1` | `feat/t389-p2w4-live-context-guard` | the `session.compact` hook as a pass-through sensor, `compact.done` and spend (no summary on the wire)         | AC-P4W5-3, -4, -5, -6, -7, -26                             |
| S2    | `…-s2`                                | S1                                  | durable rows through the result `messages`, the `harnu.mission` document, the mission notifier, re-issue rules | AC-P4W5-1, -2, -15, -17, -18, -19, -20, -25, -27, -28, -29 |
| S3    | `…-s3`                                | S2                                  | the own-compaction path and the classic fallback, removing P2W4's deferred append and `reinject` key           | AC-P4W5-8, -9, -21, -22, -23, -30                          |
| S4    | `…-s4`                                | S3                                  | the `recap` switch: summary on the wire, classifier, refusal warning, recap in project memory                  | AC-P4W5-10, -11, -12, -13, -14, -16; human -24             |

Spec: `docs/specs/T389-companion-mod/P4W5-compaction-digest.md` · contract §8, §9, §22. Size: L (30 ACs, four PRs). Agent-facing: yes. Gate for S2: AC-P4W5-20 green and LV-P4W5-b recorded. Default-on of `recap` is an operator confirmation point.

**Files.** Mod: `resources/companion/hooks/register.ts` (`onCompact`, `onPostCompact`, `afterOwnCompact`, `appendDurable`; removes P2W4's `source: compact` step and the `reinject` key; one `session.compact` body in the order of contract §11.4). Host: new `src/main/companion/{compact-summary-core,compact-adapter,mission-context}.ts`; extend P2W4's `context-registry.ts` (`harnu.mission`: a pointer with a mission id, never a title, R29) and `context-injector.ts` (re-issue rules for `beforeHello`, `onRebound`, `onCompactDone`; ledger fields `appendedAt` and `lostAfter`; still the only issuer); `src/main/memory-digest.ts` (export `digestOnCompaction(input)`, `maybeDigest` takes an optional recap); `src/main/mcp/digest-core.ts` (`DigestEndReason` gains `'compacted'`, `:248`; a "Compaction recap" section). Settings region switches (`recap`, `context`), six keys, `harnu-features.md` + marker, `docs/user/{project-memory,sessions,troubleshooting}.md`, `design.md`, CHANGELOG.

**Steps**

| #   | Slice | Commit group             | Tests first (file → ACs)                                                                                                                                                                                                                                                                                                   | Then                                                                                                                          |
| --- | ----- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1   | S1    | sensor                   | `resources/companion/tests/compact.test.ts` → AC-P4W5-3 (passes input as received), -4 (`precompute` and subagent), -5 (a veto), -6 (fails to the engine result), -7 (withholds the summary while `compactSummary` is unset), -26 (inert after the kill switch); add a unit test for `recordAuxSpend({kind:'compaction'})` | the hook, `compact.done` with `summaryChars`, spend into P1W6's ledger                                                        |
| 2   | S2    | durable rows             | `compact.test.ts` → AC-P4W5-1, -2; `tests/companion/context-injector.test.ts` → AC-P4W5-15, -25, -29; `context-registry.test.ts` → AC-P4W5-27; `mission-context.test.ts` → AC-P4W5-28; `tests/cli/compact.cli.test.ts` → AC-P4W5-20 (haiku, three calls)                                                                   | rows through `messages`, `harnu.mission`, notifier, re-issue rules; LV-P4W5-b steps 1 to 5 and LV-P4W5-c (AC-17, -18, -19)    |
| 3   | S3    | own compaction, fallback | `compact.test.ts` → AC-P4W5-8, -9                                                                                                                                                                                                                                                                                          | `afterOwnCompact`, `classic.PostCompact` fallback; LV-P4W5-a steps 5 and 7 (AC-21, -22), LV-P4W5-b steps 6 and 7 (AC-23, -30) |
| 4   | S4    | recap                    | `compact.test.ts` (the opted-in case: the summary crosses the wire only when `recap` is on); `compact-summary-core.test.ts` → AC-P4W5-10; `compact-adapter.test.ts` → AC-P4W5-11, -14, -16; `tests/memory-digest-compaction.test.ts` → AC-P4W5-12, -13                                                                     | classifier, adapter, `digestOnCompaction`, the switch, the refusal warning; human AC-P4W5-24 (a week in a real repo)          |

**Labels per slice.** S1 (a sensor and spend accounting, nothing visible) and S3 (re-injection path swap): `no-changelog`. S2: CHANGELOG `Fixed` (an orchestrator keeps its contract after it compacts), `harnu-features.md` + marker, `docs/user/sessions.md`. S4: CHANGELOG `Added` (recap, off by default), `design.md`, the six keys in both locales, `docs/user/{project-memory,troubleshooting}.md`.

**Pipeline.** Each slice: `scripts/ci/local-pipeline.sh --base <branch below> --with-cli --with-e2e` (S1 and S3 add `--labels no-changelog`); model calls only behind `HARNU_CLI_LIVE=1` (cap USD 1.00 for LV-P4W5-b).

**Boot packet (paste with a dispatch line `Slice: S1`, `S2`, `S3` or `S4` above it; do only that slice)**

```text
Objective: compaction digest and durable context (spec P4W5). S1: hook session.compact as a pass-through sensor (never an instruction to the summarizer, never an append inside the hook), emit compact.done, account its spend. S2: re-inject durable context rows through the compaction result messages, add the mission pointer and the re-issue rules. S3: the own-compaction path and the classic fallback. S4: the opt-in recap in project memory.
Setup: new worktree, branch and base from the plan table (S1 from feat/t389-p2w4-live-context-guard; each next slice on the one before); npm ci. For S1 check that P1W6 S3 (recordAuxSpend) is in the ancestry. Do not merge: the operator merges after the kill-criteria review.
Read first: docs/specs/T389-companion-mod/P4W5-compaction-digest.md; 01-contract.md 8, 9, 22; plan P4-surface-and-governance.md (P4W5); master plan section 9; run /harnu-awareness before docs/harnu-features.md (S2).
May touch: resources/companion/**, src/main/companion/{compact-*,mission-context,context-*}.ts, src/main/memory-digest.ts, src/main/mcp/digest-core.ts, the settings region, design.md, en.json, pt-BR.json, docs/harnu-features.md, docs/user/{project-memory,sessions,troubleshooting}.md, CHANGELOG.md, tests/**.
Satisfy: S1: AC-P4W5-3 to -7, -26. S2: -1, -2, -15, -17 to -20, -25, -27 to -29. S3: -8, -9, -21 to -23, -30. S4: -10 to -14, -16 (-24 human).
Skills: /local-ci, /harnu-awareness, plugin-authoring, superpowers:test-driven-development (if available; otherwise follow test-first as listed).
Out of scope: an operator compact button, rewriting instructions or messages on the way down, a skip, legacy PreCompact or PostCompact HTTP hooks, subagent or fork compaction, hot.md changes, T195.
Return: pipeline JSON, AC table, recipe logs and cost, rev-list count, Spec defects.
Autonomy: decide within the spec, do not ask, commit each plan step before reporting.
```

---

### Spec defects touching P4

- P4W4's S2 and S3 had no AC; the plan review added AC-P4W4-24 to -27 to the spec and mapped them here. P4W5 names four slices without assigning ACs; the mapping above is this plan's, with AC-P4W5-7 moved to S1 because the default (no summary on the wire) is established there.
- P4W1 part A is specified as independent of the companion, yet three of its ACs (AC-P4W1-9, -14, -15) need P1W2 or P1W4's probe; the plan attaches them after the join rebase.
- `tests/companion/contract.test.ts` is now owned by P1W1; P4W2 appends a case.
