# T455 — W0 spike findings (spec §11, §12 W0)

**Status:** measured · **Date:** 2026-10-13 · **Card:** T468 (T455 wave W0) · **Engine:** Claude Code
**2.1.296** (the installed CLI, the same build the spec's runs used) · **Harnu:** the installed
AppImage **0.3.47**, built at 13:58 local time, two minutes after `origin/main`'s head (`c73c5a6`,
13:56), so it is the current main-based build.

This file checks, against the real engine and recorded transcripts, the ten assumptions of spec §11,
and re-runs the cost baseline of [`02-cost.md`](02-cost.md) §8.6. Every verdict carries the command
that produced it and the numbers it printed. Scripts are in [`w0/`](w0/). Raw logs, probe output and
copied transcripts stayed in the session scratchpad and are not committed. Everything below is counts
and aggregates; no prompt or transcript text is quoted.

## 0. Verdicts

| Id   | Verdict       | One-line evidence                                                                                                                                                                   | Breaks                       |
| ---- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| A-E1 | **partly**    | same doors and order; 186 of 191 appended uuids are rows of the JSONL. The 5 missing are all `hook-context`/`hook_success`. After `/clear`, 3 command rows are stored out of order  | §5.3 `lastUuid`, §7.3        |
| A-E2 | **confirmed** | `classic.SessionStart` came before `session.start` in both interactive starts; a `/clear` raised no `session.start` at all                                                          | —                            |
| A-E3 | **confirmed** | after `/rename`, the next `classic.UserPromptSubmit.session_title` is the new title (2 of 2 runs)                                                                                   | —                            |
| A-T2 | **refuted**   | an `ai-title` line was in the JSONL before the next prompt in both runs; that prompt's `session_title` was `null` (2 of 2)                                                          | §5.2 title row, §7.3 `title` |
| A-E4 | **confirmed** | `/clear` → `session.end{reason:'clear'}` (old id) → `classic.SessionStart{source:'clear'}` with the new id and its exact `transcript_path`; no `session.start`                      | —                            |
| A-E5 | **confirmed** | all 25 subagent rows carry `agentId`; the subagent's `Bash` `tool_use` carries it; 24 of 25 are rows of its own `subagents/agent-<id>.jsonl`, in order                              | —                            |
| A-P1 | **confirmed** | machine-origin prompt rows are common, and `isMeta` alone does not catch them: 376 task-notification rows, **0** `isMeta`. An origin filter is required                             | §5.2 prompt rows (amendment) |
| A-M1 | **refuted**   | `strace` of the interactive session: claude's own threads reopen its live transcript read-only after boot (3 times in run 2; run 1 saw 4 + 5 such opens, unattributed)              | 02-cost.md §8.2 caveats      |
| A-H1 | **partly**    | 60 new sessions: at +0 ms all 52 interactive headers lack `cwd`, `gitBranch` and `entrypoint`; at +250 ms and +2 s all 60 match the settled header                                  | §6.1 step 6, §6.6            |
| A-S1 | **refuted**   | the 256-call list disagrees with the reader at 6.5–7.7 % of turn ends. The cause is the reader's 512 KB byte window, not the cap. A windowed list matches **72,807 of 72,807** cuts | §6.7                         |

AC-5 (baseline re-run): the headline numbers reproduce (§7). Pass-class opens per append are
1.07–1.37 (spec 0.78–1.32); their same-file gap p50 is 1.8–2.0 s, the 2 s slug-pass cadence. A
first run in a window where a second Harnu instance was also reading the corpus is kept as a warning
for the W6 gate (§7.3).

Q6: **skip** machine-origin prompts. The data behind it is in §3.

## 1. Setup

- **Scratch session.** `claude --model haiku --plugin-dir <scratch>/t455-probe` in a tmux pane,
  started under `env -i HOME PATH TERM LANG USER SHELL T455_PROBE_DIR=<scratch>/probe-out`. That
  removes `HARNU_SPAWN_TOKEN`, `CLAUDE_CODE_PLUGIN_DIRS` and every `CLAUDE_*` variable of the parent
  session, so the Harnu mod stayed out. The user's own settings hooks still ran; they are the
  `hook-context` rows below.
