# System Monitor

A Chrome-task-manager-style view of what Harnu is actually spending — every Electron process and every session, live, with why each session is live or parked.

## Why it exists

Harnu's main process once ran out of memory with zero warning: nothing in the product showed heap growth, per-session memory, or a rising process count before it happened. The System Monitor closes that gap.

## Opening it

The System Monitor takes over the main pane, the same way the Roadmap board and the Usage Dashboard do — sidebar and topbar stay put, the transcript area swaps for the monitor's table.

Click the **heap gauge** in the footer, next to the plan-usage summary in the bottom-right corner, to jump straight in. That gauge is always there once Harnu has been running for a few seconds — a small `heap ▓▓░ NN%` reading — and it's your early-warning signal even when the monitor itself isn't open (see below). Clicking it a second time closes the monitor again; so do Esc and clicking any session in the sidebar.

## What you see

Two groups, both sorted by RAM used (highest first):

- **Harnu** — one row per Electron process (`main`, `renderer`, `GPU`, `network`, …). The `main` row carries a small heap gauge — the number that matters most, since that's the process that can run out of memory. It turns amber as it climbs, red near the limit.
- **Sessions** — one row per session you have open. A live session with running subprocesses (like the Claude process itself, or an MCP server) can be expanded to see each one's own RAM and CPU. A **parked** session — one Harnu hibernated to save memory — shows a dash instead of a number (its cost is genuinely unknown while parked, not zero) plus a short line explaining why it was parked and roughly how much RAM that freed up. Wake a parked session the normal way: select it in the sidebar.

Each live session also shows the state of the [Harnu mod](settings.md#harnu-mod) in its state column — `Harnu mod live`, `off` or `legacy` — with the reason in the tooltip. `legacy` is a quiet fact, not a warning: the session simply runs on hooks and polling. A parked session shows none.

A session that's live but getting cold enough to be the next one hibernated gets a small "next to be swept" note, so you're never surprised by a session disappearing from the live list.

## Acting on a row

Hover a session row and two buttons appear:

- **Park now** — parks the session immediately, the same way the automatic hibernation sweep would. The row updates on the next sample: an em-dash cost, the reason, and roughly how much RAM it freed. Only shown for a live, resumable session (there's nothing to park in a synthetic session with no transcript yet, or one that's already parked).
- **Close** — closes the session, the same as closing it from the sidebar.

Waking a parked session is still the normal path: select it in the sidebar and it resumes.

## What it costs to run

The monitor's detailed sampling only runs while this pane is open and the window has focus — it pauses the moment you switch away or the window loses focus, and stops entirely when you close the pane. A much lighter heartbeat (just the heap number, roughly every 30 seconds) keeps running in the background regardless, so an early memory-growth warning doesn't require you to have the monitor open to catch it.

## The footer heap gauge

That background heartbeat feeds the small gauge in the footer, so you always have a read on memory pressure at a glance, whether or not the monitor is open:

- **Green** — under 70% of the heap limit, nothing to worry about.
- **Amber** — 70% and climbing, worth keeping an eye on.
- **Red**, with a warning icon — 85% or higher, the same territory the 2026-07-14 incident reached before it took the app down.

Click the gauge any time to open the full System Monitor and see exactly what's using the memory.

## The hibernation policy

How many sessions stay live, and how long an idle one waits before it's a candidate for parking, is configurable in **Settings → Hibernation policy** — see [Settings](settings.md#hibernation-policy). The footer's "Edit hibernation policy" link (in the monitor's own footer bar) jumps straight there. A change takes effect on the very next hibernation check — no restart needed.
