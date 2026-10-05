# P5W1 — Legacy seam demotion

## 1. Status

Specified, not implemented · 2026-10-02 · Epic T389 · The last wave. Each step below starts only
after its fact family has flipped to `active` and its own gate holds.

Verified against repo `main` @ `46d70c7d` (line references re-checked after the Harnu rename; the earlier base `b35a2c06` is not in this repository) and Claude Code CLI 2.1.287. Line references are to the
files at that commit.

## 2. Depends on / Unblocks

- **Depends on:** the flip gate of each family (P1W3 `identity`, P1W5 `taskState`, P1W6
  `telemetry` / `planUsage`, P2W2 `startPrompt`, P2W3 `message`, P2W4 `guard`, P3W1 `approval`);
  P1W4's parity ledger (`parityReport`, the recorded `OwnReason`), `companion-prefs.json` and
  `companionStatus()`; P1W2's `cliGate` and the tested ceiling; P2W4's guard adapter
  (`ArmedEntry.enforcer`). Soft: P4W3 (the external profile decides what an outside session
  counts as, §7.2). The steps are independent: a step whose family has not flipped is not taken.
  Base branch: one stacked branch per step.
- **Owns** (master §12): `resolveLegacyInstall` and `ledgerSummary` in
  `src/main/companion/retirement-core.ts`.
- **Owned open question:** master Q32 (should agent prompts under the argv budget also move to
  the companion later; default no, D9), §14.
- **Unblocks:** nothing.

## 3. Summary

**The end state keeps two stacks.** A session on a CLI below 2.1.287, on a machine whose
organization blocks user mods, under the kill switch, after a mid-session unload, started outside
Harnu, or with no process at all, runs on the legacy seams, permanently (ADR-0018, decision 2).
This wave does not remove that stack. It does three smaller things:

1. **It shrinks Harnu's footprint on the user's machine.** Today Harnu writes hooks and a
   `statusLine` into `~/.claude/settings.json` on every boot, and leaves a guard hook in each
   orchestrated folder's `.claude/settings.local.json` for good. Afterwards those writes happen
   only when the operator asks or a session needs the fallback, and Harnu removes what it no longer
   needs.
2. **It freezes the legacy modules**: fixes and CLI-compatibility work only.
3. **It states what is never deleted, what may be deleted later, and on which evidence.**

No module is deleted in this wave. Steps change defaults and clean the machine; §7.8 names what a
later change may delete.

## 4. Evidence

| Source                                                    | What it shows                                                                                                                                                                                                                                                    | Verdict                       |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| smoke A3                                                  | `session.measure` equals the statusLine figures; lines ±, thinking, output style and PR have no mod source; model display name untested                                                                                                                          | CONFIRMED; full cover REFUTED |
| smoke A5                                                  | A mod that fails to load is silent in an interactive session; hook failures are fail-open: absence is the only signal                                                                                                                                            | CONFIRMED                     |
| smoke D7 (with D4, D5)                                    | Summed `turn.complete` usage equals the CLI total; fork, complete and compaction spend is in no `turn.complete`, so the JSONL scan stays the cross-check                                                                                                         | CONFIRMED; USD PARTIAL        |
| evidence §1 (the confound), C2                            | The live bridge added about 3.5 s under every tool call in runs A, B and D: the global `PreToolUse` hook is paid by every session on the machine                                                                                                                 | observed                      |
| `hook-bridge.ts:304-307`, `:364-376`                      | Global hooks are opt-out (default on), reconciled at every boot; a disabled boot already takes a prune-only path                                                                                                                                                 | code                          |
| `hook-bridge.ts:385-395`, `:534-543`                      | Own entries are removed on exit, token-scoped. `docs/hook-bridge-integration.md` §3 still says they are left in place                                                                                                                                            | code; the doc is stale        |
| `hook-installer.ts:41-51`, `hook-settings-blob.ts:90-102` | The global set has `StopFailure`, `PreToolUse *` and `PermissionRequest`; the per-session blob has none of the three                                                                                                                                             | code                          |
| `hook-settings-blob.ts:176-185`                           | A user `--settings <file>` makes Harnu skip its blob: that session is observed only through the global install                                                                                                                                                   | code                          |
| `statusline-install.ts:94-124`                            | A foreign `statusLine` is never overwritten; Harnu stashes **its own** config under `statusLine_harnu` (the legacy `statusLine_capy` and `statusLine_om2tab` backup keys are still recognized and dropped). No user value is backed up, because none is replaced | code                          |
| `statusline.ts:169-188`; lesson framework/005             | A 60 s self-heal re-installs a vanished `statusLine`; exit cleanup must be instance-exact                                                                                                                                                                        | code, lesson                  |
| `orchestrator-guard.ts:356-364`                           | `removeGuardHookRegistration` exists and has **no caller**                                                                                                                                                                                                       | code (`grep`)                 |
| `messaging-socket.ts:14-36`                               | The socket path mirrors a private function of the CLI binary, last re-read on 2.1.241                                                                                                                                                                            | code                          |
| lessons framework/002, /004                               | Claude Code strips unknown keys from hook handlers (identity is the URL shape); an `http` hook's response body decides, proven for `PreToolUse` only                                                                                                             | lesson                        |

## 5. Deviations from the study

