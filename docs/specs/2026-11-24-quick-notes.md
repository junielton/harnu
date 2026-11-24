# Quick notes: a daily scratch note per repo, one shortcut away

- **Date:** 2026-11-24
- **Status:** approved by the operator on 2026-11-24 (builder check done, answers folded in)

## 1. Intent

The operator keeps reaching for VSCode to jot quick notes, saving them to the Desktop or
Downloads, or not saving them at all because they will be used again soon. Harnu should own
that scratch space: one shortcut opens today's note for the current repo, ready to type, in
the same editor pane Harnu already uses for `.md` files; another opens a picker over every
note the repo has. Notes live with the repo's other Harnu data instead of loose on the
Desktop.

Success: the operator starts typing a note without thinking about where it goes, saves with
⌘S / Ctrl+S, and finds any earlier note in a couple of keystrokes from any worktree of the
repo. Nothing typed is lost silently: closing a pane or quitting the app with unsaved edits
always asks first.

## 2. Goals

- **G1. Write today's note.** Command `notes.openToday` (default `Cmd+Shift+N` /
  `Ctrl+Shift+N`; also a Topbar button and a command-palette entry) opens
  `<main checkout>/.harnu/notes/YYYY-MM-DD.md` for the selected folder, in that folder's
  helper stack, in edit mode with the cursor at the end, so the operator can type at once.
- **G2. One file per day.** Opening on a day whose file exists reopens it (content untouched).
  Opening on a new day creates a new file whose content is exactly `# YYYY-MM-DD Notes\n\n`.
  The date is the operator's **local** date.
- **G2b. Reachable everywhere, rebindable.** Both commands have default shortcuts that the
  operator can change in **Settings → Keybindings**, and both are in the sidebar folder's
  right-click menu.