- **The probe** is 03-prototype.md §P.4's, with four additions:
  - `origin` on every append;
  - the `tool_use` names of each row;
  - a length and FNV-1a hash of a prompt's text, never the text;
  - a sequence number and the mod clock on every append.

  It is committed as [`w0/t455-probe/`](w0/t455-probe/). `claude plugin validate` passes on it.

- **Run 1** (interactive, `strace -f -e trace=openat,open`):
  1. a prompt with one Bash call;
  2. a plain prompt;
  3. `/rename`, then a prompt;
  4. a background Bash task (a task notification follows);
  5. an Agent call (a subagent with one Bash call);
  6. `/clear`, then a prompt with one Bash call;
  7. `/exit`.

  That is 3 `classic.SessionStart`, 2 `session.start`, 11 `classic.UserPromptSubmit`, 191
  `session.append`, 12 `turn.complete` and 3 `session.end` events.

- **Run 2** (interactive, `strace -f -tt -e trace=openat,open,execve,clone,clone3,fork,vfork`): a
  prompt with one Bash call, a plain prompt, `/rename`, a prompt, `/exit`.

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

- **The missing rows are not only the boot row.** Under `-p`, the one uuid not in the file was a
  `hook_success` appended before `session.start`. Interactively that boot row **is** stored (it is
  appended after `session.start`). Instead, about one `hook_success` per tool call is appended and
  never written. Every row whose door is not `hook-context` was found in the file.
- **One reorder, at `/clear`.** The three `/clear` command rows (door `command`, under the new id)
  are appended **before** the new conversation's two SessionStart hook rows, but stored **after**
  them (file positions 7–9 after 5–6). Nothing else moved.
- **Boot differs.** `session.start` saw **0** loaded messages interactively (2 of 2), against 1
  under `-p`.
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

### 2.2 A-E2 — `classic.SessionStart` before `session.start`

Both interactive starts logged `classic.SessionStart` at seq 0 and `session.start` at seq 1. The
`/clear` in run 1 logged `session.end{reason:'clear'}` then `classic.SessionStart{source:'clear'}`,
and **no** `session.start` (2 `session.start` for 3 `classic.SessionStart` in the run).
**Verdict: confirmed.**

### 2.3 A-E3 and A-T2 — what reaches `session_title`

| Run | `ai-title` line in the JSONL before the next prompt | Next `UserPromptSubmit.session_title` | `/rename X`, then a prompt: `session_title` |
| --- | --------------------------------------------------- | ------------------------------------- | ------------------------------------------- |
| 1   | yes (written twice during turn 1)                   | `null`                                | `X`                                         |
| 2   | yes (row 26, turn 1)                                | `null`                                | `X`                                         |

The custom title also crosses a `/clear`. The new conversation's `classic.SessionStart` carried the
renamed title, and its transcript opens with a `custom-title` line.

- **A-E3: confirmed** (2 of 2).
- **A-T2: refuted** (2 of 2). An AI-generated title never reached `session_title`, at the next
  prompt or later in either run.

### 2.4 A-E4 — a live `/clear`

Run 1, after `/clear`:

1. `session.end{reason:'clear', sessionId:<old>}`;
2. `classic.SessionStart{source:'clear', session_id:<new>, transcript_path:<dir>/<new>.jsonl}`;
3. every later append reports `$.session.id() === <new>`, and its rows are in `<new>.jsonl`;
4. no `session.start`.

**Verdict: confirmed.**

### 2.5 A-E5 — a subagent's rows

The Agent call raised 25 appends with `agentId` set. One was the subagent's `Bash` `tool_use`
(`response`, `agentId` set). Its `turn.complete` also carried the `agentId`. 24 of the 25 are rows of
`subagents/agent-<agentId>.jsonl`, in order; the missing one is a `hook_success`, as in §2.1.

Two subagent-shaped rows also reach the **main** loop's `door: 'prompt'`:

- the subagent's own opening prompt: origin `coordinator`, **with** `agentId`;
- its hand-back to the parent: origin `peer`, `isMeta: true`, **without** `agentId`.

The spec's main-loop rule (`agentId` absent, not `isMeta`) excludes both. **Verdict: confirmed.**

## 3. A-P1 and Q6 — machine-origin prompts (AC-2)

