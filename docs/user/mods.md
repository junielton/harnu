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
