# T456 — W4 live verification (`02-live-verify.md`)

Companion to [`00-spec.md`](00-spec.md) §11 (W4) and AC-T456-9. Run on 2026-10-13, 21:20 to 22:15
-03:00, on Linux (kernel 7.0.0), against real `claude --model haiku` sessions in a second,
isolated Harnu instance. The operator's own Harnu kept running throughout and was never touched.

**Code under test.** Runs 1 and 2: `9fb7839` (the W2 tip, holding W1 + W3 + W2). Run 3: `5360047`
(the W2 tip after the "Park now never waits behind a pending `park.query`" fix), used only for the
in-flight re-test of §4.4.

**Result in one paragraph.** Every scenario of AC-T456-9 behaves as designed with real sessions,
on both the legacy-facts path and the real `park.query` path. A session idle at its prompt with a
background `sleep` declines the sweep and stays live; it parks at the limit, under the memory
floor, and on "Park now", with the ledger reason the spec names. Three findings came out of the
runs: the shipped CLI is above the mod's tested ceiling, so `park.query` never runs on a current
install (§4.1); "Park now" during a pending question is lost on `9fb7839` (§4.4, reproduced live);
and on the `park.query` path a `maxDeferMs` hold can overrun by one sweep interval (§4.2).

## 1. Method

### 1.1 Isolation

The earlier W0 spike ran its isolated instance with the real `HOME`, and that instance wrote its
`statusLine` into the real `~/.claude/settings.json`. Harnu writes its hooks and `statusLine`
through `os.homedir()` (`claude-settings.ts` `claudeSettingsPath`), so this run gave the isolated
instance, and every session it spawned, a **throwaway `HOME`**:

