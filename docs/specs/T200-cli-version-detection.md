# T200 — Detect the installed Claude Code version at boot

**Date:** 2026-08-05 · **Status:** specified (not implemented) · **Card:** `.capy/memory/roadmap/T200-detect-the-installed-claude-code-version-at-boot-nothing-in.md`
**Audit:** `.capy/out/claude-code-sync-audit.md` §3.7 (gate), §2 (the five version-coupled breakages it unblocks).

## 1. Problem

Capy spawns, parses and configures a CLI whose contract moves weekly, and **it never asks
that CLI what it is**. Every version-coupled behavior is therefore a silent break:

- **Effort `xhigh` / `max`** are still offered in three pickers (`ClaudeBootForm.vue:66`,
  `ClaudeBootDialog.vue:50`, `RoadmapBoard.vue:67`) and emitted verbatim
  (`claude-args.ts:373`). CC v2.1.72 reduced `--effort` to `low|medium|high`. An invalid value
  does not degrade — the session **fails to open**, surfacing as a dead terminal.
- **it2 / agent-teams hosting** is pinned by prose and by a basename regex to a contract
  captured against **claude 2.1.193** (`it2-parse.ts:10`, `:63`, `:231-233`, `:325`). CC
  v2.1.178 removed `TeamCreate`/`TeamDelete`; v2.1.186 added `teammateMode`. Any CLI upgrade
  can change the run chain the bridge parses; the failure mode is "teammate panes stop
  appearing", with no error attributable to a version.
- **`sessions-index.json`** is read per slug (`claude-reader.ts:283-322`) although CC ≥ 2.1.152
  stopped writing it (`claude-reader.ts:362` says so in a comment) — dead I/O, undetectable.
- **`rate_limits`** in the statusline payload (`statusline-parse.ts:114`, `:142-145`) exists
  only on CC ≥ 2.1.80. Capy parses it _and_ still runs the legacy `claude -p "/usage"` poller
  (`usage.ts:42-46`) for everyone, because nothing can tell whether the cheap path is available.
- **The "new version available" notification** (`claude-changelog.ts:107-113`) fires off the
  _published_ GitHub changelog, so a user already on the newest CLI is still told to upgrade.

## 2. Current behaviour, verified

| Fact                                                                                                                                                         | Evidence                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| **No runtime version check exists anywhere.** Grep for `--version` in `src/` hits only a denylist entry, an it2 passthrough, and a form label                | `claude-args.ts:143` (`DENY_BOOL`), `it2-bridge.ts:324-328`, `ClaudeBootForm.vue:152` |
| No semver parse/compare over an _installed_ version                                                                                                          | `claude-changelog-parse.ts:9` parses the **published** changelog headings only        |
| `claude-changelog.ts` polls `raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md` every 30 min and notifies on the newest _published_ release | `claude-changelog.ts:21-25`, `:101-114`. It says **nothing** about what is installed  |
| Binary resolution order: `which`/`where.exe` first, then hardcoded common paths                                                                              | `claude-cli.ts:69-95` (`tryWhich`), `:97-106` (`tryCommonPaths`), `:108-118`          |
| Hardcoded paths: POSIX `/usr/local/bin`, `/opt/homebrew/bin`, `/usr/bin` + `~/.local/bin`, `~/.bun/bin`, `~/.deno/bin`, `~/.npm-global/bin`                  | `claude-cli.ts:24-33`                                                                 |
| Windows prefers a real `claude.exe` over the npm `.cmd`/extension-less shim (ConPTY can only `CreateProcess` a real executable)                              | `claude-cli.ts:35-47`, `:55-67`, `:78-89`                                             |
| Path cache is a single module-level `let cached: string \| null \| undefined`, process-lifetime, with one invalidation seam                                  | `claude-cli.ts:22`, `:109`, `:120-122` (`clearClaudePathCache`)                       |
| Consumers of the resolved path                                                                                                                               | `pty.ts:616`, `usage.ts:42`, `usage-history.ts:338`, `haiku.ts`                       |
| Two test files mock the whole `claude-cli` module with a one-export factory                                                                                  | `tests/usage-poller.test.ts:42`, `tests/haiku-service.test.ts:31`                     |

