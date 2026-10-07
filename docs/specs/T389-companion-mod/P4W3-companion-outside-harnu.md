# T389 P4W3 — Harnu mod outside Harnu

## 1. Status

Specified (not implemented) · 2026-10-02 · Epic T389 · Master: [`00-master.md`](00-master.md) ·
Contract: [`01-contract.md`](01-contract.md) · ADR-0018 · Verified against Claude Code CLI 2.1.287
and repo `main` @ `46d70c7d` (line references re-checked after the Harnu rename; the earlier base `b35a2c06` is not in this repository). "types L<n>" is a line of that release's `claude-code.d.ts`.

## 2. Depends on / Unblocks

- **Depends on (hard):** P1W3 (hello, binding table, identity adapter), P1W4 (arbiter, task-state
  hub, prefs, Harnu mod state, the disclosure) and **P4W1 part A** (`docs/user/mods.md` is its page;
  its settings region hosts the switch). Step 2 of §7.3 runs P1W4's shared policy probe.
  **Base branch: the P1W4 branch with P4W1 part A merged into the stack below it.**
- **Needed for one feature only:** P2W1, for `ui.band.set` (the band of P4W2). Without it an
  external session reports state and has no band.
- **Uses when present:** P1W5 and P1W6 (the sensors it carries), P3W1 (the opt-in hold), P4W2
  (band and `/harnu-link`, which stacks on this wave).
- **Unblocks:** P4W2.
- **Interfaces this wave conforms to** (master §12; the owner defines the signature):
  - P1W2 `ensureStaged(): Promise<string | null>` for the directory to install, and
    `pinStagedDir(fn)` so that garbage collection keeps the directory named by the install record
    and by any live external binding.
  - P1W1 `companionHost.beforeHello` (kind `'external'`), `revoke(b)`, `bindingForSid`,
    `setCommandSource`; and the table additions master §12.1 lists for this wave, `profile: 'external'` and
    `corroborated`, which this wave adds to P1W1's table **in its own change**.
  - P1W3 `ensureHello($)`: this wave adds the tokenless branch to it in its own change.
  - P1W4 `registerPrefsKey('external', …)`, `registerFeaturePolicy`, the hub's `ingest`,
    `owns` / `ownerFor`, `recordFact`.
  - P1W4 `classifyPolicyProbe(output: string)` and its shell.
  - P2W1: the rule that an `external` binding receives only `flush`, `config.update` and
    `ui.band.set` is stated in P2W1's origin gate (its `registerGateRow` profiles); this wave
    conforms and adds no second gate on the host.
  - P2W3 `shouldStandDown`, as extended by P3W1, for an opted-in hold (§7.7).

## 3. Summary

An opt-in, default-OFF switch, "Harnu mod outside Harnu", that makes `claude` sessions started in
any terminal load the same staged companion. Such a session has no spawn token, so it introduces
itself with a tokenless hello and gets the **external** profile: sensors, `/harnu-link` and the mission
line, and nothing that acts on it. Harnu shows it in the "Active elsewhere" zone with real turn
state instead of a guess. Approvals are not held unless the folder is already on the interceptor
ramp. Turning the switch off removes exactly what Harnu wrote.

This is not the existing "Also outside Harnu" switch of the Skills tab. That one copies a
`SKILL.md` into `~/.claude/skills/<name>/` (`bundled-skills.ts:545-598`); a skill file cannot
carry a hooks module.

## 4. Evidence

| Id                   | Verdict   | What this wave takes from it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| smoke A1             | CONFIRMED | A plugin folder loads from `CLAUDE_CODE_PLUGIN_DIRS` alone (process env), headless and interactive, with no consent prompt in a trusted folder. Untrusted folder: could not test.                                                                                                                                                                                                                                                                                                                                                                                                                |
| smoke A2             | CONFIRMED | `session.start` is awaited before the first prompt; `$.session.id()` equals the transcript file name; `--resume`, `/clear` and in-session `/resume` behave as contract §15 says.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| smoke D6             | REFUTED   | Nothing a mod sends is authenticated. A tokenless hello is a claim; it must grant nothing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| smoke C2; ADR C6     | CONFIRMED | A pending long-poll delays `-p` exit by 24–46 s: outside headless runs must not open the channel at all.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| smoke B1.7           | CONFIRMED | A `classic.PermissionRequest` hold leaves the native dialog usable and the first answer wins, so an opted-in hold never strands the person at that terminal.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| docs (not smoke-run) | —         | `CLAUDE_CODE_PLUGIN_DIRS` is read from the environment "or `env` in `~/.claude/settings.json`", "for apps you can't pass a flag to". `disableSideloadFlags` "rejects `--plugin-dir` and `--plugin-url` at startup". No mod loads in an untrusted directory until the trust prompt is answered. A mod under `~/.claude/skills/` "loads only after you approve it" and never in `-p` or `dontAsk`.                                                                                                                                                                                                 |
| CLI help             | —         | `claude plugin init` writes `~/.claude/skills/<name>/`, loaded as `<name>@skills-dir`; `claude plugin install`, `uninstall`, `update` ("restart required"), `marketplace` exist.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| code                 | —         | `claude-settings.ts` already owns a locked, atomic write of `~/.claude/settings.json` (`withSettingsLock` `:109`, `atomicWrite` `:130`, `writeClaudeSettings` `:147`), mirrored for exit handlers at `hook-installer.ts:299-314`. `usage.ts:44-47` runs `claude -p /usage` with the user's settings. Scheduler ticks pass `--setting-sources ''` (`scheduler-core.ts:660`). External sessions already get state from the PID registry (`session-registry-watch.ts`, header) and the transcript tier. `message_session` refuses a session Harnu did not spawn (`mcp/tool-handlers.ts:1879-1880`). |

