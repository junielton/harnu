# T389 P4W1 — Mods audit tab

## 1. Status

Specified (not implemented) · 2026-10-02 · Epic T389 · Master: [`00-master.md`](00-master.md) ·
Contract: [`01-contract.md`](01-contract.md) · ADR-0018 · Verified against Claude Code CLI 2.1.287
and repo `main` @ `46d70c7d` (line references re-checked after the Harnu rename; the earlier base `b35a2c06` is not in this repository). "types L<n>" is a line of that release's `claude-code.d.ts`.

## 2. Depends on / Unblocks

- **Depends on:** nothing for part A (static audit). Base branch: `main`; it may ship before any
  companion code. Part B (live observation, §7.6) is a stacked increment whose base is the P1W4
  branch (it needs P1W3 and P1W4).
- **Unblocks:** P4W3 (the page `docs/user/mods.md` and the settings region).
- **Interfaces this wave conforms to** (master §12.1; the owner defines the signature):
  - P1W2 `ensureStaged(): Promise<string | null>`: the staged companion directory, or `null`. The
    repo folder is returned only when Harnu runs with `HARNU_COMPANION_DEV=1`. Until P1W2 is in the
    base the provider is absent and row 1 is absent.
  - P1W4 `registerPrefsKey` / `prefsKey` for `modsLive` (part B), and `getCompanionMode()`.
  - P1W4 `classifyPolicyProbe(output: string)` in `src/main/claude-policy-probe-core.ts` and
    its shell (master §12.1): P1W4 creates them. On a `main` base without P1W4 the pane reports
    `policy: 'unknown'` and shows no banner until a rebase brings the probe in.
  - P1W1 `companionHost.registerEventTypes` and `bus` for `mod.admitted` (part B).
- **Interfaces this wave owns:**
  - `permissionHookers(folder: string | null): { name: string; root: string }[]` (§7.5, master
    Q31).
  - The pane's settings region `#mods-companion` (§10). The Harnu mod switch lives in Settings →
    General → Integrations until this wave ships (master Q10, settled); this wave moves it here,
    and P4W2, P4W3 and P4W5 mount their switches in the same region.

## 3. Summary

A new Settings tab, **Mods**, placed directly after **Skills**. It lists every mod that a session
started in a folder can load, and for each one says what its source declares it **can** do, as
neutral chips. The data comes from a static read by the CLI (`claude plugin validate --json`), cached
by content hash. **The audit list is read-only**: it reveals folders and points at the mechanisms
that already turn a mod on or off. Harnu's own mod (the row named `harnu-companion`) is row 1 and
gets exactly the same treatment.

The audit list is a disclosure, not a control and not a verdict (SEC-7, R16). The pane also has a
settings region above the list, which hosts the Harnu mod switches of P1W4, P4W2, P4W3 and P4W5;
those are controls of Harnu's own mod, never of anyone else's.

## 4. Evidence

| Id                                              | Verdict   | What this wave takes from it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| smoke D2                                        | PARTIAL   | `validate --json` takes 500–760 ms, exit 0 or 1. Hook and call facts are free text in `contents[].notes[]` (`"<file> <label>: a, b, c"`). Not listed: URLs, argv, `$.fs` paths, `$.store` keys, `$.mcp.call` targets. A directory that also has a `marketplace.json` validates as a marketplace with `contents: []` and `success: true`. A user-tier gate is order-dependent.                                                                                                                                                                                                                                                                   |
| smoke D2                                        | PARTIAL   | `claude plugin list --json` covers installed marketplace plugins only: no `--plugin-dir` mod, no hook facts, not per session.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| measured here                                   | —         | `claude plugin list --json` on CLI 2.1.287, 2026-10-02: a top-level array of 202 rows, 18 unique `id`s. Row keys: `id`, `version`, `scope`, `enabled`, `installPath`, `installedAt`, `lastUpdated`, `projectEnabled`, `projectPath`, `mcpServers`. Scopes seen: `local` 180 (one row per `projectPath`), `user` 16, `project` 5, `synced` 1.                                                                                                                                                                                                                                                                                                    |
| smoke D3                                        | CONFIRMED | `validate` and `test` need only the `claude` binary; `.claude-plugin/types/` appears only after a session loaded the mod, so it is excluded from the content hash.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| smoke D6                                        | REFUTED   | No isolation between same-tier mods. A hook on an op name (`http.fetch`, `env.get`, …) reads and rewrites another mod's call. That is a capability chip in its own right.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| smoke A1                                        | CONFIRMED | A plugin folder loads through `--plugin-dir` and through `CLAUDE_CODE_PLUGIN_DIRS`; `--plugin-dir` is repeatable. Both are sources to list.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| CLI help                                        | —         | `claude plugin init` scaffolds `~/.claude/skills/<name>/`, which "auto-loads next session as `<name>@skills-dir`". `claude plugin enable` / `disable [plugin] --scope` exist.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| docs; reproduced in part for this review (RB-5) | PARTIAL   | `claude plugin test` run from a directory with no mod prints `no hooks module to load` (reproduced on 2.1.287: `no hooks module to load; there is no hooks/hooks.json naming one in "modules"`), and with `disableAllHooks` in the settings it prints `hooks modules are turned off here (disableAllHooks, allowManagedHooksOnly or a policy)` (reproduced: so `off-here` also covers a personal `disableAllHooks`, which turns off the legacy settings hooks as well). `hooks modules are turned off in this process` and the `allowManagedModsOnly` case were not reproduced; the latter is documented as not reported. Carried as AC-P4W1-9. |