| Study claim ("what falls into disuse")                                                                                                                                  | Deviation                                                                                                             | Basis                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| The installer, the HTTP bridge, the statusline install, the `/usage` parser, the messaging socket, the paste gate, `guard.mjs` and the collapse window fall into disuse | None is deleted. Each becomes the fallback and, where it writes to the user's machine, opt-in or on-demand            | D4; ARB-8; ADR decision 2 |
| statusline "replaced"                                                                                                                                                   | D11: demoted. The install becomes automatic or opt-in; the ingest stays for the fields with no mod source             | smoke A3                  |
| The HTTP bridge falls into disuse                                                                                                                                       | It gains work: after step H2 the per-session blob carries the decision events, and the bridge is their only transport | §7.3                      |

## 6. Scope / Non-goals

**In scope.** The demotion steps for nine seams; the retirement gate; machine cleanup; the "Legacy
integration" controls; the never-delete list; the maintenance policy and kill criteria; a rewrite
of `docs/hook-bridge-integration.md`.

**Non-goals.**

- Deleting any module.
- Touching anything Harnu did not write: cleanup removes only entries that match Harnu's identity
  rules.
- Hardening the legacy bridge (a persisted port, a rendezvous file). Its stale-port orphaning
  stays a known defect, pruned at boot as today.
- A per-session `statusLine` through the `--settings` blob: it would override the user's own
  status line inside Harnu's terminal, which today's install never does.
- Raising the minimum supported CLI (a product decision; §7.8).
- Removing the `<path>.backup` files beside `settings.json` (`claude-settings.ts:201`,
  `hook-installer.ts:299-314`): they hold the user's own settings.

## 7. Design

**Contract additions:** none. This wave changes no wire shape.

### 7.1 Two decisions, two kinds of evidence

Harnu sends no telemetry off the machine, so the evidence lives in two places.

| Decision                                                                            | Taken by                                  | Evidence                                                                                            |
| ----------------------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **Release default**: a seam's default changes from "always" to "automatic"          | maintainers, in the release that ships it | the family's committed parity fixtures (QA-9), its flip gate, and RG below on maintainers' machines |
| **Machine cleanup**: Harnu stops writing an artifact on this machine and removes it | Harnu main, at boot and on demand         | this machine's parity ledger over the soak window                                                   |

**Retirement gate (RG)**, the same four clauses for every step:

| Clause | Requirement                                                                                                                                |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| RG-a   | The family has been `active` for all folders for `RETIRE_SOAK_DAYS` (30), with the step's minimum of owned sessions in that window (§13)   |
| RG-b   | The tested ceiling (QA-6) moved at least twice while the family was `active`                                                               |
| RG-c   | Zero unexplained divergences in the window, and every session where legacy was authoritative carries a reason from the closed list of §7.2 |
| RG-d   | The reversibility drill passes: with the step applied, companion mode `off` restores the legacy artifact for the next spawned session      |

A machine that fails RG-a or RG-c keeps the artifact installed. That is a correct outcome: the
machine is saying it still runs on legacy.

### 7.2 What the ledger must answer

This wave reads P1W4's ledger and does not write a second one. `ledgerSummary` lives in
`retirement-core.ts` and is built on P1W4's `parityReport` and on the `OwnReason` each record
carries:

```ts
/** Why a session ran a family on legacy. Not P1W4's `LegacyReason` (the UI state reason). */
type LegacyInstallReason =
  // derived from P1W4's recorded OwnReason
  | 'mode-off' | 'mode-shadow' | 'off-ramp' | 'cli-above-ceiling' | 'no-binding' | 'lease-lost'
  | 'unproven' | 'revoked'
  // derived from the spawn (the CLI gate and pty.ts)
  | 'cli-too-old' | 'cli-unknown' | 'headless' | 'agent-controlled' | 'outside-harnu'
  | 'user-settings-file'

interface FamilySummary {
  stream: FactFamily
  ownedSessions: number
  legacySessions: Record<LegacyInstallReason, number>
  divergences: { explained: number; unexplained: number }
  activeSince: number | null // for all folders
  ceilingMoves: number
}
ledgerSummary(stream: FactFamily, windowMs: number): FamilySummary
```

- `'cli-unknown'` is the gate value `unknown` (`cliGate`, P1W2): it installs, like `'cli-too-old'`.
- `'no-binding'` on a machine with a managed policy is what the earlier draft called
  "policy-no-hello"; the cause is named only when P1W4's policy probe observed it (DOC-8).
- `'user-settings-file'` is a spawn whose `--settings` is a file path, recorded by `pty.ts`.

**Which sessions count as legacy, per family.** A session counts when the family was not owned
for it at any time in the window, with these two clarifications:

| Session kind                                     | `identity`, `taskState`, `telemetry`, `planUsage`                         | `approval`, `guard`, `startPrompt`, `message`                      |
| ------------------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Headless (`-p`, scheduler tick)                  | not legacy when owned: the headless profile has sensors (contract §16)    | not counted at all: these families do not exist for a headless run |
| Outside Harnu, external profile and corroborated | `taskState` and `telemetry` may be owned (contract §21): counted as owned | legacy (`outside-harnu`): never actuated or held by default        |
| Outside Harnu, no external profile               | legacy (`outside-harnu`), but only when Harnu's watchers saw the session  | legacy (`outside-harnu`)                                           |

### 7.3 The demotion table

