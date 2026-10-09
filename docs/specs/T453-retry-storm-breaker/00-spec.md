# T453 — Retry-storm breaker: stop the same failing tool call repeating

**Status:** specified (not implemented) · **Date:** 2026-10-09 (round 2) · **Card:** T453 ·
**Decision record:** [`ADR-draft.md`](ADR-draft.md) (proposed; numbered when merged)

Files: this spec; [`01-corpus-scan.md`](01-corpus-scan.md) (the measurement behind every
threshold, U-2); [`02-prototype.md`](02-prototype.md) (the prototype mod, C-5);
[`03-prototype-tests.md`](03-prototype-tests.md) (its tests and twelve live runs, C-1/C-5);
[`04-detector-core.md`](04-detector-core.md) (`hooks/core.ts`, the normative definition, U-1).

## 0. Summary

A small mod, **`retry-breaker`**, counts identical failing tool calls inside each conversation loop
and climbs a ladder:

1. a notice the model reads, on the 3rd identical failure;
2. a dialog for the person (or Harnu's escalation when nobody is there), on the 4th;
3. at level `enforce`, a refusal of the 5th identical attempt, with the reason;
4. in an unattended run that keeps pushing a refused call, the end of the turn.

Seven facts shape the design:

1. **Observe through `session.append`, refuse through `tool.check`, never `tool.call`.** A
   pass-through `tool.call` hook on Bash broke `Agent(isolation: "worktree")` in T389's smoke
   (#92533, `docs/studies/T389-smoke-evidence.md:628-650`), and the companion forbids it (SEC-9 (d)).
   On 2.1.296 headless the evidence is now mixed: a T450 verifier saw isolation hold with such a hook,
   and this spec's run 8 saw it hold with the breaker's hooks. The breaker does not need `tool.call`,
   so it takes the caution either way (§8.1).
2. **The notice is a rewrite of the failing result.** The model reads it and the transcript keeps it
   (proven, run 3).
3. **Every refusal is a `deny` with its reason.** A live interactive run showed that an `ask` is
   unreliable. In manual mode the person's dialog appears but never shows the reason. In auto mode the
   mode settles the `ask` without anyone (run 10). A `deny`'s reason reached the model in every run,
   attended or not (runs 3, 11).
4. **Who is watching decides the rest.** Attended means an operator's interactive session: the
   dialog, and no automatic abort. Unattended means `-p`, a Scheduler tick, or a session Harnu spawned
   for an agent: Harnu's escalation, and at level `enforce` an abort cap (not at the default `notice`).
5. **Harnu's escalation runs in Harnu's host.** The mod cannot reach Harnu where it matters, so the
   host runs the same `core.ts` over the transcript it already reads (§5.4).
6. **Legitimate repetition is excluded by rule.** That covers polling (read from the command words),
   waiting for a server, a re-run after any possibly-mutating success, and refusals by a person or the
   permission layer (§3.4).
7. **Storms are rare here, and their main cause is in the engine.**
   - On 115,595 tool calls, 19 exact runs reached 3, none passed 5, and a perfectly obeyed notice
     would have saved 8 calls.
   - 16 of the 19 are one engine-side contradiction in the `SendMessage` tool (§15 F-1).
   - No false positive was observed at the chosen thresholds, but the sample bounds the rate only
     below about 15 % for the notice and 30–40 % for the later rungs.

   **Recommendation (OQ-1):** fix F-1 at its source first, then re-scan (a transcript replay: it needs
   no deployed mod), then ship W0 + W1 at the default level `notice`, and build the host escalation
   only if the re-scan still shows storms in unattended runs.

## 1. Origin and scope

**Origin.** Idea 81 of the operator's ideation report (`.harnu/out/claude-code-mods-ideas.md` in
the main checkout, gitignored): "Counts identical failing tool calls (same tool, same input hash,
same error) and on the third opens a dialog 'Same failure ×3 — stop and rethink?' with the three
errors side by side; optionally forks a tool-less 'why is this failing?' question." Uses: "`tool.call`
await-then-inspect, `$.state` ring buffer, `Pane` dialog mode, `$.model.fork`, `turn.abort` on
[Stop]."

**Deviations from the idea.**

| Idea said                      | This spec                                               | Why                                                              |
| ------------------------------ | ------------------------------------------------------- | ---------------------------------------------------------------- |
| `tool.call` await-then-inspect | `session.append` to observe, `tool.check` to refuse     | #92533 caution; SEC-9 (d) (§8.1)                                 |
| a dialog on the 3rd            | a notice to the model on the 3rd, the dialog on the 4th | the model stops after the notice (runs 4, 7, 11)                 |
| same input hash only           | two rules: exact, and same-error with any input         | same-error storms the exact rule misses (`01-corpus-scan.md` E4) |
| `turn.abort` on [Stop]         | on [Stop]; automatically only unattended                | the person decides when present (U-4)                            |

**Goals.**

- G1. An identical failing call does not repeat unchanged without the model being told, in every
  session the mod loads in, Harnu's or not.
- G2. Tell the model, then the person, before refusing anything; never refuse without the reason.
- G3. In an unattended Harnu session, make a storm visible to the operator without opening it.

**Non-goals.** No repair of the failing call. No cross-session memory of storms. No detection of
loops that do not fail: T175's `stall-detect.ts` flags those (§3.4 X7). No change to Claude Code's
permission rules.

## 2. Conventions

- `T:n` is line _n_ of `types/claude-code.d.ts` written by Claude Code 2.1.295 through the
  `plugin-authoring` skill; `R:n` is line _n_ of that skill's `reference.md`. The kit and every live
  run used 2.1.296, the CLI installed when this spec was written.
- **proven (run n)**: observed in a real session (`03-prototype-tests.md` §3); **kit**:
  `claude plugin test`; **doc**: the types or reference say so and nothing here ran it.
- "Loop" is one model conversation: the main one, or a subagent's, named by `agentId`.
- Harnu source is cited from this worktree (`main` at `cb7fb58`).

## 3. "Same failure", defined (U-1)

**The definition is `hooks/core.ts`** ([`04-detector-core.md`](04-detector-core.md)). This section
explains it; where the two disagree, the code wins.

### 3.1 Calls and loops

A call is a `tool_use` block appended through `session.append` door `response` (`T:10556`,
`T:10566-10594`), joined by id to the `tool_result` appended through door `tool-result`. Every rule is
per loop: the key is `e.agentId ?? 'main'`, which both `session.append` (`T:10586-10593`) and
`tool.check` (`T:12833-12839`) carry (proven, run 5).

### 3.2 Input normalisation, per tool

The input signature is a hash of the fields below; other fields do not count.

