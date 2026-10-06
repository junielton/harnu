# T389 P4W3 — live-verify log

Run 2026-10-06 on Linux. Branch `feat/t389-p4w3-outside-harnu`, base `feat/t389-p4w1-mods-tab-a`
(P1W4 below it; **P1W5 and P2W1 are not in the base**, so the mod declares `sense.identity` only
and the host has no command channel yet).

## Safety rule, and how it was kept

This wave writes a user's Claude settings, so every run used a throwaway root created for it:
`HOME`, `CLAUDE_CONFIG_DIR`, the Harnu `--user-data-dir`, the project folder and the install
record all live under `/tmp/harnu-lv*` and `/tmp/harnu-lvapp*`. Each run **printed the resolved
settings path before anything was read or written** (first line of every log) and aborts when it
is under the real `~/.claude` (`assertThrowaway` in `tests/cli/support/run-interactive.ts`, the
same check at the top of `lv-p4w3/drive-app.mjs`). The real `~/.claude/settings.json`,
`~/.claude.json` and Harnu data were never opened. No credential was copied anywhere: every
session ran "Not logged in", which is enough for `session.start` and the hello.

## Which CLI

The installed `claude` is **2.1.291**, above the tested ceiling (**2.1.290**, not moved). With it
the host caps the `external` key at off (contract §11.5), so a live run against the installed CLI
could only show refusals. The runs below therefore use the **ceiling release itself**: the
official `@anthropic-ai/claude-code@2.1.290` package installed into a scratch directory
(`npm install --prefix <scratch>`), first on `PATH`, `DISABLE_AUTOUPDATER=1`. The pipeline's
`cli` step ran against the installed 2.1.291 and passed too.

```
claude --version        2.1.290 (Claude Code)      (recipes, real app)
claude --version        2.1.291 (Claude Code)      (pipeline cli step)
```

## Files

| File                                                          | What                                                                      |
| ------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `lv-p4w3/lv-app.log`                                          | the real Harnu second instance driven over CDP (confirm, on, hello, off)  |
| `lv-p4w3/drive-app.mjs`                                       | the driver (xvfb, `electron .`, `env -i`, own CDP port, torn down by PID) |
| `lv-p4w3/lv-cli-suite.log`                                    | one line per fact from `tests/cli/external.cli.test.ts`                   |
| `lv-p4w3/lv-cli-suite.vitest.txt`                             | the vitest output of that run (7 tests, all passed)                       |
| `P4W3-pipeline.json`                                          | `local-pipeline.sh --with-cli --with-e2e` summary (13 steps, 0 failed)    |
| `P4W3-confirm.png`, `-light.png`                              | AC-P4W3-19: the confirm dialog, dark and light                            |
| `P4W3-switch-on-{dark,light}.png`, `P4W3-switch-off-dark.png` | the switch in the Mods tab                                                |

## LV-P4W3-a — CQ18 (AC-P4W3-12) — PASS, with the real host

`tests/cli/external.cli.test.ts` › "LV-P4W3-a (a)" and "(b)", a real interactive `claude` in tmux
against the real host server:

- **(a) a plain terminal, settings `env` alone** (no `--plugin-dir`, no spawn token): the debug
  file has **one** `hooks module harnu-companion@inline loaded` line; the host saw **one** hello of
  kind `external`, profile `external`, no refusal. **Q-P4W3-a answered: yes**, the settings `env`
  key loads the mod like the process env did in smoke A1.
- **(b) a Harnu-spawned session with the flag AND the env key naming the same directory**: **one**
  loaded line, **one** hello of kind `spawn`, zero `UNAUTHORIZED`, held for a further 3 s (a second
  instance would have said hello again within a heartbeat). **Q-P4W3-b answered: one module
  instance, not two.** R24 does not materialise, so Harnu keeps its own `--plugin-dir` while the
  switch is on (the fallback of Q-P4W3-b is not needed).
- **a scheduler tick** (`--setting-sources ''`, tick-shaped argv) with the env key set: one loaded
  line, no hello (no token, not interactive).

```
LV-a(a): loaded lines=1, hellos=[["external","external"]]
LV-a(b): loaded lines=1, hellos=[["spawn","interactive"]], helloOk=1, refused={}
tick: loaded lines=1, hellos=0
```

## The real app (second isolated Harnu, CLI 2.1.290) — PASS

`lv-p4w3/lv-app.log`. Highlights, in order:

1. `externalGet` before: `on:false`; the settings file is byte-identical to its baseline.
2. Settings → Mods → Advanced shows the hint, the row, the path line and "No outside session has
   reported yet." (`P4W3-switch-off-dark.png`).
3. The toggle opens the confirm dialog first; **the file is unchanged while it is open**
   (`P4W3-confirm.png`, `-light.png`); **Cancel** closes it and leaves the file untouched.
4. **Turn on**: exactly one key is added, `env.CLAUDE_CODE_PLUGIN_DIRS` = the staged directory;
   every other key is unchanged; the post-install check (`claude plugin list --json`) ran.
5. A plain `claude` in tmux, settings `env` alone: `companionDiagnostics()` shows one binding,
   `profile: external`, `sessionKey: null`, `enabled: ["sense.identity"]` (no `gate.approval`,
   nothing that acts), `proven: ["sense.identity"]`. One loaded line.
