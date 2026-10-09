# T453 — Retry-storm breaker: stop the same failing tool call repeating

**Status:** specified (not implemented) · **Date:** 2026-10-09 · **Card:** T453 · **Decision
record:** [`ADR-draft.md`](ADR-draft.md) (proposed; numbered when merged)

Files: this spec; [`01-corpus-scan.md`](01-corpus-scan.md) (the measurement behind every threshold,
U-2); [`02-prototype.md`](02-prototype.md) (the prototype mod, C-5);
[`03-prototype-tests.md`](03-prototype-tests.md) (its tests and the live runs that prove the
mechanisms, C-1/C-5).

## 0. Summary

A small mod, **`retry-breaker`**, counts identical failing tool calls inside each conversation loop
and climbs a ladder: a notice the model reads on the 3rd identical failure, a dialog for the person
(or a Harnu escalation when nobody is there) on the 4th, a refusal of the 5th identical attempt with
the reason, and an end to the turn if the model keeps pushing a refused call in an unattended run.

Six facts shape the design:

1. **No `tool.call` hook.** A pass-through `tool.call` hook on Bash breaks
   `Agent(isolation: "worktree")` (#92533; ADR-0018:121-127). The mod observes calls through
   `session.append`, which sees every `tool_use` and every `tool_result` row (proven, run 3), and
   refuses through `tool.check`, which is safe on Bash (T389 smoke B4; this spec's run 8).
2. **The notice is a rewrite of the failing result.** A `session.append` hook may append text to a
   `tool_result`'s content; the model reads it and the transcript keeps it (proven, run 3).
3. **A refusal always says why.** It is a `tool.check` verdict with a `reason` the model reads
   (`deny`) or the person's dialog shows (`ask`) (proven, run 3).
4. **Who is watching decides the rung.** Attended (an operator's interactive session): the
   person's own dialog and an `ask`. Unattended (`-p`, a Scheduler tick, a session Harnu spawned for
   an agent): a refusal, an abort cap, and Harnu's escalation.
5. **Harnu's escalation runs in the host, not in the mod.** The mod cannot reach Harnu where it
   matters: `$.mcp.call` is forbidden to the companion (SEC-9 (b)) and absent in agent-spawned
   sessions (`src/main/pty.ts:812-819`). Harnu runs the same detector (`hooks/core.ts`, zero
   imports) over the transcript it already watches, and raises a notification and an optional
   mission blocker for unattended sessions.
6. **Storms are rare here.** On this machine's 112,674 tool calls, 23 exact runs reached 3, none
   passed 4, and a perfectly obeyed notice would have saved 6 calls. 21 of the 23 come from one
   cause (§15 F-1). The thresholds below have a measured false-positive rate of 0 %, but the token
   savings the ideation promised are not in this corpus (OQ-1).

## 1. Origin and scope

**Origin.** Idea 81 of the operator's ideation report (`.harnu/out/claude-code-mods-ideas.md` in
the main checkout, gitignored): "Counts identical failing tool calls (same tool, same input hash,
same error) and on the third opens a dialog 'Same failure ×3 — stop and rethink?' with the three
errors side by side; optionally forks a tool-less 'why is this failing?' question." Uses: "`tool.call`
await-then-inspect, `$.state` ring buffer, `Pane` dialog mode, `$.model.fork`, `turn.abort` on
[Stop]." The report lists it among "Ten I would build first".

**Deviations from the idea.**

| Idea said                      | This spec                                               | Why                                                        |
| ------------------------------ | ------------------------------------------------------- | ---------------------------------------------------------- |
| `tool.call` await-then-inspect | `session.append` to observe, `tool.check` to refuse     | #92533; SEC-9 (d); MOD-3 (§8)                              |
| a dialog on the 3rd            | a notice to the model on the 3rd, the dialog on the 4th | measured: the model stops after the notice (§4, runs 4, 7) |
| same input hash only           | two rules: exact, and same-error with any input         | 13 same-error storms the exact rule misses (§4)            |
| `turn.abort` on [Stop]         | on [Stop], and automatically only in unattended runs    | the person decides when present (U-4)                      |

**Goals.**

- G1. Stop an identical failing call from repeating without a change, in every session the mod
  loads in, Harnu's or not.
- G2. Tell the model, then the person, before refusing anything; never refuse without the reason.
- G3. In an unattended Harnu session, make the storm visible to the operator without them opening
  the session.

**Non-goals.** No repair of the failing call (the model or the person does that). No cross-session
memory of storms (`$.store` is unused). No detection of loops that do not fail (T175's
`stall-detect.ts` already flags stagnation). No change to Claude Code's permission rules.

## 2. Conventions

- `T:n` is line _n_ of `types/claude-code.d.ts` written by Claude Code 2.1.295 through the
  `plugin-authoring` skill; `R:n` is line _n_ of that skill's `reference.md`. The live runs and the
  test kit ran on 2.1.296, the CLI installed when this spec was written.
- A fact marked **proven (run n)** was observed in a real session (`03-prototype-tests.md` §3); **kit**
  means `claude plugin test`; **doc** means the types or reference say so and nothing here ran it.
- "Loop" is one model conversation: the main one, or a subagent's, named by `agentId`.
- Harnu source is cited from this worktree (`main` at `cb7fb58`).