## 5. Deviations from the study

| Study claim (item "new 2")                             | Deviation                                                                                                          | Source           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ---------------- |
| "A Mods tab … per folder, with an on/off switch"       | No switch for third-party mods. Read-only plus "Reveal folder"; on/off stays with the mechanism that owns the mod. | master §1; D13   |
| `validate --json` "lists what each mod intercepts"     | It does, as free text that this wave parses, with no destinations. Chips say "can", never where.                   | D13; smoke D2    |
| Implied: Harnu can refuse a mod (the allowlist gate)   | Out of scope, see §6.                                                                                              | smoke D2; C4, C9 |
| "127 of 359 mods run processes; 111 read every prompt" | UNTESTED counts. They do not appear in product copy or docs.                                                       | study verdict    |

## 6. Scope / Non-goals

**In scope.** Discovery of the five sources in §7.2; static analysis and its cache; the pane; the
policy banner over P1W4's shared policy probe; row 1 for the companion; the settings region; the
optional live observation of §7.6.

**Non-goals.**

- **No enable/disable, install, update or uninstall** of a third-party mod from this tab (master
  §1). The only switches are the Harnu mod's own, in the settings region.
- **No user-tier allowlist gate.** Decided out of scope, for six reasons:
  1. It is order-dependent: a gate judges only mods admitted after it (smoke D2, both load orders).
     The load order of installed and `skills-dir` mods relative to `--plugin-dir` is unknown
     (master Q3, recorded by part B: AC-P4W1-20).
  2. Where an organization's `sec-default` is seated, it passes `plugin.register` except under
     its `allowManagedModsOnly` option, which refuses every user-tier module outright (the
     companion included, so there is no hello at all). Read from the copy of its source in the
     CLI's mods repository (its README, "The rows"; not run on a managed machine, master Q8):
     a gate in a user-tier mod is therefore not pinned by `sec-default`, but under the option
     there is nothing left to gate, and without it the gate keeps the load-order limit of
     reason 1.
  3. A wedge by any mod skips the whole chain for that dispatch (C9): the gate fails open.
  4. A sibling can forge or rewrite anything at the same tier (smoke D6). Harnu cannot back the
     guarantee a gate implies (SEC-7, master non-goal "not a security boundary").
  5. Refusing a user's mod is changing which of the user's mods load, the habit this epic retires.
  6. A module that hooks `plugin.register` makes every reload re-run every module (types L4038,
     R25).

  The supported answer for "only these mods may load" is the organization's own
  `allowManagedModsOnly`. The tab says so in its footer hint.

- No runtime tracing of what a mod does. No destination, argv or path is ever shown, because the
  source does not expose them (smoke D2).
- No scan of marketplaces the user has not installed from (`claude plugin list --available`).
- No per-session "what did this session load" view for PTY sessions: `system/init` is only on
  stream-json (smoke D2). Part B approximates it for sessions with a live companion.

## 7. Design

### 7.1 Modules

| File                                             | Kind              | Owns                                                                                               |
| ------------------------------------------------ | ----------------- | -------------------------------------------------------------------------------------------------- |
| `src/main/mods-audit-core.ts`                    | pure, unit-tested | types, source planning, `list --json` normalisation, note parser, capability mapping, cache keys   |
| `src/main/mods-audit.ts`                         | shell (ADR-0001)  | fs discovery, hashing, running the CLI, the cache file, IPC; `registerModsAuditHandlers()`         |
| `src/main/claude-policy-probe-core.ts`           | pure, unit-tested | `classifyPolicyProbe` (master §12.1): created by P1W4; this wave reuses it                         |
| `src/main/claude-policy-probe.ts`                | shell             | P1W4's: runs `claude plugin test` at most once per boot and binary, and caches the answer          |
| `src/main/index.ts`                              | edit              | registers the handlers next to `registerBundledSkillsHandlers` (`index.ts:617`)                    |
| `src/preload/index.ts`                           | edit              | `modsAuditList`, `modsAuditAnalyse`, `onModsAuditRow`; `showItemInFolder` already exists (`:1177`) |
| `src/renderer/src/components/ModsAuditPane.vue`  | new, top-level    | the pane                                                                                           |
| `src/renderer/src/components/SettingsDialog.vue` | edit              | tab entry after `skills` (`:211-226`), pane mount after `:1037`                                    |
| `src/renderer/src/stores/ui.ts`                  | edit              | `'mods'` added to `SettingsTabId` (`:104`)                                                         |

No store: the pane keeps local refs, like `BundledSkillsPane.vue`.

IPC (`feature:verb`, request/response unless noted):

| Channel             | Argument                                       | Returns / emits                                   |
| ------------------- | ---------------------------------------------- | ------------------------------------------------- |
| `modsAudit:list`    | `folder: string \| null`                       | `ModsAuditView` (rows with cached analyses only)  |
| `modsAudit:analyse` | `{ folder, keys?: string[], force?: boolean }` | `{ queued: number }`; then `modsAudit:row` events |
| `modsAudit:row`     | (event, main → renderer)                       | one `ModRow` whose analysis settled               |

The renderer passes **row keys, never paths**. Main resolves a key against its own last listing, so
no caller can make Harnu run the CLI on an arbitrary directory.

### 7.2 Sources