Top to bottom is the order (the migration paper's, with the global install split in two).

| #   | Seam                                                                                                                                   | Demotion step                                                                                                                                                                                                                                                                                                                                                                                                              | Family        | Machine cleanup                                                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------- |
| H1  | Global hook install, **observation** events (`hook-installer.ts`, `hook-bridge.ts:364-376`)                                            | `EVENT_SPECS` splits into an observe set and a decide set. On automatic, the global install carries the decide set only. `StopFailure` is added to the per-session blob first, so a legacy session loses nothing. A switch re-adds the observe set for outside sessions                                                                                                                                                    | `taskState`   | the six observe handlers leave `settings.json` at the next boot                                         |
| C1  | Synthetic-collapse heuristics (`sessions.ts:4917`, `:5051-5115`; correlation window `:507`)                                            | P1W3 limits them to spawns with no hello. This step makes that unconditional: a synthetic whose spawn token was redeemed is never offered to `collapseSyntheticInto` or `collapseResolvedSynthetics`; they run only after P1W3's hello grace has passed                                                                                                                                                                    | `identity`    | none (renderer code)                                                                                    |
| S1  | statusLine install (`statusline-install.ts`, `statusline.ts:114-124`, `:282-316`)                                                      | The install becomes automatic: absent when RG holds and the window has no legacy session with reason `cli-too-old`, `cli-unknown`, `no-binding` or `cli-above-ceiling`. The self-heal tick follows the same answer. The eight mod-less fields are blank unless the operator opts in                                                                                                                                        | `telemetry`   | our `statusLine`, `statusLine_harnu` and the legacy `statusLine_capy` / `statusLine_om2tab` are removed |
| U1  | `/usage` poll (`usage.ts:20`)                                                                                                          | None here: P1W6 already limits it to "no leased `usage.measured` within `PLAN_USAGE_STALE_MS`". Listed for completeness                                                                                                                                                                                                                                                                                                    | `planUsage`   | none                                                                                                    |
| G1  | Legacy guard (`orchestrator-guard.ts`, `resources/orchestrator-guard/guard.mjs`)                                                       | Registration becomes on-demand: it is ensured only when an entry of the folder has `enforcer: 'script'` (ruling 6: the `armed.json` entry always stays, as the role record). A folder's registration is removed when no entry of the folder has `enforcer: 'script'`. `removeGuardHookRegistration` gets callers (§7.5)                                                                                                    | `guard`       | the guard entry leaves each known folder's `settings.local.json`                                        |
| P1  | Paste gate and watchdog (`prompt-inject-gate.ts`, `injection-watchdog.ts`, `prompt-submit.ts`, `mcp/injection-escalation-registry.ts`) | None beyond P2W2: reachable only for a spawn with no lease within the gate cap, for `@file` prompts (D9) and for resumes on legacy. Frozen                                                                                                                                                                                                                                                                                 | `startPrompt` | none                                                                                                    |
| M1  | Messaging socket (`messaging-socket.ts`, `messaging.ts`)                                                                               | The re-verification ritual stops. `MESSAGING_SOCKET_VERIFIED_CEILING` records the last CLI release the resolver was re-read on; a recipient with no lease on a newer CLI is refused with `PEER_NO_SOCKET` instead of being written to on an unverified path                                                                                                                                                                | `message`     | none                                                                                                    |
| H2  | Global hook install, **decision** events (`PreToolUse *`, `PermissionRequest`)                                                         | The decide set moves into the per-session blob: `PreToolUse` always, `PermissionRequest` only if AC-P5W1-12 shows the blob carries its decision (OQ1); otherwise `PermissionRequest` stays in the global install and H2 demotes `PreToolUse` alone. On automatic, nothing that moved is installed globally. A switch keeps the global decide set for outside sessions, and then the blob omits it: one carrier per session | `approval`    | no Harnu handler remains in `settings.json`; the boot prune of dead-port orphans stays                  |
| B1  | Hook-bridge HTTP responder (`hook-bridge.ts:160-193`, 3.5 s deadline `:51`)                                                            | **Not demoted further.** It stands down per session (ARB-9a) and stays the transport of the blob, of the opt-in global install and of Sentinel's synchronous deny                                                                                                                                                                                                                                                          | —             | none                                                                                                    |

Notes:

- **Blob preconditions (master R28).** The blob gains `StopFailure` one release before H1, and
  the decision events before H2 removes them from the global install; neither demotion ships in
  the same release as its precondition. The fallback matrix (master §8) already carries the
  three rows this changes: "Agent-controlled spawn" (approval through the session blob after
  H2), "Started outside Harnu, switch off" (the global hook becomes opt-in after H2) and "Session
  spawned with a user `--settings <file>`".
- **H1 and H2 are separate releases.** Between them every session on the machine still POSTs each
  tool call to the bridge; that cost ends at H2.
- **H2 changes the legacy path itself**, so it needs a proof that does not involve the companion: a
  `PermissionRequest` decision carried by the `--settings` blob was never validated, and the
  question is about an interactive session. AC-P5W1-12 settles it by live-verify; if it fails,
  the blob carries `PreToolUse` alone, the global install keeps `PermissionRequest`, and the
  legacy Inbox keeps today's coverage.
- **H2 and a live toggle.** A session spawned with a decide-carrying blob keeps it. If the global
  switch is turned on meanwhile, that session fires both, so the bridge joins a second POST with
  the same `session_id` and `tool_use_id` to the pending decision of the first.
- **H2 and a user `--settings <file>`.** That session gets no blob and, on automatic, no global
  hook: R-tier state and the native dialog. It is counted as `user-settings-file`, and while the
  count is above zero in the window, automatic keeps the global install on this machine.
- **S1 and usage history.** `captureFleet` is fed from statusLine ingest (`statusline.ts:247`).
  P1W6's adapter must feed it (R14) before S1 (AC-P5W1-8).
- **G1 and lease loss.** After G1 an owned session has no registration in its folder; its
  `armed.json` entry is still there as the role record, with `enforcer: 'companion'`. On lease
  loss P2W4's guard adapter rewrites the entry to `enforcer: 'script'` (ARB-9c) and this wave's
  step ensures the registration at that moment. Whether a running
  CLI picks up a hook added mid-session is OQ2; until settled, Harnu shows the `legacy.guardOff`
  toast. The guard is a drift brake that fails open by design (`orchestrator-guard.ts:8-10`); this
  is the same failure, stated.
- **M1 reduces capability on purpose**: messages to a legacy recipient on a future CLI, in
  exchange for not re-extracting a minified function each release.

### 7.4 Preferences

Both prefs files already read an absent key as the default (`hook-bridge.ts:304-307`,
`statusline.ts:86-93`), so no migration is needed:

```ts
// <userData>/hook-prefs.json
interface HookPrefs {
  enabled?: boolean // absent → automatic (was: on) · true → always install the decide set · false → never
  observeOutside?: boolean // also install the observe set; default false
  injectPerSession?: boolean // unchanged
}
// <userData>/statusline-prefs.json
interface StatusLinePrefs {
  enabled?: boolean // absent → automatic (was: on)
}
```

An operator who used either switch before has an explicit value and keeps exactly that behaviour.

`resolveLegacyInstall(prefs, summaries, step)` in `src/main/companion/retirement-core.ts` (pure)
returns `{ install, reason }` per artifact; `hook-bridge.ts` and `statusline.ts` call it where they
read `enabled` today. It answers `install: true` whenever legacy is authoritative: companion mode
`off`, the step's family in `shadow` (for any folder), a CLI gate of `below`, `unknown` or
`above`. So the kill switch restores the legacy footprint (RG-d).

### 7.5 Machine cleanup

| Artifact                                                           | What counts as ours                                                                                                                                               | Removed                                                                                                       | Never touched                               |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Hook handlers in `~/.claude/settings.json`                         | the bridge URL shape, or the `_harnu` key, or a legacy `_capy` / `_om2tab` key (`BRIDGE_URL` and `isOurs`, `hook-installer.ts:96-111`; `LEGACY_SENTINELS`, `:24`) | automatically: this instance's token and dead ports. By the operator: every handler of ours (`stripOurHooks`) | a live peer's handlers; foreign hooks       |
| `statusLine` in `~/.claude/settings.json`                          | a command matching `statusline-writer.(sh\|cmd)` (`statusline-install.ts:83-91`)                                                                                  | automatically: this instance's exact command. By the operator: the loose match                                | a foreign `statusLine`                      |
| `statusLine_harnu`, legacy `statusLine_capy` / `statusLine_om2tab` | the key name                                                                                                                                                      | with the `statusLine` removal                                                                                 | —                                           |
| Guard entry in `<folder>/.claude/settings.local.json`              | `PreToolUse`, matcher `Edit\|Write\|NotebookEdit`, command equal to `guardHookCommand()` (`orchestrator-guard.ts:230-232`)                                        | when the folder is removed from Harnu, when its last legacy-armed session ends, or by the operator            | Harnu's always-allow rules; every other key |
| `<userData>/orchestrator-guard/`, `<userData>/statusline/`         | Harnu's own directories                                                                                                                                           | never: a registration may still point at the scripts                                                          | —                                           |

There is no user `statusLine` to restore: the installer preserves a foreign one and stashes its own
config instead (`statusline-install.ts:119-123`). The user docs say that the `statusLine_harnu` key
(and the legacy `statusLine_capy` key) was Harnu's.

**Guard registrations need a ledger.** Harnu never recorded where it registered the guard. This
wave adds `<userData>/orchestrator-guard/registered.json` (`{ [folder]: { at } }`), written by
`ensureGuardHookRegistration`, and a one-time discovery pass: every folder Harnu knows (pinned
folders, their worktrees, folders named in `armed.json`) is checked with `hasHookEntry`. A folder
Harnu no longer knows cannot be found; the user docs give the manual step.

**Operator action.** Settings → Integrations → "Legacy integration" lists each artifact with its
state and one button, "Remove from this machine", behind the existing confirm dialog. It runs the
loose removals, sets `enabled: false` in both prefs files and reports what it removed. Every write
goes through `updateClaudeSettings` (lock, corrupt-file guard, backup, atomic rename,
`claude-settings.ts:181-202`); a corrupt `settings.json` is left untouched and reported.

**Uninstalling Harnu.** An AppImage has no uninstall hook and a `.deb` must not edit a home
directory, so `docs/user/troubleshooting.md` carries the manual list. A clean quit already removes
the hooks and the statusLine (`hook-bridge.ts:537`, `statusline.ts:150-161`); the guard entry is
the one that survives today.

### 7.6 Never delete

The list is ARB-8, which now includes the three items this wave asked for (the hook-bridge
server, statusLine ingest and parse, and the settings read-modify-write helpers with the hook
identity and prune functions). The reasons, per item:

| Item (ARB-8)                                                                                                        | Reason                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Transcript watcher, `transcript-truth.ts`, `stall-detect.ts`                                                        | The only source for cold, parked and outside sessions; the silence timer catches a mod that goes quiet (R11)                |
| PID-registry watcher (`session-registry-watch.ts`)                                                                  | Liveness that needs no cooperation from the process; the fallback while the host restarts                                   |
| `/usage` poll and parser                                                                                            | Plan limits when no session is live; a rate-limit-only push was never isolated (C5, CQ14)                                   |
| JSONL cost scan (`usage-cost.ts`)                                                                                   | History before the companion, legacy sessions, and the cross-check for spend that is in no `turn.complete`                  |
| Argv positional prompt                                                                                              | The default for operator prompts and the only carrier in headless runs (D9, contract §16)                                   |
| Task-state reducer (`hook-state.ts`)                                                                                | The one fold both sources feed through the hub (ARB-5)                                                                      |
| Resolver chain and Sentinel, regex engine included (`responder-dispatch.ts`, `sentinel-*`, `approval-resolver.ts`)  | Decide for both transports; a Sentinel deny must survive a mod crash (SEC-1)                                                |
| `isHibernated` guard (`hook-bridge.ts:410`)                                                                         | A dying process must not re-animate a parked row, whatever the source (T178)                                                |
| Per-session `--settings` blob (`hook-settings-blob.ts`)                                                             | The fallback of every row of the fallback matrix; after H2 also the legacy approval carrier                                 |
| Hook-bridge server (`hook-bridge.ts`)                                                                               | The blob's transport                                                                                                        |
| `claude-settings.ts`, the identity and prune functions of `hook-installer.ts`, `stripStatusLine`, `removeHookEntry` | The opt-in installs, and cleaning a machine that upgrades from any older Harnu                                              |
| statusLine ingest (`statusline.ts`, `statusline-parse.ts`)                                                          | Eight fields have no mod source: lines ±, thinking, output style, PR, model name, duration and effort (smoke A3; P1W6 §7.3) |

### 7.7 Maintenance cost

| Cost                 | Size                                                                                                                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Legacy code kept     | about 4 100 source lines in 17 files (the modules of §7.3 and `claude-settings.ts`), about 200 lines of collapse logic in `sessions.ts`, and their tests, which stay in `npm test` (QA-4) |
| Companion code added | the mod, the host, the arbiter, the ledger: more code than today, not less (ADR-0018, Consequences)                                                                                       |
| Per CLI release      | the drift contract (QA-6) for the companion; for legacy the existing CLI-assumption checks, minus the messaging resolver after M1                                                         |
| Per feature          | every fact family has two sources and one arbiter rule; a new consumer must work on both (ARB-5)                                                                                          |
| Per bug report       | two paths to reason about: the Harnu mod state (`live`, or `legacy` with its reason) belongs in every report                                                                              |

**Freeze policy.** Each legacy module gets a header `FALLBACK (T389): frozen` naming its fallback
rows. Allowed: bug fixes, CLI-compatibility fixes, the changes this spec lists. Not allowed: a
feature that exists only on legacy.

### 7.8 Kill criteria

**For legacy code** (a later change may delete; none is taken here):

| Candidate                                                                                                                                      | May be deleted when                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The `messaging-socket.ts` resolver                                                                                                             | the CLI's resolver changes after M1 and maintainers' ledgers show no socket-transport message for 60 days                                                                                          |
| Collapse heuristics, paste gate and watchdog, `guard.mjs`, the global decide install, the `curl` command transport (`hook-installer.ts:60-64`) | Harnu's minimum CLI is raised to 2.1.287 or later **and** a managed machine can allow the companion by name (ADR-0018's re-open clause). Until both hold, each serves a row of the fallback matrix |
| The statusLine install                                                                                                                         | every field of `SessionTelemetry` has a mod source, or the product drops the eight fields                                                                                                          |

