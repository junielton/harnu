# PRD — T486: Keybindings coverage pass

> Written 2026-10-14 alongside the spec (`docs/specs/T486-keybindings-coverage-pass.md`).
> Follow-up to T1 (customizable keybindings, PR #65). House shape: problem / who /
> what this delivers / out of scope / how we know / cost & risk.

## 1. Problem

T1 made Harnu's shortcuts rebindable, but only for the 26 actions that already had a
chord or a Topbar button. Everything else the operator does in a day — open the
jump palette, close a takeover, cycle between the terminal and a split pane, fork a
session, rename a folder, open Cleanup, the Scheduler, the System Monitor or a given
Settings tab — is
**click-only**. There is no id to bind, so `keybindings.json` cannot reach it and the
Settings pane cannot list it. An operator who lives in VS Code (F6, Shift+F10, F2,
Ctrl+Enter, ``Ctrl+` ``) finds none of it.

Three defects make the surface worse than it looks:

1. **The Settings → Keyboard Shortcuts pane shows raw i18n keys**
   (`keybindings.actions.session.new`) instead of labels, in both locales. Every row
   is unreadable today.
2. **The pane is a flat, unsearchable list.** At ~26 rows it is tolerable; at the
   113-row table this card brings (82 new ids) it is not. There is no way to ask "what holds Ctrl+J?".
3. **The command palette carries six hand-written actions** that already drift from
   the real handlers (its "Resume last session" picks folder terminals; `App.vue`'s
   skips them). An unbound action is unreachable by keyboard because the palette
   does not know it exists.

And one documented behavior is false: `design.md` §6 says Esc dismisses a takeover
through the App-level `closeAll()`. `closeAll()` has no caller; only the header X
closes a takeover. A second bug sits in the pane itself: pressing Esc while recording a
chord closes Settings.

## 2. Who it's for

The power user who already rebinds (T1's audience): macOS and Linux, VS Code muscle
memory, keyboard-first. Secondary: anyone who opens the command palette to find an
action by name — the palette becomes the discovery path for every unbound action.

## 3. What this delivers

1. **Every user-invokable action has a stable id in the keybindings table**, including
   the ones that ship unbound — 82 new ids, among them one per Settings tab. The
   table, not the UI, is the inventory (re-derived from code in the spec, §3).
2. **A small, deliberate set of new defaults**, chosen for VS Code parity and checked
   against xterm and the reserved set: `Cmd+Shift+F` jump palette, `Esc` close
   takeover, `F6`/`Shift+F6` pane focus, `Cmd+Shift+M` maximize the focused pane,
   `Cmd+Enter` open to the side, `Shift+F10` context menu, `F2` rename folder,
   `Cmd+Alt+S` Keyboard Shortcuts settings. Everything else ships unbound, including
   fork (operator decision, 2026-10-14: Ctrl+D is EOF in every shell).
3. **A terminal toggle** (`terminal.toggle`) with VS Code's Ctrl+J semantics, shipped
   **unbound** by operator decision, with the Ctrl+J/LF hazard documented in the pane
   hint and the user docs.
4. **A searchable, grouped Keyboard Shortcuts pane** — search over label and chord,
   group headers, filter chips (Unbound / Conflicts / Customized) — and the raw-key
   bug fixed for good, with a test that renders the real i18n catalog. The recorder
   refuses chords that could never fire, and rows warn when a chord is taken from, or
   kept by, the terminal.
5. **A command palette generated from the table**: every palette-eligible action,
   with its resolved chord, reachable by typing its name.
6. **Chords in tooltips** for buttons whose action has a chord, tracking rebinds live.
7. **`nav.back` / `nav.forward` become rebindable** through a generic capture-phase
   shield that replaces today's hand-written `onNavKeydown`.

## 4. Out of scope

- MCP verbs — `list_keybindings` is T485 (soft-depends on this card's table).
- Two-chord sequences (`Ctrl+K Ctrl+S`). The grammar rejects them by design (T1 Q2);
  this card proves it does not need them.
- Redesigning the palette's visuals; per-folder overrides; `when`-clauses; rebinding
  `terminalKeymap.ts` (copy/paste, Shift+Enter, font size).
- Making the "not in terminal" marker platform-accurate. The spec proves it is wrong
  off macOS and centralizes it in one predicate; the fix is a follow-up.
- Localizing the native menu labels (they are English literals today).

## 5. How we know it worked

Harnu ships no product analytics, so success is verifiable by construction:

- **Deciding signal:** no click-only action is left. A test enumerates the table and
  asserts every id has a handler registered in `App.vue`, a label that resolves in
  both locales, and a group. Adding a button without an id still compiles, but adding
  an id without a handler or a label fails CI.
- **The palette cannot drift again.** Its action rows are generated; a test asserts
  each row dispatches the same registered handler the chord does.
- **The pane is readable.** A test mounts `KeybindingsPane` with the real i18n
  instance and asserts no row text starts with `keybindings.actions.`.
- **Wrong signal:** a new default that eats a key the terminal needed (reported as
  "Ctrl+X stopped working in Claude Code"). The spec's per-default terminal analysis
  is the guard; `terminal.toggle` ships unbound for exactly this reason.

## 6. Cost & risk

- **Cost:** eight stacked PRs (spec §11), each ≤ ~500 lines. The table expansion and
  the i18n labels for 82 new ids are the bulk; the Esc gating, the shield and the
  pane-focus model are the subtle parts.
- **Risk — stealing terminal keys.** Any capture-phase shield takes a chord from xterm
  for good. Mitigated: only five actions are shielded (`pane.focusNext`,
  `pane.focusPrev`, `terminal.toggle`, `nav.back`, `nav.forward`); F6 has no common TUI use; `terminal.toggle`
  is unbound; the pane hint names the hazard when a user binds a shielded action to a
  Ctrl+letter.
- **Risk — Esc fights a takeover's own Esc.** One Esc must close one layer. Mitigated:
  the binding is disabled while any popover is open (popover state moves into the `ui`
  store), yields to text fields and to the `'modal'` scope, and every takeover-internal
  Esc handler that consumes Esc stops propagation, from a window capture listener the
  way dialogs already do (spec §6.1 lists them). Unit tests cannot see this listener
  ordering, so the Esc criteria also require a live check.
- **Risk — Linux menu accelerators are weaker than T1 assumed.** On Linux/Windows an
  Electron accelerator only fires for a key the page left unhandled, and xterm
  handles every Ctrl+letter. Mitigated for this card by choosing defaults xterm leaves
  alone; the broader correction to T1's "menu-backed fires over the terminal" claim
  is stated in the spec (§7.1) and left to a follow-up.
- **Risk — table bloat in the native menu.** New actions are `menu: false` unless the
  spec names a menu item; only one native item is added (`view.settings.keybindings`).
