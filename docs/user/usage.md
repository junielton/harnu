# Usage

Harnu surfaces your Claude plan usage and per-session cost at three depths: a quick glance, a history tab, and a full dashboard.

## The footer popover

Click the fleet indicator in the footer to open a popover with your current plan-usage meters — 5-hour and 7-day rate-limit bars (using whichever of Claude's own status line or a periodic `/usage` poll is freshest), a per-model weekly breakdown, how long ago the numbers were refreshed, and a rollup of cost and session count across your fleet. It also shows Claude's own service status (any active incidents or scheduled maintenance) alongside the usage meters. From here, **Open full dashboard** takes you to the deeper view.

### Today — your daily budget

Below those meters, separated by a hairline, sits a fourth row Harnu derives itself rather than reads from Claude: **Today**, showing something like `9% / 17%`. The first number is how much of your 7-day allowance you have burned since the day began; the second is what today was budgeted. Harnu works that out by taking what was left of the weekly limit when the day started and splitting it across the working days still ahead of the reset — today counts, and so does the reset day itself, which errs on the cautious side.

**The budget is fixed for the day.** It is calculated once, from the 7-day figure as it stood when the day began, and does not move as you spend. That is deliberate: recalculated on every turn, the allowance would creep upwards all day and you could never actually go over it. Because it is frozen, the bar means something — it goes from green to the accent colour at 80% of the day's budget, and to red at 100%.

**Going over is never blocked.** Harnu will not stop a session, and does not try to. What it does is tell you the price: the row switches to `over · next 3 days drop to 12%/day`, which is the smaller per-day share the remaining working days inherit now that today has eaten into the week. When there are no following days to quote — today is the last working day before the reset, or the week's allowance was already gone before today started — the line reads `over · nothing left this week` instead.

**On a day off** — any weekday outside your working set — the row shows what you have spent and nothing more: no bar, no budget, and the line `day off · not counted against a budget`. Spending on a day you did not plan to work is a choice, not an overrun. It still comes out of the week, which the 7-day meter above already accounts for.

The row hides itself entirely, hairline included, whenever there is nothing honest to show: no 7-day window reported yet, no usage history to read a start-of-day figure from, or no working days configured at all.

Which days count, and the optional alert at 80% and 100% of the day's budget, are configured in [Settings](settings.md#daily-budget).

## Where the figures come from

Each session's cost, context fill and plan limits can come from two places: the statusLine Harnu installs for Claude Code (**Settings → General → Session telemetry (statusLine)**), or the [Harnu mod](settings.md#harnu-mod) running inside the session. Harnu keeps a neutral record per session and decides, per group of figures, which source writes it. A group is never a blend of the two.

- **Today the mod only compares.** In the shipped setting the mod's readings are recorded next to the statusLine's so Harnu can check they agree, and the footer, the hover preview and the usage panel keep showing the statusLine's figures. Nothing you see changes yet.
- **When the mod is the source** for a session, it writes cost, context (percent, window size, over 200k) and the 5-hour and 7-day limits. If it stops reporting for that session — the session is lost, the mod is switched off — the statusLine takes all of them back at once.
- **Eight figures always need the statusLine**, because the mod has no source for them: lines added, lines removed, thinking on or off, output style, the pull request, the model's display name, the session duration and the effort level. Turn the statusLine switch off and these go blank, whoever supplies the rest. A session started with your own statusLine gets cost, context and limits from the mod for the first time, and the same eight stay empty.
- **Usage history keeps filling** whichever source wrote the figures.
- **Plan limits and the `/usage` check.** The 5-hour and 7-day numbers can come from any live session whose mod is the source, and the footer shows whichever reading is freshest. When a session's mod reported a limit in the last 90 seconds, Harnu skips its periodic `claude -p "/usage"` check (the timer tick and the refresh when you focus the window); when none did, the check runs as before. A manual refresh always runs it, and so does the first look at app start. Two things only the check supplies: the per-model weekly rows, so they refresh less often while sessions are working, and the numbers when no session is reporting (idle sessions, an API-key account). In the shipped setting the mod only compares, so the check still runs on its usual schedule.
- **Dashboard cost** still comes from Harnu's scan of your session transcripts, which stays the source for history and for the day, model and session breakdowns. For a session that started fresh in Harnu with the mod as its source for cost (and with nothing lost along the way), the dashboard replaces the scan's price for each day with Claude Code's own total for that day, split across models the way the scan splits it; a difference larger than a factor of two is ignored and the scan's number stands. Resumed sessions, sessions with a gap, and everything while the mod only compares keep the scan's price. Token counts and request counts are never changed.
- **A per-turn record.** While the mod reports, Harnu keeps a small local record of each turn's tokens, duration and cost (ids, counts and dollars only, never text) under its own data folder, one per Harnu instance. It follows the **Usage history** capture switch and retention setting, and it is what the dashboard calibration above is computed from.

## Usage history (Settings tab)

**Settings → Usage history** gives you trajectory charts of your 5-hour and 7-day windows, cost, and session count over a range you choose (24 hours up to "all"), a "right now" strip, and a weekday-by-hour heatmap of when you actually use Claude. It's explicit about the difference between your **account-wide plan percentage** and **local-machine cost** — the two are tracked separately, so a number here that looks off is worth checking against which of those two it actually is. This tab also holds the feature's own configuration: whether it captures data at all, your plan tier, and how long history is retained.

### Plan-fit calculator

Also in this tab: a calculator that compares your observed 5-hour-window peaks against a plan tier and tells you, plainly, whether that plan would actually have covered you — "N of your M windows would have blown past the limit" — plus a recommendation for the smallest tier that would fit, over a recency window you can adjust (30/60/90 days, or all history). If there isn't enough data yet, it says so rather than guessing. A companion heatmap shows average usage percentage by day-of-week and hour over the last four weeks, so you can see when your usage actually peaks.

## Usage Dashboard

**Open full dashboard** (from the footer popover) takes over the main pane with a deeper view: five at-a-glance KPIs (current 5h/7d window, cost today, sessions today, a projection to your next reset), a switchable trajectory chart (cost, rate, or session count over time — including a visual split around the mid-week reset point so you're not comparing usage across two different limit periods as if they were one continuous line), an activity calendar, ranked lists (top models, top projects, top sessions), a per-session "anatomy" view (duration, cost, and token breakdown per session, with subagent activity called out), and an explorer table you can regroup by day, session, model, or project and sort however you like.

## What this doesn't cover

None of this data leaves your machine — it's all read from what Claude Code and Harnu already track locally (plus the periodic status/usage checks noted in the [README](../../README.md#network-activity)). There's no cloud usage service involved.
