# Cleanup

One screen for everything Harnu can reclaim: worktrees that are finished, the Docker stacks that hang off them, orphan Docker volumes, Docker's build cache, and the leftover branches and folders around them. Disk space is the first thing you see (a map where every worktree's area is its size on disk), one button cleans everything Harnu has proven is ready to clean, and everything it is unsure about is listed with a one-sentence reason under Needs review.

## Why it exists

Working across many worktrees leaves a trail: merged worktrees nobody removed, the `vendor/` and `node_modules/` inside them, Docker stacks still running from folders whose branch shipped weeks ago, build cache that only grows. On one measured repo, 64 worktrees held 29 GiB, and about 17 GiB of it sat in worktrees that were dead or probably dead. Cleanup finds all of it, explains its reasoning for each item, and only ever acts without asking on what it can actually prove is finished.

## Opening it

Cleanup takes over the main pane, the same way the Roadmap board, Usage Dashboard, and System Monitor do. The sidebar and topbar stay put.

- Click the **recycle pill** in the footer (bottom-right, next to the fleet summary). It is the only Cleanup pill there is: it replaces the old Cleanup and Containers pills. At rest it shows how much disk Cleanup could reclaim, for example `17 GiB`. While a clean is running it reads **Cleaning 3/12** in the accent color, with a small dot. If a clean left something that needs review, it turns amber and reads **1 needs review**, so you can see it from any screen. It is hidden only when there is nothing to reclaim, nothing running and nothing failed. The pill is a toggle: it turns accent-colored while Cleanup is open, and clicking it again puts you back in your session (Esc and clicking any session do the same).
- Right-click a repo-group header in the sidebar and choose **Cleanup…**. This opens the same view and scrolls to that repo's section.
- In [Containers](containers.md), click **Open Cleanup · N stacks**. Cleanup is the one place stacks are cleaned.
- Click **Review** on a cleanup toast, or open the matching entry in the Activity bell.

## The Cleanup screen

### The summary line

Along the top: `17.2 GiB reclaimable · autopilot on · next cycle in 42 min`.

