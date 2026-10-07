# Containers

An inspector for every docker stack on your machine, sorted into the ones that need you and the ones to leave alone — so you can find the stacks your worktrees left running after the work shipped, see what they cost in RAM, ports and disk, and stop, start or remove them one at a time. Cleaning up many stacks at once, together with the worktrees they belong to, happens in [Cleanup](cleanup.md).

## Why it exists

Parallel work in worktrees leaves docker stacks behind. One measured repo had 40 containers holding about 6 GB of RAM and 48 host ports, a machine down to 1.7 GiB free, and one stack still running after its worktree had been deleted. `docker ps` shows the containers, but not which worktree each came from, whether a session still uses it, or what is safe to stop. Containers answers those questions and offers only the actions the answer allows.

## Opening it

Containers takes over the main pane, like Cleanup and the System Monitor; the sidebar and topbar stay put. It opens from the **Inspect stacks** link in the Docker card on the Cleanup screen, and from the notification Harnu posts when a stack becomes a zombie (see [Settings](#settings)). It no longer has a footer pill: the single recycle pill opens [Cleanup](cleanup.md#opening-it), where stacks are cleaned.

Harnu scans docker about a minute after start-up and then every hour (you can change that in [Settings](#settings)), even while the view is closed. Opening the view scans right away if no background scan has run yet.

## How Harnu decides

Every stack — one docker compose project, or one container that belongs to no project — is traced back to a folder Harnu knows:

1. its compose `working_dir` label, or
2. a bind mount that lies inside one of your Harnu folders, or
3. nothing, in which case Harnu can't tell where it came from.

It then gets one **verdict**, shown as a chip on its row:

| Verdict          | What it means                                                                                                               | Where it's listed |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| **zombie**       | It runs from a worktree Cleanup calls a corpse, or no Harnu session is using it and it has been unused for at least 2 days. | Needs you         |
| **orphan**       | The directory it ran from was inside one of your Harnu folders, and no longer exists.                                       | Needs you         |
| **active**       | A Harnu session is working in its worktree right now.                                                                       | Leave alone       |
| **protected**    | It runs from a repo's main checkout (or from a folder git can't vouch for). It is never counted as a zombie.                | Leave alone       |
| **zombie in Nd** | It runs from a worktree and is unused, but not for 2 days yet.                                                              | Leave alone       |
| **unknown**      | Harnu can't tell which worktree it belongs to — including a directory outside every Harnu folder, gone or not.              | Leave alone       |

**A stack that runs from a worktree takes its verdict from Cleanup.** When Cleanup has judged the worktree, its group decides: a **Corpse** worktree's stack is a **zombie** at once (no waiting for the clock), a **Decide** worktree's stack stays out of "Needs you" until you decide about the worktree, and an **Alive** worktree's stack is **active**. The idle clock below only applies to stacks Cleanup has not judged.

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
- **Open Cleanup · N stacks** (top right, next to **Stop N running**) — appears whenever at least one stack is a zombie or an orphan. It does not clean anything itself: it opens [Cleanup](cleanup.md), the one place where stacks are cleaned together with their worktrees, behind one confirm dialog that says what goes with them. Stacks Harnu leaves alone — active, protected, not-yet-zombie, unknown — are never in it. (A zombie that belongs to no worktree is not part of Cleanup's worktree cleaning; remove it here, one stack at a time, with **Remove…**.)
- **Remove…** — only on a **stopped** zombie or orphan; on a running one it is greyed out with "Stop it first". It opens a dialog that lists the containers and asks before removing them. The stack's volume is kept unless you tick **Also remove volume** — the box is always unticked when the dialog opens, because a volume usually holds a database. A volume another stack also uses is never removed.
- **Open worktree / Go to session / Open folder** — jump from a stack to the folder or session behind it. Orphans and unknown stacks have none.

**Unknown stacks get no actions at all.** Harnu only acts on stacks it can trace to one of your folders; use the docker CLI for anything else.

While an action runs its button shows a spinner ("Stopping… 2 of 4"), and each container reads "stopping…" until docker reports it down. If docker refuses, the pane shows docker's own error and a **Try again** button.

## Recent and undo

Every action writes one entry to a journal, and **Recent** lists them — one entry per action, so "Stop N running" shows up once as "3 stacks stopped", and a cleaning in Cleanup that removes twelve stacks as one "12 stacks removed". Selecting an entry shows what it did and how to undo it:

- **After a stop:** the `docker start …` command (with a copy button) and a **Start stack** / **Start all N** button that runs it.
- **After a removal:** removed containers can't be restarted. If the worktree still exists, the entry shows the `docker compose … up -d` command that recreates them from it, and reattaches a volume you kept. If the worktree is gone, there is nothing to recreate them from.

## When docker isn't there

If docker is not on your PATH, or its daemon isn't running, the view says so, shows docker's error, and offers **Scan again**. Nothing is scanned until it works.

## Settings

**Settings → Containers** now holds only what this inspector needs for itself. A note at the top says that a stack running from a worktree is judged by Cleanup, and an **Open Cleanup settings** link takes you to [Settings → Cleanup](settings.md#cleanup), where the autopilot, the grace period and the other cleaning controls live. Every change saves as you make it.

- **Scan in the background** — on by default. Turn it off and Harnu scans only when you open the view or click **Scan now**, so new zombies are only noticed then.
- **Scan every** — 30 minutes, 1 hour (the default), 6 hours, or daily. This is the inspector's own timer; Cleanup has its own.
- **Zombie after** — how many days a stack that Cleanup has not judged (one that does not run from a worktree) must go unused before it counts as a zombie: 2 by default, at least 1. Harnu rescans as soon as you change it, so rows move between **Needs you** and **Leave alone** right away. For example, raise it from 2 to 4 and a stack unused for 3 days goes back from "zombie" to "zombie in 1d". Stacks that run from a worktree ignore this number.
- **Notify me about new zombies** — on by default. The first time a stack becomes a zombie, Harnu adds one entry to the [Activity bell](approval-inbox.md#activity-bell) in the topbar (no toast, no sound), naming the stacks. Clicking it opens Containers.

Each stack is announced **once**. It is not announced again on later scans, after a restart, or if it stops being a zombie and later becomes one again. A stack that turns zombie while the notification is off is not announced when you turn it back on. Only a stack you remove and recreate counts as new. The first scan after you update Harnu announces the zombies that are already there, once.

## Safety

- Harnu never stops or removes anything in this view on its own; every action is a click.
- Nothing is removed while it is running, and `--force` is never used.
- A volume is removed only when you tick it, and the box is always unticked when the **Remove…** dialog opens. That dialog takes one stack and never removes a volume docker reports as shared with another stack.
- Cleaning many stacks at once is [Cleanup](cleanup.md#the-hero-button-clean-every-corpse-in-one-click)'s job, and it is as strict: one confirm dialog that lists everything it will take, a re-check of the machine at the moment you confirm (anything that changed is skipped and shown again), and a plain warning that volumes cannot be restored.
- The same rules are enforced in Harnu's main process, so nothing — not the view, not an agent — can get around them.

**Mass cleaning is yours alone.** An agent can stop and remove stacks one at a time through Harnu's agent verbs, with the same rules; there is no agent verb that cleans in bulk.

## Not built yet

- The agent-facing verbs (`list_containers`, `stop_containers`, …).
