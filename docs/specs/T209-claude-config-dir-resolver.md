# T209 — One Claude config-dir resolver; every `~/.claude` path routed through it

**Date:** 2026-08-05 · **Status:** specified (not implemented) · **Card:** `.capy/memory/roadmap/T209-respect-claude-config-dir-xdg-config-home-every-claude-path-is.md`
**Audit:** `.capy/out/claude-code-sync-audit.md` §3.8 · **Verified against:** `claude` **2.1.222** (`~/.local/share/claude/versions/2.1.222`)

## 1. Symptom

A user who sets `CLAUDE_CONFIG_DIR` — a first-class CLI configuration since v1.0.6 — gets four
simultaneous silent failures, none of which produce an error:

1. **Session discovery finds nothing.** `scanFoldersUncached` and the chokidar watcher both scan
   `~/.claude/projects` (`claude-reader.ts:1193`, `claude-watcher.ts:53`, `fleet-model.ts:51`).
   The sidebar renders "no folders" and looks like a broken install.
2. **Hooks and the statusline install into a directory the CLI never reads.**
   `claudeSettingsPath()` (`claude-settings.ts:33`) is `~/.claude/settings.json`; the observer
   hooks and the `statusLine` command are written there. The CLI reads the relocated dir → no
   fleet state, no telemetry, and an orphaned hook blob left behind in the wrong file.
3. **Usage and cost go blank.** The cost engine scans `~/.claude/projects/**/*.jsonl`
   (`usage-cost.ts:55`). Zero files → the Usage Dashboard reads as "you spent nothing".
4. **The pasted-images gallery is empty.** `imageCacheRoot` (`image-cache.ts:32`) is
   `~/.claude/image-cache`.

Plus a fifth that only shows up as absence: `~/.claude/sessions`, `~/.claude/teams`,
`~/.claude/tasks` (PID registry, team board) all go silent, and each of those is already
fail-open by design, so nothing complains.

## 2. Census — every construction of a path under the Claude config dir

Grepped `homedir|CLAUDE_CONFIG_DIR|XDG_CONFIG_HOME` and `\.claude` across `src/main` +
`src/preload` + `src/renderer/src`. **23 in-scope sites** (16 needing an edit, 3 that inherit
correctness through `claudeSettingsPath()`, 4 Capy-owned). The renderer constructs none — every
`~/.claude` there is a doc comment or i18n copy.

### 2.1 CLI contract — must follow the resolved root

| file:line                            | what it touches                                                                    |
| ------------------------------------ | ---------------------------------------------------------------------------------- |
| `claude-reader.ts:1193`              | `scanFoldersUncached` default `rootDir` — **session discovery**                    |
| `claude-watcher.ts:53`               | `DEFAULT_ROOT` — the single chokidar watcher                                       |
| `fleet-model.ts:51`                  | `DEFAULT_ROOT` — the central fleet model's scan root                               |
| `session-ops.ts:45`                  | `PROJECTS_ROOT` — **the destructive fence** (`session:delete`, `session:digest`)   |
| `usage-cost.ts:55`                   | `projectsRoot()` — cost-engine JSONL scan                                          |
| `orchestrator-guard.ts:267`          | `sweepOnBoot` default transcript root                                              |
| `orchestrator-guard.ts:312`          | `personalGuardHookActive` reads the global `settings.json` directly (not via §2.2) |
| `claude-settings.ts:33`              | `claudeSettingsPath()` — the hardened RMW chokepoint for `settings.json`           |
| `session-registry-watch.ts:36`       | `sessionsRegistryDir()` — `~/.claude/sessions` PID registry (T92)                  |
| `team-watcher.ts:47`                 | `DEFAULT_TEAMS_ROOT` — `~/.claude/teams`                                           |
| `team-watcher.ts:49`                 | `DEFAULT_TASKS_ROOT` — `~/.claude/tasks`                                           |
| `image-cache.ts:143`, `:150`, `:159` | shell passes `homedir()` into the pure `imageCacheRoot`/`resolveImagePath`         |
| `roadmap-core.ts:1115`               | image-cache root recomputed **inline** in the MCP card-asset gate                  |
| `mcp/tool-handlers.ts:578`           | passes `os.homedir()` into `resolveCardAssetSource`                                |

