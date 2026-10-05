# Settings

Settings is organized into tabs. Most are covered in depth on their own pages — this page is the map, plus the tabs that don't have a home elsewhere.

- **General** — app-wide preferences that don't fit a more specific tab.
- **Appearance** — pick a theme. Harnu ships 13: nine dark (including Tokyo Night, Dracula, Catppuccin Mocha, One Dark, GitHub Dark, Gruvbox Dark, Nord) and four light (Light, Catppuccin Latte, GitHub Light, Gruvbox Light), plus a Monospace theme. Your choice is remembered across restarts. A theme installed via an [extension](extensions.md) shows up in the same grid, marked with a small puzzle-piece badge.
- **Startup** — your global [Claude Boot](claude-boot.md) defaults (model, effort, flags) applied to every session unless a folder or session overrides them.
- **Claude config** — a focused editor for your global `~/.claude/settings.json`: the handful of settings Harnu understands (model, cleanup period, permission defaults, and a few others) get real form controls with Set/Default indicators; anything else already in the file is still shown, just read-only, so an unfamiliar or newer setting is never silently dropped or overwritten.
- **Endpoints** — the registry of custom Claude-compatible endpoints, covered in [Claude Boot](claude-boot.md#custom-endpoints).
- **Remote notifications** — push channels for session events (needs input, finished, failed): either an [ntfy](https://ntfy.sh) topic to your phone, or a generic webhook (which also happens to work directly with Slack/Discord incoming webhooks). You can pause notifications for a set period, and there's a "send test" button per channel so you're not guessing whether it's wired up correctly. This is separate from the OS notifications Harnu also shows locally.
- **MCP** — the agent [control server](agent-control.md), which is **on by default**. This is where the three ways to rein it in live: the server's master kill switch, the global **Ask before agent actions** toggle (off by default — agents act without confirmations), and the per-folder list where you can block agents in a specific folder. It also shows the audit log of everything agents have done.
- **Skills** — the skills Harnu ships and a per-skill on/off switch, globally or per project. Everything is off until you turn it on; see [Bundled skills](bundled-skills.md).
- **Interceptor** — an optional, separate layer that lets Harnu answer Claude Code's own permission prompts (not to be confused with the MCP approvals above) — see [Intercepting Claude Code's own prompts](approval-inbox.md#intercepting-claude-codes-own-prompts) for how its shadow/active modes work.
- **Memory** — where [project memory](project-memory.md) behavior is configured.
- **Hibernation policy** — covered below.
- **Usage history** — covered in [Usage](usage.md#usage-history-settings-tab); the working-days control for the daily budget is [below](#daily-budget).
- **Changelog** — renders this repo's `CHANGELOG.md` in-app, so you can see what shipped without leaving Harnu.
- **Containers** — the background scan, the zombie threshold and the new-zombie notification behind the [Containers](containers.md#settings) view.
- **Claude Code** — renders Claude Code's own official changelog (fetched from Anthropic, separate from Harnu's own Changelog tab above). Claude's live service status (incidents, scheduled maintenance) is shown in the footer popover alongside your [usage](usage.md#the-footer-popover), not here.

## Sidebar

The **General** tab has a SIDEBAR section that controls how the folder/session list looks and behaves:

- **Density** — **Comfortable** (default) or **Compact**. Compact tightens the sidebar's row heights, the session-row gap, and the left indent of session rows, so you fit more sessions on screen and give long names more room. It only affects the sidebar — nothing else in the app changes. Your choice is remembered across restarts.
- **Sort folders by** — Recent activity or Name.
- **Sort sessions by** — Attention, Recent activity, or Name.
- **Show sessions within** — hide sessions older than a window (All / 24h / 48h / 7d) inside each folder; the selected and live sessions are never hidden.
- **Active-elsewhere window** — how recently a non-pinned folder must have been active to show up in the "Active elsewhere" zone.

## Daily budget

**Settings → Usage history** has a **Daily budget** group that drives the `Today` row in the footer's usage popover — what that row actually means is explained under [Usage](usage.md#today--your-daily-budget).

- **Working days** — seven buttons, Mon through Sun. The days you tick are the ones your weekly allowance is split across; the default is **Mon–Sat**. Untick a day and it becomes a day off: the row still reports what you spent, it just stops measuring it against a budget.
- **Unticking every day switches the feature off.** That is a supported state, not an error — the readout drops to zero and the `Today` row disappears from the popover entirely.
- Below the buttons, a live readout — `5 working days → today's budget 12%` — pairs how many days you have ticked with what today's budget works out to, so the effect of ticking Sunday is visible without opening the footer. It previews the split as it stands right now, rather than the start-of-day figure the popover freezes, so once you have spent something today it reads a little lower than the popover. The popover is the number of record.

The alert lives in the other tab: **Settings → General**, in the **OS notifications** group, as **Daily budget alerts**. It is **on by default** and fires at most twice a day — once when you cross 80% of the day's budget, while it is still correctable, and once when you cross 100%. It does not repeat: the crossing is remembered across restarts, so relaunching Harnu mid-afternoon will not replay an alert you already saw, and a new day re-arms both steps. Turning the master **OS notifications** switch off silences it along with everything else.

## Hibernation policy

Harnu automatically parks (hibernates) idle sessions to keep memory use in check — see [System Monitor](system-monitor.md) for what a parked session looks like and how to park one on demand. This tab controls the policy behind that:

- **Max concurrent sessions** — how many sessions can stay live before the coldest one is parked to make room for a new one.
- **Idle threshold (cap)** — how long a session can sit unfocused before it's eligible for that eviction.
- **Idle threshold (sweep)** — how long a session can sit idle before a periodic sweep parks it regardless of how many sessions are open.

Edits save automatically and take effect on the very next hibernation check — no restart required.
