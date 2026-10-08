# Scheduler

A worker is a prompt that runs itself on a timer, in one of your folders, without you opening a session. Point it at a repo and tell it what to do — "check if there's a new PR and review it," "look for anything stale in the roadmap" — and it fires on its own cadence, unattended, for as long as Harnu is running.

## What a worker actually is

Every time a worker is due, Harnu starts a brand-new, invisible `claude -p` process: it reads the worker's prompt, does its work, prints a result, and exits. It is **not** a session — it never shows up in your sidebar, in the fleet, or in the Approval Inbox, and you cannot open it mid-run to see what it's typing. Harnu only keeps the process's own stdout and turns it into a run record afterward.

Nothing carries over from one run to the next. A worker has no memory of its previous tick unless you turn on **Remember last run** (below), or the prompt itself is written to check something persistent, like the repo or the roadmap board.

## Opening it

Click the **Scheduler** pill in the footer. It reads quietly ("Scheduler") when nothing is running, and turns green with a live count ("2 running") the moment a tick is in flight — click it from either state to open the takeover. The × in the header, or selecting a session in the sidebar, closes it again.

Inside: a worker list on the left, grouped **Enabled** and **Off**, and the selected worker's detail on the right, with **Runs** and **Settings** tabs.

## Creating a worker

**New worker** adds one with safe defaults — `observe` mode, haiku, low effort, every 30 minutes, no run-on-boot — and drops you straight into Settings with the Name field focused.

**A new worker is created switched off.** Creating one and arming one are two separate acts: fill in the folder and the prompt at your own pace, then flip the toggle in the detail header when you actually want it running. Nothing fires before that, and a worker with an empty prompt never fires even if it is switched on.

Once you do arm it, it runs on the **next beat** rather than waiting out a full cadence — so a worker you enable at 14:02 with a 30-minute schedule ticks within about thirty seconds, not at 14:32.

### The fields

**Identity**

- **Name** — whatever helps you tell workers apart in the list.
- **Folder** — required. This is the tick's working directory, and it also decides which skills the tick can be given: Harnu's own bundled ones (whatever this folder has enabled) plus the repo's own `.claude/skills/`. Pick from the same folder list the sidebar uses, or "Choose another folder…" to browse for one Harnu doesn't know about yet. If the folder has no bundled skill turned on, the form warns you right there.
- **Prompt** — free text, and the only place the worker's job lives. There's no separate "attach a skill" field: type `/` and name the skill inline — see "Naming a skill in the prompt" below.

**Schedule**

- **Every _N_ minutes** — the cadence. See "What a cadence actually costs" below before you set this aggressively.
- **Run on boot** — fires once when Harnu starts, in addition to its regular cadence. If several workers have this on, Harnu staggers their first runs a few seconds apart rather than firing them all in the same instant.
- **Remember last run** — off by default. When on, the next tick's prompt gets the previous run's result prepended: `Last run: <previous result>`. It costs a few extra tokens and is the cheapest way to stop a worker from repeating itself, short of writing state-checking logic into the prompt.
- **Notify me** — `Silent` (the default), `On failure`, or `Every run`. See "Deciding how much you want to hear" below; the short version is that `Silent` is not "no notifications", it's "nothing per tick".

**Execution**

- **Model** / **Effort** — the usual choices (opus/sonnet/haiku/fable; low through max).
- **Timeout** — seconds before Harnu kills a tick that's still running. Default 300 (5 minutes). A killed tick is recorded as `timeout`, not `error`.

There is no **Provider** picker here, and there is no transcript toggle. Both used to exist; neither did anything. The Provider selector was saved with the worker and then never read on the way to spawning the process, so every tick ran against the Anthropic default no matter what it said — a control promising a bill it could not move. The transcript toggle only switched the process's output format, and nothing anywhere wrote a transcript down. Every tick runs against the Anthropic default and records one result. If you had either of them set on an existing worker, the setting is dropped the next time Harnu reads its definitions; nothing about how your worker runs changes, because neither one ever changed it.

**Permission** — see the next section; this is the one to actually read.

**Advanced**

