# System Monitor

A Chrome-task-manager-style view of what Harnu is actually spending — every Electron process and every session, live, with why each session is live or parked.

## Why it exists

Harnu's main process once ran out of memory with zero warning: nothing in the product showed heap growth, per-session memory, or a rising process count before it happened. The System Monitor closes that gap.

## Opening it

The System Monitor takes over the main pane, the same way the Roadmap board and the Usage Dashboard do — sidebar and topbar stay put, the transcript area swaps for the monitor.

Click the **heap gauge** in the footer, next to the plan-usage summary in the bottom-right corner, to jump straight in. That gauge is always there once Harnu has been running for a few seconds — a small `heap ▓▓░ NN%` reading — and it's your early-warning signal even when the monitor itself isn't open (see below). Clicking it a second time closes the monitor again; so do Esc and clicking any session in the sidebar.

## What you see

The monitor has two columns: a **Harnu sidebar** on the left and, on the right, a strip of **three headline numbers**, the **Responsiveness** section and your **sessions**. (In a narrow window — under about 1000px wide — the sidebar stacks above the right column.)

### The Harnu sidebar

- **The heap card** — the number that matters most, since the main process is the one that can run out of memory. It shows the percentage of the heap limit in use, how many bytes that is, and a bar with two tick marks at **70%** and **85%**. It stays neutral while the heap is healthy, turns **amber** with a warning icon past 70%, and **red** past 85%. The small heap gauge in the monitor's header follows the same colours.
- **The process list** — one row per Electron process (`main`, `renderer`, `GPU`, `network`, …) with its RAM, its CPU and a bar showing its size against the largest process.
- **The total** at the bottom — Harnu plus your live sessions: RAM and CPU. A parked session costs nothing, so it is not counted.

### The three headline numbers

- **Total RAM** — Harnu plus live sessions, with a bar split between the two so you can see who owns the memory.
- **CPU** — the combined CPU, and how many processes it spans (Harnu's own plus every live session's subprocesses).
- **Sessions** — how many are live and how many are parked, and roughly how much RAM parking has freed (the sum of what each parked session was using when it was last live). The freed-RAM line is hidden until Harnu knows at least one number.

### Responsiveness — what froze typing

Everything you type crosses two threads of JavaScript, the **Main process** and the **Renderer** (the window you are looking at). If either one is busy for more than a split second, your keystrokes queue up and arrive in a burst. The Responsiveness section, between the headline numbers and the sessions, shows what each of them has been doing, and who held it.

Each thread gets a card:

- **Busy** — how much of the last few seconds the thread spent running code. For the Main process that is exact. For the Renderer on Linux it is the thread's own CPU share. On other platforms Harnu cannot read that, so the number is shown with a `~` and means "the share of the last minute spent in tasks over 50 ms", a lower bound; hover it for the explanation. A dash means "not measured yet", never zero.
- **> 50 ms, > 100 ms, > 250 ms** — how many tasks held the thread for at least that long in the last hour. They are nested: a 300 ms task counts in all three. A count turns amber when it is not zero, and the 250 ms count turns red. Fifty milliseconds is the limit: a task over it can be felt as a hitch.
- **Top offenders** — up to five names ranked by the time they held the thread, each with how many times (`×4`) and the worst single stall (`842 ms`). A name is whatever was running: an IPC channel (`ipc:fleet:rescan`), an event the Renderer received (`event:fleet:updated`), a periodic job (`timer:` and its name), a store action (`store:sessions.load`), a component (`component:SidebarFolder`), or, when nothing was labelled, the innermost function of a stack sampled while the stall was happening. A stall nobody could name reads `unattributed`; hover an offender to see the sampled frames.

When a thread has had no task over 50 ms in the last hour, its card says so.

A stall is reported when it ends: a thread stuck for 20 seconds shows up 20 seconds after it started, and a loop that never goes idle is reported in chunks of a few seconds while it runs.

#### The stall log

Every stall over 50 ms is also written, one line each, to `stalls.jsonl` in Harnu's data folder (the same folder as your settings). It holds the time, the thread, how long it lasted, its owner and, for a sampled one, the stack. It is local, nothing is sent anywhere. The file is capped at 1 MiB (the previous generation is kept as `stalls.1.jsonl`) and lines older than 24 hours are dropped when Harnu starts, so it never grows without limit. The last hour is read back at startup, so a restart does not blank the section.

#### Turning it off

The stall monitor costs well under 1% of a thread. If you want it gone anyway, start Harnu with `HARNU_STALL_MONITOR=off`: nothing is measured, the section says the monitor is off, and no log is written.

