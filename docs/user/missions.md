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

For now the pane shows:

- the mission's **title**;
- a line such as **4 of 21 steps done** (or **1 of 10 milestones done**);
- **Ready to close** when every step is done.

It can also say:

- **This session has no mission.** The selected session is not attached to a version 4 mission. A mission you closed also ends up here.
- **This mission cannot be read right now.** Harnu could not read the mission file. The reason is printed under it.
- **This mission is still a v3 mission.** The session has a version 3 mission, which the pane does not draw. Open it from the pill at the top.

## What you cannot do yet

- **Create a version 4 mission.** Agents cannot create one yet.
- **Act on a mission from the pane.** There are no buttons for marking a criterion, clearing a blocker, closing the mission or handing it to a new session yet. The pane only reads.
- **See the steps.** The progress bar, your next step, the list of milestones and steps and the timeline are not in the pane yet.

## Related

- [Agent control](agent-control.md) — what a session can do with missions today, through its Harnu commands.
- [Sessions](sessions.md) — the helper stack and its panes.
