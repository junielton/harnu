# T455 — W0 spike findings (spec §11, §12 W0)

**Status:** measured, revised after verification round 1 · **Date:** 2026-10-13 · **Card:** T468
(T455 wave W0) · **Engine:** Claude Code **2.1.296** (the installed CLI, the same build the spec's
runs used) · **Harnu:** the installed AppImage, reporting **0.3.47**.

That build is **main-based, not proven**. The AppImage file's mtime (13:58 local) is two minutes
after `origin/main`'s head (`c73c5a6`, 13:56). But `package.json` at `c73c5a6` says 0.3.46, and
there is no v0.3.47 release, so the exact source commit is not known.

This file checks, against the real engine and recorded transcripts, the ten assumptions of spec §11,
and re-runs the cost baseline of [`02-cost.md`](02-cost.md) §8.6. Every verdict carries the command
that produced it, the numbers it printed, and when and on how large a corpus they were taken. The
local corpus grows by the minute.

Scripts are in [`w0/`](w0/). Raw logs, probe output and copied transcripts stayed in the session
scratchpad and are not committed. Everything below is counts and aggregates; no prompt or transcript
text is quoted.

**Round 2** answers the round-1 verification. It reworks A-P1, Q6 and M3 (§3), and A-M1 / M4 with
attr.py-unit attribution (§4). It re-runs A-E2 with the probe logging before `next()` (§2.2), dates
every corpus number, and adds four probe runs (3–7) and a limitations paragraph (§1.1).

## 0. Verdicts

| Id   | Verdict       | One-line evidence                                                                                                                                                                                         | Breaks                                 |
| ---- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| A-E1 | **partly**    | same doors and order; 186 of 191 appended uuids are rows of the JSONL. The 5 missing are all `hook-context`/`hook_success`, one per Bash call. After `/clear`, 3 command rows are stored out of order     | §5.3 `lastUuid`, §7.3                  |
| A-E2 | **confirmed** | in 6 of 6 starts the `classic.SessionStart` handler **starts** first. But `session.start` enters before it finishes (same millisecond), so the two overlap. A `/clear` raised no `session.start`          | §6.1 step 3 (M8)                       |
| A-E3 | **confirmed** | after `/rename`, the next `classic.UserPromptSubmit.session_title` is the new title (2 of 2 runs)                                                                                                         | —                                      |
| A-T2 | **refuted**   | an `ai-title` line was in the JSONL before the next prompt in both runs; that prompt's `session_title` was `null` (2 of 2)                                                                                | §5.2 title row, §7.3 `title`           |
| A-E4 | **confirmed** | `/clear` → `session.end{reason:'clear'}` (old id) → `classic.SessionStart{source:'clear'}` with the new id and its exact `transcript_path`; no `session.start` (1 run)                                    | —                                      |
| A-E5 | **confirmed** | all 25 subagent rows carry `agentId`; the subagent's `Bash` `tool_use` carries it; 24 of 25 are rows of its own `subagents/agent-<id>.jsonl`, in order (1 subagent)                                       | —                                      |
| A-P1 | **confirmed** | machine-made prompt rows are common, and `isMeta` alone does not catch them (338 task-notification rows, 0 `isMeta`). An origin filter is required. But round 1's filter misses typed slash commands (§3) | §5.2 first/last prompt rows (M3a, M3b) |
| A-M1 | **refuted**   | `claude` reopens its own live transcript read-only after boot (3–5 times per conversation). Its O_APPEND opens raise `IN_OPEN` too, one per `IN_MODIFY`, so attr.py counts the writer itself as a reader  | 02-cost.md §8.2, §8.5; W6 gate (M4)    |
| A-H1 | **partly**    | 60 new sessions: at +0 ms all 52 interactive headers lack `cwd`, `gitBranch` and `entrypoint`; at +250 ms and +2 s all 60 match the settled header                                                        | §6.1 step 6, §6.6 (M5)                 |
| A-S1 | **refuted**   | the 256-call list disagrees with the reader at 6.3–7.6 % of turn ends. The cause is the reader's 512 KB byte window, not the cap. A windowed list matches the reader at **73,395 of 73,395** cuts         | §6.7 (M6)                              |

AC-5 (baseline re-run): the headline numbers reproduce as measured (§7). Pass-class opens per append
are 1.07–1.37 (spec 0.78–1.32), with a same-file gap p50 of 1.8–2.0 s, the 2 s slug-pass cadence.
But A-M1's attribution shows that 0.43–0.76 of each append's pass-class opens are the writer's own
O_APPEND opens. Harnu's own share is smaller than both baselines state (§4.3, M4).

**Q6: skip** machine-made prompts, **but keep typed slash commands** (door `command`, origin
`composer`). The CLI's `last-prompt` names them in about one line in eight. The divergence that
remains is named class by class in §3.4.

## 1. Setup

- **Scratch sessions.** `claude --model haiku --plugin-dir <scratch>/t455-probe` in a tmux pane,
  started under `env -i HOME PATH TERM LANG USER SHELL T455_PROBE_DIR=<scratch>/probe-out<n>`. That
  removes `HARNU_SPAWN_TOKEN`, `CLAUDE_CODE_PLUGIN_DIRS` and every `CLAUDE_*` variable of the parent
  session, so the Harnu mod stayed out. The user's own settings hooks still ran; they are the
  `hook-context` rows below.
- **The probe** is 03-prototype.md §P.4's, with these additions:
  - `origin` on every append;
  - the `tool_use` names of each row;
  - a length and FNV-1a hash of a prompt's text, never the text;
  - a sequence number and the mod clock on every entry;
  - **from run 3 on**, a `session.start:enter` entry logged **before** `next(e)`. The sequence number
    is taken at handler entry, before any `await`, so it orders handler starts (§2.2).

  It is committed, as used for runs 3–7, in [`w0/t455-probe/`](w0/t455-probe/).
  `claude plugin validate` passes on it.

| Run | Date (local)      | Traced                                        | What it did                                                                                                                     | `classic.SessionStart` | `session.start` | `UserPromptSubmit` | appends | `turn.complete` | `session.end` |
| --- | ----------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | --------------- | ------------------ | ------- | --------------- | ------------- |
| 1   | 2026-10-13, 20:03 | `strace -f -e trace=openat,open` (no `-tt`)   | Bash prompt; plain prompt; `/rename` + prompt; background Bash (task notification); Agent call; `/clear` + Bash prompt; `/exit` | 2                      | 1               | 8                  | 142     | 9               | 2             |
| 2   | 20:11             | `strace -f -tt` + `execve`, `clone*`          | Bash prompt; plain prompt; `/rename` + prompt; `/exit`                                                                          | 1                      | 1               | 3                  | 49      | 3               | 1             |
| 3   | 21:03             | `strace -f -tt` + `execve`, `clone*`; inotify | Bash prompt; custom `/hello world`; `/context`; 3-Bash prompt; a cross-session message; a prompt; `/exit`                       | 1                      | 1               | 5                  | 69      | 5               | 1             |
| 4   | 21:10             | —                                             | an agent team: the lead and one in-process teammate (both loaded the probe)                                                     | 2                      | 2               | 1                  | 61      | 3               | 2             |
| 5   | 21:13             | —                                             | `/loop 1m …` (fixed interval) until one re-fire                                                                                 | 1                      | 1               | 2                  | 38      | 2               | 1             |
| 6   | 21:17             | —                                             | `/loop …` (self-paced) until one re-fire                                                                                        | 1                      | 1               | 2                  | 41      | 2               | 1             |
| 7   | 21:23             | inotify only                                  | 3 prompts with 5 Bash calls; `/exit`                                                                                            | 1                      | 1               | 3                  | 62      | 3               | 1             |

