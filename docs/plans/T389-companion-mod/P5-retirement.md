# T389 P5 — Retirement: implementation plan

**Wave:** P5W1 (legacy seam demotion), delivered as one stacked branch per release step · **Master plan:** [`00-master-plan.md`](00-master-plan.md) · **Spec:** `docs/specs/T389-companion-mod/P5W1-legacy-retirement.md`

**Nothing is deleted in this wave** (ARB-8, spec §7.6). It demotes legacy seams from "always installed" to "automatic" on evidence, adds an exact machine cleanup, and freezes the legacy modules. A step ships in its own release, only when its family has been `active` for all folders for 30 days (RG-a) with its owned-session minimum, the tested ceiling moved at least twice (RG-b), the ledger has zero unexplained divergences (RG-c) and the reversibility drill passes (RG-d). A step never ships in the release that flips its family. The retirement gate and per-step minimums are in master plan §7; common definition of done and executor hygiene are in §9.

**This wave is calendar-bound.** Its executor work is small (six code steps) but each step waits on a 30-day soak of a family that is `active`. Do not start a step early to "get ahead": a step whose family has not flipped is not taken.

## Order of releases

| Release | Branches (stacked, each base = the one before)                                                                     | Waits for                                                                      |
| ------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| R0      | run LV-P5W1-e on `main` before any change (F5: what the guard registration leaves behind today); record the answer | nothing                                                                        |
| R1      | `s0-retirement-core`, `pre-blob-events`, `pre-guard-registry` (all behaviour-neutral)                              | P1W4's ledger, P2W4 and P3W1 merged                                            |
| R2      | `h1-observe-events`                                                                                                | `taskState` RG, R1 shipped one release earlier (R28)                           |
| R3      | `c1-collapse-heuristics`                                                                                           | `identity` RG                                                                  |
| R4      | `s1-statusline-auto`                                                                                               | `telemetry` and `planUsage` RG, AC-P5W1-8 green (R14)                          |
| R5      | `g1-guard-on-demand`                                                                                               | `guard` RG, R1's registration ledger and discovery shipped one release earlier |
| R6      | `m1-messaging-socket`                                                                                              | `message` RG and master Q16 settled                                            |
| R7      | `h2-decide-events`                                                                                                 | `approval` RG, AC-P5W1-12 and -9, the blob's decide events shipped in R1       |

Branch names are `feat/t389-p5w1-<id>`. U1 (`/usage` poll), P1 (paste gate and watchdog) and B1 (the bridge responder) have no code in this wave: P1W6 and P2W2 already limit the first two, and B1 is not demoted further. The spec's numbers (200, 200, 200, 50, 100, 100) are the migration paper's proposals and are "tuned once, in the plan, before H1": the plan adopts them unchanged, and the operator may change them in the H1 go/no-go PR comment from the first real ledgers.

