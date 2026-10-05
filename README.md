# Harnu

> Harnu — Manage every Claude Code session in one place.

A desktop app that turns the sprawl of running and idle Claude Code sessions into a single browsable workspace.

> **Not affiliated with Anthropic.** Harnu is an independent, unofficial project. It is not affiliated with, endorsed by, or sponsored by Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic, PBC.

## What it is

Harnu is a cross-platform Electron + Vue 3 desktop app. It reads `~/.claude/projects/`, where Claude Code persists every session as JSONL, and renders it as a sidebar of folders with their sessions underneath; folders that are worktrees of the same repo are grouped together. Click a past session to resume it via `claude --resume <uuid>`; click "new session" to spawn `claude` in the chosen folder's cwd. Renames issued inside Claude (via `/rename`) propagate back to the sidebar live through a filesystem watcher. No daemon, no cloud, no account — the app is a faithful UI over files that already exist on disk.

## Features

- **Sessions in one place** — resume any past Claude Code session or start a new one, grouped by folder and git worktree, with live status (working / needs input / stuck / idle) right in the sidebar.
- **Approval Inbox** — every action an agent takes through Harnu's control server surfaces in one rail for your say-so instead of scattered terminal prompts (Claude Code's own permission prompts join it only if you switch the opt-in Interceptor to Active in **Settings → Interceptor**; it ships in log-only Shadow mode, which never changes a session); grant a whole batch of actions at once or allow a verb durably per folder.
- **Git worktrees** — spin up an isolated worktree for a task straight from Harnu, seeded via a repo's own `WORKTREE.md` manifest so it's usable immediately instead of a bare checkout.
- **Project memory** — a per-repo `.harnu/memory/` spotlight (hot state, decisions, roadmap) that every session and worktree shares, browsable from a built-in pane.
- **Roadmap board** — a kanban for the project's backlog with agent-authored cards, a dispatch manifest gate, and configurable model routing per card kind.
- **Claude Boot** — per-folder launch options (model, effort, flags, custom Claude-compatible endpoints).
- **Usage dashboard** — plan usage at a glance plus a full history/cost breakdown across sessions.
- **MCP control server** — lets a session act on the fleet itself (create sessions/worktrees, read project memory, manage the roadmap) through a typed tool catalog, gated by the Approval Inbox.

See the [user guide](docs/user/README.md) for how to use all of this — start with [Getting started](docs/user/getting-started.md) if this is your first time running Harnu.

## Status

**Still in alpha — no signing, no notarization.** The binaries are unsigned on every platform. Expect Gatekeeper (macOS) and SmartScreen (Windows) to block the first launch. See the platform notes below for the bypass per OS.