- **System prompt** — replaces Harnu's default system prompt entirely. Leave this alone unless you specifically want a leaner, less capable tick; the default prompt is what teaches the model to use its tools well.

**Delete worker** removes the worker's definition and its stored run history. Nothing else is touched — no board card, no session, no file in your repo changes because a worker was deleted.

## Naming a skill in the prompt

A tick is not a session, and this is the one place that difference bites. A session loads your settings, and with them every skill you have — the ones in `~/.claude/skills/`, the ones in the repo's `.claude/skills/`, the ones your plugins bring. **A tick loads none of that on purpose**, so that your hooks never fire unattended at 3am. The only skills it can see are the ones Harnu copies in for it.

So you tell it which ones. **Type `/` in the Prompt field** and a list drops down of everything this folder could stage, each row tagged with where it comes from:

- **bundled** — one of Harnu's own skills (Settings → Skills).
- **personal** — one of yours, from `~/.claude/skills/`.
- **project** — one the repo ships, from `<folder>/.claude/skills/`.

Pick one and its name goes into the prompt as plain text — `/land-prs`, exactly what you'd type in a session. Nothing is stored anywhere else: **the skill list is read back out of the prompt text every time**, in the form and again when the tick actually fires. Delete the name and the skill stops being staged. Type a name by hand, without touching the list, and it gets staged just the same.

Typing `/` only opens the list at the start of a word. A slash inside a path — `src/main/`, `docs/user/` — is left alone, so a prompt full of file paths stays comfortable to write.

**Under the field, one chip per name you used.** A chip that resolves reads `land-prs · personal`. A chip for a name nothing on this machine answers to turns amber and reads **not found** — that is the whole point of the row. A misspelled skill name used to look perfectly fine and quietly do nothing at 3am; now the form says so while you're still looking at it. It never blocks saving: you may be about to write that skill.

A few details worth knowing:

- If you have a personal skill with the same name as one of Harnu's, the personal one wins. Write `/harnu:mission` to insist on the bundled one. A saved prompt that still says `/capy:mission` keeps working.
- A skill that belongs to an installed **plugin** (`/dtk:review`) can't be staged — plugins come from the settings a tick deliberately doesn't load — so it shows as **not found**.
- Naming a bundled skill stages it even if it's switched off for this folder in Settings → Skills. Naming it in a prompt is an explicit request, so it's honoured.
- Skills reach the tick namespaced, the same way they do in a session started by Harnu: `/land-prs` arrives as `harnu:land-prs`. The model resolves it either way — you write the plain name.

## Agents can create workers too

