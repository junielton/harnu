# Mods

A **mod** is a Claude Code plugin that has a _hooks module_: a small program that runs
inside `claude` and can watch or change what a session does. Mods run **unsandboxed**.
**Settings → Mods** lists the mods a session can load and what each one's source says
it can do, so you can see what is in there before you rely on it.

The list is **read-only**. It never turns a mod on or off, installs one or removes one —
for that it points you at the place that owns the mod.

## Open it

Open **Settings → Mods** (the tab right after **Skills**).

- **Global** lists the mods every session can load: user-scope installed plugins, the
  folders under `~/.claude/skills/`, and the folders named by `CLAUDE_CODE_PLUGIN_DIRS` in
  your `~/.claude/settings.json`.
- **The project pill** (named after the folder of the selected session) adds that
  folder's own installed plugins, its `.claude/skills/` folders, and any `--plugin-dir`
  you put in its Claude Boot extra arguments. With no session selected the pill is
  disabled.

Nothing runs until you open the tab. The first open reads each mod with
`claude plugin validate`, which takes about half a second per plugin, so rows fill in one
by one. Results are cached by the content of the plugin folder and the Claude Code
version, so reopening the tab costs nothing until a mod changes. **Refresh** forces a
fresh read of every row.

## What a row tells you

Each row is one mod: its name, where it came from (**installed · user**, **skills
folder**, **--plugin-dir**, or **Harnu mod**), its version, and a row of chips. Every
chip says what the source **can** do:

| Chip                            | Meaning                                                           |
| ------------------------------- | ----------------------------------------------------------------- |
| can run processes               | It calls a process API.                                           |
| can use the network             | It calls the HTTP fetch API.                                      |
| can read and write files        | It calls a file API.                                              |
| can read every prompt           | It hooks prompt submission.                                       |
| can change the system prompt    | It hooks how the system prompt is composed.                       |
| can rewrite or block tool calls | It hooks tool calls.                                              |
| can decide permissions          | It hooks permission checks.                                       |
| can submit prompts              | It can send a prompt or run a command on its own.                 |
| can call the model              | It can ask the model for a completion.                            |
| can call MCP tools              | It can call a tool on a connected MCP server.                     |
| can read other mods' calls      | It hooks a low-level operation (files, network, environment, …).  |
| can refuse other mods           | It hooks mod registration.                                        |
| can read environment variables  | It declares reading at least one environment variable.            |
| draws in the terminal           | It draws something in the terminal UI.                            |
| has matchers Harnu cannot read  | One of its hooks filters on a value that is not a plain constant. |

Click a row to see the details: each hook with its matcher, each call, the environment
and state names it reads and writes, anything the parser did not recognise (shown
exactly as the CLI printed it), the folder, a short fingerprint of its content, and when
it was last read. **Reveal folder** opens it in your file manager.

A chip is a **fact about what the source declares**, not a judgement. A mod with no chips
is not "safe", and a mod with many is not "unsafe". Harnu never says either.

## What it cannot tell you

The read is static and shallow, so the pane says so under the list. It does **not**
show where data goes (the hosts a mod fetches from), which commands it runs, which files
it reads or writes, or what a running session actually loaded. A mod can also hook the
calls of another mod; this list shows that as a chip but cannot stop it. It lists what
**can** load, not what did.

Plugins that have no hooks module are not mods and are not listed; one line under the
list counts them.

## Turning a mod off

Each source has its own switch, and the expanded row names it:

- **Installed plugins** — `/plugin` in a session, or `claude plugin disable <id>`.
- **Skills folder** — remove its folder. Claude Code asks you to approve such a plugin
  the first time a session loads it, and that approval is not readable from outside, so
  Harnu says it cannot tell whether the mod is allowed to load.
- **`--plugin-dir`** — remove the argument from the folder's Claude Boot extra arguments,
  or the entry from `CLAUDE_CODE_PLUGIN_DIRS`.
- **Harnu skills** — Settings → Skills.

To allow **only** your organization's mods, an administrator sets `allowManagedModsOnly`.
Harnu cannot detect that setting from outside a session, so the pane does not show a
banner for it.

## The row named `harnu-companion`

`harnu-companion` is Harnu's own mod, and it is listed like any other: same read, same
chips, same words. It is always the first row. It appears only when Harnu's mod is
staged by this build of Harnu; when none is staged there is simply no row.

