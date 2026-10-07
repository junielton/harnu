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

## Rerun after the join rebase (2026-10-06, `claude --version` = `2.1.291 (Claude Code)`)

Base: this branch rebased onto `feat/t389-p1w4-arbitration-rollout` (P1W2 `ensureStaged`, P1W4
policy probe in the base). Second isolated instance per run: `electron .` (so `app.getAppPath()` is the
repo root and the stager finds `resources/companion`), `--user-data-dir=/tmp/p4w1a-ud-<run>`, own CDP
port, under `xvfb-run`, an `env -i` environment (no inherited `CLAUDE_*`), a throwaway `HOME` with one
`skills-dir` mod (`demo-gate`). Torn down by PID afterwards. Driver: open Settings → Mods, read
`[data-testid="mods-row"]` and `window.api.modsAuditList(null)` over CDP.

### LV-P4W1-a (row 1, AC-P4W1-14) — PASS

`HOME=/tmp/p4w1a-home-a` (`settings.json` is `{}`). Rows, in order:

| source       | name              | label         | chips                                                                         |
| ------------ | ----------------- | ------------- | ----------------------------------------------------------------------------- |
| `harnu`      | `harnu-companion` | Harnu mod     | can use the network, can read and write files, can read environment variables |
| `skills-dir` | `demo-gate`       | skills folder | can rewrite or block tool calls                                               |

Chip ids `network, files, env` equal what `resources/companion/api-surface.json` implies
(`$.http.fetch` → network, `$.fs.read` → files, `envReads: [HARNU_SPAWN_TOKEN]` → env; none of its
three hooks maps to a chip). `unparsed` is empty. App log: `[companion] policy probe: loads`.
Screenshot: `P4W1-lv-a-row1.png`.

### LV-P4W1-c (policy, AC-P4W1-15) — PASS

`HOME=/tmp/p4w1a-home-c` whose `.claude/settings.json` is `{"disableAllHooks": true}`. The banner
`[data-testid="mods-policy-banner"]` read "Turned off by a setting or by your organization's policy."
(`policy: off-here`), and both rows were still listed. App log: `[companion] policy probe: off-here`.
Screenshot: `P4W1-lv-c-policy.png`.

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

## Findings from the join rebase (CLI 2.1.291)

- `claude plugin test` in an **empty** directory prints `no hooks module to load; …` when mods
  are on. P1W4's classifier knew only the staged directory's line (`no *.test.ts …`), so AC-P4W1-9, which
  probes an empty directory, would have read `unknown`. `classifyPolicyProbe` now also maps it to `loads`.
- `plugin validate --json` on 2.1.291 adds a `gatingHooks` key to `manifest` and every `contents[]`
  entry, a note `<file> gating hook without .catch: <hooks>`, and `<file> calls: nothing on $` for a
  module that makes no call. The first was an unparsed note; the parser now keeps the advisory as a
  warning and reads `nothing on $` as an empty list. The shape snapshot was re-recorded (additive key).
