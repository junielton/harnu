# Quick notes

Quick notes are a scratch note for today, one shortcut away. Press a key, start typing, press `Cmd/Ctrl+S`. No file dialog, no deciding where it goes, and no more notes saved to the Desktop or left unsaved in another editor.

A note is a plain Markdown file that opens in the same editor pane Harnu uses for any `.md` file, in edit mode with the cursor at the end, so you can type right away.

## Today's note

Press `Cmd+Shift+N` (`Ctrl+Shift+N` on Linux and Windows) to open today's note for the folder you have selected. You can also:

- click the **notebook** button in the Topbar, next to **Browse files**;
- right-click a folder in the sidebar and choose **Notes → New note for today**;
- pick **New note for today** from the command palette, or from the **Folder** menu.

The shortcut works even while a terminal has focus.

What happens:

- There is **one file per day**, named for your **local** date: `YYYY-MM-DD.md`.
- The first time you open a day, Harnu creates the file with the header `# YYYY-MM-DD Notes` and a blank line, and puts the cursor under it.
- Opening it again later the same day reopens the same file. Nothing you wrote is touched.
- With no folder selected, you get a warning toast asking you to select one first.

## Where notes live

Notes are stored with the rest of the repo's Harnu data, under `.harnu/notes/` in the repo's **main checkout**:

```
<main checkout>/.harnu/notes/2026-11-24.md
```

Every worktree of a repo shares that one folder, so a note you start in one worktree is there from every other worktree, and it does not vanish when a worktree is cleaned up. A folder that is not a git repository keeps its notes in its own `.harnu/notes/`.

Harnu adds its data folder to the repo's `.git/info/exclude`, so notes do not show up as untracked files in `git status`. Harnu does not edit your `.gitignore`.

## All notes

Press `Cmd+Alt+N` (`Ctrl+Alt+N`) to open the notes picker. It is also on the Topbar notebook button (**right-click** it), in the folder right-click menu as **Notes → All notes…**, in the **Folder** menu and in the command palette.

- The list shows every note of the repo, newest first. **Today** is always the first row, even before its file exists; choosing it creates it, exactly like the shortcut above.
- The search box is focused when the picker opens. Typing filters by date: `11-2`, `2026-11` and `24` all work. It does not search inside notes.
- `Up` and `Down` move the selection, `Enter` or a click opens the note, and `Esc` closes the picker.
- Opening a note puts it in the current folder's split stack, in edit mode.

## Changing the shortcuts

Both actions appear in **Settings → Keyboard Shortcuts** as **New note for today** and **All notes…**, so you can rebind or unbind them like any other action (see [Settings](settings.md#keyboard-shortcuts)). The Topbar tooltips and the menus always show your current binding.

## Browse files cannot reach your notes from a worktree

**Browse files** only shows the folder you are in. From a linked worktree, it cannot reach the main checkout's `.harnu/notes/`. Use the picker instead: it finds the notes of the whole repo from any worktree.

## Unsaved changes are never dropped silently

Saving is explicit: `Cmd/Ctrl+S`. There is no autosave. To make sure nothing is lost:

- **Closing a Markdown pane with unsaved edits** asks first. This applies to every Markdown pane, not only notes. The dialog offers **Save**, **Don't save** and **Cancel**. If the save fails, the pane stays open with your text. Reloading the file or following a link inside it keeps its existing non-blocking toast instead of a dialog.
- **Quitting Harnu** while any Markdown pane in any folder has unsaved edits shows a native prompt that names the files. Its buttons are **Cancel** and **Quit without saving**. It appears even if you turned off the confirm-on-quit setting, and it has no "Don't ask again" checkbox, because losing work is not a preference. If agents are also working, the same prompt lists them below the files, even with confirm-on-quit off, because quitting interrupts them too. See [Quitting Harnu](sessions.md#quitting-harnu).
- **Opening a fifth Markdown pane** recycles the oldest pane that has no unsaved edits. A pane with unsaved edits is never recycled; the stack grows instead.
- A session cannot close a pane that has unsaved edits; the request is refused and the pane stays open.

## What is not there yet

- No autosave.
- No search inside notes, only by date.
- No delete or rename from the picker.
- No notes shared across repos.
- Agents have no dedicated notes command. A session can open a note like any other file once its folder is one Harnu knows.