### 3.1 In the probe runs

Every `door: 'prompt'` row of both runs, by `origin.kind` (command:
`python3 <scratch>/dump.py`, tallied):

| `origin.kind`       | Rows | `isMeta` | `agentId` |
| ------------------- | ---- | -------- | --------- |
| `composer`          | 9    | no       | no        |
| `task-notification` | 2    | **no**   | no        |
| `peer`              | 1    | yes      | no        |
| `coordinator`       | 1    | no       | yes       |

Slash commands arrive on `door: 'command'`, not `prompt`. `/clear` and `/exit` come with origin
`unclassified`, `/rename` with `engine`.

The JSONL stamps the same provenance on the stored row, so recorded transcripts can be tallied. The
mapping, matched by uuid:

| engine `origin.kind` | stored `origin.kind` | stored `promptSource` |
| -------------------- | -------------------- | --------------------- |
| `composer`           | `human`              | `typed`               |
| `task-notification`  | `task-notification`  | `system`              |
| `peer`               | `peer`               | `system`              |
| `coordinator`        | none                 | none                  |

### 3.2 In 400 recorded transcripts

Command: `python3 w0/p1-origin.py 400`. The input is the 400 most recently modified top-level
transcripts whose first `entrypoint` is `cli`. A prompt row is a `user` row that is not sidechain,
not a tool result and not a compact summary, and has text.

| Stored origin of the prompt row         | Rows  | of which `isMeta` | Sessions containing it |
| --------------------------------------- | ----- | ----------------- | ---------------------- |
| `human`                                 | 1,011 | 0                 | 328                    |
| `peer`                                  | 881   | **881**           | 128                    |
| `task-notification`                     | 376   | **0**             | 92                     |
| no origin, `isMeta` (skill / meta text) | 1,620 | 1,620             | 265                    |
| no origin, not meta (older transcripts) | 281   | 0                 | 79                     |
| no origin, slash-command wrapper        | 273   | 53                | 57                     |

Which prompt the CLI's own `last-prompt` line names (8,830 lines with text; 1,246 named text the
script could not find among the preceding rows and are left out):

| Named row's origin          | Lines | Share of the matched 7,584 |
| --------------------------- | ----- | -------------------------- |
| `human`                     | 7,370 | 97.2 %                     |
| no origin, not meta (older) | 126   | 1.7 %                      |
| `peer`                      | 81    | 1.1 %                      |
| slash-command wrapper       | 4     | 0.05 %                     |
| `task-notification`         | 3     | 0.04 %                     |

When the newest prompt row before a `last-prompt` line was machine-made:

| Newest row            | Line names an earlier row | Line names it |
| --------------------- | ------------------------- | ------------- |
| `task-notification`   | 227                       | **0**         |
| `isMeta`, no origin   | 3,104                     | **0**         |
| `peer`                | 1,537                     | 46 (2.9 %)    |
| slash-command wrapper | 8                         | 0             |

**Verdict: confirmed.** Prompt rows not typed by the person are frequent (peer messages in 32 % of
sessions, task notifications in 23 %). `isMeta` catches the peer rows but **none** of the 376
task-notification rows. So the first/last prompt rule needs an origin filter, as the assumption's
second branch says.

### 3.3 Q6 recommendation (data-backed)

**Skip machine-origin prompts.** The legacy twin is the CLI's `last-prompt` line (§5.2). It keeps the
previous typed prompt over a newer task notification in 227 of 227 cases, and over a newer peer
message in 1,537 of 1,583. The push matches it best with this rule for `firstPrompt` and
`lastPrompt`:

- `door === 'prompt'`;
- `agentId` absent;
- not `isMeta`;
- `origin.kind` in {`composer`, `bridge`}, plus `plugin` only when it was submitted `asUser`.