Runs 1–2 are the round-1 runs (191 appends, the totals round 1 reported under "run 1"). Runs 3–7
are round 2.

### 1.1 Limitations

The engine verdicts rest on few, small sessions:

- 7 interactive scratch sessions on one machine, model haiku, one CLI build (2.1.296);
- 1 subagent, 1 `/clear`, 2 `/rename`, 1 teammate pair, 1 cross-session message;
- 1 fixed-interval and 1 self-paced `/loop`;
- the user's own settings hooks, which decide how many `hook_success` rows exist.

A behaviour seen "2 of 2" means exactly that, not "always". The corpus numbers (§3, §6) are one
user's transcripts on one machine, heavy on Harnu orchestration (peer messages, teammates, loops).

## 2. The interactive probe runs (AC-1)

### 2.1 A-E1 — doors, order and uuids

Command: `python3 w0/e1-order.py <scratch>/probe-out/probe-<n>.json`. It matches main-loop rows
against `<sid>.jsonl` and subagent rows against `<sid>/subagents/agent-<agentId>.jsonl`.

| Conversation           | Appended | Rows of the file | Same order | Not in the file                 | File rows never appended | Doors                                                                                              |
| ---------------------- | -------- | ---------------- | ---------- | ------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------- |
| run 1, before `/clear` | 83       | 81               | yes        | 2 × `hook-context/hook_success` | 0                        | hook-context 24, attachment 21, notice 14, response 10, prompt 8, tool-result 3, command 2, note 1 |
| run 1, its subagent    | 25       | 24               | yes        | 1 × `hook-context/hook_success` | 0                        | attachment 14, hook-context 5, response 2, tool-result 2, prompt 1, note 1                         |
| run 1, after `/clear`  | 34       | 33               | **no**     | 1 × `hook-context/hook_success` | 0                        | attachment 15, hook-context 7, command 6, response 2, notice 2, prompt 1, tool-result 1            |
| run 2                  | 49       | 48               | yes        | 1 × `hook-context/hook_success` | 0                        | attachment 17, hook-context 11, notice 6, response 5, command 5, prompt 3, tool-result 1, note 1   |
| **total**              | **191**  | **186**          |            | **5, all `hook_success`**       | **0**                    |                                                                                                    |

What the interactive runs add to the `-p` runs of 03-prototype.md §P.4:

- **The missing rows are tied to Bash calls.** Under `-p`, the one uuid not in the file was a
  `hook_success` appended before `session.start`. Interactively that boot row **is** stored (it is
  appended after `session.start`).
  - Instead, one `hook_success` per **Bash** call was appended and never written: 5 of 5 Bash calls
    in runs 1–2.
  - There were none for the `Agent` and `SubagentHandback` calls (0 of 2).
  - These rows come from the user's own hooks, so the count depends on the hook configuration.
  - Every row whose door is not `hook-context` was found in the file.
- **One reorder, at `/clear`.** The three `/clear` command rows (door `command`, under the new id)
  are appended **before** the new conversation's two SessionStart hook rows, but stored **after**
  them (file positions 7–9 after 5–6). Nothing else moved.
- **Boot differs.** `session.start` saw **0** loaded messages interactively (every interactive
  start), against 1 under `-p`.
- **One `response` row per block** holds (`tool_use` and `text`; haiku produced no thinking block
  here).
- **Never appended, as under `-p`:** `last-prompt`, `ai-title`, `custom-title`, `mode`,
  `permission-mode`, `atis-latch`, `bridge-session` and `file-history-snapshot` lines. They carry no
  uuid.

Event order of run 1's first turn, as the probe logged it (`seq door origin.kind type/name`):

```text
0  classic.SessionStart source=startup, session_id = transcript file name
1  session.start isInteractive=true, loadedMessages=0
2  hook-context hook attachment/hook_success
3  hook-context hook attachment/hook_additional_context
4  classic.UserPromptSubmit session_title=null
5  prompt composer user
6-18 attachment engine attachment/{environment, model, deferred_tools_delta, agent_listing_delta,
     mcp_instructions_delta, skill_listing, total_tokens_reminder, instructions, session_context,
     date, credential_org, remote_session_change, prompt_snapshot}
19 response model assistant [tool_use: Bash]
20-22 hook-context hook attachment/hook_success ×3   (#21 is never written)
23 tool-result tool user
24-25 attachment engine attachment/{prompt_snapshot, total_tokens_reminder}
26 response model assistant [text]
27-28 hook-context hook attachment/hook_success ×2
29 notice engine system/stop_hook_summary
30 turn.complete reason=answer
31 notice engine system/turn_duration
```

**Verdict: partly.** Doors and order match the `-p` runs, and every non-`hook-context` uuid is a row
of the file. Two exceptions remain: unwritten `hook_success` rows (5 of 191), and the `/clear`
reorder.

### 2.2 A-E2 — which handler starts first

**Round 1 could not prove the order.** Its probe logged `classic.SessionStart` before `next(e)` but
`session.start` after `await next(e)`, so the order of its entries did not show which handler
**started** first. In run 1, the one `/clear` raised `session.end{reason:'clear'}` then
`classic.SessionStart{source:'clear'}` and **no** `session.start`: 1 `session.start` for 2
`classic.SessionStart`.

**Round 2** logs a `session.start:enter` entry before `next(e)`. Its sequence number is taken at
handler entry, before any `await`. Over 6 interactive starts (runs 3–7, the teammate of run 4
included), every one showed the same thing:

| Start           | `classic.SessionStart` seq | `session.start:enter` seq | Mod clock, enter − classic | Pushed to the log first |
| --------------- | -------------------------- | ------------------------- | -------------------------- | ----------------------- |
| runs 3, 5, 6, 7 | **0**                      | 1                         | 0 ms                       | `session.start:enter`   |
| run 4, lead     | **0**                      | 1                         | 0 ms                       | `session.start:enter`   |
| run 4, teammate | **0**                      | 1                         | 1 ms                       | `session.start:enter`   |

- The `classic.SessionStart` handler **starts** first (it takes seq 0) in 6 of 6.
- `session.start`'s handler enters before the classic handler has returned. The classic handler
  had not even passed its first `await` (`$.clock.now()`), let alone called `next(e)`. So the
  engine does not wait for the `classic.SessionStart` chain before dispatching `session.start`;
  the two run concurrently.
- The orchestrator's grader re-ran with logging before `next()` on both hooks, headless and
  interactive, and saw classic first too.

