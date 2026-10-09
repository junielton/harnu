# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 🔒 Design contract — read `design.md` before touching any UI

**`design.md` is the single source of truth for the visual system.** It is written in English and defines every token, component, motion spec, and copy rule. Before you write, refactor, or restyle anything inside `src/renderer/`:

1. **Read the relevant section of `design.md` first.** Sections are: §1 Logo, §2 Colors, §3 Typography, §4 Spacing & radii, §5 Iconography, §6 Components, §7 Motion, §8 Voice & copy, §9 Tokens.
2. **If your task needs a token, size, animation, or component variant that's not in `design.md`, edit `design.md` first** in the same change, then implement. Never silently add a new color, radius, easing, or row-height.
3. **No raw colors or off-system sizes in components.** Tailwind utilities only, backed by `src/renderer/src/styles/themes.css` (which mirrors `design.md` §9). If you reach for `bg-[#1a1a1f]` or `style="color: rgba(...)"`, you are violating the contract.

### Branding note

The public product name is **Harnu** (domain `harnu.dev`). "Claude" appears only as a _descriptor_ — e.g. "a session manager for Claude Code" — never as the brand itself; using "Claude" as the product name is the trademark risk this rebrand exists to avoid. Visible UI copy, the `design.md` §1 wordmark/lockups, the i18n `app.name`, and the `BrandMark` component should all read **Harnu**. The logo and visual mark are unchanged for now; they follow in a later phase, and only the name text has moved to Harnu. (The project was previously called `om2tab` and then Capy, and several invisible internal namespaces — the `om2tab.*` `localStorage` key prefix, legacy hook/statusline markers kept for back-compat — deliberately retain the old id; those are not user-visible brand and must not be renamed. Legacy `capy` ids — the `capy` MCP server name, `capy:` skill prefix, `capy://` URIs, `CAPY_*` variables, the `.capy/` data dir — remain only as migration and compatibility aliases, so old installs and saved rules keep working; never use them as the product name.)

### Token map (CSS → Tailwind utility)

All tokens declared in `themes.css` follow the design. Token name → Tailwind utility examples:

| Token                                                             | bg / text / border utility            |
| ----------------------------------------------------------------- | ------------------------------------- |
| `--color-bg`                                                      | `bg-bg`, `text-bg`                    |
| `--color-sidebar`                                                 | `bg-sidebar`                          |
| `--color-surface`                                                 | `bg-surface`, `border-surface`        |
| `--color-surface-2`                                               | `bg-surface-2`                        |
| `--color-border`                                                  | `border-border`                       |
| `--color-border-2`                                                | `border-border-2`                     |
| `--color-text` / `text-2` / `text-3` / `text-4` / `text-disabled` | `text-text`, `text-text-2`, …         |
| `--color-accent`                                                  | `bg-accent`, `text-accent`            |
| `--color-accent-soft`                                             | `bg-accent-soft`                      |
| `--color-accent-line`                                             | `border-accent-line`                  |
| `--color-accent-ink`                                              | `text-accent-ink` (only on accent bg) |
| `--color-green` / `--color-green-soft`                            | `bg-green`, `bg-green-soft`           |
| `--color-red` / `--color-warning`                                 | `text-red`, `text-warning`            |
| `--color-red-soft`                                                | `bg-red-soft`                         |

Motion tokens (`--ease`, `--dur-fast`, `--dur`, `--dur-slow`) and shape tokens (`--radius-sm`, `--radius`, `--radius-lg`, `--shadow-pop`) are available as CSS variables and through the helper classes `.anim-fade-in`, `.anim-fade-in-scale`, `.anim-overlay-fade`, `.anim-pulse-dot`, `.anim-shimmer-dot` defined in `main.css`. Don't write ad-hoc keyframes in components.

### i18n & copy

- Default locale: **`en`** (`src/renderer/src/i18n/en.json`).
- `pt-BR` is **fully populated and at parity** with `en.json`. The schema is `MessageSchema = typeof en`, so **every new key must be added to BOTH `en.json` and `pt-BR.json` in the same change** or the `vue-tsc` build breaks (see `docs/lessons/i18n/002-vue-i18n-schema-parity.md`). `design.md` is the English source of truth — write the `en.json` wording to match it and the screenshots, then translate that wording into `pt-BR.json`; the key must exist in both files.
- All visible strings must go through `$t('namespace.key')`. No string literals in templates.
- Tone rules live in `design.md` §8 (Voice & copy). Short labels = no trailing period; complete sentences = period; technical nouns (worktree, branch, commit, tool call, diff) are kept untranslated.

## 📓 Changelog is mandatory