| `source`       | Found by                                                                                                                                                                 | Loads in the folder when                                                                | Limits                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `harnu`        | `ensureStaged()` (P1W2)                                                                                                                                                  | companion mode is not `off` (P1W4)                                                      | absent until P1W2 ships                                             |
| `harnu-skills` | `stagedPluginDir(folder)` (`bundled-skills.ts:112`), only if the directory exists                                                                                        | a skill is on for the folder                                                            | skills only, no hooks module today; counted, not listed (see below) |
| `installed`    | `claude plugin list --json`, de-duplicated on `id` + `installPath`                                                                                                       | `scope` is `user` or `synced` and `enabled`; or `projectPath` equals the folder         | installed marketplace plugins only (smoke D2)                       |
| `skills-dir`   | directories under `~/.claude/skills/` and `<folder>/.claude/skills/` that contain `.claude-plugin/plugin.json`                                                           | the user approved it in a session; not knowable from outside → `loadsInFolder: unknown` | approval state is not readable; load order unknown (Q3)             |
| `boot-arg`     | `--plugin-dir <dir>` tokens in the folder's resolved Claude Boot `extraArgs` (`claude-args.ts:105`), and `CLAUDE_CODE_PLUGIN_DIRS` in `env` of `~/.claude/settings.json` | always, for Harnu-spawned sessions (flag) or every session (settings `env`)             | a `--plugin-dir` typed in a terminal outside Harnu is invisible     |

Global scope lists `harnu`, user-scope `installed`, `~/.claude/skills` and the settings `env` dirs.
Folder scope adds the folder's `installed` rows, its `.claude/skills`, its staged skills dir and its
Boot `extraArgs`.

**One row per root.** Rows are de-duplicated on the resolved `root`, with the precedence `harnu`,
`harnu-skills`, `installed`, `skills-dir`, `boot-arg`. With P4W3's outside switch on, the companion
directory is also named by `CLAUDE_CODE_PLUGIN_DIRS`: it is shown once, as `harnu`.

A plugin with no hooks module is not a mod. It is not listed; the pane shows one count line
("{n} plugins without a mod are not listed."). `hasModule` is decided by the analysis: a
`contents[]` entry of `type: "hooks"` with at least one `hooks:` or `calls:` note.

### 7.3 Data shapes

```ts
type ModSource = 'harnu' | 'harnu-skills' | 'installed' | 'skills-dir' | 'boot-arg'

interface ModRow {
  key: string // `${source}\u0000${id ?? name}\u0000${root}`
  name: string // plugin.json `name`
  id?: string // `<name>@<marketplace>` for `installed`
  source: ModSource
  scope?: 'user' | 'project' | 'local' | 'synced' // as the CLI reports it
  root: string // absolute plugin directory
  version?: string
  enabled: boolean | null // null: not knowable (skills-dir, boot-arg)
  loadsInFolder: 'yes' | 'no' | 'unknown'
  analysis: ModAnalysis | null // null: never analysed
}

interface ModAnalysis {
  status: 'ok' | 'invalid' | 'failed' | 'unsupported'
  hasModule: boolean
  hash: string // hex sha256, full; the pane shows the first 8
  hashKind: 'content' | 'stat'
  analysedAt: number // epoch ms
  cliVersion: string
  changedSince?: number // `analysedAt` of the previous analysis, when its hash differed
  hooks: { file: string; event: string; matcher?: string; opaque: boolean }[]
  calls: { file: string; op: string; via?: string }[]
  env: { reads: string[]; writes: string[] }
  state: { reads: string[]; writes: string[]; foreignUnchecked: string[] }
  unparsed: string[] // notes the parser did not recognise, shown verbatim
  errors: string[]
  warnings: string[]
  capabilities: CapabilityId[]
}

interface ModsAuditView {
  cli: { path: string | null; version: string | null }
  policy: 'loads' | 'off-here' | 'off-remote' | 'unknown'
  rows: ModRow[] // companion first, then by name
  withoutModule: number
  listedAt: number
}
```

### 7.4 Analysis algorithm

For each row to analyse (concurrency 2, 10 s timeout per run, `maxBuffer` 4 MiB, at most 200 rows):

1. **Hash.** Walk `root`, skipping `.git/`, `node_modules/` and `.claude-plugin/types/`. Hash the
   sorted list of `(relative path, size, sha256 of bytes)`. Over 2 000 files or 16 MiB, hash
   `(relative path, size, mtimeMs)` instead and set `hashKind: 'stat'`.
2. **Cache.** Key `hash + '\u0000' + cliVersion`. A hit returns the stored analysis untouched
   (`analysedAt` is the time it was computed, not the time it was read).
3. **Run** `claude plugin validate <root> --json` with `execFile`, the binary from
   `resolveClaudePath()` (`claude-cli.ts:108`), the env from `sanitizeSpawnEnv` and `cwd` set to the
   home directory, exactly like `usage.ts:44-47`. Exit 0 and 1 both carry a report.
4. **Marketplace trap.** If `manifest.type` is not `"plugin"`, or `contents` is empty while
   `<root>/.claude-plugin/plugin.json` exists, run once more with that file as the path (smoke D2).
5. **Parse** every `contents[].notes[]` string with
   `^(?<file>\S+) (?<label>hooks|calls|env reads|env writes|state reads|state writes|state of other plugins, not checked): (?<list>.*)$`.
   Split the list on `, ` outside `{…}` and `(…)`. A hook item is `event` or `event{matcher}`; a
   `?` matcher sets `opaque`. A call item is `$.noun.method` with an optional `(via <helper>)`.
   Anything else goes to `unparsed` verbatim. The parser never throws.