**Verdict: confirmed** (start order), with a consequence the spec does not state. A step that
`classic.SessionStart` records **after** an `await` may not be visible yet to the `session.start`
step. That is the case for the transcript path that `session.snapshot.start` is to carry (§6.1
step 3). See M8.

### 2.3 A-E3 and A-T2 — what reaches `session_title`

| Run | `ai-title` line in the JSONL before the next prompt | Next `UserPromptSubmit.session_title` | `/rename X`, then a prompt: `session_title` |
| --- | --------------------------------------------------- | ------------------------------------- | ------------------------------------------- |
| 1   | yes (written twice during turn 1)                   | `null`                                | `X`                                         |
| 2   | yes (row 26, turn 1)                                | `null`                                | `X`                                         |

The custom title also crosses a `/clear`. The new conversation's `classic.SessionStart` carried the
renamed title, and its transcript opens with a `custom-title` line.

- **A-E3: confirmed** (2 of 2).
- **A-T2: refuted** (2 of 2). An AI-generated title did not reach `session_title` in either run, at
  the next prompt or later.

### 2.4 A-E4 — a live `/clear`

Run 1, after `/clear`:

1. `session.end{reason:'clear', sessionId:<old>}`;
2. `classic.SessionStart{source:'clear', session_id:<new>, transcript_path:<dir>/<new>.jsonl}`;
3. every later append reports `$.session.id() === <new>`, and its rows are in `<new>.jsonl`;
4. no `session.start`.

**Verdict: confirmed** (1 `/clear`).

### 2.5 A-E5 — a subagent's rows

The Agent call raised 25 appends with `agentId` set. One was the subagent's `Bash` `tool_use`
(`response`, `agentId` set). Its `turn.complete` also carried the `agentId`. 24 of the 25 are rows of
`subagents/agent-<agentId>.jsonl`, in order; the missing one is a `hook_success`, as in §2.1.

Two subagent-shaped rows also reach the **main** loop's `door: 'prompt'`:

- the subagent's own opening prompt: origin `coordinator`, **with** `agentId`;
- its hand-back to the parent: origin `peer`, `isMeta: true`, **without** `agentId`.

The main-loop rule (`agentId` absent, not `isMeta`) excludes both. **Verdict: confirmed** (1
subagent).

## 3. A-P1 and Q6 — which prompt rows the legacy twins name (AC-2)

### 3.1 What each kind of user row looks like to the engine (probe runs 1–7)

Every main-loop user row with text the probe saw, by door and `origin.kind`. Next to each: how the
JSONL stores it, and whether the CLI's own `last-prompt` line named it in that run. Rows of the
`attachment`, `hook-context`, `tool-result` and `response` doors are left out.

| Row                                                                                | Door       | `origin.kind`       | `isMeta` | Stored as                                                                    | Runs (count)  | `last-prompt` named it             |
| ---------------------------------------------------------------------------------- | ---------- | ------------------- | -------- | ---------------------------------------------------------------------------- | ------------- | ---------------------------------- |
| a typed prompt (Enter at the composer; an argv start prompt stores alike)          | `prompt`   | `composer`          | no       | `origin.kind: human`, `promptSource: typed`                                  | 1–4, 7 (16)   | yes                                |
| a typed slash command (`/hello world`, `/loop …`)                                  | `command`  | **`composer`**      | no       | `origin.kind: human`, no `promptSource`, `<command-name>` + `<command-args>` | 3, 5, 6 (3)   | **yes**: `/hello world`, `/loop …` |
| a note the engine adds (a command's expansion, a `/rename` notice)                 | `note`     | `engine`            | yes      | no origin, `isMeta`                                                          | 1–3, 5, 6 (7) | no                                 |
| a built-in command's `system/local_command` rows (`/context`, `/rename`, `/clear`) | `command`  | `engine`            | —        | `system` rows, not `user`                                                    | 1–3 (7)       | no                                 |
| `/clear`, `/exit` (caveat, command, stdout)                                        | `command`  | `unclassified`      | 1 of 3   | no origin                                                                    | 1–3, 7 (14)   | no (`/exit`, run 3)                |
| a task notification                                                                | `prompt`   | `task-notification` | **no**   | `origin.kind: task-notification`, `promptSource: system`                     | 1 (2)         | no                                 |
| a cross-session message (idle)                                                     | `prompt`   | `peer`              | yes      | `origin.kind: peer`, `promptSource: system`                                  | 3 (1)         | no                                 |
| a subagent's hand-back                                                             | `prompt`   | `peer`              | yes      | `origin.kind: peer`                                                          | 1 (1)         | —                                  |
| a subagent's opening prompt                                                        | `prompt`   | `coordinator`       | no       | in the subagent's file, with `agentId`                                       | 1 (1)         | —                                  |
| a fixed-interval `/loop` re-fire                                                   | `prompt`   | **`unclassified`**  | yes      | no origin, `scheduledTaskId`, plain text                                     | 5 (1)         | no (stayed on the typed `/loop`)   |
| a self-paced `/loop` re-fire                                                       | `command`  | **`unclassified`**  | no       | no origin, `scheduledTaskId`, `<command-name>/loop`                          | 6 (1)         | no line written before `/exit`     |
| a teammate's opening message (in the teammate's session)                           | **`note`** | `engine`            | no       | no origin, `teamName`, `<teammate-message …>`                                | 4 (1)         | no                                 |
| a teammate's reply (in the lead's session)                                         | **`note`** | `engine`            | no       | no origin, "Another Claude session sent a message: `<teammate-message …>`"   | 4 (1)         | **yes**                            |

Three facts round 1 missed:

- **Typed slash commands are the person's own prompts.** They come on door `command`, not `prompt`,
  with origin `composer`. A rule limited to door `prompt` can never produce them.
- **Teammate messages are not `coordinator`.** The class round 1 labelled "no origin, not meta
  (older transcripts)" is in fact current builds' unstamped rows. Its largest parts are teammate
  messages and replies, which arrive on door **`note`** with origin `engine` (§3.2). The CLI names a
  teammate **reply** in the lead's session.
- **No `/loop` re-fire reports `scheduled-trigger` on this build.** Both modes report
  `unclassified`. A self-paced re-fire arrives on the same door and origin as `/clear` and `/exit`.

### 3.2 The corpus: rows by class

Command: bundle [`w0/p1-prompts.ts`](w0/p1-prompts.ts) with esbuild, run `node <bundle> 400`. Taken
**2026-10-13 21:21 local**, corpus **10,866** top-level transcripts, sample = the 400 most recently
modified whose first `entrypoint` is `cli`. Row versions in the sample: 2.1.259–2.1.296.

A prompt row is a non-sidechain `user` row with text that is neither a tool result nor a compact
summary. Each is classed by its stored shape; the engine door per class is §3.1's.