**Every feature or fix MUST add a dated entry to `CHANGELOG.md` (repo root) in the same change — no exceptions.** The file follows [Keep a Changelog](https://keepachangelog.com/): newest first, grouped under a `## YYYY-MM-DD` date with `### Added` / `### Changed` / `### Fixed` sections, one user-facing bullet per change.

- A commit/PR that adds, changes, or fixes behavior **without** a `CHANGELOG.md` entry is **incomplete** — treat the entry as part of the definition of done.
- The in-app **Settings → Changelog** tab renders this file (`ChangelogPane.vue` via `changelog-parse.ts`), so entries are read by real users — write them for humans, not as commit logs.
- Group multiple changes landed on the same day under one `## YYYY-MM-DD` heading. Convert "today" to the actual date.
- Pure internal refactors, docs, and test-only changes don't require an entry (add one under `### Changed` only if the effect is user-visible).

## 🧭 Self-awareness doc is mandatory (agent-facing changes)

Harnu tells every session what it can do from inside Harnu by prepending `docs/harnu-features.md` to the session's system prompt (T55, `src/main/harnu-features.ts`). That doc is a **contract, exactly like the CHANGELOG**: it must be kept true.

**Every AGENT-FACING change MUST update `docs/harnu-features.md` in the same change, and bump its version marker (`<!-- harnu-features vN -->`) — no exceptions.** Run `/harnu-awareness` for the editorial rules (what belongs, the terse second-person tone, good/bad examples).

**"Agent-facing" means a change to an _actionable capability_ the session itself uses or offers** — not release notes. It is agent-facing when it touches:

- a **new or changed MCP verb** in `src/main/mcp/tool-catalog.ts` (the canonical agent API surface);
- the **shape of an ACK** a verb returns (a new field the agent should read, e.g. `grantBudgetRemaining`);
- **grant / confirm semantics** (what a mission grant buys, when a confirm fires, budget/TTL behavior);
- a **UI affordance the agent should proactively offer the user** ("open this .md report in the viewer", "enable agent control from the folder menu").

It is **NOT** agent-facing (leave the doc alone) when it is a fact the session can't act on: internal fleet-state/stuck heuristics, watcher/persistence internals, renderer styling, or anything that's just "what shipped". Litmus: _budget-with-no-ACK_ (the agent reads a new field) is **in**; _fleet-state/stuck classifier tuning_ (nothing new to call or offer) is **out**.

- A commit/PR with an agent-facing change **without** the `docs/harnu-features.md` update + marker bump is **incomplete** — same standing as a missing CHANGELOG entry.
- A **CI gate** (`scripts/ci/awareness-gate.mjs`) enforces this: a diff touching `src/main/mcp/tool-catalog.ts` or `src/main/harnu-features.ts` must also touch `docs/harnu-features.md`, or carry the **`no-awareness`** label (a catalog-internal change with no new agent-usable semantics).

## 📗 User docs are mandatory (user-visible changes)

Harnu ships to real end users, not just contributors. `docs/user/` (T124) is the only place that speaks to them in plain English — install, features, how to actually use the thing. It is a **contract, exactly like the CHANGELOG and `docs/harnu-features.md`**: it must stay true to what actually shipped, or it rots the same way empty `docs/` did before T124.

**Every PR that lands a user-visible capability MUST update the relevant page(s) under `docs/user/` in the same change — no exceptions.** Read the code and `CHANGELOG.md` to confirm the actual behavior before writing — never document a spec that never landed, and say plainly when something is half-built.

**"User-visible" means a person using the app gains a new thing to see or do.** Concretely, it is user-visible when it adds:

- a **new top-level Vue component** under `src/renderer/src/components/` (a new screen, pane, or dialog someone can open and interact with — see the "Design entity → file map" above, which already tracks this 1:1);
- a **new top-level file** directly under `src/main/` (a new main-process capability wired to the UI — a new IPC surface, a new background policy the user can configure or observe);
- a **new or changed MCP verb** in `src/main/mcp/tool-catalog.ts` (the same verbs `docs/harnu-features.md` documents for the agent belong, in human prose, in `docs/user/agent-control.md`).

It is **NOT** user-visible (leave `docs/user/` alone) when it is: a nested/internal helper (`src/main/detect/**` — fleet-state heuristics; `src/main/mcp/**` other than `tool-catalog.ts` — MCP server internals; `src/renderer/src/components/ui/**` — low-level primitives like `ToggleSwitch`), an edit to an existing file that adds no new user-reachable behavior, a pure refactor, a perf fix, or a styling tweak.

- A commit/PR that ships a new component, main-process capability, or MCP verb **without** a `docs/user/` update is **incomplete** — treat the doc update as part of the definition of done, same standing as a missing CHANGELOG entry.
- A **CI gate** (`scripts/ci/user-docs-gate.mjs`) enforces this: a diff that adds a top-level component or main-process file, or changes `tool-catalog.ts`, must also touch something under `docs/user/`, or carry the **`no-user-docs`** label (an internal/refactor change with no new user-reachable surface).

## 🌐 Language policy — English is the lingua franca

**Harnu is open source.** English is the sole working language for this repository — the same standing as the Changelog, self-awareness, and user-docs contracts above. This is not a style preference; it's what makes the codebase legible to a contributor who doesn't read Portuguese.

**English is mandatory for:** all code, code comments, docstrings, commit messages, PR titles/descriptions, `CHANGELOG.md` entries, `docs/**` (specs, plans, ADRs, PRDs, lessons), `design.md`, project-memory content (`.harnu/memory/**`), test names and descriptions, and any string literal meant to be read by a human (log messages, error messages, generated file templates) — anywhere it isn't already covered by the i18n exception below.

**The one exception is i18n resources:** `src/renderer/src/i18n/*` locale files (`pt-BR.json` and any future non-English locale) and test fixtures that exist specifically to exercise i18n/locale behavior (a translated string used as sample data to test a translation feature, a UTF-8/unicode test fixture). Any other language — Portuguese, Spanish, German, or otherwise — has no home outside that exception.

- A PR that adds non-English prose in a comment, doc, commit message, or any string outside the i18n exception is **incomplete** — same standing as a missing CHANGELOG entry.
- See [`docs/lessons/conventions/001-english-lingua-franca.md`](docs/lessons/conventions/001-english-lingua-franca.md) for the review lesson with concrete good/bad examples.
- A **CI gate** (`scripts/ci/english-gate.mjs`) flags Portuguese prose in any tracked text file outside the i18n exception. When a file legitimately needs non-English text (a locale file, a unicode fixture), add it to `ALLOWED_PATHS` in `scripts/ci/english-gate-core.mjs`.

## 🕵️ Client confidentiality — real client identifiers never enter this repo

**Harnu is open source, and its specs are written from live evidence.** That combination is
the hazard: the honest way to write a spec is to quote what was actually measured, and what
was actually measured usually lives in a client repo. The evidence must survive; the
identifiers must not.

**Never commit, in any tracked file** — source, tests, specs, PRDs, ADRs, `design.md`,
`CHANGELOG.md`, `docs/**`, or `.harnu/memory/**`:

- **client or employer names**, in any casing or CamelCase contraction;
- **client ticket keys** (`ACME-1234`-shaped ids from a real tracker), including inside
  branch names, worktree directory names and slugify examples;
- **client repo or org paths** (`~/Workspace/<employer>/<client>/www`, and the
  `-home-user-Workspace-…` slug form of the same path);
- **client source paths** (`app/Filament/…`, `bin/worktree/…` under a client tree),
  infrastructure hostnames, database names, and tracker/workspace ids.

**Use the neutral vocabulary instead.** It is stable — reuse these, don't invent a new set
per document, so a worked example stays greppable:

| Real thing          | Write this                                        |
| ------------------- | ------------------------------------------------- |
| a client ticket key | `PROJ-231`, `ACME-10996`                          |
| a client name       | `Acme`, `ProjectAlpha`                            |
| an employer/org dir | `~/Workspace/org/…`                               |
| a client repo dir   | `org/proj/www`, `org/www`                         |
| a repo group label  | `ProjectAlpha`, `www · org-a` / `www · org-b`     |
| a sibling repo      | `api-gateway`, `web-api`, `portal`, `example-web` |

**Preserve the shape, scrub the identity.** A spec's worth is in the _shape_ of its worked
example — `PROJ-347-wave-2` branching off `PROJ-347-wave-1`, two branches sharing one
upstream, a 47-worktree corpus. Keep all of that, including real commit SHAs, PR numbers and
measured counts: once the branch names are neutral those carry no identity. Do **not** flatten
a worked example into `foo`/`bar` to be safe — over-scrubbing destroys the readability the
example exists for.

**Real numbers stay real.** "Measured on `org/proj/www`, 2026-08-28, 47 worktrees" is the
honest form. Never invent a measurement to replace one you scrubbed.

- A PR that introduces a real client identifier is **incomplete**, same standing as a missing
  CHANGELOG entry — and unlike a missing entry, it is not fixable after the fact: once pushed
  to a public remote it is in the history for good.
- **`tests/no-client-identifiers.test.ts` is the gate.** It `git grep`s the tracked tree for
  the _shape_ of an identifier — a `XYZ-1234` tracker key, a `Workspace/<name>` directory —
  and allowlists the neutral vocabulary above, so an unknown client fails the first time it is
  committed. It is deliberately not a list of real client names: such a list would have to
  spell them out to match them. If a gate fires on something genuinely innocent, add that
  token to the allowlist; never narrow a pattern to silence a hit, and never delete the
  gate. Making a pattern catch _more_ is always fair game — the two key gates match the
  same digit range in either case precisely so a slugified key cannot slip past the
  uppercase one.
- The identifiers that were committed before this convention existed were scrubbed from
  `HEAD`, and the public repository was then started without that history, so none of them
  were published. The record is [`docs/adr/0017-client-identifier-scrub-without-history-rewrite.md`](docs/adr/0017-client-identifier-scrub-without-history-rewrite.md).
- **`.harnu/private-denylist.txt`** (gitignored, maintainer machines only) lists bare names the
  shape gates cannot see; the same test matches them as whole words and reports `file:line`
  only. Keep it local; never commit it.

## Commands

```bash
npm install                # Install deps. postinstall runs `electron-builder install-app-deps` (rebuilds node-pty for Electron).
npm run dev                # electron-vite dev (main + preload + renderer with HMR + Electron window).
npm run build              # Full production build: typecheck:node + typecheck:web + electron-vite build.
npm run typecheck          # Both: typecheck:node (main/preload) + typecheck:web (renderer/Vue).
npm run typecheck:node     # tsc -p tsconfig.node.json (main + preload).
npm run typecheck:web      # vue-tsc -p tsconfig.web.json (renderer + Vue SFCs).
npm run lint               # ESLint with cache across the repo.
npm run format             # Prettier write across the repo.
npm run start              # Preview the production build via electron-vite preview.

npm run build:linux        # Build + electron-builder for Linux (.deb, AppImage).
npm run build:mac          # Build + electron-builder for macOS (.dmg).
npm run build:win          # Build + electron-builder for Windows (.exe).
npm run build:unpack       # Build + electron-builder --dir (unpacked, for local smoke-testing).
```

After changing main-process or preload code, the dev server hot-reloads them; the renderer HMR is via Vite. Native modules (currently only `node-pty`) are rebuilt by the `postinstall` script — if you upgrade Electron, run `npm install` again to trigger a rebuild.

## Architecture

A three-process Electron app: **main** (Node, privileged), **preload** (context bridge), **renderer** (Vue 3 + Tailwind v4 + xterm.js). Builds are driven by [electron-vite](https://electron-vite.org/) with three separate Vite configs nested in `electron.vite.config.ts`.

### Process boundaries

```
┌─────────────────────────────┐         ┌────────────────────────┐         ┌──────────────┐
│  Renderer (Vue 3, Tailwind) │ ←IPC→   │  Main (Electron, Node) │ ←pipe→  │  PTY procs   │
│  src/renderer/src/          │         │  src/main/             │         │  bash/claude │
└──────────────┬──────────────┘         └────────────────────────┘         └──────────────┘
               │
               ↑ contextBridge — only typed API
               │
       ┌───────┴────────┐
       │ src/preload/   │
       └────────────────┘
```

- The **renderer is sandbox-isolated** (`contextIsolation: true`). It can only call functions exposed by `src/preload/index.ts` through `window.api`.
- All Node-only APIs (file system, `node-pty`, `chokidar`) live in **`src/main/`** and are reached over IPC. Never `import` from `node:` in a Vue component.
- `electron-vite`'s `externalizeDepsPlugin()` is applied to main and preload so native modules are not bundled into the JS — they're resolved from `node_modules` at runtime.

### Where things live

- `src/main/index.ts` — window lifecycle, app events, registers IPC handlers, kills PTYs on quit.
- `src/main/pty.ts` — owns the `Map<uuid, IPty>`. Handles `pty:create`, `pty:write`, `pty:resize`, `pty:destroy`. Emits `pty:data:<uuid>` and `pty:exit:<uuid>` events back to the renderer.
- `src/preload/index.ts` — exposes a strongly-typed `Api` (`window.api`) covering the PTY lifecycle. Types re-exported and consumed by `src/preload/index.d.ts` for global `Window` augmentation.
- `src/renderer/src/App.vue` — layout shell. Reads from the Pinia stores, never touches PTYs directly.
- `src/renderer/src/components/` — UI pieces. Mapping of design entities → Vue files lives at the bottom of this file (§ "Design entity → file map").
- `src/renderer/src/stores/theme.ts` — current theme, persisted to `localStorage` under `om2tab.theme`. Writes `data-theme` on `<html>`. Themes defined in `themes.css`.
- `src/renderer/src/stores/sessions.ts` — **folder-first model**: the entity is `Folder` (path-keyed; git branch/`repoId`/`isMainWorktree` are optional additive metadata), with sessions directly under it — the old `Project → Worktree → Session` tree is gone. `init()` loads folders from `~/.claude/projects/` (`window.api.foldersLoad` → per-cwd `FolderEntry[]` with git probed per folder) merged with user-added pinned folders (`window.api.userProjectsList` → `mergeFolders`), then subscribes to the chokidar watcher events (`onProjectAdded`/`onProjectRemoved`/`onSessionAdded`/`onSessionRemoved`/`onSessionUpdated`/`onIndexUpdated`/`onWatcherDegraded`; still slug-keyed — the store decodes slug→path) for live reconciliation. The sidebar splits into a **pinned zone** + an **"Active elsewhere" zone** (`classifyFolder`/`groupByRepo` in `folder-zones.ts`), with a configurable session sort (`sessionSort`, `session-sort.ts`). Also owns synthetic sessions (`createNewSession`/`createForkedSession`, `synthetic-<uuid>` ids) and their synth→real migration once the watcher reports the JSONL on disk. (The legacy `model:load`/`scanProjects` path has been removed; `claude-reader.ts` keeps the per-slug readers + `ProjectEntry`/`WorktreeEntry` interfaces as the internal intermediate that `scanFolders` flattens.)
- `src/renderer/src/i18n/` — vue-i18n setup. Use `$t('key')` everywhere — never hardcode strings in templates.
- `src/renderer/src/styles/main.css` — Tailwind v4 entry, global resets, scrollbar, keyframes, motion helpers, `prefers-reduced-motion` reset.
- `src/renderer/src/styles/themes.css` — all tokens (CSS variables) per theme, mirroring `design.md` §9.

### Terminal embedding (TerminalPane.vue)

**Switching sessions detaches, it does not dispose.** Each session owns a long-lived `LiveTerminal` (`Terminal` + PTY + IPC cleanups) cached in the module-level `liveTerminals` map, keyed by `sessionId`. The cache survives component remounts (HMR / parent `v-if` flips). The PTY and xterm keep running in the background for every session that isn't currently visible — Claude keeps streaming, the scrollback keeps filling, conversation context is preserved (findings/04 §11).

On `sessions.selectedId` change, `activate(id)` runs:

1. **Detach the previously-attached terminal** via `detachLiveTerminal()` — removes its `term.element` from the host, disconnects the `ResizeObserver`, tears down the focus listeners. The `Terminal` and PTY stay alive. (`selectedId → null` calls `detachCurrent()` — an unselect, also non-destructive.)
2. **Reuse or create.** If a `LiveTerminal` already exists for `id`, `attachLiveTerminal()` `appendChild`s its existing `term.element` back into the host and resizes-on-attach to pick up any dimension changes that happened while detached. Otherwise `createLiveTerminal()` builds a fresh one: `new Terminal(...)`, `loadAddon(WebLinksAddon)` (no `FitAddon` — sizing is manual), `open()` into the host.
3. **Sizing is a two-pass manual measure** (no `FitAddon`): a rough `measureCells()` span estimate so the PTY spawns at a sane size, then a re-measure against xterm's real rendered metrics via `measureXtermCells()` and a second `resize()` if rows were off. The bundled Nerd Font is awaited (`ensureTerminalFontLoaded()`) before measuring so we don't measure the fallback face.
4. `window.api.ptyCreate(...)` spawns the PTY in the main process. The `kind` is resolved from the session entry: `claude-fork` (fork synthetic → `claude --resume <src> --fork-session`), `claude-new` (plain synthetic → bare `claude`), `claude-resume` (disk session → `claude --resume <uuid>`), or `shell` fallback.
5. **Wire data flow:** `pty.onData` → `term.write` (with renderer-side backpressure — count outstanding bytes, `ptyPauseFlow`/`ptyResumeFlow` over the 1 MiB / 256 KiB watermarks, T-3.6), `term.onData` → `pty.write`, `term.onResize` → `pty.resize`. A debounced `ResizeObserver` on the host drives grid resizes on container resize.

Full teardown (`disposeLiveTerminal` → `ptyDestroy` → `pty.kill()`) happens only on **explicit close** (`registerCloseHandler` — ⌘W / X button / `closeSession`), **window unload** (`beforeunload` → `disposeAllLiveTerminals`), or **app quit** (`before-quit` → `killAllPtys` in `src/main/pty.ts`). Tab switching never disposes.

Theme tokens are read from CSS variables at terminal-construction time, but a `watch(theme.current)` (T-3.5) reapplies the new CSS-var palette to `term.options.theme` for **every** live terminal — attached or detached — and forces a full `term.refresh(0, rows-1)` repaint, so switching theme mid-session recolors all running terminals.

### Adding a new IPC capability

1. Add the handler in `src/main/` (new file under `src/main/<feature>.ts`, plus a `register*(getWindow)` function called from `src/main/index.ts`).
2. Add the typed function to `src/preload/index.ts`'s `api` object.
3. The `Api` type is inferred from `api` and re-exported; `src/preload/index.d.ts` augments `Window` with it. The renderer can `window.api.yourFn(...)` with full types.
4. Use `ipcMain.handle` for request/response, `ipcMain.on` + `webContents.send` for streaming events. Channel naming: `feature:verb` (request) and `feature:event:<id>` (per-instance streams).

## Non-obvious behaviors

- **PTYs are killed in `before-quit`**, not `window-all-closed`. Quitting the app cleanly terminates every spawned shell.
- **The preload uses `process.contextIsolated`** to conditionally expose via `contextBridge` or direct window assignment — keep both branches in sync.
- **`vue-i18n@11`** is used (not `@10`, which is deprecated). The schema is keyed by the structure of `en.json`; adding a new locale requires updating `SUPPORTED_LOCALES` in `src/renderer/src/i18n/index.ts`.
- **Native modules**: the only one in this project is `node-pty`. If you add another (e.g. `better-sqlite3`), run `npm install` afterwards so `electron-builder install-app-deps` rebuilds it for Electron's V8 ABI.
- **Linux/KDE**: webkit2gtk under Wayland can be flaky. `npm run dev` may need `GDK_BACKEND=x11 npm run dev` if you see freezes or scroll glitches.
- **Live-verifying a change in the real app** (even while another Harnu/AppImage is running): launch a second **isolated** instance (`--user-data-dir=/tmp/harnu-verify` bypasses the single-instance lock; alt `--remote-debugging-port` avoids the `:9222` conflict), drive `window.api.*` over CDP (Node 22 has a built-in `WebSocket`), inspect the throwaway `userData`, and tear down only the PIDs you spawned. Full recipe (incl. the `is.dev` renderer-URL gotcha — serve `out/renderer` on `:5174` or use `npm run build:unpack`) in `docs/dev/live-verify-second-instance.md`.
- **Auto-update** runs only in packaged builds (the `registerUpdater` call in `src/main/index.ts` early-returns on `!app.isPackaged`, so dev sessions never poll). On Linux, the AppImage variant updates itself in place silently (auto-download + "Update ready — Restart now" toast); the `.deb` is managed by apt and is NOT auto-updated — users on Debian/Ubuntu must rerun `sudo dpkg -i`. macOS and Windows builds are unsigned, so Gatekeeper/Squirrel refuse to let electron-updater apply a downloaded update silently there — those platforms instead get a sticky "Update available" toast (`updater:manualAvailable`, see `usesManualUpdateFlow`/`releaseUrlFor` in `src/main/updater-policy.ts`) with a "Download update" action that opens the GitHub release page. The update channel tracks GitHub Releases via the `publish:` block in `electron-builder.yml`. Renderer subscriptions live on `window.api.onUpdate*` (see `src/preload/index.ts`).

## Design entity → file map

| Design entity (in `design.md`)                     | Vue file                                                                         |
| -------------------------------------------------- | -------------------------------------------------------------------------------- |
| Layout shell                                       | `src/renderer/src/App.vue`                                                       |
| Sidebar (§6 — session rows)                        | `src/renderer/src/components/Sidebar.vue`                                        |
| Sidebar folder row                                 | `src/renderer/src/components/SidebarFolder.vue`                                  |
| Sidebar jump palette (§6 — T288)                   | `src/renderer/src/components/SidebarJumpPalette.vue`                             |
| Repo group header (multi-worktree repos)           | `src/renderer/src/components/RepoGroupHeader.vue`                                |
| Topbar / breadcrumb / status pill                  | `src/renderer/src/components/Topbar.vue`                                         |
| Activity bell (Topbar notification popover, T152)  | `src/renderer/src/components/ActivityBell.vue`                                   |
| Empty state ("Ready to start")                     | `src/renderer/src/components/EmptyState.vue`                                     |
| Folder View (main pane, T212)                      | `src/renderer/src/components/FolderView.vue` + `folder-view-format.ts`           |
| Folder View — sessions section                     | `src/renderer/src/components/FolderViewSessions.vue`                             |
| Folder View — roadmap section                      | `src/renderer/src/components/FolderViewRoadmap.vue`                              |
| Folder View — worktrees section                    | `src/renderer/src/components/FolderViewWorktrees.vue`                            |
| Transcript / xterm host                            | `src/renderer/src/components/TerminalPane.vue`                                   |
| Onboarding hero                                    | `src/renderer/src/components/Onboarding.vue`                                     |
| Add folder dialog (§6 — Dialog)                    | `src/renderer/src/components/AddFolderDialog.vue`                                |
| New folder dialog (§6 — New folder)                | `src/renderer/src/components/NewFolderDialog.vue`                                |
| Open subfolder picker (§6 — Open subfolder)        | `src/renderer/src/components/OpenSubfolderDialog.vue`                            |
| Rename folder dialog (§6 — Rename folder)          | `src/renderer/src/components/RenameFolderDialog.vue`                             |
| Context menu (§6 — Context menu)                   | `src/renderer/src/components/SessionMenu.vue`                                    |
| Hover preview (session)                            | `src/renderer/src/components/SessionPreview.vue`                                 |
| Hover preview (folder) (§6 — Folder preview)       | `src/renderer/src/components/FolderPreview.vue`                                  |
| Brand mark (§1)                                    | `src/renderer/src/components/BrandMark.vue`                                      |
| Helper stack (split right side)                    | `src/renderer/src/components/HelperStack.vue`                                    |
| Helper pane (one cell)                             | `src/renderer/src/components/HelperPane.vue`                                     |
| Image lightbox (Pasted-images gallery, §6)         | `src/renderer/src/components/ImageLightbox.vue`                                  |
| Markdown pane (file-backed viewer, §6 — T74)       | `src/renderer/src/components/MarkdownPane.vue`                                   |
| Markdown renderer (string→prose, reusable)         | `src/renderer/src/components/MarkdownRenderer.vue` + `lib/markdown.ts` seam      |
| Memory pane (project memory viewer, §6 — T79)      | `src/renderer/src/components/MemoryPane.vue` + `stores/memory.ts`                |
| Split menu (Topbar dropdown)                       | `src/renderer/src/components/SplitMenu.vue`                                      |
| Fleet rail — approvals + fleet state (§6, T151)    | `src/renderer/src/components/InboxRail.vue`                                      |
| Approval Inbox row (§6)                            | `src/renderer/src/components/ApprovalRow.vue`                                    |
| Settings dialog (§6)                               | `src/renderer/src/components/SettingsDialog.vue`                                 |
| Claude config tab — settings.json editor (§6)      | `src/renderer/src/components/ClaudeConfigPane.vue` + `claude-config-catalog.ts`  |
| Plan usage panel (§6 — Footer popover)             | `src/renderer/src/components/UsagePanel.vue`                                     |
| Plan usage meter row (§6 — Footer popover)         | `src/renderer/src/components/UsageMeter.vue`                                     |
| Usage history pane (§6 — Settings tab)             | `src/renderer/src/components/UsageHistoryPane.vue` + `usage-history-format.ts`   |
| Usage history KPI tiles (§6 — T47 P3)              | `src/renderer/src/components/UsageStatTiles.vue`                                 |
| Usage "now" strip (§6 — T47 P4)                    | `src/renderer/src/components/UsageNowStrip.vue`                                  |
| Usage trajectory chart (bars/area) (§6)            | `src/renderer/src/components/UsageChart.vue`                                     |
| Plan-fit calculator card (§6)                      | `src/renderer/src/components/PlanFitCard.vue`                                    |
| Plan-fit peak distribution (§6 — T47 P4)           | `src/renderer/src/components/UsageDistribution.vue`                              |
| Usage weekday×hour heatmap (§6 — T47 P4)           | `src/renderer/src/components/UsageHeatmap.vue`                                   |
| Footer / status bar (§6 — Footer)                  | `src/renderer/src/components/StatusFooter.vue`                                   |
| Claude Boot launch-options form (§6)               | `src/renderer/src/components/ClaudeBootForm.vue`                                 |
| Claude Boot per-folder dialog (§6)                 | `src/renderer/src/components/ClaudeBootDialog.vue`                               |
| New session launch dialog (§6)                     | `src/renderer/src/components/NewSessionDialog.vue`                               |
| Endpoints registry pane (§6)                       | `src/renderer/src/components/EndpointsPane.vue`                                  |
| Remote notifications pane (§6 — push)              | `src/renderer/src/components/PushChannelsPane.vue` + `stores/push.ts`            |
| Voice pane (Settings tab, §6 — T239)               | `src/renderer/src/components/VoicePane.vue` + `stores/voice.ts`                  |
| Claude service status panel (§6)                   | `src/renderer/src/components/ClaudeStatusPanel.vue`                              |
| Control server (MCP) pane (§6)                     | `src/renderer/src/components/McpServerPane.vue`                                  |
| Agent-action confirm overlay (§6)                  | `src/renderer/src/components/McpConfirmOverlay.vue`                              |
| Bundled skills pane (Settings tab, T217)           | `src/renderer/src/components/BundledSkillsPane.vue`                              |
| Mods audit pane (Settings tab, T389)               | `src/renderer/src/components/ModsAuditPane.vue`                                  |
| Harnu mod outside Harnu switch (Mods tab, T389)    | `src/renderer/src/components/HarnuModExternal.vue` + `lib/external-view.ts`      |
| Usage Dashboard (takeover, §6 — T47 P6)            | `src/renderer/src/components/UsageDashboard.vue`                                 |
| Usage Dashboard KPI strip (§6)                     | `src/renderer/src/components/UsageDashboardKpiStrip.vue`                         |
| Usage Dashboard stacked chart (§6)                 | `src/renderer/src/components/UsageDashboardStackChart.vue`                       |
| Usage Dashboard activity calendar (§6)             | `src/renderer/src/components/UsageDashboardCalendar.vue`                         |
| Usage Dashboard ranked list (§6)                   | `src/renderer/src/components/UsageDashboardRankList.vue`                         |
| Usage Dashboard session anatomy (§6)               | `src/renderer/src/components/UsageDashboardAnatomy.vue`                          |
| Usage Dashboard explorer table (§6)                | `src/renderer/src/components/UsageDashboardExplorerTable.vue`                    |
| System Monitor (takeover, T127 S2)                 | `src/renderer/src/components/SystemMonitor.vue`                                  |
| System Monitor row (process/session/child)         | `src/renderer/src/components/SystemMonitorRow.vue`                               |
| Heap gauge (footer, T127 S3)                       | `src/renderer/src/components/HeapGauge.vue`                                      |
| Hibernation policy pane (Settings tab, T127 S4)    | `src/renderer/src/components/HibernationPolicyPane.vue`                          |
| Cleanup takeover (unified Workspace GC, T443)      | `src/renderer/src/components/CleanupView.vue`                                    |
| Cleanup treemap (repo → bucket → block, T443)      | `src/renderer/src/components/CleanupTreemap.vue` + `lib/gc-treemap.ts`           |
| Cleanup list fallback (T443)                       | `src/renderer/src/components/CleanupListView.vue`                                |
| Cleanup block side panel (T443)                    | `src/renderer/src/components/CleanupBlockPanel.vue`                              |
| Cleanup "Needs review" list (T443)                 | `src/renderer/src/components/CleanupReviewList.vue`                              |
| Cleanup opinion chip (T444)                        | `src/renderer/src/components/CleanupOpinionChip.vue` + `lib/gc-opinion.ts`       |
| Cleanup hero button / progress chip (T443)         | `src/renderer/src/components/CleanupHeroButton.vue`                              |
| Cleanup selection bar (T443)                       | `src/renderer/src/components/CleanupSelectionBar.vue`                            |
| Cleanup bulk-clean confirm dialog (T443)           | `src/renderer/src/components/CleanupBulkConfirmDialog.vue`                       |
| Cleanup first-cycle banner (T443)                  | `src/renderer/src/components/CleanupFirstCycleBanner.vue`                        |
| Cleanup Docker card (T443)                         | `src/renderer/src/components/CleanupDockerCard.vue`                              |
| Cleanup split bar (T443)                           | `src/renderer/src/components/CleanupSplitBar.vue`                                |
| Cleanup legend row (T443)                          | `src/renderer/src/components/CleanupLegend.vue`                                  |
| Cleanup "Other leftovers" (branches/folders, T443) | `src/renderer/src/components/CleanupOtherItems.vue`                              |
| Workspace GC store + view model (T443)             | `src/renderer/src/stores/gc.ts` + `lib/gc-model.ts` + `lib/gc-jobs.ts`           |
| Checkpoint timeline (Reaper PR3)                   | `src/renderer/src/components/CleanupTimeline.vue`                                |
| Sweep confirm dialog (Reaper PR3)                  | `src/renderer/src/components/SweepConfirmDialog.vue`                             |
| Dehydrate confirm dialog (T250)                    | `src/renderer/src/components/DehydrateConfirmDialog.vue` + `cleanup-row.ts`      |
| Cleanup settings pane (Settings tab, Reaper)       | `src/renderer/src/components/CleanupSettingsPane.vue`                            |
| Containers settings pane (Settings tab, T332)      | `src/renderer/src/components/ContainersSettingsPane.vue`                         |
| PR Stack Canvas (takeover, T198)                   | `src/renderer/src/components/PrStackCanvas.vue`                                  |
| PR card (canvas node)                              | `src/renderer/src/components/PrStackCard.vue` + `pr-stack-format.ts`             |
| PR Stack edge layer                                | `src/renderer/src/components/PrStackEdges.vue`                                   |
| PR Stack filter bar (T387)                         | `src/renderer/src/components/PrStackFilterBar.vue` + `pr-stack-filter.ts`        |
| PR Stack settings pane (Settings tab, T198)        | `src/renderer/src/components/PrStackSettingsPane.vue`                            |
| Diagram pane (canvas viewer, non-PTY, T218)        | `src/renderer/src/components/DiagramPane.vue` + `components/canvas/*`            |
| Scheduler (takeover, T291)                         | `src/renderer/src/components/SchedulerView.vue`                                  |
| Scheduler worker row                               | `src/renderer/src/components/SchedulerWorkerRow.vue`                             |
| Scheduler prompt field (skill mentions, T305)      | `src/renderer/src/components/SchedulerPromptField.vue` + `scheduler-mentions.ts` |
| Scheduler worker detail                            | `src/renderer/src/components/SchedulerWorkerDetail.vue`                          |
| Mission progress pill (Topbar, §6 — T370)          | `src/renderer/src/components/MissionPill.vue` + `lib/mission-view.ts`            |
| Mission progress popover (§6 — T370)               | `src/renderer/src/components/MissionPopover.vue` + `stores/missions.ts`          |
| Mission step rail (§6 — T370)                      | `src/renderer/src/components/MissionStepRail.vue`                                |
| Mission close confirm (§6 — T370 AC-S9-8)          | `src/renderer/src/components/MissionCloseConfirmDialog.vue`                      |
| Folder combobox (form control)                     | `src/renderer/src/components/ui/FolderCombobox.vue`                              |

## Process for UI work

Before opening a Vue file:

1. Open `design.md` and locate the section matching your task (see the design-entity map above).
2. If anything is unclear or missing, **update `design.md` first**, then implement. Same commit.
3. Use the playwright/browser MCP against the running app (see `docs/dev/live-verify-second-instance.md`) to visually confirm the result.
4. Run `npm run typecheck` and `npm run build` before reporting work done. Both must pass.