6. **Status.** `ok` when a report parsed; `invalid` when `success` is false (errors are shown);
   `failed` on timeout, spawn error or unparseable JSON; `unsupported` when the CLI rejects
   `plugin validate` or `--json`.
7. **Capabilities** by the closed table of §7.5.
8. **Store** in `<userData>/mods-audit-cache.json` (`{ v: 1, entries }`, temp file plus rename,
   at most 500 entries, oldest evicted). The previous entry for the same `key` supplies
   `changedSince`.

Analysis runs only when the tab is open: on mount for rows with no cache hit, and on **Refresh**
(`force`). Never at boot, never per spawn. First open with 18 unique plugins costs about 6–7 s of
background CLI time at concurrency 2 (18 × ~0.65 s ÷ 2, smoke D2 timings); rows fill in as
`modsAudit:row` events arrive.

**Policy probe.** The pane reads the shared probe (master §12.1). Its shell runs
`claude plugin test` with `cwd` set to a fresh empty directory under the OS temp dir (5 s timeout,
directory removed afterwards), **at most once per boot and binary**, and passes the output to the
pure `classifyPolicyProbe`: `no hooks module to load` → `loads`; `turned off here` → `off-here`;
`turned off in this process` → `off-remote`; anything else → `unknown`. **Refresh** does not
re-run it. P1W4 creates the probe; this pane and P4W3 call the same function; none of them runs
a second probe.

### 7.5 Capability chips

Chips are facts derived from `hooks` and `calls`. All use the **Default** badge variant
(`design.md` §6 Badges): colour would read as a verdict. Order is fixed as listed.

| `CapabilityId`  | Chip (`en`)                     | Derived from                                                               |
| --------------- | ------------------------------- | -------------------------------------------------------------------------- |
| `process`       | can run processes               | call `$.process.run` or `$.process.spawn`                                  |
| `network`       | can use the network             | call `$.http.fetch`                                                        |
| `files`         | can read and write files        | any call `$.fs.*`                                                          |
| `prompts`       | can read every prompt           | hook `prompt.submit`, `turn.start` or `classic.UserPromptSubmit`           |
| `system-prompt` | can change the system prompt    | hook `prompt.compose`, `prompt.section` or `prompt.context`                |
| `tool-calls`    | can rewrite or block tool calls | hook `tool.call` or `classic.PreToolUse`                                   |
| `permissions`   | can decide permissions          | hook `tool.check` or `classic.PermissionRequest`                           |
| `submit`        | can submit prompts              | call `$.prompt.submit`, `$.command.run` or `$.session.send`                |
| `model`         | can call the model              | call `$.model.complete`, `$.model.fork` or `$.model.classify`              |
| `mcp`           | can call MCP tools              | call `$.mcp.call`                                                          |
| `other-mods`    | can read other mods' calls      | hook on an op name (`http.fetch`, `env.get`, `store.*`, `state.*`, `fs.*`) |
| `gate`          | can refuse other mods           | hook `plugin.register`                                                     |
| `env`           | can read environment variables  | non-empty `env.reads`                                                      |
| `terminal`      | draws in the terminal           | hook `ui.render`                                                           |
| `opaque`        | has matchers Harnu cannot read  | any hook with `opaque: true`                                               |

**`permissionHookers` (master Q31).** P3W1's `contested / other-mod` coverage reason needs to know
whether a co-loaded mod can decide a permission. This wave offers
`permissionHookers(folder): { name: string; root: string }[]`: the rows that load in the folder,
other than `harnu`, whose **cached** analysis carries the `permissions` or `tool-calls` chip. It
never spawns the CLI: a mod that was never analysed, or whose hash changed since, is not in the
answer. It is therefore a lower bound, and P3W1 must word it as "another mod can decide", never as
"no other mod can".

### 7.6 Part B — live observation (optional, needs P1W3 + P1W4)

When a companion is live, it can report the structured `plugin.register` input (types L7176:
`name`, `tier`, `root`, `version`, `provenance`, `uses`) for mods admitted **after** it. The hook is
a pure observer: it always returns `next(e)`. It is the only `plugin.register` registration the
companion may have, and it exists only under `sense.mods` (MOD-3, R25).

Limits, stated in the UI: only mods admitted after the companion; nothing for a session whose
organization refuses user-tier mods (`allowManagedModsOnly`: the companion itself is not loaded);
nothing for sessions without a live lease. Whether `sec-default` otherwise passes the event to a
user-tier hook is read from its source, not yet observed (master Q8).

The host keeps the last observation per (`sid`, `root`) in memory only. The pane, in folder scope,
adds one line to a row's details: "Loaded in {session} at {time}." and, when the live `uses` holds
an event or call the static read lacks, "The running session reported {n} more than the static
read." It never removes a static chip.

The arrival order of `mod.admitted` per binding is also kept: it is the only observation of the
load order of marketplace-installed and `skills-dir` mods relative to `--plugin-dir` (master Q3).

**Default off.** `sense.mods` needs three things (contract §11.5): the `modsLive` key on, the
companion mode not `off`, and a live lease. The key stays `false` until AC-P4W1-16 shows the
reload cost (types L4038, contract CQ21) is acceptable. It is never enabled for the external
profile (contract §21 item 3).

### 7.7 Contract additions