## 5. Deviations from the study

| Study claim                                                                                                             | Deviation                                                                                                                                     | Source                |
| ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| "For sessions outside Harnu, `CLAUDE_CODE_PLUGIN_DIRS` or installation in `~/.claude` (the switch that already exists)" | The existing switch installs skill files, not a plugin. This wave adds a separate switch and picks the settings `env` route (§7.2).           | code; D1              |
| Outside sessions "enter the Active elsewhere zone with real state **and remote approval**"                              | State yes. Approval is not held by default; a hold is an existing per-folder opt-in and never a guarantee.                                    | D5; product paper §2d |
| Implied: the handshake identifies the session                                                                           | A tokenless hello is an unauthenticated claim. It is shown only after Harnu's own watchers corroborate the session id, and it never actuates. | C4; smoke D6          |

## 6. Scope / Non-goals

**In scope.** The switch, the settings write and its exact undo, the external hello and profile,
corroboration, what the sidebar and hover preview show, the refusal list, the approval default,
the interaction with policy.

**Non-goals.**

- No start prompt, no message delivery, no context append, no guard, no abort, no compact, no plan
  capture for an external session, ever (§7.6).
- No install for other machines, containers or remote hosts. The rendezvous path is local.
- No Desktop, VS Code, SDK or cloud claim (Q22): the mod loads wherever the CLI honours the
  setting, and this spec promises only the terminal.
- No resume guard for a session that is live in another terminal (Q-P4W3-e).
- No workaround on a managed machine (SEC-9f).

## 7. Design

### 7.1 Modules

| File                                                                   | Side       | Owns                                                                                                                                                                                              |
| ---------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/companion/external-install-core.ts`                          | host, pure | `planInstall`, `planUninstall`, the refusal reasons, the env-list edit                                                                                                                            |
| `src/main/companion/external-install.ts`                               | host       | reads and writes `~/.claude/settings.json` through `readClaudeSettings` / `writeClaudeSettings` (`claude-settings.ts:88`, `:147`), the install record, the post-install check, boot-time re-point |
| `src/main/companion/external-binding.ts`                               | host       | tokenless hello, corroboration, limits, the external enable set                                                                                                                                   |
| `src/main/companion/session-table.ts` (P1W1)                           | host       | gains `profile: 'external'` and `corroborated`                                                                                                                                                    |
| `src/main/companion/companion-ipc.ts` (P1W4)                           | host       | `companion:externalGet`, `companion:externalSet`                                                                                                                                                  |
| `resources/companion/hooks/register.ts`                                | mod        | the tokenless branch of `ensureHello`; the local command refusal of §7.6                                                                                                                          |
| `src/renderer/src/components/` (the pane hosting the companion region) | renderer   | the Advanced block of §10                                                                                                                                                                         |
| `src/renderer/src/components/SessionPreview.vue`                       | renderer   | the Harnu mod state line gains "outside Harnu"                                                                                                                                                    |

### 7.2 Install mechanism

| Option                                                                 | Evidence                                                                                 | For                                                                                                                                                        | Against                                                                                                                                                                                  | Verdict                        |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| **A. `CLAUDE_CODE_PLUGIN_DIRS` in `env` of `~/.claude/settings.json`** | env-only load CONFIRMED (smoke A1); the settings `env` form is documented, not smoke-run | Loads the **same immutable staged directory** as Harnu-spawned sessions: one artefact, one version, baked coordinates. One key to add, one path to remove. | Harnu writes the user's settings file. Applies to every `claude` process, including Harnu-spawned ones and Harnu's own probes.                                                           | **chosen**                     |
| B. Copy to `~/.claude/skills/harnu-companion/` (`@skills-dir`)         | CLI help; docs                                                                           | Lives beside the existing skills switch; the engine asks for approval itself.                                                                              | A second, mutable copy that hot-reloads live sessions on every Harnu update (MOD-9). Approval per session with wording Harnu does not own. Never loads in `-p`. Load order unknown (Q3). | rejected                       |
| C. A local marketplace plus `claude plugin install`                    | none                                                                                     | The CLI writes its own settings; visible in `/plugin` and `plugin list`; removable with official commands.                                                 | Copies into the CLI's cache (a second copy, updated only by `plugin update`, "restart required"). Blocked by marketplace allowlists. Entirely untested.                                  | fallback if A fails AC-P4W3-12 |

Writing the user's settings is the habit this epic retires. It is accepted here because it is an
explicit opt-in, one key, disclosed before it happens, recorded, and undone exactly.

### 7.3 Settings write and undo

Install record `<userData>/companion/external-install.json`:

```ts
interface ExternalInstallRecord {
  v: 1
  installed: boolean
  entry: string // the absolute directory Harnu added to the list
  settingsPath: string
  createdEnv: boolean // Harnu created the `env` object
  createdKey: boolean // Harnu created the CLAUDE_CODE_PLUGIN_DIRS key
  modVersion: string
  at: number
}

type ExternalInstallResult =
  | { ok: true; installed: boolean }
  | {
      ok: false
      reason:
        | 'unparseable'
        | 'occupied'
        | 'symlink'
        | 'policy' // a managed cause was positively identified
        | 'mods-off' // the probe shows mods are off; the cause was not observed
        | 'no-companion'
        | 'failed'
    }
