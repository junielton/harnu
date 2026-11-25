# Missions

A **mission** is one body of work that an agent keeps track of for you across sessions: what it is for, how far it has got and what is waiting on you. This page covers how you see and steer one: the **Mission dropdown** that opens from the pill in the top bar, the acceptance criteria that say when a step is done, and what happens to the missions an earlier version of Harnu wrote.

Every mission, old or new, opens in the dropdown. An agent starts a mission by itself when its work will take several steps, so you do not have to ask for one.

## The dropdown

### The pill

A pill sits in the top bar, after the session's name. When the session you have selected belongs to a mission it reads:

- **4/21 · 3 for you** — 4 of 21 steps are done and 3 things are waiting on you. If the mission has milestones, the count is milestones instead (**1/10 · 5 for you**).
- **4/21** — nothing is waiting on you right now.
- **21/21 · ready to close** — everything is done.

The numbers come straight from Harnu's count of the mission; the pill never works them out itself. An amber pill means something waits on you, a blue one means nothing does and a green one means the mission is ready to close. A small arrow at its right edge says it opens something, and it turns over while the dropdown is open.

A session with **no mission** shows a quiet pill: a small target and the arrow, no text. Hold the pointer over it and it says **No mission**. It opens the same dropdown, on the "no mission" view (see "A session with no mission"). A mission an earlier version wrote shows the same pill: see [Records from earlier versions](#records-from-earlier-versions).

### Opening the dropdown

Click the pill, or press Enter or Space while it has the focus, to open the **Mission dropdown** right under it. The keyboard shortcut for "Open mission progress" does the same, and it works whenever the pill is on screen. Esc, a click anywhere outside the dropdown, or the pill again closes it, and Esc puts the focus back on the pill. A dialog opened from the dropdown (the close question) sits above it and dims it; Esc closes the dialog first.

Two other places open it on the mission they name: a row of the **Activity** list and **Open mission** on a **Your move** card (see "Elsewhere in Harnu"). The dropdown is not part of the helper stack, so it takes no room from the other panes.

It is at most 420 pixels wide and keeps 8 pixels from the window's edges; on a narrower window it is the width of the window. When the content is taller than the window, the content scrolls and the **Close mission…** line at its foot stays in view (in a window shorter than 420 pixels it scrolls with the content). Nothing scrolls sideways.

### What the dropdown shows

The dropdown **follows the session you have selected** and shows only that session's mission. Pick another session in the sidebar and it changes with it. It checks for changes about every 20 seconds, so a number can lag the real state by a little.

When the session leads more than one mission, a line above the title says **Mission 1 of 3 · Change**. Click it to open a list of the missions (title, how far it is, and how many are for you) and pick one; a check marks the one shown. Without a choice of yours the dropdown opens on the mission that is waiting on you, and when none is, on the one that changed last. A mission you chose in the dropdown wins over both. Choosing one only changes what the dropdown shows: it writes nothing to any mission. For a session that leads, the pill, the sidebar chip and the dropdown always show the same mission. A session that only works on several missions has no switch and shows the one that changed last, whatever waits on you.

From top to bottom:

- the mission's **title**, which wraps instead of being cut;
- a **progress bar** with the count beside it: **4 of 21 steps done**, or **1 of 10 milestones done** when the mission has milestones;
- **one card with the next thing you owe**, described below;
- the **tree** of the mission;
- **Close mission…** at the foot.

There is no "Ready to close" badge and no state label: the card and the green pill say it. There is no "Done when" paragraph either; it shows when a new one is waiting for you, and in the close question.

In Portuguese, the words of the dropdown are Harnu's own, in Portuguese. What an agent wrote (a blocker's reason, a criterion, a step's title) is shown exactly as written.

### Your next step

The card under the title is **one** card, and it holds the first of these that applies:

- **Your next step**: what to do and why it matters, with an **Open step** button that opens that step in the tree and brings it into view. If more than one thing waits on you, **N more waiting on you** opens the rest right there, and **Show less** folds them again.
- When every step is done, the card reads **Close the mission: every step is done** (or **Close the mission: the session says it is ready** once the session has asked you) with a **Close mission…** button, and the Your move card says the same.
- **A new Done when** the session proposed, with **Approve** and **Decline** (see below).
- **A session asking to join**, with **Allow** and **Deny** (see below).
- When nothing waits on you, the card says what is running instead ("2 steps are running. Nothing for you right now.").

The button sits to the right of the text when the dropdown is at least 380 pixels wide, and under the text when it is narrower.

### The tree

Under the card, the mission is a tree: milestone, then step, then criteria. Every row has a chevron: click it to open or close the row. The keyboard works too: Up and Down move between rows, Right and Left open and close the row, Home and End jump to the first and last, Enter or Space opens or closes it.

- **Only the current milestone opens by itself.** That is the first milestone that is neither done nor optional. Open any other one with its chevron.
- Under an open milestone, a summary line counts what is **running**, **waiting for review** and **blocked** ("4 running · 9 waiting for review · 1 blocked"). Steps that have not started are not counted. A milestone's count on the right is its finished steps out of its steps ("4/4").
- Inside a milestone the steps you owe something on come **first** (marked **Yours**), then at most **three** running ones. Every other step is folded behind **N more steps**; click it to see them all, and again (**Show less**) to fold them.
- A step shows its pull request number (**#256**) when it has one. Click the number to open the pull request in your browser (it is plain text when Harnu does not know where the pull request is). A blocked step carries a flag.
- Every dot and flag has a name: hold the pointer over it, or move the focus to it, and a small label says **Not started**, **In progress**, **Waiting for review**, **Done**, **To do**, **Running**, **Blocked**, **Not settled yet** or **Settled**.
- If a milestone has to wait for one that is not the one just before it, it says **Waits for "…"** and names it. It stops saying so once that milestone is done.
- Optional milestones sit under one line at the bottom ("2 optional milestones"); click it to see them.
- A mission with no milestones shows its steps directly, in the same order.

Titles and step names wrap, so a long one never pushes a button out of sight.

### An open step

Click a step to open it. It shows up to three parts, in this order: the blocker, its criteria and the links.

**The blocker**, when something stops the step. A red box says **Blocked · waiting for you · 40m** (how long it has been waiting) when it is yours to clear, or **Blocked · waiting for the session** when the session has to move. Under it is what is wrong, the exact thing that is needed, and what starts once it is done. When the blocker is yours, **Done, continue** clears it. Do that after you have done the thing; the box goes away and the step carries on. A blocker that belongs to the session has no button, because there is nothing for you to press.

**Criteria.** The criteria of the step and who settles each of them: see [Acceptance criteria](#acceptance-criteria) below.

**Links.** What the step points to, one chip each:

- the **pull request**, which opens in your browser;
- a **worktree**, shown as its branch name. Click it to select that folder in the sidebar (if the folder is not in the sidebar, a line under the links asks **This folder is not in the sidebar. Add it?** with **Add** and **Not now**). The small copy button next to it copies the path ("Path copied" for a moment). A worktree that has been removed is greyed, says **removed — branch kept**, opens nothing and keeps its copy button;
- **Evidence**, which opens the report in Harnu's viewer. It is only there when the file exists;
- the page address of something running on this machine (**Page · localhost:5173/score-report**).

A link that would open nothing is not drawn, a path on your disk is never printed in full, and a step with no links shows no Links block. Links come from what is recorded on the step (the pull request Harnu found on its branch, and links the agent added) and, for a step the session is working on right now, from the links the session wrote in its conversation (the same ones the footer's Links list shows). A link you pasted yourself is not listed here.

**When a button does not work.** If something changed under you (someone else cleared the blocker a moment ago, or the mission was closed), the dropdown says what to do in plain words, shows the latest, and leaves the step as it now is. Nothing is lost.

### A new Done when

A session can propose a new **Done when** for the mission (what has to be true for it to be finished). It never takes effect by itself: the next-step card shows **New Done when proposed** with the proposed text, **Approve** and **Decline**. Approve makes it the mission's Done when; Decline keeps the current one. This holds for an older mission with a new end waiting too.

### A session with no mission

When the session you are looking at has no mission, the dropdown says **This session has no mission.** and lists the folder's **open missions**. Each row shows the mission's title, how far it is ("4 of 21 steps done") and who leads it ("led by Harnu Spec", or "nobody leads it"), with **Attach**. A mission you closed also ends up here.

- **Attach** asks first, in the row: **Attach this session to "…"? It will be part of the mission, but it will not lead it.** Nothing changes until you confirm. **Cancel** closes the question. Once attached, the dropdown shows the mission. If the mission is gone or was closed in the meantime, the dropdown says so and keeps the list.
- **Start a new mission** does not create anything. It puts one line into the session's prompt, asking it to start a new mission and to tell you what "done" will look like first. Harnu does not press Enter: you read the line and send it in the session. If the session is not running, the dropdown says so. The session's agent creates the mission with `mission_create`.
- When the folder has no open mission, the dropdown says so and still offers **Start a new mission**.
- **See a sample mission**, under the list, shows the dropdown with made-up data (see "A sample mission").

Two more things it can say: **Reading the mission…** while Harnu looks, and **This mission cannot be read right now.** when Harnu could not read the mission file (the reason is printed under it, with **Retry**).

### When a session asks to join a mission

A session can ask to join a mission that already exists. The dropdown then shows **Asks to join** with **Allow** and **Deny**. You see it on the session that asked (where it replaces the list of missions until you answer), and also on a session that is already in the mission. **Allow** attaches the session so it works on the mission; **Deny** says no. A session you allow never leads the mission. If someone else already answered the request, the dropdown says nothing changed. The **Asks you** sound for a request to join is not wired to the dropdown yet.

### Asking a milestone a question

When a session leads the mission, each open milestone has an **Ask** button at the end of its summary line. It opens a small box: type the question and press **Send**. Harnu puts "About the milestone "…": your question" into the prompt of the session that **leads** the mission, the way **Reference in session** does it. It does not press Enter, because the session may be waiting at a permission prompt: you press Enter there. The answer shows in that session, not in the dropdown. If the session that leads is not running, the dropdown says so and keeps your question. When nobody leads the mission there is no Ask button.

### Test it: walking a step, a milestone or the whole mission by hand

When something waits on you to check by hand, the dropdown offers a small **Test it** button. It starts a
[guided walk](guided-test-walk.md): a list of checks you do one at a time, written by the session that leads the
mission. It shows up in three places, and only where you really owe a check:

- on an open step's **Criteria** line, when the step has a criterion that is yours (or another person's) and still open;
- on a milestone's summary line, next to **Ask**, when a step of it is waiting on you;
- as **Test the whole mission** in the footer, only once the mission is ready to close.

A step with nothing owed by hand, a finished milestone and a mission that is still under way show no button.

Press it and the dropdown closes. Harnu sends the mission's leader one request that names what you want walked and
the walks that already exist for it, and the walk opens in the side stack as soon as the session has written it. If
the leader is parked, Harnu wakes it first; if no leader can be reached, Harnu starts a new session and hands it the
mission summary and the request (it does not become the mission's leader). A small notice says which of the two
happened, and a refusal (a closed mission, for example) says why in the same place.

If a walk of that step, milestone or mission is already running, pressing **Test it** again does not ask for a new
one: it brings that walk's pane back. Clicking outside the dropdown closes it and leaves the walk where it is. A
walk never settles a criterion: you still tick it yourself with **Mark done**.

### Closing a mission

You close a mission from the dropdown. **Close mission…** is at its foot for any open mission, ready or not (when the card already says **Close mission…**, the foot does not repeat it). Either one only **opens a question**: nothing changes until you confirm.

The question says the mission **leaves the Topbar and cannot be reopened** (the mission's file stays on disk as the record) and offers two ends under **How to close it**:

- **Close as delivered**: the work is done. It also confirms the mission's **Done when**, and the question shows the text it confirms. The button reads **Close mission**.
- **Discard**: drop it because it is dead, duplicated or abandoned. A discard confirms nothing, and the button reads **Discard**.

It opens on **Close as delivered** only when every step is done; otherwise it opens on **Discard**, so a stray Enter on an unfinished mission does not mark it delivered. An optional **Reason** goes to the mission's log.

If something is still open, the question lists it under **Before you end it**: how many steps are not done, how many blockers are still open, a new Done when waiting for your approval, and sessions waiting to join. These are **warnings only**. They never stop you and never turn the button off. If Harnu cannot save the close (the mission changed at the same moment, or it was already closed), the question stays open and says what to do; press the button again after reading it.

A closed mission **leaves the dropdown**, and the dropdown closes with it. The session then shows the quiet "No mission" pill; open it and it says "This session has no mission" with the list of the folder's open missions. The mission's file stays on disk as the record, and it cannot be reopened.

### A small task

A mission does not need milestones. A small task, such as one scoped from a tracker, is a mission with **no milestones**: its steps are listed directly, the progress bar counts steps ("1 of 2 steps done"), and an open step shows the **acceptance criteria** taken from the task. When another person has to approve something (a designer, a QA analyst), that approval is a criterion that says **Waiting for the designer** with **Mark approved**. Harnu cannot see their approval, so you press it when they tell you they approve. A sign-off you already marked is counted in "1 criterion verified", like any criterion that is settled.

### A sample mission

Most of the dropdown only has something to show once a mission is in a particular state. To see them, open the dropdown on a session that has no mission and press **See a sample mission**. A strip at the top says **Sample mission**, says the data is made up, and has a **State** chooser: a mission with something waiting, a step open, a step blocked, every step of a milestone, a milestone being asked about, nothing waiting, everything done and ready to close, another session, a small task, a small task with sign-offs, a large mission, a session with no mission, a request to join, and a closed mission. A few of them are one click away on the default mission, and the strip says which click. **Nothing you press on a sample is saved**: marks, approvals and the close all answer "nothing changed" without touching any file. **Leave the sample** brings the real answer back.

## Acceptance criteria

A criterion is one thing that has to be true for the step to be done. The ones that are already verified fold into one line, such as **19 criteria verified**, so a long list does not push the rest off the screen. Only the open ones are listed, and each says who settles it:

- **Checked automatically** — Harnu reads a fact (a pull request merged, CI green). You never tick it.
- **Checked by a second session** — another session looks at the work and settles it. You do not tick it either.
- **You** — it is yours. **Mark done** settles it.
- **Waiting for Dana** — another person has to approve it. When they do, click **Mark approved**. Until then the step reads as waiting for them, not as waiting for you.

If the session says it is done with a criterion but nothing independent has checked it, the criterion stays open and says **The session says it is done. Not checked yet.** A step with no criteria says so.

An agent writes every criterion as a fact that is true when the step is done, in at least three words ("Every reviewer question has an answer"), and every step has at least one. A sign-off you were asked for is a criterion too, not a step of its own. The mission as a whole has one more sentence, its **Done when**: closing the mission as delivered confirms it (see "Closing a mission" above).

## Records from earlier versions

Missions and delivery plans that an earlier version of Harnu wrote (version 3) are still there, and they open in the dropdown like any other mission. Nothing is lost and nothing is rewritten when you look at one.

- **Looking is free.** Harnu reads the old file and shows it through a converted view: its steps keep their order and their pull requests, a step that was verified reads as done, a sign-off that had been ticked reads as a criterion that is settled, and the old finish line becomes the **Done when**. The pill and the sidebar chip read the same way ("2/5 · 1 for you"). The old file is not changed, not even its modified time.
- **The first change writes a copy.** The first time you use a button on an old mission (for example close it) or an agent makes a version 4 call on it, Harnu writes a version 4 copy next to it, and from then on the copy is the mission. A single mission keeps its id; a delivery plan becomes one new mission with a new id. The old file stays exactly as it was, byte for byte. An older Harnu installed beside this one keeps showing that old file as it stood at that moment and never sees what happens afterwards, so work a live mission in one Harnu after its first change.
- **An old delivery plan becomes one mission.** A plan with chapters (each chapter was a mission of its own) shows as one mission whose chapters are milestones, in order. A chapter that had no mission yet is a milestone with no steps; it fills in when it starts. Ending the converted mission closes only the new copy: the old plan file is untouched, so the older Harnu still shows it open.
- **A new end an agent proposed on an old mission** is still yours to answer. It shows on the same card, with the owner's reason, and also as an item that waits on you: it counts on the pill and the chip, plays the **Asks you** sound, and gets a card in **Your move** and a row in Activity until you decide. **Approve** makes it the mission's end exactly as before and **Decline** keeps the current one; on a mission still in its old file neither writes a version 4 copy. If the mission was already copied when the proposal was still waiting, the proposal moves with it and you answer it the same way.
- **Nothing you owed disappears.** A sign-off, a check or a human step that waits on you is a criterion you mark in the dropdown. A choice nobody made yet, a check on the finish line and the review of an imported finish line each wait on you as a blocker of yours: press **Done, continue** when it is done.
- **The old commands are gone.** An agent that sends one is told the tool is not found, and nothing is written. The new commands read an old mission and write a version 4 copy on the first change.
- **A session that leads several old missions** gets the switch described under "What the dropdown shows".
- **A file Harnu cannot read.** If a mission file is damaged, Harnu raises one entry in Activity, **A mission file can't be read**, with the names of the files. The mission it holds stays hidden until the file is fixed or removed, and Harnu does not close or re-file anything because of it.
- **There is no steward any more.** Missions used to get a background helper that did the routine moves; the session that leads the mission does them now. See [Scheduler](scheduler.md).

## Elsewhere in Harnu

The same waiting list shows up outside the dropdown:

- **The sidebar chip.** On the session that leads a mission, the session's row in the sidebar shows what the pill shows ("4/21 · 3 for you"), in the same colour. It stays visible while something waits on you. A mission an earlier version wrote has the same chip. It names the same mission as the pill and the dropdown.
- **Activity.** One entry lists every mission that is waiting on you, one row each, with one plain sentence saying what to do. Clicking a row opens the session that leads the mission it names and the Mission dropdown on that mission, even when the session leads several. If the leader's session is not loaded in this window, the click shows a notice that names the mission, “Can’t open “{title}” from here” (the title is the mission's), saying “Its owner session isn’t open in this window. Open that session, then use its Mission pill.” Every mission that waits on you gets its own row, however many.
- **Your move.** A mission that waits on you files **one** card, for the next thing it owes you, with the same sentence; the card changes as that does. A mission untouched for 7 days has no card. **Open mission** on a card opens the session and then the Mission dropdown, on the mission the card names, for any mission. A mission that is ready to close and owes nothing else first shows **Close the mission** on that card.
- **Sounds and reminders.** Harnu plays a sound when something new waits on you, and the sound says what kind (see [Notification sounds](settings.md#notification-sounds)). Anything that blocks something, such as a blocker that is yours, a session asking to join, a mission that is ready to close or a criterion only you can mark, plays **Asks you**. A main branch that went red plays **Broke**. One more pull request waiting for your review plays the soft **Just so you know** chime. The **Sound** switch in **Settings → General** silences all of them, and each kind has its own mute under it. Everything except the pull requests then reminds you after 30 minutes, 1 hour, 2 hours and 4 hours, and stops. When fewer things wait on you, there is no sound, and clearing one blocker never counts the others as new. Updating Harnu makes no sound by itself: what a mission already owed you keeps the reminder it had.
- **The session that leads a mission stays awake.** Harnu normally puts a session you are not using to sleep to free memory. It does not do that to the session that leads an open mission (a mission that is ready to close included), even when nothing else is running. It stays awake until the mission is closed.

## What you cannot do yet

- **Create a mission from the dropdown.** Agents create one; **Start a new mission** does not write a file.
- **Reopen a closed mission.** A closed mission stays closed. You can close a mission from the dropdown (see "Closing a mission"), mark your own criteria and another person's approval on an open step, clear a blocker that is yours, and approve or decline a new Done when.
- **See or change which session leads a mission.** The dropdown does not list the sessions that worked on a mission and has no button to hand it to a new session.
- **Confirm a plan from the dropdown.** There is no button for that; the sample's "Confirm the plan" step only offers **Open step**.

## Related

- [Agent control](agent-control.md) — what a session can do with missions today, through its Harnu commands.
- [Sessions](sessions.md) — the helper stack and its panes.
