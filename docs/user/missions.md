# Missions

A **mission** is one body of work that an agent keeps track of for you across sessions: what it is for, how far it has got and what is waiting on you. This page covers the **Mission pane**, the way you see a mission in Harnu.

> **Where this stands.** Harnu is moving to a new kind of mission (version 4) and the Mission pane is the first piece you can see. Agents cannot create a version 4 mission yet (the commands for that arrive in a later update), so today the pane has a mission to show only if a version 4 mission file already exists in your repo. Missions you already have (version 3) are unchanged: they keep their pill and their popover. This page says what the pane does today; it grows as the rest lands.

## The pill

When the session you have selected belongs to a version 4 mission, a pill appears in the top bar, after the session's name:

- **4/21 · 3 for you** — 4 of 21 steps are done and 3 things are waiting on you. If the mission has milestones, the count is milestones instead (**1/10 · 5 for you**).
- **4/21** — nothing is waiting on you right now.
- **21/21 · ready to close** — everything is done.

The numbers come straight from Harnu's count of the mission; the pill never works them out itself. An amber pill means something waits on you, a blue one means nothing does and a green one means the mission is ready to close.

A session with no mission shows no pill. A session whose mission is a version 3 mission shows the same pill and popover it always had.

## Opening the pane

Click the pill to open the **Mission pane** in the helper stack, next to your session. Click it again (or the **×** in the pane's header) to close it. The pill looks pressed while the pane is open. The keyboard shortcut for "Open mission progress" does the same thing. You can expand or maximize the pane like any other pane in the stack, and it comes back after a restart.

There is one Mission pane per folder or worktree.

## What the pane shows

The pane **follows the session you have selected** and shows only that session's mission. Pick another session in the sidebar and the pane changes with it. It checks for changes about every 20 seconds, so a number can lag the real state by a little.

At a glance, from top to bottom:

- the mission's **title**;
- a **progress bar** with the count written inside it: **4 of 21 steps done**, or **1 of 10 milestones done** when the mission has milestones. The bar fills in as steps are done. There is no "Done when" paragraph;
- **Ready to close** when every step is done;
- **Your next step**: one box with what to do and why it matters. If more than one thing waits on you, **N more waiting on you** opens the rest right there, and **Show less** folds them again. When nothing waits on you, the box says what is running instead ("2 steps are running. Nothing for you right now.");
- the **tree** of the mission.

### The tree

Below the next step, the mission is a tree: milestone, then step, then criteria. Every row has a chevron: click it to open or close the row.

- **Only the current milestone opens by itself.** That is the first milestone that is neither done nor optional. Open any other one with its chevron.
- A line joins the milestone dots like a timeline. It is **green behind a finished milestone** and grey ahead, and it runs down through an open milestone's steps.
- Under an open milestone, a summary line counts what is **running**, **waiting for review** and **blocked** ("4 running · 9 waiting for review · 1 blocked"). Steps that have not started are not counted. A milestone's count on the right is its finished steps out of its steps ("4/4").
- Inside a milestone the steps you owe something on come **first** (marked **Yours**), then the running ones. Every other step is folded behind **N more steps**; click it to see them all, and again (**Show less**) to fold them.
- A step shows its pull request number (**#256**) when it has one, and a **Blocked** mark when something stops it. Open a step to see its criteria; a ticked criterion is settled and an empty box is not yet.
- If a milestone has to wait for one that is not the one just before it, it says **Waits for "…"** and names it. It stops saying so once that milestone is done.
- Optional milestones sit under one line at the bottom ("2 optional milestones"); click it to see them.
- A mission with no milestones shows its steps directly, in the same order.

In a narrow pane the tree wraps: step titles take up to two lines and a step's marks move under its title.

Your next step has one button, **Open step**: it opens that step in the tree and brings it into view. Items that need another action (closing the mission, letting a session join, marking a criterion done) show their text but no button yet.

It can also say:

- **This session has no mission.** The selected session is not attached to a version 4 mission. A mission you closed also ends up here.
- **This mission cannot be read right now.** Harnu could not read the mission file. The reason is printed under it.
- **This mission is still a v3 mission.** The session has a version 3 mission, which the pane does not draw. Open it from the pill at the top.

## What you cannot do yet

- **Create a version 4 mission.** Agents cannot create one yet.
- **Act on a mission from the pane.** There are no buttons for marking a criterion, clearing a blocker, closing the mission or handing it to a new session yet. The pane only reads.
- **See more of an open step.** Opening a step lists its criteria, but not who settles each one, its blocker or the links its session left. Those arrive next.
- **Ask a milestone a question, see the sessions that worked on it or move it to a new session.** Not in the pane yet.

## Related

- [Agent control](agent-control.md) — what a session can do with missions today, through its Harnu commands.
- [Sessions](sessions.md) — the helper stack and its panes.
