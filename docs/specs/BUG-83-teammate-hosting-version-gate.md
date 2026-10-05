# BUG-83 — Teammate hosting rides a contract frozen at claude 2.1.193 with no version gate at all

**Date:** 2026-08-05 · **Status:** specified (not implemented) · **Card:** `.capy/memory/roadmap/BUG-83-teammate-hosting-is-pinned-to-claude-2-1-193-by-a-filename.md`
**Depends on:** T200 (`.capy/memory/roadmap/T200-detect-the-installed-claude-code-version-at-boot-nothing-in.md`) — this card consumes its gate; it does not build one.

## 1. Symptom

Installed CLI, recorded verbatim from `claude --version` on 2026-08-05:

```
2.1.222 (Claude Code)
```

`readlink -f $(which claude)` → `/home/u/.local/share/claude/versions/2.1.222` (the native
installer keeps 2.1.219–2.1.222 side by side).

The frozen contract Capy hosts teammates against was captured on **2.1.193**
(`scripts/spikes/it2-argv-CONTRACT.md:1`, 2026-06-26). **29 patch releases separate the capture
from the machine running it**, and nothing in the codebase compares the two — there is no
`claude --version` call anywhere (audit §3.7). Teammate hosting is a per-session toggle
(**Host teammates**, `SessionMenu.vue:613-624`) that can only report success: it turns on, the
session restarts, and whether a teammate can actually be hosted is discovered — or not discovered
— much later, in the main-process log.

**Correction to the card's premise, verified.** The card states hostability is gated "by a
hardcoded version string (`2.1.193`, `2.1.193-beta.1`)". It is not. The regex at
`it2-parse.ts:233` is

```ts
const CLAUDE_VERSION_BASENAME = /^\d+\.\d+\.\d+([.\-+].*)?$/
```

which is **version-agnostic** — `2.1.222` matches it exactly as `2.1.193` does. `2.1.193` appears
only as an _example_ in the doc comment (`:232`). The regex is an anti-RCE basename allowlist
(D1/T07, `it2-parse.ts:319-327`), not a version pin, and it is doing its job.

The real pin is softer and worse: **the argv shape, the lifecycle FSM and the backend-selection
mechanism are frozen prose, asserted by tests built from one 2.1.193 capture, with no runtime check
that the installed CLI still behaves that way.** That is what this card must fix.

## 2. Current behaviour, verified

### 2.1 What is actually frozen at 2.1.193

| Frozen artefact                                                   | Where                                                                            |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Lifecycle `list → split -v -s → send → run`                       | `it2-argv-CONTRACT.md:11-25`, restated `it2-parse.ts:12-18`, `it2-plan.ts:11-24` |
| Chain shape `cd X && env K=V… <bin> --agent-id …`                 | `it2-parse.ts:274-345` (`extractHostableCommand`)                                |
| Teammate flag set (8 flags)                                       | `it2-parse.ts:242-251` (`FLAG_FIELDS`)                                           |
| Backend selection via `--teammate-mode iterm2` on the lead's argv | `pty.ts:767-776`                                                                 |
| iTerm2 identity env the lead is given                             | `it2-shim-build.ts:192-200`                                                      |
| Test fixtures built from the capture                              | `tests/it2-parse.test.ts:11,33,143,313`                                          |

`FLAG_FIELDS` parses `--agent-id` (required, `it2-parse.ts:340-344`), `--agent-name`,
`--team-name`, `--agent-color`, `--parent-session-id`, `--agent-type`, `--effort`, `--model`.

### 2.2 The spawn path