### 2.2 Inherit through `claudeSettingsPath()` — no edit, but they WRITE

| file:line                           | what it does                                         |
| ----------------------------------- | ---------------------------------------------------- |
| `hook-installer.ts:270,289,300,331` | installs/removes the observer hook blob — **writes** |
| `statusline.ts:6` (import)          | installs/strips the `statusLine` key — **writes**    |
| `hook-bridge.ts:15`                 | reads settings to report install state               |

### 2.3 Capy-owned, but living under `~/.claude` — a separate decision (§4.3)

| file:line                            | what it touches                                      |
| ------------------------------------ | ---------------------------------------------------- |
| `extensions/extensions-loader.ts:39` | `~/.claude/capy-extensions` (T137 extension SDK)     |
| `detect/screen-detect.ts:99`         | `~/.claude/detectors` (T9 manifest overrides)        |
| `usage-history.ts:79`                | `~/.claude/om2tab/usage-history` (samples + windows) |
| `usage-cost.ts:182`                  | `~/.claude/om2tab/usage-history/cost-cache.json`     |

### 2.4 Deliberately out of scope — `homedir()` that is not the config dir

- **Repo-scoped `<repo>/.claude/**`** — `worktree-core.ts:48,68-74`, `git-probe.ts:68`,
  `worktree-md-ipc.ts:174,339`, `mcp/server.ts:594`, `mcp/settings-local.ts`,
  `orchestrator-guard.ts:77`. Verified in the 2.1.222 binary: project scope resolves from
  **cwd**, never from the config dir. These must NOT move.
- **`~` expansion for permission/grant scope matching** — `mcp/permission-core.ts:126,162,180,207`,
  `mcp/grant-registry.ts:79,164`, `mcp/plan-tool-call.ts:290,337`, `mcp/tool-handlers.ts:434,872`,
  `mcp/server.ts:853`, `roadmap-ipc.ts:805,1054`.
- **`~` expansion of user-typed folder paths** — `responder-registry.ts:83`,
  `user-projects.ts:209`, `claude-config.ts:67`.
- **Neutral spawn cwd** — `pty.ts:61,796`, `usage.ts:48`, `usage-history.ts:343`.
- **Binary discovery** — `claude-cli.ts:26-47,100-101` (`~/.local/bin/claude` etc.). The CLI
  itself hardcodes `homedir()` for its `~/.claude/local` npm-local install, so this stays.
- **`<userData>/…`** — `statusline.ts:61-82`, `orchestrator-guard.ts:52-61`. Already app-owned.

### 2.5 Corrections to the card's list

- `mcp/team-parse.ts:5-6` is a **doc comment in a pure core** — it builds no paths. The real
  sites are `team-watcher.ts:47,49`.
- `statusline-install.ts:37-56` is **pure** (`buildWriterScript`) and takes `inboxDir` as an
  argument; the settings write is in `statusline.ts` via `claudeSettingsPath()`.
- The card **missed**: `fleet-model.ts:51`, `usage-cost.ts:55,182`, `usage-history.ts:79`,
  `orchestrator-guard.ts:267,312`, `roadmap-core.ts:1115` + `mcp/tool-handlers.ts:578`,
  `team-watcher.ts:47,49`, and the three write-side inheritors in §2.2.

## 3. Precedence — confirmed, not assumed

Confirmed against the installed binary (`strings` over `~/.local/share/claude/versions/2.1.222`,
read-only). The canonical resolver is one memoized function:

```js
function g9l() {
  return process.env.CLAUDE_CONFIG_DIR
}
fn = qr(() => (g9l() ?? SSe.join(_9l.homedir(), '.claude')).normalize('NFC'), g9l)
```