None — merged into `01-contract.md`: the event `mod.admitted` (§8), the feature `sense.mods`
(§11.1, proof in §11.2), the key `modsLive` (§11.5) and the open question CQ21 (§20). Part A has
no wire surface.

## 8. Arbitration & fallback

There is no fact family and no legacy rival: nothing is arbitrated. Negative paths:

| Condition                                                         | Behaviour                                                                                                                                                                                               |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI not found (`resolveClaudePath()` is `null`)                   | `cli.path: null`; the pane shows the "CLI not found" state and no rows. No process is spawned.                                                                                                          |
| CLI too old (`validate` or `--json` rejected)                     | Rows are listed from the filesystem sources with `status: 'unsupported'` and no chips: "This Claude Code version cannot analyse mods."                                                                  |
| `plugin list --json` fails or changes shape                       | `installed` rows are dropped; the other sources still list; one hint line says installed plugins could not be read. Unknown keys are ignored.                                                           |
| A validate run times out or prints invalid JSON                   | That row is `failed` ("Could not analyse"), with **Retry**. Other rows are unaffected.                                                                                                                  |
| Policy probe says `off-here` or `off-remote`                      | Banner (§10). Rows are still listed and analysed: the read is static.                                                                                                                                   |
| `allowManagedModsOnly` (the probe cannot see it)                  | No banner. The header hint already says the list is what **can** load, not what did. Not detectable without a session (docs); see Q-P4W1-b.                                                             |
| Folder's Claude Boot has `--safe-mode` or `--bare`                | Folder scope shows one hint: "This folder starts sessions with `--safe-mode`, so no mod loads there." Read from the resolved `ClaudeBootConfig`.                                                        |
| Companion not staged (`ensureStaged()` is `null`, or before P1W2) | Row 1 is absent, with no placeholder.                                                                                                                                                                   |
| Cache file corrupt                                                | Treated as empty; rewritten on the next analysis.                                                                                                                                                       |
| A plugin directory vanishes between list and analyse              | Row `failed`; removed on the next listing.                                                                                                                                                              |
| Part B: mod absent, lease lost, host restart, `/clear`, reload    | The live line disappears; static rows are unchanged. Observations are memory-only and die with the binding or the host.                                                                                 |
| Part B: headless session                                          | `sense.mods` is a sensor, so it may be enabled; the pane shows such observations only while the lease is live.                                                                                          |
| Part B: external profile (P4W3)                                   | `sense.mods` is never enabled (contract §21 item 3). An outside session contributes no observation.                                                                                                     |
| Part B: kill switch turned off mid-session                        | The `conn` is revoked and the re-hello is answered `enable: []` (contract §3 item 9): the mod is inert and the session's observations are dropped at once, with no TTL wait. Static rows are unchanged. |
| Part B: `modsLive` off, or a CLI above the tested ceiling         | The key is capped at `off` (contract §11.5): no hook step runs, no line is shown.                                                                                                                       |

## 9. Security requirements

SEC-7 is the wave's core. In addition:

- **P4W1-S1.** Every chip reads "can …". The strings "safe", "verified", "trusted", "secure",
  "malicious" and "approved" appear in no `modsAudit.*` key (static test, both locales).
- **P4W1-S2.** The pane states its blind spots in place: no destinations, no arguments, no paths,
  static read only, and not what a running session actually loaded.
- **P4W1-S3.** Main runs the CLI only on directories it discovered itself (§7.1); `validate` is a
  static read (smoke D2 validated community mods without running them).
- **P4W1-S4.** The companion row is produced by the same code path as every other row. No field,
  chip or wording is special-cased for `source: 'harnu'` other than its position and its label.
- **P4W1-S5.** Part B's hook never refuses. A static test fails on a `refuse` property anywhere in
  `resources/companion/` (SEC-9f spirit: Harnu does not gate other mods), and on a
  `plugin.register` registration outside the `sense.mods` step (MOD-3).
- **P4W1-S6.** The cache holds hashes, names and declared capability facts only: no file content.

## 10. UX & copy

`design.md` gains **§6 → "Mods (Settings → Mods, T389)"**, placed after "Bundled skills", and the
Settings dialog tab list gains `Mods`. No new token and no new component: `SegmentedControl`,
`SettingHint`, the bordered `--surface` row of the Skills and MCP panes, and the Default badge.

```
+----------------------------------------------------------------------+
| MODS                                                   [ Refresh ]   |
| Mods run unsandboxed inside claude. This list shows what each one    |
| can do, from a static read of its source.              <- SettingHint|
| [ Global ][ my-repo ]                             <- SegmentedControl|
| (#mods-companion: the Harnu mod switches of P1W4, P4W2, P4W3, P4W5)   |
|                                                                      |
|  harnu-companion                                   Harnu · 0.1.0   >   |
|  (can use the network) (can decide permissions) (draws in the term…) |
|                                                                      |
|  token-chart                                 installed · user    >   |
|  (can run processes) (can read every prompt)                         |
|  Changed since 28 Sep.                                               |
|                                                                      |
| 12 plugins without a mod are not listed.                             |
| Not shown: where data goes, which commands run, which files are      |
| read. To allow only your organization's mods, an administrator sets  |
| allowManagedModsOnly.                                  <- SettingHint|
+----------------------------------------------------------------------+
```

- **Row:** name in `font-mono` 12.5px `--text`; right side: source label and version in 11px
  `--text-3`, then a chevron. Chips wrap under the name, `gap: 4px`.