| Tool                 | Signature fields                            | Why                                                                             |
| -------------------- | ------------------------------------------- | ------------------------------------------------------------------------------- |
| `Bash`               | `command`, whitespace collapsed and trimmed | `description`, `timeout`, `run_in_background` change nothing about why it fails |
| `Edit`               | `file_path`, `old_string`                   | a mismatch is about `old_string`; changing only `new_string` does not fix it    |
| `Read`               | `file_path`, `offset`, `limit`              | a missing path ignores the window, but "file too large" is fixed by changing it |
| `Write`              | `file_path`                                 | its failures ("read it first", a denied path) are about the path                |
| `NotebookEdit`       | `notebook_path`, `cell_id`                  | as `Edit`                                                                       |
| `Grep`, `Glob`       | `pattern`, `path`, `glob`                   | output options do not cause failures                                            |
| `Agent`              | `subagent_type`, `isolation`                | its failures (unknown type, limit reached, no pane) ignore the prompt           |
| MCP tools (`mcp__*`) | every argument, keys sorted                 | a server's tool is opaque; the whole call is the call                           |
| any other tool       | every argument but `description`            | conservative default                                                            |

### 3.3 What counts as a failure, and "the same error"

A **failure** is a `tool_result` with `is_error: true` (`T:12764-12790`) whose call ran and failed,
not one refused before it ran. The **error signature** hashes the error text after `normalizeError`:
the mod's own notice lines are removed (the transcript stores them, run 3), `\b[0-9a-f]{7,40}\b` is
folded to `H`, numbers to `N`, whitespace collapsed, 600 characters kept. The hex fold also folds a
7–40 letter word made only of a–f; that can only merge errors, never split one
(`04-detector-core.md`).

### 3.4 Exclusions, as rules

None of these is ever counted, by either rule.