```

`planInstall(settingsText, dir, record)`:

1. `dir` = `await ensureStaged()` (P1W2). `null` → `no-companion`.
2. **Policy (operator decision OD-5, master §13; R23).** A managed settings file exists on this
   machine → `policy` ("Blocked by your organization's policy": a managed cause was found). The
   shared probe (`classifyPolicyProbe`, P1W4 §7.6) says `off-here` or `off-remote` → `mods-off`
   ("Turned off by a setting or by your organization's policy": the probe shows that mods are
   off, not why, DOC-8). Nothing is written in either case. The per-platform managed-settings
   paths come from the CLI's settings reference; they are not in the evidence pack and are
   confirmed at implementation (Q-P4W3-c). OD-5's alternative (install, check, roll back) is
   not the default; step 8 keeps its check only as a second net.
3. `lstat` says the settings file is a symlink → `symlink`. A temp-file-plus-rename would replace
   the link with a regular file and detach the user's dotfiles.
4. The file is missing → start from `{}`. It does not parse as JSON → `unparseable`.
5. `env` exists and is not an object, or `env.CLAUDE_CODE_PLUGIN_DIRS` exists and is not a string
   → `occupied`.
6. Split the value on the platform path delimiter, drop empty items and the record's previous
   `entry`, append `dir`, join. Every other key and every other list item is kept as it was.
7. Write with `writeClaudeSettings` (settings lock, temp file, rename; `claude-settings.ts:130`
   makes no backup copy), then write the record. The record is the undo.
8. **Post-install check.** Run `claude plugin list --json` (10 s timeout). A non-zero exit whose
   output names managed settings → roll back with `planUninstall` and return `policy`. This is the
   second net for a managed cause that is not a file on disk (Q-P4W3-c, R23).

`planUninstall`: remove exactly `record.entry` from the list. If the list is then empty and
`createdKey`, delete the key; if `env` is then empty and `createdEnv`, delete `env`. If the entry
is no longer there (the user edited it), change nothing and clear the record. A file that no
longer parses → `unparseable`, and the toast names the one path to remove by hand.

**Boot.** When the record says installed and `ensureStaged()` differs from `record.entry`
(a mod version bump), re-plan with the new directory. Sessions already running keep the old
directory (immutable, D1; kept by `pinStagedDir`); the host serves protocol N and N-1.

### 7.4 External hello and profile

The mod has no spawn token. `ensureHello` branches once per load (contract §21 item 1):

| `HARNU_SPAWN_TOKEN` | `isInteractive` | Behaviour                                                                                                |
| ------------------- | --------------- | -------------------------------------------------------------------------------------------------------- |
| present             | any             | the spawned path of P1W3, unchanged                                                                      |
| absent              | false           | **dormant, no request at all.** Covers Harnu's own `claude -p` probes, CI and scripts (smoke C2; ADR C6) |
| absent              | true            | hello with neither `spawn` nor `resume` (contract §21)                                                   |

A `claude` started by the model's Bash inside a Harnu session inherits the spent token, gets
`UNAUTHORIZED` and goes dormant; it never becomes an external row.

Host, on a tokenless hello (`external-binding.ts`), first match (contract §21 item 2):

1. The `external` key is off, **or the companion mode is `off`** → `FEATURE_DISABLED`; the mod
   goes dormant. `FEATURE_DISABLED` means "off" and nothing else.
2. `sid` is bound to a live spawned binding, or `sessionOwnedByHarnu(sid)` is true (`pty.ts:1176`)
   → `UNAUTHORIZED`. A claim never displaces a session Harnu spawned.
3. More than `EXTERNAL_MAX_BINDINGS` live external bindings → `SLOW_DOWN` with `retryAfterMs`;
   the mod retries.
4. Otherwise create a binding: `profile: 'external'`, `sessionKey: null`, `corroborated: false`,
   `enable` = the external set, and no `commands`.

**External enable set** (contract §21 item 3): `sense.identity`, `sense.turn`, `sense.attention`,
`sense.subagent`, `sense.usage`; and `ui.command` and `ui.band` only when the `surface` key
(P4W2) is on. Plus `gate.approval` only under §7.7. Never `act.*`, `gate.guard`, `gate.sentinel`,
`stamp.mcp`, `sense.message`, `sense.compact`, `sense.mods`. The rows are registered with
`registerFeaturePolicy`.

**Transport rules for `external`:** no `poll`; the lease is renewed by `events` batches and an
empty heartbeat every `HEARTBEAT_MS`, as in the headless profile (contract §16 item 3); `ask` is
allowed for kind `status`, and for `permission` only when `gate.approval` is enabled; commands
arrive piggybacked on `events` responses only, and the mod sends its `bootId` and `cursor`
there (contract §21 item 4).

### 7.5 Corroboration: when an external session is shown

A tokenless hello proves nothing (smoke D6; contract §21 item 6). The binding stays invisible
until Harnu's own watchers report the same session, by either of:

- the PID registry: a `~/.claude/sessions/<pid>.json` entry with that `sessionId` and the hello's
  `cwd` (`session-registry-watch.ts`);
- the transcript watcher: `<sid>.jsonl` under the project directory of that `cwd`.

Until then the host buffers the binding's events (at most `RING_MAX`), feeds no consumer, draws
no band, focuses nothing and answers a `status` ask `released` with reason `abstain`. On
corroboration it sets `corroborated: true`, replays the buffer through the task-state hub with
`source: 'companion'`, and the adapters key everything by `sid`: the sidebar row of a disk session
is already keyed by its session id. The one anchor of `EXTERNAL_CORROBORATE_MS` is the binding's
**first `turn.started`** (the transcript appears with the first prompt): a binding not
corroborated that long after it is dropped; the mod sees `STALE_CONN` and may hello again. A
binding that has not yet run a turn waits without a deadline, invisible.

The row itself is still created only by the transcript watcher. The companion never creates a
sidebar row (ARB-2: one writer for row existence).

Ownership follows ARB-3 unchanged, with one substitution: for an external binding the proof of
`sense.identity` is corroboration, not a redeemed token.

| Family                      | External session, switch off (today) | External session, corroborated and family `active`    |
| --------------------------- | ------------------------------------ | ----------------------------------------------------- |
| identity                    | registry / transcript                | companion (re-key on `session.rebound`, contract §15) |
| taskState                   | registry, then transcript            | companion, through the hub                            |
| telemetry                   | user statusLine, if installed        | companion: context and cost in the hover preview      |
| planUsage                   | `/usage` poll                        | any leased session counts, external included (D11)    |
| approval                    | global hook, if installed            | global hook; companion only under §7.7                |
| guard, startPrompt, message | not applicable / refused             | not applicable / refused                              |

### 7.6 What is refused

For a binding with `profile: 'external'` the host issues only `flush`, `config.update` and
`ui.band.set` (contract §21 item 5). Everything else is refused at P2W1's origin gate and audited
as a refusal:

| Request                                       | Outcome                                                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| start prompt / `prompt.submit` in any form    | refused; `create_session` never targets an external session, and there is no claim to deliver           |
| `message.deliver`                             | refused; `message_session` already answers `RECIPIENT_NOT_HARNU_SPAWNED` (`tool-handlers.ts:1879-1880`) |
| `context.append`, `guard.set`, `plan.capture` | refused                                                                                                 |
| `turn.abort`, `session.compact`               | refused                                                                                                 |
| `ui.toast`, `ui.status`                       | refused: Harnu does not write into a terminal it does not own, beyond the opt-in band line              |

**Mod-side second lock** (contract §9, conformance row 26). A mod whose hello carried no spawn
token answers every command other than those three with `CMD_UNSUPPORTED`, without looking at
`enable`. So a forged or rewritten response (smoke D6) still cannot make an outside session run a
prompt (SEC-3d).

`ui.band.set` is never applied as `$.ui.status` (contract §9): if the band hook could not be
declared, an outside session simply has no line.

### 7.7 Approvals

Default: **not held** (the default of operator decision OD-2 applies to outside sessions too:
Harnu holds only when the engine would ask, and here only by opt-in). `gate.approval` is not enabled, the mod never asks, the native dialog and
any global hook behave exactly as today.

Opt-in is the per-folder interceptor ramp that already exists (`interceptActive`,
`user-projects.ts:69`, `setUserProjectInterceptActive` `:939`; `rampActionFor`, `responder-registry.ts:115`): today it makes the legacy
hook park calls from that folder, whoever started the session. With this wave, for an external
binding whose `cwd` is on the ramp, whose `approval` family is `active` and which is corroborated,
the host enables `gate.approval` and P3W1's hold applies unchanged: the dialog stays usable at
that terminal, the first answer wins, any failure is the engine's verdict (SEC-1), and the bridge
stands down for that session (ARB-9a; contract §11.6, the predicate of P2W3 as extended by
P3W1). The Inbox row carries "outside Harnu" and the coverage state.
No new switch is added for this.

### 7.8 Contract additions

None — merged into `01-contract.md` §21 (External profile), with:

| Item                                                                 | Contract                       |
| -------------------------------------------------------------------- | ------------------------------ |
| tokenless `hello` as the external claim; `profile: 'external'`       | §5.1, §21 items 1–2            |
| `FEATURE_DISABLED` on `hello` (off only); `SLOW_DOWN` over the limit | §21 item 2, §12                |
| proof of `sense.identity` by corroboration                           | §11.2, §21 item 6              |
| a tokenless non-interactive mod sends no request                     | §16 item 6; conformance row 26 |
| the tokenless second lock on commands                                | §9; conformance row 26         |
| `UNKNOWN_SESSION` → one fresh tokenless hello                        | §21 item 7                     |
| revocation when the switch or the kill switch turns off              | §21 item 8, §3 item 9          |
| `EXTERNAL_MAX_BINDINGS`, `EXTERNAL_CORROBORATE_MS`                   | §7.2                           |
| the `external` key                                                   | §11.5                          |

Not in the contract, and local to this wave: `ExternalInstallRecord` and `ExternalInstallResult`
(§7.3). They never cross the wire.

## 8. Arbitration & fallback

| Condition                                                                                                    | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Switch off (default)                                                                                         | Nothing is written. Outside sessions behave as today (registry and transcript tiers).                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Switch on, Harnu not running                                                                                 | The mod reads the rendezvous file, fails to connect, backs off and stays a no-op: every hook returns `next(e)`. The session is unaffected.                                                                                                                                                                                                                                                                                                                                                                                                   |
| Harnu starts later                                                                                           | The next backoff attempt hellos; state appears from then on.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Host restart                                                                                                 | The designed path: the `resume` hello is answered `UNKNOWN_SESSION` and the tokenless mod sends **one fresh tokenless hello** instead of going dormant (contract §21 item 7): it has no token to protect, and Harnu restarts on every update. Corroboration starts over. The persisted `conn` hash is optional; where the host has it, the `resume` simply succeeds.                                                                                                                                                                         |
| The outside switch turned off, or the kill switch turned off, mid-session                                    | Every live external binding is revoked at once (`revoke(b)`; contract §21 item 8, §3 item 9): its `conn` answers `STALE_CONN`, the mod's `resume` re-hello is answered `enable: []` for the switch and the kill switch alike (contract §3 item 9: a revoked `conn` on `resume` is accepted and answered empty; only a fresh tokenless hello with the key off gets `FEATURE_DISABLED`), the mod is inert, and the registry and transcript tiers win at once, with no TTL wait. Turning the switch off also removes the settings entry (§7.3). |
| Lease lost mid-session                                                                                       | Legacy tiers win within one TTL, sticky (ARB-4). An opted-in hold falls back to the global hook.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Hot reload                                                                                                   | `conn` from `$.state`, `resume` hello, same binding. Rare: the directory is immutable.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `/clear`, in-session `/resume`                                                                               | `session.rebound`; the binding is re-keyed; corroboration is required again for the new id before it is shown.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Headless outside run                                                                                         | Dormant by rule (§7.4). No hello, no delay at exit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| CLI below 2.1.287, or above the tested ceiling                                                               | Below: the env key is ignored or the mod API is absent; nothing loads. Above: the `external` key is capped at `off` (contract §11.5) and a tokenless hello is refused. The pane shows "No outside session has reported yet."                                                                                                                                                                                                                                                                                                                 |
| Untrusted folder                                                                                             | No mod loads until the trust prompt is answered (docs; Q1). Legacy tiers until then.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `--safe-mode`, `--bare`, `disableAllHooks`                                                                   | No hello. Legacy tiers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `allowManagedModsOnly`, `sec-default`                                                                        | No hello, or sensors pinned: detected by absence and by `probes` (ARB-7c). Stated as "legacy"; no workaround.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `disableSideloadFlags`                                                                                       | `policy` refusal at install (§7.3 steps 2 and 8). If it appears later, see Q-P4W3-c.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Claim for a session Harnu spawned                                                                            | `UNAUTHORIZED`; the spawned binding is untouched.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Claim never corroborated                                                                                     | Never shown; dropped after `EXTERNAL_CORROBORATE_MS`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| The same directory named by the flag **and** by the env key (a Harnu-spawned session while the switch is on) | Expected: one module instance. Unverified (contract CQ18, R24) → AC-P4W3-12, with the fallback of Q-P4W3-b.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Scheduler tick                                                                                               | Expected, not observed (master Q2): `--setting-sources ''` drops the user's `env`, so the tick loads the companion only through its own flag, as before. If it did not, the tick would name the directory twice (CQ18, R24) and AC-P4W3-12 (b) is the check to repeat for a tick.                                                                                                                                                                                                                                                            |
| User removes the path by hand                                                                                | The record is cleared on the next read; the switch shows off.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Harnu uninstalled with the switch on                                                                         | The key points at a missing directory. Documented in `docs/user/`; the path to remove is shown in the pane and the docs.                                                                                                                                                                                                                                                                                                                                                                                                                     |

## 9. Security requirements

Cites SEC-1, SEC-2, SEC-3, SEC-4, SEC-5, SEC-6, SEC-7, SEC-8, SEC-9f. Wave-specific:

- **P4W3-S1.** An external binding is a claim. It never receives a prompt, a message, context or
  any actuator command (§7.6), and it never displaces a spawned binding (§7.4 step 2).
- **P4W3-S2.** Nothing from an external binding is shown or fed to a consumer before
  corroboration by Harnu's own watchers (§7.5).
- **P4W3-S3.** Harnu changes one list item in one key of the user's settings, records it, refuses
  rather than overwrites (§7.3 steps 3–5), and undoes exactly that item.
- **P4W3-S4.** On a machine where a managed settings file is found the switch is refused with
  "Blocked by your organization's policy" and nothing is written (OD-5). Where only the probe
  shows mods are off, the refusal uses DOC-8's neutral sentence. No alternative route is offered
  or attempted.
- **P4W3-S5.** Bindings are bounded (`EXTERNAL_MAX_BINDINGS`) and every hello is validated as
  untrusted input (SEC-3c): `cwd` must be absolute; `sid` must be a uuid.
- **P4W3-S6.** The disclosure is shown before the first write and states: unsandboxed, runs inside
  `claude`, talks only to Harnu on this machine, edits `~/.claude/settings.json`, applies to every
  session started in any terminal.
- **P4W3-S7.** External facts are attributable, not authenticated: the audit log and the parity
  ledger mark them `external`, and no verb treats them as proof of anything.

## 10. UX & copy

The switch lives in a collapsed **Advanced** block of the settings region of the Mods tab
(`#mods-companion`, P4W1), mirroring the Skills pane's Advanced block (`design.md` §6 "Bundled
skills"). `design.md` gains §6 "Harnu mod outside Harnu (T389)". No new
token or component: `ToggleSwitch`, `SettingHint`, the bordered `--surface` row, a `danger` toast
for a refusal.