What stays divergent is the CLI naming a `peer` message (46 of the 1,583 peer-newest cases, 0.5 % of
all named lines). That is exactly parity's `E-ORIGIN` class, and it should be counted, not fixed.
Whether a `scheduled-trigger` (`/loop`) prompt should show is untested here (17 rows in the corpus
carry `scheduledTaskId`, too few to read the CLI's rule from). It falls under the same skip by
default.

## 4. A-M1 — does `claude` read its own transcript after boot? (AC-3)

**Method 1, as the card asks (`fdattr.py`).** It samples which processes hold a transcript open,
every 10 ms.

- Over 7,028 samples (300 s overlapping run 1's start) it saw, besides two Harnu instances, **one**
  `claude` process holding a transcript open (1 hit).
- Over 6,110 samples in the clean window of §7 it saw only Harnu main (7 hits on 6 files).

A 10 ms sampler sees a short open only by luck, so it cannot prove a negative.

**Method 2, decisive (`strace`).** The scratch session is the tracer's own child, so
`ptrace_scope = 1` allows it. Command:
`strace -f -qq -tt -e trace=openat,open,execve,clone,clone3,fork,vfork -o <log> claude …`, then
`python3 w0/m1-strace.py <log>`. The script attributes each open to a thread of the `claude` process
or to a child process, using the `clone` flags.

| Run                | Append opens of its own transcript | Read-only opens before the file existed (ENOENT) | **Read-only opens after the first write** | By                                     |
| ------------------ | ---------------------------------- | ------------------------------------------------ | ----------------------------------------- | -------------------------------------- |
| 2                  | 21 (+2 failed)                     | 2                                                | **3**                                     | `claude`'s own threads                 |
| 1, before `/clear` | 29                                 | 2                                                | **4**                                     | unattributed (run 1 traced opens only) |
| 1, after `/clear`  | 14 (+2 at exit)                    | 0                                                | **5**                                     | unattributed (run 1 traced opens only) |

Run 2's three reads, against the probe's clock:

| Read at    | Nearest event                                                   |
| ---------- | --------------------------------------------------------------- |
| +0.30 s    | the first prompt row (the file had been created 0.30 s earlier) |
| +0.06 s    | after a `tool-result` append                                    |
| at `/exit` | the exit's command rows                                         |

No child process (hooks, git, the Bash tool) opened the transcript in run 2.

**Verdict: refuted** (2 interactive runs: 3 reopens attributed to `claude`'s own threads in run 2, 9 more read-only opens of the live transcript by the traced tree in run 1). What it does to 02-cost.md: inotify
cannot tell these opens from Harnu's, so attr.py counts them as tail or pass opens. In run 2 there
are 3 own reads per 21 own append-opens, so they inflate Harnu's per-append ratios by at most
≈ 0.14. That is small next to the 1.1–1.5 measured, but the caveat in §8.2 ("assuming a `claude`
process does not read its own transcript after boot") is false and should be replaced (§8).

## 5. A-H1 — the one-file insert after a `stat` hit (AC-3)

Command:

```text
npx esbuild w0/h1-headers.ts --bundle --platform=node --format=cjs --outfile=<scratch>/h1.cjs
node <scratch>/h1.cjs 60 1500
```

It watches every project dir and runs the **real reader**
(`__scrapeHeaderWithStatForTests`, the path `scrapeJsonlHeaderCached` takes) on each new top-level
transcript at +0 ms, +250 ms, +2 s and +10 s (settled).

- **+0 ms** is the earliest `stat` hit: the push can report the path before the file exists.
- **+250 ms** is the `add` path: chokidar's add, then the model's 250 ms debounce.
- **+2 s** is the latest regular `stat` hit.

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
`gitBranch` and no `entrypoint` (52 of 52 interactive sessions). §6.6 foresees the empty
set-once field and re-reads once. But §6.1 step 6 commits membership **at** the insert, so a row
could be committed with no `projectPath` (no folder) and no `entrypoint`, then patched. The
amendment in §8 makes the proof wait for a header that has `cwd` instead.

## 6. A-S1 — the retained window against the reader (AC-4)

**Method.** Each transcript is replayed line by line. The verdict is compared at three kinds of cut
point (`w0/s1-replay.ts`):

- `turn`: after every `system/turn_duration` line (the W6 gate's "owned turn end");
- `tool`: after every assistant line with a `tool_use`;
- `eof`: at the end of the file.

At each cut, the two sides are:

- **reader:** the real reader's incremental fold up to that byte (`__scrapeHeaderWithStatForTests`
  with a stat whose size is the cut): what a slug pass at that instant derives.
- **retained (spec §6.7):** every `tool_use` so far, capped at 256, scored by the real
  `deriveStagnation` with the window anchored on "the timestamp of the last entry". That phrase is
  read two ways:
  - **v1:** the newest entry that has a timestamp;
  - **v2:** the newest non-noise entry, with a zero verdict when it has none. This is what the
    reader does.

Two controls run beside it: an **uncapped** list, and a **windowed** list. The windowed list is the
amendment of §8: the same calls, filtered by the reader's own tail rule, i.e. the last 800 non-noise
entries below the 2 MiB head cap, and the entries starting in the last 512 KB above it.

Commands:

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
| **recent**: the 200 most recently modified | 1.5 MB   | 6.3 MB   | 46 MB    | 70               | 17                     |
| **largest**: the 200 largest of 30 days    | 5.1 MB   | 12.4 MB  | 67 MB    | 200              | 55                     |

**Results** (mismatch = any of `stagnant`, `calls`, `distinct` differs):

| Set     | Cut  | Cuts   | Reader `stagnant` | v1 mismatch    | v2 mismatch     | uncapped mismatch | **windowed mismatch** |
| ------- | ---- | ------ | ----------------- | -------------- | --------------- | ----------------- | --------------------- |
| recent  | turn | 1,731  | 1                 | 113 (6.5 %)    | **113 (6.5 %)** | 113               | **0**                 |
| recent  | tool | 19,451 | 10                | 1,658 (8.5 %)  | 1,658 (8.5 %)   | 1,658             | **0**                 |
| recent  | eof  | 200    | 0                 | 164 (82 %)     | 0               | 0                 | **0**                 |
| largest | turn | 3,525  | 1                 | 271 (7.7 %)    | **271 (7.7 %)** | 271               | **0**                 |
| largest | tool | 47,700 | 43                | 5,484 (11.5 %) | 5,484 (11.5 %)  | 5,484             | **0**                 |
| largest | eof  | 200    | 0                 | 168 (84 %)     | 0               | 0                 | **0**                 |

The recent set holds live transcripts, so its cut counts moved by a few between runs (1,728 →
1,731). The rates did not.

What the mismatches are:

- **They are all in files over 2 MiB.** Below the head cap, the reader's tail is the last 800
  entries, which always covers the 5-minute window, and v2 matched every cut.
- **The cap is never the cause.** The uncapped list mismatches at exactly the same cuts. The largest
  reader window held **125** calls (101 in the recent set), so 256 is enough for the window.
  The spec's "at most 40 `tool_use` in the 512 KB window" undercounts that.
- **The cause is the reader's 512 KB byte window.** In a large transcript (big tool results),
  512 KB spans less than 5 minutes. The reader then sees fewer in-window calls and fewer prior
  fingerprints than the retained list. Wherever `calls` differs, the retained list counts **more**
  (112/112, 1,649/1,649, 267/267, 5,464/5,464; never fewer).
- **The stuck dot would get stronger, not weaker.** Where `stagnant` differs, it is always the
  retained list that says `true`: 1 and 4 turn ends; 198 and 210 tool cuts, against a reader
  `stagnant` of 10 and 43 at those cuts. The spec's worry (§6.7, "must not weaken") holds. But its
  check ("must match") would fail at 6.5–7.7 % of turn ends, so W6's gate could never pass.
- **v1 is wrong at rest.** 176 of 200 and 187 of 200 transcripts end in timestamp-less metadata lines
  (`last-prompt`, `mode`, …). The reader's verdict is then zero (§6.7 inherits this). Only v2
  reproduces it.

**Verdict: refuted as written.** The mismatch rate is 6.5 % (recent) and 7.7 % (largest) of turn
ends, and 8.5 % / 11.5 % of tool cuts. The windowed list matches the reader at **0 of 72,807** cuts
and holds ≤ 125 calls, so the fix is a definition change, not a bigger cap (§8).

## 7. The cost baseline re-run (AC-5)

`02-cost.md` §8.6's scripts, verbatim (extracted from the markdown blocks), against the running
Harnu: `attr.py 60` five times, then `sample.py <main> <renderer> 60`, with `fdattr.py 365` across
the whole span. 2026-10-13, 20:35–20:41 local time. No scratch session was running.

### 7.1 Headline numbers next to the spec's

| Measure                                                     | Spec (02-cost.md run 5, 2026-10-09) | W0 re-run (5 × 60 s, 256 appends)      |
| ----------------------------------------------------------- | ----------------------------------- | -------------------------------------- |
| tail opens per append                                       | 0.72–1.55 (713 total)               | **1.25–1.51** (353 total)              |
| tail: open after append, p90                                | 2 ms                                | **1–4 ms**                             |
| pass opens per append                                       | 0.78–1.32 (596 total)               | **1.07–1.37** (307 total)              |
| pass: gap to the previous pass open of the same file, p50   | 1.7–2.1 s (sweep-free windows)      | **1.80–2.00 s**                        |
| pass share of live-transcript opens, sweep-free windows     | 45 % (445 of 995)                   | **47 %** (106 of 225, windows 2 and 5) |
| first pass open after the last append (time to reopen), p50 | 258–565 ms                          | **252–378 ms**                         |
| first pass open after the last append, p90                  | 4.7–8.2 s                           | **4.8–6.0 s**                          |
| sweep opens                                                 | 243, in 2 of 5 windows              | 65, in 3 of 5 windows                  |
| main CPU / renderer CPU (one 60 s window)                   | 7.2–17.6 % / 22.4–43.0 %            | 5.9 % / 13.5 %                         |

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

**Reading.** Every headline holds. The pass class is still ≈ 1–1.4 opens per append, on the 2 s
slug-pass cadence, and still about half the live-transcript opens in sweep-free windows. The model
still lags a live session's last append by a quarter-second at p50 and about 5 s at p90. All counts
include up to ≈ 0.14 opens per append made by `claude` itself (§4).

### 7.3 A contaminated first run, kept as a warning for W6

The first attempt (19:59–20:05, same scripts) overlapped a second Harnu instance: another worktree's
dev build, started with its own `--user-data-dir`. `fdattr.py` saw it holding transcripts (6 hits)
more often than the installed Harnu (2). In those windows:

- pass opens per append rose to 1.53–2.15;
- the pass gap p50 fell to **251–252 ms**, against 2 s in every clean window.

`fleet-model.ts` still sets `APPEND_MIN_INTERVAL_MS = 2000`, so the 250 ms gaps are the second
reader, not a code change. **attr.py cannot tell two Harnu instances apart.** The W6 performance
gate must check that only one Harnu main is running (or attribute with `fdattr.py`) before it trusts
a window.

## 8. Amendments proposed (AC-6)

Proposals only. `00-spec.md` is not edited here; the orchestrator decides.

| #   | From | Spec section                         | Proposed change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ---- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | A-E1 | §5.3 `lastUuid`; §7.3 alignment      | Fold `lastUuid` only from rows whose door is not `hook-context`. Interactively about one `hook_success` per tool call is appended but never written, while every other row was found in the file (186/186). The parity aligner treats a `lastUuid` absent from the file as "not yet aligned", never as a divergence. §4's row "25/26 uuids in the JSONL" becomes "every non-`hook-context` uuid; `/clear` stores its 3 command rows after the new conversation's hook rows".                             |
| M2  | A-T2 | §5.2 `title` row; §7.3 `title` group | `session_title` carries only a **custom** title (`/rename`, `--name`, and one carried across `/clear`); an `ai-title` never reaches it (2 of 2 runs). Compare the pushed `title` against `customTitle` alone. `E-AITITLE` then stops being a divergence class, and the AI title stays a tail-only fact. Nothing gates on it, so no partition change follows.                                                                                                                                             |
| M3  | A-P1 | §5.2 first/last prompt rows          | Replace "`door: 'prompt'`, main loop, not `isMeta`" with "`door: 'prompt'`, `agentId` absent, not `isMeta`, `origin.kind ∈ {composer, bridge}` or `plugin` with `asUser`". Q6 is answered: skip (§3.3). Keep `E-ORIGIN` for the CLI naming a `peer` message (≈ 0.5 % of `last-prompt` lines).                                                                                                                                                                                                            |
| M4  | A-M1 | 02-cost.md §8.2 caveats              | Replace "assuming a `claude` process does not read its own transcript after boot" with "a `claude` process reopens its own transcript read-only a few times per session (3 per 21 append-opens measured, W0 §4). Those opens are counted as Harnu's, an over-count of ≤ ≈ 0.14 per append". The W6 gate compares before/after on the same basis, so its verdict is unaffected.                                                                                                                           |
| M5  | A-H1 | §6.1 step 6; §6.6 last row           | A `stat` hit proves the transcript only once its header has a `cwd`. If the header read finds no `cwd` (52/52 interactive sessions at +0 ms, 0/60 from +250 ms), the insert is deferred to the next `session.row` or the watcher's `add`, whichever comes first. So membership is never committed with an empty `projectPath`. The "re-read once if a set-once field is still empty" rule stays for `teamName` / `agentName`, which a teammate line may set later.                                       |
| M6  | A-S1 | §6.7 "What is retained"; "The cap"   | Retain each call with its line's byte offset and its non-noise entry ordinal, and score only the calls the reader's own tail rule keeps: the last 800 non-noise entries while the file is under the 2 MiB head cap, else the entries whose line starts in the last 512 KB (`claude-reader.ts` `tailEntriesOf`). Anchor on the newest non-noise entry's timestamp, zero when it has none ("v2"). Keep 256 as a hard bound (the window held ≤ 125). Replace "at most 40 `tool_use`" with the measured 125. |
| M7  | AC-5 | §8 table; W6 gate (§7.3)             | The re-run's numbers (§7.1) can stand beside run 5's. Add to the W6 performance gate: "exactly one Harnu main process during the measured windows (checked with `fdattr.py` or `pgrep`)".                                                                                                                                                                                                                                                                                                                |

M6 was checked against the data, not only argued: its replay matched the reader at 72,807 of 72,807
cuts in 400 transcripts (§6). M1, M3 and M5 rest on the counts above. M2 and M4 are wording changes
to match what was observed.

## 9. Reproducing

- **Probe:** `claude plugin validate w0/t455-probe`. Run it with
  `env -i HOME=$HOME PATH=$PATH TERM=xterm-256color T455_PROBE_DIR=<dir> claude --model haiku --plugin-dir w0/t455-probe`
  in a scratch directory; optionally prefix `strace -f -qq -tt -e trace=openat,open,execve,clone,clone3,fork,vfork -o <log>`.
- **A-E1:** `python3 w0/e1-order.py <dir>/probe-<n>.json`.
- **A-M1:** `python3 w0/m1-strace.py <log>` (needs the `-tt` form).
- **A-P1 / Q6:** `python3 w0/p1-origin.py 400`.
- **A-H1:** bundle `w0/h1-headers.ts` with esbuild, run `node … 60 1500`, then start new interactive
  sessions.
- **A-S1:** `w0/s1-select.py`, then bundle and run `w0/s1-replay.ts` (commands in §6).
- **AC-5:** the four scripts of 02-cost.md §8.6, unchanged.

The TypeScript scripts import the reader, `stall-detect.ts` and `transcript-truth.ts` from `src/main/`
directly, so a reader change is measured as shipped.

## 10. Acceptance map

| AC   | Where                    | Self-assessment                                                                                                                                                                               |
| ---- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-1 | §2                       | met: six verdicts from 2 interactive runs with the probe, raw counts, order and doors pasted                                                                                                  |
| AC-2 | §3                       | met: `origin.kind` tallied for every probe prompt row, plus 400 recorded transcripts; Q6 recommendation in §3.3                                                                               |
| AC-3 | §4, §5                   | met: A-M1 refuted (fdattr 13,138 samples + 2 strace runs); A-H1 partly (60 new sessions; the card asked for 50)                                                                               |
| AC-4 | §6                       | met in substance, with a deviation: 2 × 200 transcripts replayed. The reader's real window is "800 entries below 2 MiB, 512 KB above", not a flat 512 KB, and the replay uses the real reader |
| AC-5 | §7                       | met: §8.6 re-run on the main-based build, headline numbers tabulated beside the spec's                                                                                                        |
| AC-6 | §8; the checks in REPORT | every refuted or partly verdict names its section and an amendment; prettier and `tests/no-client-identifiers.test.ts` are run before commit                                                  |