| Rule   | Excluded                                        | How it is recognised (`core.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------ | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **X1** | The person refused the call, or chose "clarify" | engine text `The user doesn't want to proceed`, `The user wants to clarify`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **X2** | The call was interrupted                        | `[Request interrupted`, `Interrupted by user`, `[Tool call interrupted`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **X3** | The permission layer refused it                 | in-session: its `tool.check` verdict was `deny`, or `ask` while unattended. Text, for the host twin and the scan: the auto-mode classifier's no-verdict, rate limit and `Permission for this action was denied`; `requested permissions … haven't granted`; `This command requires approval`; `Permission to use … denied`; `PreToolUse:<Tool> hook error`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **X4** | The breaker's own refusal                       | recorded as `deny` by the breaker before it answers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **X5** | **Polling**                                     | **`Bash`:** a simple command whose command word is `sleep`, `watch`, `wait-on`, `wait-for` or `wait-for-it`, or whose argv starts `gh pr checks`, `gh run view`, `gh run watch`, `kubectl rollout status` or `kubectl wait`. Words come from a shell tokenizer (quotes, `;`, `&&`, `\|\|`, `\|`, `&`, keywords, `NAME=value`, `env`/`sudo` wrappers; `timeout` with its options such as `-s KILL`, `-k 5`, `--signal=KILL`; and the string after `bash`/`sh`/`zsh`/`dash`/`ksh -c`, read again to depth 3), so `grep -r sleep`, `echo "sleep 5"` and `npm run test:watch` are **not** polls. A `curl` is no poll word: `until curl -sf …; do sleep 1; done` is a poll through its `sleep`, and a bare failing `curl` is X7's business. **MCP:** a read-verb tool (`get_`, `list_`, `read_`, `query_`, `search_`, `find_`, `fetch_`, `wait_`, `poll_`, `status`, `check_`, `describe_`, `show_`) answering not found / not ready / pending / spawning / starting / unavailable, such as `get_session` returning `SESSION_NOT_FOUND` while a session spawns |
| **X6** | Re-running after a real edit                    | not an exclusion but a reset: R2 below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **X7** | **Waiting for a server**                        | by the **text of the failure, whatever the client**: connection refused / reset, `ECONNREFUSED`, `Couldn't connect`, `Failed to connect`, `Empty reply from server`, `returned error: 50[234]`, `HTTP/x 50[234]`, `50[234] Bad Gateway \| Service Unavailable \| Gateway Timeout`, `not ready`, `is starting`. A `curl`, `psql`, `npx playwright test`, `docker compose exec … pg_isready`, any MCP tool and `WebFetch` to localhost all count. A wrapped wait that only exits `124` is caught by X5 through the `sleep` inside its `bash -c` string                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **X8** | A bare exit status                              | an error that normalises to `Exit code N` alone never feeds the same-error rule (it still feeds the exact rule)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

**X7's cost, stated.**

- A model hammering a server that never comes up is not caught by the breaker. T175 catches it:
  `stall-detect.ts` flags a session that makes at least 8 calls in 5 minutes with no new fingerprint
  and no mutation (`stall-detect.ts:21-24`, `:126-131`, `:177`).
- Because X7 reads the text, any failure whose output merely contains one of those phrases is not
  counted, for example a test that asserts on `ECONNREFUSED`. That errs toward silence, never toward a
  refusal.
- What X5 and X7 still cannot read: a wait hidden in a script file (`./wait-for-db.sh`), a command
  string behind `eval`, `xargs`, `ssh host '…'` or `docker exec … sh -c`, a non-literal `-c "$cmd"`,
  and a silent probe that exits non-zero with no output and no `sleep` in its command. Each of these
  counts, and the worst outcome is a notice on the 3rd failure.

**What is excluded on this machine** (`01-corpus-scan.md` §2): X3 221, X5 332, X1 105, X2 24, X7 3,
of 4,036 failures.

### 3.5 The two rules and the window

- **Exact:** same loop, same input signature, same error signature.
- **Same-error:** same loop, same tool, same error signature, any input (E4: six different card
  slugs, one `NOT_FOUND`).

A run stays open while each new member lands within **20 calls and 10 minutes** of the previous one.
Round 1 measured that the window barely matters (10/5 min and 50/30 min gave the same counts).

### 3.6 Resets

| Reset  | When                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **R1** | A success of the same input signature clears its exact entry and its tool's same-error entry                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **R2** | **Any success that may have changed the world clears every entry in the loop.** `isMutation`: `Edit`/`Write`/`MultiEdit`/`NotebookEdit`; a `Bash` command with an output redirection to a file, `sed -i`/`perl -i`, `find -delete/-exec`, a `git` subcommand outside the read-only set, or any command word outside the read-only list (`cat ls head tail wc grep rg echo …`); an MCP tool whose verb is not a read verb; any other built-in outside the read-only set. **Unknown counts as a change**: a wrong guess can only reset early, never trip |
| **R3** | The window expires (§3.5)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **R4** | The person types a prompt (`turn.start` with non-empty `text`, `T:13374-13388`): the main loop starts over                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **R5** | The person presses "Let it retry" in the dialog: that key is muted for the session, and a system notice `[retry-breaker] muted <key>` is appended to the transcript                                                                                                                                                                                                                                                                                                                                                                                    |
| **R6** | `/retry-breaker reset`: every entry and mute cleared, and the system notice `[retry-breaker] reset` appended (proven, run 10)                                                                                                                                                                                                                                                                                                                                                                                                                          |

**Edits the session cannot see.** An edit the person makes in their editor, or one by another
process, is invisible to the loop. If it changed what the failing call depends on, the error usually
changes too, and a changed error is a new signature. If the error is byte-identical after the edit,
the edit did not change what the call sees, and the failure is genuinely the same. The worst case is
a notice. A person who types after editing triggers R4 anyway.

A compaction does not reset: a storm across a compaction is still a storm.

## 4. Thresholds, measured (U-2)

Round 2 replays every transcript on this machine (12,057 files, 2,804 loops, 115,595 calls, 4,036
failures; this spec's probe sessions under `/tmp` skipped) through the prototype's own `core.ts`.
Full method, labels, examples and source: [`01-corpus-scan.md`](01-corpus-scan.md).

| Rule       | k   | Trips | False positives | 95 % upper bound | Rung that uses it              |
| ---------- | --- | ----- | --------------- | ---------------- | ------------------------------ |
| exact      | 2   | 38    | 3 (7.9 %)       | 19.2 %           | none                           |
| exact      | 3   | 19    | 0               | 14.6 %           | **notice**                     |
| exact      | 4   | 6     | 0               | 39.3 %           | **dialog / escalation**        |
| exact      | 5   | 2     | 0               | 77.6 %           | **refusal of the 5th attempt** |
| same-error | 3   | 27    | 1 (3.7 %)       | 16.4 %           | none                           |
| same-error | 4   | 8     | 0               | 31.2 %           | **notice**                     |
| same-error | 5   | 3     | 0               | 63.2 %           | **dialog / escalation**        |

- **The bounds matter more than the zeros.** No false positive was observed at the chosen
  thresholds, but the trips are few. So each rung tells before it acts: a notice is free to be wrong,
  the dialog asks a person, the refusal says why and is lifted by one command. And the default level is
  `notice`, which never refuses (§10.1).
- **The exact-rule labels are close to tautological at k ≥ 3**: an unchanged call that failed the same
  way three times is a storm by the rubric's own definition, once polling and transients are excluded.
  The labels inform k = 2 and the same-error rule (`01-corpus-scan.md` §1).
- **Who the trips are.** Exact ≥ 3: `SendMessage` 16, `Agent` 3. Exact ≥ 4: `SendMessage` 3,
  `Agent` 3. Most of what the breaker catches here is F-1 (§15).
- **The abort cap ("two refused repeats") is not measured:** no run in the corpus pushed a refused
  call. It is a structural choice (OQ-3).
- **Run lengths.** Exact 2: 19 · 3: 13 · 4: 4 · 5: 2. Same-error 2: 47 · 3: 19 · 4: 5 · 5: 2 · 6: 1.
  Median gap between repeats 3.3 s (p90 6.5 s).
- **Savings ceiling.** 8 calls after an exact notice at 3, 4 after a same-error notice at 4; 27 at
  exact 2. Round 1's "6" and its script's "30" measured those two different things
  (`01-corpus-scan.md` §3.5).

## 5. Action ladder (U-3)

### 5.1 The rungs

| Rung | Trigger                                    | Level   | Attended (§5.2)                                        | Unattended (§5.2)                                     |
| ---- | ------------------------------------------ | ------- | ------------------------------------------------------ | ----------------------------------------------------- |
| 1    | exact 3, or same-error 4                   | notice+ | **notice** appended to the failing result              | same                                                  |
| 2    | exact 4, or same-error 5                   | notice+ | notice, **dialog** (§5.3), a native notification       | notice, a log line, and **Harnu's escalation** (§5.4) |
| 3    | a new call whose exact entry has reached 4 | enforce | **`deny`** with the reason; the dialog is already open | **`deny`** with the reason                            |
| 4    | a 3rd refused attempt of the same entry    | enforce | none: the person has the dialog's [Stop]               | **`$.turn.abort`**, main loop only                    |

**Rung 1, the notice.** Appended to the failing `tool_result`'s content:

```text
[retry-breaker] This exact <Tool> call has now failed <n> times with the same error. Repeating it unchanged will fail again: change the input, check the cause, or stop and say what blocks you.
```

The same-error wording says "across different inputs" and "the cause is likely outside the input".
It is part of the result, so the model reads it in its next request and the transcript keeps it
(proven, run 3: the model quoted it verbatim). In runs 4, 7 and 11 the model stopped at the notice or
the first refusal even when told to continue.

**Rung 3, the refusal.** `tool.check` first awaits the engine's verdict (`next(e)`, `T:3957-3969`).
An engine `deny` is returned unchanged. Otherwise, if the call's exact entry has reached 4, the hook
answers `{ decision: 'deny', reason }`:

```text
retry-breaker: this exact Read call already failed 4 times with the same error ("File does not exist. …"). Change the call or the cause first. The person can lift this with /retry-breaker reset.
```

The model reads it as `Permission to use <Tool> denied by plugin retry-breaker: <reason>`. Proven
unattended (run 3) and attended in auto mode (run 11). A same-error entry is never refused: its inputs
differ, so there is no identical call to refuse (OQ-6).

**Why not an `ask` when a person is there.** The first design answered `ask` when attended, so the
person's permission dialog would decide. Run 10 showed two things. In **manual** mode the dialog
appeared but did not draw the reason: the person saw "Do you want to proceed?" with no idea why. In
**auto** mode the mode settled the `ask` by itself ("Skipping auto mode classifier for Read: would be
allowed in acceptEdits mode") and the call ran, so the person was never asked and the reason was never
shown. A `deny` works the same in every mode. The person's override is the dialog, which opened one
failure earlier: "Let it retry" lifts the refusal, and `/retry-breaker reset` too.

**Rung 4, the abort.** `$.turn.abort({ turnId })` with the id `turn.start` handed the mod
(`T:2918-2931`, `T:13381`); proven in run 9 (`$.turn.abort (retry-breaker): cancelled turn …`). Only
unattended, only the main loop: attended, the person has [Stop] (run 11: no abort). A subagent's storm
is refused, never aborted, since the abort ends the parent's turn and every sibling.

### 5.2 Attended or unattended

| Signal                                                    | Source                                                                       | Reads as                             |
| --------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------ |
| `isInteractive: false` at `session.start`                 | `T:11682-11685`: `-p`, the SDK (proven `false`, runs 1–9; `true`, run 10)    | unattended                           |
| `HARNU_SESSION_ROLE` = `agent`, `tick` or `read-only`     | **new**, set by Harnu at spawn (below); read by `$.env.get` (proven, run 12) | unattended                           |
| `HARNU_SESSION_ROLE=operator`, or absent, and interactive | the operator's session, or any session outside Harnu                         | attended                             |
| a subagent's loop (`agentId` present)                     | `T:10586-10593`                                                              | never opens the dialog, never aborts |

**`HARNU_SESSION_ROLE`, specified.** No fact in the session tells an agent-spawned session from the
operator's today. The trust class (`operator | agent | read-only | tick`, `session-table.ts:29`) lives
on Harnu's side, and the mod sees only the opaque `HARNU_SPAWN_TOKEN` (`spawn-inject.ts:130-140`). An
env var is the smallest carrier, but it leaks: the PTY env spreads `process.env`
(`pty.ts:875-876`), so a Harnu running inside a Harnu session would hand its own role to every child.
The token has the same problem and is deleted first (`spawn-inject.ts:134`). So:

- **Delete, then set, on every `claude` spawn.** In `applyCompanionEnv` (or a sibling the PTY spawn
  calls beside it), `delete env.HARNU_SESSION_ROLE` unconditionally, then set it from the spawn's
  trust class whenever the breaker is staged. A spawn that stages no breaker carries no role.
- **Ticks too.** `tickEnv` (`spawn-inject.ts:147-155`, called at `scheduler-shell.ts:498`) builds the
  tick's env from `process.env`; it gains the same delete-then-set, with the value `tick`.
- **The mapping.** `operator → operator`, `agent → agent`, `tick → tick`, `read-only → read-only`.
  The mod reads `read-only` as unattended: the review companion (`pty.ts:264-271`) runs in plan mode
  for a stranger's read of a diff, and nobody watches its tool calls.
- **A hint, not a credential.** A forged `operator` shows a dialog nobody sees; a forged `agent` only
  removes the dialog and allows an abort the level already permits.

**An interactive session with nobody at it.** The dialog sits unanswered; at `enforce` the 5th
identical attempt is refused anyway, with its reason. Nothing runs repeatedly because the breaker
guessed "attended".

### 5.3 The dialog (attended, main loop)

Opened with `$.ui.open({ id: 'retry-breaker', title: 'Retry storm', focus: true, closeOnEscape:
true, holdToasts: true })` (`T:2479-2497`, `T:7390-7440`), with `$.ui.notify` beside it
(`T:2449-2466`). **Proven drawn live** in a terminal (run 10).

**What it shows.** The tool and the rule (`exact` / `same-error`); the count; up to the last four
failures side by side, one column each (`#n`, the error's first 160 characters), sized to
`e.props.bodyColumns`; the "Ask why" answer once there is one.

**What it offers.**

| Button        | Hotkey | Does                                                                                                                      |
| ------------- | ------ | ------------------------------------------------------------------------------------------------------------------------- |
| Stop the turn | `s`    | `$.turn.abort` on the running turn, closes the dialog                                                                     |
| Let it retry  | `r`    | mutes this entry for the session (R5), writes the mute notice, closes the dialog                                          |
| Ask why       | `w`    | `$.model.fork` (`T:2620-2638`, `R:163`): one tool-less question over the session's own transcript, answered in the dialog |
| Esc / close   |        | closes; counting goes on, so rung 3 still fires at `enforce`                                                              |

**What the live run taught (run 10).**

- **Focus.** `focus` is a request, granted only while the prompt holds the keys over an empty
  composer (`T:7406-7414`). A hotkey typed during a running turn went to the composer. The person
  focuses the dialog with `ctrl+x tab`. In tmux the chord reached it in 2 of 4 tries, so the W1 copy
  says it on the dialog's first line ("ctrl+x tab to act").
- **"Ask why" after an interrupted turn.** Answered `nothing-to-fork` (the fork needs the main
  thread's last request; `T:2628-2632` lists that reason for "before the first response and after
  `/clear`"). The dialog showed `no answer (nothing-to-fork)` and nothing broke. After a turn that
  ended normally it answered in about five seconds, and the answer was drawn in the dialog. If "Ask
  why" fails, the design loses only the explanation: the failures, [Stop] and "Let it retry" stand.
- **Escape closes it** (`closeOnEscape`), as intended; a person reaching for Esc to clear the
  composer closes the dialog too.

`$.ui.ask` (`T:2416-2430`) was rejected: it shows 2–4 labels, no side-by-side errors, and rejects in
`-p`.

### 5.4 Harnu's escalation (unattended)

Run in Harnu's main process, not in the mod (ADR-draft D3).

1. **Where.** `src/main/retry-storm.ts`, beside `stall-detect.ts` and `transcript-truth.ts` in
   `src/main/` (not `src/main/detect/`, which holds PTY-screen and task-state detection). It is called
   where `deriveStagnation` is (`claude-watcher.ts:512`, `transcript-truth.ts:389`), over the same
   transcript entries, and it imports the mod's `hooks/core.ts` unchanged.
2. **Scope, and where the trust class comes from.** Only sessions whose trust class is `agent`, `tick`
   or `read-only`; an operator's session gets the dialog instead. The twin must not read the class from
   the companion's binding table (`session-table.ts:2-9`, `:33`): that table has a row only for a
   session the companion was staged into, and staging is decoupled from the companion (§9.2), so a
   companion-off session has none. Its sources, none of which depends on the companion:
   - **PTY sessions:** `spawnOriginForSession(sessionKey)` (`pty.ts:1325-1328`), which returns
     `'agent'` or `'operator'`. It is stamped at the spawn site from `opts.spawnedBy` (`pty.ts:945`,
     `:960`) and is what `message_session` already uses to refuse an operator-owned recipient
     (`tool-handlers.ts:1885-1893`). It covers MCP `create_session` and board/manifest dispatch.
   - **Read-only reviewers:** not recorded after spawn today (`readOnly` is read at the spawn site only,
     `pty.ts:789`, `:838`). W3 records the class next to the origin: compute `trustFor({ readOnly,
agentControlled, spawnedBy })` (`spawn-inject.ts:111-120`) unconditionally at the spawn site and
     keep it in a sibling of `sessionSpawnOrigins` (`pty.ts:514`), which the session-key move at
     `pty.ts:1157-1160` must carry too. Until then a read-only reviewer reads as `operator` and gets no
     escalation, which is safe.
   - **Scheduler ticks:** the tick's own run record. The Scheduler spawns the child and knows its worker
     and run (`scheduler-shell.ts:495-498`), so it runs the twin over that run with the class `tick`.
3. **Rung 2 → an Activity notification**, through the path the `notify` verb uses
   (`tool-handlers.ts:1220-1240`): "Retry storm in <session>", the tool, the count, the error's head, a
   deep link to the session.
4. **Rung 2 → a mission blocker, optional (OQ-2).** When the session is linked to a step of an active
   mission, raise a blocker on that step with `owner: 'operator'` through the store function
   `mission_set_blocker`'s handler uses (`editMission`/`blockerTarget`, `tool-handlers.ts:4291-4323`).
   It clears on a reset of that entry.
5. **A Scheduler tick.** A `-p` run the mod aborted ends with `subtype: "success"` and an empty
   `result` (run 9). The tick's run record must read the escalation, not only the exit (F-3).

**Same code, different inputs: what the twin cannot see.**

| The mod sees                                         | The twin, from the transcript                                                                                                                                    |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| each call's `tool.check` verdict (X3 by verdict, X4) | **not stored.** It applies X3 by text only. The breaker's own refusal is stored as `Permission to use … denied by plugin retry-breaker`, which X3's text matches |
| `isInteractive`, `HARNU_SESSION_ROLE`                | **not stored.** It uses Harnu's trust class instead                                                                                                              |
| R4 (a typed prompt)                                  | yes: the prompt row                                                                                                                                              |
| R5 (mute), R6 (reset)                                | yes, only because the mod appends a system notice for each (proven for R6, run 10). A mod too old to write them leaves the twin counting past a mute             |
| `/retry-breaker off \| notice \| enforce`            | yes: a slash command's output is a stored row (`local_command`, run 10)                                                                                          |
| the window by wall-clock                             | yes: row timestamps                                                                                                                                              |
| a hot-reload's lost call map (A4)                    | no such loss: it re-reads the tail                                                                                                                               |

So "the same definition" means the same `core.ts` over the same rows. The twin can count a failure
the mod excluded by verdict and not by text. That errs toward escalating, never toward silence.

**Why not from the mod.** `$.mcp.call('harnu', 'notify', …)` fails everywhere it is needed. It is
forbidden in the companion (SEC-9 (b), `00-master.md:502`). It is absent in `create_session` agents
(`pty.ts:252-262`, `:812-819`). And under "Ask before agent actions" a mutation parks for 30 s and
returns `{ status: 'pending' }` (`confirm-core.ts:37`, `server.ts:1278-1290`), longer than a hook's
10 s budget (`T:5109`). T447's `$.harnu.notify` / `missionBlockerSet` ride the same call
(T447 `01-contract.md:210-227`) and answer `NO_MCP` there (T447 `00-spec.md:505-507`).

### 5.5 How the counter resets

R1–R6 (§3.6). The ledger lives in `$.state` (`retry-breaker.ledger`, `R:118`), so a hot reload keeps
it. The maps that join `tool_use` to `tool_result` and keep verdicts are module memory, lost on a
reload, which drops at most the calls in flight (A4).

## 6. No harm (U-4)

### 6.1 Never silent

- The notice is text in the result. A refusal carries its reason, which the model reads
  (`T:12866-12870`; proven, runs 3 and 11).
- A refusal fires only at level `enforce`, only on a call that already failed identically four times
  with two notices before it, and never on a same-error match.
- Every refusal names how to lift it (`/retry-breaker reset`, or the dialog's "Let it retry", which
  opened one failure earlier).
- It never refuses on its own failure (§10.2).

### 6.2 Permission prompts and the Approval Inbox

Order on one call: `tool.call` hooks → classic `PreToolUse` (Harnu's legacy approval bridge parks ≤
3.5 s, `approval-resolver.ts:25`) → `tool.check` ("after the `tool.call` and PreToolUse hooks and
before the mode settles an ask", `T:3957-3960`) → the mode's decider (the dialog, the classifier, a
`classic.PermissionRequest` hook such as Harnu's bridge or the companion's future P3W1 hold).

- **The breaker never loosens a verdict.** An engine `deny` stays a `deny`; an `allow` or an `ask`
  may become a `deny`; nothing becomes `allow`.
- **The breaker never answers `ask`** (§5.1, run 10). So it never adds an entry to the Approval Inbox
  and never interacts with P3W1's hold. A call the engine itself put to the person reaches the person
  as before; if they refuse it, X1 keeps it out of every count (proven, run 10: "No" was not counted).
- **A refused call is never a failure** (X1, X3, X4).
- **Permission modes.** A `tool.check` `deny` holds in every mode, `bypassPermissions` included
  (T389 smoke B1.6, `P3W2-structured-sentinel.md:49`), and was proven here unattended (`-p`, run 3) and
  attended in auto mode (run 11). No mode-specific branch is needed.

### 6.3 Subagents, teammates and worktree isolation

- **Counted apart** in the subagent's own loop (`agentId`; kit; proven, run 5). **The notice reaches
  the subagent** (run 5).
- **No dialog, no abort.** Rung 2 logs a line; rung 3 refuses the identical call inside the subagent's
  loop; rung 4 never fires for a subagent.
- **Worktree isolation**: see §8.1.
- **Teammates:** one in a terminal pane of its own "runs no loop here" (`T:130-132`); there it is
  another session with its own copy of the mod.
- **Parallel identical calls** issued in one response count one by one as their results land (run 5).

### 6.4 Cost on the hot path

`session.append` fires for every row (`T:4349`). Per tool-result row the hooks do a constant-time
hash, a shell tokenisation of at most one command, and one `$.state` read and write. A hook's budget
is 10 s per dispatch, and a `$` call in flight does not count against it (`T:5100-5125`, `R:154`).

## 7. Engine grounding (C-1)

| Mechanism                                                              | Cited from                                                 | Status                                                                                        |
| ---------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `session.append`, doors `response`/`tool-result`, one id joins them    | `T:4349-4359`, `T:10556-10594`, `R:137-141`                | **proven** (run 3)                                                                            |
| rewriting a `tool_result`'s content; the transcript stores the rewrite | `T:10627-10634`, `T:4352-4355`, `R:141`                    | **proven** (run 3: 4 notices, 4 refusals stored)                                              |
| `agentId` on `session.append` and `tool.check`                         | `T:10586-10593`, `T:12833-12839`                           | **proven** (run 5)                                                                            |
| `tool.check` `deny` with a reason the model reads                      | `T:3957-3969`, `T:12802`, `T:12855-12870`                  | **proven** unattended (run 3), attended in auto mode (run 11)                                 |
| `tool.check` `ask`: the reason "the dialog shows on an ask"            | `T:12866-12870`                                            | **refuted live**: not drawn in manual mode; settled by the mode in auto mode (run 10)         |
| headless `ask` comes back as an error result                           | none                                                       | **proven** (run 1)                                                                            |
| `session.start` `isInteractive`                                        | `T:11671-11686`                                            | **proven** `false` (runs 1–9, 12) and `true` (run 10)                                         |
| `$.env.get` of a literal                                               | `T:3590-3598`                                              | **proven** (run 12)                                                                           |
| `turn.start` `turnId`, `$.turn.abort`                                  | `T:13374-13388`, `T:2918-2931`                             | **proven** (run 9)                                                                            |
| `$.command.register`, `command.run`                                    | `T:1792-1837`, `R:183-200`                                 | **proven** (run 10: `/retry-breaker enforce`, `reset`)                                        |
| `$.session.append` of a system notice, stored                          | `R:145`                                                    | **proven** (run 10: `[retry-breaker] reset` stored)                                           |
| a slash command's output is stored                                     | `R:137`                                                    | **proven** (run 10: a `local_command` row)                                                    |
| `$.ui.open` dialog, `Pane` props, `Button` `hotkey`/`onPress`          | `T:2479-2497`, `T:7390-7440`, `T:10312-10356`, `R:131-133` | **proven drawn** (run 10); a press: kit                                                       |
| focus is a request                                                     | `T:7406-7414`                                              | **proven** (run 10: a key during a turn went to the composer)                                 |
| `$.model.fork`                                                         | `T:2620-2638`, `R:163`                                     | **proven** (run 10: answered after a normal turn; `nothing-to-fork` after an interrupted one) |
| `$.ui.notify`, `$.ui.log`                                              | `T:2449-2466`, `T:2399-2414`                               | kit                                                                                           |
| `$.state` atoms, `update`; the `userConfig` picker                     | `T:14701-14735`, `R:118`, `R:74`                           | kit (`level` through `test(name, { options })`)                                               |
| `.catch` on gating hooks                                               | `R:79`, `T:3940`                                           | validate lists all three                                                                      |
| hook budget                                                            | `T:5100-5125`, `R:154`                                     | doc                                                                                           |
| worktree-isolated agents unharmed                                      | `docs/studies/T389-smoke-evidence.md:628-650` (the hazard) | **proven** headless (run 8); interactive and tick unrun (A3)                                  |
| test kit: `test`, `mock.*`, `$.ui.mount`, `$.command.run`              | `T:15921`, `T:15460-15480`, `T:15800-15835`, `R:81`        | kit (15 pass)                                                                                 |

Not relied on: `classic.PostToolUseFailure` (`T:7851`), "never observed firing" in T389's smoke
(`01-contract.md:665`); `$.ui.notice` (never rendered, ADR-0018:115-116).

## 8. Relation to T389, T447 and T175 (C-2)

### 8.1 #92533: caution, not a confirmed bug

| Evidence                                                                   | Build             | Result                                                                                                                 |
| -------------------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------- |
| T389 smoke B4 (`docs/studies/T389-smoke-evidence.md:628-650`)              | an earlier build  | a pass-through Bash `tool.call` hook: "Worktree isolation was lost" (CONFIRMED)                                        |
| T450 verifier (`b4-mod4`, a marker in an `isolation: "worktree"` subagent) | 2.1.296, headless | with a Bash `tool.call` hook and the operator's rewrite hook off, `pwd` and branch were the worktree's: isolation held |
| this spec, run 8 (`session.append` + `tool.check`, no `tool.call`)         | 2.1.296, headless | the subagent's `pwd` was its worktree                                                                                  |
| interactive, or a Scheduler tick                                           | none              | **unrun**                                                                                                              |

The breaker keeps `session.append` + `tool.check`: it needs nothing from `tool.call` that it cannot
get otherwise, and the companion's rule (MOD-3, `00-master.md:524`) still forbids it. **If W0 finds
#92533 gone** (interactive and tick runs included), one thing becomes worth having: `tool.call`'s
result carries `isReadOnly`, the tool's own read-only verdict on the call as run (`T:12752-12760`).
That could replace R2's command-word heuristic for deciding which successes reset the count. Nothing
else would change.

### 8.2 The waves

| Wave / spec                   | Status (checked against code)                                        | Relation                                                                                                                                      |
| ----------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| ADR-0018 D6, MOD-3, SEC-9 (d) | in force (`00-master.md:502`, `:524`)                                | **builds on** (§8.1)                                                                                                                          |
| P1W2 skeleton, staging        | shipped (`staging-core.ts:72-86`, `spawn-inject.ts:72-95`)           | **extends**: stages a second bundled mod, gated on its own (§9.2)                                                                             |
| P1W5 fleet state              | shipped (`resources/companion/hooks/lib/fleet-sensor.ts`)            | **no overlap**: it tracks settled tools and "stuck" by timer; it ignores the failed flag                                                      |
| P2W1 command channel          | shipped (6 commands, `turn.abort` among them)                        | **not used**: host → mod only; the breaker aborts itself                                                                                      |
| P2W5 MCP attribution          | planned                                                              | **no overlap**: it owns the companion's only allowed `tool.call` matcher                                                                      |
| P3W1 approval hold            | planned (insertion points only)                                      | **no interaction**: the breaker never answers `ask` (§6.2)                                                                                    |
| P3W2 structured Sentinel      | planned                                                              | **overlaps in seat, not in rule**: both deny through `tool.check`; the Sentinel is static and host-evaluated, the breaker stateful and in-mod |
| P4W1 Mods audit               | shipped (`mods-audit-core.ts`)                                       | **extends**: discovery of a second staged dir, and a chip for `session.append` (§10.3)                                                        |
| P4W2 terminal band            | planned                                                              | **not used**: absent inside Harnu (`P4W2…md:39-40`)                                                                                           |
| P4W3 companion outside Harnu  | shipped (`external-install.ts`)                                      | **reuses the pattern** for the breaker's own "outside Harnu" switch (§9.3)                                                                    |
| T175 `stall-detect.ts`        | shipped (`stall-detect.ts:21-24`, `:177`)                            | **complements**: it catches loops with no new fingerprint (X7's cost); the host twin sits beside it                                           |
| T447 `$.harnu` noun           | specified, not built (docs merged in #41; no `resources/harnu-sdk/`) | **not used**: its `notify`/`missionBlockerSet` ride `$.mcp.call` (§5.4)                                                                       |

New here: the detector, the ladder, the dialog, `HARNU_SESSION_ROLE`, the host twin, and the P1W2 and
P4W1 deltas.

## 9. Packaging (C-3)

### 9.1 Decision

**A mix** (ADR-draft D2, D3):

1. **A new bundled mod, `retry-breaker`**, source `resources/retry-breaker/` (`02-prototype.md`,
   `04-detector-core.md`). Harnu stages it as one more `--plugin-dir` into operator, agent and tick
   sessions. It holds detection and every in-session action.
2. **Harnu main code:** `src/main/retry-storm.ts` (§5.4) and `HARNU_SESSION_ROLE` (§5.2).

### 9.2 Staging, decoupled from the companion

The companion's provider returns no plan when the companion's mode is `off`
(`spawn-inject.ts:79`). Hanging the breaker on that plan would make turning the companion off quietly
turn the breaker off too, even at level `enforce`. So the breaker is staged by its own gate:

- its own `retryBreaker` level not `off` (§10.1);
- the CLI version floor and the sideload block (`spawn-inject.ts:80-81`), which concern the CLI and
  not the companion;
- **not** the companion's mode, kill switch or lease.

It reuses the staging mechanics (`staging-core.ts`), generalised from one directory to a list.
`HARNU_SESSION_ROLE` is set whenever the breaker is staged, with or without the companion.

### 9.3 Why not elsewhere, and outside Harnu

- **Not inside the companion:**
  - its hook surface is closed and checked in (MOD-3, `api-surface.json`), and it is meant to stay
    "small, readable" (ADR-0018:33-45);
  - its outside-Harnu profile never enables `act.*`, `gate.guard` or `gate.sentinel`
    (`P4W3…md:200-203`), while the breaker is an actuator and a gate;
  - a separate mod has its own switch and its own Mods row.
- **Not host-only:** the host cannot put a sentence in the model's next request or refuse a call.
- **Outside Harnu**, the mod has no Harnu dependency. A session gets the whole in-session ladder and
  no escalation: through `/plugin install retry-breaker --marketplace <owner>/<repo>` once published
  (`R:83-105`), or a Settings → Mods "Also outside Harnu" switch that adds the staged dir to
  `CLAUDE_CODE_PLUGIN_DIRS` (the P4W3 pattern). `HARNU_SESSION_ROLE` is absent there, so
  `isInteractive` alone decides.

## 10. Control and failure (C-4)

### 10.1 Switch and default

- **Harnu:** one setting, `retryBreaker: 'off' | 'notice' | 'enforce'`, global with a per-folder
  override, in its own prefs key (not the companion's family modes). `off` stages nothing.
- **In the mod:** the `userConfig` field `level` with the same values (`R:74`), so a standalone install
  has the switch too, plus `/retry-breaker off | notice | enforce | reset | status` for the running
  session (proven, run 10).
- **Default: `notice`** (rungs 1–2: the notice and the dialog, or the escalation). It never refuses and
  never aborts. `enforce` adds rungs 3–4 and is the operator's choice (OQ-5). Why: the refusal rung's
  false-positive rate is bounded only below about 40 %, and most of what it would refuse here
  disappears with F-1's fix.
- A change reaches **new** sessions; a running one keeps its staged copy, or uses the command.

### 10.2 Failure: fail-open

Every gating hook carries `.catch(($, e, next) => next(e))` (`R:79`; validate lists all three). A hook
that throws, overruns or answers a wrong shape leaves the engine's verdict on `tool.check` and the row
unchanged on `session.append`.

**This departs from the types' advice on purpose.** `tool.check`'s doc tells a guard to fail closed:
"give it `.catch(() => ({ decision: "deny" }))`" (`T:3964-3965`). That fits a guard whose job is
safety. The breaker's refusals are a convenience, and refusing calls because of its own bug is exactly
the harm U-4 forbids. The host twin fails the same way: a parse error drops the escalation, never the
session.

### 10.3 Settings → Mods audit chips

From `deriveCapabilities` (`mods-audit-core.ts:370-391`) and what validate reports:

| Chip          | Why it shows                        |
| ------------- | ----------------------------------- |
| `prompts`     | hooks `turn.start` (`:379`)         |
| `permissions` | hooks `tool.check` (`:382`)         |
| `model`       | calls `model.fork` (`:384`)         |
| `env`         | reads `HARNU_SESSION_ROLE` (`:388`) |
| `terminal`    | hooks `ui.render` (`:389`)          |

Not shown, correctly: `tool-calls`, `mcp`, `files`, `process`, `network`, `other-mods`, `submit` (it
registers a command but never calls `command.run`). Two gaps:

- **No chip says it rewrites conversation rows.** `session.append` maps to none. Delta for P4W1: a
  `transcript` chip ("can change what the conversation stores") for any hook on `session.append`.
- **Discovery knows one Harnu-staged dir** (`companionDir`, `mods-audit.ts:618`); it must list every
  staged bundled mod.

## 11. Prototype (C-5)

The hooks module, its manifest with `level`, its contract and its tests:
[`02-prototype.md`](02-prototype.md), [`04-detector-core.md`](04-detector-core.md),
[`03-prototype-tests.md`](03-prototype-tests.md), with the real output of:

- `claude plugin validate`: passed, no warning;
- `claude plugin test`: 15 pass, 0 fail;
- `tsc -p` (TypeScript 5.9.3, the header's options): exit 0;
- twelve live runs, two of them interactive (§7).

Defects the runs found that the kit could not:

- a headless `ask` was counted as a failure (run 1);
- the stored notice changed the error signature the twin would read (run 3);
- an `ask` is unreliable (run 10), which turned rung 3 into a `deny`;
- the prototype did not record its own `ask` as a verdict (run 10; moot now that it no longer asks).

The kit and the round-2 replay found three more: polls counted under the same-error rule, the
substring polling rule, and the `2>&1` tokenizer bug.

## 12. Implementation outline (C-6)

**Recommended path (OQ-1):** F-1 fix → re-scan (a replay of `01-corpus-scan.md`; no deployed mod needed) → W0 → W1. W2–W6 only if the re-scan still shows storms in unattended runs.

| Wave | Size | Depends on  | Delivers                                                                                                                                                                                                                                       |
| ---- | ---- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-1  | S    | none        | the `SendMessage` schema contradiction is reported upstream by the operator through `/feedback` (§15, OQ-7); Harnu's own guidance stays as it is until `"message": ""` is tested                                                               |
| —    |      | F-1         | **re-scan**: re-run `01-corpus-scan.md`'s replay over the transcripts written after F-1 lands. It needs no mod. Continue only if storms remain                                                                                                 |
| W0   | S    | re-scan     | spike: A3, A4, A6 (§13); #92533 interactive and in a tick (§8.1)                                                                                                                                                                               |
| W1   | S    | W0          | `resources/retry-breaker/` (prototype hardened): copy review, the dialog's focus hint, kit tests in CI; installable standalone; default `notice`                                                                                               |
| W2   | M    | W1, re-scan | staging of a second bundled mod, decoupled (§9.2); `HARNU_SESSION_ROLE` delete-then-set on PTY and tick spawns; the `retryBreaker` pref and its Settings control; Mods audit discovery of every staged dir                                     |
| W3   | M    | W1, re-scan | host twin `src/main/retry-storm.ts` (trust class from `spawnOriginForSession`, a recorded `read-only` class, and the tick's run record: §5.4); Activity notification for `agent`/`tick`/`read-only`; the Scheduler run record reading it (F-3) |
| W4   | S    | W3          | mission blocker raise/clear, if OQ-2 says yes                                                                                                                                                                                                  |
| W5   | S    | W2          | Mods audit `transcript` chip                                                                                                                                                                                                                   |
| W6   | S    | W1          | marketplace publication and the "Also outside Harnu" switch                                                                                                                                                                                    |

**Contracts the implementation owes:**

| Contract                               | Waves      | What                                                                                                                                                         |
| -------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CHANGELOG.md`                         | W1–W6      | one user-facing entry per shipped wave                                                                                                                       |
| `docs/harnu-features.md` + marker bump | W1, W3, W4 | agents meet a notice and a refusal text, and Harnu raises blockers on their missions. The `SendMessage` wording changes only after `"message": ""` is tested |
| `docs/user/`                           | W2, W3, W6 | a page for the breaker: what it does, the levels, the dialog, outside Harnu                                                                                  |
| `design.md` + `en.json` + `pt-BR.json` | W2, W5     | the Settings control and the audit chip are renderer UI; the mod's own dialog copy is English in the mod, as the companion's is                              |
| `docs/specs/T389-companion-mod/`       | W2, W5     | P1W2 staging list, P4W1 chip table                                                                                                                           |
| ADR                                    | merge      | `ADR-draft.md` numbered                                                                                                                                      |
| `tests/no-client-identifiers.test.ts`  | every wave | fixtures use the neutral vocabulary                                                                                                                          |

## 13. Assumptions the W0 spike must check

| Id  | Assumption                                                                                                   | Status / what the design does if it fails                                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | A hook's `ask` reaches the person with its reason                                                            | **settled, false** (run 10). The design no longer asks                                                                                                                                                           |
| A2  | (round 1) the companion sees the breaker's `ask`                                                             | **moot**: no `ask`                                                                                                                                                                                               |
| A3  | `session.append` + `tool.check` leave worktree agents alone **interactively and in a tick** (run 8 was `-p`) | unrun. If it fails: the breaker drops its `session.append` hooks on subagent loops (`agentId` present), and subagents lose the notice and the refusal                                                            |
| A4  | Losing the module-memory call map on a hot reload drops only calls in flight                                 | doc-derived. If more is lost: some failures go uncounted (the safe direction)                                                                                                                                    |
| A5  | `HARNU_SESSION_ROLE` reaches `$.env.get`                                                                     | **settled, true** (run 12)                                                                                                                                                                                       |
| A6  | The engine's refusal texts in X1–X3 are stable across the CLI range Harnu supports                           | unrun across versions. If a text changes: in-session, the verdict still excludes it; the twin and the scan would count it, which errs toward a notice or an escalation, never a refusal (the twin never refuses) |

## 14. Open questions (C-7)

| Id   | Question                                                                                                                                                                                                                                                                                                          | Who decides |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| OQ-1 | **Build it, and how far?** Recommendation: F-1 fix first; then re-scan; then W0 + W1 at default `notice` (S); W2–W6 only if the re-scan still shows unattended storms. The data: 8 calls saved in 115,595, and 16 of the 19 storms are one engine bug                                                             | operator    |
| OQ-2 | Should the host twin raise a mission blocker, or only notify? A blocker chimes every 30 minutes until cleared                                                                                                                                                                                                     | operator    |
| OQ-3 | The abort cap (two refused repeats) is unmeasured. Keep it, raise it, or never abort and only refuse?                                                                                                                                                                                                             | operator    |
| OQ-4 | Is the polling vocabulary (X5) right for the operator's tools, and should it be editable from Settings rather than only in the mod?                                                                                                                                                                               | operator    |
| OQ-5 | Default level `notice` (recommended) or `enforce`?                                                                                                                                                                                                                                                                | operator    |
| OQ-6 | Should the same-error rule ever refuse (for example after 6), given E2-type storms ("Do not retry") never have an identical call to refuse?                                                                                                                                                                       | operator    |
| OQ-7 | **Answered (orchestrator).** The upstream report on the `SendMessage` schema-versus-description contradiction is drafted and queued for the operator to send through `/feedback`; filing it is the operator's call, not Harnu's. Harnu's guidance is **not** changed to `"message": ""` until that form is tested | answered    |
| OQ-8 | Should the host twin also mark an operator's session row ("retrying") in the fleet view, though the dialog is already on their screen?                                                                                                                                                                            | operator    |

## 15. Findings outside the AC list

- **F-1 — the dominant storm is an engine-side contradiction.**
  - **The counts.** There are 146 `SendMessage` JSON-parse failures on this machine (distinct
    `tool_use` ids). All are `notify_when_idle: true` with an empty message: 53 written
    `"message": }` and 93 written `"message": ,`. They make up 16 of the 19 exact storms ≥ 3.
  - **The contradiction.** Claude Code's `SendMessage` tool, as handed to a 2.1.296 session (this
    executor's own tool list), marks `message` as **required**. Its description says "Omit `message`
    for a pure subscription". Its `notify_when_idle` field says "Without a message (omit it)". The
    model tries to follow both and writes a key with no value.
  - **Harnu's part.** `docs/harnu-features.md:347` repeats "and no message". Rewording it cannot fix
    the schema, and Harnu's guidance stays as it is until `"message": ""` is tested (OQ-7, answered).
  - **Where to fix it.** Upstream, in the tool's schema or description. The report is drafted and
    queued for the operator to send through `/feedback`.
- **F-2 — the operator's Bash rewrite hook trips the worktree guard.** Run 6 and the corpus group
  "this agent is isolated in the worktree …, but this command runs rtk …" show a user-level
  `PreToolUse` rewrite making Claude Code refuse git commands in worktree agents. Not Harnu's code, but
  a storm source on this machine.
- **F-3 — an aborted `-p` run reads as success.** `subtype: "success"`, `result: ""` (run 9). A Harnu
  consumer of a tick's result should treat an empty result as "ended early".
- **F-4 — the Mods audit has no chip for `session.append`** (§10.3).
- **F-5 — an `ask` from a hook does not show its reason in the terminal** (run 10). That matters
  beyond this mod: any design that relies on the `reason` reaching the person through an `ask` (P3W2's
  Sentinel ask kind, for one) should check it live.