```
> ADVANCED
  Sessions you start in your own terminal can load the Harnu mod too. They
  report their state to Harnu on this machine. Harnu never starts prompts in
  them and does not hold their approvals.                       <- SettingHint
  +------------------------------------------------------------------+
  | Harnu mod outside Harnu                                     [ o--] |
  | ~/.claude/settings.json · env.CLAUDE_CODE_PLUGIN_DIRS            |
  +------------------------------------------------------------------+
  Last outside session seen: 2 min ago                          <- SettingHint
```

First time the switch is turned on, a confirm dialog (the existing `Dialog`) carries the
disclosure; **Turn on** writes, **Cancel** leaves everything untouched.

**Sidebar.** No new chip. An outside session with a corroborated live binding simply has real
state: its dot and the "Active elsewhere" zone (`isLiveFolder`, `folder-zones.ts:140`; `classifyFolder`, `:160`) follow turn events
instead of the registry or transcript guess. The session hover preview's Harnu mod line (P1W4)
reads "Harnu mod: live · outside Harnu".

i18n keys, in **both** `en.json` and `pt-BR.json`:

| Key                                     | `en`                                                                                                                                                                                                                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `harnuMod.external.title`               | Advanced                                                                                                                                                                                                                                                                              |
| `harnuMod.external.hint`                | Sessions you start in your own terminal can load the Harnu mod too. They report their state to Harnu on this machine. Harnu never starts prompts in them and does not hold their approvals.                                                                                           |
| `harnuMod.external.label`               | Harnu mod outside Harnu                                                                                                                                                                                                                                                               |
| `harnuMod.external.path`                | `~/.claude/settings.json` · `env.CLAUDE_CODE_PLUGIN_DIRS`                                                                                                                                                                                                                             |
| `harnuMod.external.lastSeen`            | Last outside session seen: {time}                                                                                                                                                                                                                                                     |
| `harnuMod.external.neverSeen`           | No outside session has reported yet.                                                                                                                                                                                                                                                  |
| `harnuMod.external.confirm.title`       | Load the Harnu mod outside Harnu?                                                                                                                                                                                                                                                     |
| `harnuMod.external.confirm.body`        | Harnu adds one folder to `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`. Every `claude` session you start in any terminal then loads the Harnu mod. It runs unsandboxed inside `claude` and talks only to Harnu on this machine. Turning this off removes exactly that entry. |
| `harnuMod.external.confirm.accept`      | Turn on                                                                                                                                                                                                                                                                               |
| `harnuMod.external.refused.unparseable` | `~/.claude/settings.json` is not valid JSON. Nothing was changed.                                                                                                                                                                                                                     |
| `harnuMod.external.refused.occupied`    | `env.CLAUDE_CODE_PLUGIN_DIRS` has a shape Harnu does not edit. Nothing was changed.                                                                                                                                                                                                   |
| `harnuMod.external.refused.symlink`     | `~/.claude/settings.json` is a symlink. Harnu does not replace it. Nothing was changed.                                                                                                                                                                                               |
| `harnuMod.external.refused.modsOff`     | Turned off by a setting or by your organization's policy.                                                                                                                                                                                                                             |
| `harnuMod.external.refused.policy`      | Blocked by your organization's policy.                                                                                                                                                                                                                                                |
| `harnuMod.external.refused.noCompanion` | The Harnu mod is off. Turn it on first.                                                                                                                                                                                                                                               |
| `harnuMod.external.refused.failed`      | Could not update `~/.claude/settings.json`.                                                                                                                                                                                                                                           |
| `harnuMod.external.manualRemove`        | To remove it by hand, delete {path} from `CLAUDE_CODE_PLUGIN_DIRS`.                                                                                                                                                                                                                   |
| `harnuMod.state.outside`                | outside Harnu                                                                                                                                                                                                                                                                         |
| `approvalInbox.row.outside`             | outside Harnu                                                                                                                                                                                                                                                                         |