### Your sessions — cards or a table

Use the **Cards / Table** switch above the sessions. Harnu remembers your choice.

Every session wears the colour of its folder, the same colour the [Scheduler](scheduler.md) gives that folder, so one repo looks the same everywhere.

- **Cards** (the default) — a card per session: the folder and branch, its RAM and CPU in big numbers, a **60-second sparkline** of its memory, and a bar showing where that memory goes (the session's own process and its biggest children). The footer shows whether it is live or parked, why (for a session that is close to being hibernated: `lru` or `hard-idle` and how long it has been idle), the "next to be swept" note and the [Harnu mod](settings.md#harnu-mod) state.
- **Table** — the same information in rows: name, RAM with a bar against the biggest session, CPU, the 60-second sparkline, and the state. When the window is narrow the sparkline column drops out and the state wraps onto a second line rather than being cut off.

A **parked** session — one Harnu hibernated to save memory — is drawn dashed. It shows how much RAM parking freed (or a dash when Harnu never saw it live), why it was parked, and a reminder that you wake it by selecting it in the sidebar. Its own cost is genuinely unknown while parked, not zero, so there is no RAM or CPU number.

**Expanding a session.** A live session with running subprocesses (like the Claude process itself, or an MCP server) has a chevron. Click it to list the session's **own memory** and each subprocess's RAM and CPU. Only that session opens; the others stay as they are. If Harnu cannot measure one of the subprocesses, the "own memory" figure is shown as a dash instead of a misleading number.

The sparklines start empty and fill as samples arrive — they only draw what the monitor has already seen while it was open, about the last minute.

Each live session also shows the state of the [Harnu mod](settings.md#harnu-mod) — `Harnu mod live`, `off` or `legacy` — with the reason in the tooltip. `legacy` is a quiet fact, not a warning: the session simply runs on hooks and polling. A parked session shows none.

Hover a live session whose Harnu mod is `live` and a **Test Harnu mod channel** button appears beside Park now and Close. It sends the session a quick check through the mod: you get a toast with the round trip ("Harnu mod channel answered in 42 ms"), and the session shows a short `harnu-companion: Harnu mod channel check` line in its own terminal for a few seconds. The line is drawn by Claude Code and its prefix cannot be changed. If the channel is not available the toast says why — `this session runs on hooks`, `the channel is observing only` or `this is a headless session` — and if nothing answers it says so. The check changes nothing in the session and carries no text from you or from an agent.

A session that's live but getting cold enough to be the next one hibernated gets a small "next to be swept" note, so you're never surprised by a session disappearing from the live list.

## Acting on a session

Hover a session's card or row (or tab to it with the keyboard) and its buttons appear. On a card they sit in the card's top corner; in the table they are at the end of the state column. The spot for each button is always reserved, so nothing jumps when they show up.

- **Park now** — parks the session immediately, the same way the automatic hibernation sweep would. The session updates on the next sample: a dash for its cost, the reason, and roughly how much RAM it freed. Only shown for a live, resumable session (there's nothing to park in a synthetic session with no transcript yet, or one that's already parked).
- **Close** — closes the session, the same as closing it from the sidebar.

Waking a parked session is still the normal path: select it in the sidebar and it resumes.

## What it costs to run

The monitor's detailed sampling only runs while this pane is open and the window has focus — it pauses the moment you switch away or the window loses focus, and stops entirely when you close the pane. A much lighter heartbeat (just the heap number, roughly every 30 seconds) keeps running in the background regardless, so an early memory-growth warning doesn't require you to have the monitor open to catch it. The stall monitor behind the Responsiveness section also runs in the background (it has to, to catch a stall when it happens), at well under 1% of a thread.

## The footer heap gauge

That background heartbeat feeds the small gauge in the footer, so you always have a read on memory pressure at a glance, whether or not the monitor is open:

- **Green** — under 70% of the heap limit, nothing to worry about.
- **Amber** — 70% and climbing, worth keeping an eye on.
- **Red**, with a warning icon — 85% or higher, the same territory the 2026-07-14 incident reached before it took the app down.

Click the gauge any time to open the full System Monitor and see exactly what's using the memory.

## The hibernation policy

How many sessions stay live, and how long an idle one waits before it's a candidate for parking, is configurable in **Settings → Hibernation policy** — see [Settings](settings.md#hibernation-policy). The footer's "Edit hibernation policy" link (in the monitor's own footer bar) jumps straight there. A change takes effect on the very next hibernation check — no restart needed.
