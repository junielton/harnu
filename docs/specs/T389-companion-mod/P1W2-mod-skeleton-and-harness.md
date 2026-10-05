# T389 P1W2 — Mod skeleton, staging, CLI version gate, test harness

## 1. Status

**Specified (not implemented)** · 2026-10-02 · Epic T389 · Wave P1W2
**Reads:** [`00-master.md`](00-master.md) · [`01-contract.md`](01-contract.md) ·
[ADR-0018](../../adr/0018-harnu-mod-as-integration-substrate.md) ·
[`P1W1-host-server.md`](P1W1-host-server.md) · `docs/specs/T200-cli-version-detection.md` ·
`docs/studies/T389-smoke-evidence.md`
**Verified against:** repo `main` @ `46d70c7d` (line references re-checked after the Harnu rename; the earlier base `b35a2c06` is not in this repository); Claude Code CLI 2.1.287 (minimum) and 2.1.289 (tested ceiling, smoke §11).

## 2. Depends on / Unblocks

- **Depends on:** P0. Runs in parallel with P1W1 and is **rebased onto it before P1W3 starts**.
  From P1W1 it expects: `resources/companion/hooks/contract.ts`, `getCompanionMode()`
  (`src/main/companion/mode.ts`), `companionHost.mintSpawnToken(meta)` / `releaseSpawn(owner, reason)`
  and the `SpawnOwner` / `TrustClass` types (P1W1 §7.5, §7.7). Until the rebase, this wave
  compiles against a local stub of those three with the same signatures.
- **Unblocks:** P1W3 (it fills `register.ts` with the handshake), every later wave (the harness).

## 3. Summary

The plugin `harnu-companion` as a loadable, deliberately empty skeleton; its immutable, versioned
staging into the app's data directory; the second `--plugin-dir` and the spawn token in the spawn
path; the CLI version gate; a developer hot-reload mode; and the whole test harness: static
surface checks in `npm test`, a `mod` step in local-ci (`claude plugin validate`,
`claude plugin test`), and opt-in real-CLI integration tests against a fake host. The skeleton
hooks nothing that changes a session. With the default mode `off`, a spawn's argv and env are
byte-identical to today's.

## 4. Evidence