## 11. Acceptance criteria

```
AC-P4W3-1 [unit] Given settings with other keys and an existing two-item list, When `planInstall`
  runs, Then the output differs from the input only by one appended list item.
  Evidence: tests/companion/external-install-core.test.ts › "adds one item and nothing else"
AC-P4W3-2 [unit] Given the installed result of AC-P4W3-1, When `planUninstall` runs, Then the
  output is byte-equal to the original parsed settings.
  Evidence: tests/companion/external-install-core.test.ts › "undo is exact"
AC-P4W3-3 [unit] Given invalid JSON, a non-object `env`, a non-string value, or a symlinked file,
  When `planInstall` runs, Then it returns the matching refusal and proposes no write.
  Evidence: tests/companion/external-install-core.test.ts › "refuses rather than overwrites"
AC-P4W3-4 [unit] Given a record with `createdKey` and `createdEnv`, When uninstall empties the
  list, Then both the key and `env` are removed; without those flags they are kept.
  Evidence: tests/companion/external-install-core.test.ts › "removes only what it created"
AC-P4W3-5 [integration] Given a managed settings file (result `policy`) or a policy probe of
  `off-here` (result `mods-off`), When the switch is turned on, Then the settings file's bytes
  are unchanged.
  Evidence: tests/companion/external-install.test.ts › "no write under policy"
AC-P4W3-6 [mod-test] Given no spawn token and `isInteractive === false`, When any hook runs,
  Then no `http.fetch` is issued for the life of the module (conformance row 26).
  Evidence: resources/companion/tests/external.test.ts › "headless outside run is silent"
AC-P4W3-7 [mod-test] Given a tokenless hello that was accepted, When a `prompt.submit`,
  `message.deliver` or `context.append` command arrives, Then the result is CMD_UNSUPPORTED and no
  `$.prompt.submit` or `$.session.append` call is made.
  Evidence: resources/companion/tests/external.test.ts › "an outside session refuses actuators"
  Guards: R1
AC-P4W3-8 [unit] Given an external binding, When any verb or gesture queues a command outside
  flush, config.update and ui.band.set, Then the origin gate refuses and writes a refusal record.
  Evidence: tests/companion/external-binding.test.ts › "host refuses actuators for external"
  Guards: R1
AC-P4W3-9 [unit] Given a tokenless hello whose `sid` belongs to a live spawned binding, When it is
  handled, Then the answer is UNAUTHORIZED and the spawned binding's `conn` is unchanged.
  Evidence: tests/companion/external-binding.test.ts › "a claim never displaces a spawned session"
AC-P4W3-10 [unit] Given an external binding with events and no registry or transcript entry,
  When events arrive, Then no task-state hub input is produced; and after a matching transcript
  appears the buffered events are replayed in order.
  Evidence: tests/companion/external-binding.test.ts › "nothing is shown before corroboration"
AC-P4W3-11 [unit] Given the `external` key off, or the companion mode `off`, When a tokenless
  hello arrives, Then the answer is FEATURE_DISABLED; and over EXTERNAL_MAX_BINDINGS it is
  SLOW_DOWN.
  Evidence: tests/companion/external-binding.test.ts › "off means refused"
AC-P4W3-12 [live-verify] Given the switch on, When (a) a session is started in a plain terminal
  and (b) a session is started from Harnu, Then (a) hellos as external through the settings `env`
  alone and (b) loads exactly one companion module and hellos once, as spawned.
  Evidence: LV-P4W3-a (settles contract CQ18)
  Guards: R24
AC-P4W3-13 [live-verify] Given an outside session with a corroborated binding, When it runs a
  turn and then waits on a permission dialog, Then its sidebar row shows working and then
  needs-input within one flush, and the folder is in the "Active elsewhere" zone.
  Evidence: LV-P4W3-b
AC-P4W3-14 [integration] Given an external binding in a folder that is not on the ramp, When a
  permission dialog opens, Then no `ask` request reaches the host.
  Evidence: tests/cli/external.cli.test.ts › "approvals are not held by default" (--with-cli)
AC-P4W3-15 [integration] Given the host is not running and the switch is on, When an outside
  session runs a turn, Then the turn completes and the debug file shows no hook skipped or failed.
  Evidence: tests/cli/external.cli.test.ts › "Harnu absent is a no-op"
AC-P4W3-16 [integration] Given the switch on and Harnu's usage probe runs, When it finishes,
  Then the host has received no hello from it and its wall time is within 10% of the baseline.
  Evidence: tests/cli/external.cli.test.ts › "probes stay silent"
AC-P4W3-17 [unit] Given a mod version bump at boot with an installed record, When the re-point
  runs, Then the list holds the new directory once and the old one not at all.
  Evidence: tests/companion/external-install-core.test.ts › "re-points on a version bump"
AC-P4W3-18 [live-verify] Given the switch turned on and then off, When the settings file is
  compared with its pre-install bytes after JSON normalisation, Then they are equal and a new
  outside session sends no hello.
  Evidence: LV-P4W3-c
AC-P4W3-21 [unit] Given two live external bindings, When the outside switch is turned off, and
  again when the kill switch is turned off, Then both bindings are revoked at once, their next
  request answers STALE_CONN and no hub input is produced afterwards.
  Evidence: tests/companion/external-binding.test.ts › "switch off revokes every external binding"
AC-P4W3-22 [mod-test] Given a tokenless mod whose `resume` hello is answered UNKNOWN_SESSION,
  When the hook runs again, Then exactly one tokenless hello is sent and the mod is not dormant.
  Evidence: resources/companion/tests/external.test.ts › "survives a Harnu restart"
AC-P4W3-23 [unit] Given an external binding with no `turn.started`, When EXTERNAL_CORROBORATE_MS
  passes, Then it is kept; and that long after its first `turn.started` with no corroboration it
  is dropped.
  Evidence: tests/companion/external-binding.test.ts › "the corroboration clock starts at the first turn"
```

