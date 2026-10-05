# Security Policy

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues, discussions, or
pull requests.**

Instead, report them privately through **GitHub's [private vulnerability
reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)**
— open the repository's **Security** tab and choose **"Report a vulnerability"**. This is the
preferred channel: it routes straight to the maintainers, keeps the report private until a fix
ships, and needs no third-party inbox. It is the only channel; there is no security mailbox.

Please include:

- A description of the issue and its impact.
- Steps to reproduce (or a proof of concept).
- Affected version(s) and platform(s).
- Any suggested mitigation, if you have one.

## Disclosure window

- We aim to **acknowledge** your report within **72 hours**.
- We aim to provide an initial assessment and remediation plan within **7 days**.
- We follow **coordinated (responsible) disclosure**: please give us up to **90 days** to ship
  a fix before any public disclosure. We're happy to credit you in the release notes and the
  advisory unless you'd prefer to remain anonymous.

## Scope and threat model

Harnu is a local desktop app — there is no Harnu-operated server or cloud account. It is a UI
over files that already exist on your machine. Two parts of its behavior are security-relevant
and worth understanding:

- **It spawns PTYs / shell and `claude` processes.** Selecting or creating a session launches
  a real terminal process (`bash`, `claude --resume <uuid>`, etc.) with your user's
  privileges. Anything you can do in a terminal, a session can do.
- **It reads `~/.claude`.** The app reads `~/.claude/projects/` (session JSONL +
  `sessions-index.json`) and related Claude Code config to render the sidebar. It does not
  transmit this data anywhere.
- **`create_worktree` runs committed `WORKTREE.md` setup scripts.** When the optional MCP
  control server is enabled and a folder is agent-allowed, an agent's `create_worktree` request
  can cause Harnu to execute the `setup:` / `create:` / `remove:` shell commands the repo author
  committed to that repo's `WORKTREE.md` — with your user's privileges. Those commands are
  **trusted committed content** (like a git hook), never agent-supplied: the agent controls only
  the pre-validated branch name, not the command strings or the target path. Every such run is
  gated by a **fail-closed operator confirm that discloses the exact commands verbatim** before
  you approve — an unanswered confirm denies. Treat approving a `create_worktree` on a repo whose
  `WORKTREE.md` you don't trust as running that script yourself. There is deliberately **no
  `remove_worktree` agent tool**.

Reports we're especially interested in: command/argument injection into spawned processes,
path traversal when reading `~/.claude`, IPC channels that could let the sandboxed renderer
escalate beyond the typed `window.api` surface, and the auto-update path (signature/origin of
downloaded artifacts).

Out of scope: vulnerabilities in the `claude` CLI itself (report those to Anthropic), in
third-party dependencies that are already publicly tracked, and issues that require an attacker
to already have local code-execution as the same user.

## Supported versions

Harnu is pre-1.0 and ships from a single release line. Security fixes land on the **latest
released version** only; please upgrade to the newest release before reporting.

| Version        | Supported          |
| -------------- | ------------------ |
| Latest release | :white_check_mark: |
| Older releases | :x:                |
