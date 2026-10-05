# Harnu user guide

Harnu is a desktop app that turns the sprawl of running and idle Claude Code sessions into one browsable workspace. This guide covers how to _use_ Harnu — for the visual design system see `design.md`, and for how the codebase is put together see `CLAUDE.md`.

## Guide

- [Getting started](getting-started.md) — install, first launch, adopting a folder, starting your first session.
- [Sessions](sessions.md) — new / resume / fork, the terminal pane, splits, the command palette, shortcuts.
- [Folders and worktrees](folders-and-worktrees.md) — the flat folder list, pin vs. hide, repo groups, git worktrees, the `WORKTREE.md` manifest.
- [Fleet rail](approval-inbox.md) — the fleet's live state at a glance, confirms, "always allow this verb here", mission grants (budget + TTL), the hook interceptor, and the Topbar Activity bell.
- [Agent control](agent-control.md) — what a session can do from inside Harnu via its MCP server (the human-readable counterpart to `docs/harnu-features.md`, which is written for the agent, not for you).
- [Bundled skills](bundled-skills.md) — the skills Harnu ships, the per-skill on/off panel, per-project overrides, and the opt-in install outside Harnu.
- [Project memory](project-memory.md) — `.harnu/memory/`, the hot/decisions/roadmap pages, the memory pane.
- [Roadmap board](roadmap-board.md) — the kanban, card kinds, dispatch, the manifest gate, substrate, model routing.
- [Review pane](review-pane.md) — the branch diff plus its receipts, side by side
  with the card that asked for it: what changed, what is missing, Close or bounce back.
- [PR Stack](pr-stack.md) — the merge chain of your open PRs on a canvas: which
  branch to deploy to staging, which PR to merge next, and the base-merged hazard.
- [Canvas pane](canvas.md) — the whiteboard that lives in your worktree as a file: how to open one, how to read and move around a board, and what is still read-only.
- [Claude Boot](claude-boot.md) — per-folder launch options, model/effort, custom endpoints.
- [Usage](usage.md) — the plan usage popover, usage history, the usage dashboard.
- [System Monitor](system-monitor.md) — the live process/session task-manager view, and why a parked session shows a dash.
- [Scheduler](scheduler.md) — recurring workers that run a prompt on a timer without opening a session: `observe` vs. `act`, what a cadence costs, and the limits worth knowing before you turn one on.
- [Cleanup](cleanup.md) — the guarded worktree/branch deletion view, the checkpoint timeline, the sweep confirm dialog, and the safety model (trash, reflog, journal).
- [Containers](containers.md) — every docker stack on your machine, sorted into zombies, orphans and the ones to leave alone: what they cost, stop / start / remove, and the undo for each.
- [Voice](voice.md) — having Harnu read things to you: your own TTS command, and the opt-in ~119 MB offline neural voice (English only, and why the download includes the code).
- [Settings](settings.md) — themes, the `settings.json` editor, notifications/push channels, the changelog tab.
- [Extensions](extensions.md) — user-installable theme + board-template packs from `~/.claude/capy-extensions/`, hot-reloaded, zero code execution.
- [Troubleshooting](troubleshooting.md) — Gatekeeper/SmartScreen, Wayland/KDE flakiness, the `.deb` not auto-updating, `npm: not found` in fresh worktrees.

Every PR that ships a new user-visible capability must add or update a page here — see the "User docs are mandatory" contract in `CLAUDE.md`.
