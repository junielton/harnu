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

The view uses the full width of the pane, laid out as a main column plus a
narrower **context rail** on the right. Below roughly 1100px wide the rail drops
underneath the main column as a two-up band, and on a narrow window everything
stacks into one column.

The view is the folder's home screen:

- **Header** — the folder's name, full path, git branch, whether it's the main worktree or a linked one, and live git status (uncommitted count, ahead/behind).
- **Actions** — New session, [Roadmap board](roadmap-board.md), [PR Stack](pr-stack.md), Browse files, Open in your [editor](settings.md#editor), Open folder in your file manager, and a terminal in that folder.
- **Sessions** — the folder's sessions, newest first; click one to open it. A folder with no sessions shows a **New session** button instead of an empty list. **Older** and **Archived** sit below as expandable sections, so you no longer need the hover-only peek icons on the sidebar row to reach them.
- **Where we left off** — the top of the repo's [project memory](project-memory.md) snapshot, when it has one.
- **Roadmap** — how many cards sit in each column, and every card currently in progress or in review by name.
- **Worktrees** — the repo's other worktrees, marking which one you're looking at and which were cut from here. Click one to switch to it.

**The long lists scroll inside themselves.** The roadmap and worktree lists in the rail — and
the fan-out table on a main checkout — stop growing after about nine or eleven rows and scroll
within their own box, so a repo with a hundred worktrees or a hundred cards can't push the rest
of the view off the bottom of the screen. A list that's shorter than that just renders at its
natural height, with no scrollbar and no empty space held in reserve.

On a repo's main checkout you also get a **KPI strip**, the **Worktrees in flight** fan-out table and an **Activity · 14d** chart — see [Main checkout](#main-checkout) below.

Sections you have no content for simply don't appear — a repo with no project memory shows no memory section, a repo with no cards shows no roadmap section.

### `this folder` vs `repo` — why the little tags are there

Each block carries a small tag next to its label saying **what it is actually
about**, and it is not decoration. Half of this view is not about the folder you
clicked:

- **`this folder`** — your sessions, your branch, your working tree. Only the
  **Sessions** block is genuinely local.
- **`repo`** — the whole repository. Project memory is shared by every worktree of
  a repo, so **Where we left off** in a worktree shows you the main checkout's
  snapshot, word for word. The same is true of the **Roadmap** counts: there is one
  board per repo, and every worktree shows the same numbers. **Worktrees** is the
  repo's full list of worktrees, not just the ones cut from where you're standing.

Before the tags existed, all of it printed in one undivided column, which made a
worktree look like it had its own memory and its own board. It never did — you were
always reading the repo's.

### Two shapes, depending on where you're standing

The view knows the difference between a repo's **main checkout** and a **worktree**,
and lays itself out for the job you're actually doing there.

- **Main checkout — the orchestration home.** Main is where you plan and dispatch;
  its own sessions are few and they're the ones running the show. The main column
  leads with the repo's fan-out, and the rail carries memory, the board and the
  worktree list.
- **A worktree — one feature's cockpit.** A worktree exists to land one card and
  then be deleted. It leads with the card that branch owns, and the repo-wide blocks
  shrink into the rail — present, clearly labelled, never pretending to describe the
  branch you're on. The worktree list is titled **Sibling worktrees** here, which is
  the honest name once you're standing inside one of them.

### Main checkout

The main checkout is where you plan and dispatch, so its view is built to answer one
question at a glance: **what is in flight, and what needs me?**

**The KPI strip** sits above everything — four numbers:

- **Needs you** — sessions waiting on you, plus pull requests with changes requested,
  across every worktree of the repo.
- **In flight** — how many worktrees have a live session right now, out of how many
  worktrees there are.
- **In review** — how many roadmap cards sit in Review, with a bar showing the whole
  backlog → ready → in progress → review pipeline.
- **Sessions here** — the working set of this checkout itself, and how many older
  sessions folded away below.

**Worktrees in flight** — the fan-out table — leads the main column. One row per
worktree of the repo, and each row tells you:

- **Branch**, with a status dot: green when a session is working there, amber when one
  is waiting on you, muted when nothing is running.
- **Card** — the roadmap card that branch is executing (the one whose `executedIn`
  names it). A branch no card owns shows an em-dash rather than a blank.
- **Sessions** — how many that worktree holds, and how many are live.
- **Git** — how far ahead of or behind its base the branch is.
- **PR** — a pill: checks passing, checks failing, changes requested, or draft. Click
  it to open the pull request on GitHub.

Your own row is tinted and sits at the bottom — it's the base the others merge into,
not one of the things in flight.

The table **scrolls inside itself** once it gets past roughly eleven rows, and the column
header stays put while the rows move under it, so you always know which column you're
reading. Everything below the table — your sessions, and the rail beside it — stays where it
is no matter how many worktrees the repo has.

**Clicking a row opens it, it doesn't take you away.** A row click expands a detail panel
directly underneath it (or use the chevron on the left, which works from the keyboard too),
showing the things the row itself had to cut short:

- the **full branch name**, however long it is;
- the card's **full title**, not the ellipsised version;
- **ahead / behind** written out — "3 ahead · 1 behind" — or an explicit "Git status could not
  be read" when the probe failed, which is not the same thing as being up to date;
- the pull request's **own title**, linked, rather than just its state and number;
- the worktree's **absolute path**.

One row is open at a time — opening another closes the first — and it stays open while Harnu's
git and pull-request reads finish arriving in the background. To actually switch to that
worktree, use the **Open this worktree** button inside the panel. That's the change: leaving
the table is still one click, but it's now a click that says so, instead of something that
happened because you wanted to read a row.

**Activity · 14d** sits at the top of the rail, just under "Where we left off". It draws how
many sessions started per day across the repo over the last fortnight, with today emphasised
and quiet days shown as a flat tick rather than a gap. It's above the roadmap and worktree
lists on purpose: it's a small chart, and it used to render below both of them, which on a
large repo meant scrolling past hundreds of rows to see it.

A repo with only one worktree shows **no fan-out table at all** — there's nothing to
fan out to.

**What happens when Harnu can't read something.** Each of these reads can fail on its
own, and none of them takes the row down with it:

- No `gh`, no network, or a repo with no pull requests → the **PR** column is simply
  empty. No error, no spinner that never resolves.
- A git probe that fails → that row's **Git** cell is empty; the row stays.
- The **Needs you** tile is the one exception, and deliberately so: when it cannot read
  PR state it says **"PR state unavailable"** instead of quietly counting those PRs as
  zero. A tile that told you nothing was waiting on you when it simply couldn't look
  would be wrong in the one direction that costs you something.

One thing the fan-out does **not** show yet: a **merged** PR. Harnu's PR data for a repo
only carries open pull requests today, so a branch whose PR has already merged shows an
empty PR cell rather than a "merged" pill.

### Worktree

A worktree's view leads with **the card this branch owns** — the one thing a
worktree is for. Below it sit its own sessions in the main column, and memory,
**Sibling worktrees** and the roadmap in the rail.

#### The card this branch owns

A worktree exists to land one card and then be deleted, so the block at the top
answers "what is this branch for" before anything else. It is the only
accent-coloured block in the view, on purpose.

It shows the card's id, title and status, a pill with the pull request's state
(approved, changes requested, draft, in review), and a **four-step progress
rail**:

**Dispatched → Commits → PR → Merge**

Each step carries what it actually knows: how long ago the work was dispatched,
how many commits the branch carries and the latest short commit hash, the PR
number. One step at a time is highlighted — the one the work is standing on right
now. Everything before it is green, everything after is grey.

**The PR step shows the number and nothing else.** It does **not** tell you how
many review threads are still open on that pull request. Harnu doesn't read a
thread count for a PR anywhere today — the pull request data behind this rail
carries the review decision, the checks and how far behind the branch is, but no
count of open conversations — so the step reports the half it can actually read
instead of guessing at the other. It can only start showing a count if that pull
request data is widened to carry one; as things stand, open the PR to see its
threads.

**The final Merge step doesn't light up yet.** Harnu currently only reads open
pull requests, so once your PR is actually merged the rail loses sight of it and
falls back to showing no PR rather than a completed merge. That's the honest
direction to fail in — it never claims a merge that didn't happen — but it does
mean the rail is most useful while the work is in flight, and the merged state is
still to come.

**A step Harnu can't verify shows as "not yet", never as done.** If you have no
`gh` installed, or the branch has no upstream, the steps it couldn't read stay
grey rather than guessing. That is deliberate: a rail that claims a PR is merged
when it simply couldn't check is worse than one that admits it doesn't know. The
same applies in reverse — "no PR" and "couldn't check for a PR" are different
things, and only the first one is ever stated.

Under the rail sits a line of context: the card's board column, the session that
owns it, how many commits are unpushed and whether the tree is clean, and the
branch this worktree was cut from.

**A worktree whose branch owns no card shows none of this** — no empty box, no
"no card yet" placeholder. The view simply starts at the sessions list. That's the
normal state for a worktree you cut by hand rather than dispatching from the
board, and it isn't a broken view.

There's no 14-day activity chart here, and there never will be: a worktree that
has existed for two days has nothing to trend. (The chart is planned for the main
checkout's view, where it makes sense, but isn't built there yet either.)

#### Sibling worktrees

Each row in this list carries the same status dot the sidebar paints, so a branch
you're stacked on that is **waiting on you** is visible without leaving the folder
you're in. A worktree shows amber if any of its sessions needs you, green if any
is working, and grey otherwise — the worst case wins, because the whole reason to
show it is to surface the one that's blocked.

### What a session row tells you

Each row in the **Sessions** block is a status dot, the session's title, its message
count and when it was last touched.

The dot is the same one the sidebar paints, and it means the same thing in both
places — that is deliberate, so a session can't look busy in one list and finished
in the other:

- **Green, pulsing** — working. A session that has gone quiet mid-task still counts
  as working here rather than quietly dropping to idle.
- **Amber** — waiting on you, whether that's an approval or a question.
- **Muted grey** — idle, done, failed, or archived. The row is not asking for
  anything.

The number beside the title is how many messages that session holds. A session that
hasn't said anything yet shows no number at all rather than a `0`.

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
