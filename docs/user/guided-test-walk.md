# Guided test walk

A **guided walk** takes you through a list of things only your eyes can check, one at a time: that a feature you just had built does what it should, that a colleague's pull request really works, that a mission's step is done. It opens as a pane beside your session. Nothing in the pane is written by hand each time: the session that knows the work sends the list, and Harnu draws it the same way every time.

This page covers the pane you walk in. How a session writes and reads a walk is in [Agent control](agent-control.md#guided-walks).

## Starting one

Say it in any session: "walk me through what we just built", "test PR #48 with me" (in your own language, or `/harnu:walk`). The session writes the checks and the walk opens in the background in the folder's split stack, like a report or a canvas; it never takes the focus from what you are doing. If you close the pane before you press **Start with 1**, that unstarted run is thrown away (the walk itself stays saved). If you close it after you started, the walk stays where it was and the pane picks it up again when you reopen it, even after a restart.

The first line under the pane header is the **source**: what this walk is about. For a pull request it reads `PR #48 · title · author` and clicking it opens the PR in a browser pane (the copy button beside it takes the link). For a mission it names the step, milestone or the whole mission and opens the Mission. A branch reads `branch → base`, a board card its slug, and a feature walk its short description. On a re-run a `Re-run · run N` chip sits at the right.

## The roadmap

A walk opens on its **roadmap**: every check as a row with its glyph, the checks already verified before the walk with their evidence, and how each open one will be checked (**Your eyes only**, or **I check** and the command the session will run). Anything the session left out on purpose is one folded line. The only action is **Start with 1** (press `Enter`).

If you already walked the same thing before, the roadmap starts with one line: "Re-run the saved walk (4 of 6 passed)?". Accepting it starts a new run of the saved walk and drops the new one, which was never started.

Later, the list icon beside the progress (or `L`) opens the same rows read-only, with where each check stands. `Esc` closes it.

## One check at a time

The pane shows exactly one check. Under the title:

- **Do**: the steps, numbered. Every command is a block with a **Copy** button, and every `value` in the text copies with one click.
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

If something is still owed (skipped, failed or unverified checks, or "re-check 3 after #52 merges"), a **Still yours** card says so. For a walk whose source is a mission it also shows each criterion and whether it is still open, with a link to the Mission. **The walk never ticks a criterion for you**: pressing Done does not, and nothing in the pane does. You tick it yourself, in the Mission.

A card says the walk is saved in Walks, on this machine, in the repo's `.harnu/walks/` folder (private and never committed). The Walks list, the run history, Re-run and Export are coming in a later update; for now the saved walk is read by the session and shows up again when you reopen its pane.

## If the session is gone

If a message for the session has waited and no session took it (it ended, or it is not running), the pane shows **The session is gone** with a note that your progress is saved. **Resume the session** brings the walk's session back, and the waiting messages are sent again. The error text next to it copies with one click.

## Good to know

- The pane is drawn with the same tokens as the rest of Harnu, in English and Portuguese, in light and dark.
- A walk survives closing the pane, restarting the app and a session being parked.
- The session cannot press your buttons: it can add to the walk and answer your Done, but only you answer a check.
