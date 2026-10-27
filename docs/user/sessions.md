# Sessions

A session is one Claude Code conversation, backed by a real `claude` process and its transcript on disk. This page covers starting, resuming, and forking sessions, the terminal pane they run in, splitting your view, and the shortcuts that make moving between them fast.

## New, resume, and fork

There are three ways a session comes into existence, and they behave differently:

- **New session** — the **+** on a folder row (or `Cmd/Ctrl+N`) starts a brand-new `claude` process in that folder with no history. Only one "new session in progress" placeholder is allowed per folder at a time.
- **Resume** — clicking any past session row spawns `claude --resume <id>` in its original working directory, restoring the full conversation from the on-disk transcript. This is what you're doing every time you click a session that already exists.
- **Fork** — right-click a session and choose **Fork** to spawn `claude --resume <id> --fork-session`. This loads the source session's entire history but immediately diverges into a new, independent session id — the original is untouched. Unlike New session, forking doesn't dedupe, so you can stack as many forks off one session as you want. You can't fork a session that hasn't started yet (a still-booting "new session" placeholder).

Every session row carries a status dot so you can tell what's going on without opening it: **green** (pulsing) means Claude is actively working, **amber** means it's waiting on you (a question, or an approval), **red** means it failed or has gone quiet mid-task ("stuck"), **gray** is idle, and a **checkmark** means it finished. A session that's been quiet a while may also get parked to reclaim memory — see "Hibernated sessions" below.