**Human**

```
AC-P4W3-19 [human] Given the confirm dialog, When the operator reads it, Then it says what file
  changes, that every terminal session is affected, and how it is undone, before any write.
  Evidence: screenshot docs/specs/T389-companion-mod/evidence/P4W3-confirm.png
AC-P4W3-20 [human] Given a machine with managed settings that set `disableSideloadFlags`, When
  the switch is tried, Then it is refused with the policy sentence and `claude` still starts.
  Evidence: operator note in the Delivery Report (needs a managed test machine; Q-P4W3-c, OD-5)
  Guards: R23
```

**LV-P4W3-a.** 1. Second isolated Harnu with a temp HOME and config dir; companion mode `shadow`. 2. Turn the switch on; read the settings file. 3. In tmux, run `claude --debug-file <f>` in a
trusted folder; assert one `hooks module harnu-companion@inline loaded` line and one external hello
in the host log. 4. Start a session from Harnu; assert one loaded line, one spawned hello, zero
`UNAUTHORIZED`. 5. Record `claude --version`.
**LV-P4W3-b.** 1. Continue from a. 2. Submit a prompt that needs a permission in the tmux session. 3. Over CDP read the row's task state at 1 s intervals: `working`, then `needs-input`. 4. Read the
zone of its folder.
**LV-P4W3-c.** 1. Save the settings bytes. 2. On, then off. 3. Compare. 4. Start `claude` in tmux;
assert no hello and no `harnu-companion` line in its debug file.

