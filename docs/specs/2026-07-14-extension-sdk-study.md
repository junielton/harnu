# Extension SDK study — themes, modes, and everything else that fits the pattern

> Status: study (pre-spec) · 2026-07-14 · feeds card **T136 (Extension SDK)** · prereqs T120 (PR #97) + T121 (PR #96) merged
> Sources: code recon 2026-07-14 (file:line cited inline), audited VS Code/Obsidian architecture review 2026-07-12.

## 0. The question

Which Capy capabilities can become **user-installable extensions** — added by dropping a
manifest on disk, no fork, no rebuild — and what exactly is missing for each? The two
concrete asks: **themes** and **session modes** (the `Modes ▸ Learning` folder-menu entry).
Then: what else follows the same pattern.

## 1. The pattern we already ship (the reference implementation)

Capy already has one working extension system: **terminal-state detectors**
(`~/.claude/detectors/<agent>.json`). Its architecture is the template for everything below:

| Piece          | File                                           | Property                                                                                                                                       |
| -------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Pure validator | `src/main/detect/manifest-load-core.ts`        | structurally-invalid manifest → rejected _with reason_; one broken rule → skipped, never fatal                                                 |
| Registry fold  | `src/main/detect/manifest-registry.ts:111-131` | builtins first, then overrides; an override with **no builtin compiles standalone** ("a user can add a brand-new agent without a code change") |
| Impure shell   | `src/main/detect/screen-detect.ts:155+`        | `~/.claude/detectors` watched via chokidar, 100 ms debounce, hot-reload + `detectors:changed` event                                            |

Design posture (from the 2026-07-12 audit): **VS Code's trust shape, Obsidian's infra size.**
VS Code's safety comes from process isolation + mediated UI slots — _not_ from manifests being
declarative. We don't need an extension host until third-party _code_ runs; Phases 1–2 below are
**pure data** (worst case: an ugly theme, a bad-advice mode prompt), so the detector-grade loader
is enough. User-installed content is trusted-content class, same as `WORKTREE.md` setup scripts.
Hard boundary carried from the audit: never add a generic `invoke(channel)` escape hatch to
`window.api`; extension behavior reaches the app only through mediated registries.

## 2. Case study A — Themes as extensions

### Today (all compile-time, triple hand-sync)

A theme is **36 tokens** — 20 UI + 16 ANSI (`themes.css:9-10`): 6 surfaces, 5 text, 9
accent/semantic, 16 `--term-ansi-*`. 13 themes ship as `:root[data-theme='…']` blocks
(`themes.css`; default is the Tailwind `@theme` block at :12-54). Shape/motion tokens
(`--radius*`, `--ease`, `--dur*`, `--shadow-pop`) are theme-invariant — a theme never touches them.

Adding a theme today means editing **four places by hand**:

1. the CSS block (`themes.css`);
2. `THEMES` array (`stores/theme.ts:7-21`);
3. `THEME_META` (`stores/theme.ts:39-118`) — including **hand-copying 4 swatch hexes** from the
   CSS, because the picker can't read inactive themes' vars (`theme.ts:24-31`);
4. two i18n label keys (`en.json` + `pt-BR.json`, schema-locked by the CI parity gate).

The rest of the pipeline is already indirection-friendly: switching = one `data-theme`
attribute flip (`theme.ts:129-134`); xterm re-reads tokens via `getComputedStyle` on every
switch (`terminalTheme.ts:19-46` + watches in `TerminalPane.vue`/`HelperPane.vue`) — so a
runtime-injected theme **recolors terminals for free**.

### What's missing (gap → change)

| Gap                                                                                                 | Change                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No runtime CSS injection                                                                            | Loader builds one `:root[data-theme='ext-<id>']` stylesheet from the manifest and mounts it (`adoptedStyleSheets` or a `<style>` tag). Prefix `ext-` prevents id collision with builtins. |
| `THEMES`/`THEME_META` hardcoded                                                                     | Derive: `allThemes = BUILTIN_THEMES ∪ extensionThemes`. Swatch is **computed from the manifest tokens** — kills the hand-copy problem for extension themes entirely.                      |
| Labels are i18n keys                                                                                | Extension themes carry a **plain-string label** in the manifest (Obsidian's convention: community content self-localizes). Builtins keep `$t()`.                                          |
| CSS contract is convention-only (a missing token silently inherits the default — `themes.css:1-11`) | The pure validator **enforces all 36 tokens** and rejects with a reason — the extension path becomes _stricter_ than the in-repo path.                                                    |
| `om2tab.theme` persistence validates against the hardcoded union (`theme.ts:120-122`)               | Guard accepts `ext-*` ids; if the extension is uninstalled, fall back to `default-dark` (never a broken blank).                                                                           |

**Manifest sketch** (`theme` contribution): `{ id, label, dark: boolean, tokens: { bg, sidebar, surface, surface2, border, border2, text, text2, text3, text4, textDisabled, accent, accentSoft, accentLine, accentInk, green, greenSoft, red, redSoft, warning, ansi: { black, red, …, brightWhite } } }` — exactly the 36-token contract, JSON-shaped, zero CSS knowledge required from the author.

**Effort: S–M.** Purely declarative, no code execution, no process boundary crossed (loader can
live renderer-side reading via a small main IPC, or main-side pushing over the existing
watcher-event pattern). **This is the ideal Phase-1 proof of the SDK.**

## 3. Case study B — Modes as extensions

### Today (already a registry — the closest surface to done)

`Modes ▸ Learning` is **T123**, and its implementation is exactly the right shape:

- **Registry:** `src/main/session-modes.ts` — `SessionMode { id, labelKey, icon, doc }`,
  `SESSION_MODES` array (one entry: `learning`), `isSessionModeId()` treats IPC input as
  untrusted, `modeContract(id)` returns `''` for unknown → **degrades to a normal session,
  never throws**.
- **Contract text:** a versioned Markdown doc (`docs/capy-teacher.md`) inlined at build time via
  `?raw` (`capy-teacher.ts:12`), version-marker parsed like `capy-features.md`.
- **Injection:** `pty.ts:615-626` joins `[self-awareness doc, orchestrator doc if armed,
modeContract(opts.mode), auto-organize line]` and prepends to `--append-system-prompt`.
- **UI:** `FolderMenu.vue:325-337` maps `SESSION_MODES` → submenu items. **Adding a registry
  entry auto-adds the menu item.** (The Orchestrator role is a parallel caller of the same
  injection channel, deliberately not in this registry — `session-modes.ts:11-13`.)

### What's missing (gap → change)

| Gap                                                                              | Change                                                                                                                                                         |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SESSION_MODES` + docs bundled at build time                                     | Disk loader: `<extension>/modes/<id>.md` with YAML frontmatter `{ id, label, icon? }`, body = the contract. Merged after builtins (detector precedence rules). |
| Renderer imports `SESSION_MODES` from main at compile time (`FolderMenu.vue:29`) | Replace with an IPC read + change event (`modes:list` / `modes:changed`) — the exact mirror of `detectors:changed`. Small, mechanical.                         |
| Icon is a lucide glyph name mapped by hand (`MODE_ICONS`)                        | Keep: unknown icon already falls back to `GraduationCap`. Extensions pick from a documented subset.                                                            |
| `SessionModeId` is a closed union                                                | Loosen to `string` at the IPC boundary (already guarded by `isSessionModeId`-style validation); keep the union for builtins.                                   |

**Security note (the honest one):** a mode doc is _prompt injection by design_ — it is literally
appended to the system prompt of a session the user boots. That is the feature. It is
trusted-content class (the user installed it), but the UI should disclose origin: a small
"custom" badge on extension modes in the menu, and the mode id recorded in the session's boot
disclosure. A mode must never change permission flags — it is text only; flags stay owned by
`claude-args.ts` and its denylist.

**Effort: M** (the IPC decoupling is the only real work). Phase 1–2.

## 4. Everything else that fits — ranked by distance to the pattern

| #   | Surface                              | Today                                                                                                          | Distance | Notes                                                                                                                                                                                                                      |
| --- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Board templates**                  | Already read from disk per call (`tool-handlers.ts:469-482`, `resources/board-templates/<kind>.md`, null-safe) | **XS**   | Just add user-dir precedence: check `<extensions>/board-templates/<kind>.md` before the app resource. Hot-editable already.                                                                                                |
| 2   | **Detectors**                        | Done                                                                                                           | —        | The model itself. Fold its dir into the unified extension layout eventually (keep `~/.claude/detectors` as legacy alias).                                                                                                  |
| 3   | **Themes**                           | §2                                                                                                             | **S–M**  | Phase-1 flagship.                                                                                                                                                                                                          |
| 4   | **Modes**                            | §3                                                                                                             | **M**    | Phase-1/2. Highest product leverage (a mode = a distributable _method_, cf. T50's "process factory" insight).                                                                                                              |
| 5   | **Statusline / hooks / boot config** | Already user-authored files (`~/.claude/settings.json`, `claude-boot.json`) with self-healing installers       | —        | Already "extensions" in spirit; document them as such.                                                                                                                                                                     |
| 6   | **Notification sounds**              | Bundled asset behind a `sound: boolean` pref                                                                   | S        | Could ride the theme manifest (`sounds.notify: <file>`) — v2, low value.                                                                                                                                                   |
| 7   | **i18n locales**                     | Static imports + closed tuple (`i18n/index.ts:2-13,63`); schema-typed; CI parity gate                          | **L**    | Technically possible via `setLocaleMessage`, but the type-safety + parity-gate design actively fights it. Farthest; skip until asked.                                                                                      |
| 8   | **MCP verbs**                        | Post-T120: one def + one handler (`tool-catalog.ts` header: "Nothing else.") — but both compile-time           | **L**    | Phase 3. Needs a handler-code story. Interim idea: **declarative composite verbs** (a manifest verb that expands into existing primitives — open_file + notify + template) gets 80% of the value with zero code execution. |
| 9   | **Pane types**                       | Post-T121: exhaustive typed registry (`pane-registry.ts`) + separate component map                             | **XL**   | Phase 3. Needs the sandboxed `<webview>`/iframe host, theme-token injection, MCP-only postMessage channel. The registry seam is ready; the host doesn't exist.                                                             |

## 5. Shared infrastructure decision — one dir, VS Code-shaped `contributes`

Recommendation: **one extension = one folder** under `~/.claude/capy-extensions/<id>/` with a
single `manifest.json`:

```json
{
  "id": "my-pack",
  "label": "My pack",
  "version": "1.0.0",
  "contributes": {
    "themes": [
      { "id": "solarized-capy", "label": "Solarized Capy", "dark": true, "tokens": { "…": "…" } }
    ],
    "modes": [
      { "id": "code-reviewer", "label": "Code reviewer", "doc": "./modes/code-reviewer.md" }
    ],
    "boardTemplates": { "bug": "./templates/bug.md" }
  }
}
```

Why this over per-surface dirs (`capy-themes/`, `capy-modes/`, …): one watcher, one loader, one
validation entry point, one uninstall gesture, one place to show origin in the UI — and each
`contributes` key gets its own **pure validator** (per-key fail-soft: a broken theme never
disables the pack's modes). This is the detector triad generalized once, instead of N times.
A per-repo variant (`.capy/extensions/`) can come later for project-scoped packs; the loader
signature (`buildRegistry(overrides)`) already supports layering.

## 6. Phasing (maps to card T136)

1. **Phase 1 — declarative extensions**: shared loader (detector triad generalized) +
   `contributes.themes` + `contributes.boardTemplates`. Zero code execution. Proves install /
   hot-reload / uninstall / origin-badge UX end to end.
2. **Phase 2 — modes**: `contributes.modes` + the `modes:list` IPC decoupling + boot-disclosure
   line. (Separated from Phase 1 only because of the prompt-injection disclosure design.)
3. **Phase 3 — behavior extensions**: composite declarative MCP verbs first; real handler code
   and sandboxed panes only if demand shows up — that's the point where the VS Code-grade
   isolation conversation (utility process, webview host) actually starts.

Non-goals at every phase: marketplace, remote installation, auto-update of extensions, a
generic IPC escape hatch, raw DOM access for extension UI.