A session whose own turn has ended but whose background **subagent** is still running keeps the green "working" dot until the last subagent finishes (once the Harnu mod's task state switch is on; see [Troubleshooting](troubleshooting.md#a-sessions-dot-stays-working-or-needs-input-after-it-stopped)). Background shell commands and monitors do not hold it.

## The terminal pane

Each session's terminal is a real xterm.js terminal, not a log viewer — it behaves like the terminal you already know:

- **Scrollback** holds the last 10,000 lines.
- URLs in the output are clickable links.
- Terminal graphics (Sixel / iTerm inline images, e.g. from tools that render charts or screenshots to the terminal) render inline.
- Drag a file or folder from your OS file manager onto the terminal to insert its absolute path at the cursor — handy for pointing Claude at something without typing the path.
- Copy/paste, font size, and line editing have their own shortcuts — see [Terminal shortcuts](#terminal-shortcuts) below.

Switching away from a session doesn't stop it. Claude keeps working, output keeps streaming, and scrollback keeps filling in the background — switching tabs only detaches the view, it never tears down the process. The terminal (and any background process it's running, like a dev server) only actually stops if you explicitly restart or delete the session, or quit Harnu.

### Pasted screenshots

When you paste a screenshot into a session, Claude Code saves it into a hidden per-session cache (the system temp folder for current Claude Code versions, `~/.claude/image-cache/` for older ones — Harnu reads both). Harnu surfaces that cache as a small `🖼 N` pill in the footer — it only appears when the session actually has images, and the count updates live, so pasting a screenshot into the session you're looking at makes the pill react without switching away and back. When a new screenshot lands, the pill gives a brief pop so you notice it registered; it stays quiet when you merely switch to a session that already has images, and on the very first image (the pill fading in is signal enough).

Click the pill for a grid of the session's screenshots, newest first. Hovering a thumbnail offers four actions — **Open** (in your OS image viewer), **Reveal in folder**, **Copy** (to the clipboard), and **Re-attach** (writes the image's path back into the running session so Claude picks it up again as an attachment; it needs a live session, so it's greyed out otherwise).

Clicking the thumbnail itself opens the image full size, filling the window. From there you can step through the session's screenshots with the on-screen arrows or the `←` / `→` keys (they wrap around), jump straight to any image from the strip along the bottom, and use those same four actions on whichever image you're looking at. `Esc`, a click on the dark backdrop, the close button, or Re-attach all take you back to the plain footer.

This gallery is **read-only and temporary**: Harnu only shows what's on disk right now and never writes to either cache, so images disappear when Claude Code prunes the session. If you want to keep one, use **Reveal in folder** or **Copy**.

### Hibernated sessions

Harnu caps how many `claude` processes it keeps alive at once (each one holds real memory). When a session has been idle for a while and you're over that cap, Harnu quietly kills its process to free memory — this is called **hibernating** a session. Nothing is lost: the conversation is intact on disk, and clicking the session's row respawns it exactly like a normal resume. A hibernated session just briefly shows no live status until you reopen it.

### Cloud sessions and "Resume anyway"

Some sessions have no conversation on your disk to resume — their transcript lives on claude.ai (a Remote Control / cloud session). Selecting one shows a quiet **"This session lives in the cloud"** panel instead of a terminal, because running `claude --resume` on it would only print "No conversation found".

Harnu only shows that panel when it is sure: the transcript must hold no conversation, be linked to claude.ai, and have been left untouched for over a minute. A session you have just opened in Harnu never lands there — its terminal is alive, and a brand-new transcript that simply hasn't recorded your first prompt yet is treated as a normal session.

If the panel ever shows for a session you want to open, press **Resume anyway**. The terminal opens and runs `claude --resume` regardless, so you see exactly what Claude Code says — including its error, if there is one. The choice lasts until you quit Harnu. If the transcript later gains a conversation, the panel gives way to the terminal on its own.

## Jump from the transcript to a file

When Claude mentions a file — `src/main/pty.ts`, or `src/main/pty.ts:42` — you
can jump straight to it. Hold **Option** (**Alt** on Windows and Linux) or
**Ctrl** and the paths under your pointer become clickable; click one and Harnu
opens the **Browse files** pane, expands the folders down to that file,
highlights it, and opens it in a viewer pane. Clicking a folder this way reveals
and expands it instead. It works the same in the helper-pane terminals next to a
session. (On a Mac, Ctrl+click is the system right-click, so use Option there.)

Nothing underlines until you hold the modifier, so it stays out of your way while
you read. A path is only clickable when it actually exists inside the project
folder and isn't ignored by `.gitignore` — the file tree can't show those
either, so Harnu doesn't pretend they're reachable. The one exception is
Harnu's own **`.harnu/`** folder: even though it's usually gitignored, it shows
up in Browse files and its paths are clickable, because that's where agents put
the reports and diagrams they hand you (for example
`.harnu/out/roadmap-notes.md`). Everything else that's gitignored — `node_modules`,
build output — stays hidden. Links to web addresses behave as before. A bare filename with no folder in it
(just `pty.ts`) isn't clickable, because there's no way to tell which one it
means.

## The right-click menu

Right-click any session row for:

- **Rename**, **Fork**, **Restart session** (kills and respawns the same session in place), **Open in new tab** (resumes this session into a new split next to your current pane, without leaving the one you're on)
- Copy actions: session ID, transcript path, the `claude --resume` command, or a context digest
- Per-session toggles: **No flicker**, **Remote Control** (bridges the session to your phone), **Promote/Demote Orchestrator** (see below)
- **Archive** (reversible, just hides it from the default view) and **Delete** (destructive — asks for confirmation, removes the transcript from disk)

From the keyboard, `Shift+F10` opens the same menu for the row under the sidebar's keyboard cursor (or, with no cursor, the selected session; with no session, the active folder's menu), anchored at that row, with its first item focused — arrow keys and Enter take it from there. On a repo group row it does nothing: the group's menu can't be opened from the keyboard yet, but its three actions (rename, reset name, clean up) are commands you can bind — see [Shortcuts](#shortcuts). On a Mac keyboard press `Fn+Shift+F10`, unless you set the F-keys to act as standard function keys.

`F2` renames a folder: with the keyboard cursor on a folder row it opens **Rename folder** for that folder; with no cursor row, it renames the active folder. On a session row or a repo group row it does nothing — rename a session with `Cmd/Ctrl+R`. On most Mac keyboards `F2` is the brightness key, so press `Fn+F2` unless you set the F-keys to act as standard function keys. (VS Code on macOS renames with Enter; in Harnu, Enter opens the cursor row, so rename stays on `F2` on every platform.)

### Promoting a session to Orchestrator

Any session can be promoted to **Orchestrator** from this menu. Promoting arms a guard that blocks the session from editing files directly outside its own memory/scratch area, and gives it a coordinator-focused system prompt — the idea being it plans and delegates work to other sessions or subagents instead of touching your code itself. A promoted session is marked with a badge on its row and a pill in the topbar. You always have to promote it manually from this menu to get the coordinator system prompt — but the guard half can also be armed live, mid-conversation, by a session Harnu spawned for agent work (on itself or on another such session); a session you opened by hand can't arm it on itself.

## Splits

The area to the right of your main terminal can hold a vertical stack of extra panes — a "split" — so you can keep a file, a shell, or another session visible alongside the one you're focused on. Panes you can open:

- A plain **shell** (Topbar's Split button)
- A **file browser** (Topbar's browse-files button), and clicking a file in it opens that file in a **Markdown viewer** pane. Every code block in that viewer has a hover-revealed copy button, and the pane's toolbar has a "Copy file" button that copies the whole raw file — no more hand-selecting text out of the pane
- A folder's **Project memory** pane (from the folder's right-click menu)
- Another session, resumed as its own pane (a session's **Open in new tab** action)

Drag a pane's header to resize it. Split panes follow the same rule as the main terminal — a shell running in a split (say, `npm run dev`) keeps running in the background even if you switch to a different worktree or session. Every pane's header also has a maximize button: click it to grow that pane to fill the split while the others collapse to a thin header strip (still running in the background); click it again, or a different pane's maximize button, to restore or switch.

### Moving between panes from the keyboard

- `F6` moves focus to the next pane: the main terminal, then each split pane from top to bottom, then back to the main terminal. `Shift+F6` goes the other way. Both work while a terminal has focus, so the program running there no longer receives `F6`. A collapsed split, and the panes hidden behind a maximized one, are skipped; when a view such as the Roadmap covers the main terminal, only the split panes are visited. With a dialog, the command palette or a menu open, they do nothing. On most Mac keyboards press `Fn+F6` and `Fn+Shift+F6`.
- A Markdown, Memory, file-browser or canvas pane shows a thin accent outline while it has focus. Terminal panes don't: their cursor already tells you.
- `Cmd/Ctrl+Shift+M` maximizes the focused split pane, or restores it if it's already maximized. With no split pane focused, it restores whichever pane is maximized.
- **Close the focused pane** has no shortcut out of the box (command id `pane.close`). Once you bind one, it closes the pane that has focus exactly like its header's close button: a Markdown or canvas pane with unsaved changes still asks before discarding them. Focus then moves to the next pane.

### The terminal toggle

**Toggle the terminal pane** (command id `terminal.toggle`) has no shortcut out of the box. Once you bind one, each press does one of three things in the current folder:

1. No shell pane in the split → it opens one.
2. A shell pane exists but doesn't have focus → it shows the split (if you had collapsed it), restores a maximized pane so the shell is visible, and focuses the shell. If a view such as Cleanup or the usage overview covers the screen, it closes that view first; the Roadmap and Review stay open, since the split sits beside them.
3. The shell pane already has focus → it collapses the whole split panel and puts focus back on the main terminal.

It always reuses the first shell pane in the split. Split → **New shell** still adds another shell every time. A terminal an agent opened is never taken by the toggle (you can still reach it with F6): if the only shells in the split belong to agents, the toggle opens a new one for you.

The toggle's chord is taken from every terminal before the program sees it, so it works from inside the shell pane (that's how the third press collapses it). That also means the chord never reaches any program running in a terminal. **Pick a chord no terminal program needs:**

- **Don't bind `Ctrl+J`.** `Ctrl+J` is LF, the line-feed character. In Claude Code it inserts a newline; in bash and zsh it runs the command, like Enter; in vim's insert mode it starts a new line. Bound to the toggle, it stops doing all of that in every terminal. (`Shift+Enter` still sends a newline to Claude Code.) The same goes for `Cmd+J` on Linux and Windows, where `Cmd` means `Ctrl`.
- **``Ctrl+` ``** (Control and the backquote key) is safe on every platform: terminals send nothing for it. Harnu matches the physical key, so on a non-US layout it's the key where the backquote sits on a US keyboard, left of `1`. In `keybindings.json` write it as ``"key": "Ctrl+`"`` — Control, also on a Mac. Don't write ``Cmd+` ``: on macOS, ``⌘` `` moves focus to your next window and never reaches Harnu.
- On macOS, `Cmd+J` is also safe: terminals ignore `⌘J`.

## The command palette

`Cmd/Ctrl+K` opens a spotlight-style search over your recent sessions, folders, and every action Harnu has a command for. It's the fastest way to jump around once you have more than a couple of folders pinned. Empty, it shows your most recent sessions, a short list of everyday actions (new session, add folder, resume your last session, toggle the Approval Inbox rail, open approvals), then your folders and sessions. As you type it fuzzy-matches folders by name, sessions by their summary or first prompt, and actions by name — every action listed in Settings → Keyboard Shortcuts, including the ones with no shortcut yet (type "rename", "fork", "close the open view"). An action only appears when it can run right now: "Restart the session" needs a selected session, "Close the open view" needs an open view. Each action row shows its shortcut on the right, and follows your rebinds. Choosing an action runs exactly what its shortcut or menu item runs. Most actions work on the selected session or the active folder; a few follow the sidebar's keyboard cursor first, just like their shortcut: "Rename the folder…" renames the folder row the cursor is on, "Open the session to the side" opens the session row the cursor is on, and the repo-group actions ("Rename group", "Reset name (group)", "Cleanup… (repo)") work on the group row the cursor is on. With the cursor on no such row, they fall back to the active folder, the selected session, or the active folder's group. A few actions are never listed: opening the palette itself, the sidebar's arrow-key cursor, the keyboard context menu (`Shift+F10`), the Fleet rail shortcut (`Cmd/Ctrl+Shift+B`, which does the same as toggling the Approval Inbox rail), the pane actions that act on whichever pane has focus (`F6`, `Shift+F6`, maximize and close the focused pane), since the palette holds focus while it is open, and the app commands the system handles itself (reload, developer tools, quit, full screen). Arrow keys move the selection, Enter activates it, Esc closes it.

## Going back and forward

Harnu remembers the sessions you viewed, like a browser's history. Press the mouse's **back** side button, or `Alt+←` (`Cmd+[` on macOS), to return to the session you were just in; the **forward** side button, or `Alt+→` (`Cmd+]` on macOS), goes the other way after a Back. It works whether or not the terminal has focus, and the side-button clicks never reach the running program. Both keys can be rebound (command ids `nav.back` and `nav.forward`); whatever chord they hold gets the same treatment.

- Opening a session after going back clears the forward history, exactly like following a new link in a browser.
- Only sessions are in the history. If you're on a folder's Folder View or a takeover (Board, PR Stack, Cleanup, Usage Dashboard, System Monitor), the first Back takes you to the session you left.
- Sessions you closed or deleted are skipped. At either end, the key or button simply does nothing.
- A parked (hibernated) session resumes when you land on it, like clicking its row.
- Nothing navigates while a dialog or the command palette is open.
- The history lives in memory: it holds your last 50 sessions and starts empty after a restart.

> **Trade-off:** the Back / Forward chords are taken from the terminal before it sees them, so `Alt+←` / `Alt+→` no longer reach the program running there (where they would jump a word left/right). `Ctrl+←` / `Ctrl+→` usually do the same word jump and are unaffected. Settings → Keyboard Shortcuts says so under the two rows ("Taken from the terminal: …"). On Linux and Windows the Alt release does not open the menu bar.
>
> **Only verified on Linux.** macOS and Windows haven't been tested live yet. On Windows, a mouse driver that sends the side buttons only as system "browser back/forward" commands won't navigate (the keyboard still will); on macOS, a mouse whose side buttons aren't exposed as standard back/forward buttons relies on its vendor tool mapping them to `Cmd+[` / `Cmd+]`.

## Shortcuts

Harnu shows each shortcut in your platform's notation — `⌘⇧P` on macOS,
`Ctrl+Shift+P` on Linux and Windows. `Cmd` and `Ctrl` are the same key here:
a binding written as `Cmd+K` is `⌘K` on a Mac and `Ctrl+K` elsewhere.

| Shortcut           | Action                                                                          |
| ------------------ | ------------------------------------------------------------------------------- |
| `Cmd/Ctrl+N`       | New session                                                                     |
| `Cmd/Ctrl+K`       | Open command palette                                                            |
| `Cmd/Ctrl+O`       | Add folder                                                                      |
| `Cmd/Ctrl+,`       | Open Settings                                                                   |
| `Cmd/Ctrl+Alt+S`   | Open Settings on the Keyboard Shortcuts tab                                     |
| `Esc`              | Close the open view (Roadmap, PR Stack, Cleanup, …) — one layer at a time       |
| `Cmd/Ctrl+R`       | Rename the selected session                                                     |
| `Cmd/Ctrl+Shift+R` | Resume your most-recently-modified session                                      |
| `Cmd/Ctrl+W`       | Close/deselect the current session tab                                          |
| `Cmd/Ctrl+B`       | Toggle the left sidebar                                                         |
| `Cmd/Ctrl+Alt+B`   | Toggle the right split panel                                                    |
| `Cmd/Ctrl+Shift+A` | Toggle the Approval Inbox rail                                                  |
| `Cmd/Ctrl+Shift+B` | Toggle the Fleet rail                                                           |
| `Cmd/Ctrl+Shift+D` | Review the active folder's branch                                               |
| `Cmd/Ctrl+Shift+P` | Switch project (currently opens the command palette)                            |
| `Cmd/Ctrl+Shift+F` | Jump to a folder or session (press again to close)                              |
| `Cmd/Ctrl+Enter`   | Open the cursor session (or the selected one) in a split beside the current one |
| `Shift+F10`        | Open the right-click menu for the cursor row (`Fn+Shift+F10` on a Mac)          |
| `F2`               | Rename the cursor folder row, or the active folder (`Fn+F2` on a Mac)           |
| `F6` / `Shift+F6`  | Focus the next / previous pane, even from a terminal (`Fn+F6` on a Mac)         |
| `Cmd/Ctrl+Shift+M` | Maximize or restore the focused split pane                                      |
| `Alt+←` / `Cmd+[`  | Back to the previous session you viewed                                         |
| `Alt+→` / `Cmd+]`  | Forward again after going back                                                  |
| Arrow keys / Enter | Move and activate the keyboard cursor in the sidebar                            |

The Topbar's folder actions — roadmap board, PR Stack, open in file manager,
open in your [editor](settings.md#editor), pull requests on GitHub, Browse files, and open a terminal —
have no shortcut out of the box, and neither does the usage overview, but you
can give each one a chord (see
[Customizing shortcuts](#customizing-shortcuts)). They're also in the native
**Folder** menu, so a chord you bind works even while the terminal has focus.

Every item of the session right-click menu, closing a folder terminal, the
**+** that starts a new session in the active folder, and the sidebar header's
buttons (rescan, drill depth, collapse all, hidden folders) can be given a
shortcut too; none has one out of the box. Their command ids are
`session.newInFolder`, `session.fork`, `session.restart`, `session.copyId`,
`session.copyTranscriptPath`, `session.copyResumeCommand`,
`session.copyContextDigest`, `session.toggleNoFlicker`, `session.toggleArchived`,
`session.delete`, `session.retryBoot`, `session.dismiss`, `session.closeTerminal`,
`sidebar.rescan`, `sidebar.cycleDrillDepth`, `sidebar.toggleCollapseAll` and
`sidebar.hiddenFolders`. A session action works on the **selected** session and
only when the right-click menu would offer it there (no Fork on a session that is
still starting, for example). Remote Control and Promote to Orchestrator stay
click-only on purpose: they show a disclosure you should read first.

The folder right-click menu works the same way. Its items, the folder row's
**Show older** / **Show archived** toggles and the repo group menu have these
command ids, all without a shortcut except `folder.rename` (`F2`):
`folder.rename`, `folder.newFolderTerminal`, `folder.toggleBranchAlias`,
`folder.bootOptions`, `folder.projectMemory`, `folder.memoryLocation`,
`folder.newSubfolder`, `folder.openSubfolder`, `folder.newWorktree`,
`folder.worktreeMd`, `folder.askAgentWorktreeMd`, `folder.toggleIntercept`,
`folder.toggleAutoOrganize`, `folder.toggleOrchestratorDefault`,
`folder.toggleHidden`, `folder.removeWorktree`, `folder.toggleOlder`,
`folder.toggleArchived`, `repoGroup.rename`, `repoGroup.resetName` and
`repoGroup.cleanup`. A folder action works on the **active** folder (only
`folder.rename` follows the keyboard cursor first) and only when the menu would
offer it there — New worktree only in a git repo, Remove worktree only on a
linked worktree, which still asks before removing anything. A repo group action
works on the group under the keyboard cursor, or else the group the active folder
belongs to. Blocking agents, letting agents read terminals, **Modes** and the
parent-folder pick stay click-only: the first two change what agents may do, the
others need you to pick from a list.

The Fleet rail's header buttons and the popovers in the Topbar and the footer
can be given a shortcut as well, again with none out of the box:
`inbox.open` (Open approvals — expands the rail, whether it was minimized or
hidden), `inbox.toggleOrder` (flip the rail's newest-first / oldest-first
order), `inbox.filter` (the **Filter states** popover), `inbox.showAll` (**Show
all**, while a state is filtered out), `view.activity` (the Activity bell),
`view.missionProgress` (the mission's "Step N of M" pill), `view.pastedImages`
(the pasted-images pill), `view.claudeStatus` (the Claude service status dot)
and `view.usagePanel` (the plan-usage meters). Pressing a popover's shortcut
again closes it, and `Esc` closes it exactly as when you opened it with a
click. These shortcuts only work while their button is on screen — the
pasted-images pill shows only once the session has screenshots, the mission
pill only while the session has an open mission, the plan-usage meters only
while plan usage is available, and the order, filter and **Show all** buttons
only while the Fleet rail is expanded.

Every Settings tab has a command id too: `view.settings.general`,
`view.settings.keybindings`, `view.settings.appearance` and so on, one per tab in
the Settings sidebar ("Open Settings: General" in the shortcut list). Only
Keyboard Shortcuts has one out of the box, `Cmd/Ctrl+Alt+S`, also under
**View → Keyboard Shortcuts…** (on macOS, in the **Harnu** menu right after
**Settings…**). With Settings already open these shortcuts do nothing; switch
tabs from the sidebar. On some Windows keyboard layouts `Ctrl+Alt` acts as
`AltGr` and `Ctrl+Alt+S` types a character instead (a Polish layout types `ś`);
rebind it there if it doesn't open Settings. The footer's views have ids with no
shortcut out of the box: `view.cleanup`, `view.scheduler`, `view.systemMonitor`
and `view.containers`, each opening the view or closing it again, like its
footer button.

#### Closing a view with Esc

`Esc` closes whatever covers the session — the Roadmap board, PR Stack, Review,
Cleanup, the Scheduler, the System Monitor, Containers or the usage overview —
exactly like its **X**, including the review's side pane. It peels **one layer
per press**: a dialog, the command palette, a right-click menu or a footer /
Topbar popover open over the view closes first; then the view's own state —
Cleanup's selection, then its side panel, a PR Stack filter, the Roadmap's
dispatch confirm, a line selection in Review, or a selection on a canvas pane
beside the view; only the next
`Esc` closes the view. `Esc` typed in a text field stays with the field, and in
a terminal pane it goes to the program running there (Claude Code uses it to
cancel), so the view stays open. The command id is `view.closeTakeover`; you can
rebind it like any other.

`Cmd/Ctrl+Shift+F` opens the jump palette even while a terminal has focus, and
shows the sidebar first if you had collapsed it. The terminal sends nothing for a
`Cmd/Ctrl+Shift+letter` chord, so `Cmd/Ctrl+Shift+A`, `+Shift+B` and `+Shift+D`
also fire over it. `Cmd/Ctrl+Enter`, `Shift+F10`, `F2` and the sidebar arrow keys don't
fire while the terminal pane has keyboard focus — the terminal gets those keys. Shortcuts that act on the sidebar or on a
selection also leave a key you type in a text field alone.

The rest are bound in the native menu. On macOS they fire even while a terminal
has focus. On Linux and Windows the menu only gets a key the terminal didn't use,
so a `Ctrl+letter` chord (`Ctrl+N`, `Ctrl+B`, `Ctrl+W`, …) pressed in a terminal
goes to the program running there as a control character instead (`Ctrl+W`
deletes the previous word in a shell); click outside the terminal first, or use
the menu. `Ctrl+Shift+letter` chords are not affected. Back and Forward, `F6` /
`Shift+F6` and the terminal toggle are **shielded**: their chord is taken before
the terminal sees it, on every platform.

On Linux and Windows, if you bind `F6`, `Shift+F6` or the terminal toggle to an
`Alt` chord, the menu bar may appear when you release `Alt`. Back and Forward
don't have this problem: they are native menu items, so their `Alt` chord stays
with the menu.

A shortcut fires only with exactly its modifiers held: `F7` does not fire on
`Shift+F7`, and `Ctrl+K` does not fire on `Ctrl+Shift+K`.

On most Mac keyboards the F-keys (`F2`, `F6`, `Shift+F10`, …) need **Fn** held —
`F2` is brightness, `F6` Do Not Disturb, `F10` mute — unless you set "Use F1, F2, etc. keys as standard
function keys" in System Settings → Keyboard.

### Customizing shortcuts

Harnu reads shortcut overrides from a `keybindings.json` file kept in the same
folder as `settings.json` (Settings → the folder shown under "Settings file").
The file is optional — without it every shortcut uses the built-in default
above.

It's a VS Code-shaped array, one entry per action, merged over the defaults:

```jsonc
// Harnu keybindings — overrides merged over the built-in defaults.
[
  { "key": "Cmd+J", "command": "view.review" },
  { "key": "Cmd+Shift+K", "command": "app.search" },
  { "key": null, "command": "session.resumeLast" }, // unbind a default
  { "key": "Cmd+Shift+M", "command": "view.roadmap" } // bind an action with no default
]
```

The Topbar's folder actions have no default chord. Their command ids are
`view.roadmap`, `view.prStack`, `folder.openInFileManager`,
`folder.openInEditor`, `folder.openGithubPulls`, `folder.browseFiles`, and
`folder.newTerminal`. (`folder.openInEditor` used to be called `folder.openInVSCode`; a
binding saved under the old name still works.) The usage overview is `view.usageDashboard`, and Settings
(`Cmd/Ctrl+,` by default) is `view.settings`.

- `Cmd` means ⌘ on macOS and `Ctrl` on Linux/Windows — one file works on every
  platform. `//` and `/* */` comments are allowed.
- `"key": null` (or a `-` in front of the command) unbinds that action.
- Edits apply on save — no restart. The renderer-level shortcuts, the
  `⌘K`-style hints, and the native menu (File, View, …) all re-bind live. A
  malformed file is ignored with a toast and the defaults stay active, so you
  can't lock yourself out.
- A handful of actions are reserved and can't be rebound: quit, reload,
  toggle DevTools, toggle fullscreen, and "Open keybindings.json"
  (`Cmd/Ctrl+Alt+K`).
- [Back and forward](#going-back-and-forward) are `nav.back` and `nav.forward`.
  Their default depends on the platform — `Alt+Left` / `Alt+Right` on Linux and
  Windows, `Cmd+[` / `Cmd+]` on macOS — and an entry written on one platform
  loads unchanged on the other. A new chord moves both the **Session** menu
  item and the key the terminal no longer sees.
- Prefer not to edit JSON by hand? **Settings → Keyboard Shortcuts** is a
  point-and-click editor for this same file — see
  [Settings → Keyboard Shortcuts](settings.md#keyboard-shortcuts)
  (`Cmd/Ctrl+Alt+S`, or **View → Keyboard Shortcuts…**; on macOS, in the
  **Harnu** menu right after **Settings…**). To jump straight to
  the raw file, use **View → Open keybindings.json** or `Cmd/Ctrl+Alt+K` — it
  opens `keybindings.json` in a split-pane editor.

### Terminal shortcuts

These apply while a terminal pane has focus:

| Shortcut                     | Action                                         |
| ---------------------------- | ---------------------------------------------- |
| `Cmd+C` / `Ctrl+Shift+C`     | Copy selection                                 |
| `Cmd+V` / `Ctrl+Shift+V`     | Paste                                          |
| `Shift+Enter`                | Insert a soft newline without submitting       |
| `Ctrl+Backspace`             | Delete the previous word                       |
| `Cmd/Ctrl` + `=` / `-` / `0` | Increase / decrease / reset terminal font size |

The terminal keeps these chords (and `Shift+Backspace`) for itself. If you give an
app action one of them, it won't fire while a terminal has focus, and Settings →
Keyboard Shortcuts says so under that row ("The terminal keeps …").

> **Not built yet:** `Cmd/Ctrl+Shift+P` is wired to a "Switch project" action, but today it just reopens the plain command palette — a dedicated project-filter mode hasn't shipped yet.