## 12. Docs deliverables

| Contract                 | Deliverable                                                                                                                                                                                                                                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHANGELOG.md`           | `### Added` — "Harnu mod outside Harnu" (opt-in): sessions you start in your own terminal report real state to Harnu.                                                                                                                                                                                                                                   |
| `docs/harnu-features.md` | none. No verb, ACK or grant changes: `get_fleet` rows for outside sessions keep their shape, and `message_session` still refuses them.                                                                                                                                                                                                                  |
| `docs/user/`             | `mods.md` § "Harnu mod outside Harnu" (what it writes, what it shows, what it never does, how to remove it by hand, managed machines); `folders-and-worktrees.md` (the zone now has real state); `approval-inbox.md` (outside sessions are not held unless the folder is on the ramp); `troubleshooting.md` (a leftover entry after uninstalling Harnu) |
| `design.md`              | new §6 "Harnu mod outside Harnu (T389)"; Hover preview: the "outside Harnu" suffix                                                                                                                                                                                                                                                                      |
| i18n                     | the keys of §10 in both locales                                                                                                                                                                                                                                                                                                                         |
| Contract                 | already in `01-contract.md` §21; the wave lands `contract.ts` and fixtures with the code (DOC-7)                                                                                                                                                                                                                                                        |

## 13. Rollout & parity gate