**Observed on this machine (2026-08-05), verbatim:**

```
$ claude --version
2.1.222 (Claude Code)
```

`cat -A` shows `2.1.222 (Claude Code)$` — one line, one trailing `\n`, no trailing spaces,
exit code `0`, ~70 ms wall clock. `which claude` → `/home/u/.local/bin/claude`, which
resolves through to `/home/u/.local/share/claude/versions/2.1.222` — i.e. the native
installer's real binary basename **is** the version, which is exactly the shape
`it2-parse.ts:233` (`CLAUDE_VERSION_BASENAME`) already accepts as hostable.

## 3. Decision

### 3.1 Two modules: a pure core + the existing shell

- **`src/main/claude-cli-version.ts` (NEW, pure, no I/O)** — parse + compare. Lands in the
  coverage surface (ADR-0001 pure-core/thin-shell); `claude-cli.ts` is _not_ in
  `vitest.config.mts`'s exclude list either, so both are measured.
- **`src/main/claude-cli.ts` (extended)** — the `execFile` probe and the cache, beside the
  path cache it must stay in lockstep with.

```ts
// claude-cli-version.ts
export interface ClaudeVersion {
  raw: string // the full stdout line, trimmed: "2.1.222 (Claude Code)"
  major: number
  minor: number
  patch: number
  prerelease: string | null // "beta.1" for 2.1.193-beta.1, else null
}
export function parseClaudeVersion(stdout: string): ClaudeVersion | null
export function compareClaudeVersions(a: ClaudeVersion, b: ClaudeVersion): -1 | 0 | 1
export function isAtLeast(v: ClaudeVersion | null, target: string): boolean
```

`parseClaudeVersion` matches the **first** `\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?` in the first
non-empty line and ignores the rest (`(Claude Code)` today, anything tomorrow). Anything else
→ `null`. Comparison is **numeric per component**, never lexicographic — `2.1.9 < 2.1.72 <
2.1.222` is the whole point, and a string compare gets all three wrong. A prerelease sorts
_below_ its release (`2.1.193-beta.1 < 2.1.193`), matching semver.

`isAtLeast(null, …)` is **`false`**: "unknown behaves as the oldest supported version" (card
AC 3). That is the correct default for _additive_ gates (don't use a new field you can't
confirm). It is the wrong default for gates whose legacy branch is "allow" — §4 states the
unknown-branch for every consumer explicitly, so nobody has to infer it.

### 3.2 The probe and the cache — same seam as the path cache

```ts
// claude-cli.ts, beside `let cached`
let versionCache: ClaudeVersion | null | undefined
let versionProbe: Promise<ClaudeVersion | null> | null // single-flight
let versionFailureLogged = false

export async function resolveClaudeVersion(): Promise<ClaudeVersion | null>
export function claudeVersionSync(): ClaudeVersion | null // cached-or-null; NEVER spawns
export function registerClaudeCliHandlers(): void // ipcMain.handle('claude-cli:version', …)
```

- `resolveClaudeVersion()` awaits `resolveClaudePath()`, then `execFile(path, ['--version'])`
  with `cwd: homedir()`, `timeout: 3000`, `maxBuffer: 1 << 16`, and
  `sanitizeSpawnEnv(process.env, { execPath: process.execPath })` — the same env scrub
  `usage.ts:47`, `haiku.ts` and `usage-history.ts` already use, so an AppImage's
  `$APPDIR`-rooted `LD_LIBRARY_PATH`/`PATH` cannot leak into the child.
- **Single-flight**: concurrent callers share `versionProbe`; the CLI is spawned at most once
  per cache generation.
