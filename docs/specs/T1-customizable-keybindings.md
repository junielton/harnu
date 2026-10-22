# T1 — Customizable keybindings

> Reconstructed 2026-09-09 from the card's four answered interview rounds
> (roadmap/T1). The original 721-line draft was written in an earlier worktree
> and never committed. This file is the authoritative spec; it folds in every
> Round 1–4 answer.

## Problem

Every keyboard chord in Harnu is a hardcoded literal, and the same chord is
written in **four** independent places with nothing detecting drift:

1. `src/renderer/src/App.vue` — the `useShortcuts([...])` registration table
   (`keys: 'Cmd+K'`, …), 17 renderer bindings.
2. `src/main/menu.ts` — the native-menu `accelerator:` strings (~9 of the 17).
3. `src/renderer/src/components/EmptyState.vue` — the `['⌘', 'K']` hint arrays.
4. `src/renderer/src/i18n/{en,pt-BR}.json` — chords baked into labels
   (`"search": "Search (⌘K)"`).

Plus `SessionMenu.vue`'s `renameAccelerator = 'F2'` and `CommandPalette.vue`'s
per-item `accelerator` hints.

There is no override layer, no settings surface, no persisted file. A Linux
desktop environment that claims `Cmd+K`/`Ctrl+K` (or VS Code muscle memory)
leaves the user with no recourse.

## Approach

Add a **merge layer** on top of the existing, well-shaped dispatch system — do
not rewrite it. The system already has the two things that make this tractable:
stable string action ids, and `keys` as a per-binding string rather than a
parsed structure.

One canonical descriptor table becomes the single source of truth. Every
display surface derives from the **resolved** table (defaults ← overrides).
Both dispatch surfaces (renderer `useMagicKeys` watchers + native menu) read
the resolved chords.

## Decisions (from the interview)

