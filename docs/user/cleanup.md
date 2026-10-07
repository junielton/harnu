# Cleanup

A guarded view of every branch and worktree you can safely delete — merged worktrees, orphan local branches, hidden archived folders, and stale remote branches — with a checkpoint timeline showing exactly why each one is or isn't safe to remove. Worktrees that Cleanup cannot judge, because they have no branch at all, are listed too rather than hidden.

## Why it exists

Working across many worktrees and branches leaves a trail: merged worktrees nobody removed, local branches whose PRs shipped weeks ago, folders you archived and forgot about. Cleanup finds all of it, explains its reasoning for each item, and only offers to delete what it can actually prove is safe.

## Opening it

Cleanup takes over the main pane, the same way the Roadmap board, Usage Dashboard, and System Monitor do — sidebar and topbar stay put.

- Click the **Cleanup** pill in the footer (bottom-right, next to the fleet summary). It only appears once something is actually harvestable, with a count badge. The pill is a toggle — it turns accent-colored while Cleanup is open, and clicking it again puts you back in your session (Esc and clicking any session do the same).
- Right-click a repo-group header in the sidebar and choose **Cleanup…** — this opens the same view and scrolls to that repo's section.

## What "harvestable" means

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

They now get a row of their own, labelled **detached worktree**, showing the folder, how old the commit it sits on is, and how much disk it takes. (The commit sha itself is recorded but not yet on the row — it needs a slot on the meta line that doesn't exist yet.) Because there is no branch, there is no PR, no ancestry and no remote to check — so every branch checkpoint reads as "not applicable" rather than borrowing an answer from a branch that happens to point at the same commit.

**A detached worktree is never harvestable and can never be swept**, on its own or inside a bulk sweep. It is listed as **blocked**, with "detached HEAD — no branch" as the reason — unless a Harnu session is running in that folder, in which case Cleanup hides it while the session is live, exactly as it does for every other folder in use. Cleanup is telling you the folder is there and costing you disk, not that it is safe to delete. Most of that disk is usually installed dependencies, and **Dehydrate** reaches detached worktrees like any other (see below) — it needs no branch. To reclaim the checkout itself, attach it to a branch (`git switch -c <name>`) so the normal checkpoints apply, or remove it yourself with `git worktree remove`.

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

A dehydrated worktree's row reads **dehydrated** and offers **Rehydrate** (the package-with-a-plus icon), which re-runs the `setup` commands from the repo's `WORKTREE.md` in that worktree — the same recipe Harnu used to create it. While it runs the row reads **rehydrating…**. If a step fails, the notification names the stage, the exact command, and whether the tool was missing (with the `PATH` Harnu's setup shell searched) or ran and errored — the same report worktree creation gives you.

**Installs can rewrite tracked files.** `npm install` rewrites `package-lock.json`; `composer update` rewrites `composer.lock`. A clean worktree could come back **blocked** — with Cleanup as the cause. So rehydrate compares every tracked file before and after, and if the install changed any, the notification names them and the row says **rehydrate changed package-lock.json** until you commit or revert it. Using `npm ci` / `composer install` in `setup` avoids this.

**No `setup`, no rehydrate.** A worktree whose manifest declares no `setup` can still be dehydrated, but Cleanup can't bring its dependencies back — you'll run your own install. Its Dehydrate button says "Harnu cannot rehydrate it" before you click, the confirm dialog says it again, and afterwards the row reads **dehydrated · no setup** with no Rehydrate button.

### Dehydrating many at once

Each repo group's header offers **Dehydrate N idle** next to its Sweep button: every dehydratable worktree in that repo whose last commit is at least a week old. It opens the same confirm dialog, listing every worktree, what will be removed from each, and the total. The one-week threshold is the `dehydrateIdleDays` setting in `reaper-prefs.json` in Harnu's settings folder; there's no control for it in **Settings → Cleanup** yet. Dehydration is always something you click — Cleanup never dehydrates on its own.

### How big, and how honest the number is

Every folder row now shows its size, and the Dehydrate button's tooltip says how much it frees. Sizes come from `du`, cached between scans. Three things to know:

- **On Windows there are no sizes.** Cleanup doesn't guess: the button says "Dehydrate" without a figure and the dialog says "size unknown". Deep `node_modules` folders on Windows can also fail to delete (`EPERM`, long paths); when one does, the dialog shows that folder's error and the rest go ahead.
- **pnpm's figure is materially wrong.** pnpm hardlinks packages from a global store, so `du` counts those bytes in full — but removing `node_modules` frees none of them until you prune the store (`pnpm store prune`). For npm and Composer the figure is honest. If you check it against `df`, this is why they disagree.
- **A figure can be up to a few hours stale** for a worktree whose top-level folders haven't changed; a dehydrate or rehydrate always refreshes it.

Each row is labelled with the shortest thing that identifies it: the branch name for branches and worktrees; for an archived folder or a detached worktree — neither of which has a branch — its path relative to the repo when it lives inside the repo, and otherwise the folder's own name. Harnu's own managed worktrees sit at `.claude/worktrees/<name>` inside the repo, so that is the usual shape. Hover the row — in Cleanup or in the confirm dialog — to see the full path on disk in a tooltip.

## Deleting something

Every deletion goes through the same confirm dialog, whether you click the trash icon on a single row or the **Sweep** button in the toolbar (which bundles every currently-harvestable item):

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

> **Half-built, on purpose.** The engine below ships and runs, but its screen does not exist yet. Today there is no button for it: the autopilot is off, and you turn it on by editing `gc-prefs.json` in Harnu's settings folder (see [Settings](settings.md#automatic-cleanup)). The unified Cleanup screen that shows the three groups below, a progress bar for background cleaning and the controls arrives in the next Cleanup update.

Cleanup used to sort a worktree by one question, "is the branch merged?". The autopilot sorts every worktree into one of three groups by what the branch is and what is happening in the folder, and only ever acts on the first.

| Group      | What it means                                                                                                                                                                                                                                                                                                               | What happens                                                                                     |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Corpse** | The branch is merged for real, nothing in the folder is uncommitted or unpushed, no Harnu session is running in it, and it has been quiet for the grace period (2 days by default).                                                                                                                                         | The autopilot removes it, with the Docker stack running from it. You can also remove it by hand. |
| **Decide** | Something is unclear: the branch was closed without merging, the remote branch is gone, the worktree has a detached HEAD, GitHub could not be reached, it has uncommitted or unpushed work, the merge is only inferred, a session is open but idle, another stack shares the folder, or an earlier cleanup stopped partway. | Nothing is touched. The reason is one sentence. You decide.                                      |
| **Alive**  | The pull request is still open, a session is working or waiting for you, or the worktree is within its grace period. Also: a main checkout, anything on your never-clean list, anything you marked Keep.                                                                                                                    | Never touched.                                                                                   |

**"Merged for real"** is stricter than a green merged checkpoint. It means git itself shows the branch's work is in the default branch (as an ancestor, or as the same change squashed), or GitHub says the pull request merged **and** that pull request's last commit is the commit the worktree has checked out. A branch that kept getting commits after its pull request merged therefore lands in Decide, not Corpse. A branch whose remote was deleted after a closed pull request is also Decide, never Corpse.

**"No session"** means no running process. A past conversation in that folder, or a parked session, does not block cleaning. A session that is open but idle moves the worktree to Decide, because Harnu never ends a process on its own.

### The first run only reports

Turning the autopilot on does not clean anything. The first cycle runs the same checks and stops at the count: _"Found 12 corpses, 6.0 GiB - enable automatic cleanup?"_ Nothing is deleted until you acknowledge that report, and acknowledging is a separate action from turning the autopilot on. From the next cycle on, it cleans, at most **20 worktrees per cycle** (the oldest first; the rest wait for the next cycle). A cycle that cleaned something posts one notification with how much it freed.

The cycle runs on the same timer as the background scan, right after it, so switching the background scan off also stops the autopilot. A cleaning job you started by hand takes priority: a cycle that comes due waits for it, and a manual request made during a cycle waits for the cycle.

### What a worktree cleanup does, in order

For each worktree, one at a time, stopping at the first problem for that worktree only:

1. Check again that nothing changed since the scan (a session started, the branch got a new commit, a container came up, the grace period no longer holds). If it did, the worktree is skipped and shows up again on the next scan.
2. Stop and remove the Docker containers that run only from this worktree. A stack that also runs from somewhere else is never touched, and the worktree moves to Decide.
3. Remove the named volumes only those containers used (the **Remove volumes** setting; on by default).
4. Remove installed dependencies.
5. Archive the branch tip and the working state, then move the folder to the system trash, prune the worktree entry and delete the local branch.

Remote branches are never deleted by the autopilot. If a step fails, the worktree appears in Decide as _"Cleanup stopped at trash: …"_ and the autopilot leaves it alone for a day.

### Docker housekeeping

In the same cycle, when the Docker cache setting is on, Harnu runs `docker builder prune` for build cache older than 7 days and `docker image prune` for dangling images, and adds the bytes they report to the cycle's total. It never runs `-a` variants, so an image a stack uses is never removed.

**Orphan volumes are not cleaned automatically.** A volume that no container uses and whose compose project's folder no longer exists is listed in Decide with its size, its compose project and the reason "no known worktree". It is removed only when you ask for it and confirm. Harnu keeps a volume when it cannot tell whether it is orphaned: a folder that still exists pins the compose project name (by its folder name, by `COMPOSE_PROJECT_NAME` in its `.env`, or by a `name:` in its compose file), a folder it cannot read counts as existing, and a project whose folder it cannot learn is left alone.

### Removing a Decide item on purpose

Decide items are removed only after you confirm, and the confirmation is for what you were looking at: if the worktree changed between your click and the job (a new commit, a Docker stack that started, a different reason it is listed), Harnu refuses it with _changed since you confirmed_ and you look again. Confirming one item never confirms another, and an orphan volume needs its own confirmation. The same check applies to a worktree you remove by hand that Harnu already considers finished. Before anything is stopped or deleted, Harnu writes the branch tip and the working state (tracked and untracked files) to `refs/archive/…`; if that fails, nothing is touched. It still refuses a worktree with a running session, a folder whose Docker stacks changed since the scan, a main checkout, a path on your never-clean list and a worktree with a detached HEAD (there is no branch to preserve or delete). The branch is then deleted even though git does not consider it merged, because its tip is archived.

### What you can get back

| What                                        | Restorable? | How                                                                                                                                                                                                                            |
| ------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Code, uncommitted work and the local branch | Yes         | The `refs/archive/…` refs and the system trash. The cleanup journal line carries the command.                                                                                                                                  |
| Containers                                  | Yes         | `docker compose -p <project> --project-directory <folder> up -d`, while the folder exists.                                                                                                                                     |
| Dependencies                                | Yes         | Rehydrate, which re-runs the repo's `setup`.                                                                                                                                                                                   |
| **Volumes**                                 | **No**      | A removed volume and its data are gone. This is the only step that cannot be undone, and it is the reason the autopilot only removes volumes that belong to a worktree it is cleaning, and only when **Remove volumes** is on. |

On Windows, sizes are not measured, so the report shows counts without a byte total. pnpm's hard-linked store means removing `node_modules` frees less than the figure shown until the store is pruned.

## Automatic background scans

Cleanup doesn't need to be open to keep working. By default it re-scans every known repo once an hour and quietly records a notification-center entry — no toast, no sound, no OS alert — whenever the scan finds items that just became harvestable. Open the notification to jump into Cleanup and sweep.

Everything about the background scan is tunable in **Settings → Cleanup**:

- **Automatic background scan** — turn it off entirely if you'd rather trigger scans manually with the **Scan now** button.
- **Scan interval** — 30 minutes, 1 hour (the default), 6 hours, or daily.
- **Notify when items become harvestable** — turn off the notification-center entry if you'd rather just check the footer pill's count when you feel like it.
- **Minimum age** — wait this many days after a branch becomes harvestable before flagging it, useful if you don't want to be told about something the moment its PR merges.
- **Protected branches** — extra branch names (beyond the repo's default branch) that Cleanup never scans, comma-separated.
- **Never delete remote branches** — a kill switch. Turning this on hides the remote-delete toggle in the sweep dialog everywhere, _and_ Harnu itself refuses any remote deletion while it's on, even if something upstream asks for one — the setting is enforced, not just hidden.

The background scan uses the same classifier as **Scan now** and respects the same live-session guard: a folder with a running Harnu session is never touched, scheduled or not.