## 3. "Same failure", defined (U-1)

### 3.1 Calls and loops

A call is a `tool_use` block appended through `session.append` door `response`
(`T:10556`, `T:10566-10594`), joined by id to the `tool_result` appended through door
`tool-result`. Every rule below is per loop: the key is `e.agentId ?? 'main'`, which both
`session.append` (`T:10586-10593`) and `tool.check` (`T:12833-12839`) carry (proven, run 5).

### 3.2 Input normalisation, per tool

The input signature is a hash of the fields below. Fields not named do not count.

| Tool                 | Signature fields                              | Why                                                                                |
| -------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------- |
| `Bash`               | `command`, whitespace collapsed and trimmed   | `description`, `timeout` and `run_in_background` change nothing about why it fails |
| `Edit`               | `file_path`, `old_string`                     | a mismatch is about `old_string`; changing only `new_string` does not fix it       |
| `Read`               | `file_path`, `offset`, `limit`                | a missing path ignores the window, but "file too large" is fixed by changing it    |
| `Write`              | `file_path`                                   | its failures ("read it first", a denied path) are about the path                   |
| `NotebookEdit`       | `notebook_path`, `cell_id`                    | as `Edit`                                                                          |
| `Grep`, `Glob`       | `pattern`, `path`, `glob`                     | output options do not cause failures                                               |
| `Agent`              | `subagent_type`, `isolation`                  | its failures (unknown type, limit reached, no pane) ignore the prompt              |
| MCP tools (`mcp__*`) | every argument, keys sorted, values canonical | a server's tool is opaque; the whole call is the call                              |
| any other tool       | every argument but `description`, canonical   | conservative default                                                               |

### 3.3 What counts as a failure, and "the same error"

A **failure** is a `tool_result` with `is_error: true` (`T:12764-12790`) whose call was **run and
failed**, not refused before it ran. The error **class** is taken from the result's text
(`hooks/core.ts` `classify`); three classes are never counted (§3.4 X1–X3).

The **error signature** hashes the error text after: removing the mod's own notice (the transcript
stores it, run 3), folding hex ids of 7–40 characters to `H` and numbers to `N`, collapsing
whitespace, and keeping 600 characters. So `Exit code 1 … line 42` and `… line 43` are the same
error, and a refreshed token count does not make a new one.

### 3.4 Exclusions, as rules

| Rule   | Never counted                                                                | How it is recognised                                                                                                                                                                                                                                                          |
| ------ | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **X1** | The person refused the call, or answered an `AskUserQuestion` with "clarify" | engine text `The user doesn't want to proceed`, `The user wants to clarify` (111 + 55 in the corpus)                                                                                                                                                                          |
| **X2** | The call was interrupted                                                     | `[Request interrupted`, `Interrupted by user`, `[Tool call interrupted`                                                                                                                                                                                                       |
| **X3** | The permission layer refused it                                              | its `tool.check` verdict was `deny`; or `ask` in an unattended session (nobody to approve: run 1); or engine text: auto-mode classifier no-verdict or rate-limited, `requested permissions … haven't granted`, `This command requires approval`, `Permission to use … denied` |
| **X4** | The breaker's own refusal                                                    | recorded as `deny` by the breaker before it answers                                                                                                                                                                                                                           |
| **X5** | Polling                                                                      | a `Bash` command naming `sleep`, `until`, `while`, `watch`, `--watch`, `wait-for`, `wait-on`, `gh pr checks`, `gh run view`, `gh run watch` or `kubectl rollout status`; the list is a `userConfig` option (OQ-4)                                                             |
| **X6** | Re-running after a real edit                                                 | a successful `Edit`, `Write`, `MultiEdit` or `NotebookEdit` in the loop resets every `Bash` entry (§3.6 R2)                                                                                                                                                                   |
| **X7** | Waiting for a server                                                         | with a wait in the command, X5; without one, it is counted, and the notice on the 3rd is the right answer: it says "check the cause" (§5.1)                                                                                                                                   |
| **X8** | A bare exit status                                                           | an error that normalises to `Exit code N` alone never feeds the same-error rule (it still feeds the exact rule)                                                                                                                                                               |

X3 is keyed on the verdict first and the text second because the text is the engine's and can
change between builds; the verdict is the API's (`T:12855-12870`).

### 3.5 The two rules and the window

- **Exact:** same loop, same input signature, same error signature.
- **Same-error:** same loop, same tool, same error signature, any input (catches E4 in
  `01-corpus-scan.md` §6: five different `Agent` prompts, one "limit reached" error).

A run stays open while each new member lands within **20 calls and 10 minutes** of the previous
one. The window is measured as not mattering (`01-corpus-scan.md` §3.2: 10/5 min and 50/30 min give
the same counts).

### 3.6 Resets