- **`clearClaudePathCache()` (`claude-cli.ts:120-122`) is the ONE invalidation seam** and must
  clear `versionCache`, `versionProbe` and `versionFailureLogged` together with `cached`. A
  re-resolved path can point at a different install; a version outliving its path is exactly
  the bug this card exists to prevent. Rename is out of scope — the function keeps its name
  and gains the extra resets, so no caller changes.
- **Boot**: `void resolveClaudeVersion()` fires from `src/main/index.ts` next to
  `registerClaudeChangelog(…)` (`index.ts:664`) — fire-and-forget, never awaited. 70 ms, off
  the critical path. Its purpose is to make `claudeVersionSync()` warm for the _synchronous_
  consumers (`it2-parse.ts` is a pure sync parser and must not become async for this).
- **Manual re-probe**: Settings → Claude Code's existing **Refresh** button
  (`ClaudeChangelogPane.vue:76-85`) also clears + re-probes the version. The native installer
  swaps `~/.local/share/claude/versions/<v>` underneath a long-lived Capy, so a
  process-lifetime cache _will_ go stale; one button, no timer.

### 3.3 Failure semantics (the important path)

Three failures, one outcome: path unresolved (**no spawn attempted**), `execFile`
ENOENT/non-zero/timeout, or unparseable stdout (empty, HTML, a shim's usage banner) all cache
`null` and emit `console.warn('[claude-cli] version probe failed …')` **once per cache
generation**, guarded by `versionFailureLogged` (card AC 3: "recorded once, not per call").

`resolveClaudeVersion()` **never rejects** and is **never awaited on a spawn path** —
`pty.ts:616` keeps calling `resolveClaudePath()` only, so a hung `claude --version` cannot
delay or block a session. This is a hard constraint, not a preference.

### 3.4 UI surface

`ClaudeChangelogPane.vue` (Settings → **Claude Code** tab, `SettingsDialog.vue:233-234`,
`:956`). One row directly under the `settings.claudeCode.eyebrow` label (line 31), above the
release list, so "what I have" reads immediately above "what exists":

- known → `Installed: 2.1.222` (`settings.claudeCode.installed`, `{version}` param)
- unknown → `settings.claudeCode.installedUnknown`

**Both keys must land in `en.json` AND `pt-BR.json` in the same change** — `MessageSchema =
typeof en` breaks the `vue-tsc` build otherwise (`docs/lessons/i18n/002-…`). The existing
`settings.claudeCode.*` block already holds 6 parity-matched keys.

No new store: the pane calls `window.api.claudeCliVersion()` on mount. The changelog store
stays about _published_ releases.

### 3.5 Alternatives rejected

- **Derive the version from the resolved path basename** (`…/versions/2.1.222` — true on this
  machine): breaks for `~/.local/bin/claude` (a launcher), for the npm layout
  (`claude-cli.ts:40`), for Homebrew and for the Windows `.exe`. One source of truth, and it
  is the CLI's own answer.
- **Persist to `userData`** (a 70 ms probe needs no JSON file, and a persisted value is one
  more thing that can outlive its binary) and **poll periodically** (the version only changes
  on a CLI upgrade; boot + the manual Refresh cover it).
- **A `SUPPORTED_RANGE` constant now** (mirroring CC's own `requiredMinimumVersion` /
  `requiredMaximumVersion` managed settings, v2.1.163 — precedent that a supported _range_,
  not just a floor, is the right long-term notion): deferred. `compareClaudeVersions` makes a
  range two calls; declaring Capy's supported window is a policy decision that belongs with
  the first consumer that needs a ceiling (it2, §4).

### 3.6 Open questions (flagged, not blocking)

1. **Windows `--version` output** is unverified — only the Linux native install was observed.
   The parser is deliberately "first semver in the first line", which survives a `.cmd` shim
   prefixing noise, but a Windows smoke check belongs in the implementing PR.
2. **`~/.local/bin/claude` is a launcher, not the binary.** `claude --version` answers for
   whatever the launcher resolves; if a future launcher answers _its own_ version, the value
   diverges from the versioned binary basename `it2-parse.ts:233` sees. Only matters if it2
   gains a version gate (§4 row 1).

## 4. Consumers this unlocks (specify, do not implement)

| Call site                                                                                        | What the gate decides                                                                                      | Version | Unknown ⇒                                           |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ------- | --------------------------------------------------- |
| `it2-parse.ts:231-233`, `:325`; contract prose `:10`, `:63`                                      | Whether the captured hostable-run contract still holds; warn/annotate when installed ≠ the captured window | 2.1.193 | **allow** (today's behavior; never regress hosting) |
| `claude-args.ts:373` + `ClaudeBootForm.vue:66`, `ClaudeBootDialog.vue:50`, `RoadmapBoard.vue:67` | Drop `xhigh`/`max` from the `--effort` options (an invalid value makes the session fail to open)           | 2.1.72  | keep offering (status quo)                          |
| `claude-args.ts:374` + `ClaudeBootForm.vue:69-74`, `claude-config-catalog.ts`                    | `manual` vs the legacy `default` permission mode; same fail-to-open class                                  | 2.1.200 | keep offering both                                  |
| `claude-reader.ts:283-322`, `:362`                                                               | Skip the `sessions-index.json` read entirely (CC stopped writing it) — pure dead-I/O removal               | 2.1.152 | keep trying (harmless miss)                         |
| `statusline-parse.ts:114`, `:142-145` → `usage.ts:42-46`                                         | Retire the `claude -p "/usage"` poller when `rate_limits` is guaranteed present                            | 2.1.80  | keep polling                                        |
| `claude-changelog.ts:107-113`                                                                    | Suppress "Version X available" when the installed version already ≥ X                                      | any     | notify (status quo)                                 |

Each row is a separate card. This spec ships **only** the gate and the UI row.

## 5. Acceptance

- The version is probed at most once per cache generation, lazily single-flighted, and warm
  after boot without any `await` on a spawn path.
- `clearClaudePathCache()` clears path **and** version state; no test or caller can observe a
  version that belongs to a previously-resolved path.
- A missing CLI, a non-zero exit, a timeout, or unparseable stdout yields `null`, logs exactly
  once, and changes nothing about session spawning.
- `isAtLeast` compares numerically (`2.1.9 < 2.1.72 < 2.1.222`) and returns `false` for `null`.
- Settings → Claude Code shows the installed version, or an explicit unknown state, in both
  locales.
- §4 exists as a table with real file:line anchors; no consumer is changed in this PR.

## 6. Test plan

| Test                                                                                                                                                        | File                                                               | Asserts                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------- |
| Parses the **observed** stdout verbatim: `"2.1.222 (Claude Code)\n"` → `{major:2,minor:1,patch:222,prerelease:null,raw:'2.1.222 (Claude Code)'}`            | `tests/claude-cli-version.test.ts` (NEW)                           | §3.1                         |
| Bare `"1.0.6\n"`, prerelease `"2.1.193-beta.1 (Claude Code)"`, leading shim noise all parse; `''`, `'\n\n'`, `'command not found'`, an HTML page → `null`   | `tests/claude-cli-version.test.ts`                                 | §3.1, §3.3, open question 1  |
| Ordering is numeric, not lexicographic: `2.1.9 < 2.1.72 < 2.1.222`; `2.1.193-beta.1 < 2.1.193`; equality is `0`                                             | `tests/claude-cli-version.test.ts`                                 | §3.1                         |
| `isAtLeast(null, '2.1.80') === false`; `isAtLeast(v2_1_222, '2.1.80') === true`; equal version is `true`                                                    | `tests/claude-cli-version.test.ts`                                 | §3.1                         |
| Probe caches: two `resolveClaudeVersion()` calls spawn `execFile` **once**; concurrent calls also spawn once; `resolveClaudePath()` → `null` spawns nothing | `tests/claude-cli-probe.test.ts` (NEW, `vi.mock('child_process')`) | §3.2, §3.3                   |
| Probe failure (rejecting `execFile`) → `null`, cached, and `console.warn` called **once** across three calls                                                | `tests/claude-cli-probe.test.ts`                                   | §3.3                         |
| `clearClaudePathCache()` re-arms both caches: the next call re-spawns and can log again; `claudeVersionSync()` is `null` before any probe and never spawns  | `tests/claude-cli-probe.test.ts`                                   | §3.2 (the invalidation seam) |

**Pre-existing mocks that will break — verified.** `vi.mock` factories replace the _whole_
module, so `tests/usage-poller.test.ts:42` and `tests/haiku-service.test.ts:31` (each
returning only `{ resolveClaudePath }`) must gain the new exports, or any import of
`resolveClaudeVersion` in the module-under-test's transitive graph resolves to `undefined`.
Extend both factories in the same PR.

There is **no** existing `tests/claude-cli*.test.ts` — this is new coverage for a module that
is already inside `coverage.include` (`vitest.config.mts` does not exclude `claude-cli.ts`).

## 7. Contracts touched

- **`CHANGELOG.md` — YES.** `### Added`, user-visible: the Claude Code settings tab now shows
  the installed CLI version.
- **`docs/capy-features.md` — NO.** No MCP verb, no ACK field, no grant/confirm change, no
  affordance the agent should offer. Per `CLAUDE.md`'s litmus this is main-process
  infrastructure the session cannot act on. If the gate trips on an unrelated file, label
  `no-awareness`.
- **`docs/user/` — YES, and CI will force it.** `scripts/ci/user-docs-gate-core.mjs` rule 2
  fires on an **added top-level file directly under `src/main/`**, which
  `src/main/claude-cli-version.ts` is. Update `docs/user/settings.md` (the Claude Code tab now
  shows the installed version) and `docs/user/troubleshooting.md` (how to tell which CLI Capy
  actually resolved). Do not take the `no-user-docs` label — the surface is real.
- **`design.md` — YES (small).** §6, Settings → Claude Code: the installed-version row above
  the release list. Existing tokens and type scale only; no new token. Written before the Vue
  edit, per the design contract.
- **i18n — YES.** `settings.claudeCode.installed` and `settings.claudeCode.installedUnknown`,
  added to `en.json` **and** `pt-BR.json` in the same commit.
- **English-only — YES**, trivially: all new code, comments and copy are English; the only
  Portuguese is the `pt-BR.json` value, which is the documented exception.

## 8. Definition of done

- [ ] `src/main/claude-cli-version.ts` — `parseClaudeVersion`, `compareClaudeVersions`,
      `isAtLeast`, `ClaudeVersion`
- [ ] `src/main/claude-cli.ts` — `resolveClaudeVersion`, `claudeVersionSync`,
      `registerClaudeCliHandlers`; `clearClaudePathCache` clears the version state too
- [ ] `void resolveClaudeVersion()` + `registerClaudeCliHandlers()` wired in `src/main/index.ts`
- [ ] `claudeCliVersion()` in `src/preload/index.ts` (typed via the inferred `Api`)
- [ ] `ClaudeChangelogPane.vue` renders the installed version; **Refresh** re-probes
- [ ] `en.json` + `pt-BR.json` keys; `design.md` §6 row
- [ ] `tests/claude-cli-version.test.ts` + `tests/claude-cli-probe.test.ts` green
- [ ] `tests/usage-poller.test.ts` and `tests/haiku-service.test.ts` mock factories extended
- [ ] `CHANGELOG.md` entry; `docs/user/settings.md` + `docs/user/troubleshooting.md` updated
- [ ] `npm run typecheck` and `npm run build` pass