- **Expanded row:** hooks (event plus matcher, `font-mono` 11px), calls (with "via {helper}"),
  env names read and written, state keys, unparsed notes verbatim, errors and warnings, the path
  in `font-mono` 11px `--text-4`, `{hash8} · Last analysed {time}`, and two actions: **Reveal
  folder** (`showItemInFolder`) and, per source, a hint naming the mechanism that owns the mod.
- **Scope:** the Skills pane's rule: the folder pill is the selected session's folder and is
  disabled with a hint when nothing is selected.
- **No toast** on refresh; rows show a `--text-4` "Analysing…" line while pending.

i18n keys, added to **both** `en.json` and `pt-BR.json` (technical nouns stay untranslated):

| Key                            | `en`                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `settings.tabs.mods`           | Mods                                                                                                          |
| `modsAudit.title`              | Mods                                                                                                          |
| `modsAudit.hint`               | Mods run unsandboxed inside `claude`. This list shows what each one can do, from a static read of its source. |
| `modsAudit.refresh`            | Refresh                                                                                                       |
| `modsAudit.scope.*`            | same five keys as `bundledSkills.scope.*`                                                                     |
| `modsAudit.source.harnu`       | Harnu mod                                                                                                     |
| `modsAudit.source.harnuSkills` | Harnu skills                                                                                                  |
| `modsAudit.source.installed`   | installed · {scope}                                                                                           |
| `modsAudit.source.skillsDir`   | skills folder                                                                                                 |
| `modsAudit.source.bootArg`     | `--plugin-dir`                                                                                                |
| `modsAudit.cap.<CapabilityId>` | the fifteen chip strings of §7.5                                                                              |
| `modsAudit.analysing`          | Analysing…                                                                                                    |
| `modsAudit.status.invalid`     | The CLI reported errors in this mod.                                                                          |
| `modsAudit.status.failed`      | Could not analyse this mod.                                                                                   |
| `modsAudit.status.unsupported` | This Claude Code version cannot analyse mods.                                                                 |
| `modsAudit.retry`              | Retry                                                                                                         |
| `modsAudit.lastAnalysed`       | {hash} · Last analysed {time}                                                                                 |
| `modsAudit.changedSince`       | Changed since {date}.                                                                                         |
| `modsAudit.loads.unknown`      | Harnu cannot tell whether this one is approved to load.                                                       |
| `modsAudit.withoutModule`      | {n} plugin without a mod is not listed. \| {n} plugins without a mod are not listed.                          |
| `modsAudit.blindSpots`         | Not shown: where data goes, which commands run, which files are read.                                         |
| `modsAudit.managedHint`        | To allow only your organization's mods, an administrator sets `allowManagedModsOnly`.                         |
| `modsAudit.reveal`             | Reveal folder                                                                                                 |
| `modsAudit.manage.installed`   | Turn it on or off with `/plugin` in a session, or `claude plugin disable {id}`.                               |
| `modsAudit.manage.harnuSkills` | Managed in Settings → Skills.                                                                                 |
| `modsAudit.manage.skillsDir`   | Remove its folder to stop it loading.                                                                         |
| `modsAudit.manage.bootArg`     | Loaded by this folder's startup arguments.                                                                    |
| `modsAudit.policy.offHere`     | Turned off by a setting or by your organization's policy.                                                     |
| `modsAudit.policy.offRemote`   | Mods are turned off remotely by Anthropic.                                                                    |
| `modsAudit.safeMode`           | This folder starts sessions with `--safe-mode`, so no mod loads there.                                        |
| `modsAudit.noCli`              | Claude Code CLI not found. Nothing to analyse.                                                                |
| `modsAudit.empty`              | No mods found.                                                                                                |
| `modsAudit.live.loaded`        | Loaded in {session} at {time}. (part B)                                                                       |
| `modsAudit.live.more`          | The running session reported {n} more than the static read. (part B)                                          |

`modsAudit.policy.offHere` is DOC-8's neutral wording: the probe shows that mods are off, not why,
so the string names no cause. "Blocked by your organization's policy" is never shown by this pane,
because it never positively identifies a managed cause.

The strings stay in the `modsAudit.*` namespace (master §15: keys that extend an existing surface
keep its namespace). The row is named `harnu-companion`, the plugin's own name, which Harnu cannot
change; its source label reads "Harnu mod".

## 11. Acceptance criteria

