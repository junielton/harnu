# Troubleshooting

## The OS warns me on first launch

Harnu is still in alpha and the binaries aren't signed or notarized on any platform, so this is expected on every OS the first time you run a fresh download:

- **macOS** — Gatekeeper refuses to open it. Either run `xattr -d com.apple.quarantine "/Applications/Harnu.app"`, or right-click the app in Finder and choose **Open**, which offers a one-time exception.
- **Windows** — SmartScreen shows "Windows protected your PC". Click **More info → Run anyway**. Subsequent launches are clean.
- **Linux** — no OS warning, but you do need to `sudo dpkg -i` the `.deb` or `chmod +x` the AppImage before it'll run — see [Getting started](getting-started.md#install).

None of this means anything is wrong with your download; it's the cost of an unsigned alpha build, not a red flag.

## Harnu freezes or the scroll feels broken on Linux

If you're on Linux/KDE under Wayland, `webkit2gtk` (the web engine Electron embeds) can be flaky — freezes or scroll glitches are a known rough edge, not a Harnu bug specifically. Launch with `GDK_BACKEND=x11` instead of Wayland's native backend to work around it:

```bash
GDK_BACKEND=x11 ./Harnu-*.AppImage
```

## Harnu isn't auto-updating

What happens when a new version ships depends on how you installed Harnu:

- **AppImage (Linux)**: fully automatic. Harnu checks GitHub Releases periodically, downloads the update silently, and shows a "Update ready — Restart now" toast when it's staged.
- **`.deb` (Linux)**: not automatic at all — it's managed by `apt`/`dpkg`, not Harnu. Download and `sudo dpkg -i` the new version yourself when one ships.
- **macOS / Windows (unsigned builds)**: checked automatically, but not applied automatically — Gatekeeper (macOS) and Squirrel (Windows) refuse to let an unsigned app silently install a downloaded update. Instead, when a new release publishes, Harnu shows an "Update available" toast with a **Download update** button that opens the correct GitHub release page in your browser, so you can grab the right installer and reinstall in one click of navigation — no hunting on GitHub yourself.

None of this is a bug; it's the current state of packaging for an unsigned alpha. True one-click auto-update on macOS/Windows needs code signing and notarization, which isn't set up yet.

## Creating a worktree fails with "npm: not found" (or similar)

This used to be a real bug: an app launched from your desktop or Dock doesn't inherit the PATH your terminal has, so a Node installed via `mise`, `nvm`, `asdf`, or Homebrew was invisible to the setup commands Harnu ran from a repo's `WORKTREE.md` — worktree creation failed and rolled back entirely. This has been fixed: setup commands now run with your terminal-equivalent PATH. If you still hit a missing-command error inside a worktree's setup step, check `node --version`/`npm --version` from a plain terminal in that same repo first — a genuinely broken or unusually-configured toolchain is more likely at that point than a PATH problem Harnu itself should have already solved.

## An agent's action isn't asking me for approval — or isn't doing anything at all

Check two things, in this order:

1. **Is agent control enabled for that folder at all?** Open **Settings → MCP** — if the folder isn't in the allowed list, none of the capabilities in [Agent control](agent-control.md) are available to a session there, and nothing will show up in the [Approval Inbox](approval-inbox.md) because nothing was ever attempted.
2. **Did you (or a past session) already grant a durable "always allow" rule, or is a mission grant currently live for that folder?** Both make matching actions run silently by design — check the Approval Inbox's mission-grant strip and the "always allow" state before assuming something's misbehaving.

## Harnu mod: legacy

A session whose hover preview says **Harnu mod: legacy — …** is running on hooks and polling, the way every session did before the [Harnu mod](settings.md#harnu-mod) existed. Nothing is broken and you do not need to act. Today the mod only observes: it does not change what Harnu shows or does, so `legacy` costs you nothing yet. The reason after the dash says why:

- **started without it** — you started the session before Harnu showed the one-time notice. A new session will carry the mod.
- **Claude Code older than 2.1.287** — the mod needs 2.1.287 or newer. **Claude Code version not checked yet** clears by itself within a few seconds of starting Harnu.
- **turned off by a setting or by your organization's policy** — Claude Code reported that mods are off in this environment (for example `disableAllHooks` in your Claude settings, or a managed policy). Harnu cannot tell the two apart, never retries and never tries to work around it.
- **mods turned off remotely** — Claude Code says mods are turned off for this install by a remote switch. Start Claude Code once with network access; if it persists, it is not something Harnu can change.
- **blocked by your organization's policy** — shown only when Claude Code's own refusal text was recognised. Ask whoever manages the machine.
- **the mod did not load** — the session started with the mod but it never said hello, and Harnu has no better explanation. Starting a new session usually fixes it.
- **handshake refused**, **lost when Harnu restarted**, **unloaded mid-session** — the mod stopped talking to Harnu. Harnu went back to hooks and polling for that session and stays there until it ends; a new session starts clean.

If you do not want the mod at all, turn off **Settings → General → Integrations → Harnu mod**.

## A session's dot stays "working" or "needs input" after it stopped

The status dot follows what Claude Code reports. Two things can leave it behind, and the [Harnu mod](settings.md#harnu-mod) changes both once its **task state** switch is on (today it only watches, so nothing below changes yet):

- **You pressed Esc, or answered "No" to a permission.** Claude Code ends the turn but sends no "stopped" hook, so the dot keeps its last colour until the next event or the "stuck" timer. With the mod's task state switch on, the dot goes to idle within a couple of seconds.
- **A subagent is still running when the main turn ends.** The parent stays **working** until the last subagent finishes, so a session that is only waiting for its helpers does not look idle. Background shell commands, monitors and workflows do not hold the dot: Claude Code gives Harnu no signal when they end.

What the mod cannot see, and neither can the hooks: a permission you approve at the terminal still shows **needs input** until the tool finishes, because Claude Code sends nothing when you press the approve key. A long tool call that prints nothing still turns red as "stuck" after the usual wait.

## Test Harnu mod channel: "did not answer"

The **Test Harnu mod channel** button in the [System Monitor](system-monitor.md) sends a session a quick check and waits up to five seconds. **Harnu mod channel did not answer** means the check was sent but the session did not reply in time. The usual causes:

- The session is busy loading, compacting or wedged. Try again in a few seconds; a session that stays silent is on its way to `legacy — unloaded mid-session`.
- The mod was reloaded or lost its connection to Harnu a moment ago. It reconnects by itself, so a second try normally works.
- Harnu was restarted and the session is not talking to it yet.

**Harnu mod channel is not available: …** is not an error. `this session runs on hooks` means the session fell back to the old path (see above), `the channel is observing only` means the channel is still in its measuring stage, and `this is a headless session` means the session is a background run that never listens for checks.

## Custom endpoint credentials

If you've registered a custom Claude-compatible endpoint under **Settings → Endpoints**, its auth token is stored in plaintext on disk (`claude-boot.json` in Harnu's app data directory) — this isn't a bug, but it is worth knowing if that machine or file is shared. See [Claude Boot](claude-boot.md#custom-endpoints) for the exact location.