| Class (stored shape)                                                      | Rows  | of which `isMeta` | Sessions | Engine door / origin (§3.1)    |
| ------------------------------------------------------------------------- | ----- | ----------------- | -------- | ------------------------------ |
| typed prompt (`human`, no command)                                        | 818   | 0                 | 282      | `prompt` / `composer`          |
| typed slash command (`human` + `<command-name>`)                          | 99    | 0                 | 81       | `command` / `composer`         |
| self-paced `/loop` re-fire (`scheduledTaskId` + command)                  | 89    | 0                 | 15       | `command` / `unclassified`     |
| fixed-interval `/loop` re-fire (`scheduledTaskId`, plain)                 | 12    | 12                | 5        | `prompt` / `unclassified`      |
| other unstamped slash command (e.g. `/clear`, `/exit`; rest unidentified) | 111   | 0                 | 92       | `command` / `unclassified`     |
| local command output / caveat                                             | 206   | 96                | 92       | `command` / `unclassified`     |
| `peer`                                                                    | 823   | 823               | 113      | `prompt` / `peer`              |
| `task-notification`                                                       | 338   | **0**             | 79       | `prompt` / `task-notification` |
| teammate reply (unstamped "Another Claude session sent a message…")       | 130   | 0                 | 6        | `note` / `engine`              |
| teammate opening message (unstamped `<teammate-message`)                  | 105   | 0                 | 51       | `note` / `engine`              |
| interrupt marker                                                          | 17    | 0                 | 12       | not observed                   |
| other `isMeta`, no origin (skill bodies, command expansions)              | 1,466 | 1,466             | 233      | `note` / `engine`              |
| other unstamped                                                           | 8     | 0                 | 5        | not observed                   |

All 130 unstamped "Another Claude session sent a message" rows contain `<teammate-message` (a
separate check over the 400 most recent `cli` transcripts, 2026-10-13 21:20 local).

**Verdict on A-P1: confirmed.** Prompt rows not typed by the person are frequent: peer messages in
113 of 400 sessions, task notifications in 79, teammate messages in 51. `isMeta` catches the peer
rows but none of the 338 task-notification rows. So an origin filter is required, as the
assumption's second branch says. Round 1's filter, however, was wrong in two ways:

- it dropped typed slash commands;
- it would treat teammate rows as unknown.

§3.3–§3.5 replace it.

### 3.3 `lastPrompt`: four candidate rules against the CLI's `last-prompt` line

Same command and sample (21:21, corpus 10,866). Every `last-prompt` line with text is a sample: **7,898
lines**. The CLI re-appends the line with unchanged text many times, so only **871** of them are a
change from the file's previous line. The distinct count is the honest unit; per-line counts are
given beside it.

A rule predicts the newest row it accepts before the line. A slash-command row's text is
`/name args`, which is how the CLI writes it. A line matches when its first 40 characters
(whitespace collapsed) are a prefix of the prediction.

| Rule (rows it accepts)                       | Lines matched (of 7,898) | **Distinct lines matched (of 871)** |
| -------------------------------------------- | ------------------------ | ----------------------------------- |
| R1, round 1's M3: typed prompts only         | 6,374 (80.7 %)           | 663 (76.1 %)                        |
| **R2: typed prompts + typed slash commands** | 6,818 (86.3 %)           | **730 (83.8 %)**                    |
| R3: R2 + teammate replies                    | 6,980 (88.4 %)           | 799 (91.7 %)                        |
| R4: R3 + self-paced `/loop` re-fires         | 7,546 (95.5 %)           | 827 (94.9 %)                        |

Under R1, 59 distinct lines (in 58 sessions) name a typed slash command when no typed prompt precedes
them at all; 9 more name one over an older typed prompt. That is the class the round-1 verifier
found. It is also where round 1's 1,246 "unmatched" lines went: the round-1 script never built the
`/name args` text, and with it the unmatched lines fall to 155 (37 distinct).

### 3.4 What R2 leaves divergent, class by class

The 141 distinct lines (16.2 %) where R2's prediction is not the CLI's line:

| Class the CLI's line names                                           | Distinct lines | Sessions (any line) | What it is                                                                                                              |
| -------------------------------------------------------------------- | -------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| a teammate reply (door `note`)                                       | 58             | 6                   | the lead's session shows the teammate's reply as its last prompt                                                        |
| unmatched                                                            | 37             | 19                  | the line's text is a prefix of no stored row: 3 start with an image placeholder; 34 others (the text was not inspected) |
| a self-paced `/loop` re-fire (door `command`, origin `unclassified`) | 28             | 11                  | the CLI shows each re-fire, R2 the person's last typed prompt                                                           |
| `peer`                                                               | 11             | 2                   | a cross-session message                                                                                                 |
| other unstamped                                                      | 4              | 3                   | not classified                                                                                                          |
| an older typed prompt over a newer typed slash command               | 3              | 12                  | the CLI did not move to the command                                                                                     |

Round 1 claimed that "what stays divergent is the CLI naming a `peer` message (0.5 %)". **That was
false.** Peer messages are 11 of 871 distinct lines (1.3 %). The divergence after R2 is 16.2 % of
distinct lines; after R4 it is 5.1 %.

### 3.5 `firstPrompt`: the rules against the legacy reader

Same command and sample (21:21, corpus 10,866). The twin is the **real reader**: the header from
`__scrapeHeaderWithStatForTests`, i.e. `firstRealPrompt` over the first non-sidechain `user` text,
with the 2 MiB head cap (`claude-reader.ts` 598–612). It does **not** filter on `isMeta` or origin,
and it resolves a slash command to its name. Each rule takes the first row it accepts, through the
same `firstRealPrompt`.

| The row the legacy reader took | Sessions (of 400) |
| ------------------------------ | ----------------- |
| a typed prompt                 | 257               |
| a typed slash command          | 64                |
| a teammate opening message     | 51                |
| an unstamped slash command     | 24                |
| `peer`                         | 1                 |
| other unstamped                | 1                 |
| none (empty)                   | 2                 |

| Rule                                                                       | Sessions matched  | Misses: the legacy took …                                                                 |
| -------------------------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------- |
| R1, round 1's M3                                                           | 259 (64.8 %)      | a typed slash command 64, a teammate message 51, an unstamped command 24, peer 1, other 1 |
| R2 (and R3, R4)                                                            | 323 (80.8 %)      | a teammate message 51, an unstamped command 24, peer 1, other 1                           |
| **F: mirror the reader (every class but `peer`, as P2W2 §7.7 skips peer)** | **399 (99.75 %)** | peer 1                                                                                    |

So `firstPrompt` needs its own rule. The legacy's first prompt is "the first user row with text",
whoever wrote it. That includes 51 teammate sessions (12.8 %) whose first prompt is the lead's
`<teammate-message>`, and 24 sessions that begin with an unstamped command. The `lastPrompt` filter
would blank those. In a new conversation the push sees every one of those rows: A-E1 found every
non-`hook-context` row appended, in store order.

### 3.6 Q6 recommendation (data-backed)