Every config-dir consumer in the CLI goes through `fn()` — `join(fn(),"teams")`,
`join(fn(),"ide")`, `join(fn(),".config.json")` — and the standalone sites agree verbatim:
`n?.CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR` → `?? join(homedir(),'.claude')`. The
CLI's own `/context`-style prompt states it in shell: `` `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/*/` ``.

**`XDG_CONFIG_HOME` does not relocate the Claude config dir in 2.1.222.** All 11 occurrences in
the binary are unrelated: the Anthropic SDK's `$XDG_CONFIG_HOME/anthropic`, `ANTHROPIC_CONFIG_DIR`,
the git `core.excludesfile` lookup, fish completion, alacritty config, the systemd user-unit dir,
the env-name catalog, and the eval harness. **There is therefore no precedence question to get
backwards** — the card's premise (from the CC changelog's v1.0.28 note) does not hold for the
installed version. Implement `CLAUDE_CONFIG_DIR` only. Three consequences that DO matter:

- **`.normalize('NFC')`** — the CLI NFC-normalizes the root. Capy must too, or a decomposed-form
  (NFD) path from `readdir` on APFS fails the `session-ops` prefix comparison.
- **`??` not `||`** — `CLAUDE_CONFIG_DIR=""` makes the CLI resolve to `''`. Capy must **not**
  copy that: an empty root turns the destructive fence into `startsWith('/')`, which matches every
  absolute path. Treat empty/whitespace-only as unset.
- **Relative values** are not resolved by the CLI. Capy's cwd differs from the CLI's, so a
  relative value cannot be made to agree — reject it (§4.4).

**Re-verification duty:** this is pinned to 2.1.222. Recheck when the audit's CLI-version-detection
item (§5 row 4) lands; the resolver is one function, so adding `XDG_CONFIG_HOME` later is one edit.

## 4. Decision

### 4.1 Shape — `src/main/claude-config-dir.ts`, one new module

```ts
export type ConfigDirStatus = 'ok' | 'missing' | 'unreadable' | 'invalid'
/** Absolute, NFC-normalized Claude config root. Resolved once; frozen for the process. */
export function claudeConfigDir(): string
/** `join(claudeConfigDir(), ...segments)`. The only way to build a config-dir path. */
export function claudeConfigPath(...segments: string[]): string
/** Why the root may be unusable, for the degraded banner. `'ok'` in the normal case. */
export function claudeConfigDirStatus(): ConfigDirStatus
/** Test-only override, mirroring `fleet-model.__setRootDirForTests`. */
export function __setClaudeConfigDirForTests(dir: string | null): void
```

Every §2.1 site becomes `claudeConfigPath('projects')` / `claudeConfigPath('settings.json')` /
`claudeConfigPath('image-cache')`. Existing `rootDir` / `dir` / `homeDir` injection points stay
exactly as they are — only the **default** changes, so all current tests keep working.

### 4.2 When it resolves — once, at first call, frozen

Resolved lazily on first call and memoized for the process lifetime. Rationale, verified:

- Electron never reloads `process.env` mid-run, so there is nothing to re-resolve.
- Spawned PTYs inherit the parent env (`pty.ts:732-736`; `sanitizeSpawnEnv` strips only AppImage
  pollution and never touches `CLAUDE_*`), so the child `claude` sees the **same**
  `CLAUDE_CONFIG_DIR` Capy resolved from. One authority, no divergence.
- **Writers (§2.2) are the reason freezing matters.** A frozen root means the hook blob and the
  `statusLine` key are installed into, and later stripped from, the same file. An env change
  between runs is handled at the next boot: `installObserverHooks` / the statusline install are
  already idempotent read-merge-writes keyed on a marker, so they re-install into the new root.
  A blob orphaned in the old root is inert (the CLI no longer reads it) and is removed if the
  user flips the env back — accepted, and logged once at boot when the resolved root differs
  from the previously recorded one (persisted in `<userData>`).

Lazy-not-eager also means no import-order coupling with `index.ts`'s boot sequence.

### 4.3 Capy-owned paths stay anchored to `homedir()` — decided