6. Corroboration: the CLI wrote `~/.claude/sessions/<pid>.json` in the throwaway config dir;
   `companionStatus().sessions[sid].state` = `{"state":"live","outside":true}`, which the hover
   preview words as "Harnu mod: live · outside Harnu". **Q-P4W3-g answered: on 2.1.290 on Linux the
   registry entry carries `cwd`.**
7. **Turn off**: `externalGet` → `on:false`; the file is **byte-equal** to the baseline (and JSON
   equal); the live binding is revoked (no external binding enabled afterwards).

Baseline note. Harnu's own legacy hook installer rewrites the `hooks` key of `settings.json` when
the app boots (existing behaviour, not this wave). The "untouched" and "exact undo" comparisons
therefore use the file as it is once the app has settled; the log states that it differed from the
seeded file.

## LV-P4W3-b (AC-P4W3-13) — **BLOCKED**, not passed

Two independent reasons, either is enough:

1. It needs a model turn and a permission dialog, so a **signed-in CLI**. The harness's rule is
   that no credential is ever copied into a throwaway HOME (`docs/dev/companion-mod.md`), and the
   real `~/.claude` must not be used as the config dir while the switch writes to its settings.
2. It needs the mod to report **turn state** (`sense.turn`, `sense.attention`): that is **P1W5**,
   which is not in this base. The mod here declares `sense.identity` only, so no `working` /
   `needs-input` event exists to be flushed.

What was shown instead: the corroborated outside binding reaches the row's **state line** and the
hover preview (step 6 above). The "Active elsewhere" zone and the row's dot still follow the
registry and transcript tiers until P1W5 lands and the `taskState` family flips.

## LV-P4W3-c (AC-P4W3-18) — PASS

`tests/cli/external.cli.test.ts` › "LV-P4W3-c", install shell against a throwaway HOME with the
real post-install check on the real CLI:

```
LV-c: before {"permissions":{"allow":["Read"]},"cleanupPeriodDays":30,"tui":"fullscreen"}
LV-c: on     {…same keys…,"env":{"CLAUDE_CODE_PLUGIN_DIRS":"<throwaway>/harnu-companion"}}
LV-c: off    {"permissions":{"allow":["Read"]},"cleanupPeriodDays":30,"tui":"fullscreen"}
LV-c: second session: harnu-companion lines=0, new hellos=0
```

The restored file is JSON-equal and, for a CLI-formatted file, **byte-equal**. A new session in the
same HOME after the undo loads no mod and sends no hello.

Finding. The post-install check runs the CLI against the user's real settings, and the CLI is
not read-only about them: with `"model": "opus"` in the file, `claude plugin list --json` on 2.1.290
rewrote it to `"opus[1m]"` and reordered keys (its own migration). The undo is exact relative to
the file as the CLI left it. The fixture avoids migratable keys; a user whose file the CLI would
migrate anyway sees the same change on their next ordinary `claude` run.

## L4 (`--with-cli`) — AC-P4W3-14, -15, -16 — PASS

- **-14 approvals are not held by default**: a real session in a folder not on the ramp, a prompt
  attempt (the CLI answers "Not logged in" at the terminal): **zero `ask` requests of any kind**
  reached the host (asks registered for `permission`, `status`, `sentinel`), and `gate.approval`
  is not in `enabled`. Limit: no model turn exists in a hermetic run, so no permission dialog
  could open; the assertion is structural (nothing is enabled that could ask).
- **-15 Harnu absent is a no-op**: the rendezvous file does not exist; the session starts, takes
  a prompt attempt and stays usable; **zero** `hook skipped` / `failed` lines for the mod (the
  mod's own `$.fs.read … ENOENT` is its backoff, not a hook failure). Limit: same, "the turn
  completes" is a prompt attempt that fails at sign-in.
- **-16 probes stay silent**: `claude -p` runs with the env key active and no token reach the
  host with **zero hellos**; wall time medians of 3: baseline 1050 ms, with the key 1149 ms
  (+9%). On an earlier run the figures were 669 → 822 ms (+23%): a 0.7 s zero-model run is
  dominated by loading the mod, not by anything it sends, so the test allows 10% **or** 250 ms.

This suite found one real defect that the mod rig cannot reproduce: `classic.SessionStart`
dispatches before `session.start` on a real CLI and the two overlap, so the early hello of a
**headless** tokenless run could reach the network once `boot` was set. Fixed by re-checking the
headless guard just before the request; "probes stay silent" is the regression guard.

## Not done here

- **The managed-machine run (AC-P4W3-20, Q-P4W3-c, OD-5, R23) did not happen**: no managed machine
  is available. What exists is code and unit coverage: the managed-settings paths come from the
  CLI's own strings and debug log (`/etc/claude-code` printed by 2.1.290 as missing, the macOS and
  Windows paths and the `managed-settings.d` directory from its strings), a managed file refuses
  with no write, and the post-install check rolls back when the CLI's refusal names managed
  settings. The CLI's refusal reads "disabled by your organization's managed settings
  (disableSideloadFlags)" in its strings; **it has not been seen from a managed machine**. A policy
  delivered through the Windows registry (`HKLM\SOFTWARE\Policies\ClaudeCode`) or a macOS MDM
  profile is not a file and is caught only by the second net.
- Windows and macOS were not run.
