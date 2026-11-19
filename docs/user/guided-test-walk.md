# Guided test walk

A **guided walk** takes you through a list of things only your eyes can check, one at a time: that a feature you just had built does what it should, that a colleague's pull request really works, that a mission's step is done. It opens as a pane beside your session. Nothing in the pane is written by hand each time: the session that knows the work sends the list, and Harnu draws it the same way every time.

This page covers the pane you walk in. How a session writes and reads a walk is in [Agent control](agent-control.md#guided-walks).

## Starting one

Say it in any session: "walk me through what we just built", "test PR #48 with me" (in your own language, or `/harnu:walk`). This works because the bundled `walk` skill is **on by default**; you can switch it off in Settings → Skills, see [Bundled skills](bundled-skills.md#walk-is-on-by-default). The session writes the checks and the walk opens in the background in the folder's split stack, like a report or a canvas; it never takes the focus from what you are doing. If you close the pane before you press **Start with 1**, that unstarted run is thrown away (the walk itself stays saved). If you close it after you started, the walk stays where it was and the pane picks it up again when you reopen it, even after a restart.

The first line under the pane header is the **source**: what this walk is about. For a pull request it reads `PR #48 · title · author` and clicking it opens the PR in a browser pane (the copy button beside it takes the link). For a mission it names the step, milestone or the whole mission and opens the Mission. A branch reads `branch → base`, a board card its slug, and a feature walk its short description. On a re-run a `Re-run · run N` chip sits at the right.

## The roadmap

A walk opens on its **roadmap**: every check as a row with its glyph, the checks already verified before the walk with their evidence, and how each open one will be checked (**Your eyes only**, or **I check** and the command the session will run). Anything the session left out on purpose is one folded line. The only action is **Start with 1** (press `Enter`).

If you already walked the same thing before, the roadmap starts with one line: "Re-run the saved walk (4 of 6 passed)?". Accepting it starts a new run of the saved walk and drops the new one, which was never started.

Later, the list icon beside the progress (or `L`) opens the same rows read-only, with where each check stands. `Esc` closes it.

## One check at a time

The pane shows exactly one check. Under the title:

- **Do**: the steps, numbered. Every command is a block with a **Copy** button, and every `value` in the text copies with one click.
- **Back** leads with the undo: when the check you return to changed something, the pane first says how to reverse it, and a command in that line is a chip you copy with one click.
- **Where**: link chips (a PR, a file in the viewer, a page in a browser pane, a folder) and a path you have to click through. A path the session is not sure of is tagged `path approximate`. Each value has a copy button that puts the full text on the clipboard; the icon turns into a green check for a moment.
- **You should see**: the text to look for, a muted `✗ Not:` line saying what would be wrong, and, when there is one, a picture of the expected result. The picture is a 300 px thumbnail; click it to enlarge it, click it again for a full-pane view (`Esc` closes it).
- **I'll check**: what the session will check from its side when you press Done, or why nothing can be checked from here.

Above it all, **Check 3 of 9** and a thin strip with one cell per check (green for closed, the accent for the one you are on). Nothing else is written about progress.

### The five answers

Whenever a check is waiting for you, the bar at the bottom holds the same five buttons:

| Button           | Key           | What it does                                                                        |
| ---------------- | ------------- | ----------------------------------------------------------------------------------- |
| **Done**         | `Enter`       | You saw it. If the session can check it too, the check stays open until it answers. |
| **Failed**       | `F`           | Opens one line and a place to paste a screenshot. See below.                        |
| **Back**         | `B` or `Left` | Returns to the check before this one, whatever state it closed in.                  |
| **Skip**         | `S`           | Sets it aside; skipped checks come back as a list at the end.                       |
| **Explain more** | `E`           | Shows what was prepared for this check (see below). Press again to fold it.         |

`Enter` is Done only while the pane or the Done button has the focus. On a link, a copy button or another button it keeps its own meaning, and in a text field it sends. A second Done in the first 400 ms after a new check appears is ignored, so a held key cannot sail through two checks. Clicking a copy button or a link does not move the focus off the pane. The shortcuts are off while you are typing.

### When something does not work

Press **Failed**, write one line about what you saw and, if it helps, paste a screenshot (`Ctrl+V`). **Send** needs a line or an image. The image is saved inside the walk's own folder on this machine. A line that looks like a secret (a token, a password, a key) is flagged and held back until you change it, because the line goes to the session as your own words.

The session answers with **one** correction, drawn above the same check, and **Try again** (`Enter`) puts you back on it with the same five answers. There is no limit on how many times you can try. From the second failure a quiet link appears under the check: for a mission step it sends the problem to the step's builder, for a pull request it asks the session to draft a comment (a draft only, never posted for you), and for a feature, branch or card it asks for a bug card. The pane itself creates nothing.

### When the session's check disagrees

If you press Done and the session's own check finds something else, the pane shows what it ran, what it expected and what it found. A check nothing later depends on can be **Followed anyway (unverified)**; one that blocks later checks can only be tried again or **treated as failed**. If the session never answers, after 30 seconds a **Continue without the check** button appears; the check is then recorded as unverified, and a late answer from the session still upgrades or fails it.

### Explain more and "I didn't get this step"

**Explain more** reveals, without moving you off the check, what the session prepared: why it matters, and extra checks you can tick as you go. They never block Done; the ones you leave unticked are listed at the end. On a walk-through of a feature it teaches first: what the part does, where it lives (links that open the file at its line), the idea behind it, and why it behaves that way. If nothing was prepared, the press asks the session, and a quiet "Asking…" shows while it answers.

The quiet link **I didn't get this step** asks the session to say the same check more simply. The answer shows as a "Said more simply" card over the same check; a later press replaces it.

## The end

When no check is left, or you end the walk early with the pane's close button (it asks once: "End the walk and see the close-out?"), the pane shows the **close-out**. It is the report: one row per check with how it was verified (for example "you confirmed · my check agreed", "followed anyway", "skipped"), the extra checks you did not tick, and a copyable summary that the session received as one message too.

For a walk whose source is a mission, the close-out also has a **Mission criteria** list, one row per criterion the walk covers. **Closing the walk settles the criteria it verified, so you do not tick them twice.** A criterion of yours is settled only when two things agree: your **Done** and the session's own read-only check (it ran, and passed). Then the row reads "criterion settled by this walk", and the Mission records which walk, run and check settled it. Everything else stays open, and the row says why: "criterion still open: the check failed", "...the check was skipped", "...my check did not agree, or you continued without it", "...only your Done, with nothing for me to check", "...a second session settles it", "...another person approves it", "...Harnu reads it from the pull request or CI" or "...no check of this walk answered it". If you end the walk early, only what was verified up to then is settled. A closed or removed mission is left alone and the rows read "mission not available".

**Done alone never settles a criterion**: pressing Done, or any key, settles nothing while the walk runs, and the walk never settles one that a second session, another person or a pull request or CI settles. For a source other than a mission, nothing in any mission is touched.

If something is still owed (skipped, failed or unverified checks, "re-check 3 after #52 merges", or a criterion still open), a **Still yours** card says so. It lists only what is left, with a link to the Mission, where you tick a criterion yourself.

A card says the walk is saved in Walks, on this machine, in the repo's `.harnu/walks/` folder (private and never committed). Its **Open Walks** button opens the library, and **Export markdown** writes the walk as a Markdown file (see below).

## The Walks library

Every walk is kept, with all its runs, until you delete it. The **Walks** pane lists the repo's walks, newest run first. Open it from the library icon in a walk pane's header, from **Walks** in the folder's menu (right-click a folder), or from the **Walks** button in the top bar (it moves into the `…` menu when the bar is narrow). It shares one pane per worktree, so opening it twice shows the same one.

Each row has the walk's source icon, its title, where it comes from (`Mission`, `PR #48 · alex`, `Feature`, `Branch …`, `Card · …`), the date of its last run and how it ended: `4 of 6 passed` (with a `!` when anything did not pass), `in progress, check 4 of 9` for a run you have not finished, or `not walked yet`. There is no search and no filter.

- **Re-run** starts the walk again (see below).
- **Open** shows the last run read-only. On a run in progress it continues that run instead.
- The **⋯** menu on a row has **Delete…**. It asks once, on the row, and says when a run is in progress and goes with the walk. A deleted walk is gone, with its runs, its images, your screenshots and its exports.

With no walks, the pane shows how a walk starts and nothing else: ask a session, or use Test it in the Mission.

## A past run

Open on a finished run shows it **read-only**, as it was when it ended: `← Walks`, the title, `4 passed · 1 failed · 1 skipped`, a **Run** selector (`Run 3 · Nov 16`) with a `Read-only` chip, and one row per check with how it was verified. A failed or noted check also shows what you wrote, your screenshot (click it to see it larger), the session's one correction and what its check found. Checks added to the walk after that run are not shown in it.

The selector lists the walk's other runs; picking a finished one shows it, picking the one in progress continues it. The bottom bar has **Re-run** and **Export markdown**.

## Re-run

**Re-run** starts run `n + 1` of the same walk: the same checks, every one to do again (rows that were already verified before the first run are walked this time too), and nothing you answered before is pre-answered. The roadmap and each check carry a quiet `last time: passed`, `failed`, `skipped` or `not confirmed`; a check that failed shows what you wrote then. Earlier runs are never touched.

You cannot start a second run while one is in progress: Re-run opens the run that is. When you pressed Re-run but have not started the new run yet, pressing it again shows the same run, not a new empty one.

## Export markdown

**Export markdown** writes the walk as a Markdown file and opens it in the viewer: the title, where it comes from, every check in order (where, what to do with what you should see, what you should not see, what the session checks), links as links, and a **Last run** table with your notes. Files go in the walk's own folder, `.harnu/walks/<walk>/exports/<name>/`, together with the walk's images and your screenshots, so the folder can be copied as it is. An export never overwrites another: the next one gets a `-2`, then `-3`. Harnu commits nothing; to share a walk, copy that folder.

## If the session is gone

If a message for the session has waited for about 45 seconds and no session took it (it ended, or it is not running), the pane shows **The session is gone** with a note that your progress is saved. **Resume the session** brings the walk's session back, and the waiting messages are sent again. The error text next to it copies with one click.

## Good to know

- The pane is drawn with the same tokens as the rest of Harnu, in English and Portuguese, in light and dark.
- A walk survives closing the pane, restarting the app and a session being parked.
- When a message for a parked session has waited a few seconds, the pane says `Waking the session…` and stays on the check; only after about 45 seconds does it show **The session is gone**.
- The session cannot press your buttons: it can add to the walk and answer your Done, but only you answer a check.