Its row carries the chips **can use the network**, **can read and write files**, **can
read every prompt**, **can decide permissions**, **can refuse other mods**, **can read
environment variables** and **draws in the terminal**. They are what the source declares:
it talks to Harnu on this machine, reads session state, watches prompts, permission
requests and mod registration, and draws one line above the prompt of a review companion
(the selection you made in the Review pane) and, in every session, the [report cards](#report-cards)
and [compact agent messages](#compact-agent-messages) described below. The registration hook only watches which mods a session admits; it never
refuses one, and a test in Harnu's repository fails if it ever does. The static read
cannot tell a watcher from a gate, so the chips are shown anyway, the same as for any mod
with those hooks.

## What the mod does for the Review pane

In a review companion (the read-only session beside the diff) the Harnu mod does two
things, both for the selection you make in the diff:

- **It receives a hidden note.** While the companion is open, Harnu tells the mod which
  lines you have selected, and the mod adds that to the companion's context. It is not a
  message and not a turn: nothing is typed into the conversation and the companion does
  not answer it. A newer selection replaces the note, and clearing the selection replaces
  it with a note that says nothing is selected.
- **It draws one line above the companion's prompt** (`⧉ speech.ts L85–92`) while the
  selection stands, so you can see what the companion has. The line stays through the
  companion's answers and is cleared when you clear the selection, run `/clear` in the
  companion, or close it.

Neither works in any other session: the mod only does this for a review companion that
Harnu started, and only if the mod was **on when that companion started** — a mod joins a
session at launch, so switching it on later cannot reach a companion already running.
When that is why a selection is not shared, the Review pane says
_This session started without the Harnu mod_ and tells you to close the companion and open
a fresh one; **Open Mods settings** is offered only when the mod is actually off.

What the chip in the Review pane means by **Companion sees this**: the note is in the
companion's context, nothing more. It never says that the companion read it, used it or
answered about it. See [Review pane](review-pane.md#sharing-a-selection-with-the-companion)
for the rest, including **Copy as text**, which works with no mod at all.

## Report cards

When a session's reply contains a **status glance card** or a **report-back final report**
(the formats of Harnu's bundled `status` and `report-back` skills), the Harnu mod draws it in
the terminal as a card instead of showing the raw text:

- a **bordered card** with the front's title, a progress bar and the ledger rows (what is
  running, what is done, what is next). The border and the bar are green when the front is
  finished (a full bar, a trailing `✓` such as "Step 5 of 5 ✓", or 100%, or every step of the
  report succeeded and the header shows no unfinished bar), red when any step failed, and the accent colour otherwise;
- a separate **yellow box** for what is owed to you, headed by its label and a count;
- the **checklist** with aligned labels and coloured marks: `✓` green, `!` yellow, `✗` red,
  `-` dim;
- the report's links, with PR numbers and URLs you can click.

The sentence before the report and the summary after it are still drawn as normal markdown.
On a narrow terminal only a checklist row is cut with an ellipsis (**Ctrl+O** shows the whole
message as written); what is owed to you, the ledger rows and every link wrap instead, so
nothing you must act on is hidden. The drawing is display only: the stored message, what the model reads and the
transcript file are never changed.

The mod recognises a report by its **shape** (the `▰▱` progress bar, the `├─` / `└─` rail with
its `✓ ! ✗ -` marks, and the fixed label column), not by the words of its labels, so a report
written in Portuguese or any other language is drawn the same way. Anything that is not a
complete report is left exactly as it was: a reply still streaming, a report cut off before its
closing fence, a `tree` listing, a lone link.

**Turning it off.** **Settings → General → Harnu mod → Draw reports as cards** (on by
default; it can only be on while the Harnu mod itself is on). A session reads the setting when it
starts, so a change reaches sessions you start afterwards; sessions already running keep what
they had until they restart.

## Compact agent messages

In a session with the Harnu mod on, the rows in the transcript that **you did not type** are
drawn short. Anything you type, and anything that comes from a person at another client, is never
touched.

- **A report from another session** is one line: `✉` the sender, `report · mnt-… stp-…` when it
  is a `Report for session … · mission … · step …` report, and the first sentence of its summary.
- **A finished background task** is one line: `✓ bg task <name> · exit 0` (`✗` when it failed,
  with how long it ran).
- **A teammate's idle notice** is one line: `◌ <name> idle 07:14 · «what they said»`.
- **A loop tick over a mission** is a **live card**: the mission's title, a progress bar with
  "Step 3 of 5 · 1 verified", `now` (the step that is running, its executor, what it is doing and
  for how long), `waits` (the blocker or the open PRs it waits on) and a yellow `⚑ you` row for
  each thing you owe. A tick qualifies when its prompt starts with the line
  `/harnu:mission tick · <mission id>`. The card is drawn from the mission's current state, which
  Harnu sends to the session (the missions it owns or is linked to), not from the prompt. A tick
  that finds the same state as the one before is a single dim line, "no change since #14"; one that
  finds a change shows a `changed` row instead (`stp-3 verified · PR #269 merged`). The tick number
  `#N` counts the ticks of that mission that arrived while the session was running. A tick row
  that was already in a resumed transcript has no number and no comparison: it shows the mission as
  it is now. The card is green when the mission is
  done, and the accent colour otherwise.

The labels of the card (`now`, `waits`, `changed`, `you`, "no change since") are English in every
language. A row the mod cannot read, a tick with no mission id, a session outside Harnu (which gets
no mission state) or a mission Harnu does not know is drawn as a plain one-line chip from its text,
or left as the engine draws it. A line is cut at the edge of the terminal, never hidden: **Ctrl+O**
shows every row as written, and the stored message and what the model reads are never changed.

**Turning it off.** **Settings → General → Harnu mod → Draw agent messages compactly** (on by
default; it can only be on while the Harnu mod itself is on). A session reads the setting when it
starts, so a change reaches sessions you start afterwards; sessions already running keep what they
had until they restart.

## Harnu mod outside Harnu

By default only the sessions **Harnu starts** carry the Harnu mod. **Harnu mod outside Harnu**
(**Settings → Mods → Advanced**) lets the `claude` sessions you start in your **own terminal**
load it too, so Harnu can show their real state instead of guessing. It is **off** until you
turn it on, and it is not the **Also outside Harnu** switch of the Skills tab, which copies a
skill file and nothing else.

**What turning it on writes.** One folder, added to `env.CLAUDE_CODE_PLUGIN_DIRS` in
`~/.claude/settings.json`: the same folder Harnu's own sessions load the mod from. Every other
key and every other item of that list stays exactly as it was. Before anything is written a
dialog names the file, the folder and what it does, and **Cancel** leaves everything
untouched. The setting then applies to **every** `claude` session you start in any terminal,
and it also reaches the sessions Harnu starts and Harnu's own `claude` probes (which stay
silent: a probe never says hello).

**What it shows.** A session outside Harnu reports to Harnu on this machine. Harnu shows it
only after its **own** watchers (the transcript of the session, or Claude Code's process
registry) report the same session, so a session that merely claims to exist is never shown.
Once it is, the session's hover preview reads **Harnu mod: live · outside Harnu**, and the
session counts under **Active elsewhere** with its real state. The block shows when the last
outside session was seen, or "No outside session has reported yet." A session whose first
turn never appears in Harnu's watchers is dropped after about half a minute and may report
again.

**What it never does.** Harnu never starts a prompt in an outside session, never sends it a
message, never aborts or compacts it and never writes into its terminal. It does **not** hold
its approvals either: the native dialog and any hook behave exactly as before, unless that
folder is already on the interceptor ramp (see [Approval Inbox](approval-inbox.md)).

**Turning it off** removes exactly the folder Harnu added. If Harnu had to create the `env`
object or the key, it removes those too; if you added other folders to the list, they stay.
Every outside session that is already running is cut off at once and goes quiet; new ones
load nothing. Two cases need you: if `~/.claude/settings.json` no longer parses, Harnu
cannot edit it and says which folder to delete from `CLAUDE_CODE_PLUGIN_DIRS` by hand; and if
you uninstall Harnu while the switch is on, the entry points at a folder that no longer
exists, which Claude Code skips, but you should delete it (see
[Troubleshooting](troubleshooting.md#a-leftover-harnu-mod-entry-in-my-claude-settings)).

**When it refuses** (a toast, one sentence, nothing written):

- **Blocked by your organization's policy.** A managed settings file exists on this machine.
  Harnu does not try another route. If the policy is delivered another way (a registry key or
  a device-management profile), Harnu adds the entry, runs one check, and removes it again
  when Claude Code's own refusal blames managed settings.
- **Turned off by a setting or by your organization's policy.** Claude Code reports that mods
  are off here; Harnu cannot tell why, and says so.
- `~/.claude/settings.json` is not valid JSON, is a symlink, or has an `env` or a
  `CLAUDE_CODE_PLUGIN_DIRS` of a shape Harnu does not edit. Harnu never repairs, replaces or
  follows these: nothing is changed.
- **The Harnu mod is off.** Turn it on first (Settings → General → Integrations).

This was tried on Linux with Claude Code 2.1.290. It has **not** been tried on a machine with
managed settings, on Windows or on macOS. Desktop, the VS Code extension, the SDK and cloud
sessions are not covered, and a session that starts in a folder Claude Code does not yet
trust loads no mod until you accept the trust prompt. With a Claude Code newer than the last
version Harnu was tested with, the switch still writes its entry but Harnu refuses outside
sessions until a Harnu update covers that version.

## Banners you may see

- **Turned off by a setting or by your organization's policy.** Mods are off in this
  environment (for example `disableAllHooks` in your settings). Rows are still listed,
  because the read is static. Harnu checks this once per launch and Claude Code version,
  by running `claude plugin test` in an empty folder. When the answer is unclear there is
  no banner, which means "unknown", not "mods will load".
- **Mods are turned off remotely by Anthropic.** The same check found Claude Code's
  remote switch off.
- **This folder starts sessions with `--safe-mode`, so no mod loads there.** From the
  folder's Claude Boot settings.
- **Claude Code CLI not found.** Without the `claude` binary there is nothing to read,
  and Harnu starts no process.
- **This Claude Code version cannot analyse mods.** Update Claude Code.

## What Harnu stores

A small cache file in Harnu's data folder (`mods-audit-cache.json`) holds, for each
plugin folder, a content fingerprint, the plugin name and the declared hooks and calls.
It never holds file contents. Harnu only reads folders it found itself; the tab passes
row keys, not paths, to the main process.