**Operator decision OD-3** (recorded: a notice, then automatic removal when the machine's ledger passes RG) is needed before R2.

## Common to every step

- **Pipeline.** `scripts/ci/local-pipeline.sh --base <branch below> --with-cli --with-e2e --json <path>` for every step that touches UI (S0 has none; H1 adds the Legacy integration list).
- **Tests.** `tests/companion/retirement-core.test.ts` (S0) is the pure table every step extends; `resolveLegacyInstall` answers `install: true` whenever legacy is authoritative: companion mode `off`, the step's family in `shadow` for any folder, or a CLI gate of `below`, `unknown` or `above`.
- **Live-verify** runs on a second isolated instance with a throwaway `CLAUDE_CONFIG_DIR` (recipes LV-P5W1-a to -e).
- **Docs per release.** CHANGELOG; `docs/user/{settings,troubleshooting,approval-inbox,usage}.md` as each step touches them; `docs/hook-bridge-integration.md` is rewritten once (the blob as default carrier, the opt-in global install); `design.md` §6 and §8; keys in both locales.
- **Never in a PR.** Deleting a module, touching anything Harnu did not write, hardening the bridge's port, a per-session `statusLine`, raising the minimum CLI, removing `<path>.backup` files.

---

## R1 — S0 foundation, and the two preconditions

### S0 — `retirement-core` (branch `feat/t389-p5w1-s0-retirement-core`, base: the P3W2 tip or `main` once P1 to P3 are merged)

**Files.** New `src/main/companion/retirement-core.ts` (`resolveLegacyInstall(prefs, summaries, step)`, `ledgerSummary(stream, windowMs)` on P1W4's `parityReport` and the recorded `OwnReason`; the closed `LegacyInstallReason` list), prefs types in `hook-bridge.ts` and `statusline.ts` (an absent `enabled` stays "on" until a step changes the default), a `FALLBACK (T389): frozen` header naming its fallback rows on each legacy module of spec §7.3, and `tests/legacy-freeze.test.ts`.

| #   | Commit group   | Tests first (file → ACs)                                                                                                                                                                        | Then                                       |
| --- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 1   | decision table | `tests/companion/retirement-core.test.ts` → AC-P5W1-1, -2 (kill switch restores legacy), -3 (managed machines keep legacy), -23 (shadow keeps legacy), -24 (kill switch restores the footprint) | `retirement-core.ts`; nothing reads it yet |
| 2   | freeze         | `tests/legacy-freeze.test.ts` → AC-P5W1-20 (every module of §7.3 and ARB-8 is present)                                                                                                          | the headers; no behaviour change           |

**Labels.** `no-changelog` (no behaviour change).

### PRE-A — the blob gains events (branch `feat/t389-p5w1-pre-blob-events`, base S0)

The per-session `--settings` blob gains `StopFailure` first (precondition of H1, R28), then the decide events `PreToolUse` and, only if live-verify shows the blob carries its decision, `PermissionRequest` (precondition of H2). While the global install still carries them too, the bridge joins a second POST with the same `session_id` and `tool_use_id` to the pending decision of the first.

| #   | Commit group   | Tests first (file → ACs)                                                                                                                                 | Then                                                                                    |
| --- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 1   | duplicate join | `tests/hook-bridge.test.ts` → AC-P5W1-9 (duplicate decision events join; R7)                                                                             | join logic in `hook-bridge.ts` keyed on `session_id` and `tool_use_id`                  |
| 2   | one carrier    | `tests/hook-settings-blob.test.ts` → AC-P5W1-7 (the observe and decide split: before H2, after H2 with injection on, after H2 with the global switch on) | `hook-settings-blob.ts` gains `StopFailure` and the decide set, behind the carrier rule |
| 3   | live-verify    | LV-P5W1-d → AC-P5W1-12 (does a `PermissionRequest` handler in the blob carry a decision, interactively?)                                                 | the answer decides whether H2 moves `PreToolUse` alone                                  |

**Labels.** `no-changelog` unless the blob change is user-visible.

### PRE-B — the guard registration ledger (branch `feat/t389-p5w1-pre-guard-registry`, base PRE-A)

`<userData>/orchestrator-guard/registered.json` (`{ [folder]: { at } }`) written by `ensureGuardHookRegistration`, plus a one-time discovery pass over every folder Harnu knows (pinned folders, their worktrees, folders named in `armed.json`) using `hasHookEntry`. Files: `src/main/orchestrator-guard.ts`. A folder Harnu no longer knows cannot be found; the user docs give the manual step. Tests: add cases beside `tests/orchestrator-guard.test.ts`. `no-changelog`.

**Boot packet (R1, all three branches)**

```text
Objective: the behaviour-neutral foundation of P5W1 (spec P5W1): S0 retirement-core with the closed decision table and the frozen-module headers; PRE-A the per-session blob gains StopFailure and the decide events with a bridge join on session_id and tool_use_id; PRE-B the guard registration ledger and discovery pass. No default changes and nothing is deleted.
Setup: new worktrees stacked in order from the P3W2 tip (or main once P1 to P3 are merged): feat/t389-p5w1-s0-retirement-core, then feat/t389-p5w1-pre-blob-events, then feat/t389-p5w1-pre-guard-registry; npm ci.
Read first: docs/specs/T389-companion-mod/P5W1-legacy-retirement.md sections 7.1 to 7.4, 7.6; plan P5-retirement.md; master plan section 9.
May touch: src/main/companion/retirement-core.ts, hook-bridge.ts, hook-settings-blob.ts, orchestrator-guard.ts, statusline.ts (prefs types only), header comments on the legacy modules, tests/**.
Satisfy: AC-P5W1-1, -2, -3, -7, -9, -12, -20, -23, -24; recipe LV-P5W1-d (and LV-P5W1-e on main first).
Skills: /local-ci, superpowers:test-driven-development (if available; otherwise follow test-first as listed).
Out of scope: any default change, any cleanup, UI, deleting any module.
Return: pipeline JSON per branch, AC table, LV-P5W1-d and -e logs with claude --version, rev-list counts, Spec defects.
Autonomy: decide within the spec, do not ask, commit each plan step before reporting.
```

---

## R2 — H1: global hook install, observation events

| Field  | Value                                                                     |
| ------ | ------------------------------------------------------------------------- |
| Branch | `feat/t389-p5w1-h1-observe-events` (base PRE-B)                           |
| Gate   | `taskState` RG with 200 owned sessions; PRE-A shipped one release earlier |
| ACs    | AC-P5W1-4, -5, -14, -15, -16, -18, -19                                    |

**Files.** `src/main/hook-installer.ts` (`EVENT_SPECS` splits into an observe set and a decide set), `src/main/hook-bridge.ts` (`:364-376`; `hook-prefs.json`: `enabled?` absent means automatic, `observeOutside?`), `retirement-core.ts` (the H1 row), boot cleanup (the six observe handlers leave `settings.json`; exact for this instance, dead-port orphans pruned as today), the Settings → Integrations "Legacy integration" list (each artifact with its state and one "Remove from this machine" button behind the existing confirm dialog), `claude-settings.ts` writes through `updateClaudeSettings` (lock, corrupt-file guard, atomic rename). UI: `design.md` §6 and §8 first, then keys.

| #   | Commit group      | Tests first (file → ACs)                                                                                                                                                                                                                          | Then                                                                      |
| --- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1   | prefs             | `tests/hook-bridge.test.ts` → AC-P5W1-4 (explicit prefs are honoured: an operator who used the switch keeps exactly that)                                                                                                                         | prefs read in the bridge                                                  |
| 2   | split and cleanup | `tests/hook-reconcile.test.ts` → AC-P5W1-5 (automatic cleanup is instance-exact: a live peer's and a foreign hook are never touched); `tests/claude-settings-write.test.ts` → AC-P5W1-19 (a corrupt file is left byte-identical)                  | observe and decide sets, `resolveLegacyInstall` call sites, boot cleanup  |
| 3   | UI (design first) | e2e                                                                                                                                                                                                                                               | Legacy integration list, the remove action, notice for OD-3               |
| 4   | live-verify       | LV-P5W1-a steps 4 to 7 (AC-14, -15: automatic, then companion mode `off` restores the legacy artifact for the next spawn) and steps 8 to 9 (AC-18, screenshot); LV-P5W1-b (AC-16: a CLI below 2.1.287 after the step still runs a turn on legacy) | CHANGELOG `Changed`, user docs, rewrite `docs/hook-bridge-integration.md` |

**Boot packet**

```text
Objective: P5W1 step H1 (spec P5W1 7.3 row H1): split the global hook install into an observe set and a decide set; on automatic (absent enabled) the global install carries the decide set only and the six observe handlers are removed at the next boot, exactly (this instance's entries and dead-port orphans only); add the Legacy integration list with an operator "Remove from this machine". Companion mode off, a family in shadow, or a CLI gate other than ok restores the install.
Setup: new worktree stacked on feat/t389-p5w1-pre-guard-registry, branch feat/t389-p5w1-h1-observe-events; npm ci. Go only if the taskState retirement gate holds on maintainers' machines and PRE-A shipped a release earlier.
Read first: docs/specs/T389-companion-mod/P5W1-legacy-retirement.md; plan P5-retirement.md; master plan sections 7 and 9; design.md section 6.
May touch: src/main/{hook-installer,hook-bridge,claude-settings}.ts, src/main/companion/retirement-core.ts, SettingsDialog.vue (Legacy integration list), design.md, en.json, pt-BR.json, docs/user/{settings,troubleshooting}.md, docs/hook-bridge-integration.md, CHANGELOG.md, tests/**.
Satisfy: AC-P5W1-4, -5, -14, -15, -16, -18, -19 (and the table rows of AC-P5W1-1, -2, -3 for H1).
Skills: /local-ci, superpowers:test-driven-development (if available; otherwise follow test-first as listed).
Out of scope: the decide set, C1, S1, G1, M1, H2, deleting any module, anything Harnu did not write.
Return: pipeline JSON (cli and e2e), AC table, recipe logs with claude --version, screenshot, rev-list count, Spec defects.
Autonomy: decide within the spec, do not ask, commit each plan step before reporting.
```

---

## R3 — C1: synthetic-collapse heuristics

Branch `feat/t389-p5w1-c1-collapse-heuristics` (base H1). Gate: `identity` RG, 200 spawns, zero wrong binds, every owned spawn hello-bound. Files: `src/renderer/src/stores/sessions.ts` (`collapseSyntheticInto` at about `:4917`, `collapseResolvedSynthetics` and the window at about `:5051-5115`, `:507`): a synthetic whose spawn token was redeemed is never offered to either function; they run only after P1W3's hello grace has passed. Tests first: `tests/sessions-store.test.ts` → AC-P5W1-11 ("bound spawns skip the heuristics"; guards BUG-65). No machine cleanup (renderer code). Pipeline: `--base feat/t389-p5w1-h1-observe-events --with-cli --with-e2e` (the wave edits `stores/sessions.ts`). CHANGELOG only if user-visible; otherwise `--labels no-changelog`.

```text
Objective: P5W1 step C1 (spec P5W1 7.3 row C1): make P1W3's limit unconditional so a synthetic session whose spawn token was redeemed is never offered to collapseSyntheticInto or collapseResolvedSynthetics; they run only for spawns with no hello after the grace.
Setup: new worktree stacked on feat/t389-p5w1-h1-observe-events, branch feat/t389-p5w1-c1-collapse-heuristics; npm ci. Go only if the identity retirement gate holds.
Read first: docs/specs/T389-companion-mod/P5W1-legacy-retirement.md 7.3 (C1); plan P5-retirement.md; master plan section 9.
May touch: src/renderer/src/stores/sessions.ts, tests/sessions-store.test.ts, CHANGELOG.md if user-visible.
Satisfy: AC-P5W1-11; the C1 rows of AC-P5W1-1 to -3.
Skills: /local-ci, superpowers:test-driven-development (if available; otherwise follow test-first as listed).
Out of scope: deleting the heuristics, any main-process change.
Return: pipeline JSON, AC table, rev-list count, Spec defects.
Autonomy: decide within the spec, do not ask, commit before reporting.
```

---

## R4 — S1: statusLine install becomes automatic

Branch `feat/t389-p5w1-s1-statusline-auto` (base C1). Gate: `telemetry` RG with 200 owned sessions (500 samples within one point), and AC-P5W1-8 green first. Files: `src/main/statusline-install.ts`, `src/main/statusline.ts` (`:114-124`, `:282-316`: the install and the self-heal tick follow `resolveLegacyInstall`; the statusLine is absent only when RG holds and the window has no legacy session with reason `cli-too-old`, `cli-unknown`, `no-binding` or `cli-above-ceiling`), boot cleanup (`statusLine`, `statusLine_harnu`, and the legacy `statusLine_capy` / `statusLine_om2tab`; never a foreign `statusLine`), the eight mod-less fields blank unless the operator opts in (the Settings hint names them; explicit prefs keep their behaviour). Tests first: `tests/companion/telemetry-adapter.test.ts` → AC-P5W1-8 ("usage history without the status line"; R14: `captureFleet` must be fed by the adapter); `tests/statusline-install.test.ts` → AC-P5W1-6 ("removal never touches a foreign statusLine"). Docs: `docs/user/{settings,usage}.md`. Pipeline: `--base feat/t389-p5w1-c1-collapse-heuristics --with-cli --with-e2e`.

```text
Objective: P5W1 step S1 (spec P5W1 7.3 row S1): the statusLine install becomes automatic (absent when the retirement gate holds on this machine and no legacy session in the window has a CLI or no-binding reason); the self-heal tick follows the same answer; Harnu's own statusLine entries are removed exactly. Usage history must keep working from the companion adapter first (R14).
Setup: new worktree stacked on feat/t389-p5w1-c1-collapse-heuristics, branch feat/t389-p5w1-s1-statusline-auto; npm ci. Go only if the telemetry retirement gate holds and AC-P5W1-8 is green.
Read first: docs/specs/T389-companion-mod/P5W1-legacy-retirement.md 7.3 (S1), 7.5; plan P5-retirement.md; master plan section 9.
May touch: src/main/{statusline-install,statusline}.ts, src/main/companion/retirement-core.ts, SettingsDialog.vue (hint text), design.md, en.json, pt-BR.json, docs/user/{settings,usage}.md, CHANGELOG.md, tests/**.
Satisfy: AC-P5W1-6, -8; the S1 rows of AC-P5W1-1 to -3, -16.
Skills: /local-ci, superpowers:test-driven-development (if available; otherwise follow test-first as listed).
Out of scope: deleting statusLine ingest or parse (eight fields have no mod source), a per-session statusLine through the blob, anything that is not Harnu's own entry.
Return: pipeline JSON (cli and e2e), AC table, recipe logs, rev-list count, Spec defects.
Autonomy: decide within the spec, do not ask, commit each plan step before reporting.
```

---

## R5 — G1: guard registration on demand

Branch `feat/t389-p5w1-g1-guard-on-demand` (base S1). Gate: `guard` RG with 50 armed sessions; the registration ledger and discovery pass shipped one release earlier (PRE-B). Files: `src/main/orchestrator-guard.ts` (`removeGuardHookRegistration`, `:356`, gains callers: when the folder is removed from Harnu, when its last legacy-armed session ends, and by the operator; registration is ensured only when an entry of the folder has `enforcer: 'script'`; the `armed.json` entry always stays as the role record), a toast `legacy.guardOff` for the lease-loss window (OQ2: whether a running CLI picks up a hook added mid-session). Tests first: `tests/orchestrator-guard.test.ts` → AC-P5W1-10 ("registration is removed with the folder"; keep Harnu's always-allow rules and every other key). Live-verify: LV-P5W1-c → AC-P5W1-17 (an owned orchestrator after G1: unload the mod, observe the re-arm and the toast); LV-P5W1-e (F5) on `main` was run in R0 → AC-P5W1-22 (record what a promoted-then-ended session leaves). Pipeline: `--base feat/t389-p5w1-s1-statusline-auto --with-cli --with-e2e`.

```text
Objective: P5W1 step G1 (spec P5W1 7.3 row G1): register the legacy guard hook in a folder's settings.local.json only when an armed.json entry of that folder has enforcer 'script'; remove the registration with the folder, when its last legacy-armed session ends, or on the operator's action (removeGuardHookRegistration finally gets callers). The armed.json entry always stays as the role record.
Setup: new worktree stacked on feat/t389-p5w1-s1-statusline-auto, branch feat/t389-p5w1-g1-guard-on-demand; npm ci. Go only if the guard retirement gate holds and PRE-B shipped a release earlier.
Read first: docs/specs/T389-companion-mod/P5W1-legacy-retirement.md 7.3 (G1), 7.5; plan P5-retirement.md; master plan section 9.
May touch: src/main/orchestrator-guard.ts, src/main/companion/{retirement-core,guard-adapter}.ts, the guardOff toast strings (en.json, pt-BR.json), docs/user/troubleshooting.md, CHANGELOG.md, tests/**.
Satisfy: AC-P5W1-10, -17, -22; the G1 rows of AC-P5W1-1 to -3, -16.
Skills: /local-ci, superpowers:test-driven-development (if available; otherwise follow test-first as listed).
Out of scope: deleting guard.mjs or the registration helpers, touching always-allow rules or any other settings.local.json key.
Return: pipeline JSON (cli and e2e), AC table, recipe logs, rev-list count, Spec defects.
Autonomy: decide within the spec, do not ask, commit each plan step before reporting.
```

---

## R6 — M1: messaging socket

Branch `feat/t389-p5w1-m1-messaging-socket` (base G1). Gate: `message` RG with 100 messages; master Q16 settled (P2W3). Files: `src/main/messaging-socket.ts`, `src/main/messaging.ts`: the re-verification ritual stops; `MESSAGING_SOCKET_VERIFIED_CEILING` records the last CLI release the resolver was re-read on; a recipient with no lease on a newer CLI is refused with `PEER_NO_SOCKET` instead of being written to on an unverified path. Test first: `tests/messaging-socket.test.ts` → AC-P5W1-13 ("unverified CLI is refused"). Deliberate capability reduction: messages to a legacy recipient on a future CLI. Pipeline: `--base feat/t389-p5w1-g1-guard-on-demand --with-cli` (AC-P5W1-16 is a live-verify run on a CLI below the ceiling; the step touches no renderer file). CHANGELOG `Changed`.

```text
Objective: P5W1 step M1 (spec P5W1 7.3 row M1): stop the messaging-socket re-verification ritual. Record MESSAGING_SOCKET_VERIFIED_CEILING; a recipient with no lease on a CLI newer than it is refused with PEER_NO_SOCKET instead of written to on an unverified path. Messaging-socket modules stay (frozen), nothing is deleted.
Setup: new worktree stacked on feat/t389-p5w1-g1-guard-on-demand, branch feat/t389-p5w1-m1-messaging-socket; npm ci. Go only if the message retirement gate holds and master Q16 is settled.
Read first: docs/specs/T389-companion-mod/P5W1-legacy-retirement.md 7.3 (M1); plan P5-retirement.md; master plan section 9.
May touch: src/main/messaging-socket.ts, messaging.ts, src/main/mcp/tool-handlers.ts (the refusal code), docs/harnu-features.md only if the ACK or error text an agent reads changes (then bump the marker), CHANGELOG.md, tests/**.
Satisfy: AC-P5W1-13; the M1 rows of AC-P5W1-1 to -3, -16.
Skills: /local-ci, /harnu-awareness (if an agent-visible code changes), superpowers:test-driven-development (if available; otherwise follow test-first as listed).
Out of scope: deleting the resolver, any change for a leased recipient.
Return: pipeline JSON, AC table, rev-list count, Spec defects.
Autonomy: decide within the spec, do not ask, commit before reporting.
```

---

## R7 — H2: global hook install, decision events

Branch `feat/t389-p5w1-h2-decide-events` (base M1). Gate: `approval` RG with 100 held decisions and none fail-open; AC-P5W1-12 and -9; the blob's decide events shipped in R1. Behaviour: the decide set moves into the per-session blob (`PreToolUse` always; `PermissionRequest` only if AC-P5W1-12 showed the blob carries its decision, else it stays in the global install and H2 demotes `PreToolUse` alone); on automatic nothing that moved is installed globally; an operator switch keeps the global decide set for outside sessions and then the blob omits it (one carrier per session); a session with a user `--settings <file>` is counted as `user-settings-file` and, while the count is above zero in the window, automatic keeps the global install. Files: `hook-installer.ts`, `hook-settings-blob.ts`, `hook-bridge.ts` (`:160-193` stays; join on `tool_use_id`), `pty.ts` (record `user-settings-file`), `retirement-core.ts`. Tests: AC-P5W1-7 and -9 extended for the carrier rule; LV-P5W1-a steps 4 to 7 (AC-14, -15) and LV-P5W1-b (AC-16) re-run with every step applied. Docs: `docs/user/{approval-inbox,troubleshooting}.md` (approvals for outside sessions are opt-in), `docs/hook-bridge-integration.md`. Human AC-P5W1-21 (the operator's machine after 30 days on automatic, side-by-side screenshot) is listed for the Delivery Report. Pipeline: `--base feat/t389-p5w1-m1-messaging-socket --with-cli --with-e2e`.

```text
Objective: P5W1 step H2 (spec P5W1 7.3 row H2): move the decide events out of the global hook install into the per-session blob (PreToolUse always; PermissionRequest only if AC-P5W1-12 proved the blob carries its decision). On automatic nothing that moved is installed globally; one carrier per session; the bridge joins duplicate POSTs on tool_use_id; a session with a user --settings file keeps the global install on this machine while counted.
Setup: new worktree stacked on feat/t389-p5w1-m1-messaging-socket, branch feat/t389-p5w1-h2-decide-events; npm ci. Go only if the approval retirement gate holds, AC-P5W1-12 is answered, and the blob's decide events shipped in R1.
Read first: docs/specs/T389-companion-mod/P5W1-legacy-retirement.md 7.3 (H2), 7.4, 8; plan P5-retirement.md; master plan section 9.
May touch: src/main/{hook-installer,hook-settings-blob,hook-bridge,pty}.ts, src/main/companion/retirement-core.ts, docs/user/{approval-inbox,troubleshooting}.md, docs/hook-bridge-integration.md, design.md, en.json, pt-BR.json, CHANGELOG.md, tests/**.
Satisfy: AC-P5W1-7, -9, -12, -14, -15, -16; the H2 rows of AC-P5W1-1 to -3; human -21 listed.
Skills: /local-ci, superpowers:test-driven-development (if available; otherwise follow test-first as listed).
Out of scope: Sentinel or the resolver chain, the bridge responder (B1, not demoted), deleting any module.
Return: pipeline JSON (cli and e2e), AC table, recipe logs, rev-list count, Spec defects.
Autonomy: decide within the spec, do not ask, commit each plan step before reporting.
```

---

### Spec defects touching P5

- Master spec §4 says P5W1 has "nine steps"; the spec table has nine rows but only six have code (H1, C1, S1, G1, M1, H2); U1, P1 and B1 are "none here". The plan treats six code steps plus three preconditions (blob events, registration ledger, retirement core).
- The spec says the step minimums are "tuned once, in the plan, before H1" but supplies no data to tune against; the plan adopts the proposals unchanged and leaves a go/no-go review to the operator.
- LV-P5W1-e is specified "on `main` before this wave" with no owner step; the plan makes it release R0.