`~/.claude/capy-extensions`, `~/.claude/detectors`, and `~/.claude/om2tab/usage-history` do **not**
follow the resolved root. Reasons:

1. They are not the CLI's contract. Claude Code never reads them; there is nothing to stay in
   sync with. The whole point of the resolver is agreement with the CLI.
2. A user relocating their Claude config does not expect their Capy extensions and detector
   overrides to disappear. That would be a second silent failure introduced by the fix.
3. `usage-history` is an **accumulating** store. Following the root would fork it on every env
   flip, and the Usage Dashboard would read as reset with no stated cause — the exact class of
   bug this card exists to close.

`~/.claude/om2tab/` is squatting inside someone else's directory and belongs under
`app.getPath('userData')`. That is a **separate, migration-bearing card** (§4.6), not this one.

### 4.4 The destructive fence — re-anchored fail-closed

`session-ops.ts:45-60` fences `session:delete`/`session:digest` to `~/.claude/projects` with a
trailing-separator prefix guard. A configurable root must not widen it. Three changes:

1. Extract the guard into an exported pure function taking the root explicitly
   (ADR-0001 pure-core/thin-shell). `session-ops.ts` is **in** the coverage surface and has **no
   test file today** — this is what makes the new test possible.
2. `PROJECTS_ROOT` becomes a memoized `projectsRoot()` call, not a module-level `const`, so it
   never captures a value before the resolver has run.
3. **Fail closed.** The guard returns `false` for every input unless the root is a non-empty,
   absolute, NFC-normalized path. `''` or a relative root must never reach the prefix comparison:
   `''  + '/'` matches every absolute path and would open `fs.unlink` to the whole filesystem.
   The existing `resolve()` collapse of `..` and the trailing-`sep` guard against a sibling
   (`…/projects-other/`) are kept verbatim.

`image-cache.ts:42-52` and `roadmap-core.ts:1115` carry the same prefix-plus-`sep` shape and get
the same treatment; both already take the root as a parameter, so only the caller changes.

### 4.5 Degradation — visible, never a silent fallback

| Condition                       | Status       | Behavior                                                                                      |
| ------------------------------- | ------------ | --------------------------------------------------------------------------------------------- |
| Unset                           | `ok`         | `~/.claude`. Today's behavior, byte for byte.                                                 |
| Set, absolute, exists, readable | `ok`         | Used everywhere in §2.1.                                                                      |
| Set, absolute, does not exist   | `missing`    | Root is **still used** (so the app is consistently empty, not half-relocated) + degraded emit |
| Set, absolute, exists, `EACCES` | `unreadable` | Same as `missing`, different message.                                                         |
| Set to `""` / whitespace        | `invalid`    | Fall back to `~/.claude` + degraded emit. Fence fails closed regardless (§4.4).               |
| Set to a relative path          | `invalid`    | Fall back to `~/.claude` + degraded emit — Capy's cwd can't agree with the CLI's.             |

"Degraded emit" reuses the existing channel rather than inventing one: `claude:watcher:degraded`
(`claude-watcher.ts:918`, preload `onWatcherDegraded` at `preload/index.ts:1430`, already consumed
by the sessions store) gains a `config-dir` code. The message names the resolved path and the
env var, so the user sees _why_ the app is empty. Two new i18n keys, `en.json` **and**
`pt-BR.json` in the same change.

### 4.6 Alternatives rejected

- **Resolve per call, no memo.** Matches the CLI's memo-keyed-on-env behavior, but a GUI's env is
  static and a moving root mid-run is exactly how a hook gets orphaned. Rejected.
- **Silently fall back to `~/.claude` when the configured dir is missing.** The app would look
  populated while the CLI writes elsewhere — worse than empty, because nothing signals it.
- **Move `~/.claude/om2tab/` to `<userData>` in this card.** Correct destination, but it needs a
  migration of an accumulating store. Separate card.
- **Support `XDG_CONFIG_HOME` "just in case".** It would point at `$XDG_CONFIG_HOME/claude`, a
  directory 2.1.222 never reads — inventing a divergence in the name of fixing one.

