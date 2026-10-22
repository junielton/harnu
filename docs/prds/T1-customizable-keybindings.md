# PRD — T1: Customizable keybindings

> Reconstructed 2026-09-09 alongside the spec (`docs/specs/T1-customizable-keybindings.md`).
> House shape: problem / who / what v1 delivers / out of scope / how we know /
> cost & risk.

## 1. Problem

Harnu sits next to VS Code, Cursor, and a terminal all day, and it is the only
one of them whose keyboard shortcuts cannot be changed. Every chord is a
hardcoded literal. There is no reported incident driving this — it is parity
with every editor Harnu shares a screen with, and it closes a real gap for the
Linux users in the current audience whose desktop environment claims chords
(`Ctrl+K`, `Ctrl+Shift+P`, …) out from under the app with no recourse.

Underneath, the same chord is duplicated in four places — `App.vue`,
`menu.ts`, `EmptyState.vue`, and both locale files — with nothing detecting
drift. The feature's enabling work collapses that to one canonical table; the
rebinding UI is what the user actually gets.

## 2. Who it's for

Power users on **macOS and Linux** (both are v1). Someone with editor muscle
memory, a chord collision with their window manager, or a left-hand/one-hand
setup. Not a first-run concern — the feature is latent until someone has a
conflict, which is exactly when they need to already know Harnu is rebindable.

## 3. What v1 delivers

### 3.1 All five phases

1. **One canonical table.** All 17 renderer shortcuts + the reserved `app.*`
   menu roles live in `src/main/keybindings-core.ts`. Every displayed chord —
   the command palette, the empty state, the session menu, i18n labels —
   derives from the **resolved** table. The four-way drift bug becomes
   impossible to write.
2. **`keybindings.json`.** A VS Code-shaped array, hand-editable, next to
   `settings.json` and following its relocation, chokidar-watched so an
   external edit applies live. One entry per command; `"key": null` unbinds.
   `//` comments tolerated.
3. **Both dispatch surfaces.** Overrides apply to the renderer `useMagicKeys`
   watchers _and_ the native menu (rebuilt on every change), so a rebound chord
   works in the terminal pane too — for the ~9 menu-backed actions.
4. **Settings → Keybindings.** A row per action (name / chord / default), a
   record-a-chord control, per-row Reset + Unbind, global Reset all, conflict
   badges on every participant, and a "not in terminal" marker for the
   renderer-only actions.
5. **Open & discover.** A native **View → "Keyboard Shortcuts…"** item and an
   in-pane button open `keybindings.json` in Harnu's helper panel. `Cmd+Alt+K`
   does the same and is itself reserved.

### 3.2 Platform hint rendering (required, not a side-benefit)

`design.md` §6 currently mandates `⌘⇧⌥⌃` in every hint. Because Linux is half
the audience, the spec replaces that with platform rendering: `⌘⇧⌥⌃` on macOS,
`Ctrl` / `Shift` / `Alt` elsewhere. Every displayed chord changes on
Linux/Windows whether or not anyone rebinds anything. Its own CHANGELOG bullet.

### 3.3 The un-brick guarantee

A user can rebind the chord that opens Settings, or land two overrides on one
chord. Three escapes, none of which need the file you just broke:

1. A malformed or reserved-colliding file falls back to defaults for the
   affected ids with a visible toast.
2. The Settings → Keybindings tab is always reachable **by mouse** from the
   gear menu.
3. "Reset all" in the pane and in the View menu.

### 3.4 Fallback cut

If the pane (P4) has to be cut, **P1–P3 ship** as "rebind by hand-editing
`keybindings.json`, live, on both surfaces, with derived hints" — VS Code's
model minus the GUI. DoD's "reset without hand-editing" then downgrades to
"Reset all from the View menu". Naming this makes cutting it a decision, not a
slip.

## 4. Out of scope (v1)

Terminal keymap rebinding; `when`-clause expressions; importing VS Code
keybindings; multi-chord-per-action and two-chord sequences; user-editable
scope; promoting renderer-only actions into the native menu; per-folder
overrides; a first-run tour or EmptyState affordance for discovery; Windows
manual verification (leans on `keybindings-core` mac/non-mac tests).

## 5. How we know it worked

**Deciding signal — verifiable by construction, not measurement** (Harnu ships
no product analytics): _the four-way drift bug can no longer be written._ P1
leaves exactly one table, and the tests assert every display surface and both
dispatch surfaces derive from it. A hint that disagrees with the chord that
fires is now structurally impossible.

**Supporting signal:** at least one live override that survives an app upgrade.

**Wrong signal:** any user hitting escape #1 (the fallback-to-defaults toast)
or "Reset all" during _normal_ use means the parser or the conflict model is
too strict.

**Discovery:** the native View → "Keyboard Shortcuts…" item plus the Settings
tab is the claimed discovery path. Proportionate for a power-user feature; no
first-run tour.

## 6. Cost & risk

- **Cost:** ~5 phases. P1–P3 is the mechanism (parser + core + file + menu
  sync + derived hints); P4–P5 is roughly half the build and all of the new UI
  surface, the `design.md` §6 work, and the new i18n keys (× 2 locales).
- **Risk — parser strictness.** A too-strict parser rejects a chord a user
  reasonably typed. Mitigated: every rejection is a named, surfaced warning
  with the default kept, never a throw.
- **Risk — menu / renderer split stays confusing.** A rebound renderer-only
  chord silently doesn't fire in the terminal pane. Mitigated: the "not in
  terminal" per-row marker (Q8 option b) makes it visible; option a (promote
  everything into the menu) is deferred to its own card.
- **Risk — Linux regression.** Platform rendering changes every hint on Linux.
  Mitigated: manual Linux pass is a merge gate (Q12).
- **Risk — gate widening.** The confined-file gate also validates MCP
  `open_file`. Mitigated: the exact-path exception is passed only at the three
  `markdown:*` channels the pane uses, never at the `open_file` validator — so
  no agent-facing surface changes and no `docs/harnu-features.md` bump.