| Piece                     | Real                               | This run                                                               |
| ------------------------- | ---------------------------------- | ---------------------------------------------------------------------- |
| Harnu `userData`          | `~/.config/harnu`                  | `/tmp/hv4` (`--user-data-dir`; short for the mod socket's 90-byte cap) |
| `HOME` (Claude settings)  | `~`                                | `/tmp/hv4home`                                                         |
| `companion-prefs.json`    | `~/.config/harnu/…`                | `/tmp/hv4/companion-prefs.json`                                        |
| `XDG_RUNTIME_DIR`         | `/run/user/1000`                   | `/tmp/hv4run` (keeps the test sessions out of the CLI's peer sockets)  |
| Remote Control at startup | on (the operator's `.claude.json`) | `remoteControlAtStartup: false` in the throwaway `.claude.json`        |
| CDP port                  | —                                  | `9334`                                                                 |

The throwaway `HOME` held a minimal `settings.json` (`remoteControlAtStartup: false`, an allow rule
for `Bash(sleep *)`, `DISABLE_AUTOUPDATER=1`), a `.claude.json` built from the scalar keys of the
real one (onboarding flags, account record; no Remote Control keys; the scratch folders trusted),
and a copy of the OAuth credentials file (mode 600, 171 min left on the access token, so no refresh
was needed; deleted at teardown). No Remote Control was enabled and no remote client was attached.

The isolated instance confirmed it on its own: after boot,
`/tmp/hv4home/.claude/settings.json` held `hooks` (8 events) and
`statusLine: sh "/tmp/hv4/statusline/statusline-writer.sh"`, and the instance removed both at
exit. The real `~/.claude/settings.json` hash did not move (§5).

### 1.2 Launch and drive

The renderer was built with `npx electron-vite build` and served from `out/renderer` on `[::]:5174`
(the `--remote-debugging-port` ⇒ dev-mode gotcha of `docs/dev/live-verify-second-instance.md`). The
instance was started from the worktree root with `electron .`. A first try with
`electron out/main/index.js` left the app path at `out/main`, so the mod failed to stage
(`ENOENT … out/main/resources/companion/.claude-plugin/plugin.json`).

```bash
env -i HOME=/tmp/hv4home PATH="$CLI_DIR:$HOME_REAL/.local/bin:/usr/local/bin:/usr/bin:/bin" \
  DISPLAY=:0 XAUTHORITY=… DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus \
  XDG_RUNTIME_DIR=/tmp/hv4run DISABLE_AUTOUPDATER=1 ENABLE_CLAUDEAI_MCP_SERVERS=false \
  TERM=xterm-256color \
  <worktree>/node_modules/electron/dist/electron . --user-data-dir=/tmp/hv4 \
  --remote-debugging-port=9334 --no-sandbox
```

`/tmp/hv4/companion-prefs.json` was written before launch, and only there:

```json
{ "v": 1, "disclosureShownAt": 1791937790872, "keys": { "channel": "active", "park": "ask" } }
```

A Node 22 CDP driver (the `verify.mjs` pattern of the recipe) did the rest through `window.api`:

- **Sessions.** Each scratch folder got a transcript from one headless seed
  (`claude -p "Reply with the single word: ready" --model haiku --session-id <uuid>`, same throwaway
  `HOME`), then was resumed through the real `pty:create` path:
  `ptyCreate({ kind: 'claude-resume', claudeSessionId, sessionKey, cwd, cols: 120, rows: 36 })`.
  Only `claude-resume` is parkable (`fleet-policy.ts` `isParkable`), so a `claude-new` would never
  be a candidate. The prompt typed into the PTY:
  _"Use the Bash tool with run_in_background set to true to run exactly: sleep 900. Do not wait for
  it, do not check on it. Then reply with the single word started and end your turn."_ Every
  session's footer then read `1 shell still running`.
- **Policy.** `monitorPolicySet({ lruIdleMs: 60000, hardIdleMs: 60000 })`. The sweep reads
  `hardIdleMs`, not `lruIdleMs` (`parkCandidates`, trigger `sweep`), so both were set to 1 min.
  Both were raised to 1 h while a session was being prepared, and lowered once its shell was
  running, so the session could not be parked mid-setup (the first attempt was: §3, B0).
- **Sweep.** There is no IPC to force a sweep. The 60 s `setInterval` in `pty.ts` is the trigger,
  so "a forced sweep" here is the next tick after the session has been silent for 60 s.
- **Bounds.** `monitorNegotiationSet({ maxDeclines, maxDeferMs, pressureFloorMb })`, read back from
  `/tmp/hv4/monitor-policy.json`.
- **Evidence.** A recorder subscribed to `onMonitorSample` (every 1.5 s, the System Monitor's own
  feed) and logged each session's `state`, `reason`, `declined` and `negotiation` to JSONL: 678
  samples in run 1, 689 in run 2. `onPtyHibernated`, `onPtyExit` and per-second PTY byte counts
  came from the same page. `park.query` traffic came from the isolated
  `/tmp/hv4/companion/audit.ndjson`. Screenshots were taken with `Page.captureScreenshot` with the
  System Monitor takeover open (the footer heap gauge's button), and "Park now" was the real row
  button (`aria-label="Park now"`, which calls `window.api.ptyPark`).

### 1.3 Runs and CLI versions

| Run | Code      | CLI         | `cliGate` | Effective `park` | Effective `channel` | Path exercised                 |
| --- | --------- | ----------- | --------- | ---------------- | ------------------- | ------------------------------ |
| 1   | `9fb7839` | **2.1.296** | `above`   | `facts`          | `shadow` (capped)   | legacy Stop facts (no command) |
| 2   | `9fb7839` | **2.1.292** | `ok`      | `ask`            | `active`            | real `park.query` round trips  |
| 3   | `5360047` | **2.1.292** | `ok`      | `ask`            | `active`            | in-flight "Park now" re-test   |

2.1.296 is the CLI on `PATH`; the machine also holds 2.1.294 and 2.1.295, all above the mod's
`lastVerifiedCli` 2.1.292 (`resources/companion/api-surface.json`). The 2.1.292 binary for runs 2
and 3 is the official `@anthropic-ai/claude-code-linux-x64@2.1.292` npm package, unpacked in the
session scratchpad and put first on the instance's `PATH`. Run 1's prefs file stored `ask` +
`active` like run 2's; the instance read them as `facts` and `shadow` (§4.1).

**Live sessions: 13** (`haiku` throughout): 3 headless seeds and 10 resumes (S1, S1b, S1c, S1d in
run 1; S2a to S2e in run 2; S3 in run 3). That is one over the ~12 cap; the 13th was the optional
fix re-test of §4.4.

## 2. Scenario results

Times are epoch ms (run 1 starts at `1791937945` = 21:32:25 -03:00). "Sweep" ticks fell at
`…x1.0` in run 1 and at `…x5.4` in runs 2 and 3, 60 s apart.

| AC         | Path          | Session | Result                                                                                        |
| ---------- | ------------- | ------- | --------------------------------------------------------------------------------------------- |
| AC-T456-9a | facts (run 1) | S1b     | **met.** Declined at the first sweep, held through three more, ledger empty until §2.4's park |
| AC-T456-9a | ask (run 2)   | S2a     | **met.** `park.query` answered busy in 13 ms; declined; no park until "Park now"              |
| AC-T456-9b | facts (run 1) | S1c     | **met.** Parked `why: limit` 120.0 s after the decline (`maxDeferMs` 120 000)                 |
| AC-T456-9b | ask (run 2)   | S2c     | **met, with finding §4.2.** Parked `why: limit`, but 180.0 s after the decline                |
| AC-T456-9c | facts (run 1) | S1d     | **met.** Parked `why: memory-pressure` at the next sweep, 44.6 s after the floor was raised   |
| AC-T456-9c | ask (run 2)   | S2b     | **met.** Parked `why: memory-pressure` 1.6 s after the floor was raised; no command sent      |
| AC-T456-9d | facts (run 1) | S1b     | **met.** Parked 1 ms after the click; `why: operator`, `override: true`                       |
| AC-T456-9d | ask (run 2)   | S2a     | **met.** Parked in the same ms as the click; `why: operator`, `override: true`                |
| AC-T456-9d | in-flight (2) | S2b     | **unmet on `9fb7839`** (§4.4): the click parked nothing; the session was then deferred        |
| AC-T456-9d | in-flight (3) | S3      | **inconclusive on `5360047`** (§4.4): the question was refused at once, never pending         |

### 2.1 AC-T456-9a — a background `sleep` survives the sweep

**Facts path (run 1, S1b).** Prompted at `1791938117`. The PTY's last bytes came at
`1791938122376`; after that the PTY was **silent for 270 s** until the park (per-second byte map:
`117: 854, 118: 913, 119: 333, 120: 821, 121: 1987, 122: 1089`, then nothing). That is W0's A1 for
a background shell again, live inside Harnu. Thresholds were lowered at `1791938159.86`.

```
1791938182614 live hard-idle idle 60
1791938211119 live declined  idle 89  {"declines":1,"max":8,"reasons":["background-task"],
                                       "counts":{"background-task":1},"retryInMs":599867}
1791938361145 live declined  idle 239 {"declines":1,…,"retryInMs":449841}
```

Sweeps at `…271.0` and `…331.0` passed it over (it was inside its `until`). The isolated audit log
held **no `command` row** in run 1, only `binding` rows: the decision came from the legacy Stop
facts, as `park: facts` requires. Tooltip text, read from the DOM:
`Asked to stay. It said it is busy with:\n• 1 background task\nAsked 1 of 8 times\nAsks again in 9 min`.

**`park.query` path (run 2, S2a).** Thresholds lowered at `1791939092.87`.

```
audit  1791939155417  park.query  decision: queued   cause: {kind: internal, subsystem: park}
audit  1791939155430  park.query  outcome: {state: resulted, ok: true}            (13 ms)
sample 1791939155980  live declined idle 119 {"declines":1,"max":8,"reasons":["background-task"],
                                              "counts":{"background-task":1},"retryInMs":599452}
```

The mod answered busy (`background-task`, count 1, no `retryAfterMs`, so the host default of
600 s applied). The chip and tooltip match run 1 word for word. S2a stayed declined until the
operator park of §2.4.

**Baseline (B0, run 1, S1).** The first S1 was resumed with no background task and sat idle before
its prompt arrived. It was parked at the first sweep past 60 s idle (`1791938030987`) with
`negotiation: {declines: 0, reasons: [], why: "silent"}`. In run 2, two idle resumes with no
background work (S2d, S2e) were each asked, answered free, and parked with
`{declines: 0, reasons: [], why: "free"}` (`1791939935419`, `1791939995419`). Parked line:
`Parked; the session said it was free`.

### 2.2 AC-T456-9b — it parks at the limit

Bounds: `maxDeclines: 2`, `maxDeferMs: 120000` (read back `{"park":…,"maxDeclines":2,"maxDeferMs":120000,…}`).

| Run, session  | Decline                                 | `until` (cap)       | Park (`hibernated`) | Hold    | Ledger                                                  |
| ------------- | --------------------------------------- | ------------------- | ------------------- | ------- | ------------------------------------------------------- |
| 1 (facts) S1c | sweep `…570.99`, sample `1791938571199` | `retryInMs` 119 789 | `1791938690989`     | 120.0 s | `{declines: 1, reasons: [background-task], why: limit}` |
| 2 (ask) S2c   | `park.query` `1791939635415` → 8 ms     | `retryInMs` 119 325 | `1791939815419`     | 180.0 s | `{declines: 1, reasons: [background-task], why: limit}` |

Both parked by `limit` with **one** question asked. The time bound fired first because `until` was
capped at `firstDeclineAt + maxDeferMs`. In run 2 the audit log holds exactly one `park.query` for
S2c, so the limit park asked nothing. Parked line: `Parked after 1 decline (background task)`.
The run-2 hold of 180 s against a 120 s bound is §4.2.

The `maxDeclines` count bound was not exercised on its own: with the default 600 s retry, a second
question takes 10 min, and `maxDeferMs` fired first in both runs.

### 2.3 AC-T456-9c — it parks under a lowered memory floor

The floor was raised to 200 000 MB while the session was declining; `MemAvailable` was 23 264 552
kB (run 1) and 25 366 624 kB (run 2), about 22.7 and 24.8 GB.

| Run, session  | Floor set       | Row at next sample            | Park (`hibernated`) | Ledger                                                            |
| ------------- | --------------- | ----------------------------- | ------------------- | ----------------------------------------------------------------- |
| 1 (facts) S1d | `1791938886402` | `hard-idle` (episode dropped) | `1791938930990`     | `{declines: 1, reasons: [background-task], why: memory-pressure}` |
| 2 (ask) S2b   | `1791939513776` | `hard-idle`                   | `1791939515416`     | `{declines: 1, reasons: [background-task], why: memory-pressure}` |

`declines` stayed at 1, and run 2's audit log holds **no command row** after the floor was set:
the session was parked without being asked. "At once" means **at the next sweep**: the floor drops
the deferral immediately (`policyEpisodes()` returns none under pressure), but the park waits for
the 60 s tick, so it took 44.6 s in run 1 and 1.6 s in run 2. Parked line:
`Parked under memory pressure; the session said busy`. The floor was set back to 1 536 after each run.

### 2.4 AC-T456-9d — "Park now" overrides

Normal case, on a declining session between sweeps, through the real row button:

| Run, session  | Click           | `hibernated`    | Ledger                                                                     |
| ------------- | --------------- | --------------- | -------------------------------------------------------------------------- |
| 1 (facts) S1b | `1791938392577` | `1791938392578` | `{declines: 1, reasons: [background-task], why: operator, override: true}` |
| 2 (ask) S2a   | `1791939483573` | `1791939483573` | `{declines: 1, reasons: [background-task], why: operator, override: true}` |

No question was asked (no command row near either click). Parked line:
`Parked by you; it had asked to stay (background task)`. The PTY exited with code 129
(SIGHUP), `reason: "park"`, about 0.9 s later. After every park in this run,
`ps` showed **no `sleep 900` left behind**: the background shell dies with the session.

The in-flight case is §4.4.

### 2.5 Screenshots (AC-W4-5)

Real sessions, System Monitor takeover. Copied to `.harnu/out/w4-screens/` in the worktree
(gitignored, not committed):

| File                                | Shows                                                                       |
| ----------------------------------- | --------------------------------------------------------------------------- |
| `shot-9a-declined-facts.png`        | live row, `Harnu mod live`, chip `Asked to stay · 1 background task`, run 1 |
| `shot-9a-declined-ask.png`          | the same chip from a real `park.query` answer, run 2                        |
| `shot-9d-parked-operator-facts.png` | parked row: `Parked by you; it had asked to stay (background task)`         |
| `shot-9d-parked-operator-ask.png`   | a declined row and an operator-parked row together, run 2                   |
| `shot-9b-parked-limit-facts.png`    | parked row: `Parked after 1 decline (background task)`                      |
| `shot-9c-parked-pressure-facts.png` | parked row: `Parked under memory pressure; the session said busy`           |
| `shot-parked-free-ask.png`          | two parked rows: `Parked; the session said it was free`                     |

This closes W3's "fixture only" gap: each chip, tooltip and parked line above was rendered from a
real `declined` / `negotiation` value produced by the coordinator.

## 3. A6 — `park.query` round-trip latency

Every `park.query` of runs 2 and 3, from the isolated audit log (`decision` row → `outcome` row):

| Command         | Session | Decision        | Outcome                        | Round trip               |
| --------------- | ------- | --------------- | ------------------------------ | ------------------------ |
| `cmd_790606af…` | S2a     | `1791939155417` | `resulted`, `ok: true` (busy)  | **13 ms**                |
| `cmd_d3db0e4d…` | S2b     | `1791939395415` | `expired`                      | 5 178 ms (induced, §4.4) |
| `cmd_2aef1803…` | S2c     | `1791939635415` | `resulted`, `ok: true` (busy)  | **8 ms**                 |
| `cmd_8521560b…` | S2d     | `1791939935419` | `resulted`, `ok: true` (free)  | **10 ms**                |
| `cmd_e2530b78…` | S2e     | `1791939995419` | `resulted`, `ok: true` (free)  | **11 ms**                |
| (run 3)         | S3      | `1791940366309` | refused `NO_LEASE`, not queued | 0 (induced, §4.4)        |

**4 natural questions, 8 to 13 ms, 0 natural `silent`.** The two silent outcomes were both caused by
this run's own SIGSTOP of the session. So 5 s holds with three orders of magnitude to spare, but
only at the load measured here: at most 2 live sessions on the instance, idle machine. A6 asks
"under load", and that was **not** measured, so §12's A6 row is left as it is.

## 4. Findings

### 4.1 On a current CLI, `park.query` never runs

With the CLI on `PATH` (2.1.296; also 2.1.294 and 2.1.295 on disk), the instance reported
`cliGate: "above"`, and `monitorNegotiationGet()` returned `park: "facts"` although the prefs file
stored `ask`. `channel` was likewise capped at `shadow`. This is ARB-7b doing what §5.4's table
says ("CLI above the tested ceiling … not sent"), and the legacy path covered every scenario. But
it means **no operator on a current CLI gets the negotiated path today**. They get the
`background-task` / `scheduled-wakeup` facts only, never `turn`, `permission`, `remote-surface` or a
retry hint, until `lastVerifiedCli` is raised past 2.1.296. Run 1 is therefore the configuration
users actually run.

### 4.2 On the `park.query` path a `maxDeferMs` hold can run one sweep long

Run 2, S2c: the question was queued at `1791939635415` and answered at `…423`. `applyAnswer` stamps
`until = min(now + wait, firstDeclineAt + maxDeferMs)` with `now` read **after** the answer, so
`until` = `…423` + 120 000 = `1791939755423`. The System Monitor agrees: its sample at
`1791939636099` showed `retryInMs: 119325`, which puts `until` at `1791939755424`. The sweep two
ticks later ran at about `…755.41`,
a few ms **before** `until`, so the session was still deferred and skipped. The deferral ended in
the sample at `1791939756138`, and the park came at the following tick, `1791939815419`: **180 s of
hold against a 120 s `maxDeferMs`**. In run 1 (facts, no await) `until` equals the sweep tick plus
`maxDeferMs`, the later tick lands at or after it, and the hold was exactly 120.0 s.

The sweep's own tick time is inferred from the 60 s phase of the audit rows (`…x5.415` to
`…x5.419` all run long), not logged directly. If this holds, then on the
`park.query` path any `until` that is a whole number of sweep intervals away is reached one tick
late: the overrun is at most `SWEEP_INTERVAL_MS` (60 s) per deferral. That covers the 600 s default
retry as well (an 11 min re-ask), which was not observed here. §6.6's "the most a session can be
held past the policy's own park point is `maxDeferMs`" holds at sweep granularity, not to the ms.
Reported as found, not tuned.

### 4.3 What the chip looks like on a real session

Matches W3's design on real data: the row shows `live · Harnu mod live · [Asked to stay · 1
background task] · idle 1 min`; parked rows show one of the four lines quoted in §2. One
oddity: after the SIGSTOP-induced `lease-lost` of §4.4, S2b's row read `Harnu mod legacy` at
`1791939483` while `companionDiagnostics()` already showed its lease `live`
(`shot-9d-parked-operator-ask.png`). It was caused by the test's own SIGSTOP and was not
investigated further.

### 4.4 "Park now" while a question is pending

Method: SIGSTOP the session's own `claude` process (a child of the isolated electron, with
`HOME=/tmp/hv4home`) so the mod cannot answer, watch the audit log every 20 ms for that session's
`park.query` decision row, call `window.api.ptyPark(sessionKey)` the moment it appears, and SIGCONT
8 s later.

**Run 2 (`9fb7839`), S2b: the click is lost.** SIGSTOP at `1791939364785`.

```
1791939395415  park.query queued (sweep)
1791939395417  ptyPark(S2b) called  → resolved at …395420, no `pty:hibernated`
1791939400538  sample: live declined {"declines":1,"max":8,"reasons":["background-task"],…}
1791939400593  park.query outcome: expired   (5 178 ms)
1791939400656  binding lease-lost
1791939403438  SIGCONT
1791939463553  sample: live declined …retryInMs 536863
```

`requestPark('manual')` returned `in-flight` while the sweep's question was pending, so the click
did nothing. The question then expired, the silent answer fell back to the legacy facts
(`background-task`), and the session was deferred for another 10 min. This is the defect the
orchestrator reported, reproduced live on `9fb7839`. S2b was later parked by the memory floor
(§2.3).

**Run 3 (`5360047`, the fix), S3: inconclusive.** SIGSTOP at `1791940303660`, but this time the
sweep that asked came 63 s later. The mod's lease was lost at `1791940336542` (32.9 s after the
SIGSTOP), so at `1791940366309` the sweep's `park.query` was refused `NO_LEASE` before being queued:
silent at once, legacy facts, declined, with nothing pending. "Park now" at `1791940366324` then
parked it (`hibernated` `…366326`, `{declines: 1, why: operator, override: true}`). That is the
normal case again, not the in-flight one. A clean re-test needs the SIGSTOP placed less than ~30 s
before the sweep, and a 14th session; it was not run.

### 4.5 Smaller observations

- **Thresholds and the `declined` label.** Raising `hardIdleMs` back to 1 h while preparing another
  session turned a declining row's reason into `active`. Its episode was kept (the retry countdown
  carried on: 410 407 ms left at `1791939345025`), and `declined` came back once the thresholds were
  lowered. `explainFleet` labels a row `declined` only while it is also eligible under `lruIdleMs`.
  A setup artefact, not a defect.
- **Lease timeout.** A frozen session lost its mod lease about 33 s after freezing (run 3), and its
  next `park.query` was refused `NO_LEASE` at once. §5.4's table already reads that as silent.

## 5. Side-effect audit (AC-W4-7)

Taken before launch (`2026-10-13T21:20:58-03:00`) and after the last teardown: `sha256sum` and a
copy of `~/.claude/settings.json` and `~/.claude/settings.local.json`, a `sha256sum` listing of
`~/.config/harnu/**` (2 340 files; Chromium caches excluded) and of `~/.claude/plugins/**`
(6 780 files).

| Target                          | Before → after                                     | Verdict                                |
| ------------------------------- | -------------------------------------------------- | -------------------------------------- |
| `~/.claude/settings.json`       | `d4b540b1…f566` → `d4b540b1…f566`, `cmp` identical | **clean**, nothing restored            |
| `~/.claude/settings.local.json` | `24a13611…6dd4` → `24a13611…6dd4`, `cmp` identical | **clean**                              |
| `~/.claude/.credentials.json`   | hash unchanged                                     | **clean** (no token refresh happened)  |
| `~/.config/harnu/**`            | 14 added, 4 removed, 22 changed                    | **operator's own instance**, see below |
| `~/.claude/plugins/**`          | 74 added, 35 removed, 5 changed                    | **operator's own sessions**, see below |

The `~/.config/harnu` changes are the operator's running Harnu at work: scheduler run logs, mod
parity and audit logs, `Local Storage`, `projects.json`, `mcp-audit.json`, and a bundled-skills
staging dir (`skills/cb0ca3520b56e075/…`, stamped 21:50:23). The `~/.claude/plugins` changes are
`.in_use/<pid>` markers and two `temp_git_*` marketplace fetches. The new marker PID 3015726 is a
`claude` with the real `HOME`, whose parent is the operator's Harnu main process, running in another
worktree. None of it can come from this run: every process it spawned ran with
`HOME=/tmp/hv4home` and `--user-data-dir=/tmp/hv4`. A search of `~/.config/harnu` for this run's
three session-id prefixes and for `hv4work` / `hv4home` found **0 files**, and `~/.claude/projects`
holds no `hv4` slug. At teardown, every PID this run started (electron trees, recorders, static
servers) was killed by PID, no `HOME=/tmp/hv4home` process was left, and the `/tmp/hv4*` dirs were
deleted, the credentials copy first.

## 6. Not verified

- **"Park now" during a pending question on the fixed tip** (§4.4, run 3 inconclusive).
- **The `maxDeclines` count bound on its own**: `maxDeferMs` fired first in both limit runs (§2.2).
- **A6 under load**: at most 2 concurrent sessions (§3).
- **An explicit `park: facts` on an in-ceiling CLI**: run 1's facts path came from the ARB-7b cap,
  not from the stored key. **`park: off`** was not run.
- **The `cap` trigger** (AC-T456-6, a declining coldest session passing its slot to the next one)
  and **any busy reason other than `background-task`**: subagent, wakeup or cron, turn,
  permission, remote surface.
- **A4's positive half** (a drawing remote client as `mobile`): no Remote Control by rule.
- **The Settings → Hibernation policy UI**: the bounds were set over IPC, not through the form.
- macOS and Windows.
