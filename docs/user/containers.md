# Containers

A view of every docker stack on your machine, sorted into the ones that need you and the ones to leave alone — so you can find the stacks your worktrees left running after the work shipped, see what they cost in RAM, ports and disk, and stop or remove them without touching anything you still need.

## Why it exists

Parallel work in worktrees leaves docker stacks behind. One measured repo had 40 containers holding about 6 GB of RAM and 48 host ports, a machine down to 1.7 GiB free, and one stack still running after its worktree had been deleted. `docker ps` shows the containers, but not which worktree each came from, whether a session still uses it, or what is safe to stop. Containers answers those questions and offers only the actions the answer allows.

## Opening it

Containers takes over the main pane, like Cleanup and the System Monitor; the sidebar and topbar stay put.

- Click the **Containers** pill in the footer (bottom-right). It only appears when at least one stack needs you, and its badge counts them. The pill is a toggle: it turns accent-colored while the view is open, and clicking it again takes you back to your session. Esc and selecting a session close it too.
- The pill is fed by a background scan that Harnu runs about a minute after start-up and then every hour (you can change that in [Settings](#settings)), even while the view is closed. Opening the view scans right away if no background scan has run yet.

## How Harnu decides

Every stack — one docker compose project, or one container that belongs to no project — is traced back to a folder Harnu knows:

1. its compose `working_dir` label, or
2. a bind mount that lies inside one of your Harnu folders, or
3. nothing, in which case Harnu can't tell where it came from.

It then gets one **verdict**, shown as a chip on its row:

| Verdict          | What it means                                                                                                  | Where it's listed |
| ---------------- | -------------------------------------------------------------------------------------------------------------- | ----------------- |
| **zombie**       | It runs from a worktree, no Harnu session is using it, and it has been unused for at least 2 days.             | Needs you         |
| **orphan**       | The directory it ran from was inside one of your Harnu folders, and no longer exists.                          | Needs you         |
| **active**       | A Harnu session is working in its worktree right now.                                                          | Leave alone       |
| **protected**    | It runs from a repo's main checkout (or from a folder git can't vouch for). It is never counted as a zombie.   | Leave alone       |
| **zombie in Nd** | It runs from a worktree and is unused, but not for 2 days yet.                                                 | Leave alone       |
| **unknown**      | Harnu can't tell which worktree it belongs to — including a directory outside every Harnu folder, gone or not. | Leave alone       |

"Unused for" counts from the later of two moments: the last activity of any Harnu session in that folder, and the last time any of the stack's containers started or stopped. Stopping a stack from Harnu does not reset it — a stopped zombie stays a zombie until you remove it. The 2-day threshold is the default; change it under [Settings → Containers](#settings).

## Reading the view

- **The three numbers at the top** are what you would get back by stopping everything under "Needs you": RAM, host ports, and — in grey — the disk those stacks' volumes hold, which only comes back if you remove them yourself.
- **The bar under them** shows the RAM of every running stack, colored by verdict, with a legend.
- **The list** has three sections: **Needs you**, **Leave alone**, and **Recent** (what you did lately). It scrolls when there are many stacks.
- **Selecting a row** shows why it got its verdict (which label or mount attributed it, the worktree, whether a session uses it, how long it has been unused), its containers with their RAM and ports, and its volumes.

## What you can do

The detail pane only offers what the verdict allows:

- **Stop stack** — on a running zombie or orphan, and by hand on active, protected or not-yet-zombie stacks. It asks nothing: stopping is reversible. On an active stack it warns you that the session's app goes down with it. A running "Needs you" row also shows a small stop button when you hover it.
- **Stop N running** (top right) — stops every running zombie and orphan at once, with no confirmation. It never touches active, protected, not-yet-zombie or unknown stacks; Harnu decides the set, not the view.
- **Start stack** — brings a stopped stack back exactly as it was. Not offered on an orphan: the code it ran from is gone.
- **Clean up N stacks** (top right, next to **Stop N running**) — clears everything under "Needs you" in one go: it stops each zombie and orphan that is still running and then removes it. It appears whenever at least one stack is a zombie or an orphan, and it never acts on the click — removal cannot be undone, so it opens one dialog first. The dialog names every stack it would take and how many containers each has, gives the total ("Clean up 12 stacks? 47 containers will be removed."), and offers the volumes as one line you can tick. Stacks Harnu leaves alone — active, protected, not-yet-zombie, unknown — are never in it. While the sweep runs the button and the dialog's confirm both count the stacks cleared so far, and the whole thing lands in **Recent** as one entry.
- **Choosing which stacks it takes.** Every row under "Needs you" has a checkbox, and they all start ticked, so the button above is still one click over everything. Untick a row to leave that stack out: the button's count drops, and the dialog lists only what is left ticked. At zero the button greys out instead of disappearing — it stays where you left it. The checkbox is only about the clean-up: clicking it changes nothing on the machine, and it does not select the row, so the detail pane keeps showing whatever you were reading. "Leave alone" rows have no checkbox, because nothing there can be cleaned up.
  - **Leaving a stack out protects its volume too.** A volume that stack still uses outlives the clean-up, so it is kept and named under the volume line, exactly like one an in-use stack holds.
  - **The "Needs you" heading has a select all / none control**, showing a half-ticked state while you are picking. It clears everything when all are ticked, and ticks everything otherwise.
  - **Your picks follow the stacks, not the list position**, so a background scan never shuffles them. A stack that disappears is forgotten. A stack that turns up _after_ you have unticked something arrives **unticked** — nothing is ever removed because of a checkbox you never saw. Until you untick anything, new stacks arrive ticked, and **select all** puts you back in that state.
  - **A pick can only ever take a stack out.** Harnu still decides what a clean-up is allowed to touch, from its own fresh scan; your selection narrows that set and can never add a stack Harnu refuses.
- **Remove…** — only on a **stopped** zombie or orphan; on a running one it is greyed out with "Stop it first". It opens a dialog that lists the containers and asks before removing them. The stack's volume is kept unless you tick **Also remove volume** — the box is always unticked when the dialog opens, because a volume usually holds a database. A volume another stack also uses is never removed.
- **Open worktree / Go to session / Open folder** — jump from a stack to the folder or session behind it. Orphans and unknown stacks have none.

**Unknown stacks get no actions at all.** Harnu only acts on stacks it can trace to one of your folders; use the docker CLI for anything else.

While an action runs its button shows a spinner ("Stopping… 2 of 4"), and each container reads "stopping…" until docker reports it down. If docker refuses, the pane shows docker's own error and a **Try again** button.

## Recent and undo

Every action writes one entry to a journal, and **Recent** lists them — one entry per action, so "Stop N running" shows up once as "3 stacks stopped", and a clean-up of twelve stacks as one "12 stacks removed". Selecting an entry shows what it did and how to undo it:

- **After a stop:** the `docker start …` command (with a copy button) and a **Start stack** / **Start all N** button that runs it.
- **After a removal:** removed containers can't be restarted. If the worktree still exists, the entry shows the `docker compose … up -d` command that recreates them from it, and reattaches a volume you kept. If the worktree is gone, there is nothing to recreate them from.

## When docker isn't there

If docker is not on your PATH, or its daemon isn't running, the view says so, shows docker's error, and offers **Scan again**. Nothing is scanned until it works.

## Settings

**Settings → Containers** controls the background scan and the zombie threshold. Every change saves as you make it.

- **Scan in the background** — on by default. Turn it off and Harnu scans only when you open the view or click **Scan now**, so the footer pill only updates then.
- **Scan every** — 30 minutes, 1 hour (the default), 6 hours, or daily.
- **Zombie after** — how many days a worktree's stack must go unused before it counts as a zombie: 2 by default, at least 1. Harnu rescans as soon as you change it, so rows move between **Needs you** and **Leave alone** right away. For example, raise it from 2 to 4 and a stack unused for 3 days goes back from "zombie" to "zombie in 1d".
- **Notify me about new zombies** — on by default. The first time a stack becomes a zombie, Harnu adds one entry to the [Activity bell](approval-inbox.md#activity-bell) in the topbar (no toast, no sound), naming the stacks. Clicking it opens Containers.

Each stack is announced **once**. It is not announced again on later scans, after a restart, or if it stops being a zombie and later becomes one again. A stack that turns zombie while the notification is off is not announced when you turn it back on. Only a stack you remove and recreate counts as new. The first scan after you update Harnu announces the zombies that are already there, once.

## Safety

- Harnu never stops or removes anything on its own; every action is a click.
- Nothing is removed while it is running, and `--force` is never used.
- A volume is removed only when you tick it, and the box is always unticked when a dialog opens — in the per-stack **Remove…** dialog and in **Clean up N stacks** alike.
- The two paths differ in one way worth knowing. **Remove…** takes one stack, and never removes a volume docker reports as shared with another stack. A clean-up takes many stacks at once, and with the box ticked it can remove a shared volume **when every stack that mounts it is inside the same clean-up** — nothing is left to use it. A volume anything outside the clean-up still mounts is kept, and the dialog names it before you confirm.
- **The clean-up dialog is binding.** Harnu re-checks the machine at the moment you confirm, and what it
  finds can differ from what the dialog showed — a stack can cross its zombie threshold, or lose its
  worktree, while the dialog sits open. When that happens the whole clean-up is refused and **nothing is
  deleted**: the dialog stays open, tells you the list changed, refreshes to the current one, and waits
  for you to confirm again. Nothing is removed that you did not read on that list.
- **The list is the one you read, not the one that arrived since.** The dialog reads the clean-up once,
  when it opens; it is not a live view of Harnu's background scans. If a scan changes what the clean-up
  would take, the dialog refreshes **and says so**, and the volume box goes back to unticked — the tick
  was for the list that just changed. It never confirms on its own: you read the new list and click
  **Remove N containers** again. While the clean-up is actually running the list holds still, because
  stacks disappearing from the scan then are the clean-up doing its job.
- **Unticking a stack is binding in the same way.** The confirm sends both what you picked and what the
  dialog showed you, as two separate things: the picks narrow what Harnu may take, and the list is the
  promise Harnu checks its own fresh scan against. So a stack you left out is left out, and if the two
  disagree for any reason the whole clean-up is refused and nothing is deleted.
- The same rules are enforced in Harnu's main process, so nothing — not the view, not an agent — can get around them.

**Clean up N stacks is yours alone.** An agent can stop and remove stacks one at a time through Harnu's agent verbs, with the same rules; there is no agent verb that sweeps.

## Not built yet

- The agent-facing verbs (`list_containers`, `stop_containers`, …).
