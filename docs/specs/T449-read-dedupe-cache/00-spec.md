# T449 — Read-dedupe cache: answer a re-Read of an unchanged file in-process

**Status:** specified (not implemented) · **Date:** 2026-10-09 · **Card:** T449 · **ADR:**
[`ADR-draft.md`](ADR-draft.md) (proposed; numbered when merged)

Files: this spec; [`01-measurement.md`](01-measurement.md) (U-4: the transcript scan, its method,
numbers and source); [`02-prototype.md`](02-prototype.md) (C-5: the hooks module, its tests, the
real `validate` / `test` / `tsc` output, and eleven live runs); [`ADR-draft.md`](ADR-draft.md) (the
packaging decision).

## 0. Summary

A **read-dedupe cache** is a Claude Code mod that remembers every `Read` a session made. When the
model asks for the same file and range again, the file has not changed, and the earlier result is
still in what the next model request carries, the mod answers the `tool.call` itself, without
calling `next`, with Read's own `file_unchanged` result and a one-line note pointing at the earlier
result. A status line shows the tokens it saved.

The design works; it is proven by a prototype and eleven live runs (`02-prototype.md`). The
measurement says it is **not worth building now**:

1. **Claude Code already has this feature, switched off.** The 2.1.295 and 2.1.296 `Read` tool
   carries its own unchanged-file dedupe (the `file_unchanged` result, types
   `claude-code.d.ts`:21025-21033), gated by the server-side flag `tengu_read_dedup_killswitch`.
   That flag is `true` on this machine, and not one of 10,209 Reads in the corpus came back
   `file_unchanged` (§4.1).
2. **Exact re-reads are rare here.** Over 55 days, 12,066 transcripts and 10,209 Reads, the cache
   would have answered **9** Reads and saved about **14 thousand tokens**: 0.08 % of the tokens
   Read results put into main-loop context (§4.2, `01-measurement.md` §3). Re-reading a file
   _after editing it_ costs twenty times more, and no dedupe can touch it.
3. **Correctness has to be checked, not argued.** The first prototype passed all its kit tests and
   never fired in a real session, because the request holds the earlier result normalised and with
   a reminder appended (§5.3). The final rule needs three independent checks per answer.

**Recommendation: no-go for now** (OQ-1). Keep the spec and the scanner; re-run the scanner when
the workload changes or if the engine's own dedupe stays off; build it (one S wave plus a spike)
only if a scan shows enough savings to justify a mod that rewrites what the model reads. If it is
built, it ships as a **standalone mod**, not inside the Harnu mod (§9, ADR-draft).

## 1. Origin and scope

Idea 8 of the operator's ideation report (`.harnu/out/claude-code-mods-ideas.md`, "Read-dedupe
cache"): track every `Read`/`Grep`, answer a re-read of an unchanged file "locally with 'unchanged
since turn 12 (see above)'", show "saved 4.1k tokens" in the status line; effort S. The report
ranks it second of "Ten I would build first" as "pure token savings … only possible in-process".

This spec decides: what "unchanged" means and when the mod may answer (U-1, §5); which tools it
covers (U-2, §6); the exact text the model gets and the escape (U-3, §7); the measured value and
the status line (U-4, §4, §8); packaging (C-3, §9); control and failure (C-4, §10); overlap with
T389 and T447 (C-2, §11); the implementation outline (C-6, §12); assumptions (§13) and open
questions (C-7, §14). §15 maps every AC to where it is met.

Out of scope: any change to `src/`, `resources/`, `tests/`, `docs/user/`, `CHANGELOG.md` or
`docs/harnu-features.md`. The prototype lives in the session scratchpad; its source is in
`02-prototype.md`.

## 2. Conventions

- `types:N` is a line of this build's declaration file, `claude-code.d.ts`, written by Claude Code
  **2.1.295** when the `plugin-authoring` skill loaded. `reference.md:N` is a line of that skill's
  `reference.md`. Repository paths are relative to the repo root.
- `bin:2.1.295` marks a fact read from the minified Claude Code bundle
  (`~/.local/share/claude/versions/2.1.295`): an observation of shipped code, with obfuscated
  names; it is evidence, not a contract.
- **Verified** means a command ran and its output is quoted (here or in an appendix). **Assumed**
  means inferred; every assumption is listed in §13 for the implementation's first spike.
- The CLI updated itself to **2.1.296** during the session. The live runs and the final
  `validate` and `test` runs used 2.1.296; the types and the bundle read are 2.1.295. §4.1 checks
  that the dedupe code is still present in 2.1.296.

## 3. The engine contract the design uses (C-1)

Every mechanism the mod relies on, where the engine declares it, and how it was shown to work.
"Live n" is run n of `02-prototype.md` §3; "kit" is the `claude plugin test` suite of
`02-prototype.md` §2.2, its tests numbered in file order (1 is the answered re-Read, 11 the
`enabled: false` case).