- **`lastPrompt`: skip machine-made prompts, keep typed slash commands (rule R2, M3a).** That
  matches the CLI on 83.8 % of distinct lines. Count the rest under named parity classes, not as
  unexplained divergence:
  - `E-TEAMMATE`: a teammate reply on door `note`, 6.7 %;
  - `E-SCHEDULED`: a self-paced `/loop` re-fire, 3.2 %;
  - `E-ORIGIN`: a peer message, 1.3 %;
  - `E-UNMATCHED`, 4.2 %;
  - residual, 0.8 %.

  Closing `E-TEAMMATE` and `E-SCHEDULED` as well (R4, 94.9 %) means keying on engine wording: the
  teammate envelope text, and the `/loop` command name on an `unclassified` command row. That is the
  same kind of anchor as P2W2's `stripPluginFrame`, and it would need the same L4 test. Recommend R2
  in W1 and measure in shadow; adopt R4's two anchors only if the `prompt` parity group cannot pass
  with the named classes. Whether a teammate reply or a loop re-fire _should_ read as "last prompt"
  is the operator's call (Q6). The legacy shows them.

- **`firstPrompt`: mirror the reader (rule F, M3b)**, 399 of 400. P2W2 §7.7's adjustments apply
  (skip `peer` and plugin-meta; strip a plugin frame).
- **Untested origins.** No row of these kinds was seen live or in the sample:
  - `bridge`;
  - `plugin`, with or without `asUser`;
  - `scheduled-trigger` (on 2.1.296 `/loop` reports `unclassified`);
  - `sdk`, `slack-ping`, `channel`, `auto-continuation`, `peer-send-message`, `projects-relay`,
    `observer`, `observer-activity`.

  M3a's defaults for them are stated, not measured (M3a below).

## 4. A-M1 — does `claude` read its own transcript after boot? (AC-3)

### 4.1 `fdattr.py`, as the card asks

It samples, every 10 ms, which processes hold a transcript open.