The data plane, terminal pipeline, shortcuts, and command palette are wired. Auto-update applies silently on AppImage; unsigned macOS/Windows builds get an in-app "Update available" toast linking to the release page instead (the OS won't let an unsigned build apply an update silently). The `.deb` doesn't auto-update at all.

## Requirements

- **Claude Code**: the `claude` CLI installed, on your `PATH`, and logged in. Harnu runs your own `claude`; it does not bundle or replace it.
- **git**, for the worktree features.
- **GitHub CLI (`gh`)**, optional, logged in, for the pull-request features (PR Stack, Review, Cleanup).

## Install

Download the build for your platform from the [releases page](https://github.com/junielton/harnu/releases).

### Linux

```bash
sudo dpkg -i harnu_*_amd64.deb
# or
chmod +x Harnu-*.AppImage
./Harnu-*.AppImage
```

### macOS

Drag the `.dmg` to Applications. On first launch Gatekeeper will refuse to open it. Either:

```bash
xattr -d com.apple.quarantine "/Applications/Harnu.app"
```

Or right-click the app in Finder and choose Open — macOS then offers a one-time exception.

### Windows

Run the `.exe` installer. SmartScreen will show "Windows protected your PC". Click **More info → Run anyway** to proceed. Subsequent launches are clean.

## Network activity

Harnu is a local-first app — there is no Harnu backend, no account, and no telemetry, analytics, or crash reporting. Every outbound call Harnu (or a tool it runs for you) makes is listed below. Anything that reaches Anthropic goes through your own `claude` CLI and your own login; Harnu holds no Anthropic credentials of its own. Git and GitHub features run through your own `git` and `gh`, so the hosts they contact are whatever your remotes and `gh` login point at.

**Automatic** (no action from you):

| Destination                                                                | Purpose                                                                                                                                                                                   | When                                                                              |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `status.claude.com`                                                        | Shows the current Claude service incident state.                                                                                                                                          | Always: every 60 s while a window is focused, every 5 min in the background.      |
| `raw.githubusercontent.com`                                                | Fetches the official Claude Code changelog and notifies you of new versions.                                                                                                              | Always: every 30 min, whether or not Settings is open.                            |
| Anthropic, via `claude -p /usage`                                          | Reads your plan-usage meters for the footer. Sends no prompt content.                                                                                                                     | Immediately on focus, then every 90 s while a window is focused.                  |
| GitHub Releases (`github.com` / `objects.githubusercontent.com`)           | Update check. AppImage builds download and apply silently; macOS/Windows builds only show a toast linking to the release page. The `.deb` is managed by apt and is not replaced in place. | Packaged builds only: 5 s after launch, then hourly.                              |
| Your git remotes (`git ls-remote`) and GitHub via your `gh` (`gh pr list`) | Cleanup (Reaper) scan: which branches and worktrees are merged and safe to clean up. Read-only.                                                                                           | Default on, hourly. Change the interval or turn it off in **Settings → Cleanup**. |
| GitHub via your `gh` (`gh pr list`)                                        | Pull-request state for PRs linked to an open Mission.                                                                                                                                     | While a Mission with linked PRs is open.                                          |

**On your action:**

| Destination                                                | Purpose                                                                                   | When                                                                             |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Your git remote (`git fetch`)                              | Fetches a base branch when you create a worktree, and a PR head for the Review pane.      | When you create a worktree or open a PR in Review.                               |
| Your git remote (`git push --delete`)                      | Cleanup deletes a merged remote branch.                                                   | Only after you confirm a sweep; can be disabled with `neverDeleteRemote`.        |
| GitHub via your `gh`                                       | PR Stack, Review pane (including submitting a review), and Cleanup PR lookups.            | When you open those views or click.                                              |
| Anthropic, via your `claude` CLI                           | Usage history **Ask** sends your question plus aggregated usage figures.                  | When you submit a question.                                                      |
| Anthropic (or your custom endpoint), via your `claude` CLI | The Claude Code sessions themselves, including Scheduler workers you created and enabled. | When you start or resume a session, or a worker you enabled runs.                |
| `cdn.jsdelivr.net` and `huggingface.co`                    | One-time download of the offline voice engine (about 120 MB for the default voice).       | Only when you click install in **Settings → Voice**. Afterwards it runs offline. |

**Opt-in:**

| Destination                                 | Purpose                                                                                                                                   | When                                                                  |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Anthropic, via your `claude` CLI            | **Auto-name** sends the first user prompt of a new session to Haiku to name it. Off by default.                                           | Once per new session, only if enabled in **Settings → Intelligence**. |
| The ntfy topic or webhook URL you configure | Remote push notifications. The payload is the notification title and body, which can include the session name or summary. Off by default. | Only after you add a channel; goes only to the URL you enter.         |

**Your configuration:**

| Destination                                      | Purpose                                                                                                                                                              | When                 |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| The custom `ANTHROPIC_BASE_URL` endpoint you set | Points your `claude` sessions at an alternate Claude-compatible server (**Settings → Endpoints**). Harnu only sets the environment variable; the CLI makes the call. | Only if you set one. |

Everything else — reading `~/.claude/projects/`, spawning `claude`, the terminal pipeline — stays on your machine.

### Stored credentials

Custom-endpoint auth tokens (for alternate Claude-compatible endpoints) are stored **in plaintext** in `claude-boot.json` inside the app's `userData` directory. They are not encrypted at rest — treat that file as sensitive.

## Development

```bash
npm install
npm run dev
```

`npm install` rebuilds `node-pty` for the Electron ABI via the `postinstall` hook. `npm run dev` starts electron-vite with HMR for the main, preload, and renderer processes.

```bash
npm run build       # full production build (typecheck + electron-vite build)
npm run typecheck   # both: typecheck:node and typecheck:web
npm run build:linux # electron-builder for .deb + AppImage
npm run build:mac   # electron-builder for .dmg
npm run build:win   # electron-builder for NSIS .exe
```

### Live-verify a change in the real app (without disturbing a running instance)

To prove a change works end-to-end against the actual app — even while another
Harnu (an AppImage or `npm run dev`) is already running — launch a second,
**isolated** instance (its own `--user-data-dir` bypasses the single-instance
lock; an alternate `--remote-debugging-port` avoids CDP collisions), drive it over
the DevTools Protocol, and inspect what it wrote to disk. Full reproducible recipe
(including the `is.dev` renderer-URL gotcha and safe teardown) is in
[`docs/dev/live-verify-second-instance.md`](docs/dev/live-verify-second-instance.md).

## Architecture

[`ARCHITECTURE.md`](ARCHITECTURE.md) maps the three Electron processes and where code lives. [`design.md`](design.md) is the visual system, the single source of truth for tokens and components. [`CHANGELOG.md`](CHANGELOG.md) is the release history, and [`docs/`](docs/README.md) holds the user guide, ADRs and engineering notes. [`CLAUDE.md`](CLAUDE.md) is the same contract written for AI coding agents working in this repo.

## Project layout

```
src/main/        — Electron main process (PTY, watcher, IPC, MCP control server)
src/preload/     — typed contextBridge API
src/renderer/    — Vue 3 app (sidebar, terminal, dialogs, palette)
tests/           — Vitest unit tests and Playwright e2e
docs/            — user guide, ADRs, lessons, specs
scripts/         — CI gates and generators
build/           — packaging assets (icons, entitlements)
resources/       — runtime assets shipped with the app (icon, bundled skills, templates)
```

## Contributing

Contributions are welcome. Start with [`CONTRIBUTING.md`](CONTRIBUTING.md): it covers setup, the conventions the CI gates enforce, and what a pull request needs. Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md). Report security issues privately, as described in [`SECURITY.md`](SECURITY.md).

The project was developed in a private repository before its public release. That history was not carried over; this repository starts from a single initial commit, and the design decisions it holds are recorded in the [ADRs](docs/adr/) and the [changelog](CHANGELOG.md).

## License

MIT. See [`LICENSE`](LICENSE). Third-party software and assets bundled with the app are listed in [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).
