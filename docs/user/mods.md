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
installed in your build; without it there is simply no row.

## Banners you may see

- **Turned off by a setting or by your organization's policy.** Mods are off in this
  environment (for example `disableAllHooks` in your settings). Rows are still listed,
  because the read is static. In this version Harnu does not yet check this, so no banner
  means "unknown", not "mods will load".
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