- **G3. Find any note.** Command `notes.open` (default `Cmd+Alt+N` / `Ctrl+Alt+N`; also in the
  Topbar button's menu and the command palette) opens a dialog listing every note of the
  repo, newest first, with a search input focused on open. Typing filters the list by date
  (substring of the file name, so `11-2`, `2026-11` or `24` all work). ↑/↓ move the
  selection, Enter opens it, a click opens it, Esc closes. Today is always the first row,
  even before its file exists (choosing it behaves like G1). Opening a note puts it in the
  current folder's helper stack in edit mode.
- **G4. Repo-scoped storage.** Notes go to the repo's MAIN checkout, resolved with
  `mainCheckoutRoot()` (`src/main/data-dir.ts`), so every worktree of a repo shares one notes
  folder, as memory and missions do. A folder that is not a git repo uses its own
  `.harnu/notes/`.
- **G5. Explicit save, guarded close.** Saving stays ⌘S / Ctrl+S (the existing
  `MarkdownPane` model). An operator closing ANY markdown pane with unsaved edits gets a modal
  dialog (built on `ui/Dialog.vue`): "Unsaved changes in `<file name>`" with **Save**,
  **Don't save** and **Cancel** (default: Save; Esc: Cancel). This replaces the current
  non-blocking toast for the close path only.
- **G6. Guarded quit.** Quitting Harnu (⌘Q / Ctrl+Q, the app menu, the window's X) while any
  markdown pane in any folder has unsaved edits asks first, naming the files.

## 3. Non-goals

- No autosave (the operator chose explicit save).
- No full-text search inside notes in v1; the picker filters by date only.
- No deleting or renaming notes from the picker in v1.
- No new MCP verb. Agents reach a note only as an ordinary file through `open_file`.
- No global (cross-repo) notes, no sync, no git integration.
- No change to the reload / relative-link navigation guards; they keep the toast.

## 4. Anti-goals

- A note silently lost on close or quit. Every operator exit path with a dirty buffer asks.
- Overwriting an existing day's note when opening it: the header is written only when the
  file does not exist, using an exclusive create (`wx`); `EEXIST` means "open it".
- Writing notes into a linked worktree instead of the main checkout (they would vanish when
  the worktree is cleaned).
- A broad loosening of the markdown read/write root confinement. The one addition (§6.2) is
  a narrow, derived rule.
- A blocking modal popping up because an agent or a background cascade did something.

## 5. Constraints

- `.harnu/` is not guaranteed to be gitignored in every repo (it is in Harnu's own). v1 does
  not edit the operator's `.gitignore`.
- `markdown:read` / `markdown:write` / `markdown:watch` only accept paths inside known Harnu
  roots; a worktree's main checkout may not be a known root.
- Markdown panes are persisted (`helpers.json`) and restored on boot, so a note pane must keep
  working after a restart without the operator pressing a shortcut again.
- The Explorer (Browse files) is confined to the active folder, so it cannot reach the main
  checkout's notes from a worktree; hence the picker (G3).
- The quit guard (`src/main/quit-confirm.ts`, T579) decides synchronously in `before-quit` /
  window `close`. A quit with nothing dirty and no agent mid-turn must stay instant.
- New keys go to both `en.json` and `pt-BR.json`; any new token/size goes to `design.md`
  first; a CHANGELOG entry and a `docs/user/` page are required. The §6.5 router refusal is
  internal (no MCP verb reaches it), so `docs/harnu-features.md` does not change.

## 6. Design

### 6.1 Approaches considered

Close/quit guard:

1. Modal dialog on close for every markdown pane.
2. The same dialog only for notes. Rejected: one action behaving two ways by file type.
3. **(Picked by the operator)** Option 1 plus a quit-time check across all dirty panes,
   closing the silent-loss gap on quit (drafts live only in renderer memory today).

Reaching past notes:

1. ‹ › day arrows in the note pane header. Rejected by the operator: one day at a time is too
   slow.
2. A "Notes" root in the Explorer. Rejected: more Explorer work, weaker for "jump to a day".
3. **(Picked by the operator)** A dedicated picker dialog with a focused search input and
   keyboard navigation (G3).

Opening/creating notes: a main-process IPC that resolves the root and creates the file
(picked), versus doing it in the renderer through `markdown:write` (rejected: the renderer
cannot resolve the main checkout and the write would hit the root gate).

### 6.2 Main process: `src/main/notes.ts`

Registered from `index.ts`, exposed in preload.

- `notes:list({ folder })` → `{ ok, notesDir, notes: [{ date, filePath }] }`, every
  `YYYY-MM-DD.md` in the notes dir (other files ignored), newest first. Missing dir = empty
  list.
- `notes:open({ folder, date })` → `{ ok, filePath, created }`. `date` is `YYYY-MM-DD`,
  validated strictly (the renderer supplies today's local date). Creates the dir
  (`mkdir -p`) and, when absent, the file with `# <date> Notes\n\n` via exclusive create.
  Opening a past date that has no file is refused (`not-found`); only today is created.
- Root: `mainCheckoutRoot(folder) ?? folder`, notes dir `dataDirAt(root)/notes`.
- **Gate rule (decided):** the markdown read/write/watch gate additionally admits a path
  that resolves to `<mainCheckoutRoot(r)>/.harnu/notes/<YYYY-MM-DD>.md` for some known root
  `r`, with no symlink at the file or the `notes` dir (reuse the `isExactPathSymlink`
  reasoning). It is computed from the rule on every call, not stored, so restored panes keep
  working after a restart. The MCP `open_file` validator does not take it (an agent can open
  a note only when its folder is itself a known root, as today).

### 6.3 Renderer: commands, button, picker

- **Keybindings.** Both commands are registered with `def()` in
  `src/main/keybindings-core.ts`, so they show up in **Settings → Keybindings** with their
  defaults and can be rebound there (or in `keybindings.json`) like every other command;
  the Topbar tooltip and the menus show the CURRENT binding, not the default.
- **Folder context menu.** `FolderMenu.vue` (right-click on a folder in the sidebar) gains a
  "Notes" group with **New note for today** (`notes.openToday`) and **All notes…**
  (`notes.open`), each showing its current shortcut. They act on the right-clicked folder,
  not the selected one: the folder is selected first, then the note opens in its helper
  stack (the picker lists that folder's repo notes).
- `notes.openToday`: needs a selected folder (none → toast steering to pick one). Calls
  `notes:open` with today's local date, then
  `helpers.addMarkdownHelper(worktreePath, filePath, cwd, { initialMode: 'edit' })`. The
  existing dedup by `filePath` reveals an already-open pane instead of stacking another.
  The textarea gets focus with the caret at the end.
- `notes.open`: opens `NotesPickerDialog.vue` (on `ui/Dialog.vue`; follow the keyboard model
  of `SidebarJumpPalette.vue` / `CommandPalette.vue`). Rows show the date and a relative hint
  ("today", "yesterday", weekday). Empty filter result shows an empty-state line. Choosing a
  row opens it like `notes.openToday` but with that note's path.
- Topbar: one notebook-icon button beside **Browse files**. Click = `notes.openToday`; its
  tooltip names both shortcuts; a secondary affordance (split chevron or right-click menu,
  builder's choice within `design.md`) offers "All notes…" = `notes.open`.
- Panes always open in the CURRENT folder's helper stack, even though the file lives in the
  main checkout. A pane left open past midnight keeps its file.

### 6.4 Renderer: operator close dialog (all markdown panes)

- `MarkdownPane.onClose` with `dirty` opens `UnsavedChangesDialog.vue`: Save → run the
  existing save, close only if the write succeeded (a failed save keeps the pane open and
  shows the existing error); Don't save → current discard path; Cancel → nothing.
- Every OPERATOR-initiated close of a markdown pane routes through this guard (pane X,
  ⌘W when it targets the pane, closing the helper stack). The builder inventories those
  paths.

### 6.5 Closes the operator did not start (decided)

- **Router close** (`pane.closeFile` / `pane.closePane`, i.e. `closeHelperByPath` /
  `closeHelperById`, on a dirty markdown pane): refused with the error code
  `UNSAVED_CHANGES` (pane stays, no modal). `close_file` is a dormant router op with no MCP
  verb in `src/main/mcp/tool-catalog.ts`, so this refusal is internal: no agent-facing ACK
  changes and `docs/harnu-features.md` does not change.
- **Cascades** (worktree removal via `dropWorktreeFromMemory`, `remove_folder` of a folder
  already gone from disk): discard silently. The folder is gone, so the operator has no stack
  to return to; a note's file itself lives in the main checkout and keeps its last save.

### 6.6 Quit guard (decided: push model)

- The renderer pushes the set of dirty markdown panes (`{ fileName, folder }[]`) to main
  whenever it changes (one IPC, debounced lightly). Main keeps it in memory.
- `decideQuitConfirm` gains the dirty list as an input and stays synchronous. A quit with no
  dirty pane and no agent mid-turn stays instant.
- With dirty panes the guard always prompts, **even when `confirmOnQuit` is off** (that
  preference is about agents, not data loss), and the "don't ask again" checkbox is hidden
  for this case.
- One combined native dialog naming the unsaved files (and the working agents, if any, even
  when `confirmOnQuit` is off: "Quit without saving" interrupts them too).
  Buttons: **Cancel** (default) and **Quit without saving**.
- A renderer that died before pushing means an empty list: the guard falls back to today's
  agent-only behavior, so a quit is never stuck.

## 7. Left to the builder

- The exact icon, the split-button vs menu affordance, and the `design.md` §6 entries for the
  picker, the close dialog and the Topbar button.
- How the dirty registry is exposed (store vs module map) and how operator close paths are
  found.
- Test layout: unit tests for date validation, header, exclusive create, list ordering, root
  resolution and the gate rule in main; component tests for the picker (filter, arrows,
  Enter) and the close dialog; a unit test for the quit decision.
- Copy wording within `design.md` §8 rules, in `en` and `pt-BR`.

## 8. Calls made by Claude (operator may override)

- Shortcuts: `Cmd/Ctrl+Shift+N` (today's note) and `Cmd/Ctrl+Alt+N` (picker); both free in
  the keybinding table.
- The day's file is created on disk when first opened (header only), so reopening always
  finds it, at the cost of a header-only file on days the note stays empty.
- Local date, `YYYY-MM-DD.md` file names; the picker filters by date only.
- No `.gitignore` editing.
- Quit dialog offers Cancel / Quit without saving only; "Save all and quit" (a renderer save
  round-trip during quit) is deferred.
- The folder right-click menu selects the folder before opening its note.
- Notes gate rule derived per call (§6.2); agent close of a dirty pane refused with
  `UNSAVED_CHANGES`; cascades discard (§6.5); quit uses the push model (§6.6).
