# Sessions

A session is one Claude Code conversation, backed by a real `claude` process and its transcript on disk. This page covers starting, resuming, and forking sessions, the terminal pane they run in, splitting your view, and the shortcuts that make moving between them fast.

## New, resume, and fork

There are three ways a session comes into existence, and they behave differently:

- **New session** — the **+** on a folder row (or `Cmd/Ctrl+N`) starts a brand-new `claude` process in that folder with no history. Only one "new session in progress" placeholder is allowed per folder at a time.
- **Resume** — clicking any past session row spawns `claude --resume <id>` in its original working directory, restoring the full conversation from the on-disk transcript. This is what you're doing every time you click a session that already exists.
- **Fork** — right-click a session and choose **Fork** to spawn `claude --resume <id> --fork-session`. This loads the source session's entire history but immediately diverges into a new, independent session id — the original is untouched. Unlike New session, forking doesn't dedupe, so you can stack as many forks off one session as you want. You can't fork a session that hasn't started yet (a still-booting "new session" placeholder).

Every session row carries a status dot so you can tell what's going on without opening it: **green** (pulsing) means Claude is actively working, **amber** means it's waiting on you (a question, or an approval), **red** means it failed or has gone quiet mid-task ("stuck"), **gray** is idle, and a **checkmark** means it finished. A session that's been quiet a while may also get parked to reclaim memory — see "Hibernated sessions" below.

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

## Jump from the transcript to a file

When Claude mentions a file — `src/main/pty.ts`, or `src/main/pty.ts:42` — you
can jump straight to it. Hold **Option** (**Alt** on Windows and Linux) and the
paths under your pointer become clickable; click one and Harnu opens the **Browse
files** pane, expands the folders down to that file, highlights it, and opens it
in a viewer pane. Option+clicking a folder reveals and expands it instead.

Nothing underlines until you hold Option, so it stays out of your way while you
read. A path is only clickable when it actually exists inside the project folder
and isn't ignored by `.gitignore` — the file tree can't show those either, so
Harnu doesn't pretend they're reachable. A bare filename with no folder in it
(just `pty.ts`) isn't clickable, because there's no way to tell which one it
means.

## The right-click menu

Right-click any session row for:

- **Rename**, **Fork**, **Restart session** (kills and respawns the same session in place), **Open in new tab** (resumes this session into a new split next to your current pane, without leaving the one you're on)
- Copy actions: session ID, transcript path, the `claude --resume` command, or a context digest
- Per-session toggles: **No flicker**, **Remote Control** (bridges the session to your phone), **Promote/Demote Orchestrator** (see below)
- **Archive** (reversible, just hides it from the default view) and **Delete** (destructive — asks for confirmation, removes the transcript from disk)

### Promoting a session to Orchestrator

Any session can be promoted to **Orchestrator** from this menu. Promoting arms a guard that blocks the session from editing files directly outside its own memory/scratch area, and gives it a coordinator-focused system prompt — the idea being it plans and delegates work to other sessions or subagents instead of touching your code itself. A promoted session is marked with a badge on its row and a pill in the topbar. You always have to promote it manually from this menu to get the coordinator system prompt — but the guard half can also be armed live, mid-conversation, by a session Harnu spawned for agent work (on itself or on another such session); a session you opened by hand can't arm it on itself.

## Splits

The area to the right of your main terminal can hold a vertical stack of extra panes — a "split" — so you can keep a file, a shell, or another session visible alongside the one you're focused on. Panes you can open:

- A plain **shell** (Topbar's Split button)
- A **file browser** (Topbar's browse-files button), and clicking a file in it opens that file in a **Markdown viewer** pane. Every code block in that viewer has a hover-revealed copy button, and the pane's toolbar has a "Copy file" button that copies the whole raw file — no more hand-selecting text out of the pane
- A folder's **Project memory** pane (from the folder's right-click menu)
- Another session, resumed as its own pane (a session's **Open in new tab** action)

Drag a pane's header to resize it. Split panes follow the same rule as the main terminal — a shell running in a split (say, `npm run dev`) keeps running in the background even if you switch to a different worktree or session. Every pane's header also has a maximize button: click it to grow that pane to fill the split while the others collapse to a thin header strip (still running in the background); click it again, or a different pane's maximize button, to restore or switch.

## The command palette

`Cmd/Ctrl+K` opens a spotlight-style search over your recent sessions, folders, and available actions. It's the fastest way to jump around once you have more than a couple of folders pinned. It shows your most recent sessions first, then fuzzy-matches everything else as you type — folders by name, sessions by their summary or first prompt, and a fixed set of actions (new session, add folder, resume your last session, toggle the Fleet rail, open the Approval Inbox). Arrow keys move the selection, Enter activates it, Esc closes it.

## Shortcuts

| Shortcut           | Action                                               |
| ------------------ | ---------------------------------------------------- |
| `Cmd/Ctrl+N`       | New session                                          |
| `Cmd/Ctrl+K`       | Open command palette                                 |
| `Cmd/Ctrl+O`       | Add folder                                           |
| `Cmd/Ctrl+R`       | Rename the selected session                          |
| `Cmd/Ctrl+Shift+R` | Resume your most-recently-modified session           |
| `Cmd/Ctrl+W`       | Close/deselect the current session tab               |
| `Cmd/Ctrl+B`       | Toggle the left sidebar                              |
| `Cmd/Ctrl+Alt+B`   | Toggle the right split panel                         |
| `Cmd/Ctrl+Shift+A` | Toggle the Fleet rail                                |
| `Cmd/Ctrl+Shift+B` | Toggle the Fleet rail                                |
| Arrow keys / Enter | Move and activate the keyboard cursor in the sidebar |

### Terminal shortcuts

These apply while a terminal pane has focus:

| Shortcut                     | Action                                         |
| ---------------------------- | ---------------------------------------------- |
| `Cmd+C` / `Ctrl+Shift+C`     | Copy selection                                 |
| `Cmd+V` / `Ctrl+Shift+V`     | Paste                                          |
| `Shift+Enter`                | Insert a soft newline without submitting       |
| `Ctrl+Backspace`             | Delete the previous word                       |
| `Cmd/Ctrl` + `=` / `-` / `0` | Increase / decrease / reset terminal font size |

> **Not built yet:** `Cmd/Ctrl+Shift+P` is wired to a "Switch project" action, but today it just reopens the plain command palette — a dedicated project-filter mode hasn't shipped yet.