| #       | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1      | Overrides live in a dedicated `keybindings.json`, VS Code-shaped, hand-editable, with a shortcut to open it. **Global only** (no per-folder). One file, `Cmd`/`Mod` semantics (no per-platform sections). A reserved set is un-rebindable.                                                                                                                                                                                                                                                                                                                         |
| Q1      | File is a **VS Code-shaped array** of `{ "key", "command", "scope"? }` entries, **restricted to one entry per `command`** (last wins, warn on duplicates). `"key": null` (or a leading `-`) means "unbind this default entirely".                                                                                                                                                                                                                                                                                                                                  |
| Q2      | Canonical chord grammar is **Harnu's `Cmd+Shift+P` casing** with `Cmd`/`Mod` as the portable modifier (keeps the defaults table copy-pasteable). **Two-chord sequences are out of scope for v1** — rejected at parse with a named warning, never silently ignored.                                                                                                                                                                                                                                                                                                 |
| Q3      | **Main owns the file.** Reads it at startup _before_ `registerAppMenu`. Exposes `keybindings:load` / `keybindings:save` + a `keybindings:changed` event over IPC. Rebuilds the menu (`Menu.setApplicationMenu`) on every change. Sits **next to `settings.json` and follows its relocation**. **Chokidar-watched** — a hand-edit applies without a restart.                                                                                                                                                                                                        |
| Q4      | Rebindable surface = **the 17 renderer bindings only**. Reserved = `app.quit`, `app.devtools`, `app.fullscreen`, `app.reload` (+ the open-keybindings chord). Displayed hints become **derived** from the resolved table → an i18n change (`"search": "Search"` + a chord slot, not a chord inside the string).                                                                                                                                                                                                                                                    |
| Q5      | The "open keybindings.json" shortcut opens the file **in Harnu's helper panel** (the `MarkdownPane` any-text-file editor). Its chord is **itself reserved**. Settings → Keybindings tab stays reachable **by mouse** from the gear menu (never keyboard-only). A malformed/conflicting file **falls back to defaults for the affected ids with a visible toast**, never fails closed. No `--reset-keybindings` CLI flag.                                                                                                                                           |
| Q6      | Helper-pane opening vs. the confined-file gate → **exact-path exception** in the shared gate, passed at the three channels the pane uses (`markdown:read`, `markdown:write`, `markdown:watch`) and **not** at the MCP `open_file` validator. So `open_file` still refuses the file and no `docs/harnu-features.md` bump is triggered.                                                                                                                                                                                                                              |
| Q7      | A **conflict** = any two _resolved_ bindings sharing a normalized chord **in the same scope**, regardless of origin (override-vs-override _and_ override-vs-untouched-default). Runtime keeps **first-registered wins** (App.vue declaration order — deterministic); the chord still dispatches once. **Every participant** is badged in the pane, so nothing silently stops working. An override landing on a **reserved** chord is **rejected at parse** (override dropped, default kept, named warning + toast). Per-row **Unbind** action; **no auto-unbind**. |
| Q8      | Keep the renderer/menu split, **make it visible**: a per-row "not in terminal" marker in the pane, derived from menu membership. Validate a rebound chord against the Electron accelerator grammar **only for menu-backed actions** (a renderer-only action may legally take a chord Electron can't express).                                                                                                                                                                                                                                                      |
| Q9      | `scope` is **parsed and validated but not user-editable in v1** — an entry naming a different scope than the built-in binding is rejected with a named warning (the field stays in the shape for forward-compat). `enabled()` and the `Cmd+W` terminal fall-through stay **keyed to the action id**; `terminalKeymap.ts` is untouched (its `Cmd+W` behavior is left stale on purpose for v1).                                                                                                                                                                      |
| Q10–Q14 | PRD framing: lead user-facing (rebinding is the product, de-dup is how); all five phases are v1 (P1–P3 is the named fallback cut); macOS **and Linux** are the v1 audience → Linux verified manually before merge; success is verifiable by construction ("the four-way drift bug can no longer be written"); discovery is the native **View → "Keyboard Shortcuts…"** item + the Settings tab.                                                                                                                                                                    |

## Data model

### `keybindings.json` (on disk)

```jsonc
// Harnu keybindings — overrides merged over the built-in defaults.
// One entry per "command". "key": null unbinds the default.
[
  { "key": "Cmd+J", "command": "view.review" },
  { "key": "Cmd+Shift+K", "command": "app.search" },
  { "key": null, "command": "session.resumeLast" }
]
```

- `//` and `/* */` comments are stripped before `JSON.parse` (VS Code's own
  default keybindings file is entirely comments — failing the whole file over
  one would be hostile). ~30 lines of pure, tested code.
- Top level must be an array. A non-array / unparseable file → **whole file
  ignored**, defaults used, one toast.
- Per-entry validation, each failure collected as a named warning (surfaced in
  the pane, not thrown):
  - `command` not one of the 17 rebindable ids → `unknown-command`.
  - duplicate `command` → `duplicate-command` (last wins).
  - `key` present but unparseable / a two-chord sequence → `bad-chord` /
    `sequence-unsupported` (entry dropped, default kept).
  - `key` resolves to a **reserved** chord → `reserved-chord` (entry dropped).
  - `scope` present and ≠ the built-in binding's scope → `scope-immutable`
    (entry dropped).
  - menu-backed `command` + `key` not expressible as an Electron accelerator →
    `not-accelerator` (entry dropped).

### Canonical chord grammar

`Mod+Shift+Key` style. Tokens joined by `+`, order-insensitive on input,
normalized to `Mod?  Ctrl?  Alt?  Shift?  <key>` on output.

- Modifiers: `Cmd`, `Mod` (both = ⌘ on macOS, Ctrl elsewhere), `Ctrl`, `Alt`
  (= `Option`), `Shift`.
- Keys: `A`–`Z`, `0`–`9`, `F1`–`F24`, `Enter`, `Escape`, `Tab`, `Space`,
  `ArrowUp/Down/Left/Right`, `Backspace`, `Delete`, `Home`, `End`,
  `PageUp/PageDown`, `-` `=` `[` `]` `\` `;` `'` `,` `.` `/` `` ` ``.
- `keybindings-core.ts` exports:
  - `parseChord(s): { ok: true; chord: Chord } | { ok: false; code }`
  - `normalizeChord(chord): string` — the canonical string.
  - `toMagicKeys(chord): string` — `useShortcuts` shorthand.
  - `toAccelerator(chord): string | null` — Electron accelerator, or `null`
    when the chord cannot be expressed as one.
  - `chordFromEvent(e: KeyboardEvent): Chord | null` — for the capture control.
  - `renderChord(chord, platform): string[]` — display tokens
    (`['⌘', '⇧', 'P']` on mac; `['Ctrl', 'Shift', 'P']` elsewhere).

### The canonical descriptor table — `src/main/keybindings-core.ts`

Pure module (no `electron` import), imported by `src/main/keybindings.ts`,
`src/main/menu.ts`, and the renderer via `../../../main/keybindings-core`
(the established `pr-stack-core` cross-process pattern).

```ts
export interface KeyBindingDescriptor {
  id: ShortcutActionId // stable action id
  defaultKeys: string | null // canonical chord, or null (menu-only role)
  scope: 'global' | 'sidebar' | 'terminal' | 'modal'
  menu: boolean // has a native menu item (fires in the terminal pane)
  reserved: boolean // un-rebindable
  labelKey: string // i18n key for the human name
}
export const KEYBINDINGS: KeyBindingDescriptor[] // 17 rebindable + reserved app.*
export const REBINDABLE_IDS: readonly ShortcutActionId[]
export const RESERVED_IDS: readonly ShortcutActionId[]
```

### Resolution — `resolveKeybindings(overrides): ResolvedBindings`

Pure. `{ id -> { keys: string | null; source: 'default' | 'override' | 'unbound'; conflictsWith: string[] } }`
plus a `warnings: KeybindingWarning[]` array. Conflict detection runs here
(normalized chord × scope, all origins).

## Process ownership & wiring

```
startup (src/main/index.ts):
  loadKeybindings()                 // read + strip comments + parse + validate
  registerAppMenu(getWindow)        // menu.ts reads resolved accelerators
  registerKeybindingsHandlers(...)  // keybindings:load / :save / :changed
  watchKeybindings(getWindow)       // chokidar → reload → rebuild menu → emit :changed

renderer:
  stores/keybindings.ts             // holds ResolvedBindings, subscribes to :changed
  App.vue useShortcuts([...])       // keys/scope pulled from the store's resolved table
  EmptyState / CommandPalette / SessionMenu  // hints derived from the store
```

`keybindings.json` path = `dirname(settingsPath()) + '/keybindings.json'`, and
`isPathAllowed` gains the exact-path exception (read/write/watch channels only).

## Phases (each independently shippable)

- **P1 — de-duplication.** Introduce `keybindings-core.ts` with the canonical
  table + chord helpers. Point `App.vue`, `menu.ts`, `EmptyState.vue`,
  `CommandPalette.vue`, `SessionMenu.vue` at it. i18n: strip the `(⌘K)` /
  `(⌘S)`-style chords out of labels, add a derived chord slot. **No
  user-visible behavior change.** `design.md` §6: the "always use the Mac
  symbol" rule becomes platform rendering.
- **P2 — override layer.** `keybindings-core.ts` parser/normalizer/emitters +
  `resolveKeybindings`. `src/main/keybindings.ts`: comment-strip, load,
  validate, `keybindings:load/save`, chokidar watch. Renderer store consumes
  it. Overrides now apply to the renderer watchers. Tests:
  `tests/keybindings-core.test.ts` (parse, normalize, both emitters,
  resolve, conflicts, mac/non-mac render), `tests/keybindings-file.test.ts`
  (comment strip, array shape, per-entry warnings, reserved rejection).
- **P3 — menu sync + derived hints + platform rendering.** `menu.ts` builds
  accelerators from the resolved table; `watchKeybindings` rebuilds the menu on
  change. All display surfaces now show the resolved chord on every platform.
- **P4 — Settings pane.** `KeybindingsPane.vue` (new Settings tab): a row per
  rebindable action — name / current chord / default — with a record-a-chord
  capture control, per-row Reset + Unbind, and a global "Reset all". Conflict
  badges on every participant. "Not in terminal" marker for renderer-only
  actions. `design.md` §6: new pane + capture control. New i18n keys in both
  locales.
- **P5 — open + discover.** New reserved action `app.openKeybindings`
  (`Cmd+Alt+K`), a **View → "Keyboard Shortcuts…"** native menu item, and an
  "Open keybindings.json" button in the pane — all open the file in the
  `MarkdownPane` helper pane. The exact-path gate exception. The un-brick
  guarantee: the Settings tab is mouse-reachable, and a broken file self-heals
  to defaults with a toast.

## Out of scope (v1)

- Rebinding `terminalKeymap.ts` (copy/paste, `Shift+Enter`, font size).
- `when`-clause expressions. Scope stack + `enabled()` already cover it.
- Importing VS Code keybindings files.
- Multi-chord-per-action; two-chord sequences.
- User-editable `scope`.
- Promoting renderer-only actions into the native menu (Q8 option a) — its own
  card if wanted.

## Definition of done

- Overrides load, apply to **both** dispatch surfaces, survive a restart.
- Conflicts detected and shown, not silently resolved.
- Reset-to-defaults works from the UI (per-row and global).
- A broken `keybindings.json` never bricks the app (fall back + toast; Settings
  tab mouse-reachable).
- `CHANGELOG.md` entry.
- `docs/user/sessions.md` shortcut table + a "customizing shortcuts" section;
  `docs/user/settings.md` covers the new tab.
- `design.md` §6 updated **before** the UI work.
- No `docs/harnu-features.md` bump (the gate exception is deliberately not at
  the `open_file` validator).
- Linux verified manually: hints render `Ctrl`/`Shift`/`Alt`; a rebind
  re-applies to the GTK menu; a file written on macOS loads unchanged.
- `npm run typecheck` and `npm run build` both green.
