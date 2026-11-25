# Folders and worktrees

This page covers how Harnu organizes folders in the sidebar once you have more than a couple pinned, and how git worktrees work — both by hand and seeded from a repo's own manifest. For the basics of adding your first folder, see [Getting started](getting-started.md#adding-folders).

## Pin, hide, and the flat folder list

The sidebar is one flat list — every folder you've explicitly pinned, plus every folder that's active right now (a live process, or a session modified recently) even if you never pinned it, sorted and grouped together with no section split and no visual distinction between the two. The "active but unpinned" case exists so you don't lose track of a session running somewhere you didn't add on purpose — for example, one a teammate or an agent started in a sibling worktree. A folder with no sessions and no pin simply doesn't show up at all — except a git worktree of a repo the list already shows, which always lists (see [Worktrees you create outside Harnu](#worktrees-you-create-outside-harnu)).

**Pin** is just an attribute you can set or clear from a folder's right-click menu — pinning keeps a folder listed even after it goes quiet; unpinning lets an inactive folder drop out of the list once nothing's happening in it.

**Hide** is the only way to suppress a folder from the list regardless of its pin state. Hiding doesn't unpin — a pinned folder you hide stays pinned underneath, so unhiding it later brings it straight back as pinned (not relocated or lost). Manage hidden folders from the eye-off icon in the sidebar toolbar (above the folder list). The popover opens on a search box (already focused, so you can just start typing) that filters by folder name, branch and path, with an "N of M" counter on the right. Matching folders are grouped under their repo — the same label the sidebar's repo header uses — and each row shows how many sessions live in it. `↑`/`↓` move the selection, `↵` or a click on the **Unhide** chip restores that folder, and the popover stays open so you can restore several in a row. When a search narrows the list to two or more folders, the footer offers **Unhide all N** to restore the whole filtered set at once.

## The sidebar tree

The list has three levels and no more: **folder → checkout → session**.

- A **folder** is one repository (its main checkout plus its worktrees) or one standalone folder. It has one header with a state ring, its name and, at the right edge, how many checkouts it holds.
- A **checkout** is one working directory: the **main** checkout first (home icon), then the worktrees (branch icon), labelled by branch. They are all flat, at the same indent. A detached checkout shows its folder name.
- **Sessions** sit under their checkout, joined by a thin guide line. A folder that isn't a git repository has no checkout row: its sessions sit directly under its header.

Worktrees with no listed session fold into a single quiet **n idle worktrees** row. Click it to list them; click one of them to open its folder view, or right-click it for its menu. The main checkout is never folded away, and a worktree that gains a session leaves the fold on its own.

**The header.** Click it (or press Enter) to open the folder's view; it opens the folder too and never collapses it. The chevron that replaces the count on hover is what collapses, and the target button beside it is [Focus](#focus-on-one-folder). The header stays on screen while its checkouts scroll. Its ring takes the hottest session inside: waiting on you, then failed, then working; an idle folder shows an empty ring. Markers from any checkout stay visible on it: new agent panes you haven't seen, **agents blocked** and **new sessions start as Orchestrator** (the tooltip names the checkout). If two headers resolve to the same name, a small `· parent` hint tells them apart.

**Checkout rows.** Click (or press Enter) to fold or unfold that checkout's sessions. A folded row shows its session count; on hover the count turns into a chevron, in the same place. The row has no buttons of its own: right-click it for **New session**, **Show older (n)**, **Show archived (n)** and the rest of the folder menu.

