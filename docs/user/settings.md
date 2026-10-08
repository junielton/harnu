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
- **Mods** — a read-only list of the mods (Claude Code plugins with a hooks module) your sessions can load, and what each can do. It never switches anyone's mod; see [Mods](mods.md).
- **Interceptor** — an optional, separate layer that lets Harnu answer Claude Code's own permission prompts (not to be confused with the MCP approvals above) — see [Intercepting Claude Code's own prompts](approval-inbox.md#intercepting-claude-codes-own-prompts) for how its shadow/active modes work.
- **Memory** — where [project memory](project-memory.md) behavior is configured.
- **Hibernation policy** — covered below.
- **Usage history** — covered in [Usage](usage.md#usage-history-settings-tab); the working-days control for the daily budget is [below](#daily-budget).
- **Changelog** — renders this repo's `CHANGELOG.md` in-app, so you can see what shipped without leaving Harnu.
- **Cleanup** — the autopilot, what it cleans, the never-clean list and the background scan behind the [Cleanup](cleanup.md) screen; covered [below](#cleanup).
- **Containers** — the inspector's own background scan, its idle clock and the new-zombie notification behind the [Containers](containers.md#settings) view.
- **Claude Code** — renders Claude Code's own official changelog (fetched from Anthropic, separate from Harnu's own Changelog tab above). Claude's live service status (incidents, scheduled maintenance) is shown in the footer popover alongside your [usage](usage.md#the-footer-popover), not here.

## Harnu mod

**Settings → General → Integrations → Harnu mod** is the switch for the small mod Harnu loads into the `claude` sessions it starts. It runs unsandboxed inside the `claude` process and talks only to Harnu on this machine; today it only observes, and Harnu still reads every fact the old way (hooks, the transcript, polling) as well.

- **On (default).** New sessions carry the mod once Harnu has shown you the one-time notice. A session you started before you saw it runs without the mod and says so in its state line.
- **Off.** Harnu stops using the mod at once: every running mod is switched off, and new sessions start without it. Turning the switch back on reaches new sessions only; running ones stay off until they restart. Off means hooks and polling, as before.

Under the switch you may see the folder the mod is loaded from (with a **Reveal folder** button) and at most one plain status line, for example that your Claude Code is older than 2.1.287 or newer than the last version Harnu tested (the mod then only observes), or that mods are turned off by a setting or by your organization's policy. None of these is a warning.

**The statusLine switch.** The mod can supply a session's cost, context and plan limits, but not eight figures: lines added and removed, thinking on or off, output style, the pull request, the model's display name, the session duration and the effort level. **Settings → General → Session telemetry (statusLine)** is still where those come from, so turning it off blanks them. The details are under [Where the figures come from](usage.md#where-the-figures-come-from).

The per-session state is in the hover preview and in the [System Monitor](system-monitor.md#what-you-see). If a session says `legacy` and you want to know why, see [Troubleshooting](troubleshooting.md#harnu-mod-legacy).

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

## Cleanup

**Settings → Cleanup** is the one place that controls how Harnu cleans up after finished work. Every change saves as you make it, and the numbers you type are applied about half a second after you stop typing. If you type a value outside the allowed range, Harnu keeps the nearest allowed one and the field shows what it kept. The tab is the settings behind the [Cleanup](cleanup.md) screen, in four groups.

**Autopilot**

| Setting                     | Default | Range                      | What it does                                                                                                                                                     |
| --------------------------- | ------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clean corpses automatically | off     | on / off                   | Turns automatic cleaning on. The first cycle after turning it on only reports; automatic cleaning starts once you acknowledge that report on the Cleanup screen. |
| Run every                   | 1 hour  | 30 min / 1 h / 6 h / daily | How often the cycle runs. It is the same timer as the background scan, so this is the one interval setting for both.                                             |
| Grace period                | 2 days  | 0 - 30 days                | How long a worktree must be quiet (no session activity, no container start or stop that Harnu did not cause) before it can count as a corpse.                    |
| Per-cycle cap               | 20      | 1 - 200 worktrees          | The most worktrees one automatic cycle cleans. The rest wait for the next cycle. Cleaning by hand is not limited by it.                                          |

The autopilot rides the background scan, so it needs **Automatic background scan** (in the Scan group below) to stay on.

**What it cleans** (these switches govern the autopilot; cleaning by hand always asks first)

| Setting                                | Default | What it does                                                                           |
| -------------------------------------- | ------- | -------------------------------------------------------------------------------------- |
| Worktrees                              | on      | Off: the autopilot cleans no worktrees.                                                |
| Docker build cache and dangling images | on      | Off: no build-cache or dangling-image pruning. It never removes an image a stack uses. |
| Build cache max age                    | 7 days  | Build cache older than this is pruned (1 - 365 days).                                  |

**Docker volumes are always kept.** There is no switch for this: cleaning a worktree, by hand or automatically, never removes its volumes. Once the worktree is gone they appear in Needs review as orphan volumes, with their size and compose project, and you remove each one yourself. A removed volume and its data cannot be restored.

**Never clean**

A list of absolute paths (a repo or a single worktree) that Cleanup never touches, automatically or by hand. Type a path and press Enter or **Add**; click **Remove** beside a path to take it off. A relative path is refused, because it would protect nothing, and a path already on the list is ignored.

**Scan** (the settings of the older background scan, which also cover leftover branches and folders)

- **Automatic background scan** — on by default. Turning it off also stops the autopilot.
- **Notify when items become harvestable** — a quiet entry in the notification center.
- **Never delete remote branches** — a kill switch; Harnu refuses any remote deletion while it is on.
- **Protected branches** — extra branch names, comma-separated, that are never scanned.
- **Minimum age** — days to wait after a branch becomes harvestable before it is flagged.

The marks you set with **Keep**, and whether you have acknowledged the first report, are not settings: they are set from the Cleanup screen. Behind this tab is one file, `gc-prefs.json` in Harnu's settings folder (next to `reaper-prefs.json`); you do not need to edit it. The first time Harnu starts without it, it takes your earlier Cleanup interval and the Containers zombie threshold (which becomes the grace period) so nothing you configured is lost, and it never turns the autopilot on by itself.

## Containers

**Settings → Containers** now holds only what the [Containers](containers.md#settings) inspector needs for itself: its own background scan, the idle clock for stacks that do not run from a worktree, and the new-zombie notification. A stack that runs from a worktree is judged by Cleanup, so there is no setting for it here. A note at the top of the tab says so and has an **Open Cleanup settings** link.

## Hibernation policy

Harnu automatically parks (hibernates) idle sessions to keep memory use in check — see [System Monitor](system-monitor.md) for what a parked session looks like and how to park one on demand. This tab controls the policy behind that:

- **Max concurrent sessions** — how many sessions can stay live before the coldest one is parked to make room for a new one.
- **Idle threshold (cap)** — how long a session can sit unfocused before it's eligible for that eviction.
- **Idle threshold (sweep)** — how long a session can sit idle before a periodic sweep parks it regardless of how many sessions are open.

Edits save automatically and take effect on the very next hibernation check — no restart required.