The regex Sentinel engine is in ARB-8 and is not a deletion candidate, whatever P3W2's structured
engine proves.

Raising the minimum CLI is proposed no earlier than twelve months after 2.1.287, as one of
the further confirmation points of master §13.

**For the companion stack** (the reverse direction; nothing is deleted so that legacy can carry
the product alone):

1. The drift contract fails on two consecutive CLI releases and each fix takes more than a week:
   the default mode returns to `shadow`, and every step reverts through `resolveLegacyInstall`.
2. The mods API is withdrawn, or `--plugin-dir` stops loading a user mod: mode `off`; the legacy
   footprint is restored at the next boot.
3. RG-c fails on maintainers' machines after a step shipped: that step's release default returns
   to "always" in the next release.

## 8. Arbitration & fallback

Arbitration is unchanged (ARB-1 to ARB-9). This wave changes only whether a legacy artifact is
present, under one rule: an artifact a session can need without a respawn is injected at spawn for
every session (the blob); an artifact that lives in a shared file is present whenever
`resolveLegacyInstall` cannot show it is unneeded.

| Situation                                                | Behaviour after this wave                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI < 2.1.287, or above the tested ceiling               | install everything, as today                                                                                                                                                                                                                                                                                                                                  |
| Companion mode `off`, kill switch turned off mid-session | two effects. Every running session reverts to legacy at once (the `conn` is revoked, the re-hello is answered `enable: []`, no TTL wait): its blob is already injected, so state, notifications and legacy approvals continue. The machine-wide artifacts (global hooks, statusLine, guard registrations) are restored at the toggle and serve the next spawn |
| Managed machine (no hello)                               | the window fills with `no-binding` sessions and RG-c keeps the artifacts; the state uses the wording of DOC-8 (a cause is named only when it was observed)                                                                                                                                                                                                    |
| Lease lost mid-session                                   | the blob is already in the session: state, notifications and (after H2) approvals continue on legacy. Guard: the G1 note                                                                                                                                                                                                                                      |
| Host down                                                | the fallback matrix, unchanged                                                                                                                                                                                                                                                                                                                                |
| Headless (`-p`, scheduler ticks)                         | unaffected: ticks pass `--setting-sources ''` (`scheduler-core.ts:660`) and do not load the global install                                                                                                                                                                                                                                                    |
| Session started outside Harnu                            | R tiers, unless the operator turned on an outside switch (or P4W3)                                                                                                                                                                                                                                                                                            |
| User `--settings <file>`                                 | counted; keeps the global install on this machine while present                                                                                                                                                                                                                                                                                               |
| Two Harnu instances (dev and production)                 | each writes and removes only its own entries (lesson framework/005)                                                                                                                                                                                                                                                                                           |
| `settings.json` unwritable or corrupt                    | no write, no cleanup, one line in the list; legacy degrades to the watcher tiers as today (`hook-bridge.ts:473-477`)                                                                                                                                                                                                                                          |
| Downgrade to an older Harnu                              | the old version reads the absent `enabled` key as on and re-installs: a downgrade restores the old footprint by itself                                                                                                                                                                                                                                        |