### 4.7 Open questions

- **Q1.** Was `XDG_CONFIG_HOME` support for the config dir real in v1.0.28 and later removed, or
  did the changelog note refer to something else? Not resolvable from the installed binary. Does
  not block: 2.1.222 is what ships today, and the resolver is one function.
- **Q2.** Should `mcp/tool-catalog.ts:643,686` — agent-facing copy that literally says "must be
  under `~/.claude/image-cache/`" — interpolate the resolved root? Doing so makes it agent-facing
  (§7). Recommendation: yes, interpolate; the agent needs a path it can actually produce.

## 5. Acceptance

- One resolver; no remaining `join(homedir(), '.claude', …)` outside it and outside §2.3/§2.4.
- Precedence matches 2.1.222: `CLAUDE_CONFIG_DIR` → `~/.claude`, NFC-normalized. `XDG_CONFIG_HOME`
  is not consulted, and the spec records why.
- The `session-ops` fence holds against the resolved root, keeps the trailing-separator guard,
  and **fails closed** on an empty/relative/unresolved root.
- Watcher, settings RMW, hook installer, statusline writer, image cache, teams/tasks reader and
  PID registry all follow the resolved root; an env change between runs re-installs cleanly and
  never corrupts `settings.json`.
- Capy-owned paths (§2.3) are unchanged and a test pins that they do NOT follow the root.
- A non-existent / unreadable / invalid configured dir degrades visibly and never crashes.

## 6. Test plan

| Test                                                                                             | File                                                                                  | Asserts    |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- | ---------- |
| default (env unset) → `~/.claude`; `CLAUDE_CONFIG_DIR` set → that path, NFC-normalized           | `tests/claude-config-dir.test.ts` (**new**)                                           | §3, §4.1   |
| `XDG_CONFIG_HOME` set alone → **ignored**; both set → `CLAUDE_CONFIG_DIR` wins                   | `tests/claude-config-dir.test.ts` (**new**)                                           | §3         |
| `""` / whitespace / relative → `invalid`, falls back, status reported                            | `tests/claude-config-dir.test.ts` (**new**)                                           | §4.5       |
| missing dir → `missing`, root still used, no throw; `EACCES` → `unreadable`                      | `tests/claude-config-dir.test.ts` (**new**)                                           | §4.5       |
| memoized: a second call after mutating `process.env` returns the first value                     | `tests/claude-config-dir.test.ts` (**new**)                                           | §4.2       |
| fence: file under the resolved root → allowed; sibling `…/projects-other/x.jsonl` → refused      | `tests/session-ops-fence.test.ts` (**new**)                                           | §4.4       |
| fence **path traversal**: `<root>/a/../../../../etc/passwd` and `<root>/../evil.jsonl` → refused | `tests/session-ops-fence.test.ts` (**new**)                                           | §4.4       |
| fence **fails closed**: root `''` / relative / unresolved → `/etc/passwd` refused                | `tests/session-ops-fence.test.ts` (**new**)                                           | §4.4 (3)   |
| `imageCacheRoot`/`resolveImagePath` under a relocated root; `../../etc/passwd` still null        | `tests/image-cache.test.ts` (existing)                                                | §2.1, §4.4 |
| image-cache shell lists/reads from the resolved root                                             | `tests/image-cache-shell.test.ts` (existing)                                          | §2.1       |
| `claudeSettingsPath()` follows the root; RMW/backup/atomic-rename unchanged                      | `tests/claude-settings-write.test.ts` (existing)                                      | §2.1, §2.2 |
| hook install → strip round-trip against a relocated settings path leaves no residue              | `tests/hook-installer.test.ts` (existing)                                             | §4.2       |
| statusline install/strip preserves a foreign `statusLine` under a relocated root                 | `tests/statusline-install.test.ts` (existing)                                         | §2.2       |
| watcher default root follows the resolver (`rootDir` injection still wins)                       | `tests/claude-watcher.test.ts` (existing)                                             | §2.1       |
| fleet model default root follows the resolver; `__setRootDirForTests` still wins                 | `tests/fleet-model.test.ts` (existing)                                                | §2.1       |
| PID registry dir follows the root; absent dir → silent no-op (gate unchanged)                    | `tests/session-registry-watch.test.ts` (existing)                                     | §2.1, §4.5 |
| teams/tasks roots follow the resolver                                                            | `tests/team-hook-bridge.test.ts` (existing)                                           | §2.1       |
| `sweepOnBoot` + `personalGuardHookActive` follow the resolver                                    | `tests/orchestrator-guard.test.ts` (existing)                                         | §2.1       |
| cost engine `projectsRoot()` follows the root; **`cacheDir()` does NOT**                         | `tests/usage-cost-core.test.ts` (existing)                                            | §2.3       |
| usage-history `rootDir()` stays on `homedir()` with the env set                                  | `tests/usage-history-core.test.ts` (existing)                                         | §2.3       |
| extensions dir + detectors dir stay on `homedir()` with the env set                              | `tests/extensions-loader-modes.test.ts`, `tests/manifest-registry.test.ts` (existing) | §2.3       |