```
AC-P4W1-1 [unit] Given the validate report of smoke D2 (hooks and calls notes), When it is parsed,
  Then hooks, calls, env and state lists equal the fixture's expected structure.
  Evidence: tests/mods-audit-core.test.ts › "parses notes into structured facts"
AC-P4W1-2 [unit] Given a note with an unknown label or a malformed list, When it is parsed,
  Then it lands in `unparsed` verbatim and no exception is thrown.
  Evidence: tests/mods-audit-core.test.ts › "keeps what it cannot parse"
AC-P4W1-3 [unit] Given a report with `manifest.type` other than "plugin" and empty `contents`,
  When the plan is computed, Then a second run on `.claude-plugin/plugin.json` is requested.
  Evidence: tests/mods-audit-core.test.ts › "re-targets the marketplace trap"
AC-P4W1-4 [unit] Given the 202-row `plugin list --json` fixture (18 unique ids), When it is
  normalised for one folder, Then each id appears once and only rows of user scope or of that
  `projectPath` are marked as loading.
  Evidence: tests/mods-audit-core.test.ts › "de-duplicates installed rows per folder"
AC-P4W1-5 [unit] Given each hook and call of §7.5, When capabilities are derived, Then exactly the
  listed chip ids are returned, in table order.
  Evidence: tests/mods-audit-core.test.ts › "maps facts to capability chips"
AC-P4W1-6 [unit] Given both locale files, When the `modsAudit.*` values are scanned, Then none
  contains safe, verified, trusted, secure, malicious or approved (and the pt-BR equivalents).
  Evidence: tests/mods-audit-copy.test.ts › "chips never read as a verdict"
  Guards: R16
AC-P4W1-7 [contract] Given the installed CLI, When `plugin validate --json` runs on a fixture mod
  and `plugin list --json` runs, Then both outputs still satisfy the checked-in shape snapshots.
  Evidence: tests/cli/mods-audit-shape.cli.test.ts › "validate and list keep their shape" (--with-cli)
AC-P4W1-8 [integration] Given a plugin directory whose content did not change, When the tab is
  opened twice, Then the second open spawns no `validate` process for it.
  Evidence: tests/mods-audit-cache.test.ts › "a cache hit runs nothing"
AC-P4W1-9 [contract] Given the installed CLI, When `plugin test` runs in an empty directory,
  Then `classifyPolicyProbe` maps its output to loads, off-here, off-remote, or to unknown with no
  banner.
  Evidence: tests/cli/mods-audit-shape.cli.test.ts › "policy probe message is recognised"
AC-P4W1-10 [integration] Given no `claude` binary, When the tab opens, Then the "CLI not found"
  state renders and zero child processes are spawned.
  Evidence: tests/mods-audit-shell.test.ts › "no CLI, no spawn"
AC-P4W1-11 [integration] Given a validate run that exceeds 10 s, When the others finish,
  Then that row is `failed` with Retry and every other row shows its chips.
  Evidence: tests/mods-audit-shell.test.ts › "one timeout does not blank the pane"
AC-P4W1-12 [integration] Given an IPC call whose key is not in main's last listing,
  When `modsAudit:analyse` runs, Then no process is spawned for it.
  Evidence: tests/mods-audit-shell.test.ts › "unknown keys are ignored"
AC-P4W1-13 [unit] Given a changed file under a plugin root, When it is re-analysed, Then the row
  carries `changedSince` equal to the previous `analysedAt` and a new hash.
  Evidence: tests/mods-audit-core.test.ts › "records a change"
AC-P4W1-14 [live-verify] Given a staged companion, When the tab opens, Then `harnu-companion` is
  the first row, labelled "Harnu mod", and its chips equal the chips its checked-in
  `api-surface.json` implies.
  Evidence: LV-P4W1-a (runs once P1W2 is in the base; before that the row is absent — LV-P4W1-b)
AC-P4W1-15 [live-verify] Given policy `off-here` (a temp HOME with `disableAllHooks`),
  When the tab opens, Then the banner shows and rows are still listed.
  Evidence: LV-P4W1-c
AC-P4W1-16 [integration] (part B) Given two mods and the companion with `sense.mods`, When the
  second mod is saved, Then the count of `session.start` re-fires and the reload wall time are
  recorded; the feature stays off by default if the companion re-hellos more than once per save.
  Evidence: tests/cli/mods-live.cli.test.ts › "reload cost of a plugin.register hook"
AC-P4W1-17 [mod-test] (part B) Given any `plugin.register` input, When the companion's hook runs,
  Then it returns the result of `next(e)` unchanged and queues one `mod.admitted`.
  Evidence: resources/companion/tests/mods.test.ts › "observes, never refuses"
AC-P4W1-18 [integration] (part B) Given a session whose lease is lost, When the pane is open,
  Then its "Loaded in" lines disappear and static chips are unchanged.
  Evidence: tests/companion/mods-observed.test.ts › "observations die with the lease"
AC-P4W1-20 [integration] (part B) Given one `--plugin-dir` mod, one installed mod and one
  `skills-dir` mod loaded with the companion, When the session starts, Then the `mod.admitted`
  sequence is recorded per provenance and written to the evidence file (settles master Q3).
  Evidence: tests/cli/mods-live.cli.test.ts › "records the load order by provenance" (--with-cli)
AC-P4W1-21 [unit] (part B) Given a binding whose `conn` is revoked by the kill switch, When the
  host handles the revocation, Then every observation of that binding is dropped at once.
  Evidence: tests/companion/mods-observed.test.ts › "the kill switch drops observations"
AC-P4W1-22 [unit] Given cached analyses for three rows, one stale, When `permissionHookers` runs,
  Then it returns only the fresh rows with the permissions or tool-calls chip and spawns nothing.
  Evidence: tests/mods-audit-core.test.ts › "permission hookers come from the cache only"
AC-P4W1-23 [unit] Given the companion directory named by `ensureStaged()` and by the settings
  `env` list, When the rows are planned, Then it appears once, with source `harnu`.
  Evidence: tests/mods-audit-core.test.ts › "one row per root"
```

**Human**

```
AC-P4W1-19 [human] Given the pane in a light and a dark theme, When compared with the design.md
  section, Then row shape, chip variant and hints match with no raw colour.
  Evidence: screenshots docs/specs/T389-companion-mod/evidence/P4W1-{light,dark}.png
```