## 9. Security requirements

SEC-1 to SEC-9 apply. Wave-specific:

1. **Fewer writes to files Harnu does not own.** After H2 and S1, a machine on automatic has no
   Harnu entry in `~/.claude/settings.json`; each remaining write is listed in the UI.
2. **Removal is exact.** Automatic cleanup removes only this instance's entries and dead-port
   orphans; the loose forms run only on the operator's action.
3. **Never install around a policy** (SEC-9f): `resolveLegacyInstall` installs legacy hooks and
   never writes anything that would make the companion load.
4. **H2 widens what the blob carries, not who decides.** Decisions still come from the resolver
   chain, and only renderer IPC resolves a held approval (SEC-2). The blob carries the bridge
   token and is never logged (`hook-bridge.ts:331-339`).
5. **Coverage stays honest** (SEC-7): a session with no blob and no global hook shows `not gated`.
6. The registration ledger holds folder paths and timestamps only.

## 10. UX & copy

`design.md` first: §6 Settings dialog (Integrations group), §8. No new component.

| Key                             | English                                                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `settings.hooks.description`    | Harnu adds its hooks to each session it starts. Turn this on to also install them in ~/.claude/settings.json for sessions started outside Harnu. |
| `settings.hooks.auto`           | Automatic                                                                                                                                        |
| `settings.hooks.observeOutside` | Also show the state of sessions started outside Harnu                                                                                            |
| `settings.statusline.auto`      | Automatic — installed only when a session needs it                                                                                               |
| `settings.statusline.fields`    | Without the status line, lines changed, thinking, output style, PR, model name, duration and effort are not shown.                               |
| `settings.legacy.title`         | Legacy integration                                                                                                                               |
| `settings.legacy.hint`          | What Harnu has written outside its own folder on this machine. Sessions on an older Claude Code, or blocked by policy, still need these.         |
| `settings.legacy.remove`        | Remove from this machine                                                                                                                         |
| `settings.legacy.removed`       | Removed {count} entries. Harnu will not install them again.                                                                                      |
| `settings.legacy.kept`          | Kept: {reason}                                                                                                                                   |
| `legacy.notice`                 | Harnu no longer edits your Claude settings by default. Sessions it starts carry their own hooks.                                                 |
| `legacy.guardOff`               | Harnu mod unloaded in {session}. The orchestrator guard may be off until the session restarts.                                                   |