A Claude session working inside Harnu can mint a worker itself, the same way it can already start another session or cut a worktree without asking you first — this is the third layer of the heartbeat an [orchestrating session](agent-control.md#promoting-a-session-to-orchestrator) is expected to set up on its own, instead of relying on you to remember to build one by hand. A worker made this way arrives fully formed and switched **on** in one call, rather than the New worker button's create-then-arm sequence above, because the session already supplied every field at once.

The same `observe`/`act` split below governs what a session can do without stopping to ask you. An `observe` worker — the default — is created directly, no prompt, the same as a session starting another session. An `act` worker is not: minting one unattended would hand the session a second, permanently unsupervised body, so it always stops and asks you first, naming the folder, the cadence and the prompt, before it's created — the same class of ask as a few other especially consequential actions (see [Agent control](agent-control.md)). Either way, once it exists it shows up in this same Scheduler list, indistinguishable from one you built by hand: the same Runs tab, the same three-strikes disable, the same Delete button.

If the prompt names a skill that resolves to nothing on this machine — a typo, an unknown name, a plugin skill a tick can't load — the session is told so in its own result, and you'll see that skill's chip read **not found** the first time you open it here; the worker still gets created either way. Naming a bundled skill that's merely switched off for the folder is not this case: as above, naming it is an explicit request, so it stages just fine and draws no warning.

## `observe` vs `act` — read this before you flip the switch

**`observe`** is read-only, and the read-only-ness is enforced by an explicit allowlist, not by the prompt being polite. A worker in this mode can use `Read`, `Grep`, `Glob` and `Skill` — and **no shell at all**. It has **no network access either**, unless you turn on **Network access** for that worker (see below). Harnu starts the tick with exactly those built-in tools and nothing else, so tools that can run commands or change things never load: not `Bash`, and not `Monitor`, the worktree tools, scheduled-task and workflow tools, `SendMessage` or `ToolSearch` either. `Edit`, `Write`, `NotebookEdit` and dispatching a subagent are denied by name on top of that. There used to be a short list of `git` and `gh` commands here; it was removed because a command that looks read-only can still write a file (`git log --output=<path>` overwrites whatever path you give it, and a planted `.git/config` can then run code on the next `git status`), and a rule cannot say "this command, but never with that flag". An `observe` worker gets its git and pull-request facts from Harnu's own read tools instead — the worktree listing, the fleet, and a mission's progress. Only a handful of Harnu's own tools are reachable — reading memory, the fleet or a mission's progress, creating or updating a roadmap card, and sending a notification — every tool that would let it spawn a session, open a worktree, or dispatch a manifest is refused by name. An `observe` worker that decides something needs doing can raise a board card and notify you about it; it cannot act on that conclusion itself.

**`act` is full, unattended write access.** It runs with permissions bypassed and the entire Harnu toolset available — editing files, committing, pushing, dispatching sessions, anything a normal session with every permission pre-approved could do.

**The one fact to actually remember: an `act` worker does not stop at the Approval Inbox.** The Inbox exists to intercept a tool call and wait for you to click Allow or Deny — bypassing permissions is precisely what skips that mechanism. There is no human in the loop for an `act` tick. If the prompt is ambiguous, or the model has a bad turn, whatever it decides to do happens, including committing something you didn't want, with nobody there to say no.

It's also worth knowing plainly that every tick — `observe` or `act` — launches with your own `settings.json` dropped entirely, so any hooks you've configured do not run inside a tick. Harnu now re-adds its own hooks to every tick, in both modes, but those only report what the tick is doing (it started, it finished, it's waiting) — they do not inspect the commands it runs. Harnu's automatic guard against an obviously catastrophic shell command still does not see inside a tick. Treat `act` as having no safety net beyond whatever the prompt itself is careful about.

## What a cadence actually costs

Every tick is a real model call, not a cheap poll. A worker set to run "every 5 minutes" fires **288 times a day**, whether or not anything actually changed. Before setting an aggressive cadence, open that worker's **Runs** tab: every run's cost in dollars, its token usage, and how many turns it took are all recorded there. Look at what one run already costs, then multiply by how many times a day it'll fire.

## The three real limits

- **Harnu has to be open.** A worker only runs while the app itself is running. Quit Harnu, or let the machine sleep, and nothing fires until it's open again — there's no cloud fallback that keeps ticking in the background.
- **Your own hooks do not run inside a tick**, and Harnu's own hooks only observe it — nothing screens the commands a tick runs, in either mode (see above).
- **At most two workers run at once.** If a third worker comes due while two ticks are already in flight, it's skipped for that check and picked up on the next one roughly 30 seconds later — never queued. A worker whose own previous tick hasn't finished yet is skipped the same way; it never overlaps itself.

Two related, gentler behaviors: a worker whose folder no longer exists at tick time disables itself and tells you why, rather than spawning into a directory that isn't there anymore; and a worker that fails three times in a row disables itself and notifies you, rather than quietly failing 288 times a day. Stopping a run by hand (the Stop button, next to a running worker) never counts toward that three-strikes count — the run is recorded as `stopped`, and the worker stays exactly as enabled as it was.

## Network access is opt-in

An `observe` worker can read any file you can read. If it could also reach the internet, a malicious line in anything it reads — a README, a commit message, a pull-request body — could tell it to put the contents of a file such as `.env` into a web address and fetch it, which sends the file to whoever runs that site. So a worker starts with no network tool at all (`WebFetch` is not even loaded), and you turn it on per worker.

To allow it, open the worker's **Settings** tab, and under **Permission** switch on **Network access**. Harnu shows a red notice while it is on: _"Lets this worker send data from files it reads to the internet."_ Only turn it on for a worker whose job really needs the web, and consider keeping its folder free of secrets. Network access is not offered for an `act` worker, which has no allowlist to begin with.

If an agent (a Claude session using Harnu's tools) tries to switch it on for a worker, in `create_worker` or `update_worker`, Harnu stops and asks you first, in the Approval Inbox. Switching it **off** never asks.

**Workers you already had.** Every worker saved before this change starts with Network access off. Harnu posts one entry in your Activity bell, _"Scheduler: network access is now opt-in"_, listing the `observe` workers whose prompt mentions a URL or `WebFetch` — those are the ones that may have been using it. Switch it back on for any that should. The entry appears once; it will not repeat on the next launch.

## Extra read commands are retired

Older versions of Harnu let an `observe` worker carry **Extra read commands** — your own `Bash(...)` rules added on top of the built-in set. Since `observe` has no shell any more, that field is gone from the worker's settings and grants nothing. A worker saved with some still has them on disk; every one is ignored when the worker runs, and it shows up in that worker's **Runs** tab next to the tick's permission denials as `rejected rule: Bash(…)`, so you can see it was refused rather than wondering why nothing changed.

If a worker genuinely needs a shell — to run `jj`, or a project script — it is no longer an `observe` job. Make it an `act` worker, and read the section above first: `act` has no allowlist and no safety net.

## Reading a worker's history

The **Runs** tab shows the last result in full, a table of recent runs (time, status, turns, cost, duration), and — when a run got refused something — exactly what it tried and couldn't do (`Edit ×9`, `Bash ×3`). A worker that keeps showing up there is telling you something: either its prompt is asking for more than `observe` allows, or it genuinely needs to be `act`. Harnu keeps the most recent 200 runs per worker; older ones roll off on their own.

**Click any row in that table to read that run.** It expands in place, under the row, and shows what that particular run said, why it ended, and anything it was refused. All 200 stored runs have always carried that — until now only the newest one was readable, which made the table a scoreboard you could not ask a question of ("the 3am tick cost four times the others — what did it _do_?"). One row is open at a time; clicking it again closes it. A run that produced no text — one you stopped by hand, for instance — opens to a plain "This run produced no result", which is the honest answer rather than a blank panel.

**A tick that was skipped leaves no row at all.** When a worker comes due while its own previous tick is still going, or while two other workers already hold the two concurrency slots, Harnu does not start it and does not record anything — there is no run to record. It simply comes due again on the next check, roughly 30 seconds later. So the table is a list of ticks that actually ran; a gap in it, not a row, is what a skipped beat looks like.

One thing that is deliberately capped: a run's stored result is truncated at 4000 characters. A worker that writes an essay every five minutes would otherwise grow its history file without limit, 200 records deep.

## Deciding how much you want to hear

Harnu's scheduler sends you a notification about **itself** in two cases, always, in every setting: a worker got disabled by its failure streak, and a worker got disabled because its folder disappeared. Those are the machinery telling you it broke, and they are not optional.

Everything else is the **Notify me** setting on the worker, and it has three states:

- **Silent** — the default. Nothing per tick. You still get the two cases above.
- **On failure** — additionally, every individual failed tick (`error` or `timeout`). Stopping a run by hand doesn't count — that's your own action, not the worker misbehaving. A skipped beat doesn't either: nothing ran, so there is nothing to report.
- **Every run** — additionally, every tick that completed, including the successful ones. Bear in mind what a cadence costs in attention as well as money: a 5-minute worker on this setting is 288 notifications a day.

**Why the default is Silent, and why you probably want to leave it there.** A worker's own prompt can already notify you — `notify` is one of the Harnu tools an `observe` tick is allowed to call, and an `act` tick has everything. That is the better channel for anything interesting, because the prompt is the only thing that knows whether _this_ run found something worth interrupting you for. If you both write a prompt that reports its findings and set the worker to **Every run**, you get told twice about the same tick, once with content and once without.

So the split is: **the prompt owns "tell me when something is interesting"; the scheduler owns "tell me the machinery broke."** Turn this up when you're debugging a worker or watching a new one settle in, and turn it back down once you trust it.

(A related idea was considered and rejected: "notify only when the result changed". A model almost never writes the same sentence twice, so that filter would have fired on nearly every tick while looking like it was filtering.)