- **Reclaimable** is everything that is not in use: items that are ready to clean, items that need review, orphan volumes, and the build cache and dangling images Docker could reclaim. It is the most you could get back, not what the next automatic cycle will take.
- **Autopilot on / off** is the switch in [Settings → Cleanup](settings.md#cleanup). When the Reaper's background scan is off there is no timer, so "next cycle" is left out.
- Next to it, a badge repeats the state ("Autopilot on · every 1 h") and an **Autopilot settings** button opens Settings → Cleanup.

Under the toolbar, one **split bar** divides everything Cleanup tracks into three parts, in proportion to their size: **Ready to clean**, **Needs review** and **In use**. A line below it says what the last cycle did ("Last cycle 12 min ago: cleaned 6, freed 3.1 GiB", or "found 12 ready items, 6.0 GiB (report only)").

### The three groups

Every worktree is in exactly one group, and the screen shows each group three ways, so it never relies on color alone: a fill pattern, an icon and a word.

| Group              | Look                          | What it means                                                                                                                                                                                                                                                                                                               | What happens                                                                                   |
| ------------------ | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **Ready to clean** | Solid green, a check circle   | The branch is merged for real, nothing in the folder is uncommitted or unpushed, no Harnu session is running in it, and it has been quiet for the grace period (2 days by default).                                                                                                                                         | The autopilot removes it with the Docker stack running from it. You can also clean it by hand. |
| **Needs review**   | Amber hatching, a help circle | Something is unclear: the branch was closed without merging, the remote branch is gone, the worktree has a detached HEAD, GitHub could not be reached, it has uncommitted or unpushed work, the merge is only inferred, a session is open but idle, another stack shares the folder, or an earlier cleanup stopped partway. | Nothing is touched. The reason is one sentence. You decide: Remove, Dehydrate or Keep.         |
| **In use**         | Plain grey, a padlock         | The pull request is still open, a session is working or waiting for you, or the worktree is within its grace period. Also: a main checkout, anything on your never-clean list, anything you marked Keep.                                                                                                                    | Never touched. (Dehydrate is offered once a worktree has been idle for a week.)                |

"Merged for real", "no session" and the grace period are explained under [Automatic cleanup](#automatic-cleanup-the-autopilot) below.

### The hero button: clean everything that is ready

Right after the summary line sits the screen's one big button: **Clean 12 ready · 6.0 GiB**. It cleans proven-ready items only. The count and the size are in the label, so the click is never blind.

Clicking it opens **one** confirm dialog. It lists every ready item: `repo › worktree`, the branch, its size, and small chips for what goes with it (the Docker stack's containers, dependencies, the checkout, the branch). A warning says plainly that **volumes are kept** (they show up in Needs review afterwards) and what can come back and how (see [What you can get back](#what-you-can-get-back)). Esc or **Cancel** closes it; the focus starts on Cancel, never on the confirm button. Confirming closes the dialog at once and the cleaning runs in the background.

With nothing to clean, the button is disabled and reads **Nothing to clean**. Before you have acknowledged the first report (see below), it is a quieter button, because **Enable autopilot** is the one big button on that screen. Cleaning by hand still works then.

A manual clean is not limited by the autopilot's per-cycle cap: with 24 ready items, the button says 24.

### The map

Below the split bar, each repo is a region sized by its disk use, and inside it each worktree is a block whose **area is its size on disk**. Blocks are grouped by bucket (Ready to clean, Needs review, In use), so the area of each group is itself a number you can read. The biggest blocks are the biggest wins.

- A region header shows the repo name, its worktree count and size, how many are Ready to clean, Needs review and In use, and **Select all in repo**.
- Each block shows the longest label that fits: the full name, then a ticket id such as `PROJ-0412`, then a number, then only its size. Hover for the full name, repo, size and reason.
- Worktrees too small to read collapse into one **N smaller** block per group (dotted border); click it to see them as a list.
- Click a repo's name to open it on its own, with a breadcrumb back to **All repos** and a filter (All / Ready to clean / Needs review / In use). Use the filter to look only at the 42 items that need review.
- Arrow keys move between blocks; **Enter** opens the panel for the focused block; **Space** selects a Needs review block or opens any other.
- A block that is cleaned fades ("freed") and then the map re-draws without it. The map never re-draws under your pointer while you are aiming at a block.

**Scan now** in the toolbar re-reads every repo and Docker straight away instead of waiting for the next scan. The **Map / List** switch changes how the same data is drawn. The list is grouped by bucket and shows each item as a row with a bar. On a system that cannot measure disk sizes (Windows), there is nothing to draw, so the list is the only view and the screen says so.

### The side panel

Click a block to open its panel on the right (on a narrow window it opens over the map instead of beside it). It shows:

- the worktree's name and repo, and its size, split into dependencies and the rest of the checkout (Harnu does not report how big a worktree's volumes are, so volumes are listed by name, with a note that they are kept);
- **Why it is here**: the one-sentence reason (for example "The pull request was closed without being merged.");
- **Takes with it**: exactly what removing it would delete (its Docker stack's containers, dependencies, the checkout, the local branch; its volumes are kept);
- the actions: **Remove**, **Dehydrate** (or **Rehydrate** for one already dehydrated), **Keep**, and **Ask for an opinion**. **Ask for an opinion** is visible but disabled for now (it says "coming in S6"). A ready item's panel offers **Clean now** instead.

An orphan Docker volume shows its compose project and "No known worktree uses this volume".

If a clean failed on an item, the panel also shows **What ran**: which steps finished, which one failed, and which never started ("Nothing destructive ran" when it stopped before touching anything), with Docker's own error text and a **Copy error** button. The item comes back as a Needs review block with its own reason.

**Keep** marks an item so Cleanup stops offering it and the autopilot never cleans it, until its situation changes (the branch merges, or goes away).

### Needs review

A ranked list under the map, biggest first: every Needs review item with its one-sentence reason, size and quick actions (Keep, Dehydrate, Remove). Hovering a row outlines its block on the map. Orphan Docker volumes are listed here too. "Ask for an opinion on all" is visible and disabled for now.

### Selecting several at once

**Shift+click** a Needs review block (or tick a row in Needs review) to select it, and again to deselect. **Select all in repo** selects every Needs review block in that repo. Only Needs review blocks can be selected: ready items are cleaned by the hero button, and In use blocks are never touched. **Esc** clears the selection.

A selection bar appears under the toolbar: `4 selected · 3.4 GiB`, with **Remove selected**, **Dehydrate**, **Keep** and **Ask for an opinion** (disabled for now). **Remove selected** opens the same kind of dialog as the hero button, with differences that matter: each row carries its reason, and a stronger warning says how many of the worktrees you picked hold work that no other branch has. Their code stays recoverable from the archive refs and the system trash. Those items were not proven safe, so the confirm button is red rather than green. Harnu checks every item again at the moment you confirm; one that changed in the meantime is skipped and shown as "Changed since you confirmed — review again."

### Cleaning runs in the background

Nothing blocks. After you confirm, the hero button turns into a **progress chip**: `Cleaning 3/12 · 1.4 GiB freed`, with a thin bar that counts items (not bytes). The map stays fully usable:

- the block being cleaned is tinted with a dot;
- a finished block fades ("freed"), disappears and the map re-flows;
- the footer pill mirrors the chip ("Cleaning 3/12") on every screen.

If you close Cleanup, or reload the window, and come back, the chip is back where it was. There is no Cancel for a clean that is running: it works through the list. An automatic cycle that runs while the screen is open looks exactly the same.

When it ends, a toast says **Freed 6.0 GiB · 12 ready items cleaned**. If something could not be cleaned, it says **11 cleaned · 1 needs review** instead, in amber. The failed item reappears as a Needs review block with its reason ("Cleanup stopped at …"), and the footer pill reads **1 needs review** until you deal with it. Every run also lands in the Activity bell and in the journal at the bottom of the screen. If the window is not focused, you get a normal desktop notification instead of a toast.

### The first run only reports (the banner)

Until you acknowledge the first report, the screen shows a banner: **"Found 12 ready items, 6.0 GiB — enable autopilot?"** with **Enable autopilot** and **Not now**. The ready blocks are drawn with a dashed border: planned, not done. **Enable autopilot** acknowledges the report and turns the autopilot on in one step. **Not now** acknowledges the report and leaves the autopilot off. Either way nothing is deleted by the banner itself.

### Docker

A strip under the map covers what is not a worktree:

- **Build cache**, **Dangling images** and **Orphan volumes**. Build cache and dangling images share one automatic-cleaning switch (the same one as in Settings → Cleanup). Orphan volumes have no switch: they are never removed automatically.
- The build-cache block shows how much Docker could **reclaim right now** and the dangling-image block shows how many images there are and how big. Once an automatic cycle has run, each block also says what the **last cycle reclaimed**. If Docker does not answer for a figure, that block says "Size unavailable — Docker did not answer" rather than show a zero. Both figures count in the reclaimable total at the top while the Docker switch is on.
- **Orphan volumes** show a count and a size, the compose projects they belonged to, and a "Can't be restored" badge. They are never cleaned automatically; they appear in Needs review and are removed only when you select them and confirm each one.
- **Inspect stacks** in the card header opens the [Containers](containers.md) view, where you can look at each stack and start or stop it.

### All clean

When there is nothing to reclaim, the screen says **All clean** ("Nothing to reclaim. Autopilot checked 4 min ago."). The map is still there, showing only worktrees that are in use, so it still answers "where did my disk go?".

### Other leftovers

Below everything, **Other leftovers** keeps the older list for what is not a worktree: orphan **local branches**, **remote branches** and **hidden (archived) folders**. Each row has its checkpoint timeline, a verdict and, when it is harvestable, a trash button; **Sweep** cleans every harvestable one. The next sections explain the checkpoints and the sweep dialog.

## What "harvestable" means (Other leftovers, and the proof behind the groups)

> The worktrees on the map are sorted into the three groups above. The checkpoint timeline and the **harvestable / blocked / insufficient signal** verdicts below are what **Other leftovers** rows show, and the same proof (is it really merged, is the folder really clean) decides which group a worktree lands in.

Every candidate goes through a 7-checkpoint pipeline, shown as a small timeline on its row: **PR → Review → CI → Merged → In main → Remote gone → Local clean**. A checkpoint is green (proven safe), red (a real blocker), a dashed "?" (unknown — Cleanup won't guess), or dimmed (not applicable to this item's kind).

An item is **harvestable** only when it's provably merged into the default branch — either GitHub confirms the PR merged, or the branch's commits are a direct ancestor of `origin/main` (the merge-commit path, when `gh` isn't available or the branch never had a PR) — **and** its folder (if it has one) is clean: no uncommitted changes to **tracked** files, no unpushed commits. A branch that was squash-merged but whose upstream was later deleted still counts, since "merged into main" outranks the unpushed-commits check once that's proven.

Anything with uncommitted changes, unpushed commits, a still-open PR, failing CI, or no merge signal at all is either **blocked** (a real reason not to touch it) or **insufficient signal** (Cleanup genuinely doesn't know, and never deletes on a guess) — never silently harvestable. The line under the verdict says which: a blocked row names its first blocker ("uncommitted changes", "+1 more" when there are others — hover for all of them), and an insufficient-signal row names what went unanswered, or "no probe reached a verdict".

### Untracked files don't block, and don't disappear either

"Clean" means **tracked** files. A file git was never asked to track — a scratch note, a draft, a stray artifact — no longer makes a merged worktree unremovable.

It used to. Cleanup asked git one question ("does this worktree have any changes?") and got one answer that lumped both cases together, so a merged worktree holding a single untracked file rendered **blocked** with "uncommitted changes", its whole PR chain green and its trash button gone. On one real repo, that one conflation was blocking more worktrees than every gap in Cleanup's merge detection combined.

The two are now separate:

- **Tracked modifications still block, exactly as before.** An edit you haven't committed is unfinished work, and Cleanup will not offer to delete the folder holding it.
- **Untracked files are disclosed, not counted against the item.** The **Local clean** checkpoint stays green and its tooltip says how many untracked paths the folder holds, and the confirm dialog lists every one of them by name — grouped by worktree, never truncated to a count — before you confirm.

Nothing about them is silently discarded: untracked files are captured into the sweep's **wip** archive ref along with everything else that was never committed (see "Nothing is deleted before a copy exists" below). The one exception is anything matched by `.gitignore` — build output and installed dependencies are regenerable and are deliberately never archived, so if a folder's only untracked content is `node_modules`, that content is gone with the folder.

**Removing a worktree by hand is stricter, on purpose.** The **Remove worktree** dialog in the sidebar still refuses on _any_ uncommitted change, untracked files included. That path deletes on your say-so with no archive step behind it, so it keeps the blunter guard.

A worktree with a Harnu session currently running in it never shows up as a candidate — Cleanup won't offer to delete a folder you're actively working in.

## Detached worktrees

A worktree can be checked out at a bare commit rather than a branch — a **detached HEAD**. It happens more often than you would think: a `git checkout <sha>`, an interrupted rebase or bisect, a tool that cut the checkout without a branch.

Cleanup used to leave these out of the list entirely. On one real repo that was 15 of 48 worktrees holding 7 GiB — a third of the checkout disk, invisible. Silence read as "nothing there", which was the opposite of the truth.

They now get a block on the map of their own, in **Needs review**, showing the folder and how much disk it takes, and a panel that says how old the commit it sits on is. (The commit sha itself is recorded but not yet on the row — it needs a slot on the meta line that doesn't exist yet.) Because there is no branch, there is no PR, no ancestry and no remote to check — so every branch checkpoint reads as "not applicable" rather than borrowing an answer from a branch that happens to point at the same commit.

**A detached worktree is never ready to clean and can never be removed**, on its own or inside a selection. It is listed in **Needs review**, with "Detached HEAD, so there is no branch to judge." as the reason — unless a Harnu session is running in that folder, in which case Cleanup hides it while the session is live, exactly as it does for every other folder in use. Cleanup is telling you the folder is there and costing you disk, not that it is safe to delete. Most of that disk is usually installed dependencies, and **Dehydrate** reaches detached worktrees like any other (see below) — it needs no branch. To reclaim the checkout itself, attach it to a branch (`git switch -c <name>`) so the normal checkpoints apply, or remove it yourself with `git worktree remove`.

## Dehydrate: reclaim dependency space without deleting work

On one real repo, the `.git` directory for 141 branches was 78 MiB, and the worktree checkouts were 19.71 GiB — of which `vendor/` and `node_modules/` were **17.48 GiB, 93%**. Deleting branches reclaims essentially nothing; the disk is installed dependencies. And sweeping needs a merged, clean worktree, which almost none of them were.

**Dehydrate** removes a worktree's installed dependencies and leaves everything else exactly as it was: the checkout, the branch, every uncommitted edit, every untracked file. It is the one Cleanup action that works on a **blocked** row, because a dependency folder git ignores is not work. It works on detached-HEAD worktrees too.

### What gets removed — and what never does

A folder is removed only when **all four** of these hold. If Cleanup can't prove one of them, it keeps the folder and tells you why:

1. **It is listed as ephemeral** — in `WORKTREE.md`'s `ephemeral:` list, or by default `node_modules`, `vendor`, `.venv` and `venv` (see [Folders & worktrees](folders-and-worktrees.md)). Build output like `dist`, `target` or `.next` is not in the default: `setup` installs, it doesn't build, and a Rust `target/` can be an hour of compilation. Add those yourself if you want them dehydrated.
2. **Git ignores it** (`git check-ignore`).
3. **Git tracks no file inside it** (`git ls-files`) — checked separately from the ignore rules. A PHP project that commits `vendor/` keeps it, full stop.
4. **No session is running in the worktree** — including one idle at its prompt. This is checked again at the moment you confirm, not just when the list was scanned. Harnu can only see sessions it manages: a plain shell or an IDE terminal open in that folder, outside Harnu, is invisible to this guard.

A symlinked folder (for example a `node_modules` your manifest's `seed.link` shares from the main checkout) is kept too: removing a link frees nothing, and `setup` wouldn't recreate it.

Kept folders are listed in the confirm dialog with their reason ("vendor — tracked by git — never removed"). On the row, hover the second line (the kind · age · size line) to see them.

### Deleted outright — not moved to the trash

Everything else Cleanup deletes goes to the system trash. Dehydrate doesn't, on purpose: the trash is on the same disk, so trashing a dependency folder would free nothing until you emptied it, and the space Cleanup told you it reclaimed would be a fiction. The confirm dialog says so before you click. The way back is the worktree's own install, not the trash.

### Rehydrate

A dehydrated worktree reads **dehydrated** in its panel and offers **Rehydrate** (the package-with-a-plus icon), which re-runs the `setup` commands from the repo's `WORKTREE.md` in that worktree — the same recipe Harnu used to create it. While it runs the row reads **rehydrating…**. If a step fails, the notification names the stage, the exact command, and whether the tool was missing (with the `PATH` Harnu's setup shell searched) or ran and errored — the same report worktree creation gives you.

**Installs can rewrite tracked files.** `npm install` rewrites `package-lock.json`; `composer update` rewrites `composer.lock`. A clean worktree could come back **blocked** — with Cleanup as the cause. So rehydrate compares every tracked file before and after, and if the install changed any, the notification names them and the row says **rehydrate changed package-lock.json** until you commit or revert it. Using `npm ci` / `composer install` in `setup` avoids this.

**No `setup`, no rehydrate.** A worktree whose manifest declares no `setup` can still be dehydrated, but Cleanup can't bring its dependencies back — you'll run your own install. Its Dehydrate button says "Harnu cannot rehydrate it" before you click, the confirm dialog says it again, and afterwards the row reads **dehydrated · no setup** with no Rehydrate button.

### Dehydrating many at once

Select several Needs review blocks and click **Dehydrate** in the selection bar: it opens one confirm dialog listing every worktree, what will be removed from each, and the total. A single worktree is **Dehydrate** in its side panel or in its Needs review row. A worktree that is In use is offered Dehydrate once its last commit is at least a week old. That one-week threshold is the `dehydrateIdleDays` setting in `reaper-prefs.json` in Harnu's settings folder; there's no control for it in **Settings → Cleanup** yet. Dehydration is always something you click; Cleanup never dehydrates on its own.

### How big, and how honest the number is

Every folder row now shows its size, and the Dehydrate button's tooltip says how much it frees. Sizes come from `du`, cached between scans. Three things to know:

- **On Windows there are no sizes.** Cleanup doesn't guess: the button says "Dehydrate" without a figure and the dialog says "size unknown". Deep `node_modules` folders on Windows can also fail to delete (`EPERM`, long paths); when one does, the dialog shows that folder's error and the rest go ahead.
- **pnpm's figure is materially wrong.** pnpm hardlinks packages from a global store, so `du` counts those bytes in full — but removing `node_modules` frees none of them until you prune the store (`pnpm store prune`). For npm and Composer the figure is honest. If you check it against `df`, this is why they disagree.
- **A figure can be up to a few hours stale** for a worktree whose top-level folders haven't changed; a dehydrate or rehydrate always refreshes it.

Each row is labelled with the shortest thing that identifies it: the branch name for branches and worktrees; for an archived folder or a detached worktree — neither of which has a branch — its path relative to the repo when it lives inside the repo, and otherwise the folder's own name. Harnu's own managed worktrees sit at `.claude/worktrees/<name>` inside the repo, so that is the usual shape. Hover the row — in Cleanup or in the confirm dialog — to see the full path on disk in a tooltip.

## Deleting something

Worktrees are cleaned through the hero button, **Clean now**, or **Remove selected**, described above. The leftover branches and folders under **Other leftovers** share one confirm dialog, whether you click the trash icon on a single row or **Sweep** (which bundles every currently-harvestable one). Both paths follow these rules:

- **Folders go to the system trash**, not permanent deletion — recoverable the normal OS way.
- **Local branches stay recoverable via `git reflog`** for about 30 days, git's own default.
- **Remote branches are opt-in and off by default.** If any item in the batch would also delete a branch on `origin`, the dialog shows an amber warning and a toggle you have to turn on explicitly — deleting something on a shared remote never happens silently, even inside a bulk sweep.
- Every action — success or failure — is written to the **cleanup journal** at the bottom of the view, with a one-click "copy restore command" (`git branch <name> <sha>`) for anything that turns out to be needed back.
- If an item fails partway through (say, git refuses the branch delete), the dialog keeps that failure visible with its exact error instead of hiding it behind a generic "something went wrong."

## Nothing is deleted before a copy exists

Before Cleanup trashes a folder or deletes a branch, it writes what would be lost into two git refs that outlive the sweep. If the archive can't be written, that item is abandoned with the reason shown — Cleanup never deletes and then discovers it couldn't preserve.

The two refs live under a namespace of their own, one per branch per sweep:

```
refs/archive/<branch>/<timestamp>/tip   # the branch tip — the commits
refs/archive/<branch>/<timestamp>/wip   # the working state — what the tip does not hold
```

The **wip** ref is the one that matters most. A branch tip preserves commits, and the work people actually lose is the work that was never committed: modified files, and untracked ones — that half-written ADR that existed nowhere else. Cleanup captures both, from the worktree exactly as it stood the moment before deletion.

**Files matched by `.gitignore` are not archived.** That's deliberate: `node_modules`, `dist`, and build output are regenerable, and leaving them out is why archiving every branch in a large repo costs tens of megabytes instead of tens of gigabytes.

Your own `git stash` stack is never touched. The stash is shared across every worktree in a repo, so Cleanup builds its archive commit directly instead — running a sweep can never collide with a stash you or another session pushed.

### Getting something back

List what was preserved, for one repo:

```bash
git for-each-ref --format='%(refname) %(committerdate:short)' refs/archive/
```

The cleanup journal records both ref names on every entry too, so you can go straight to the one you want.

To recover the uncommitted work, check the **wip** ref out into a scratch worktree and copy out what you need:

```bash
git worktree add --detach /tmp/recovered refs/archive/<branch>/<timestamp>/wip
```

To bring the branch itself back, use the tip:

```bash
git branch <branch> refs/archive/<branch>/<timestamp>/tip
```

These refs are permanent until you remove them — `git gc` will not collect them, because they're real refs. When you're sure you don't need one, delete it with `git update-ref -d <refname>` (or drop a whole sweep with `git for-each-ref --format='%(refname)' 'refs/archive/<branch>/**' | xargs -n1 git update-ref -d`).

## Degraded mode without `gh`

Cleanup works without the GitHub CLI installed, just with less certainty: PR/review/CI checkpoints show as "not applicable" instead of green, and the merge decision falls back to git alone. A branch Cleanup cannot prove is merged shows **insufficient signal** and stays locked — Cleanup never invents a merge signal just because `gh` isn't around to contradict it.

Falling back to git used to mean one check — is this branch an ancestor of the default branch? — and on a repo that squash-merges, that check is false for essentially everything. Squashing rewrites the branch's commits into one new commit on `main`, so the branch's own commits are not in `main`'s history and never will be. On one real repo the ancestor check was true for **2 of its 141 branches**. Every other merged worktree read as unmerged, and without `gh` there was nothing to correct it.

So there are now two git-side checks:

- **Is the branch an ancestor of the default branch?** The cheap one. True for ordinary merge commits and fast-forwards.
- **Does the branch's content already exist in the default branch?** Cleanup takes the branch's net diff against where it forked, reduces it to a _patch id_ — a fingerprint of the change itself, independent of commit hashes — and looks for that fingerprint among the default branch's recent commits. A squash commit has exactly that fingerprint, which is how a squash-merged branch is recognized with no PR data at all. On that same repo this recovered **19 branches** the ancestor check missed.

Three things about the second check are deliberate, and worth knowing when you read a row:

- **Only a match counts.** Finding the fingerprint proves the branch's work is in the default branch. _Not_ finding it proves nothing — a merge that resolved conflicts changes the diff, and Cleanup only looks back a bounded stretch of history. A branch it can't prove reads **containment not proven**, never "not merged".
- **An empty branch is not a merged branch.** A branch whose net change is nothing at all — a commit and its revert — has no fingerprint to match, and Cleanup treats that as unproven rather than as containment.
- **It writes nothing.** The check only reads diffs. Scanning is inventory, and a background scan that runs every hour must not leave anything behind in your repos.

### When two branches share one upstream

Branch off a branch you've already pushed, never push the new one, and both local branches track the same remote branch. Cleanup can follow that link to find a PR the second branch would otherwise have no record of — but a PR found that way is only credited when the branch's tip is actually the PR's head commit, or its content is provably in the default branch. Otherwise the sibling branch would inherit "merged" from a PR it has nothing to do with, while still carrying commits nobody has merged. This is headroom rather than a common win: on the repo that motivated it, it recovers nothing, and that is the guard working.

An uncredited PR still shows on the sibling's row, because the relationship is real — if that upstream has an open PR, you want to know. But it is labelled as what it is: the PR step reads **PR · upstream**, and the PR, Review, CI and Merged checkpoints are drawn **hollow** instead of solid. Hover one and it tells you the fact comes from a shared upstream, not the branch's own PR. A solid green or red dot is always a fact about the branch itself. **In main** doesn't read an uncredited PR either: without a PR of its own, a branch whose containment can't be proven shows **containment not proven** rather than "not merged".

### "Not applicable" now means Cleanup actually looked

There are two different reasons Cleanup can have no PR to show you, and it used to render them identically.

It asked GitHub for the 100 most recent pull requests and read anything missing from that answer as _there was never a PR_ — the dimmed "not applicable" checkpoints. On a repo with 169 PRs that inference was wrong for every branch whose PR merged more than 100 PRs ago: `gh` had not been silent, it had been cut off. Those worktrees showed a fully dimmed PR chain and never became harvestable, no matter how cleanly they had merged. On one real repo the 100-PR window covered 11 of its 143 local branches.

Now:

- **Cleanup asks for the whole list**, not the first hundred. On any repo below a thousand PRs that alone ends the problem.
- **When the list still comes back capped, Cleanup says so.** A branch it has no answer for reads **unknown** — the dashed "?" — rather than a confident "not applicable". Hover that PR step and it tells you why: "PR list was capped". A dimmed PR checkpoint now means Cleanup saw the complete list and your branch was not in it.
- **It fills the gaps by asking about individual branches**, a handful per scan, worktrees first. What it learns is remembered between scans — both the PRs it finds and the branches that genuinely never had one — so it doesn't re-ask the same questions on every hourly background scan. Anything it hasn't got to yet stays honestly unknown rather than being asserted either way.

A branch stuck at "PR list was capped" resolves itself on a later scan, or immediately if you hit **Scan now** — which also re-asks about branches it had previously concluded had no PR, in case one has since been opened.

## Automatic cleanup (the autopilot)

The autopilot cleans **Ready to clean** worktrees on a timer, with no click. It is **off** until you turn it on (the **Enable autopilot** banner, or Settings → Cleanup), and it only ever acts on the first group in the table above.

**"Merged for real"** is stricter than a green merged checkpoint. It means git itself shows the branch's work is in the default branch (as an ancestor, or as the same change squashed), or GitHub says the pull request merged **and** that pull request's last commit is the commit the worktree has checked out. A branch that kept getting commits after its pull request merged therefore lands in Needs review, not Ready to clean. A branch whose remote was deleted after a closed pull request is also Needs review, never Ready to clean.

**"No session"** means no running process. A past conversation in that folder, or a parked session, does not block cleaning. A session that is open but idle moves the worktree to Needs review, because Harnu never ends a process on its own.

### The first run only reports

Turning the autopilot on does not clean anything. The first cycle runs the same checks and stops at the count: _"Found 12 ready items, 6.0 GiB — enable autopilot?"_ This is the banner described above. Nothing is deleted until you acknowledge that report, and acknowledging is a separate step from turning the autopilot on (the banner's **Enable autopilot** does both at once). From the next cycle on, it cleans, at most **20 worktrees per cycle** by default (the oldest first; the rest wait for the next cycle). A cycle that cleaned something posts one notification with how much it freed.

The cycle runs on the same timer as the background scan, right after it, so switching the background scan off also stops the autopilot. A cleaning job you started by hand takes priority: a cycle that comes due waits for it, and a manual request made during a cycle waits for the cycle.

### What a worktree cleanup does, in order

For each worktree, one at a time, stopping at the first problem for that worktree only:

1. Check again that nothing changed since the scan (a session started, the branch got a new commit, a container came up, the grace period no longer holds). If it did, the worktree is skipped and shows up again on the next scan.
2. Stop and remove the Docker containers that run only from this worktree. A stack that also runs from somewhere else is never touched, and the worktree moves to Needs review.
3. **Keep the volumes.** Cleaning a worktree, by hand or automatically, never removes a Docker volume: Harnu could not reliably prove that a volume belongs to only one worktree (a compose file in a subfolder, a `name:` in the compose file or a project name shared with the main checkout all fooled the check). Once the worktree is gone its volumes show up under orphan volumes in Needs review, with their size and compose project, for you to remove one by one.
4. Remove installed dependencies.
5. Archive the branch tip and the working state, then move the folder to the system trash, prune the worktree entry and delete the local branch.

Remote branches are never deleted by the autopilot. If a step fails, the worktree appears in Needs review as _"Cleanup stopped at trash: …"_ and the autopilot leaves it alone for a day.

### Docker housekeeping

In the same cycle, when the Docker cache setting is on, Harnu runs `docker builder prune` for build cache older than the max age (7 days by default) and `docker image prune` for dangling images, and adds the bytes they report to the cycle's total. It never runs `-a` variants, so an image a stack uses is never removed.

**Orphan volumes are not cleaned automatically.** A volume that no container uses and whose compose project's folder no longer exists is listed in Needs review with its size, its compose project and the reason "no known worktree". That includes the volumes a worktree cleanup left behind: Harnu remembers which folder each cleaned worktree's project ran from, so they are recognized even though the containers are gone. It is removed only when you ask for it and confirm. Harnu keeps a volume when it cannot tell whether it is orphaned: a folder that still exists pins the compose project name (by its folder name, by `COMPOSE_PROJECT_NAME` in its `.env`, or by a `name:` in its compose file), a folder it cannot read counts as existing, and a project whose folder it cannot learn is left alone.

### Removing a Needs review item on purpose

Needs review items are removed only after you confirm, and the confirmation is for what you were looking at: if the worktree changed between your click and the job (a new commit, a Docker stack that started, a different reason it is listed), Harnu refuses it with _changed since you confirmed_ and you look again. Confirming one item never confirms another, and an orphan volume needs its own confirmation. The same check applies to a worktree you remove by hand that Harnu already considers finished. Before anything is stopped or deleted, Harnu writes the branch tip and the working state (tracked and untracked files) to `refs/archive/…`; if that fails, nothing is touched. It still refuses a worktree with a running session, a folder whose Docker stacks changed since the scan, a main checkout, a path on your never-clean list and a worktree with a detached HEAD (there is no branch to preserve or delete). The branch is then deleted even though git does not consider it merged, because its tip is archived.

### What you can get back

| What                                        | Restorable? | How                                                                                                                                                                                                                           |
| ------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Code, uncommitted work and the local branch | Yes         | The `refs/archive/…` refs and the system trash. The cleanup journal line carries the command.                                                                                                                                 |
| Containers                                  | Yes         | `docker compose -p <project> --project-directory <folder> up -d`, while the folder exists.                                                                                                                                    |
| Dependencies                                | Yes         | Rehydrate, which re-runs the repo's `setup`.                                                                                                                                                                                  |
| **Volumes**                                 | **No**      | A removed volume and its data are gone. This is the only step that cannot be undone, so no cleanup ever does it: a volume is removed only when you confirm that one volume, and Harnu checks it is still what you were shown. |

On Windows, sizes are not measured, so the report shows counts without a byte total. pnpm's hard-linked store means removing `node_modules` frees less than the figure shown until the store is pruned.

## Automatic background scans

Cleanup doesn't need to be open to keep working. By default it re-scans every known repo once an hour and quietly records a notification-center entry — no toast, no sound, no OS alert — whenever the scan finds items that just became harvestable. Open the notification to jump into Cleanup.

Everything about the background scan is tunable in [Settings → Cleanup](settings.md#cleanup):

- **Automatic background scan** — turn it off entirely if you'd rather trigger scans manually with the **Scan now** button. This also stops the autopilot.
- **Run every** — 30 minutes, 1 hour (the default), 6 hours, or daily. One timer drives the scan and the autopilot, so there is one setting for both.
- **Notify when items become harvestable** — turn off the notification-center entry if you'd rather just glance at the footer pill when you feel like it.
- **Minimum age** — wait this many days after a branch becomes harvestable before flagging it, useful if you don't want to be told about something the moment its PR merges.
- **Protected branches** — extra branch names (beyond the repo's default branch) that Cleanup never scans, comma-separated.
- **Never delete remote branches** — a kill switch. Turning this on hides the remote-delete toggle in the sweep dialog everywhere, _and_ Harnu itself refuses any remote deletion while it's on, even if something upstream asks for one — the setting is enforced, not just hidden.

The background scan uses the same classifier as **Scan now** and respects the same live-session guard: a folder with a running Harnu session is never touched, scheduled or not.
