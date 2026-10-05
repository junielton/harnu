# T389 P4W1 part A — live-verify log

Run 2026-10-05 on `claude --version` = `2.1.289 (Claude Code)`, Linux, a second isolated Harnu
instance (`--user-data-dir=/tmp/harnu-verify-p4w1`, CDP port 9333, under `xvfb-run`, renderer served
on its own port through `ELECTRON_RENDERER_URL` because `5174` was taken). Base: this branch, which
has **no companion** (P1W2 not in the base) and **no policy probe** (P1W4 not in the base).
Torn down by PID afterwards.

Fixture home (`HOME=/tmp/mods-home-p4w1`): four `--plugin-dir` mods named by
`CLAUDE_CODE_PLUGIN_DIRS` in its `~/.claude/settings.json` (three public mods from the CLI's
own mods repository, plus one example guard mod), and three plugin folders under
`~/.claude/skills/` (one with no hooks module, two with a hooks module that the CLI reports errors for).

## LV-P4W1-b — no companion

Settings → Mods, read over CDP (`[data-testid="mods-row"]`):

| source       | name        | label          | chips                                                                   |
| ------------ | ----------- | -------------- | ----------------------------------------------------------------------- |
| `boot-arg`   | agents-md   | `--plugin-dir` | files, system-prompt, tool-calls, env, opaque                           |
| `skills-dir` | demo-mod    | skills folder  | (none: the CLI reported errors; "The CLI reported errors in this mod.") |
| `boot-arg`   | diff        | `--plugin-dir` | process, files, prompts, tool-calls, env, terminal, opaque              |
| `boot-arg`   | guard       | `--plugin-dir` | tool-calls                                                              |
| `boot-arg`   | sec-default | `--plugin-dir` | prompts, system-prompt, tool-calls, permissions, gate                   |
| `skills-dir` | tool-calls  | skills folder  | tool-calls, terminal                                                    |

Result: **PASS.** No row has `data-source="harnu"` and there is no placeholder row. The count line
read "1 plugin without a mod is not listed." (the folder with no hooks module). No policy banner
(policy `unknown` on this base, as the spec says).

## LV-P4W1-a (row 1) and LV-P4W1-c (policy) — blocked

- **LV-P4W1-a** needs `ensureStaged()` from P1W2 and `resources/companion/api-surface.json`; neither is in
  this base. **Blocked, not passed.** AC-P4W1-14 is open until the join rebase.
- **LV-P4W1-c** needs P1W4's `classifyPolicyProbe` and its shell. **Blocked, not passed.** The pane
  renders the banner from `ModsAuditView.policy` (component test `tests/mods-audit-pane.test.ts`
  › "shows the policy banner and still lists the rows"), and `setModsAuditPolicyProvider` is the
  seam P1W4 registers into. For when the probe lands, the raw `claude plugin test` outputs on
  2.1.289 were recorded here:

  ```
  # empty directory, normal HOME
  claude plugin test: <dir>: no hooks module to load; there is no hooks/hooks.json naming one in "modules"
  # empty directory, HOME whose .claude/settings.json is {"disableAllHooks": true}
  claude plugin test: hooks modules are turned off here (disableAllHooks, allowManagedHooksOnly or a policy)
  ```

## Findings about the CLI that the spec did not have

Measured on 2.1.289 with `CLAUDE_CODE_PLUGIN_DIRS` set in the settings `env`:

- `claude plugin list --json` also lists a skills-folder plugin, as `<name>@skills-dir`, scope `user`,
  `enabled: true` (it answers Q-P4W1-c: yes, listed; the approval state is still not in the row).
- It lists a `--plugin-dir` plugin, as `<name>@inline`, scope `session`.
- The note label for foreign state reads `state of other plugins, not checked (run validate in a session
with them enabled): <list>`, with a parenthetical before the colon.
- `env writes: nothing` / `env reads: nothing` is printed for an empty list.
- A hook matcher can nest braces: `prompt.context{instructionFiles has {kind=?}}`.
- A call can be `next.to:append` (no `$.`).
- A hook event can be a wildcard: `classic.*`.

Each one is handled in `mods-audit-core.ts` and pinned by a test.