`pty.ts:705-719` — `kind: 'teammate'` hosts the lead-supplied `claudeBin` + argv **verbatim and
without a shell**; `mcpArgsProvider()` is deliberately not called, so a teammate never gets Capy's
`--mcp-config` (no recursive Conductor). `pty.ts:746-752` forces `CLAUDECODE=1` +
`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` into the child env (the renderer wire spec drops the
chain's `env K=V…` prefix). `pty.ts:761-776` gives the _lead_ the it2 host-env and appends
`--teammate-mode iterm2`, guarded on `isClaudeLead` so a teammate can never re-host.
`pty.ts:437-457` (`downgradeArgvPermission`) strips `--dangerously-skip-permissions` and rewrites
`--permission-mode[= ]bypassPermissions` → `manual`. Orthogonal to the version question and
**must survive unchanged**.

### 2.3 Today's failure mode is silent — three distinct silences

1. **Backend never selects.** If the installed CLI stops honouring `--teammate-mode iterm2`, or
   refuses the backend, the lead simply never invokes `it2`. Capy sees nothing: no bridge request,
   no log line, no UI change. The toggle reads "on" forever.
2. **Chain shape drifts.** `extractHostableCommand` returns `{ error }`, `handleRun` answers 403
   with a `console.warn` (`it2-bridge.ts:252-256`). The main-process console is not a user
   surface; the operator sees the lead's `curl -f` failure on the _teammate's_ stderr, if they
   happen to be reading the lead pane.
3. **Version mismatch.** Not detected at all — there is no comparison to fail.

None of the three produces an error in Capy's UI. `MenuToggle` (`SessionMenu.vue:91-105`) has
`id/kind/label/icon/hint/hintWrap/isOn/onToggle` and **no `disabled` and no `reason` field** —
the menu is structurally incapable of expressing "unavailable, because X".

### 2.4 What the installed 2.1.222 binary actually says

Read-only string extraction from `/home/u/.local/share/claude/versions/2.1.222`. **All eight
teammate flags and `--teammate-mode` are still present** (`--teammate-mode <mode>  How to spawn
teammates: iterm2, in-process, auto`; `--agent-id <id>  Teammate agent ID`; `--effort` is the only
one in public `--help`). The reply the shim must print is unchanged — the CLI still parses
`Created new pane:\s*(.+)`. One new constraint string appears:
`--agent-id, --agent-name, and --team-name must all be provided together`.

Three behaviours that **did not exist in the frozen capture**:

- A hard **"am I inside iTerm2"** gate that throws a user-facing error: `teammateMode is set to
"iterm2" but this session is not running inside iTerm2. Launch Claude from iTerm2, or change
teammateMode in settings.` (telemetry `swarm_backend_detect: iterm2_explicit_not_in_iterm2`).
  The 2.1.193 contract explicitly recorded "**NO darwin gate**" (`it2-argv-CONTRACT.md:8-9`).
- An **`it2` presence probe through a login shell** — `$SHELL -lc "command -v it2"`, 2 s timeout,
  failing to `iterm2_explicit_no_it2`. Capy injects its shim by prepending `shimDir` to the
  spawned lead's `PATH` (`it2-shim-build.ts:184-193`); a login shell re-sources the user's profile,
  so a profile that assigns `PATH` outright would hide the shim.
- An **`it2 session list` verification pass** whose exit code and stderr are sniffed for
  `api`/`python`/`connection refused`/`not enabled` → `Python API not enabled in iTerm2 preferences`.

Capy's lead env sets only `TERM_PROGRAM=iTerm.app`, `LC_TERMINAL=iTerm2`, `ITERM_SESSION_ID`
(`it2-shim-build.ts:194-196`). The spike that produced the frozen capture additionally set
`TERM_PROGRAM_VERSION=3.5.0`, `LC_TERMINAL_VERSION=3.5.0`, `__CFBundleIdentifier` and
`ITERM_SHELL_INTEGRATION_INSTALLED` (`capture-it2-argv.sh:33-36`) — **production is a narrower
identity than the one the contract was captured under**, a pre-existing divergence that matters now
that a detection gate exists. The binary also contains a `TERM_PROGRAM==="iTerm.app"` → version
≥ 3.6.6 comparison; whether it guards _this_ gate is unresolved (§4.5 O1).

## 3. What moved upstream since 2.1.193

| Change                                                                                                 | Version  | Consequence for Capy's contract                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Teammates can no longer spawn nested teammates                                                         | v2.1.69  | Upstream now enforces what `pty.ts:761-776` enforces structurally. No change needed; the invariant is now belt-and-braces.                                                                                                                                       |
| Team agents inherit the leader's model                                                                 | v2.1.72  | `--model` in `FLAG_FIELDS` may arrive absent or as the lead's value. Already optional (`it2-parse.ts:84`) — must **stay** optional, never required.                                                                                                              |
| `SendMessage` relayed cross-session loses user authority                                               | v2.1.166 | Relayed messages carry no operator authority. Nothing to change in the argv contract; relevant to how the board narrates teammate messages (§4.6).                                                                                                               |
| **`TeamCreate`/`TeamDelete` removed** — one implicit team per session                                  | v2.1.178 | `--team-name` is **accepted but ignored**. `it2-parse.ts:73` already treats `teamName` as optional and `it2-bridge.ts:215` already synthesizes `'team'` when absent. The re-capture must confirm the flag is still _emitted_; nothing may become required on it. |
| `teammateMode: "iterm2"` added as a **setting**                                                        | v2.1.186 | Argv may no longer be the intended door. Now paired with the "not running inside iTerm2" throw (§2.4) — settings and argv reach the same gate.                                                                                                                   |
| `SendMessage` detects a re-spawned agent reusing a name                                                | v2.1.199 | Agent names are no longer unique keys over time. `team-parse.ts` joins by `agentId`/`agentName`; a re-spawn can now collide.                                                                                                                                     |
| `SendMessage` truncates long summaries; auto-mode `SendMessage` goes through the permission classifier | v2.1.222 | Teammate messages can now raise a permission prompt. Capy's approval surfaces must not assume a teammate's `SendMessage` is silent.                                                                                                                              |

**Net for the argv contract: the flag set survives intact.** The breakage risk moved to _backend
selection and environment detection_, not to the shape of the chain. That inverts where the fix
belongs.

## 4. Decision

### 4.1 Replace the absence-of-a-gate with a version **range**, consumed from T200

`it2-parse.ts:233` stays exactly as it is — it is an RCE allowlist, not a version check, and
narrowing it to a supported range would reintroduce the arbitrary-binary hole for any binary named
`claude`. Rename nothing; only correct the `2.1.193` example in the comment.

The new gate is a **separate, main-process, non-pure module** — `src/main/it2-support.ts` — because
it needs T200's probed version (impure). It exports:

```ts
/** Inclusive lower bound; `max` is the highest version the contract was verified against. */
export const IT2_SUPPORTED_RANGE = { min: '2.1.193', max: '<re-capture version>' }

export type It2Unavailable =
  | { reason: 'cli-not-found' }
  | { reason: 'version-unknown' } // probe failed — T200 AC3
  | { reason: 'version-too-old'; installed: string; min: string }
  | { reason: 'version-untested'; installed: string; max: string }

export function checkIt2Support(installed: string | null): It2Unavailable | null
```

- **A range, never a single version.** `min` = the oldest version the contract is known to hold
  for; `max` = the newest it was _verified_ against. Above `max` is `version-untested` —
  **permitted with a visible warning**, not blocked; blocking there would mean every CLI release
  breaks hosting until Capy ships, the same silent-loss shape from the other direction.
- **`version-unknown` permits and warns** — T200 AC3 requires an unparseable probe to be non-fatal
  and never block a spawn.
- Only `cli-not-found` and `version-too-old` actually refuse.

### 4.2 The reason is visible — exactly where

Three surfaces, in order of who sees it first:

1. **The "Host teammates" toggle** (`SessionMenu.vue:613-624`). `MenuToggle` (`:91-105`) gains
   `disabled?: (sessionId) => boolean` and `disabledHint?: string`. When `checkIt2Support` refuses,
   the row renders non-interactive with the reason **replacing** the `hostTeammates.disclosure`
   hint — a slot already designed for a full wrapped paragraph (`hintWrap: true`). This is the fix
   for the headline defect: the operator learns hosting is unavailable _at the moment they reach
   for it_. `design.md` §6 (Context menu) gains the disabled-toggle-with-reason state.
2. **A toast on a refused `run`** (`it2-bridge.ts:253-256`). The 403 path keeps its `console.warn`
   and adds one toast — "A teammate spawn was refused: `<reason>`" — so the parse-rejection silence
   (§2.3 case 2) becomes visible too. Rate-limited to one per lead per session; a runaway lead must
   not spray toasts.
3. **Settings → Claude Code**, beside the version T200 already surfaces (T200 AC4): one line with
   the supported range and whether the installed version is inside it. The only place the _warning_
   states (`version-untested`, `version-unknown`) appear — they must not gate or nag the toggle.

New i18n keys in **both** `en.json` and `pt-BR.json`, one per reason plus the two warning states.

### 4.3 `teammateMode` setting vs `--teammate-mode` argv — keep argv

`pty.ts:775` keeps appending `--teammate-mode iterm2`. The flag is **still present in 2.1.222**
with the same three values (§2.4) — not deprecated. The setting is user-global while the toggle is
deliberately **per-lead** (`sessions.ts:1563-1599`), so writing a global setting to express a
per-session opt-in would silently change every other session's behaviour, including sessions Capy
did not spawn. Both roads reach the same "not inside iTerm2" gate anyway, so switching buys nothing.

**Rejected:** (a) writing `teammateMode` into the user's `settings.json` — scope mismatch above;
(b) offering both and letting the user pick — a second way to configure one thing, the shape of bug
this card closes.

### 4.4 The re-capture method — the reusable part

`scripts/spikes/capture-it2-argv.sh` already implements this and **must be re-run, not rewritten**.
It is interactive by necessity: the iterm2 backend is lazy and only invokes `it2` when a teammate
spawn is _approved_ (`capture-it2-argv.sh:3-6`). Method:

1. Run `claude --version`; record it **verbatim** — it is the first line of the new capture.
2. Run `bash scripts/spikes/capture-it2-argv.sh` in a real terminal (logging `it2` first on `PATH`,
   it2 stdout emulated so the lead completes the lifecycle, tmux stripped, interactive lead).
3. Ask the lead for a teammate and **approve** the spawn.
4. Quit; the trap prints the capture. Raw log → `scripts/spikes/it2-argv-captured.raw.txt`
   (overwrite — the 2.1.193 raw log has no value once the contract doc enumerates the diff).

**What to record** beyond the raw argv: the version string; the full ordered verb sequence including
any **new** verb (the `it2 session list` verification pass of §2.4 may now precede the first split);
the exact `run` chain; every flag emitted **and** every `FLAG_FIELDS` flag now **absent** (esp.
`--team-name` after v2.1.178 and `--model` after v2.1.72); and the env the lead had when detection
**succeeded** — specifically whether `TERM_PROGRAM_VERSION` / `__CFBundleIdentifier` were required.

**Where the updated contract lives:** `scripts/spikes/it2-argv-CONTRACT.md`, in place. Its title
line moves off `FROZEN from real capture (claude 2.1.193…)` to the new version, and it gains a
**"Differences from the 2.1.193 capture"** section — enumerated, never silently overwritten, so the
next upgrade diffs against a stated baseline instead of re-deriving one. `it2-parse.ts:10,63`,
`it2-plan.ts:11-12` and `tests/it2-parse.test.ts:11` get their version references updated in the
same change.

### 4.5 Open questions the re-capture must answer

- **O1 (blocker — settle first)** — Does the "inside iTerm2" detection accept Capy's three env
  vars, or require `TERM_PROGRAM_VERSION` / `__CFBundleIdentifier` / iTerm2 ≥ 3.6.6? If more is
  needed, `buildTeammateHostEnv` (`it2-shim-build.ts:192-200`) widens and
  `tests/it2-shim-build.test.ts:129` asserts the new keys. Most likely live break.
- **O2** — Does `$SHELL -lc "command -v it2"` see Capy's `shimDir`? If the login shell rebuilds
  `PATH`, the shim must live where the user's profile keeps it, or detection be satisfied otherwise.
- **O3** — Does the CLI now try to **install** `it2` (`swarm_iterm2_it2_install`) when the probe
  fails, and can that clobber the shim on `PATH`?
- **O4** — Is `it2 session list` still only step 1, or also a pre-flight whose stderr is sniffed?
  The bridge already handles `list` (`it2-plan.ts`), but the shim must exit 0 and emit nothing
  matching `api|python|connection refused|not enabled`.

### 4.6 `mcp/team-parse.ts` — not changed by this card

`team-parse.ts:3-23` documents the messy on-disk reality it already defends against: **26 team
config dirs vs ~390 task dirs**, teammates with no resolvable session id, empty inboxes, defensive
joins, malformed JSON skipped rather than thrown. It reads `~/.claude/teams/*/config.json` and
`~/.claude/tasks/*/*.json` — **a different surface from the it2 argv contract**, which is all this
card re-captures. v2.1.178 does not affect it (it already tolerates a team with zero tasks and a
task dir with no team). The one change that does — v2.1.199, a re-spawned agent reusing a name,
which can now collide with a stale member on the `agentId`/`agentName` joins — is a real defect but
**not this card**; file it separately rather than widening a version-gate card into a reader refactor.

## 5. Acceptance

- Hosting availability is decided by a **version range** read from T200's cached probe — never by a
  binary basename, never by an unstated assumption.
- Every unavailable state has a **reason the operator can read in the UI**. Zero silent no-ops.
- `version-untested` and `version-unknown` **permit** hosting and warn; only `cli-not-found` and
  `version-too-old` refuse.
- The contract doc names its capture version and enumerates its differences from the 2.1.193
  capture; `it2-parse.ts`, `it2-plan.ts` and the test fixtures agree with it.
- Nothing becomes required on `--team-name` or `--model` (v2.1.178, v2.1.72).
- `downgradeArgvPermission` (`pty.ts:437-457`) unchanged and still applied; no teammate can re-host
  (`pty.ts:767` `isClaudeLead` guard intact).

## 6. Test plan

| Test                                                                                                                                                                               | File                                                                                                      | Asserts                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `checkIt2Support` — below `min` refuses `version-too-old`; inside range returns `null`; above `max` returns `version-untested`; `null` input returns `version-unknown`             | `tests/it2-support.test.ts` (**new**, pure core)                                                          | §4.1                         |
| Re-captured chain parses: the new `run` chain extracts `cwd`/`env`/`claudeBin`/`args`/`agentId` and every flag present in the capture                                              | `tests/it2-parse.test.ts` (existing — replace the `2.1.193` fixtures at `:33,143,313`)                    | §4.4                         |
| `--team-name` absent → `teamName` undefined and `--model` absent → `model` undefined; extraction still succeeds (v2.1.178, v2.1.72)                                                | `tests/it2-parse.test.ts` (existing `extractHostableCommand (happy path)`, `:104`)                        | §3, §5                       |
| Every BLOCKER-2 rejection still holds against the re-captured shape; a version basename is still accepted and a shell/interpreter basename still rejected (the regex is untouched) | `tests/it2-parse.test.ts` (existing `…SECURITY (BLOCKER-2…)`, `:163`)                                     | no security regression; §4.1 |
| `buildTeammateHostEnv` emits whatever identity keys O1 proves are required                                                                                                         | `tests/it2-shim-build.test.ts` (existing `buildTeammateHostEnv — iterm2 identity + bridge reach`, `:129`) | §4.5 O1                      |
| Pane registry / lifecycle FSM unchanged, or updated in lockstep if a new verb appears                                                                                              | `tests/it2-plan.test.ts` (existing `planIt2`, `:234`)                                                     | §4.4                         |
| Not bypassable through the bridge: an unminted pane and a refused `cwd` still 403                                                                                                  | `tests/it2-bridge-gate.test.ts` (existing, `:35-138`)                                                     | §5                           |
| `pane.teammate` still routes with the re-captured payload shape                                                                                                                    | `tests/command-router.test.ts` (existing `pane.teammate (it2 host, headless)`, `:191`)                    | §2.2                         |
| Team board joins unaffected by the re-capture                                                                                                                                      | `tests/team-parse.test.ts` (existing `buildTeamBoard (defensive joins)`, `:278`)                          | §4.6 (no change expected)    |

**Honest gap.** No unit test can prove the CLI still drives the lifecycle — that is what the
interactive capture (§4.4) is for, and its output is evidence, not a test. `src/main/pty.ts` is a
coverage-excluded imperative shell, so the `--teammate-mode` append and the teammate env are
verified by reading the capture log, not by vitest. Record the log path in the PR.

## 7. Contracts touched

- **`CHANGELOG.md` — YES.** `### Fixed`: teammate hosting now says why it is unavailable instead of
  silently not working, and is gated on a supported CLI version range.
- **`docs/capy-features.md` — NO.** `tool-catalog.ts` untouched, no ACK field change, no
  grant/confirm change, and no affordance the agent should offer — the toggle is an operator gesture
  the session cannot invoke. Label **`no-awareness`** if the gate trips on an unrelated file.
- **`docs/user/` — YES.** `docs/user/sessions.md:47` already lists **Host teammates**; it must gain
  the supported range and what the disabled state means. A new top-level `src/main/it2-support.ts`
  trips `scripts/ci/user-docs-gate.mjs` on its own anyway.
- **`design.md` — YES.** §6 (Context menu) gains the disabled-toggle-with-reason state — edited
  **before** `SessionMenu.vue`, per the design contract.
- **i18n — YES.** One key per reason plus the two warning states, in **both** `en.json` and
  `pt-BR.json` in the same change (`MessageSchema = typeof en`).
- **English-only — YES.** Contract doc, module comments and CHANGELOG in English; `pt-BR.json` is
  the sole exception.

## 8. Definition of done

- [ ] T200 landed and its probed version is readable from the main process
- [ ] O1–O4 (§4.5) answered by a real capture against the installed CLI, recorded in the PR
- [ ] `scripts/spikes/capture-it2-argv.sh` re-run; `it2-argv-captured.raw.txt` refreshed
- [ ] `scripts/spikes/it2-argv-CONTRACT.md` re-titled with the captured version + a
      "Differences from the 2.1.193 capture" section
- [ ] `src/main/it2-support.ts` with `IT2_SUPPORTED_RANGE` + `checkIt2Support`
- [ ] `MenuToggle` gains `disabled`/`disabledHint`; the Host-teammates row renders the reason
- [ ] Refused-`run` toast in `it2-bridge.ts`, rate-limited per lead
- [ ] Supported-range line in Settings → Claude Code beside T200's version
- [ ] `buildTeammateHostEnv` widened iff O1 requires it
- [ ] Version references corrected: `it2-parse.ts:10,63,232`, `it2-plan.ts:11-12`,
      `tests/it2-parse.test.ts:11`
- [ ] `pty.ts:437-457` and `pty.ts:767-776` verified unchanged
- [ ] Tests in §6 green
- [ ] `design.md` §6, `docs/user/sessions.md`, `en.json` + `pt-BR.json`, `CHANGELOG.md`
- [ ] `npm run typecheck` and `npm run build` pass
