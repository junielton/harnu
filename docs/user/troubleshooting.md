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

## Custom endpoint credentials

If you've registered a custom Claude-compatible endpoint under **Settings → Endpoints**, its auth token is stored in plaintext on disk (`claude-boot.json` in Harnu's app data directory) — this isn't a bug, but it is worth knowing if that machine or file is shared. See [Claude Boot](claude-boot.md#custom-endpoints) for the exact location.
