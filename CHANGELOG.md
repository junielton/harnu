# Changelog

All notable changes to Harnu are recorded here, newest first. Format follows
[Keep a Changelog](https://keepachangelog.com/); each entry is grouped under a
`## YYYY-MM-DD` date with `### Added` / `### Changed` / `### Fixed` sections.

> **This file is mandatory.** Every feature or fix must add a dated entry here in
> the same change — see the "Changelog is mandatory" contract in `CLAUDE.md`.
>
> Ids such as `T212` or `BUG-64` refer to the maintainer's internal board, and links
> to `docs/specs/…` mockups point to files kept out of the public repository.

## 2026-10-09

### Changed

- **The Fleet rail no longer jumps around.** Cards used to reshuffle every time a session wrote
  anything, so with a few sessions running the list never stayed put. Inside each state group
  (needs input, errored, stuck, working, done) cards now stay in the order the sessions were
  created, newest on top, and activity never moves them. The groups keep their usual order, and
  the minimized strip follows the same order. A new button in the rail header (next to the
  state filter) flips it to oldest first; Harnu remembers your choice.

### Fixed

- **A mission no longer appears twice when two clones of a repo hold the same mission files.** Missions are now listed once by id, in the app and for the agent's `mission_list`: the newest copy wins, and a mission you closed stays closed even if an older clone still says it is active. This also stops the "N missions need you" notice from counting and naming the same mission twice.
- **Missions no longer nag.** The sound, taskbar nudge and Activity entry for a mission that needs you used to repeat every 30 minutes for everything, and replayed your whole backlog each time Harnu started. Now a to-do nobody is blocked on (a delivered mission waiting for your close, due checks, an imported finish line to review) rings once and is never repeated, while things an agent is waiting on (a blocker, a re-scope, a step to confirm) are repeated after 30 minutes, 1 hour, 2 hours and 4 hours and then stop. Harnu now remembers what it already told you, so opening it again only rings for what became waiting while it was closed.
- **A clean no longer leaves "Needs review" ghosts behind.** After every successful clean (the big button, **Remove**, **Clean now**, **Retry**, even the last item before "All clean") the cleaned worktrees used to come straight back as hatched Needs review items saying "Another worktree lives inside this one", with a raw `ENOENT … scandir` error in the panel, while the totals stayed inflated. Only **Scan now** fixed it. Cleaned items now leave the screen the moment the clean ends, the totals match, and the screen reaches "All clean" on its own. A worktree whose folder no longer exists is simply absent, never reviewed.
- **A cleanup that stops partway no longer disappears.** When a clean trashed a worktree's folder but then stopped at the git steps (pruning the registration or deleting the branch, for example because of a git lock), the item used to vanish from the screen while the toast still said "1 needs review". It now stays in Needs review as "Cleanup stopped at …" with the step and the folder, until it is dealt with. Retry cannot finish those git steps when the folder is already gone, so for such an item Cleanup hides Retry, Remove and Dehydrate and shows, in the panel and the list, the step it stopped at and the exact commands to finish by hand (`git -C <repo> worktree prune`, plus `git -C <repo> branch -D <branch>` when the branch is still there and its commit is archived, or the safer `branch -d` with a warning when it is not). The archive refs keep the commit recoverable once the archive step had run. A folder you deleted by hand gets the same note. A real resume is planned.
- **Cleaned items stay gone even if another refresh was already running.** A refresh that started before a clean (Keep, or opening Cleanup) could finish afterwards and bring the cleaned items back. Refreshes that began before a clean ended are now discarded.
- **A broken symlink is no longer treated as a cleaned folder.** A worktree whose folder is a link to somewhere that no longer exists lands in Needs review instead of vanishing.
- **Halted items no longer show raw errors.** A "Cleanup stopped at …" reason shows the step and the folder only; the engine's own error text goes to the log. Remove on an item Harnu could not look inside no longer claims another worktree lives inside it, and the bulk Remove dialog now shows the translated reason for every code.
- **"Harnu could not look inside" has its own reason.** When Harnu cannot read a worktree's folder to check for other checkouts (a root-owned folder, say), the item now says so in plain words and names the folder, instead of claiming another worktree lives inside it. The raw error text is no longer shown, and Remove stays unavailable for that item with a sentence that says why. `list_cleanup` reports the new `check-failed` reason code for it.

- **Cleanup no longer warns about hidden orphan volumes when none could be hidden.** The Docker card said "Orphan volumes: hidden" with a list of folders even when every volume belonged to a running stack. The warning now shows only when some volume is used by no container and a compose project name could not be resolved; otherwise the card reads "No orphan volumes". The card also says plainly that it counts only build cache older than N days and dangling images, never images in use or the volumes of live stacks.

## 2026-10-08

### Added

- **Ask for an opinion on Needs review items.** In Cleanup, **Ask for an opinion** (in the
  selection bar, the panel, or "on all" above the Needs review list) now works. It starts a
  read-only model session that looks at each item you picked (the diff against the default
  branch, the uncommitted files, the pull request, the reason it needs review and the last
  chat in that folder) and answers **safe**, **keep** or **unsure**, with a reason and the
  evidence behind it. The answer shows as a chip on the row, with the reason and evidence on
  hover and in the panel. **Remove the N marked safe** then selects exactly those items and
  opens the usual remove dialog, where you still confirm each one. The opinion is advice
  only: it never removes anything and never runs by itself. The session reads files in the repository
  folder with `Read`, `Grep` and `Glob` only: no shell, no tool that writes a file, no web tool
  and none of Harnu's own tools. The Claude CLI's own check keeps it to that folder, but the CLI
  may still allow a few of its own working folders, so Harnu explicitly blocks Claude's data
  folder (`~/.claude` and `CLAUDE_CONFIG_DIR`) and Claude's temp folder, and switches auto memory
  off, so a repository's `MEMORY.md` is not added to what it sees (auto memory is off). On Windows, where there is no per-user temp folder name to block, only `~/.claude` (and `CLAUDE_CONFIG_DIR`) are explicitly blocked. If a blocked folder's path could not be written into a rule, Harnu does not run the advisor and answers unsure. Inside the
  repository folder any file can be opened, ignored files such as `.env` included (a hard link
  there to a file elsewhere reads as a file inside it). What it opens is sent to the model like
  any Claude request. If git fails to produce a fact for an item, Harnu says so and answers unsure
  itself. Right before the dialog opens, Harnu re-checks the marked items and leaves out any it
  can no longer confirm as safe. Each question uses model tokens (it runs as the cheap "scout"
  tier of the folder's model routing table, Haiku at low effort by default). Answers are kept
  until the item changes (a new commit, different uncommitted files, a different pull request
  state), so asking again costs nothing, and the chips come back by themselves after you reload
  the window.
- Scheduler workers have a **Network access** switch (Settings → Permission, `observe` workers only). It is off by default. Turning it on gives that worker `WebFetch` and shows a red warning, because a worker that can read any file and also reach the internet can be talked into sending a file out by anything malicious it reads. Workers you already had start with it off, and one Activity entry lists the ones whose prompt mentions a URL or `WebFetch`, so you can switch it back on. When a Claude session asks to turn it on through `create_worker` or `update_worker`, Harnu now asks you first.

### Changed

- **Cleanup polish.** Docker bytes now get their own "Docker (cleaned each cycle)" segment in the split bar, so "Ready to clean" agrees with the big button. While a clean runs, the line under the bar reads "Cleaning now · N left". The selection bar's Remove, Dehydrate and Keep have icons. The dialog and the side panel use the same `proj/www` repo label as the map, so two repos called `www` stay apart. Portuguese now calls the review group "Precisa de revisão" everywhere in Cleanup.
- **Cleanup now matches the approved mockup more closely.** Every map region shows its repo as a monospace `proj/www`-style label (the full path on hover), a legend row under the split bar names the three groups and says what a block's area means, Map / List and Scan now have icons, and the Docker card has a "runs each cycle" subtitle, a split bar of cache, images and orphan volumes, and draws orphan volumes in the amber review colour. The confirm dialog gained a close button, icons on the chips and the confirm button, monospace row titles, a one-line breakdown ("3 stacks stopped · 12 dependency folders removed · 12 worktrees trashed") and a "12 ready · 6.44 GB" footer.
- **One unit everywhere in Cleanup.** Sizes use the app's decimal GB/MB on every surface; the docs examples follow.

### Fixed

- **Cleanup map is readable with many repos.** Repo regions now wrap onto several rows (never narrower than 340 px, with a gap between them) and the map grows downward instead of squeezing every repo into one row. Repo names and bucket headers are no longer cut off, a repo name that is too long ends in an ellipsis with the full path on hover, and a worktree block shows its name and its whole size or folds into "N smaller" — a size is never cut off mid-number.
- **Cleanup no longer says "All clean" before the first scan.** Until Harnu has scanned your worktrees the screen reads "Scanning your worktrees…" and the clean button is disabled; a failed first scan is reported instead of looking clean.
- **Cleanup tooltips tell the truth about In use blocks.** Hovering an In use block now says why it is in use (a session is working there, its pull request is open, it is inside the grace period, the main checkout, or you marked it Keep) instead of the Ready-to-clean sentence.
- **Cleanup's orphan-volume hint is two lines.** A hidden orphan-volume list now reads "Orphan volumes hidden: a compose project name couldn't be resolved in N folders" with a "Show folders" link, instead of a wall of folder names; the Docker cards are as tall as their own content, and the split bar's Docker segment no longer truncates its caption.
- **Cleanup can start a clean and enable the autopilot again.** "Clean N ready" failed at once with "An object could not be cloned", and "Enable autopilot" acknowledged the report but never turned the autopilot on. Both sent live view state across to the main process in a form it rejects; Cleanup, the Reaper and the Settings panes now send plain copies. The first-cycle banner also disables its buttons while it works and shows an error toast, instead of staying silent, when a click fails.
- **No raw codes in Cleanup.** Items stopped because they became dirty, hold another repository's checkout, or could not be unregistered from git now say so in a sentence; any other reason reads "Harnu stopped this item for a safety check", with the raw text only behind Copy error. Every pipeline step has a label.
- **No Remove on an item that holds another worktree or that git has locked.** It could never succeed, so the button and its R shortcut are gone, with a line saying why.
- **The Docker card says when orphan volumes are hidden.** If a compose project name could not be resolved (or the compose scan hit its limit), the volumes block now reads "hidden" with a note naming the folders, instead of a misleading "0 volumes".
- **Cleanup no longer invents a history of what ran.** After a failed clean the panel says what happened ("Nothing was changed", or "Stopped at <step>: <reason>") instead of ticking steps that never ran, and Docker volumes never show up as removed.
- **Retry works for every failed item.** A failed ready item reopens the ready confirmation; a review item opens the review one.
- **The confirmation can no longer drift under you.** If a scan or a running job changes what the dialog showed, it says "This changed since you opened it — review again" and Confirm stays off until you reopen it; what is sent is what you saw when it opened, including the worktree's folder.
- **Every refusal has a plain sentence** in English and Portuguese (grace period not elapsed, protected now, another worktree inside it, and the rest), the needs-review counter ignores items you chose to keep, Keep skips orphan volumes, a failed Remove or Keep shows an error toast, and R / D / K / A work as the panel's shortcuts.
- **Toast copy:** "1 cleaned · 1 needs review" / "… · 2 need review", and the success toast offers "View journal".
- Scheduler `observe` workers can no longer be made to run shell commands through a skill. A skill's `hooks:` header runs commands on its own, outside the tool allowlist, and a repo could ship a skill with the same name as one of Harnu's (for example `delivery-watchdog`) to get it staged. An `observe` worker now always resolves a name Harnu ships to Harnu's own skill (in any letter case), and only loads a personal or project skill it can read as plain text: a header that mentions `hooks`, hides a key with YAML tricks or does not parse is refused, and so is a skill folder holding a symbolic link, a `hooks` folder or other unexpected files. A header whose opening or closing `---` line has anything extra on it (a trailing space, an invisible character, text in front) is refused as well, since Claude Code reads those as valid. The skill is read once and exactly what was checked is what is loaded. Refusals show in the Runs tab as `rejected skill`, and `create_worker`/`update_worker` warn about them. `act` workers are unchanged.
- `observe` workers now see only the Harnu tools they are allowed to use. Tools such as `update_worker`, `delete_worker`, `plan_mission`, `open_file` and `speak` used to appear in their tool list (they were refused only when called); every Harnu tool that is not on the allowed list is now denied by name, and a tool added in a future version is denied by default.
- The one-time notice about workers losing network access is now reliably delivered. It used to be sent while Harnu was still starting, when nothing could show it, and was then lost for good; it is now kept until it has actually been delivered, and refers to the **Network access** switch by name.
- Scheduler `observe` workers no longer have a shell. Their allowlist used to include `git log`, `git diff`, `git show`, `git status` and a few `gh` commands, and a "read-only" `git` command can still write a file: `git log --output=<path>` overwrites any path, so text from a commit message could land in `.git/config` and run as a command on the next `git status`. `Bash` is now denied outright in `observe` mode; the delivery watchdog reads worktrees and PRs through Harnu's own tools instead. The **Extra read commands** field is gone from worker settings, and any saved rules are ignored and listed as `rejected rule` in the Runs tab. `act` workers are unchanged.
- Closed the rest of the same hole for `observe` workers: Harnu now starts each tick with `--tools Read,Grep,Glob,Skill` (plus `WebFetch` only for a worker you opted in to Network access), so the CLI loads no other built-in tool. Before this, `Monitor` (which runs commands), `EnterWorktree` (which runs `git worktree add` and any `post-checkout` hook), the scheduled-task, workflow and `SendMessage` tools and `ToolSearch` were still loaded and callable even with `Bash` denied. They are also denied by name as a second layer, and so are the Harnu tools an `observe` worker may not call, so they no longer appear in its tool list at all.
- **Saving the Containers settings can no longer come back as the defaults.** If the settings were still loading in the background when you saved (a slow disk, a busy machine), the save was written correctly but the window briefly showed the default values instead of what you had just saved. The saved values now always stand.

## 2026-10-07

### Added

- **Sessions can read the cleanup list and release a finished worktree.** Two new agent
  verbs: `list_cleanup` shows the same Ready to clean / Needs review / In use picture the Cleanup
  surface uses (reasons, sizes, orphan volumes, whether the automatic cleanup is on, when the next
  cycle runs; worktrees shown by name, never by path) and is open to read-only Scheduler workers, so a
  worker can report how many worktrees are ready to clean. `release_worktree` lets a session say its merged
  worktree is done, which skips the grace period so it becomes ready to clean at the next scan.
  A release never overrides a safety rule (uncommitted work, an open session, a shared
  Docker stack, a worktree nested inside it, a worktree git has locked, Keep, never-clean, an unresolved path all still hold it back) and it deletes nothing: neither
  verb removes anything, and no agent can clean a worktree. A release belongs to the commit it was made at, and a
  session can name the worktree by its folder or by the name the list gave it. See [Agent control](docs/user/agent-control.md).

- **Automatic cleanup of merged worktrees and their Docker stacks.** Harnu can now clear
  worktrees whose branch is proven merged, together with the Docker stack running from
  each one, on the same hourly timer as the Cleanup scan. It cleans only worktrees it can
  prove are finished: merged for real (the pull request's last commit is the worktree's
  commit, or git itself shows the work is in main), clean, past a grace period, and with no
  Harnu session running in them. It is off by default, and the first run only reports what
  it found ("Found N ready to clean, X GB - enable automatic cleanup?") and deletes nothing. A
  stack's containers, the code (kept as `refs/archive/…` refs), the dependencies, the folder
  and the local branch go in a fixed order, one worktree at a time, and a failure stops that
  worktree only. **Docker volumes are never removed with a worktree**, by the automatic cleanup
  or by hand: they stay, and show up afterwards as orphan volumes for you to review. A cycle that cleaned something posts one
  notification. The Containers view now marks a stack from a merged worktree as a zombie as
  soon as the branch is merged instead of waiting for the idle clock. For now there is no
  settings screen for it: the options live in `gc-prefs.json` in Harnu's settings folder and
  the screen arrives with the next Cleanup update (see [Cleanup](docs/user/cleanup.md)).
  A worktree whose
  cleanup stopped partway shows as needing review, not as ready to clean, everywhere in Harnu.
- **Automatic cleanup is stricter about what is still in use.** Time since the last activity
  now counts any terminal under the worktree, including `claude` runs started outside Harnu and
  sessions parked a while ago, and sessions reached through a symlink. A worktree, or a clone of another repository, inside
  another worktree needs review, and so does one Harnu could not look inside (the reason names
  the folder and the error). A Docker Compose project name written in a subfolder (`docker/compose.yml`,
  an `.env` there, `${VAR}` read from the `.env` beside it) keeps its volumes out of the orphan
  list, and a name that cannot be resolved keeps every volume out. Pressing Keep is remembered
  against the item's state at that moment, a partial settings write no longer resets other
  settings, and cleaning a worktree now unregisters only that worktree from git instead of
  pruning every stale entry in the repository.
- **Automatic cleanup counts every kind of session, and a Keep protects at once.** Headless
  runs (`claude -p`, including Harnu's own scheduled workers) and a stale legacy session index
  now count as activity for the grace period. Pressing **Keep** protects the worktree
  immediately instead of after Harnu has re-checked it, even while a cleaning cycle is already
  running. If Harnu cannot read every compose file it needs to (a scan limit, or a project name
  it cannot resolve), it lists no orphan volumes and says why. Cleanup notifications use the
  same decimal units (`GB`) as the screens.
- **A clean never deletes anything permanently.** If Harnu cannot match a worktree to its own
  registration in git (even through a symlinked path), it leaves the worktree untouched and
  reports why, instead of asking git to remove it for good. Pressing **Keep** again on an item
  that is already kept never drops its mark. If Harnu cannot read Claude's transcripts folder,
  or cannot tell which folder a transcript belongs to, it counts the activity as possibly
  belonging to the worktree and keeps it out of the ready list.
- **Locked worktrees are left alone, and Harnu says so up front.** A worktree you locked in git
  (`git worktree lock`) now shows in Needs review with "This worktree is locked in git", and
  Harnu checks again before it stops any container: if git cannot unregister a worktree, nothing
  is stopped or removed. A lock also counts when a stale duplicate registration points at the
  same folder. If Claude's folder exists but its transcripts folder is missing, Harnu treats
  recent activity as unknown and cleans nothing automatically.
- **Docker housekeeping in the same cycle.** When automatic cleanup is on, each cycle also
  clears Docker build cache older than a week and dangling images, and reports how much it
  freed. It never touches images a stack uses and never removes a volume: volumes nobody uses
  any more, including the ones a cleaned worktree left behind, are listed with their size for
  you to remove one by one, each after its own confirmation, and **a removed volume cannot be
  restored**.
- **Cleaning in the background.** Removing worktrees by hand no longer holds the window: it
  starts a job, reports progress item by item, survives a reload of the window, and a second
  request waits for the first instead of running beside it. Worktrees that Cleanup is not
  sure about (an unmerged or dirty branch, say) can be removed on purpose after an explicit
  confirmation; their code and uncommitted work are archived to `refs/archive/…` first. The confirmation is for what you were
  looking at: if the worktree changed after you clicked (a new commit, a Docker stack that
  started), Harnu refuses it and you look again.

- **The Harnu mod.** Harnu now loads a small mod into the `claude` sessions it starts, so
  it can read what a session is doing from the inside instead of guessing from hooks and
  files. For now it only watches: your sessions behave exactly as before, and every fact
  Harnu already read the old way is still read that way. The mod runs unsandboxed inside
  the `claude` process and talks only to Harnu on this machine. A one-time notice
  explains this the first time you open Harnu after the update; sessions you started
  before you saw it keep running without the mod. For now the
  commands Harnu can send through the mod are housekeeping only (a channel check),
  nothing that steers or approves a session.
- **A switch for it.** Settings → General → Integrations has a new **Harnu mod** switch.
  Off stops Harnu from using the mod right away, switches it off in running sessions and
  keeps it out of new ones; on again reaches new sessions only. Off means the hooks and
  polling Harnu used before.
- **Harnu mod outside Harnu (opt-in).** Settings → Mods → Advanced has a new switch that lets
  `claude` sessions you start in your own terminal load the Harnu mod too, so Harnu can show
  their real state instead of guessing. It is off by default and asks first: turning it on adds
  one folder to `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`, and turning it off
  removes exactly that entry. Harnu shows an outside session only once its own watchers confirm
  it, never starts prompts in it, never writes into its terminal and does not hold its
  approvals. On a machine with managed settings the switch refuses and writes nothing.
- **The state of the mod, per session.** The hover preview shows one quiet line (`Harnu
mod: live`, `off`, or `legacy` with the reason), and the System Monitor shows the same
  state next to each live session. `legacy` is not an error: it means the session runs
  on hooks and polling, for example because it was started before the notice, because the
  installed Claude Code is older than 2.1.287, or because mods are turned off by a
  setting or by your organization's policy. Harnu only names a cause it actually saw.
- **Test Harnu mod channel.** In the System Monitor, a session whose Harnu mod is `live`
  has a new button on hover, **Test Harnu mod channel**. It sends that session a quick
  check through the mod and tells you how long the round trip took, and the session shows
  a short `Harnu mod channel check` line in its own terminal. Nothing else in the session
  changes, and Harnu has no abort or compact button: the channel behind this one only
  carries the check for now.

- **One Cleanup screen for worktrees, Docker stacks and Docker housekeeping.** Cleanup is
  now a disk-first map: every worktree is a block sized by what it takes on disk, grouped by
  repository and colored by what Harnu thinks of it - ready to clean (proven merged),
  needs review, or in use. A summary line shows what could be reclaimed, whether autopilot is
  on and when the next cycle runs. **Clean N ready** cleans every proven-ready item behind one
  confirmation that lists each one and says plainly that Docker volumes are kept. Click a
  block for its reason, size and what removing it takes with it, then Remove, Dehydrate or
  Keep; Shift+click, or **Select all in repo**, picks several at once. Cleaning runs in the
  background: the button turns into a progress chip, cleaned blocks fade out and the map
  re-flows, you can keep working (or close and reopen the screen), and a toast reports how
  much was freed - or which items still need review. A Docker card and a ranked "Needs review" list
  sit under the map (showing how much build cache and how many dangling images Docker could
  reclaim right now), and the first autopilot run offers to turn it on. "Ask for an opinion"
  is visible but not available yet. See [Cleanup](docs/user/cleanup.md).
- **Cleanup settings for everything automatic.** Settings -> Cleanup now holds every
  autopilot option: on/off, how often it runs, the grace period, the per-cycle cap, which
  categories it cleans, the build-cache age and a never-clean list, and it says plainly that
  Docker volumes are always kept (a removed volume cannot be restored).

### Changed

- **One footer pill instead of two.** The separate Cleanup and Containers pills in the footer
  are now one recycle pill showing how much can be reclaimed; it reads "Cleaning 3/12" while a
  clean runs and "1 needs review" when an item could not be cleaned. Click it to open Cleanup.
- **The Containers view sends cleaning to Cleanup.** Containers stays the place to inspect and
  start or stop stacks; its clean-up button now opens Cleanup, so there is one place to clean.
  Its settings keep only the stack scan options and the idle clock for stacks that belong to no
  worktree. Containers now opens from the **Inspect stacks** link in the Cleanup screen's Docker
  card.
- **Branches and folders that are not worktrees** (local and remote branches, hidden folders)
  now appear under "Other leftovers" on the Cleanup screen instead of in the old row list.

### Fixed

- **A question no longer stays green because a background agent is running.** When a
  session opened a question or approval dialog while a background agent kept working, the
  agent's own tool calls turned the session back to working, so the row stayed green
  instead of orange "needs you". The agent's activity now never clears a dialog the main
  conversation opened; answering it does. A plain turn that ended while agents still run
  keeps showing as working.

- **Files an agent saves in `.harnu/` are now reachable.** The `.harnu/` folder is
  usually gitignored, so Browse files hid it and a path like
  `.harnu/out/roteiro.md` printed in the transcript never became a link. `.harnu/`
  and everything in it now shows in the file tree, turns up when you search, and
  opens from the transcript. Every other gitignored folder (`node_modules`, build
  output) stays hidden.
- **Ctrl+click opens a path from the transcript**, the same as Option/Alt+click: a
  file opens in the viewer pane and a folder is revealed in Browse files. Holding
  either key underlines the paths under the pointer, in the main terminal and in
  helper-pane terminals. Links to web addresses behave as before. (On a Mac,
  Ctrl+click is the system right-click — keep using Option there.)

## 2026-10-06

### Added

- **Back and forward between sessions.** The mouse's back / forward side buttons, and
  `Alt+←` / `Alt+→` (`⌘[` / `⌘]` on macOS), now walk the sessions you viewed, like a
  browser: Back returns to the session you were just in, Forward undoes it, and opening
  a new session clears the forward history. From Folder View or a takeover (Board, PR
  Stack, Cleanup, …), the first Back returns to the session you left. Closed sessions
  are skipped, and the history is kept in memory only, so it starts empty after a
  restart. `Alt+←` / `Alt+→` no longer reach the terminal (use `Ctrl+←` / `Ctrl+→` to
  jump words there). Verified live on Linux only; macOS and Windows are untested.

## 2026-10-05

### Added

- **Settings → Mods lists the mods your sessions can load and what each one can do.** It is
  read-only: each mod shows neutral "can …" chips (runs processes, reads every prompt,
  decides permissions, …) from a static read of its source, plus its hooks and calls on
  expand, and points at where that mod is switched on or off. It never enables, disables
  or installs anything, and it states what it cannot show (destinations, arguments,
  paths, what a session actually loaded). The Harnu mod is always its first row, and a
  banner tells you when Claude Code has mods turned off here or remotely.
- **Third-party notices ship with the app.** Every build now carries `LICENSE` and a
  generated `THIRD-PARTY-NOTICES.md` with the license text of each bundled package and
  of the terminal font (JetBrains Mono under the SIL Open Font License, plus the Nerd
  Fonts glyph sets).
- **Non-affiliation line on the welcome screen.** The onboarding hero now says that
  Harnu is an independent project, not affiliated with or endorsed by Anthropic.

### Changed

- **Voice uses your OS's own speech by default.** A fresh install now speaks through
  `say` on macOS and `spd-say -w` on Linux, instead of a command most machines do
  not have. Windows has no default yet, so set one in Settings → Voice. A command you
  already saved is kept. The read-aloud skill falls back to the same voices when it
  runs outside Harnu.
- **Notification chime is now generated in the repo.** The sound is rebuilt from two
  sine tones by `scripts/gen-notify-sound.py`, so its origin is on record. It sounds the
  same as before.

## 2026-10-03

### Changed

- **Captions, metadata and the danger red are easier to read on the dark theme.** The
  two dimmest text shades now meet the 4.5:1 contrast bar on the app and card
  backgrounds, so hints, eyebrows and file paths no longer fade into the sidebar. The
  red used for stuck sessions, destructive menu items and removed diff lines is a
  touch lighter and leans rose, so it stands out more and no longer reads as orange.
  Disabled controls stay deliberately dim.
- **Two agent-facing refusal codes were respelled for the rename.** A message to a session Harnu does not own is now refused with `RECIPIENT_NOT_HARNU_SPAWNED` (was `RECIPIENT_NOT_CAPY_SPAWNED`), and arming a guard on such a session with `TARGET_NOT_HARNU_SPAWNED` (was `TARGET_NOT_CAPY_SPAWNED`). They are status codes an agent reads, not saved settings, so there is no alias; the self-awareness doc and the user guide use the new spelling.
- **The final rename sweep.** Remaining internal names, temp-file suffixes, dev scripts and the mission eval harness now say Harnu; the old names are kept only where an existing install needs them (the `capy:` skill prefix, `mcp__capy__` rules, `capy://` addresses, `capy-voice`, the `.capy/` legacy folder, the `capycanvas` file format, and `~/.claude/capy-extensions/`).
- A Scheduler worker's saved system prompt now gets the same `/capy:<skill>` → `/harnu:<skill>` rewrite its prompt already did, so an old worker keeps resolving its bundled skills.
- The review pane's local PR refs are now `refs/harnu/pr/<n>` and the Reaper's archive commits start with `harnu-archive:`; nothing reads the old ones back, so leftovers are harmless.

- **The visible name is now Harnu everywhere.** The window title, settings, dialogs, notifications, generated memory files, the README, the user guide and the design guide all say Harnu instead of Capy. The default theme is labelled "Harnu" (your saved theme choice is unaffected), and `harnu .` opens a folder from the terminal. The logo is unchanged for now.
- **Each project's data folder moves from `.capy/` to `.harnu/`.** Memory, the roadmap board, missions and canvases now live in `.harnu/`. On first launch Harnu copies every known repo's `.capy/` into `.harnu/` automatically (a repo you add later, or one that only shows up under "Active elsewhere", is copied the first time Harnu opens it), and the old `.capy/` folder is kept until you delete it. New canvases are saved as `*.harnucanvas.json`; boards saved under the old name still open.
- **The per-repo data folder is now kept out of git automatically.** The first time Capy writes memory, roadmap cards, missions or canvases in a repo, it adds the folder to that repo's `.git/info/exclude` (shared by every worktree), so it never shows up as untracked and your own `.gitignore` is never touched.
- The in-app docs that tell a session about its environment are renamed to Harnu (`docs/harnu-features.md`, `harnu-orchestrator.md`, `harnu-teacher.md`), and lesson results now report to the session as `[harnu-lesson]` instead of `[capy-lesson]` (the teacher still grades old `[capy-lesson]` results). Your self-awareness on/off choice carries over from the old `capy-features.json` file.
- Bundled skills now live under the `harnu:` prefix — `harnu:mission`, `harnu:status`, `harnu:orchestrate-delivery` and the rest — and their texts speak Harnu and call the `harnu` server's tools. The old `capy:` prefix still works as an alias, so a Scheduler worker whose saved prompt says `/capy:mission` keeps staging and running the skill. The read-aloud skill reads `HARNU_TTS_COMMAND` first and falls back to `CAPY_TTS_COMMAND`.
- The agent control server is now named `harnu`: a session sees its tools as `mcp__harnu__<verb>` (was `mcp__capy__<verb>`), its resources as `harnu://…`, and its setup text speaks as Harnu. "Always allow" choices you already saved under the old `mcp__capy__<verb>` name keep working, so nothing re-prompts, new ones are saved under the new name, and Scheduler workers in read-only mode stay locked down under both names. The `capy://` resource address and the `CAPY_POSIX_SHELL` variable are still understood (`HARNU_POSIX_SHELL` takes precedence), and **Copy config** now registers the server under the `harnu` key.
- **The app is now named Harnu.** The package, installer, desktop entry, window class and
  update source all use the new name, and releases publish to `junielton/harnu`. On first
  launch Harnu copies your settings, folders, scheduler workers, skills and voice data from
  your old Capy data directory automatically, so nothing needs re-entering. Existing Capy
  installs do not update in place: install Harnu by hand, then remove Capy.
- **Hooks, statusline and orchestrator-guard entries from Capy are migrated to Harnu
  automatically.** On launch, Harnu replaces the old Capy observer hooks and statusline in
  `~/.claude/settings.json` with its own (your other hooks and a custom statusline are left
  alone), rewrites the orchestrator guard in any folder that still has an armed session so it
  points at the new data directory. A skill you installed outside the app keeps its old
  Capy stamp until you next re-install or toggle it in Settings → Skills; Harnu recognizes
  that stamp as its own and replaces it then.

### Fixed

- The one-time settings copy from an old Capy install no longer carries the stale `capy.mcp.json` (a dead port and token) into the new data directory, and Harnu now deletes the dead `skills/<hash>/capy/` staging folders that copy brought across.
- Opening a canvas board that still sits in a repo's legacy `.capy/` folder no longer reports "not found" while the first-use copy is still running.

## 2026-10-02

### Added

- **The sidebar always lists the git worktrees of the repos it shows.** That includes
  worktrees created outside Capy with no session yet, and ones whose sessions are all
  old. A `git worktree add` or `git worktree remove` on a repo in your sidebar shows up
  within a couple of seconds, with no Rescan.

### Changed

- **The live green pulse is now drawn without repainting the window every frame**, cutting idle renderer and GPU CPU while a session is working. It looks the same; the halo now grows from a ring that the compositor animates, and non-6px dots (footer, mission steps, containers) keep their size and position.

- **Append-only transcript activity refreshes the fleet model at most every 2 s per
  project.** A session that is busy writing no longer rescans its project several
  times a second; new and removed sessions still show up within about a quarter of
  a second.

- **A session's name now reads the same everywhere** — sidebar, top bar, approval inbox, triage
  queue, jump palette, footer and notifications all use the auto-generated title when a session
  has not been renamed, instead of some of them falling back to the first prompt. The sidebar
  filter finds a session by the name it shows.

### Fixed

- **Lower main-process CPU while sessions and subagents are writing.** Transcript
  headers are now read incrementally and subagent headers are cached, so a busy session
  no longer makes Capy re-read every transcript and subagent file in its folder on each
  new line.

- **New sessions and folders show up on their own.** A `claude` started outside
  Capy, or a new project folder, now appears in the sidebar within about a second
  instead of waiting for an unrelated refresh, and Rescan does a single scan instead
  of two. A new session that has not been fully picked up yet no longer briefly
  disappears from the sidebar when something unrelated refreshes it.
- **Busy sessions cost less CPU.** Session updates no longer replay whole
  transcripts to the window (one measured pair carried 27 MB): the first update
  after launch reads at most the last 256 KB of a transcript, and rapid updates to
  one session are batched. A `claude -p` probe can no longer leak an update into
  the sidebar.

- **Renaming a session more than once now updates its sidebar name** — before, the sidebar kept
  showing the session's first name while the top bar showed the new one.

## 2026-10-01

### Added

- **Option+click a pull request link to see it on the PR Stack.** Turn on
  "Open PR links in the PR Stack" in Settings → PR Stack, then Option+click a link
  to an open pull request of the session's repo in the transcript: the PR Stack
  canvas opens, pans to that card and rings it for a moment. Links to other repos,
  merged or closed PRs, or any click while `gh` is unavailable open in your browser
  as before, and a plain click always does.
- **Filter the PR Stack canvas.** A search bar now floats next to the refresh and zoom controls.
  Type GitHub-style qualifiers — `review:approved ci:passing`, `-is:draft`, `author:alice`,
  `label:bug`, `chain:#412` — or just words from a title or branch, and the canvas shows only what
  matches. Four menus (Author, Review, Checks, Labels) do the same with checkboxes and live counts,
  and the two always agree: checking a box writes the token, deleting the token unchecks the box.
  Press `/` to jump to the field, `Esc` to leave it and `Esc` again to clear.
- **Dim or Hide.** Non-matching PRs fade out by default (**Dim**), so you keep the whole picture.
  **Hide** removes them and re-arranges what is left; where a match's ancestors were hidden, a dashed
  "N hidden · #a #b" pill keeps its path to the base, and clicking it shows that stack in context.
  Your own card positions are ignored while Hide is on and come back when you turn it off.
- **The header counts are filters.** Click `ready to merge`, `with unresolved threads` or `needs
retarget` to apply it as a filter; click it again to clear. A count of zero is plain text.

### Changed

- **Capy's delivery skills speak the pill's language.** The bundled `status`, `mission`,
  `orchestrate-delivery`, `delivery-verifier` and `delivery-watchdog` skills now report a mission
  exactly as the topbar does — "Step 4 of 5 · 2 verified" — instead of counting proven steps on
  their own, and the status card prints each of its lines once. Orchestrators declare the whole
  plan when they create the mission (one step per pull request), turn sign-offs like "the
  designer approves the section" into checks on the step instead of extra steps, stop asking you
  to approve a mission, and stop their loop as soon as you end one. A verifier that needs a person
  to confirm something adds it as a check you can tick, and the watchdog no longer skips old
  draft missions. The `mission` skill no longer keeps a copy of each mission in an old-style notes
  file under `.capy/goals/` — the mission is the only record.
- **The mission pill says where the work is: "Step 8 of 9".** The topbar pill, the progress
  popover and the sidebar chip now show the step the work is on — "Steps 4–7 of 9" when several
  run at once, and "Step 9 of 9 ✓" only when every step is done — using the numbers Capy computes
  once for every surface, so they can never disagree. An older mission's "Scope confirmed" step is
  no longer counted; its documents show as scope links in the popover header. The sidebar chip
  wears the same color as the pill (it no longer turns amber on its own) and stays visible while
  the mission needs you.
- **The progress popover answers done, running, waiting, left behind and blocked at a glance.**
  Each step shows one of seven marks — verified, done but not verified, running, waiting,
  blocked, still to do, and left behind — and the header reads "6 done · 6 verified · 1 left
  behind". A helper session appears once, on the step it's working on, with "+1 session" on the
  other steps it touches; its new go-to button opens it inside Capy, and tells you when the
  session isn't loaded yet instead of doing nothing.
- **Tick, add and delete checks right on the step.** Checks waiting for your sign-off show on the
  step that produced the work, marked "due" once that step is reached. Tick or untick them, add
  one with "+ check", or delete one — a label the step already has isn't added twice.
- **End a mission from one dialog, and it leaves at once.** "End mission…" is always in the
  popover: choose **Close as delivered** or **Discard**, add an optional reason, and see what's
  still open listed as warnings that never block you. The mission disappears from the topbar and
  the sidebar the moment Capy confirms — no more waiting for the dialog to close — and if
  something goes wrong you get a message instead of a stuck dialog. The warnings name steps by
  their titles and count properly ("2 steps left behind"), not by internal ids. There is no
  "Approve mission" anywhere any more.
- **A mission reminds you only when it starts needing more from you.** The chime now follows the
  full list of what a mission needs from you: it rings when something new appears or a count
  grows (one due check becoming two), never when you tick something off. A dead old draft never
  rings.
- **Missions start active; the end you agree in chat is the agreement.** There is no draft and
  no "Approve mission" step any more: a session creates a mission already active, declares its
  plan (one step per deliverable) in the same call, and records the finish line it agreed with you
  in chat. Old missions still saved as drafts now read as active — a dead one shows up as stale
  instead of waiting forever for an approval. Planning steps need no reason; once work has
  started, every new step still needs one.
- **Scope is an attachment, not a step.** The spec, PRD and ADR a session names are attached to
  the mission instead of becoming a "Scope confirmed" first step that almost never got proven.
  Missions created before this keep their old first step on disk, and nothing counts it any more.
- **Mission progress is worked out once, by position.** Capy now computes where a mission stands
  — which step it's on, what's done, what's verified, what was left behind — in one place, and
  every session reads those same numbers instead of counting on its own. What a
  mission needs from you is now a full list on Capy's side (approvals, a close, your blockers,
  checks to tick, steps to confirm, an imported finish line to review), not just the first thing.
- **End any mission yourself: close it as delivered, or discard it.** One operator door now
  ends any mission that isn't closed — with an optional reason — whether or not a session asked.
  Unverified work, steps left behind, unticked checks, blockers and a pending new finish line are
  shown as warnings, never as a reason you can't. The choice and the reason are written to the
  mission's log, and the session that owned it can no longer change it.
- **Human checks on mission steps.** A sign-off that belongs to a piece of work — a design check,
  "validated visually", a designer's approval — is now a check on that step instead of a step of
  its own. Sessions add them, and a verifier that finds everything met except the part only a
  person can judge marks the step done and leaves you a check. Only you can tick or delete a
  check.
- **Mission files keep fields a newer Capy writes.** An older Capy reading a mission file no
  longer strips fields it doesn't know about when it saves it back.

### Fixed

- **The pasted-images gallery and screenshot attach work again with newer Claude Code.**
  Newer Claude Code versions save pasted screenshots under the system temp folder
  (`<tmp>/claude-<uid>/…/<session>/images/`) instead of `~/.claude/image-cache/`, so the footer
  `🖼 N` pill vanished and sessions couldn't attach new screenshots to cards or boards. Capy now
  reads both locations, merged per session, and only ever accepts the exact pasted-image files
  there — never the rest of that temp folder.
- **A slow GitHub no longer empties the PR Stack canvas.** A timed-out or failed `gh` call used
  to replace a populated canvas with an empty one that claimed "GitHub CLI is unavailable". Now
  the last good picture stays, the age beside **Refresh** turns amber with a hover explanation
  (timed out, couldn't reach GitHub, answer too large) and a click retries. If the very first
  read fails, the canvas says the refresh failed and offers **Retry** instead. "GitHub CLI is
  unavailable" is now reserved for a missing, signed-out or non-GitHub `gh`. The PR list also
  gets a two-minute budget (the same one the Cleanup scan uses) instead of 15 seconds, so large
  repos stop timing out in the first place.
- **Option+click in a session no longer reaches Claude Code.** When Claude Code
  was tracking the mouse, an Option+click on a link was also passed to it, so it
  opened the link in your browser a second time. Option+click now stays in Capy.
- **A GitHub hiccup no longer un-proves a mission step.** Once a linked pull request has been seen
  open or merged, a read that can't reach GitHub — or no longer finds that pull request among the
  recent ones — keeps the last known state instead of flipping the step back to waiting. A worktree
  cleaned up after its pull request merged still counts as proof. Only a real change, like a pull
  request closed without merging, takes the proof away. Reading a mission never rewrites its file.
- **The mission popover and Close respond quickly.** Open missions are now worked out several at a
  time, and their GitHub lookups are shared — one per repo per minute instead of one per mission —
  so a refresh that took tens of seconds now takes a few.

## 2026-09-29

### Added

- **"Scope confirmed" can prove itself.** A session that starts a mission can now name the
  documents that fix its scope — the spec, the PRD, the ADR — and Capy links them to the first
  step, "Scope confirmed", and marks it proven as soon as they exist in the repo. Paths that would
  prove it without saying anything about the scope are refused, and re-checked every time the
  mission is read: anything outside the repo (symlinks included), the repo root itself, Git's and
  Capy's own folders (`.git`, `.capy`), and worktree checkouts (a linked worktree, a nested clone,
  or anything under `.claude/worktrees`).
- **Know ahead of time whether a mission can close.** Reading a mission now says whether a close
  request would be accepted right now, and if not, why — so a session no longer has to ask and be
  turned down to find out.
- **When a mission is waiting on you — a merge, a key, a decision, an approval of its end or its
  close — Capy plays the confirm chime, asks for your attention and reminds you every 30 minutes
  until it is handled.** Each new wait also leaves one entry in the Activity bell. Opening Capy with
  several missions already waiting gives one combined reminder, not one per mission. Pending
  approvals and a session waiting on your answer are not repeated here — they already ring.

### Changed

- **The bundled delivery skills now agree the finish line with you before any work goes out, and
  tell you when they're waiting on you.** An orchestrating session creates its mission before the
  first dispatch, proposes the end and asks you to confirm it in one question, and links the spec
  it works from. Whenever its turn ends waiting on you — a merge, a key, a decision — it raises a
  blocker in your name, which is what makes Capy chime and re-nudge. When you change how the
  delivery ends (say, stacked PRs you merge yourself), it proposes the new end on the spot.
  Stacked PRs are retargeted to the default branch before you're asked to merge them, and once
  every unit is verified the session verifies the end itself and asks you to close.
- **The mission pill counts finished steps ("3 of 10 done") and keeps counting while the mission
  awaits approval; the approval callout shows the end you are agreeing to.** Before, the pill
  showed the first unfinished step, so one early step left open — often "Scope confirmed" — kept
  it at "Step 1" through a whole delivery, and a draft always read zero. The popover header and the
  sidebar chip use the same count. The draft copy no longer claims that nothing runs before you
  approve: sessions may already be working, and approving agrees the finish line.
- **Missions can now be closed after a normal orchestration.** The coordinating session's
  verification of the final step now counts when it built none of the steps itself — the sessions
  that did the work are linked to their steps, so Capy can tell them apart. Before, the final step
  always came out "self-verified" and the mission could never be closed. A mission whose steps have
  no linked sessions at all still can't be closed this way.
- **A close request is refused while a new finish line is waiting for your approval**, the same
  way your Close button already was — the request and the button now always agree.
- **Pull requests on a mission show the branch they merge into**, so a stacked PR that still
  targets a stack branch instead of the default branch is visible to the coordinating session.

### Fixed

- **The mission progress popover no longer shows a bright native scrollbar.** When a mission had
  enough steps to scroll, the popover drew the browser's wide white scrollbar; it now uses the same
  thin, hover-revealed scrollbar as the rest of the app.

## 2026-09-28

### Added

- **See a mission's progress in the app, and approve or close it yourself.** When the selected
  session owns a Mission, the topbar shows a **Step N of M** pill next to its title. Its color says
  whether it's worth a glance — gray while it's still a draft, blue while it's moving, amber when
  something is blocked, stalled, waiting on you or proposing a new finish line, green once it's
  delivered. Click it for the full progress: every step with how it's proven, what's blocking it,
  the sessions working on it, the finish line, and a "You" line saying what the mission needs from
  you. That's also where your decisions live: **Approve mission** starts a draft, **Approve
  re-scope** accepts a new finish line, **Mark verified** confirms a step that's yours to confirm,
  and **Close mission** closes a delivered one. The sidebar shows the same **N/M** on the session's
  row — amber and always visible when you need to act. A step a session verified on its own work
  never shows as proven.

- **Closing a mission asks first.** Closing is the one mission decision you can't undo, so **Close
  mission** now opens a short confirmation — with a sound and a taskbar/dock nudge, like every other
  confirmation in Capy — and the mission only closes when you confirm there. Cancel, Esc or a click
  outside leaves it open. Approving a mission, a re-scope or a step stays one click.

- **Two more bundled skills: `report-back` and `draft-to-prompt`.** `report-back` is the
  final-report format every multi-step run ends with — one line per step with its real outcome,
  what you owe (always printed, even when it's nothing), the links worth opening, and at most three
  lines of summary. `draft-to-prompt` turns a rough idea into a finished prompt for a Claude model,
  including a boot prompt for a new session, with the model and any long-running setup spelled out.
  Both are off until you switch them on in **Settings → Skills**.

- **Capy's delivery skills now run on Missions.** The bundled `mission`, `status`,
  `orchestrate-delivery`, `delivery-watchdog` and `delivery-verifier` skills read and record a
  coordinated delivery through the mission actions instead of hand-parsing a notes file: a tick is
  one read, the stall flag and what you owe come straight from the mission, and a step is only
  proven when a session other than its author verified it. `delivery-verifier` now grades code, UI,
  research and decision work each against its own rubric — and when a session has no browser tools
  it hands visual checks to you instead of passing them. For one release the `mission` skill still
  also writes the old goal file alongside the mission, and a checker confirms the two agree before
  the old format is retired.

- **A scheduled read-only watchdog can now read missions.** An `observe` Scheduler worker may read
  a mission's progress (never change it), so `delivery-watchdog` can notice a stalled delivery on
  its own. Turn on "carry last result" for that worker and it will not repeat a finding it already
  told you about.

- **Old goal files can become Missions without losing a byte.** A session can now import one of
  the free-form `.capy/goals/*.md` notes files coordinating sessions used to keep, as a new draft
  mission: the goal, what "done" looks like, the listed helpers or units, pending gates, open
  questions and the log are picked out where Capy recognizes them, and the whole original file is
  kept inside the mission byte for byte — even when it uses headings Capy doesn't know. The old
  file is only read, never changed or deleted. When it never said what "done" means, the mission's
  finish line is marked as needing review so the session proposes a real one for you to approve.

- **Missions now show how their linked work is actually doing, and flag when it stalls.** Reading a
  mission works out, fresh each time, the live state of every session, worktree, card and pull
  request linked to its steps — whether each helper session is working, idle or parked, whether it
  is waiting on an approval from you, what's committed and which pull requests are open — and
  checks automatically whether the steps Capy proves on its own really are proven. A running
  mission with no new activity for over an hour and no linked session working is flagged
  **stalled**, by a fixed rule rather than a model's guess; the flag is worked out on every read
  and clears as soon as anything moves. Pull-request details need the GitHub CLI; without it they are simply left out.

- **Sessions can track a larger piece of work as a Mission.** A session coordinating
  work that spans several sessions can now keep one structured record of it — what
  "done" means (declared up front, or the mission is refused), the steps in between,
  what each step is linked to, and a running log — instead of a loose notes file. Seven
  new agent actions cover creating, reading, listing and updating missions; approving
  a draft and closing a finished mission stay yours. Missions live in your repo's
  `.capy/missions/`, shared by every worktree, and never leave your machine. Not to be
  confused with a mission grant, the batch approval — they only share a word.
- **Missions can now be blocked, re-scoped, verified and handed back to you to close.**
  A session can flag what a mission (or one of its steps) is stuck on and whose move it
  is, propose a new finish line that only takes effect once you approve it (and that
  resets the final step's proof, since it was about the old goal), record a step's
  verification — labelled "self-verified", never proven, when the session checked its
  own work — and ask you to close a mission once its final step is independently
  verified and nothing is blocked. Closing stays yours.

### Changed

- **An orchestrator waiting on its dispatched work is no longer parked.** Automatic
  hibernation now skips any session that owns an active mission while at least one
  session linked to that mission is still running, however long the owner itself has
  been idle — so a child's report no longer lands on a parked process. The exemption
  lifts on its own once every linked session has finished or been parked, so a
  forgotten mission can't pin its owner's memory forever.

### Fixed

- **A mission can no longer be closed on stale proof.** Closing re-checks the mission at that
  moment: if its finish line was found unmet after the close was requested, a blocker was raised,
  or a new finish line is waiting for your approval, the close is refused and the progress popover
  says why instead of offering the button.

## 2026-09-23

### Added

- **Jump to a repo's pull requests on GitHub from the Topbar.** When the selected
  folder's `origin` is on github.com, a new pull-request button in the Topbar's right
  cluster opens that repo's Pull requests page in your browser. HTTPS and SSH remotes
  both work. The button stays hidden for folders with no `origin` or one hosted
  somewhere else.

## 2026-09-22

### Added

- **Make a folder default every new session to Orchestrator.** The folder
  context menu has a new toggle, "New sessions start as Orchestrator" (off by
  default): turn it on and every plain session you start there — "+ New
  session", the New session dialog, the keyboard shortcut — boots already
  promoted, with the coordinator contract in its preamble and the structural
  guard armed from its very first turn, no "Promote to orchestrator" click
  needed. The folder row picks up a small crown to show the default is on. The
  toggle is per exact folder — turning it on for a repo never turns it on for
  its worktrees, so an orchestrator can still dispatch executors into its own
  worktrees without them being blocked from editing code. A session the
  default armed keeps its role through a park (hibernate) and resume; an
  explicit demote still always wins. Sessions an agent starts (MCP, a
  board/manifest dispatch, a Scheduler tick, a read-only review companion) are
  never armed by this default.

### Fixed

- **The selected session row keeps one clean highlight behind its chips.** The
  fade behind the right-side chips (count, crown) used the plain sidebar color,
  so on a selected or hovered row it cut a dark block into the highlight. It now
  matches the row's own background.

### Changed

- **Toolbar buttons finally look like one system.** Containers, Cleanup, Usage
  Dashboard, PR Stack, Roadmap, Review, Scheduler and System Monitor each grew
  their own "Scan now"/"Sweep"/"New card" button by hand over time, and it
  showed: four-plus different paddings, radii and font sizes answering to the
  same design. They now all render through one shared `Button` component
  (`components/ui/Button.vue`), so every header and toolbar action across the
  app shares the same height, radius, icon size, gap and 5-variant color
  system (Primary/Soft/Ghost/Danger, plus a new Success tone for reclaim-type
  actions like "Stop running" and "Sweep"). Per-row inline actions inside dense
  lists (a Roadmap card's own pills, a Cleanup row's action cluster) keep their
  smaller, established look — this pass covers header/toolbar-level buttons
  only.

## 2026-09-20

### Added

- **You choose which stacks a clean-up takes.** Every row under "Needs you" now
  has a checkbox, and they all start ticked — so **Clean up N stacks** is still
  one click over everything, and unticking a row is how you leave a stack out.
  The button counts what you ticked and greys out at zero (it stays where you
  left it rather than vanishing), and the dialog lists only the stacks it is
  about to take, with their containers, their total, and their volumes. Leaving a
  stack out protects its data too: a volume it still uses is kept and named
  before you confirm, exactly like one an in-use stack holds. "Needs you" also
  has a select-all / none control that shows a mixed state while you are picking.
  The selection follows the stacks themselves, so a background scan never moves
  it; a stack that appears after you have unticked something arrives **unticked**,
  so nothing is ever removed on the strength of a box you never saw. Capy still
  decides what a clean-up is _allowed_ to touch — your picks can only ever take a
  stack out of one, never add one Capy refuses.
- **Clearing out every dead container is one action now.** Containers gained a
  **sweep**: it stops and then removes every stack under "Needs you" — every
  zombie and every orphan, running or already exited — in one go, instead of one
  Remove dialog per stack. Capy picks what a sweep touches; a stack a session is
  working in, one from a repo's main checkout, one that is not a zombie yet, and
  one Capy cannot attribute to a folder are never swept. A running stack is
  stopped first and only then removed, so Capy still never forces a removal, and
  a stack that fails to stop is reported and left alone. Removing volumes stays
  opt-in and happens only after every container is gone, so a volume two swept
  stacks shared is reclaimed once both are, while one anything else still uses is
  kept. The whole sweep is one entry in Recent. Sweeping is yours alone: agents
  still stop and remove stacks one at a time.
- **"Clean up N stacks"** sits next to "Stop N running" at the top of Containers
  and is how you run that sweep. It appears whenever at least one stack is a
  zombie or an orphan, and unlike the stop button it never acts on the click: it
  opens one dialog that names every stack it would take, its containers, and the
  total — "Clean up 12 stacks? 47 containers will be removed." Volumes stay
  opt-in behind a box that always opens unchecked, now totalled across the whole
  sweep in one line, with any volume that survives it named underneath. While the
  sweep runs the button counts the stacks it has cleared, and a sweep that did
  not finish keeps the dialog open, says how many stacks it did clean, and names
  each one it could not with docker's own reason.

### Fixed

- **The clean-up dialog is binding: what it lists is what gets removed.** Capy
  re-checks the machine the moment you confirm, so a stack that crossed its
  zombie threshold — or lost its worktree — while the dialog sat open used to be
  swept along with the rest, volumes included, without ever having appeared in
  the list you read. The confirm now carries the list it showed you, and if the
  machine moved in between the whole clean-up is refused: **nothing is deleted**.
  The dialog stays open, says so, refreshes to the current list, and waits for
  you to confirm again.
- **The clean-up list no longer moves while you are reading it.** The dialog used
  to be a live view of the latest background scan, so a scan landing while it sat
  open rewrote both the list on screen and the list your confirm would carry —
  together, and without a word. Capy had nothing to refuse, because the two still
  agreed; you simply confirmed a list you had not read. The dialog now reads the
  clean-up once, when it opens, and a scan that changes what it would take
  refreshes it **and tells you**, re-ticking the volume box off, so the next
  confirm is one you made on the list in front of you. While a clean-up is
  actually running the list holds still: stacks leaving the scan then are the
  clean-up working, not the machine moving.
- **The clean-up now runs.** Every confirm failed outright — "The action didn't
  run — the request failed", with _An object could not be cloned_ underneath —
  and nothing was ever removed. The dialog was handing its volume list to Capy
  exactly as the screen held it, and that internal form cannot cross between
  Capy's windowed and background halves, so the request died on the way out
  instead of reaching the part that does the work. Every container action now
  leaves the screen as plain data.

## 2026-09-18

### Removed

- **The experimental "Host agent teams in Capy" toggle is gone.** It let a
  session's context menu relaunch that session as a team lead hosting its
  agent-teams teammates as native Capy panes, by impersonating iTerm2's `it2`
  CLI. Teammates still run exactly as before through Claude Code's own tmux
  backend, and still group under their lead in the sidebar — only the
  experimental native-pane hosting path is removed.
- **The footer's "N waiting on you" teammates indicator is gone**, along with
  the agent-team board observer that fed it (the disk watcher over
  `~/.claude/teams` + `~/.claude/tasks`, and the `TaskCreated`/`TaskCompleted`/
  `TeammateIdle` observer hooks). The sidebar's Team board view this fed was
  already removed in an earlier release, leaving the footer pill as its last
  consumer. The sidebar's teammate grouping (nesting a team's members under
  their lead session) is unaffected — it reads transcript metadata, not this
  observer.

## 2026-09-11

### Added

- **Agents can stop, start and remove your Docker containers.** Three new verbs,
  `stop_containers`, `start_containers` and `remove_containers`, run the same
  Stop, Start and Remove as the Containers view, with the same safety rules.
  Stopping and starting run without asking because both can be undone. Stopping a
  stack a session is working in, or one from a repo's main checkout, needs an
  explicit force, and a forced stop always asks you first. Removing always asks,
  whatever your settings, handles one stack at a time, and deletes volumes only
  when asked, after the containers, never one another stack shares. Containers
  Capy can't tie to one of your folders, and containers in a folder you blocked,
  are never touched. Every action shows up in the Containers history marked as an
  agent's. Read-only Scheduler workers can't use these verbs.

- **Agents can list your Docker containers.** A new `list_containers` verb gives
  a session the same facts as the Containers view: every compose project or
  standalone container, the folder it belongs to, Capy's verdict on it (zombie,
  orphan, active, protected, pending or unknown), the memory, ports and volumes it
  holds, and the recent stop/start/remove history with who did each one. A
  session can ask about one repo and its worktrees, or everything. Paths are
  shortened like every other fleet read, containers in a folder you blocked are
  listed but marked off-limits, and a missing or stopped Docker is reported as
  such, never as an empty list. Read-only Scheduler workers may use it, so a
  worker can watch for zombie containers.

### Fixed

- **A restore command no longer leaks a folder path with a quote in its name.**
  When a container's folder name held a single quote, the "how to recreate it"
  hint in an agent's container history showed the full path instead of the
  folder's short name.
- **Containers: find the docker stacks your worktrees left running, and clean
  them up.** A new **Containers** view (open it from the footer pill, which
  counts the stacks that need you) lists every docker stack on the machine and
  traces each one back to the worktree it came from. Stacks nobody has used for
  two days are **zombies**, stacks whose worktree was deleted are **orphans**,
  and everything else — a stack a session is working in, your main checkout's
  stack, one Capy can't place — is listed under **Leave alone**. The top of the
  view says how much RAM and how many ports stopping the zombies would free.
  **Stop N running** stops every running zombie and orphan in one click;
  **Remove…** only works on a stopped stack and always asks first, keeping its
  volume unless you tick it. Every action lands in **Recent** with the command
  that undoes it.
- **Containers settings, and a heads-up when a stack turns zombie.** A new
  **Settings → Containers** tab lets you turn the background scan off, choose
  how often it runs (every 30 minutes up to once a day), and decide how many
  days unused make a stack a zombie — the rows re-sort as soon as you change
  it. With **Notify me about new zombies** on (the default), the first time a
  stack becomes a zombie Capy adds one entry to the Activity bell, and clicking
  it opens Containers. Each stack is announced once, even across restarts.

### Fixed

- **Containers: a stack Capy restarted, then someone stopped outside Capy, no
  longer misreads as "stopped by Capy".** The master list only reads a stack's
  own most recent action now, instead of matching any past stop in its history.

## 2026-09-10

### Added

- **PR Stack — the card now says when a human asked for changes.** A PR whose
  review verdict is _changes requested_ used to render the same neutral grey
  `review` chip as a PR nobody had opened, which are the two most different
  states a PR can be in. It now gets its own red chip, ranked below `conflicts`
  and `retarget` and above `approved`.
- **PR Stack — drafts are marked on the card.** A `draft` badge sits on the
  identity row beside the PR number, so it stays visible when you zoom out past
  70% and the chip row is gone. GitHub already told us; the card just never drew
  it.
- **PR Stack — the card now says who a review is waiting on.** A PR with a
  pending reviewer request shows a grey `waiting @dberri` chip beside `review`
  (`+2` when more are pending, teams included), and the expanded card lists all
  of them. A PR with no reviewer pending — nobody asked yet, or a reviewer who
  already left comments without a verdict — keeps the lone `review` chip, so
  _no one pending_ and _asked, no answer_ — which call for different next steps —
  no longer look identical. The chip only appears while there is no verdict:
  once a PR is approved or has changes requested, a leftover request is noise.
- **PR Stack — every card says how big the PR is.** A grey `+412 −38 · 9 files`
  chip closes the card's chip row, so a 12-line fix no longer looks exactly like
  a 900-line refactor when you are choosing what to review next. Thousands are
  shortened (`1.2k`, always rounded down) and the expanded card lists the exact
  numbers. It is deliberately grey rather than GitHub's green and red — size is
  not a verdict — and a PR whose size GitHub did not report shows no chip at
  all, never `+0 −0`.
- **PR Stack — a card shows when auto-merge is armed.** A PR that GitHub will
  merge by itself once its checks and reviews clear used to look exactly like
  one waiting on you. It now carries a small timer icon beside its age,
  still visible when you zoom out, and its drawer names the merge method and who
  armed it — for example `squash, armed by @you`.
- **PR Stack — unresolved review threads on the card.** An amber `3 unresolved`
  chip now sits next to the status chip, because a PR can read _approved_ and
  still carry open threads. It counts only threads on code that still exists;
  threads on rewritten code are listed separately as _outdated_ in the card's
  drawer. The header gains a `N with unresolved threads` count. If GitHub could
  not be asked, the card shows nothing rather than a false `0`. This costs one
  extra GitHub API call per refresh (one rate-limit point for the whole repo),
  run alongside the existing one so refreshing is no slower.
- **PR Stack — GitHub labels on the card, if you want them.** Turn on **Settings
  → PR Stack → Show labels on cards** and each card shows up to two of its PR's
  labels, with a `+N` count when there are more; expand the card to see them
  all. It is off by default, because labels only help in a repo that uses them
  sparingly and would bury the chips that matter in one that labels everything.
  Labels are drawn in the same neutral grey as other informational chips, never
  in GitHub's label colours, and they drop off when you zoom out past 70%.
- **PR Stack — a `blocked` chip when a branch rule refuses the merge.** When
  GitHub reports a PR as blocked by branch protection even though nobody asked
  for changes — an approved PR that still lacks a required check, say — the
  status chip now reads `blocked` instead of `approved`. It stays out of the way
  where something else already explains the block: a draft keeps its `draft`
  badge, a PR still waiting on a required review keeps `review`, and a PR whose
  checks are still running keeps its usual chip instead of flashing `blocked` on
  every CI run — the `running` chip already says what it is waiting on. The expanded
  card also gains a `merge` row that names the block, and that says so when a
  check that is not required is failing.
- **Dehydrate: reclaim a worktree's dependency space without touching its
  work.** On one real repo, `vendor/` and `node_modules/` were 93% of the disk
  its worktrees used — and almost none of it was reachable, because every other
  Cleanup action needs a merged, clean worktree. Dehydrate removes a worktree's
  installed dependencies and keeps everything else: the checkout, the branch,
  every uncommitted edit and untracked file. It works on **blocked** rows and on
  detached-HEAD worktrees too. A folder is removed only if the repo's
  `WORKTREE.md` lists it as ephemeral (by default `node_modules`, `vendor`,
  `.venv`, `venv`), git ignores it, git tracks no file inside it, and no session
  is running in the worktree — a project that commits `vendor/` keeps it, and
  the confirm dialog says why. Folders are deleted outright, not trashed
  (trashing would free nothing), and the dialog says that too. **Rehydrate**
  re-runs the manifest's `setup`; if the install rewrites a tracked file such as
  a lockfile, the row names it. A worktree whose manifest has no `setup` can
  still be dehydrated, but Cleanup tells you before and after that it cannot
  bring the folders back. Each repo group offers **Dehydrate N idle** for
  worktrees untouched for a week or more.
- **`ephemeral:` in `WORKTREE.md`** lists the directories Cleanup may dehydrate.
  Build outputs (`dist`, `target`, `.next`, …) are deliberately not in the
  default — `setup` installs, it does not build — so a project opts them in.

### Fixed

- **Spoken notifications no longer read branch slugs and session ids letter by
  letter.** A card worktree's directory name (`card-BUG-117-kokoro-synthesis-…`)
  used to be read aloud dash by dash, and a session with no summary yet had its
  raw UUID spelled out one character at a time. Both `{folder}` and `{session}`
  are now normalized into speakable words before the spoken phrase is built: a
  slug becomes plain words, a path is trimmed to its last segment, and a bare
  UUID, `synthetic-<uuid>` id, or git SHA is dropped entirely rather than
  spoken — the sentence degrades gracefully to the parts that still make sense.
  The toast/OS notification text is unchanged; only what gets spoken changed.
- **PR Stack — "not behind" and "never checked" no longer look the same.** The
  `N behind` chip was counted by the local git checkout only, so a PR whose
  branch had never been fetched on this machine showed no chip at all — exactly
  like a PR that was up to date. The chip now also listens to GitHub, which
  knows whether a PR is behind without anything being fetched: such a PR shows a
  plain `behind` chip, and `5 behind` when the branch is also local. The
  expanded card always has a `vs base` row, which now says one of
  `5 behind its base`, `behind its base, per GitHub`, `up to date locally` or
  `could not measure locally`. The local count is kept, not replaced: GitHub only reports
  "behind" on branches whose rules require them to be up to date, which a PR
  stacked on another PR never has. The count is also taken against the branch
  the PR really merges into: a PR into `develop` or a `release/*` branch used to
  be counted against the default branch, so it could read up to date while far
  behind its real base.
- **Cleanup now recognizes squash merges.** `git merge-base --is-ancestor`, the
  only git-side "is this branch in main?" check Cleanup had, is false by
  construction on a repo that squash-merges: on one real repo it was true for 2
  of 141 branches. That left the GitHub CLI as the sole compensation, so an
  absent, unauthenticated, rate-limited or non-GitHub `gh` left Cleanup with no
  containment evidence at all and every merged worktree stuck at **insufficient
  signal**. Cleanup now also compares a branch's net diff against the default
  branch by patch id, which recognizes the squash commit that collapsed it — 19
  branches on that same repo. The probe is read-only (it writes no git objects,
  so an hourly background scan never mutates a repo), only positive evidence
  counts (no match is never read as "not merged"), and an empty diff is never
  mistaken for containment. A branch it cannot prove now says **containment not
  proven** instead of leaving the row blank.
- **Sweeping a squash-merged branch no longer fails at the delete step.** A
  squash-merged branch is exactly the case `git branch -d` refuses as "not fully
  merged", and which merge signals may force past that refusal is now derived
  from the signal list itself rather than restated in the sweep — the mismatch
  that broke this once before cannot silently recur.
- **A PR found through a shared upstream no longer merges the wrong branch.**
  Branch off an already-pushed branch and never re-push, and two local branches
  track one upstream. Cleanup can now follow that upstream to find a PR, but only
  credits it to a branch whose tip is actually the PR's head, or whose content is
  provably in the default branch — otherwise the sibling would inherit a merge
  verdict while carrying commits nobody has merged. That guard covers the
  closed-PR path as well as the merged one: a branch that was never pushed has no
  remote head to have been _deleted_, so "the remote went away after the PR
  closed" is not evidence of a cleanup for the sibling of a shared upstream.
- **The worktree status probe no longer drops an untracked file that follows an
  unstaged rename.** An unstaged rename (the new path staged with intent-to-add,
  its old path not yet staged) was read from only one of the two status columns,
  so its leftover source path could be misread as its own record and swallow the
  file after it. Cleanup's sweep confirm dialog could therefore list fewer
  untracked files than the worktree actually held.
- **A shared-upstream PR no longer shows as this branch's own on the Cleanup
  timeline.** The guard above kept such a PR out of the verdict, but the row's
  timeline still read it bare: the sibling of a merged branch showed "PR #59",
  Review, CI and Merged as solid green checkpoints, telling you a PR merged that
  has nothing to do with the branch. Those checkpoints now render hollow, the
  PR step reads **PR · upstream**, and hovering any of them says the fact comes
  from a shared upstream, not the branch's own PR. The **In main** step no longer
  turns red "not merged" on the strength of that PR either — it reads
  **containment not proven**, exactly as it would with no PR at all. Nothing
  about which rows are safe to sweep changes, and a PR found by the branch's own
  name looks exactly as before.

### Changed

- **Cleanup rows say why they are blocked.** The padlock that hid a row's
  blockers in a tooltip is gone; a reason line under the verdict now reads
  "uncommitted changes" (plus "+1 more" when there are others), and an
  insufficient-signal row names what went unanswered instead of staying blank.
  Every row button now has a proper accessible name.
- **Every folder row shows its size**, not just harvestable ones, measured with
  a cache and a larger time budget so a cold scan no longer blanks the figure.
- **PR Stack — `ready to merge` no longer counts PRs with auto-merge armed.**
  The number in the canvas header is a to-do count, and a PR that merges itself
  is not something you have to do. So for the same set of PRs it can now read
  lower than before — `0 ready to merge` while a card still says **merge next**
  means that PR is armed and will land on its own.
- A branch whose PR was closed without merging now reads **abandoned — PR closed
  unmerged** on its blocker chip, which describes the branch rather than sounding
  like Cleanup is withholding permission.

- **Cleanup stopped reading a truncated PR list as "there never was a PR".**
  Cleanup asked GitHub for the 100 most recent pull requests and treated
  anything missing from that answer as proof no PR ever existed — so on a repo
  with 169 PRs, a worktree whose PR merged long ago showed every PR checkpoint
  as "not applicable" and never became harvestable. On one real repo the window
  covered 11 of 143 local branches. Cleanup now asks for the full list, and when
  the list still comes back capped it says so instead of guessing: branches it
  has no answer for read **unknown**, with "PR list was capped" as the reason,
  and Cleanup looks each one up individually — a few per scan, remembering both
  the PRs it finds and the branches that genuinely have none, so the same
  fruitless lookups are not repeated on every background scan.
- **Cleanup no longer treats an untracked file as uncommitted work.** A merged
  worktree whose tracked files were pristine still rendered `blocked` with
  "uncommitted changes" — and could not be swept — because a single untracked
  file (a stray note, a build artifact git was never asked to track) made
  `git status --porcelain` non-empty. Only tracked modifications turn the
  **Local clean** checkpoint red now. Untracked paths are still reported: the
  checkpoint's tooltip counts them, and the sweep confirm names every one of
  them, grouped by worktree and never truncated, before anything is deleted.
  They are preserved to the sweep's `wip` archive ref along with the branch tip,
  so nothing that lived in no commit is lost — except paths matched by
  `.gitignore`, which are deliberately never archived.
- **Removing a worktree by hand is unchanged.** The **Remove worktree** dialog
  still refuses on any uncommitted change, untracked files included — Cleanup's
  split probe is a second, separate probe rather than a loosening of that gate.

## 2026-09-09

### Added

- **Option+click a file path in a session to open it in Browse files.** Hold
  Option and any path in the transcript that exists in the project lights up;
  clicking it opens the Browse files pane, expands the folders down to it,
  highlights the row, and opens the file in a viewer. Folders are revealed and
  expanded. Paths outside the project or ignored by `.gitignore` aren't
  clickable, because the file tree can't show them either.
- **A session can now fix a Scheduler worker it already made, or remove one.**
  `create_worker` was write-once for agents — the only way to correct a typo or
  a wrong prompt was to hand the operator a corrected string and ask them to
  retype it into the Scheduler UI. Two new verbs close that gap:
  `update_worker` edits any subset of an existing worker's fields and runs
  freely unless the edit itself raises the risk (flipping to `act`, or
  touching either prompt — the worker's instructions or its system prompt —
  always a confirm, since the verb can't see the worker's current mode to tell
  a safe prompt edit from a risky one);
  `delete_worker` removes a worker and its run history for good and always
  confirms, the same as deleting a roadmap card. `create_worker` also now
  accepts `timeoutSeconds` at mint time, for a tick whose own command chain
  needs longer than the 5-minute default.

### Changed

- **A worker a session creates now starts at the same `Silent` notify setting as one
  you create by hand.** The agent verbs that mint Scheduler workers and the per-worker
  "Notify me" control were built in parallel, so this is the first release where they
  meet: a worker created by a session inherits the same default as the New worker
  button, and a session can't quietly sign you up for a notification on every tick.
  Turning it up is still yours to do, in the Scheduler. The agent docs also now
  describe listing existing workers, not just creating them.

### Fixed

- **Two agent verbs your sessions were told did not exist.** The paragraph Capy
  prepends to every session's system prompt lists the verbs a session can call,
  and `draw_canvas` (draw a diagram on a canvas) and `speak` (say one line out
  loud) had been left out of it — even though the same document explains both in
  full further down. A session that read the list and stopped there concluded the
  verb was unavailable, and at least one told its operator exactly that. Both are
  listed now, and a test asserts the list can never fall behind the verbs again.

- **A session can no longer wipe out your Scheduler workers by creating one too
  early.** The verb that mints a worker for a session wrote the whole
  `schedulers.json` file from an in-memory list, and that list was empty until the
  app had finished reading the file at boot. Nothing in the code said the boot order
  was load-bearing, so a worker created in that window would have replaced every
  worker you own with just the new one — no error, nothing to restore from. The
  store now knows the difference between "not read yet" and "you have no workers",
  and refuses to write in the first case with a plain error instead of overwriting.
  A fresh install with zero workers still creates its first one, and deleting a
  worker still works. The boot order itself is now pinned by a test.
- **Scheduler: one header, not two.** The Scheduler takeover shipped before the
  shared takeover chrome existed and was the one view never migrated onto it, so
  it drew its own 40px header underneath the shared one — two titles, two close
  buttons, stacked. Its icon, the `{n} workers · {m} running` counter and the
  **New worker** button now render in the shared header like every other
  takeover, and the view keeps only what sits below it. Its root is also sized
  as the flex child it actually is (`flex-1`, not `h-full`) — a tidy-up rather
  than a visible fix: nothing was overflowing, but the old declaration asked for
  a whole pane's height from one header lower down and was waiting to.
- **Scheduler: one bar at the bottom of the window, not two.** The Scheduler's
  own "Checks every 30s…" line carried the status footer's exact treatment —
  same background, same top border, same type size — and sat flush on it, so the
  two read as a single doubled bar. It is now a plain caption on the view's own
  background; the status footer keeps the only real boundary down there.

- **Scheduler: a run's result reads like the report it is.** A worker's result is
  whatever the model wrote, and for a real triage worker that is a document —
  headings, bold, a wide table. Both places that showed it got it wrong, in
  opposite ways: the **Last result** card collapsed every line break into one
  run-on paragraph, and the expanded run row kept the line breaks but printed
  `##`, `**` and table pipes on screen. Both now render through the same markdown
  view the memory pane and roadmap cards already use, so the two agree — and the
  block is height-bounded and scrolls, on both axes, so a long report no longer
  pushes the rest of the Runs tab off screen and a wide table scrolls inside the
  block instead of stretching the panel. A result that is a stack trace or a JSON
  blob keeps its line breaks; a run that produced nothing still says so in words
  instead of showing a bare dash. Bullet lists in a result get their bullets back,
  and a wide table keeps its columns readable instead of breaking its own headers
  mid-word.
- **Markdown lists have their bullets and numbers back, everywhere.** Every
  surface that renders markdown — project memory pages, roadmap card bodies,
  review notes, lessons, folder previews, the Markdown viewer and a scheduler
  run's result — shared one set of prose styles that never restored the list
  markers the CSS reset strips. A `- item` showed up as an unlabelled indented
  line, which is less legible than the raw dash it replaced, and lists are the
  most common structure in all of those. Markers are back, and each nesting level
  gets a different one so a nested list no longer reads as one flat list.
- **A wide markdown table scrolls on its own, without dragging the text around
  it.** Scrolling right to read the last column of a wide table used to scroll the
  whole block, so the paragraphs above and below the table slid out of view and
  the reader lost the sentence that said what the table was. Each table now
  scrolls inside its own box, keeps its columns at their real width instead of
  compressing until it breaks its own header words mid-word, and the prose around
  it stays put.
- **Two blocks showing the same document no longer collide.** Rendering the same
  markdown twice on one page — a card body beside a memory page, a scheduler
  result shown in a card and in a row disclosure — gave both copies the same
  heading identifiers. Invalid HTML, and anything reading the page as a whole
  (including a screen reader's heading list) could only ever find the first copy.
  Repeated headings within a document are now numbered, and each block's headings
  are its own. In-document `#anchor` links are unaffected.
- **Folder View: the main checkout's view no longer collapses on a big repo.** On a repo with
  102 worktrees and 128 cards, the fan-out table and the rail's card list had no height of
  their own — they simply ran until they ran out of rows, and everything under them (the rail,
  the activity chart, the Sessions block) ended up several screens down. The only scroll in the
  view was the page's own, so you paid for the length of the longest list with the visibility
  of every block below it. **Worktrees in flight** now caps its body and scrolls inside itself,
  with the column header staying put while the rows move under it; the rail's **Roadmap** and
  **Worktrees** lists cap the same way. A repo with four worktrees still draws a four-row table
  at its natural height — the cap is a ceiling, not a frame, and a list that fits shows no
  scrollbar at all.
- **Folder View: `Activity · 14d` moved to the top of the rail.** It is a 44px chart with two
  labels — the most glanceable thing in the view — and it was rendering underneath both long
  text lists, which on a big repo meant scrolling past some 230 rows to reach it. It now sits
  directly under "Where we left off", above the roadmap and worktree lists.
- **Folder View: clicking a row in the fan-out no longer navigates away.** It used to switch the
  whole view to that worktree, with no way back to the row you were reading — in a 102-row table
  that is one click from losing your place. A row now **expands in place**: a detail row opens
  underneath it — scrolled into view, since the table is now a capped window — showing
  what the collapsed row had to truncate — the full branch name, the card's
  full title, ahead/behind spelled out, the pull request's own title, and the worktree's absolute
  path. One row is open at a time, and it stays open while Capy's git and PR reads land underneath
  it. Switching to that worktree is still one click, but now it is the **Open this worktree**
  button that does it, not the act of reading the row.

## 2026-09-08

### Added

- **Scheduler: click a run to read it.** Every run's full result, the reason it ended, and
  anything it was refused have always been stored — 200 runs deep, per worker — but only the
  newest one was ever on screen. The other 199 were on disk with no way to reach them, which
  made the Runs table a scoreboard you could not ask a question of: the 3am tick cost four
  times the others and there was no way to see what it did. Any row in the table now opens in
  place, under itself, showing that run's own result, its terminal reason and its own denial
  chips. One row at a time, inside the Runs column — no dialog over the takeover. A run that
  produced no text — one you stopped by hand, say — opens to a plain "This run produced no
  result" instead of a blank panel. A tick that was skipped, because its own previous tick was
  still going or because both concurrency slots were taken, never becomes a row at all: nothing
  ran, so nothing is recorded, and the worker simply comes due again on the next check.
- **Scheduler: a per-worker "Notify me" setting, with three states.** `Silent` (the default),
  `On failure`, and `Every run`. `Silent` is not "no notifications" — a worker that disables
  itself after three failures, or because its folder disappeared, still tells you, in every
  state; what the setting controls is what happens per tick. `On failure` adds every individual
  failed tick (`error`, `timeout`); stopping a run by hand is an operator action, not a failure,
  and never fires. `Every run` adds the completed ones too — worth remembering that a 5-minute
  worker on that setting is 288 notifications a day. Existing workers, and every worker created
  from now on, start at `Silent`, so nothing about what you hear today changes. The reasoning
  is in the hint under the control: a worker's own prompt can already call Capy's notify tool,
  and it is the only thing that knows whether _this_ run found something worth interrupting you
  for — leave the scheduler `Silent` and you won't hear the same finding twice.
- **An agent can arm its own orchestrator drift-brake, live, without a human clicking "Promote to orchestrator."**
  Promoting a session to Orchestrator is two separable things: a doc injected into the system prompt at spawn, and a
  guard hook that blocks `Edit`/`Write`/`NotebookEdit` for that session until disarmed. Only the second half can be
  flipped mid-session, and until now it had no verb behind it, so a session told to orchestrate mid-conversation
  (the orchestration skill's own trigger) had no way to arm its own brake. `orchestrator_arm`/`orchestrator_disarm`
  fill that gap: a session names a target session id (its own, or one it dispatched) and the guard is armed or
  disarmed for it live, the next matching tool call onward. The target is scoped exactly like `message_session`'s
  recipient — only a session Capy itself spawned for an agent, in a folder that isn't blocked — so the verb can never
  reach into a session the operator opened by hand. See `docs/adr/0013-orchestrator-arm-addressing.md` for the
  addressing decision.
- **Scheduler: type `/` in a worker's prompt to name a skill, and the tick actually gets it.**
  A tick runs with the user and project setting sources switched off — that is what keeps your
  hooks from firing unattended at 3am — but it is also where Claude Code finds the skills in
  `~/.claude/skills/` and in a repo's own `.claude/skills/`. Measured on 2026-09-08, a tick
  could see 13 skills where a session saw 88, and a prompt naming one of the other 75 quietly
  did nothing. Typing `/` in the Prompt field now opens a list of everything that folder could
  stage — Capy's bundled skills, your personal ones, and the repo's own — each row tagged with
  where it comes from, and picking one drops its plain name into the prompt. Capy reads the
  names back out of the prompt text itself, in the form and again when the tick fires, so
  deleting a name unstages the skill and typing one by hand stages it. Under the field, one
  chip per name: `land-prs · personal` when it resolves, an amber **not found** when nothing on
  this machine answers to it. Ticks still run with the setting sources off — only the skills you
  name come along. Two lines of copy that were true before and are not any more went with it: the
  hint under the Prompt field no longer claims a tick "resolves a skill like any session", and the
  folder warning no longer says a prompt naming a skill "will fail silently" — it now says what
  actually happens, which is that only the skills you name are staged.
- **A watchdog that finds delivery work which finished and then sat there.** The new
  bundled skill `delivery-watchdog` runs as a Scheduler worker in `observe` mode and
  sweeps a repo's missions for units that are parked rather than progressing — commits
  pushed with no PR and no live session, a board card whose column disagrees with its
  worktree, an executor that vanished, a heartbeat that lapsed. It writes the finding
  onto the card and sends one notification naming the exact next action. Read-only by
  allowlist: it reports a stall, it cannot resolve one. Turn it on in Settings → Skills.

### Changed

- **The two cross-session channels are now told apart in the self-awareness doc.**
  `docs/capy-features.md` described `message_session`'s limits without mentioning
  that Claude Code ships its own native `SendMessage`, which reads as "a dispatched
  session cannot reach you at all" — false, and it cost a real delivery about 15
  hours. The doc now carries a comparison table and the short rule: a live peer goes
  over native `SendMessage`, a parked peer or an auditable flow goes over
  `message_session`, which is the only one of the two that can wake a hibernated
  session.
- **Dispatched work now reports home over Claude Code's own cross-session channel.**
  A session Capy dispatches holds none of Capy's MCP verbs, but `SendMessage` is
  native and unaffected — so the delegation packet now carries a real return address
  (read from `ListAgents`, which states the session's own name; a session id is not
  an address and never resolves) plus a `.capy/REPORT.md` fallback. The orchestrator
  also subscribes to each executor with `notify_when_idle` at dispatch, so a unit
  that finishes wakes it immediately instead of waiting for the next timed tick.
- **`orchestrate-delivery` no longer assumes its own loop survives.** The heartbeat is
  now explicitly two layers — the in-session loop that does the work, plus a
  `delivery-watchdog` worker that outlives the session and can at least make a stall
  loud — and the skill records the arrangement in the mission file so a lapse is
  visible. A new "Resume" step makes every turn in an orchestrating session re-derive
  state from git and the board, do the work the missed ticks would have done, and
  re-arm the loop before answering: previously, answering an operator's question
  mid-delivery could leave the heartbeat dead.
- **Acceptance criteria the orchestrator wrote itself are now marked `provisional`.**
  When an objective arrives without acceptance criteria, the orchestrator still writes
  them and still dispatches immediately, but it tags them, notifies once with the list,
  and carries the tag into the delivery report — so a criterion that was met reads as
  "met the bar we proposed" rather than "met the spec".
- **Delegation packets now carry the repo's delivery method as steps.** A packet states
  what TDD or spec-first actually requires of the executor (the failing test as the
  first commit, the red→green transition reported as evidence) instead of naming the
  method and hoping.
- **A delivery now ends with a short retro on the pipeline itself** — where a unit
  waited on nothing, what a packet instructed that could not be done — written to
  project memory so the next orchestration in that repo starts knowing it.

### Removed

- **Scheduler: the Provider picker is gone (BUG-114).** It was drawn, it was saved with the
  worker, and nothing on the way to spawning a tick ever read it — every tick ran against the
  Anthropic default regardless of what was selected, while the hint under the control promised
  "a local endpoint keeps ticks off the Anthropic bill". A control that cannot change the
  outcome is worse than a missing one. Removed rather than left inert; an existing worker that
  had one saved loses the dead field the next time Capy reads its definitions, and nothing
  about how it runs changes, because the setting never changed it.
- **Scheduler: the transcript option is gone (BUG-115).** `keepTranscript` was documented as
  "capture the turn-by-turn stream to Capy's own userData". Nothing wrote a transcript
  anywhere. All it actually did was switch the tick to a streaming output format, which the
  code that reads a finished tick then parsed as if it were a single document — a path with no
  test coverage that could only ever make the reader wrong. Every tick now asks for one JSON
  document, always.

- **A session can create a Scheduler worker on its own.** Two new agent verbs,
  `create_worker` and `list_workers`, let a session mint and enumerate the one
  heartbeat that outlives it — the backstop an orchestrating session needs to set
  up so its own coordination survives past when it ends. An `observe` worker (the
  default) is created directly, no confirmation, the same class as a session
  starting another session; an `act` worker runs with permissions bypassed and
  never stops at the Approval Inbox, so minting one always faces you as a
  confirmation naming the folder, cadence, and prompt before it's created — the
  same standing as a mission grant. Either verb is off-limits to an `observe`
  worker's own tick, so a read-only heartbeat can never mint or enumerate other
  heartbeats. A worker made this way arrives already switched on, unlike the
  Scheduler UI's create-then-arm form.

### Fixed

- **The `create_worker` warning now describes what actually triggers it.** The ACK
  string, the tool description and the docs said the warning fired when a prompt
  named a skill "not enabled for that folder." It never did: naming a bundled
  skill that's merely switched off stages it anyway — that's deliberate, the same
  behavior a Scheduler tick already honors. The warning only ever fires when a
  mention resolves to nothing on this machine at all (a typo, an unknown name, a
  plugin skill a tick can't load). Wording only; the worker was always created
  either way.

- **Jumping to a folder from the sidebar search now opens it.** Picking a folder in the
  jump palette — from Folders, from "Unhide & go" or from Recently visited — only
  highlighted its row in the tree; the main pane kept showing whatever was there before.
  It now opens the folder's Folder View, exactly like clicking the folder row, and closes
  any takeover (Roadmap board, PR Stack, Usage dashboard…) that would otherwise hide it.

- **The Scheduler's "extra read commands" field now checks the command, not just its shape.**
  In `observe` mode this field let you widen a worker's read-only allowlist, but it only
  verified that what you typed _looked_ like `Bash(something)` — never what was inside. A
  rule like `Bash(rm -rf /)` or `Bash(git push --force)` was accepted exactly like
  `Bash(git status)`, which handed write access to the one mode whose entire promise is
  that it cannot write. Capy now validates the invoked verb against an explicit read-only
  list, and refuses anything chained (`&&`, `;`, `|`), substituted (`$(…)`, backticks),
  redirecting (`>`, `>>`), prefixed by `env`/`sudo`, or carrying a writing flag in any of
  the forms a shell accepts it — `-o file`, `-ofile` and `-lo` are all caught. Verbs whose
  subcommands are not all read-only — `git`, `gh`, `jj` — are only accepted together with a
  subcommand, so `Bash(git status)` passes and `Bash(git push)` does not, and a `:*` wildcard
  is refused for a verb an argument could make write (`Bash(git diff:*)`), since the wildcard
  authorizes arguments the check never sees. `sort`, `uniq` and `tree` are not accepted at
  all: each writes with an ordinary argument (`uniq IN OUT` writes its second positional), so
  no flag check makes them read-only. A refused rule now appears in that worker's **Runs**
  tab as `rejected rule: …` instead of being dropped in silence. One rule that used to work
  no longer does: `Bash(npm run lint:*)` runs whatever your `package.json` says, so it is
  refused along with `node` and `xargs`.
- **The `act` mode warning no longer promises a protection Capy does not provide.** It said
  "Capy still blocks catastrophic shell commands", and that was false: a Scheduler tick
  launches with your settings dropped, so the hook that carries that guard was never loaded
  for either mode. Capy now does inject its own hooks into every tick, so a tick's progress
  is visible to the app in both modes — but those hooks observe state, they do not inspect
  the commands the tick runs. The warning now says that plainly, and the Scheduler docs and
  spec were corrected to match.

- **Scheduler: a screen reader now hears a run row as a row.** Each row in the Runs table was
  itself the disclosure control — it carried `role="button"`, which replaces a row's semantics
  outright: assistive tech announced a button instead of "row 3 of 12", and the cells lost the
  row ancestor that makes the Time/Status/Turns/Cost/Duration headers mean anything. The row is
  a row again, and the control is a real button on the timestamp inside it, announcing whether
  it is expanded and naming the panel it opens. Clicking anywhere on the row still opens it, as
  before.

- **Scheduler: a chatty worker can no longer grow its history without limit.** A failed tick
  always capped what it stored at 4000 characters; a successful one did not, and the result
  comes straight off the model. Both paths now use the same cap.

- **A new Scheduler worker no longer starts running before you have finished creating it.**
  Workers were created already switched on, and a worker that has never run is due on the
  very next beat — so within thirty seconds Capy fired a tick against the empty prompt the
  form opens with, that tick failed, and three failures switched the worker off again. You
  could watch a worker you were still naming go from new to `failed · 1 in a row` to
  disabled without ever having told it what to do. Two things changed: **a new worker is
  now created switched off**, so filling in the form and arming it are separate acts; and
  **a worker with an empty prompt is never due**, even if it is switched on. A worker you
  arm still runs on the next beat rather than waiting out a full cadence — that part was
  deliberate and is unchanged. (The user guide already promised "nothing fires until you
  save a folder and a prompt"; the code now keeps that promise.)

- **The Scheduler's detail pane no longer shows a stray platform scrollbar.** The Runs and
  Settings columns scrolled with the operating system's own scrollbar — wider, opaque, with
  stepper arrows — instead of the thin hover-revealed one every other scrolling surface in
  Capy uses, so it read as a bar sitting outside the panel.

- **A dispatched agent's session no longer silently stalls when a takeover is open with
  nothing selected (BUG-103).** The main-pane terminal only drained its background boot
  queue while it was actually mounted, and every takeover (Roadmap board, PR Stack, Usage
  Dashboard, System Monitor, Cleanup, Review, Scheduler) outranked it — so an MCP
  `create_session` landing while the operator had a takeover open and no session selected
  queued its boot and then never ran it, eventually failing itself as `boot timeout`. The
  terminal now renders continuously behind whichever view is on screen instead of being
  unmounted by it, so a queued boot always drains. The terminal a takeover now covers is
  also excluded from Tab/keyboard focus and the accessibility tree (`inert`), matching what
  unmounting used to guarantee for free.

- **The Roadmap filter bar's Group control no longer explodes into three stacked rows.**
  The `epic` / `kind` / `none` buttons rendered one per line instead of side by side —
  `epic` bled up over the board header's card count, `none` bled below the filter bar. The
  control's wrapping `<div>` is itself a `flex-wrap` container, and a `flex-wrap` container's
  automatic minimum width is only its single widest child, not the sum of all of them — so
  once the filter bar ran short on room, that wrapper shrank down to one button's width and
  every button wrapped onto its own line. The Group label and control now sit in their own
  `shrink-0` group so they always get their full one-row width; the filter bar itself scrolls
  horizontally instead when the window is too narrow to fit everything.

### Fixed

- **Kokoro voice synthesis no longer freezes the whole app on every utterance (BUG-117).**
  Every spoken line ran `kokoro-js`'s ONNX inference synchronously on the renderer's own UI
  thread — the single thread that draws every session's terminal, not just the one
  speaking — so the whole window locked up for the duration of each utterance, reported by
  the operator as "any session freezes, not just the one talking." Synthesis now runs
  inside a dedicated Web Worker instead: the renderer hands it text and gets back an audio
  buffer, and model loading plus `generate()` never touch the UI thread again. (An
  onnxruntime-web `proxy: true` flag looked like a one-line fix and was tried first, but
  measured broken against a real install: its own internal proxy worker reloads a different
  file than the one this install actually downloads, failing outright for every voice
  already on an operator's disk — see the `applyKokoroEnv` doc comment in
  `speech-kokoro-env.ts` for the measured failure.)

## 2026-09-07

### Added

- **The sidebar's search button now takes you somewhere instead of hiding half your
  tree.** Clicking it opens a jump palette under the header: type, and you get a list of
  targets grouped as Folders, Hidden and Sessions — press ↵ and Capy expands whatever the
  target lives behind, scrolls to it, selects it if it is a session, and flashes the row
  so you can see where you landed. The tree itself is never filtered, so closing the
  palette leaves you exactly where you were. It searches more than the old filter did: a
  folder's name, its git branch **and its path**, plus a session's summary and its first
  prompt — so pasting a PR number or a ticket key finds the session that worked on it.
  **Folders you have hidden are searchable here too**, with an "Unhide & go" chip that
  unhides and jumps in one keystroke, instead of opening the Hidden list and scanning it.
  Open it with nothing typed and you get your history: your last 8 searches (with how
  many hits each found) and the last 5 folders you visited. `↑↓` moves, `↵` jumps, `⇥`
  falls back to the old behaviour and filters the tree with what you typed, `Esc` closes.
  `⌘K` is unchanged — it still opens the command palette.

- **Drill-in rows are no longer dead ends.** At drill depth 1–2 the header row and the
  chooser rows below it were plain buttons: right-clicking did nothing, and renaming,
  hiding, or cutting a worktree meant leaving drill-in first. Every row now carries the
  same menu its twin in the classic tree has — right-click anywhere on it, or use the new
  trailing **⋯**. A folder row (and the folder screen's header) opens the usual folder
  menu; a repo/group row opens Rename group / Reset name / Cleanup. On the header the ⋯
  sits after the **+** and stays visible; on the chooser rows it appears on hover, like
  every other stat on a sidebar row.

- **The Hidden-folders popover is searchable, grouped, and can restore a whole batch.**
  Hiding folders you are not working on is cheap, so the list grows — 43 of them in one
  install — and finding one again meant scrolling a flat column of names. The popover now
  opens on a search box, already focused, that filters by folder name, branch and path
  (whichever you happen to remember), with an "N of M" counter next to it. What is left is
  grouped under its repo, using the same label the sidebar's repo header shows, and every
  row says how many sessions live in that folder. `↑`/`↓` move through the results and `↵`
  restores the selected one; the popover stays open, so bringing several back is one visit,
  not several. And when a search narrows things to two or more folders, the footer offers
  "Unhide all N" to restore exactly that filtered set.

- **Design tokens: the green/red/warning "line" and "soft" grammar is complete.**
  `--color-green-line`, `--color-red-line`, `--color-warning-soft`, and
  `--color-warning-line` now exist across every theme, each derived from that
  theme's own hue — the badge-token contract already used by `--accent` is now
  symmetric across green/red/warning too. An extension theme that predates
  these four tokens keeps working: Capy alpha-blends them from the theme's
  declared base color instead of leaving a badge transparent.

- **Scheduler workers: persistence, the tick runner, and the IPC surface
  (groundwork — not yet reachable from the UI).** Worker definitions now
  survive a restart (`schedulers.json`) and every tick's outcome is kept as
  an append-only run history, capped at the newest 200 runs per worker. A
  single 30-second check spawns a due worker as a headless `claude -p`
  process in its own folder, kills it if it runs past its timeout, and
  disables it — with a notification naming the reason — after three
  failures in a row or if its folder has been deleted. Still invisible:
  the takeover that lets a person actually create a worker lands in a
  follow-up change.

- **FolderCombobox primitive (groundwork — not yet wired to any dialog).** A
  new searchable single-select over the folders Capy already knows, sibling
  to the existing branch picker: a trigger reading "alias · branch", a
  filterable dropdown that groups a repo's worktrees under one header, a
  synthetic label so a folder Capy has lost track of (a deleted worktree, a
  moved directory) never reads as "nothing selected", and a trailing "Choose
  another folder…" row. Built for the upcoming Scheduler worker form (T291),
  which is what will actually put it on screen.

- **Scheduler takeover: the Scheduler is now something you can actually open.**
  A new footer pill (quiet when nothing runs, a live green count when a tick
  is in flight) opens a full takeover: a worker list with its five states
  (waiting, running, failed, disabled, off), a detail pane with Runs (last
  result, run history, and what a worker got denied trying) and Settings
  (schedule, model/effort/provider, and the permission mode — `act` is the
  only place in the app where a selected control turns red instead of accent,
  because the selection itself is the warning). Creating, editing, running,
  stopping, and deleting a worker all work from here now — deleting always
  asks for confirmation first, whether from the worker list's hover icon or
  the Settings tab.

- **Scheduler: a user guide, and the two facts about it worth reading before
  you turn one on.** The new [Scheduler](docs/user/scheduler.md) page covers
  creating a worker and what each field does, but its real job is spelling
  out the sharp edges plainly: an `act` worker does not stop at the Approval
  Inbox — there's nobody there to click Allow or Deny — and a tight cadence
  is a real, recurring model-call cost, visible in a worker's own run
  history (a 5-minute worker fires 288 times a day). It also names the three
  honest limits (Capy has to be open, your own hooks don't run inside a
  tick, at most two workers run at once) and flags that the `observe`
  mode's extra-read-commands field currently checks a command's shape, not
  its safety (BUG-108) — so a command like `Bash(git push --force)` is
  accepted as readily as a real read-only one.

### Changed

- **The sidebar header and its toolbar merged into one row, giving the tree back ~34px.**
  Rescan, drill-in depth, collapse-all, the hidden-folder count and search now sit on a
  single 42px line, right-aligned with search last, and the folder tree starts directly
  underneath. Nothing moved out of reach — the same buttons do the same things, and the
  inline filter input is still there behind the palette's `⇥`.

- **Drill-in remembers where you were.** Reopening Capy used to drop you back at the root
  screen even if you had spent the session inside one worktree. The drill position is now
  saved and restored. If anything it pointed at is gone — the folder was removed, you hid
  it, the repo group no longer groups — it falls back to the root screen rather than
  stranding you on a screen with nothing in it, or reopening on a folder you dismissed.

- **The six main-pane takeovers (Roadmap board, PR Stack, Cleanup, Usage Dashboard,
  System Monitor, Review) now come from one internal registry instead of six
  hand-tracked flags.** No visible change — same dismissal behavior, same toggle
  buttons, same Esc handling — but a future seventh view can no longer be wired
  incompletely and silently reintroduce the bug where a fresh session stayed hidden
  behind an open takeover (BUG-102). Purely internal (`stores/ui.ts`, `App.vue`).
- **The six takeovers now share one header instead of six hand-rolled copies.**
  Nearly all pixel-identical to before, with two small, deliberate exceptions: the
  Review pane and PR Stack Canvas headers gain a hover tooltip on the close button
  (every other takeover already had one) and both now carry an accessible name on
  the takeover region (`aria-label`), which they were previously missing.

### Fixed

- The FIRST takeover a session opened after launch (whichever it was) could render
  its header with no icon: the icon and the shared header it teleports into mounted
  in the same render pass, so Vue sometimes resolved the Teleport target before that
  header existed. Every subsequent takeover you opened in the same session was
  unaffected. Fixed by deferring target resolution (`<Teleport defer>`) on all six
  views.

## 2026-09-07

### Fixed

- **A dispatched unit no longer parks silently between "pushed" and "PR open".**
  The `orchestrate-delivery` packet told the executor to hand its branch to a
  fresh shipper session by calling `create_session` — a verb that session does
  not have: Capy spawns agent-dispatched sessions `agentControlled`, withholding
  its `--mcp-config` so they hold no `mcp__capy__*` verbs at all (that is what
  stops a recursive conductor). The instruction could only fail, quietly: the
  executor pushed, found no verb, and stood down with no PR and no way to say
  so. The ship handoff is now the orchestrator's own step, stated as such in
  both `orchestrate-delivery` and the `mission` tick — commits on the branch, a
  clean tree and no PR means dispatch the shipper now — and the monitoring loop
  must stay armed until every unit reaches Review, because the operator noticing
  a stalled unit days later is the failure the loop exists to prevent.

## 2026-09-06

### Changed

- **"Browse files" now lands your cursor in the search field.** Opening the
  Explorer pane from the Topbar or the Folder View focuses (and selects) its
  file search, so you can type a filename straight away instead of clicking the
  field first. Clicking "Browse files" again with the pane already open
  re-focuses the search rather than doing nothing visible.

### Fixed

- Dispatching or generating from a long roadmap card no longer spawns a session
  with an empty composer and a "Prompt not delivered" badge. Two causes: the boot
  prompt's body cap and the reliable argv delivery limit were the same number, so
  any card whose body reached the cap overflowed by exactly its own framing and
  fell onto the older paste-after-boot path; and that path then gave up on the
  prompt after the first half-second lull in the boot banner. Long cards now
  deliver whole — including interview answers, which sit at the end of the card
  and used to be the first thing truncated — and the paste path waits a realistic
  cold-boot window for the composer, handing the prompt back for a retry instead
  of dropping it.

## 2026-09-04

### Fixed

- **Settings → Voice: the Test button now tells you what happened.** Pressing it used
  to change nothing on screen, which was the worst possible place for that — its entire
  output is audio, the one output you cannot see. A muted machine, a first Kokoro run
  loading the offline voice, an utterance Capy dropped on purpose and a backend that
  simply failed all looked identical: nothing. Now the click is acknowledged straight
  away, the wait is visible while it lasts, and the result is spelled out — spoken;
  nothing was spoken _because_ voice is off, or muted, or the phrase is empty; stopped;
  or a failure that names what failed (a command that is not on your PATH, a voice that
  was never downloaded). Only the line that says it _did_ speak mentions your volume,
  because that is the only case where your speakers are the remaining explanation.
  Pressing Test again while one is playing does nothing on purpose — the engine plays
  utterances one after another, so a second press would only buy you a second sentence.

### Changed

- **The voices list is a short scrolling list instead of a wall of 28 rows.** It used to
  push "What it says", "Sessions" and the disk row far below the fold, so the settings
  you actually change were the hardest to reach. The voice in use is now named just
  above the list and stays on screen wherever you have scrolled, and opening the tab
  scrolls straight to it. The "English only" note about Portuguese sits under the list,
  where it is still read.
- **Picking a voice now plays it.** The button always carried a play icon; it now
  actually speaks the phrase in the voice you picked, and reports the outcome the same
  way Test does. The voice already in use gets a Preview button so you can hear it again
  without changing anything.

- **`read-aloud` now speaks through Capy's own voice, not a shell command.** The skill
  shipped talking to a text-to-speech program on your `PATH`, because Capy had no way for
  a session to ask to be heard yet. It does now, so inside the app the skill uses it —
  which means reading something aloud obeys the switches in Settings → Voice like
  everything else, and still leaves nothing behind in your Activity history. Outside Capy
  — the same skill in a plain terminal, where there are no Capy verbs — it falls back to
  `CAPY_TTS_COMMAND` (or `speak-notify`) exactly as before, so it does not become an
  app-only feature. What it will not do is fall back to the shell after Capy _refused_:
  a refusal is your own switch answering, and a folder you muted on purpose stays muted
  rather than being talked around.

## 2026-09-03

### Added

- **Settings → Voice — the switch the whole thing was missing.** Voice existed but had
  nowhere to be turned on. Now there is a Voice tab: pick the engine (your own TTS command,
  or the built-in offline one), download the offline voice with an explicit button that
  shows progress and can be cancelled, choose which of the 28 voices speaks, and see what
  the download is costing you on disk with a Remove that reclaims it. There is also a
  **Voice** toggle in General → Notifications, right under **Sound**, because voice is a
  notification channel — it turns speech on and nothing else, and it never starts a
  download. See [Voice](docs/user/voice.md).
- **It names the session and what happened, not just "done".** The Voice tab carries a
  phrase template — `{folder}`, `{session}`, `{event}` — with a live preview and a Test
  button, so a spoken notification says "capy — feat t216 is waiting for you" rather than
  a word that tells you less than the chime already did. It rides the same three
  notification events (Needs input / Completed / Failed) rather than adding a second set
  to keep in sync, and if speech fails it quietly falls back to the chime while the
  **reason** stays readable in the pane — never mute with no explanation. And because
  voice rides the same decision the notifications make, the pane says so plainly when
  the OS-notifications master switch is off, instead of leaving you to work it out from
  the silence.
- **Which sessions may speak, made auditable.** The Voice tab shows the `speak` gate as it
  actually resolves: a global switch, plus a list of only the folders that carry a
  deliberate exception. A folder that inherits is labelled and styled differently from one
  that was explicitly set, so a mute you made weeks ago is findable; "Clear exceptions"
  returns every folder to inheritance without touching the global; and a folder you have
  blocked for agents shows as silent-and-locked whatever the global says. Flipping the
  global still writes nothing into any folder.

- **A good offline voice, if you want it — downloaded, never bundled.** Capy can now
  speak with Kokoro, a neural text-to-speech model that runs locally and works with the
  network off. It is not in the installer: you opt in once, Capy fetches ~119 MB into its
  own data directory, and from then on it speaks without touching the network. Nothing
  downloads behind your back — turning voice on doesn't start a fetch, and selecting the
  offline engine doesn't either; only pressing the button does, after a screen stating the
  size, the contents, the destination and the licence terms. A cancel leaves nothing
  behind; a crash mid-download resumes instead of re-fetching 92 MB of weights; removing
  it reclaims the disk and returns Capy to where it was. It speaks **English only** — 28
  American and British voices — and Portuguese is shown as unavailable with the reason,
  because the library hardcodes every voice to `en-us`/`en-gb`. See
  [Voice](docs/user/voice.md).
- **The download includes the engine code, not just the model — on purpose.** `kokoro-js`
  and the weights are Apache-2.0, but its `phonemizer` dependency ships a compiled
  espeak-ng, which is GPLv3. Bundling the library and downloading only the model would
  look tidier and would quietly relicense every Capy release as GPLv3. So Capy ships none
  of it, and a CI gate fails the build if `kokoro-js` or `phonemizer` ever appears in the
  packaged artifact.
- **A session can say something out loud.** With voice turned on, a session can
  speak one short line through your speakers — "the migration finished, zero
  conflicts" — for when you're away from the screen. It's heard once and gone:
  no Activity row, no toast, nothing to come back to (a session that wants you
  to find the message later posts a "Session says" notice instead). Voice starts
  OFF; you turn it on in Settings → Voice, globally or for one folder. The global
  switch covers every folder you have and every worktree you'll ever make, and
  turning it on never writes anything into your folders — so a folder you muted
  on purpose stays muted. A folder you've blocked for agents is silent whatever
  the voice settings say. Speech is capped at a headline's length (longer text is
  trimmed, never refused), stays quiet for the session you're actually looking at,
  and is rate-limited per session so one looping agent can't hold the speakers.
  See [Agent control](docs/user/agent-control.md).
  The Settings → Voice panel that exposes the switches is the next piece of the
  voice work and isn't in the app yet — until it lands, every folder stays silent.
- **PR Stack — the card now says when a human asked for changes.** A PR whose
  review verdict is _changes requested_ used to render the same neutral grey
  `review` chip as a PR nobody had opened, which are the two most different
  states a PR can be in. It now gets its own red chip, ranked below `conflicts`
  and `retarget` and above `approved`.
- **PR Stack — drafts are marked on the card.** A `draft` badge sits on the
  identity row beside the PR number, so it stays visible when you zoom out past
  70% and the chip row is gone. GitHub already told us; the card just never drew
  it.

### Changed

- **The espeak-ng licence question is decided.**
  [`docs/adr/0012`](docs/adr/0012-espeak-ng-gpl-exposure-in-a-bundled-kokoro-backend.md)
  moves from Proposed to **Accepted — option C (runtime opt-in download)**, recording the
  reasoning: the default Linux TTS sounds bad enough that shipping it as the experience
  would make being read to seem useless for the wrong reason. If you want a good voice,
  you download it — and Capy's binary stays MIT.
- The bundled `status` skill now renders its glance card in the same visual
  system as the `report-back` final report: no emoji anywhere (the header dots,
  the stale-executor hourglass and the flag are gone), `▰`/`▱` progress bars
  instead of `█`/`░`, and the frozen narrow-glyph gutter (`✓` shipped, `!` needs
  attention, `✗` finished and failed, `-` not started, `⚑` something is owed,
  `?` open question) — every marker exactly one column wide on every font, so the
  label column never shifts and a card pasted into a file, commit message or PR
  body still lines up.
- The `status` card now states success explicitly instead of implying it. A front
  that is finished and proven ends its header with a `· all green` verdict — only
  when the bar is full, nothing is owed, and the evidence is named (merged PR,
  green checks, release tag); a front that stopped takes `· stopped at <what>`.
  The "nothing is owed" line is spelled out as `— nothing, you're clear` rather
  than a bare dash, so an empty ledger reads as "I checked, you are free" instead
  of "nobody looked".
- The `status` card gained a links block: after the last card, every PR, CI run,
  board card, task or generated report worth opening, written as
  `<why open it> → <url or path>`. Full URLs now live there and only there — a
  card body carries the bare `#224`.
- **PR Stack — the card's status is now one chip, not four competing ones.** The
  status slot is picked by a single precedence rule (conflicts → retarget →
  changes requested → approved → review) instead of a chain of overlapping
  conditions, so the card can gain new signals without the row growing
  unreadable. The expand chevron also stays put now: a long chip row is clipped
  from its trailing edge rather than pushing the chevron off the card.
- **The PR Stack canvas now reads every remaining signal GitHub already offers,
  in the same call it was already making.** `gh pr list` is asked for
  `mergeStateStatus`, `additions`, `deletions`, `changedFiles`, `reviewRequests`,
  `labels` and `autoMergeRequest` alongside the fields it already fetched — no
  extra round trip, no extra rate-limit cost. **Nothing on the canvas looks
  different yet**: this is groundwork so the card units that draw these signals
  can land without each one re-editing the query. Absent data stays absent —
  a diff size the app could not read parses as "unknown", never as `+0 −0`, and
  a label's GitHub hex colour is deliberately dropped rather than carried into
  the renderer.

### Fixed

- **A new session now wins the main pane no matter what was covering it (BUG-102).**
  The 2026-08-31 fix only cleared the folder selection when minting a session — it
  never closed an open takeover. Starting a session (or forking one, or opening a
  folder terminal) while the Roadmap board, PR Stack Canvas, Cleanup, Usage
  Dashboard, System Monitor, or Review pane was open left the new terminal invisible
  behind it. Every session-focus action now routes through the same primitive that
  already clears the folder selection, so it dismisses whatever is on screen too.
  `⌘N` / the palette's "New session" also now mints into the currently selected
  folder instead of always falling back to the first one. Retrying a boot-failed
  synthetic's session (SessionMenu's "Retry boot") when nothing was selected now
  closes an open takeover too, for the same reason — otherwise the takeover kept
  the retried session's terminal from ever mounting to drive its boot.

- **A folder's session rows now show what each session is doing.** Every row in the
  Folder View carries the same status dot the sidebar paints — green for working,
  amber when it is waiting on you, muted when it is idle — plus the session's
  message count. The dot is resolved by the sidebar's own rule, not a second
  opinion, so a session can never read `working` in one place and `idle` in the
  other.
- **A repo's main checkout now shows the whole fan-out at a glance.** Open the main
  checkout of a repo with more than one worktree and the Folder View leads with
  **Worktrees in flight**: one row per worktree, with its branch and status dot, the
  roadmap card that branch is executing, how many sessions it holds and how many are
  live, how far ahead or behind it is, and its pull request as a pill you can click
  through to GitHub. Above it, a KPI strip answers what needs you, how many worktrees
  are in flight, what the board holds, and how many sessions are running in the
  checkout itself; a 14-day activity chart in the rail shows how the fortnight
  actually went. Every one of those reads degrades on its own — no `gh`, no network,
  or a repo with no pull requests leaves the PR column empty instead of showing an
  error, and a branch no card owns shows an em-dash rather than a guess. The one thing
  that never degrades silently is the "needs you" tile: when it cannot read pull
  request state it says so, rather than counting those signals as zero. A repo with a
  single worktree shows no fan-out at all.
- **The Folder View can now ask which card a branch is executing.** The read-only
  board peek takes an optional branch and answers with the card whose `executedIn`
  names it — the "what is this branch FOR" hero block of the new worktree Folder
  View. It looks across all five columns, not just the two it names today, so a
  branch whose card has already been closed still gets an answer; when more than
  one card names the same branch the live one wins (in progress, then review, then
  ready, then backlog, then done), falling back to the board's own within-column
  order rather than whatever the directory listed first. Callers that ask without a
  branch get exactly the summary they got before.
- **A worktree's Folder View now leads with the card that branch owns.** The hero
  names the card whose `executedIn` is this branch — id, title, board status and a
  pill with its pull request's state — above a four-step rail: dispatched →
  commits → PR → merge, with the real evidence on each (how long ago it was
  dispatched, the commit count and latest short SHA, the PR number). The **PR**
  step shows the number and nothing else — it does **not** show how many review
  threads are still open, because Capy does not read a thread count for a pull
  request today. Exactly one
  step is highlighted at a time: the one the work is standing on. The final
  **merge** step does not light up yet — Capy only reads open pull requests, so a
  landed PR drops out of view rather than completing the rail; it under-reports
  instead of claiming a merge it cannot see. Everything it
  shows comes from reads that already existed — no new probe, and nothing on the
  PR Stack was touched. **A step Capy cannot verify shows as "not yet", never as
  done**: with no `gh` or no upstream the rail stops where the evidence stops
  rather than guessing, and "no PR" and "could not check for a PR" are never
  conflated. A worktree whose branch owns no card shows **no hero at all** — the
  normal state for a worktree you cut by hand — rather than an empty placeholder.
- **Sibling worktree rows carry their session state.** Each worktree in the
  Folder View's worktree list now shows the sidebar's own status dot, so a branch
  you are stacked on that is waiting on you is visible without leaving the folder
  you are standing in. The worst case wins: amber if any of its sessions needs
  you, green if any is working, muted otherwise.

### Changed

- **The Folder View is scope-aware, and it uses the whole pane.** Half of what the
  view showed was never about the folder you clicked: project memory, the roadmap
  counts and the worktree list all collapse onto the repo's main checkout, so a
  worktree was printing main's snapshot and main's board as if they described the
  branch. Every block now carries a **`this folder`** or **`repo`** tag saying what
  it is actually about, read from a single scope table rather than typed per
  header, so a tag can never drift from the read behind it. The 880px column cap is
  gone — content is a main column plus a 320px context rail, folding to one column
  (rail two-up) at 1100px and stacking at 760px.
- **The view now has two shapes.** A repo's **main checkout** gets the orchestration
  home (its lead block is the repo's fan-out); a **worktree** gets one feature's
  cockpit (its lead block is the card that branch owns) with the repo-wide blocks in
  a labelled rail, and its worktree list titled _Sibling worktrees_. A plain pinned
  folder with no repo keeps the main shape. Both hero blocks are still being built —
  until they land their slot is empty rather than filled with a placeholder, and
  every section the view showed before is still there.

### Fixed

- **Folder View: a card in the folded rail is no longer stretched to three screens
  tall.** In a narrow pane the context rail folds into two columns, and each card
  was being made as tall as the tallest card beside it — so on a real repo, a
  roadmap card listing 88 cards in review dragged its neighbour to roughly 3000px
  and left a 44px activity chart floating at the top of a mostly empty bordered
  box. Cards are now sized by their own content in both layouts.

## 2026-09-02

### Fixed

- **The bundled-skills catalog no longer ships a committed merge conflict.**
  `resources/skills/CATALOG.md` had carried `<<<<<<< Updated upstream` / `=======`
  since v0.3.29, left by a bad stash-pop resolution. Prettier rendered the closing
  marker as a blockquote, so the formatter passed and nothing flagged it. The
  version marker is resolved to a single line and bumped to `v6`, which is the
  honest value: four `SKILL.md` files changed after `v5` was written without the
  catalog moving with them, so staged copies were never told to refresh.
- **A goal file's frontmatter is now stated as mandatory, not just shown.**
  `mission` displayed the `session:` block in its template but never said it was
  required, and goal files were being written without it — the filename prefix kept
  them from colliding, but the front read as unowned. `status` now also falls back
  to the filename prefix for attribution, so the files already written without
  frontmatter still name their orchestrator.
- **"GitHub CLI is unavailable here" on a Dock-launched macOS build (BUG-34).**
  PR Stack, Review, the Cleanup scan and PR viewed-state all spawned `gh` with
  whatever `PATH` the app was launched with. On macOS an app opened from the
  Dock or Finder inherits launchd's minimal `PATH`
  (`/usr/bin:/bin:/usr/sbin:/sbin`), which does not include Homebrew's
  `/opt/homebrew/bin` — so every call died with `ENOENT` and those panes
  reported the CLI as missing to users whose `gh auth status` was green in a
  terminal. All four now spawn with the login-shell `PATH` Capy already
  captures for PTY sessions and worktree setup, so `gh` (and `git`/`du` on the
  same paths) resolve the same way they do in your shell.

## 2026-08-31

### Fixed

- **Starting a session from the folder screen now actually shows that session.**
  Clicking **+ New session** (or forking one, or dispatching a card by hand)
  minted the session and selected it in the sidebar, but the folder's index
  screen stayed on top of the main pane — so the new terminal was invisible
  until you clicked the row a second time. Minting a session now drops the
  folder selection, the same way clicking a session row always has.

## 2026-08-28

### Added

- **Cleanup lists detached worktrees instead of hiding them (BUG-95).** A
  worktree checked out at a bare commit rather than a branch produced no row at
  all — on one real repo that was 15 of 48 worktrees holding 7 GiB, a third of
  the checkout disk, entirely invisible. Each one now gets its own **detached
  worktree** row carrying the folder, the age of the commit it sits on and the
  folder's size — the shortest thing that identifies it, never a truncated
  absolute path. Because there is no branch there is no PR, ancestry or
  remote to check, so every branch checkpoint reads "not applicable" rather than
  borrowing an answer from a branch that happens to point at the same commit. A
  detached worktree is **blocked** with "detached HEAD — no branch" as the stated
  reason, and can never be swept — not on its own, not inside a bulk sweep.
  Cleanup is reporting the disk, not offering to delete it. As with every other
  folder, one with a live Capy session in it stays hidden until the session ends.
- **Cleanup preserves your work before it deletes anything (T254).** Before a
  sweep trashes a worktree or deletes a branch, Capy writes two git refs that
  outlive it: `refs/archive/<branch>/<timestamp>/tip` for the commits, and
  `.../wip` for the working state the tip does not hold — modified files _and_
  untracked ones, captured from the worktree exactly as it stood. Files matched
  by `.gitignore` are skipped, so archiving costs megabytes, not gigabytes. If
  the archive cannot be written, that item is abandoned with the reason shown
  instead of deleted. Both ref names are recorded in the cleanup journal beside
  the existing restore command, and `docs/user/cleanup.md` explains how to get
  anything back. Your `git stash` stack is never touched.
- **Review pane: approve, request changes, or comment on a pull request without
  leaving Capy (T244).** When the branch you are reading has a pull request, the
  evidence header offers **Submit review**. Write what you found, pick one of
  the three verdicts, confirm, and it goes to GitHub under your own account — it
  runs `gh pr review`, so Capy never holds a token of its own and can never
  reach further than you can. The three verdicts sit side by side, styled
  identically, none pre-selected, and all three ask for the same body: a surface
  where approving is one click and objecting is three teaches people to approve.
  Nothing recommends a verdict — Approve is neither disabled by red checks nor
  encouraged by green ones. **No agent, session or skill can reach this**; the
  only trigger is your click. And you can only approve what you actually read:
  Capy pins the commit the diff was built from and re-checks it at the moment
  you submit, so an amend, a push or another session moving the branch under you
  is refused with the reason, rather than approved on your behalf. A submission
  that fails says so verbatim and keeps your text — the pane never shows a
  submitted state it did not confirm.
- **The review companion now knows that it is blind (T247).** Reviewing a PR no
  longer costs a worktree, so the folder can sit on `main` while you read a
  branch far away from it — and asked what it was reviewing, the fresh session
  ran `git status` and answered confidently about the folder. It was right about
  where it stood and wrong about what you were reading. Before its first turn it
  is now handed a short orientation: the folder's `HEAD` is unrelated to the
  diff, the exact `git diff <base>...<head>` that _is_ the diff, that it cannot
  write, and the PR number when there is one. Nothing else — no CI or PR state,
  no counts, no file list, no diff. Capy still never sends a message: the
  orientation is a system-prompt fragment, so it never appears as a turn in the
  conversation and never becomes the session's name in the sidebar.
- **Review companion: "What this session was told".** A scroll icon in the
  companion pane's header opens the orientation verbatim. It is invisible by
  design, and a reviewer who cannot check what its reader was primed with is
  trusting a black box.

- **Review pane: mark a file as read, synced with GitHub's own viewed state
  (T243).** Each file header carries a checkbox. Click it and the file collapses
  and stays marked — reopen the pane a day later and it is still where you left
  off. When the branch has a pull request, the mark is GitHub's own per-file
  `Viewed` state, read and written through the API, so a review started in Capy
  and finished in the browser keeps its place, and one started in the browser
  arrives here already marked. GitHub wins whenever a pull request is known: a
  local mark is a write waiting to be pushed, never a competing opinion.
  `DISMISSED` — GitHub clearing the mark because the file changed after you read
  it — renders as its own state (`changed since you read it`), never as merely
  unread. With no PR, no remote or no `gh`, the mark is local and works exactly
  the same, and it invalidates **per file** on that file's content changing, so
  a commit elsewhere in the branch costs you nothing. A mark that could not
  reach GitHub says so and shows as unsynced rather than silently claiming to
  have synced. A sensitive file is never collapsed or dimmed by having been
  read, and there is deliberately no "all files viewed" badge or `n/m` count.

- **Review pane: "Ask a fresh session".** A button in the review pane's header
  opens a Claude session in the split beside the diff, so "what breaks if this
  ships?" is a question you can ask without leaving the review. It is always a
  fresh session, never the one that wrote the branch — a session reviewing its
  own code finds fewer bugs, and when you are reviewing someone else's PR an
  author session does not exist at all. The session starts read-only (plan mode,
  with the file-editing tools denied) so a mid-review "fix that for me" cannot
  change the code under the diff you are reading; **Promote** in the pane header
  hands the same conversation to a full working session and closes the review in
  the same gesture (greyed out until you have actually asked the session
  something — before that there is no conversation to hand over). Capy never sends it an opening message — no summary, no
  verdict — and nothing it says renders as evidence. The pane closes with the
  review and never reappears on a later app start.

- **Review someone else's PR without checking it out (T246).** `Review branch`
  on a PR Stack card now works for every PR in the canvas, not only for the ones
  already checked out in a worktree. When nothing local holds the branch, Capy
  reads the pull request's own head from GitHub (`refs/pull/<number>/head`,
  which exists for fork and same-repo PRs alike) and diffs it read-only — no
  worktree, no checkout, no dependencies. Reading someone's PR should not cost
  you a working tree.
- **A `head` receipt that says whether you are reading the current head.**
  `current` or `moved`, compared against the PR's own head SHA — a boolean, not
  an age, because "this commit is 3 days old" describes the code rather than
  your copy of it. When there is no head SHA to compare against, the strip falls
  back to `fetched 3h`, and says plainly when it knows neither. There is no
  green "up to date" badge.
- **Three explicit states for "there is no diff, and here is why":** the head
  has not been fetched yet (with a one-click `Fetch this head`), the fetch
  failed, and the PR's base does not exist in this clone. Previously all three
  would have rendered as `0 commits` — indistinguishable from a branch with
  nothing on it, which is how an unread PR gets closed as empty.

### Changed

- **The review pane takes the base from the pull request**, not from the repo's
  default branch, whenever a PR is known for the branch under review. A stacked
  PR diffed against `main` shows its parent branch's commits as its own. When
  the PR's base cannot be resolved locally the pane now refuses to draw a diff
  and says why, rather than quietly falling back.
- **Opening the review pane still performs no network call.** Fetching happens
  only on the explicit refresh gesture (or the `Fetch this head` button), which
  now also forces past the GitHub CLI cache.

### Fixed

- **The review pane's diff now scrolls sideways as one column instead of one
  line at a time (BUG-92).** Every long line used to be its own independent
  horizontal scroller, so scrolling one line left its neighbours behind — a long
  line could never be read beside its context, and a scrollbar would appear in
  the middle of a file attached to a single row. Each file box now has one
  shared horizontal scroller, and the line-number gutter stays pinned on the
  left while the code slides under it.
- **The review pane's scrollbars follow the theme.** Its diff body, the diff's
  horizontal scroller, the intent rail and the bounce note were the last
  surfaces in the app still drawing the operating system's default scrollbar.
- **"Ask a fresh session" no longer goes silently inert once a companion is
  already running (BUG-94).** Clicking it a second time used to do nothing at
  all — no new pane, no reveal, no toast, no error — because the companion is
  deliberately one per worktree and the click's return value was discarded. It
  now brings the running companion into focus instead.
- **The button is disabled while the branch is still loading or failed to
  load, with a hover reason (BUG-94).** Clicking it in that window used to
  spawn a companion with no review context at all, which started running
  `git status` on its own — the exact defect this pane exists to not have,
  reachable purely by timing.
- **Removed `reviewFolderPath` from the review companion pane (BUG-94).** The
  field was read by no code anywhere and its doc comment claimed a
  capability — telling one review's companion apart from another's — that the
  rest of the design makes structurally unreachable. `cwd` already carries the
  value that mattered.
- **Sidebar search field overlapped the macOS window controls.** With the
  `hiddenInset` title bar the renderer paints behind the traffic lights, and
  activating the sidebar filter expanded the input full-width into that corner —
  the typed text sat under the buttons. Whichever header reaches the top-left
  corner (the sidebar header always, the topbar header while the sidebar is
  collapsed) now reserves a 78px left inset on macOS so its content clears the
  window controls.

## 2026-08-26

### Added

- **Capy can speak.** A voice engine turns a string into audio through a text-to-speech
  command you already have on your machine (`speak-notify` by default, configurable).
  Utterances are queued rather than mixed, so two sessions asking to be heard at the same
  time take turns instead of talking over each other, and a single mute silences what is
  playing and drops everything waiting behind it. If the command is missing the engine says
  so through its own state and stays quiet — it never breaks the turn that asked for it.
  Speech is a third notification channel, next to the chime and the OS notification, not a
  replacement for either, and it is off until you turn it on. It inherits the "only speak
  what you cannot see" rule: a session speaking on its own initiative stays quiet for the
  session you are already looking at, while anything you asked to have read to you is read
  regardless. The Voice settings pane and the `speak` verb that let you reach it land next.

### Changed

- **The espeak-ng licence question now has a written answer to decide from.**
  [`docs/adr/0012`](docs/adr/0012-espeak-ng-gpl-exposure-in-a-bundled-kokoro-backend.md)
  records what a bundled offline voice would cost: `kokoro-js` is Apache-2.0, but it pulls
  in a phonemizer that ships GPLv3 espeak-ng inside an Apache-2.0 wrapper. The ADR lays out
  the options and recommends one; the call is the operator's, and the shipped
  system-command engine is unaffected either way.
- **A mission's goal file is now tied to the orchestrator session, not to the
  folder.** `mission` used to keep one `.capy/GOAL.md` per repo, so two
  orchestrations started from the same checkout — the normal case for a mother
  folder that fans work out into worktrees — silently overwrote each other's
  thread. The state now lives at `.capy/goals/<session>-<slug>.md`, one file per
  orchestrator session: a session resolves its own id, writes only its own file,
  and is told in as many words never to edit another orchestrator's. `status`
  reads every file in the directory and renders one front per mission instead of
  one contradictory card. A pre-existing `.capy/GOAL.md` still counts as a front
  and can be adopted, so nothing in flight is lost.

### Fixed

- **Enter on a folder row now opens the folder's view.** Clicking a folder opened
  it, but pressing Enter on one via the sidebar's arrow-key navigation only
  expanded or collapsed the row — so the Folder View was unreachable without a
  mouse. Enter now does exactly what a click does: it selects the folder and
  expands it, and a second Enter collapses it while keeping the view open.
- **Folder actions no longer require a selected session.** Roadmap board, PR
  Stack, Browse files, Open in VS Code, Open folder and the folder terminal all
  act on a folder, but the Topbar only offered them while a session was
  selected — so a folder with no sessions was a dead end and you had to start a
  session just to open its board. They now act on whichever folder you have
  selected. The Roadmap and PR Stack buttons also light up correctly for a
  selected folder, not only for a selected session.
- **Topbar couldn't be used to move the window or double-click-to-zoom on
  macOS.** The window uses a `hiddenInset` title bar, which draws no native
  drag strip of its own — the renderer has to opt a region in via
  `-webkit-app-region: drag`, and nothing did. The Topbar is now a drag
  region, restoring both window-drag and double-click-to-zoom from the top
  bar; only the interactive controls inside it (the sidebar toggle, the
  editable session-title text itself, the right-side action buttons) are
  carved out as `no-drag` so they stay clickable — the rest of the Topbar,
  including the empty space around the title, remains a usable drag surface.

## 2026-08-25

### Changed

- **A dispatched session no longer reviews and ships its own work.**
  `orchestrate-delivery`'s delegation packet now ends the executor's run once its
  commits are pushed and the tree is clean, and forbids it from running the PR
  pipeline in its own session: it spawns a fresh session in the same worktree to
  run review → PR → reviewers, so the review reads the diff cold instead of
  re-reading the implementer's own justifications. The monitoring tick gained a
  backstop that dispatches the shipper itself when a unit has pushed commits and
  no PR.

- **Dispatched sessions must now look at what they rendered.** A unit that changes
  rendered UI carries a visual-proof step in its delegation packet: start the app,
  open every affected route with the Chrome tools, and attach the capture to the
  card before reporting done. `delivery-verifier` enforces the other half — an
  acceptance criterion about something visible can no longer be graded `met` from a
  code-reading argument; with no screenshot in evidence the verdict is `unmet`
  ("nobody looked"). This is the class of defect where the diff reads correctly, the
  build and tests are green, and the page is visibly broken.

- **The `status` glance card was redesigned for readability and color.** The six
  markers became a three-column layout — a blank gutter, a left-aligned label
  column (`Running`, `Done`, `Next`, `Needs you`, `Open`), then the value — and
  progress bars are now blocks in brackets (`[██░░░] 2/5`). Color lives only in
  the gutter, which is empty by default: 🟢 / 🔵 / 🟡 / 🔴 on the front header for
  its state, ⏳ on `Running` when the executor goes stale, and a red 🚩 on
  `Needs you` only when something is actually owed. A healthy front with nothing
  owed shows exactly one emoji. Identifiers — PR numbers, card ids, session ids,
  branches, flags — are written as code spans so the terminal renders them in the
  accent color. The gutter is droppable: written to a file or a commit message
  without emoji, the card still reads.

### Fixed

- **A dispatched session that finishes booting no longer lingers as a phantom
  spawn in the fleet.** `get_fleet`/`get_session` could keep listing a
  `create_session` dispatch as still-in-flight for up to an hour after it
  actually materialized — the eviction only fired as a side effect of a later
  fleet read, so a session nobody happened to re-poll for stayed a ghost entry
  until the 60-minute backstop caught up. The in-flight registry now evicts the
  entry (and releases its reservation) the instant the session reports it has
  materialized, including the case where the original `create_session` call had
  already timed out.

- **Fleet rail no longer accumulates label-less "Untitled session" ghost rows.**
  When a synthetic placeholder migrated to its real session in place (a
  "+ New session" landing, or an MCP `create_session`), the row kept its
  blank disk identity — no path, summary, first prompt, or message count —
  until some later, unrelated reload happened to fix it, and could stay
  permanently "Untitled" and stuck at the top of the rail if that reload
  never placed it correctly. The row now backfills its real name the moment
  it migrates, and a migration the reader can never place on disk is dropped
  instead of resurrected on every reload.

- **"Open in VS Code" (Topbar) silently did nothing on macOS.** The button
  spawned the `code` CLI relying on plain `PATH` lookup, but a macOS app
  launched from Finder/Dock/Spotlight doesn't inherit PATH additions a user
  only made in their shell profile — and a `code` that "works" in a terminal
  is sometimes just a shell alias, invisible to a non-shell spawn. Capy now
  also tries the well-known install locations (`/usr/local/bin/code`,
  `/opt/homebrew/bin/code`, the VS Code / VS Code Insiders `.app` bundle's own
  CLI script) before giving up, and shows a toast with next steps if VS Code
  still can't be found, instead of failing silently.

- **Cleanup: the Sweep button no longer disappears after the first sweep.** Reopening
  the sweep confirm dialog showed it already finished — every item pre-ticked green and
  only a **Close** button — because it read the previous run's per-item progress, which
  outlives the dialog. Each dialog now starts armed regardless of what the last sweep
  left behind.

## 2026-08-24

### Added

- **A session's deliverable now lands _on_ the board, not next to it.** A
  generated PNG or SVG becomes a real image node you can drag, and the
  `capy/mockup-card` shape draws as a live **card** — a titled panel with an
  optional subtitle, a status pill and a body paragraph, in Capy's own type and
  colours. It is drawn by Capy rather than pasted in as a picture, so it
  recolours with the app when you switch theme, and you can move, resize,
  connect, rename, delete and undo it like any other node. Capy tints the status
  pill for words it recognises (green for _done_/_ready_/_shipped_/_ok_/_passed_,
  amber for _wip_/_in progress_/_review_/_pending_, red for
  _blocked_/_failed_/_error_) and shows anything else plainly rather than
  dropping it. A session writes a shape **name** and plain text fields — never
  markup — so a card can only ever be a card, whatever the text inside it says.
  See [Canvas pane](docs/user/canvas.md#when-the-agent-draws).

- **Paste a screenshot straight onto a canvas.** Paste (**Ctrl/⌘ + V**) or drag
  an image file onto a canvas pane and it becomes an image node. The picture
  itself is copied into an `assets/` folder next to the canvas and the board
  keeps only a short pointer to it — so a board with three screenshots on it is
  still a few kilobytes of file, and saving does not rewrite megabytes every
  time. Capy names the copies, so a second paste never lands on top of the
  first, and an over-size or non-image paste is refused whole rather than
  half-written.

- **A session can draw you a diagram, and you can draw back.** New agent
  capability `draw_canvas`: a session builds a picture — an architecture map, a
  flow, a dependency graph, a plan in boxes — on a canvas that opens in a pane
  beside it, where you move, rename, connect and delete shapes and hit Save. The
  board records who drew each element, so a session's "redraw my diagram" only
  clears its own work and leaves your boxes and notes intact, and after you edit
  and save it can read the board back and tell exactly what you changed. It
  cannot claim your work as its own — supplying an operator stamp is refused
  outright. Drawing lands all-or-nothing: if one edit in a batch is wrong the
  file is left byte-identical, so you never open a half-drawn board. Deleting a
  box also removes the arrows attached to it. By default it draws on the
  worktree's own gitignored board and opens the pane for you; a session can ask
  for `docs/canvas/` instead when the diagram is a deliverable that should travel
  with the branch. Screenshots go beside the canvas in an `assets/` folder rather
  than inside it, so a board with images on it stays small. See
  [Agent control](docs/user/agent-control.md).

- **An agent handing you a canvas now opens the canvas.** When a session opens a
  `*.capycanvas.json` with `open_file`, it lands in the canvas pane instead of
  the text viewer — in the background, badged as unseen, exactly like any other
  file an agent opens. The routing is on the whole `.capycanvas.json` ending, so
  every ordinary `.json` file (`package.json`, `tsconfig.json`) keeps opening as
  plain text; a board that is broken still opens **in the canvas pane** and says
  what is wrong with it rather than quietly falling back to raw JSON. See
  [Canvas pane](docs/user/canvas.md).

- **Manual update fallback for macOS/Windows.** Unsigned macOS and Windows
  builds can't have an update applied silently by the OS (Gatekeeper /
  Squirrel refuse it), so those platforms previously gave zero in-app signal
  that a new version existed. Capy now shows a sticky "Update available"
  toast with a "Download update" action that opens the version-specific
  GitHub release page in your browser — one click to the right download
  instead of hunting for it manually. Linux AppImage's existing silent
  auto-update-and-restart flow is unchanged.

### Fixed

- An image node that does not state its own size now draws at an image's
  footprint (240x160) instead of a box's (132x52), so a board written by hand —
  or by an older build — no longer letterboxes its pictures. A session's images
  were already sized correctly.

### Changed

- **Clicking a folder now opens its view.** A folder click used to only expand
  the row — which looked like nothing at all for a folder with no sessions.
  Clicking one now opens the folder's home screen in the main pane: git status,
  where you left off, its sessions (with Older and Archived as expandable
  sections instead of hover-only peek icons), a roadmap summary naming what's in
  progress and in review, this repo's other worktrees, and a New session button.
  The first click still expands the row; a second one only collapses it, and the
  view stays open. Selecting a folder never stops a running session.
- **`orchestrate-delivery` is stricter about dispatching instead of asking.** The
  bundled skill now states that authorization to orchestrate is authorization to
  dispatch: a unit whose dependencies are satisfied is dispatched on the tick that
  discovers it, units born mid-delivery (splits, deferred fixes, reviewer
  follow-ups) go through the same card → packet → manifest pipeline as planned
  ones, and a report that hands the operator work the orchestrator could have
  started itself is treated as a defect. It also arms its own monitoring loop over
  `mission` rather than waiting to be asked how things are going.

### Fixed

- **Folder actions no longer require a selected session.** Roadmap board, PR
  Stack, Browse files, Open in VS Code, Open folder and the folder terminal all
  act on a folder, but the Topbar only offered them while a session was
  selected — so a folder with no sessions was a dead end and you had to start a
  session just to open its board. They now act on whichever folder you have
  selected. The Roadmap and PR Stack buttons also light up correctly for a
  selected folder, not only for a selected session.

- An image node that does not state its own size now draws at an image's
  footprint (240x160) instead of a box's (132x52), so a board written by hand —
  or by an older build — no longer letterboxes its pictures. A session's images
  were already sized correctly.

## 2026-08-23

### Added

- **You can draw on a canvas now, and save it.** The canvas pane became an
  editor: **drag** on empty board to draw a box (it opens with its name field
  ready — just type), **double-click** to rename, **hover a box and drag from
  one of its dots** to connect it to another with an arrow that stays attached
  and routes itself around whatever is in the way. **Shift-drag** selects a
  group, handles resize, **Delete** removes, **Ctrl/⌘ + Z** undoes and
  **Ctrl/⌘ + D** duplicates. Panning moved to a **right-drag** so the plain drag
  could draw. Nothing touches the file until you press **Save** (or
  **Ctrl/⌘ + S**) — an accent dot next to the filename shows when you have
  unsaved work, closing a dirty canvas asks before discarding it, and if the
  file changes on disk while you are mid-edit the pane refuses to clobber you:
  it raises a _changed on disk_ strip and lets you choose. A save that is
  refused leaves the file exactly as it was. Everything you draw is recorded as
  yours rather than the agent's — including a copy you make of one of its boxes.
  See [Canvas pane](docs/user/canvas.md).

- **Canvas pane — a whiteboard that lives in your worktree, and Capy now draws
  it.** A `*.capycanvas.json` file opens in a new pane beside the terminal
  instead of as raw JSON: click the **eye** icon on its row in **Browse files**.
  The board renders its boxes, text annotations, images and routed arrows in
  your current theme, with a dotted grid, drag-to-pan, ⌘/Ctrl-scroll zoom and a
  floating Fit / zoom cluster. It follows the file — edit the canvas on disk and
  the pane redraws immediately **without moving your view** — and it recolours
  live when you switch theme, with no reload. A canvas that is malformed, too
  large, or written by a newer Capy is refused with a readable reason rather
  than half-drawn. No agent can draw on one yet. See
  [Canvas pane](docs/user/canvas.md).

- **Canvas files (groundwork — no UI yet).** Capy now understands a new kind of
  file inside a worktree: a canvas document named `<name>.capycanvas.json`,
  defaulting to `.capy/out/canvas/board.capycanvas.json`. It is a per-worktree,
  gitignored scratch board rather than a repo-wide one, it is plain JSON with a
  stable key order (so re-saving an unchanged board produces an empty diff), and
  every node and edge in it records whether you or the agent created it. **The
  pane that draws and edits these files is not built yet** — this change ships
  only the file format and the reader, writer and on-disk watcher behind it, so
  a `.capycanvas.json` still opens as ordinary text for now. See
  [Folders and worktrees](docs/user/folders-and-worktrees.md).

- **Sessions can message each other, through a door Capy records.** A session can
  now send a short message straight into another Capy session's Claude Code
  inbox: Capy resolves the session id to the exact process, so there is no name
  guessing, and the message waits for the recipient to finish its turn instead of
  interrupting it. Every message sent **through Capy** lands in the audit log and
  posts a row in your Activity history — Capy cannot see traffic that does not go
  through it (sessions can always reach each other directly), so this is one
  recorded door, not the only door. The reachable set is deliberately narrow:
  only sessions Capy started **for an agent**, in a folder you have not blocked.
  A session **you** opened, a `claude` in your own terminal, a teammate pane and
  a cold transcript are all refused — an agent cannot put words in front of you
  in your own session. A **parked** recipient is woken first, in the background,
  without moving your view, and that wake is recorded as agent-driven rather than
  as one of your clicks; if the resume does not land in time the message is not
  sent rather than quietly dropped, and Capy never starts a process to force a
  delivery. The sender is told the message was **queued**, never "delivered" —
  Capy has no way to hear back what the recipient did with it, and says so.

- **`get_fleet` / `get_session` now report a session's peer address.** A session
  with a running Capy-owned process reports the process id and the socket it is
  listening on, which makes "which session is which process" answerable instead
  of a guess. Its absence means "not reachable right now", not "that session is
  dead".

- **`status` bundled skill.** A fifth skill in **Settings → Skills**: renders a
  fixed six-line "glance card" — progress bars, what's running now, what's done,
  what's next, what needs you, and open questions — built from the board, the
  mission file and open PRs, never from memory. It's also the mandatory header
  of `mission`'s tick report, `orchestrate-delivery`'s final output, and
  `delivery-verifier`'s Delivery Report. Off by default, like every other
  bundled skill — nothing reaches your sessions until you turn it on.

## 2026-08-22

### Added

- **Daily budget.** The usage popover in the footer has a new **Today** row — `9% / 17%` —
  that splits what is left of your weekly (7-day) allowance across the working days you
  still have before it resets. It is worked out once, from where the 7-day figure stood
  when the day began, and then held fixed for the rest of the day, so the bar can actually
  reach 100% instead of quietly stretching to fit whatever you spend. Nothing is ever
  blocked: going over simply means the days after today inherit a smaller share, and the
  row says so — `over · next 3 days drop to 12%/day`. On a day off it shows what you spent
  with no bar and no budget attached.

- **Working days (Settings → Usage history).** A seven-button Mon–Sun row picks which days
  the allowance is split across — **Mon–Sat** by default — with a live readout of what the
  current selection buys you today. Untick every day and the feature switches off: the
  Today row disappears from the popover.

- **Daily budget alerts (Settings → General).** A notification at 80% of the day's budget,
  while it is still correctable, and another at 100%. At most twice a day, on by default,
  and remembered across restarts so relaunching Capy mid-afternoon does not replay an
  alert you already saw.

- **Bundled skills.** Capy now ships its own skills and gives each one an on/off
  switch in **Settings → Skills**: `orchestrate-delivery` (break an objective into
  board cards, dispatch a session per unit, hand back a delivery report),
  `delivery-verifier` (grade a finished unit's acceptance criteria from repo
  evidence), `mission` (one coordination tick over dispatched work) and `conductor`
  (drive the fleet through the `capy` MCP verbs). Every skill is **off on a fresh
  install** — nothing reaches your sessions until you turn it on. A skill that is on
  is handed to the next session Capy starts in that folder; a skill that is off is
  never copied, so it is genuinely absent from the session's list rather than just
  discouraged.

- **Per-project skill overrides.** The Skills panel has a Global / this-project scope
  switch. A project's explicit On or Off beats the global setting in both directions,
  and **nothing is written into your repository** to express it — no config file, no
  gitignored file, no `.claude/` directory; `git status` stays clean.

- **Coexistence with your own skills.** Capy's skills arrive namespaced (`capy:mission`
  alongside your own `mission`), so a personal skill of the same name is never
  shadowed, renamed or removed. The panel flags a row when the name collides so the
  duplicate is not a surprise.

- **"Also outside Capy" (opt-in, per skill).** An Advanced switch installs a bundled
  skill into `~/.claude/skills/` so your own terminal sessions see it too. Default off,
  and it refuses to overwrite a skill folder Capy did not create.

### Fixed

- **A brand-new session could not use the bundled skills you had switched on.** Any
  session Capy started fresh in a folder with a pre-prompt silently launched without
  its `capy:` skills — invoking one answered `Unknown skill: capy:mission` even though
  the panel showed it on and the files were staged correctly. Resuming a session in
  the same folder worked, which is what made it look like the feature worked at all.
  The launch command put the skills directory (and Capy's per-session notification
  settings) _after_ the marker that ends the option list, so the CLI read both as
  extra prompt text instead of as settings. Every option is now emitted before that
  marker, on every launch path.

- **Freshly started sessions rang their own notifications.** The same swallowed
  settings carried the "let Capy own notifications" preference, so a new session fell
  back to notifying you itself — a second alert alongside Capy's. Fixed by the same
  change. Fleet state was unaffected: the observer hooks Capy installs system-wide
  were still delivering those events.

## 2026-08-12

### Added

- **PR Stack cards now jump straight to the branch's worktree.** When Capy
  manages a worktree checked out on a PR's branch, a small house button appears
  on the card's branch line — one click reveals that folder in the sidebar, no
  need to expand the card first. A pulsing green dot on the button means a
  session is live in it. The card drawer's `worktree` row and `Open worktree`
  button now fill in too; until now they never appeared at all.

### Changed

- **Clicking a PR Stack card's branch name now opens the pull request**, not the
  branch's tree page on GitHub. The card is a PR, so its one link goes to the PR;
  the branch name itself is still one click away through the copy button beside
  it.

### Fixed

- **Every button on a PR Stack card was dead.** Opening the branch on GitHub,
  copying the branch name, expanding the card, `Open on GitHub` and the
  `gh pr edit` copy button all did nothing: the card-drag handler captured the
  pointer, which made the browser fire the click on the canvas instead of on the
  button. Card controls now get their clicks; cards are still draggable by their
  body.

## 2026-08-11

### Changed

- **The buttons that open a full-pane view now close it too.** The Topbar's
  **Roadmap board** and **PR Stack** buttons, the footer's **Cleanup** pill, and
  the footer's **heap gauge** are toggles: click once to open the view, click the
  same button again to go back to your session — no hunting for the header `X`.
  While a view is open its button is highlighted in accent, so you can see which
  one you're in. Clicking the button for a _different_ repo still switches repos
  rather than closing.

- **Clicking a session closes whatever view is open.** Picking a session — from
  the sidebar, the command palette, an approval row, or a board card — now means
  "show me that session": the Roadmap board, PR Stack, Cleanup, Usage Dashboard,
  or System Monitor gets out of the way instead of staying on top of it.

### Fixed

- **Esc now closes the PR Stack Canvas.** It closed every other full-pane view
  but that one, which had to be dismissed from its header `X`.

## 2026-08-05

### Added

- **Paste a ticket title into the New worktree dialog and get a branch name.**
  Type or paste something like `ACME-10996 Report Export Date Range Filter` in
  the Branch field and a strip appears under it suggesting
  `acme-10996-report-export-date-range-filter` — click **Apply** and the field
  is rewritten. The strip only shows up when the name would actually change, and
  disappears once you apply it. Open its **options** to set a **prefix** (`feature/`),
  choose whether that prefix is slugified too (`feature/acme-…` vs `feature-acme-…`),
  and whether the original capitalization is preserved
  (`ACME-10996-Report-Export-…`). The three settings are remembered between
  worktrees.

## 2026-08-03

### Added

- **The branch name on a PR Stack card is now a link.** Click it to open that
  branch on GitHub (`/tree/<branch>`); hover the line and a copy button appears
  at its right edge that copies the raw branch name for a local `git checkout`,
  confirming with a toast. The URL is derived from the pull request Capy already
  holds — no extra GitHub call — and on an unrecognizable URL the name simply
  stays plain text instead of becoming a link that 404s.

- **Roadmap board and PR Stack are one click away in the topbar.** Both per-repo
  views used to need a right-click on the correct sidebar folder first; they now
  also have buttons in the topbar's right-hand row (kanban and pull-request
  icons), acting on the selected session's repo.

- **PR Stack refresh is now yours to set** (Settings → PR Stack). While the
  canvas is open it re-reads GitHub on its own clock — separate from the hourly
  background scan, because readiness rots faster than debris does. Choose 30s,
  90s (default), 5min or 10min, or switch it off entirely and keep the Refresh
  button as the only way to fetch. Each tick is one `gh` call per open repo, so
  the choice is a real trade-off rather than a hidden constant. Changing it
  takes effect on the canvas behind the dialog immediately.

- **PR Stack — see which pull request merges into which.** A new main-pane view
  (folder menu → **PR Stack**) draws the merge chain of a repo's open PRs on an
  infinite canvas, so you stop opening PRs one at a time just to read the base
  branch out of the header. Each chain is a column, bottom-aligned and growing
  upward, so stack depth reads as column height. Two markers answer the
  questions GitHub answers nowhere: **staging tip** (the leaf of a chain, with a
  `carries N` count — deploy that branch and you test the whole stack at once)
  and **merge next** (the base-most PR that is green, approved and already
  targeting the default branch). They are opposite ends of the same chain.

- **The silent-retarget hazard is now visible.** When a PR's base branch is
  merged and deleted, GitHub quietly retargets the PR onto the default branch
  and the diff you review afterwards is not the diff you reviewed before. Those
  PRs are flagged amber, and the expanded card hands you the exact
  `gh pr edit N --base <branch>` command to copy. PR Stack never writes to
  GitHub itself.

- **Cards drag freely, and zoom sheds detail instead of pixels.** Move any card
  anywhere — edges stay anchored, so the arrow carries the chain and the graph
  can not be made to lie. Your arrangement is remembered per repo, untouched
  cards keep flowing with the automatic layout, and **Re-layout** puts
  everything back. Zooming out past 70% drops the branch line and chips, and
  past 45% collapses a card to a pill with its number and carry count, so a
  crowded canvas stays readable.

- **Finished worktrees leave the graph.** A worktree whose PR already merged is
  not part of any merge chain, so it drops into a harvest tray on the canvas
  floor with its size and a jump into Cleanup, which is where deleting still
  happens. Worktrees with no PR yet stay on the canvas as live work.

## 2026-08-02

### Fixed

- **`update_card`'s `replaceBody` now actually works (BUG-79).** The MCP verb
  advertised a `replaceBody` field for rewriting a card's whole body, but every
  call using only that field was rejected with a misleading "at least one of
  set/appendBody/replaceBody is required" error — the field WAS supplied, but
  the request-shaping layer between the tool call and the write handler
  silently dropped it before validation ever saw it. `appendBody`-only and
  `set`-only calls were unaffected; only `replaceBody`-only calls failed. The
  card-detail modal's own Edit mode (the human counterpart) was never affected
  — it writes through a separate IPC path that doesn't go through the same
  translation step.

## 2026-08-01

### Added

- **Pasted screenshots: the footer pill reacts, and the thumbnails open full
  size.** The `🖼 N` pill in the footer now gives a short pop (a ~300ms nudge
  with an accent flash) when a new screenshot actually lands in the session
  you're looking at — so a paste registers instead of the counter silently
  ticking up. It stays quiet where it would be noise: switching sessions never
  pops it, and neither does the first image, which already fades the pill in.
  Clicking a thumbnail in the popover now opens it in a full-window viewer
  instead of doing nothing: prev/next (wrapping in both directions, or the
  `←` / `→` keys), a thumbnail strip to jump straight to any image, and the
  same Open / Reveal in folder / Copy / Re-attach actions the grid already had,
  acting on whichever image you're looking at. Esc, a click outside, the close
  button, or Re-attach all take you straight back to the plain footer.

## 2026-07-31

### Added

- **Worktree lineage in the sidebar.** A repo with a fan-out history no longer
  shows a flat, unrelated-looking list of worktrees: a folder whose session cut
  other worktrees now shows a small fork badge with the live count, and those
  worktrees render indented one level beneath it with a guide line, so "3
  orchestrators, each with its own wave" reads at a glance instead of "12
  unrelated branches." The badge stays clickable to collapse/expand the group
  (the count never disappears, even collapsed), and the lineage is recorded
  automatically the moment an agent or the manifest dispatcher cuts a new
  worktree from an existing one. For worktrees that already exist, the folder's
  right-click menu gained "Set parent folder" (pick a sibling worktree of the
  same repo) and "Clear parent folder" to fix up the lineage by hand.

- **Roadmap board cards now show which worktree they came from and which one
  is executing them.** A card carries two distinct facts: where it was
  **born** (the origin branch, unchanged — already tracked) and where it is
  **executed** (the owner branch, new — stamped the moment a dispatch spawns,
  by both the per-card confirm and the manifest auto-drain, and never cleared
  by a later move to Review or Done). The board card face shows one branch
  chip with a clear precedence — the stamped owner (solid), else a
  best-effort guess from a matching local branch name (dashed, never saved),
  else the origin (solid) — and the card detail modal shows both as separate
  "Born in"/"Executed in" rows. A new **Worktree** dropdown in the filter bar
  scopes the board to cards born on a branch OR executed on it; opening the
  board from a worktree (not the main checkout) pre-selects that branch, one
  click away from "All worktrees". The scope is never persisted — it always
  resets on the next board open.

- Extensions can now contribute session **modes** (`contributes.modes`) — a
  distributable session contract the same way `Modes ▸ Learning` works,
  hot-reloaded with no app restart. Extension-contributed modes show a
  puzzle-piece origin badge in `Modes ▸` and in the session hover preview, so
  they're never mistaken for a built-in mode. A mode's Markdown doc is text
  only — it can never change permission flags or any other launch argument.

- The Fleet rail's **minimized strip now shows the whole fleet**. Instead of just an icon and a counter, the 44px strip stacks one minicard per active session, each carrying the same state ring as the full card and in the same priority order. Hover for the usual session preview, click to jump to it, right-click for its menu — so you can reclaim the width without losing the glance.

### Changed

- **Session state is now a ring badge on the card, not the card's border.** Each card carries a small ring on its left: a bright edge orbiting a faint circle while working, a breathing amber ring when it needs you, a broken red ring (two arcs with gaps) when it's stuck, a solid still red ring when it's errored, and a quiet green ring when it's done. It reads the same on hover, when selected, and in every theme — the old border ring's inner mask made it depend on the card's background color.

- **The rail no longer forces itself open when something arrives.** That behavior existed because minimizing used to hide the entire fleet; now that the strip keeps showing it, an automatic pop-open is just an interruption. If you put the rail away, it stays away until you bring it back. The sound, the system notification and the counter are unchanged — and clicking the notification still opens the rail, because that's you asking.

## 2026-07-30

### Changed

- **Sessions now hand you copyable output in a viewer pane instead of dumping it
  into the terminal.** When a session produces something you'd copy or keep — a
  drafted message, a PR description, a command to paste elsewhere, a longer code
  snippet, a report — it writes it to a file and opens it in a read-only pane,
  where every code block has a copy button and the toolbar has "Copy file".
  Explanations, answers, and status updates stay in the terminal as before, so
  the conversation doesn't get scattered into panes.

### Fixed

- Sessions were told the viewer pane only accepted `.md`, `.markdown` and `.txt`
  files — a leftover from before the pane learned to open any text file. A
  session that wanted to show you a `.json`, a `.sql`, a `.py` or a shell script
  would fall back to pasting it into the terminal instead. The description they
  read now matches what the pane actually does.

## 2026-07-29

### Changed

- The sidebar's drill-in button is now a three-level depth control instead of an on/off toggle. Click it once to drill into a repo group and then work inside it with the folders expanded inline, exactly like the classic tree; click again for the full one-screen-at-a-time navigation; a third click returns to the classic tree. If you already had drill-in on, you keep the behavior you had. Collapse all is available again at the first level.

## 2026-07-28

### Changed

- **Folders now group under their direct parent directory, not under whatever
  pinned folder happens to sit above them.** Two or more folders living directly
  inside the same directory collapse under one group header named after that
  directory — even when the directory itself isn't pinned. Pin `~/work/api` and
  `~/work/web` and they gather under a `work` header, the same way a repo's
  worktrees already gathered under a repo header. Repo grouping is unchanged.

- **Pinning a broad folder no longer swallows the whole sidebar.** The old rule
  nested a folder under its _shallowest_ visible ancestor, so pinning something
  like your home directory pulled every non-repo folder beneath it — at any
  depth — into one flat pile under a single row. Grouping now only ever uses the
  direct parent, so a broad pin gathers its immediate children and nothing else.
  The list is still capped at one level deep; a group never contains a group.

- **Non-git folder groups are reachable in drill-in mode.** Previously a folder
  nested under another pinned folder was listed nowhere in the drill-in
  navigator — only the classic tree showed it. Sibling groups now drill exactly
  like repo groups do.

- **Group headers read "Rename group" instead of "Rename repo".** The rename and
  reset actions work on both kinds of group; **Cleanup…** stays repo-only, since
  a parent-directory group has no shared git history to sweep. Collapse state and
  custom group names you'd already set are carried over.

### Fixed

- **Waking a parked session no longer re-runs the prompt it was started with.**
  A session dispatched with a starting prompt kept that prompt attached to it
  forever, so every time it was relaunched — woken from hibernation, or just
  closed and reopened — Claude received the original instruction again on top of
  the conversation it had already had, and started the whole task over. The
  starting prompt is now delivered once, at launch; a resumed session picks up
  its conversation exactly like any other.

- **Terminal rows now line up under their folder instead of hanging to the
  left.** A folder's terminals were missing the leading slot every session row
  reserves, so their names started further left than the sessions right above
  them — in Compact density they even sat left of the folder names, reading as
  siblings of the folder rather than as something inside it. Terminal rows and
  the `TERMINALS` label now share the same label column as the folder's
  sessions.

- **Cleanup rows no longer identify a folder by a cut-off absolute path.**
  Hidden-folder candidates that live next to their repo instead of inside it
  (`~/w/org/proj-231` beside the repo `~/w/org/www` — the usual worktree layout)
  were labelled with their full path, which the identity column truncated to an
  unreadable `/home/user/Workspace/org/pr…`, identical for every row. They now
  show the folder's own name, and hovering any row in Cleanup or in the sweep
  confirm dialog reveals the complete path in a tooltip.

## 2026-07-27

### Fixed

- **Capy's own background checks no longer show up as sessions — or hijack the
  one you're in.** To read your plan usage and name new sessions, Capy runs the
  Claude CLI in the background from your home folder. Each of those runs leaves a
  transcript behind, and the sidebar was treating them as real sessions: rows
  kept appearing every ~90 seconds titled `<local-command-caveat>Caveat: The
messages below were generated…`. Worse, if one landed in the moment between
  starting a new session and that session's first line hitting disk, it could
  take over the new session's row — your conversation kept running but under a
  row with that name, while the correctly-titled row sat next to it looking dead.
  Background runs are now recognized and ignored, so neither can happen.

- **A session that starts with a slash command gets a real name again.** Its
  sidebar label used to be the "Caveat: The messages below were generated…"
  boilerplate; it now falls through to the actual first prompt, matching what
  every other session shows.

## 2026-07-23

### Added

- **A busy session going in circles now shows as `stuck`, not just a silent one.**
  Fleet cards used to only classify `stuck` from filesystem silence, so a
  session repeating the same failing command (or re-reading the same file)
  over and over stayed invisible — it kept touching its transcript on every
  retry, so the quiet timer never fired. A new zero-cost detector (no process
  spawn, no LLM call, no network) watches for tool calls whose targets it has
  already seen recently, with no edit between them, and folds that verdict
  into the same `stuck` state. A flagged card's second line now names what's
  repeating and how many times (e.g. "repeating Bash: npm test ×10"), and the
  hover preview shows the full tally (calls, distinct targets, top repeat)
  even for a session that isn't (yet) flagged.

- **Maximize/restore a helper-stack pane.** Every split pane's header (shell,
  Claude, teammate, markdown, memory, and explorer panes alike) now has a
  maximize button: click it to grow that pane to fill the split while the
  others collapse to a thin header-only strip (they keep running in the
  background — nothing stops). Click it again, or a different pane's
  maximize button, to restore the normal split or switch which pane is
  maximized.

- **Sidebar density preset (Settings → SIDEBAR → Density).** A new
  **Comfortable** / **Compact** toggle scales the sidebar's own row heights,
  the session-row gap, and the left indent of session rows — so you can trade
  breathing room for more sessions on screen and wider labels. Comfortable is
  the default; the choice persists across restarts. Nothing outside the
  sidebar changes.

### Changed

- **The "Live session pulse" toggle is gone from Settings.** It used to spawn a
  Haiku process per session, on every turn end and every 15s of work, to render
  a one-line "doing now" guess — but the guess went stale exactly when a
  session stopped, which is when you're actually looking at the card. The new
  stagnation detector (see above) took over that line with zero-cost,
  content-derived evidence instead, so the Haiku-generated pulse — the
  Settings toggle, the fleet card / hover-preview text, and the per-folder
  pause — has been removed. Session auto-naming, which shares the same
  Haiku substrate, is unaffected.

- **Dispatching a batch of Ready cards no longer waits on a confirm.** With
  "Ask before agent actions" off (the default) and the folder not blocked, an
  agent's `submit_manifest` call now stamps the named cards `approved` and
  lets them drain unattended, same as every other agent action — closing the
  one step where an overnight batch used to stall on a modal nobody was
  there to click. A shadow-log entry and a notification still mark every
  self-approved batch, so it stays visible after the fact. Turning "Ask
  before agent actions" ON still parks the full checklist confirm with
  partial-go, unchanged.

- **Session rows waste far less empty space on the left.** The indent that
  nests a session under its folder now aligns to the folder **icon** instead of
  the folder **label**, reclaiming ~20px of dead column for the session name.
  In drill-in mode the indent is smaller still (the back-row header already
  names the folder). Trailing count chips (subagents, teammates) no longer
  reserve a fixed column either — they overlay the end of the label on hover,
  so labels get the full row width instead of being crushed.

### Fixed

- **The status icon column in the sidebar no longer drifts row-to-row.** A
  6px status dot and an 11px icon (check / cloud / moon) were rendered without
  a fixed-width box, so a session's name started at a slightly different
  position depending on its status. Both now sit in a fixed, centered slot, so
  every label lines up. Teammate rows got the same fix.

- **The "Needs you" section of the Fleet rail now starts collapsed.** It used
  to default to open, competing for space with the Fleet bucket cards above
  it every time the rail was opened. It still never auto-collapses once you
  expand it, and still never hides while something is actually pending.

- **"Restart session" now appears for sessions that have already ended, not
  only ones still running.** Previously, once a session's process exited the
  menu item disappeared — even though reselecting the session's row does NOT
  actually respawn it (its terminal is reattached in a frozen, "[session
  ended]" state, not recreated). The only workaround was toggling "Enable
  remote control" to force a respawn. "Restart session" now shows for any
  real (non-synthetic) session that has ended, and spawns a fresh
  `claude --resume` in place.

- **Sidebar loading spinner now actually centers in the tree area.** The
  spinner added for the cold-boot folder scan (T180, 2026-07-22) was pinned
  near the top instead of vertically centered — its `flex-1` sizing class
  only works inside a flex container, and its parent (the scrollable tree
  area) isn't one. Switched to `h-full`, which sizes against the parent's
  real height regardless.

## 2026-07-22

### Added

- **Sidebar loading spinner on cold boot.** While Capy scans
  `~/.claude/projects/` for the first time — which can take a while on
  installs with many project folders — the sidebar now shows a spinner and
  "Loading folders…" instead of looking like there are simply no folders
  added yet.

- **Stagnation detector core (internal, not yet user-visible).** A new pure,
  LLM-free fold (`src/main/stall-detect.ts`) detects a session repeating the
  same tool targets with no mutation between them — the "noisy stall" the
  existing filesystem-silence-only `stuck` rule can't see — and is now
  computed as part of `deriveTranscriptTruth()`. Nothing renders from this
  yet; the Fleet board surface work lands in a follow-up card.

- **Extension SDK Phase 1 — themes and board templates from `~/.claude/capy-extensions/`.**
  Drop a `manifest.json` under `~/.claude/capy-extensions/<id>/` to install a pure-data
  extension — zero code execution, hot-reloaded within about a second, no app restart.
  This first phase covers two contribution kinds: `contributes.themes` (the full
  36-token contract — 20 UI colors + the 16-color terminal ANSI palette — validated
  strictly, so a broken theme is dropped rather than silently patched) shows up in
  Settings → Appearance in the same grid as the built-in themes, marked with a small
  puzzle-piece origin badge; uninstalling falls the active selection back to the
  default theme automatically. `contributes.boardTemplates` lets an extension override
  the delegation-packet template a new Roadmap card seeds from, for a given kind,
  falling back to Capy's bundled template if the extension's file goes missing. See
  [Extensions](docs/user/extensions.md).

### Fixed

- **Parking a session no longer reports it as completed or raises a
  notification.** Both the automatic hibernation sweep and the System
  Monitor's "Park now" killed the session's process without telling `pty:exit`
  that a park — not a real finish — was underway, so the exit was folded as a
  natural completion: a native "session completed" notification, a chime, and
  a title/dock badge, all for memory Capy reclaimed on the operator's behalf.
  Clicking that notification then resurrected the exact session it had just
  freed, with no trace a park had ever happened. `pty:exit` now carries the
  real reason (`'park'` vs `'natural'`); a park skips the completion state and
  the `[session ended]` scrollback line entirely, while every other consumer
  of that event (the pre-prompt injection gate, the prompt submitter) still
  gets its cancel signal exactly as before.

- **Parking a session from the System Monitor now frees its terminal and
  scrollback, like the automatic sweep.** The manual "Park now" action only
  flagged the session as parked without ever broadcasting it, so the
  renderer's xterm instance (and its full scrollback) was never disposed —
  Capy killed the process but kept the memory it was trying to free. Manual
  park now converges onto the exact same kill-flag-broadcast transaction the
  automatic sweep uses, so both paths leave byte-identical state.

- **A parked session can no longer be re-animated by a hook event that lands
  after the kill.** A `Stop`/`SessionEnd` POST in flight when a session was
  parked could arrive moments later and both re-notify and re-flip the row
  back to a "working"/"completed" state. Main now drops any hook event for a
  session it has already parked.

- **Drill-in sidebar mode no longer hides the "show older / archived
  sessions" actions.** The folder screen's back row only carried over the
  trailing `+` (new session) from the classic tree's folder row, dropping
  the `clock`/`archive` peek buttons — so a folder with older or archived
  sessions had no way to reveal them while drill-in was on. Both now sit
  next to the `+`, same as the classic tree.

## 2026-07-21

### Added

- **"Roadmap board" in the session context menu.** Right-clicking any session
  row now shows a "Roadmap board" entry (previously only available from the
  folder's right-click menu), opening the board scoped to that specific
  session's own folder — even when right-clicking a session that isn't the
  currently active one.

### Fixed

- **A session started fresh (or forked) is no longer immortal — hibernation now
  actually reclaims it.** `pty:rekey`, fired when a new/forked session's
  synthetic id migrates to its real transcript uuid, updated the session index
  but left the PTY record's own `sessionKey` and `kind` frozen at their
  spawn-time values. Every place that decides what's parkable, and every place
  the System Monitor reads a session's identity from, reads those two fields —
  so a migrated session stayed permanently mislabeled (`kind: 'claude-new'`,
  which hibernation treats as un-resumable) and permanently addressed by a
  session key nothing else recognized anymore. In practice this meant the vast
  majority of sessions — anything not opened cold from disk — never parked no
  matter how long they sat idle, the System Monitor showed them as
  `synthetic-<uuid>` forever with no "Park now" button, and their ✕ button did
  nothing. `pty:rekey` now promotes the record's `kind` to `claude-resume`
  (the transcript is on disk by the time this event fires) and moves its
  `sessionKey` in the same step the index moves.

- **A stuck agent session no longer reports `active` forever.** Live validation
  of a fan-out dispatch caught a session that booted cleanly, sat on a ready
  and empty composer, and never received its pre-prompt — `get_session`/
  `get_fleet` reported it as a healthy `active` session for the entire time it
  sat there, because that escalation only ever updated the app's own UI state
  and never reached the agent-facing side. A stuck session's failure now
  reaches there too, the same way a genuinely Claude-reported failure already
  does, so an orchestrator polling on a dispatch it just made can actually
  learn it needs to intervene instead of waiting on a session that will never
  finish.

- **An agent's pre-prompt is no longer pasted into an unknown idling prompt.**
  The safety check that decided "the terminal has gone quiet, it's safe to
  paste now" could not tell a genuinely ready chat composer apart from some
  other prompt idling for a keypress (a first-run trust dialog, a login
  screen) — both go quiet the same way. For a session where Capy's hook wiring
  is active, only a real "composer is ready" signal from Claude Code may
  trigger the paste now; if that signal never arrives, the prompt is held back
  and the session is flagged as failed to deliver, rather than risking the
  prompt landing somewhere it was never meant to go. A healthy session is
  unaffected — it still gets its prompt with no added delay. Sessions with
  Capy's hook wiring turned off keep today's behavior unchanged, since they
  have no such signal to wait for.

- `create_session` (and the roadmap board's manifest-drain dispatch) now
  deliver a starting prompt of ~8000 characters or fewer as a deterministic
  argument at launch, instead of pasting it into the terminal after boot. This
  removes the race condition behind a whole family of prior fixes
  (BUG-57/58/59/60/61/62/63/64/66/67, T172) for the common case: a session no
  longer needs to detect "is the composer ready yet?" to receive its prompt,
  because the prompt launches WITH it. Longer prompts still use the previous
  paste-based delivery, unchanged.

## 2026-07-20

### Added

- **`create_worktree` warns before you collide with your own earlier attempt.**
  The ACK now carries a non-blocking `existingWork` list when a local branch or
  worktree already embeds the same task's slug (e.g. a stale attempt from an
  earlier dispatch) — a heads-up, never a refusal, so a fresh attempt is still
  always possible.

### Changed

- **The agent pre-prompt injection path now records what actually happened to
  it.** Previously nothing recorded whether a queued pre-prompt was ever
  resolved, dequeued, or actually pasted into a session's terminal — a blind
  spot that made the 2026-07-20 orphaned-spawn incident's trigger undiagnosable
  after the fact. Each decision point (target resolved/failed, prompt
  dequeued, which of the three composer-readiness inputs fired the paste, the
  paste and submit writes, and a cancel on `pty:exit`) now lands in a
  renderer-side ledger keyed by session id, distinguishing a merely dequeued
  prompt from one that was truly injected, and surviving the synthetic→real id
  migration. Internal-only — no new UI, at no cost to a normal (promptless)
  session (T172, see `docs/adr/0007-injection-trail-is-an-in-memory-renderer-ledger.md`).

- **Orphaned teammate groups no longer render under a synthetic header.**
  When a team's lead session can't be found anywhere in the folder, its
  teammates used to show up under a synthetic "Team session-…" header row
  that had no context menu (no Archive, no Delete) and whose displayed count
  only reflected the sidebar's display window, not the group's real size on
  disk. The group is now hidden entirely, except a teammate that is the
  sidebar's currently selected session, which stays visible as a flat row so
  an open terminal never loses its sidebar row. A hidden-but-active orphan
  still surfaces through the Fleet rail, an independent read path (T168,
  supersedes T99 decision #1).

### Fixed

- **A failed `create_session` (or any mutating verb) no longer poisons its own
  retries for 10 minutes.** The idempotency registry that dedupes a retry of a
  timed-out mutating call treated a `failed` outcome the same as an `applied`
  one — cached and replayed for the full 10-minute idempotency window. An
  agent retrying a genuinely failed `create_session` with identical args got
  the same cached failure back every time, in a few milliseconds, without the
  server dispatching anything: the retry contract `docs/capy-features.md`
  advertises ("a real failure, safe to retry into the SAME folder") was false.
  Only `applied` (and still-`in-flight`) now dedupes; a `failed` entry lets an
  identical retry re-actuate for real, and the audit log now tells a genuine
  re-actuation (`re-actuate-after-failure`) apart from a cache hit
  (`duplicate-replay`).

- **The background manifest drain no longer leaves an orphan worktree when a
  spawn fails.** Dispatching a stamped `worktree`-substrate card through the
  background drain (not the roadmap board itself) used to cut the worktree,
  then — if the session spawn afterward failed — silently move on to the next
  card: the worktree stayed on disk, the failure reason was destroyed in a
  bare `catch { return null }`, and the card sat at `status: ready` forever
  with no toast, no log, no signal of any kind. The drain now rolls the
  worktree back with the same helper the board's own dispatch path uses
  (`rollbackWorktree`), keeps the real failure reason all the way out to the
  drain's result, and surfaces it in a dedicated toast so a stamped card that
  failed to dispatch is never silent. One failing card still never blocks the
  rest of the batch.

- **The background manifest drain no longer fails a `worktree`-substrate
  card's spawn on the first attempt.** The drain dispatches a session into a
  just-created worktree in the same tick `create_worktree` returns, but the
  renderer only learns about that folder through a fire-and-forget push
  debounced 250ms — so the dispatch's own folder lookup missed it on
  (effectively) every attempt, the exact race the manual board dispatch was
  fixed for earlier. The drain's spawn command now carries the worktree's
  adoption payload and the renderer registers it synchronously before
  dispatching, closing the same race for the background path.

- **The pre-prompt injection watchdog can now actually see the failure it
  exists to catch.** It used to treat "no longer in the queue" and "no live
  PTY" as proof of delivery — but the prompt is dequeued _before_ it's pasted,
  and the paste can still be held for up to 2.5s or dropped entirely if the
  session exits first. Two orphaned sessions from the 2026-07-20 incident sat
  blank forever while this watchdog reported them delivered. It now reads
  T172's injection ledger for the real "was it actually pasted?" signal
  instead of guessing from queue/PTY membership, so a consumed-but-never-
  pasted prompt escalates to a visible failure and a PTY that dies before
  injecting no longer reads as a false "delivered" — while a session that
  finishes its work normally still disarms cleanly, with no new false alarms.

- **The dead-synthetic reaper no longer goes blind the instant a PTY comes up
  live.** It used to treat a live PTY as unconditional proof a synthetic booted
  fine, so a session that spawned a perfectly live REPL but never got its
  queued pre-prompt delivered sat `working` forever — invisible both to this
  120s reaper and, whenever the injection watchdog above never got the chance
  to arm, to any other guard. The reaper now reads the same delivery signal
  (T172's injection ledger) as that watchdog on its live-PTY branch, and
  surfaces the genuinely-stuck case as a visible `prompt_undelivered` failure
  with the injection-retry recovery already built for it — reusing the
  escalation path that existed but was unreachable, not building a new one. A
  session with nothing queued (the common, promptless case) or one whose
  prompt was actually delivered is never touched.

- **Dispatching a card as a new worktree no longer fails on the first attempt,
  then poisons every retry.** Dispatching from the roadmap board used to check
  whether the freshly-created worktree's folder was known to Capy before the
  250ms background reload that actually registers it had a chance to run — a
  guaranteed miss, not a rare race — so the dispatch failed with a generic
  "Couldn't spawn the session." toast on the very first try. Because the
  worktree's path is deterministic per card, every retry after that collided
  with the orphaned worktree left behind and failed again with "Couldn't
  create the worktree for this card." The board now registers the folder
  directly from the worktree-creation response instead of waiting on that
  background reload, so the first attempt succeeds. A failure after the
  worktree is fully seeded now also rolls it back instead of leaving an
  orphan, and both the worktree-creation and session-dispatch failure paths
  now surface their real cause in the toast instead of a bare generic message.

- **Sidebar drill-in polish.** The back row at the top of a drilled-into
  screen was only clickable on its small back-arrow icon — the whole row is
  now the back button, matching every other sidebar row. A folder screen
  also had no way to start a new session (drill-in hides the classic tree's
  hover-revealed "+" for that reason) — a `+` action now sits on the back
  row itself. The toolbar's Collapse-all button showed the same static icon
  regardless of state; it now shows the icon for the action a click would
  actually perform (collapse vs. expand), and the Rescan button's icon now
  spins while a scan is in flight instead of giving no feedback at all. The
  Collapse-all button itself is now hidden while drill-in mode is on, since
  expand/collapse state is a classic-tree concept it has no effect on there.

- **macOS app icon now matches the Dock.** The macOS icon (`.icns`) was
  rendered full-bleed, so Capy looked noticeably larger than neighboring apps.
  It now follows the Apple icon grid — the rounded-square artwork occupies
  824×824 of the 1024×1024 canvas — and bakes in the template drop shadow that
  every other Mac icon carries (macOS doesn't add one at render time), so it
  reads the same size and depth as its neighbors. Linux and Windows icons stay
  full-bleed, per their conventions.

- **Usage Dashboard shows dashed/underscored project names correctly.** "Top
  projects" (and the project filter / explorer paths) derived the project name
  by decoding Claude's project-directory slug, which turns every `-` into `/` —
  so `expense-categorizer` showed up as just "categorizer". The cost engine now
  recovers the real path from each transcript's own `cwd` field and only falls
  back to the slug decode when a file carries none.

- **`create_session` no longer reports a healthy session as failed.** The
  synth→real correlation that lets `create_session`'s ACK confirm
  materialization was armed at dispatch time, while agent boots drain a
  serial queue — so under a fan-out the window routinely lapsed before a
  queued session even started booting, and its ACK timed out with
  `SPAWN_NOT_MATERIALIZED` even though the session came up fine (one
  incident case wrote its transcript 11 seconds before the deadline and
  still failed). The correlation now arms at the moment the PTY actually
  spawns, so queue depth ahead of a session no longer erodes its reporting
  window. The fallback migrate path also reports materialization now, so the
  signal no longer depends solely on the correlation surviving.

- **A `create_session` materialization timeout no longer leaves an orphaned,
  unattributed session running.** On a timeout, the spawned session used to
  be reported as a failure while its process, PTY, and sidebar row all kept
  running — so an agent's retry (with nothing else stopping it) could land a
  second process in the same working tree, exactly the collision the
  single-occupancy guard exists to prevent. The session is no longer torn
  down (a late materialization is healthy — the field has observed a
  ~14-minute tail), the ACK now carries the `syntheticId` so the caller can
  adopt or poll it, and the folder's reservation stays held until that spawn
  resolves — a retry into the same folder while it's unresolved is refused
  with `SESSION_ALREADY_IN_FLIGHT` instead of racing a second spawn in.

## 2026-07-19

### Added

- **Manual rescan.** A "Rescan folders" button in the sidebar toolbar forces
  a fresh disk scan and reconciles the sidebar — an escape hatch for the rare
  case where the background watcher misses something, without needing a full
  app restart.

- **`remove_folder` MCP verb.** Cleans up a "ghost" folder — one whose
  directory is already gone from disk but whose sidebar entry (and its now-broken
  session) lingers — by unpinning it and dropping it from the sidebar without an
  app restart. It only ever touches Capy's own bookkeeping: refuses with
  `DIRECTORY_STILL_EXISTS` if the directory is actually still there, and with
  `FOLDER_UNKNOWN` if the path isn't pinned, hidden, or known via session
  history. Never deletes a worktree, branch, or file.

- **Sidebar drill-in navigation (optional).** A new two-state icon in the
  sidebar toolbar switches between the classic always-expanded tree and a
  drill-in mode that navigates one screen at a time — root, then a repo's
  worktrees, then a folder's sessions — mobile-menu style. Off by default.
  Selecting a session anywhere (a notification, the command palette, the
  roadmap board) while drill-in is on automatically navigates to that
  session's screen.

- **The sidebar always reflects the selected session.** Previously only a
  handful of "jump to session" affordances (OS-notification clicks, the
  toast "Open" action) reliably expanded the right folder and repo-group and
  scrolled the row into view — selecting a session any other way could leave
  its row collapsed or off-screen. Now every selection path does this.

### Changed

- **The `stuck` fleet-card ring no longer marches — it holds still.** Direct
  operator feedback on the just-shipped ring rework: the slowly-marching red
  dashes read as messy rather than as "movement that goes nowhere". The ring
  now stays a static, broken red line — same dash pattern, animation removed
  — while `errored`'s ring stays a continuous, unbroken line, so the two red
  states remain distinguishable from the ring alone (BUG-51).

- **Sidebar toolbar.** The hidden `⋯` menu (Rescan folders +
  Expand/Collapse-all + Hidden folders) is replaced by four always-visible
  icon buttons in the same position: Rescan, the new drill-mode toggle,
  Collapse-all, and Hidden (with a folder-count badge).

### Fixed

- **Adopted folders no longer vanish under concurrent writes.** Two folder
  adoptions, renames, or setting toggles landing close together could race
  inside `projects.json`'s read-modify-write cycle — the second write would
  silently overwrite the first's change with no error anywhere, occasionally
  dropping a just-adopted worktree from the sidebar entirely. Every mutator
  now serializes through an in-process queue, so concurrent writes to the
  same file can no longer clobber each other.

- **A parked agent confirm now promotes to the modal the moment you come back.**
  Previously, a confirm that arrived while the window was unfocused stayed
  parked in the Approval Inbox forever, even after you returned and were
  looking right at the app — nothing routed it to the confirm modal, so the
  dispatched agent work stayed frozen until you happened to open the Inbox
  yourself. Now, on window focus regain, every still-pending parked confirm
  surfaces as the modal over whatever screen is active. The overlay also
  gains a **Dismiss** ("not now") button, distinct from Deny: it defers the
  confirm back to the Inbox without answering it — the confirm stays pending
  and its timeout is untouched — and won't re-promote on the very next focus
  event, only after you look away and back again.

- **A session moved into a worktree via `EnterWorktree` now follows in the
  sidebar instead of staying stuck under the old folder.** Claude Code
  natively re-homes a live session's transcript to a new project directory
  when the session enters a worktree; the sidebar previously kept showing it
  under the original folder (a ghost) while the worktree folder stayed empty,
  with no way to fix it short of restarting Capy. The session now re-homes to
  the new folder within one watcher tick, keeping its selection state and
  live terminal attached.

- **Fleet model: a quiet folder's branch is refreshed on every full rescan.**
  A folder with no session activity now gets its `gitBranch`/`repoId`
  metadata re-probed on every watcher `ready`/degraded rescan, the same as a
  folder whose sessions changed — so `get_fleet` and other MCP consumers no
  longer report a stale branch after a switch that happened in a folder with
  no new session writes (BUG-34). Guaranteed going forward by a new
  regression test at both the pure-core and shell level; no new watcher
  subscription or polling interval was added.

- **`get_session`/`get_fleet` can now see a session an agent just created.**
  Previously a session minted by `create_session` was invisible to both reads
  until it produced a real disk transcript — which could be minutes away, or
  never happen for a session nobody opened a window for. A just-created
  session is now readable in the same turn, flagged `inflight: true` until its
  real transcript lands (or a 60-minute backstop passes), so a create→read
  round trip is observable end-to-end.

- **`create_session`'s `ok:true` now means the session actually launched.**
  Previously the ACK reported success the instant Capy accepted the request,
  before anything had actually started — five field incidents showed this as a
  phantom session (nothing ever launched, but a mission's approval budget was
  still spent), a batch that materialized minutes late all at once (risking
  several processes racing in the same folder), and a process that came up but
  was never wired into Capy's own session bookkeeping. `create_session` now
  waits (up to ~60s) to confirm a real process and its on-disk transcript
  before reporting success; a launch that doesn't come up in time reports
  `ok:false` with a clear reason and refunds any mission-grant budget it had
  reserved. A second `create_session` into a folder that already has one in
  flight is refused rather than risking a duplicate. `get_session` on a launch
  that's still in progress now reports it as pending instead of "not found".

- **Fleet rail no longer floods with phantom `stuck` cards after a restart.**
  The classifier now requires proof that a session's process is actually alive
  (a live terminal, a PID-registry entry, or a hook event received this run)
  before it will assign a `working`/`stuck`/`needs-you` state. Previously, a
  session that died mid-turn — quit while Capy was waiting on it — kept its
  transcript's last-known "working" or "asking for input" tail forever, which
  the 3-minute stuck timer then promoted to a permanent false alarm. Dead
  sessions now read as idle instead; a genuinely stalled live session is
  unaffected and still surfaces as `stuck`.

- **Reaper's sweep and manual "Remove worktree" left a dead folder in the
  sidebar.** Both already deleted the right things on disk, but neither made
  the sidebar agree the folder was gone — a swept worktree's folder and its
  broken session ("original directory no longer exists") kept showing up
  until a full app restart. Both call sites now reconcile the sidebar
  themselves, and the folder model itself no longer classifies a
  confirmed-gone, non-pinned directory as "active", so a ghost can't resurface
  after a restart re-scans your sessions either.

- **Manual "Remove worktree" failed outright when the directory was already
  gone** (e.g. deleted by Reaper, or by hand outside Capy) instead of pruning
  the stale registration — its pre-flight dirty-check tried to run `git
status` against a path that no longer existed. It now detects the missing
  directory up front and falls back to a forced removal.

- **A mutating tool call that trips the 120s server-side deadline can no
  longer silently duplicate its action on retry.** Node can't cancel a
  handler that's merely slow rather than hung, so it kept running invisibly
  after the caller already got `TOOL_TIMEOUT` and retried — a duplicate
  `create_session`, `create_worktree`, `submit_manifest`, or board write, with
  no audit trail linking the two. Every mutating call now derives a stable
  call id (the verb, folder, and its arguments); a retry that lands while the
  original is still running gets `CALL_IN_FLIGHT` instead of running a second
  time, and a retry that lands after the original already finished replays
  the SAME result instead of duplicating the action. The synthetic timeout
  audit record and the handler's eventual late-completion record now share
  that call id, so the audit trail reads as one intent instead of two
  unrelated actions, and a timed-out mission-grant action writes a distinct
  `timeout` shadow entry instead of a false success. `create_session`,
  `create_worktree`, `submit_manifest`, and the board writers additionally
  check whether the deadline already fired right before their commit step and
  abort instead of applying.

- **A session created via "+ New session" or a roadmap-card dispatch whose
  boot silently drops no longer lingers in the WORKING bucket forever.** The
  boot-timeout reaper (BUG-23) was only armed for MCP-created sessions; it is
  now armed from every creation path, so a dropped boot on any of them
  surfaces as a visible failed state (with Retry/Dismiss) instead of staying
  stuck as "working" indefinitely.

- **Creating a worktree was broken on Windows for any repo whose `WORKTREE.md`
  declared a `setup` step or a `copy` seed** — the normal case — failing with
  a bare `spawn sh ENOENT` and rolling back the freshly-created branch. Manifest
  `setup`/`create`/`remove` commands are POSIX-shell strings on every platform;
  on Windows, Capy now resolves a real POSIX shell (Git Bash, or the
  `CAPY_POSIX_SHELL` override) and runs the command through it, or fails
  loudly before anything is created if none is found. The seed's `copy` step
  no longer depends on a `cp` binary at all — it uses Node's `fs.cp`, with
  `cp --reflink=auto` kept as a fast path on Linux.

- **Restarting the control server no longer breaks already-running sessions'
  Capy tool calls.** The bearer token and the loopback port used to be
  regenerated from scratch on every server start, so toggling the control
  server off and on — or any restart of it — left every in-flight session
  holding a credential and endpoint the server no longer recognized: its Capy
  verbs failed (403, or `ECONNREFUSED` once the old port stopped existing)
  for the rest of that session's life, with no way to recover short of
  resuming it. The token is now persisted (`<userData>/mcp-token.json`, mode
  `0600`) and reused across restarts, and the server re-binds the
  previously-used port before falling back to a fresh one. If the stored
  port happens to be taken, Capy still starts on a new port and logs the
  fallback rather than failing or breaking silently — sessions spawned
  before that restart still need to be resumed in that case, same as before.

- **Failed and finished sessions no longer vanish on restart.** The rail's
  `errored`/`done` tiers used to exist only in memory — quitting Capy dropped
  every failure badge, rate-limit countdown, and collectable finished session,
  and some dirty-tailed ones came back mislabeled `stuck`. A small persisted
  ledger now records each failed/completed edge as it happens and restores it
  on the next launch, with correct badges and countdowns; a session that's
  resumed and shows any sign of life sheds a stale entry immediately.

- **A worktree `setup`/seed failure only ever showed the raw, bare `stderr`**
  (e.g. `sh: 1: npm: not found`), which hid two things: whether the tool was
  merely missing vs. actually failing, and that the checkout + branch had
  already been silently rolled back. The error now names the failing stage and
  exact command, distinguishes "binary not found" (naming it, plus the PATH
  Capy's setup shell used) from "the command ran and failed" (its exit code +
  verbatim output), and states plainly that the worktree was created and
  rolled back — same wording on the New-worktree dialog and the MCP
  `create_worktree` ACK, so an agent never has to probe `list_worktrees` to
  learn whether a failed create left anything behind.

- **Checkpoint timeline dots are now genuinely solid.** The green/red
  checkpoint dots in the Cleanup view's timeline (PR, Review, CI, Merged...)
  now fill with an opaque color instead of a translucent tint — the earlier
  fix only stopped the connector line from bleeding through, but the dots
  still read as faint/washed-out rather than solid.

## 2026-07-18

### Added

- **Fleet rail state filter.** A filter icon in the rail's header opens a
  popover listing the five states a card can be in (needs input, errored,
  stuck, working, done) — each with a live count and a toggle to show or hide
  it, so a wall of finished cards no longer has to push down the ones you're
  actually watching. It doubles as a legend for the dot/ring language the
  rail already uses. The setting persists across restarts. For safety, the
  header's attention badge always counts every needs-input/errored/stuck
  session regardless of the filter, and a one-click "N hidden" warning
  appears whenever the active filter is hiding one of those — filtering can
  narrow what you see, but it can never make an urgent session disappear
  without telling you.

- **Clickable view-targeted notifications in the Activity bell.** Rows that
  point at an in-app view instead of a session — the Reaper's "reclaimable
  space" alert, the manifest "needs a per-card confirm" toast — are no longer
  dead ends: clicking one now opens that view (Cleanup, the roadmap board) and
  dismisses the row, exactly like session-targeted rows already did.

- **Scoped sweeps in Cleanup.** "Sweep all green" no longer has to be
  all-or-nothing: each repo group in the Cleanup takeover now has its own
  "Sweep {n}" button that cleans only that repo's harvestable items, and
  harvestable rows carry a hover-reveal checkbox (in the existing kind-icon
  slot) for hand-picking a selection across repos, confirmed via a "Sweep {n}
  selected" bar. All three entry points — global, per-repo, per-selection —
  share the same confirm dialog, so nothing sweeps without it.

- **Copy affordance in the Markdown viewer.** Every fenced code block now has a
  hover-revealed copy button (top-right, also reachable by keyboard focus) that
  copies the block's exact source text to the clipboard, with a brief "copied"
  confirmation. The Markdown pane's toolbar also gained a "Copy file" action that
  copies the whole raw file (including unsaved edits) as markdown text.

- **Activity moved from the Fleet rail into a Topbar notification bell.** The
  notification history is global now, not per-worktree — a bell in the
  Topbar's right cluster (with a count badge) opens an anchored popover
  listing every notification, reachable even with no session selected. Rows
  keep the same anatomy (colored kind bar, "Session says" eyebrow for a
  session's own notices) with two changes: long text that clamps to 2 lines
  now always offers an expand chevron, so nothing is ever silently
  truncated, and optional per-row action buttons render from the
  notification's own payload. Clicking a row now correctly reveals and
  scrolls to its session in the sidebar before switching to it, fixing a bug
  where the old "Go to session" button changed the active tab without
  bringing it into view.

### Changed

- **Orphaned teammate groups are now hidden from the sidebar instead of
  showing a "Team session-…" header.** When a team's lead session can't be
  found anywhere in the folder, its teammates no longer render under a
  synthetic collapsible header — that row had no way to remove it (no
  Archive, no Delete) and its count only reflected the sidebar's own display
  window, not the group's real size on disk. The one exception: a teammate
  that is the sidebar's currently selected session still renders normally, so
  an open terminal never loses its row.

- **Notifications: dismiss and Clear all replace read/unread.** Being in the
  Activity list is now itself the "not yet handled" signal — there's no more
  unread dot to track. Hovering a row swaps its timestamp for a dismiss ×,
  and the popover header has a Clear all button. The Fleet rail no longer
  shows an Activity section at all — it moved into the new Topbar bell above.

- **Sidebar drop-to-pin now shows an unmistakable affordance.** Dragging a
  folder from the OS file manager over the sidebar (or the empty-state hero)
  used to draw only a barely-visible border. It now dims the sidebar's own
  content behind a pulsing dashed drop-target box with a centered icon and a
  "Drop to add folder" label, so the drop target is obvious at a glance.

### Fixed

- **Fleet rail cards now fill the rail's width.** The card `<button>` had no
  `width` set, so a short title shrank the whole card to fit its text and a
  long title overflowed the rail uncontained instead of ellipsising. Restored
  the approved mockup's `width: calc(100% - 16px)` — every card is now the
  same width regardless of title length, and long titles truncate correctly.

- **Fleet rail's `working`/`stuck` ring no longer travels at wildly uneven
  speed.** The border glint was a rotating `conic-gradient`, which sweeps at
  constant angular velocity around the box's centre — on a wide, short card
  that meant the glint crawled across long edges and then whipped through
  corners up to ~22x faster. Both rings now travel the border via an SVG
  `stroke-dashoffset` animation instead, which moves at constant speed by
  path length regardless of the card's aspect ratio. The `working` ring now
  shows two lights 180° apart instead of one.

- **`needs-input` ring's breathing opacity narrowed (0.3–0.85 → 0.55–0.8).**
  The old range made a needs-input card's own perceived weight swing more
  than the difference between any two other states, which read as "some
  cards have a thicker border" rather than as a state signal. The narrower
  range keeps the "waiting on you" pulse legible without the flicker.

- **Stamped manifest cards now actually auto-dispatch when "Ask before agent
  actions" is off.** The operator's manifest Allow is sufficient authorization,
  and a mission grant is only required while the ask toggle is on. Previously
  every stamped card silently fell back to a per-card confirm that only
  existed behind the board's Dispatch button (BUG-43, three field repros).

- **Minting a mission grant now wakes the manifest drain**, so an
  Allow-then-grant ordering no longer strands stamped cards.

- **The drain's fallback toast now names the folder, the cards, and the
  reason** (manifest-stale, no-manifest, …), and a drain paused at the WIP
  ceiling says so instead of staying silent.

- **Activity bell: rows no longer reflow on hover, clicking navigates, and
  action labels are translated.** Hovering a row swapped a ~40px timestamp
  for a 16px dismiss button without reserving column width, so body text
  visibly re-wrapped under the cursor — the right column now reserves a
  fixed `min-width`. Clicking a "Session completed" / "Needs your input" row
  silently dismissed it without navigating, because the session id never made
  it from the notification into the persisted history row — it's threaded
  through now, and a row with genuinely nothing to navigate to no longer
  dismisses itself on click. The per-row action button also rendered a raw
  `toast.actions.*` key instead of its translation; it now resolves the same
  way `Toast.vue` does, and reads "Go to session" for the session-navigate
  action.

- **Cleanup checkpoint timeline: connector line no longer bleeds through the
  dots, and the strip now fills its column.** The dot's `bg-*-soft` fill is
  genuinely translucent, so the 1.5px connector bar underneath was visible
  through and at the edge of every checkpoint dot; each dot now paints on an
  opaque backing plate that tracks the row's own background (rest vs.
  hover) instead. Separately, the 7-checkpoint strip was a fixed-width
  `flex` row (532px) that never grew to fill its `1fr` grid column, leaving
  a large dead gap before the verdict chip on wide windows — it's now a
  `w-full` 7-column grid, with each connector spanning its own (now
  dynamic, equal-width) column instead of a hardcoded 76px.

### Removed

- **The sidebar's folders/board segmented toggle.** The sidebar is
  folders-only now — the header no longer has a `list`/`layout-grid` mode
  switch, and the by-state "Fleet status board" it used to swap in is gone.
  `Cmd/Ctrl+Shift+B` now toggles the Fleet rail (same as `Cmd/Ctrl+Shift+A`),
  which already answers "which session needs me right now?" via its Fleet
  bucket cards.

## 2026-07-17

### Added

- **The right rail is now the Fleet rail.** The 4th column (formerly the
  Approval Inbox) now shows the whole fleet's live state as its scrolling
  body, not just the pending approval queue: every session that's needs
  input, errored, stuck, or working — plus recently done — one glance, no
  click required. Idle sessions stay hidden. No more state-label text: each
  card's dot and a new animated border ring (a travelling glint while
  working, a breathing amber ring on needs-input, slow marching red dashes
  when stuck, a still red ring when errored, a still green ring when done)
  carry the state instead, and a newly-arriving card fades and slides in
  from the right. Cards render in a strict priority order — a session that
  just started working can never bump something that's still waiting on
  you — and within the attention states, the longest-waiting session sorts
  to the top. "Needs you" and "Would-have" are now collapsible sections
  pinned below the fleet, with Needs-you open by default and Would-have
  closed.

- **Searchable branch picker in the New worktree dialog.** The Base ref and
  Branch-to-check-out fields used to be plain native `<select>`s — fine for a
  handful of branches, painful to scroll through on a repo with dozens. Both
  now open into a small filterable panel: start typing to narrow the
  Local/Remote list, arrow keys to move, Enter to pick.

- **Roadmap board: Archive and Delete a card.** The card detail modal now has
  Archive and Delete icon buttons next to Edit. Archive pulls a card off the
  board reversibly (a toast with Undo restores it); Delete removes the card's
  file for good, behind a confirmation. Both are disabled while a card is In
  Progress — move it to Review first. A Claude session with agent control
  enabled can do the same two things via new `archive_card`/`delete_card` MCP
  verbs — archiving runs directly like the board's other organizing verbs,
  but deleting always asks you first, since there's no undo.

- **Cleanup view.** A new guarded-deletion takeover for merged worktrees, orphan
  local branches, archived hidden folders, and stale remote branches. Each
  candidate shows a 7-checkpoint timeline (PR → Review → CI → Merged → In main
  → Remote gone → Local clean) explaining exactly why it's harvestable, blocked,
  or still insufficient signal — nothing gets offered for deletion without a
  provable merge signal. Deleting always goes through one sweep-confirm dialog
  (single item or a bulk sweep): folders go to the OS trash, local branches stay
  recoverable via `git reflog` for ~30 days, remote-branch deletion is opt-in and
  off by default with an explicit warning, and every action lands in a cleanup
  journal with a one-click restore-command copy. Open it from the new footer
  pill (visible once something's harvestable) or a repo group's right-click
  **Cleanup…** menu entry.

- **Cleanup: background scan + Settings tab.** Cleanup now scans quietly on its
  own timer (1 hour by default) instead of only when you open the view, and
  logs a notification-center entry whenever something new becomes harvestable
  — no toast, no sound, no OS alert, just a quiet record you can act on later.
  A new **Settings → Cleanup** tab controls it: turn the background scan off,
  pick the interval (30m/1h/6h/daily), add extra protected branches, require a
  minimum age before flagging a branch, and a **kill switch** that stops remote
  branches from ever being deleted — enforced by Capy itself, not just hidden
  from the sweep dialog.

- **System Monitor: an "own memory" row and a RAM-column hint.** Expanding a live
  session used to show only its child processes, whose RAM never added up to the
  row's total — the session's own process was included in the total but never got
  its own line. It now appears as a muted, distinctly-marked "own memory" row so
  the numbers reconcile. A small info glyph next to the "RAM" header explains that
  the column sums per-process RSS, which can read higher than OS-level tools (KDE
  System Monitor, `htop`) that deduplicate memory shared across processes. Both are
  pure client-side additions over numbers already sampled — no extra `/proc` reads.

- **Cleanup: collapsible repo groups.** A repo's group header in the Cleanup view
  is now a click-to-collapse toggle, with a chevron that rotates on expand and a
  worktrees/branches/folders count that stays visible while collapsed — useful on
  a fleet with hundreds of harvestable items spread across many repos. Groups
  start expanded; the collapsed state is session-local and not persisted.

- **Cleanup: filter by verdict + search by branch name.** With hundreds of items
  and dozens of repos, finding one specific branch or narrowing to just the
  harvestable ones meant scrolling through everything. The toolbar now has a
  live search (matches branch or folder name) and an All/Harvestable/Blocked/
  Unknown verdict filter; both compose, a repo group with zero matching rows
  hides itself entirely, and the KPI strip narrows to reflect what's shown.

### Fixed

- **Cleanup: sweep no longer fails on squash-merged branches.** A branch
  classified harvestable via GitHub's PR-merged verdict (or a closed PR whose
  remote branch vanished) could still fail deletion with "not fully merged" —
  `git branch -d` runs its own ancestry check, which squash merges defeat even
  though the PR-merged signal is authoritative. The branch-delete step now
  retries with `-D` only for those two proven-merged signals, on that exact
  refusal; branches justified purely by local ancestry (or with no signal)
  still only ever use `-d`.

- **Release builds silently shipped with no downloadable assets.** The
  `release.yml` workflow built the Linux/macOS/Windows installers successfully
  every time, but electron-builder was silently skipping the GitHub upload
  whenever the tag's release was already published (non-draft) before the CI
  build finished — v0.3.3 and v0.3.5 both went out with only GitHub's
  auto-generated source zip/tar.gz, no actual installers. `electron-builder.yml`
  now sets `releaseType: release` so uploads target the already-published
  release instead of silently bailing.

## 2026-07-16

### Fixed

- **Inbox rail: Activity row anatomy matches the approved BUG-36 mockup.**
  The kind color (info/success/warning/danger) was rendering as a colored
  border wrapped around the whole row — combined with the neutral row
  divider, this read as a colored frame around each row rather than the
  approved design. It's now an inner 2px rounded bar, a dedicated element
  inside the row, matching the mockup exactly; row dividers stay a plain
  neutral hairline.

- **Escape inside the branch picker no longer discards the New worktree
  dialog.** The dialog's own Escape handler ran in the capture phase on
  `window`, so it always fired before the branch combobox's own Escape
  handling could close just the dropdown — closing the entire dialog (and
  whatever branch/base the operator had typed) instead. Escape now closes only
  the open combobox panel when it's focused; the dialog stays open otherwise.

## 2026-07-15

### Added

- **Footer heap gauge.** The System Monitor now has a one-click entry point: a
  small `heap NN%` gauge in the footer, next to the plan-usage summary. Fed by a
  cheap 30-second heartbeat that keeps running even with the monitor pane closed,
  it turns amber at 70% heap used and red at 85% — the early-warning signal that
  would have caught the 2026-07-14 OOM incident without any pane open. Click it to
  open the full System Monitor.

- **System Monitor: per-row Park now / Close, and a hibernation-policy Settings tab.**
  Hovering a live session row in the System Monitor now reveals **Park now**
  (parks it immediately, same as an automatic hibernation sweep) and **Close**
  (closes the session, same as from the sidebar). A new **Hibernation policy**
  Settings tab exposes the three T119 hibernation knobs — max concurrent
  sessions, and the two idle thresholds for the cap and the periodic sweep —
  previously hardcoded and only changeable by editing source and rebuilding.
  Edits persist and take effect on the very next hibernation check, no restart.

### Changed

- **Sidebar: one flat folder list.** The classic sidebar's FOLDERS /
  ACTIVE ELSEWHERE split is gone — every visible folder (pinned or merely
  active) now renders in a single list, with no section headers, no divider,
  and no visual distinction between a pinned and a discovered folder. This
  also fixes a bug where a repo with worktrees split across the two zones
  rendered its repo-group header twice.

### Fixed

- **Agent-dispatched sessions no longer boot blank when the initial prompt can't
  be delivered on the first try.** A session started with an initial prompt (from
  `create_session`, or a dispatched roadmap card) queues that prompt for delivery
  once its REPL is up. The delivery step used to _consume_ the one-shot prompt
  before it had resolved where to type it — so if the terminal wasn't reachable at
  that instant (for example, during a brief Control-server reconnect), the prompt
  was thrown away and the session opened empty. It now resolves the target first
  and only consumes the prompt once it has somewhere to send it; a failed attempt
  leaves the prompt queued to be delivered on the next readiness signal. That
  resolve is now retried a few times on a short backoff instead of giving up
  after a single miss, so a target that only becomes reachable a moment later
  (the reconnect settles mid-attempt) still gets the prompt delivered instead of
  leaving it queued indefinitely.

- **A stuck initial-prompt delivery is now visible and retryable, instead of
  leaving a session silently blank forever.** Even with the fix above, a
  dispatched session's REPL could come up perfectly live while its initial
  prompt still never got typed in (the same brief Control-server hiccup, just
  timed slightly differently) — and nothing noticed, since the session already
  looked "running". Capy now keeps checking for a few seconds after the REPL
  comes up, retrying delivery a handful of times; if it still doesn't land, the
  session shows a clear **"Prompt not delivered"** failure with a **Retry**
  action right in its context menu.

- **Packaged builds showed a broken-image icon in the window's menu-bar corner
  (Linux) and in OS notifications / the changelog and Claude-status alerts.**
  `resources/icon.png` is loaded at runtime via an `?asset` import for those
  four spots, but `electron-builder.yml`'s `files` allowlist never actually
  included it — only `out/**/*` and `package.json` shipped inside the asar, so
  the icon file simply didn't exist in installed builds. Added
  `resources/icon.png` to `files` so it's packaged where the code expects it.

- **Hiding a pinned folder no longer loses its pin.** Hide used to also unpin
  a folder, so a pin → hide → unhide round-trip brought it back merely
  "active" (or dropped it entirely once it went quiet). Hide now only hides —
  a pinned folder you hide stays pinned underneath, and unhiding it restores
  it as pinned.

- **Weekly-reset rate-limit chart: the "after reset" number was wrong, now it's
  right.** On a day when your 7-day cap reset mid-day, the Dashboard's rate-limit
  chart was reporting the _old_ window's peak as the after-reset amount (e.g. a
  day showing 100% "after reset" when you'd only used ~20% of the fresh week) —
  because the account API keeps echoing the closed window's high reading for a
  while after the reset, and the chart was picking that up. It now tracks only
  the new window, so the after-reset bar shows what you've actually used since
  the reset. The reset day also renders more clearly: two stacked segments —
  the closed week at the base, the new week on top — each with its own %
  labelled inside it and colored by its own threshold, no confusing combined
  total.

- **System Monitor: the expand/collapse chevron on a session row now actually
  hides its child processes.** Child process rows were rendered with `v-show`,
  but `SystemMonitorRow` has two possible root `<tr>`s (the main row plus a
  conditional "parked" explain row), so Vue treats it as a multi-root
  component and silently drops attribute/directive fallthrough — the
  `v-show` toggle never reached the DOM, so clicking the chevron did nothing.
  Switched to `v-if`, which isn't subject to that fallthrough limitation.

- **System Monitor: session state pips (`live`/`parked`) no longer drift
  out of alignment between rows.** The Park now button only renders for
  parkable sessions, so its 22px slot was missing entirely on non-parkable
  rows — since the whole state column is right-justified, that shifted the
  state pip sideways by a button-width depending on the row. The Park slot
  now always reserves its 22px (an invisible placeholder when absent), so
  every session row's pip lands at the same x position.

### Removed

- **Bento and drill-in sidebar layouts.** Classic is now the only sidebar
  layout — the "Sidebar layout" picker in Settings → General → SIDEBAR is
  gone. Both alternate layouts (bento's repo cards + idle compression, T90;
  drill-in's one-domain-at-a-time navigation, T119) shipped as opt-in
  experiments that never became the default and are being retired ahead of a
  future sidebar redesign.

## 2026-07-14

### Added

- **System Monitor takeover.** A new Chrome-task-manager-style pane showing every
  Capy process and every session's live RAM/CPU, built after the 2026-07-14 heap OOM
  incident left zero visibility while it was forming. Two groups — Capy processes
  (with a heap gauge on the `main` row) and Sessions (expandable into their
  `/proc` children) — sorted by RAM used. A parked session shows a dash for its
  cost instead of a false zero, plus why it was parked and roughly how much RAM
  that freed. Detailed sampling only runs while the pane is open and the window is
  focused; a lightweight heap heartbeat keeps running in the background regardless.
  Observe-only for now — per-row park/close actions and an in-app hibernation-policy
  editor are a follow-up.

- **Card detail modal: edit engine + actions footer.** Opening a card now offers a
  real Edit mode — the whole spec swaps for one raw-markdown textarea (Save/Cancel
  right below it), a full replace that writes atomically without ever touching the
  card's frontmatter. Editing an already-approved (manifest-stamped) card warns you
  first that the stamp will be voided; you can still save anyway. Closing a dirty
  editor (Esc, clicking outside, or Cancel) now asks before discarding instead of
  silently losing the draft.
  - Acceptance-criteria checkboxes in the read view are now **live** — click one to
    flip it, written straight to the card.
  - The card's title is click-to-edit right in the modal (hover to see the
    affordance), no need to open Edit mode just to rename something.
  - A new **copy-link** button in the header copies the card's file path.
  - A sticky actions footer: **Edit**, a **Backlog/Ready/Review** move control
    (never Done — that's still your call from the board), a readiness hint that
    turns green when the card has no gaps or amber with what's missing, and a
    **Dispatch** button when the card is eligible.
  - Agent-side: `update_card` gained a `replaceBody` capability so a session can do
    the same full-spec rewrite the Edit button does, with the same stamp-void
    warning on the response.

- **Roadmap board: a filter bar, group-by, and a collapsible Done rail.** A new bar
  under the board header lets you search cards by id/title, filter by kind (bug,
  feature, chore, scout, review — dim the ones you don't want), group the columns by
  epic or by kind instead of one flat list, and hide Done. Your kind/group/hide-done
  picks are remembered per repo; the search box always starts empty. Hiding Done
  collapses that column into a slim vertical rail showing its count — click it to
  expand back to a normal column any time (dragging a card onto Done, rail or
  expanded, is still blocked — that's still Close-only). The board header now also
  shows "N cards · M working" at a glance. Compact cards got a couple of small
  upgrades to match: the kind chip is colored (bug red, feature accent) instead of
  plain grey, and a card bound to a session shows a short mono session-id chip.

- **Create a card straight from the board.** A new **`+ New card`** button on the
  filter bar opens the card detail modal in create mode: pick a kind and a
  complexity, type a title, and the body starts pre-filled with that kind's
  delegation-packet template (the same one an agent's `create_card` seeds) — edit
  it to taste, or leave it as scaffolding. The card is always born in Backlog; on
  Create it opens straight into its own detail view so you can see exactly what got
  written. Cancel, Esc, or clicking outside discards without writing anything
  (asks first if you've already typed a title or changed the body).

- **Cards now track a PRD and an ADR alongside the spec.** Cards can carry optional
  `prd:`/`adr:` fields (same convention as `spec:`), settable by hand or through
  `update_card`. A `standard` card is expected to have a spec, a `complex` card a spec
  and a PRD, and any card that declares an architectural decision (an `adr:` field, or
  an `## Architectural decision` heading in the body) is expected to have an ADR —
  whether that's tier-appropriate or not. Compact cards on the board now show a badge
  per required artifact (green `spec ✓` when it's there, a dashed amber `prd` when
  it's missing) instead of one anonymous gap count; the card detail modal's Docs
  section always shows all three rows (present, missing, or "not required for this
  tier"), and a required-but-missing row hints at a matching `docs/prds/`/`docs/adr/`
  file if one already exists on disk, even though only the field itself makes it
  official. Linked cards in the modal now also say WHY they're linked — `← blocked-by`
  when a dependency isn't done yet, `→ blocks` when another card is waiting on this
  one, `· done` once a blocker lands.

- **Answer a card's open questions right in the modal, and generate its missing
  docs.** The "Open questions" section is now interactive: an answered question
  shows who answered it and when, next to the answer itself; an open one gets a text
  box and a **Send** button — typing an answer and sending it saves straight to the
  card and the question flips to answered on the spot. A badge on the section header
  counts how many are still open, and the same count now shows as a small `? N` chip
  on the compact board card. When a card is missing a doc its complexity tier
  requires, its Docs row now offers a **Generate** button — it goes through the exact
  same launch disclosure as dispatching the card itself (same model/effort, same
  "where it runs", same boot prompt shown verbatim), just without rebinding the
  card's own session. What the launched session does depends on the card's tier: a
  standard card gets a complete draft immediately with its assumptions spelled out
  and a few follow-up questions parked for later; a complex card asks its questions
  first and holds off drafting until they're answered.

- **System Monitor — main-process core (T127 S1, no UI yet).** The engine room for
  an upcoming Chrome-task-manager-style view of the fleet: an always-on 30s heap
  heartbeat (`v8.getHeapStatistics()`, negligible cost) and a 1–2s full sampler that
  reads `app.getAppMetrics()` for Capy's own processes plus a `/proc` walk for each
  live session's process subtree — never a folder scan, a transcript read, or a git
  probe. The hibernation policy (T119) gained an `explainFleet` sibling that reports
  _why_ a session is live or parked and who's next to be swept, on top of which the
  existing eviction logic is now built (its behavior is unchanged). Nothing user-
  visible ships yet — the takeover pane, footer gauge, and Settings tab land in
  follow-up slices.

### Changed

- **Agents are now free by default — this is a security-posture reversal, and it
  applies to your existing folders too.** Read this one.
  - **Agent control is ON for every folder**, including every folder you already
    had. There is no longer a per-folder allowlist to opt in to, and nothing is
    migrated — a folder you had previously left disallowed (or never enabled) is
    now agent-reachable on upgrade.
  - **Agent actions no longer ask for confirmation.** Creating a session, a
    worktree, or a terminal, pinning a folder, and writing to project memory all
    run immediately. Previously each one stopped at a human confirm.
  - **The control server is on out of the box** (it used to ship off).
  - Why: the old fail-closed default silently stranded work. An agent would create
    a session, get an id back, then be refused when it tried to read that same
    session — and the machine sat idle until a human came back and flipped a
    switch. The gate was buying little: pinning a folder at all was already the
    trust decision, and an agent could pin folders itself.
  - **Everything agents do is still recorded** in the audit log
    (Settings → Control server). With actions running unattended, that log is now
    the record of what happened.
  - **Three ways to opt out**, in increasing severity:
    1. **Ask before agent actions** (Settings → Control server, off by default) —
       puts the confirmation back in front of every agent action, everywhere.
    2. **Block agent control** on a folder (right-click a folder, or the list in
       Settings → Control server) — refuses agents in that folder _and everything
       under it_, absolutely: no mission grant or "always allow" can reach into a
       blocked folder. Blocked folders show a crossed-out-bot marker in the sidebar.
    3. **Turn the control server off** — the master kill switch; nothing gets
       through, not even reads.
  - **`submit_manifest` still always asks you.** Dispatching a batch of roadmap
    cards as running sessions remains an explicit door you open, in both modes.
  - The per-folder toggle in the folder menu is now **"Block agent control"**
    (it used to read "Allow agent control"), and the sidebar's bot badge now marks
    a _blocked_ folder rather than an allowed one. The "Worktrees inherit agent
    control" setting is gone — with no allowlist, there is nothing to inherit.

- **Learning mode now delivers lessons instead of waiting to be asked.** The
  tutor contract (`docs/capy-teacher.md`, now v5) makes authoring and delivering
  a lesson one act: the moment a lesson file is written — the first one, the
  next one, or a retry after a failed exam — the tutor calls `open_file` on it
  immediately, never waiting for "abre ela pra mim". Lesson files also get an
  explicit, fixed home (`<folder>/.capy/learning/lessons/`) so they always land
  somewhere `open_file` can actually reach, instead of a scratchpad path it
  structurally can't open.

- **Learning mode now delivers lessons instead of waiting to be asked.** The
  tutor contract (`docs/capy-teacher.md`, now v5) makes authoring and delivering
  a lesson one act: the moment a lesson file is written — the first one, the
  next one, or a retry after a failed exam — the tutor calls `open_file` on it
  immediately, never waiting for "abre ela pra mim". Lesson files also get an
  explicit, fixed home (`<folder>/.capy/learning/lessons/`) so they always land
  somewhere `open_file` can actually reach, instead of a scratchpad path it
  structurally can't open.

### Fixed

- **Approval Inbox rows (Needs-you, Would-have, Activity) no longer read as
  permanently cut-off text.** Titles and descriptions now wrap to 2 lines
  instead of truncating single-line mid-word, so realistic session titles and
  tool summaries are legible instead of always ending in an ellipsis; the
  Allow/Deny buttons on Needs-you rows no longer crowd against clipped text.
  The Activity list (unbounded, every session event appends) is now
  virtualized — only the rows in view are rendered, keeping the rail smooth
  past hundreds of entries. Supersedes and closes out the earlier
  Activity-only version of this fix.

- **An agent pane opened into the folder you're already looking at no longer
  lands silently if the helper panel is collapsed.** Previously the reveal
  only fired when the panel went from empty to non-empty; a pane added to a
  stack that already had panes crossed no such edge, so a collapsed panel
  stayed collapsed with zero signal — no reveal, no badge. It now reveals
  itself the moment the pane lands. Off-screen folders are unaffected: they
  still get the unseen-pane badge + coalesced notification without stealing
  focus or switching folders.

- Clicking a link printed in any terminal (main pane or a helper split) now
  opens it in your default browser. Previously the click did nothing — xterm's
  link addon called `window.open()` with no URL, which the app's popup
  allowlist always denied, so the click silently no-opped.

- **`sanitizeSpawnEnv` now cleans the AppImage-runtime pollution out of every
  spawned child's environment under AppImageLauncher, not just a plain
  AppImage run.** It used to trust `$APPDIR` as the squashfs mount
  unconditionally; under AppImageLauncher `$APPDIR` points at the launcher's
  own directory instead, so the sanitizer silently stripped nothing and
  mount-rooted `PATH`/`LD_LIBRARY_PATH` entries leaked into every terminal
  session and worktree setup shell. The mount is now also detected from the
  running binary's path and from the mount-shaped entries already present in
  `PATH`/`LD_LIBRARY_PATH`, so the cleanup works regardless of how the
  AppImage was launched.

- **`create_worktree` could not stack one branch on top of another — it always
  forked the new branch from `origin/main`, with no way to say otherwise.** A
  new optional `base` parameter lets a session name an explicit ref (another
  feature branch, a tag, a commit) to fork from instead — the new worktree's
  HEAD lands exactly on that ref's tip. With no `base`, behavior is unchanged
  (still `origin/main`). A `base` that doesn't exist is refused with a clear
  `BAD_BASE` error rather than silently falling back to main; an explicit local
  base that's behind its own remote counterpart gets a warning, not a refusal.
  This also resolves the sibling report that `folder` looked like it meant
  "base the new branch here" when it never did — `folder` still only ever
  means which repo, never which base.

- Clicking a link printed in any terminal (main pane or a helper split) now
  opens it in your default browser. Previously the click did nothing — xterm's
  link addon called `window.open()` with no URL, which the app's popup
  allowlist always denied, so the click silently no-opped.

- **`sanitizeSpawnEnv` now cleans the AppImage-runtime pollution out of every
  spawned child's environment under AppImageLauncher, not just a plain
  AppImage run.** It used to trust `$APPDIR` as the squashfs mount
  unconditionally; under AppImageLauncher `$APPDIR` points at the launcher's
  own directory instead, so the sanitizer silently stripped nothing and
  mount-rooted `PATH`/`LD_LIBRARY_PATH` entries leaked into every terminal
  session and worktree setup shell. The mount is now also detected from the
  running binary's path and from the mount-shaped entries already present in
  `PATH`/`LD_LIBRARY_PATH`, so the cleanup works regardless of how the
  AppImage was launched.

- **`create_worktree` could not stack one branch on top of another — it always
  forked the new branch from `origin/main`, with no way to say otherwise.** A
  new optional `base` parameter lets a session name an explicit ref (another
  feature branch, a tag, a commit) to fork from instead — the new worktree's
  HEAD lands exactly on that ref's tip. With no `base`, behavior is unchanged
  (still `origin/main`). A `base` that doesn't exist is refused with a clear
  `BAD_BASE` error rather than silently falling back to main; an explicit local
  base that's behind its own remote counterpart gets a warning, not a refusal.
  This also resolves the sibling report that `folder` looked like it meant
  "base the new branch here" when it never did — `folder` still only ever
  means which repo, never which base.

- **Capy no longer re-scans your entire session history for every agent action.**
  Capy now keeps one shared, watcher-fed in-memory index of your fleet; agent
  calls and the sidebar read it instead of re-scanning `~/.claude/projects/` —
  previously, concurrent agent calls each ran their own full scan, which could
  freeze the UI and crash the app with an out-of-memory error under load.

- **`create_session` no longer dead-ends in a folder Capy hasn't seen yet.** The
  free-by-default reversal above killed the permission gate that used to block
  this, but a second, separate check — the renderer's own "do I know this
  folder" existence check — still refused the exact same call with
  `FOLDER_NOT_FOUND`. A folder created outside Capy (a plain `git worktree add`)
  or one an agent had just pinned itself hit this every time. `create_session`
  now adopts the folder and waits for it to actually register before finishing,
  instead of refusing outright.

- **A failed `create_session` no longer reports success.** The ACK could read
  `{"ok":true, ...}` while nesting a real failure inside — an agent trusting the
  top-level flag believed the call had worked. `ok` now reflects the true
  outcome.

- The "not agent-allowed" hint an agent got when a folder was blocked was
  stale — it described a per-folder grant that no longer exists. It now says
  plainly that the operator blocked the folder on purpose.

- **A hung MCP tool call can no longer pile up in-flight handlers indefinitely.**
  Every tool call now carries a server-side 120-second deadline; a handler that
  exceeds it returns a structured `TOOL_TIMEOUT` error instead of leaving the
  caller waiting, and the timeout is recorded in the audit log
  (Settings → Control server). This closes the failure pattern from the
  2026-07-14 incident, where handlers outlived the client's own 300-second
  timeout and each stuck call retained memory until the main process ran out
  of heap.

- Sessions no longer die at boot with "MCP config file not found" when the
  control server is toggled off and on. A `claude` session that spawns or
  resumes while the server is off (or in the brief gap right after a restart)
  now simply boots without the capy connector, instead of being pointed at a
  config file that doesn't exist yet. The config file itself is also now
  written atomically, so a session can never read it half-written mid-restart.

## 2026-07-13

### Added

- **`create_card`/`update_card` can now attach a pasted screenshot to a board
  card.** Both verbs accept an `images` list of source paths (e.g. one of the
  paths from the footer's pasted-images gallery); the server copies the bytes
  into the board's `assets/` directory and embeds them in the card body as a
  relative markdown image — an agent never writes a filesystem path into the
  card itself. A source must live under `~/.claude/image-cache/` or inside the
  repo folder whose board is being written; anything else is refused, as is a
  non-image file or one over 2 MB. This closes the one board-verb capability
  gap that was pushing agents to hand-write card files with an `assets:`
  frontmatter key no verb could write and the board never read.

### Changed

- **The default theme is now "Capy," built from the brand's own palette.** What
  was "Default Dark" (terracotta accent) is now Capy: a warm Ink-based
  neutral scale with a Dusk-blue accent, matching the brand palette instead
  of a generic dark theme. Existing users keep their setting automatically —
  only the display label changed, not the underlying theme id.

- **The app/taskbar icon now uses the Capy theme's own colors.** The Prompt
  Tile icon (window, taskbar/dock, `.ico`/`.icns`) is now a dark Ink tile
  with a Dusk-blue chevron, replacing the old terracotta tile with a dark
  chevron. `scripts/gen-icons.py` regenerates every format (`resources/icon.png`,
  `build/icon.png`, `.ico`, `.icns`, `iconset/`) from the same two constants.

### Fixed

- **Clicking an OS notification (or any other "jump to session" affordance) now
  fully focuses that session in the sidebar, not just in the terminal pane.**
  Previously only the selection moved — the keyboard-navigation outline stayed
  on whatever row you'd last reached with arrow keys, so two rows could look
  focused at once, and the target row could be off screen, inside a collapsed
  teammate group, or hidden behind bento's "+ N idle" compression. The shared
  `activateSession()` path now moves the keyboard cursor, scrolls the row into
  view, expands a collapsed teammate group, and reveals a compressed idle row
  — so exactly one row reads as focused, and it's always on screen.

- **A parked agent-action confirm (e.g. `plan_mission`, `create_session`) could
  vanish from the Approval Inbox and the confirm overlay alike, expiring
  unanswered 30 minutes later even while you were actively using the app.**
  The main process only ever announced a parked confirm once, at the moment
  it parked; if the window reloaded afterward (a dev reload, a crash
  recovery, a fresh window) there was no way for it to learn the confirm
  still existed. Capy now re-hydrates every still-pending confirm into the
  Approval Inbox as soon as the app (re)starts, so it can't go unseen again.

- **An agent-opened pane (`open_file`, `spawn_terminal`, a hosted teammate) now
  always lands in the folder that asked for it — never wherever you happen to
  be looking when the tool actually fires.** Previously, switching to a
  session in a different folder while an agent was still working could cause
  its pane to open in the wrong place. A folder Capy no longer recognizes (a
  stale or misspelled path) now gets an explicit refusal instead of silently
  appending to a stack nobody sees.

- **A small badge now marks a sidebar folder holding agent-opened panes you
  haven't looked at yet**, distinct from the session status dots — and if
  that folder isn't currently visible, Capy also raises a native
  notification (coalesced, so a burst of panes is one notification, not
  several). Clicking it jumps to the folder's most recently active session;
  opening the folder yourself clears the badge.

- **The Inbox rail now keeps a scrollable "Activity" history of every
  notification.** A new stacked section between "Needs you" and "Would-have"
  shows a durable, most-recent-first log of every toast Capy has shown you —
  session finished, an update is ready, a config copy failed — so stepping
  away no longer means losing track of what happened while you weren't
  looking. It's read-only for now (ack, dismiss, and filtering land in later
  updates) and keeps up to 200 entries or 7 days, whichever is smaller.

- **Roadmap board cards with a legacy Portuguese priority (`alta`/`media`/
  `baixa`) now sort correctly instead of falling to the bottom of their
  column.** The board's priority sort only recognized `high`/`medium`/`low`
  tokens; anything else — including the Portuguese tokens the agent-facing
  `create_card`/`update_card` docs used to suggest — ranked as "no priority"
  and sorted dead last. The sort now treats `alta`/`media`/`baixa` as
  equivalent to `high`/`medium`/`low`, and the `create_card`/`update_card`
  tool docs now only offer the English tokens.

- **A session can now post a notice any window can see ("Session says").** A
  new `notify` agent-control verb appends a short, persisted notice into the
  Activity history — visible from whichever session/window you're actually
  looking at, not just the one that sent it. Each notice tracks read/unread and,
  when the sending session included its own id, offers a **Go to session**
  button — a deep-link you can follow, never a switch that happens on its own.
  Silent-allowed in an agent-enabled folder, same gate as `open_file`.

- **`create_card` no longer mints a truncated-title id.** A card's id is now
  auto-numbered server-side — `T<n>` for most cards, `BUG-<n>` for bug-kind
  cards — the same convention already used for hand-written cards, instead of
  a raw slugified title cut off mid-word at 64 characters (e.g.
  `...capy-dispatches-work-but-never-observes-i`). The filename becomes
  `<ID>-<short-slug>.md`; the short slug is still readable (cut on a word
  boundary now, not mid-word) but no longer has to be unique on its own since
  the id carries uniqueness. Existing long-slug cards are untouched — they
  keep resolving under their own id and are never renamed or renumbered.

## 2026-07-12

### Added

- **The user guide now covers every feature, not just getting started.** Ten new
  pages under `docs/user/` document sessions, folders and worktrees, the
  Approval Inbox (including the hook interceptor), agent control, project
  memory, the roadmap board, Claude Boot, usage, settings, and troubleshooting
  — each verified against the shipped code, not the spec that originally
  proposed it.

### Changed

- **The footer's 5h/7d fleet chips now show the countdown, not the window
  size.** The window size (5h, 7d) is a constant — what you actually need to
  know is how much of it is left. The chips now read `5h·3h 7%` / `7d·2d 41%`:
  the window id stays (quiet, just for identity), followed by the time
  remaining until reset, then the % used. Hover a chip for the full detail
  ("5h window · 7% used · resets in 3h").

- **The design contract and project docs are now English, ahead of going open
  source.** `design.md` — the visual-system source of truth — was written in
  Portuguese; it's now the English source of truth (token names, CSS variables,
  and component names are unchanged). `CLAUDE.md` and `CONTRIBUTING.md` now state
  a Language policy: English for all code, comments, docs, and commit/PR content,
  with `pt-BR.json` and i18n test fixtures as the only exception.

### Fixed

- **New worktrees are now cut from `origin/<branch>`, not from whatever the shared
  checkout happened to be sitting on.** Creating a worktree resolved its base from the
  main checkout's local branch tip — which nobody fast-forwards during a long session,
  so new work routinely started 6+ commits behind `origin/main` and hit avoidable
  rebase conflicts at PR time. Worse, because it read that shared directory's live
  `HEAD`, a second session working in the same folder at that exact moment could hand
  the new worktree the tip of a **completely unrelated branch**. Capy now fetches the
  base branch and cuts from the remote-tracking ref, so the starting commit no longer
  depends on what another session is doing. Two behaviors are deliberately unchanged:
  picking an explicit base (checking out an existing PR branch) still means exactly
  what you asked for, and branching from a specific worktree's own tip (stacking work
  on work) still starts from that worktree's commit. If the remote can't be reached,
  the worktree is still created from the local ref and the create reports a warning
  instead of failing.

- **Teammate sessions no longer pile up as loose top-level rows in the sidebar.**
  A team's lead session normally nests its teammates underneath it, like
  subagents — but the lead typically goes idle the moment it dispatches its
  team, which could age it out of the sidebar's session window. Once that
  happened, the teammates fell back to a standalone "Team session-XXXXXXXX · N"
  row instead of nesting. The lead lookup now searches the whole folder, not
  just the currently visible window, so the lead's row reappears (with its
  teammates nested underneath, chevron and all) whenever it's still on disk —
  the standalone header is now reserved for the rare case where no session in
  the folder matches the team's lead at all.

- **The divider between the helper panel and the Approval Inbox no longer renders as
  two lines, and its header no longer sits a few pixels off from the topbar.** The
  Inbox rail carried its own left border on top of the shared drag handle, so the
  boundary looked like a doubled, broken line instead of the single hairline used
  everywhere else in the app (sidebar, terminal↔helper-panel). Its header row was
  also 4px shorter than the topbar, so the two borders stair-stepped instead of
  lining up — both now match.

- **Removed the redundant Approval Inbox icon from the topbar.** Now that the
  Inbox rail is a permanent, always-visible panel rather than something you open,
  a dedicated topbar button to "open" it was pointless clutter. ⌘⇧A and the "Open
  approvals" command in the palette still expand it.

- **A memory-update notification no longer yanks a minimized Approval Inbox open.**
  Low-priority, informational notices (like a proposed memory update) used to
  force-expand the panel exactly like a real approval request, interrupting
  whatever you were doing for something that needed no decision. They now only
  make the minimized panel's icon glow — no forced reopen, no sound. Genuine
  approval requests still force-open the panel with sound and OS attention,
  unchanged.

## 2026-07-11

### Added

- **A real user guide, finally.** `docs/user/` now documents how to actually use
  Capy — starting with install and your first session — instead of the
  engineering-only docs that existed before. Linked from a new Features section
  in the README. Landing a new user-visible screen or capability without
  updating `docs/user/` now fails CI (see the "User docs are mandatory" contract
  in `CLAUDE.md`).

- **Interactive lessons in the file viewer (Capy Learn).** A `.md` file with ` ```quiz `
  blocks now opens as a lesson instead of a wall of text: the alternatives become real
  radio buttons or checkboxes (or a text box, for open questions), and **Submit answers**
  grades you instantly against the answer key embedded in the file and reveals the
  explanations. The result — your score, what you got wrong, and your written answers
  verbatim — is sent straight back to the session teaching you, which can then explain the
  mistakes and plan the next lesson. If no session is live, you still get your grade
  locally. A malformed quiz block simply renders as a normal code block, so a typo never
  breaks a lesson.

- **Checkpoints — practice questions that grade themselves, mid-lesson.** A quiz block
  can now carry `mode: check` to become a checkpoint: it gets its own **Check** button, and
  pressing it grades only that question, reveals its explanation, and reports the result to
  the teaching session right away — while the rest of the lesson stays open and editable.
  The lesson's own **Submit answers** bar counts only the exam questions, so checkpoints
  never affect your score; a lesson made entirely of checkpoints (pure practice) shows no
  submit bar at all, since there's nothing to hand in.

- **Modes ▸ Learning — open a session that's already a teacher.** A new option in a
  folder's context menu boots Claude straight into teaching mode: it asks you _why_
  you want to learn the topic, researches how the subject is actually taught, maps
  the domain's learning path — and says plainly what it can't teach you — before
  writing the first lesson. There's no skill to install or prompt to paste: the
  teaching method ships inside Capy itself.

- **Sessions now go to sleep instead of piling up.** Every session you open holds a live
  `claude` process worth around 420 MB, and until now nothing ever released one — a day of
  hopping between sessions could quietly cost several GB of memory. Capy now keeps at most
  5 sessions running and puts the ones that have gone cold to sleep, freeing their memory.
  **Nothing is lost:** the conversation lives on disk, and clicking a sleeping session picks
  it up exactly where it was. A session that is actively working is never put to sleep, and
  neither is the one you have open.

- **Drill-in sidebar layout — a third option next to Classic and Bento.**
  Instead of an always-expanded tree, navigate one domain at a time: Spaces
  (repos/folders) → worktrees → sessions, sliding between panels. Sessions
  that need you or are stuck show a compact card that reveals its full reason
  plus an Open action on hover; running sessions get a live context %. Switch
  it in Settings → General → Sidebar → "Sidebar layout".

- **The rate-limit chart now shows both sides of a weekly reset.** When your
  7-day cap resets partway through a day, the Dashboard's stacked bar used to
  show only whichever number was higher — usually the pre-reset peak, silently
  hiding how much of the fresh window you'd already used. That day's bar now
  splits into two segments (post-reset on top, pre-reset below in a muted
  tone, with a thin divider), and is allowed to rise past the 100% line since
  the two segments are different quota windows, not one fill.

### Changed

- **The Approval Inbox is no longer a pop-up — it's a permanent panel on the right.**
  It used to be a modal, which meant a click just to find out whether anything was
  waiting on you; a confirm parked behind a closed modal was, in practice, an
  invisible confirm. Now the queue lives in its own column beside the helper panel,
  so "is something blocked?" is answered by a glance. Approvals and the shadow log
  are stacked sections rather than tabs, so the allow/deny queue can never hide
  behind an unselected tab.

- **The panel calls for you when something needs a decision.** If a new approval
  arrives while the panel is minimized or hidden, it opens itself — but it never
  steals your keyboard: no dimmed backdrop, no Esc-to-close, and the cursor stays
  in the terminal, so you can keep typing mid-sentence while the queue appears
  beside you.

- **`hot.md` memory updates no longer wait for your approval.** Every session that
  finishes or goes idle after committing work used to propose a "where we left off"
  update as its own row in the Approval Inbox — with several sessions running at once,
  these piled up faster than they could be reviewed. They now apply immediately; you
  can still audit every one after the fact in the Approval Inbox's "Would-have" section.

- **Minimize keeps the badge.** Collapsing the panel leaves a slim strip that still
  shows how many items are waiting, so minimizing costs you screen space, never the
  warning. Drag its edge to resize (double-click to reset), and ⌘⇧A / the Topbar
  inbox button expand or minimize it — they never hide the queue.

- **Sidebar stat icons now appear on hover instead of permanently.** The counts
  and actions on the right edge of folder and session rows (older/archived
  peeks, "+", agent badges, context %) no longer stack into a wall of numbers —
  they fade in when you hover a row or focus it with the keyboard. Anything
  carrying a live signal stays visible: an active peek, a context % near
  /compact, failure badges, and collapsed group/section counts.

- **Removed the duplicate context % and relative-time chips from session rows.**
  Both already showed in the hover preview card, so the row no longer repeats
  them — same reasoning as the branch chip, which already lived only in the
  footer. The hover preview's context % now carries the same color banding
  (quiet below 80%, warm near /compact) that the row chip used to have.

- **The hover preview card now also shows the subagent count.** The row's
  agent chip is a control (it expands the nested agent list), so it stays —
  but the plain count wasn't visible anywhere without opening the row. The
  hover card's footer now reads "N messages · N agents" when the session has
  subagents.

### Fixed

- **Creating a worktree no longer fails with "npm: not found".** A worktree's setup
  commands (from the project's `WORKTREE.md` — typically `npm ci`) ran in a shell that
  never saw your real toolchain: an app opened from the desktop/Dock doesn't inherit the
  PATH your terminal has, so a Node installed through mise, nvm, asdf, or Homebrew was
  simply invisible. The setup then died, and because the create is transactional, the
  worktree was rolled back — leaving you with an error and nothing to show for it. Setup
  now runs with the same environment your terminal would give it, which is what the
  sessions Capy spawns already did.

- **Approved dispatch batches now run without the Roadmap board open.** The
  manifest drain — what actually launches the cards you approved in a dispatch
  manifest — used to live inside the board view, so closing the board silently
  stopped all dispatching (approved cards could sit undrained for as long as the
  board stayed closed). The drain now runs in the background in the main process:
  once you Allow a manifest, its cards dispatch in order with Capy open on any
  view, pausing at the WIP ceiling and resuming as cards leave In Progress.
  Sessions spawned by the background drain never steal your focus, and a batch
  summary toast tells you when some cards still need a manual confirm.

- **The file browser now previews images instead of refusing them as binary.**
  Opening a `.png`/`.jpg`/`.jpeg`/`.gif`/`.svg`/`.webp`/`.bmp`/`.ico` from the
  Explorer (or via an agent's `open_file`) renders it inline in the viewer pane —
  centered, never wider than the pane. Non-image binaries (archives, executables,
  fonts) and files over 2 MB keep the existing refusal.

- **A "New session" that died before its first turn (e.g. Ctrl+C in the
  terminal) no longer gets stuck as an unrecoverable zombie.** Right-clicking it
  now offers Retry/Dismiss the same way a session that failed to boot already
  did, and "+ New session" mints a genuinely fresh session instead of endlessly
  re-selecting the dead one — previously this could trap the sidebar in a loop
  where no new session could ever be opened.

- **Click a roadmap card to open its dossier.** A read-only detail modal shows
  everything the board row hides: the card's Goal, Acceptance criteria (checkboxes
  reflect the markdown), Open questions, full Context, its `spec:` doc (opens in the
  markdown pane), linked cards (click to jump), and the whole trail — how it was
  dispatched, the bound session with its live state, evidence, and every
  provenance-stamped append. Esc, the backdrop, or ✕ close it; nothing is written.

- **The Approval Inbox rail now reaches the bottom of the window.** Its panel
  was sizing to its own content (header + Needs you + Would-have) instead of
  stretching to fill the column, leaving a tall blank gap between the last
  entry and the footer — worse the more the rail's content shrank (e.g. when
  minimized/collapsed).

- **Terminal image rendering (Sixel/iTerm inline images) no longer fails
  silently on every session.** The CSP didn't allow WebAssembly, which xterm's
  image addon needs to decode inline images — every terminal spawn threw an
  uncaught `CompileError` in the console and image output never rendered.
  `script-src` now allows `'wasm-unsafe-eval'` (WebAssembly only, not general
  `eval`).

- **A checkpoint result no longer looks like a passed exam to the teaching
  session.** A mid-lesson checkpoint (`mode: check`) used to send back
  `[capy-lesson] file — 1/1`, byte-identical to a one-question exam, so the
  teaching session could mistake a single practice question for finished
  assessment and record mastery off it. Checkpoint results now arrive marked
  `[capy-lesson] file — checkpoint` and never carry a score (an open checkpoint
  no longer shows a misleading `0/0`); the exam wire format is unchanged.

## 2026-07-10

### Added

- **Closing a roadmap card now writes a dated memory trace and auto-archives
  its bound session — zero typing.** The human Close (Review → Done, still
  human-only) appends a mechanical "Closed \<date\> · evidence" line directly
  onto the card (a durable, dated project-memory entry, with no model call —
  the record is plain fact, never a summary); when the closing card is an
  epic (other cards declare it as their `parent`), a companion entry lands in
  `decisions.md`. The card's bound session, if any, is auto-archived
  (reversible any time via Unarchive or the toast's Undo) — no confirm dialog,
  matching the epic's zero-friction principle.

- **Per-repo model routing policy: dispatch now resolves model + effort from a
  human-owned routing table, never from the agent.** A new folder-scoped table
  (edited in the folder's Startup dialog, alongside a per-kind routing table:
  `scout`, `bug`, `feature`, `review`, `chore`, plus a fallback row) maps each
  card kind to a `{ model, effort }` pair, with operator-approved hardcoded
  defaults (`scout`=haiku·low, `bug`/`feature`/`chore`=sonnet·high,
  `review`=opus·high) when a row is left on "Inherit". Both dispatch paths —
  the per-card confirm and the manifest drain — resolve the SAME table before
  spawning; the confirm additionally shows the resolved model·effort with an
  inline picker to override it for that one dispatch. Whichever value actually
  launches is recorded on the card as a `dispatched-with: model·effort` audit
  line. The table lives in its own `routing-policy.json`, and no MCP verb can
  read or write it — an agent's `submit_manifest` model/effort hint is
  disclosure-only and never controls what actually runs.

- **Dispatch manifest: a new `submit_manifest` verb declares one dispatch batch
  for the operator to review as a single go.** An agent-authored card can now
  auto-dispatch under a live mission grant — but only after it has gone
  through a manifest. The agent lists Ready cards (in drain order,
  optionally overriding substrate/model/effort); the server builds the
  disclosure entirely from disk (title, kind/complexity, readiness gaps, the
  exact boot prompt, a body fingerprint) and parks it in the Approval Inbox as
  a checklist — every card starts checked, and unchecking one before Allow
  leaves it exactly as it was (partial-go, never a denial). The verb itself is
  never silently allowed and never covered by a grant: it always asks. On
  Allow, checked cards are stamped `approved` + a fingerprint of their
  title/spec/body — fields no verb can ever write directly. Cards then drain
  automatically in the declared order, pausing at the WIP ceiling and
  resuming as cards leave In Progress. Editing a stamped card's title/spec/body
  afterward still succeeds (zero friction) but voids the stamp — the fingerprint
  is recomputed from disk at dispatch time, so a changed card falls back to a
  per-card confirm (with a summary of what changed) instead of dispatching on
  stale content. The board shows a discreet "manifest ✓" badge on approved
  cards and a drain counter on the mission-grant strip.

- **The orchestrator contract is now a real doc, and Capy manages its own
  drift-brake guard — zero setup required.** `docs/capy-orchestrator.md`
  spells out what a promoted Orchestrator session may and may not touch
  directly. Backing it, Capy now installs and refreshes a small hook script
  per app boot; when a session is armed (the toggle itself lands in a
  follow-up release), an Edit/Write/NotebookEdit outside that session's
  `.capy/` folder, scratchpad, or project memory is steered back to
  delegation instead of silently landing. The guard fails open by design —
  if it ever breaks, the session just behaves like a normal one, never a
  stuck Claude Code — and coexists cleanly with an operator's own
  hand-rolled hook if they already have one.

- **The orchestrator toggle itself: "Promote to orchestrator" in a session's
  context menu.** Flipping it arms the guard from the entry above for that
  session's real id + folder and injects the orchestrator contract into its
  boot preamble on restart — no more manual flag-file editing. The role is
  now visible state, not a hidden file: an Orchestrator badge on the session
  row, a topbar pill for the selected session, and an `orchestrator` marker
  in `get_fleet`/`get_session`. Demoting (or closing an armed session) disarms
  it and drops the contract on the next boot.

- **Per-repo "Auto-organize conversation into draft cards" toggle** (folder
  context menu, default ON). Every worktree of a repo inherits the setting
  from its main checkout — no re-asking on a pipeline-created worktree.
  There's no enforcement behind it; a session reads its current value as a
  runtime line in its boot preamble and honors the conservative task-smell
  contract in `docs/capy-orchestrator.md` accordingly.

- **Dispatch substrate now actually decides WHERE a card runs — session,
  worktree, teammate, or internal.** A card's `substrate:` field (default
  `session`, agent-proposable via `create_card`) is resolved at dispatch time
  on both paths (the per-card confirm and the manifest drain): `session`
  spawns in the same folder as before; `worktree` cuts a fresh `create_worktree`
  with one branch per card and — fixing a live-dogfood finding — is born
  inheriting the parent repo's agent control (not just grant scope), so an
  orchestrator can read back its own worker's session over MCP; `teammate`
  spawns the same as `session` and records the authoring session as a
  `teammate-of:` audit line; `internal` never spawns a Capy session at all —
  the card stays with the orchestrator, which resolves it with its own
  subagents and advances it via `propose_move`/`move_card` (clicking Dispatch
  on one just shows an informational note, and it's excluded from the
  auto-drain queue so it can never silently consume a grant unit). Both the
  per-card dispatch confirm and the `submit_manifest` checklist gained a
  substrate picker so the operator can override it for that one dispatch —
  the manifest override is written onto the card alongside the `approved`
  stamp, before the drain ever runs.

- **Search your whole project from the file browser.** Type in the panel's new
  search bar to find any file by path — a recursive, project-wide finder that
  respects `.gitignore` (so `node_modules` and build output never show up) — then
  open a match or add it to the chat with one click. Faster than expanding the
  tree folder by folder when you already know part of the name.

- **A file browser panel, built into Capy.** Click "Browse files" in the toolbar
  to open a panel with your project's file tree — confined to the project root and
  respecting `.gitignore`. Expand folders as you go, and add any file or folder to
  the chat with one click, so you can drop a plan or PRD into your prompt without
  leaving Capy or fighting the native file dialog.

- **Drag a file straight onto a session to attach it.** Drag a plan, a PRD,
  anything from your file manager onto a terminal pane and its path drops into
  that session's prompt, ready to send — the same move you'd make in your editor.
  The pane highlights with a "Drop to attach to chat" hint while you drag, so the
  shortcut is easy to find. Works on the main terminal and on every split/helper
  pane; drop several files and each path lands in turn.

### Changed

- **Opening and creating files now uses the in-app file browser instead of the
  native OS dialog.** On Linux the native dialog ignored the project folder and
  opened somewhere random (your home or the last-visited directory). Now click the
  eye icon next to any file in the "Browse files" panel to open it, and use the
  panel's new-file button to create one at the project root — both confined to
  the project, no OS dialog. The separate "Open markdown file…" / "New markdown"
  toolbar buttons are gone; the file browser covers both.

- **The file browser can now open and edit any text file, not just markdown.**
  `.ts`, `.json`, `.yml`, and anything else readable as text opens and edits like
  before; `.md`/`.markdown` still render as formatted prose, everything else shows
  as plain text. Binary files (images, archives, executables) are refused with a
  message instead of corrupting the editor. Clicking a file's name no longer opens
  it — use the new eye icon next to the row (folders still expand on click).

## 2026-07-09

### Added

- **The roadmap board is now agent-owned: `create_card`, `update_card`, and
  `move_card` let a session organize its own board directly, with no per-call
  confirm, in any agent-enabled folder.** A new card is always born in
  `backlog` — status is never an argument. `move_card` can only target
  `backlog`/`ready`/`review`: `done` (the operator's Close, after Review) and
  `in-progress` (only reachable via a real dispatch bind) are impossible to
  request by schema, not merely refused. `update_card` refuses controlled
  fields (`status`/`session`/`evidence`/`provenance`/`approved`) with a clear
  steer naming the right channel, and locks `substrate` once a session is
  bound. Every write is provenance-stamped server-side and capped against a
  runaway loop (a high per-board daily write ceiling). Moving a card to
  `ready` still never starts any work by itself — dispatch keeps going
  through the existing operator confirm/manifest gate.

- **Cards gained a schema v2: `kind` (scout/bug/feature/review/chore),
  `complexity` (trivial/simple/standard/complex), `parent` (one level of
  nesting), and `substrate`.** Creating a card with a `kind` and an empty/short
  body seeds a per-kind delegation-packet template (Objective/Acceptance
  criteria/Out of scope/Evidence to return, plus Repro for bugs, Verdict for
  reviews, Findings for scouts). A new non-blocking readiness lint flags gaps
  like a `standard`+ card missing its Acceptance criteria — surfaced as a
  small badge on the card, never a refusal. The board now shows `kind` and
  `complexity` chips and a `↑ parent` chip on cards that declare them.

- **Notify when your Claude 5-hour usage limit resets.** Opt-in (Settings →
  Notifications → "Usage limit reset"), off by default. When enabled, Capy
  sends a native system notification (or an in-app toast if the window is
  focused) the moment your current 5-hour rate-limit window rolls over.

## 2026-07-08

### Added

- **Usage history's Cost/day chart now shows your REAL spend, computed from
  the Claude Code transcripts already on disk.** A new local, zero-network
  cost engine reads `~/.claude/projects/**/*.jsonl`, dedupes the block-split
  API responses, and prices every request against the published per-model
  rates — replacing the old "notional" figure (which double-counted live
  sessions' accumulated cost) as the primary Cost/day number once real data is
  available. The old notional reading stays visible as a secondary "live"
  figure (it's still the only intraday signal). The Sessions/day chart gains
  the same treatment: "sessions worked" counts distinct sessions with at least
  one priced request that day, alongside the existing peak-live-sessions
  figure. A new "Top models (cost)" list breaks down spend by model, with an
  honest `estimated` flag on any model whose pricing isn't in our table yet
  (priced on a default tier rather than guessed silently). First scan of a
  large history may take a few seconds; every scan after that is instant
  thanks to a per-file cache that only re-reads changed transcripts. The
  "Ask about your usage" chat now sees the same real per-day/model/project/
  session breakdown, so it can answer "what did I spend on X" or "which
  model cost the most" with actual figures instead of only the notional
  daily total.

- **The cost engine prices Fable 5 / Mythos 5, Opus 4.7/4.8, and Sonnet 5 at
  their published rates instead of estimating.** These models previously fell
  to the estimated default tier; they now price exactly (Fable/Mythos 5 at
  $10/$50 per Mtok in/out, Opus 4.7/4.8 at $5/$25, Sonnet 5 at the $3/$15
  sticker rate). Only Opus 4.7/4.8 in fast mode stays flagged as estimated —
  its premium multiplier isn't published yet. Cache writes are also now
  priced by their TTL, matching the CLI exactly: 5-minute cache writes at
  1.25× the input rate, 1-hour cache writes at 2× (older transcripts without
  the breakdown keep the flat 1.25× rate — tokens are never dropped).

- **The real cost engine now understands sessions, not just days/models —
  laying the groundwork for the upcoming Usage BI dashboard.** For every
  session, Capy now computes its full "anatomy" from the transcripts: how
  long it ran, how many real turns/requests/subagents it had, its token
  breakdown and cost per model, its peak context-window usage, and a display
  title reusing the same rename/auto-title/first-message cascade the sidebar
  uses. Closed 5h/7d rate-limit windows are also enriched with which sessions
  and models actually burned that window's spend. Backend-only in this slice
  (a dedicated Usage dashboard screen to browse this data lands next) — no
  new UI yet, just the data layer behind a new `usageBi:snapshot` capability.

- **A full-screen Usage Dashboard — the deep-dive view for "who's spending,
  when, and why".** Open it from the footer's fleet pill ("Open full
  dashboard"): a range/model/project filter bar; five glance KPIs (5h/7d
  window, cost today, sessions today, projected-at-reset); the live 5h
  strip; a cost-by-model trajectory chart (also switchable to rate-limit %
  or sessions); an activity calendar; the existing weekday×hour heatmap;
  ranked Top models/projects/sessions; a **session anatomy** bubble chart
  (duration × cost × tokens × dominant model, subagent count badge) with a
  docked inspector and a deterministic burn-rate insight line; and an
  explorer table that regroups by Days/Sessions/Models/Projects with
  sortable columns. Everything reuses the real cost + session-anatomy engine
  (T47 P5/P6 S1) — no new data collection, one `usageBi:snapshot` call per
  range change, with model/project filters applied instantly client-side.

- **Usage history's 7-day rate-limit chart marks weekly resets, and the 5h
  chart can show individual windows.** A dashed vertical line now appears on
  the 7d chart wherever a weekly window actually closed. The 5h chart gets a
  "By day / By window" toggle — by window renders one bar per closed 5-hour
  window in chronological order, so a 95% window shows beside its 30–40%
  same-day siblings instead of hiding behind the day's peak. Partial windows
  (app was closed during part of them) render as hollow/dimmed bars with a
  note that their recorded peak may undercount.

- **Agent-teams teammates group under their team lead in the sidebar.**
  Sessions spawned as agent-teams teammates no longer show up as flat sessions
  with a raw internal label — they nest under their team lead's row (with a
  teammate-count chip to expand/collapse), or under a collapsible "Team
  session-XXXXXXXX" header when the lead isn't open in that folder. Selecting a
  teammate that's currently being driven by its lead now asks for confirmation
  first, since resuming it locally could conflict with the lead's writes.

### Changed

- **The plan-usage popover now shows everything it knows — and how fresh it is.**
  Each 5h/7d meter is fed by the freshest of its two sources (the statusLine
  cockpit vs the `/usage` poll) instead of a frozen cockpit shadowing fresh
  polls; a window past its reset moment no longer competes. The per-model weekly
  buckets are always listed, and an "updated X ago" line tells you the age of
  what you're reading.

- **Usage history trajectory charts read at a glance on the 7-day view.** Every
  day now gets both an axis label and a value label instead of skipping to 4
  ticks with only the peak and latest called out; 30-day-and-wider charts get
  weekly-spaced axis ticks instead of an arbitrary even split, so the x-axis
  lines up with actual weeks.

- **Usage history chart names and ranges are more honest.** "Sessions / day" is
  renamed to "Live sessions (peak)" — it was never "sessions I ran that day",
  it's the busiest moment's count of sessions with fresh telemetry. Cost/day
  (peak) now carries a subtitle spelling out it's notional cumulative cost, not
  daily spend. The trajectory range picker gains 60d/90d/all, matching the
  plan-fit calculator's ranges.

### Fixed

- **Session telemetry no longer dies silently when a second Capy quits.** The
  exit cleanup now removes the `statusLine` key from `~/.claude/settings.json`
  only when it is exactly this instance's — a dev or verify instance closing
  used to strip the production instance's statusLine, freezing every usage
  number and blanking new sessions' footer HUD until the next restart. A
  periodic self-heal also re-installs the key if anything else removes it.

- **The footer HUD survives a restart.** Per-session telemetry (model, context %,
  cost, lines) is now persisted and restored on launch, so a session that has
  been idle since Capy started shows its last-known numbers instead of only its
  name.

- **Usage history "now" strip no longer reads the 80% mark as a projection.**
  The legend chip is now explicitly labeled `80% mark`, and the projection tick
  on the meter shows its own `~N%` value so it visibly agrees with the "at your
  current pace" text above it — the two used to be the same number in two
  places with nothing tying them together.

## 2026-07-07

### Added

- **The Roadmap board dispatches, tracks, and paces your agents.** Dropping a
  human-authored card into **Ready** now spawns its agent automatically when an
  active mission grant already covers that folder — no per-card confirm — while
  cards outside a grant still ask first. Each card linked to a running session
  shows that session's live state dot, and when a card's work lands on `main` the
  board suggests the move to **Review** for you to approve (an agent still can
  never move a card itself, least of all to Done). The In-Progress column warns
  when you cross the 4–5 simultaneous-supervision ceiling.

- **Project memory now writes its own session digests.** When a session that did
  real work (at least one commit) ends or goes idle, Capy writes an
  evidence-linked digest — commits, files touched, tests — into the project's
  `sessions/` memory, and proposes an updated "where we left off" note in the
  Approval Inbox for you to accept. Your resume cue is never overwritten silently.

- **Capy's agent verbs now work in new sessions with zero setup.** When the MCP
  control server is on, every Claude session Capy launches is auto-wired to it —
  Capy injects the server descriptor plus a server-level allow rule, so the capy
  verbs (fleet board, project memory, mission planning, …) are available from the
  first turn without a per-verb “allow this tool?” prompt. It's purely additive:
  your own MCP servers are untouched, and Capy never restricts them. A new
  **Settings → Control server → “Auto-register in new sessions”** toggle (on by
  default) opts out if you'd rather wire the server up yourself.

- **The core agent verbs are visible from the first turn.** The fleet board,
  project-memory reads, mission planning, and report delivery (`get_fleet`,
  `get_session`, `memory_read`, `memory_query`, `plan_mission`, `open_file`) now
  load immediately in a Capy session instead of hiding behind a tool search — so an
  agent picks up “where we left off” and can plan a fan-out without first hunting for
  the tools.

- **Agents learn what Capy is over the MCP connection itself.** The control server
  now serves a compact self-awareness primer as its MCP instructions — so even a
  session you started outside Capy (one where you added Capy's server to your own
  `claude` config) knows the capy verbs, the “read memory first / plan a mission for
  fan-out” habits, and writes project memory in your app language.

- **“Approve + always allow this verb here.”** Agent-action approvals now carry an
  “always allow this verb in this folder” checkbox. Tick it and that verb (create a
  session, open a report, append to memory, …) runs without a confirm in that folder
  from then on — the rule is written to the folder's `.claude/settings.local.json`
  (Claude Code's own permission file, so it survives restarts and your other settings
  are left intact), and Capy honors it on the next call. The riskier verbs
  (`create_worktree`, `spawn_terminal`) offer it too but leave the box unchecked, and
  mission planning (`plan_mission`) never offers it.

### Changed

- **Session status dots, the Fleet board, and the triage queue now read the
  transcript's own turn markers.** Capy used to guess whether a session was working,
  waiting, or blocked mostly from how recently its file changed — which mislabelled a
  long-running tool as "stuck" and a session paused on a question as "working." It now
  reads Claude Code's own end-of-turn markers and the last thing the assistant did:
  a finished turn reads idle, a running tool reads working, and a session paused on an
  AskUserQuestion / plan approval reads "needs you" — even for sessions running outside
  Capy with no hooks. Live sessions with hooks still trust the hook first; the change
  only sharpens everything else.

- **Better session titles and "what's happening now."** Names now come from Claude
  Code's own title entries — your `/rename` always wins over the auto-generated title,
  and it's picked up even in very long transcripts. The hover preview's summary line
  now shows the latest instruction (the current task or last prompt) instead of the
  first message you ever sent.

- **Context % works without a live tab.** The context-window percentage on session
  rows, board cards, and the hover preview is now computed straight from the
  transcript, so it shows up for every session (and resets correctly after a
  `/compact`), instead of only for sessions with a reporting status line.

- **Hover previews are now hoverable and scrollable.** Moving the mouse into a
  session or folder hover card no longer makes it vanish — the row and the card are
  one hover zone with a short grace delay, so you can move onto the card and scroll
  its contents (for folders, the full "where we left off" memory cue). The wheel
  scrolls the card without dragging the sidebar underneath it.

- **Agents can show you a report without asking every time.** When an agent opens a
  Markdown report in Capy's read-only viewer (the `open_file` action) inside a folder
  you've already allowed for agents, it no longer stops for a per-file approval — the
  same folder already lets agents do more powerful things like starting sessions, so
  asking permission just to _show_ you a file was needless friction. Folders you
  haven't allowed still block it, and the viewer still opens quietly in the background
  without stealing focus. The action is recorded in the agent activity log either way.

- **Project memory is now written in your app language.** Notes agents save to a
  project's memory (the "where we left off" snapshot, decisions, summaries) now follow
  the language set in **Settings → Interface**, instead of whatever language the chat
  happened to be in. Set the app to English and your memory reads in English; set it
  to Português and it reads in Português. Your conversation language is unaffected —
  this only governs what gets written to the project's shared memory.

- **The bento sidebar has more air when a repo card is expanded.** Worktree capsules
  no longer sit right up against the card header or crowd each other — there's a
  touch more breathing room around and inside each capsule, so an expanded card with
  several worktrees no longer reads as "crushed." Long branch names now truncate
  reliably instead of squeezing the rest of the row; hover the capsule for the full
  name. Hovering or selecting a row inside a capsule now highlights an inset "pill"
  instead of a flush, edge-to-edge block, so adjacent rows keep a sliver of
  breathing room between them — and that highlight is now a single uniform color
  instead of showing two tones (a lighter strip around a darker fill). A standalone
  pinned folder (one that isn't part of a repo card) now gets the same outer margin
  a repo card does, instead of stretching edge-to-edge to the sidebar's border while
  cards stayed inset. A repo card's header and its worktree rows (and standalone
  folders) now share one height and width and sit on one even 4px rhythm — between
  cards, inside cards, everywhere — instead of the header standing taller and wider
  than the rows beneath it. Session, terminal, and "+ N idle" rows now step in
  slightly from their folder row, so what belongs to a folder visibly derives from
  it; and the "+ N idle" toggle is now plain text instead of another pill, so it no
  longer masquerades as a session row.

- **Pinned folders that merely live inside another pinned folder no longer look like
  a repo.** A folder like `~` that path-contains several of your other pins (docs,
  sandbox, …) used to render every one of those as a worktree-style capsule, making
  it balloon into one dominating card and read as if it were a git repo. Those pinned
  children now show as a collapsed "N folders" hint under their parent — expand it on
  demand — with a plain indented look that's clearly distinct from a repo's worktree
  capsules.

### Fixed

- **Long session names no longer run off the edge inside a repo card.** A session
  with a very long title (or a pasted command caveat) used to blow the row out past
  the sidebar and get hard-clipped with no ellipsis, because the card's row grid grew
  to fit the text. Those rows now stay within the sidebar and truncate with an
  ellipsis like everywhere else.

- **Agent-created sessions dispatched in a burst all start now.** When an agent (or a
  mission) fired several `create_session` calls back-to-back, only one of them
  actually booted — the others returned "ok" but never became a running session
  (no terminal, no transcript), because starting a session was tied to which row was
  _selected_, and a rapid burst kept overwriting that single selection. Each new
  session now boots on its own background queue, independent of selection, so every
  dispatched session reliably starts. A background session no longer steals your
  current view either — it starts quietly while you keep working.

- **Dead "New session" rows no longer linger as "working" forever.** A session whose
  boot never produced a terminal within ~2 minutes now flips to a visible **Failed to
  start** state (red dot + badge) and drops out of the Fleet board's WORKING section,
  instead of sitting there pretending to work. Right-click the row for **Retry boot**
  (start it again) or **Dismiss** (remove it).

- **The safety downgrade now writes a permission mode current Claude Code
  advertises.** When Capy's safe mode strips `bypassPermissions` from an agent
  boot, it now rewrites it to `manual` (the mode's canonical name since Claude
  Code 2.1.x) instead of the old `default`, which today survives only as a
  hidden alias and could disappear in any release — an invalid mode makes the
  session fail to launch entirely.

- **The sidebar-collapse shortcuts now work reliably on Linux.** **Ctrl+B**
  (collapse the left sidebar) and **Ctrl+Alt+B** (collapse the right panel) were
  firing twice per press — once from the OS menu accelerator and once from the
  in-app fallback — so a toggle just flickered back to where it started. The two
  are now coalesced into a single toggle. Separately, **Ctrl+Shift+B** (switch the
  sidebar to the Fleet board) no longer also collapses the sidebar: shortcuts now
  match their modifiers exactly instead of treating a plainer chord as a match.

- **The markdown pane no longer loses an unsaved draft when the view changes.**
  Typing into a new `untitled.md` and then opening the Roadmap board (or switching
  worktrees) used to discard everything you'd typed — the pane reloaded from disk
  and a never-saved file came back empty. The edit buffer now survives any such
  unmount/remount, so your draft is right where you left it. Closing a pane with
  unsaved edits now warns first (a non-blocking prompt) instead of dropping them
  silently. Saving is still explicit — nothing is auto-written to disk.

- **An agent's "open this file" now lands in the split you're looking at.** When an
  agent opened a markdown report for you (the `open_file` verb) while you had a
  different worktree selected, the pane was created off-screen in the target
  folder's stack — it existed, but you never saw it. The viewer now attaches to the
  **currently selected worktree's** split, so the offer is visible immediately. It
  still opens in the background without stealing your keyboard focus.

- **The session/folder hover preview no longer renders off-screen.** When neither
  side of the hovered row had a full card's width of room (a narrower window), the
  preview could flip to the wrong side and render mostly outside the window, with
  no visible padding. Its position is now always clamped inside the window.

## 2026-07-06

### Added

- **Collapse the sidebars for a full-screen terminal.** Both side columns can now
  be hidden to give the whole width to the terminal. Toggle the left folder/session
  sidebar with **⌘B** (Ctrl+B on Linux/Windows) and the right helper panel with
  **⌘⌥B** (Ctrl+Alt+B), matching VS Code's primary/secondary side-bar shortcuts —
  or click the panel-toggle buttons that live in the top bar. The left toggle is
  always there; the right one appears whenever the session has split panes and
  stays put while collapsed, so a hidden panel is always one click away. Collapsing
  the right panel hides it even when panes are open, and opening a fresh pane brings
  the panel back automatically. Your choice is remembered across restarts.

- **Markdown pane now edits, creates, and can be opened by an agent.** The in-app
  markdown viewer (open a `.md`/`.markdown`/`.txt` from the topbar) grew an
  **editor**: toggle a pane between preview and edit, make your changes, and save
  explicitly with the **Save** button or **⌘/Ctrl-S** (a dot marks unsaved edits;
  a non-blocking prompt guards against discarding them on reload or navigation).
  A new **"New markdown file…"** topbar button creates a file and drops you
  straight into editing it. And agents can now **offer you a report** through the
  `open_file` MCP verb — it opens the file in a read-only viewer **in the
  background without stealing your focus**, behind a light confirm that shows the
  path (or covered by a mission grant). Reads and writes stay confined to your
  known Capy folders, only markdown files, with a size cap — nothing outside the
  known roots can be opened or written.

- **Roadmap board — a kanban over your project memory, where grooming _is_
  dispatch.** Right-click a folder → **Roadmap board** to open a wide, per-repo
  board that reads the cards in `.capy/memory/roadmap/` (1 card = 1 `.md` file) and
  lays them out in five lifecycle columns: **Backlog · Ready · In Progress · Review ·
  Done**. Drag a card between columns and Capy rewrites its `status` on disk (atomic,
  preserving every other field); a `blocked` card shows a badge, not a column. Drop a
  card into **Ready** (or hit **Dispatch**) and Capy offers to spawn an agent for it —
  showing you the generated boot prompt **verbatim** before anything launches, then
  injecting it into a fresh session and linking the card to it. The In-Progress column
  carries a WIP hint (the 4–5 simultaneous-supervision ceiling as a board rule). Two
  safety rails are baked in: an agent never has a channel to move a card (least of all
  to **Done** — that's a human-only Close after Review), and the boot prompt is
  secret-linted + capped server-side before it can be built. Auto-dispatch under a
  grant is a later slice; this one is 100% human-confirmed.

- **Remote push notifications — reach your phone.** A new **Settings → Remote
  notifications** tab lets you register push channels: an **ntfy** topic (install
  the free ntfy app, subscribe to a secret topic, paste its URL) or a **generic
  webhook** (Slack and Discord incoming webhooks work out of the box). When the
  Capy window is unfocused, the same events that fire an OS notification —
  a session needing your input, finishing, or failing — are also delivered to
  every enabled channel, including parked agent-action confirms. Comes with a
  master switch, a pause control (30 min / 1 h / 8 h), per-channel on/off,
  per-event opt-ins, and a "Send test" button. Channel tokens are stored
  locally in an owner-only file and all delivery happens from the main process.

- **Project memory (`.capy/memory/`) with MCP verbs.** A repo can now keep a shared,
  markdown project memory that every session, worktree, and branch of that repo sees —
  no more re-discovering the project from scratch or pointing boot prompts at absolute
  paths. Agents get three tools: `memory_read` (reads `hot.md` — "where we left off" —
  plus the index; gated by the same folder allowlist as `get_session`), `memory_query`
  (a server-side grep for "why did we choose X?"), and `memory_append` (records a dated
  decision or refreshes the snapshot, behind a confirm or a mission grant). Writes are
  body-only (never a card's frontmatter/status), serialized through Capy, and stamped
  with visible provenance (who/when/branch) that Capy derives — never taken from the
  agent. A worktree with no copy of the memory resolves to its main checkout
  automatically; obvious secrets are refused before anything is written. The layout
  scaffolds itself on first write and the index regenerates deterministically, so your
  files stay yours — editing or deleting them by hand never corrupts anything.

- **See a project's memory without leaving Capy.** Two new surfaces bring the memory to
  you. **Hovering a folder** in the sidebar now shows a "Where we left off" cue — the top
  of that repo's `hot.md` — so you can re-orient in about a second without a click. And a
  new **Project memory** pane (open it from a folder's right-click menu) shows the repo's
  memory in a split, with tabs for **hot**, **decisions**, and a **timeline** of session
  digests (newest first, each with its author/branch provenance). When a digest names its
  originating session, clicking it reveals and selects that session in the sidebar; if that
  session isn't loaded, it says so instead of jumping nowhere. Both read the same
  repo-shared memory (a worktree resolves to its main checkout), are cached off the sidebar
  hot path, and the pane reopens on boot like an editor tab. The timeline is empty until
  automatic session digests land — it shows an honest empty state until then.

- **Agent-control inheritance is now discovered at the friction, not hidden in Settings.**
  When an agent tries to act in a worktree of a repo you already allow (the canonical
  `.claude/worktrees/*` layout), instead of a dead-end "folder not allowed" you now get a
  contextual approval — **Always**, **Only this**, or **Deny**. _Only this_ lets agents
  work in that worktree for the rest of the app session (covering a whole fan-out without
  re-asking) and is forgotten on restart; _Always_ turns on the "Worktrees inherit agent
  control" setting and marks that worktree, so its repo's worktrees inherit from then on
  (revoke the repo to revoke them all in one go). Nothing is granted unless you click, an
  unanswered prompt still denies, and a prompt shown without the picker (e.g. one parked
  in the Approval Inbox while you were away) can only ever grant "Only this" — never the
  global setting.

- **Read markdown files in a viewer pane, without leaving Capy.** A new
  **Open markdown file…** button in the topbar (next to Split) opens a `.md`
  right in the split — rendered with the app's own typography instead of raw
  text, so an agent's report or a repo doc no longer forces a trip out to your
  editor. Headings, code blocks, tables, blockquotes and links all render;
  external links open in your browser, in-document `#anchors` scroll in place,
  and relative `.md` links browse within the pane. The pane reopens on the next
  launch, and only files inside your known Capy folders can be opened. Markdown
  is sanitized on the way in (no scripts, no inline event handlers, no remote
  images), so opening an untrusted report is safe.

- **New worktree dialog can now check out an existing branch.** A **Mode** toggle
  lets you pick **New branch** (the previous behavior — name a branch and pick a
  base) or **Existing branch**, which checks out an existing local or remote branch
  into a fresh worktree — the natural way to review a pull request. The worktree is
  named after the branch, the live preview shows the real mode (including a detached
  checkout when the branch is already open in another worktree), and setup/seed still
  run as usual. (The agent MCP verb already supported this; the UI just never did.)

- **New `stuck` session state.** A session that's working but has produced no output
  for more than 3 minutes (with no live sub-agent explaining the silence) now shows a
  distinct **hollow red dot** in the sidebar and its own **Stuck** section on the Fleet
  board — instead of silently going grey as if idle. Hover it for "Working but no output
  for a while — may need a look."

- **Supervision-load counter in the footer.** A discreet `● N` in the footer shows how
  many live sessions are working or waiting on you right now. It hides at zero; the
  tooltip notes that comfortable supervision tops out around 4–5 concurrent agents.

### Changed

- **"Open subfolder" is now a lazy tree instead of a flat dump.** Opening a
  folder's subfolder picker used to list every subfolder up to four levels deep
  at once — unusable in a real repository. It now shows only the top level,
  collapsed; click a chevron to expand a folder and load just that level on
  demand. Start typing and it switches back to the familiar flat search across
  all levels. Arrow keys walk the tree (→ expands / steps in, ← collapses /
  steps out).

- **Agents are told to batch fan-out through one approval.** The in-session Capy
  guide now explains that for a batch of actions (several worktrees and sessions at
  once), an agent should call `plan_mission` first — one approval grants the whole
  batch — instead of triggering an approval prompt per action.

- **Actions under a mission grant now report the budget left.** When an agent action
  auto-runs under a mission grant, its success acknowledgement now echoes the grant's
  remaining budget (and its id) — so a fan-out knows how many actions the mission has
  left without a separate check, and stops guessing when it's about to run out.

- **The in-session guide that tells agents what Capy can do is now kept accurate by
  contract.** Sessions run with a short doc describing Capy's capabilities (the
  Approval Inbox, MCP verbs, worktrees, and so on). A change to the agent-facing MCP
  surface must now update that doc in the same change — enforced by a CI gate, the way
  the changelog already is — so an agent won't be left unaware of a capability it
  should be using or offering you. As the first pass, agents are now told to read the
  remaining grant budget from action acknowledgements and to offer opening Markdown
  reports in Capy's viewer.

### Fixed

- **Pinned folders that live inside each other now nest in the sidebar.** If you
  pinned a folder and then pinned one of its subfolders (e.g. `~/x` and `~/x/y`)
  without them being git worktrees, both used to sit loose in a flat list. The
  child now tucks under its containing parent, one indent level in. Deeper chains
  flatten to a single level on purpose — pinning `~/x`, `~/x/y`, and `~/x/y/z`
  puts `y` and `z` both directly under `x`, never a three-deep staircase. Git
  worktrees of one repo keep grouping flat under their repo header, unchanged.

- **`capy .` now reveals the folder it opens.** Opening a folder from the terminal
  (`capy .` / `capy <path>`) pinned it to the sidebar but didn't bring it into view,
  so on a long list — or a nested subfolder — it looked like nothing happened. Capy
  now expands that folder and scrolls it into view. This happens only for the CLI
  flow; an agent pinning a folder over MCP still never moves your selection.

- **Agent-launched sessions submit their first prompt reliably.** When an agent
  created a session with an initial prompt, the prompt was pasted the instant the
  process spawned — before Claude's startup banner finished printing — so on a
  fan-out you'd sometimes see paste-escape gibberish smeared across the banner, or
  a prompt left sitting in the composer waiting for you to press Enter. Capy now
  holds the prompt until the composer is actually ready (Claude's own start signal,
  or the banner going quiet), then pastes and submits it cleanly.

- **Agent model choice is now honored at launch, not just echoed.** Asking an
  agent-created session to run a specific model (e.g. `haiku`) was acknowledged
  with that model but the session still launched on your global default — the
  requested model was dropped on the way to the spawn. The choice now reaches the
  launched session, and the acknowledgement is derived from what's actually sent so
  it can't claim a model the session didn't start with.

- **Claude config editor no longer writes values Claude Code rejects.** The
  **Terminal UI mode** setting offered "Fullscreen" and "Inline", but current
  Claude Code only accepts `default` and `fullscreen` — picking "Inline" wrote a
  value that `/doctor` flagged as invalid. The options are now **Default** and
  **Fullscreen**. Sweeping the rest of the catalog against the installed
  `claude` turned up two more stale entries, also fixed: **Default permission
  mode** dropped the removed `bypassPermissions` and gained `dontAsk`, and
  **Chat retention (days)** no longer lets you enter `0` (Claude Code requires a
  positive number).

- **Startup options: the launch `--permission-mode` choices match your installed
  Claude Code.** The Startup options form (Settings and per-folder) offered a stale
  `default` mode and was missing `manual`. It now lists exactly what `claude --help`
  accepts — **acceptEdits · auto · bypassPermissions · manual · dontAsk · plan** — so
  a launch can no longer be built with a mode Claude Code rejects. (The neutral
  "Default" pill still means "pass no flag and use Claude's own default".)

- **The sidebar dot and the Fleet board now always agree.** The same session used to
  show green **Working** on the board while its sidebar dot went grey (idle) mid-tool-call
  — two surfaces guessing activity from the same signals with opposite rules. Both now
  read one shared classifier, so a long, quiet tool call reads **Working** (not a grey
  lie), and only crosses into **Stuck** once the silence is genuinely glance-worthy.

- **An orchestrator with live sub-agents no longer looks idle.** A session whose main
  transcript is quiet while its spawned sub-agents keep working (e.g. multi-agent
  red-teaming) was listed as **Idle** on the board. A session with any live sub-agent now
  correctly counts as **Working**.

## 2026-07-05

### Fixed

- **Mission grants work now: `plan_mission` no longer rejects every call.** The
  one-approval fan-out flow (grant a bounded scope once, then create N worktrees
  and N sessions with no per-action prompts) was dead on arrival: the server
  dropped the tool's arguments before validating them, so every `plan_mission`
  call failed with `BAD_ARGS … received undefined` and the approval never
  appeared. The grant arguments now reach the gate intact, and a new seam test
  guards every MCP verb against this class of silent argument drop.

## 2026-07-04

### Added

- **Folder identity: rename, auto-label by branch, and a hover card.** Right-click
  a sidebar folder to **Rename…** its label (clear the field to reset to the folder
  name), or toggle **Use branch as name** so a worktree whose directory name differs
  from its branch shows the branch instead (a custom name always wins). Hovering a
  folder now opens a card — like the session preview — showing its branch, whether
  it's the main worktree or a linked one, its path, session count, last activity,
  and (for a git folder) its uncommitted-change count and how far it's ahead/behind
  its upstream.

- **Agent-control badge on the sidebar.** A folder you've granted MCP agent
  control now shows a small robot icon on its row (hover it for a reminder), so
  you can see at a glance where an agent is allowed to act without opening the
  right-click menu.

- **Create or open a subfolder from the folder menu.** Right-click a folder in the
  sidebar for two new actions: **New folder…** creates a subfolder inside it and
  pins it (already organized under the right repo), and **Open subfolder…** opens
  a searchable picker of the folder's subfolders (scanned a few levels deep,
  skipping `node_modules`/`.git`/`vendor`/`dist`/`target`) so you can pin a nested
  folder in two clicks instead of leaving Capy to run `capy .`.

- **Worktrees can inherit agent control (opt-in).** A new Settings → Control server
  toggle ("Worktrees inherit agent control", off by default) lets a worktree created
  in a repo you already allow — via an agent's `create_worktree` or the New worktree
  dialog, in the canonical `.claude/worktrees` layout — inherit that control instead
  of asking you to grant it again. Every create still discloses it with an opt-out
  checkbox, and revoking a repo's agent control revokes its inherited worktrees in
  one step. Off by default, it changes nothing; fail-closed as ever.

- **Sessions can know they run inside Capy.** A new Settings → General toggle
  ("Make sessions aware of Capy", on by default) injects a short, versioned
  environment doc into every Claude session's `--append-system-prompt`, so the
  session knows about the MCP verbs it can call, the footer image gallery, the
  Approval Inbox, and worktrees — and can guide you through the UI. It composes
  with (never replaces) your own append system prompt and never touches Claude's
  default system prompt. Turn it off anytime; the hint is honest about the small
  token cost (cached as system prompt).

- **Interface scale.** A new control in Settings → General zooms the whole UI —
  typography and icons together — from 80% to 150%, for comfort and
  accessibility. It applies instantly and is saved to `settings.json` (as
  `uiZoom`, next to the terminal font size), so it sticks across restarts. The
  terminal scales along with everything else; the existing Terminal → Font size
  still fine-tunes the terminal on top of that.

- **Language selector in Settings.** Settings → General now has an Interface
  section where you can pick the app language — System default, English, or
  Português (Brasil). "System default" follows your OS language; a specific choice
  is applied instantly and remembered across restarts. Find it by searching
  "language", "locale", "idioma", or "língua".

### Changed

- **Removed the Team view from the sidebar.** The sidebar's view switch is back to
  two modes — folder tree and Fleet status board. Agent-team hook plumbing (the
  footer's "N waiting for you" indicator) is untouched.

- **Contribution gates in CI.** Pull requests now fail fast on the contract slips
  that used to slip past review: a change under `src/` without a `CHANGELOG.md`
  entry (bypass with the `no-changelog` label for pure refactor/test/docs), an
  `en.json` ↔ `pt-BR.json` translation-key mismatch (reported by key name and
  file, no more cryptic type error), and unformatted code (`prettier --check`).
  CI also cancels superseded runs, caches the Electron download, and uploads the
  Playwright trace/screenshots when an e2e fails. See `CONTRIBUTING.md`.

### Fixed

- **A newly pinned worktree now groups under its repo right away.** Pinning a
  folder that's a worktree of an already-listed repo used to leave it as a loose
  top-level row until Claude wrote a session under it; the sidebar now reads its
  git branch and repo at pin time (and backfills folders pinned before this
  change on next load), so it collapses under the shared repo group immediately.

- **Startup options now stack instead of silently dropping.** When both a global
  and a per-folder (or per-session) **Append system prompt** or **Pre-prompt** were
  set, the lower scope used to overwrite the higher one — your global instructions
  vanished the moment a folder set its own. They now **accumulate** (global text
  kept, the more specific text added after it), and the **Extra directories**,
  **Allowed/Disallowed tools**, and **MCP config** lists **merge** across scopes
  instead of replacing. Scalar options (model, effort, permission mode, flags) still
  override as before. The Startup form shows a note on these fields so the additive
  behaviour is clear.

- **"(inherited)" hints stay correct and live.** The Startup dialogs now read the
  inherited values from a single source (the main process) so the per-folder and
  per-session dialogs can't drift apart, and the hints update on the spot when the
  underlying config changes while a dialog is open.

- **New worktree dialog no longer jumps around.** The Target/Base/Mode preview
  box is now always visible (with neutral placeholders before you type), so
  typing the branch no longer materializes the box and pushes the footer down.

- **Base ref is now a picker, not free text.** The New worktree dialog lists the
  repo's local and remote branches in a dropdown (grouped Local/Remote), so you
  can pick the base to branch from instead of typing its name from memory.

- **Settings no longer resizes when you switch tabs or search.** The dialog now
  has a fixed size derived from the window, so moving between General, Usage
  history, and Interceptor — or searching with no results — keeps it steady
  instead of collapsing or growing mid-screen.

- **Switching theme now repaints split and helper terminals too.** An already-open
  terminal in the right-side split kept its old palette when you changed theme;
  now every live terminal recolours on the spot, and one that was off-screen
  during the switch picks up the new palette when you return to it.

- **The footer now fills in right away for a new session.** Starting a fresh
  session left the footer blank until the first turn; it now shows the model,
  context, and cost within seconds of launch by matching the session to its
  telemetry by folder, before the session is written to disk.

- **Clicking a repo group header now collapses the whole group.** For a repo with
  several worktrees, clicking the group header used to expand or collapse each
  inner folder's session list instead of hiding the group; it now folds the whole
  group away behind its header, leaving each folder's own expanded/collapsed state
  untouched for when you reopen it.

- **Agent-launched sessions now honour the requested model.** When an agent starts
  a session through the control server and asks for a specific model or effort,
  Capy applies it — including when the request arrives as a JSON string — and the
  reply now echoes which model and effort will actually launch, so the agent can
  confirm it took instead of silently getting your global default. A malformed
  override (wrong shape or a disallowed field) is now refused with a clear,
  actionable error rather than being dropped in silence.

- **An agent's initial prompt now submits on its own.** A session launched by an
  agent with an initial prompt used to type the prompt into Claude's input box
  but wait for a human to press Enter — with several worktrees, that was one Enter
  each, defeating the hands-off flow. Capy now waits for the pasted prompt to
  settle and submits it automatically (with a safety retry), so large multi-line
  prompts go through even on a busy machine.

- **New worktrees now branch from the folder you point at.** Creating a worktree
  through the control server used to branch from the main checkout's HEAD even
  when you pointed it at a different worktree, so stacking a new branch on top of
  in-progress work silently started from the wrong commit. It now cuts from the
  passed folder's own tip, and the reply echoes the base and branch it created so
  an agent can confirm where the worktree came from.

## 2026-07-03

### Added

- **Open a folder from the terminal.** `capy .` (or `capy <path>`) opens and pins
  that folder in the sidebar, like `code .`. If Capy is already running it pins
  into the existing window and focuses it instead of launching a second one.

- **Usage history was rebuilt to read at a glance.** The tab now opens with four
  headline numbers (last 30 days) — times near the 5h cap, peak 5h (+7d), your
  busiest time of week, and peak cost/day — followed by a live "right now" strip,
  the trajectory charts, the plan-fit calculator, a "when you use it" heatmap, and
  the chat.

- **A live "right now" strip.** Bridges the footer telemetry into the history:
  your current 5h window, when it resets, and — at your current pace — roughly
  where it lands by reset.

- **The 24h trajectory is a live line, not bars.** The 5h/7d charts draw the
  sawtooth of each reset as a filled area; daily views stay as bars.

- **Plan-fit shows the distribution, not just percentiles.** Every 5h window's
  peak is a dot — one row as observed, one projected onto the compared plan —
  against an 80%/100% axis, so "how many would blow past the limit" is something
  you see, not read out of a table.

- **A "when you use it" heatmap.** Weekday × hour of your average 5h usage over
  the last four weeks — spot your heavy blocks and schedule around resets.

- **Suggested questions in the usage chat.** One-tap chips ("When do I use it
  most?", "Would Max 5× be enough?") instead of a blank field.

- **The trajectory charts are now readable without a legend.** Each shows its
  current value in the title ("today 66%"), labels the peak and latest bars with
  their value, draws reference lines at 80% and 100% on the rate-limit charts,
  gives every bar a hover tooltip (day · value), and labels the day axis — so you
  can tell which bar is which day and what it's worth.

- **The plan-fit calculator now answers in plain words.** Under the verdict, a
  one-sentence read reports the number people actually ask about — "N of your M
  5h windows would have blown past the limit" — plus the projected p95, and the
  table gains an **exceed** column. A new **"Smallest plan that fits"**
  recommendation scans every tier deterministically and names the cheapest one
  your observed peaks fit into.

- **The calculator has a recency scope** (30d / 60d / 90d / all, default 60d) —
  months-old usage no longer weighs the same as last week's when judging whether
  a plan fits you today.

- **Reuse a session's context elsewhere without hunting the JSONL.** The session
  right-click menu has a new **Copy context digest** — it copies a portable
  markdown block (folder · branch · summary · first prompt · the last few turns)
  you can paste straight into a fresh session, a doc, or an issue.

- **Capy surfaces sessions you forgot.** A session that's waiting on you and you
  haven't looked at in ~10 minutes rises into a "Return here" zone at the top of
  the sidebar — click to jump back, or dismiss to clear it. The zone stays
  invisible until there's actually something to return to.

- **Capy auto-blocks obviously-catastrophic commands (Sentinel).** In an
  intercepted folder (hook responder active), a small, conservative set of
  clearly-destructive shell commands — `rm -rf /` or `~`, `dd` onto a raw disk,
  `mkfs`/`wipefs`, a fork bomb, `chmod 777 /`, force-push to `main`/`master`,
  `curl … | sh` — are auto-denied before they run. When it blocks one, a red
  toast + OS attention tells you what was stopped and why (never silent), and it's
  logged in the Approval Inbox's **Would-have** tab. It's deny-only and
  deliberately conservative: it never allows anything, and a false positive just
  costs a retry, never data loss (in shadow mode it only previews what it would
  have blocked).

- **Agents can choose the model for a session they start.** The `create_session`
  MCP tool now takes an optional `model` / `effort` (capacity knobs only — never a
  permission flag), so a mission can spawn, say, a cheap Haiku session in a fresh
  worktree. The choice is shown in the approval disclosure you already see (which
  previously named a model the tool couldn't actually accept).

- **Grant an agent a bounded "mission" — approve once, not every action.** With a
  single approval an agent can now run a set of actions (create worktrees, start
  sessions, spawn terminals) in named folders without asking you each time — capped
  by a budget (a max number of actions) and a timer (a TTL), with every action still
  logged. See every running mission in Settings → Control server (MCP) → **Active
  missions** (goal, folders, verbs, a budget meter, and the minutes left) and, at a
  glance, in a compact strip atop the Approval Inbox. Revoke any mission in one click
  from either place; it dims to `expired`/`revoked` the moment its budget or timer
  runs out. Anything outside the mission's folders or verbs still parks in the
  Approval Inbox for a per-action Allow/Deny.

- **Turn the Approval Inbox on for trusted folders, one at a time.** The
  interceptor can now actually hold tool calls for you — but only where you say so.
  Flip the hook responder to **active** in Settings and a trust ramp appears: switch
  on the folders you trust one at a time (or flip **Trust all folders** for the whole
  fleet), and every other folder keeps quietly logging instead of blocking. Before
  you commit, open the Approval Inbox's new **Would-have** tab (or right-click a
  folder → **Intercept tool calls here**) to preview, in a shadow log, exactly what
  it would have held — so going live is a calm, reversible step, never an
  all-or-nothing switch.

- **Agent confirms no longer die on a 30-second timeout.** A privileged MCP
  action that needs your sign-off used to auto-deny after 30s — so anything you
  weren't watching failed silently. Now, if you're away, the request waits (up to
  30 min) and the agent gets a pending handle it can poll via the new
  `get_approval` tool; the action runs only when you actually Allow. Still fails
  closed on a genuine no-answer (quit / no window).

- **Approve an agent's action from the Approval Inbox when you get back.** When
  you're away, an agent's confirm no longer flashes a modal you'll miss — it parks
  in the Approval Inbox with a chime and an OS notification (clicking it opens the
  Inbox), and it counts toward the inbox badge and the window title. Each parked row
  is quiet by default; expand it to review the full disclosure — the prompt, the
  requested flags, and the exact `sh -c` commands — and only then Allow or Deny. So
  you always see the commands before approving, and the request waits for you instead
  of dying on a timer. (The security chime and attention always fire, even if you've
  muted session notifications.)

- **`list_worktrees` now reflects real git, not a stale registry.** The MCP read
  is derived live from `git worktree list` per known repo — each worktree's branch,
  short HEAD, whether it's agent-controllable, and whether it has uncommitted
  changes — optionally scoped to one folder, instead of echoing the fleet board.

- **`get_fleet` returns a bounded, filterable board.** Agents no longer get the
  whole fleet as one giant blob — the snapshot is capped to the most-recent
  sessions by default (and says when it truncated), with optional `activeOnly`,
  `sinceMinutes`, and `limit` filters to focus on what matters.

- **`create_worktree` can check out an existing branch (not just create one).** The
  MCP verb takes an optional `ref` — an existing local or remote branch (or
  commit-ish) to check out into the new worktree, instead of always branching from
  `from:`. If that branch is already checked out in another worktree, it detaches
  at its commit instead of failing. This unblocks per-PR fan-out (one worktree per
  existing PR branch); the operator's confirm shows exactly which ref is checked out.

- **Control-server denials now tell the agent how to proceed.** When an MCP tool
  call is refused (folder not agent-allowed, path outside known repos, server
  off), the error now carries a plain-language explanation and concrete next
  steps instead of a bare code — so an agent stops retrying blindly and asks you
  for exactly the right grant.

- **The footer tells you when a teammate is waiting on you.** When a team session
  has blocked teammates, a small amber "N waiting on you" indicator appears in the
  status bar, so the team view answers "who needs me?" at a glance instead of only
  showing structure.

- **Create a git worktree from the folder menu.** Right-clicking a git folder now
  offers a **New worktree…** action that opens a dialog where you name the branch
  and (optionally) a base ref. Before anything runs, Capy previews the exact plan —
  the target folder, resolved base, whether it's a new branch or a delegated
  create, which files get seeded, and the setup commands that will run — with live
  per-stage progress while it builds. If it can't proceed (branch already checked
  out, target exists, no commits yet…) it tells you up front instead of failing
  halfway.

- **Remove a git worktree from the folder menu.** Right-clicking a linked
  worktree folder now offers a red **Remove worktree** action that opens a confirm
  dialog. You can optionally delete its branch too. If the worktree has
  uncommitted changes or unpushed commits, removal is blocked until you turn on a
  **Force** toggle that spells out that the work will be discarded — so nothing is
  thrown away by accident. The main worktree (the repo itself) is never offered
  for removal.

### Changed

- **Settings has a searchable side nav.** The Settings tabs moved from a row
  across the top to a vertical list down the left, with a search box on top that
  filters the list as you type — search by a tab's name or by what it holds
  ("sound", "font", "theme", "model", "endpoint"…) to jump straight to it.

- **Settings search finds individual settings, not just tabs.** Type "font",
  "sound", "trust", or "theme" and the search now lists the actual setting (with
  the tab it lives on); clicking it opens that tab, scrolls the setting into
  view, and briefly highlights it.

- **The hook responder (interceptor) has its own Settings tab.** The
  off/shadow/active mode selector and the per-folder trust ramp moved out of the
  crowded General tab into a dedicated **Interceptor** tab. The Session-state
  hooks switch stays under General → Integrations.

- **The cost chart is labeled "Cost / day (peak)"** — it reports the day's peak
  running fleet total (real per-day spend is coming with the JSONL cost engine).

- **The scary "N windows were only partly observed" warning is gone**, replaced
  by a compact coverage note inside the calculator ("X of Y windows in scope
  fully observed") that no longer grows forever.

### Fixed

- **"Reveal in folder" in the Pasted-images gallery** now reveals the actual image
  file in its cache folder — it previously opened Capy's settings folder instead.

- **Usage-history charts show their real colors again.** The trajectory bars were
  silently rendering black — the threshold palette (green under 80%, amber
  80–95%, red at 95%+) never applied because SVG bars ignore background-color
  classes. They now paint via SVG fills.

- **The "24h" trajectory really is the last 24 hours.** It used to show the last
  600 samples regardless of age, which could stretch over weeks of sparse usage.

- **Days in usage history follow your local timezone.** Daily rollups were cut at
  UTC midnight, so evening work (UTC−3) leaked into the next day's bar.

## 2026-07-02

### Added

- **Agents can pin an existing folder into your sidebar.** With the MCP control
  server enabled, an agent can call `adopt_folder` to bring an existing directory
  into Capy (so its sessions show up) — it needs your one-click approval like any
  other agent action, creates/changes nothing on disk, and the folder still isn't
  agent-actionable until you grant it separately.

### Changed

- **The control server's safety model is now solely "every agent action asks
  you."** The MCP tool-call gate carried never-enforced per-resource concurrency
  limits and a rate cap that never actually ran (the server fed them empty state),
  so they bounded nothing. They've been removed; the real bound is unchanged —
  every agent mutation (create a session, spawn a terminal, create a worktree)
  still requires your explicit confirmation, and the separate teammate-spawn cap
  (the one path that runs without a per-action prompt) is untouched.

- **The "create worktree" approval now shows the exact setup commands that will
  run.** When an agent asks to create a git worktree, the repo's `WORKTREE.md` can
  run setup commands in a shell. The Allow/Deny confirm now discloses those
  commands verbatim (with a warning that they run with your full access), so you're
  approving what you can actually see — not a blank "create a worktree". The
  security policy documents this as a trust boundary.

- **The iTerm2/teammate bridge only hosts the `claude` CLI now.** When you let a
  session host agent-teams as native panes, the bridge would run whatever binary
  the incoming request named. It now accepts only the `claude` launcher (or its
  versioned binary) and requires a well-formed teammate argument list, so a
  malformed or hostile request can't get an arbitrary program to run on your
  machine. Legitimate teammate hosting is unaffected.

- **Hardened a few more security boundaries (mostly invisible).** Endpoint auth
  tokens are now written owner-only (`0600`) instead of world-readable; the two
  local helper servers (hook bridge, iTerm2/teammate bridge) now use the same
  constant-time token check and loopback Origin/Host guard as the control
  server; and the plan-usage poller resolves the `claude` binary explicitly and
  scrubs its environment (fixing a "usage unavailable" case on macOS Dock
  launch). Worktree setup commands from a `WORKTREE.md` now shell-quote the repo
  name and base ref so an oddly-named directory can't inject a command.

### Fixed

- **Your settings carry over from the pre-rebrand build.** The app's config
  directory moved when it was renamed from its old identity to Capy, which would
  have silently reset your theme, pinned folders, sort, and other preferences on
  first launch. Capy now migrates the old config into the new location once, on
  first boot — only into a fresh install, never overwriting anything, and never
  for throwaway/isolated instances.

- **The control server writes its audit log far less aggressively.** It used to
  rewrite the entire audit file on every single agent tool call; it now coalesces
  bursts into one write (with a final flush when the server stops), so a chatty
  agent no longer thrashes the disk on the request path.

- **Hosting Claude teammates as native panes no longer jams after a while.** When
  you let a session host agent-teams as panes, the teammate limit counted every
  pane ever opened instead of the ones still open — so after enough came and went
  it would refuse new teammates permanently. The limit now tracks only live panes
  and frees a slot as soon as a pane closes.

- **The selected session row uses your theme's accent color.** It was hardcoded
  to the default terracotta, so on other themes the highlight was the wrong color;
  it now follows the active theme.

- **Keyboard nav in the command palette and dialogs no longer leaks to the
  sidebar.** Arrow keys and Enter in the ⌘K palette (or an open dialog/menu) used
  to also move the hidden sidebar cursor — so Enter could select a background
  session and swap the terminal underneath you. Overlays now capture the keyboard
  exclusively, and arrow/Enter no longer drive the sidebar while you're typing in
  a text field or renaming a session inline.

- **The live one-line "pulse" describes the work, not the transcript.** The
  summary prompt now explicitly forbids meta-narration ("I see a message…", "the
  transcript shows…", mentioning the log or its language) and asks for a concrete
  present-continuous action, so the pulse reads like "refactoring the auth guard"
  instead of commentary about the text it was given.

- **A split/helper pane opened right as you switch folders no longer disappears.**
  A rare race where loading a folder's saved pane layout could overwrite a pane
  that was just created is closed.

- **Plan-usage history honors your opt-out reliably at startup.** A boot-time race
  could let a sample get written (and a rate-limit window reconcile against empty
  state) before the setting finished loading; the load is now single-flight and
  its on-disk state is written atomically.

- **Creating a New session no longer leaves a duplicate row in more cases.** The
  earlier fix covered the common dash-folder case; this closes the structural
  remainder — when the folder can't be matched by its slug (path drift, an
  adopted worktree, a not-yet-loaded folder), the placeholder is now reliably
  collapsed into the real session by its id instead of surviving next to it. One
  session = one row.

- **A session's status no longer briefly reverts when the sidebar refreshes.** If
  a session changed state (e.g. finished working, got a new one-line pulse, or
  auto-named itself) at the same moment a background sidebar rescan was in flight,
  the rescan could overwrite it with the older value. The rescan now reads the
  current live state, so the newest status sticks.

- **Session activity is read more reliably from disk.** Rapid writes could make
  the file watcher emit the same transcript lines twice (double-triggering
  auto-name / live-pulse and inflating counts); per-file reads are now serialized
  so each line is seen exactly once. And after a `/compact` rewrites a session's
  history, the watcher no longer replays the entire transcript as if it were new
  activity — it re-syncs quietly and only surfaces genuinely new lines afterward.

- **Opening and closing sessions repeatedly no longer slowly leaks memory.**
  Clearing the terminal view and coming back (⌘W then reselecting, or switching
  between a cloud and a local session) used to leave an orphaned terminal and a
  duplicate output subscription behind each time, which compounded over a long
  session. The terminal cache is now a true singleton, so returning re-attaches
  the exact same live terminal — no orphans, no double-rendering, scrollback
  intact, and the session's process is never disturbed.

- **A closed or finished session no longer reports "working" forever.** The live
  status shared with an agent fleet (and the sidebar dot) is now reconciled with
  whether the session's process is actually alive: when you close or a session
  exits, its state is cleared, so the fleet stops showing a dead session as busy.
  And a just-started session now shows its real state the moment it lands on disk,
  instead of staying blank until its next action — including raising the "needs
  you" ping if it blocked while starting up. (No time-based guessing: a genuinely
  long build still reads as working, and a 20-minute blocked session stays blocked.)

- **The welcome screen's "Add folder" button now works, and you can drop a
  folder onto it.** On first run (no folders yet) the primary button was inert
  and the "drag a folder here" hint did nothing. The button now opens the
  Add-folder dialog, and dropping a directory anywhere on the welcome screen
  pins it — the same as dropping onto the sidebar.

- **Rename from a session's right-click menu now works.** Choosing **Rename**
  in a session's context menu now selects that session and focuses its title
  for inline editing — the same thing the rename shortcut does. Previously the
  menu item did nothing.

## 2026-06-30

### Added

- **Pasted-images gallery — see (and reuse) the screenshots you pasted into a
  session.** When a session has pasted images, a new `🖼` pill appears in the
  footer; click it for a grid of those screenshots, newest first. Each one has
  **Open** (system viewer), **Reveal in folder**, **Copy** (to the clipboard),
  and **Re-attach** — which drops the image's path back into the running session
  so Claude picks it up as `[Image #N]` again, no re-screenshotting. It's a
  read-only window over Claude Code's live image cache: the pill hides when a
  session has none, appears as you paste (no tab switch needed), and nothing is
  copied or kept (the cache is cleared when the session is pruned).

## 2026-06-29

### Added

- **Live status for any terminal agent, not just Claude Code.** Run `codex`,
  `aider`, or another CLI agent in a folder terminal and Capy now lights the same
  status dots you already get for Claude sessions — **amber when it needs you**
  (a `(y/N)`-style approval prompt), **green while it's working**, idle
  otherwise. Capy reads the bottom of the terminal and matches it against a
  per-agent manifest, so a glance at the sidebar tells you which agents are
  blocked on you — across any agent, not only the ones that support hooks.

- **Tunable detectors.** The built-in agent manifests (codex, aider) can be
  overridden or extended by dropping a `<agent>.json` file in
  `~/.claude/detectors/`; it hot-reloads with no restart. Claude Code sessions
  are unchanged — they stay hook-driven and are never screen-scraped, so their
  state remains exactly as precise as before.

- **Terminal agents in the fleet.** If you turn on the Control server (MCP),
  your folder terminals running a recognized agent now appear in the fleet an
  agent can see — with their live state, the same redaction (folder alias only,
  never a transcript), and the same per-folder allowlist gating as your Claude
  sessions. So "wait until something needs me" works across any agent, not just
  Claude.

## 2026-06-26

### Added

- **Capy control server (MCP) — let a Claude agent see and drive your fleet.**
  A new **Control server (MCP)** tab in Settings turns on a local server that an
  agent (a Claude session, today; the cloud later) can connect to over the
  loopback only. With it on, the agent can **see** your fleet (sessions,
  worktrees — paths and transcripts redacted) and **act**: create a new session,
  spawn a split terminal, or create a git worktree that shows up in your sidebar
  on its own, grouped under its repo. **Off by default**, and designed so an
  agent can never act behind your back — see the two entries below. This is the
  foundation for "Claude managing Claudes": the agent's tool calls become real
  Capy actions instead of fragile keystrokes.

- **Per-folder agent control — a folder is off-limits to an agent until you opt
  it in.** A new **Allow agent control** toggle in a folder's right-click menu
  is the gate: an agent's create/spawn tools are refused for any folder you
  haven't explicitly allowed, and reading a folder's transcript is gated the
  same way. Nothing is allowed by default. The same opt-in is also editable as a
  per-folder allowlist in the new Settings tab.

- **Agent action confirms — every agent action is held for your Allow/Deny and
  shows you exactly what it will do.** When an allowed agent asks to create a
  session, spawn a terminal, or create a worktree, Capy holds it in a fleet-wide
  confirm that **discloses the effective prompt (verbatim), the permission mode,
  and any non-default flags** before you decide — approving something you can't
  see isn't a control. It **auto-denies** if you don't respond, so an agent can
  never act by waiting you out, and there is no "skip confirm" mode. Agent-spawned
  sessions also can't inherit a skip-permissions posture or recursively spawn
  their own agents. Every gated call is recorded in a read-only audit log.

- **Conductor skill — turn a session into a fleet orchestrator.** With the control
  server on, any Capy session already has the `capy` tools; the bundled
  **capy-conductor** skill gives it the playbook to read your fleet and set up work
  across folders/worktrees on your behalf (each action still held for your Allow).
  "Claude managing Claudes," gated by the same per-folder + per-action consent.

- **Team board — see a Claude agent-team at a glance.** A third sidebar view
  (next to Folders and Board) groups the fleet by **agent-team**: each team's
  members shown as cards with a live state dot (working / idle / blocked), the
  agent type and model, and a task rollup. It's **observe-only** — read straight
  from `~/.claude/teams` on disk (paths and prompts redacted), so it works for
  any team whether or not Capy hosts it.

- **Remote control — reach a session from your phone.** A **Remote control**
  toggle in a session's right-click menu relaunches it with Claude Code's
  Remote Control bridge (the phone/QR pairing). Before it turns on, Capy
  discloses the trust model plainly: the chat and tool results can be pulled
  off your device, but **actions still need the Allow at your desk** — Capy's
  control server never leaves your machine.

- **Host agent teams in Capy — teammates as native split panes (experimental).**
  Claude Code's agent-teams can spawn "teammates," but the split-pane view only
  works in iTerm2 or tmux. A new **Host agent teams in Capy** toggle in a
  session's right-click menu lets Capy host them itself, cross-platform: flip it
  on, and when that lead spawns teammates they dock as **native Capy panes** —
  full-width horizontal split strips, no iTerm2, no tmux. Per-session opt-in;
  hosted teammates run gated (no
  Capy control server, permission-downgraded) and can't recursively host their
  own. Capy fills the cross-platform gap by speaking iTerm2's pane protocol.

### Changed

- **"Capy" everywhere in the UI.** The last user-visible "om2tab" mentions — the
  statusline-conflict warning and the Hook responder description/hint — now read
  **Capy**.

- **Hardened the app's security boundary.** Mostly invisible changes that reduce
  risk: the "this folder no longer exists" terminal notice no longer runs your
  folder path through a shell (closing a command-injection vector when you open a
  session whose directory was renamed or deleted); Capy's own settings are
  written only inside its data directory; links you click in the terminal open
  only with `http`/`https`/`mailto`; and the main window can no longer be
  navigated away from the app UI.

### Fixed

- **Hosting a teammate could fail with "An object could not be cloned."** When a
  lead spawned a teammate, the pane sometimes never started. The spawn now sends
  a plain snapshot of the teammate's launch spec across the process boundary, so
  hosted teammates start reliably.

- **Split panes no longer render blank after you switch away and back.** A
  helper/teammate pane that was detached and re-attached (switching sessions, or
  a hot reload) could come back blank; it now forces a repaint on re-attach.

- **"Host agent teams" and "Remote control" no longer get silently turned off.**
  Toggling either flag could be undone when the folder was rescanned in the
  background; the per-session flags now survive a rescan.

- **A hosted lead keeps its full PATH.** Hosting teammates no longer strips
  shared system directories (e.g. `/usr/bin`) from the lead's PATH, so ordinary
  commands inside that session keep working.

- **No more truncated `~/.claude/settings.json`.** When Capy removes its own hook
  and statusLine entries on exit, it now writes atomically and keeps a backup, so
  force-quitting mid-write can't corrupt the file it shares with Claude Code.

- **The app survives an unexpected background error.** An uncaught exception no
  longer takes down every running session — it's logged and the window stays up.

## 2026-06-25

### Added

- **Restart session — pick up a new skill, MCP server, or settings change
  without losing the conversation.** A new **Restart session** item in a
  session's right-click menu kills its running `claude` and relaunches it with
  `claude --resume`, so it re-reads everything Claude only loads at startup (a
  skill you just installed, an edited `settings.json`, a new MCP server). The
  conversation is preserved — it resumes from the transcript on disk — so it's
  safe and needs no confirmation; a toast confirms it took effect. The item only
  shows for sessions that are actually running (nothing to restart otherwise).

- **Approval Inbox — allow or deny a tool call from one place, without hunting
  for the tab.** When the **Hook responder** is set to **Active**, a tool call
  Claude is about to run is held briefly and surfaced in a fleet-wide **"Needs
  you"** overlay (a new `inbox` button in the Topbar — with a count badge when
  something's waiting — plus **⌘⇧A** and a command-palette action). Each row
  shows the exact call (`Bash(rm -rf build)`, `Edit(.env)`, an MCP tool…), its
  folder, and the session; **Allow** / **Deny** answer it and Claude continues —
  no tab switch. Click the row body instead to jump to that session. It's a
  fast-path while you're watching: an approval you don't answer within a few
  seconds falls through and Claude prompts in its own terminal as usual, so a
  session is never blocked. Answering in the terminal (or the session moving on)
  clears the row automatically. Requires the session-state hooks to be on and the
  responder in Active (both default off/observe) — the empirically-verified
  foundation for the upcoming per-folder firewall and auto-approve rules.

- **Hook responder — the groundwork for Capy answering Claude Code hooks.** Until
  now the session-state hooks were a strict observer: Capy could _see_ a tool call
  or a permission prompt but never act on it. A new **Settings → Integrations →
  "Hook responder"** control adds an **off / shadow / active** mode (it's disabled
  until the session-state hooks are on, since there's nothing to answer otherwise).
  **Shadow** (the default) computes and logs what Capy _would_ decide but never
  changes the session — a safe preview. **Active** lets Capy answer a hook with a
  decision (allow/deny a tool call, inject context). It's built to fail safe: a
  hard internal deadline well under Claude Code's hook timeout means a slow or
  buggy rule can never freeze a session — it just falls through to "no decision."
  On its own this control does nothing yet (no rules ship with it); it's the
  foundation upcoming features (an approval inbox, a per-folder firewall,
  auto-approve trust rules) build on.

- **Open a plain terminal on any folder.** Right-click a folder and pick "New
  terminal" to launch a shell bound to that folder's directory — for git, builds,
  creating worktrees, or anything else — separate from Claude sessions. Terminals
  appear in a "Terminals" group under the folder (you can open several), each with
  a close (✕) button, and they keep running in the background when you switch away
  just like sessions do. They're reachable by the sidebar's arrow-key navigation
  (↑/↓ to land on one, Enter to open it), not just the mouse.

- **Copy a session's identifiers from the right-click menu.** Right-click any
  session and pick "Copy session ID", "Copy transcript path", or "Copy --resume
  command" to put its session ID, its transcript path on disk, or a ready-to-paste
  `claude --resume <id>` command on your clipboard.

- **The terminal can now display inline images.** Tools that emit iTerm2 imgcat
  (OSC 1337 `File=`) or Sixel graphics — a generated diff, plot, chart, or
  diagram — render as a real image inline instead of a wall of escape codes, in
  both the main session terminal and split helper panes.

### Changed

- **Older / archived / new-session actions moved onto the folder row.** Instead of
  three rows at the bottom of an expanded folder ("Show N older sessions", "Show N
  archived", "+ New session"), the folder row now carries a compact inline cluster
  on its right — a clock + count to peek older sessions, an archive box + count for
  archived, and a + for a new session — so the actions are reachable without
  expanding the folder. Each has a tooltip, and the count you're currently peeking
  is highlighted. This replaces the folder's plain session-count number.

- **Toasts with an action are clickable anywhere on the card.** A toast that
  offers an action (like "Session completed → Open") is now one big hit target
  instead of just the small link, and keyboard users can focus the card and press
  Enter or Space. Toasts without an action stay passive.

- **Settings → Claude config: Save and Discard moved into the dialog footer**
  next to Close, so unsaved edits are obvious and the actions are where you
  expect them, instead of buried below the advanced raw editor.

- **Settings controls are consistent and legible in every theme.** Every on/off
  setting is now the same **switch** (a filled track when on, empty when off), so
  the state reads at a glance without depending on a subtle colour difference —
  previously some screens used a faint outlined "Enabled/Disabled" pill that all
  but vanished in low-contrast themes, and one screen used a different switch
  entirely. "Pick one of N" settings (sort order, model, effort, permission mode,
  retention…) are now one shared button group, and the plain HTML dropdowns on the
  Claude config tab (permission mode, terminal UI mode) and elsewhere became those
  same buttons. The description text under each setting moved up one step on the
  contrast scale across the **whole** app, fixing help copy that was nearly
  unreadable in themes like Tokyo Night and Dracula. Under the hood these are now
  three shared components, so the look can never drift between screens again.

- **Session notifications now follow your focus.** When the Capy window is
  focused you get a quiet in-app **toast** (bottom-right) when a session needs
  you, finishes a turn, or fails — with an **Open** button that jumps straight to
  that session. When the window is **not** focused, you get a native **OS
  notification** instead, to pull you back. Previously the notification for the
  session you had selected while focused was simply swallowed — so a turn ending
  right in front of you gave no signal at all.

- **The chime no longer beeps for the session you're staring at.** The
  attention sound still plays for background sessions (and whenever the window is
  unfocused), but the session that's selected _and_ in front of you gets a silent
  toast — no beep on every turn. Background sessions, which is what you actually
  need to be pulled toward, still chime.

### Fixed

- **Shift+Enter inside the terminal no longer steals focus to another session.**
  Pressing Shift+Enter to insert a soft newline while composing a multi-line
  prompt could jump focus out of the chat and switch to whatever session the
  sidebar's keyboard cursor was on. The keystroke was leaking past the terminal
  to the app-wide Enter shortcut; it's now fully consumed by the terminal, so
  Shift+Enter only adds a newline.

- **Creating a New session no longer leaves a duplicate, stuck "New session"
  placeholder.** In a brand-new folder whose path contains a dash (for example a
  `TASK-0240-build-footer` worktree), the placeholder now correctly becomes the
  real session once it lands on disk, instead of sticking around next to it as a
  second row wired to the same conversation (so `/clear` no longer hit both). As
  a side effect, the stuck placeholder no longer blocks clicking "New session"
  again. A background refresh can also no longer briefly resurrect a placeholder
  you just closed.

- **Switching sessions no longer leaves the terminal blank or half-rendered.**
  Re-attaching a cached terminal now forces a full repaint on attach instead of
  waiting for your next keystroke, so the transcript shows immediately.

- **Split terminal / shell sessions failed to spawn on Windows.** The shell PTY
  fell back to `/bin/bash`, which doesn't exist on Windows (`File not found`). It
  now uses the platform's shell (`%ComSpec%`, else PowerShell) on Windows and
  `$SHELL`/bash elsewhere.

- **Claude sessions on Windows dropped you into `cmd.exe` instead of Claude.**
  The CLI was resolved to the npm `claude.cmd`/extension-less shim; launching a
  shim through ConPTY lands in an interactive `cmd.exe`, so the session rendered
  but wouldn't take input. Resolution now targets the real `claude.exe` shipped
  in the package's `bin/` (and probes Windows install locations), so sessions
  spawn the actual Claude TUI.

- **The "original directory is gone" notice is now cross-platform.** It hard-coded
  `/bin/sh` + `printf`; on Windows it now renders via PowerShell.

- **Worktree grouping no longer breaks on Windows.** The slug-based `repoId`
  fallback used `path.join`, which rewrites paths to `\` on Windows and so didn't
  match the forward-slash `repoId`s used elsewhere; it now preserves the path
  convention and matches either separator.

## 2026-06-23

### Added

- **Open the active session's folder straight from the Topbar.** Two new icon
  buttons next to the split/Terminal button reveal the selected session's folder
  in your OS file manager ("Open folder") or open it in VS Code ("Open in VS
  Code"). If the `code` CLI isn't on your PATH, the VS Code button is a quiet
  no-op rather than an error.

- **New "Fleet status board" view groups every session by what it's doing, not
  by folder.** Toggle it from the new button in the sidebar header (or ⌘⇧B, or
  the command palette) to see your whole fleet sorted into urgency buckets —
  **Needs input**, **Errored**, **Working**, **Idle**, **Done** — so "what needs
  me right now?" is one glance instead of a hunt across folders. Each card shows
  the session, its folder, a live one-line summary (the Haiku pulse or the last
  terminal line), and per-state detail: the failure reason with reset countdown
  for errored sessions, how long a session has been blocked, or its context %.
  The folder view stays the default and is unchanged; the plan-usage panel and
  footer remain in both views.

- **A new Settings → Claude config tab edits `~/.claude/settings.json` from a
  form.** Known options (model, chat retention, the co-authored-by trailer,
  default permission mode, TUI mode) render as toggles, selects, and inputs with
  a "Set vs. default" marker and a docs link, instead of hand-editing JSON. Keys
  Capy doesn't recognise — and the `hooks`/`statusLine` it manages — are shown
  read-only and preserved untouched when you save. Edits target the global file
  only. Saving writes a one-key diff, never a whole-file reserialize.

- **Run a session against a local model as an Anthropic-API fallback.** A new
  **Settings → Endpoints** tab lets you register custom Anthropic-compatible
  endpoints (e.g. a local model in LM Studio at `http://127.0.0.1:1234`). Pick one
  as the **Provider** in the global Startup options, a folder's startup dialog, or
  a New session dialog — the cascade is the same global → folder → session as every
  other launch option. A session pointed at a custom endpoint doesn't touch the
  Anthropic API at all, which makes it a real fallback when the API is down. When a
  provider other than Anthropic is active, the Model field becomes free-text (the
  opus/sonnet/haiku aliases don't map to a local id) and the Topbar shows a badge
  with the endpoint name so there's no silent quality downgrade — a local model is
  a resilience play, not a match for Opus.

- **Capy now shows the Claude service status, so you can tell "is it me or
  Anthropic?" at a glance.** A calm health dot sits in the footer (green when
  operational, amber when degraded, red on an outage, grey when offline). Click
  it for a panel with per-component health, any active incidents, scheduled
  maintenance, and a link to the full status history. You also get a native OS
  notification when an incident opens, worsens, or resolves — even while Capy is
  in the background — with a toggle in **Settings → Integrations** to mute them.

- **Usage history + BI: a new "Usage history" tab in Settings.** Capy now
  durably captures the quota telemetry that used to vanish on quit (cost,
  context, 5h/7d rate-limit) — reusing the per-turn statusLine data, so it costs
  nothing extra. The tab shows **trajectory charts** (5h / 7d / cost per day /
  sessions per day, over 24h / 7d / 30d), a **plan-fit calculator** that
  deterministically projects your observed rate-limit peaks onto another plan
  tier (with a verdict, a manual ratio override, and a "quotas as of …"
  disclaimer), and an on-demand **chat over the aggregated data** (default
  Haiku, configurable). The account-wide 5h/7d percentages are kept distinct
  from local-only cost/session counts, partial windows (app was closed) are
  flagged and excluded from the calculator, and capture is opt-out with a
  configurable retention window. Storage is daily-rotated JSONL under
  `~/.claude/om2tab/usage-history/`.

- **The sidebar sections now collapse like VS Code's Source Control panel.**
  Click the **FOLDERS** or **ACTIVE ELSEWHERE** header (or the chevron on its
  left) to fully fold that section away, hiding its folder list while the
  header — with its count — stays put. Each section's collapsed state is
  remembered across restarts. A text filter temporarily reopens both sections so
  search results are never hidden behind a collapsed header.

### Changed

- **Theme picker moved to its own Settings → Appearance tab.** The theme grid
  now lives in a dedicated **Appearance** tab (right after General) instead of
  being stacked at the top of the General tab, so General is shorter and the
  theme picker is easier to find.

- **The "Add folder" dialog is now just folder + name.** The "other worktrees"
  multi-select is gone — Capy is folder-first, so adding a project pins exactly
  the folder you pick and any sibling git worktrees show up on their own as you
  use them. One less step to add a project.

- **The sidebar header no longer shows the Capy logo and wordmark.** The header
  is now reserved for navigation — the folders/board view switch and search — and
  the brand appears only on the onboarding, empty-state, and Settings surfaces.

### Fixed

- **The app could fail to open (and once froze the machine) on large session
  histories.** On launch the folder scan read and parsed every transcript in
  `~/.claude/projects/` at once — with hundreds of un-indexed sessions that meant
  opening hundreds of files simultaneously, stalling startup. The scan now reads
  at most a handful of files at a time, so the window appears promptly regardless
  of how many sessions you have.

- **Auto-update no longer breaks startup on a malformed version.** An invalid
  version string disabled the updater with an unhandled error during boot; the
  version is corrected and the updater now fails safe (logs and skips) instead.

- **The footer's `/compact` warning now says why it lit up.** The bare warning
  triangle in the status bar had a hover-only tooltip and fired for two different
  reasons — leaving you guessing why it appeared at, say, 53% context. It now
  shows a visible micro-label next to the icon: "near /compact" (red) when
  context is ≥95% and full, or ">200k tokens" (accent) when the session crossed
  the 200k-token tier on a large context window. The tooltip is condition-specific
  too.

- **Startup options are actually saved now.** Setting a global or per-folder
  startup option (model, effort, …) silently did nothing — the config never
  reached disk, so a new session never inherited it and a per-folder override
  reverted to the global value when you reopened the dialog. Two causes: the save
  passed a reactive object the IPC couldn't serialize (so it was dropped before
  ever being written), and the per-folder key was derived non-deterministically
  (a symlinked or transiently-unreadable path could make the save key differ from
  the load key). Both are fixed: saves now persist reliably, and a folder override
  round-trips and is inherited by new sessions in that folder.

- **Writes to `~/.claude/settings.json` can no longer clobber the file.** Every
  edit Capy makes (hooks, statusLine, and the new Claude config tab) now goes
  through a hardened write layer: the new contents are written to a temp file and
  atomically renamed into place, concurrent writes are serialised per-file, the
  prior contents are backed up first, and a settings file that exists but fails
  to parse aborts the write instead of overwriting it — closing the regression
  that once shrank this file from 9 KB to 162 bytes.

## 2026-06-22

### Added

- **You can now sort folders by name instead of recent activity.**
  **Settings → Sidebar → "Sort folders by"** adds a `Recent activity` / `Name`
  toggle. The default (`Recent activity`) is the old behavior — the most-recently
  active folder floats to the top. Switch to `Name` and the folder order is fixed
  alphabetically, so a folder **stops jumping to the top** every time one of its
  background sessions emits output. The choice is per-machine and persists across
  restarts.

- **You're now pinged when a background session finishes.** When Claude wraps up
  a turn in a session you're **not** looking at, Capy raises a native OS
  notification ("Session completed") with the same sound as the "needs input"
  ping — so you can leave the window and still be pulled back when a long task is
  done. It never fires for the session you're currently staring at, and is muted
  by the existing **Completed** toggle in **Settings → Integrations**. Clicking
  the notification now also **expands the session's folder** in the sidebar, not
  just selects it, so a session inside a collapsed folder is actually visible.

- **Archive now works.** Right-clicking a session and choosing **Archive** puts it
  away: the row leaves the normal sidebar flow, its live terminal is stopped, and
  it stops counting toward the folder's session count and the attention badge.
  Unlike **Delete**, the transcript on disk is untouched — archiving is fully
  reversible. Archived sessions reappear under a **"Show N archived"** row inside
  their folder; right-click one and choose **Unarchive** to bring it back. The
  archived state persists across restarts.

- **Open in new tab now works.** Right-clicking a session and choosing **Open in
  new tab** resumes it in a new split pane beside the session you're viewing, so
  you can watch two sessions at once. It opens in the current session's split
  stack with the target session's own folder as the working directory. Hidden for
  synthetic and cloud/bridge sessions (nothing to resume); if the same session is
  already the main pane or already open in the split, it's left as-is rather than
  starting a second conflicting `claude --resume`.

### Changed

- **Resize dividers are thinner.** The draggable bars between the sidebar and the
  content, and between the terminal and the helper-stack, now show only a 1px
  hairline instead of a full 6px colored bar — while the 6px drag target (and its
  terracota hover) stays exactly as wide as before, so dragging feels the same.

- **Topbar is leaner.** The Fullscreen, More, and Close buttons were removed from
  the top-right of the session header — the More button was a disabled placeholder,
  and fullscreen is still a press of **F11** away.

- **Startup options now show what they inherit.** When you open a folder's or a
  session's startup options, inherited values are surfaced as the effective config
  — for choices (model, effort, …) the inherited option itself is highlighted, and
  free-text fields show it as a `(inherited)` hint — so a session also reflects the
  folder's settings on top of the global. Inheritance is live: only the fields you
  actually change are saved at that level, editing a level never writes upward, and
  changing the global later updates everything that didn't override it.

- **Split panes close themselves when the session ends.** Typing `exit` (or
  `Ctrl-D`, or quitting Claude) in a split-stack terminal now removes that pane
  automatically instead of leaving it parked on a dead `[session ended]` line.
  An exit in the first couple of seconds — the signature of a broken
  `claude --resume` — still keeps the pane and shows the "stale session" toast so
  you can read what happened.

- **Split panes now have a title bar.** Each terminal in a split stack gets a thin
  header at the top — like the bottom status bar — showing a type icon (shell,
  Claude, or fork), the folder name, and a clearer **close** button. It replaces
  the faint floating `X` in the corner, which was easy to miss against the
  terminal content. The header also doubles as the **resize handle** — drag it to
  resize the pane against the one above — so the separate divider line and the
  empty gap above the stack are gone.

- **Split button spawns a terminal on click.** The topbar `>` button now opens a
  new shell pane in the active session's split immediately — no dropdown. It used
  to open a "New shell" / "Fork current session" menu; forking moved to the
  sidebar right-click (**Fork session**), leaving "new shell" as the button's only
  job, so it just does it.

### Fixed

- **The 5h / 7d usage percentages in the footer are no longer dimmed.** They sat
  in a darker, harder-to-read tone than the labels next to them; now the whole
  fleet summary (labels, percentages, and cost) reads at the same bright HUD tone,
  with the percentage only changing color as a signal near your rate-limit cap.

- **The app no longer freezes when you create a session or run several at once.**
  Starting a **+ New session** (or a fork) used to trigger a full re-scan of every
  transcript on disk in the background, which could hang the whole window —
  terminal included — for a noticeable beat, and also reshuffled the sidebar.
  Creating a session now updates the row in place with no re-scan, bursts of file
  changes are coalesced instead of each forcing a scan, and the scan itself now
  re-reads only the handful of files that actually changed since last time
  (everything else is cached). Busy multi-session days stay smooth.

### Removed

- **The "Claude is typing…" pill no longer clutters the topbar.** The active
  session already shows a green pulse dot on its sidebar row, so the duplicate
  pill next to the title has been removed.

- **The animated sidebar mascot is gone.** The pixel-art character that sat
  between the folder tree and the footer, along with its **Settings → Sidebar →
  Mascot** show/hide toggle, has been removed.

- **The redundant "Resume" item is gone from the session right-click menu.**
  Clicking a session in the sidebar already resumes it, so the menu entry — which
  did nothing — only added noise.

## 2026-06-19

### Added

- **Customize how Claude starts (Claude Boot).** A new **Settings → Startup** tab
  lets you set default `claude` launch flags — model, effort, permission mode,
  Claude-in-Chrome, system / append / pre-prompt, allowed/disallowed tools, extra
  directories, MCP config, and more — plus a free-form "extra arguments" escape
  hatch. The same form is available **per folder** via the folder right-click menu
  ("Startup options…"), where empty fields inherit the global config and any field
  can override it (e.g. always launch one project with `--chrome`, or seed it with
  a pre-prompt). Session-breaking flags (`--resume`, `--print`, …) are blocked.
  Applies to new sessions.

- **Configure a session before it starts.** Clicking "+ New session" now opens a
  small launch dialog (Cancel / Start) instead of spawning immediately. An
  **Advanced** disclosure expands it to the full launch-options form, applied as a
  one-shot override **just for that session** — layered on top of the global and
  per-folder config (session wins). Start is focused, so Enter launches right away.

- **Theme picker with 9 new themes.** Settings → Appearance now has a visual theme
  picker (a grid of live mini-previews) — before this there was no way to switch
  theme from the UI at all. Added Catppuccin Mocha & Latte, One Dark, GitHub Dark
  & Light, Gruvbox Dark & Light, Nord, and Monospace, alongside the existing
  Default Dark, Light, Tokyo Night, and Dracula.

- **Terminal follows the theme.** Each theme now defines the full 16-colour ANSI
  palette, so Claude/bash output in the terminal recolours to match the active
  theme instead of always using xterm's built-in colours.

- **Footer status bar.** A persistent full-width bottom bar (VS Code style) shows
  the active session's model · context% · branch · effort · cost · ±lines (plus a
  near-`/compact` warning) on the left, and plan usage / rate-limit (5h · 7d ·
  total cost · tabs) on the right — click it for the full meters. It updates live
  as you switch sessions and as a turn runs. Replaces the sidebar Plan usage panel.

### Changed

- **Footer status bar is easier to read.** The session telemetry chips (context,
  branch, effort, cost, ±lines) now sit at the brighter model-label tone instead
  of the dim quaternary gray — the footer reads as a HUD. Context still turns
  accent/red as it nears `/compact`.

- **Sidebar no longer shows git branches.** The per-folder branch badge and the
  per-session branch chip were removed now that the active session's branch lives
  in the footer — the sidebar stays focused on session identity without the
  duplicate, noisy branch labels.

### Fixed

- **No more spurious "Update failed" toast.** A benign background update-check
  failure (first-run 404 when no release is published yet, or simply being
  offline) no longer surfaces a red error toast dumping raw HTTP headers. Errors
  are now only shown once an update was actually found and is downloading.

## 2026-06-18

### Added

- **Sound on OS notifications.** Notifications (a session needing input / finishing /
  failing, and a new Claude Code version) now play a short sound, with a **Sound**
  toggle in Settings → Notifications (on by default).

- **Live session pulse (Haiku).** Opt-in (Settings → Intelligence, default off): each
  session gets a one-line "doing now" generated by Haiku from its latest turn, shown
  in the hover preview. Cheap and bounded (one call per turn-end, content-hash cached
  ~15s, `--model haiku`). The sidebar-row subtitle + per-folder pause follow.

- **Out-of-window attention signal.** The number of sessions waiting on you
  (`needs-input`) now appears in the window title — "(3) Capy" — and on the
  OS dock/taskbar badge, so the fleet signals you even when the window is hidden.
  Degrades gracefully where the OS has no badge (the title is universal).

- **StopFailure reason badges.** When a session stops because of a rate-limit,
  overload, or billing error (not just "needs you"), the sidebar row shows _why_ —
  "Rate-limited · resets in 12m", "Overloaded", or "Billing" — instead of a bare red
  dot. Read from the Claude Code StopFailure hook (observer-only).

- **Auto-name new sessions (Haiku).** Opt-in (Settings → Intelligence, default off):
  a "+ New session" gets a short title + one-line summary generated by Haiku from its
  first prompt, replacing "New session" in the sidebar and topbar. Cheap and bounded
  (one call per session, content-hash cached, `--model haiku`); a `/rename` always
  wins. Built on a reusable headless Haiku service.

- **statusLine telemetry UI.** A per-session context-% chip on each sidebar row
  (quiet by default, turning amber/red as the context window fills), a
  cost / context / lines block with `thinking` / `effort` / `near /compact` badges in
  the hover preview, and a Settings → Integrations opt-out toggle for the telemetry.

- **Settings → Changelog tab.** The Settings dialog is now tabbed (`General` |
  `Changelog`); the Changelog tab renders this file in-app.

- **Changelog contract.** `CLAUDE.md` now requires every feature/fix to add a
  dated entry to `CHANGELOG.md` in the same change.

- Claude Code update awareness: a dot on the Settings gear + an OS notification when a new Claude Code version ships, with the full changelog in a new **Settings → Claude Code** tab (links out to the official changelog).

### Changed

- **Renamed to Capy.** The app is now **Capy** (`capy.run`). The visible name
  ("Claude Sessions") and the internal app identity have been rebranded — "Claude"
  now appears only as a descriptor ("session manager for Claude Code"), never as the
  product name. This includes the window title, native menu, onboarding, README, and
  design system.

- **Heads-up — this rebrand changes the app's identity and is a deliberate, pre-public
  break.** The application id (`dev.capy.app`), Windows AppUserModelId (`com.capy`),
  packaged product name (`Capy`, so artifacts become `Capy-x.y.z.AppImage`), and the
  GitHub release repo (`capy`) all changed. As a result, **existing installs will not
  auto-update to the renamed build** (the updater feed and app id no longer match), and
  because the product name moves the OS app-data directory, **local app data (theme,
  sidebar width, locale, and other preferences) resets** on the rename. Old hook and
  statusLine markers are still recognized for cleanup, so no stale config is left in
  `~/.claude/settings.json`.

### Fixed

- **Sidebar no longer stutters when a session is active.** Each Claude turn made
  the file watcher fire a burst of events that each launched its own concurrent,
  full re-scan of every session transcript on disk, ending in a wholesale rebuild
  of the entire sidebar — the periodic freeze/lag right before the list visibly
  reordered. Reloads are now single-flight (a burst coalesces into one scan
  instead of several overlapping ones), and the sidebar is reconciled in place:
  folders and sessions that didn't change keep their identity, so only what
  actually changed re-renders.

## 2026-06-17

### Added

- **statusLine telemetry substrate.** Installs a Claude Code `statusLine` that
  dumps the per-turn JSON blob to `<userData>/statusline/inbox/`; om2tab tails it
  for zero-token per-session cost / context-window telemetry and a fleet-wide
  rate-limit cockpit (5h / 7d), retiring the frequent `claude -p /usage` poll.
  Non-destructive install (never clobbers a user's own statusLine), opt-out, and
  exit-cleanup.

- **Feature exploration v2** — a 40-feature menu across 6 themes
  (`docs/superpowers/specs/2026-06-17-feature-exploration-v2.md`) plus 7
  implementation-ready, TDD-structured design specs (statusLine telemetry, Haiku
  service + auto-name, Clawd quick-wins, StopFailure badges, attention badge,
  session trash, remote-control toggle).

### Fixed

- Corrected the stale `CLAUDE.md` note claiming `pt-BR.json` was unpopulated — it
  is at full parity with `en.json`, and the `vue-tsc` schema breaks if a key is
  added to only one locale.