**LV-P4W1-a (row 1).** 1. Build and start a second isolated instance
(`docs/dev/live-verify-second-instance.md`). 2. Open Settings → Mods. 3. Read the first row over
CDP. 4. Compare its chip ids with the set derived from `resources/companion/api-surface.json`.
**LV-P4W1-b (no companion).** Same on a base without P1W2: assert no `harnu` row and no placeholder.
**LV-P4W1-c (policy).** 1. Create a temp HOME whose `.claude/settings.json` sets
`disableAllHooks`. 2. Start the isolated instance with that HOME. 3. Open the tab; assert the
banner key and a non-empty row list. 4. Record `claude --version`.

## 12. Docs deliverables

| Contract                 | Deliverable                                                                                                                                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHANGELOG.md`           | `### Added` — "Settings → Mods lists the mods your sessions can load and what each one can do. Read-only."                                                                                                                                  |
| `docs/harnu-features.md` | none; not agent-facing (no verb, no ACK, nothing to offer proactively). Part B adds no verb either.                                                                                                                                         |
| `docs/user/`             | new `mods.md` (what the tab shows, what it cannot show, how to turn a mod off at its owner; it says that the row named `harnu-companion` is the Harnu mod); `README.md` index; `settings.md` tab map; a cross-link from `bundled-skills.md` |
| `design.md`              | new §6 "Mods (Settings → Mods, T389)"; Settings dialog tab list; §8 one Do line: "can run processes" (a fact, never a verdict)                                                                                                              |
| `CLAUDE.md`              | design-entity map row: "Mods audit pane (Settings tab, T389) → `ModsAuditPane.vue`"                                                                                                                                                         |
| i18n                     | the keys of §10 in `en.json` and `pt-BR.json`                                                                                                                                                                                               |
| Contract (part B only)   | already in `01-contract.md` (§8, §11.1, §11.5); part B lands `contract.ts`, the fixtures and `api-surface.json` with the code (DOC-7)                                                                                                       |

The user-docs gate fires twice (a top-level component and a top-level main file); `mods.md`
satisfies it.

## 13. Rollout & parity gate

No fact family, no shadow comparison, no legacy seam demoted. Part A ships on with no flag: it is
read-only and spawns nothing until the tab is opened. Merge bar: QA-4 with `--with-e2e`, plus
`--with-cli` for AC-P4W1-7 and AC-P4W1-9. Part B registers the boolean key `modsLive` with P1W4's
`registerPrefsKey` (default `false`, `observeCap: false`); `sense.mods` needs the key on, the
companion mode not `off` and a live lease (contract §11.5). The key flips on AC-P4W1-16 (CQ21),
recorded in the master plan.

## 14. Open questions

| Id       | Question                                                                                                                | Default until settled                                                                                                                                   | Owner |
| -------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| Q-P4W1-a | Master Q4: is the `notes[]` label set stable across CLI releases?                                                       | snapshot (AC-P4W1-7); unknown labels fall into `unparsed`                                                                                               | P4W1  |
| Q-P4W1-b | Can `allowManagedModsOnly` be detected without a session?                                                               | no banner; the hint names the option                                                                                                                    | P4W1  |
| Q-P4W1-c | Does `plugin list --json` include `skills-dir` plugins and their approval state? (one of 202 rows lacked `installedAt`) | discover them from the filesystem, `loadsInFolder: unknown`                                                                                             | P4W1  |
| Q-P4W1-d | Master Q3: load order of installed and `skills-dir` mods relative to `--plugin-dir`                                     | AC-P4W1-20 records it; until then part B claims nothing about mods it did not observe                                                                   | P4W1  |
| Q-P4W1-e | Does `validate` accept a `plugin.json` path for every plugin, so the trap needs no second run?                          | directory first, file on the trap                                                                                                                       | P4W1  |
| Q-P4W1-f | Master Q25: should the companion audit log and the native-message audit get a pane?                                     | **decided: no, file only** (`<userData>/companion/audit.ndjson`). The Mods tab audits mods, not Harnu's own commands; a log viewer is a separate design | P4W1  |
| Q-P4W1-g | Master Q31: static detection of a co-loaded mod that can decide a permission                                            | **decided: offered** as `permissionHookers` (§7.5), a lower bound from cached analyses                                                                  | P4W1  |
| Q-P4W1-h | Contract CQ21: is the reload cost of a `plugin.register` hook acceptable?                                               | `modsLive` stays `false` (AC-P4W1-16)                                                                                                                   | P4W1  |

## 15. Risks

| Risk                                                                              | Sev    | Mitigation                                                                                   |
| --------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------- |
| R16: the pane is read as a safety verdict                                         | Medium | P4W1-S1, P4W1-S2; neutral chips; blind spots stated in place                                 |
| A mod with zero `$` calls rewrites through `next()` and shows few chips           | Medium | the hook chips (`tool-calls`, `prompts`, `other-mods`) come from `hooks:`, not from `calls:` |
| The free-text report changes shape and chips silently vanish                      | Medium | AC-P4W1-7 snapshot in local-ci; `unparsed` is shown, so a miss is visible, never silent      |
| First open is slow on a machine with many plugins                                 | Low    | cache by content hash; concurrency 2; rows stream in                                         |
| The Harnu mod's own row embarrasses Harnu ("can decide permissions")              | Low    | intended: it is the credibility of the pane (P4W1-S4)                                        |
| R25: part B's `plugin.register` hook makes user mod development reload everything | Medium | default off; CQ21, AC-P4W1-16 decides                                                        |