`tests/session-ops-fence.test.ts` requires the §4.4 (1) extraction — `session-ops.ts` is in the
coverage surface (`vitest.config.mts` does not exclude it) and has no test today.

## 7. Contracts touched

- **`CHANGELOG.md` — YES.** `### Fixed`: "Capy now reads and writes the Claude config directory
  the CLI actually uses (`CLAUDE_CONFIG_DIR`), so sessions, hooks, usage and the pasted-images
  gallery keep working when you relocate it."
- **`docs/capy-features.md` — YES, IF Q2 is taken.** Interpolating the resolved root into
  `tool-catalog.ts:643,686` changes what path an agent may pass to `create_card`/`update_card`
  `images` — a change in verb semantics. Bump the `<!-- capy-features vN -->` marker. If Q2 is
  declined, no agent-usable semantics change and the diff carries **`no-awareness`** (the CI gate
  trips on `tool-catalog.ts`).
- **`docs/user/` — YES.** `docs/user/settings.md` gains a short "Relocating your Claude config
  directory" note; `docs/user/README.md`, `getting-started.md` and `extensions.md` say
  `~/.claude` in prose and need the caveat, especially `extensions.md` (§4.3 says extensions do
  **not** move). Also required by the gate: this adds a top-level `src/main/` file.
- **`design.md` — NO.** No new visual element; the degraded banner reuses the existing
  watcher-degraded surface (§6 Footer).
- **i18n — YES.** Two keys for the degraded message, in `en.json` **and** `pt-BR.json` in the
  same change (schema parity, `docs/lessons/i18n/002`).
- **English-only — YES, satisfied.** New code, comments and doc prose are English.

## 8. Definition of done

- [ ] `src/main/claude-config-dir.ts` — `claudeConfigDir` / `claudeConfigPath` /
      `claudeConfigDirStatus` / `__setClaudeConfigDirForTests`, memoized, NFC-normalized
- [ ] All 16 §2.1 sites routed through it; §2.3 explicitly left on `homedir()` with a comment
      naming this spec
- [ ] `session-ops` fence extracted to an exported pure function, re-anchored, **fail-closed**
- [ ] `image-cache.ts:20` and `session-registry-watch.ts:33-34` comments ("no `CLAUDE_CONFIG_DIR`
      support in the app today") corrected — they are the load-bearing lie this card removes
- [ ] `claude:watcher:degraded` gains a `config-dir` code; renderer surfaces it; two i18n keys in
      both locales
- [ ] Boot logs once when the resolved root differs from the previously recorded one
- [ ] §6 tests green, including the two new files and the path-traversal + fail-closed cases
- [ ] `CHANGELOG.md`, `docs/user/settings.md` (+ the three prose pages), and — if Q2 —
      `docs/capy-features.md` with a marker bump
- [ ] `npm run typecheck` and `npm run build` pass