| Mechanism                                                                                                                                                                                               | Declared at                                                              | Shown by                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `on('tool.call', { tool: 'Read' }, …)`; answering `{ result }` in place of `next` runs no tool                                                                                                          | types:3943-3955 (`tool.call`: "`{ result }` answers in place of `next`") | Live 4: "answered tool.call without next() in 4.9ms; nothing beneath it ran"             |
| A hook's own `result` is validated against the tool's output schema and mapped by the tool's own mapper                                                                                                 | types:12719-12726                                                        | Live 4: the model read Read's own mapped text                                            |
| Read's `file_unchanged` result variant                                                                                                                                                                  | types:21025-21033                                                        | Live 4, kit test 1                                                                       |
| `context` on a result: "what the model reads after the tool's result"                                                                                                                                   | types:12728-12735                                                        | Live 4: stored as a `hook_additional_context` attachment, quoted by the model            |
| `text` (the result as the model reads it) and `ref` on what `next(e)` resolves to; returning that object makes core use it verbatim                                                                     | types:12736-12750                                                        | Live 1-4 (pass-through Reads unchanged)                                                  |
| Read's input: `file_path`, `offset`, `limit`, `pages`                                                                                                                                                   | types:16527-16536                                                        | Kit test 8 (a range is its own key)                                                      |
| Read's text result: `content`, `numLines`, `startLine`, `totalLines`, `truncatedByTokenCap`                                                                                                             | types:20942-20957                                                        | Live 3 trace (`content` sliced from disk hashed equal); kit test 6                       |
| `agentId` names the loop a `tool.call` runs in; absent on main                                                                                                                                          | types:186-204, 12656-12665                                               | Live 10                                                                                  |
| `$.session.messages({ as: 'api', agentId })`: "the ones the next request is built from, after the engine's normalization (the last compaction's summary in place of what it replaced …)", at most 4,096 | types:2739-2771, 631-655                                                 | Live 3 (holds the earlier result), live 8 (not after `/compact`), live 10 (a subagent's) |
| `$.session.id()`, `$.session.turns()`                                                                                                                                                                   | types:2788-2796                                                          | Live 4, 9                                                                                |
| `$.fs.stat` (`size`, `mtimeMs`) and `$.fs.read` (rejects past 4 MiB)                                                                                                                                    | types:3269-3321, 4985-5021, 3225-3243                                    | Live 3 trace; kit tests 2-3                                                              |
| `session.compact` (`trigger`, `agentId`; a `skip` result vetoes)                                                                                                                                        | types:4380-4383, 10791-10856                                             | Kit test 10; live 7                                                                      |
| `session.end`: `reason: 'clear'` ends the conversation, a new session id follows, no `session.start`                                                                                                    | types:4416-4427, 11041-11077                                             | Live 9                                                                                   |
| `$.ui.status(text)`: one pinned line per plugin under the prompt                                                                                                                                        | types:2466-2477                                                          | Kit test 1 (the line's text)                                                             |
| `$.state` through `atom` / `read` / `update`; values declared in the plugin's contract                                                                                                                  | types:14693-14735; reference.md:118                                      | `claude plugin validate`: "state writes / reads: read-dedupe.entries, read-dedupe.saved" |
| `userConfig` options, read by `register(on, options)`; a config-menu row, a change reloads the module                                                                                                   | types:7646-7658, 9301; reference.md:74                                   | Kit test 11 (`{ options: { enabled: false } }`)                                          |
| A hook that fails is skipped; `.catch(($, e, next) => next(e))` replays a settled `next` and never runs it twice                                                                                        | types:3936-3941; reference.md:78-79                                      | `validate`: "gating hook with .catch" for each gate                                      |
| Hook budget: 10 s of the hook's own time, `$` and `next` calls not counted; `.catch` grace 1 s                                                                                                          | types:5090-5124 (`ms: 10_000` at :5109, `catchMs: 1_000` at :5117)       | Live 4 and 11: 4.9 ms and 3.8 ms per answer                                              |
| Test kit: hooks the test registers sit beneath the plugin and stand for the engine; `mock.clock`; `test(name, { options }, body)`                                                                       | reference.md:81; types:15453                                             | `02-prototype.md` §2.2: 11 pass, 0 fail                                                  |
| Grep and Glob are not registered by a native macOS or Linux build                                                                                                                                       | reference.md:54-56                                                       | Not in this build's `BuiltinToolInputs` (types:15987-16812)                              |

## 4. What already exists, and what it would save

### 4.1 The engine's own Read dedupe, switched off

`Read` in Claude Code 2.1.295 already short-circuits an unchanged re-read (bin:2.1.295, the Read
tool's call path). In order:

1. It looks up the path in the session's `readFileState`.
2. The lookup is skipped when the flag `tengu_read_dedup_killswitch` is on, for a remote call, or
   when `dedupUnchangedReads` is false. A context getter sets the latter to false under a condition
   of the conversation and model (an obfuscated function; its meaning is not established here).
3. A prior entry answers only if it is not a partial view, not marked `contentNotInModelContext`,
   was made by a Read (not an Edit/Write), has the same `offset` and `limit`, and the file's
   `mtime` still equals the recorded timestamp. A separate branch answers a whole-file Read of a
   file the session was seeded with (CLAUDE.md, nested memory): `source: "seeded"` (types:21032).
4. Its answer is `{ type: "file_unchanged", file: { filePath } }`, which the model reads as
   `Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.`
   (live 4). The bundle holds a gentler variant beside it, which none of these runs received:
   "File unchanged since last read. The content from the earlier Read tool_result in this
   conversation is still current — refer to that instead of re-reading."

On this machine the flag is on: `~/.claude.json` caches `"tengu_read_dedup_killswitch": true`. The
2.1.296 bundle still carries the flag name, the `Wasted call` string and the same keep-recent
micro-compaction constants (checked by byte search). The corpus scan found **zero** Read results of
type `file_unchanged` among 10,209 Reads (`01-measurement.md` §3). Anthropic built this feature,
shipped it, and keeps it switched off remotely; why is not public (OQ-6).

The mod therefore re-enables, in-process, a behaviour the engine owns and holds off. Its checks
are stricter than the engine's: a content hash where the engine compares `mtime`, and a check of
the request itself where the engine trusts a state flag (§5).

### 4.2 The measured value (U-4)

Full method, corpus and threats in `01-measurement.md`. The figures that decide:

| Measure (12,066 transcripts, 55 days, 10,209 Reads)           | Value                                             |
| ------------------------------------------------------------- | ------------------------------------------------- |
| Unchanged text re-reads, same key, same window (main loops)   | **9**, ~14.3 k tokens (upper bound)               |
| Same, in subagent loops                                       | **0**                                             |
| Share of main-loop Read tokens                                | **0.08 %** (0.04 % of all Read tokens)            |
| Within 60 minutes of the earlier Read                         | 8 of 9                                            |
| Re-reads after the loop's own edit (content changed)          | 88, ~304 k tokens: not deduplicable               |
| Ranged Reads inside an earlier whole-file Read (not answered) | 52, ~24.8 k tokens                                |
| Characters per token of a Read result (measured)              | median 2.245 (quartiles 1.726–2.461, 887 samples) |

Two things make the number small. The model rarely re-reads a file it has not changed. And when it
does re-read, it usually changed the file first, which is what the engine's own hint after an
Edit addresses: `(file state is current in your context — no need to Read it back)` (bin:2.1.295;
this session's own tool results carry it).

### 4.3 Verdict

The savings are real but tiny on this workload, and the engine owns a switched-off version of the
same feature. A mod that rewrites model-visible tool results is a correctness liability for every
session it loads in (§5). Recommended: **do not build now** (OQ-1). The rest of this spec is the
design to build if a later scan says otherwise.

## 5. Correctness: when the mod may answer (U-1)

### 5.1 The rule

The mod answers a `Read` call only when **all** of these hold, checked in this order on every call
(prototype `hooks/register.ts`:32-68):

1. **Same key.** `(session id, loop, file_path, offset, limit)` matches an entry the mod recorded
   from an earlier Read that **ran** and returned a text result. The loop is `e.agentId ?? 'main'`.
   `pages` set (a PDF range) → never recorded, never answered.
2. **Not just answered.** The entry was not itself answered last time (the escape, §7.4).
3. **Same file metadata.** `$.fs.stat(file_path)` gives the `size` and `mtimeMs` recorded right
   after the earlier Read ran.
4. **Same content.** The file's text now, cut to the same lines (`startLine`, `numLines` of the
   earlier result), hashes (sha256) to the hash of the `content` the earlier Read returned.
5. **Still in the request.** In `$.session.messages({ as: 'api', agentId: e.agentId })` there is a
   tool_result for the earlier call's `tool_use_id`, and its text **begins with** the earlier
   `text`, trailing whitespace cut (a hash over that prefix length).

Anything else, any failed `$` call, or any throw, and the real `Read` runs (`next(e)`). A Read that
runs and returns a text result not cut to its token cap is recorded (or re-recorded with its new
`tool_use_id`); one that errs, is denied, or returns anything else drops the entry for that key.

Check 5 is the one that guarantees the content is still in the model's context. Checks 3–4 guarantee
the file still says what that content says. Neither pair is enough alone: an unchanged file whose
earlier result was compacted away must be re-read (check 5), and a result still in context whose
file changed must be re-read (checks 3–4).

### 5.2 What "unchanged" means

- **Path:** as the model spelled it (`file_path`). Two spellings of one file (a symlink, a relative
  path) are two keys: a miss, never a wrong answer.
- **Range:** `offset` and `limit` as given, absent ≠ `1`. A ranged Read is never answered from a
  whole-file entry, even when its lines are inside it (that saves ~24.8 k tokens on this machine,
  `01-measurement.md` §3, and needs a different note; deferred, §6).
- **mtime and size:** the cheap gate before reading the file.
- **Content hash:** sha256 of the same line range of the file's text now versus of the earlier
  result's `content`. This catches a same-size rewrite within the same millisecond, or one that
  restores the mtime (kit test 3). A file over 4 MiB cannot be read by `$.fs.read`
  (types:3225-3243): never answered.
- **What the model was shown:** the prefix hash of check 5, against the request itself.

### 5.3 Why check 5 is a prefix, not an equality (found by a live run)

The first prototype hashed the earlier `text` whole and compared it to the tool_result text in the
request. Every kit test passed; in a real session it never fired (live 1–3). The trace showed the
request holds the earlier result as `…\n4` where `text` was `…\n4\t` (trailing whitespace cut), and
followed, **inside the same tool_result**, by a `<system-reminder>` the engine attached on that
turn. The rule therefore hashes `text.trimEnd()` and compares it to the same-length prefix of what
the request holds. A cleared, cut or summarised result does not begin with the full earlier text,
so it fails. The kit's `session.messages` stub now models that shape (prototype test file, the
`shown.set` line).

### 5.4 Cases, each with its rule and the event or check that drives it

| Case                                                                                   | Rule                                                                                                                                                          | Driven by                                                                                | Evidence                                                      |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Compaction of a loop (`/compact`, auto, a plugin's)                                    | Drop every entry of that loop once the compaction stands (`skip` absent, trigger not `precompute`). Check 5 also fails: the request holds the summary instead | `session.compact` hook after `next(e)` (`register.ts`:114-121); check 5                  | Kit test 10; live 7; live 8 (eviction removed, check 5 alone) |
| Compaction that keeps a preserved tail of messages                                     | Still dropped: the eviction is conservative. A result kept verbatim would pass check 5, but the mod does not rely on that                                     | `session.compact`                                                                        | —                                                             |
| `precompute` trigger                                                                   | Nothing: a precomputed compaction has not replaced anything yet                                                                                               | `session.compact` (`trigger`, types:10856)                                               | —                                                             |
| `/clear`                                                                               | The conversation ends and the session id changes: the key never matches again. `session.end` drops that id's entries                                          | `session.end` with `reason: 'clear'` (types:11054-11056); the session id in the key      | Live 9                                                        |
| Resume (`claude --resume`, `--continue`, an in-process resume)                         | The cache starts empty in a new process, and an in-process resume ends the old id (`session.end`, `reason: 'resume'`). Misses only: no warm-up from history   | `session.end`; a fresh module has no entries                                             | —                                                             |
| Hot reload of the mod, or the engine replacing its copy                                | Entries live in `$.state`, which survives a reload (reference.md:118); a lost copy loses at most the entries, never answers wrongly                           | —                                                                                        | —                                                             |
| A subagent, a fork, a teammate (`agentId`)                                             | Its own key space; check 5 reads that loop's messages. A fork that inherited the parent's history is not answered from the parent's entries (a miss)          | `e.agentId` in the key; `$.session.messages({ as: 'api', agentId })`                     | Live 10                                                       |
| A Read cut to its token cap (`truncatedByTokenCap`)                                    | Never recorded; a prior entry for the key is dropped                                                                                                          | The result's `file.truncatedByTokenCap` (types:20956)                                    | Kit test 6                                                    |
| A kept result the engine later cuts to budget, or clears                               | No event exists for it (reference.md:141: the engine's later edits of a kept row "are its own business and no append"). Check 5 fails on the cut text         | Check 5                                                                                  | Kit test 5; A-1 (§13)                                         |
| Keep-recent micro-compaction (old tool results cleared after a long idle)              | Same as above                                                                                                                                                 | Check 5                                                                                  | A-1 (§13)                                                     |
| Edit, Write or NotebookEdit by this session                                            | Drop every entry for that path, any loop, after the edit ran                                                                                                  | `tool.call` on `/^(Edit\|Write\|NotebookEdit)$/` after `next(e)` (`register.ts`:106-112) | Kit test 9                                                    |
| An edit through Bash (`sed -i`, `git checkout`), by a formatter, or by another process | No event. Checks 3–4 fail on the changed file                                                                                                                 | Checks 3–4                                                                               | Kit tests 2-3                                                 |
| A same-size, same-mtime rewrite                                                        | Check 4 fails                                                                                                                                                 | Check 4                                                                                  | Kit test 3                                                    |
| The earlier Read errored or was denied                                                 | Never recorded                                                                                                                                                | `isError` / `deny` on the result                                                         | —                                                             |
| The engine's own dedupe answers beneath the mod (if the flag flips)                    | The pass-through sees a non-text result and drops the entry; the engine's answer goes up untouched                                                            | `ran.result.type !== 'text'` (`register.ts`:71-85)                                       | —                                                             |
| Image, PDF or notebook Reads                                                           | Never recorded (text results only)                                                                                                                            | `ran.result.type`                                                                        | §6                                                            |

## 6. Which tools (U-2)

| Tool                                    | Decision | Reason                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Read`, text results                    | **Yes**  | The whole value measured (9 repeats); the only kind §5 can check line by line.                                                                                                                                                                                                                                                                                                                                                      |
| `Read`, image results                   | No (v1)  | 2,076 image Reads, 11 unchanged repeats (2 main, 9 subagent). Check 5 would have to hash image blocks, which the engine may resize or drop (reference.md:141); the tokens per image are not in the transcript. Revisit only with its own scan.                                                                                                                                                                                      |
| `Read` with `pages` (PDF), notebooks    | No       | 2 PDF Reads in the corpus. A notebook comes back as `type: "notebook"` with `cells` (types:20942-21033), not lines; there is **no `NotebookRead` tool** in this build (only `NotebookEdit`, types:16400).                                                                                                                                                                                                                           |
| `Grep`, `Glob`                          | No       | Not registered by a native macOS or Linux build (reference.md:54-56); absent from this build's tool table. 23 calls in the whole corpus, from older builds. Their output depends on the whole tree, so "unchanged" needs the search to run anyway: only a run-then-compare variant could save the output tokens. Revisit on a build that registers them, with a scan.                                                               |
| `Bash cat` / `head` / `sed -n` / `tail` | No       | 6 identical file-dump repeats in the corpus, ~158 tokens. All identical Bash repeats together: 351, ~14.6 k tokens, under 100 characters of output each on average. A Bash command can have side effects, so "unchanged" needs it to run. And a `tool.call` hook whose matcher can match `Bash`, even pass-through, breaks `Agent(isolation: "worktree")` (T389 risk R8, `docs/specs/T389-companion-mod/00-master.md`:605, #92533). |
| MCP resource reads                      | No       | Out of the idea's scope; no measurement.                                                                                                                                                                                                                                                                                                                                                                                            |

## 7. The synthetic result (U-3)

### 7.1 What the hook returns

```ts
return {
  result: { type: 'file_unchanged', file: { filePath: e.file_path } },
  context: [
    `read-dedupe: ${e.file_path} lines ${prior.startLine}-${prior.startLine + prior.numLines - 1} ` +
      `are unchanged since turn ${prior.turn}; they are in the Read result ${prior.toolUseId} above. ${ESCAPE}`
  ]
}
```

(`register.ts`:60-66; `ESCAPE` is the sentence that ends the note below.) The result is Read's
own output variant, so the engine validates it against Read's schema and maps it with Read's own
mapper (types:12719-12726); the UI draws it as it draws the engine's own dedupe.

### 7.2 The exact text the model gets

Recorded in live 4 (2.1.296), for a file `notes.txt` first read as `toolu_01EB…`. The tool_result
(no `is_error`):

```text
Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.
```

After it, as a `hook_additional_context` attachment (`<path>` stands for the folder):

```text
read-dedupe: <path>/notes.txt lines 1-4 are unchanged since turn 1; they are in the Read result toolu_01EBpEVtNaUcwtuVo54e6ypL above. If you need the text re-sent, call Read again with the same arguments.
```

"Turn" is `$.session.turns()` when the earlier Read ran: the user's prompt count (types:2788-2792),
also inside a subagent.

### 7.3 Why it does not confuse the model or lose the content

- **It is the engine's own wording.** The tool_result text is what Read's own mapper makes of any
  `file_unchanged` result. The engine's built-in dedupe returns the same result type, so a model
  running with that feature on would read the same line (inferred: same type, same mapper).
- **It is only sent when the content is provably there.** Check 5 (§5.1) answers only when the
  request still holds the earlier result verbatim, so the model never loses content it has not
  got. The note names the earlier `tool_use_id` and line range, so the model can find it.
- **Observed.** In live 4 and live 6 the model quoted the file's lines from the earlier result
  after the answer; in live 10 a subagent and then the main loop relayed it correctly. All runs used
  Haiku. No run measured whether `Wasted call` makes a model shy of a legitimate re-read (A-5, OQ-3).

### 7.4 The escape

- **The model:** asking again with the same arguments right after an answer runs the real Read
  (the `answered` flag, check 2). The note tells it so. Live 5: call 1 ran, call 2 was answered,
  call 3 ran. A different `offset`/`limit` is a different key and always runs.
- **Why not a `force` argument:** Read's input schema is the engine's (types:16527-16536); the
  model cannot send a field Read does not declare, and a rewrite is checked against the schema
  (types:12660-12663). "Ask again" needs no schema change.
- **The person:** the mod's `enabled` option (§10.1), or disabling or uninstalling the plugin.

## 8. The status line (U-4)

After each answer: `$.ui.status("read-dedupe · saved ~<n> tok (<k> re-read[s])")`, for example
`read-dedupe · saved ~14.3k tok (9 re-reads)` (`hooks/lib/core.ts` `statusLine`; kit test 1 checks
the shape). `$.ui.status` pins one line per plugin under the prompt until replaced (types:2466-2477);
nothing is shown before the first answer.

- **What `<n>` counts:** the length of each answered Read's earlier tool_result text divided by
  **2.245**, the characters-per-token ratio measured on this machine's Read results
  (`01-measurement.md` §2, item 8), summed over the session. It is the content the model was spared, not
  a cost: each saved token is written to the prompt cache once and read on every later request of
  that context window, so the money saved is larger and depends on the window. The `~` says it is an
  estimate.
- **Where it is kept:** `$.state` key `saved` (`{ tokens, reads }`), which survives a hot reload; a
  new session starts at zero.
- **Inside Harnu:** the line is drawn by the terminal Harnu hosts, so it shows in the session pane
  with no Harnu code. Outside Harnu: the same.

## 9. Packaging (C-3)

Decision, recorded in [`ADR-draft.md`](ADR-draft.md): **a standalone mod, `read-dedupe`, that
Harnu neither bundles nor stages.** A person installs it once, with
`/plugin install read-dedupe --marketplace <owner>/<repo>` (reference.md:85-101), at user scope.

| Option                                                      | Verdict    | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inside the Harnu mod (`resources/companion/`), behind a key | Rejected   | MOD-3 closes the companion's surface to exactly two `tool.call` matchers, `Edit\|Write\|NotebookEdit` and `/^mcp__(harnu\|capy)__/` (`00-master.md`:524; `01-contract.md`:1008-1009); a `Read` matcher means amending that rule. A feature with no fact family needs its key on, the companion mode not `off` and a **live lease** (`01-contract.md`:1029-1031): the dedupe needs nothing from Harnu's host, yet would stop whenever the host is away. And it would put the one hook that changes what the model reads into the substrate every Harnu session loads, for a measured 0.08 %. |
| A new mod Harnu bundles and stages (second `--plugin-dir`)  | Not now    | The pattern exists in plans (T447's `harnu` mod, `docs/specs/T447-harnu-sdk-noun/00-spec.md`:13-37) and for skills (T217). It needs staging, a Settings switch and per-folder state: worth it as a general "bundled mods" catalog for several report ideas, not for this one (OQ-5).                                                                                                                                                                                                                                                                                                        |
| Harnu main-process code                                     | Impossible | Only an in-process `tool.call` hook can answer in place of the tool. Harnu's settings hooks (PreToolUse) can deny or allow, not supply a result.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Standalone mod, installed by the person**                 | **Chosen** | Nothing in it is Harnu's: no host fact, no verb, no Harnu state. It behaves the same in every session, inside or outside Harnu. Harnu's only contact is the Settings → Mods audit row (§10.3).                                                                                                                                                                                                                                                                                                                                                                                              |

**A session started outside Harnu** gets exactly what a Harnu session gets: the mod, installed at
user scope, loads in every `claude` session on the machine. Nothing degrades and nothing needs
Harnu. Conversely a Harnu session gets nothing unless the person installed the mod. Where the source
lives (a `mods/` folder in this repository made a marketplace, or a repository of its own) is OQ-2.

## 10. Control and failure (C-4)

### 10.1 On, off, default

- **Default: off** — it is not installed. Installing it is the opt-in.
- **Once installed: on**, through its one `userConfig` option `enabled` (boolean, default `true`,
  `02-prototype.md` `plugin.json`). The option is a row in Claude Code's config menu; changing it
  reloads the module with the new value (reference.md:74). With `enabled: false` the module
  registers no hook at all (`register.ts`:30), so every Read runs and nothing is recorded (kit test
  11). Stored under `pluginConfigs["read-dedupe"].options` in the person's settings (types:7646-7658).
- **Fully off:** `/plugin` → disable, or uninstall.
- **No Harnu switch.** Harnu does not stage this mod, so it adds no Settings toggle (§9).

### 10.2 Failure: fail-open, through `.catch`

Every hook is registered with `.catch(($, e, next) => next(e))` (`register.ts`:104, 112, 121, 126).

- The `Read` hook judges before it calls `next`. If it throws, overruns its 10 s budget (types:5109)
  or answers a wrong shape **before** `next`, the handler runs `next(e)`: the real Read runs. If it
  fails **after** `next`, the handler's `next(e)` replays what that call settled to and nothing runs
  twice (reference.md:79). The mod never answers `{ deny }`.
- Every failed check, rejected `$` call (`fs.stat`, `fs.read`, `session.messages` answering
  `{ deny }`) or missing field is a pass-through. The only harmful failure is a **false answer**
  (the model told a file is unchanged when its content is not in context, or the file changed);
  §5's three independent checks exist for that, and each has a test.
- The `Edit|Write|NotebookEdit` and `session.compact` hooks run `next(e)` first and only then
  touch `$.state`; `session.end` drops its entries and then passes on. A failure in any of them
  leaves an entry behind, which checks 3–5 still guard.
- Cost: an answered Read took 4.9 ms and 3.8 ms of hook time in live 4 and live 11 (the debug log). A pass-through adds one
  `$.fs.stat`, two hashes and one `$.state` write after the tool ran.
- `claude plugin validate` reports each gate as "gating hook with .catch" (`02-prototype.md` §2.1).

### 10.3 Settings → Mods audit chips

Computed, not predicted: the prototype's `claude plugin validate --json` was fed to this
repository's own `parseValidateReport` and `buildAnalysis` (`src/main/mods-audit-core.ts`), run
with `node --experimental-strip-types`:

```json
{
  "status": "ok",
  "capabilities": ["files", "tool-calls"],
  "hooks": [
    "tool.call{tool=Read}",
    "tool.call{tool=/\"^(Edit|Write|NotebookEdit)$\"/}",
    "session.compact",
    "session.end"
  ],
  "calls": [
    "fs.read",
    "fs.stat",
    "session.id",
    "session.messages",
    "session.turns",
    "state.get",
    "state.set",
    "ui.status"
  ]
}
```

- **`files`**: it calls `fs.*` (`mods-audit-core.ts`:378).
- **`tool-calls`**: it hooks `tool.call` (`mods-audit-core.ts`:381).
- Not `terminal` (no `ui.render` hook; `$.ui.status` is a call), not `other-mods` (no hook on an
  `http`/`env`/`store`/`state`/`fs` event, `:354`, `:386`), not `model`, `network`, `process`,
  `submit` or `mcp`.
- The row's source is `installed` (`mods-audit-core.ts`:18).
- **Side effect:** a `tool-calls` chip makes the mod a "permission hooker" for
  `pickPermissionHookers` (`mods-audit-core.ts`:742-764), the static detector of T389 master Q31.
  Nothing consumes it today (only `src/main/mods-audit.ts` defines and exports it). If P3W1 ships as
  specified, a session in a folder where this mod loads could read as contested by another mod,
  though the mod never decides a permission (OQ-4).

## 11. Overlap with T389 and T447 (C-2)

Status is checked against the code at `cb7fb58` (this branch's base), not against the specs' own
status lines, which all still read "Specified (not implemented)".

| Wave or spec                                                      | Status in code                                                                                                                                                          | Relation                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADR-0018 (the Harnu mod is the integration substrate)             | Accepted; the companion ships                                                                                                                                           | This mod is **not** integration: it reports nothing to Harnu and takes no command. The ADR-draft records why it stays outside the substrate.                                                                                                                      |
| P1W3 handshake and identity                                       | Shipped (`resources/companion/hooks/register.ts`:1141-1172: `session.start`, `classic.SessionStart`, `session.end`)                                                     | Its re-key rule resets per-conversation state on `/clear` and resume (`01-contract.md`:998). This mod applies the same idea to its own state by keying on the session id and dropping at `session.end` (§5.4); no shared code.                                    |
| P2W4 live contract and guard                                      | **Not shipped**: the companion registers no `tool.call` hook (`resources/companion/api-surface.json`:6-24)                                                              | Plans the companion's one `tool.call` on `Edit\|Write\|NotebookEdit` (`01-contract.md`:1008). This mod hooks the same matcher in its own module, for eviction only. Two mods on one event nest by tier (types:12602-12610); neither answers in the other's place. |
| P2W5 MCP caller attribution                                       | Not shipped (same evidence)                                                                                                                                             | No relation; disjoint matcher.                                                                                                                                                                                                                                    |
| P3W1 approval hold                                                | Not shipped (`pickPermissionHookers` has no consumer)                                                                                                                   | The `tool-calls` chip side effect, §10.3, OQ-4.                                                                                                                                                                                                                   |
| P4W1 Mods audit tab                                               | Shipped (`src/main/mods-audit-core.ts`, `ModsAuditPane.vue`)                                                                                                            | Lists this mod with chips `files`, `tool-calls` (§10.3). Nothing to add to it.                                                                                                                                                                                    |
| P4W3 Harnu mod outside Harnu                                      | Shipped (`src/main/companion/external-*.ts`, `HarnuModExternal.vue`)                                                                                                    | Not needed: a standalone mod is already outside Harnu.                                                                                                                                                                                                            |
| P4W5 compaction digest                                            | Not shipped: no `on('session.compact')` in the companion (its `session.compact` mention at `register.ts`:1020 is the `act.compact` command calling `$.session.compact`) | Plans the companion's shared `session.compact` registration (`01-contract.md`:1006). This mod hooks `session.compact` in its own module, pass-through, acting after `next(e)`; it never rewrites the summary.                                                     |
| MOD-3 / R8 (no `Bash` matcher)                                    | Rule in force for the companion                                                                                                                                         | The bug behind it (#92533) is in Claude Code, not in the companion, so this mod keeps the rule too: no matcher can match `Bash` (§6).                                                                                                                             |
| T447 `$.harnu` noun (PR #41)                                      | **Merged as a spec** on main (`9142876`); not implemented: no `engine.create` in `resources/` or `src/`                                                                 | Not used: the mod needs no Harnu verb, state or identity. It does not depend on `harnu` and adds no noun.                                                                                                                                                         |
| Report ideas 6 (context diet meter), 76, 82 (prompt-cache keeper) | Ideas only; no spec or code                                                                                                                                             | Same cluster (context budget). Nothing to duplicate; a future diet meter could read this mod's `saved` key only through a contract this spec does not define.                                                                                                     |

The card brief describes PR #41 as not merged; it merged before this branch was cut. Everything the
mod needs is Claude Code's own API; nothing in it duplicates a T389 or T447 deliverable.

## 12. Implementation outline (C-6)

Only if OQ-1 is answered "go". Sizes: S ≤ 1 day, M ≤ 3 days, L more.

| Wave                         | Size | Depends on | Content                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------- | ---- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| W0 spike                     | S    | —          | Check A-1…A-6 (§13) live: a session idle past the micro-compaction threshold, a budget-cut result, CRLF and very long lines, a 4 MiB file, macOS. Re-run the scanner on the current corpus. Note the mapped text on the current CLI. Exit: a yes/no on each assumption, and the scan.                                                                                                |
| W1 the mod                   | S    | W0         | The prototype hardened: an LRU cap on `entries` per session (A-3), the README with the install line, `.claude-plugin/marketplace.json`, the kit tests plus one per W0 finding. A CI step that runs `claude plugin validate` and `claude plugin test` on it (the companion's `scripts/ci/mod-step.mjs` is the model). The OQ-3 choice of wording, if it changes anything, lands here. |
| W2 covered ranges (optional) | S    | W1, a scan | Answer a ranged Read from a whole-file entry whose lines contain it (~24.8 k tokens here, §4.2), with its own note. Only if a scan shows it pays.                                                                                                                                                                                                                                    |

**Repository contracts the implementation owes**, by where OQ-2 puts the source:

- **Source in this repository** (`mods/read-dedupe/`): a `CHANGELOG.md` entry (a new mod people can
  install is user-visible); a section in `docs/user/mods.md` with the install line and the
  `enabled` option; the English-only and no-client-identifier gates on the new files. **Not owed:**
  `docs/harnu-features.md` and its marker (no MCP verb, ACK, grant or Harnu UI affordance changes;
  the model sees the engine's own text), `design.md` and the two locale files (no renderer UI).
- **Source in its own repository:** none of the above here; a one-line mention in
  `docs/user/mods.md` only if the operator wants Harnu to point at it.
- **If OQ-5 later makes it a Harnu-bundled mod:** `docs/harnu-features.md` (an affordance the agent
  could offer) plus the marker bump, `docs/user/`, and for the Settings switch `design.md` and both
  `en.json` and `pt-BR.json`.

## 13. Assumptions for the W0 spike

| Id  | Assumption                                                                                                                                          | Why it matters                                            | Evidence so far                                                                                                                                                                                                                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A-1 | `$.session.messages({ as: 'api' })` shows a tool result the engine later cleared (keep-recent micro-compaction) or cut to budget, as cleared or cut | Check 5 is the only guard for those two cases             | The type says "after the engine's normalization" and names compaction (types:631-639); compaction proven (live 8). Micro-compaction needs a long idle: not run. The bundle shows keep-recent clearing after `minIdleSeconds: 3900`, keeping 5 tool uses (bin:2.1.295). |
| A-2 | Read's `content` equals the file's text cut by lines for every file the mod records                                                                 | Check 4 would miss (never answer wrongly) on any mismatch | Proven for an LF file (live 3). CRLF, BOM and lines past Read's per-line cap are expected to miss: safe, unmeasured.                                                                                                                                                   |
| A-3 | `$.state` copes with the `entries` map of a long session                                                                                            | Each Read writes the whole map back through `update`      | An entry holds two hashes, ids and the path (estimated under 500 bytes, not measured). Measured: the busiest loop in the corpus made 204 Reads; the 99th percentile, 16. W1 adds an LRU cap.                                                                           |
| A-4 | 2.245 characters per token for a Read result                                                                                                        | The status line's number                                  | Measured, 887 samples (`01-measurement.md` §2, item 8); a lower bound on the ratio, so the shown savings are an upper bound.                                                                                                                                           |
| A-5 | `Wasted call —` does not make a model avoid a re-read it needs                                                                                      | U-3's "does not confuse" for models other than Haiku      | Haiku handled it in live 4, 5, 6 and 10. No Sonnet or Opus run.                                                                                                                                                                                                        |
| A-6 | The mapper text and the `file_unchanged` variant stay in future CLI builds                                                                          | The answer depends on Read's output schema                | Present in 2.1.295 and 2.1.296; the types file is the contract to re-check on every CLI bump.                                                                                                                                                                          |

## 14. Open questions (C-7)

| Id   | Question                                                                                                                                                                                                                                                     | Who decides                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| OQ-1 | Go or no-go. Recommended: no-go now; re-run the scanner after a workload change, and go only if unchanged re-reads reach a share the operator considers worth a mod that rewrites model-visible results (a proposal, not a measurement: 1 % of Read tokens). | The operator                                      |
| OQ-2 | Where the source lives: `mods/read-dedupe/` in this repository (the repo becomes a marketplace) or a repository of its own.                                                                                                                                  | The operator, as maintainer                       |
| OQ-3 | Keep the engine's `Wasted call —` text, or rewrite the tool_result at `session.append` (door `tool-result`, reference.md:137-141) to the engine's gentler sentence or the mod's own. Needs a live comparison across models.                                  | The implementer, after W0                         |
| OQ-4 | Should T389's static permission-hooker detector (`pickPermissionHookers`) ignore `tool.call` hooks whose matchers cannot reach a permission decision, so a mod like this one does not make a session read as contested?                                      | The P3W1 owner                                    |
| OQ-5 | A general "bundled mods" catalog in Harnu (staged like bundled skills, a Settings switch per mod) for the report's in-process ideas (2, 8, 81, …). It would reopen §9 for this mod.                                                                          | The operator                                      |
| OQ-6 | Why the engine's own dedupe is held off by `tengu_read_dedup_killswitch`, and whether a mod should do what Anthropic switched off. If the flag flips, the mod already steps aside (§5.4); whether to retire it then.                                         | Upstream (Anthropic); the operator for the policy |

## 15. AC traceability

| AC  | Where                                                                                                                                                                                                                                                                 |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U-1 | §5: the rule (§5.1), what "unchanged" means (§5.2), the case table with the rule and the driving event or check per case (§5.4): compaction, `/clear`, resume, subagents (`agentId`), truncated and budget-cut results, edits by this session and by other processes. |
| U-2 | §6: Read (text) yes; images, PDF, notebooks, Grep, Glob, Bash file dumps no, each with the reason and the measured count.                                                                                                                                             |
| U-3 | §7: the returned value, the exact text the model got in a live run, why it is safe, and the escape.                                                                                                                                                                   |
| U-4 | §4.2 and `01-measurement.md` (method, corpus, numbers, scanner source); §8 the status line.                                                                                                                                                                           |
| C-1 | §3 (every mechanism with its declaration line and the run that shows it); `02-prototype.md` §3 (live runs).                                                                                                                                                           |
| C-2 | §11.                                                                                                                                                                                                                                                                  |
| C-3 | §9 and `ADR-draft.md`.                                                                                                                                                                                                                                                |
| C-4 | §10.                                                                                                                                                                                                                                                                  |
| C-5 | `02-prototype.md` (module, tests, `validate`, `test`, `tsc` output).                                                                                                                                                                                                  |
| C-6 | §12.                                                                                                                                                                                                                                                                  |
| C-7 | §14.                                                                                                                                                                                                                                                                  |
| C-8 | English only; neutral vocabulary; `npx prettier --check` and `npx vitest run tests/no-client-identifiers.test.ts` pass on these files (run before commit).                                                                                                            |
