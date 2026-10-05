# Getting started

Harnu reads the sessions Claude Code already keeps on your machine (`~/.claude/projects/`) and gives you one place to see, resume, and start them. There's no account, no cloud sync, and no daemon — it's a UI over files that already exist on disk.

## Install

Harnu is still in alpha and the binaries aren't signed or notarized on any platform, so the OS will warn you on first launch. That's expected — see the platform note below for how to get past it.

**Linux** — download the `.deb` or `.AppImage` from the release page.

```bash
sudo dpkg -i harnu_*_amd64.deb
# or
chmod +x Harnu-*.AppImage
./Harnu-*.AppImage
```

**macOS** — drag the `.dmg` to Applications. Gatekeeper will refuse to open it on first launch; either run:

```bash
xattr -d com.apple.quarantine "/Applications/Harnu.app"
```

or right-click the app in Finder and choose **Open** — macOS then offers a one-time exception.

**Windows** — run the `.exe` installer. SmartScreen will show "Windows protected your PC" — click **More info → Run anyway**. Subsequent launches are clean.

Full detail on what Harnu talks to over the network (there's very little — status checks, changelog fetch, opt-in auto-name) is in the [README](../../README.md#network-activity).

## First launch

If you have no folders added yet, Harnu opens straight to a welcome screen: a title, a short description, and a single button — **Add your first project folder**. You can also just drag a folder in from your file manager and drop it onto that screen; either way pins the folder to the sidebar.

"Adding" a folder doesn't create or move anything — it points Harnu at a directory that already exists on your machine (typically a git repo or project you already have Claude Code sessions in, or want to start one in).

## Adding folders

Once you have at least one folder pinned, the sidebar footer always has an **Add folder** button, so you're not limited to the welcome screen. Clicking it opens the same dialog: **Browse** to pick a directory with your OS's native picker, adjust the display name if you want (Harnu suggests one from the folder's name), then **Add project**.

Two more ways to add folders show up on a folder's right-click context menu, useful once you have a folder already pinned:

- **New folder** — creates a brand-new subfolder inside the one you right-clicked (e.g. a fresh package in a monorepo) and pins it. This is the only option that writes anything to disk; the folder didn't exist before.
- **Open subfolder** — browse or search for a subfolder that already exists inside the one you right-clicked, and pin that instead. Handy for adopting one package out of a large monorepo without pinning the whole tree.

Pinned folders live in the sidebar's flat folder list, alongside folders that are active but that you haven't explicitly pinned — so you don't lose track of a session running somewhere you didn't add on purpose. See [Folders and worktrees](folders-and-worktrees.md#pin-hide-and-the-flat-folder-list) for how pin and hide interact.

## Starting your first session

Every folder row has a **+** for a new session (also reachable with `Cmd/Ctrl+N`, or by opening the [command palette](#the-command-palette) and searching). This opens a small confirm dialog: it shows the target folder, and an **Advanced** section you can expand to override the model or launch flags for just this one session. Press **Start** (or hit Enter) and Harnu spawns a plain `claude` process in that folder — this is your first session, from scratch, with nothing to resume.

Sessions you've already had with Claude Code show up nested under their folder the moment you pin it — click one to resume it (`claude --resume <id>`) right where you left off. Each session row carries a status dot so you can tell at a glance what's going on: green pulsing means Claude is actively working, amber means it's waiting on you, red means it failed or got stuck, gray is idle, and a checkmark means it finished.

## The command palette

`Cmd/Ctrl+K` opens a spotlight-style search over your recent sessions, folders, and available actions — the fastest way to jump around once you have more than a couple of folders pinned. A few other shortcuts worth knowing early: `Cmd/Ctrl+B` toggles the sidebar, and `Cmd/Ctrl+Shift+A` / `Cmd/Ctrl+Shift+B` both toggle the Fleet rail.

## What's next

From here, the rest of the guide (linked from the [index](README.md)) covers each capability in depth as those pages land — sessions and the terminal pane, worktrees, the Approval Inbox, agent control, project memory, the roadmap board, and settings.