`legacy.notice` is one `info` toast, on the first boot where automatic removed something. A
`settings.legacy.kept` reason is a sentence, not a code ("3 sessions ran on a Claude Code older
than 2.1.287 in the last 30 days").

## 11. Acceptance criteria

```
AC-P5W1-1 [unit] Given each combination of prefs, mode, CLI gate and ledger summary in the
  fixture, When resolveLegacyInstall runs, Then it returns the expected install flag and reason.
  Evidence: tests/companion/retirement-core.test.ts › "decision table"

AC-P5W1-2 [unit] Given companion mode `off`, When resolveLegacyInstall runs for any step, Then it
  answers install true.
  Evidence: tests/companion/retirement-core.test.ts › "kill switch restores legacy"

AC-P5W1-3 [unit] Given a window with one `no-binding` session, When the S1 and H2 decisions
  run, Then both answer install true with that reason.
  Evidence: tests/companion/retirement-core.test.ts › "managed machines keep legacy"

AC-P5W1-4 [unit] Given hook-prefs with an explicit `enabled` value, When the bridge boots, Then
  the install behaviour equals the behaviour before this wave.
  Evidence: tests/hook-bridge.test.ts › "explicit prefs are honoured"

AC-P5W1-5 [unit] Given settings holding our handlers, a live peer's and a foreign hook, When the
  automatic cleanup runs, Then only our token's and the dead-port handlers are gone.
  Evidence: tests/hook-reconcile.test.ts › "auto cleanup is instance-exact"
  Guards: lesson framework/005

AC-P5W1-6 [unit] Given a foreign statusLine and a `statusLine_harnu` key (and, in a second case, a legacy `statusLine_capy` key), When the operator removal
  runs, Then the foreign statusLine is unchanged and the key is gone.
  Evidence: tests/statusline-install.test.ts › "removal never touches a foreign statusLine"

AC-P5W1-7 [unit] Given the observe/decide split, When the blob is built before H2, after H2 with
  the global switch off, and after H2 with it on, Then it holds respectively StopFailure and no
  decide event, both decide events, and no decide event.
  Evidence: tests/hook-settings-blob.test.ts › "one carrier for decision events"

AC-P5W1-8 [unit] Given statusLine ingest disabled, When a day of `usage.measured` events is
  replayed, Then captureFleet received a sample for each.
  Evidence: tests/companion/telemetry-adapter.test.ts › "usage history without the status line"
  Guards: R14

AC-P5W1-9 [unit] Given two POSTs with the same session_id and tool_use_id, When the bridge
  dispatches them, Then one approval is parked and both receive its decision.
  Evidence: tests/hook-bridge.test.ts › "duplicate decision events join"
  Guards: R7

AC-P5W1-10 [unit] Given a folder with the guard entry and an always-allow rule, When the folder is
  removed from Harnu, Then the entry is gone and every other key remains.
  Evidence: tests/orchestrator-guard.test.ts › "registration is removed with the folder"

AC-P5W1-11 [unit] Given a synthetic whose spawn token was redeemed, When both collapse functions
  run with a real row inside the window, Then the synthetic is not absorbed.
  Evidence: tests/sessions-store.test.ts › "bound spawns skip the heuristics"
  Guards: BUG-65

AC-P5W1-12 [live-verify] Given an interactive session spawned with only a `--settings` blob
  holding PreToolUse and PermissionRequest handlers and no global hook, When a tool call opens the
  permission dialog, Then whether the bridge received each event and whether a deny in each
  response blocked the tool is recorded (OQ1).
  Evidence: LV-P5W1-d
  Guards: lesson framework/004

AC-P5W1-22 [live-verify] Given a folder where a session was promoted to orchestrator and then
  ended, on today's code, When the folder's `settings.local.json` is read, Then the leftover guard
  entry is recorded (F5: no caller removes it and no record of the folder exists).
  Evidence: LV-P5W1-e

AC-P5W1-23 [unit] Given the step's family in `shadow`, When resolveLegacyInstall runs, Then it
  answers install true.
  Evidence: tests/companion/retirement-core.test.ts › "shadow keeps legacy installed"

AC-P5W1-24 [unit] Given the kill switch turned off with one live owned session, When the toggle
  handler returns, Then the global hooks and the statusLine are installed again and the session's
  families report legacy.
  Evidence: tests/companion/retirement-core.test.ts › "kill switch restores the footprint"

AC-P5W1-13 [unit] Given a recipient with no lease on a CLI above
  MESSAGING_SOCKET_VERIFIED_CEILING, When the broker picks a transport, Then it refuses with
  PEER_NO_SOCKET and writes to no socket.
  Evidence: tests/messaging-socket.test.ts › "unverified CLI is refused"

AC-P5W1-14 [live-verify] Given a machine on automatic after H2 and S1, When a session is spawned,
  Then `settings.json` holds no Harnu hook handler and no Harnu statusLine.
  Evidence: LV-P5W1-a step 4

AC-P5W1-15 [live-verify] Given that state, When companion mode is set to `off` and a session is
  spawned, Then the handlers and the statusLine are back and the session reports through them.
  Evidence: LV-P5W1-a steps 5–7

AC-P5W1-16 [live-verify] Given a CLI below 2.1.287 after every step, When a session runs a turn
  that needs an approval, Then the Inbox row, the sidebar state and the footer telemetry appear.
  Evidence: LV-P5W1-b

AC-P5W1-17 [live-verify] Given an owned orchestrator session after G1, When the mod is unloaded
  and the session attempts an Edit, Then whether the legacy guard denied it is recorded (OQ2) and
  the `legacy.guardOff` toast was shown.
  Evidence: LV-P5W1-c

AC-P5W1-18 [live-verify] Given "Remove from this machine", When it completes, Then the three kinds
  of entry are absent, a `.backup` exists and the next boot installs nothing.
  Evidence: LV-P5W1-a steps 8–9, screenshot

AC-P5W1-19 [unit] Given a corrupt settings.json, When any cleanup runs, Then the file's bytes are
  unchanged and the result names the failure.
  Evidence: tests/claude-settings-write.test.ts › "cleanup never rewrites a corrupt file"

AC-P5W1-20 [unit] Given the repo tree, When the static check runs, Then every module of §7.3 and
  §7.6 exists and carries the FALLBACK header.
  Evidence: tests/legacy-freeze.test.ts › "frozen modules are present"
```

**Human**

```
AC-P5W1-21 [human] Given the operator's machine after 30 days on automatic, When the operator
  opens Settings → Integrations, Then the list matches what `settings.json` and one orchestrated
  folder's settings.local.json contain.
  Evidence: Delivery Report, side-by-side screenshot
```

**LV-P5W1-a** (second isolated Harnu with a throwaway `CLAUDE_CONFIG_DIR`)

1. Seed the ledger fixture so RG holds for every family; boot.
2. The `legacy.notice` toast appears once.
3. Spawn a session; run one tool call that needs approval; approve it in the Inbox.
4. Read the throwaway `settings.json`: no handler with the bridge URL shape, no `statusLine`.
5. Set companion mode `off`.
6. Spawn a session; read `settings.json`: the handlers and the statusLine are back.
7. Run a turn: the sidebar state and the footer telemetry update.
8. Settings → Integrations → "Remove from this machine"; confirm.
9. Read `settings.json` and the folder's `settings.local.json`; restart Harnu; read them again.

**LV-P5W1-b**: point the isolated instance at a pinned CLI binary below 2.1.287; repeat steps 3
and 7; record `claude --version`.

**LV-P5W1-d**: with a throwaway `CLAUDE_CONFIG_DIR` holding no hooks, spawn an interactive
session whose only hooks are a blob with `PreToolUse` and `PermissionRequest` pointing at a
recording bridge; trigger an Edit that opens the dialog; answer deny from the bridge on
`PermissionRequest`; record both POSTs and the outcome; repeat with the deny on `PreToolUse`.

**LV-P5W1-e** (F5, on `main` before this wave): promote a session to orchestrator, end it, read
the folder's `.claude/settings.local.json` and `<userData>/orchestrator-guard/`; record the entry
that remains and that no file names the folder.

**LV-P5W1-c**: promote a session to orchestrator on `active`; confirm the folder has no guard
entry; force an unload in a dev build; ask the session to edit a file outside `.harnu/`; record the
outcome and the toast.

## 12. Docs deliverables

| Deliverable                       | Content                                                                                                                                                                                                                                                                                                                             |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHANGELOG.md`                    | `Changed`: Harnu no longer edits `~/.claude/settings.json` by default; hooks travel with each session. `Added`: the Legacy integration list. `Fixed`: the orchestrator guard hook is removed from a folder that no longer needs it                                                                                                  |
| `docs/harnu-features.md`          | No change, no marker bump: nothing the session can call or offer changes                                                                                                                                                                                                                                                            |
| `docs/user/`                      | `settings.md` (the automatic default, the outside switches, the status line fields, the list); `troubleshooting.md` ("What Harnu writes outside its folder" with the manual cleanup; "my session shows `legacy`"); `approval-inbox.md` (approvals for outside sessions are opt-in); `usage.md` (which figures need the status line) |
| `docs/hook-bridge-integration.md` | Rewritten: product name, URL-shape identity, removal on exit, the blob as the default carrier, the opt-in global install                                                                                                                                                                                                            |
| `design.md`                       | §6 Settings dialog: the three-state rows and the Legacy integration list; §8 copy                                                                                                                                                                                                                                                   |
| i18n                              | the keys of §10 in `en.json` and `pt-BR.json`                                                                                                                                                                                                                                                                                       |

## 13. Rollout & parity gate

- Each step ships in its own release, in the order of §7.3, as a stacked branch (base = the branch
  below), when its family's flip gate **and** RG hold on maintainers' machines. A step never ships
  in the release that flips its family.
- On a user's machine a shipped step takes effect only when that machine's ledger satisfies RG-a
  and RG-c; otherwise the artifact stays and the reason is shown.
- **Reversal:** companion mode `off`, an explicit `enabled: true`, or a release that returns the
  default to "always".
- **Operator decision:** OD-3 (a notice, then automatic removal; the alternative is a prompt
  before each removal).

| Step | Owned sessions in the window (RG-a) | Extra precondition                                                                |
| ---- | ----------------------------------- | --------------------------------------------------------------------------------- |
| H1   | 200                                 | `StopFailure` in the blob shipped one release earlier (R28)                       |
| C1   | 200 spawns                          | zero wrong binds; every owned spawn hello-bound                                   |
| S1   | 200 (500 samples within 1 point)    | AC-P5W1-8                                                                         |
| G1   | 50 armed sessions                   | registration ledger and discovery pass shipped one release earlier                |
| M1   | 100 messages                        | master Q16 settled (P2W3)                                                         |
| H2   | 100 held decisions, none fail-open  | AC-P5W1-12 and AC-P5W1-9; the decide events in the blob one release earlier (R28) |

The numbers are the migration paper's proposals; they are tuned once, in the plan, before H1.

## 14. Open questions

| #   | Question                                                                                                                                         | Default until settled                                        | Owner                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------ |
| OQ1 | Does a `PermissionRequest` handler in the `--settings` blob carry a decision, interactively?                                                     | H2 moves `PreToolUse` only; `PermissionRequest` stays global | P5W1 (AC-P5W1-12, live-verify)             |
| OQ2 | Does a running CLI pick up a hook added to `settings.local.json` mid-session?                                                                    | assume no; show `legacy.guardOff`                            | P5W1 (AC-P5W1-17)                          |
| OQ3 | May automatic remove an artifact with only a notice, or must it ask first?                                                                       | notice                                                       | OD-3                                       |
| OQ4 | When is the minimum supported CLI raised?                                                                                                        | not before twelve months after 2.1.287                       | a further confirmation point of master §13 |
| OQ5 | Master Q8: does `disableAllHooks` or `allowManagedHooksOnly` also drop hooks passed through `--settings`? If so that machine has R tiers only    | say so in troubleshooting; no workaround                     | P1W4 (master Q8 run)                       |
| OQ6 | F5: `removeGuardHookRegistration` has no caller and no registration record exists (`orchestrator-guard.ts:356`). What is left on machines today? | step G1 gives it callers and adds the record                 | P5W1 (AC-P5W1-22)                          |
| OQ7 | Master Q32: should agent prompts under the argv budget also move to the companion later?                                                         | no (D9): the argv positional stays                           | P5W1                                       |

## 15. Risks

| Risk                                                                 | Sev    | Mitigation                                                                                            |
| -------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------- |
| Two stacks forever (R4)                                              | High   | stated in §3 and §7.7; the freeze policy; kill criteria in both directions                            |
| Cleanup removes a peer instance's or the user's entry                | High   | exact automatic removal; loose removal only on the operator's action; AC-P5W1-5, AC-P5W1-6            |
| A removed artifact is needed again and is missing                    | High   | the blob is always injected; `resolveLegacyInstall` installs on any doubt; RG-d; a downgrade restores |
| H2 double-fires approvals during a toggle                            | Medium | one carrier per session at spawn; the bridge joins on `tool_use_id` (AC-P5W1-9)                       |
| S1 blanks eight HUD fields                                           | Medium | opt-in is one click; the hint names the fields; explicit prefs are kept                               |
| G1 leaves an orchestrator unguarded after a lease loss               | Medium | toast and role state; the re-arm attempt; OQ2; the guard was never a boundary                         |
| A lightly used machine never fills the window, so nothing is cleaned | Low    | acceptable: the artifact stays, and the operator action is always available                           |
