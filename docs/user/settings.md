# Settings

Settings is organized into tabs. Most are covered in depth on their own pages — this page is the map, plus the tabs that don't have a home elsewhere.

- **General** — app-wide preferences that don't fit a more specific tab, including the [editor](#editor) the Topbar's open button launches.
- **Keyboard Shortcuts** — covered below.
- **Appearance** — pick a theme and the [split layout](sessions.md#splits). Harnu ships 13 themes: nine dark (including Tokyo Night, Dracula, Catppuccin Mocha, One Dark, GitHub Dark, Gruvbox Dark, Nord) and four light (Light, Catppuccin Latte, GitHub Light, Gruvbox Light), plus a Monospace theme. Your choice is remembered across restarts. A theme installed via an [extension](extensions.md) shows up in the same grid, marked with a small puzzle-piece badge. Under **Layout**, **Split layout** decides whether your helper panes sit beside the session or under it: **Auto** (the default), **Side by side** or **Stacked**. The choice is saved in `settings.json`. Right below it, **Floating panels** is an opt-in look for the whole window: see [Floating panels](#floating-panels).
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
- **Your move** — whether Harnu checks sessions for something only you can unblock; covered [below](#your-move).
- **Usage history** — covered in [Usage](usage.md#usage-history-settings-tab); the working-days control for the daily budget is [below](#daily-budget).
- **Changelog** — renders this repo's `CHANGELOG.md` in-app, so you can see what shipped without leaving Harnu.
- **Cleanup** — the autopilot, what it cleans, the never-clean list and the background scan behind the [Cleanup](cleanup.md) screen; covered [below](#cleanup).
- **Containers** — the inspector's own background scan, its idle clock and the new-zombie notification behind the [Containers](containers.md#settings) view.
- **Claude Code** — renders Claude Code's own official changelog (fetched from Anthropic, separate from Harnu's own Changelog tab above). Claude's live service status (incidents, scheduled maintenance) is shown in the footer popover alongside your [usage](usage.md#the-footer-popover), not here.

## Floating panels

**Settings → Appearance → Layout → Floating panels** turns each pane into its own rounded island on a darker background, with an even 4px gap between islands and around the window edge. It is **off by default**, and with it off Harnu looks exactly as it always has.

With it on:

- The sidebar toolbar, the Topbar and the Fleet rail header line up as one row of three bars; everything below them starts at the same height.
- The sidebar is a stack of islands: the folder list with its toolbar joined on top as one box, **Return here** (when something is waiting, just above the dock), and a **dock** at the bottom with Add folder and Settings. The Fleet rail is the same idea: the fleet list with its header joined on top as one box, **Needs you** (while something is pending) and **Would-have**.
- Every helper pane is its own island, and the session area is one too.
- Pane dividers draw no line at rest. The gap itself is the drag handle: hover it and a short grip appears, then drag to resize or double-click to reset, exactly as before.
- The footer at the bottom stays a flat full-width bar; it is not an island.
- Minimizing the Fleet rail, collapsing the sidebar or closing the helper stack never closes the gap.

The switch takes effect immediately and is remembered across restarts; the setting is saved in `settings.json` as `floatingPanels`. Every theme has a darker background to float on; on the light themes it is a soft grey picked by hand, not a heavy dark slab.

## Harnu mod

**Settings → General → Integrations → Harnu mod** is the switch for the small mod Harnu loads into the `claude` sessions it starts. It runs unsandboxed inside the `claude` process and talks only to Harnu on this machine; today it only observes, and Harnu still reads every fact the old way (hooks, the transcript, polling) as well.

- **On (default).** New sessions carry the mod once Harnu has shown you the one-time notice. A session you started before you saw it runs without the mod and says so in its state line.
- **Off.** Harnu stops using the mod at once: every running mod is switched off, and new sessions start without it. Turning the switch back on reaches new sessions only; running ones stay off until they restart. Off means hooks and polling, as before.

Under the switch you may see the folder the mod is loaded from (with a **Reveal folder** button) and at most one plain status line, for example that your Claude Code is older than 2.1.287 or newer than the last version Harnu tested (the mod then only observes), or that mods are turned off by a setting or by your organization's policy. None of these is a warning.

**The statusLine switch.** The mod can supply a session's cost, context and plan limits, but not eight figures: lines added and removed, thinking on or off, output style, the pull request, the model's display name, the session duration and the effort level. **Settings → General → Session telemetry (statusLine)** is still where those come from, so turning it off blanks them. The details are under [Where the figures come from](usage.md#where-the-figures-come-from).

The per-session state is in the hover preview and in the [System Monitor](system-monitor.md#what-you-see). If a session says `legacy` and you want to know why, see [Troubleshooting](troubleshooting.md#harnu-mod-legacy).

## Editor

The Topbar has an **Open in {editor}** button (and the folder's page has the same action) that opens the selected folder in your editor. By default it launches VS Code with the `code` command. **Settings → General → Editor** changes that:

- **Presets** — VS Code, Cursor, Zed, Sublime Text, JetBrains (IntelliJ IDEA or WebStorm, whichever launcher Harnu finds), Neovim and Helix. The button shows that editor's own icon, and its tooltip reads "Open in Cursor", "Open in Neovim" and so on. The row's hint names the command a preset runs (`cursor`, `nvim`, …).
- **GUI editors** (VS Code, Cursor, Zed, Sublime Text, JetBrains) start as a separate process, so they keep running when you close Harnu.
- **Terminal editors** (Neovim, Helix) open inside Harnu: a terminal pane in the selected session's split, running the editor in that folder. With only a folder selected and no session, it opens as a terminal for that folder instead. Quit the editor as you normally would; the pane stays open until you close it.
- **Custom…** — type a command with a `{path}` placeholder, for example `nvim {path}` or `code --reuse-window {path}`. Harnu splits it into arguments itself, with no shell involved: quotes group words, `{path}` becomes the folder as exactly one argument (so spaces or symbols in a folder name are safe), and a command without `{path}` gets the folder added at the end. `|`, `;`, `&&` and `$VARIABLE` have no special meaning. Switch on **Runs in a terminal** for a terminal editor; leave it off for a GUI one. A custom editor uses the generic `<>` icon and reads "Open in editor".

Harnu only looks for the command on your `PATH` (plus the usual install locations on macOS); it does not scan for installed editors. If it can't find the command, a toast names it and points back to this setting. For VS Code, install the shell command from VS Code's Command Palette ("Shell Command: Install 'code' command in PATH").

The choice is saved in `settings.json` and applies on the next click, no restart. The action also has a [shortcut](sessions.md#customizing-shortcuts) you can bind: `folder.openInEditor`.

## Keyboard Shortcuts

**Settings → Keyboard Shortcuts** is a point-and-click editor for the same `keybindings.json` covered in [Sessions → Customizing shortcuts](sessions.md#customizing-shortcuts) — you never have to open the file by hand. Open it straight on this tab with `Cmd/Ctrl+Alt+S` or **View → Keyboard Shortcuts…** (on macOS, **Harnu → Keyboard Shortcuts…**, right after Settings…).

- One row per rebindable action, showing its current chord. The Topbar's folder actions (roadmap board, PR Stack, open in file manager, open in VS Code, pull requests on GitHub, Browse files, open a terminal) are listed too, along with the usage overview; they ship with no chord and read **Set a shortcut…** until you give them one. Settings itself opens with `Cmd/Ctrl+,`, which you can rebind here too. **Click the chord, then press the keys you want.** `Esc` cancels the recording (Settings stays open), `Backspace` unbinds the action.
- **Find a shortcut fast.** The search box at the top takes either words or a key combo. Words match an action's name (in your app language), its chord or its id: `session`, `palette`, `sidebar`. A combo — anything with a `+` or a modifier, an F-key, `Esc`, or a Mac symbol like `⌘K` — lists exactly the actions on that chord, so `Ctrl+K` answers "what is on Ctrl+K?" (on Linux and Windows `Ctrl` and `Cmd` count as the same key). A single key name such as `delete` or `left` does both: it lists actions on that key _and_ actions whose name contains the word.
- Rows are grouped under **Sessions, Sidebar, Folders, Views, Panes, Takeovers** and **App**; a group with nothing to show is hidden.
- The **Unbound**, **Conflicts** and **Customized** chips under the search narrow the list to actions with no chord, actions sharing a chord with another one, or actions you changed. Each chip shows how many such actions exist in total; turn on several and they combine with each other and with the search. When nothing matches you'll see **No shortcut matches.**
- Some combos can never fire for an action that has no native menu item: Shift plus a punctuation key (Harnu sees the shifted character instead, e.g. `<` for `Ctrl+Shift+,`), and on macOS Option plus a letter. The recorder refuses those, keeps the old chord, and says so under the row. A combo typed by hand into `keybindings.json` still loads.
- **Reset** on a row drops your override and restores the built-in default; **Unbind** clears the chord entirely. A row already at its default hides **Reset** (nothing to reset) but still offers **Unbind** — unless it has no chord at all.
- **Reset all** (top right) clears every override at once.
- If two actions end up on the same chord, both get a **conflict** badge naming the other. The chord still fires once — the first-registered action wins and the other stays inert — so nothing breaks silently, but you'll want to rebind one.
- Actions marked **not in terminal** have no native menu item, so a custom chord for them won't fire while the terminal pane has keyboard focus.
- Five actions — quit, reload, toggle DevTools, fullscreen, and "Open keybindings.json" (`Cmd/Ctrl+Alt+K`) — are reserved and aren't listed. Session back/forward isn't listed either; it can't be rebound yet.
- **Open keybindings.json** (top right, or **View → Open keybindings.json**, or `Cmd/Ctrl+Alt+K`) opens the raw file in a split-pane editor when you'd rather edit the JSON directly. It needs an active folder to open the pane in.

Every edit writes `keybindings.json` immediately and applies live, so this pane and a hand-edited file always agree.

## Sidebar

The **General** tab has a SIDEBAR section that controls how the folder/session list looks and behaves:

- **Density** — **Comfortable** (default) or **Compact**. Compact tightens the sidebar's row heights, the session-row gap, and the left indent of session rows, so you fit more sessions on screen and give long names more room. It only affects the sidebar — nothing else in the app changes. Your choice is remembered across restarts.
- **Sort folders by** — Recent activity or Name.
- **Sort sessions by** — Attention, Recent activity, or Name.
- **Show sessions within** — hide sessions older than a window (All / 24h / 48h / 7d) inside each folder; the selected and live sessions are never hidden.
- **Active-elsewhere window** — how recently a non-pinned folder must have been active to show up in the "Active elsewhere" zone.

## Quitting

The **General** tab has a QUITTING section with one switch, **Confirm before quitting while agents are working** (on by default). While it is on, closing the window or quitting (Ctrl+Q, the app menu) shows a native prompt if any session is actively working at that moment, so you don't kill a turn by accident. See [Quitting Harnu](sessions.md#quitting-harnu) for what the prompt shows. The prompt's own **Don't ask again** checkbox turns this switch off; come back here to turn it on again. The choice survives restarts.

## Daily budget

**Settings → Usage history** has a **Daily budget** group that drives the `Today` row in the footer's usage popover — what that row actually means is explained under [Usage](usage.md#today--your-daily-budget).

- **Working days** — seven buttons, Mon through Sun. The days you tick are the ones your weekly allowance is split across; the default is **Mon–Sat**. Untick a day and it becomes a day off: the row still reports what you spent, it just stops measuring it against a budget.
- **Unticking every day switches the feature off.** That is a supported state, not an error — the readout drops to zero and the `Today` row disappears from the popover entirely.
- Below the buttons, a live readout — `5 working days → today's budget 12%` — pairs how many days you have ticked with what today's budget works out to, so the effect of ticking Sunday is visible without opening the footer. It previews the split as it stands right now, rather than the start-of-day figure the popover freezes, so once you have spent something today it reads a little lower than the popover. The popover is the number of record.

The alert lives in the other tab: **Settings → General**, in the **OS notifications** group, as **Daily budget alerts**. It is **on by default** and fires at most twice a day — once when you cross 80% of the day's budget, while it is still correctable, and once when you cross 100%. It does not repeat: the crossing is remembered across restarts, so relaunching Harnu mid-afternoon will not replay an alert you already saw, and a new day re-arms both steps. Turning the master **OS notifications** switch off silences it along with everything else.

## GitHub API budget

Harnu asks GitHub (through your `gh` login) about pull requests, CI and reviews, and every one of those requests spends **your** quota: 5,000 REST requests and 5,000 GraphQL points an hour, shared with every other session, script and monitor using the same account. Harnu keeps an eye on that budget so it never spends you dry.

- **It reads the budget once a minute** with `gh api rate_limit`, which GitHub does not charge for. If `gh` is missing or not signed in, Harnu treats the budget as unavailable and only looks again every ten minutes. It follows whichever of the two buckets (REST or GraphQL) has the smaller share left.
- **It counts its own calls** per feature — missions, PR Stack, Review, Cleanup, the mission steward and the merge batch — so it can tell what it spent from what the rest of your account spent. "Outside Harnu" is GitHub's figure minus Harnu's count, so treat it as an estimate.
- **Near the limit it slows down.** When the tighter bucket drops to **15 %** or less (10, 15 or 25 %), Harnu keeps mission PR and main-CI results for five minutes instead of one and pauses PR Stack's background refresh (opening the canvas, or pressing Refresh, still reads GitHub). At zero it stops reading GitHub altogether, shows the last values it knew, and starts again by itself after the reset. If `gh` ever prints "rate limit exceeded", Harnu checks the budget at once: when a bucket really is empty it stops as above, but when you still have calls left (GitHub's separate "secondary" limit, which can hit with budget to spare) it only pauses its reads for a minute, or for the wait GitHub asks for, and carries on.
- **Your own actions are never held back.** Posting a review, merging, and marking a file viewed always go through.
- **Delivered missions are not checked on GitHub.** A mission that has been delivered keeps the pull-request and CI state it last had. A `Check delivered missions` switch (off by default) turns the checking back on.

### The footer pill

A **GitHub** pill sits in the footer, left of the Cleanup pill, and shows how many calls are left in the tighter bucket (`4,112 left`). It turns amber while Harnu is slowing down (`640 left`) and red once the limit is spent (`0 left · 12m`, with the time to the reset). It is hidden while the budget is unavailable — `gh` missing, not signed in, or no answer yet.

Click it for the popover: the **REST** and **GraphQL** meters (they turn accent from 80 % used and red from 95 %, like the Plan usage meters), and **Who spent it · this hour** — a split bar of Harnu against everything outside Harnu, and one row per Harnu feature. While Harnu is slowing down the Missions row says _slowed_; once the limit is spent every Harnu row says _paused_, and a note explains what Harnu changed and when it resumes. **Details ↗** opens the Settings pane. When GitHub itself slows Harnu down while your buckets still have calls (its secondary limit), the note says _GitHub is slowing requests. Harnu resumes at 14:00._ and the pill keeps the real number of calls left — it is not the same as running out. Esc or a click outside closes the popover.

### Settings → GitHub API

The tab shows the whole picture and holds the slow-down rules:

- **Tiles** — REST and GraphQL left (and when each resets), and the **pace** over the last 10 minutes: calls per minute, whether the budget lasts past the reset or runs out first, and how that splits between Harnu and everything else.
- **Last 60 minutes** — twelve 5-minute columns for the tighter bucket: Harnu, Harnu while slowed, and outside Harnu.
- **Who spends it · this hour** — each Harnu feature with its calls, its share and how often it checks (`1 min`, `on open`, `on event`, …). While Harnu is slowing down the old cadence is struck through next to the new one; delivered missions show as _not checked_.
- **Check delivered missions** — off by default.
- **Slow down below** — 10, 15 or 25 % of the tighter bucket.
- **Pause PR Stack auto-refresh** — on by default; the canvas then refreshes when you open it, not in the background, while Harnu is slowing down.
- **Tell me when it happens** — on by default: one toast when Harnu starts slowing down and one system notification when the limit is reached, each at most once per GitHub window.

Every control saves as you change it (to `github-budget-prefs.json` in Harnu's data folder; a missing or damaged file just means the defaults). The numbers for Harnu's own share are counts of its calls, and "Outside Harnu" is GitHub's total minus that, so it is an estimate. When the limit is spent, PR Stack says _GitHub API limit reached, resets at 14:00_ and keeps showing the last read.

## Cleanup

**Settings → Cleanup** is the one place that controls how Harnu cleans up after finished work. Every change saves as you make it, and the numbers you type are applied about half a second after you stop typing. If you type a value outside the allowed range, Harnu keeps the nearest allowed one and the field shows what it kept. The tab is the settings behind the [Cleanup](cleanup.md) screen, in five groups.

**Autopilot**

| Setting                             | Default | Range                      | What it does                                                                                                                                                     |
| ----------------------------------- | ------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clean ready worktrees automatically | off     | on / off                   | Turns automatic cleaning on. The first cycle after turning it on only reports; automatic cleaning starts once you acknowledge that report on the Cleanup screen. |
| Run every                           | 1 hour  | 30 min / 1 h / 6 h / daily | How often the cycle runs. It is the same timer as the background scan, so this is the one interval setting for both.                                             |
| Grace period                        | 2 days  | 0 - 30 days                | How long a worktree must be quiet (no session activity, no container start or stop that Harnu did not cause) before it can count as ready to clean.              |
| Per-cycle cap                       | 20      | 1 - 200 worktrees          | The most worktrees one automatic cycle cleans. The rest wait for the next cycle. Cleaning by hand is not limited by it.                                          |

The autopilot rides the background scan, so it needs **Automatic background scan** (in the Scan group below) to stay on.

**What it cleans** (these switches govern the autopilot; cleaning by hand always asks first)

| Setting                                | Default | What it does                                                                           |
| -------------------------------------- | ------- | -------------------------------------------------------------------------------------- |
| Worktrees                              | on      | Off: the autopilot cleans no worktrees.                                                |
| Docker build cache and dangling images | on      | Off: no build-cache or dangling-image pruning. It never removes an image a stack uses. |
| Build cache max age                    | 7 days  | Build cache older than this is pruned (1 - 365 days).                                  |

**Docker volumes are always kept.** There is no switch for this: cleaning a worktree, by hand or automatically, never removes its volumes. Once the worktree is gone they appear in Needs review as orphan volumes, with their size and compose project, and you remove each one yourself. A removed volume and its data cannot be restored.

**Archives** (what every removal leaves behind in git; see [Archives and the trash](cleanup.md#archives-and-the-trash--cleanup-cleans-its-own-leftovers))

| Setting                       | Default | What it does                                                                                                                                                                                       |
| ----------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep archives for             | 30 days | Archive refs older than this are offered for deletion on the Cleanup screen, after you confirm the list (1 - 3650 days).                                                                           |
| Expire archives automatically | off     | On: the autopilot itself deletes the archive refs older than the setting above. A deleted archive cannot be restored, and git frees the space on its next gc (Harnu never runs `git gc` for this). |

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

## Your move

**Settings → Your move** is where you choose whether Harnu reads your sessions to tell when the ball is yours: a question left unanswered, a decision, a step only you can do. It is built in stages, and this first one is a way to watch it work before it ever interrupts you.

The mode has three values:

- **Off** — the default. Nothing is read and nothing is spent.
- **Observe** — when a session stops, Harnu reads what it wrote since the last check and asks two independent, isolated Claude calls whether anything is waiting on you, then one more call to write each card clearly (a short context, what it blocks, the options and a recommendation when the session gave one). If either detection call fails, Harnu uses the other; if the writing call fails or returns nothing, the cards are filed as the detection found them, and a card it leaves out is filed as found, never dropped. Two detections of the same item are merged into one card. What it finds is stored as a card and listed at the bottom of the tab. Nothing shows in the sidebar and nothing makes a sound.
- **Live** — Harnu checks sessions the same way, and lists what it finds as cards in the **Return here** box at the bottom of the sidebar, oldest first, each with a clock that keeps running until you deal with it. See [Return here: sessions waiting on you](sessions.md#return-here-sessions-waiting-on-you). For now the answer buttons on a card open the session instead of answering for you.

Each check uses your own Claude quota: about US$ 0.002 and several seconds across those calls, run in the background at low priority and never more than half your CPU cores at once. The calls are isolated: it has no tools, no settings and no project files, and it never answers or changes a session.

**Inspect selected session** runs one check on the session you have selected, so you can see a card appear without waiting for a stop. The result sits beside the button: checked, nothing new, skipped (the mode is Off, the folder is blocked for agents, or the session is archived) or failed, with the reason.

The list shows every card Harnu stored, open ones first and then the newest closed ones. A card carries a kind (Decide, Go / no-go, Provide, Do or Check), the folder and session it came from, and the one-line ask, shown exactly as the model wrote it. The list is read-only: no card can be answered or dismissed yet.

### What files a card

With **Observe** or **Live**, a card is filed for each of these, with no button to press:

- **A finished turn.** Two seconds after a session stops, Harnu reads what it wrote and asks whether anything is waiting on you. This never delays the session: Harnu answers the stop first.
- **A long turn that never stops.** A session that has been working for five minutes without a check is looked at again; what it finds is kept in a separate lane that stays hidden for now, and the real check still happens when the turn ends and reads everything from the last stop on. A check that fails is not retried for five minutes.
- **A session that died or could not be checked.** A stop on an error (rate limit, overload, billing) or a process that ended while a turn was still running files "Session stopped", even when the session shut down gracefully and Claude Code reported it finished first; a session Harnu failed to check files one "Could not check this session" for the whole run of failures. Your own Ctrl+C, closing the session and parking it are not deaths. A later good turn closes these cards.
- **A mission.** Every blocker you own, a re-scope to approve, a close to confirm, a paused steward, due checks, a human step, an imported end to review and a red main after a merge. The card points at the mission's owner session and closes when the mission stops owing it; it never changes the mission, and a child session's approvals and waiting-for-input items file nothing.
- **A question parked in a session.** A session waiting on `AskUserQuestion` or `ExitPlanMode` files a card that opens the session, whatever else the session wrote after asking. The card closes when the question is answered or the session next stops, and never because Harnu could not read the transcript. A normal tool permission does not file one: it stays in the Approval Inbox.

Archiving a session closes its cards, and so does removing its folder from the sidebar: only the cards of that exact folder, not those of a folder nested under it. Hiding a folder does not, and switching a folder off for Your move leaves its mission cards where they are. Harnu's own background runs (the auto-namer, the usage poller) are never checked, and with the mode **Off** nothing is read at all.

When you switch from Off to Observe or Live, Harnu forgets where it had read up to in every session, so the days spent Off are never judged. The first stop after that reads the most recent part of the transcript, up to 256 KiB.

## Hibernation policy

Harnu automatically parks (hibernates) idle sessions to keep memory use in check — see [System Monitor](system-monitor.md) for what a parked session looks like and how to park one on demand. This tab controls the policy behind that:

- **Max concurrent sessions** — how many sessions can stay live before the coldest one is parked to make room for a new one.
- **Idle threshold (cap)** — how long a session can sit unfocused before it's eligible for that eviction.
- **Idle threshold (sweep)** — how long a session can sit idle before a periodic sweep parks it regardless of how many sessions are open.

Edits save automatically and take effect on the very next hibernation check — no restart required.