- Over 7,028 samples (300 s from 19:59, overlapping run 1's start) it saw, besides two Harnu
  instances, **one** `claude` process holding a transcript open (1 hit).
- Over 6,110 samples in the clean window of §7 it saw only Harnu main (7 hits on 6 files).

A 10 ms sampler sees a short open only by luck, so it cannot prove a negative.

### 4.2 `strace`, decisive

The scratch session is the tracer's own child, so `ptrace_scope = 1` allows it. Command:
`python3 w0/m1-strace.py <log>`.

- It parses both log forms. Run 1's log has no `-tt` and no `clone` calls, so its opens are
  "unattributed". Runs 2 and 3 attribute each open to a thread of the `claude` process or to a child
  process, through the `clone` flags.
- Every number below is regenerated by that script from the kept logs. Run 1's round-1 figure "29"
  counted one failed `O_EXCL` append-open.

| Conversation           | Successful O_APPEND opens of its own transcript | Read-only opens before the file existed (ENOENT) | **Successful read-only opens after the first write** | Reads per append-open | Opener                 |
| ---------------------- | ----------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------- | --------------------- | ---------------------- |
| run 1, before `/clear` | 28 (+1 failed)                                  | 2                                                | **4**                                                | 0.14                  | unattributed           |
| run 1, after `/clear`  | 14 (+2 failed at exit)                          | 0                                                | **5**                                                | 0.36                  | unattributed           |
| run 2                  | 21 (+2 failed)                                  | 2                                                | **3**                                                | 0.14                  | `claude`'s own threads |
| run 3                  | 25 (+1 failed)                                  | 2                                                | **5**                                                | 0.20                  | `claude`'s own threads |

In run 2 the reads came +0.30 s after the file was created (with the first prompt row), +0.06 s
after a `tool-result` append, and at `/exit`. No child process (hooks, git, the Bash tool) opened the
transcript in runs 2 and 3.

### 4.3 In attr.py's units: the writer is counted as a reader

attr.py counts `IN_OPEN` events per `IN_MODIFY` event. So the question is not only "does `claude`
read", but **which `IN_OPEN` events are `claude`'s**.

**Run 3: `strace -tt` plus inotify.** Run 3 recorded inotify on its project dir
(`w0/m1-inotify.py`) beside `strace -tt`. `m1-strace.py <log> --inotify <events.json>` matches each
`IN_OPEN` one-to-one to a `claude` open of the same file within 20 ms. It then classes each one
exactly as attr.py does: `tail` when the file's newest `IN_MODIFY` stamped at or before it is
≤ 50 ms old, else `pass`.

**Run 7: no strace.** Every write is one O_APPEND open followed by one write (run 3: 25 opens, 25
`IN_MODIFY`), so the writer's own open is the `IN_OPEN` just before each `IN_MODIFY`.
`w0/m1-appendopen.py` counts that signature. On run 3 it reproduces the strace attribution exactly.

| Per `IN_MODIFY` (attr.py's "per append") | Run 3 (strace; 25 appends, 67 `IN_OPEN`) | Run 7 (no strace; 23 appends, 61 `IN_OPEN`) |
| ---------------------------------------- | ---------------------------------------- | ------------------------------------------- |
| pass: `claude`'s own O_APPEND open       | **0.76**                                 | **0.43**                                    |
| pass: other processes (Harnu)            | 0.68                                     | 0.70 (may include `claude`'s reads)         |
| tail: `claude`'s own O_APPEND open       | 0.24                                     | 0.57                                        |
| tail: `claude`'s own read-only open      | 0.20                                     | not separable                               |
| tail: other processes (Harnu)            | 0.80                                     | 0.96 (may include `claude`'s reads)         |

- **The units agree one-to-one for appends:** one O_APPEND open per `IN_MODIFY`, 25 of 25.
- **The writer adds ≈ 1.0 `IN_OPEN` per append to attr.py's tail + pass,** plus its read-only
  reopens (0.14–0.36 per append in §4.2). How that 1.0 splits between tail and pass depends on
  whether the watcher reads the `IN_OPEN` before the write lands: 0.43–0.76 per append landed in
  **pass**.
- Harnu's own opens in these two quiet single-session runs were ≈ 0.7 pass and 0.8–1.0 tail per
  append.

**Verdict: refuted.** `claude` reopens its own transcript read-only after boot (12 such opens in runs
1–2, 5 in run 3). More importantly for the cost baseline, its writes raise `IN_OPEN` too. 02-cost.md
§8.2's caveat assumed the opposite, and its pass and tail ratios include the writer.

## 5. A-H1 — the one-file insert after a `stat` hit (AC-3)

Command:

```text
npx esbuild w0/h1-headers.ts --bundle --platform=node --format=cjs --outfile=<scratch>/h1.cjs
node <scratch>/h1.cjs 60 1500
```

Taken 2026-10-13, 20:24–20:30 local. It watches every project dir and runs the **real reader**
(`__scrapeHeaderWithStatForTests`, the path `scrapeJsonlHeaderCached` takes) on each new top-level
transcript at four delays:

- **+0 ms** is the earliest `stat` hit: the push can report the path before the file exists.
- **+250 ms** is the `add` path: chokidar's add, then the model's 250 ms debounce.
- **+2 s** is the latest regular `stat` hit.
- **+10 s** is the settled read.

50 interactive scratch sessions were spawned for it (5 in parallel, 10 rounds, one prompt each);
10 more appeared on their own while it ran.

| Read at | Sessions | Empty file | Null header | Sessions whose set-once fields differ from the settled read |
| ------- | -------- | ---------- | ----------- | ----------------------------------------------------------- |
| +0 ms   | 60       | 0          | 0           | **52**: `cwd` 52, `gitBranch` 52, `entrypoint` 52           |
| +250 ms | 60       | 0          | 0           | 0                                                           |
| +2 s    | 60       | 0          | 0           | 0                                                           |

- Settled entrypoints: `cli` 52, `sdk-cli` 8.
- The 52 that differ at +0 ms are exactly the 52 interactive (`cli`) sessions. An interactive
  transcript's first lines (`last-prompt`, `mode`, `permission-mode`, `bridge-session`) carry no
  `cwd`; the first line that does comes a few rows later. The 8 `-p` sessions were complete at once.
- `teamName` and `agentName` were empty in all 60 (no teammate sessions in the sample).

**Verdict: partly.** From +250 ms on, the insert sees exactly what the `add` path sees (60 of 60).
A `stat` hit within the first few milliseconds of the file's life sees a header with no `cwd`, no
`gitBranch` and no `entrypoint` (52 of 52 interactive sessions). §6.6 foresees the empty set-once
field and re-reads once. But §6.1 step 6 commits membership **at** the insert, so a row could be
committed with no `projectPath` (no folder) and no `entrypoint`, then patched. M5 makes the proof
wait for a header that has `cwd` instead.

## 6. A-S1 — the retained window against the reader (AC-4)

**Method.** Each transcript is replayed line by line, and the verdict is compared at three kinds of
cut point (`w0/s1-replay.ts`):

- `turn`: after every `system/turn_duration` line (the W6 gate's "owned turn end");
- `tool`: after every assistant line with a `tool_use`;
- `eof`: at the end of the file.

The two sides at each cut:

- **reader:** the real reader's incremental fold up to that byte (`__scrapeHeaderWithStatForTests`
  with a stat whose size is the cut). That is what a slug pass at that instant derives.
- **retained (spec §6.7):** every `tool_use` so far, capped at 256, scored by the real
  `deriveStagnation` with the window anchored on "the timestamp of the last entry". That phrase is
  read two ways:
  - **v1:** the newest entry that has a timestamp;
  - **v2:** the newest non-noise entry, with a zero verdict when it has none. This is what the reader
    does.

Two controls run beside it:

- an **uncapped** list;
- a **windowed** list: the M6 amendment. It holds the same calls, filtered by the reader's own tail
  rule: the last 800 non-noise entries below the 2 MiB head cap, else the entries starting in the
  last 512 KB.

Commands (taken **2026-10-13 21:25 local**, corpus **10,867** top-level transcripts, printed by
`s1-select.py`):

```text
python3 w0/s1-select.py recent 200 <scratch>/s1-recent.txt
python3 w0/s1-select.py largest 200 30 <scratch>/s1-largest.txt
npx esbuild w0/s1-replay.ts --bundle --platform=node --format=cjs --outfile=<scratch>/s1.cjs
node <scratch>/s1.cjs <scratch>/s1-recent.txt
node <scratch>/s1.cjs <scratch>/s1-largest.txt
```

**Corpus.** Two sets of 200, both of top-level `cli` transcripts with ≥ 8 `tool_use` blocks:

| Set                                        | Size p50 | Size p90 | Size max | Files over 2 MiB | Files with > 256 calls |
| ------------------------------------------ | -------- | -------- | -------- | ---------------- | ---------------------- |
| **recent**: the 200 most recently modified | 1.5 MB   | 6.3 MB   | 46 MB    | 76               | 17                     |
| **largest**: the 200 largest of 30 days    | 5.2 MB   | 12.4 MB  | 67 MB    | 200              | 55                     |

**Results** (mismatch = any of `stagnant`, `calls`, `distinct` differs):

| Set     | Cut  | Cuts   | Reader `stagnant` | v1 mismatch    | v2 mismatch     | uncapped mismatch | **windowed mismatch** |
| ------- | ---- | ------ | ----------------- | -------------- | --------------- | ----------------- | --------------------- |
| recent  | turn | 1,770  | 1                 | 112 (6.3 %)    | **112 (6.3 %)** | 112               | **0**                 |
| recent  | tool | 19,889 | 10                | 1,680 (8.4 %)  | 1,680 (8.4 %)   | 1,680             | **0**                 |
| recent  | eof  | 200    | 0                 | 167 (83.5 %)   | 0               | 0                 | **0**                 |
| largest | turn | 3,561  | 1                 | 271 (7.6 %)    | **271 (7.6 %)** | 271               | **0**                 |
| largest | tool | 47,775 | 43                | 5,493 (11.5 %) | 5,493 (11.5 %)  | 5,493             | **0**                 |
| largest | eof  | 200    | 0                 | 167 (83.5 %)   | 0               | 0                 | **0**                 |

Round 1's run of the same scripts (2026-10-13 ~20:23 local, corpus between 10,739 and 10,839) gave
the same picture: 6.5 % / 7.7 % at turn ends and 0 windowed mismatches in 72,807 cuts. The recent set
holds live transcripts, so its counts move between runs; the rates do not.

What the mismatches are:

- **They are all in files over 2 MiB.** Below the head cap, the reader's tail is the last 800
  entries, which covered the 5-minute window at every cut, and v2 matched every cut.
- **The cap is never the cause.** The uncapped list mismatches at exactly the same cuts. The reader's
  window held at most **125** calls in this corpus (101 in the recent set; the grader's sample peaked
  at 108). Those are corpus maxima, not a bound. The spec's "at most 40 `tool_use` in the 512 KB
  window" undercounts.
- **The cause is the reader's 512 KB byte window.** In a large transcript (big tool results),
  512 KB spans less than 5 minutes. The reader then sees fewer in-window calls and fewer prior
  fingerprints than the retained list. Wherever `calls` differed, the retained list counted
  **more**: 111/111, 1,671/1,671, 267/267 and 5,473/5,473, never fewer.
- **In this data the stuck dot would get stronger, not weaker.** Where `stagnant` differs, the
  retained list says `true`: 1 and 4 turn ends; 198 and 210 tool cuts, against a reader `stagnant`
  of 10 and 43 at those cuts.
  - This holds **in the data, not by construction**. A mutation inside the 5-minute window but before
    the reader's 512 KB window would make the reader say `stagnant` and the retained list not.
  - It was not observed in 73,395 cuts. W3's test should state it as an assumption, not rely on it.
  - The spec's worry (§6.7, "must not weaken") holds here, but its check ("must match") would fail at
    6.3–7.6 % of turn ends, so W6's gate could never pass.
- **v1 is wrong at rest.** 179 of 200 and 186 of 200 transcripts end in timestamp-less metadata lines
  (`last-prompt`, `mode`, …). The reader's verdict is then zero (§6.7 inherits this); only v2
  reproduces it.

**Verdict: refuted as written.** The 256-call list mismatches at 6.3 % (recent) and 7.6 % (largest)
of turn ends, and at 8.4 % / 11.5 % of tool cuts. The windowed list matches the reader at **0 of
73,395** cuts, so the fix is a definition change, not a bigger cap (M6).

## 7. The cost baseline re-run (AC-5)

`02-cost.md` §8.6's scripts, verbatim (extracted from the markdown blocks), against the running
Harnu: `attr.py 60` five times, then `sample.py <main> <renderer> 60`, with `fdattr.py 365` across
the whole span. Taken 2026-10-13, **20:35–20:41 local**. The corpus was 10,839 top-level transcripts
in 506 project dirs (`sample.py`). No scratch session was running.

### 7.1 Headline numbers next to the spec's

| Measure                                                     | Spec (02-cost.md run 5, 2026-10-09)     | W0 re-run (5 × 60 s, 256 appends)                                                                      |
| ----------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| tail opens per append                                       | 0.72–1.55 (713 total)                   | **1.25–1.51** (353 total)                                                                              |
| tail: open after append, p90                                | 2 ms                                    | **1–4 ms**                                                                                             |
| pass opens per append                                       | 0.78–1.32 (596 total)                   | **1.07–1.37** (307 total)                                                                              |
| pass: gap to the previous pass open of the same file, p50   | 1.7–2.1 s (**sweep-free** windows only) | **1.80–2.00 s** (**all five** windows, sweeps included); 1.99 and 2.00 s in the two sweep-free windows |
| pass share of live-transcript opens, sweep-free windows     | 45 % (445 of 995)                       | **47 %** (106 of 225, windows 2 and 5)                                                                 |
| first pass open after the last append (time to reopen), p50 | 258–565 ms                              | **252–378 ms**                                                                                         |
| first pass open after the last append, p90                  | 4.7–8.2 s                               | **4.8–6.0 s**                                                                                          |
| sweep opens                                                 | 243, in 2 of 5 windows                  | 65, in 3 of 5 windows                                                                                  |
| main CPU / renderer CPU (one 60 s window)                   | 7.2–17.6 % / 22.4–43.0 %                | 5.9 % / 13.5 %                                                                                         |

### 7.2 Per window

| Window | Live files | Appends | Tail (/append) | Pass (/append) | Sweep (/append) | Tail p50 / p90 / max (ms) | Pass after last append p50 / p90 (ms) | Pass gap p50 / p90 (ms) |
| ------ | ---------- | ------- | -------------- | -------------- | --------------- | ------------------------- | ------------------------------------- | ----------------------- |
| 1      | 8          | 89      | 120 (1.35)     | 99 (1.11)      | 32 (0.36)       | 0 / 1 / 7                 | 252 / 5,872                           | 2,000 / 7,805           |
| 2      | 5          | 43      | 63 (1.47)      | 59 (1.37)      | 0               | 0 / 1 / 33                | 256 / 5,396                           | 1,987 / 5,738           |
| 3      | 8          | 44      | 55 (1.25)      | 47 (1.07)      | 22 (0.50)       | 0 / 4 / 6                 | 260 / 4,841                           | 1,801 / 7,641           |
| 4      | 7          | 43      | 59 (1.37)      | 55 (1.28)      | 11 (0.26)       | 0 / 4 / 49                | 378 / 5,420                           | 1,999 / 12,066          |
| 5      | 5          | 37      | 56 (1.51)      | 47 (1.27)      | 0               | 0 / 1 / 18                | 254 / 6,010                           | 2,001 / 6,258           |

`fdattr.py` (6,110 samples) saw only Harnu main holding a transcript (7 hits, 6 files).
`sample.py`: main 5.87 % CPU, renderer 13.54 %, main `rchar` 26.3 MiB/s, 3,269 read syscalls/s.

**Reading.** As measured, every headline holds. The pass class is ≈ 1.1–1.4 opens per append, on the
2 s slug-pass cadence, and about half the live-transcript opens in sweep-free windows. The model lags
a live session's last append by a quarter-second at p50 and about 5 s at p90.

**But both baselines include the writer (§4.3).** Of each append's pass-class opens, 0.43–0.76 are
`claude`'s own O_APPEND opens, and its read-only reopens add to tail or pass. Harnu's own pass-class
reads are therefore smaller than 1.07–1.37 per append. In the two single-session runs of §4.3 they
were ≈ 0.7. This re-run cannot separate them, because attr.py records no pid.

### 7.3 A contaminated first run, kept as a warning for W6

The first attempt (2026-10-13 19:59–20:05 local, same scripts, corpus 10,739) overlapped a second
Harnu instance: another worktree's dev build, started with its own `--user-data-dir`. `fdattr.py`
saw it holding transcripts (6 hits) more often than the installed Harnu (2). In those windows:

- pass opens per append rose to 1.53–2.15;
- the pass gap p50 fell to **251–252 ms**, against 2 s in every clean window.

The 250 ms gap equals `DEBOUNCE_MS` (`fleet-model.ts:63`, the membership debounce). The code the
second instance ran was not checked, so the 250 ms gaps are **consistent with** a second reader, not
proven to be caused by it. **attr.py cannot tell two Harnu instances apart.** The W6 performance gate
must check that only one Harnu main is running (or attribute with `fdattr.py`) before it trusts a
window.

## 8. Amendments proposed (AC-6)

Proposals only. `00-spec.md` is not edited here; the orchestrator decides.

| #   | From     | Spec section                                                     | Proposed change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | -------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | A-E1     | §5.3 `lastUuid`; §7.3 alignment                                  | Fold `lastUuid` only from rows whose door is not `hook-context`. A `hook_success` row can be appended and never written (here, one per Bash call, 5 of 5; none for Agent calls; the count depends on the user's own hooks), while every other row was found in the file (186/186). The parity aligner treats a `lastUuid` absent from the file as "not yet aligned", never as a divergence. §4's row "25/26 uuids in the JSONL" becomes "every non-`hook-context` uuid; `/clear` stores its 3 command rows after the new conversation's hook rows".                                                                                                                                                                                                                                                                                                                                                                                      |
| M2  | A-T2     | §5.2 `title` row; §7.3 `title` group                             | `session_title` carried only a **custom** title (`/rename`, `--name`, and one carried across `/clear`). An `ai-title` did not reach it in 2 of 2 runs. Compare the pushed `title` against `customTitle` alone; `E-AITITLE` stops being a divergence class, and the AI title stays a tail-only fact. Nothing gates on it, so no partition change follows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| M3a | A-P1, Q6 | §5.2 "last prompt" row; §7.3 `prompt` group                      | `lastPrompt` = the newest main-loop row (`agentId` absent) that is either<br>(1) `door: 'prompt'`, not `isMeta`, `origin.kind` `composer` (+ `bridge`, untested), or<br>(2) `door: 'command'`, `origin.kind: 'composer'` (a typed slash command), its text built as `/name args` from `<command-name>` / `<command-args>`.<br>Plugin rows follow P2W2 §7.7 (`asUser` → the text; framed → `stripPluginFrame`), untested in W0. Every other origin is skipped (the untested ones in §3.6 by default).<br>Parity counts the rest under named classes: `E-TEAMMATE` (6.7 % of distinct lines), `E-SCHEDULED` (3.2 %), `E-ORIGIN` (1.3 %), `E-UNMATCHED` (4.2 %), residual 0.8 %. Measured 83.8 % of distinct lines (§3.3–§3.4).<br>Optional (R4, 94.9 %): also accept a `note`/`engine` row that is not `isMeta` and carries the teammate envelope, and a `command`/`unclassified` row whose command is `/loop`, both pinned by an L4 test. |
| M3b | A-P1     | §5.2 "first prompt" row                                          | `firstPrompt` gets its own rule, mirroring the legacy reader: the first main-loop row whose `message.type` is `user` with a text block, **any door and origin**, through `firstRealPrompt` (a slash command resolves to its name). The only exceptions are P2W2 §7.7's: skip `peer` and plugin-meta rows; `stripPluginFrame` a framed plugin row. Measured 399 of 400 sessions (§3.5); round 1's filter matched 259.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| M4  | A-M1     | 02-cost.md §8.2 caveats, §8.5 targets; W6 gate                   | Replace "assuming a `claude` process does not read its own transcript after boot" with the measured attribution (§4.3). The writer raises one `IN_OPEN` per append through its own O_APPEND open, 0.43–0.76 per append of it classed **pass**. It also reopens read-only, 0.14–0.36 per append. So §8.5's after-target "≈ 0 slug-pass opens" cannot be read off attr.py's pass class: that class has a **floor of ≈ 0.4–0.8 opens per append (plus any own reads classed pass) with no Harnu read at all**. The W6 gate subtracts the writer's own opens (`m1-appendopen.py`'s signature, or `strace` on a scratch session) before comparing, or states its target as that floor.                                                                                                                                                                                                                                                        |
| M5  | A-H1     | §6.1 step 6; §6.6 last row                                       | A `stat` hit proves the transcript only once its header has a `cwd`. If the header read finds no `cwd` (52/52 interactive sessions at +0 ms, 0/60 from +250 ms), the insert is deferred to the next `session.row` or the watcher's `add`, whichever comes first. So membership is never committed with an empty `projectPath`. The "re-read once if a set-once field is still empty" rule stays for `teamName` / `agentName`, which a teammate line may set later.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| M6  | A-S1     | §6.7 "What is retained"; "The cap"; W3 test                      | Retain each call with its line's byte offset and its non-noise entry ordinal. Score only the calls the reader's own tail rule keeps: the last 800 non-noise entries while the file is under the 2 MiB head cap, else the entries whose line starts in the last 512 KB (`claude-reader.ts` `tailEntriesOf`). Anchor on the newest non-noise entry's timestamp, zero when it has none ("v2"). **Count** the calls that rule keeps; above the 256 hard bound, log it and drop the session out of `patchApplied` (§6.8), so its slug pass resumes, instead of silently losing the match. 125 was this corpus's maximum, not a guarantee. Replace "at most 40 `tool_use`" with the measured maximum. Keep "retained ≥ reader" only as a stated test assumption (not observed false in 73,395 cuts; not true by construction).                                                                                                                 |
| M7  | AC-5     | §8 table; W6 gate (§7.3)                                         | The re-run's numbers (§7.1) can stand beside run 5's, with M4's correction. Add to the W6 performance gate: "exactly one Harnu main process during the measured windows (checked with `fdattr.py` or `pgrep`)".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| M8  | A-E2     | §6.1 step 3; W1 (`classic.SessionStart` / `session.start` steps) | The two handlers overlap: `session.start` entered before `classic.SessionStart`'s handler passed its first `await` (6 of 6 starts, same millisecond). The `classic.SessionStart` step therefore records `{source, transcriptPath}` synchronously at entry, before any `await`. Since it starts first (6 of 6), the value is then visible to the `session.start` step. Do not rely on that ordering alone: the host also accepts the path on a later `session.snapshot.start` / `session.rebound` if the first snapshot arrives without it.                                                                                                                                                                                                                                                                                                                                                                                               |

M6 was checked against the data, not only argued: its replay matched the reader at 73,395 of 73,395
cuts in 400 transcripts (§6). M3a, M3b, M4 and M5 rest on the counts above. M1, M2, M7 and M8 are
wording and ordering changes that match what was observed.

## 9. Reproducing

- **Probe:** `claude plugin validate w0/t455-probe`. Run it with
  `env -i HOME=$HOME PATH=$PATH TERM=xterm-256color T455_PROBE_DIR=<dir> claude --model haiku --plugin-dir w0/t455-probe`
  in a scratch directory. Optionally prefix
  `strace -f -qq -tt -e trace=openat,open,execve,clone,clone3,fork,vfork -o <log>`, and run
  `python3 w0/m1-inotify.py <project-dir> <events.json> <seconds>` beside it.
- **A-E1:** `python3 w0/e1-order.py <dir>/probe-<n>.json`.
- **A-M1:** `python3 w0/m1-strace.py <log> [--inotify <events.json>]` (both log forms);
  `python3 w0/m1-appendopen.py <events.json>` (no strace).
- **A-P1 / Q6:** bundle `w0/p1-prompts.ts` with esbuild, run `node … 400`. It replaces round 1's
  `p1-origin.py`, whose classes were mislabelled.
- **A-H1:** bundle `w0/h1-headers.ts` with esbuild, run `node … 60 1500`, then start new interactive
  sessions.
- **A-S1:** `w0/s1-select.py`, then bundle and run `w0/s1-replay.ts` (commands in §6).
- **AC-5:** the four scripts of 02-cost.md §8.6, unchanged.

The TypeScript scripts import the reader, `claude-reader-derive.ts`, `stall-detect.ts` and
`transcript-truth.ts` from `src/main/` directly, so a reader change is measured as shipped. Every
corpus script prints its date and the corpus size.

## 10. Acceptance map

| AC   | Where                    | Self-assessment                                                                                                                                                                                                                         |
| ---- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-1 | §1, §2                   | met: six verdicts from interactive probe runs (2 in round 1, 5 more in round 2); raw counts, order and doors pasted; A-E2 re-run with logging before `next()`                                                                           |
| AC-2 | §3                       | met in round 2: `origin.kind` (and door) of every probe prompt-like row in runs 1–7. Corpus measured against both legacy twins, with honest per-class divergence. Q6 answered with a rule per field (M3a, M3b); untested origins listed |
| AC-3 | §4, §5                   | met: A-M1 refuted (fdattr 13,138 samples; strace runs 1–3; inotify attribution runs 3 and 7, M4 restated as a range with its floor); A-H1 partly (60 new sessions; the card asked for 50)                                               |
| AC-4 | §6                       | met, with a deviation: 2 × 200 transcripts replayed through the real reader. The reader's window is "800 entries below 2 MiB, 512 KB above", not a flat 512 KB                                                                          |
| AC-5 | §7                       | met: §8.6 re-run on the main-based (not proven) build, headline numbers tabulated beside the spec's, with A-M1's correction                                                                                                             |
| AC-6 | §8; the checks in REPORT | every refuted or partly verdict names its section and an amendment; prettier, `tests/no-client-identifiers.test.ts`, the English gate and ESLint on `w0/` are run before commit                                                         |
