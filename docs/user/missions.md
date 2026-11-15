# Missions

A **mission** is one body of work that an agent keeps track of for you across sessions: what it is for, how far it has got and what is waiting on you. This page covers how you see and steer one: the **Mission pane**, the acceptance criteria that say when a step is done, handing a mission to a new session, and what happens to the missions an earlier version of Harnu wrote.

Every mission, old or new, opens in the Mission pane. An agent starts a mission by itself when its work will take several steps, so you do not have to ask for one.

## The pane

### The pill

When the session you have selected belongs to a mission, a pill appears in the top bar, after the session's name:

- **4/21 · 3 for you** — 4 of 21 steps are done and 3 things are waiting on you. If the mission has milestones, the count is milestones instead (**1/10 · 5 for you**).
- **4/21** — nothing is waiting on you right now.
- **21/21 · ready to close** — everything is done.

The numbers come straight from Harnu's count of the mission; the pill never works them out itself. An amber pill means something waits on you, a blue one means nothing does and a green one means the mission is ready to close.

A session with no mission shows no pill. A mission an earlier version wrote shows the same pill: see [Records from earlier versions](#records-from-earlier-versions).

### Opening the pane

Click the pill to open the **Mission pane** in the helper stack, next to your session. Click it again (or the **×** in the pane's header) to close it. The pill looks pressed while the pane is open. The keyboard shortcut for "Open mission progress" does the same thing. You can expand or maximize the pane like any other pane in the stack, and it comes back after a restart.

There is one Mission pane per folder or worktree.

### What the pane shows

The pane **follows the session you have selected** and shows only that session's mission. Pick another session in the sidebar and the pane changes with it. It checks for changes about every 20 seconds, so a number can lag the real state by a little.

When the session leads more than one mission, a label above the title says **This session leads 3 missions**, with a chooser under it that takes the whole width (its text is never squeezed out of view; hold the pointer over it to read the full title). The pane opens on the one that changed last. Choosing another only changes what the pane shows: it writes nothing to any mission. A session that only works on several missions has no chooser and shows the one that changed last.

The pane is built to be read in a small space (it usually sits at 300 to 420 pixels wide), so the first screenful is the part you need and the rest is one click away. Nothing is removed.

**The first screenful**, from top to bottom:

- the mission's **title**;
- a **progress bar** with the count written inside it: **4 of 21 steps done**, or **1 of 10 milestones done** when the mission has milestones. The bar fills in as steps are done, with a thin green line under the count that shows where the fill ends. The count is a single line; hold the pointer over it for the full text. There is no "Done when" paragraph;
- **Ready to close** when every step is done;
- **Your next step**: one box with what to do and why it matters. If more than one thing waits on you, **N more waiting on you** opens the rest right there, and **Show less** folds them again. When nothing waits on you, the box says what is running instead ("2 steps are running. Nothing for you right now.");
- anything else that waits on you and is not a line of that list: a session asking to join, and a new Done when to approve (see below).

**One click away.** These start closed, and the pane remembers what you open, even after a restart:

- **Steps and timeline**: the tree of the mission (next section). The closed line shows where the mission is, on its right: the current milestone, or "Every step is done". **Open step** in the next-step box opens this part for you and opens that step.
- **Sessions**: who worked on the mission (see [Hand-off](#hand-off)).
- **N more waiting on you**, in the next-step box.

In Portuguese, the words of the next-step box are Harnu's own, in Portuguese. What an agent wrote (a blocker's reason, a criterion, a step's title) is shown exactly as written.

#### The tree

Under **Steps and timeline**, the mission is a tree: milestone, then step, then criteria. Every row has a chevron: click it to open or close the row.

- **Only the current milestone opens by itself.** That is the first milestone that is neither done nor optional. Open any other one with its chevron.
- A line joins the milestone dots like a timeline. It is **green behind a finished milestone** and grey ahead, and it runs down through an open milestone's steps.
- Under an open milestone, a summary line counts what is **running**, **waiting for review** and **blocked** ("4 running · 9 waiting for review · 1 blocked"). Steps that have not started are not counted. A milestone's count on the right is its finished steps out of its steps ("4/4").
- Inside a milestone the steps you owe something on come **first** (marked **Yours**), then the running ones. Every other step is folded behind **N more steps**; click it to see them all, and again (**Show less**) to fold them.
- A step shows its pull request number (**#256**) when it has one, and a **Blocked** mark when something stops it. Click the number to open the pull request in your browser (it is plain text when Harnu does not know where the pull request is). Open a step to see what is in it: see "An open step" below.
- If a milestone has to wait for one that is not the one just before it, it says **Waits for "…"** and names it. It stops saying so once that milestone is done.
- Optional milestones sit under one line at the bottom ("2 optional milestones"); click it to see them.
- A mission with no milestones shows its steps directly, in the same order.

In a narrow pane the tree wraps: step titles take up to two lines and a step's marks move under its title.

**A very narrow pane.** The pane has no minimum width. Below about 240 pixels it switches to a tighter layout: less padding at the sides, text that wraps or shortens (hold the pointer over it for the full text), buttons that wrap onto their own line, and no sideways scrolling. The same controls are there at 110 pixels as at 420.

Your next step has one button, **Open step**: it opens that step in the tree and brings it into view. Items that need another action (closing the mission, letting a session join) show their text but no button yet.

#### An open step

Click a step to open it. It shows up to three parts, in this order: the blocker, its criteria and the links.

**The blocker**, when something stops the step. A red box says **Blocked · waiting for you · 40m** (how long it has been waiting) when it is yours to clear, or **Blocked · waiting for the session** when the session has to move. Under it is what is wrong, the exact thing that is needed, and what starts once it is done. When the blocker is yours, **Done, continue** clears it. Do that after you have done the thing; the box goes away and the step carries on. A blocker that belongs to the session has no button, because there is nothing for you to press.

**Acceptance criteria.** The criteria of the step and who settles each of them: see [Acceptance criteria](#acceptance-criteria) below.

**Links from the session.** The pull request, the finished page (**Page · localhost:5173/score-report**), and reports or documents. Click a link to open it in your browser. A file path from the repo is shown as text, because there is nothing to open. These come from two places: what is recorded on the step (the pull request Harnu found on its branch, and links the agent added), and, for a step the session is working on right now, the links the session wrote in its conversation (the same ones the footer's Links list shows). A link you pasted yourself is not listed here. A step the session has not written any links for yet says **The session has not written any links for this step yet.**

**When a button does not work.** If something changed under you (someone else cleared the blocker a moment ago, or the mission was closed), the pane says what to do in plain words, shows the latest, and leaves the step as it now is. Nothing is lost.

### A new Done when

A session can propose a new **Done when** for the mission (what has to be true for it to be finished). It never takes effect by itself: the pane shows a box under **Your next step** with the proposed text, **Approve** and **Decline**. Approve makes it the mission's Done when; Decline keeps the current one.

### Other things the pane says

Other things the pane can say:

- **This session has no mission.** The selected session is not attached to a mission. A mission you closed also ends up here. Under it, Harnu lists the folder's open missions so you can attach the session to one (see "A session with no mission").
- **This mission cannot be read right now.** Harnu could not read the mission file. The reason is printed under it, with **Retry** to read it again.

### A session with no mission

When the session you are looking at has no mission, the pane lists the folder's **open missions**. Each row shows the mission's title, how far it is ("4 of 21 steps done") and who leads it ("led by Harnu Spec", or "nobody leads it"), with **Attach**.

- **Attach** asks first: **Attach this session to "…"? It will be part of the mission, but it will not lead it.** Nothing changes until you confirm. **Cancel** closes the question. Once attached, the pane shows the mission. If the mission is gone or was closed in the meantime, the pane says so and keeps the list.
- **Start a new mission** does not create anything. It puts one line into the session's prompt, asking it to start a new mission and to tell you what "done" will look like first. Harnu does not press Enter: you read the line and send it in the session. If the session is not running, the pane says so. The session's agent creates the mission with `mission_create`.
- When the folder has no open mission, the pane says so and still offers **Start a new mission**.

### When a session asks to join a mission

A session can ask to join a mission that already exists. The pane then shows a box, **Asks to join**, with **Allow** and **Deny**. You see it on the pane of the session that asked (where it replaces the list of missions until you answer), and also on the pane of a session that is already in the mission. **Allow** attaches the session so it works on the mission; **Deny** says no. A session you allow never leads the mission: only you change who leads (see "Continuing in a new session"). If someone else already answered the request, the pane says nothing changed. Harnu's attention sound for a request to join is not wired to this pane yet.

### Asking a milestone a question

When a session leads the mission, each open milestone has an **Ask** button next to its summary line. It opens a small box: type the question and press **Send**. Harnu puts "About the milestone "…": your question" into the prompt of the session that **leads** the mission, the way **Reference in session** does it. It does not press Enter, because the session may be waiting at a permission prompt: you press Enter there. The answer shows in that session, not in the pane. If the session that leads is not running, the pane says so and keeps your question. When nobody leads the mission there is no Ask button.

### Closing a mission

You close a mission from the pane. **Close mission…** is at the foot of the pane for any open mission, ready or not, and it is also the button in **Your next step** when every step is done ("Everything is done. Look it over and close the mission."). Either one only **opens a question**: nothing changes until you confirm.

The question offers two ends:

- **Close as delivered**: the work is done. It also confirms the mission's **Done when**, and the question shows the text it confirms.
- **Discard**: drop it because it is dead, duplicated or abandoned. A discard confirms nothing.

It opens on **Close as delivered** only when every step is done; otherwise it opens on **Discard**, so a stray Enter on an unfinished mission does not mark it delivered. An optional **Reason** goes to the mission's log.

If something is still open, the question lists it under **Before you end it**: how many steps are not done, how many blockers are still open, a new Done when waiting for your approval, and sessions waiting to join. These are **warnings only**. They never stop you and never turn the button off. If Harnu cannot save the close (the mission changed at the same moment, or it was already closed), the question stays open and says what to do; press the button again after reading it.

A closed mission **leaves the pane**. The session then shows "This session has no mission" with the list of the folder's open missions (see "A session with no mission"). The mission's file stays on disk as the record, and it cannot be reopened.

### A small task

A mission does not need milestones. A small task, such as one scoped from a tracker, is a mission with **no milestones**: its steps sit **directly on the timeline**, the progress bar counts steps ("1 of 2 steps done"), and an open step shows the **acceptance criteria** taken from the task. When another person has to approve something (a designer, a QA analyst), that approval is a criterion that says **Waiting for the designer** with **Mark approved**. Harnu cannot see their approval, so you press it when they tell you they approve. A sign-off you already marked is counted in "1 criterion verified", like any criterion that is settled.

### A sample mission

Most of the pane only has something to show once a mission is in a particular state. To see every state, open the pane on a session that has no mission and press **See a sample mission**. A strip at the top says "Sample mission" and has a **State** chooser: a mission with something waiting, a step open, a step blocked, a milestone being asked about, the hand-off offered and confirmed, nothing waiting, everything done and ready to close, another session, a small task, a small task with sign-offs, a large mission, a session with no mission, a request to join, and a closed mission. Three of them (the next-step list, every step of a milestone, and the Sessions row) are one click away on the default mission, and the strip says which click, using the pane's own words for the thing to press. The data is made up. **Nothing you press on a sample is saved**: marks, approvals, the hand-off and the close all answer "nothing changed" without touching any file. **Leave the sample** brings the real answer back.

## Acceptance criteria

A criterion is one thing that has to be true for the step to be done. The ones that are already verified fold into one line, such as **19 criteria verified**, so a long list does not push the rest off the screen. Only the open ones are listed, and each says who settles it:

- **Checked automatically** — Harnu reads a fact (a pull request merged, CI green). You never tick it.
- **Checked by a second session** — another session looks at the work and settles it. You do not tick it either.
- **You** — it is yours. **Mark done** settles it.
- **Waiting for Dana** — another person has to approve it. When they do, click **Mark approved**. Until then the step reads as waiting for them, not as waiting for you.

If the session says it is done with a criterion but nothing independent has checked it, the criterion stays open and says **The session says it is done. Not checked yet.** A step with no criteria says so.

An agent writes every criterion as a fact that is true when the step is done, in at least three words ("Every reviewer question has an answer"), and every step has at least one. A sign-off you were asked for is a criterion too, not a step of its own. The mission as a whole has one more sentence, its **Done when**: closing the mission as delivered confirms it (see "Closing a mission" above).

## Hand-off

A mission outlives the session that works on it. The pane keeps the list of the sessions that worked on the mission, and you are the only one who decides to move it to a new one. No session hands a mission over by itself, and Harnu never switches sessions on its own. A session that is running out of room may ask you for a hand-off in its reply; nothing happens until you confirm it here.

### The Sessions line

At the bottom of the pane, **Sessions** is one line: how many sessions worked on the mission and which one leads it, for example **4 · led by this session**, **4 · led by orch-1** or **4 · nobody leads it**. Click it to open the list. Each session shows:

- its **name** (**Session** and the first eight characters of its id when the session is not loaded any more; a session that a hand-off started is named after the mission, with the mission's title instead of its opening message);
- what it is or was in the mission: **Leads the mission** / **Led the mission** (the one that leads, or used to) and **Works on the mission** / **Worked on the mission**, with **this session** on the one you are looking at;
- **when it worked**: **Since Nov 13** while it is attached, **Nov 11 to Nov 12** once it stopped (with the hours when it started and stopped on the same day);
- for a session that stopped, **where it stopped**: **Stopped at "Run the tool on the whole test set"** and, when it was waiting for something, **Waiting for: the corpus folder path**. If the record does not say, it says **Stopped. The record does not say where.**

The session that leads is first, then the ones still attached, then the ones that stopped, the latest first. When more than five have stopped, the older ones fold behind **N more sessions**.

### Continuing in a new session

Under the list, **Continue in a new session…** opens a confirmation. It says what will happen, in three lines, and shows **the summary the new session starts from**: the goal, where the mission is, what was decided, where each session stopped and the next step. Read it: it is all the new session knows, so if something important is missing, cancel and say it in the current session first.

Nothing happens until you press **Start new session**. Then Harnu:

1. saves where the session that leads stopped;
2. starts a new session in the same folder, in your usual permission mode, with that summary as its first message, and attaches it as the one that leads the mission;
3. releases the old session. It is **not closed or interrupted**: it stays open in the sidebar and in the Sessions list as one that worked on the mission.

Starting a session can take **up to 90 seconds**. The window says so, stays open and cannot be closed while it waits, so you cannot press the button twice. When it is done the window says **The new session leads the mission**, and offers **Open the new session**. The pane you are looking at then shows **This session has no mission**, because the session you were following has been released: select the new session to see the mission again.

If it does not work, the window stays open and says what to do. In every case the old session still leads, unless the window says the lead changed:

- **The new session did not start.** Nothing changed. Try again in a moment.
- **The new session was started, but it did not take over in time.** The same session still leads. Harnu did not see the new session begin, so it did not attach it, and it is running on its own. **Open the new session** takes you to it so you can see what happened or close it. Then try again.
- **A hand-off of this mission is already starting a session.** Wait for it to finish, then look at the Sessions line.
- **Harnu cannot start a session right now.** Nothing changed. Try again in a moment.
- **Who leads the mission changed while the new session was starting.** Harnu did not attach the new session, so it is open but is not part of the mission (**Open the new session** takes you to it). Look at the Sessions line and decide again.
- **This mission is closed.** There is nothing to continue.

### When Harnu offers it

When the context of the session that leads is **80 percent full or more**, the pane shows a notice under the mission: **This session's context is 82% full. You can continue the mission in a fresh session.** (When you are looking at another session, it names the one that leads.) **Continue in a new session…** opens the same confirmation. **Not now** keeps the notice away until that session's context grows by **five more points**, and does nothing else: it does not start a session or change who leads. If Harnu has no reading of the context (the session is not running, or it has just started), there is no notice. Harnu never switches sessions by itself.

## Records from earlier versions

Missions and delivery plans that an earlier version of Harnu wrote (version 3) are still there, and they open in the Mission pane like any other mission. Nothing is lost and nothing is rewritten when you look at one.

- **Looking is free.** Harnu reads the old file and shows it through a converted view: its steps keep their order and their pull requests, a step that was verified reads as done, a sign-off that had been ticked reads as a criterion that is settled, and the old finish line becomes the **Done when**. The pill and the sidebar chip read the same way ("2/5 · 1 for you"). The old file is not changed, not even its modified time.
- **The first change writes a copy.** The first time you use a button on an old mission (for example close it) or an agent makes a version 4 call on it, Harnu writes a version 4 copy next to it, with the same id, and from then on the copy is the mission. The old file stays exactly as it was, byte for byte. An older Harnu installed beside this one keeps showing that old file as it stood at that moment and never sees what happens afterwards, so work a live mission in one Harnu after its first change.
- **An old delivery plan becomes one mission.** A plan with chapters (each chapter was a mission of its own) shows as one mission whose chapters are milestones, in order. A chapter that had no mission yet is a milestone with no steps; it fills in when it starts. Ending the converted mission closes only the new copy: the old plan file is untouched, so the older Harnu still shows it open.
- **A command of the old kind is refused.** Once a mission has a version 4 copy, an agent that uses a command of the older shape on it is told the mission is version 4 now and which command to use instead. Nothing is written.
- **A session that leads several old missions** gets the chooser described under "What the pane shows".
- **A file Harnu cannot read.** If a mission file is damaged, Harnu raises one entry in Activity, **A mission file can't be read**, with the names of the files. The mission it holds stays hidden until the file is fixed or removed, and Harnu does not close or re-file anything because of it.
- **There is no steward any more.** Missions used to get a background helper that did the routine moves; the session that leads the mission does them now. See [Scheduler](scheduler.md).

## Elsewhere in Harnu

The same waiting list shows up outside the pane:

- **The sidebar chip.** On the session that leads a mission, the session's row in the sidebar shows what the pill shows ("4/21 · 3 for you"), in the same colour. It stays visible while something waits on you. A mission an earlier version wrote has the same chip.
- **Activity.** One entry lists every mission that is waiting on you, one row each, with one plain sentence saying what to do. Clicking a row opens the session that leads that mission and its Mission pane. If that session is not loaded in this window, Harnu shows a notice that names the mission instead and opens nothing, so a click is never silent. The entry stays in the list: its other rows are still waiting on you.
- **Your move.** A mission that waits on you files a card for each thing, with the same sentence. A mission you already have (a version 3 one) keeps the cards it had, so updating Harnu does not close or re-file any of them. **Open mission** on a card opens the session and its Mission pane, for any mission.
- **Sounds and reminders.** Harnu plays its attention sound when something new waits on you: a blocker that is yours, a session asking to join, a mission that is ready to close, a main branch that went red, a criterion only you can mark, or one more pull request waiting for your review. Everything except the pull requests then reminds you after 30 minutes, 1 hour, 2 hours and 4 hours, and stops. When fewer things wait on you, there is no sound, and clearing one blocker never counts the others as new. Updating Harnu makes no sound by itself: what a mission already owed you keeps the reminder it had.
- **The session that leads a mission stays awake.** Harnu normally puts a session you are not using to sleep to free memory. It does not do that to the session that leads an open mission (a mission that is ready to close included), even when nothing else is running. It stays awake until the mission is closed or you hand it to a new session.

## What you cannot do yet

- **Create a mission from the pane.** Agents create one; the pane's **Start a new mission** does not write a file.
- **Reopen a closed mission.** A closed mission stays closed. You can close a mission from the pane (see "Closing a mission"), mark your own criteria and another person's approval on an open step, clear a blocker that is yours, approve or decline a new Done when, and continue the mission in a new session (see "Hand-off").
- **Confirm a plan from the pane.** The pane has no button for that; the sample's "Confirm the plan" step only offers **Open step**.

## Related

- [Agent control](agent-control.md) — what a session can do with missions today, through its Harnu commands.
- [Sessions](sessions.md) — the helper stack and its panes.