**Renaming a repository.** Right-click the header of a repository with two or more checkouts for **Rename repo** (a custom label), **Reset name** (only once you've set one) and **Clean up** (opens Cleanup on that repository). A repository with a single checkout uses the folder's own **Rename…**.

## Shelved worktrees

When Cleanup [shelves](cleanup.md#shelving-idle-worktrees) an idle worktree, its folder is gone on purpose but the branch and the sessions are kept. Such a worktree never shows as a normal row, and never as a "ghost" folder either. It waits in a **Shelved** section (pt-BR: **Guardadas**) at the **end of its repository's folder**, after the live worktrees:

- **Collapsed by default.** The row reads **Shelved · 3** (the number is always visible, even collapsed) and only appears when the repo has at least one shelved worktree. Click it to open it. Whether it is open is remembered per repo. Typing in the sidebar filter opens it when a shelved branch or session matches; folding the folders closes it and **Expand all** opens it. The folder header's own count stays the live worktrees only.
- **A repo with one live worktree and one shelved worktree still counts as a repository folder**, so the section always has a place to live.
- **One compact, dimmed line per worktree:** the branch (a detached worktree shows its folder name), a small archive icon and how long ago it was shelved (**9 d**). Hover for the full wording ("Shelved 9 days ago · branch `feat/x` kept"). Clicking the line only opens its list of sessions; it never restores anything.
- **Click a session to resume it.** Harnu restores the worktree first (the row reads **restoring…** and the session is highlighted at once), then opens the session in its own folder, so nothing ever starts in a missing directory. The worktree then moves back into the folder as a normal checkout row. If the restore cannot work, nothing is started anywhere else, the selection stays where it was, and a message names the branch and offers **Open in Cleanup**, where the Shelved card says what to do next. Nothing was lost.
- **Right-click a shelved worktree** for **Restore worktree** (brings the folder back without resuming anything) and **Open in Cleanup**. A shelved worktree has no folder, so the usual folder actions (new terminal, rename, hide...) do not apply. The hover action at the right edge of the line does the same as **Restore worktree**.

## Worktree lineage

When a session cuts a new worktree (you dispatched an agent that called `create_worktree`, or a roadmap card drained into one), Harnu remembers which folder asked for it. The sidebar no longer draws that relationship: every worktree is a flat checkout row under its repository.

The record is still kept, and you can set or fix it by hand: right-click a worktree and use **Set parent folder** (pick any sibling worktree of the same repo) or **Clear parent folder**.

## Focus on one folder

When one repository has all your attention, **Focus** narrows the list to it. Hover a folder header and click the target button that appears beside the chevron (or reach it with Tab), or right-click any row of the folder and pick **Focus this folder**.

- The list now holds that folder alone, with all its checkouts and sessions. It stays open: there is nothing to collapse on its header.
- **All folders**, the row pinned at the top, brings the full list back; the whole row is the button. On its right it counts what is waiting elsewhere, for example **7 others · 1 needs you · 1 failed**. Each other folder counts once, at its most urgent state.
- **Needs attention** and the bottom dock still cover every folder. Selecting a session of another folder, from anywhere (a Needs attention row, the jump palette, a notification, the command palette), leaves Focus so you can see where you landed. `Esc` does not leave it.
- The collapse button still works; its last step (**folders folded**) leaves Focus.
- Focus is remembered across restarts. It is dropped if the folder no longer exists or you hide it.

## Sidebar toolbar

Everything lives on one line at the top of the sidebar, right-aligned: Rescan folders, the collapse button, Hidden folders (with a count badge), then — after a thin divider — Search. The folder list starts directly underneath.

**Rescan folders** forces a fresh scan of disk and reconciles the sidebar with what's actually there. You shouldn't normally need it — a background watcher keeps the list current — but it's the escape hatch for the rare case where the watcher misses something, and it saves you a full app restart. New sessions and folders created outside Harnu (a `claude` you start in a terminal, a new project folder) show up on their own within about a second. Rescan runs one fresh scan.

The **collapse button** steps through three levels, one per click, then starts over: **everything open**, **sessions folded** (checkouts listed) and **folders folded** (headers only). The icon and tooltip say what the next click does (**Collapse sessions**, **Collapse folders**, **Expand all**), and the dots under the icon show the current level: three, two, one.

With the keyboard, ↑ and ↓ move through the list. Enter on a header opens the folder's view, on a checkout folds or unfolds it, on the idle-worktrees row lists them, and on a session selects it; → and ← open and close.

## Finding a folder or session (the jump palette)

The Search button opens a small palette under the toolbar. It is a way to **go somewhere**, not a way to shrink the list: the tree behind it is left exactly as it was, so closing the palette never costs you your place.

Type, and results come back grouped as **Folders**, **Hidden** and **Sessions**, with the part you typed shown in bold and a dim hint saying where each one lives. It looks at more than the name: a folder matches on its label, its git branch and its full path, and a session matches on its summary and on your first prompt to it — so pasting a PR number or a ticket key lands on the session that worked on it.

Press ↵ (or click) and Harnu expands whatever the target is buried under (folder, checkout or idle-worktrees row), scrolls to it, selects it if it's a session, leaves [Focus](#focus-on-one-folder) if the target is in another folder, and flashes the row once so you can see where you ended up.

**Folders you've hidden are searchable here too.** A hidden hit shows an eye-off icon and an **Unhide & go** chip — one keystroke, instead of opening the Hidden list and scanning it for a name you half-remember.

Open the palette without typing anything and you get history instead: your **recent searches** (the last 8 that found something, with how many hits each returned — click one to run it again) and the **folders you visited most recently**. Both are remembered between restarts.

Keys: `↑`/`↓` move through the results, `↵` jumps, `Esc` closes, and `⇥` falls back to the old behaviour — it takes what you typed and uses it to filter the tree itself, for when a narrowed list really is what you wanted. `⌘K` is unrelated and unchanged: it still opens the app-wide command palette.

## Active elsewhere: sessions you start in your own terminal

Folders where a `claude` session is running that Harnu did not start show up under **Active
elsewhere**. By default Harnu guesses their state from Claude Code's own files. With **Harnu
mod outside Harnu** on ([Mods](mods.md#harnu-mod-outside-harnu)), a session that Harnu's own
watchers have confirmed reports its real state, and its hover preview reads **Harnu mod: live ·
outside Harnu**. A session that has not been confirmed yet is not shown differently, and Harnu
never creates a row for it: the row comes from the session's own transcript, as before.

## Creating a worktree

Right-click any git-tracked folder and choose **New worktree…**. The dialog has two phases:

1. **Form** — name the branch (and optionally an existing local/remote branch or commit to check out instead of creating a new one, e.g. to review a PR). Both branch pickers are searchable — type to filter a long list instead of scrolling. Harnu dry-runs the plan as you type and shows a live preview.
2. **Progress** — a step tracker walks through resolving the base, adding the worktree, seeding files, running setup commands, and adopting it into the sidebar.

### Slugifying a pasted ticket title

Most of the time the branch name starts life as a ticket title copied out of an issue tracker — `ACME-10996 Report Export Date Range Filter` — which git won't accept. Paste it anyway: a strip appears under the Branch field showing what it would become (`acme-10996-report-export-date-range-filter`), and **Apply** rewrites the field. It only shows up when the name would actually change, and it goes away once you apply it, so a name that's already clean never gets nagged at.

Open **options** on that strip for three settings, all remembered between worktrees:

- **Prefix** — prepended to every suggestion, e.g. `feature/`.
- **slugify prefix** — off keeps the prefix literal (`feature/acme-10996-…`), on folds it into the name (`feature-acme-10996-…`).
- **preserve case** — keeps the original capitalization (`ACME-10996-Report-Export-…`) instead of lowercasing everything.

Everything that isn't a letter or a digit becomes a single dash, so dots and underscores collapse too (`release/1.2.0` → `release-1-2-0`). Nothing is ever rewritten without your click.

If you point it at a branch that's already checked out somewhere else, Harnu checks it out detached instead of failing. A Claude session can also create a worktree on your behalf via its `create_worktree` capability (see [Agent control](agent-control.md)) — it goes through the same machinery as the dialog.

If a `setup` step or seed fails, Harnu always rolls the create back — removing the checkout and the branch it made, so a retry never trips over a leftover branch. The error you see names the exact stage and command that failed, says whether the tool was simply missing (and, if so, the PATH Harnu's setup shell used to look for it) or actually ran and errored, and confirms the rollback happened, instead of a bare, hard-to-parse error line.

### Removing a worktree

Right-click a linked worktree (not your main checkout — that option never appears there) for **Remove worktree**. Harnu refuses to remove one with uncommitted changes or unpushed commits unless you explicitly toggle **Force**; you can also choose to delete the branch at the same time. Note this is a human-only action today — there's no equivalent capability exposed for a Claude session to remove a worktree itself.

### Worktrees you create outside Harnu

A `git worktree add` on a repo that's already in your sidebar (pinned, or active on its own sessions) shows up under that repo within a couple of seconds, even before any session runs in it. With no session yet it sits in the **idle worktrees** row: open that row and click the worktree for its folder view, or right-click it to start a session there. `git worktree remove` (or `prune`) takes it away again. Every worktree of a repo the sidebar shows stays listed this way, including one whose sessions are all old, until you remove it; a path you hid stays hidden.

Repos you haven't pinned and haven't used recently are not scanned, so their worktrees don't appear until one of their folders is pinned or active again. A worktree's branch label refreshes the next time that repo's worktree list changes — a `git switch` inside a worktree with no session in it doesn't update the label on its own.

## Worktrees born usable: `WORKTREE.md`

A bare `git worktree add` gives you an empty checkout with no dependencies installed and no `.env` seeded — useless until you run setup by hand. Harnu avoids that by reading a manifest committed at the repo root (`WORKTREE.md`, `worktree-manifest.md`, or `.claude/worktree.md` — first one found wins) and running it automatically whenever it creates a worktree, whether from the dialog or from an agent's `create_worktree` call.

The manifest is YAML front matter plus a markdown body explaining it to whoever reads the file. Fields Harnu actually understands:

- **`dir`** — where to put the new worktree, as a template (`{branch}`, `{slug}`, `{repo}` tokens). Defaults to `../{repo}-worktrees/{branch}`.
- **`from`** — the branch to base new worktrees on. Harnu fetches it and cuts from the _remote_ tip: `from: main` means `origin/main`, not your local `main` (which nobody fast-forwards during a long session, so new work would silently start several commits behind). With no `from` at all, it uses the remote's default branch. Either way the starting commit doesn't depend on what the shared checkout — or another session working in it — happens to be doing right now. If the remote can't be reached, Harnu still creates the worktree from the local ref and tells you the base may be stale. Two cases deliberately keep the old meaning: picking an explicit base in the New-worktree dialog means exactly what you picked, and creating a worktree _from another worktree_ starts at that worktree's own commit (so you can stack work on work).
- **`seed.copy`** / **`seed.link`** — files to copy or symlink into the new worktree (typically `.env`, since that's never checked into git).
- **`setup`** — shell commands to run once the worktree exists (e.g. `npm ci`). This is the part that actually gets you a usable checkout instead of a bare one. Cleanup's **Rehydrate** re-runs it too, so prefer the lockfile-respecting form of your install (`npm ci`, `composer install`, `pnpm install --frozen-lockfile`) — an `npm install` can rewrite `package-lock.json`.
- **`ephemeral`** — the directories Cleanup may **dehydrate** (remove to reclaim disk) from an idle worktree, because `setup` regenerates them. Defaults to `node_modules`, `vendor`, `.venv` and `venv`. Build outputs like `dist`, `target` or `.next` are left out on purpose — `setup` installs, it doesn't build — so add them here only if you're happy to rebuild them. Listing a folder is necessary but never enough: Cleanup still refuses anything git tracks or doesn't ignore. See [Cleanup](cleanup.md#dehydrate-reclaim-dependency-space-without-deleting-work).
- **`create`** / **`remove`** — an escape hatch for repos with unusual setup: if present, `create` fully replaces Harnu's default worktree-creation flow, with `remove` as its matching teardown.
- **`boot.model`** / **`boot.prompt`** — the default model and boot prompt for a session started in this worktree.

Unknown keys are ignored with a warning rather than failing the whole thing, and a malformed manifest never blocks worktree creation — it just falls back to defaults. If you keep a machine-specific overlay (say, a different seed path on your laptop vs. a teammate's), a gitignored `WORKTREE.local.md` next to it is merged on top.

By default an agent creates worktrees without asking you (see [Agent control](agent-control.md)), which means a repo's committed `setup` commands run as part of that. If you'd rather see them first, turn on **Ask before agent actions** in Settings → Control server: the approval Harnu then puts in front of you discloses the exact commands the manifest will run, so you're never running arbitrary shell blind.

### `setup`/`create`/`remove` are POSIX-shell strings — what that means on Windows

Whatever you write in `setup`, `create`, or `remove` is a **POSIX-shell command**, on every platform, always — Harnu never translates or reinterprets it. On macOS/Linux that's just `sh -c` and needs nothing extra. **On Windows, Harnu needs a real POSIX shell to run it**, and uses Git Bash (the one that ships with [Git for Windows](https://git-for-windows.github.io/), which you already have if you can run `git worktree` at all): it's found automatically, no setup required. If none is found, worktree creation fails immediately with a clear message — nothing is created, no branch is left behind — rather than the old bare `spawn sh ENOENT`. If your Git Bash lives somewhere non-standard, point Harnu at it with the `CAPY_POSIX_SHELL` environment variable (the full path to a bash-compatible shell). The `seed.copy`/`seed.link` step itself doesn't need a shell at all and works the same way on every platform.

## Clicking a folder — the folder view

Clicking a folder header opens **that folder's view** in the main pane, the same way clicking a session opens the session. It also opens the folder in the sidebar, and clicking again never collapses it (use the chevron). A worktree in the idle-worktrees row opens its own view the same way.

The view says which folder you are in and lets you act on it. What is working or waiting on you stays in the sidebar:

- **Header** — the folder's name, its git branch and a git summary: how many uncommitted changes there are (or none), and how far ahead or behind the branch is. The summary turns amber when the folder has changes or is behind. The full path sits underneath.
- **Actions** — **New session**, **Terminal here**, **Browse files** and, when the repo has a board, **[Roadmap board](roadmap-board.md)**. The **…** button holds the rest: [PR Stack](pr-stack.md), Open in your [editor](settings.md#editor) and Open folder in your file manager.
- **Roadmap** — one line, only when the repo has a board: how many cards are in progress, ready and in review, with a small bar. The numbers belong to the repo, so every worktree of it shows the same ones.

A folder that isn't a git repo shows no branch, no git summary and no PR Stack.

Selecting a folder never stops a running session. Pressing **Enter** on a folder with the arrow-key sidebar navigation does the same as clicking it. Sessions keep running in the background with their scrollback and conversation intact; clicking one brings you straight back to it.

**Walks.** Right-click a folder and choose **Walks** to open the repo's saved [guided test walks](guided-test-walk.md#the-walks-library) in a pane, or use the **Walks** button in the top bar. The walks belong to the repo, so every worktree of it shows the same list.

**Folder actions no longer need a session.** The Topbar's buttons (Roadmap board, PR Stack, Browse files, Open in your [editor](settings.md#editor), Pull requests on GitHub, Open folder, terminal) act on whichever folder you have selected. Previously they were only available while a session was selected, which made a folder with no sessions a dead end — you had to start a session just to open that folder's board.

**Pull requests on GitHub.** When the selected folder's `origin` remote points at github.com, the Topbar shows a pull-request button that opens the repo's **Pull requests** page in your browser. Both HTTPS and SSH remotes work, including SSH host aliases like `git@github.com-work:owner/repo.git`. The button is hidden when the folder isn't a git repo, has no `origin`, or its `origin` is somewhere else (GitLab, Bitbucket, a GitHub Enterprise host). It only reads `origin`, so a fork whose `origin` is your own copy opens your fork's pull requests, not the upstream's.

**A narrow Topbar folds its buttons into a `…` menu.** When the window (or the column) is too narrow for the Topbar's buttons, the title shortens with an ellipsis — down to a minimum of about 96px — and then the buttons start to leave the bar one at a time, the least important first, into a **More actions** (`…`) button at the end of the bar. They come back, one at a time, when the bar gets wider. The first to go are Pull requests on GitHub, Open folder and Open in your editor, then Browse files, the split-layout toggle, Notes, Browser and Terminal; the Walks, Review, PR Stack and Roadmap buttons, the panel toggle and **New session** go last. The sidebar toggle and the Activity bell never fold. Everything in the menu works as it did in the bar: same icon, name, keyboard shortcut and highlight (a board that is open is still lit). Open it with a click, or press **Enter**, **Space** or the **Down** arrow on the `…` button; move with the arrow keys, press **Enter** to run an action, **Esc** to close it and return to the button.

## Hover preview

Hovering a folder row shows its alias, full path, git branch and whether it's the main worktree or a linked one, session count, live git status (uncommitted count, ahead/behind), and — if the repo keeps [project memory](project-memory.md) — the top of its "where we left off" snapshot, so you can catch up on a folder without opening it.

## Canvas files in a worktree (groundwork — no UI yet)

Harnu now understands one more kind of file inside a worktree: a **canvas document**, named `<name>.harnucanvas.json`. The default lives at `.harnu/out/canvas/board.harnucanvas.json`, with any images it references in a sibling `assets/` directory.

Two things are worth knowing about where it lives:

- **It is per-worktree, not per-repo.** Unlike [project memory](project-memory.md), which every branch of a repo shares, each worktree gets its own canvas — because a worktree is a physically separate checkout, `feature-a`'s board and `feature-b`'s board are simply different files.
- **It is gitignored by default.** `.harnu/` is already ignored, so the default board is a branch-local scratch surface that never lands in a commit and disappears with the worktree. A canvas you deliberately want to keep goes somewhere tracked, such as `docs/canvas/` — where the `assets/` folder beside it is tracked as well, so images on that board land in commits.

The file is plain JSON with a stable key order (so re-saving an unchanged board produces an empty diff), and every node and edge in it records whether **you** or **the agent** created it — which is what will later let an agent tell its own drawing apart from your edits.

Harnu **draws** these files: clicking the **eye** icon on a `.harnucanvas.json` row in the file browser opens it in the [canvas pane](canvas.md), where you can draw, rename, connect, delete and save. A session can draw on one too, and creates the file if it is not there yet — so the usual way to get your first board is to ask for one. Writing one by hand still works; there is a starter file in [Canvas pane](canvas.md).