| Reset  | When                                                                                                            |
| ------ | --------------------------------------------------------------------------------------------------------------- |
| **R1** | A success of the same input signature clears its exact entry and its tool's same-error entry                    |
| **R2** | A successful mutating call (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`) clears every `Bash` entry in the loop |
| **R3** | The window expires (§3.5)                                                                                       |
| **R4** | The person types a prompt (`turn.start` with non-empty `text`, `T:13374-13388`): the main loop starts over      |
| **R5** | The person presses "Let it retry" in the dialog: that key is muted for the session                              |
| **R6** | `/retry-breaker reset`: every entry and every mute cleared                                                      |

A compaction does not reset: a storm across a compaction is still a storm.

## 4. Thresholds, measured (U-2)

Measured over every transcript on this machine (12,184 files, 2,886 loops, 112,674 calls, 4,030
failures), every run of length ≥ 2 labelled by hand. Full method, labels, examples and the scanner's
source: [`01-corpus-scan.md`](01-corpus-scan.md).

| Rule       | k   | Trips | False positives | Rung that uses it              |
| ---------- | --- | ----- | --------------- | ------------------------------ |
| exact      | 2   | 62    | 8 (12.9 %)      | none: too noisy                |
| exact      | 3   | 23    | 0               | **notice**                     |
| exact      | 4   | 6     | 0               | **dialog / escalation**        |
| exact      | 5   | 0     | n/a             | **refusal of the 5th attempt** |
| same-error | 3   | 40    | 5 (12.5 %)      | none: too noisy                |
| same-error | 4   | 13    | 0               | **notice**                     |
| same-error | 5   | 3     | 0               | **dialog / escalation**        |

- **The refusal rung has no measured trip.** No exact run reached 5 here, so its false-positive
  rate is unmeasured, not zero. It is chosen because the call it refuses has already failed
  identically four times, with a notice twice.
- **The abort cap ("two refused repeats") is a structural choice, not a measurement:** the corpus
  holds no refused repeat. It is stated as such and is OQ-3.
- **Run length distribution (exact):** 2: 39 · 3: 17 · 4: 6 · ≥ 5: 0. **Same-error:** 2: 81 · 3: 27
  · 4: 10 · 5: 2 · 6: 1.
- **Speed:** median gap between repeats 3.8 s (p90 15.1 s), so the dialog appears within seconds.

## 5. Action ladder (U-3)

### 5.1 The rungs

| Rung | Trigger                                            | Attended (§5.2)                                                                       | Unattended (§5.2)                                                  |
| ---- | -------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 1    | exact 3, or same-error 4                           | **notice** appended to the failing result                                             | same                                                               |
| 2    | exact 4, or same-error 5                           | notice, **dialog** (§5.3) and a native notification                                   | notice, a debug/transcript line, and **Harnu's escalation** (§5.4) |
| 3    | the next call with an exact entry at ≥ 4           | **`ask`** in `tool.check` with the reason: the person's own permission dialog decides | **`deny`** in `tool.check` with the reason                         |
| 4    | a 3rd refused attempt of the same entry, main loop | none: the person has the dialog's [Stop]                                              | **`$.turn.abort`**; Harnu's escalation already fired               |

**Rung 1 — the notice.** On the failing `tool_result` the hook appends, to its content:

```text
[retry-breaker] This exact <Tool> call has now failed <n> times with the same error. Repeating it unchanged will fail again: change the input, check the cause, or stop and say what blocks you.
```

(the same-error wording says "across different inputs" and "the cause is likely outside the
input"). It is part of the result, so the model reads it in the next request and the transcript
keeps it (proven, run 3: the model quoted it verbatim). In runs 4 and 7 the model stopped after the
notice or the first refusal even when told to continue.

**Rung 2.** See §5.3 (attended) and §5.4 (unattended).

**Rung 3 — the refusal.** `tool.check` first awaits the engine's verdict (`next(e)`, `T:3957-3969`);
an engine `deny` is returned unchanged. Otherwise, if the call's exact entry has reached 4, it
answers `{ decision: 'ask' | 'deny', reason }`. The reason names the count, the last error's head,
and how to lift it:

```text
retry-breaker: this exact Read call already failed 4 times with the same error ("File does not exist. …"). Change the call or the cause first. The person can lift this with /retry-breaker reset.
```

The model reads a deny as `Permission to use <Tool> denied by plugin retry-breaker: <reason>`
(proven, run 3; T389 smoke B1.2). A same-error entry is never refused: its inputs differ, so there
is no identical call to refuse.

**Rung 4 — the abort.** `$.turn.abort({ turnId })` with the id `turn.start` handed the mod
(`T:2918-2931`, `T:13381`); proven in run 9 (`$.turn.abort (retry-breaker): cancelled turn …`). Only
the main loop's turn is aborted: a subagent's storm is refused, never aborted, because the abort
would end the parent turn and every sibling (§6.3).

### 5.2 Attended or unattended

| Signal                                                    | Source                                                                                                                            | Reads as                                                   |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `isInteractive: false` at `session.start`                 | `T:11682-11685` (`-p`, the SDK)                                                                                                   | unattended                                                 |
| `HARNU_SESSION_ROLE=agent` or `tick`                      | **new**: Harnu sets it on the spawned process from the companion's trust class (`spawn-inject.ts:111-120`, `session-table.ts:29`) | unattended                                                 |
| `HARNU_SESSION_ROLE=operator`, or absent, and interactive | the operator's session, or any session outside Harnu                                                                              | attended                                                   |
| a subagent's loop (`agentId` present)                     | `T:10586-10593`                                                                                                                   | never opens the dialog; rung 3 answers as its session does |

`HARNU_SESSION_ROLE` is new because no fact in the session tells an agent-spawned session from the
operator's today: the trust class lives only on Harnu's side, and the mod sees only the opaque
`HARNU_SPAWN_TOKEN` (`spawn-inject.ts:131-141`). An env var is the smallest carrier: Harnu already
sets the spawn env (`pty.ts:875-890`) and `$.env.get` takes a literal (`T:3590-3598`). The value is a
hint, not a credential: the worst a forged `operator` does is show a dialog nobody sees, and a forged
`agent` only makes the breaker stricter.

**An interactive session with nobody at it.** An operator may leave an interactive session running.
The dialog then sits unanswered; rung 3 still asks, and the person's own permission dialog (or the
Approval Inbox, §6.2) holds the call. Nothing runs unattended because the breaker guessed wrong.

### 5.3 The dialog (attended, main loop)

Opened with `$.ui.open({ id: 'retry-breaker', title: 'Retry storm', focus: true, closeOnEscape:
true, holdToasts: true })` (`T:2479-2497`, `T:7390-7440`), with a `$.ui.notify` beside it
(`T:2449-2466`). `focus` is a request: the surface grants it only when the prompt holds the keys
over an empty composer (`T:7407-7414`), so it never steals keystrokes from a person typing.

**What it shows.** The tool and the rule (`exact` / `same-error`); the count; up to the last four
failures **side by side**, one column each (`#n`, the error's first 160 characters), sized to
`e.props.bodyColumns`; the answer to "Ask why" once there is one.

**What it offers.**

| Button        | Hotkey | Does                                                                                                                                       |
| ------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Stop the turn | `s`    | `$.turn.abort` on the running turn, closes the dialog                                                                                      |
| Let it retry  | `r`    | mutes this entry for the session (R5), closes the dialog; rung 3 no longer fires for it                                                    |
| Ask why       | `w`    | `$.model.fork` (`R:163`): one tool-less question over the session's own transcript, "why, and what should change?", answered in the dialog |
| (Esc / close) |        | closes; counting goes on, so rung 3 still fires                                                                                            |

Proven in the kit on `terminal` and `desktop` (`03-prototype-tests.md` §1, the test "the dialog
shows the failures and 'Let it retry' lifts the refusal"). `$.ui.ask`
(`T:2416-2430`) was rejected: it shows 2–4 labels, no side-by-side errors, and rejects in `-p`.

### 5.4 Harnu's escalation (unattended)

Run in Harnu's main process, not in the mod (ADR-draft D3):

1. **Detector.** `src/main/detect/retry-storm.ts` runs the mod's `hooks/core.ts` (zero imports, so
   main can import it from `resources/retry-breaker/hooks/core.ts`) over the transcript tail Harnu
   already parses for `stall-detect.ts` (`claude-watcher.ts:512`, `transcript-truth.ts:389`). Same
   definition, same thresholds; the notice text is stripped before the error signature (§3.3).
2. **Scope.** Only sessions whose trust class is `agent` or `tick`. An operator's session gets the
   in-session dialog instead; escalating it too would notify the person about what is on their
   screen.
3. **Rung 2 → Activity notification**, through the same path the `notify` verb uses
   (`tool-handlers.ts:1220-1240`): title "Retry storm in <session>", description the tool, the count
   and the error's head, a deep link to the session.
4. **Rung 2 → mission blocker (optional, OQ-2).** When the session is linked to a step of an active
   mission, Harnu raises a blocker on that step with `owner: 'operator'` through the store function
   `mission_set_blocker`'s handler uses (`editMission`/`blockerTarget`, `tool-handlers.ts:4291-4323`):
   reason "Retry storm: <Tool> failed <n>× with the same error", unblocks "Look at the session, then
   clear this blocker". It clears it itself on a reset (R1–R3) of that entry. An operator-owned
   blocker chimes and re-nudges every 30 minutes (`docs/harnu-features.md`, Missions).
5. **A Scheduler tick's run.** A `-p` run the mod aborted ends with `subtype: "success"` and an
   empty `result` (run 9). The Scheduler's run record must read the escalation, not only the exit, or
   the tick looks clean (F-3).

**Why not from the mod.** `$.mcp.call('harnu', 'notify', …)` would be the obvious route, and it
fails everywhere it is needed: forbidden in the companion (SEC-9 (b), `00-master.md:502`), absent in
`create_session` agents (`pty.ts:252-262`, `:812-819`), and under "Ask before agent actions" a
mutation parks for 30 s and returns `{ status: 'pending' }` (`confirm-core.ts:37`,
`server.ts:1278-1290`), longer than a hook may hold (`T:5109`, 10 s). The T447 noun has the same
reach (`$.harnu.notify`, `missionBlockerSet`, T447 `01-contract.md:210-227`) and answers `NO_MCP`
there (T447 `00-spec.md:505-507`).

### 5.5 How the counter resets

R1–R6 in §3.6. The ledger lives in `$.state` (`retry-breaker.ledger`, `R:118`), so a hot reload
keeps it; the call/verdict maps that join `tool_use` to `tool_result` are module memory and are
lost on a reload, which drops at most the calls in flight (assumption A4).

## 6. No harm (U-4)

### 6.1 Never silent, never on its own judgment alone

- Every action the model sees carries its reason: the notice is text in the result; the refusal is a
  `tool.check` reason (`T:12866-12870`: "what the model reads on a deny and the dialog shows on an
  ask").
- The breaker never refuses a call the person is there to decide: attended, rung 3 is an `ask`.
- It never refuses a call that has not already failed identically four times, and never a call the
  same-error rule matched.
- It never refuses on its own failure: every gating hook's `.catch` passes the engine's verdict or
  the unmodified row through (§10.2).
- Every refusal names how to lift it (`/retry-breaker reset`, or the dialog's "Let it retry").

### 6.2 Permission prompts and the Approval Inbox

Order on one call, from the types and T389: `tool.call` hooks → classic `PreToolUse` (Harnu's
legacy approval bridge parks ≤ 3.5 s, `approval-resolver.ts:25`) → `tool.check` (`T:3957-3960`:
"after the `tool.call` and PreToolUse hooks and before the mode settles an ask") → the mode's decider
(the dialog, the classifier, a `classic.PermissionRequest` hook such as Harnu's bridge or the
companion's future P3W1 hold).

- **The breaker reads the verdict, it never loosens it.** An engine `deny` stays a deny; an `allow`
  may become `ask` (attended) or `deny` (unattended); nothing becomes `allow`.
- **A refused call is never a failure** (X1, X3, X4): a person's "no" in the dialog or an Inbox
  deny never feeds a count.
- **The breaker's `ask` goes where every ask goes.** In an interactive session that is the person's
  permission dialog, showing the reason. If the folder's Approval Inbox is active, Harnu's
  `PermissionRequest` bridge parks it there; the `PermissionRequest` input carries no reason field
  (`T:7507-7513`), so the Inbox row would show the call without saying why. Delta for P3W1: its
  `tool.check` recorder already sees `ask` verdicts with their `tool_use_id`
  (`P3W1-approval-hold.md:127-135`); it should keep the `reason` beside them so the Inbox row can
  print "retry-breaker: …" (assumption A2: the companion is outer to the breaker in the chain).
- **Permission modes.** `ask` "puts it to the mode's decider" (`T:12861-12864`). In `auto` that is
  the classifier and in `bypassPermissions` it may be no one; what the engine does with a hook's
  `ask` in each mode is unproven (A1). Until a spike proves it, the W1 mod answers `deny` instead of
  `ask` in `auto`, `bypassPermissions` and `dontAsk`, which are by definition modes nobody approves
  in. How the mod learns the mode is part of A1: the candidate is the classic hook envelope's
  `permission_mode` (`T:834`), which the companion already records as `permissionMode` in its state
  (`resources/companion/types/index.d.ts`).

### 6.3 Subagents, teammates and worktree isolation

- **Counted apart.** A subagent's calls count in its own loop (`agentId`), never with the parent's
  (kit; proven, run 5).
- **The notice reaches the subagent.** It is appended to the subagent's own result row (proven,
  run 5).
- **No dialog, no abort for a subagent.** Rung 2 logs a line; rung 3 refuses (or asks) the identical
  call inside the subagent's loop; rung 4 never fires, since `$.turn.abort` ends the parent's turn and
  every sibling with it. A subagent that keeps pushing a refused call gets more refusals, which cost
  no tool run.
- **Worktree isolation.** With the breaker's hooks loaded, a worktree-isolated agent's Bash ran in its
  own worktree (proven, run 8). That is the failure #92533 describes for a Bash `tool.call` hook.
- **Teammates:** one in a terminal pane of its own "runs no loop here" (`T:130-132`); the breaker counts them like a
  subagent when the teammate's loop runs in this process, and is simply another session's mod when
  it runs in its own.
- **Parallel identical calls** issued in one response count one by one as their results land
  (run 5: three `Read` calls in one response counted 1, 2, 3).

### 6.4 Cost on the hot path

`session.append` fires for every row (`T:4349`); the hooks do a constant-time hash and one
`$.state` read and write per tool-result row. A hook's budget is 10 s per dispatch and a `$` call in
flight does not count (`T:5100-5125`, `R:154`). No hook waits on the network or a person.

## 7. Engine grounding (C-1)

| Mechanism                                                             | Cited from                                          | Status                                      |
| --------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------- |
| `session.append`, doors `response` / `tool-result`, one id joins them | `T:4349-4359`, `T:10556-10594`, `R:137-141`         | **proven** (run 3)                          |
| rewriting a `tool_result`'s content                                   | `T:10627-10634`, `R:141`                            | **proven** (run 3)                          |
| the rewrite is what the transcript stores                             | `T:4352-4355`                                       | **proven** (run 3)                          |
| `agentId` on `session.append` and `tool.check`                        | `T:10586-10593`, `T:12833-12839`                    | **proven** (run 5)                          |
| `tool.check` verdict and `deny` with a reason                         | `T:3957-3969`, `T:12802`, `T:12855-12870`           | **proven** (run 3)                          |
| `tool.check` `ask` reaching the person's dialog                       | `T:12861-12870`                                     | doc (A1)                                    |
| headless `ask` comes back as an error result                          | none                                                | **proven** (run 1)                          |
| `turn.start` `turnId`, `$.turn.abort`                                 | `T:13374-13388`, `T:2918-2931`                      | **proven** (run 9)                          |
| `session.start` `isInteractive`                                       | `T:11671-11686`                                     | **proven** (every run: `interactive=false`) |
| worktree-isolated agents unharmed                                     | ADR-0018:121-127 (the hazard)                       | **proven** (run 8)                          |
| `$.ui.open` dialog options                                            | `T:2479-2497`, `T:7390-7440`                        | kit (§5.3)                                  |
| `Pane` props (`bodyColumns`)                                          | `T:10312-10356`                                     | kit                                         |
| `Button` `hotkey`, `onPress`                                          | `R:131-133`                                         | kit (press on `desktop`)                    |
| `$.ui.notify`, `$.ui.log`                                             | `T:2449-2466`, `T:2399-2414`                        | kit                                         |
| `$.model.fork`                                                        | `R:163`, `T:6855`                                   | doc (validate lists the call)               |
| `$.env.get` literal                                                   | `T:3590-3598`                                       | kit (`mock.env`)                            |
| `$.state` atoms, `update`                                             | `T:14701-14735`, `R:118`                            | kit                                         |
| `.catch` on gating hooks                                              | `R:79`, `T:3940`                                    | validate lists all three                    |
| hook budget                                                           | `T:5100-5125`, `R:154`                              | doc                                         |
| test kit: `test`, `mock.*`, `$.ui.mount`                              | `T:15921`, `T:15460-15480`, `T:15800-15835`, `R:81` | kit (10 pass)                               |

Not relied on: `classic.PostToolUseFailure` (`T:7851`), "never observed firing" in T389's smoke
(`01-contract.md:665`); `$.ui.notice` (never rendered, ADR-0018:115-116).

## 8. Relation to T389 and T447 (C-2)

Status checked against the code in this worktree.

| Wave / spec                   | Status                                                                         | Relation                                                                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADR-0018 D6, MOD-3, SEC-9 (d) | in force (`00-master.md:502`, `:524`)                                          | **builds on**: the reason the breaker has no `tool.call` hook                                                                                                    |
| P1W2 skeleton, staging        | shipped (`staging-core.ts:72-86`, `spawn-inject.ts`)                           | **extends**: the same `--plugin-dir` insertion stages a second bundled mod                                                                                       |
| P1W5 fleet state              | shipped (`resources/companion/hooks/lib/fleet-sensor.ts`)                      | **no overlap**: it tracks settled tools and "stuck" by timer; it ignores the failed flag and has no error text                                                   |
| P2W1 command channel          | shipped (6 commands, `turn.abort` among them)                                  | **not used**: host → mod only; the breaker aborts itself                                                                                                         |
| P2W5 MCP attribution          | planned                                                                        | **no overlap**: it owns the only allowed `tool.call` matcher (`mcp__harnu__*`)                                                                                   |
| P3W1 approval hold            | planned (insertion points only)                                                | **extends**: carry the `tool.check` reason into the Inbox row (§6.2)                                                                                             |
| P3W2 structured Sentinel      | planned                                                                        | **overlaps in seat, not in rule**: both deny through `tool.check`; the Sentinel is static and host-evaluated, the breaker is stateful and in-mod. No shared code |
| P4W1 Mods audit               | shipped (`mods-audit-core.ts`)                                                 | **extends**: discovery of a second staged dir, and a chip for `session.append` (§10.3)                                                                           |
| P4W2 terminal band            | planned                                                                        | **not used**: the band is absent inside Harnu (`P4W2…md:39-40`)                                                                                                  |
| P4W3 companion outside Harnu  | shipped (`external-install.ts`)                                                | **reuses the pattern**: the breaker's own "outside Harnu" switch writes `CLAUDE_CODE_PLUGIN_DIRS` (§9.3)                                                         |
| T175 `stall-detect.ts`        | shipped (`STAGNATION_WINDOW_MS` 5 min, `MIN_CALLS` 8, `stall-detect.ts:21-24`) | **complements**: it flags no new fingerprints with no mutation, success or failure alike; the breaker reads errors. Both feed the same transcript parse          |
| T447 `$.harnu` noun           | specified, not built (no `resources/harnu-sdk/`; PR #41 merged as docs)        | **not used**: its `notify`/`missionBlockerSet` ride `$.mcp.call` and answer `NO_MCP` in agent spawns (§5.4)                                                      |

What is new here: the detector, the ladder, the dialog, `HARNU_SESSION_ROLE`, the host twin, and the
two P3W1/P4W1 deltas. Nothing above is respecified.

## 9. Packaging (C-3)

### 9.1 Decision

**A mix** (ADR-draft D2, D3):

1. **A new bundled mod, `retry-breaker`**, source `resources/retry-breaker/` (the files in
   `02-prototype.md`). Harnu stages it beside the companion, as one more `--plugin-dir`, into
   operator, agent and tick sessions, through the companion's staging and gates (prefs, CLI version
   floor, mode not `off`, sideload block; `spawn-inject.ts:72-95`). It holds detection and every
   in-session action.
2. **Harnu main code** for the escalation: `src/main/detect/retry-storm.ts` running the mod's
   `hooks/core.ts` (§5.4), plus `HARNU_SESSION_ROLE` on the spawn env.

### 9.2 Why not elsewhere

- **Not inside the companion.** Its hook surface is closed and checked in (MOD-3,
  `api-surface.json`); it is meant to stay "small, readable" (ADR-0018:33-45); its outside-Harnu
  profile never enables `act.*`, `gate.guard` or `gate.sentinel` (`P4W3…md:200-203`), and a breaker
  outside Harnu is a gate and an actuator. A separate mod also gets its own row and switch in Settings → Mods.
- **Not host-only.** Harnu's host can see a storm but cannot put a sentence in the model's next
  request or refuse a call without the legacy `PreToolUse` bridge, whose 3.5 s park the companion
  work is retiring (`P3W1…md:310-313`).
- **Not in T447's noun.** Wrong reach (§5.4) and not built.

### 9.3 Outside Harnu

The mod has no Harnu dependency. A session started outside Harnu gets the whole in-session ladder
(notice, dialog, refusal, abort) and none of the escalation. Two ways to get it:

- `/plugin install retry-breaker --marketplace <owner>/<repo>` once it is published (`R:83-105`);
- a Settings → Mods "Also outside Harnu" switch, the P4W3 pattern, adding the staged dir to
  `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`.

Outside Harnu, `HARNU_SESSION_ROLE` is absent, so `isInteractive` alone decides.

## 10. Control and failure (C-4)

### 10.1 Switch and default

- **Harnu:** one setting, `retryBreaker: 'off' | 'notice' | 'enforce'`, global with a per-folder
  override, in the companion prefs file beside `companionActive` (`companion-prefs-core.ts:21-33`).
  `off` stages nothing; `notice` runs rungs 1–2; `enforce` adds rungs 3–4. **Default: `enforce`**
  (OQ-5): the refusal fires only on a call that already failed identically four times, and the
  unattended runs it protects have nobody else to stop them.
- **In the mod:** a `userConfig` field `level` with the same three values (`R:74`), so a standalone
  install has the switch too, and `/retry-breaker off | reset | status` for the running session.
- Toggling reaches **new** sessions; a running one keeps its staged mod (staging happens at spawn).

### 10.2 Failure: fail-open

Every gating hook carries `.catch(($, e, next) => next(e))` (`R:79`; validate lists all three,
`02-prototype.md` §7). A hook that throws, overruns or answers a wrong shape leaves the engine's
verdict on `tool.check` and the row unchanged on `session.append`. **Fail-closed is rejected:** a
broken breaker refusing calls would be exactly the harm U-4 forbids. The host twin fails the same
way: a parse error drops the escalation, never the session.

### 10.3 Settings → Mods audit chips

From `deriveCapabilities` (`mods-audit-core.ts:370-391`) and the hooks and calls validate reports
for the prototype:

| Chip          | Why it shows                        |
| ------------- | ----------------------------------- |
| `prompts`     | hooks `turn.start` (`:379`)         |
| `permissions` | hooks `tool.check` (`:382`)         |
| `model`       | calls `model.fork` (`:384`)         |
| `env`         | reads `HARNU_SESSION_ROLE` (`:388`) |
| `terminal`    | hooks `ui.render` (`:389`)          |

Not shown, and correct: `tool-calls` (no `tool.call`), `mcp`, `files`, `process`, `network`,
`other-mods`. **Gap:** nothing shows that it rewrites conversation rows: `session.append` maps to no
chip. Delta for P4W1: a `transcript` chip ("can change what the conversation stores") for any hook on
`session.append`, which the secret-scrubber ideas (2, 70) need as much. **Discovery gap:** the audit
knows one Harnu-staged dir (`companionDir`, `mods-audit.ts:618`); it must list every staged bundled
mod, or the breaker shows as unknown or not at all.

## 11. Prototype (C-5)

The hooks module, its contract and its tests are in [`02-prototype.md`](02-prototype.md) and
[`03-prototype-tests.md`](03-prototype-tests.md), with the real output of:

- `claude plugin validate`: passed, no warning;
- `claude plugin test`: 10 pass, 0 fail;
- `tsc -p` (TypeScript 5.9.3, the header's options): exit 0;
- nine live headless runs (§7).

The runs found three defects the kit could not: a headless `ask` counted as a failure (run 1), polls
counted under the same-error rule (a kit test), and the stored notice changing the
error signature the host twin would read (run 3). Each has a test now.

## 12. Implementation outline (C-6)

| Wave | Size | Depends on | Delivers                                                                                                                                                                                            |
| ---- | ---- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W0   | S    | none       | Spike: A1–A5 (§13) on the live CLI, including `ask` per permission mode and the companion/breaker nesting order                                                                                     |
| W1   | S    | W0         | `resources/retry-breaker/` (prototype hardened): `/retry-breaker`, `userConfig` `level`, mode-aware `ask`/`deny`, copy review; its kit tests in CI                                                  |
| W2   | M    | W1         | Staging of a second bundled mod (generalise `insertCompanionPluginDir` to a list), `HARNU_SESSION_ROLE`, the `retryBreaker` pref and its Settings control; Mods audit discovery of every staged dir |
| W3   | M    | W1         | Host twin: `detect/retry-storm.ts` over the transcript parse, Activity notification for `agent`/`tick`, the Scheduler run record reading it (F-3)                                                   |
| W4   | S    | W3         | Mission blocker raise/clear (if OQ-2 says yes)                                                                                                                                                      |
| W5   | S    | W2         | Mods audit `transcript` chip; P3W1 reason carry-through when P3W1 lands                                                                                                                             |
| W6   | S    | W1         | Marketplace publication and the "Also outside Harnu" switch                                                                                                                                         |

**Contracts the implementation owes:**

| Contract                               | Waves      | What                                                                                                                            |
| -------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `CHANGELOG.md`                         | W1–W6      | one user-facing entry per shipped wave                                                                                          |
| `docs/harnu-features.md` + marker bump | W1, W3, W4 | agents meet a new refusal text and notice, and Harnu raises blockers on their missions: they should read the reason, not retry  |
| `docs/user/`                           | W2, W3, W6 | a page for the breaker: what it does, the switch, the dialog, outside Harnu                                                     |
| `design.md` + `en.json` + `pt-BR.json` | W2, W5     | the Settings control and the audit chip are renderer UI; the mod's own dialog copy is English in the mod, as the companion's is |
| `docs/specs/T389-companion-mod/`       | W2, W5     | P1W2 staging list, P4W1 chip table, P3W1 reason field                                                                           |
| ADR                                    | merge      | `ADR-draft.md` numbered                                                                                                         |
| `tests/no-client-identifiers.test.ts`  | every wave | fixtures use the neutral vocabulary                                                                                             |

## 13. Assumptions the W0 spike must check

| Id  | Assumption                                                                                                                                      | Why it matters                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| A1  | A hook's `ask` reaches the person's dialog with its `reason` in `default`/`acceptEdits`; what it does in `auto`, `bypassPermissions`, `dontAsk` | rung 3 attended; §6.2's mode rule |
| A2  | The companion (first `--plugin-dir`) sits outside the breaker in the `tool.check` chain, so it sees the breaker's verdict                       | P3W1 reason carry-through         |
| A3  | `session.append` and `tool.check` hooks do not reproduce #92533 in an **interactive** session (run 8 was `-p`)                                  | the whole observe/refuse design   |
| A4  | Losing the module-memory call map on a hot reload only drops the calls in flight                                                                | §5.5                              |
| A5  | `HARNU_SESSION_ROLE` set on the PTY env is visible to `$.env.get` in the hooks environment                                                      | §5.2                              |
| A6  | The engine's refusal texts in X1–X3 are stable across the CLI range Harnu supports (they are matched as text)                                   | X1, X3                            |

## 14. Open questions (C-7)

| Id   | Question                                                                                                                                                                                                              | Who decides  |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| OQ-1 | Build it at all, given §4: storms are rare and short here and the measured saving is 6 calls in 112,674. The value left is unattended insurance and early sight of systemic causes. W1 alone (S) is the cheap version | operator     |
| OQ-2 | Should the host twin raise a mission blocker, or only a notification? A blocker chimes every 30 minutes until cleared                                                                                                 | operator     |
| OQ-3 | The abort cap: two refused repeats is unmeasured. Keep it, raise it, or never abort and only refuse?                                                                                                                  | operator     |
| OQ-4 | Is the polling list (X5) right for the operator's tools, and should it be user-editable from Settings rather than only `userConfig`?                                                                                  | operator     |
| OQ-5 | Default level `enforce` or `notice`?                                                                                                                                                                                  | operator     |
| OQ-6 | Should the same-error rule ever refuse (for example after 6), given E4-type storms ("Do not retry") never have an identical call to refuse?                                                                           | operator     |
| OQ-7 | Fix F-1 at its source (the `notify_when_idle` guidance) in this wave's scope or as its own card?                                                                                                                      | orchestrator |
| OQ-8 | Should the host twin also mark an operator's session row ("retrying") in the fleet view, though the dialog is already on their screen?                                                                                | operator     |

## 15. Findings outside the AC list

- **F-1 — Harnu's own guidance causes most storms here.** 21 of the 23 exact runs ≥ 3 (and 39 of 62
  runs ≥ 2) are `SendMessage` with `"message": }`, unparseable JSON, sent while subscribing to a
  peer's idle notice. `docs/harnu-features.md:347` says to subscribe "with `SendMessage { to: <name>,
notify_when_idle: true }` and no message", and the model renders "no message" as an empty value.
  Fixing the sentence (for example "omit the `message` key entirely" or pass `message: ""` if the tool
  accepts it) likely removes most of what the breaker would catch on this machine.
- **F-2 — the operator's Bash rewrite hook trips the worktree guard.** Runs 6 and the corpus group
  "this agent is isolated in the worktree …, but this command runs rtk …" show a user-level
  `PreToolUse` rewrite making Claude Code refuse git commands in worktree agents. Not Harnu's code,
  but a storm source on this machine.
- **F-3 — an aborted `-p` run reads as success.** `subtype: "success"`, `result: ""` (run 9). Any
  Harnu consumer of a tick's result should treat an empty result as "ended early", not "clean".
- **F-4 — the Mods audit has no chip for `session.append`** (§10.3).