| Smoke id | Verdict   | What this wave takes from it                                                                                                                                                                                                           |
| -------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1       | CONFIRMED | A repeated `--plugin-dir` loads both plugins; a `--plugin-dir` mod runs at tier `user`, provenance `<name>@inline`; no consent prompt in 12 launches **in a trusted folder**. Untrusted folder: could not test.                        |
| A2       | CONFIRMED | `$.env.get` reads a spawn-time env var inside `session.start`; `globalThis.process` is absent in the worker.                                                                                                                           |
| A5       | CONFIRMED | Editing the hooks file reloads the mod in about 600 ms and wipes module state; a `$` passed to a helper not declared at the top of the hooks file makes the module **not load** (silent when interactive, one stderr line under `-p`). |
| C2       | CONFIRMED | Reload latency 0.8 s to over 10 s; `session.start` re-fires. This is why production stages an immutable directory.                                                                                                                     |
| D2       | PARTIAL   | `claude plugin validate --json` reports hooks and `$` calls only as free text in `contents[].notes[]`; a folder with a `marketplace.json` validates as a marketplace with `contents: []`, so the `plugin.json` path must be passed.    |
| D3       | CONFIRMED | `claude plugin test` runs offline with an empty HOME in 0.19 s, no model call; stubs are `on('<op>', …)` hooks; `.claude-plugin/types/` exists only after a session has loaded the mod; `tsc` against those types catches real errors. |
| D6       | REFUTED   | No isolation at the same tier, in either load order. Being the first `--plugin-dir` buys ordering for `plugin.register`, not protection.                                                                                               |
| B6       | CONFIRMED | A hook that spins is unloaded after 5 s and the whole chain is skipped for that call; a throw is skipped and reported once.                                                                                                            |
| B4       | CONFIRMED | Any `tool.call` hook on Bash breaks `Agent(isolation: "worktree")` (#92533). Enforced statically here (R8).                                                                                                                            |
| C4       | CONFIRMED | A mod-registered command answers with no model turn: the basis of the zero-model integration harness.                                                                                                                                  |

Not smoke evidence, cited as documentation only: the CLI's admin page states "Trust prompts come
first. In an interactive session in a directory the user hasn't trusted yet, no mod loads until
they answer the trust prompt"; the authoring reference states the engine lays
`.claude-plugin/types/` beside a `--plugin-dir` mod "at every load and reload".

Harnu code read for this wave:

- `src/main/pty.ts:622` (ptyId), `:772-793` (`withOptionArgs` callback: the only legal place for
  an argv injector, BUG-86), `:786-791` (hook blob, then bundled skills), `:806-821` (env build),
  `:831-840` (missing-directory notice replaces the command), `:842` (spawn), `:902-926` (`onExit`),
  `:736-766` (read-only and agent-controlled branches).
- `src/main/claude-args.ts:468` (`splitOptionArgs`), `:482` (`insertOptionArgs`), `:499`
  (`withOptionArgs`).
- `src/main/bundled-skills-core.ts:183-195` (`insertPluginDirArg`: empty set emits nothing,
  never doubles a directory, lands before `--`), `src/main/bundled-skills.ts:407-412` (tree
  removed when nothing is enabled), `:457-480` (sibling temp dir plus rename).
- `src/main/scheduler-core.ts:654` (a tick already takes one `--plugin-dir`), `:660`
  (`--setting-sources ''`), `src/main/scheduler-shell.ts:446` (`spawn`, no env override).
- `src/main/usage.ts:44-46` and `src/main/haiku.ts` (probe spawns: never injected, D1).
- `src/main/claude-cli.ts` (path cache; no version probe exists), T200 spec §3.
- `scripts/ci/local-pipeline.sh` (steps, `--skip`, `--json`), `vitest.config.mts`
  (`include: tests/**/*.test.ts`, coverage floors), `tsconfig.node.json`, `electron-builder.yml:30-42`.

## 5. Deviations from the study

| Deviation                                                                                                                                          | Decision | Evidence                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------- |
| The study put `hooks/` in the existing skills plugin directory. The companion gets its own, second `--plugin-dir`.                                 | D1, C8   | `bundled-skills.ts:445-450`, `:475-477`; smoke A1         |
| The study read coordinates from the session. They are baked into a generated module at staging.                                                    | D2       | smoke D6; SEC-4                                           |
| The study assumed no version gate was needed. A CLI version gate is new work.                                                                      | D4       | T200 spec §2 ("no runtime version check exists anywhere") |
| D1 says "dev builds point at the repo folder". Here that is an **explicit developer opt-in**, not the default of every unpackaged run (see §7.5).  | D1       | `docs/dev/live-verify-second-instance.md`; smoke A5, C2   |
| The QA paper put the `tsc`-against-generated-types check in the `mod` step. It runs under `--with-cli`, because the types exist only after a load. | QA-6     | smoke D3                                                  |

## 6. Scope / Non-goals

**In scope.** `resources/companion/**`; `src/main/companion/{staging-core,staging,version-gate,spawn-inject,sideload-retry-core}.ts`;
`src/main/claude-cli-version.ts` and the probe in `claude-cli.ts` (T200 §3.1–§3.3 only); edits to
`pty.ts`, `scheduler-core.ts`, `scheduler-shell.ts`, `index.ts`, `electron-builder.yml`,
`tsconfig.node.json`, `scripts/ci/local-pipeline.sh`; `scripts/ci/mod-step.mjs`;
`tests/cli/**`; the static tests.

**Non-goals.**

- No handshake and no network call from the mod (P1W3). The skeleton never calls `$.http.fetch`.
- No T200 UI row, IPC or i18n (T200 §3.4 stays with its own card).
- No mode UI, no disclosure (P1W4). No Mods tab (P4W1).
- No install outside `--plugin-dir` (P4W3). No write to the user's Claude settings.
- No injection into the `/usage` and haiku probes (D1).

## 7. Design

### 7.1 Source layout (`resources/companion/`)

```
resources/companion/
  .claude-plugin/plugin.json     name "harnu-companion", version = modVersion, "types": "./types/index.d.ts"
  types/index.d.ts               the plugin's contract: interface PluginState { 'harnu-companion': { … } }
  hooks/hooks.json               { "modules": ["./register.ts"] }
  hooks/register.ts              the hooks module; every function that takes `$` is declared here (MOD-1)
  hooks/contract.ts              wire types and constants, zero imports (created by P1W1)
  hooks/coords.gen.ts            GENERATED, gitignored; never hand-edited
  hooks/lib/*.ts                 `$`-free pure helpers only (ring buffer, wire encode); relative imports
  hooks/surface.tsx              the band's view (P4W2): a pure builder imported by register.ts; never takes `$`; staged like any file under hooks/
  api-surface.json               the checked-in surface manifest (§7.7)
  tsconfig.json                  { "extends": "./.claude-plugin/types/tsconfig.json" }
  tests/*.test.ts                `claude plugin test` suites (import `claude-code/testing`)
  tests/fixtures/*.ts            golden fixtures shared with vitest (contract §19)
  .gitignore                     .claude-plugin/types/ and hooks/coords.gen.ts
```

`PluginState` ships **empty** in this wave. Each wave declares its own `$.state` keys in
`types/index.d.ts` in its own change (MOD-1; the registry and the owners are contract §22): P1W3
adds `conn`, `bootId`, `sid`, `boot` and `probes`, P2W1 adds `channel`, and so on.

**Skeleton `register.ts`.** It registers exactly one hook, `session.start`, wrapped per MOD-2,
that returns `next(e)` and does nothing else. Its only purpose is to make "the mod loaded" an
observable line in the debug log (`hooks module harnu-companion@inline loaded`) and to give the
harness something to assert. It imports `coords.gen.ts` and `contract.ts` so a missing or broken
generated file fails validation here, not in P1W3.

### 7.2 Generated coordinates

```ts
// hooks/coords.gen.ts — written by staging; the mod's only source of coordinates (SEC-4)
export const RENDEZVOUS_PATH = '/abs/path/to/app-data/companion/endpoint.json'
export const MOD_VERSION = '0.1.0'
export const STAGED_AT = 1790000000000
```

`renderCoords(fields: Coords): string` in `staging-core.ts` is the renderer. `Coords` is the
export list of contract §23: this wave ships the first three fields; a wave that needs another
baked value adds a field to `Coords` and to the generator in its own change (P2W4 adds
`EXEMPT_CWD_DIRS`, `SCRATCH_PARENTS`, `CLAUDE_PROJECTS_ROOT`). The renderer emits one `export
const` per field, every value through `JSON.stringify`, so a quote or backslash in a
data-directory name cannot break out of a literal. The file holds no token and no secret. The
stage digest covers the rendered file, so a changed value stages a new directory.

### 7.3 Staging (`staging-core.ts` pure, `staging.ts` shell)

Target: `<app data>/companion/<stageKey>/harnu-companion/`.

```ts
export const STAGE_ALLOW = ['.claude-plugin/plugin.json', 'types/', 'hooks/'] as const
// never staged: tests/, api-surface.json, tsconfig.json, .gitignore, .claude-plugin/types/ (MOD-9)

export function stageManifest(files: { rel: string; sha256: string }[], coords: string): string // hex digest
export function stageKeyFor(modVersion: string, wanted: string, onDisk: string | null): string
//   onDisk === null || onDisk === wanted → modVersion
//   otherwise                           → `${modVersion}.${wanted.slice(0, 8)}`
export function insertCompanionPluginDir(args: readonly string[], dir: string): string[]
```

`ensureStaged(): Promise<string | null>` (shell), memoised per app run and re-validated per spawn.
It is the one interface other waves call for the staged directory (P4W1, P4W3); there is no
`companionPluginDir()`.

1. Compute `wanted` = digest over the allowed source files plus the rendered coordinates.
2. Read `<modVersion>/harnu-companion/.stamp`. Equal → return that directory.
3. Absent → build in a sibling temp directory and `rename` it in (the `bundled-skills.ts:457-480`
   shape), write `.stamp`, return it.
4. **Different** (an app update that kept `modVersion`, a changed data-directory path, or a
   same-user rewrite, R15) → never touch the existing tree, because a write would hot-reload it
   in every live session (smoke A5). Stage a sibling keyed `<modVersion>.<hash8>` and return that.
5. Per spawn: re-hash the chosen directory's allowed files (about 10 small files) against its
   `.stamp`; a mismatch is case 4. `.claude-plugin/types/`, which the engine writes on load, is
   excluded from the hash.
6. Any failure → log once, return `null`: the spawn proceeds with no companion.

Garbage collection pins by **directory**, not by version (a stage key may be
`<modVersion>.<hash8>`). `spawn-inject.ts` records the `pluginDir` it handed out per `SpawnOwner`
and drops the record at `releaseSpawn`. Other holders register through
`pinStagedDir(fn: () => string[]): void` (P4W3's install record pins its directory, MOD-9). At
boot, a stage directory is removed only when it is not the current one, no spawn record and no
pin names it, and its `.stamp` is older than 14 days. Never during a session.

**Read-only hardening is not applied.** The engine writes `.claude-plugin/types/` into a
`--plugin-dir` folder on every load; whether a read-only folder still loads is untested, so the
staged tree keeps mode `0700` directories and `0600` files (OQ-3).

### 7.4 Injection in the spawn path

New provider in `pty.ts`, same pattern as `setBundledSkillsArgsProvider` (`pty.ts:449`):

```ts
export interface CompanionSpawnPlan {
  pluginDir: string
  /** Called only when `claude` is really about to be spawned. Null → spawn without a token. */
  mintToken(owner: SpawnOwner): string | null
}
export function setCompanionSpawnProvider(
  fn: (ctx: { cwd: string; trust: TrustClass }) => Promise<CompanionSpawnPlan | null>
): void
```

`spawn-inject.ts` implements it: `null` when `getCompanionMode() === 'off'`, when the version gate
says no (§7.6), when the machine is marked sideload-blocked (§7.8), or when `ensureStaged()`
returned `null`.

P1W4 replaces the mode and gate tests at this call site with one call, whose signature it owns
(master §12.1):

```ts
companionInjectDecision(ctx: { kind: string; cliGate: CliGate }): {
  inject: boolean
  skip?: 'off' | 'pre-disclosure' | 'cli-too-old' | 'cli-unknown' | 'not-claude'
}
```

`cliGate` carries all four values of §7.6; `unknown` yields `skip: 'cli-unknown'` and `below`
yields `'cli-too-old'`. The sideload and staging conditions stay here.

Changes in `pty:create`:

1. **Argv**, inside the existing `withOptionArgs` callback and nowhere else (BUG-86), **before**
   the bundled-skills injector:
   `out = plan ? insertCompanionPluginDir(out, plan.pluginDir) : out`.
   `insertCompanionPluginDir` splits at the bare `--`, returns the argv unchanged if that exact
   directory is already present, and otherwise inserts `--plugin-dir <dir>` **immediately before
   the first existing `--plugin-dir` of the option portion**, or at its end when there is none.
   The companion is therefore first even when the user's Claude Boot extra args carry their own
   `--plugin-dir` (MOD-9). Applied to every `claude-*` kind including read-only and
   agent-controlled spawns (the master's fallback matrix gives those the sensor); never to `shell`.
2. **Env**, after the env object is built (`pty.ts:806-821`):
   `delete env.HARNU_SPAWN_TOKEN` **always** (a Harnu launched from inside a Harnu session would
   otherwise forward a spent token); then, only if `plan` exists and the missing-directory notice
   did not replace the command (`pty.ts:831-840`),
   `const t = plan.mintToken({ kind: 'pty', ptyId: id }); if (t) env.HARNU_SPAWN_TOKEN = t`.
   `trust` is `'read-only'` for `opts.readOnly`, `'agent'` for `opts.agentControlled` or
   `spawnedBy === 'agent'`, else `'operator'`.
3. **Exit**: `companionHost.releaseSpawn({ kind: 'pty', ptyId: id }, 'pty-exit')` in `onExit`
   (specified in P1W1 §7.7; the call site lands here).

Scheduler ticks: `TickContext` gains `companionPluginDir?: string`; `tickArgv` pushes it before
the skills `--plugin-dir` (`scheduler-core.ts:654`). `scheduler-shell.ts` passes
`env: { ...process.env, HARNU_SPAWN_TOKEN: token }` with owner
`{ kind: 'tick', workerId, runId }` and trust `'tick'`, and calls `releaseSpawn(…, 'tick-done')`
when the child closes. If the plan is `null` the tick's argv and env are unchanged.

### 7.5 Developer hot-reload mode

Opt-in, unpackaged builds only: launching Harnu with `HARNU_COMPANION_DEV=1` (read by Harnu main,
not by the mod, so SEC-4 is untouched) makes `ensureStaged()` return the repository folder
`resources/companion/` itself and write the gitignored `hooks/coords.gen.ts` there once at boot
(only when its content differs). Editing a hook then reloads it in every live session of that
instance within about a second (smoke A5).

It is not the default for unpackaged runs because two unpackaged instances with different data
directories (the developer's own and the live-verify one) would both rewrite the single
`coords.gen.ts` in the repository, hot-reloading each other's sessions onto the wrong endpoint.
In a packaged build the variable is ignored. A second instance started with the flag while
another holds it logs a warning and stages normally (a lock file
`resources/companion/.dev-lock` holding the owner's pid, gitignored).

### 7.6 CLI version gate

Implements T200 §3.1–§3.3 verbatim: `src/main/claude-cli-version.ts` (`parseClaudeVersion`,
`compareClaudeVersions`, `isAtLeast`) and, in `claude-cli.ts`, `resolveClaudeVersion()`
(single-flight, never rejects), `claudeVersionSync()` (never spawns) and the extra resets in
`clearClaudePathCache()`. `void resolveClaudeVersion()` fires at boot. T200's two existing mock
factories (`tests/usage-poller.test.ts:42`, `tests/haiku-service.test.ts:31`) are extended.

```ts
// src/main/companion/version-gate.ts (pure)
export const COMPANION_MIN_CLI = '2.1.287'
export type CliGate = 'unknown' | 'below' | 'ok' | 'above'
export function cliGate(v: ClaudeVersion | null, ceiling: string): CliGate
export function gateAllowsInjection(g: CliGate): boolean // 'ok' | 'above'
```

- `ceiling` is `api-surface.json`'s `lastVerifiedCli`, imported as JSON at build time.
- `unknown` (probe not finished, or failed) and `below` → no injection (ARB-7a). The spawn path
  reads `claudeVersionSync()` and **never awaits** the probe (T200 §3.3 is a hard constraint).
- `above` → inject; the session is forced to `shadow` by P1W4 (ARB-7b). This wave only
  exposes `cliGate`.
- A live session keeps the binary it started with (`mcp/deny-hint.ts:242`). The per-session truth
  is `hello.cli.version`; P1W3 re-evaluates `cliGate` on it.

### 7.7 `api-surface.json` and the three drift checks

```json
{
  "v": 1,
  "plugin": "harnu-companion",
  "minCli": "2.1.287",
  "lastVerifiedCli": "2.1.289",
  "hooks": ["session.start"],
  "calls": [],
  "envReads": [],
  "stateKeys": []
}
```

| Way          | Where                                                      | Compares                                                                                                                                                                       |
| ------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 — static   | `tests/companion/api-surface.test.ts` (`npm test`, no CLI) | `on('…'` patterns and `$.noun.method(` calls scraped from `hooks/**/*.ts` and `hooks/**/*.tsx` equal `hooks` and `calls`; `$.env.get("…")` literals equal `envReads`.          |
| 2 — validate | `scripts/ci/mod-step.mjs` (local-ci `mod`)                 | `notes[]` lines `"<file> hooks: …"`, `"… calls: …"`, `"… env reads: …"` parsed by `parseValidateNotes()` equal the manifest. The parser is pure and unit-tested on a snapshot. |
| 3 — types    | `tests/cli/types.cli.test.ts` (local-ci `--with-cli`)      | after one real load into a temp copy, `tsc -p <copy>/tsconfig.json` exits 0.                                                                                                   |

The same static test enforces MOD-3 and SEC-9 as assertions on the source, independent of the
manifest: no `tool.call` registration whose matcher can match `Bash`; no `'*'` event; no
`turn.step`; no `$.process.`; no `$.mcp.call`; `hooks/contract.ts` has zero `import` statements;
every `import` in `hooks/` is relative and stays inside the plugin directory; no function outside
`register.ts` takes a parameter named `$`.

`lastVerifiedCli` (the tested ceiling, initially 2.1.289 per smoke §11; `minCli` stays 2.1.287) is edited by hand, and only in a change whose evidence
shows ways 1–3 and the live recipe LV-P1W2-a green on that CLI version (QA-6).

### 7.8 Sideload blocked by policy (Q6)

Under `disableSideloadFlags` the CLI exits at startup when given `--plugin-dir`. The message text
was not captured by any smoke run, so detection is by behaviour, not by string:

```ts
// sideload-retry-core.ts (pure)
export function shouldRetryWithoutSideload(x: {
  injected: boolean // this spawn carried a Harnu --plugin-dir
  exitCode: number
  livedMs: number // spawn → exit
  helloSeen: boolean // the ledger entry left `minted`
  retried: boolean
}): boolean // injected && exitCode !== 0 && livedMs < 5000 && !helloSeen && !retried
```

When it returns true, `pty.ts` does not forward `pty:exit`. It respawns the same PTY record with
every **Harnu-injected** `--plugin-dir` removed (companion and bundled skills; the user's own stay)
and without the token, and writes one dim line into the terminal stream:
`Harnu: restarted without bundled plugins.` If the retry lives past 5 s the machine is marked
`sideloadBlocked` for the app run (in memory; P1W4 persists it) and later spawns skip both flags. The first process's last output
(at most 2 KiB, never logged) is kept with the mark so that P1W4 can match it against the real
exit text once LV-P1W4-e has recorded it (Q6): detection by behaviour alone does not identify a
managed cause, so P1W4 words the state neutrally until then (DOC-8). If the retry also dies, its exit
is forwarded as today. No retry ever happens when the spawn was not injected.

### 7.9 Test harness

| Layer | What                                         | Runner / location                                                                 | Gate                        |
| ----- | -------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------- |
| L1    | staging core, gate, retry core, notes parser | vitest, `tests/companion/*.test.ts`                                               | `npm test`                  |
| L1    | static surface and authoring rules           | vitest, `tests/companion/api-surface.test.ts`                                     | `npm test`                  |
| L2    | golden fixtures against `wire-core` (P1W1)   | vitest, importing `resources/companion/tests/fixtures/*.ts`                       | `npm test`                  |
| L3    | mod unit tests                               | `claude plugin test`, `resources/companion/tests/*.test.ts`                       | local-ci `mod`              |
| L4    | real `claude` against a fake host            | vitest, `tests/cli/*.cli.test.ts`, `describe.skipIf(!process.env.HARNU_WITH_CLI)` | local-ci `--with-cli`       |
| L5    | second isolated Harnu                        | numbered recipes                                                                  | per wave, evidence attached |

**`scripts/ci/mod-step.mjs`** (the new `mod` step, inserted after `lint` and before `test`):

1. Resolve `claude` on PATH and run `claude --version`. Absent, or below `minCli` → **fail** with
   one line (QA-5). `--skip mod` is the only bypass and is recorded as `skipped`.
2. Copy `resources/companion/` to a temp directory; write `hooks/coords.gen.ts` there with a temp
   rendezvous path. The script cannot import TypeScript, so it uses `scripts/ci/render-coords.mjs`,
   a twin of `renderCoords`; one vitest case asserts that the twin's output equals the renderer's
   for the same `Coords`, so there is one behaviour and two files.
3. `claude plugin validate <copy>/.claude-plugin/plugin.json --strict --json`. Exit 1 → fail.
   `success: true` with `contents: []` → fail ("validated as a marketplace", smoke D2).
   Output or stderr containing "hooks modules are turned off" → print and record the distinct state
   `blocked-by-policy`, exit code 3, which `local-pipeline.sh` maps to a **failing** step with that
   state name in the JSON summary (never a pass, QA-5).
4. Compare the parsed notes with `api-surface.json` (way 2).
5. `claude plugin test <copy>`; non-zero → fail.
6. Print `claude --version` into the step log (QA-8).

`local-pipeline.sh` changes: `run_step mod "mod (validate+test)" node scripts/ci/mod-step.mjs`;
`--skip` help lists `mod`; a new flag `--with-cli` runs
`HARNU_WITH_CLI=1 npx vitest run tests/cli` as step `cli`.

**Fake host** (`tests/cli/support/fake-host.ts`): a Node HTTP server on a Unix socket in a temp
directory that writes an `endpoint.json`, records every request (route, headers, body, arrival
ms) and answers from a script (`ok`, a canned `Failure`, garbage bytes, a hang, a closed socket).
From P1W3 on, positive-path suites may start the real `startCompanionServer` instead; negative
paths keep the fake.

**Launcher** (`tests/cli/support/run-claude.ts`), hermetic per QA-8: temp `HOME`, temp
`CLAUDE_CONFIG_DIR`, temp cwd, `--plugin-dir <temp copy of the companion>`, a second
`--plugin-dir tests/cli/fixtures/probe-mod`, `--debug-file <temp>`, stdin from `/dev/null`,
a 20 s wall cap. After every run it fails the test if the debug file contains `hook skipped` or
`did not load` for `harnu-companion`, and it attaches the file on failure.

**Zero-model driver.** `tests/cli/fixtures/probe-mod` registers one command, `/harnu-probe`, that
answers from `command.run` with no model turn (smoke C4) and prints, as JSON, what it observes:
`$.session.id()`, the list of loaded plugins it saw through `plugin.register`, and whether
`HARNU_SPAWN_TOKEN` was readable. A run is `claude -p "/harnu-probe" …`. Model calls are zero by
construction. A suite that genuinely needs a turn is gated by `HARNU_CLI_LIVE=1`, uses haiku with
`--max-turns 1`, at most three calls per run, and fails if the JSON result reports more than
0.05 USD for the run.

### 7.10 Packaging and typecheck

- `electron-builder.yml` `extraResources`: `from: resources/companion`, `to: companion`,
  `filter: ['.claude-plugin/plugin.json', 'types/**', 'hooks/**', '!hooks/coords.gen.ts']`.
- `tsconfig.node.json` `include`: P1W1 already adds `contract.ts` and the fixtures; this wave adds
  `resources/companion/hooks/lib/**/*.ts` only (all `$`-free). `register.ts` is typechecked only
  by way 3.
- `vitest.config.mts`: `src/main/companion/staging.ts` and `spawn-inject.ts` join `exclude`
  (fs and Electron glue; decisions are in `staging-core.ts`, `version-gate.ts`, tested).
- Prettier and ESLint already cover `resources/**/*.ts`; `.claude-plugin/types/` is ignored.

### 7.11 Contract additions

None — merged into `01-contract.md` §23 (the `Coords` export list and its extension rule) and §19
(fixtures are never staged). Nothing of this wave is on the wire.

## 8. Arbitration & fallback

No fact family. Every negative path ends in "spawn exactly as today".

| Condition                                                        | Behaviour                                                                                                                                 | Result                                      |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Mode `off` (default)                                             | provider returns `null`                                                                                                                   | argv and env byte-identical to today        |
| CLI version unknown (probe cold or failed) or below 2.1.287      | no flag, no token                                                                                                                         | legacy                                      |
| CLI above the tested ceiling                                     | injected; `cliGate` = `above`                                                                                                             | forced `shadow` (P1W4)                      |
| Staging fails (disk full, permissions)                           | logged once; `null`                                                                                                                       | legacy                                      |
| Staged tree modified by another process                          | hash mismatch → sibling stage; the tampered tree is never loaded again by new spawns                                                      | new spawns clean; live ones conceded (R15)  |
| Host not listening (`mintToken` → `null`)                        | flag injected, no token                                                                                                                   | mod loads, P1W3 goes dormant → legacy       |
| Org blocks user mods, `--safe-mode`, `--bare`                    | flag is accepted and ignored; the mod never loads                                                                                         | legacy; token released at exit              |
| `disableSideloadFlags`                                           | early non-zero exit → one retry without Harnu's plugin dirs → `sideloadBlocked`                                                           | legacy                                      |
| Untrusted folder                                                 | per the CLI docs the mod loads only after the trust prompt is answered; Harnu answers nothing                                             | legacy until then (Q1, AC-P1W2-24)          |
| Hot reload of the staged tree                                    | cannot happen in production (immutable tree); in dev mode it is the feature                                                               | P1W3 makes it idempotent                    |
| Mod fails to load (authoring error slipped through)              | CLI runs without it (smoke A5)                                                                                                            | legacy; caught by `mod` step and L4         |
| Kill switch turned off mid-session (P1W4)                        | nothing in this wave's code path: the host revokes the `conn`, the re-hello is answered `enable: []`; new spawns get no flag and no token | mod inert; legacy wins at once, no TTL wait |
| Headless tick                                                    | flag and token injected with owner `tick`                                                                                                 | sensor-only (contract §16)                  |
| `/clear`, lease loss, host restart                               | not applicable to this wave (no connection yet)                                                                                           | —                                           |
| Missing session directory (the notice command replaces `claude`) | no token minted                                                                                                                           | no orphan ledger entry                      |

## 9. Security requirements

Inherits SEC-1 to SEC-9. Wave-specific:

- **SEC-4.** `coords.gen.ts` is the only coordinate source; the skeleton reads no env. From P1W3
  the single env read is the literal `HARNU_SPAWN_TOKEN` (way 1 pins `envReads`).
- **SEC-8.** The spawn token is never logged, never written to disk, and stripped from the
  inherited env on every spawn. It appears in the child's environment only.
- **SEC-9a/b/d/f.** Enforced statically on the source (§7.7), not by review. The sideload retry
  removes Harnu's own flags; it never edits settings or tries another loading route.
- **R15.** Staged files are `0600` in `0700` directories and re-hashed per spawn; a same-user
  rewrite is detected for new spawns and conceded for live ones (ADR-0004 posture).
- **Shipping hygiene (MOD-9).** Tests, fixtures, `api-surface.json` and generated types are never
  staged nor packaged; the staged tree is small and readable.
- The dev flag is honoured only when `!app.isPackaged`.

## 10. UX & copy

No UI. One terminal line, written by Harnu into the PTY stream (not i18n: it is terminal output,
English like the CLI's own):

- `Harnu: restarted without bundled plugins.` (after a sideload retry)

P1W4 owns the Harnu mod state wording for the same condition.

## 11. Acceptance criteria

Test files: `tests/companion/staging-core.test.ts` (SC), `tests/companion/api-surface.test.ts`
(AS), `tests/companion/version-gate.test.ts` (VG), `tests/companion/spawn-inject.test.ts` (SI),
`tests/companion/sideload-retry.test.ts` (SR), `tests/companion/validate-notes.test.ts` (VN),
`tests/claude-cli-version.test.ts` and `tests/claude-cli-probe.test.ts` (T200 §6),
`tests/scheduler-argv.test.ts` (existing), `tests/cli/*.cli.test.ts` (L4),
`resources/companion/tests/skeleton.test.ts` (L3).

```
AC-P1W2-1 [unit] Given mode off, Then the argv and env built for a claude spawn equal the
  pre-change snapshot byte for byte.
  Evidence: SI › "mode off is byte-identical"

AC-P1W2-2 [unit] Given an argv ending in "-- <prompt>" that already carries a user --plugin-dir,
  Then insertCompanionPluginDir places the companion flag before that one and before "--".
  Evidence: SC › "companion is the first plugin dir, before the separator"
  Guards: BUG-86

AC-P1W2-3 [unit] Given an argv that already carries the companion directory, Then it is returned unchanged.
  Evidence: SC › "idempotent injection"

AC-P1W2-4 [unit] Given a parent env that contains HARNU_SPAWN_TOKEN, Then the child env carries
  the freshly minted token, or no such variable when nothing was minted.
  Evidence: SI › "an inherited token is never forwarded"

AC-P1W2-5 [unit] Given a spawn whose directory is missing, Then no spawn token is minted.
  Evidence: SI › "no mint for the missing-directory notice"

AC-P1W2-6 [unit] Given a path containing a quote and a backslash, Then renderCoords emits a
  module whose evaluated RENDEZVOUS_PATH equals the input.
  Evidence: SC › "coords are JSON-escaped"

AC-P1W2-29 [unit] Given the same Coords, Then scripts/ci/render-coords.mjs and renderCoords
  produce identical text.
  Evidence: SC › "the mjs twin equals the renderer"

AC-P1W2-30 [unit] Given a stage directory older than 14 days that a spawn record or a pin names,
  Then garbage collection keeps it; with neither, it is removed.
  Evidence: SC › "garbage collection pins by directory"

AC-P1W2-7 [unit] Given a staged tree whose stamp differs from the wanted digest, Then stageKeyFor
  returns a sibling key and the existing tree's files are not written.
  Evidence: SC › "a stale or tampered stage is never overwritten"
  Guards: R15, smoke A5

AC-P1W2-8 [unit] Given the staged file list, Then it contains no path under tests/, no
  api-surface.json and nothing under .claude-plugin/types/.
  Evidence: SC › "only the allowlist is staged (MOD-9)"

AC-P1W2-9 [unit] Given versions null, 2.1.286, 2.1.287, 2.1.289 (the ceiling) and one above the ceiling, Then cliGate
  returns unknown, below, ok, ok and above, and injection is allowed for the last three.
  Evidence: VG › "gate table"

AC-P1W2-10 [unit] Given a cold version cache, Then the spawn provider returns null without
  spawning any process.
  Evidence: SI › "unknown version: no mod, no await"

AC-P1W2-11 [unit] Then the hooks and $ calls scraped from resources/companion/hooks equal
  api-surface.json.
  Evidence: AS › "source equals the manifest (drift way 1)"
  Guards: R2

AC-P1W2-12 [unit] Then the mod source has no tool.call matcher that can match Bash, no '*' event,
  no turn.step, no $.process and no $.mcp.call.
  Evidence: AS › "forbidden constructions"
  Guards: R8 (#92533)

AC-P1W2-13 [unit] Then hooks/contract.ts has zero imports and every import under hooks/ is
  relative and inside the plugin directory.
  Evidence: AS › "import discipline (MOD-1)"

AC-P1W2-14 [unit] Given the recorded validate report, Then parseValidateNotes yields the hooks, calls and env reads.
  Evidence: VN › "notes parser"
  Guards: Q4

AC-P1W2-15 [mod-test] Given the skeleton, When session.start is dispatched, Then next is called
  once with the unchanged event and the hook returns its result.
  Evidence: resources/companion/tests/skeleton.test.ts › "session.start passes through"; local-ci JSON step=mod

AC-P1W2-16 [integration] Given a temp HOME and config dir, When claude -p "/harnu-probe" runs with
  the companion and the probe mod, Then the debug file contains the companion's "loaded" line and
  no "hook skipped" or "did not load" line, and no model request was made.
  Evidence: tests/cli/load.cli.test.ts › "skeleton loads, zero model calls"
  Guards: Q5

AC-P1W2-17 [integration] Given two --plugin-dir flags with the companion first, Then the probe's
  plugin.register hook reports nothing for the companion (loaded before it), and with the order
  swapped it reports the companion.
  Evidence: tests/cli/load.cli.test.ts › "the first plugin dir loads first"
  Guards: Q3 (partial: --plugin-dir order only)

AC-P1W2-18 [integration] Given the temp copy after one load, Then tsc -p tsconfig.json exits 0.
  Evidence: tests/cli/types.cli.test.ts › "types compile against the installed CLI (drift way 3)"
  Guards: R2

AC-P1W2-19 [integration] Given a tick-shaped argv (-p, --setting-sources '', --strict-mcp-config,
  --no-session-persistence) plus the companion, Then the debug file contains the "loaded" line.
  Evidence: tests/cli/tick.cli.test.ts › "a mod loads under --setting-sources ''"
  Guards: Q2

AC-P1W2-20 [unit] Given a TickContext with companionPluginDir, Then tickArgv emits it before the
  skills plugin dir; without it the argv equals today's snapshot.
  Evidence: tests/scheduler-argv.test.ts › "companion plugin dir on ticks"

AC-P1W2-21 [unit] Given injected, exit code 1 after 800 ms, no hello and no prior retry, Then
  shouldRetryWithoutSideload is true; flip any one input and it is false.
  Evidence: SR › "retry truth table"
  Guards: Q6

AC-P1W2-22 [unit] Given a retry, Then the rebuilt argv keeps the user's own --plugin-dir and
  drops both Harnu-injected ones.
  Evidence: SR › "strips only Harnu's flags"

AC-P1W2-23 [unit] Given no claude on PATH, a CLI at 2.1.286, and a validate output that says
  hooks modules are turned off, Then mod-step exits non-zero with states fail, fail and
  blocked-by-policy; given --skip mod, the summary records skipped.
  Evidence: tests/mod-step.test.ts › "skip versus fail" (execFile mocked)
  Guards: QA-5

AC-P1W2-24 [live-verify] Given a folder that was never trusted, When Harnu spawns a session there
  in mode shadow, Then Harnu types nothing into the trust prompt and the mod's "loaded" line
  appears in the debug file only after the operator accepts it.
  Evidence: LV-P1W2-b
  Guards: Q1, C8

AC-P1W2-25 [live-verify] Given mode shadow and CLI 2.1.287, When a session is opened from the
  sidebar, Then the process argv shows the companion --plugin-dir before any other, the debug
  file shows it loaded, and a skill enabled for the folder still appears.
  Evidence: LV-P1W2-a

AC-P1W2-26 [live-verify] Given a staged tree made read-only, When a session spawns, Then the
  recipe records whether the mod loaded.
  Evidence: LV-P1W2-c (settles OQ-3)

AC-P1W2-27 [unit] Given an unpackaged build with the dev flag and a live lock held by another pid,
  Then ensureStaged stages normally and does not write into the repository folder.
  Evidence: SC › "dev mode is single-owner"

AC-P1W2-28 [unit] Then the usage and haiku probe argv contain no --plugin-dir and their env no HARNU_SPAWN_TOKEN.
  Evidence: tests/usage-poller.test.ts › "probes are never injected"; tests/haiku-service.test.ts › same title

AC-P1W2-31 [unit] Given a report with contents: [], Then parseValidateNotes throws "validated as a marketplace".
  Evidence: VN › "the marketplace trap"
  Guards: Q4
```

**Live-verify recipes** (isolated second instance; record `claude --version` in each).

**LV-P1W2-a — injection end to end.**

1. Write `{ "v": 1, "mode": "shadow" }` to the isolated instance's `companion-prefs.json`; launch.
2. Enable one bundled skill for a test folder; add `--debug-file <tmp>/d.log` in Claude Boot extra args.
3. Open a new session there. Read the child's argv from `/proc/<pid>/cmdline`.
4. Pass: two `--plugin-dir` flags, the companion's first, both before any `--`; `d.log` has
   `hooks module harnu-companion@inline loaded (worker, …, tier user)`; `/` autocomplete lists the
   skill; `companionDiagnostics().pendingSpawns` is 1 (minted, not yet redeemed in this wave).
5. Close the session; `pendingSpawns` returns to 0.
6. Switch the mode file to `off`, restart, repeat step 3: one `--plugin-dir` (skills) only, and
   no `HARNU_SPAWN_TOKEN` in `/proc/<pid>/environ`.

**LV-P1W2-b — untrusted folder (Q1).**

1. Create a fresh directory outside any trusted parent; add it to the isolated instance.
2. Open a session with `--debug-file`. Observe the terminal: is there a trust prompt, and a
   separate consent prompt for the plugin?
3. Before answering, confirm `d.log` has no companion "loaded" line. Answer the trust prompt by hand.
4. Pass: Harnu injected no keystroke; the "loaded" line appears after the answer (or never, which
   is also a pass for this wave: legacy holds). Record both observations in the smoke evidence
   addendum; P2W2 reads them for the start-prompt gate.

**LV-P1W2-c — read-only staged tree (OQ-3).**

1. With the instance stopped, `chmod -R a-w` the staged `harnu-companion` directory.
2. Launch, open a session with `--debug-file`.
3. Record: loaded or not, and any error line. Restore the modes. No pass/fail: the result decides
   whether a follow-up may harden the tree.

**Human ACs.** None.

## 12. Docs deliverables

| Contract                  | Deliverable                                                                                                                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHANGELOG.md`            | None for users (mode `off`). The PR carries `no-changelog`.                                                                                                                                     |
| `docs/harnu-features.md`  | None.                                                                                                                                                                                           |
| `docs/user/`              | The gate fires: `src/main/claude-cli-version.ts` is a new top-level main file. It adds no user-reachable surface in this wave (T200's UI row is not shipped), so the PR carries `no-user-docs`. |
| `design.md`, i18n         | None.                                                                                                                                                                                           |
| `docs/dev/`               | New `docs/dev/companion-mod.md`: layout, authoring rules that make a module silently not load, the dev flag, how to run the `mod` step and `--with-cli`, how to bump `lastVerifiedCli`.         |
| `.claude/skills/local-ci` | Mention the `mod` step and `--with-cli` in the skill's step list.                                                                                                                               |
| T200 spec                 | Status line updated to "core and probe implemented by T389 P1W2; UI row pending".                                                                                                               |
| Smoke evidence            | An addendum section for the outcomes of LV-P1W2-b, LV-P1W2-c and AC-P1W2-16, -17, -19.                                                                                                          |

## 13. Rollout & parity gate

No fact family and no parity gate. Ships dark behind mode `off`. Demotes nothing.
Merge bar (QA-4): `scripts/ci/local-pipeline.sh --base <P1W1 branch> --with-cli --labels no-changelog,no-user-docs`
green, including the new `mod` step. This is the first wave where `--with-cli` is mandatory.

Moving the **tested ceiling** is a rollout act of its own: a one-line change to
`api-surface.json` whose PR attaches the `mod` step log, the `--with-cli` log and LV-P1W2-a on the
new CLI version.

## 14. Open questions

| #    | Question (master id)                                                                                                 | Owner                                                                                                                              | Settled by                            | Fallback already designed                                                                                                                                                                                            |
| ---- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OQ-1 | Q1: untrusted folder — a consent prompt on load? does the trust dialog delay the load?                               | P1W2                                                                                                                               | AC-P1W2-24                            | Legacy until a hello exists; Harnu never answers the prompt.                                                                                                                                                         |
| OQ-2 | Q2: does a hooks module load under `--setting-sources ''`?                                                           | P1W2                                                                                                                               | AC-P1W2-19                            | If not: ticks stay legacy (their `--settings` hook blob already covers them, BUG-111).                                                                                                                               |
| OQ-3 | Read-only plugin directory versus the engine's types write.                                                          | P1W2                                                                                                                               | AC-P1W2-26                            | Tree stays writable; integrity is by hash per spawn.                                                                                                                                                                 |
| OQ-4 | Q3: load order of marketplace-installed and personal-skills-folder mods relative to `--plugin-dir`.                  | P4W1                                                                                                                               | P4W1 part B (confirmed by the master) | Not needed here: nothing in P1 depends on being outermost (smoke D6).                                                                                                                                                |
| OQ-5 | Q5: does `-p` with a temp HOME need sign-in before `session.start`?                                                  | P1W2                                                                                                                               | AC-P1W2-16                            | If it does: L4 suites report `blocked-by-auth` under `--with-cli` (a failure, not a skip) and the wave documents a signed-in dedicated config dir for CI machines. No credential file is ever copied by the harness. |
| OQ-6 | Q6: the exact `disableSideloadFlags` exit text and code.                                                             | P1W2 for the behavioural detection (AC-P1W2-21, -22); the real exit text is recorded on P1W4's managed-machine run (master Q6, Q8) | AC-P1W2-21; P1W4's run                | Behavioural detection (§7.8) needs no string.                                                                                                                                                                        |
| OQ-7 | Q4: the validate JSON shape is unpinned free text.                                                                   | P1W2                                                                                                                               | AC-P1W2-14                            | Snapshot plus parser; a shape change fails the `mod` step loudly, never silently.                                                                                                                                    |
| OQ-8 | Does a spawn-time env var reach a tick's mod when the tick is started by `child_process.spawn` with `stdio: ignore`? | P1W3                                                                                                                               | its tick AC                           | Tick stays unbound (dormant mod).                                                                                                                                                                                    |

## 15. Risks

| Risk                                                           | Sev    | Mitigation                                                                                                  |
| -------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------- |
| R2: the mods API changes without notice                        | High   | three drift checks; thin skeleton; ceiling forces `shadow`; legacy untouched.                               |
| R8: a Bash `tool.call` hook slips in later                     | High   | static assertion on the source, not on the manifest (AC-P1W2-12).                                           |
| R15: staged mod rewritten by a same-user process               | Medium | per-spawn hash; never overwrite; sibling stage.                                                             |
| An authoring error makes the module silently not load          | Medium | `validate --strict` in the `mod` step; L4 fails on "did not load".                                          |
| The injector lands after `--` again                            | Medium | it runs only inside `withOptionArgs`; AC-P1W2-2.                                                            |
| The sideload retry masks a real startup failure                | Medium | one retry, only for injected spawns that never said hello and died in under 5 s; second death is forwarded. |
| Dev mode repoints live sessions of another instance            | Medium | opt-in flag plus single-owner lock (AC-P1W2-27).                                                            |
| The first spawn after boot misses the mod (version cache cold) | Low    | accepted: legacy for that session; the probe takes about 70 ms and fires at boot.                           |
| `--with-cli` cannot run on a machine without sign-in           | Low    | reported as `blocked-by-auth`; the `mod` step still runs offline.                                           |