The boolean key `external` is registered with P1W4's `registerPrefsKey` (default `false`,
`observeCap: false`; contract §11.5); it is true only while the switch is on. The profile needs
the key on, the companion mode not `off` and a live lease. An external binding obeys the per-family modes of P1W4 like any other: in `shadow`
it reports and the ledger records, and the registry and transcript tiers stay authoritative.

Parity for outside sessions is recorded under `tests/fixtures/companion-parity/taskState/` with
`origin: 'external'`, comparing companion state with the registry tier. External sessions flip
with the family, not separately, but only after **10 external sessions with zero unexplained
divergences** are in the ledger (QA-9); until then the adapter keeps external bindings in `shadow`
even when the family is `active` for spawned sessions.

Nothing legacy is demoted. The registry and transcript tiers stay (ARB-8).

## 14. Open questions

| Id       | Question                                                                                                                                                                                     | Default until settled                                                                                                   | Owner |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----- |
| Q-P4W3-a | Contract CQ18: does `CLAUDE_CODE_PLUGIN_DIRS` in settings `env` load a mod like the process env did in smoke A1?                                                                             | AC-P4W3-12. On failure: option C, re-specified before any code                                                          | P4W3  |
| Q-P4W3-b | Contract CQ18 (R24): flag and env key naming the same directory, one module instance or two?                                                                                                 | AC-P4W3-12. If two: Harnu omits its own companion `--plugin-dir` while the switch is on (ticks keep it)                 | P4W3  |
| Q-P4W3-c | OD-5, R23: does `disableSideloadFlags` make `claude` exit when the env key is present? If so an install would break every launch on that machine.                                            | refuse when any managed settings file exists; post-install check and rollback (§7.3 step 8); AC-P4W3-20                 | P4W3  |
| Q-P4W3-d | Master Q22: Desktop, VS Code, SDK, cloud. Do they honour the env key, and what `surface` do they report? Also upstream #96336 (a `$.prompt.submit` turn not shown on Desktop), asked by P2W2 | no claim; the band returns `next(e)` off the terminal (P4W2)                                                            | P4W3  |
| Q-P4W3-e | Selecting a row whose session is live in another terminal still offers resume, which would run it twice.                                                                                     | behaviour unchanged; a guard needs its own design                                                                       | P4W3  |
| Q-P4W3-f | Master Q1: the untrusted-folder prompt for a mod named by the env key                                                                                                                        | legacy tiers until the first hello                                                                                      | P1W2  |
| Q-P4W3-h | Master Q30: is the request rate bucket of an external binding per binding or per connection?                                                                                                 | **per binding** (`RATE_MAX_REQUESTS` per `RATE_WINDOW_MS`, contract CQ11), so one outside session cannot starve another | P4W3  |
| Q-P4W3-g | Does the PID registry carry `cwd` on every platform and CLI build (it is feature-gated)?                                                                                                     | transcript corroboration alone is enough                                                                                | P4W3  |

## 15. Risks

| Risk                                                                                                     | Sev    | Mitigation                                                                                                               |
| -------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------ |
| Harnu edits the user's settings and breaks them                                                          | High   | refusal rules, locked atomic write (no backup copy: the install record is the undo), exact undo (AC-P4W3-1 to AC-P4W3-4) |
| R23: the install blocks every `claude` launch on a policy-managed machine                                | High   | OD-5: refuse when a managed settings file exists (P4W3-S4); post-install check and rollback as a second net; AC-P4W3-20  |
| A forged tokenless hello paints false state on a real session                                            | Medium | corroboration; never for a spawned session; display only (P4W3-S1, P4W3-S2)                                              |
| R24: the companion loads twice in Harnu-spawned sessions and the two instances steal each other's `conn` | High   | AC-P4W3-12 gates the wave; fallback in Q-P4W3-b                                                                          |
| A leftover settings entry after Harnu is uninstalled                                                     | Low    | a missing directory is skipped by the CLI (to confirm in LV-P4W3-c); documented manual removal                           |
| R17: loading the mod surprises users                                                                     | Medium | default off, confirm dialog with the full disclosure, one visible path line                                              |
| Outside sessions read the Inbox as a gate                                                                | Medium | not held by default; coverage state on the row (SEC-7)                                                                   |
